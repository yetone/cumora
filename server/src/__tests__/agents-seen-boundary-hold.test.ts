/**
 * Unit tests for the HELD-acknowledgement hold token
 * (server/src/agents/seen-boundary.ts) and the shared work-subject
 * normalizer (server/src/agents/runtime/inproc-client.ts).
 *
 * The hold token is what turns `--send-anyway` / `--force` from a free
 * pass into an acknowledgement: cmdReply / doc create / calendar create
 * record a token when they return a HELD envelope, and the override flag
 * is honored only while a token exists. These tests pin that contract:
 *   - no prior HOLD → consume is unarmed (preemptive flag is inert)
 *   - record → consume arms exactly ONCE (acknowledgement, then gone)
 *   - reply tokens carry the max peer seq the HELD envelope showed
 *     (heldUpToSeq) so cmdReply can void an acknowledgement the room has
 *     moved past (the 2026-07-08 counting-game stale-"6" dup)
 *   - tokens use a SHORT TTL — an acknowledgement is only valid in the
 *     same breath as the HELD, never minutes later
 *   - clear drops a lingering token (successful send / ack / turn end)
 *   - Redis failure → consume fails OPEN to armed (infra hiccups degrade
 *     to the old behavior, never to blocked work)
 *
 * Run: node --import tsx --test server/src/__tests__/agents-seen-boundary-hold.test.ts
 */
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { redis } from '../redis.js'
import {
  recordHold, consumeHold, clearHold,
  recordHeldAttempt, clearHeldAttempts, heldEscalationNote, HELD_ESCALATE_AT,
} from '../agents/seen-boundary.js'
import { normalizeWorkSubject, worklogField, inprocClient } from '../agents/runtime/inproc-client.js'

// ── in-memory redis stand-in ───────────────────────────────────────────
// seen-boundary only uses SET (EX), EVAL (GET+DEL script), and DEL for
// hold tokens. Stub exactly those on the shared instance so the tests
// run without a live Redis and can simulate failures.

type AnyFn = (...args: unknown[]) => unknown
const store = new Map<string, string>()
let failMode = false
let lastSetTtlSec: number | null = null
const SAVED = {
  set: redis.set as AnyFn,
  eval: redis.eval as AnyFn,
  del: redis.del as AnyFn,
  multi: redis.multi as AnyFn,
  incr: redis.incr as AnyFn,
  expire: redis.expire as AnyFn,
}

beforeEach(() => {
  store.clear()
  failMode = false
  lastSetTtlSec = null
  ;(redis as unknown as Record<string, AnyFn>).set = async (...args: unknown[]) => {
    if (failMode) throw new Error('redis down (simulated)')
    store.set(args[0] as string, args[1] as string)
    if (args[2] === 'EX') lastSetTtlSec = Number(args[3])
    return 'OK'
  }
  // CONSUME_SCRIPT semantics: GET+DEL, return the stored VALUE or nil.
  ;(redis as unknown as Record<string, AnyFn>).eval = async (...args: unknown[]) => {
    if (failMode) throw new Error('redis down (simulated)')
    const key = args[2] as string // (script, numKeys, key)
    const v = store.get(key)
    if (v !== undefined) {
      store.delete(key)
      return v
    }
    return null
  }
  ;(redis as unknown as Record<string, AnyFn>).del = async (...args: unknown[]) => {
    if (failMode) throw new Error('redis down (simulated)')
    return store.delete(args[0] as string) ? 1 : 0
  }
  // recordHeldAttempt: INCR (create on first write) + EXPIRE on the first
  // increment only. Both fail when failMode is on.
  ;(redis as unknown as Record<string, AnyFn>).incr = async (...args: unknown[]) => {
    if (failMode) throw new Error('redis down (simulated)')
    const key = args[0] as string
    const next = Number(store.get(key) ?? '0') + 1
    store.set(key, String(next))
    return next
  }
  ;(redis as unknown as Record<string, AnyFn>).expire = async (...args: unknown[]) => {
    if (failMode) throw new Error('redis down (simulated)')
    return store.has(args[0] as string) ? 1 : 0
  }
  // inprocClient.unmarkThinking pipelines ZREMs before clearing holds —
  // stub a chainable no-op pipeline so the test never needs a live Redis.
  ;(redis as unknown as Record<string, AnyFn>).multi = () => {
    const pipe = {
      zrem: () => pipe,
      expire: () => pipe,
      zadd: () => pipe,
      exec: async () => [],
    }
    return pipe
  }
})

