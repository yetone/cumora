import { WebSocketServer, type WebSocket } from 'ws'
import type { Server } from 'node:http'
import {
  sub,
  CH_MESSAGE_NEW, CH_MESSAGE_DELTA, CH_TYPING,
  CH_STATUS, CH_REACTIONS, CH_POLLS,
  CH_GROUP_PULLED, CH_CONVO_UPDATED, CH_CONVENE,
  CH_BOARDS, CH_DOCS, CH_CALENDAR_REMINDER, CH_CALENDAR_EVENTS, CH_DOC_MENTION,
  publish,
  type DocMentionEvent,
} from './redis.js'
import type { MessageNewEvent } from './redis.js'
import { env } from './env.js'
import { consumeWsTicket } from './auth.js'
import { pool } from './db/pool.js'
import { setStatus } from './status.js'
import {
  subscribe as docSubscribe,
  unsubscribe as docUnsubscribe,
  applyLocalUpdate as docApplyLocalUpdate,
  broadcastAwareness as docBroadcastAwareness,
  type DocSubscriber,
} from './documents/rooms.js'
import { randomUUID } from 'node:crypto'

interface AuthedSocket {
  ws: WebSocket
  userId: string
  /** Stable per-socket id used as the Yjs update origin. Lets the room
   *  manager echo-suppress on this client's own outbound updates. */
  originId: string
  /** Set of company_ids this user is a member of. Refreshed on connect; the
   *  WS bridge uses it to filter Redis events tagged with `companyId`. */
  companies: Set<string>
  /** Active doc subscriptions on this socket. Released on close. */
  docSubs: Map<string, DocSubscriber>
  /** Heartbeat liveness flag. Set true on every received pong; the periodic
   *  ping loop flips it to false right before sending the next ping. If the
   *  next round still sees false, the socket is half-open and we terminate
   *  it — that triggers the 'close' handler, which decrements the
   *  presence counter and flips the user to 'resting'. Without this,
   *  laptop sleeps / network drops would leave 'avail' stuck until the
   *  OS finally noticed the dead TCP. */
  isAlive: boolean
}

const clients = new Set<AuthedSocket>()
const redisFanoutQueues = new Map<string, Promise<void>>()

// Per-client WebSocket send backpressure caps (OOM fix). A socket that can't
// drain makes `ws` buffer unsent frames in process memory; without a cap, a high
// broadcast rate grows that buffer unbounded across clients until the pod OOMs.
// Above MAX we stop sending new frames to that client (let it drain); above
// TERMINATE it's hopelessly behind, so we kill it to reclaim the memory (it
// reconnects + re-syncs via REST).
const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024        // 2 MB
const WS_TERMINATE_BUFFERED_BYTES = 8 * 1024 * 1024  // 8 MB
const DOC_SYNC_MAX_BYTES = 32 * 1024 * 1024          // bounded one-shot snapshot

/** Open WS connections per user. Drives real human presence:
 *   - 0 → 1  : user is now online, flip participant status to 'avail'.
 *   - 1 → 0  : user just went offline, flip to 'resting'.
 *  Multiple tabs / windows / devices coalesce on the same userId so
 *  presence stays "online" until the last one closes. */
const humanConnections = new Map<string, number>()

/** Called once at server boot. Demotes every human participant that's
 *  still flagged 'avail' from a previous run — those flags would otherwise
 *  persist as stale presence until that user reconnects/disconnects.
 *  Agents are handled by their own runtime lease + the GET /participants
 *  auto-expiry, so we leave their status alone here. */
