import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { ensureSchema, REQUIRED_SCHEMA_INDEXES } from '../db/migrate.js'
import { SCHEMA_MIGRATIONS } from '../db/migrations/manifest.js'
import { verifySchemaCompatibility } from '../db/schema-version.js'
import { ensureSchemaOnce, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
after(async () => { await teardownAll() })

test('PostgreSQL records the exact immutable migration manifest', async () => {
  const { rows } = await pool.query<{
    version: number
    name: string
    checksum: string
    execution_ms: number
    applied_at: Date
  }>(
    `SELECT version, name, checksum, execution_ms, applied_at
       FROM schema_migrations
      ORDER BY version ASC`,
  )
  assert.deepEqual(
    rows.map(({ version, name, checksum }) => ({ version, name, checksum })),
    SCHEMA_MIGRATIONS,
  )
  assert.ok(rows.every((row) => row.execution_ms >= 0))
  assert.ok(rows.every((row) => row.applied_at instanceof Date))
})

test('rerunning the migration owner does not rewrite applied history', async () => {
  const before = await pool.query<{ version: number; applied_at: Date }>(
    `SELECT version, applied_at FROM schema_migrations ORDER BY version`,
  )
  await ensureSchema()
  const after = await pool.query<{ version: number; applied_at: Date }>(
    `SELECT version, applied_at FROM schema_migrations ORDER BY version`,
  )
  assert.deepEqual(after.rows, before.rows)
})

test('application compatibility gate accepts the migrated database read-only', async () => {
  assert.equal(await verifySchemaCompatibility(pool), SCHEMA_MIGRATIONS.at(-1)?.version)
})

test('promotion-required indexes are valid, ready, and live', async () => {
  const { rows } = await pool.query<{
    name: string
    indisvalid: boolean
    indisready: boolean
    indislive: boolean
  }>(
    `SELECT c.relname AS name, i.indisvalid, i.indisready, i.indislive
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = ANY($1::text[])`,
    [[...REQUIRED_SCHEMA_INDEXES]],
  )
  const byName = new Map(rows.map((row) => [row.name, row]))
  for (const name of REQUIRED_SCHEMA_INDEXES) {
    const row = byName.get(name)
    assert.ok(row, `${name} must exist`)
    assert.equal(row.indisvalid, true, `${name} must be valid`)
    assert.equal(row.indisready, true, `${name} must be ready`)
    assert.equal(row.indislive, true, `${name} must be live`)
  }
})
