/**
 * Immediate Computer control-stream protocol and refresh coalescing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-control.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseComputerControlEvent } from '../agents/computer/control-event.js'
import { createEngineRescanQueue } from '../agents/computer/daemon.js'

test('engine detection control events validate the complete wire payload', () => {
  const raw = JSON.stringify({ kind: 'engine.detect', id: 'engine.detect-123', at: 1_725_000_000_000 })
  assert.deepEqual(parseComputerControlEvent(raw), {
    kind: 'engine.detect',
    id: 'engine.detect-123',
    at: 1_725_000_000_000,
  })
})

test('malformed and unknown control events are ignored', () => {
  assert.equal(parseComputerControlEvent('not-json'), null)
  assert.equal(parseComputerControlEvent(JSON.stringify({ kind: 'engine.detect', id: '', at: Date.now() })), null)
  assert.equal(parseComputerControlEvent(JSON.stringify({ kind: 'engine.detect', id: 'x' })), null)
  assert.equal(parseComputerControlEvent(JSON.stringify({ kind: 'daemon.stop', id: 'x', at: Date.now() })), null)
})

test('an immediate forced refresh arriving during a scan gets a forced follow-up', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const calls: boolean[] = []
  const queue = createEngineRescanQueue(async (force) => {
    calls.push(force)
    if (calls.length === 1) await firstGate
  })

  const ordinary = queue()
  const immediate = queue(true)
  assert.equal(immediate, ordinary, 'concurrent callers must share one queue')
  assert.deepEqual(calls, [false])

  releaseFirst()
  await immediate
  assert.deepEqual(calls, [false, true])
})

test('a burst of immediate refreshes coalesces to one follow-up scan', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const calls: boolean[] = []
  const queue = createEngineRescanQueue(async (force) => {
    calls.push(force)
    if (calls.length === 1) await firstGate
  })

  const running = queue()
  queue(true)
  queue(true)
  queue(true)
  releaseFirst()
  await running

  assert.deepEqual(calls, [false, true])
})

test('the refresh queue is reusable after a failed scan', async () => {
  let attempts = 0
  const queue = createEngineRescanQueue(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('transient detection failure')
  })

  await assert.rejects(queue(), /transient detection failure/)
  await queue(true)
  assert.equal(attempts, 2)
})
