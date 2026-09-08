import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { env } from '../env.js'
import * as schema from './schema.js'

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Defense-in-depth against connection-pool exhaustion. A single slow or stuck
  // query must never pin a pool slot indefinitely — that is exactly how one
  // un-indexed hot query (idle.ts' MAX(created_at) seq-scan) held all 20 slots
  // at ~8s each and 503-ed the entire API. 60s is far above any healthy request
  // (sub-second) but reaps genuine runaways; idle-in-transaction reaps leaked
  // transactions holding a slot open doing nothing. The standalone migration
  // owner and CONCURRENTLY index builds legitimately run longer and disable
  // these on their own session (see ensureSchema -> `SET statement_timeout = 0`).
  statement_timeout: 60_000,
  idle_in_transaction_session_timeout: 30_000,
})

pool.on('error', (err) => {
  console.error('[pg] idle client error', err)
})

export const db = drizzle(pool, { schema })