after(() => {
  ;(redis as unknown as Record<string, AnyFn>).set = SAVED.set
  ;(redis as unknown as Record<string, AnyFn>).eval = SAVED.eval
  ;(redis as unknown as Record<string, AnyFn>).del = SAVED.del
  ;(redis as unknown as Record<string, AnyFn>).multi = SAVED.multi
  ;(redis as unknown as Record<string, AnyFn>).incr = SAVED.incr
  ;(redis as unknown as Record<string, AnyFn>).expire = SAVED.expire
  try { redis.disconnect() } catch { /* ignore */ }
  void import('../redis.js').then(({ sub }) => { try { sub.disconnect() } catch { /* ignore */ } })
})

const AGENT = 'nova-877e'
const CONVO = 'allhands-d7f8ffcf-2'
const SCOPE = 'reply:allhands-d7f8ffcf-2'

// ── hold token contract ────────────────────────────────────────────────

test('consumeHold without a prior HOLD is unarmed — preemptive override is inert', async () => {
  assert.deepEqual(await consumeHold(AGENT, SCOPE), { armed: false, heldUpToSeq: null })
})

test('recordHold arms exactly one consumeHold', async () => {
  await recordHold(AGENT, SCOPE)
  assert.equal((await consumeHold(AGENT, SCOPE)).armed, true, 'first consume acknowledges the hold')
  assert.equal((await consumeHold(AGENT, SCOPE)).armed, false, 'token is consumed — second override is inert again')
})

test('a reply token carries the max shown peer seq (heldUpToSeq round-trip)', async () => {
  await recordHold(AGENT, SCOPE, 273)
  assert.deepEqual(await consumeHold(AGENT, SCOPE), { armed: true, heldUpToSeq: 273 })
})

test('heldUpToSeq of 1 is preserved (no collision with the no-seq sentinel)', async () => {
  await recordHold(AGENT, SCOPE, 1)
  assert.deepEqual(await consumeHold(AGENT, SCOPE), { armed: true, heldUpToSeq: 1 })
})

test('a token recorded without a seq (doc/calendar scopes) arms with heldUpToSeq null', async () => {
  await recordHold(AGENT, 'doc-create:第七天的猫')
  assert.deepEqual(await consumeHold(AGENT, 'doc-create:第七天的猫'), { armed: true, heldUpToSeq: null })
})

test('hold tokens use a SHORT TTL — never valid minutes after the HELD', async () => {
  await recordHold(AGENT, SCOPE, 273)
  assert.ok(lastSetTtlSec !== null && lastSetTtlSec <= 120,
    `hold TTL must be ≤120s (got ${lastSetTtlSec}) — a yielded hold must not arm a later turn`)
})

test('hold tokens are scoped per agent and per scope', async () => {
  await recordHold(AGENT, SCOPE)
  assert.equal((await consumeHold('saga-x798', SCOPE)).armed, false, 'another agent cannot consume my hold')
  assert.equal((await consumeHold(AGENT, 'doc-create:第七天的猫')).armed, false, 'a different scope is not armed')
  assert.equal((await consumeHold(AGENT, SCOPE)).armed, true, 'the original (agent, scope) is still armed')
})

test('clearHold drops a lingering token (successful send / ack / turn end)', async () => {
  await recordHold(AGENT, SCOPE)
  await clearHold(AGENT, SCOPE)
  assert.equal((await consumeHold(AGENT, SCOPE)).armed, false)
})

test('unmarkThinking (turn end) voids un-used reply holds for the turn convos', async () => {
  const { inprocClient } = await import('../agents/runtime/inproc-client.js')
  await recordHold(AGENT, SCOPE)
  await inprocClient.unmarkThinking(AGENT, ['allhands-d7f8ffcf-2'])
  assert.equal((await consumeHold(AGENT, SCOPE)).armed, false,
    'a hold acknowledged-but-unused must not survive the turn that saw it')
})

