/**
 * A CONCURRENTLY index build must not be killed by the migrator's lock timeout.
 *
 * `ensureSchema` pins the migration session at `lock_timeout = '5s'` so an
 * ordinary ALTER cannot sit behind a long lock and stall a deploy. That guard is
 * right for everything except the one operation it silently breaks.
 *
 * CREATE INDEX CONCURRENTLY takes no blocking lock — that is why it exists — but
 * it does WaitForOlderSnapshots: it waits out every transaction that started
 * before it, anywhere in the database, on any table. `lock_timeout` counts that
 * wait. So any transaction open longer than five seconds kills the build with
 * 55P03 and leaves an index with `indisvalid = false` behind: every INSERT
 * maintains it, no planner will use it.
 *
 * Measured on Postgres 16 before the fix, with a 30s read on an UNRELATED table:
 *
 *   SET lock_timeout = '5s'
 *   CREATE INDEX CONCURRENTLY idx_probe ON msgs(body)
 *   ERROR:  canceling statement due to lock timeout        (at 5.0s)
 *   leftover: indisvalid=f  indisready=t  indislive=t
 *
 * The same build with the timeout lifted completes. This repo supplies such
 * transactions itself — `buildConcurrentIndexes` documents a per-agent scan at
 * "~8s" — and migrations 0005/0006 reach `ensureConcurrentIndex` from the
 * versioned ledger, where nothing has ever lifted the timeout: the only code
 * that does sits in migration 1, which an already-migrated database skips.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { env } from '../env.js'
import { pool } from '../db/pool.js'
import { ensureConcurrentIndex } from '../db/migrate.js'
import { ensureSchemaOnce, teardownAll } from './_helpers.js'

const INDEX = 'idx_test_concurrent_lock_timeout'
const CREATE = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX} ON messages (created_at)`

before(async () => { await ensureSchemaOnce() })
after(async () => {
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`).catch(() => { /* best effort */ })
  await teardownAll()
})

async function indexState(): Promise<{ valid: boolean; ready: boolean } | null> {
  const { rows } = await pool.query<{ indisvalid: boolean; indisready: boolean }>(
    `SELECT i.indisvalid, i.indisready FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = $1`,
    [INDEX],
  )
  return rows[0] ? { valid: rows[0].indisvalid, ready: rows[0].indisready } : null
}

/** Open one transaction on a table the build does not touch and let it close
 *  itself after `seconds`. Self-terminating on purpose: the build we are testing
 *  now waits the blocker out, so a blocker that needed us to release it would
 *  deadlock against the very call under test. A dedicated connection, because
 *  the pool client is the one running the build. */
async function holdUnrelatedTransaction(seconds: number): Promise<() => Promise<void>> {
  const blocker = new Client({ connectionString: env.DATABASE_URL })
  await blocker.connect()
  // One multi-statement string: the snapshot is taken at BEGIN and released by
  // the COMMIT, with no further round trip from us. Any table other than
  // `messages` — WaitForOlderSnapshots is about snapshot age, not about who
  // touches what.
  const running = blocker
    .query(`BEGIN; SELECT count(*) FROM companies; SELECT pg_sleep(${seconds}); COMMIT;`)
    .catch(() => { /* the connection may be torn down first */ })
  // Give it a moment to actually reach the sleep before the build starts.
  await new Promise((r) => setTimeout(r, 500))
  return async () => {
    await running
    await blocker.end().catch(() => { /* already gone */ })
  }
}

test('[integration] a concurrent build survives a long unrelated transaction', async () => {
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`).catch(() => { /* fresh start */ })
  const client = await pool.connect()
  const stop = await holdUnrelatedTransaction(9)
  try {
    // Exactly what ensureSchema leaves on the migration session: no statement
    // timeout (a migration may legitimately run long), a 5s lock timeout.
    await client.query('SET statement_timeout = 0')
    await client.query("SET lock_timeout = '5s'")
    const started = Date.now()
    await ensureConcurrentIndex(client, INDEX, CREATE)
    const elapsed = Date.now() - started
    // Before the fix this threw 55P03 at ~5s. It should now wait out the
    // blocker instead, which takes longer than the timeout it used to hit.
    assert.ok(elapsed > 5_500, `build returned in ${elapsed}ms — it did not outlast the 5s timeout, so the blocker was not holding`)
  } finally {
    await stop()
    client.release()
  }

  const state = await indexState()
  assert.ok(state, 'the index was not created')
  assert.equal(state.valid, true, 'index is INVALID — the build was killed and left a carcass')
  assert.equal(state.ready, true)
})

test('[integration] the caller\'s lock timeout is restored, not assumed', async () => {
  const client = await pool.connect()
  try {
    await client.query("SET lock_timeout = '11s'")
    await ensureConcurrentIndex(client, INDEX, CREATE)
    const { rows } = await client.query<{ lock_timeout: string }>('SHOW lock_timeout')
    assert.equal(rows[0].lock_timeout, '11s', 'the helper clobbered the session it borrowed')
  } finally {
    client.release()
  }
})

test('[integration] an invalid leftover is rebuilt rather than skipped', async () => {
  // IF NOT EXISTS sees the name and skips, so a carcass from an earlier kill
  // would otherwise persist forever behind a migration recorded as applied.
  await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX}`).catch(() => { /* fresh start */ })
  await pool.query(`CREATE INDEX ${INDEX} ON messages (created_at)`)
  await pool.query(
    `UPDATE pg_index SET indisvalid = false
      WHERE indexrelid = (SELECT oid FROM pg_class WHERE relname = $1)`,
    [INDEX],
  )
  assert.equal((await indexState())?.valid, false, 'precondition: index marked invalid')

  const client = await pool.connect()
  try {
    await client.query("SET lock_timeout = '5s'")
    await ensureConcurrentIndex(client, INDEX, CREATE)
  } finally {
    client.release()
  }
  assert.equal((await indexState())?.valid, true, 'the invalid index was not rebuilt')
})

test('[integration] a healthy index is left alone', async () => {
  const client = await pool.connect()
  try {
    const before = await indexState()
    assert.equal(before?.valid, true, 'precondition: index is healthy from the previous case')
    await ensureConcurrentIndex(client, INDEX, CREATE)
    assert.equal((await indexState())?.valid, true)
  } finally {
    client.release()
  }
})