export async function resetHumanPresenceOnBoot(): Promise<void> {
  try {
    const { rows } = await pool.query<{ id: string; company_id: string; status_updated_at: Date }>(
      `UPDATE participants
          SET status = 'resting',
              status_updated_at = NOW()
        WHERE kind = 'human' AND status = 'avail'
        RETURNING id, company_id, status_updated_at`,
    )
    if (rows.length > 0) {
      console.log(`[ws] demoted ${rows.length} stale 'avail' human(s) to 'resting' on boot`)
    }
    // Broadcast each transition so any already-connected clients in a
    // multi-instance setup see the reset. We fire publishes in
    // parallel and bound the whole batch with a hard timeout: the
    // old code was a sequential `for await publish` that hung
    // server.listen() at first deploy when the table was full of
    // pre-feature stale rows. Failures are swallowed (Promise.race
    // against a timeout) — at boot there are typically zero connected
    // clients anyway, so the publish is best-effort.
    if (rows.length === 0) return
    const PUBLISH_BATCH_TIMEOUT_MS = 10_000
    const broadcastAll = Promise.allSettled(rows.map((r) =>
      publish(CH_STATUS, {
        type: 'participants.status',
        participantId: r.id,
        status: 'resting',
        statusUpdatedAt: r.status_updated_at.toISOString(),
        companyId: r.company_id,
      }),
    ))
    await Promise.race([
      broadcastAll,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          console.warn(`[ws] resetHumanPresenceOnBoot publishes still pending after ${PUBLISH_BATCH_TIMEOUT_MS}ms — continuing without them`)
          resolve()
        }, PUBLISH_BATCH_TIMEOUT_MS),
      ),
    ])
  } catch (e) {
    console.warn('[ws] resetHumanPresenceOnBoot failed', e)
  }
}

async function onHumanConnect(userId: string): Promise<void> {
  const cur = humanConnections.get(userId) ?? 0
  humanConnections.set(userId, cur + 1)
  if (cur === 0) {
    try { await setStatus(userId, 'avail') }
    catch (e) { console.warn(`[ws] setStatus(avail) failed for ${userId}`, e) }
  }
}

async function onHumanDisconnect(userId: string): Promise<void> {
  const cur = humanConnections.get(userId) ?? 0
  if (cur <= 1) {
    humanConnections.delete(userId)
    try { await setStatus(userId, 'resting') }
    catch (e) { console.warn(`[ws] setStatus(resting) failed for ${userId}`, e) }
  } else {
    humanConnections.set(userId, cur - 1)
  }
}

async function loadMemberships(userId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM company_members WHERE user_id = $1`,
    [userId],
  )
  return new Set(rows.map((r) => r.company_id))
}

interface RoutedRedisEvent {
  type?: string
  companyId?: string
  conversationId?: string
  message?: { id?: string }
  mentionedIds?: string[]
  recipientUserIds?: string[]
}

/** Resolve every broadcast against live authorization, not the membership
 * snapshot captured when a socket connected. Conversation events are routed
 * only to current active human members. The sole exception is a persisted
 * system message with delivery_recipient_id, which lets a just-removed human
 * receive that one terminal leave/kick notice without reopening room access. */
export async function resolveWsEventRecipientUserIds(
  event: RoutedRedisEvent,
): Promise<Set<string>> {
  const companyId = typeof event.companyId === 'string' ? event.companyId : ''
  if (!companyId) return new Set()
  const targetedUserIds = event.type === 'doc.mention'
    ? event.mentionedIds
    : event.type === 'calendar.reminder'
      ? event.recipientUserIds
      : null
  if (targetedUserIds) {
    const requested = [...new Set(targetedUserIds.filter((id) => typeof id === 'string'))]
    if (requested.length === 0) return new Set()
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT cm.user_id
         FROM company_members cm
         JOIN users u ON u.id = cm.user_id AND u.deleted_at IS NULL
         JOIN participants p
           ON p.id = cm.user_id
          AND p.company_id = cm.company_id
          AND p.kind = 'human'
          AND p.departed_at IS NULL
        WHERE cm.company_id = $1 AND cm.user_id = ANY($2::text[])`,
      [companyId, requested],
    )
    return new Set(rows.map((row) => row.user_id))
  }
  const conversationId = typeof event.conversationId === 'string' ? event.conversationId : ''
  if (!conversationId) {
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT cm.user_id
         FROM company_members cm
         JOIN users u ON u.id = cm.user_id AND u.deleted_at IS NULL
         JOIN participants p
           ON p.id = cm.user_id
          AND p.company_id = cm.company_id
          AND p.kind = 'human'
          AND p.departed_at IS NULL
        WHERE cm.company_id = $1`,
      [companyId],
    )
    return new Set(rows.map((row) => row.user_id))
  }

  const durableMessageId = event.type === 'message.new' && typeof event.message?.id === 'string'
    ? event.message.id
    : null
  const { rows } = await pool.query<{ user_id: string }>(
    `WITH scoped_conversation AS (
       SELECT id, company_id
         FROM conversations
        WHERE id = $1 AND company_id = $2
     ), current_members AS (
       SELECT company_member.user_id
         FROM scoped_conversation c
         JOIN conversation_members room_member
           ON room_member.conversation_id = c.id
          AND room_member.company_id = c.company_id
         JOIN participants p
           ON p.id = room_member.participant_id
          AND p.company_id = c.company_id
          AND p.kind = 'human'
          AND p.departed_at IS NULL
         JOIN company_members company_member
           ON company_member.user_id = p.id
          AND company_member.company_id = c.company_id
     ), durable_recipient AS (
       SELECT cm.user_id
         FROM scoped_conversation c
         JOIN messages m
           ON m.id = $3
          AND m.conversation_id = c.id
          AND m.company_id = c.company_id
          AND m.kind = 'system'
          AND m.delivery_recipient_id IS NOT NULL
         JOIN participants p
           ON p.id = m.delivery_recipient_id
          AND p.company_id = c.company_id
          AND p.kind = 'human'
          AND p.departed_at IS NULL
         JOIN company_members cm
           ON cm.user_id = p.id
          AND cm.company_id = c.company_id
     )
     SELECT user_id FROM current_members
     UNION
     SELECT user_id FROM durable_recipient`,
    [conversationId, companyId, durableMessageId],
  )
  return new Set(rows.map((row) => row.user_id))
}

/** Look up a doc + verify the caller's tenant membership in one shot.
 *  Returns null when the doc doesn't exist OR the caller can't see it —
 *  same opaque posture the chat handlers use to avoid leaking existence. */
async function docCompanyFor(documentId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT d.company_id
       FROM documents d
       JOIN company_members m ON m.company_id = d.company_id AND m.user_id = $2
       JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
       JOIN participants p
         ON p.id = m.user_id
        AND p.company_id = d.company_id
        AND p.kind = 'human'
        AND p.departed_at IS NULL
      WHERE d.id = $1
      LIMIT 1`,
    [documentId, userId],
  )
  return rows[0]?.company_id ?? null
}

