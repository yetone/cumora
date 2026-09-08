/**
 * Cached engine detection + inherit/default for BYOA computers.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-detect.test.ts
 */
import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.CUMORA_DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7'
process.env.CUMORA_DEFAULT_GEMINI_MODEL = 'gemini-2.5-pro'
process.env.CUMORA_DEFAULT_QWEN_MODEL = 'qwen3-coder-plus'
process.env.CUMORA_DEFAULT_ANTIGRAVITY_MODEL = 'Gemini 3.5 Flash (High)'
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

test('sanitizeDetectedEngines drops unknown ids and fills missing bins', () => {
  const out = registry.sanitizeDetectedEngines(
    [{ id: 'claude', bin: 'claude', path: '/usr/bin/claude' }, { id: 'bogus', bin: 'x', path: null }],
    ['claude', 'codex', 'gemini', 'antigravity', 'bogus'],
  )
  // Version fields come back on every row — null here, since a daemon this old
  // reports paths only. See agents-computer-engine-version.test.ts. blockedReason
  // is null for the same reason every key is present on every row: the app must
  // never have to tell "field absent" from "nothing to report".
  const noVersion = { version: null, latest: null, outdated: false, updateCommand: null, blockedReason: null }
  assert.deepEqual(out, [
    { id: 'claude', bin: 'claude', path: '/usr/bin/claude', ...noVersion },
    { id: 'codex', bin: 'codex', path: null, ...noVersion },
    { id: 'gemini', bin: 'gemini', path: null, ...noVersion },
    { id: 'antigravity', bin: 'agy', path: null, ...noVersion },
  ])
})

test('listAgentsForComputer keeps an explicit model and pins CUMORA_DEFAULT_* when empty', async () => {
  installPoolMock(({ sql }) => {
    if (/FROM participants/.test(sql)) {
      return { rows: [
        { id: 'bram', name: 'Bram', role: 'engineer', systemPrompt: null, engine: 'claude', model: 'stale-pin', fastModel: 'haiku' },
        { id: 'saga', name: 'Saga', role: 'writer', systemPrompt: null, engine: 'claude', model: null, fastModel: null },
        { id: 'aster', name: 'Aster', role: 'reviewer', systemPrompt: null, engine: 'antigravity', model: null, fastModel: null },
        { id: 'atlas', name: 'Atlas', role: 'analyst', systemPrompt: null, engine: 'gemini', model: null, fastModel: null },
        { id: 'orion', name: 'Orion', role: 'coder', systemPrompt: null, engine: 'qwen', model: null, fastModel: null },
      ] }
    }
    return { rows: [] }
  })
  const agents = await registry.listAgentsForComputer('comp-1')
  assert.equal(agents[0]?.model, 'stale-pin')
  assert.equal(agents[0]?.fastModel, 'haiku')
  assert.equal(agents[1]?.model, 'claude-opus-4-7')
  assert.equal(agents[1]?.engine, 'claude')
  assert.equal(agents[2]?.model, 'Gemini 3.5 Flash (High)')
  assert.equal(agents[2]?.engine, 'antigravity')
  assert.equal(agents[3]?.model, 'gemini-2.5-pro')
  assert.equal(agents[3]?.engine, 'gemini')
  assert.equal(agents[4]?.model, 'qwen3-coder-plus')
  assert.equal(agents[4]?.engine, 'qwen')
})

test('listAgentsForComputer prefers a reported local default without overriding an explicit pin', async () => {
  const catalog = {
    models: [{ id: 'provider/opus', label: 'Provider Opus' }],
    defaultModel: 'provider/opus',
    defaultFastModel: 'provider/haiku',
    prefersLocalDefault: true,
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'cli',
  }
  const localComputer = {
    availableEngines: ['claude'],
    detectedEngines: [{ id: 'claude', bin: 'claude', path: '/bin/claude', modelCatalog: catalog }],
  }
  installPoolMock(({ sql }) => {
    if (/FROM participants/.test(sql)) {
      return { rows: [
        { id: 'explicit', name: 'Explicit', role: null, systemPrompt: null, engine: 'claude', model: 'agent/pin', fastModel: null, ...localComputer },
        { id: 'local', name: 'Local', role: null, systemPrompt: null, engine: 'claude', model: null, fastModel: null, ...localComputer },
        {
          id: 'unnamed', name: 'Unnamed', role: null, systemPrompt: null, engine: 'claude', model: null, fastModel: null,
          availableEngines: ['claude'],
          detectedEngines: [{
            id: 'claude', bin: 'claude', path: '/bin/claude',
            modelCatalog: { ...catalog, models: [], defaultModel: null },
          }],
        },
      ] }
    }
    return { rows: [] }
  })

  const agents = await registry.listAgentsForComputer('comp-1')
  assert.equal(agents[0]?.model, 'agent/pin')
  assert.equal(agents[0]?.fastModel, 'provider/haiku')
  assert.equal(agents[1]?.model, 'provider/opus')
  assert.equal(agents[1]?.fastModel, 'provider/haiku')
  assert.equal(agents[2]?.model, null, 'custom provider with unnamed default must not inherit the deploy pin')
  assert.equal(agents[2]?.fastModel, 'provider/haiku')
  assert.equal('detectedEngines' in (agents[1] ?? {}), false)
})

