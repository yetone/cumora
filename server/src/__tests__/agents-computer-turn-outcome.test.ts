/**
 * A wake that cannot succeed has to stop retrying on EVERY path, not just one.
 *
 * The fifteen-minute operator pause was measured into existence: nine computers
 * whose Claude was signed out produced 1,988 failed turns in forty minutes. But
 * it was wired into the chat wake only. The proactive agenda heartbeat — which
 * fires on its own every AGENDA_CHECK_MS whether or not anyone is talking to the
 * agent — published the failure notice and then came straight back a minute
 * later, and again, for as long as the engine stayed signed out.
 *
 * So the agents that kept spinning were precisely the ones nobody was chatting
 * with, and the notice is deduplicated over the same fifteen minutes the pause
 * covers: roughly fifteen dead spawns per agent per message the operator sees.
 * The pause looked like it worked because the path that proved it was the path
 * that had it.
 *
 * The two paths now ask one classifier and assign through one method, so they
 * can no longer hold different opinions about what a failure means.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-turn-outcome.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { classifyTurnOutcome, backoffUntilFor, needsOperatorFix } =
  await import('../agents/computer/daemon.js')

const RATE_LIMIT_MS = 60_000
const OPERATOR_FIX_MS = 15 * 60_000

// ── what a finished turn means ─────────────────────────────────────────────

test('the failures measured in production classify as needing a human', () => {
  for (const err of [
    'local claude failed (exit 1): engine turn error (success): Not logged in · Please run /login',
    'local claude failed (exit 1): engine turn error (success): Credit balance is too low',
    'Invalid API key provided',
    'unauthorized',
  ]) {
    assert.equal(classifyTurnOutcome(err), 'operator-fix', err)
  }
})

test('a clean turn is ok, including the empty-string shape a caller can pass', () => {
  // The old code keyed on `!engineError`, so '' counted as success. Changing
  // that here would silently pause agents that had done nothing wrong.
  for (const err of [null, undefined, '']) assert.equal(classifyTurnOutcome(err), 'ok', String(err))
})

test('an unexplained failure stays transient and keeps retrying', () => {
  for (const err of [
    // A broken install is real, but not unambiguous enough to stop an agent
    // for fifteen minutes on — it may be an npm run that has not finished.
    'Missing optional dependency @openai/codex-darwin-arm64',
    'process exited with code 1',
    'engine turn error (error_during_execution): see log',
    // Must not fire on a turn that merely talked about logging in.
    'the user asked how to run /login later',
  ]) {
    assert.equal(classifyTurnOutcome(err), 'transient', err)
  }
})

test('a throttle outranks an operator fix, exactly as the old chat path did', () => {
  // The old order was `!rateLimited && needsOperatorFix(...)`, so a message
  // matching both took the short cooldown and stayed out of the user's chat.
  // "insufficient quota" is both — inverting this would put a self-clearing
  // throttle behind a fifteen-minute wall and post a notice about it.
  const both = 'insufficient quota for this request'
  assert.equal(needsOperatorFix(both), true, 'precondition: also reads as an operator fix')
  assert.equal(classifyTurnOutcome(both), 'rate-limited')
})

// ── what that means for the pause ──────────────────────────────────────────

test('each outcome maps to its own deadline', () => {
  assert.equal(backoffUntilFor('ok', 1_000), 0)
  assert.equal(backoffUntilFor('rate-limited', 1_000), 1_000 + RATE_LIMIT_MS)
  assert.equal(backoffUntilFor('operator-fix', 1_000), 1_000 + OPERATOR_FIX_MS)
})

test('a human-cleared failure waits far longer than a throttle', () => {
  // The two windows serve different things: a throttle clears itself in
  // seconds, a signed-out CLI does not clear at all. Collapsing them would
  // bring back the spin at a slower rate.
  const rate = backoffUntilFor('rate-limited', 0) ?? 0
  const operator = backoffUntilFor('operator-fix', 0) ?? 0
  assert.ok(operator > rate * 5, `${operator} should dwarf ${rate}`)
})

test('a transient failure leaves an existing pause alone rather than clearing it', () => {
  // null is deliberately not 0. An agent paused for a signed-out engine can
  // still fail some other way on its next attempt; if that cleared the pause,
  // the spin would resume with an extra step in it.
  assert.equal(backoffUntilFor('transient', 1_000), null)
})

// ── and that both paths actually go through it ─────────────────────────────

const DAEMON = readFileSync(
  fileURLToPath(new URL('../agents/computer/daemon.ts', import.meta.url)),
  'utf8',
)

test('nothing sets the pause except the one method', () => {
  // This is the property the bug violated. Pure functions cannot catch a path
  // that simply does not call them, so assert the shape of the source: a second
  // assignment is how the chat wake and the agenda heartbeat drifted apart.
  const assignments = DAEMON.match(/this\.engineBackoffUntil\s*=/g) ?? []
  assert.equal(assignments.length, 1, `expected one assignment, found ${assignments.length}`)
  assert.match(DAEMON, /private applyTurnBackoff\(outcome: TurnOutcome\): void \{/)
})

test('both turn paths end in it', () => {
  const calls = DAEMON.match(/this\.applyTurnBackoff\(outcome\)/g) ?? []
  assert.equal(calls.length, 2, `expected the chat and agenda paths, found ${calls.length}`)
})
