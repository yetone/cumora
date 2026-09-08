import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { frozenBaselineSql, runBaselineStatements, splitSqlStatements } = await import('../db/migrate.js')

test('splitSqlStatements only splits on top-level semicolons', () => {
  const sql = `
    -- a comment; with a semicolon
    CREATE TABLE IF NOT EXISTS a (x TEXT DEFAULT 'semi;colon', y TEXT DEFAULT 'it''s; quoted');
    /* block; comment */
    DO $$ BEGIN
      IF EXISTS (SELECT 1) THEN EXECUTE 'ALTER TABLE a ADD COLUMN IF NOT EXISTS z TEXT'; END IF;
    END $$;
    CREATE FUNCTION f() RETURNS TEXT LANGUAGE plpgsql AS $fn$ BEGIN RETURN 'x;y'; END $fn$;
    INSERT INTO a (x) VALUES ('last') -- trailing; comment
  `
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 4)
  assert.match(statements[0], /^-- a comment; with a semicolon\s+CREATE TABLE IF NOT EXISTS a/)
  assert.match(statements[0], /'it''s; quoted'\)$/)
  assert.match(statements[1], /^\/\* block; comment \*\/\s+DO \$\$ BEGIN[\s\S]*END \$\$$/)
  assert.match(statements[2], /^CREATE FUNCTION f\(\)[\s\S]*END \$fn\$$/)
  assert.match(statements[3], /^INSERT INTO a \(x\) VALUES \('last'\) -- trailing; comment$/)
})

test('splitSqlStatements drops comment-only chunks and preserves the frozen baseline verbatim', () => {
  const sql = frozenBaselineSql()
  const statements = splitSqlStatements(sql)
  assert.ok(statements.length > 250, `expected a few hundred statements, got ${statements.length}`)

  // Nothing but whitespace and comment text may be lost by the split.
  const strip = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '')
  assert.equal(strip(statements.join(';')), strip(sql).replace(/;$/, ''))

  for (const statement of statements) {
    assert.doesNotMatch(statement, /^\s*$/)
    assert.notEqual(strip(statement), '', 'a comment-only chunk leaked through')
    const dollarTags = statement.match(/\$[A-Za-z_]*\$/g) ?? []
    assert.equal(dollarTags.length % 2, 0, `unbalanced dollar quoting in: ${statement.slice(0, 80)}`)
  }
  assert.ok(statements.some((statement) => /^DO \$\$/.test(statement)), 'DO blocks must survive as single statements')
})

test('runBaselineStatements retries only lock contention, one statement at a time, in order', async () => {
  const executed: string[] = []
  const sleeps: number[] = []
  let deadlocks = 2
  const client = {
    async query(sql: string) {
      executed.push(sql)
      if (sql.startsWith('ALTER TABLE hot') && deadlocks > 0) {
        deadlocks--
        throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      }
    },
  }
  const count = await runBaselineStatements(
    client,
    'CREATE TABLE IF NOT EXISTS a (id TEXT); ALTER TABLE hot ADD COLUMN IF NOT EXISTS x TEXT; INSERT INTO a VALUES (\'z\');',
    { sleep: async (ms) => { sleeps.push(ms) } },
  )
  assert.equal(count, 3)
  assert.deepEqual(executed, [
    'CREATE TABLE IF NOT EXISTS a (id TEXT)',
    'ALTER TABLE hot ADD COLUMN IF NOT EXISTS x TEXT',
    'ALTER TABLE hot ADD COLUMN IF NOT EXISTS x TEXT',
    'ALTER TABLE hot ADD COLUMN IF NOT EXISTS x TEXT',
    "INSERT INTO a VALUES ('z')",
  ])
  assert.equal(sleeps.length, 2)
  assert.ok(sleeps[1] > sleeps[0], 'backoff must grow')
})

test('runBaselineStatements propagates real errors immediately and gives up after maxAttempts', async () => {
  const executed: string[] = []
  const failing = {
    async query(sql: string) {
      executed.push(sql)
      if (sql.startsWith('ALTER')) throw Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' })
    },
  }
  await assert.rejects(
    runBaselineStatements(failing, 'SELECT 1; ALTER TABLE nope ADD COLUMN x TEXT; SELECT 2', { sleep: async () => {} }),
    (err: unknown) => (err as { code?: string }).code === '42P01',
  )
  assert.deepEqual(executed, ['SELECT 1', 'ALTER TABLE nope ADD COLUMN x TEXT'])

  let attempts = 0
  const alwaysLocked = {
    async query() {
      attempts++
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    },
  }
  await assert.rejects(
    runBaselineStatements(alwaysLocked, 'ALTER TABLE hot ADD COLUMN x TEXT', { sleep: async () => {}, maxAttempts: 3 }),
    (err: unknown) => (err as { code?: string }).code === '55P03',
  )
  assert.equal(attempts, 3)
})
