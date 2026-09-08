import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'

export type IdempotentCreateDomain = 'board' | 'document' | 'calendar-event'

const TABLE_BY_DOMAIN: Record<IdempotentCreateDomain, string> = {
  board: 'boards',
  document: 'documents',
  'calendar-event': 'calendar_events',
}

export class IdempotencyConflictError extends Error {
  readonly status = 409
  constructor() {
    super('requestId was already used with different input')
  }
}

export function parseRequestId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new TypeError('requestId must be a string')
  const requestId = value.trim()
  if (!requestId || requestId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(requestId)) {
    throw new TypeError('requestId must be 1-128 URL-safe characters')
  }
  return requestId
}

/** Stable hash over already-normalized command input. */
export function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Serialize retries for one actor-scoped create request and return the entity
 * produced by an earlier committed attempt, if any. The advisory lock lives
 * until the surrounding transaction commits/rolls back.
 */
export async function findIdempotentCreate(
  client: PoolClient,
  args: {
    domain: IdempotentCreateDomain
    companyId: string
    actorId: string
    requestId: string | null
    requestHash: string
  },
): Promise<{ id: string } | null> {
  if (!args.requestId) return null
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
    [`create:${args.domain}`, `${args.companyId}:${args.actorId}:${args.requestId}`],
  )
  const table = TABLE_BY_DOMAIN[args.domain]
  const { rows } = await client.query<{ id: string; creation_request_hash: string }>(
    `SELECT id, creation_request_hash
       FROM ${table}
      WHERE company_id = $1
        AND created_by = $2
        AND creation_request_id = $3
      LIMIT 1`,
    [args.companyId, args.actorId, args.requestId],
  )
  const existing = rows[0]
  if (!existing) return null
  if (existing.creation_request_hash !== args.requestHash) {
    throw new IdempotencyConflictError()
  }
  return { id: existing.id }
}
