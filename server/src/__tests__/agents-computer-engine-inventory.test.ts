/**
 * Runtime engine selection must use the daemon's current PATH inventory, not
 * the snapshot captured when the process started.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EngineInventoryStabilizer,
  replaceEngineInventory,
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
