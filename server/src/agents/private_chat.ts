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
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW, publish } from '../redis.js'
import { companyIdForParticipant } from '../tenant.js'

/** A participant's display name + kind, for ANY participant — human OR agent.
 *  Unlike getPersona (which is agent-only: `kind='agent'`), this resolves humans
 *  too, so an agent can open a DM with a person and we can title the thread with
 *  the person's real name. */
async function participantBrief(id: string): Promise<{ name: string; kind: string } | null> {
  const { rows } = await pool.query<{ name: string; kind: string }>(
    `SELECT name, kind FROM participants WHERE id = $1 AND departed_at IS NULL`,
    [id],
  )
  return rows[0] ?? null
}

/** Find an existing direct conversation between two participants, or
 *  create one and return its id. Order-independent on members. */
async function findOrCreateDirect(
  aId: string,
  bId: string,
  companyId: string | null,
  topic: string | null,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM conversations
       WHERE kind = 'direct'
         AND members @> $1::jsonb
         AND members @> $2::jsonb
         AND jsonb_array_length(members) = 2
         ${companyId ? 'AND company_id = $3' : ''}
       ORDER BY created_at DESC LIMIT 1`,
    companyId
      ? [JSON.stringify([aId]), JSON.stringify([bId]), companyId]
      : [JSON.stringify([aId]), JSON.stringify([bId])],
  )
  if (rows[0]) {
    if (topic) {
      await pool.query(
        `UPDATE conversations SET topic = $2, updated_at = NOW() WHERE id = $1`,
        [rows[0].id, topic],
      )
    }
    return rows[0].id
  }

  const [aBrief, bBrief] = await Promise.all([participantBrief(aId), participantBrief(bId)])
  const aName = aBrief?.name ?? aId
  const bName = bBrief?.name ?? bId
  const id = `direct-${randomUUID().slice(0, 12)}`
  await pool.query(
    `INSERT INTO conversations
       (id, kind, title, members, company_id, topic)
     VALUES ($1, 'direct', $2, $3::jsonb, $4, $5)`,
    [id, `${aName} ↔ ${bName}`, JSON.stringify([aId, bId]), companyId, topic ?? null],
  )
  return id
}

/** Atomic per-conversation sequence claim — same mechanism as cmdReply
 *  and the HTTP POST messages handler. */
async function nextConversationSequence(conversationId: string): Promise<number> {
  const { rows } = await pool.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  return rows[0]?.seq ?? 1
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
  const [instigator, partner] = await Promise.all([
    participantBrief(instigatorId),
    participantBrief(partnerId),
  ])
  if (!instigator) throw new Error(`private-chat instigator not found: ${instigatorId}`)
  if (!partner) throw new Error(`private-chat partner not found: ${partnerId}`)

  const companyId = (await companyIdForParticipant(instigatorId)) ?? null
  const conversationId = await findOrCreateDirect(instigatorId, partnerId, companyId, topic || null)

  const messageId = `m-${randomUUID()}`
  const sequence = await nextConversationSequence(conversationId)
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
    [messageId, conversationId, instigatorId, opening, sequence, companyId],
  )
  await pool.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId])

  // Posting auto-acks the instigator on this conversation.
  await pool.query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
    [instigatorId, conversationId],
  )

  // Same channel as every other message. Agent recipients wake through the
  // mailbox scheduler; human recipients see the direct conversation normally.
  await publish(CH_MESSAGE_NEW, {
    type: 'message.new',
    conversationId,
    companyId: companyId ?? undefined,
    message: {
      id: messageId, conversationId, authorId: instigatorId,
      kind: 'text', body: opening, sequence,
      at: new Date().toISOString(),
    },
  })

  return { conversationId, messageId }
}
