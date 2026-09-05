/**
 * Database migration transaction atomicity.
 *
 * Migration DDL and ledger record must be atomic. If a migration is interrupted
 * or fails midway, PostgreSQL must roll back all partial schema changes and
 * the schema_migrations ledger must have no record, allowing clean recovery
 * on rerun.
 *
 * Run: node --import tsx --test server/src/__tests__/migration-transaction-atomicity.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PoolClient } from 'pg'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { applyPendingMigration } = await import('../db/migrate.js')
type VersionedMigration = import('../db/migrate.js').VersionedMigration

function fakeClient(opts: { failRollback?: boolean } = {}) {
  const calls: { sql: string; params?: unknown[] }[] = []
  const client = {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql: sql.trim(), params })
      if (sql.trim() === 'ROLLBACK' && opts.failRollback) {
        throw new Error('rollback network error')
      }
      return { rows: [] }
    },
    release: () => {},
  } as unknown as PoolClient
  return { client, calls }
}

test('transactional migration executes within BEGIN and COMMIT', async () => {
  const { client, calls } = fakeClient()
  let upCalled = false

  const migration: VersionedMigration = {
    version: 2,
    name: '0002-test',
    checksum: 'a'.repeat(64),
    sourceChecksum: 'a'.repeat(64),
    transactional: true,
    up: async () => {
      upCalled = true
      calls.push({ sql: 'CREATE TABLE test_table (id INT)' })
    },
  }

  await applyPendingMigration(client, migration)

  assert.ok(upCalled, 'migration.up should be called')
  assert.equal(calls[0].sql, 'BEGIN')
  assert.equal(calls[1].sql, 'CREATE TABLE test_table (id INT)')
  assert.match(calls[2].sql, /^INSERT INTO schema_migrations/i)
  assert.equal(calls[3].sql, 'COMMIT')
})

test('transactional migration defaults to true when transactional is omitted for version >= 2', async () => {
  const { client, calls } = fakeClient()

  const migration: VersionedMigration = {
    version: 5,
    name: '0005-test-default',
    checksum: 'b'.repeat(64),
    sourceChecksum: 'b'.repeat(64),
    up: async () => {
      calls.push({ sql: 'ALTER TABLE test ADD COLUMN foo TEXT' })
    },
  }

  await applyPendingMigration(client, migration)

  assert.equal(calls[0].sql, 'BEGIN')
  assert.equal(calls[1].sql, 'ALTER TABLE test ADD COLUMN foo TEXT')
  assert.match(calls[2].sql, /^INSERT INTO schema_migrations/i)
  assert.equal(calls[3].sql, 'COMMIT')
})

test('failing migration issues ROLLBACK and never records ledger entry', async () => {
  const { client, calls } = fakeClient()

  const migration: VersionedMigration = {
    version: 3,
    name: '0003-failing',
    checksum: 'c'.repeat(64),
    sourceChecksum: 'c'.repeat(64),
    transactional: true,
    up: async () => {
      calls.push({ sql: 'ALTER TABLE bad ADD COLUMN bar INT' })
      throw new Error('relation bad does not exist')
    },
  }

  await assert.rejects(
    () => applyPendingMigration(client, migration),
    /relation bad does not exist/,
  )

  const statements = calls.map((c) => c.sql)
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements[1], 'ALTER TABLE bad ADD COLUMN bar INT')
  assert.equal(statements[2], 'ROLLBACK')
  assert.ok(!statements.includes('COMMIT'), 'COMMIT must never be called on failure')
  assert.ok(
    !statements.some((s) => s.startsWith('INSERT INTO schema_migrations')),
    'schema_migrations record must never be written on failure',
  )
})

test('non-transactional migration (transactional: false) runs without BEGIN/COMMIT', async () => {
  const { client, calls } = fakeClient()

  const migration: VersionedMigration = {
    version: 1,
    name: '0001-baseline',
    checksum: 'd'.repeat(64),
    sourceChecksum: 'd'.repeat(64),
    transactional: false,
    up: async () => {
      calls.push({ sql: 'CREATE INDEX CONCURRENTLY idx_foo ON foo(id)' })
    },
  }

  await applyPendingMigration(client, migration)

  const statements = calls.map((c) => c.sql)
  assert.ok(!statements.includes('BEGIN'), 'BEGIN must not be called')
  assert.ok(!statements.includes('COMMIT'), 'COMMIT must not be called')
  assert.equal(statements[0], 'CREATE INDEX CONCURRENTLY idx_foo ON foo(id)')
  assert.match(statements[1], /^INSERT INTO schema_migrations/i)
})

test('rollback failure still preserves original migration error', async () => {
  const { client } = fakeClient({ failRollback: true })

  const migration: VersionedMigration = {
    version: 4,
    name: '0004-rollback-failure',
    checksum: 'e'.repeat(64),
    sourceChecksum: 'e'.repeat(64),
    transactional: true,
    up: async () => {
      throw new Error('primary migration error')
    },
  }

  await assert.rejects(
    () => applyPendingMigration(client, migration),
    /primary migration error/,
  )
})
