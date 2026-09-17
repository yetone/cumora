#!/usr/bin/env node
/**
 * guard-migration-locks — a migration may not take a table-wide lock it does
 * not need.
 *
 * Migrations run from a pre-deploy Job, against production, WHILE the old Pods
 * are still serving traffic. `ensureSchema` pins that session at
 * `lock_timeout = '5s'`, so DDL that needs an AccessExclusiveLock on a hot
 * table has five seconds to get it before the statement aborts with `55P03`
 * and the deploy fails. Even when it does get the lock, everything else queues
 * behind it for as long as the statement runs.
 *
 * Migration SQL is checksum-pinned once applied, so a migration written this
 * way cannot be fixed afterwards — only worked around. That is why this is a
 * pre-merge guard and not a runtime check.
 *
 * Two patterns are rejected:
 *
 *   1. ADD COLUMN with a VOLATILE default.
 *
 *      PostgreSQL's metadata-only fast path for `ADD COLUMN … DEFAULT` applies
 *      only to non-volatile defaults. A volatile one — gen_random_uuid(),
 *      random(), clock_timestamp(), nextval() — forces a full table and index
 *      rewrite under AccessExclusiveLock. Migration 0004 did exactly this to
 *      `participants`, a table on the hot path of nearly every query in the
 *      product; it is allowlisted below because its checksum is pinned and its
 *      SQL can no longer be changed.
 *
 *      Write it as: nullable column (metadata only) → batched backfill →
 *      SET DEFAULT → `CHECK (… IS NOT NULL) NOT VALID` → VALIDATE CONSTRAINT.
 *      Each step is short, and none of them holds a lock across the backfill.
 *
 *   2. CREATE INDEX without CONCURRENTLY on a pre-existing table.
 *
 *      A plain CREATE INDEX blocks writes to the table for the whole build. On
 *      a hot table under live traffic that wait deadlocks (`40P01`) against
 *      concurrent writers, and because the build then never commits, every Pod
 *      retries it on boot and none can start — which is how the
 *      conversations.members GIN build wedged production. Use CREATE INDEX
 *      CONCURRENTLY with `transactional: false`, as 0005 and 0006 do.
 *
 *      Indexing a table the SAME migration creates is fine and is not flagged:
 *      nothing can be reading or writing a table that did not exist a statement
 *      ago.
 *
 * A guard that quietly stops checking is worse than no guard, so `scanRepo()`
 * reports a problem if the migrations directory ever reads as empty.
 *
 * Run:  node scripts/guard-migration-locks.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MIGRATIONS_DIR = 'server/src/db/migrations'

/**
 * Migrations whose SQL is already applied in production and checksum-pinned,
 * so it cannot be rewritten. Each entry records what it does and why it stays.
 */
const GRANDFATHERED = new Map([
  [
    '0004-agent-runtime-assignment.ts',
    'ADD COLUMN … DEFAULT gen_random_uuid()::text rewrites participants under ' +
    'AccessExclusiveLock. Applied and checksum-pinned; changing the SQL would fail ' +
    'the checksum check on every existing database.',
  ],
])

/** VOLATILE in PostgreSQL's function catalog, so a default built from one
 *  defeats the metadata-only ADD COLUMN fast path. `now()` and
 *  `current_timestamp` are STABLE, not volatile, and are deliberately absent. */
const VOLATILE_DEFAULTS = [
  'gen_random_uuid',
  'uuid_generate_v1',
  'uuid_generate_v4',
  'random',
  'clock_timestamp',
  'timeofday',
  'nextval',
]

/** Strip comments so prose describing a pattern is never mistaken for it —
 *  0005's header explains why "a plain CREATE INDEX" is wrong, in a comment. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** Tables this file creates itself — indexing them is free of live traffic. */
export function tablesCreatedIn(sql) {
  const names = new Set()
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
    names.add(m[1].toLowerCase())
  }
  return names
}

/** Every lock hazard in one migration's source text. */
export function scanMigration(file, source) {
  const sql = stripComments(source).replace(/\s+/g, ' ')
  const created = tablesCreatedIn(sql)
  const problems = []

  // ADD COLUMN … DEFAULT <volatile>. Bounded to the clause: the default runs to
  // the next comma or statement end, so a volatile call in a LATER column's
  // definition is attributed to that column, not this one.
  for (const m of sql.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)[^,;]*?DEFAULT\s+([^,;]+)/gi)) {
    const [, column, expression] = m
    const volatileFn = VOLATILE_DEFAULTS.find((fn) => new RegExp(`\\b${fn}\\s*\\(`, 'i').test(expression))
    if (!volatileFn) continue
    problems.push({
      where: `${MIGRATIONS_DIR}/${file}`,
      why: `ADD COLUMN ${column} DEFAULT … ${volatileFn}() is VOLATILE, so PostgreSQL rewrites the whole `
        + 'table under AccessExclusiveLock instead of taking the metadata-only fast path. Add the column '
        + 'nullable, backfill in batches, then SET DEFAULT and validate a NOT VALID check constraint.',
    })
  }

  // CREATE [UNIQUE] INDEX … ON <table>, without CONCURRENTLY, on a table that
  // already exists.
  for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[a-z_][a-z0-9_$]*\s+ON\s+(?:ONLY\s+)?([a-z_][a-z0-9_]*)/gi)) {
    const [, concurrently, table] = m
    if (concurrently) continue
    if (created.has(table.toLowerCase())) continue
    problems.push({
      where: `${MIGRATIONS_DIR}/${file}`,
      why: `CREATE INDEX on the pre-existing table "${table}" blocks writes for the whole build and `
        + 'deadlocks against live writers. Use CREATE INDEX CONCURRENTLY with transactional: false.',
    })
  }

  return problems
}

export function scanRepo() {
  const files = readdirSync(join(ROOT, MIGRATIONS_DIR))
    .filter((name) => /^\d{4}-.+\.ts$/.test(name))
    .sort()

  if (files.length === 0) {
    return [{
      where: MIGRATIONS_DIR,
      why: 'no migration files found — the guard is looking in the wrong place and would pass vacuously',
    }]
  }

  const problems = []
  for (const file of files) {
    if (GRANDFATHERED.has(file)) continue
    problems.push(...scanMigration(file, readFileSync(join(ROOT, MIGRATIONS_DIR, file), 'utf8')))
  }
  return problems
}

/** Exported so the test can prove the allowlist still describes a real hazard
 *  rather than silently covering a migration that no longer has one. */
export function grandfathered() {
  return GRANDFATHERED
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = scanRepo()
  if (problems.length > 0) {
    console.error('🚨 migration would lock a live table:\n')
    for (const problem of problems) console.error(`  ${problem.where}\n    ${problem.why}\n`)
    console.error('Migration SQL is checksum-pinned once applied — it cannot be fixed after the fact.')
    process.exit(1)
  }
  console.log('✅ migration lock guard: no migration takes a table-wide lock it does not need.')
}
