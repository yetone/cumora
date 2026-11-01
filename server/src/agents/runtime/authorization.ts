import type { PoolClient } from 'pg'
import { pool } from '../../db/pool.js'
import { storageKeyFromPublicUrl } from '../../storage.js'
import type { AgentRuntimeClaims } from './jwt.js'

/**
 * A signed runtime token captures the agent's tenant and exact Computer
 * placement at mint time. Resolve the live rows as the authorization source of
 * truth so moving/offboarding an Agent or revoking its Computer invalidates
 * every previously minted token. `assignmentId` closes the move-away/move-back
 * case where tenant and Computer values end up equal again.
 */
export async function isRuntimeAgentAuthorized(
  claims: Pick<AgentRuntimeClaims, 'sub' | 'companyId' | 'computerId' | 'assignmentId'>,
): Promise<boolean> {
  if (!claims.companyId) return false
  const { rowCount } = await pool.query(
    `SELECT 1
       FROM participants p
       LEFT JOIN computers c
         ON c.id = p.computer_id
        AND c.company_id = p.company_id
        AND c.revoked_at IS NULL
      WHERE p.id = $1 AND p.company_id = $2
        AND p.computer_id IS NOT DISTINCT FROM $3::text
        AND p.runtime_assignment_id = $4
        AND p.kind = 'agent' AND p.departed_at IS NULL
        AND (p.computer_id IS NULL OR c.id IS NOT NULL)
      LIMIT 1`,
    [claims.sub, claims.companyId, claims.computerId, claims.assignmentId],
  )
  return rowCount === 1
}

/** Legacy rows may not cache a storage key. Derive one only through the same
 *  configured-origin parser used when serving that row; arbitrary URLs from a
 *  message can never authorize an attachment read. */
export function attachmentUrlMatchesStorageKey(url: string, key: string): boolean {
  return storageKeyFromPublicUrl(url) === key
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

/** Check the current agent and every requested conversation membership, then
 * release the connection before the Redis side effect. Holding `FOR SHARE`
 * across that publish pinned a pool slot and the membership rows for the
 * whole round trip. A revoke that commits in the gap after this check can
 * still observe one in-flight publish. */
export async function withRuntimeConversationAuthorization<T>(args: {
  agentId: string
  companyId: string
  conversationIds: readonly string[]
  task: () => Promise<T>
}): Promise<{ authorized: boolean; result?: T }> {
  const conversationIds = [...new Set(args.conversationIds)].sort()
  const client = await pool.connect()
  let authorized = false
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
    await client.query('COMMIT')
    authorized = true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (!authorized) return { authorized: false }
  const result = await args.task()
  return { authorized: true, result }
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

/** Authorize an attachment object only when it is referenced by a message the
 *  runtime agent can currently read. The storage key is a selector; membership
 *  and tenant are the authority. */
export async function withRuntimeAttachmentReadAuthorization(args: {
  agentId: string
  companyId: string
  key: string
  /** When supplied, the exact message must also currently be readable. */
  messageId?: string
}): Promise<boolean> {
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
      return false
    }
    const allowed = await client.query(
      `SELECT 1
         FROM messages m
         JOIN conversations c
           ON c.id = m.conversation_id AND c.company_id = m.company_id
        WHERE m.company_id = $1
          AND ($4::text IS NULL OR m.id = $4)
          AND (
            EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id
                 AND cm.company_id = c.company_id
                 AND cm.participant_id = $2
            )
            OR (m.kind = 'system' AND m.delivery_recipient_id = $2)
          )
          AND (
            m.attachment->>'key' = $3
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(m.attachments) = 'array'
                       THEN m.attachments ELSE '[]'::jsonb END
                ) candidate
               WHERE candidate->>'key' = $3
            )
          )
          AND EXISTS (
            SELECT 1 FROM attachment_grants ag
             WHERE ag.storage_key = $3
               AND ag.company_id = $1
               AND ag.status = 'active'
          )
        LIMIT 1
        FOR SHARE OF c, m`,
      [args.companyId, args.agentId, args.key, args.messageId ?? null],
    )
    if (allowed.rowCount) {
      await client.query('COMMIT')
      return true
    }

    // Older rows predate persisted storage keys. Re-signing derives their key
    // from the URL, so authorization must accept the same legacy reference.
    // Narrow in SQL to rows whose URL contains this unguessable key, then apply
    // the configured-origin parser before authorizing the fetch.
    const legacy = await client.query<{ attachment: { url?: unknown } | null }>(
      `SELECT m.attachment
         FROM messages m
         JOIN conversations c
           ON c.id = m.conversation_id AND c.company_id = m.company_id
        WHERE m.company_id = $1
          AND ($4::text IS NULL OR m.id = $4)
          AND jsonb_typeof(m.attachment) = 'object'
          AND strpos(COALESCE(m.attachment->>'url', ''), $3) > 0
          AND EXISTS (
            SELECT 1 FROM attachment_grants ag
             WHERE ag.storage_key = $3
               AND ag.company_id = $1
               AND ag.status = 'active'
          )
          AND (
            EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id
                 AND cm.company_id = c.company_id
                 AND cm.participant_id = $2
            )
            OR (m.kind = 'system' AND m.delivery_recipient_id = $2)
          )
        LIMIT 200`,
      [args.companyId, args.agentId, args.key, args.messageId ?? null],
    )
    const derived = legacy.rows.some((row) => {
      const url = row.attachment?.url
      return typeof url === 'string' && attachmentUrlMatchesStorageKey(url, args.key)
    })
    await client.query(derived ? 'COMMIT' : 'ROLLBACK')
    return derived
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
