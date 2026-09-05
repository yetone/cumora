import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'mock-key'

const { pool } = await import('../db/pool.js')
const {
  __setBackgroundScannerWakeForTesting,
  _resetBackgroundScannerForTests,
  runBackgroundScans,
} = await import('../agents/scanner.js')

const originalQuery = pool.query.bind(pool)

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

beforeEach(() => {
  _resetBackgroundScannerForTests()
})

afterEach(() => {
  _resetBackgroundScannerForTests()
  ;(pool as unknown as { query: typeof originalQuery }).query = originalQuery
})

test('scanner does not spend fingerprint or record audit log when wake is dropped by budget', async () => {
  const agent = {
    id: 'agent-1',
    name: 'Scanner Agent',
    role: 'Watcher',
    bio: null,
    company_id: 'co-1',
  }
  const recent = [
    { message_id: 'm1', conversation_id: 'c1', conversation_title: 'General', author_name: 'Alice', body: 'msg 1' },
    { message_id: 'm2', conversation_id: 'c1', conversation_title: 'General', author_name: 'Bob', body: 'msg 2' },
    { message_id: 'm3', conversation_id: 'c1', conversation_title: 'General', author_name: 'Alice', body: 'msg 3' },
    { message_id: 'm4', conversation_id: 'c1', conversation_title: 'General', author_name: 'Bob', body: 'msg 4' },
    { message_id: 'm5', conversation_id: 'c1', conversation_title: 'General', author_name: 'Alice', body: 'msg 5' },
    { message_id: 'm6', conversation_id: 'c1', conversation_title: 'General', author_name: 'Bob', body: 'msg 6' },
    { message_id: 'm7', conversation_id: 'c1', conversation_title: 'General', author_name: 'Alice', body: 'msg 7' },
    { message_id: 'm8', conversation_id: 'c1', conversation_title: 'General', author_name: 'Bob', body: 'msg 8' },
  ]
  const auditLogs: any[] = []

  ;(pool as unknown as { query: (sql: string, params?: unknown[]) => Promise<any> }).query = async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM participants p')) {
      return { rows: [agent] }
    }
    if (sql.includes('SELECT EXISTS')) {
      return { rows: [{ exists: false }] }
    }
    if (sql.includes('FROM messages m')) {
      return { rows: recent }
    }
    if (sql.includes('FROM participants') && sql.includes('departed_at IS NULL')) {
      return { rows: [{ id: agent.id, name: agent.name, role: agent.role, kind: 'agent' }] }
    }
    if (sql.includes('INSERT INTO agent_log')) {
      auditLogs.push(params)
      return { rows: [] }
    }
    return { rows: [] }
  }

  let wakeCallCount = 0
  let shouldDropWake = true

  __setBackgroundScannerWakeForTesting(async () => {
    wakeCallCount++
    if (shouldDropWake) {
      return false // simulate dropped wake (budget exceeded)
    }
    return true // simulate accepted wake
  })

  // First pass: wake is dropped by budget
  await runBackgroundScans()
  assert.equal(wakeCallCount, 1, 'wakeScannerAgent should have been attempted once')
  assert.equal(auditLogs.length, 0, 'audit log must NOT be written when wake was dropped')

  // Second pass with same messages: budget now permits (shouldDropWake = false).
  // Because fingerprint was NOT spent, the agent must be re-evaluated and woken!
  shouldDropWake = false
  await runBackgroundScans()
  assert.equal(wakeCallCount, 2, 'scanner must retry dropped activity on next pass')
  assert.equal(auditLogs.length, 1, 'audit log is recorded on successful wake')

  // Third pass with same messages: already scanned and wake succeeded.
  // Now fingerprint IS spent, so it should be skipped.
  await runBackgroundScans()
  assert.equal(wakeCallCount, 2, 'scanner must not wake again once fingerprint was successfully spent')
})
