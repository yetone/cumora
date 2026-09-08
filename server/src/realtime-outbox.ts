import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { pool } from './db/pool.js'
import { stripLoneSurrogates } from './agents/text-safety.js'
import { publish, type BroadcastEvent } from './redis.js'

/**
 * Transactional realtime outbox.
 *
 * Durable application mutations enqueue their Redis invalidation in the same
 * PostgreSQL transaction.  A bounded background dispatcher performs the
 * network I/O only after commit, so Redis degradation can no longer turn a
 * committed command into an HTTP/CLI failure.  Delivery is at-least-once;
 * `deliveryId` lets consumers deduplicate if they ever need more than the
 * current refetch/idempotent-patch behaviour.
 */

export type Queryable = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

export interface PendingBroadcast {
  id: string
  channel: string
  payload: BroadcastEvent
  attempts: number
}

export interface OutboxDrainResult {
  claimed: number
  published: number
  failed: number
  discarded: number
}

const WORKER_INTERVAL_MS = 1_000
const CLAIM_LEASE_MS = 15_000
const BATCH_SIZE = 32
const MAX_ATTEMPTS = 12
const MAX_AGE_HOURS = 24
const COMPLETED_RETENTION_HOURS = 24
const DISCARDED_RETENTION_DAYS = 7
const CLEANUP_INTERVAL_MS = 60_000
const CLEANUP_BATCH_SIZE = 1_000
const workerId = `outbox-${process.pid}-${randomUUID().slice(0, 8)}`

let workerTimer: NodeJS.Timeout | null = null
let workerRunning = false
let lastCleanupAt = 0

