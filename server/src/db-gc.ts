/**
 * Database row-retention garbage collector.
 *
 * The high-volume telemetry tables grow without bound: agent_log gets a
 * breadcrumb row for every idle/agenda/scan wake across the whole fleet
 * (~800k rows/day at Aug-2026 scale), agent_events mirrors every run's
 * observability trail, and ws_tickets are single-use auth tickets that
 * were never reaped after expiry. By Aug 2026 that was 50 GB of a 64 GB
 * database and the Cloud SQL disk was auto-growing ~1.3 GB/day.
 *
 * Readers only ever look at recent rows (`cumora log` reads the last
 * ≤100 per agent; observability drill-down and shipping-maintenance look
 * at bounded windows; llm_calls_rollup preserves cost aggregates
 * forever), so old rows are pure dead weight.
 *
 * Strategy: a periodic sweep deletes rows past a per-table retention
 * window, in small batches so locks stay short and vacuums keep up. Each
 * batch runs under its own statement_timeout so a pathological scan can't
 * wedge the worker; a timed-out batch just retries next tick.
 *
 * Every sweep target carries a BARE index on its time column — the ones
 * named `-- db-gc sweep` in migrate.ts exist for no other reader. The
 * composite (agent_id, created_at) indexes cannot serve this query: it
 * filters and orders on time alone, with no leading-column predicate.
 * Measured on 300k rows of agent_log, the same batch:
 *
 *   with idx_agent_log_created:  Index Scan,          15 buffers
 *   without it:                  Seq Scan + Sort,   2244 buffers
 *
 * and that gap grows with the table. On the 31GB agent_log this GC was
 * written for it is the difference between a batch and the 55s timeout —
 * see the note on deleteBatch, which is the incident this comes from. So
 * these indexes are load-bearing rather than incidental, and
 * `db-gc-sweep-index.test.ts` fails if one goes missing.
 *
 * Deleting agent_runs cascades to its remaining agent_events (FK ON
 * DELETE CASCADE); agent_events is swept first with the same window so
 * the cascade only ever touches a handful of stragglers.
 *
 * Note: PostgreSQL returns freed space to the table's free-space map,
 * not to the OS — the Cloud SQL disk will not shrink (it can't anyway),
 * but it stops growing once the backlog is cleared.
 *
 * Multi-replica safety: deletes are idempotent; two replicas racing on
 * the same batch means one of them deletes 0 rows. Disabling: set
 * DB_GC_INTERVAL_MS=0 (whole worker) or a table's retention env to 0.
 */
import { pool } from './db/pool.js'
import { env } from './env.js'
import { inc } from './metrics.js'

export interface SweepTarget {
  table: string
  /** Primary-key column used to address the delete batch. */
  pkCol: string
  /** Column the retention window applies to. */
  timeCol: string
  /** Retention in days; 0 disables the sweep for this table. */
  days: number
}

export function targets(): SweepTarget[] {
  return [
    // ws_tickets keys off expires_at: a ticket is garbage once expired,
    // the extra day is just diagnostic slack.
    { table: 'ws_tickets',   pkCol: 'token_hash', timeCol: 'expires_at', days: env.DB_GC_WS_TICKETS_DAYS },
    { table: 'agent_log',    pkCol: 'id',         timeCol: 'created_at', days: env.DB_GC_AGENT_LOG_DAYS },
    { table: 'agent_events', pkCol: 'id',         timeCol: 'created_at', days: env.DB_GC_AGENT_EVENTS_DAYS },
    { table: 'agent_runs',   pkCol: 'id',         timeCol: 'started_at', days: env.DB_GC_AGENT_RUNS_DAYS },
    { table: 'llm_calls',    pkCol: 'id',         timeCol: 'created_at', days: env.DB_GC_LLM_CALLS_DAYS },
  ]
}

