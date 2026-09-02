/** Helper for tool-driven group pulls (separate from the periodic scanner). */
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { CH_GROUP_PULLED, CH_MESSAGE_NEW, publish } from '../redis.js'

/** Hours an agent must wait between human-interrupting group pulls. */
const PULL_COOLDOWN_HOURS = 6

export async function startPulledGroup(args: {
  instigatorId: string
  title: string
  members: string[]
  reason: string
  opening: string
}): Promise<{ conversationId: string }> {
  const { instigatorId, title, reason, opening } = args
  const members = [...new Set([...args.members, instigatorId])]
  const { rows: tenantRows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM participants
      WHERE id = $1 AND kind = 'agent' AND departed_at IS NULL
      LIMIT 1`,
    [instigatorId],
  )
  const companyId = tenantRows[0]?.company_id
  if (!companyId) throw new Error(`pull-group instigator not found: ${instigatorId}`)

  const conversationId = `pulled-${randomUUID().slice(0, 8)}`
  const messageId = `m-${randomUUID()}`
  const pulledAt = new Date().toISOString()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Lock every endpoint in deterministic order. A foreign/departed target,
    // or a tenant move that commits while this command waits, makes the count
    // mismatch and prevents creation of a cross-tenant members array.
    const participantIds = [...members].sort()
    const { rows: participants } = await client.query<{
      id: string; name: string; kind: 'agent' | 'human'
    }>(
      `SELECT id, name, kind FROM participants
        WHERE company_id = $1 AND id = ANY($2::text[])
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        ORDER BY id FOR SHARE`,
      [companyId, participantIds],
    )
    if (participants.length !== participantIds.length) {
      throw new Error('pull-group members must all be active participants in the instigator tenant')
    }
    const includesHuman = participants.some((participant) => participant.kind === 'human')

    if (includesHuman) {
      const { rows: cooldown } = await client.query<{ id: string; title: string; at: string }>(
        `SELECT c.id, c.title, c.created_at AS at
           FROM conversations c
          WHERE c.kind = 'group'
            AND c.pulled_by ->> 'agentId' = $1
            AND c.created_at > NOW() - ($2 || ' hours')::interval
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
                JOIN participants p
                  ON p.id = cm.participant_id
                 AND p.company_id = cm.company_id
               WHERE cm.conversation_id = c.id
                 AND cm.company_id = c.company_id
                 AND p.kind <> 'agent'
            )
          ORDER BY c.created_at DESC
          LIMIT 1`,
        [instigatorId, String(PULL_COOLDOWN_HOURS)],
      )
      if (cooldown[0]) {
        const minsAgo = Math.round((Date.now() - new Date(cooldown[0].at).getTime()) / 60_000)
        throw new Error(
          `pull-group rate-limited: you (${instigatorId}) already pulled "${cooldown[0].title}" ${minsAgo} minutes ago ` +
          `(id: ${cooldown[0].id}). Cooldown is ${PULL_COOLDOWN_HOURS}h for pulls that include a human. ` +
          `Send a message in that group, or @mention people in an existing conversation, instead.`,
        )
      }
    }

    await client.query(
      `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, pulled_by, company_id)
       VALUES ($1, 'group', $2, $3, $4::jsonb, FALSE, 'fresh-pulled', $5::jsonb, $6)`,
      [
        conversationId,
        title,
        `cross-project · ${members.length}`,
        JSON.stringify(members),
        JSON.stringify({ agentId: instigatorId, at: pulledAt, reason }),
        companyId,
      ],
    )
    await client.query(
      `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 2)`,
      [conversationId],
    )
    const instigatorName = participants.find((participant) => participant.id === instigatorId)?.name ?? instigatorId
    await client.query(
      `INSERT INTO convening_info
         (conversation_id, pulled_by_id, headline_lead, headline_tail, subhead,
          who_and_why, evidence, asks, trigger, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)`,
      [
        conversationId,
        instigatorId,
        title,
        '',
        reason,
        JSON.stringify(members.map((participantId) => ({ pid: participantId, reason: '' }))),
        JSON.stringify({ tail: { tag: 'context', copy: reason } }),
        JSON.stringify([]),
        JSON.stringify({ when: new Date().toLocaleString(), what: `${instigatorName} pulled this together via tool call.` }),
        JSON.stringify([reason]),
      ],
    )
    await client.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, 1, $5)`,
      [messageId, conversationId, instigatorId, opening, companyId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  await publish(CH_GROUP_PULLED, {
    type: 'group.pulled', conversationId, companyId, pulledById: instigatorId,
  }).catch((error) => {
    console.warn(`[pull_group] durable conversation ${conversationId} committed but group publish failed`, error)
  })
  await publish(CH_MESSAGE_NEW, {
    type: 'message.new',
    conversationId,
    companyId,
    message: {
      id: messageId, conversationId, authorId: instigatorId,
      kind: 'text', body: opening, sequence: 1, at: pulledAt,
    },
  }).catch((error) => {
    console.warn(`[pull_group] durable message ${messageId} committed but publish failed`, error)
  })

  console.log(`[pull_group] ${instigatorId} pulled ${conversationId}: ${title}`)
  return { conversationId }
}