test('reportDetectedEngines keeps the previous default first when it is still installed', async () => {
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT available_engines/.test(sql)) {
      return { rows: [{ available_engines: ['codex', 'claude'], company_id: 'co-1' }] }
    }
    if (/UPDATE computers/.test(sql)) return { rowCount: 1 }
    return { rows: [] }
  })
  const ok = await registry.reportDetectedEngines({
    computerId: 'comp-1',
    engines: ['claude', 'codex', 'opencode'],
    detected: [
      { id: 'claude', bin: 'claude', path: '/bin/claude' },
      { id: 'codex', bin: 'codex', path: '/bin/codex' },
      { id: 'opencode', bin: 'opencode', path: null },
    ],
  })
  assert.equal(ok, true)
  const update = calls.find((c) => /SET available_engines/.test(c.sql))
  assert.equal(update?.params[1], JSON.stringify(['codex', 'claude', 'opencode']))
})

test('setComputerDefaultEngine reorders engines and only moves inheriting agents', async () => {
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT available_engines/.test(sql)) {
      return { rows: [{ available_engines: ['claude', 'codex'], detected_engines: [] }] }
    }
    if (/UPDATE computers/.test(sql)) return { rowCount: 1 }
    if (/UPDATE participants SET engine/.test(sql)) return { rowCount: 3 }
    return { rows: [] }
  })
  const out = await setDefault()
  assert.deepEqual(out, { engine: 'codex', updated: 3 })
  const moved = calls.find((c) => /UPDATE participants SET engine/.test(c.sql))
  assert.equal(moved?.params[0], 'codex')
  assert.match(moved?.sql ?? '', /engine_inherit = TRUE/)

  async function setDefault() {
    return registry.setComputerDefaultEngine({ computerId: 'comp-1', companyId: 'co-1', engine: 'codex' })
  }
})

test('heartbeatComputer returns a pending engine detection request', async () => {
  installPoolMock(({ sql }) => {
    if (/AND status = 'online'/.test(sql)) {
      return { rows: [{ detect_requested_at: '2026-08-31T00:00:00.000Z' }], rowCount: 1 }
    }
    return { rows: [] }
  })
  assert.equal(await registry.heartbeatComputer('comp-1', '0.5.0', true), true)
})

test('heartbeatComputer stays quiet without an engine detection request', async () => {
  installPoolMock(({ sql }) => {
    if (/AND status = 'online'/.test(sql)) {
      return { rows: [{ detect_requested_at: null }], rowCount: 1 }
    }
    return { rows: [] }
  })
  assert.equal(await registry.heartbeatComputer('comp-1', '0.5.0', true), false)
})

test('assignAgentToComputer pins when an engine is named and inherits when it is not', async () => {
  installPoolMock(({ sql }) => {
    if (/SELECT kind, available_engines/.test(sql)) {
      return { rows: [{ kind: 'local', available_engines: ['claude', 'codex'] }] }
    }
    if (/UPDATE participants SET computer_id/.test(sql)) return { rowCount: 1 }
    return { rows: [] }
  })
  const pinned = await registry.assignAgentToComputer({
    agentId: 'bram', companyId: 'co-1', computerId: 'comp-1', engine: 'codex', inherit: false,
  })
  assert.deepEqual(pinned, { kind: 'local', engine: 'codex', inherit: false })

  const inherited = await registry.assignAgentToComputer({
    agentId: 'bram', companyId: 'co-1', computerId: 'comp-1', inherit: true,
  })
  assert.deepEqual(inherited, { kind: 'local', engine: 'claude', inherit: true })
})

test('assignAgentToComputer rejects an unavailable explicit pin before mutating the agent', async () => {
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT kind, available_engines/.test(sql)) {
      return { rows: [{ kind: 'local', available_engines: ['claude'] }] }
    }
    if (/UPDATE participants SET computer_id/.test(sql)) return { rowCount: 1 }
    return { rows: [] }
  })
  const out = await registry.assignAgentToComputer({
    agentId: 'bram', companyId: 'co-1', computerId: 'comp-1', engine: 'codex', inherit: false,
    model: null, fastModel: null,
  })
  assert.equal(out, null)
  assert.equal(calls.some((call) => /UPDATE participants SET computer_id/.test(call.sql)), false)
})

test('assignAgentToComputer persists model pins in the host assignment update', async () => {
  const calls = installPoolMock(({ sql }) => {
    if (/SELECT kind, available_engines/.test(sql)) {
      return { rows: [{ kind: 'local', available_engines: ['claude', 'codex'] }] }
    }
    if (/UPDATE participants SET computer_id/.test(sql)) return { rowCount: 1 }
    return { rows: [] }
  })
  const out = await registry.assignAgentToComputer({
    agentId: 'bram', companyId: 'co-1', computerId: 'comp-1', engine: 'codex', inherit: false,
    model: 'gpt-5.6-sol', fastModel: null,
  })
  assert.deepEqual(out, { kind: 'local', engine: 'codex', inherit: false })
  const update = calls.find((call) => /UPDATE participants SET computer_id/.test(call.sql))
  assert.match(update?.sql ?? '', /model = \$4/)
  assert.match(update?.sql ?? '', /fast_model = \$5/)
  assert.deepEqual(update?.params, [
    'comp-1', 'codex', false, 'gpt-5.6-sol', null, 'bram', 'co-1',
  ])
})
