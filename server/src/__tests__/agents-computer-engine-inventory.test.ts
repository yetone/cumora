/**
 * Runtime engine selection must use the daemon's current PATH inventory, not
 * the snapshot captured when the process started.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EngineInventoryStabilizer,
  replaceEngineInventory,
  reportEngineSnapshot,
  resolveAvailableEngine,
  shouldReportEngineSnapshot,
  type EngineInventory,
} from '../agents/computer/daemon.js'

test('a newly detected requested engine is selected without a daemon restart', () => {
  const inventory: EngineInventory = { current: ['claude'] }

  assert.equal(replaceEngineInventory(inventory, ['claude', 'cursor']), true)
  assert.equal(resolveAvailableEngine('cursor', inventory.current), 'cursor')
})

test('no installed engines leaves the agent without a runnable fallback', () => {
  const inventory: EngineInventory = { current: ['claude'] }

  assert.equal(replaceEngineInventory(inventory, []), true)
  assert.equal(resolveAvailableEngine('claude', inventory.current), null)
})

test('an unchanged scan does not replace the shared inventory', () => {
  const current = ['claude', 'codex'] as const
  const inventory: EngineInventory = { current: [...current] }
  const before = inventory.current

  assert.equal(replaceEngineInventory(inventory, current), false)
  assert.equal(inventory.current, before)
})

test('a requested refresh reports an unchanged engine snapshot', () => {
  const snapshot = JSON.stringify([{ id: 'codex', version: '1.2.3' }])

  assert.equal(shouldReportEngineSnapshot(snapshot, snapshot), false)
  assert.equal(shouldReportEngineSnapshot(snapshot, snapshot, true), true)
})

test('a failed snapshot report leaves the watermark where it was, so the next scan retries', async () => {
  const before = JSON.stringify([{ id: 'codex', version: '1.2.3' }])
  // The operator installed the dependency `claude` was blocked on, so the
  // rescan computes a new fingerprint — and the POST 502s mid-deploy.
  const after = JSON.stringify([{ id: 'claude', version: '2.0.0' }, { id: 'codex', version: '1.2.3' }])
  let posts = 0
  const failing = async (): Promise<never> => {
    posts += 1
    throw new Error('POST /api/computers/me/engines → HTTP 502')
  }

  assert.equal(await reportEngineSnapshot(after, before, false, failing), before)
  assert.equal(posts, 1)

  // Five minutes later the same scan produces the same fingerprint. Committing
  // the watermark before the POST would make this a no-op and freeze the card
  // on "missing dependency" for the daemon's lifetime.
  const settled: string[] = []
  const ok = async (): Promise<void> => { settled.push(after) }
  assert.equal(await reportEngineSnapshot(after, before, false, ok), after)
  assert.deepEqual(settled, [after])
})

test('a delivered snapshot is not reported again, and a forced rescan is', async () => {
  const snapshot = JSON.stringify([{ id: 'codex', version: '1.2.3' }])
  let posts = 0
  const ok = async (): Promise<void> => { posts += 1 }

  assert.equal(await reportEngineSnapshot(snapshot, snapshot, false, ok), snapshot)
  assert.equal(posts, 0, 'an unchanged snapshot must not hit the network')

  assert.equal(await reportEngineSnapshot(snapshot, snapshot, true, ok), snapshot)
  assert.equal(posts, 1, 'Rescan has to report even an unchanged snapshot to clear the request')
})

test('a transient version failure retains a previously runnable engine', () => {
  const stabilizer = new EngineInventoryStabilizer()
  const next = stabilizer.stabilize(['claude', 'codex'], ['claude', 'codex'], {
    runnable: ['codex'],
    blocked: [{ id: 'claude', reason: 'version temporarily unavailable', state: 'temporarily-unverifiable' }],
  })
  assert.deepEqual(next, ['claude', 'codex'])
})

test('confirmed incompatibility removes an engine immediately', () => {
  const stabilizer = new EngineInventoryStabilizer()
  const next = stabilizer.stabilize(['claude', 'codex'], ['claude', 'codex'], {
    runnable: ['codex'],
    blocked: [{ id: 'claude', reason: 'version below secure minimum', state: 'confirmed-incompatible' }],
  })
  assert.deepEqual(next, ['codex'])
})

test('an engine is removed only after three consecutive reliable PATH misses', () => {
  const stabilizer = new EngineInventoryStabilizer(3)
  const evaluated = { runnable: ['codex'] as const, blocked: [] }
  assert.deepEqual(stabilizer.stabilize(['claude', 'codex'], ['codex'], evaluated), ['claude', 'codex'])
  assert.deepEqual(stabilizer.stabilize(['claude', 'codex'], ['codex'], evaluated), ['claude', 'codex'])
  assert.deepEqual(stabilizer.stabilize(['claude', 'codex'], ['codex'], evaluated), ['codex'])
})

test('a successful detection resets the consecutive missing counter', () => {
  const stabilizer = new EngineInventoryStabilizer(3)
  const missing = { runnable: ['codex'] as const, blocked: [] }
  const healthy = { runnable: ['claude', 'codex'] as const, blocked: [] }
  assert.deepEqual(stabilizer.stabilize(['claude', 'codex'], ['codex'], missing), ['claude', 'codex'])
  assert.deepEqual(stabilizer.stabilize(['claude', 'codex'], ['claude', 'codex'], healthy), ['claude', 'codex'])
  assert.deepEqual(stabilizer.stabilize(['claude', 'codex'], ['codex'], missing), ['claude', 'codex'])
})