test('consumeHold fails OPEN to armed on Redis error — infra hiccups never block work', async () => {
  failMode = true
  assert.deepEqual(await consumeHold(AGENT, SCOPE), { armed: true, heldUpToSeq: null })
})

test('recordHold / clearHold never throw on Redis error', async () => {
  failMode = true
  await assert.doesNotReject(recordHold(AGENT, SCOPE))
  await assert.doesNotReject(clearHold(AGENT, SCOPE))
})

test('empty agent or scope never consults Redis and is never armed', async () => {
  failMode = true // would throw if Redis were touched
  await assert.doesNotReject(recordHold('', SCOPE))
  assert.equal((await consumeHold(AGENT, '')).armed, false)
  assert.equal((await consumeHold('', SCOPE)).armed, false)
})

// ── HELD attempt counter (per-turn cost cap) ───────────────────────────
// Every HELD costs a full reasoning round-trip. The counter does NOT gate
// anything — it decides when the envelope stops merely explaining the hold
// and starts telling the agent to conclude.

test('recordHeldAttempt counts per turn and clearHeldAttempts resets it', async () => {
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 1)
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 2)
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 3)
  await clearHeldAttempts(AGENT, CONVO)
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 1, 'a new turn starts counting from zero')
})

test('the counter is scoped per agent and per conversation', async () => {
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 1)
  assert.equal(await recordHeldAttempt('saga-x798', CONVO), 1, 'another agent has its own budget')
  assert.equal(await recordHeldAttempt(AGENT, 'other-convo'), 1, 'another room has its own budget')
})

test('heldEscalationNote is silent below the threshold and speaks at it', () => {
  assert.equal(heldEscalationNote(0), '')
  assert.equal(heldEscalationNote(1), '', 'the first hold only explains itself')
  assert.equal(heldEscalationNote(HELD_ESCALATE_AT - 1), '')
  assert.match(heldEscalationNote(HELD_ESCALATE_AT), /STOP RE-DECIDING/)
  assert.match(heldEscalationNote(HELD_ESCALATE_AT), /cumora ack/, 'silence must be offered as a real exit')
})

test('escalation text matches the gate: a verbatim dup cannot be cleared by re-sending', () => {
  const freshness = heldEscalationNote(HELD_ESCALATE_AT, 'freshness')
  const verbatim = heldEscalationNote(HELD_ESCALATE_AT, 'verbatim')
  assert.match(freshness, /a plain re-send passes now/)
  assert.doesNotMatch(verbatim, /a plain re-send passes now/,
    'a verbatim-dup hold can never be cleared by re-sending the same body')
  assert.match(verbatim, /re-sending it can never pass/)
  assert.match(verbatim, /cumora ack/)
})

test('recordHeldAttempt fails OPEN to 1 on Redis error — no escalation without a real count', async () => {
  failMode = true
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 1)
})

test('clearHeldAttempts never throws on Redis error', async () => {
  failMode = true
  await assert.doesNotReject(clearHeldAttempts(AGENT, CONVO))
})

test('unmarkThinking (turn end) resets the HELD count for the turn convos', async () => {
  await recordHeldAttempt(AGENT, CONVO)
  await recordHeldAttempt(AGENT, CONVO)
  await inprocClient.unmarkThinking(AGENT, [CONVO])
  assert.equal(await recordHeldAttempt(AGENT, CONVO), 1,
    'the next turn must not inherit the previous turn\'s escalations')
})

// ── shared subject normalization ───────────────────────────────────────
// doc/calendar create's recently-created-duplicate checks and the worklog
// claim field must agree on what "same title" means — both go through
// normalizeWorkSubject.

test('normalizeWorkSubject collapses case and whitespace', () => {
  assert.equal(normalizeWorkSubject('  Warm   Pastels '), 'warm pastels')
  assert.equal(normalizeWorkSubject('第七天的猫'), normalizeWorkSubject(' 第七天的猫  '))
})

test('normalizeWorkSubject truncates to 80 chars after normalization', () => {
  const long = 'x'.repeat(100)
  assert.equal(normalizeWorkSubject(long).length, 80)
})

test('worklogField uses the same normalization (one definition of "same subject")', () => {
  assert.equal(worklogField('doc-create', '  Q3   Plan '), `doc-create::${normalizeWorkSubject('Q3 plan')}`)
})
