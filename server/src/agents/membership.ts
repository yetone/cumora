/**
 * Shared membership-change plumbing.
 *
 * Both the agent-side CLI (`cumora invite / leave / kick`) and the
 * human-side HTTP endpoints (`POST /conversations/:id/members`, `POST
 * /conversations/:id/leave`) need to do the same two things on every
 * membership mutation:
 *
 *   1. Post a `kind='system'` message into the conversation describing
 *      what happened (joined / left / kicked), so the audit trail is
 *      visible to remaining members.
 *   2. Enqueue CH_MESSAGE_NEW in the same PostgreSQL transaction. Departure
 *      notices carry a durable delivery recipient so the removed agent still
 *      sees the one row that explains why the conversation disappeared.
 *
 * Putting both in one file keeps the CLI and HTTP paths from drifting.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW, type MessageNewEvent } from '../redis.js'
import { enqueueBroadcast, nudgeRealtimeOutbox } from '../realtime-outbox.js'

export type MembershipKind = 'joined' | 'left' | 'kicked'

export interface MembershipMutationResult {
  /** The current database value after this operation serialized on the row. */
  members: string[]
  /** Audit row committed atomically with the membership change. */
  systemMessageId: string
}

/** Serialize membership authorization against offboarding / tenant moves.
 * Normalized membership writes then lock the conversation row, giving every
 * invite/leave/kick one participant -> conversation lock order. IDs are sorted
 * so cross-kicks cannot deadlock by locking actor/target in opposite orders. */
