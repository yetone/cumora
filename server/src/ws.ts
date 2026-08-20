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

// Per-client WebSocket send backpressure caps (OOM fix). A socket that can't
// drain makes `ws` buffer unsent frames in process memory; without a cap, a high
// broadcast rate grows that buffer unbounded across clients until the pod OOMs.
// Above MAX we stop sending new frames to that client (let it drain); above
// TERMINATE it's hopelessly behind, so we kill it to reclaim the memory (it
// reconnects + re-syncs via REST).
const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024        // 2 MB
const WS_TERMINATE_BUFFERED_BYTES = 8 * 1024 * 1024  // 8 MB

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

/** Look up a doc + verify the caller's tenant membership in one shot.
 *  Returns null when the doc doesn't exist OR the caller can't see it —
 *  same opaque posture the chat handlers use to avoid leaking existence. */
async function docCompanyFor(documentId: string, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT d.company_id
       FROM documents d
       JOIN company_members m ON m.company_id = d.company_id AND m.user_id = $2
      WHERE d.id = $1
      LIMIT 1`,
    [documentId, userId],
  )
  return rows[0]?.company_id ?? null
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return
  try { ws.send(JSON.stringify(payload)) } catch { /* ignore */ }
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
    const subRec: DocSubscriber = {
      originId: c.originId,
      onUpdate: (update, originId) => {
        sendJson(c.ws, {
          type: 'doc.update',
          documentId,
          updateB64: Buffer.from(update).toString('base64'),
          originId,
        })
      },
      onAwareness: (update, originId) => {
        sendJson(c.ws, {
          type: 'doc.awareness',
          documentId,
          updateB64: Buffer.from(update).toString('base64'),
          originId,
        })
      },
    }
    const { initialState } = await docSubscribe(documentId, companyId, subRec)
    c.docSubs.set(documentId, subRec)
    sendJson(c.ws, {
      type: 'doc.sync',
      documentId,
      stateB64: Buffer.from(initialState).toString('base64'),
      originId: c.originId,
    })
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
    const companyId = await docCompanyFor(documentId, c.userId)
    if (!companyId) return
    const buf = Buffer.from(updateB64, 'base64')
    const update = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    await docApplyLocalUpdate(documentId, companyId, c.originId, c.userId, update)
    return
  }

  if (type === 'doc.awareness') {
    const subRec = c.docSubs.get(documentId)
    if (!subRec) return
    const updateB64 = typeof msg.updateB64 === 'string' ? msg.updateB64 : ''
    if (!updateB64) return
    const companyId = await docCompanyFor(documentId, c.userId)
    if (!companyId) return
    const buf = Buffer.from(updateB64, 'base64')
    const update = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    await docBroadcastAwareness(documentId, companyId, c.originId, update)
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

  // Resolve the mentioned ids that actually belong to this tenant.
  // Match against `participants` (covers both humans + agents).
  const { rows: validRows } = await pool.query<{ id: string; kind: string; name: string }>(
    `SELECT id, kind, name FROM participants
      WHERE company_id = $1 AND id = ANY($2::text[])`,
    [companyId, requestedIds],
  )
  if (validRows.length === 0) return

  // Doc metadata for the broadcast payload — title + the conversation
  // (if any) the doc is pinned to. The pinned convo is the preferred
  // surface for the agent-wake chat ping; falling back to a 1:1 DM
  // when the doc isn't pinned avoids dragging unrelated members into
  // a chat noise loop.
  const { rows: docRows } = await pool.query<{ title: string; conversation_id: string | null }>(
    `SELECT title, conversation_id FROM documents WHERE id = $1 AND company_id = $2`,
    [documentId, companyId],
  )
  const documentTitle = docRows[0]?.title ?? 'Untitled'
  const pinnedConversationId = docRows[0]?.conversation_id ?? null

  // Mentioner display name (humans live in `users`, agents in
  // `participants`). Fall back to the id if neither has a name.
  const mentionerName = await resolveDisplayName(mentionerId, companyId)

  // Dedup against the last 60 seconds. We don't try for global
  // uniqueness — that would falsely block legitimate re-mentions hours
  // later — just enough to absorb the editor's per-keystroke chatter.
  const freshIds: string[] = []
  for (const row of validRows) {
    const { rows: recent } = await pool.query<{ id: string }>(
      `SELECT id FROM document_mentions
        WHERE document_id = $1 AND mentioner_id = $2 AND mentioned_id = $3
          AND created_at > NOW() - INTERVAL '60 seconds'
        LIMIT 1`,
      [documentId, mentionerId, row.id],
    )
    if (recent[0]) continue
    freshIds.push(row.id)
    await pool.query(
      `INSERT INTO document_mentions
        (id, document_id, company_id, mentioner_id, mentioned_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [`dm_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
       documentId, companyId, mentionerId, row.id],
    )
    // Agents: drop an agent_log breadcrumb so the mention surfaces in
    // `cumora log`. Humans don't have this surface; the toast is
    // their notification.
    if (row.kind === 'agent') {
      await pool.query(
        `INSERT INTO agent_log (id, agent_id, company_id, kind, body, ref)
         VALUES ($1, $2, $3, 'doc_mention', $4, $5::jsonb)`,
        [
          `log_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          row.id, companyId,
          `${mentionerName} @-mentioned you in doc "${documentTitle}"`,
          JSON.stringify({ documentId, mentionerId }),
        ],
      ).catch((e) => console.warn('[doc.mention] agent_log insert failed', e))

      // Also post a real `text` message authored by the mentioner so
      // the agent actually WAKES + has context to act on. The mailbox
      // scheduler watches CH_MESSAGE_NEW and runs an agent turn for
      // every recipient. Without this step the agent only sees the
      // doc-mention via `cumora log` on its NEXT natural wake — which
      // might never come if no one else messages it.
      try {
        await postDocMentionWake({
          companyId,
          mentionerId,
          mentionerName,
          agentId: row.id,
          agentName: row.name,
          documentId,
          documentTitle,
          pinnedConversationId,
        })
      } catch (e) {
        console.warn(`[doc.mention] wake post for ${row.id} failed`, e)
      }
    }
  }
  if (freshIds.length === 0) return

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
  mentionerName: string
  agentId: string
  agentName: string
  documentId: string
  documentTitle: string
  pinnedConversationId: string | null
}): Promise<void> {
  const {
    companyId, mentionerId, agentId, agentName,
    documentId, documentTitle, pinnedConversationId,
  } = args

  // 1) Try the pinned convo if both mentioner + agent are members.
  let conversationId: string | null = null
  if (pinnedConversationId) {
    const { rows } = await pool.query<{ members: string[] }>(
      `SELECT members FROM conversations WHERE id = $1 AND company_id = $2`,
      [pinnedConversationId, companyId],
    )
    const members = rows[0]?.members ?? []
    if (members.includes(mentionerId) && members.includes(agentId)) {
      conversationId = pinnedConversationId
    }
  }

  // 2) Existing DM (same 2-member query the /conversations/direct
  //    handler uses — single source of truth for the dedup shape).
  if (!conversationId) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE kind = 'direct' AND company_id = $3
          AND members @> to_jsonb(ARRAY[$1::text]) AND members @> to_jsonb(ARRAY[$2::text])
          AND jsonb_array_length(members) = 2
        ORDER BY updated_at DESC LIMIT 1`,
      [mentionerId, agentId, companyId],
    )
    if (rows[0]) conversationId = rows[0].id
  }

  // 3) Create one.
  if (!conversationId) {
    const fresh = `direct-${agentId}-${randomUUID().slice(0, 6)}`
    await pool.query(
      `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, company_id)
       VALUES ($1, 'direct', $2, NULL, $3::jsonb, FALSE, NULL, $4)`,
      [fresh, agentName, JSON.stringify([mentionerId, agentId]), companyId],
    )
    await pool.query(
      `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 1)
       ON CONFLICT (conversation_id) DO NOTHING`,
      [fresh],
    )
    conversationId = fresh
  }

  // Allocate a sequence + insert the message. Same shape sendMessage uses.
  const seqRes = await pool.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  const sequence = seqRes.rows[0]?.seq ?? 1
  const messageId = `m-${randomUUID()}`
  const body = `@${agentId} heads-up — I @-mentioned you in the doc "${documentTitle}". Take a look with \`cumora doc read ${documentId}\`, then either reply here or edit the doc directly (\`cumora doc append/replace ${documentId} …\`).`
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
    [messageId, conversationId, mentionerId, body, sequence, companyId],
  )
  await pool.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId])

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
  await publish(CH_MESSAGE_NEW, event)
}

/** Display-name lookup for the mention payload. Tries users first
 *  (humans live there), falls back to participants (covers agents and
 *  is also a backstop for humans that haven't logged in yet), finally
 *  defaults to the raw id. Best-effort — the renderer will fall back
 *  to its own participant store if the name comes back blank. */
async function resolveDisplayName(id: string, companyId: string): Promise<string> {
  try {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM users WHERE id = $1 LIMIT 1`, [id],
    )
    if (rows[0]?.name) return rows[0].name
  } catch { /* table may not exist in legacy schemas — fall through */ }
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM participants WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, companyId],
  )
  return rows[0]?.name ?? id
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
    let companyId: string | undefined
    try {
      const parsed = JSON.parse(payload) as { companyId?: string }
      if (typeof parsed.companyId === 'string') companyId = parsed.companyId
    } catch { /* malformed — drop */ return }

    if (!companyId) {
      // Conservative: untagged events have no tenant — refuse to route.
      // (If an untagged event ever reaches here it's a publisher bug; logging
      // helps catch the gap during the rollout.)
      console.warn('[ws] dropping untagged event')
      return
    }

    for (const c of clients) {
      if (!c.companies.has(companyId)) continue
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
