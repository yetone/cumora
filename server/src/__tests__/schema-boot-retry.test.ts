/** Read-only schema verification may ride out a brief DB transport failure,
 * but migration/history problems must fail startup immediately. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MigrationHistoryError } from '../db/migrations/manifest.js'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { verifySchemaWithBootRetry } = await import('../db/schema-version.js')
const noSleep = async (_ms: number): Promise<void> => {}

test('returns the compatible version on the first probe', async () => {
  let calls = 0
  const version = await verifySchemaWithBootRetry({
    verifyFn: async () => { calls++; return 1 },
    sleep: noSleep,
  })
  assert.equal(version, 1)
  assert.equal(calls, 1)
})

test('retries transport-shaped failures and recovers', async () => {
  let calls = 0
  const version = await verifySchemaWithBootRetry({
    verifyFn: async () => {
      calls++
      if (calls < 3) throw new Error('Connection terminated due to connection timeout')
      return 1
    },
    sleep: noSleep,
  })
  assert.equal(version, 1)
  assert.equal(calls, 3)
})

test('retries ECONNREFUSED', async () => {
  let calls = 0
  await verifySchemaWithBootRetry({
    verifyFn: async () => {
      calls++
      if (calls < 2) throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      return 1
    },
    sleep: noSleep,
  })
  assert.equal(calls, 2)
})

test('fails fast on schema-history errors', async () => {
  let calls = 0
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => {
        calls++
        throw new MigrationHistoryError('schema_behind', 'run migrations')
      },
      sleep: noSleep,
    }),
    /run migrations/,
  )
  assert.equal(calls, 1)
})

test('does not treat migration lock errors as replica-startup retries', async () => {
  let calls = 0
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => {
        calls++
        const err = new Error('deadlock detected') as Error & { code: string }
        err.code = '40P01'
        throw err
      },
      sleep: noSleep,
    }),
    /deadlock detected/,
  )
  assert.equal(calls, 1)
})

test('throws on the last attempt even if transport-shaped', async () => {
  let calls = 0
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => {
        calls++
        throw new Error('timeout exceeded when trying to connect')
      },
      sleep: noSleep,
      maxAttempts: 3,
    }),
    /timeout exceeded/,
  )
  assert.equal(calls, 3)
})

test('fails fast on non-transport errors', async () => {
  let calls = 0
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => {
        calls++
        throw new Error('permission denied for relation schema_migrations')
      },
      sleep: noSleep,
    }),
    /permission denied/,
  )
  assert.equal(calls, 1)
})

test('uses exponential backoff with a 30 second cap', async () => {
  const delays: number[] = []
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => { throw new Error('Connection terminated unexpectedly') },
      sleep: async (ms) => { delays.push(ms) },
      maxAttempts: 7,
    }),
  )
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
})
