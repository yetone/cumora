/**
 * Standalone migration runner.
 *
 *   npx tsx server/src/migrate-bin.ts
 *   # or, in package.json scripts: npm run migrate
 *
 * Designed to be the entry point of one pre-deploy Kubernetes Job. Runs
 * `ensureSchema()` and exits — no HTTP listener, scheduler, or Redis
 * subscription. Application Pods must not run this command as an init
 * container; their startup path is read-only schema verification.
 *
 *   kind: Job
 *   spec:
 *     template:
 *       spec:
 *         containers:
 *         - name: migrate
 *           image: ghcr.io/yetoneful/cumora-server:<version>
 *           command: ["node", "/app/migrate-bin.cjs"]
 *           env:
 *           - { name: DATABASE_URL, valueFrom: { secretKeyRef: ... } }
 *
 * The migration is wrapped in a pg_advisory_lock (see db/migrate.ts) as
 * defense in depth against duplicate deploy jobs. Applied immutable versions
 * are recorded in schema_migrations, so a rerun reads the ledger and executes
 * no historical DDL.
 *
 * Exit codes:
 *   0  schema is up to date (or was, and migration finished cleanly)
 *   1  migration failed (Postgres error, env missing, etc.) — main
 *      container should NOT start
 */
import { pool } from './db/pool.js'
import { ensureSchema } from './db/migrate.js'

// Postgres SQLSTATE codes for transient lock contention. ensureSchema records
// only completed immutable versions and is advisory-lock serialized, so a
// failed attempt can safely back off and resume from the durable ledger:
//   40P01 = deadlock_detected  — a no-op ALTER's brief AccessExclusiveLock
//                                raced a live agent/server query into a cycle
//                                and PG aborted one. Under constant traffic this
//                                recurs under sustained traffic, so the one
//                                pre-deploy Job retries in-process in a quieter
//                                moment instead of mutating the Deployment.
//   55P03 = lock_not_available — lock_timeout (set inside ensureSchema) tripped
//                                while WAITING for a table lock.
const TRANSIENT_LOCK_CODES = new Set(['40P01', '55P03', '40001'])
const MAX_ATTEMPTS = 8

async function main(): Promise<void> {
  const started = Date.now()
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await ensureSchema()
      console.log(`[migrate-bin] ok · ${Date.now() - started}ms${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
      await pool.end().catch(() => { /* swallow */ })
      process.exit(0)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      const message = err instanceof Error ? err.message : String(err)
      const lockContention = typeof code === 'string' && TRANSIENT_LOCK_CODES.has(code)
      const transportFailure = /timeout|terminated|ECONNREFUSED|ECONNRESET|EOF/i.test(message)
      if ((lockContention || transportFailure) && attempt < MAX_ATTEMPTS) {
        // The advisory lock is released on the failed attempt (ensureSchema's
        // finally), so each retry re-acquires cleanly and resumes from the last
        // recorded version. Exponential backoff + jitter is capped at 15s.
        const backoffMs = Math.min(15_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500)
        const kind = lockContention ? `lock error ${code}` : 'transport error'
        console.warn(`[migrate-bin] transient ${kind} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying in ${backoffMs}ms`)
        await new Promise((r) => setTimeout(r, backoffMs))
        continue
      }
      console.error('[migrate-bin] failed:', err instanceof Error ? (err.stack ?? err.message) : String(err))
      await pool.end().catch(() => { /* swallow */ })
      process.exit(1)
    }
  }
}

void main()
