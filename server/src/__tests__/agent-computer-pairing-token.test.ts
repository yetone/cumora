/**
 * Unit tests for persistent BYOA computer pairing tokens.
 *
 * Run: node --import tsx --test server/src/__tests__/agent-computer-pairing-token.test.ts
 */
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const registry = await import('../agents/computer/registry.js')
const { pool } = await import('../db/pool.js')

const originalQuery = pool.query.bind(pool)

type QueryCall = { sql: string; params: unknown[] }

function installPoolMock(handler: (call: QueryCall) => { rows?: unknown[]; rowCount?: number }) {
  const calls: QueryCall[] = []
  ;(pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }).query =
    async (sql: string, params: unknown[] = []) => {
      const call = { sql, params }
      calls.push(call)
      const out = handler(call)
      return { rows: out.rows ?? [], rowCount: out.rowCount ?? (out.rows?.length ?? 0) }
    }
  return calls
}

afterEach(() => {
  ;(pool as unknown as { query: typeof originalQuery }).query = originalQuery
})

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

test('company add token is persistent and reattaches an existing host by name', async () => {
  let companyTokenSelected = false
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT pair_token FROM companies/.test(sql)) {
      if (!companyTokenSelected) {
        companyTokenSelected = true
        return { rows: [{ pair_token: null }] }
      }
      return { rows: [{ pair_token: 'company-token' }] }
    }
    if (/UPDATE companies SET pair_token/.test(sql)) return { rowCount: 1 }
    if (/SELECT id, company_id/.test(sql)) return { rows: [] }
    if (/SELECT id AS company_id, owner_user_id FROM companies/.test(sql)) {
      return { rows: [{ company_id: 'co-1', owner_user_id: 'u-1' }] }
    }
    if (/SELECT id FROM computers/.test(sql)) return { rows: [{ id: 'comp-existing' }] }
    if (/UPDATE computers\s+SET credential_hash/.test(sql)) return { rowCount: 1 }
    throw new Error(`unexpected query: ${sql}`)
  })

  const issued = await registry.issuePairingCode({ companyId: 'co-1', ownerUserId: 'u-1' })
  assert.deepEqual(issued, { code: 'company-token', expiresInSeconds: null })

  const paired = await registry.pairComputer({
    code: 'company-token',
    hostName: 'MacBook Air',
    engines: ['claude', 'cursor', 'opencode', 'bogus'],
    deferBroadcast: true,
  })
  assert.equal(paired?.computerId, 'comp-existing')
  assert.equal(paired?.companyId, 'co-1')

  const update = calls.find((c) => /UPDATE computers\s+SET credential_hash/.test(c.sql))
  assert.ok(update, 'existing computer should be updated instead of inserting a duplicate')
  assert.equal(update.params[1], JSON.stringify(['claude', 'cursor', 'opencode']))
  assert.equal(calls.some((c) => /INSERT INTO computers/.test(c.sql)), false)
})

test('computer reconnect token is persistent, updates the exact row, and preserves its default engine', async () => {
  let computerTokenSelected = false
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT pair_token FROM computers/.test(sql)) {
      if (!computerTokenSelected) {
        computerTokenSelected = true
        return { rows: [{ pair_token: null }] }
      }
      return { rows: [{ pair_token: 'repair-token' }] }
    }
    if (/UPDATE computers SET pair_token/.test(sql)) return { rowCount: 1 }
    if (/SELECT id, company_id/.test(sql)) {
      return { rows: [{ id: 'comp-old', company_id: 'co-1', available_engines: ['codex', 'claude'] }] }
    }
    if (/UPDATE computers\s+SET credential_hash/.test(sql)) return { rowCount: 1 }
    throw new Error(`unexpected query: ${sql}`)
  })

  const issued = await registry.issueRepairCode({ companyId: 'co-1', ownerUserId: 'u-1', computerId: 'comp-old' })
  assert.deepEqual(issued, { code: 'repair-token', expiresInSeconds: null })

  const paired = await registry.pairComputer({
    code: 'repair-token',
    hostName: 'MacBook Air',
    engines: ['claude', 'codex'],
    deferBroadcast: true,
  })
  assert.equal(paired?.computerId, 'comp-old')
  assert.equal(paired?.companyId, 'co-1')

  const update = calls.find((c) => /UPDATE computers\s+SET credential_hash/.test(c.sql))
  assert.ok(update, 'computer-specific token should update the bound row')
  assert.equal(update.params[1], JSON.stringify(['codex', 'claude']))
  assert.equal(update.params[2], 'MacBook Air')
  assert.equal(update.params[3], 'comp-old')
})

test('daemon run mode (supervised) is persisted on pair and heartbeat', async () => {
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT id, company_id/.test(sql)) {
      return { rows: [{ id: 'comp-old', company_id: 'co-1' }] }
    }
    if (/UPDATE computers\s+SET credential_hash/.test(sql)) return { rowCount: 1 }
    if (/UPDATE computers SET last_seen_at/.test(sql)) return { rowCount: 1 }
    throw new Error(`unexpected query: ${sql}`)
  })

  await registry.pairComputer({
    code: 'repair-token', hostName: 'MacBook Air', engines: ['claude'],
    version: '0.1.122', supervised: true, deferBroadcast: true,
  })
  const updates = () => calls.filter((c) => /UPDATE computers\s+SET credential_hash/.test(c.sql))
  assert.equal(updates()[0]?.params[4], '0.1.122')
  assert.equal(updates()[0]?.params[5], true)

  // An old daemon that doesn't report the mode must not clobber the stored
  // value: the param is NULL and the SQL COALESCEs it away.
  await registry.pairComputer({
    code: 'repair-token', hostName: 'MacBook Air', engines: ['claude'], deferBroadcast: true,
  })
  assert.equal(updates()[1]?.params[5], null)

  // Heartbeat carries the live mode — a service uninstalled + re-run by hand
  // flips supervised true→false within one heartbeat.
  await registry.heartbeatComputer('comp-old', '0.1.122', false)
  const hb = calls.find((c) => /UPDATE computers SET last_seen_at/.test(c.sql))
  assert.ok(hb, 'heartbeat should bump the row')
  assert.equal(hb.params[1], '0.1.122')
  assert.equal(hb.params[2], false)
})

test('pairComputer accepts antigravity engine as primary and stores it in available_engines', async () => {
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT pair_token FROM companies/.test(sql)) return { rows: [{ pair_token: 'company-token' }] }
    if (/SELECT id, company_id/.test(sql)) return { rows: [] }
    if (/SELECT id AS company_id, owner_user_id FROM companies/.test(sql)) {
      return { rows: [{ company_id: 'co-1', owner_user_id: 'u-1' }] }
    }
    if (/SELECT id FROM computers/.test(sql)) return { rows: [{ id: 'comp-antigravity' }] }
    if (/UPDATE computers\s+SET credential_hash/.test(sql)) return { rowCount: 1 }
    throw new Error(`unexpected query: ${sql}`)
  })

  const paired = await registry.pairComputer({
    code: 'company-token',
    hostName: 'Dev Box',
    engines: ['antigravity', 'claude'],
    deferBroadcast: true,
  })
  assert.equal(paired?.computerId, 'comp-antigravity')

  const update = calls.find((c) => /UPDATE computers\s+SET credential_hash/.test(c.sql))
  assert.ok(update)
  assert.equal(update.params[1], JSON.stringify(['antigravity', 'claude']))
})

