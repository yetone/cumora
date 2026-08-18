/**
 * ensureSchema runs its DDL on a client borrowed from the SHARED pool, after
 * disabling that session's statement_timeout / idle_in_transaction_session_timeout
 * and setting a 5s lock_timeout. Those are session-scoped, `pg-pool`'s release()
 * does not reset session state, and node-postgres only sends the pool's timeouts
 * in the connection's startup packet — so whatever the migration leaves behind
 * rides that connection for the rest of the process's life.
 *
 * Run: node --import tsx --test server/src/__tests__/migrate-client-release.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { releaseMigrationClient } from '../db/migrate.js'

function fakeClient(opts: { failReset?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql)
      if (opts.failReset) throw new Error('connection terminated unexpectedly')
      return {}
    },
    release: () => { calls.push('<release>') },
  }
}

test('the migration client is reset before it re-enters the pool', () => {
  const c = fakeClient()
  return releaseMigrationClient(c).then(() => {
    assert.deepEqual(c.calls, ['RESET ALL', '<release>'])
  })
})

test('the reset happens BEFORE release, never after', async () => {
  // Order is the whole point: a client released first is already back in the
  // pool and may have been handed to another request by the time RESET lands.
  const c = fakeClient()
  await releaseMigrationClient(c)
  const reset = c.calls.indexOf('RESET ALL')
  const released = c.calls.indexOf('<release>')
  assert.notEqual(reset, -1, 'the session was never reset')
  assert.notEqual(released, -1, 'the client was never released')
  assert.ok(reset < released, 'reset must precede release')
})

test('a failed reset still returns the slot to the pool', async () => {
  // Losing a pool slot forever is worse than a stale session; the pool discards
  // a broken connection on its own.
  const c = fakeClient({ failReset: true })
  await releaseMigrationClient(c)
  assert.ok(c.calls.includes('<release>'))
})

test('releaseMigrationClient does not reject when the reset fails', async () => {
  const c = fakeClient({ failReset: true })
  await assert.doesNotReject(() => releaseMigrationClient(c))
})