async function withActiveParticipantLocks<T>(args: {
  participantIds: string[]
  companyId: string
  run: (client: PoolClient) => Promise<T>
}): Promise<T | null> {
  const client = await pool.connect()
  const participantIds = [...new Set(args.participantIds)].sort()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ id: string }>(
      `SELECT id
         FROM participants
        WHERE company_id = $1
          AND id = ANY($2::text[])
          AND departed_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [args.companyId, participantIds],
    )
    if (rows.length !== participantIds.length) {
      await client.query('ROLLBACK')
      return null
    }
    const result = await args.run(client)
    await client.query('COMMIT')
    if (result !== null) nudgeRealtimeOutbox()
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* preserve original error */ })
    throw err
  } finally {
    client.release()
  }
}

async function insertMembershipSystemMessage(args: {
  client: PoolClient
  conversationId: string
  companyId: string
  actorId: string
  kind: MembershipKind
  participantId: string
  members: string[]
}): Promise<MembershipMutationResult> {
  const messageId = `m-${randomUUID()}`
  const sequence = await nextConversationSequenceWithClient(args.client, args.conversationId)
  const body = JSON.stringify({
    kind: args.kind,
    participantId: args.participantId,
    actorId: args.actorId,
  })
  const deliveryRecipientId = args.kind === 'joined' ? null : args.participantId
  await args.client.query(
    `INSERT INTO messages (
       id, conversation_id, author_id, kind, body, sequence, company_id,
       delivery_recipient_id
     ) VALUES ($1,$2,$3,'system',$4,$5,$6,$7)`,
    [
      messageId, args.conversationId, args.actorId, body, sequence,
      args.companyId, deliveryRecipientId,
    ],
  )
  const event: MessageNewEvent = {
    type: 'message.new',
    conversationId: args.conversationId,
    companyId: args.companyId,
    message: {
      id: messageId,
      conversationId: args.conversationId,
      authorId: args.actorId,
      kind: 'system',
      body,
      sequence,
      at: new Date().toISOString(),
      ...(deliveryRecipientId ? { deliveryRecipientId } : {}),
    },
  }
  await enqueueBroadcast(args.client, CH_MESSAGE_NEW, event)
  return { members: args.members, systemMessageId: messageId }
}

async function lockConversationForMembership(args: {
  client: PoolClient
  conversationId: string
  companyId: string
  actorId: string
}): Promise<boolean> {
  const locked = await args.client.query(
    `SELECT c.id
       FROM conversations c
      WHERE c.id = $1 AND c.company_id = $2
      FOR UPDATE OF c`,
    [args.conversationId, args.companyId],
  )
  if (locked.rowCount !== 1) return false

  // This must be a separate statement after the row lock is acquired. If the
  // membership predicate is part of the blocking SELECT, its statement
  // snapshot can still see a membership deleted by the transaction we waited
  // behind even though EvalPlanQual refreshed the conversation tuple.
  const authorized = await args.client.query(
    `SELECT 1 FROM conversation_members
      WHERE conversation_id = $1
        AND company_id = $2
        AND participant_id = $3`,
    [args.conversationId, args.companyId, args.actorId],
  )
  return authorized.rowCount === 1
}

async function refreshMembersProjection(
  client: PoolClient,
  conversationId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ members: string[] }>(
    `SELECT refresh_conversation_members_projection($1) AS members`,
    [conversationId],
  )
  return rows[0]?.members ?? []
}

/**
 * Add one normalized membership row and return the derived JSON projection as
 * it stands after the write. Route-level SELECTs remain friendly preflights;
 * actor authorization is repeated while the conversation row is locked.
 *
 * Returns null when the write was not authorized or no longer necessary. The
 * helper intentionally performs no fallback SELECT: a second statement would
 * create an ABA window in which a removed-and-reinvited actor could turn a
 * rejected mutation into an apparent idempotent success.
 */
export async function addConversationMember(args: {
  conversationId: string
  memberId: string
  /** The member authorizing this mutation. Checked in the UPDATE itself so a
   * concurrent kick/revocation cannot leave a stale request authorized. */
  actorId: string
  companyId: string
}): Promise<MembershipMutationResult | null> {
  const committed = await withActiveParticipantLocks({
    participantIds: [args.actorId, args.memberId],
    companyId: args.companyId,
    run: async (client) => {
      if (!(await lockConversationForMembership({
        client,
        conversationId: args.conversationId,
        companyId: args.companyId,
        actorId: args.actorId,
      }))) return null

      const inserted = await client.query(
        `INSERT INTO conversation_members (
           conversation_id, company_id, participant_id, ordinal
         )
         SELECT c.id, c.company_id, $2,
                COALESCE(MAX(existing.ordinal) + 1, 0)::integer
           FROM conversations c
           LEFT JOIN conversation_members existing
             ON existing.conversation_id = c.id
            AND existing.company_id = c.company_id
          WHERE c.id = $1 AND c.company_id = $3
          GROUP BY c.id, c.company_id
         ON CONFLICT (conversation_id, participant_id) DO NOTHING
         RETURNING participant_id`,
        [args.conversationId, args.memberId, args.companyId],
      )
      if (!inserted.rowCount) return null
      const members = await refreshMembersProjection(client, args.conversationId)
      return insertMembershipSystemMessage({
        client,
        conversationId: args.conversationId,
        companyId: args.companyId,
        actorId: args.actorId,
        kind: 'joined',
        participantId: args.memberId,
        members,
      })
    },
  })
  return committed
}

/**
 * Delete one normalized membership row and return the rebuilt projection.
 */
export async function removeConversationMember(args: {
  conversationId: string
  memberId: string
  actorId: string
  companyId: string
  /** Leave is allowed to remove the final member. Kick passes this only after
   * explicit --confirm-empty; keeping the cardinality predicate in the UPDATE
   * makes two concurrent kicks re-check it after the row lock is acquired. */
  allowSoleMember?: boolean
  kind: 'left' | 'kicked'
}): Promise<MembershipMutationResult | null> {
  if ((args.kind === 'left') !== (args.actorId === args.memberId)) {
    throw new Error('membership removal kind does not match actor/participant')
  }
  const committed = await withActiveParticipantLocks({
    participantIds: [args.actorId, args.memberId],
    companyId: args.companyId,
    run: async (client) => {
      if (!(await lockConversationForMembership({
        client,
        conversationId: args.conversationId,
        companyId: args.companyId,
        actorId: args.actorId,
      }))) return null

      const removed = await client.query(
        `DELETE FROM conversation_members target
          WHERE target.conversation_id = $1
            AND target.company_id = $3
            AND target.participant_id = $2
            AND (
              $4::boolean
              OR (
                SELECT COUNT(*)::integer
                  FROM conversation_members remaining
                 WHERE remaining.conversation_id = target.conversation_id
                   AND remaining.company_id = target.company_id
                   AND remaining.participant_id <> target.participant_id
              ) <> 1
            )
         RETURNING participant_id`,
        [args.conversationId, args.memberId, args.companyId, Boolean(args.allowSoleMember)],
      )
      if (!removed.rowCount) return null
      const members = await refreshMembersProjection(client, args.conversationId)
      return insertMembershipSystemMessage({
        client,
        conversationId: args.conversationId,
        companyId: args.companyId,
        actorId: args.actorId,
        kind: args.kind,
        participantId: args.memberId,
        members,
      })
    },
  })
  return committed
}

/** Atomically claim the next sequence number for a conversation.
 *  Same UPSERT pattern as the human reply path and `cumora reply`. */
async function nextConversationSequenceWithClient(
  client: PoolClient,
  conversationId: string,
): Promise<number> {
  const { rows } = await client.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  return rows[0]?.seq ?? 1
}

export async function nextConversationSequence(conversationId: string): Promise<number> {
  const { rows } = await pool.query<{ seq: number }>(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
     RETURNING next_sequence - 1 AS seq`,
    [conversationId],
  )
  return rows[0]?.seq ?? 1
}
