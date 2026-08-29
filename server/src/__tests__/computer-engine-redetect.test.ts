/**
 * Re-detecting a paired computer's engines on the heartbeat.
 *
 * `available_engines[0]` is the computer's DEFAULT engine — pairComputer says so
 * outright ("first = default") and it decides the engine for the starter team
 * and for any agent assigned without an explicit override. So refreshing the
 * list from a PATH scan must never reorder it silently, and must never let a
 * daemon with a broken PATH wipe it.
 *
 * Run: node --import tsx --test server/src/__tests__/computer-engine-redetect.test.ts
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

// Same shape as agent-computer-pairing-token.test.ts: pin the HTTP runtime
// client and import registry dynamically, so the test doesn't drag the in-proc
// client's dependency graph into a unit run.
process.env.CUMORA_RUNTIME_CLIENT = 'http'

const { heartbeatComputer, mergeDetectedEngines } = await import('../agents/computer/registry.js')
const { pool } = await import('../db/pool.js')

const originalQuery = pool.query.bind(pool)
const originalWarn = console.warn

afterEach(() => {
  ;(pool as unknown as { query: typeof originalQuery }).query = originalQuery
  console.warn = originalWarn
})

test('a newly installed engine is appended without re-pairing', () => {
  // The reported case: the user installs another CLI after pairing.
  assert.deepEqual(
    mergeDetectedEngines(['claude', 'codex'], ['claude', 'codex', 'cursor']),
    ['claude', 'codex', 'cursor'],
  )
})

test('the current default stays first even when detection orders it later', () => {
  // detectEngines returns ENGINE_IDS order, which is NOT the user's choice.
  // Overwriting with it would silently switch this computer's default engine.
  assert.deepEqual(
    mergeDetectedEngines(['codex', 'claude'], ['claude', 'codex', 'grok']),
    ['codex', 'claude', 'grok'],
  )
})

test('an uninstalled engine drops out, and the default moves on', () => {
  // The default itself is gone — there is nothing to pin, so detection order wins.
  assert.deepEqual(mergeDetectedEngines(['grok', 'claude'], ['claude', 'codex']), ['claude', 'codex'])
})

test('an unchanged list writes nothing', () => {
  // The steady state: every heartbeat reports the same engines. Returning null
  // keeps the 30s tick from issuing a pointless UPDATE forever.
  assert.equal(mergeDetectedEngines(['claude', 'codex'], ['claude', 'codex']), null)
})

test('a successful empty detection clears the last uninstalled engine', () => {
  // The daemon retains its last-good list when `which` / `where` fails, so an
  // explicitly reported [] is a trustworthy scan where no engine remains.
  assert.deepEqual(mergeDetectedEngines(['claude'], []), [])
})

test('an unchanged empty list writes nothing', () => {
  assert.equal(mergeDetectedEngines([], []), null)
})

test('a detection of only unknown ids is treated as empty', () => {
  // A newer daemon reporting an engine this server has no adapter for must not
  // clear the list either.
  assert.equal(mergeDetectedEngines(['claude'], ['gemini', 'hermes']), null)
})

test('unknown ids are filtered out but known ones still apply', () => {
  assert.deepEqual(
    mergeDetectedEngines(['claude'], ['claude', 'gemini', 'opencode']),
    ['claude', 'opencode'],
  )
})

test('duplicates in a detection are collapsed', () => {
  assert.deepEqual(mergeDetectedEngines(['claude'], ['claude', 'claude', 'codex']), ['claude', 'codex'])
})

test('a computer with no stored engines adopts the detection order', () => {
  assert.deepEqual(mergeDetectedEngines([], ['claude', 'codex']), ['claude', 'codex'])
})

test('heartbeat persists a successful empty detection', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  ;(pool as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
  }).query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    if (/SELECT available_engines/.test(sql)) {
      return { rows: [{ available_engines: ['claude'], kind: 'local' }], rowCount: 1 }
    }
    if (/UPDATE computers SET available_engines/.test(sql)) return { rows: [], rowCount: 1 }
    if (/UPDATE computers SET last_seen_at/.test(sql)) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected query: ${sql}`)
  }

  await heartbeatComputer('comp-1', undefined, undefined, [])

  const inventoryUpdate = calls.find((c) => /UPDATE computers SET available_engines/.test(c.sql))
  assert.ok(inventoryUpdate)
  assert.equal(inventoryUpdate.params[1], '[]')
})

test('heartbeat persists liveness before a failing inventory refresh', async () => {
  const calls: string[] = []
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  ;(pool as unknown as {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
  }).query = async (sql: string) => {
    calls.push(sql)
    if (/UPDATE computers SET last_seen_at/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 }
    if (/SELECT available_engines/.test(sql)) throw new Error('transient inventory read failure')
    throw new Error(`unexpected query: ${sql}`)
  }

  await heartbeatComputer('comp-1', '0.8.0', true, ['claude'])

  assert.match(calls[0] ?? '', /UPDATE computers SET last_seen_at/)
  assert.match(calls[1] ?? '', /SELECT available_engines/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /transient inventory read failure/)
})
