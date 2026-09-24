import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectMemorySync } from '../agents/computer/project-memory-sync.js'

test('reconnect drains bounded batches and acknowledges only cleaned projects', async () => {
  const pending = Array.from({ length: 51 }, (_, i) => ({ projectId: `p-${i}` }))
  const cleaned = new Set<string>()
  let reads = 0
  const sync = createProjectMemorySync({
    fetchPending: async () => { reads++; return pending.slice(0, 50) },
    cleanup: async (id) => { cleaned.add(id) },
    acknowledge: async (id) => {
      assert.ok(cleaned.has(id))
      pending.splice(pending.findIndex((p) => p.projectId === id), 1)
    },
    onError: (error) => { throw error },
  })
  await sync.request()
  assert.equal(pending.length, 0)
  assert.equal(cleaned.size, 51)
  assert.equal(reads, 2)
  sync.stop()
  await sync.request()
  assert.equal(reads, 2, 'shutdown must not start new fetches')
})

test('failed cleanup stays unacknowledged until the server resends its notification', async () => {
  let attempts = 0
  let errors = 0
  let acknowledged = 0
  const sync = createProjectMemorySync({
    fetchPending: async () => [{ projectId: 'p-retry' }],
    cleanup: async () => { if (++attempts === 1) throw new Error('disk busy') },
    acknowledge: async () => { acknowledged++ },
    onError: () => { errors++ },
  })
  await sync.request()
  assert.equal(attempts, 1)
  assert.equal(acknowledged, 0)
  assert.equal(errors, 1)
  await sync.request()
  assert.equal(attempts, 2)
  assert.equal(acknowledged, 1)
  sync.stop()
})

test('an event during an in-flight fetch is not lost', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let reads = 0
  const cleaned: string[] = []
  const sync = createProjectMemorySync({
    fetchPending: async () => {
      if (++reads === 1) { await gate; return [] }
      return [{ projectId: 'p-new' }]
    },
    cleanup: async (id) => { cleaned.push(id) },
    acknowledge: async () => {}, onError: (error) => { throw error },
  })
  const first = sync.request()
  assert.equal(sync.request(), first)
  release()
  await first
  assert.deepEqual(cleaned, ['p-new'])
  assert.equal(reads, 2)
  sync.stop()
})

test('failed acknowledgement replays cleanup safely on reconnect', async () => {
  let attempts = 0
  let cleaned = 0
  const sync = createProjectMemorySync({
    fetchPending: async () => [{ projectId: 'p-ack' }],
    cleanup: async () => { cleaned++ },
    acknowledge: async () => { if (++attempts === 1) throw new Error('connection closed') },
    onError: () => {},
  })
  await sync.request()
  await sync.request()
  assert.equal(attempts, 2)
  assert.equal(cleaned, 2)
  sync.stop()
})
