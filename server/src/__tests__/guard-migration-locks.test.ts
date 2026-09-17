/**
 * CI enforcement for the migration lock guard.
 *
 * Migrations run from a pre-deploy Job while the old Pods still serve traffic,
 * and `ensureSchema` pins that session at `lock_timeout = '5s'`. DDL that needs
 * an AccessExclusiveLock on a hot table therefore has five seconds to get it
 * before the statement aborts with `55P03` — and once a migration is applied,
 * its SQL is checksum-pinned and can never be rewritten. Catching the pattern
 * before merge is the only place it can be caught at all.
 *
 * See scripts/guard-migration-locks.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
// The guard is plain ESM tooling; tsx lets this .ts test import the .mjs.
import {
  grandfathered,
  scanMigration,
  scanRepo,
  stripComments,
  tablesCreatedIn,
} from '../../../scripts/guard-migration-locks.mjs'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const MIGRATIONS = join(ROOT, 'server/src/db/migrations')
const migration = (file: string): string => readFileSync(join(MIGRATIONS, file), 'utf8')

test('no migration takes a table-wide lock it does not need', () => {
  const problems = scanRepo()
  assert.deepEqual(
    problems, [],
    '\n🚨 migration would lock a live table:\n' +
      problems.map((p: { where: string; why: string }) => `  ${p.where}\n    ${p.why}`).join('\n'),
  )
})

test('the guard is looking at the real migration files', () => {
  // If the directory or the filename pattern ever moved, scanRepo() would have
  // nothing to scan and would pass vacuously. scanRepo() reports that as a
  // problem; pin the happy path here too.
  const files = readdirSync(MIGRATIONS).filter((name) => /^\d{4}-.+\.ts$/.test(name))
  assert.ok(files.length >= 8, `expected the real migration set, found ${files.length}`)
})

// --- the guard actually catches both hazards (so it is not a no-op) ---

test('a volatile ADD COLUMN default is caught', () => {
  // Exactly migration 0004's shape, which rewrites `participants` — a table on
  // the hot path of nearly every query — under AccessExclusiveLock.
  const problems = scanMigration(
    'x.ts',
    'ALTER TABLE participants ADD COLUMN runtime_assignment_id TEXT NOT NULL DEFAULT gen_random_uuid()::text;',
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0].why, /VOLATILE/)
  assert.match(problems[0].why, /nullable/)

  // And the real file is caught when it is not treated as grandfathered, which
  // is what keeps the allowlist entry honest.
  const live = scanMigration('0004.ts', migration('0004-agent-runtime-assignment.ts'))
  assert.equal(live.length, 1, 'the allowlisted migration must still be a real hazard')
})

test('a non-volatile default is not caught', () => {
  // now() is STABLE, and a literal is IMMUTABLE — both take PostgreSQL's
  // metadata-only fast path, so flagging them would be a false positive that
  // teaches people to ignore the guard.
  assert.deepEqual(scanMigration('x.ts', "ALTER TABLE computers ADD COLUMN engine_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;"), [])
  assert.deepEqual(scanMigration('x.ts', 'ALTER TABLE messages ADD COLUMN seen_at TIMESTAMPTZ NOT NULL DEFAULT now();'), [])
  assert.deepEqual(scanMigration('x.ts', 'ALTER TABLE participants ADD COLUMN provider_profile TEXT;'), [])
})

test('a plain CREATE INDEX on a pre-existing table is caught', () => {
  const problems = scanMigration('x.ts', 'CREATE INDEX idx_messages_convo ON messages (conversation_id);')
  assert.equal(problems.length, 1)
  assert.match(problems[0].why, /CONCURRENTLY/)

  assert.deepEqual(
    scanMigration('x.ts', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_convo ON messages (conversation_id);'),
    [],
  )
})

test('indexing a table the same migration creates is not caught', () => {
  // Nothing can be reading or writing a table that did not exist a statement
  // ago, so CONCURRENTLY buys nothing there — and would force the migration
  // out of its transaction for no reason.
  assert.deepEqual(
    scanMigration('x.ts', `
      CREATE TABLE conversation_members (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE INDEX idx_conversation_members_participant ON conversation_members (conversation_id);
    `),
    [],
  )
  assert.ok(tablesCreatedIn('CREATE TABLE IF NOT EXISTS agent_routing_claims (id TEXT)').has('agent_routing_claims'))
})

test('prose about a bad pattern is not mistaken for the pattern', () => {
  // 0005's header comment explains why "a plain CREATE INDEX" is wrong. A guard
  // that flagged its own documentation would be unusable.
  assert.deepEqual(scanMigration('0005.ts', migration('0005-search-trigram-index.ts')), [])
  assert.match(stripComments('/* CREATE INDEX idx ON messages (a) */ SELECT 1'), /^\s+SELECT 1$/)
  assert.match(stripComments('// ADD COLUMN x DEFAULT gen_random_uuid()\nSELECT 1'), /^\s*\nSELECT 1$/)
})

test('every grandfathered migration says what it does and why it stays', () => {
  const entries = grandfathered()
  assert.ok(entries.size > 0, 'the allowlist should still cover migration 0004')
  for (const [file, reason] of entries) {
    assert.ok(
      readdirSync(MIGRATIONS).includes(file),
      `allowlist names ${file}, which no longer exists — drop the entry`,
    )
    assert.ok(reason.length > 40, `${file} needs a real reason, not "${reason}"`)
    assert.match(reason, /checksum/i, `${file}'s reason must say why the SQL cannot be changed`)
  }
})
