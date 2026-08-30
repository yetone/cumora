/**
 * The one-of-us election (#70): the router's unaddressed decision, the
 * deterministic lineup, and the lease-sweep state machine.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-routing-election.test.ts
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'

// Same pattern as computer-engine-redetect.test.ts: pin the HTTP runtime
// client and mock the pool, so the routing-claims tests run without Redis or
// Postgres.
process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { parseRoute, buildUnaddressedRouteRequest, parseUnaddressedRoute } = await import('../agents/routing.js')
const { electLineup, orderCandidates } = await import('../agents/routing-election.js')
const { claimPrimary, sweepRoutingClaimsOnce, ELECTION_LEASE_MS } = await import('../agents/routing-claims.js')
const { pool } = await import('../db/pool.js')

type ElectionCandidate = import('../agents/routing-election.js').ElectionCandidate

const realQuery = pool.query.bind(pool)

afterEach(() => {
  ;(pool as unknown as { query: typeof realQuery }).query = realQuery
})

// ── router plumbing ────────────────────────────────────────────────────────

test('parseRoute recognizes one-of-us instead of lossily mapping it to each', () => {
  assert.equal(parseRoute('{"responseMode": "one-of-us"}'), 'one-of-us')
  assert.equal(parseRoute('garbage {"responseMode":"ME"} trailing'), 'me')
  assert.equal(parseRoute('{"responseMode": "each"}'), 'each')
  assert.equal(parseRoute('no json at all'), 'each')
  assert.equal(parseRoute('{"responseMode": "spray"}'), 'each')
})

const ROOM = [
  { id: 'atlas', role: 'engineer', status: 'avail', statusUpdatedAt: new Date() },
  { id: 'iris', role: 'designer', status: 'avail', statusUpdatedAt: new Date() },
  { id: 'nova', role: null, status: 'avail', statusUpdatedAt: new Date() },
]

test('the unaddressed router is only asked when there is a room to elect from', () => {
  const body = 'we need a launch email drafted today'
  // A broadcast must never narrow — even when it names nobody with an exact @id.
  assert.equal(buildUnaddressedRouteRequest({ body: 'what does everyone think @all', conversationKind: 'group', candidates: ROOM }).mode, 'each')
  // A DM has one recipient; the human-DM triage note already covers it.
  assert.equal(buildUnaddressedRouteRequest({ body, conversationKind: 'direct', candidates: ROOM }).mode, 'each')
  // A room of one has nothing to elect among.
  assert.equal(buildUnaddressedRouteRequest({ body, conversationKind: 'group', candidates: [ROOM[0]] }).mode, 'each')
  const req = buildUnaddressedRouteRequest({ body, conversationKind: 'group', candidates: ROOM })
  assert.ok(!req.mode, 'a real room asks the router')
  assert.match(req.instructions ?? '', /one-of-us/)
  assert.match(req.input ?? '', /iris \(designer\)/, 'roles ride along for the fit signal')
  assert.match(req.input ?? '', /nova/, 'roleless candidates still appear')
})

test('parseUnaddressedRoute narrows only on an explicit, well-formed one-of-us', () => {
  assert.deepEqual(parseUnaddressedRoute('{"responseMode":"one-of-us","primary":"iris"}'), { mode: 'one-of-us', primary: 'iris' })
  assert.deepEqual(parseUnaddressedRoute('{"responseMode":"one-of-us"}'), { mode: 'one-of-us', primary: null })
  assert.deepEqual(parseUnaddressedRoute('{"responseMode":"each","primary":"iris"}'), { mode: 'each', primary: null })
  // Everything else reads as `each` — narrowing is the silent mistake.
  assert.deepEqual(parseUnaddressedRoute(''), { mode: 'each', primary: null })
  assert.deepEqual(parseUnaddressedRoute('{"responseMode":"each"}'), { mode: 'each', primary: null })
})

// ── deterministic election ─────────────────────────────────────────────────

const NOW = 1_000_000
const LEASE = 60_000

function cand(id: string, status: string | null, ageMs: number, role: string | null = null): ElectionCandidate {
  return { id, role, status, statusUpdatedAt: new Date(NOW - ageMs) }
}

test('ordering puts available agents first and never trusts membership order', () => {
  const candidates = [
    cand('zoe', 'thinking', 1_000),       // busy, fresh
    cand('atlas', 'avail', 1_000),
    cand('iris', null, 1_000),
    cand('milu', 'working', 5 * 60_000),  // stale busy — the lease expired it
  ]
  assert.deepEqual(
    orderCandidates(candidates, { now: NOW, leaseMs: LEASE }),
    ['atlas', 'iris', 'milu', 'zoe'],
  )
})

test('the lineup honors an available proposal, then available, then anyone', () => {
  const candidates = [
    cand('atlas', 'thinking', 1_000),
    cand('iris', 'avail', 1_000),
    cand('nova', 'avail', 1_000),
  ]
  // Role fit wins when the proposed agent can actually take the turn.
  const proposed = electLineup('nova', candidates, { now: NOW, leaseMs: LEASE })
  assert.equal(proposed?.primary, 'nova')
  assert.equal(proposed?.lineup[0], 'nova')
  // A proposal for a mid-turn agent is ignored in favour of an available one.
  assert.equal(electLineup('atlas', candidates, { now: NOW, leaseMs: LEASE })?.primary, 'iris')
  // No proposal → the head of the deterministic order.
  assert.equal(electLineup(null, candidates, { now: NOW, leaseMs: LEASE })?.primary, 'iris')
  // A proposal for an agent that is not in the room changes nothing.
  assert.equal(electLineup('ghost', candidates, { now: NOW, leaseMs: LEASE })?.primary, 'iris')
})

test('with the whole room mid-turn, the election still picks someone', () => {
  const candidates = [cand('atlas', 'working', 1_000), cand('iris', 'thinking', 1_000)]
  // A proposal that is a real candidate is kept — waking a busy agent queues
  // the message behind its turn, which still beats no one being woken.
  assert.equal(electLineup('iris', candidates, { now: NOW, leaseMs: LEASE })?.primary, 'iris')
  assert.equal(electLineup(null, candidates, { now: NOW, leaseMs: LEASE })?.primary, 'atlas')
  assert.equal(electLineup(null, [], { now: NOW, leaseMs: LEASE }), null)
})

// ── the lease row + sweep ──────────────────────────────────────────────────

type QueryHandler = (sql: string, params?: unknown[]) => { rows: unknown[] }

function mockPool(handler: QueryHandler): void {
  ;(pool as unknown as { query: QueryHandler }).query = (sql: string, params?: unknown[]) => handler(sql, params)
}

const INSERT = 'INSERT INTO agent_routing_claims'
const TAKE = 'UPDATE agent_routing_claims\n        SET lease_expires_at'
const SERVE_OR_EXHAUST = 'UPDATE agent_routing_claims SET status'
const ADVANCE = 'UPDATE agent_routing_claims\n          SET cursor'
const REAP = 'DELETE FROM agent_routing_claims'
const GET = 'SELECT message_id'

test('claimPrimary returns the fresh row to the winner and the existing row to a re-delivery', async () => {
  mockPool((sql) => {
    if (sql.startsWith(INSERT)) {
      return { rows: [{ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', candidates: ['iris', 'atlas'], cursor: 0, status: 'pending' }] }
    }
    throw new Error('unexpected: ' + sql.slice(0, 60))
  })
  const won = await claimPrimary({ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', orderedCandidates: ['iris', 'atlas'] })
  assert.equal(won?.candidates[0], 'iris')
  assert.equal(won?.status, 'pending')

  // The message re-delivered after the wake-claim TTL: INSERT conflicts, the
  // existing row comes back so the caller honors the recorded primary.
  mockPool((sql) => {
    if (sql.startsWith(INSERT)) return { rows: [] }
    if (sql.startsWith(GET)) {
      return { rows: [{ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', candidates: ['atlas', 'iris'], cursor: 1, status: 'pending' }] }
    }
    throw new Error('unexpected: ' + sql.slice(0, 60))
  })
  const existing = await claimPrimary({ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', orderedCandidates: ['iris', 'atlas'] })
  assert.deepEqual(existing?.candidates, ['atlas', 'iris'])
  assert.equal(existing?.cursor, 1)
})

test('the sweep serves a claim whose primary started any turn since the claim', async () => {
  const updates: string[] = []
  mockPool((sql) => {
    if (sql.startsWith(TAKE)) return { rows: [{ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', candidates: ['iris', 'atlas'], cursor: 0, status: 'pending', createdAt: new Date(NOW - 120_000) }] }
    if (sql.startsWith('SELECT id FROM agent_runs')) return { rows: [{ id: 'r1' }] }
    if (sql.startsWith(SERVE_OR_EXHAUST)) {
      updates.push(sql)
      return { rows: [] }
    }
    if (sql.startsWith(REAP)) return { rows: [] }
    throw new Error('unexpected: ' + sql.slice(0, 60))
  })
  const wakes = await sweepRoutingClaimsOnce()
  assert.deepEqual(wakes, [])
  assert.equal(updates.length, 1)
  assert.match(updates[0], /status = 'served'/)
})

test('the sweep advances to the next candidate when the primary went quiet', async () => {
  let advanced = false
  mockPool((sql) => {
    if (sql.startsWith(TAKE)) return { rows: [{ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', candidates: ['iris', 'atlas'], cursor: 0, status: 'pending', createdAt: new Date(NOW - 120_000) }] }
    if (sql.startsWith('SELECT id FROM agent_runs')) return { rows: [] }
    if (sql.startsWith(ADVANCE)) {
      advanced = true
      return { rows: [] }
    }
    if (sql.startsWith(REAP)) return { rows: [] }
    throw new Error('unexpected: ' + sql.slice(0, 60))
  })
  const wakes = await sweepRoutingClaimsOnce()
  assert.equal(advanced, true)
  assert.deepEqual(wakes, [{ agentId: 'atlas', conversationId: 'conv1' }])
})

test('an exhausted lineup is marked, not woken', async () => {
  const statuses: string[] = []
  mockPool((sql) => {
    if (sql.startsWith(TAKE)) return { rows: [{ messageId: 'm1', companyId: 'c1', conversationId: 'conv1', candidates: ['iris'], cursor: 0, status: 'pending', createdAt: new Date(NOW - 120_000) }] }
    if (sql.startsWith('SELECT id FROM agent_runs')) return { rows: [] }
    if (sql.startsWith(SERVE_OR_EXHAUST)) {
      statuses.push(/'exhausted'/.test(sql) ? 'exhausted' : 'other')
      return { rows: [] }
    }
    if (sql.startsWith(REAP)) return { rows: [] }
    throw new Error('unexpected: ' + sql.slice(0, 60))
  })
  const wakes = await sweepRoutingClaimsOnce()
  assert.deepEqual(wakes, [])
  assert.deepEqual(statuses, ['exhausted'])
})

test('the sweep leaves healthy claims alone and reaps terminal rows', async () => {
  const calls: string[] = []
  mockPool((sql) => {
    calls.push(sql)
    if (sql.startsWith(TAKE)) return { rows: [] }
    if (sql.startsWith(REAP)) return { rows: [] }
    throw new Error('unexpected: ' + sql.slice(0, 60))
  })
  const wakes = await sweepRoutingClaimsOnce()
  assert.deepEqual(wakes, [])
  assert.equal(calls.filter((c) => c.startsWith(REAP)).length, 1, 'terminal rows are reaped so the table stays operator-sized')
})

test('the election lease is generous enough for a cold pod or a reconnecting daemon', () => {
  assert.equal(ELECTION_LEASE_MS, 90_000)
})