export async function enqueueBroadcast(
  db: Queryable,
  channel: string,
  event: BroadcastEvent,
): Promise<string> {
  const id = randomUUID()
  const payload = { ...event, deliveryId: id }
  await db.query(
    `INSERT INTO realtime_outbox (id, channel, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [id, channel, serializePayload(payload)],
  )
  return id
}

/** Serialize an outbox payload so Postgres will accept it as `jsonb`.
 *
 *  A body truncated mid-emoji — `qr[0].body.slice(0, 240)` on the quote path —
 *  ends in a lone UTF-16 surrogate. JSON.stringify turns that into the literal
 *  ASCII escape `\ud83d`, which survives transport intact and is then rejected:
 *
 *    ERROR:  invalid input syntax for type json
 *    DETAIL: Unicode low surrogate must follow a high surrogate.
 *
 *  That matters here and not before because the enqueue is INSIDE the caller's
 *  transaction. The same payload used to go to redis.publish AFTER COMMIT, where
 *  a lone surrogate was a cosmetic glyph; behind a `::jsonb` cast it rolls the
 *  message back and 500s, so a quote-reply to one emoji-bearing message fails
 *  forever. `messages.body` is TEXT and accepts the same bytes, which is why
 *  only the outbox half dies.
 *
 *  Scrubbing here rather than at each call site is deliberate: every field of
 *  every future event goes through this one cast. The replacer visits every
 *  string in the tree, so nesting and arrays need no traversal of our own. */
function serializePayload(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'string' ? stripLoneSurrogates(value) : value,
  )
}

/** Run a mutation and all of its realtime invalidations in one transaction. */
export async function withOutboxTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    nudgeRealtimeOutbox()
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function claimBatch(limit: number): Promise<PendingBroadcast[]> {
  const { rows } = await pool.query<{
    id: string
    channel: string
    payload: BroadcastEvent
    attempts: number
  }>(
    `WITH candidates AS (
       SELECT id
         FROM realtime_outbox
        WHERE published_at IS NULL
          AND discarded_at IS NULL
          AND available_at <= NOW()
          AND (locked_until IS NULL OR locked_until < NOW())
          AND attempts < $3
          AND created_at > NOW() - ($4 * INTERVAL '1 hour')
        ORDER BY created_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE realtime_outbox o
        SET locked_by = $2,
            locked_until = NOW() + ($5 * INTERVAL '1 millisecond')
       FROM candidates c
      WHERE o.id = c.id
      RETURNING o.id, o.channel, o.payload, o.attempts`,
    [limit, workerId, MAX_ATTEMPTS, MAX_AGE_HOURS, CLAIM_LEASE_MS],
  )
  return rows
}

async function discardExpired(): Promise<number> {
  const result = await pool.query(
    `UPDATE realtime_outbox
        SET discarded_at = NOW(),
            locked_by = NULL,
            locked_until = NULL,
            last_error = COALESCE(last_error, 'delivery budget exhausted')
      WHERE published_at IS NULL
        AND discarded_at IS NULL
        AND (attempts >= $1 OR created_at <= NOW() - ($2 * INTERVAL '1 hour'))`,
    [MAX_ATTEMPTS, MAX_AGE_HOURS],
  )
  return result.rowCount ?? 0
}

async function cleanupTerminalRows(): Promise<void> {
  const now = Date.now()
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
  lastCleanupAt = now
  await pool.query(
    `WITH stale AS (
       SELECT id
         FROM realtime_outbox
        WHERE published_at <= NOW() - ($1 * INTERVAL '1 hour')
           OR discarded_at <= NOW() - ($2 * INTERVAL '1 day')
        ORDER BY COALESCE(published_at, discarded_at), id
        LIMIT $3
     )
     DELETE FROM realtime_outbox o
      USING stale
      WHERE o.id = stale.id`,
    [COMPLETED_RETENTION_HOURS, DISCARDED_RETENTION_DAYS, CLEANUP_BATCH_SIZE],
  )
}

async function markPublished(id: string): Promise<void> {
  await pool.query(
    `UPDATE realtime_outbox
        SET published_at = NOW(), locked_by = NULL, locked_until = NULL,
            last_error = NULL
      WHERE id = $1 AND locked_by = $2`,
    [id, workerId],
  )
}

async function markFailed(row: PendingBroadcast, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  // 1s, 2s, 4s ... capped at 5min. Redis commands themselves are bounded in
  // redis.ts, so the lease remains comfortably longer than one attempt.
  const delayMs = Math.min(300_000, 1_000 * (2 ** Math.min(row.attempts, 8)))
  await pool.query(
    `UPDATE realtime_outbox
        SET attempts = attempts + 1,
            available_at = NOW() + ($3 * INTERVAL '1 millisecond'),
            locked_by = NULL,
            locked_until = NULL,
            last_error = LEFT($4, 1000)
      WHERE id = $1 AND locked_by = $2`,
    [row.id, workerId, delayMs, message],
  )
}

/**
 * Drain one bounded batch. Exported for fault-injection integration tests.
 * Production uses the default Redis publisher; tests can inject a failure.
 */
export async function drainRealtimeOutbox(options: {
  publishFn?: (channel: string, event: BroadcastEvent) => Promise<void>
  batchSize?: number
} = {}): Promise<OutboxDrainResult> {
  const publishFn = options.publishFn ?? publish
  await cleanupTerminalRows()
  const discarded = await discardExpired()
  const rows = await claimBatch(Math.max(1, Math.min(options.batchSize ?? BATCH_SIZE, 100)))
  let published = 0
  let failed = 0

  // Bound simultaneous Redis calls so a large recovered queue cannot create a
  // connection spike. Promise.all is safe at this batch size (32).
  await Promise.all(rows.map(async (row) => {
    try {
      await publishFn(row.channel, row.payload)
      await markPublished(row.id)
      published += 1
    } catch (error) {
      await markFailed(row, error)
      failed += 1
    }
  }))

  return { claimed: rows.length, published, failed, discarded }
}

function runWorkerTick(): void {
  if (workerRunning) return
  workerRunning = true
  void drainRealtimeOutbox()
    .then((result) => {
      if (result.failed > 0) {
        console.warn(`[outbox] ${result.failed} realtime event(s) delayed; Redis delivery will retry`)
      }
      if (result.discarded > 0) {
        console.error(`[outbox] discarded ${result.discarded} expired realtime event(s)`)
      }
    })
    .catch((error) => {
      console.warn('[outbox] drain failed', error instanceof Error ? error.message : error)
    })
    .finally(() => { workerRunning = false })
}

export function nudgeRealtimeOutbox(): void {
  if (!workerTimer) return
  setImmediate(runWorkerTick)
}

export function startRealtimeOutboxWorker(): NodeJS.Timeout {
  if (workerTimer) return workerTimer
  runWorkerTick()
  workerTimer = setInterval(runWorkerTick, WORKER_INTERVAL_MS)
  workerTimer.unref()
  console.log(`[boot] realtime outbox running every ${WORKER_INTERVAL_MS}ms`)
  return workerTimer
}

export function stopRealtimeOutboxWorker(): void {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}
