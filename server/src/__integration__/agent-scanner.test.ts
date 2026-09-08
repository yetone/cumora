/**
 * Background scanner integration tests.
 *
 * The scanner must not impersonate a hard-coded agent or run turns inside the
 * server process. It queues a pod wake for agents that explicitly carry the
 * background.scan capability, and that agent's own loop decides what to do.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import {
  __scannerCacheInternals,
  __setBackgroundScannerWakeForTesting,
  _resetBackgroundScannerForTests,
  runBackgroundScans,
} from '../agents/scanner.js'
import type { wakeAgent } from '../agents/scheduler.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
  await _resetBackgroundScannerForTests()
})

after(async () => {
  await _resetBackgroundScannerForTests()
  await teardownAll()
})

async function seedCompanyWithScannerAgent(): Promise<{ companyId: string; agentId: string; humanA: string; humanB: string; conversationId: string }> {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const humanA = `u-${randomUUID().slice(0, 8)}`
  const humanB = `u-${randomUUID().slice(0, 8)}`
  const conversationId = `group-${randomUUID().slice(0, 8)}`

  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [companyId, `Test ${companyId}`, companyId, humanA],
  )
  for (const userId of [humanA, humanB]) {
    await pool.query(
      `INSERT INTO users (id, email, display_name, tier) VALUES ($1, $2, $3, 'free')`,
      [userId, `${userId}@test.local`, userId],
    )
    await pool.query(
      `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'member')`,
      [companyId, userId],
    )
    await pool.query(
      `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'member', $4, '#abcdef', 'avail')`,
      [userId, companyId, userId, userId.slice(2, 3).toUpperCase()],
    )
  }
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, bio, tools, system_prompt)
     VALUES ($1, $2, 'agent', 'Scanner', 'Strategist', 'S', '#abcdef', 'avail',
             'I watch for company-wide collisions.', $3::jsonb,
             'You are Scanner. You only interrupt people when the evidence is concrete.')`,
    [agentId, companyId, JSON.stringify(['bash', 'background.scan'])],
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
     VALUES ($1, 'group', 'Campaign planning', $2::jsonb, 'team', $3)`,
    [conversationId, JSON.stringify([humanA, humanB]), companyId],
  )
  for (let i = 1; i <= 8; i++) {
    await pool.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [`m-${randomUUID()}`, conversationId, i % 2 === 0 ? humanA : humanB, `campaign note ${i}: concrete claim ${i}`, i, companyId],
    )
  }
  return { companyId, agentId, humanA, humanB, conversationId }
}

test('[integration] background scanner wakes a capability-bearing agent through the pod scheduler', async () => {
  const { agentId, conversationId } = await seedCompanyWithScannerAgent()
  const wakes: Array<{
    agentId: string
    reason: Parameters<typeof wakeAgent>[1]
    conversationId: string | null
    options: Parameters<typeof wakeAgent>[4]
  }> = []
  __setBackgroundScannerWakeForTesting(async (wokenAgentId, reason, wokenConversationId, _steer, options) => {
    wakes.push({ agentId: wokenAgentId, reason, conversationId: wokenConversationId ?? null, options })
    return true
  })

  await runBackgroundScans()

  assert.equal(wakes.length, 1, 'one capability-bearing agent should be woken')
  assert.equal(wakes[0].agentId, agentId)
  assert.equal(wakes[0].reason, 'background_scan')
  assert.equal(wakes[0].conversationId, null)
  const brief = wakes[0].options?.backgroundBrief
  assert.ok(brief)
  assert.equal(brief.source, 'background_scanner')
  assert.match(brief.body, /background\.scan capability/)
  assert.match(brief.body, /Campaign planning/)
  assert.match(brief.body, /campaign note 8/)
  assert.match(brief.body, /cumora pull-group/)

  const { rowCount: runs } = await pool.query(
    `SELECT 1 FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs, 0, 'scanner must not run turns inside the server process')

  const { rowCount: pulledGroups } = await pool.query(
    `SELECT 1 FROM conversations WHERE id <> $1 AND tag = 'fresh-pulled'`,
    [conversationId],
  )
  assert.equal(pulledGroups, 0, 'scanner itself must not create groups; only the agent may do that with tools')
})

test('[integration] background scanner does not spend fingerprint or write audit log when wake drops', async () => {
  const { agentId } = await seedCompanyWithScannerAgent()
  let shouldDrop = true
  let attempts = 0
  __setBackgroundScannerWakeForTesting(async () => {
    attempts++
    if (shouldDrop) return false
    return true
  })

  // First pass: dropped by budget
  await runBackgroundScans()
  assert.equal(attempts, 1)

  const { rows: logsFirst } = await pool.query(
    `SELECT 1 FROM agent_log WHERE agent_id = $1 AND body LIKE 'background scan wake queued%'`,
    [agentId],
  )
  assert.equal(logsFirst.length, 0, 'no audit log should be written when wake was dropped')

  // Second pass: budget allows
  shouldDrop = false
  await runBackgroundScans()
  assert.equal(attempts, 2, 'scanner must retry on the next pass because fingerprint was not spent')

  const { rows: logsSecond } = await pool.query(
    `SELECT 1 FROM agent_log WHERE agent_id = $1 AND body LIKE 'background scan wake queued%'`,
    [agentId],
  )
  assert.equal(logsSecond.length, 1, 'audit log should be written once wake succeeds')

  // Third pass: should be deduplicated now
  await runBackgroundScans()
  assert.equal(attempts, 2, 'scanner must not wake again after successful scan')
})

test('[integration] only one replica scans per tick', async () => {
  await seedCompanyWithScannerAgent()
  let attempts = 0
  __setBackgroundScannerWakeForTesting(async () => {
    attempts++
    // Hold the pass open long enough that a concurrent caller is guaranteed to
    // reach the lock while this one still owns it.
    await new Promise((resolve) => setTimeout(resolve, 120))
    return true
  })

  // Two passes in flight at once is exactly what N replicas do every 90s.
  await Promise.all([runBackgroundScans(), runBackgroundScans()])
  assert.equal(attempts, 1,
    'the replica that loses the advisory lock must do nothing, not repeat the pass')

  // And the lock is released, not leaked — a later tick still works. It finds
  // the Redis claim from the first pass and skips, which is the correct
  // outcome and proves the lock did not wedge.
  await runBackgroundScans()
  assert.equal(attempts, 1)
})

test('[integration] a fresh process does not re-wake activity another replica already claimed', async () => {
  const { agentId } = await seedCompanyWithScannerAgent()
  let attempts = 0
  __setBackgroundScannerWakeForTesting(async () => { attempts++; return true })

  await runBackgroundScans()
  assert.equal(attempts, 1)

  // Simulate the lock moving to a replica that has never seen this activity:
  // same database, same Redis, empty in-process cache. Before the claim
  // existed, this re-woke the agent on every restart and on every leader move.
  __scannerCacheInternals.clear()
  await runBackgroundScans()
  assert.equal(attempts, 1, 'the Redis claim must survive an empty local cache')

  const { rows } = await pool.query(
    `SELECT 1 FROM agent_log WHERE agent_id = $1 AND body LIKE 'background scan wake queued%'`,
    [agentId],
  )
  assert.equal(rows.length, 1, 'exactly one audit row, not one per replica')
})
