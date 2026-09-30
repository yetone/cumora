import assert from 'node:assert/strict'
import { after, test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'
const { pool } = await import('../db/pool.js')
const { assertMemoryProjectExists } = await import('../agents/memory-write.js')
after(() => pool.end())

test('global memory and skill writes perform no additional database query', async (t) => {
  const query = t.mock.method(pool, 'query', () => { throw new Error('unexpected query') })
  await assertMemoryProjectExists('co-one', 'memory/note/global.md', null)
  await assertMemoryProjectExists('co-one', 'skills/task.md', { source: { projectId: 'p-other' } })
  assert.equal(query.mock.callCount(), 0)
})

test('scoped memory validates tenant and project once, including pinned memories', async (t) => {
  const query = t.mock.method(pool, 'query', async (_sql: string, params: unknown[]) => {
    assert.deepEqual(params, ['co-one', ['p-one']])
    return { rows: [{ id: 'p-one' }] }
  })
  await assertMemoryProjectExists('co-one', 'memory/projects/p-one/MEMORY.md', { pinned: true, source: { projectId: 'p-one' } })
  assert.equal(query.mock.callCount(), 1)
})

test('deleted projects are rejected by either metadata or path provenance', async (t) => {
  t.mock.method(pool, 'query', async () => ({ rows: [] }))
  await assert.rejects(assertMemoryProjectExists('co-one', 'memory/projects/p-one/note.md', null), /deleted or unknown project/)
  await assert.rejects(assertMemoryProjectExists('co-one', 'memory/note/note.md', { pinned: true, source: { projectId: 'p-one' } }), /deleted or unknown project/)
})
