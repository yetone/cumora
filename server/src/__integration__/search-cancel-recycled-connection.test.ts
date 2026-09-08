/**
 * The abandoned-search cancel must land on the search it was fired for.
 *
 * `searchMessagesBounded` captures a backend pid and, when the sidebar aborts
 * on the next keystroke, fires `pg_cancel_backend` from another connection.
 * Nothing awaits that cancel, so it can still be in flight when the abandoned
 * search finishes on its own and the connection goes back to the pool. The idle
 * pool is a LIFO stack: the next borrower gets that same backend, and a cancel
 * addressed only by pid lands on THEIR query.
 *
 * These run the race against a real Postgres rather than asserting on a string,
 * because every part of it — LIFO reuse, `set_config` reverting at COMMIT, what
 * a cancel does to a backend that has moved on — is the database's behaviour,
 * not ours.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ensureSchemaOnce, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'
import { CANCEL_ABANDONED_SEARCH_SQL } from '../api/router.js'

before(async () => { await ensureSchemaOnce() })
after(async () => { await teardownAll() })

/** What `searchMessagesBounded` does to a connection, up to the point the
 *  caller walks away: bound it, publish a token for it, then finish and let go. */
async function runAndReleaseSearch(token: string): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL statement_timeout = 3000')
    const { rows } = await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid, set_config($1, $2, true)',
      ['application_name', token],
    )
    await client.query('SELECT 1')
    await client.query('COMMIT')
    return rows[0].pid
  } finally {
    client.release()
  }
}

test('[integration] a late cancel does not kill the next borrower of the backend', async () => {
  const token = `cumora-search:${randomUUID()}`
  const pid = await runAndReleaseSearch(token)

  const next = await pool.connect()
  try {
    const nextPid = (await next.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    assert.equal(nextPid, pid, 'the pool did not hand the backend straight back — the race under test was not reproduced')

    // The cancel arrives now, while the new borrower is mid-query.
    const innocent = next.query('SELECT pg_sleep(0.5)')
    const fired = await pool.query(CANCEL_ABANDONED_SEARCH_SQL, [pid, token])
    assert.equal(fired.rowCount, 0, 'the guard matched a backend that is no longer running our search')
    await innocent

    // And the same moment with a pid-only cancel, so the guard is not merely
    // decorative: this is what it is standing in front of.
    const victim = next.query('SELECT pg_sleep(2)').then(() => null).catch((e: { code?: string }) => e.code)
    await new Promise((r) => setTimeout(r, 150))
    await pool.query('SELECT pg_cancel_backend($1)', [pid])
    assert.equal(await victim, '57014', 'a pid-only cancel was expected to kill the unrelated query')
  } finally {
    next.release()
  }
})

test('[integration] the guard still cancels the search it belongs to', async () => {
  const token = `cumora-search:${randomUUID()}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const pid = (await client.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid, set_config($1, $2, true)',
      ['application_name', token],
    )).rows[0].pid
    const search = client.query('SELECT pg_sleep(5)').then(() => null).catch((e: { code?: string }) => e.code)
    await new Promise((r) => setTimeout(r, 250))

    const started = Date.now()
    const fired = await pool.query(CANCEL_ABANDONED_SEARCH_SQL, [pid, token])
    assert.equal(fired.rowCount, 1)
    assert.equal(await search, '57014')
    assert.ok(Date.now() - started < 2_000, 'the cancel did not take effect promptly')
    await client.query('ROLLBACK').catch(() => {})
  } finally {
    client.release()
  }
})

test('[integration] the token lives exactly as long as the search transaction', async () => {
  // The guard rests entirely on this: `set_config(…, is_local => true)` must
  // revert when the transaction ends, or a released connection would keep
  // answering to a cancel meant for a search that is long over.
  const token = `cumora-search:${randomUUID()}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['application_name', token])
    const during = (await client.query<{ application_name: string }>(
      'SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()')).rows[0].application_name
    assert.equal(during, token)
    await client.query('COMMIT')
    const after = (await client.query<{ application_name: string }>(
      'SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()')).rows[0].application_name
    assert.notEqual(after, token)
  } finally {
    client.release()
  }
})

test('[integration] the search route still names the search it cancels', async () => {
  // The three tests above pass just as well against a route that went back to a
  // bare `pg_cancel_backend($1)` — they exercise the SQL, not the caller. Read
  // the source so the caller cannot quietly stop using it.
  const source = await readFile(new URL('../api/router.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function searchMessagesBounded'))
  const fn = body.slice(0, body.indexOf('\n}\n') + 2)

  assert.match(fn, /set_config/, 'the search no longer publishes a token for its backend')
  assert.match(fn, /CANCEL_ABANDONED_SEARCH_SQL/, 'the cancel no longer goes through the guarded statement')
  assert.doesNotMatch(
    fn, /pg_cancel_backend\(\$1\)/,
    'the search is cancelling by pid alone again — a late cancel will hit whoever borrows the connection next',
  )
})