/** Deliver one document frame while holding share locks on every row whose
 * mutation can revoke access. A concurrent delete/offboard waits until the
 * synchronous ws.send has happened; once revocation commits, the next lookup
 * fails closed and detaches the stale room subscription. */
async function sendAuthorizedDocFrame(
  c: AuthedSocket,
  documentId: string,
  subRec: DocSubscriber,
  payload: unknown,
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const authorized = await client.query(
      `SELECT d.id
         FROM documents d
         JOIN company_members cm ON cm.company_id = d.company_id AND cm.user_id = $2
         JOIN users u ON u.id = cm.user_id AND u.deleted_at IS NULL
         JOIN participants p
           ON p.id = cm.user_id
          AND p.company_id = d.company_id
          AND p.kind = 'human'
          AND p.departed_at IS NULL
        WHERE d.id = $1
        FOR SHARE OF d, cm, u, p`,
      [documentId, c.userId],
    )
    if (!authorized.rowCount || c.docSubs.get(documentId) !== subRec) {
      await client.query('ROLLBACK')
      detachDocSubscription(c, documentId, subRec)
      return false
    }
    if (c.ws.readyState !== c.ws.OPEN || c.ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
      await client.query('ROLLBACK')
      detachDocSubscription(c, documentId, subRec)
      try { c.ws.terminate() } catch { /* ignore */ }
      return false
    }
    sendJson(c.ws, payload)
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function withAuthorizedDocOperation(
  c: AuthedSocket,
  documentId: string,
  subRec: DocSubscriber,
  task: (companyId: string, client: import('pg').PoolClient) => Promise<void>,
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ company_id: string }>(
      `SELECT d.company_id
         FROM documents d
         JOIN company_members cm ON cm.company_id = d.company_id AND cm.user_id = $2
         JOIN users u ON u.id = cm.user_id AND u.deleted_at IS NULL
         JOIN participants p
           ON p.id = cm.user_id
          AND p.company_id = d.company_id
          AND p.kind = 'human'
          AND p.departed_at IS NULL
        WHERE d.id = $1
        FOR SHARE OF d, cm, u, p`,
      [documentId, c.userId],
    )
    if (!rows[0] || c.docSubs.get(documentId) !== subRec) {
      await client.query('ROLLBACK')
      detachDocSubscription(c, documentId, subRec)
      return false
    }
    await task(rows[0].company_id, client)
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return
  try { ws.send(JSON.stringify(payload)) } catch { /* ignore */ }
}

