/**
 * Helper for any participant to start (or extend) a private 1-on-1 chat
 * with another participant. There is no special "side-channel" model on
 * the backend: every DM is a `kind='direct'` conversation with two members.
 * An agent recipient's mailbox scheduler wakes them on the new message via
 * the standard CH_MESSAGE_NEW path, and they reply through `cumora reply`.
 *
 * (The frontend exposes a "peek" tab where the user can read these
 * agent-agent threads — that's a purely client-side affordance and
 * doesn't change the data model.)
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW } from '../redis.js'
import { enqueueBroadcast, nudgeRealtimeOutbox } from '../realtime-outbox.js'

/** Find an existing direct conversation between two participants, or
 *  create one and return its id. Order-independent on members. */
async function findOrCreateDirect(
  client: PoolClient,
  aId: string,
  bId: string,
  companyId: string,
  topic: string | null,
  aName: string,
  bName: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM conversations
       WHERE kind = 'direct'
         AND members @> $1::jsonb
         AND members @> $2::jsonb
         AND jsonb_array_length(members) = 2
         AND company_id = $3
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
    [JSON.stringify([aId]), JSON.stringify([bId]), companyId],
  )
  if (rows[0]) {
    if (topic) {
      await client.query(
        `UPDATE conversations SET topic = $2, updated_at = NOW() WHERE id = $1`,
        [rows[0].id, topic],
      )
    }
    return rows[0].id
  }

  const id = `direct-${randomUUID().slice(0, 12)}`
  await client.query(
    `INSERT INTO conversations
       (id, kind, title, members, company_id, topic)
     VALUES ($1, 'direct', $2, $3::jsonb, $4, $5)`,
    [id, `${aName} ↔ ${bName}`, JSON.stringify([aId, bId]), companyId, topic ?? null],
  )
  return id
}

/** Atomic per-conversation sequence claim — same mechanism as cmdReply
 *  and the HTTP POST messages handler. */
async function nextConversationSequence(client: PoolClient, conversationId: string): Promise<number> {
  const { rows } = await client.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  return rows[0]?.seq ?? 1
}

/** Ensure one direct conversation exists for an active same-tenant pair.
 * All DM creation entry points share the same participant lock order and
 * advisory pair key, preventing stale/departed members and duplicate rooms. */
export async function ensureDirectConversation(args: {
  companyId: string
  firstId: string
  secondId: string
  topic?: string | null
}): Promise<string> {
  if (args.firstId === args.secondId) throw new Error('cannot open a DM with yourself')
  const participantIds = [args.firstId, args.secondId].sort()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: participants } = await client.query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM participants p
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
      [args.companyId, participantIds],
    )
    if (participants.length !== 2) throw new Error('direct-chat participant is foreign, departed, or missing')
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [args.companyId, JSON.stringify(participantIds)],
    )
    const names = new Map(participants.map((participant) => [participant.id, participant.name]))
    const conversationId = await findOrCreateDirect(
      client,
      args.firstId,
      args.secondId,
      args.companyId,
      args.topic ?? null,
      names.get(args.firstId) ?? args.firstId,
      names.get(args.secondId) ?? args.secondId,
    )
    await client.query(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 1) ON CONFLICT (conversation_id) DO NOTHING`,
      [conversationId],
    )
    await client.query('COMMIT')
    return conversationId
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Open (or post into) a private 1-on-1 chat between two participants.
 *  Idempotent on the conversation creation — repeated calls between the
 *  same pair reuse the existing direct conversation. */
export async function startPrivateChat(args: {
  instigatorId: string
  partnerId: string
  topic: string
  opening: string
}): Promise<{ conversationId: string; messageId: string }> {
  const { instigatorId, partnerId, topic, opening } = args
  // Humans and agents use the same direct-conversation model. Validate both
  // endpoints by active participant existence rather than agent persona presence.
  if (instigatorId === partnerId) throw new Error('cannot open a DM with yourself')
  const { rows: tenantRows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM participants
      WHERE id = $1 AND kind IN ('agent', 'human') AND departed_at IS NULL
      LIMIT 1`,
    [instigatorId],
  )
  const companyId = tenantRows[0]?.company_id
  if (!companyId) throw new Error(`private-chat instigator not found: ${instigatorId}`)

  let conversationId = ''
  const messageId = `m-${randomUUID()}`
  let sequence = 0
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participantIds = [instigatorId, partnerId].sort()
    const { rows: participants } = await client.query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM participants p
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
    if (participants.length !== 2) {
      throw new Error(`private-chat partner is foreign, departed, or missing: ${partnerId}`)
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [companyId, JSON.stringify(participantIds)],
    )
    const names = new Map(participants.map((participant) => [participant.id, participant.name]))
    conversationId = await findOrCreateDirect(
      client,
      instigatorId,
      partnerId,
      companyId,
      topic || null,
      names.get(instigatorId) ?? instigatorId,
      names.get(partnerId) ?? partnerId,
    )
    sequence = await nextConversationSequence(client, conversationId)
    await client.query(
      `INSERT INTO messages
         (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [messageId, conversationId, instigatorId, opening, sequence, companyId],
    )
    await client.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId])
    await client.query(
      `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
      [instigatorId, conversationId],
    )
    await enqueueBroadcast(client, CH_MESSAGE_NEW, {
      type: 'message.new',
      conversationId,
      companyId,
      message: {
        id: messageId,
        conversationId,
        authorId: instigatorId,
        kind: 'text',
        body: opening,
        sequence,
        at: new Date().toISOString(),
      },
    })
    await client.query('COMMIT')
    nudgeRealtimeOutbox()
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  return { conversationId, messageId }
}
