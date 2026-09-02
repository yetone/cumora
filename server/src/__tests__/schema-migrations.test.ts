import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  type AppliedMigration,
  MAX_SUPPORTED_SCHEMA_VERSION,
  MigrationHistoryError,
  SCHEMA_MIGRATIONS,
  validateMigrationHistory,
} from '../db/migrations/manifest.js'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { computedBaselineMigrationChecksum } = await import('../db/migrate.js')
const { normalizedConversationMembersChecksum } = await import('../db/migrations/0002-normalized-conversation-members.js')
const { verifySchemaCompatibility } = await import('../db/schema-version.js')
type SchemaVersionQueryable = import('../db/schema-version.js').SchemaVersionQueryable

const current = (): AppliedMigration[] => SCHEMA_MIGRATIONS.map((migration) => ({ ...migration }))

test('the frozen baseline SQL matches its immutable manifest checksum', () => {
  assert.equal(computedBaselineMigrationChecksum(), SCHEMA_MIGRATIONS[0].checksum)
})

test('the normalized membership migration matches its immutable manifest checksum', () => {
  assert.equal(normalizedConversationMembersChecksum(), SCHEMA_MIGRATIONS[1].checksum)
})

test('the migration owner accepts an exact prefix and reports its pending suffix', () => {
  const empty = validateMigrationHistory([], { allowPending: true })
  assert.equal(empty.currentVersion, 0)
  assert.deepEqual(empty.pending, SCHEMA_MIGRATIONS)

  const complete = validateMigrationHistory(current(), { allowPending: true })
  assert.equal(complete.currentVersion, MAX_SUPPORTED_SCHEMA_VERSION)
  assert.deepEqual(complete.pending, [])
})

test('application startup rejects uninitialized, changed, and newer histories', () => {
  assert.throws(
    () => validateMigrationHistory([]),
    (err) => err instanceof MigrationHistoryError && err.code === 'schema_uninitialized',
  )
  assert.throws(
    () => validateMigrationHistory([{ ...current()[0], checksum: '0'.repeat(64) }]),
    (err) => err instanceof MigrationHistoryError && err.code === 'migration_history_invalid',
  )
  assert.throws(
    () => validateMigrationHistory([
      ...current(),
      { version: MAX_SUPPORTED_SCHEMA_VERSION + 1, name: 'future', checksum: 'f'.repeat(64) },
    ]),
    (err) => err instanceof MigrationHistoryError && err.code === 'schema_ahead',
  )
})

test('startup compatibility verification is a read-only ledger query', async () => {
  const statements: string[] = []
  const queryable: SchemaVersionQueryable = {
    async query<T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> {
      statements.push(sql)
      return { rows: current() as unknown as T[], rowCount: current().length } as QueryResult<T>
    },
  }

  assert.equal(await verifySchemaCompatibility(queryable), MAX_SUPPORTED_SCHEMA_VERSION)
  assert.equal(statements.length, 1)
  assert.match(statements[0], /^SELECT\s/i)
  assert.doesNotMatch(statements[0], /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i)
})

test('a missing schema_migrations table becomes an actionable startup error', async () => {
  const queryable: SchemaVersionQueryable = {
    async query<T extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<T>> {
      const err = new Error('relation schema_migrations does not exist') as Error & { code: string }
      err.code = '42P01'
      throw err
    },
  }
  await assert.rejects(
    () => verifySchemaCompatibility(queryable),
    (err) => err instanceof MigrationHistoryError && err.code === 'schema_uninitialized',
  )
})
