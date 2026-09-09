import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import { pool } from '../db/pool.js'
import { MAX_SUPPORTED_SCHEMA_VERSION, MIN_SUPPORTED_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from '../db/migrations/manifest.js'
import { ensureSchemaOnce, teardownAll } from './_helpers.js'
import {
  buildSchemaVerifierScript,
  parseSchemaVerifierOutput,
} from '../deploy/recovery.js'

const execFile = promisify(execFileCallback)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const createdNodeModulesLinks = new Set<string>()

interface SchemaVerifierRun {
  status: string
  [key: string]: unknown
}

function databaseUrl(): string {
  const value = process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL
  assert.ok(value, 'integration database URL is required')
  return value
}

async function runVerifier(cwd = repoRoot, script = buildSchemaVerifierScript()): Promise<SchemaVerifierRun> {
  await ensureNodeModules(cwd)
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl(),
    NODE_ENV: process.env.NODE_ENV ?? 'test',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'integration-test-key',
    NODE_PATH: process.env.NODE_PATH ?? join(repoRoot, 'node_modules'),
  }
  try {
    const result = await execFile(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd, env, maxBuffer: 1024 * 1024, timeout: 15_000 },
    )
    return parseSchemaVerifierOutput(result.stdout, result.stderr) as unknown as SchemaVerifierRun
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    return parseSchemaVerifierOutput(failed.stdout ?? '', failed.stderr ?? '') as unknown as SchemaVerifierRun
  }
}

async function ensureNodeModules(cwd: string): Promise<void> {
  const target = join(cwd, 'node_modules')
  try {
    await access(target)
    return
  } catch {
    // CI has a real install. The fallback keeps this test runnable from a
    // clean worktree when the sibling checkout already owns the dependency
    // tree; it is removed by after() and never enters git.
  }
  const fallbacks = [
    process.env.CUMORA_TEST_NODE_MODULES,
    join(repoRoot, 'node_modules'),
    resolve(repoRoot, '..', 'cumora', 'node_modules'),
  ].filter((value): value is string => Boolean(value))
  for (const fallback of fallbacks) {
    if (fallback === target) continue
    try {
      await access(fallback)
      await symlink(fallback, target, 'dir')
      createdNodeModulesLinks.add(target)
      return
    } catch {
      // Try the next workspace-local dependency location.
    }
  }
  throw new Error('node_modules is required for the old-image verifier fixture')
}

async function makeReadOnlyVerifierImageLikeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-old-image-schema-'))
  await ensureNodeModules(root)
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
  const dbDir = join(root, 'server', 'src', 'db')
  const migrationsDir = join(dbDir, 'migrations')
  await mkdir(migrationsDir, { recursive: true })
  const realPool = pathToFileURL(resolve(repoRoot, 'server/src/db/pool.ts')).href
  const realManifest = pathToFileURL(resolve(repoRoot, 'server/src/db/migrations/manifest.ts')).href
  const realSchemaVersion = pathToFileURL(resolve(repoRoot, 'server/src/db/schema-version.ts')).href
  await writeFile(join(dbDir, 'pool.ts'), `export { pool } from ${JSON.stringify(realPool)}\n`)
  await writeFile(join(migrationsDir, 'manifest.ts'), `export * from ${JSON.stringify(realManifest)}\n`)
  await writeFile(join(dbDir, 'schema-version.ts'), `
import { verifySchemaCompatibility as verifyRealSchemaCompatibility } from ${JSON.stringify(realSchemaVersion)}

export async function verifySchemaCompatibility(client) {
  const { rows } = await client.query('SHOW transaction_read_only')
  if (rows[0]?.transaction_read_only !== 'on') throw new Error('transaction is not read-only')
  await client.query('SAVEPOINT read_only_probe')
  try {
    await client.query('CREATE TEMP TABLE cumora_verifier_read_only_probe (id integer)')
    throw new Error('read-only transaction accepted DDL')
  } catch (error) {
    if (error?.code !== '25006') throw error
    await client.query('ROLLBACK TO SAVEPOINT read_only_probe')
  }
  await client.query('RELEASE SAVEPOINT read_only_probe')
  return verifyRealSchemaCompatibility(client)
}
`)
  return root
}

