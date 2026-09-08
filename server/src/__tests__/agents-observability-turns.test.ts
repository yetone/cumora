/**
 * The fan-out-width half of the wake-economics ledger: turns per human
 * message. The SQL does the grouping; these tests pin the JS contract —
 * bucket mapping, the numeric conversion of pg's decimal strings, the fixed
 * histogram order — and that the metric rides along on the wake-economics
 * response where the panel reads it.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-observability-turns.test.ts
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

// Same pattern as computer-engine-redetect.test.ts: pin the HTTP runtime
// client and mock the pool, so no Redis or Postgres is needed.
process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { getWakeEconomics, getTurnsPerMessage } = await import('../agents/observability.js')
const { pool } = await import('../db/pool.js')

const realQuery = pool.query.bind(pool)

afterEach(() => {
  ;(pool as unknown as { query: typeof realQuery }).query = realQuery
})

type QueryHandler = (sql: string, params?: unknown[]) => { rows: unknown[] }

function mockPool(handler: QueryHandler): void {
  ;(pool as unknown as { query: QueryHandler }).query = (sql: string, params?: unknown[]) => handler(sql, params)
}

const WAKE_SQL_PREFIX = 'WITH run_convo AS'
const TURNS_SQL_PREFIX = 'WITH scope AS'

function mockWakeAndTurns(turnRows: unknown[]): void {
  mockPool((sql) => {
    if (sql.startsWith(WAKE_SQL_PREFIX)) {
      return {
        rows: [{
          conversation_kind: 'group',
          runs: 10,
          silent_runs: 3,
          model: 'gpt-test',
          input_tokens: '1000',
          cached_tokens: '0',
          cache_creation_tokens: '0',
          output_tokens: '200',
        }],
      }
    }
    if (sql.startsWith(TURNS_SQL_PREFIX)) return { rows: turnRows }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
}

test('turns-per-message buckets carry the histogram in fixed order', async () => {
  mockPool((sql) => {
    if (sql.startsWith(TURNS_SQL_PREFIX)) {
      return {
        rows: [{
          conversation_kind: 'group',
          messages: 100,
          turns: 240,
          avg_turns: '2.4000000000000000',
          median_turns: '2',
          w0: 15,
          w1: 30,
          w2: 25,
          w3_5: 20,
          w6: 10,
        }],
      }
    }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
  const [b] = await getTurnsPerMessage({ companyId: 'c1', sinceHours: 24 })
  assert.equal(b.conversationKind, 'group')
  assert.equal(b.messages, 100)
  assert.equal(b.turns, 240)
  assert.equal(b.avgTurns, 2.4)
  assert.equal(b.medianTurns, 2)
  assert.deepEqual(
    b.hist.map((h) => h.turns),
    ['0', '1', '2', '3–5', '6+'],
    'the bar renderer relies on this order: darkest segment is 6+',
  )
  assert.deepEqual(b.hist.map((h) => h.messages), [15, 30, 25, 20, 10])
  assert.equal(b.hist.reduce((s, h) => s + h.messages, 0), b.messages, 'histogram sums to the denominator')
})

test('a window with no human messages yields no buckets, not zeroes', async () => {
  mockPool((sql) => {
    if (sql.startsWith(TURNS_SQL_PREFIX)) return { rows: [] }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
  assert.deepEqual(await getTurnsPerMessage({ companyId: 'c1' }), [])
})

test('the metric rides along on the wake-economics response the panel reads', async () => {
  mockWakeAndTurns([{
    conversation_kind: 'group',
    messages: 4,
    turns: 12,
    avg_turns: '3.0',
    median_turns: '3',
    w0: 0,
    w1: 1,
    w2: 1,
    w3_5: 2,
    w6: 0,
  }])
  const res = await getWakeEconomics({ companyId: 'c1', sinceHours: 24 })
  assert.equal(res.costEstimated, true, 'no prices configured here — the dollars are modelled and must say so')
  assert.equal(res.buckets[0].runs, 10)
  assert.deepEqual(res.turnsPerMessage.map((b) => b.conversationKind), ['group'])
  assert.equal(res.turnsPerMessage[0].avgTurns, 3)
})

test('sinceHours is clamped to the same window the rest of the panel uses', async () => {
  let captured: unknown[] = []
  mockPool((sql, params = []) => {
    if (sql.startsWith(TURNS_SQL_PREFIX)) {
      captured = params as unknown[]
      return { rows: [] }
    }
    throw new Error('unexpected query: ' + sql.slice(0, 60))
  })
  await getTurnsPerMessage({ companyId: 'c1', sinceHours: 99999 })
  // 720h ceiling, expressed as milliseconds — same clamp as getWakeEconomics.
  assert.equal(captured[1], 720 * 3_600_000)
})

test('the aggregate counts zero-turn messages — against a real Postgres', async () => {
  // The other cases here mock pool.query and so only cover the JS mapping. This
  // one executes the aggregate shape itself, because the defect it guards was
  // invisible to a mock: `avg(t.turns)` after a LEFT JOIN skips the NULL rows,
  // so every message no inbox reached vanished from the average and the median
  // while the histogram still counted it.
  const { pool: realPool } = await import('../db/pool.js')
  ;(realPool as unknown as { query: typeof realQuery }).query = realQuery

  const { rows } = await realQuery(`
    WITH s(mid) AS (VALUES ('a'),('b'),('c'),('d')),
         t(mid, turns) AS (VALUES ('a', 4), ('b', 2))
    SELECT count(*)::int AS messages,
           COALESCE(sum(t.turns), 0)::int AS turns,
           COALESCE(avg(COALESCE(t.turns, 0)), 0)::float8 AS avg_turns,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(t.turns, 0)), 0)::float8 AS median_turns,
           COALESCE(avg(t.turns), 0)::float8 AS avg_if_nulls_were_skipped
      FROM s LEFT JOIN t ON t.mid = s.mid`)

  const r = rows[0] as {
    messages: number; turns: number; avg_turns: number
    median_turns: number; avg_if_nulls_were_skipped: number
  }
  // Four messages, six turns, two of them never woken.
  assert.equal(r.messages, 4)
  assert.equal(r.turns, 6)
  // The average the panel reports must equal turns / messages.
  assert.equal(r.avg_turns, r.turns / r.messages)
  assert.equal(r.avg_turns, 1.5)
  assert.equal(r.median_turns, 1)
  // And pin the wrong shape so a revert is loud rather than silent.
  assert.equal(r.avg_if_nulls_were_skipped, 3, 'skipping NULLs doubles the reported fan-out')
})
