import { after, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.OPENAI_API_KEY ??= 'test-key'

const { pool } = await import('../db/pool.js')
const {
  __setEmbedTextOverrideForTesting,
  backfillMemoryEmbeddings,
} = await import('../agents/embeddings.js')

type PoolQueryFn = typeof pool.query
const savedQuery = pool.query

afterEach(() => {
  __setEmbedTextOverrideForTesting(null)
  ;(pool as unknown as { query: PoolQueryFn }).query = savedQuery
})

after(async () => {
  await pool.end()
})

test('backfillMemoryEmbeddings advances past a full batch of failed embeddings', async () => {
  const attempts = new Map<string, number>()
  let pageQueries = 0

  __setEmbedTextOverrideForTesting((body) => {
    attempts.set(body, (attempts.get(body) ?? 0) + 1)
    return null
  })

  ;(pool as unknown as { query: PoolQueryFn }).query = (async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM pg_extension')) return { rows: [{ exists: true }] }
    if (!sql.includes('FROM agent_workspace')) throw new Error(`unexpected query: ${sql}`)

    pageQueries++
    if (pageQueries === 1) {
      assert.deepEqual(params, [2, null, null])
      return {
        rows: [
          { agent_id: 'agent-a', path: 'memory/a', body: 'first' },
          { agent_id: 'agent-b', path: 'memory/b', body: 'second' },
        ],
      }
    }

    assert.deepEqual(params, [2, 'agent-b', 'memory/b'])
    return { rows: [] }
  }) as unknown as PoolQueryFn

  await backfillMemoryEmbeddings({ batchSize: 2, delayMs: 0 })

  assert.equal(pageQueries, 2)
  assert.deepEqual([...attempts], [['first', 1], ['second', 1]])
})
