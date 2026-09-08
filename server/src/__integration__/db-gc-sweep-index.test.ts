/**
 * The GC sweep's indexes are load-bearing, and nothing said so.
 *
 * Each batch selects victims with `WHERE timeCol < … ORDER BY timeCol ASC
 * LIMIT n` — time alone, no leading-column predicate — so the composite
 * (agent_id, created_at) indexes cannot serve it. Only a bare index on the time
 * column can. Three of them are annotated `-- db-gc sweep` in migrate.ts and
 * have no other reader, which is exactly what makes them look droppable.
 *
 * Measured on 300k rows of agent_log, the same batch:
 *
 *   with idx_agent_log_created:  Index Scan,          15 buffers
 *   without it:                  Seq Scan + Sort,   2244 buffers
 *
 * On the 31GB table this GC was written for, that is the difference between a
 * batch and the 55s timeout — the incident `deleteBatch` documents.
 *
 * Scope, precisely: the three declarations that exist today are already
 * immutable — they live in migration 1, and the manifest's checksum refuses any
 * edit to applied history (verified: deleting one fails with "migration 1
 * source checksum changed" before this test even runs). What is NOT protected
 * is the next sweep target. `targets()` is read from db-gc itself, so adding a
 * table there without adding its index turns this red immediately, naming the
 * table and what it will cost:
 *
 *   messages has no bare index on created_at — the GC sweep falls back to a
 *   seq scan + sort of the whole table and will blow its 55s timeout as the
 *   table grows, deleting nothing.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, teardownAll } from './_helpers.js'
import { targets } from '../db-gc.js'

before(async () => { await ensureSchemaOnce() })
after(async () => { await teardownAll() })

/** Bare = one column, that column, no partial predicate, valid. A partial
 *  index does not serve a sweep that must reach every expired row. */
async function bareTimeIndexes(table: string, column: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT i.indexrelid::regclass::text AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = $1
        AND i.indnatts = 1
        AND i.indisvalid
        AND i.indpred IS NULL
        AND pg_get_indexdef(i.indexrelid) LIKE '%(' || $2 || ')'`,
    [table, column],
  )
  return rows.map((r) => r.name)
}

test('[integration] every db-gc sweep target keeps a bare index on its time column', async () => {
  const sweeps = targets()
  assert.ok(sweeps.length > 0, 'db-gc has no sweep targets')

  for (const t of sweeps) {
    const found = await bareTimeIndexes(t.table, t.timeCol)
    assert.ok(
      found.length > 0,
      `${t.table} has no bare index on ${t.timeCol} — the GC sweep falls back to a seq scan + sort of the whole table and will blow its 55s timeout as the table grows, deleting nothing. Composite indexes do not help: the sweep filters and orders on ${t.timeCol} alone.`,
    )
  }
})

test('[integration] the sweep query is the one the index is for', async () => {
  // Pin the shape too. An index on the time column is only useful while the
  // sweep still filters and orders on that column and nothing else; a future
  // `ORDER BY id` or an added predicate would silently strip the plan back to
  // a sort, and the index check above would keep passing.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../db-gc.ts', import.meta.url), 'utf8')
  const fn = source.slice(source.indexOf('async function deleteBatch'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2)

  assert.match(body, /WHERE \$\{t\.timeCol\} </, 'the sweep no longer filters on the time column')
  assert.match(body, /ORDER BY \$\{t\.timeCol\} ASC/, 'the sweep no longer orders by the time column')
})

test('[integration] a composite index alone would not satisfy the check', async () => {
  // The guard has to be able to fail. agent_log carries both shapes, so ask for
  // the composite's leading column: no BARE index exists on agent_id, and that
  // is precisely the case the sweep cannot use.
  assert.deepEqual(await bareTimeIndexes('agent_log', 'agent_id'), [])
  assert.ok((await bareTimeIndexes('agent_log', 'created_at')).length > 0)
})