/** Delete one batch of expired rows. Returns rows deleted (0 = table clean).
 *
 *  Two statements, both index-driven: the victim SELECT walks the bare
 *  time-column index (see migrate.ts idx_*_created), the DELETE walks the
 *  PK index via `= ANY($ids)`. The earlier single-statement form —
 *  `DELETE WHERE ctid IN (subquery)` — planned the outer side as a seq
 *  scan of the whole heap, which on a 31GB table blew the 55s timeout
 *  every tick and deleted nothing. */
async function deleteBatch(t: SweepTarget, batchSize: number): Promise<{ picked: number; deleted: number }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // SET LOCAL: bounds both statements, auto-resets at COMMIT/ROLLBACK so
    // the pooled connection isn't left with a lowered timeout.
    await client.query(`SET LOCAL statement_timeout = '55s'`)
    const victims = await client.query<Record<string, string>>(
      `SELECT ${t.pkCol} AS pk FROM ${t.table}
        WHERE ${t.timeCol} < NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY ${t.timeCol} ASC
        LIMIT $2`,
      [t.days, batchSize],
    )
    let deleted = 0
    if (victims.rows.length > 0) {
      const res = await client.query(
        `DELETE FROM ${t.table} WHERE ${t.pkCol} = ANY($1)`,
        [victims.rows.map((r) => r.pk)],
      )
      deleted = res.rowCount ?? 0
    }
    await client.query('COMMIT')
    return { picked: victims.rows.length, deleted }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Run one sweep across all tables. Bounded by maxBatchesPerTable so a
 *  huge backlog burns down across many ticks instead of one marathon. */
export async function runDbGcTick(opts?: { batchSize?: number; maxBatchesPerTable?: number }): Promise<Record<string, number>> {
  const batchSize = opts?.batchSize ?? env.DB_GC_BATCH
  const maxBatches = opts?.maxBatchesPerTable ?? 10
  const deleted: Record<string, number> = {}
  for (const t of targets()) {
    if (t.days <= 0) continue
    let total = 0
    try {
      for (let i = 0; i < maxBatches; i++) {
        const { picked, deleted: n } = await deleteBatch(t, batchSize)
        total += n
        // Break on a short PICK (backlog for this table is drained), not a
        // short DELETE: with two replicas racing on the same oldest rows, a
        // batch can pick 10k live rows and delete few — the peer got there
        // first — while plenty of backlog remains.
        if (picked < batchSize) break
      }
    } catch (e) {
      console.error(`[db-gc] ${t.table} sweep failed:`, e instanceof Error ? e.message : String(e))
      inc('db.gc.failed', { table: t.table })
    }
    if (total > 0) {
      deleted[t.table] = total
      inc('db.gc.deleted', { table: t.table }, total)
    }
  }
  if (Object.keys(deleted).length > 0) {
    console.log(JSON.stringify({ evt: 'db.gc.tick', deleted }))
  }
  return deleted
}

let timer: NodeJS.Timeout | null = null

/** Start the periodic GC loop. Idempotent — re-calling is a no-op. */
export function startDbGcWorker(): { stop(): void } | null {
  if (timer) return { stop: stopDbGcWorker }
  const intervalMs = env.DB_GC_INTERVAL_MS
  if (intervalMs <= 0) {
    console.log('[db-gc] disabled (DB_GC_INTERVAL_MS=0)')
    return null
  }
  const windows = targets().map((t) => `${t.table}=${t.days}d`).join(' ')
  console.log(`[db-gc] starting · interval=${intervalMs}ms · batch=${env.DB_GC_BATCH} · ${windows}`)
  const tick = async () => {
    try { await runDbGcTick() }
    catch (e) { console.error('[db-gc] tick failed:', e instanceof Error ? e.message : String(e)) }
  }
  timer = setInterval(() => { void tick() }, intervalMs)
  return { stop: stopDbGcWorker }
}

export function stopDbGcWorker(): void {
  if (timer) { clearInterval(timer); timer = null }
}
