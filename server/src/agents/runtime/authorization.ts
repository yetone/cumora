import type { PoolClient } from 'pg'
import { pool } from '../../db/pool.js'

/**
 * A signed runtime token captures the agent's tenant at mint time. Resolve the
 * live participant row as the authorization source of truth so moving or
 * offboarding an agent revokes every previously minted token.
 */
export async function isRuntimeAgentAuthorized(
  agentId: string,
  companyId: string | null,
): Promise<boolean> {
  if (!companyId) return false
  const { rowCount } = await pool.query(
    `SELECT 1 FROM participants
      WHERE id = $1 AND company_id = $2
        AND kind = 'agent' AND departed_at IS NULL
      LIMIT 1`,
    [agentId, companyId],
  )
  return rowCount === 1
}

/** Hold the live runtime identity and every referenced run stable through an
 *  observability mutation. Participant reassignment/offboarding updates
 *  conflict with FOR SHARE; run GC and competing run mutations conflict with
 *  FOR UPDATE. Sorted run ids give concurrent batches one lock order. */
export async function withRuntimeAgentRunAuthorization<T>(args: {
  agentId: string
  companyId: string
  runIds: readonly string[]
  task: (client: PoolClient) => Promise<T>
}): Promise<{ authorized: boolean; result?: T }> {
  const runIds = [...new Set(args.runIds)].sort()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind = 'agent' AND departed_at IS NULL
        FOR SHARE`,
      [args.agentId, args.companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    if (runIds.length > 0) {
      const runs = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs
          WHERE id = ANY($1::text[])
            AND agent_id = $2 AND company_id = $3
          ORDER BY id FOR UPDATE`,
        [runIds, args.agentId, args.companyId],
      )
      if (runs.rows.length !== runIds.length) {
        await client.query('ROLLBACK')
        return { authorized: false }
      }
    }
    const result = await args.task(client)
    await client.query('COMMIT')
    return { authorized: true, result }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Hold the current agent and every requested conversation membership stable
 * while an ephemeral Redis/pubsub side effect runs. Membership mutation uses
 * the same participant -> conversation lock order, so a revoke is linearized
 * either wholly before or wholly after the side effect. */
export async function withRuntimeConversationAuthorization<T>(args: {
  agentId: string
  companyId: string
  conversationIds: readonly string[]
  task: () => Promise<T>
}): Promise<{ authorized: boolean; result?: T }> {
  const conversationIds = [...new Set(args.conversationIds)].sort()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind = 'agent' AND departed_at IS NULL
        FOR SHARE`,
      [args.agentId, args.companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    if (conversationIds.length > 0) {
      const conversations = await client.query<{ id: string }>(
        `SELECT c.id FROM conversations c
          WHERE c.company_id = $1 AND c.id = ANY($2::text[])
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id
                 AND cm.company_id = c.company_id
                 AND cm.participant_id = $3
            )
          ORDER BY c.id FOR SHARE OF c`,
        [args.companyId, conversationIds, args.agentId],
      )
      if (conversations.rows.length !== conversationIds.length) {
        await client.query('ROLLBACK')
        return { authorized: false }
      }
    }
    const result = await args.task()
    await client.query('COMMIT')
    return { authorized: true, result }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Authorize a read-cursor advance against the exact persisted message. The
 * durable departure-recipient exception lets a just-kicked agent acknowledge
 * its one terminal system row without restoring conversation access. */
export async function withRuntimeMessageReadAuthorization<T>(args: {
  agentId: string
  companyId: string
  conversationId: string
  messageId: string
  task: (client: PoolClient) => Promise<T>
}): Promise<{ authorized: boolean; result?: T }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind = 'agent' AND departed_at IS NULL
        FOR SHARE`,
      [args.agentId, args.companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    const allowed = await client.query(
      `SELECT m.id
         FROM conversations c
         JOIN messages m
           ON m.id = $4 AND m.conversation_id = c.id AND m.company_id = c.company_id
        WHERE c.id = $1 AND c.company_id = $2
          AND (
            EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id
                 AND cm.company_id = c.company_id
                 AND cm.participant_id = $3
            )
            OR (m.kind = 'system' AND m.delivery_recipient_id = $3)
          )
        FOR SHARE OF c, m`,
      [args.conversationId, args.companyId, args.agentId, args.messageId],
    )
    if (!allowed.rowCount) {
      await client.query('ROLLBACK')
      return { authorized: false }
    }
    const result = await args.task(client)
    await client.query('COMMIT')
    return { authorized: true, result }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