async function withCommittedMutation<T>(
  mutate: (client: import('pg').PoolClient) => Promise<void>,
  restore: (client: import('pg').PoolClient) => Promise<void>,
  check: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await mutate(client)
    await client.query('COMMIT')
    try {
      return await check()
    } finally {
      await client.query('BEGIN')
      await restore(client)
      await client.query('COMMIT')
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

before(async () => { await ensureSchemaOnce() })
after(async () => {
  await teardownAll()
  for (const link of createdNodeModulesLinks) await unlink(link).catch(() => {})
  createdNodeModulesLinks.clear()
})

test('the actual inline verifier reads current PostgreSQL schema in read-only mode', async () => {
  const beforeRows = await pool.query(
    `SELECT version, name, checksum, execution_ms, applied_at
       FROM schema_migrations ORDER BY version`,
  )
  const result = await runVerifier()
  assert.equal(result.status, 'compatible', JSON.stringify(result))
  assert.equal(result.currentVersion, SCHEMA_MIGRATIONS.at(-1)?.version)
  assert.equal(result.minSupported, MIN_SUPPORTED_SCHEMA_VERSION)
  assert.equal(result.maxSupported, MAX_SUPPORTED_SCHEMA_VERSION)
  const afterRows = await pool.query(
    `SELECT version, name, checksum, execution_ms, applied_at
       FROM schema_migrations ORDER BY version`,
  )
  assert.deepEqual(afterRows.rows, beforeRows.rows, 'read-only verifier changed schema ledger')
})

test('the inline verifier enforces transaction READ ONLY through an old-image-like wrapper', async () => {
  const imageLikeDir = await makeReadOnlyVerifierImageLikeDir()
  try {
    const beforeRows = await pool.query(
      `SELECT version, name, checksum, execution_ms, applied_at
         FROM schema_migrations ORDER BY version`,
    )
    const result = await runVerifier(imageLikeDir)
    assert.equal(result.status, 'compatible', JSON.stringify(result))
    assert.equal(result.currentVersion, SCHEMA_MIGRATIONS.at(-1)?.version)
    const afterRows = await pool.query(
      `SELECT version, name, checksum, execution_ms, applied_at
         FROM schema_migrations ORDER BY version`,
    )
    assert.deepEqual(afterRows.rows, beforeRows.rows)
    const { rows } = await pool.query<{ regclass: string | null }>(
      `SELECT to_regclass('public.cumora_verifier_read_only_probe') AS regclass`,
    )
    assert.equal(rows[0]?.regclass, null, 'read-only verifier left a DDL probe table')
  } finally {
    await rm(imageLikeDir, { recursive: true, force: true })
  }
})

test('an old image without verifier modules is an explicit unknown result', async () => {
  const imageLikeDir = await mkdtemp(join(tmpdir(), 'cumora-old-image-missing-verifier-'))
  await ensureNodeModules(imageLikeDir)
  await writeFile(join(imageLikeDir, 'package.json'), '{"type":"module"}\n')
  try {
    const result = await runVerifier(imageLikeDir)
    assert.equal(result.status, 'unknown', JSON.stringify(result))
    assert.equal(result.reasonCode, 'module_unavailable')
  } finally {
    await rm(imageLikeDir, { recursive: true, force: true })
  }
})

test('the actual verifier reports future schema as known incompatible', async () => {
  const version = MAX_SUPPORTED_SCHEMA_VERSION + 1
  const result = await withCommittedMutation(
    async (client) => {
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
         VALUES ($1, $2, $3, 0)`,
        [version, `000${version}_test_future`, 'f'.repeat(64)],
      )
    },
    (client) => client.query('DELETE FROM schema_migrations WHERE version = $1', [version]).then(() => undefined),
    runVerifier,
  )
  assert.equal(result.status, 'incompatible', JSON.stringify(result))
  assert.equal(result.code, 'schema_ahead')
})

test('the actual verifier rejects corrupted and gapped immutable history', async () => {
  const original = await pool.query<{
    version: number
    name: string
    checksum: string
    execution_ms: number
    applied_at: Date
  }>(
    `SELECT version, name, checksum, execution_ms, applied_at
       FROM schema_migrations WHERE version = $1`,
    [MAX_SUPPORTED_SCHEMA_VERSION - 1],
  )
  assert.equal(original.rows.length, 1)
  const row = original.rows[0]!

  const corrupted = await withCommittedMutation(
    (client) => client.query(
      `UPDATE schema_migrations SET checksum = $2 WHERE version = $1`,
      [1, '0'.repeat(64)],
    ).then(() => undefined),
    (client) => client.query(
      `UPDATE schema_migrations SET checksum = $2 WHERE version = $1`,
      [1, SCHEMA_MIGRATIONS[0]!.checksum],
    ).then(() => undefined),
    runVerifier,
  )
  assert.equal(corrupted.status, 'incompatible', JSON.stringify(corrupted))
  assert.equal(corrupted.code, 'migration_history_invalid')

  const gapped = await withCommittedMutation(
    (client) => client.query(
      `DELETE FROM schema_migrations WHERE version = $1`,
      [row.version],
    ).then(() => undefined),
    (client) => client.query(
      `INSERT INTO schema_migrations (version, name, checksum, execution_ms, applied_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.version, row.name, row.checksum, row.execution_ms, row.applied_at],
    ).then(() => undefined),
    runVerifier,
  )
  assert.equal(gapped.status, 'incompatible', JSON.stringify(gapped))
  assert.equal(gapped.code, 'migration_history_invalid')
})
