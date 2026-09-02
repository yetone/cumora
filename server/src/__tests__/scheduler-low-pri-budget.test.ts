/**
 * Unit tests for the low-priority wake budget — the post-incident
 * (FUSE-cap, 2026-05-20) backpressure that caps idle/scanner-driven
 * agent spawns at 20/min per cumora-server process.
 *
 * Run: node --import tsx --test server/src/__tests__/scheduler-low-pri-budget.test.ts
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import {
  _consumeLowPriorityWakeBudget,
  _resetLowPriorityWakeBudgetForTests,
  _shouldRetryEnsurePodFailure,
  _shouldRetryWakeFailure,
  _wakeRetryDelayMs,
  shouldDeliverToMutedAgent,
} from '../agents/scheduler.js'

after(async () => {
  // scheduler.ts transitively imports redis.ts which opens connections.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

beforeEach(() => { _resetLowPriorityWakeBudgetForTests() })

test('first 20 calls allowed within a 60s window', () => {
  const t = 1_000_000
  for (let i = 0; i < 20; i++) {
    assert.equal(_consumeLowPriorityWakeBudget(t), true, `call ${i + 1} should be allowed`)
  }
})

test('call 21 within the same window is rejected', () => {
  const t = 1_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t)
  assert.equal(_consumeLowPriorityWakeBudget(t), false)
})

test('budget resets after 60s', () => {
  const t0 = 1_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t0)
  assert.equal(_consumeLowPriorityWakeBudget(t0), false, 'still rejected before window rolls')
  // 60s later, window rolls
  const t1 = t0 + 60_000
  assert.equal(_consumeLowPriorityWakeBudget(t1), true, 'allowed after window roll')
})

test('budget does NOT reset before 60s', () => {
  const t0 = 1_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t0)
  assert.equal(_consumeLowPriorityWakeBudget(t0 + 59_999), false)
})

test('many rejections in a window are absorbed, then the next window is fresh', () => {
  const t0 = 2_000_000
  for (let i = 0; i < 20; i++) _consumeLowPriorityWakeBudget(t0)
  // 500 rejections — what a crashloop-recovery burst would look like
  for (let i = 0; i < 500; i++) {
    assert.equal(_consumeLowPriorityWakeBudget(t0), false)
  }
  // After the window
  const t1 = t0 + 60_000
  assert.equal(_consumeLowPriorityWakeBudget(t1), true)
})

test('wake retry delay backs off and caps at 60s', () => {
  assert.equal(_wakeRetryDelayMs(0), 5_000)
  assert.equal(_wakeRetryDelayMs(1), 10_000)
  assert.equal(_wakeRetryDelayMs(2), 20_000)
  assert.equal(_wakeRetryDelayMs(3), 40_000)
  assert.equal(_wakeRetryDelayMs(4), 60_000)
  assert.equal(_wakeRetryDelayMs(50), 60_000)
})

test('ensurePod retry is only for manual wakes — message.new is durable via DB inbox', () => {
  // message.new no longer gets queued retries: the message itself is
  // in the DB, and the pod's cold-start drain() catches it on attach.
  // Retrying caused duplicate turns (see "Nova says 3 then 1" bug).
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'cluster fuse saturated'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'already running'), false)
  assert.equal(_shouldRetryEnsurePodFailure('message.new', 'no such agent'), false)
  // manual wakes (CLI / admin) still retry — explicit delivery contract.
  assert.equal(_shouldRetryEnsurePodFailure('manual', 'pod apply failed'), true)
  assert.equal(_shouldRetryEnsurePodFailure('manual', 'no such agent'), false)
  // Synthetic wakes are handled by the inline poll loop in wakeOne,
  // not by the queue.
  assert.equal(_shouldRetryEnsurePodFailure('idle', 'cluster fuse saturated'), false)
  assert.equal(_shouldRetryEnsurePodFailure('background_scan', 'cluster fuse saturated'), false)
})

test('host-resolution failure retries before any execution location was selected', () => {
  assert.equal(
    _shouldRetryWakeFailure('message.new', 'host lookup failed', 'host_resolution'),
    true,
  )
  assert.equal(
    _shouldRetryWakeFailure('idle', 'host lookup failed', 'host_resolution'),
    true,
  )
  // The existing duplicate-turn protection remains intact for ordinary pod
  // failures after placement was successfully resolved.
  assert.equal(
    _shouldRetryWakeFailure('message.new', 'pod apply failed', 'ensure_pod'),
    false,
  )
})

test('muted agent delivery only allows direct, exact mention, or quote reply', () => {
  const base = { agentId: 'nova-12', conversationKind: 'group', body: 'ordinary room chatter', quotedAuthorId: null }
  assert.equal(shouldDeliverToMutedAgent(base), false)
  assert.equal(shouldDeliverToMutedAgent({ ...base, conversationKind: 'direct' }), true)
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'please check this @nova-12' }), true)
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'ping @NOVA-12, please' }), true)
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'this is for @nova-123' }), false, 'prefix mentions must not leak through')
  assert.equal(shouldDeliverToMutedAgent({ ...base, body: 'email@nova-12 is not a mention' }), false)
  assert.equal(shouldDeliverToMutedAgent({ ...base, quotedAuthorId: 'nova-12' }), true)
})
