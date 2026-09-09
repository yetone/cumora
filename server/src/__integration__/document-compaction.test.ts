import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { Pool, type PoolClient } from 'pg'
import * as Y from 'yjs'
import { compactDocument, readDocumentState } from '../documents/persistence.js'

// Use an isolated schema: these tests need real PostgreSQL transaction and
// sequence semantics but do not need the app's Redis or provider services.
const schema = `compaction_test_${randomUUID().replaceAll('-', '')}`
const connectionString = process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL
const admin = new Pool({ connectionString })
const pool = new Pool({ connectionString, options: `-c search_path=${schema}` })

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`
    CREATE TABLE document_updates (
      id BIGSERIAL PRIMARY KEY, document_id TEXT NOT NULL, update_bytes BYTEA NOT NULL
    );
    CREATE TABLE document_snapshots (
      document_id TEXT PRIMARY KEY, state_bytes BYTEA NOT NULL,
      snapshot_at_update_id BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
})
beforeEach(async () => {
  await pool.query('TRUNCATE document_updates, document_snapshots RESTART IDENTITY')
})
after(async () => {
  await pool.end()
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.end()
})

function edits() {
  const doc = new Y.Doc()
  const updates: Uint8Array[] = []
  doc.on('update', (update: Uint8Array) => updates.push(update))
  doc.getText('text').insert(0, 'A')
  doc.getText('text').insert(1, 'B')
  doc.getText('text').insert(2, 'C')
  doc.destroy()
  return updates
}

async function insert(bytes: Uint8Array, client: Pick<PoolClient, 'query'> = pool, documentId = 'doc') {
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO document_updates (document_id, update_bytes) VALUES ($1, $2) RETURNING id::text',
    [documentId, Buffer.from(bytes)],
  )
  return rows[0].id
}

async function coldText(client: Pick<PoolClient, 'query'> = pool) {
  const doc = new Y.Doc()
  try {
    for (const row of await readDocumentState(client, 'doc')) Y.applyUpdate(doc, row.bytes)
    return doc.getText('text').toString()
  } finally {
    doc.destroy()
  }
}

// Intercept a real query's result, keeping the transaction open so another
// connection can commit at a deterministic point in the compaction.
function interceptedPool(hook: (sql: string) => Promise<void>): Pick<Pool, 'connect'> {
  return {
    async connect() {
      const client = await pool.connect()
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params)
          await hook(sql)
          return result
        },
        release: () => client.release(),
      } as unknown as PoolClient
    },
  } as Pick<Pool, 'connect'>
}

test('compaction includes persisted edits missing from a stale room', async () => {
  const [a, b] = edits()
  const staleRoom = new Y.Doc()
  Y.applyUpdate(staleRoom, a)
  await insert(a)
  await insert(b) // Redis has not delivered B to the live room.
  assert.equal(staleRoom.getText('text').toString(), 'A')
  await compactDocument(pool, 'doc')
  assert.equal(await coldText(), 'AB')
  assert.equal((await pool.query('SELECT * FROM document_updates')).rowCount, 0)
  staleRoom.destroy()
})

test('a commit after the read remains in the log and survives another compaction', async () => {
  const [a, b, c] = edits()
  await insert(a)
  await compactDocument(pool, 'doc')
  await insert(b)
  const otherId = await insert(a, pool, 'other-doc')
  let tailId = ''
  await compactDocument(interceptedPool(async (sql) => {
    if (sql.includes('UNION ALL')) tailId = await insert(c)
  }), 'doc')
  const { rows } = await pool.query('SELECT id::text FROM document_updates ORDER BY id')
  assert.deepEqual(rows.map((row) => row.id), [otherId, tailId])
  assert.equal(await coldText(), 'ABC')
  await compactDocument(pool, 'doc')
  assert.equal(await coldText(), 'ABC')
})

test('late lower-ID commits and pending Yjs dependencies survive compaction', async () => {
  const [a, b] = edits()
  const writer = await pool.connect()
  try {
    await writer.query('BEGIN')
    const lowerId = await insert(a, writer)
    const higherId = await insert(b)
    await compactDocument(pool, 'doc') // B is pending until A arrives.
    await writer.query('COMMIT')
    assert.ok(BigInt(lowerId) < BigInt(higherId))
    assert.equal(await coldText(), 'AB')
    await compactDocument(pool, 'doc')
    assert.equal(await coldText(), 'AB')
    assert.equal((await pool.query('SELECT * FROM document_updates')).rowCount, 0)
  } finally {
    await writer.query('ROLLBACK')
    writer.release()
  }
})

test('a lower-ID transaction committed between read and deletion is not trimmed', async () => {
  const [a, b] = edits()
  const writer = await pool.connect()
  try {
    await writer.query('BEGIN')
    const lowerId = await insert(a, writer)
    await insert(b)
    await compactDocument(interceptedPool(async (sql) => {
      if (sql.includes('UNION ALL')) await writer.query('COMMIT')
    }), 'doc')
    assert.deepEqual((await pool.query('SELECT id::text FROM document_updates')).rows, [{ id: lowerId }])
    assert.equal(await coldText(), 'AB')
  } finally {
    await writer.query('ROLLBACK')
    writer.release()
  }
})

test('concurrent compactors cannot overwrite a newer snapshot', async () => {
  const [a, b] = edits()
  await insert(a)
  await compactDocument(interceptedPool(async (sql) => {
    if (!sql.includes('UNION ALL')) return
    await insert(b)
    assert.equal(await compactDocument(pool, 'doc'), false)
  }), 'doc')
  assert.equal(await coldText(), 'AB')
  assert.equal(await compactDocument(pool, 'doc'), true)
  assert.equal(await coldText(), 'AB')
})

test('failure after deletion rolls back both snapshot replacement and log deletion', async () => {
  const [a, b] = edits()
  await insert(a)
  await compactDocument(pool, 'doc')
  const beforeSnapshot = (await pool.query('SELECT * FROM document_snapshots')).rows
  const bId = await insert(b)
  await assert.rejects(compactDocument(interceptedPool(async (sql) => {
    if (sql.startsWith('DELETE')) throw new Error('injected failure')
  }), 'doc'), /injected failure/)
  assert.deepEqual((await pool.query('SELECT * FROM document_snapshots')).rows, beforeSnapshot)
  assert.deepEqual((await pool.query('SELECT id::text FROM document_updates')).rows, [{ id: bId }])
  assert.equal(await coldText(), 'AB')
  assert.equal(await compactDocument(pool, 'doc'), true)
})

test('cold load keeps a consistent snapshot and log when compaction commits during the read', async () => {
  const [a, b] = edits()
  await insert(a)
  await compactDocument(pool, 'doc')
  await insert(b)
  const client = await interceptedPool(async (sql) => {
    if (sql.includes('UNION ALL')) await compactDocument(pool, 'doc')
  }).connect()
  try {
    assert.equal(await coldText(client), 'AB')
    assert.equal((await pool.query('SELECT * FROM document_updates')).rowCount, 0)
  } finally {
    client.release()
  }
})