function detachDocSubscription(
  c: AuthedSocket,
  documentId: string,
  subRec: DocSubscriber,
): void {
  if (c.docSubs.get(documentId) !== subRec) return
  docUnsubscribe(documentId, subRec)
  c.docSubs.delete(documentId)
}

async function handleDocFrame(c: AuthedSocket, msg: Record<string, unknown>): Promise<void> {
  const type = msg.type as string | undefined
  const documentId = typeof msg.documentId === 'string' ? msg.documentId : null
  if (!documentId) return

  if (type === 'doc.subscribe') {
    if (c.docSubs.has(documentId)) return  // idempotent
    const companyId = await docCompanyFor(documentId, c.userId)
    if (!companyId) {
      sendJson(c.ws, { type: 'doc.error', documentId, error: 'not found' })
      return
    }
    let outboundQueue = Promise.resolve()
    let pendingOutboundBytes = 0
    let pendingOutboundFrames = 0
    let subRec: DocSubscriber
    const enqueueAuthorizedFrame = (
      payload: unknown,
      byteLength: number,
      pendingByteLimit: number = WS_TERMINATE_BUFFERED_BYTES,
    ): void => {
      const estimatedBytes = Math.max(1, Math.ceil(byteLength * 4 / 3) + 256)
      if (
        pendingOutboundFrames >= 64
        || pendingOutboundBytes + estimatedBytes > pendingByteLimit
      ) {
        detachDocSubscription(c, documentId, subRec)
        try { c.ws.terminate() } catch { /* ignore */ }
        return
      }
      pendingOutboundBytes += estimatedBytes
      pendingOutboundFrames += 1
      const current = outboundQueue.catch(() => {}).then(async () => {
        if (c.docSubs.get(documentId) !== subRec) return
        await sendAuthorizedDocFrame(c, documentId, subRec, payload)
      }).finally(() => {
        pendingOutboundBytes = Math.max(0, pendingOutboundBytes - estimatedBytes)
        pendingOutboundFrames = Math.max(0, pendingOutboundFrames - 1)
      })
      outboundQueue = current
      void current.catch((error) => {
        console.warn(`[ws] document authorization lookup failed for ${documentId}`, error)
        detachDocSubscription(c, documentId, subRec)
      })
    }
    subRec = {
      originId: c.originId,
      onUpdate: (update, originId) => {
        enqueueAuthorizedFrame({
          type: 'doc.update',
          documentId,
          updateB64: Buffer.from(update).toString('base64'),
          originId,
        }, update.byteLength)
      },
      onAwareness: (update, originId) => {
        enqueueAuthorizedFrame({
          type: 'doc.awareness',
          documentId,
          updateB64: Buffer.from(update).toString('base64'),
          originId,
        }, update.byteLength)
      },
    }
    const { initialState } = await docSubscribe(documentId, companyId, subRec)
    c.docSubs.set(documentId, subRec)
    if (initialState.byteLength > DOC_SYNC_MAX_BYTES) {
      detachDocSubscription(c, documentId, subRec)
      sendJson(c.ws, {
        type: 'doc.error',
        documentId,
        error: 'document snapshot exceeds the 32 MiB realtime sync limit',
      })
      return
    }
    enqueueAuthorizedFrame({
      type: 'doc.sync',
      documentId,
      stateB64: Buffer.from(initialState).toString('base64'),
      originId: c.originId,
    }, initialState.byteLength, Math.ceil(DOC_SYNC_MAX_BYTES * 4 / 3) + 256)
    return
  }

  if (type === 'doc.unsubscribe') {
    const subRec = c.docSubs.get(documentId)
    if (!subRec) return
    docUnsubscribe(documentId, subRec)
    c.docSubs.delete(documentId)
    return
  }

  if (type === 'doc.update') {
    const subRec = c.docSubs.get(documentId)
    if (!subRec) return  // must subscribe first
    const updateB64 = typeof msg.updateB64 === 'string' ? msg.updateB64 : ''
    if (!updateB64) return
    const buf = Buffer.from(updateB64, 'base64')
    const update = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    await withAuthorizedDocOperation(c, documentId, subRec, (companyId, client) =>
      docApplyLocalUpdate(documentId, companyId, c.originId, c.userId, update, client))
    return
  }

  if (type === 'doc.awareness') {
    const subRec = c.docSubs.get(documentId)
    if (!subRec) return
    const updateB64 = typeof msg.updateB64 === 'string' ? msg.updateB64 : ''
    if (!updateB64) return
    const buf = Buffer.from(updateB64, 'base64')
    const update = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    await withAuthorizedDocOperation(c, documentId, subRec, (companyId) =>
      docBroadcastAwareness(documentId, companyId, c.originId, update))
    return
  }

  if (type === 'doc.mention.notify') {
    const rawIds = msg.mentionedIds
    if (!Array.isArray(rawIds) || rawIds.length === 0) return
    const requestedIds = rawIds.filter((x): x is string => typeof x === 'string')
    if (requestedIds.length === 0) return
    const companyId = await docCompanyFor(documentId, c.userId)
    if (!companyId) return
    await processDocMention({
      documentId, companyId, mentionerId: c.userId, requestedIds,
    })
    return
  }
}

