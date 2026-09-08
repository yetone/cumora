import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { EngineDefaultsMap } from '../agents/computer/registry.js'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'
const { updateEngineDefaults } = await import('../agents/computer/registry.js')
const { pool } = await import('../db/pool.js')
const originalConnect = pool.connect

afterEach(() => { pool.connect = originalConnect })
after(async () => { await pool.end() })

// Model row locking and transaction-local writes without using a developer database.
function database(initial: EngineDefaultsMap, options: { missing?: boolean; failWrite?: boolean } = {}) {
  let stored = structuredClone(initial)
  let tail = Promise.resolve()
  let releases = 0
  let commits = 0
  let rollbacks = 0
  const connect = async () => {
    let unlock: (() => void) | undefined
    let pending: EngineDefaultsMap | undefined
    let inTransaction = false
    return {
      async query(sql: string, params: unknown[] = []) {
        if (sql === 'BEGIN') {
          inTransaction = true
        } else if (sql.includes('SELECT engine_defaults')) {
          assert.ok(inTransaction)
          assert.match(sql, /FOR UPDATE/)
          assert.match(sql, /company_id = \$2/)
          assert.match(sql, /kind <> 'cloud'/)
          assert.match(sql, /revoked_at IS NULL/)
          assert.deepEqual(params, ['computer', 'company'])
          const previous = tail
          tail = new Promise<void>((resolve) => { unlock = resolve })
          await previous
          return { rows: options.missing ? [] : [{ engine_defaults: structuredClone(stored) }] }
        } else if (sql.includes('UPDATE computers SET engine_defaults')) {
          assert.ok(inTransaction && unlock)
          if (options.failWrite) throw new Error('write failed')
          pending = JSON.parse(params[1] as string) as EngineDefaultsMap
        } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          if (sql === 'COMMIT') {
            if (pending) stored = pending
            commits++
          } else {
            rollbacks++
          }
          inTransaction = false
          unlock?.()
          unlock = undefined
        } else {
          throw new Error(`Unexpected query: ${sql}`)
        }
        return { rows: [] }
      },
      release() {
        assert.equal(inTransaction, false)
        assert.equal(unlock, undefined)
        releases++
      },
    }
  }
  pool.connect = connect as unknown as typeof pool.connect
  return () => ({ stored, releases, commits, rollbacks })
}

const save = (defaults: EngineDefaultsMap) => updateEngineDefaults({
  computerId: 'computer', companyId: 'company', defaults,
})

test('concurrent updates to different engines preserve both changes', async () => {
  const state = database({})
  await Promise.all([save({ claude: { model: 'claude-main' } }), save({ codex: { model: 'codex-main' } })])
  assert.deepEqual(state(), {
    stored: { claude: { model: 'claude-main' }, codex: { model: 'codex-main' } },
    releases: 2, commits: 2, rollbacks: 0,
  })
})

test('concurrent updates to different fields of one engine preserve both changes', async () => {
  const state = database({ claude: { model: 'old-main', fastModel: 'old-fast' } })
  await Promise.all([save({ claude: { model: 'new-main' } }), save({ claude: { fastModel: 'new-fast' } })])
  assert.deepEqual(state().stored, { claude: { model: 'new-main', fastModel: 'new-fast' } })
})

test('clearing a field preserves a concurrent change to the other field', async () => {
  const state = database({ claude: { model: 'old-main', fastModel: 'old-fast' } })
  await Promise.all([save({ claude: { model: null } }), save({ claude: { fastModel: 'new-fast' } })])
  assert.deepEqual(state().stored, { claude: { fastModel: 'new-fast' } })
})

test('partial updates trim strings and clearing the last field removes the engine', async () => {
  const state = database({ claude: { model: 'main', fastModel: 'fast' }, codex: { model: 'codex' } })
  assert.deepEqual(await save({ claude: { model: ' updated ' } }), {
    claude: { model: 'updated', fastModel: 'fast' }, codex: { model: 'codex' },
  })
  await save({ claude: { model: '  ' } })
  assert.deepEqual(state().stored.claude, { fastModel: 'fast' })
  await save({ claude: { fastModel: null } })
  assert.deepEqual(state().stored, { codex: { model: 'codex' } })
})

test('a missing or inaccessible computer closes the transaction without writing', async () => {
  const state = database({}, { missing: true })
  assert.equal(await save({ claude: { model: 'main' } }), null)
  assert.deepEqual(state(), { stored: {}, releases: 1, commits: 1, rollbacks: 0 })
})

test('a failed write rolls back and releases the connection', async () => {
  const state = database({ claude: { model: 'original' } }, { failWrite: true })
  await assert.rejects(save({ claude: { model: 'changed' } }), /write failed/)
  assert.deepEqual(state(), {
    stored: { claude: { model: 'original' } }, releases: 1, commits: 0, rollbacks: 1,
  })
})