/** Persist + fan out one or more @-mentions inside a doc. Filters the
 *  caller-supplied list against tenant membership (so a stale client
 *  can't notify someone in a different company) and dedups against the
 *  most recent mention-row for the same (doc, mentioner, mentioned)
 *  tuple — we don't want a noisily editing user spamming the
 *  recipient. For mentioned AGENTS, also writes an `agent_log` row so
 *  the agent's history surfaces the mention. */
async function processDocMention(args: {
  documentId: string
  companyId: string
  mentionerId: string
  requestedIds: string[]
}): Promise<void> {
  const { documentId, companyId, mentionerId, requestedIds } = args
  const participantIds = [...new Set([mentionerId, ...requestedIds])].sort()
  let mentionerName = mentionerId
  let documentTitle = 'Untitled'
  const freshRows: Array<{ id: string; kind: string; name: string }> = []
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: participants } = await client.query<{ id: string; kind: string; name: string }>(
      `SELECT p.id, p.kind, p.name FROM participants p
        WHERE p.company_id = $1 AND p.id = ANY($2::text[])
          AND p.kind IN ('agent', 'human') AND p.departed_at IS NULL
          AND (
            p.kind = 'agent'
            OR EXISTS (
              SELECT 1 FROM users u
              JOIN company_members cm ON cm.user_id = u.id AND cm.company_id = p.company_id
              WHERE u.id = p.id AND u.deleted_at IS NULL
            )
          )
        ORDER BY p.id FOR SHARE`,
      [companyId, participantIds],
    )
    const byId = new Map(participants.map((row) => [row.id, row]))
    const mentioner = byId.get(mentionerId)
    if (!mentioner || mentioner.kind !== 'human') {
      throw new Error('document mentioner is no longer an active workspace user')
    }
    mentionerName = mentioner.name || mentionerId
    const validRows = [...new Set(requestedIds)]
      .map((id) => byId.get(id))
      .filter((row): row is { id: string; kind: string; name: string } => Boolean(row))
    if (validRows.length === 0) {
      await client.query('COMMIT')
      return
    }
    const { rows: document } = await client.query<{ title: string }>(
      `SELECT title FROM documents
        WHERE id = $1 AND company_id = $2
        FOR SHARE`,
      [documentId, companyId],
    )
    if (!document[0]) throw new Error('document is no longer available in this workspace')
    documentTitle = document[0].title || 'Untitled'
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [documentId, mentionerId],
    )

    for (const row of validRows) {
      const { rows: recent } = await client.query<{ id: string }>(
        `SELECT id FROM document_mentions
          WHERE document_id = $1 AND mentioner_id = $2 AND mentioned_id = $3
            AND created_at > NOW() - INTERVAL '60 seconds'
          LIMIT 1`,
        [documentId, mentionerId, row.id],
      )
      if (recent[0]) continue
      await client.query(
        `INSERT INTO document_mentions
          (id, document_id, company_id, mentioner_id, mentioned_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [`dm_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          documentId, companyId, mentionerId, row.id],
      )
      if (row.kind === 'agent') {
        await client.query(
          `INSERT INTO agent_log (id, agent_id, company_id, kind, body, ref)
           VALUES ($1, $2, $3, 'doc_mention', $4, $5::jsonb)`,
          [
            `log_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
            row.id, companyId,
            `${mentionerName} @-mentioned you in doc "${documentTitle}"`,
            JSON.stringify({ documentId, mentionerId }),
          ],
        )
      }
      freshRows.push(row)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (freshRows.length === 0) return

  for (const row of freshRows) {
    if (row.kind !== 'agent') continue
    try {
      await postDocMentionWake({
        companyId,
        mentionerId,
        agentId: row.id,
        documentId,
      })
    } catch (e) {
      console.warn(`[doc.mention] wake post for ${row.id} failed`, e)
    }
  }
  const freshIds = freshRows.map((row) => row.id)

  const event: DocMentionEvent = {
    type: 'doc.mention',
    companyId,
    documentId,
    documentTitle,
    mentionerId,
    mentionerName,
    mentionedIds: freshIds,
  }
  await publish(CH_DOC_MENTION, event)
}

/** Post a synthetic chat message that wakes the mentioned agent with
 *  enough context to act. The agent's mailbox scheduler subscribes to
 *  CH_MESSAGE_NEW and runs a turn for every recipient — so dropping a
 *  real `text` message into a conversation the agent is in is the
 *  cheapest, most-reliable wake-with-context primitive available
 *  today (same pattern boards / scanner use indirectly).
 *
 *  Conversation selection — first match wins:
 *    1. The doc's pinned `conversation_id`, IF the agent is a member.
 *    2. An existing 1:1 DM between mentioner + agent.
 *    3. A freshly-created DM (idempotent — same shape as the auto-DM
 *       created on agent onboarding).
 *
 *  Body is plain prose — looks like a regular nudge to the agent's
 *  inbox parser, but carries the doc id verbatim so the agent's tool
 *  loop can call `cumora doc read <id>` without guessing. */
async function postDocMentionWake(args: {
  companyId: string
  mentionerId: string
  agentId: string
  documentId: string
}): Promise<void> {
  const { companyId, mentionerId, agentId, documentId } = args
  const participantIds = [mentionerId, agentId].sort()
  let conversationId = ''
  let documentTitle = 'Untitled'
  let sequence = 0
  const messageId = `m-${randomUUID()}`
  let body = ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: participants } = await client.query<{ id: string; kind: string; name: string }>(
      `SELECT p.id, p.kind, p.name FROM participants p
        WHERE p.company_id = $1 AND p.id = ANY($2::text[])
          AND p.kind IN ('agent', 'human') AND p.departed_at IS NULL
          AND (
            p.kind = 'agent'
            OR EXISTS (
              SELECT 1 FROM users u
              JOIN company_members cm ON cm.user_id = u.id AND cm.company_id = p.company_id
              WHERE u.id = p.id AND u.deleted_at IS NULL
            )
          )
        ORDER BY p.id FOR SHARE`,
      [companyId, participantIds],
    )
    const byId = new Map(participants.map((row) => [row.id, row]))
    const mentioner = byId.get(mentionerId)
    const agent = byId.get(agentId)
    if (mentioner?.kind !== 'human' || agent?.kind !== 'agent') {
      throw new Error('document mention participants are no longer active in this workspace')
    }

    const { rows: document } = await client.query<{ title: string; conversation_id: string | null }>(
      `SELECT title, conversation_id FROM documents
        WHERE id = $1 AND company_id = $2
        FOR SHARE`,
      [documentId, companyId],
    )
    if (!document[0]) throw new Error('document is no longer available in this workspace')
    documentTitle = document[0].title || 'Untitled'

    // Serialize direct-conversation creation with every other DM entry point.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [companyId, JSON.stringify(participantIds)],
    )

    // 1) Use the document's current pinned conversation only while both
    // participants still belong to it. 2) Otherwise reuse/create one DM.
    if (document[0].conversation_id) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT c.id FROM conversations c
          WHERE c.id = $1 AND c.company_id = $2
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
                 AND cm.participant_id = $3
            )
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
                 AND cm.participant_id = $4
            )
          FOR UPDATE OF c`,
        [document[0].conversation_id, companyId, mentionerId, agentId],
      )
      conversationId = rows[0]?.id ?? ''
    }
    if (!conversationId) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT c.id FROM conversations c
          WHERE c.kind = 'direct' AND c.company_id = $3
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
                 AND cm.participant_id = $1
            )
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
                 AND cm.participant_id = $2
            )
            AND (SELECT COUNT(*) FROM conversation_members cm
                  WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id) = 2
          ORDER BY c.updated_at DESC LIMIT 1
          FOR UPDATE OF c`,
        [mentionerId, agentId, companyId],
      )
      conversationId = rows[0]?.id ?? ''
    }
    if (!conversationId) {
      conversationId = `direct-${agentId}-${randomUUID().slice(0, 6)}`
      await client.query(
        `INSERT INTO conversations
          (id, kind, title, subtitle, members, pinned, tag, company_id)
         VALUES ($1, 'direct', $2, NULL, $3::jsonb, FALSE, NULL, $4)`,
        [conversationId, agent.name || agentId, JSON.stringify([mentionerId, agentId]), companyId],
      )
    }

    const seqRes = await client.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE
         SET next_sequence = conversation_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS seq`,
      [conversationId],
    )
    sequence = seqRes.rows[0]?.seq ?? 1
    body = `@${agentId} heads-up — I @-mentioned you in the doc "${documentTitle}". Take a look with \`cumora doc read ${documentId}\`, then either reply here or edit the doc directly (\`cumora doc append/replace ${documentId} …\`).`
    await client.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [messageId, conversationId, mentionerId, body, sequence, companyId],
    )
    await client.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  // Publish on the same bus chat messages use → scheduler wakes the
  // agent's pod, the turn loop drains the inbox, the agent sees this
  // message with the doc id verbatim.
  const event: MessageNewEvent = {
    type: 'message.new',
    companyId,
    conversationId,
    message: {
      id: messageId,
      conversationId,
      authorId: mentionerId,
      kind: 'text',
      body,
      sequence,
      at: new Date().toISOString(),
    },
  }
  await publish(CH_MESSAGE_NEW, event).catch((error) => {
    console.warn(`[doc.mention] durable wake ${messageId} committed but publish failed`, error)
  })
}

export function attachWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4 * 1024 * 1024 })

  wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress
    // The WS connect URL carries a SHORT-LIVED one-shot ticket
    // (?t=<ws-ticket>), not the session token. Tickets are minted via
    // POST /auth/ws-ticket and consumed atomically here. This keeps
    // session tokens out of URLs / access logs / referrer headers.
    let ticket: string | undefined
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const t = url.searchParams.get('t')
      if (t) ticket = t
    } catch { /* ignore */ }

    if (!ticket) {
      console.log(`[ws] rejecting unauthenticated connection (${ip})`)
      try { ws.close(4401, 'missing ws ticket') } catch { /* ignore */ }
      return
    }
    const session = await consumeWsTicket(ticket)
    if (!session) {
      console.log(`[ws] rejecting bad/expired/used ticket (${ip})`)
      try { ws.close(4401, 'invalid ws ticket') } catch { /* ignore */ }
      return
    }

    const companies = await loadMemberships(session.userId)
    const c: AuthedSocket = {
      ws,
      userId: session.userId,
      originId: randomUUID(),
      companies,
      docSubs: new Map(),
      isAlive: true,
    }
    clients.add(c)
    // Browsers auto-respond to ws.ping() with pong at the protocol level —
    // no JS involvement on the client side. The pong handler here is the
    // server's only signal that the socket is still alive end-to-end.
    ws.on('pong', () => { c.isAlive = true })
    console.log(`[ws] client connected (${ip}, user=${session.userId}, companies=${companies.size}) · total ${clients.size}`)
    void onHumanConnect(session.userId)

    // Single-fire disconnect handler — both 'close' and 'error' route
    // through here so we never double-decrement the connection counter.
    let released = false
    const release = () => {
      if (released) return
      released = true
      for (const [docId, subRec] of c.docSubs) docUnsubscribe(docId, subRec)
      c.docSubs.clear()
      clients.delete(c)
      void onHumanDisconnect(session.userId)
    }

    try {
      ws.send(JSON.stringify({ type: 'hello', instanceId: env.INSTANCE_ID, ts: Date.now() }))
    } catch { /* ignore */ }

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }
      const type = typeof msg.type === 'string' ? msg.type : ''
      if (type.startsWith('doc.')) {
        void handleDocFrame(c, msg).catch((e) => {
          console.warn('[ws] doc frame error', e)
          sendJson(ws, { type: 'doc.error', documentId: msg.documentId, error: 'server error' })
        })
      }
      // Other inbound types (ping etc.) would land here later; today the
      // chat protocol is pure REST + broadcast so there's nothing else.
    })

    ws.on('close', () => {
      release()
      console.log(`[ws] client disconnected · total ${clients.size}`)
    })
    ws.on('error', (err) => {
      console.warn('[ws] socket error', err)
      release()
    })
  })

  // Bridge Redis pubsub → local WS fan-out, scoped per company. The doc
  // channels (CH_DOC_UPDATE / CH_DOC_AWARENESS) are intentionally NOT in
  // this list — the room manager handles them, since recipients need to
  // be filtered by doc-subscription, not just company.
  sub.subscribe(
    CH_MESSAGE_NEW, CH_MESSAGE_DELTA, CH_TYPING,
    CH_STATUS, CH_REACTIONS, CH_POLLS,
    CH_GROUP_PULLED, CH_CONVO_UPDATED, CH_CONVENE,
    CH_BOARDS, CH_DOCS, CH_CALENDAR_REMINDER, CH_CALENDAR_EVENTS, CH_DOC_MENTION,
  ).then((count) => {
    console.log(`[ws] subscribed to ${count} redis channels`)
  })

  sub.on('message', (channel, payload) => {
    // Doc channels are room-scoped, not company-scoped — skip them here.
    if (channel === 'cumora:doc.update' || channel === 'cumora:doc.awareness') return
    // Tenant-aware fan-out: only deliver an event to a socket if the event's
    // companyId is in the socket's set of memberships. Untagged events are
    // dropped (no leakage), since every publisher is expected to tag.
    let event: RoutedRedisEvent
    try {
      event = JSON.parse(payload) as RoutedRedisEvent
    } catch { /* malformed — drop */ return }

    const companyId = typeof event.companyId === 'string' ? event.companyId : undefined
    if (!companyId) {
      // Conservative: untagged events have no tenant — refuse to route.
      // (If an untagged event ever reaches here it's a publisher bug; logging
      // helps catch the gap during the rollout.)
      console.warn('[ws] dropping untagged event')
      return
    }

    // Membership resolution is asynchronous. Serialize per conversation (or
    // company for workspace-wide frames) so a message and its delta/reaction
    // cannot be reordered while independent rooms still route in parallel.
    const routeKey = event.conversationId
      ? `${companyId}:conversation:${event.conversationId}`
      : `${companyId}:workspace`
    const previous = redisFanoutQueues.get(routeKey) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      const recipients = await resolveWsEventRecipientUserIds(event)
      for (const c of clients) {
        if (!recipients.has(c.userId)) continue
        if (c.ws.readyState !== c.ws.OPEN) continue
        // Backpressure guard (OOM fix): `ws.send()` buffers unsent frames in
        // process memory when a socket can't drain (slow/stuck client). Under a
        // high broadcast rate that buffer grows UNBOUNDED across clients → the pod
        // OOMs. If a socket is backed up past the cap it isn't keeping up — drop
        // this frame for it; if it's wildly backed up, terminate it to reclaim the
        // memory (it reconnects and re-syncs via REST). Bounds WS memory to
        // ~WS_MAX_BUFFERED_BYTES per client.
        const buffered = c.ws.bufferedAmount
        if (buffered > WS_TERMINATE_BUFFERED_BYTES) {
          try { c.ws.terminate() } catch { /* ignore */ }
          continue
        }
        if (buffered > WS_MAX_BUFFERED_BYTES) continue // skip frame; let it drain
        try { c.ws.send(payload) } catch { /* ignore */ }
      }
    })
    redisFanoutQueues.set(routeKey, current)
    void current.catch((error) => {
      // Fail closed: a routing lookup failure drops the frame instead of
      // falling back to the stale socket membership snapshot.
      console.warn(`[ws] live authorization lookup failed for ${routeKey}`, error)
    }).finally(() => {
      if (redisFanoutQueues.get(routeKey) === current) redisFanoutQueues.delete(routeKey)
    })
  })

  // Heartbeat sweeper. Real-deal human presence used to drift because TCP
  // can keep a half-open socket "alive" for many minutes after the
  // laptop sleeps / network drops, so the close handler never fired and
  // the user stayed 'avail' forever. Now we actively ping every 30s; a
  // client that doesn't pong before the NEXT tick is terminated, which
  // routes through the same close handler that decrements the presence
  // counter. End-to-end effect: status flips to 'resting' within ~60s
  // of a real disconnect.
  const HEARTBEAT_MS = 30_000
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.isAlive) {
        // Missed two ticks in a row — kill it. terminate() bypasses the
        // close handshake and fires our 'close' listener immediately.
        try { c.ws.terminate() } catch { /* ignore */ }
        continue
      }
      c.isAlive = false
      try { c.ws.ping() } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}
