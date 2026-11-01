/**
 * The BYOA steer path had no budget. The cloud pod caps steering
 * (MAX_BATCHES_PER_TURN / MAX_BYTES_PER_TURN in agents/steer.ts), but the BYOA
 * daemon injects into a live engine session with an unbounded queue
 * (ClaudeSession.steerQueue is a plain array) and a DIRECT ping is
 * deliberately unthrottled. A long turn in a fast room could therefore push an
 * unbounded amount of text into one engine session, and every later hop of
 * that turn pays for it.
 *
 * The budget is a pure arithmetic helper on purpose: the runner only decides
 * WHICH steer to attempt, so the accounting can be pinned without booting a
 * daemon, an engine, or Redis.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-steer-budget.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chargeSteerBudget, steerBudgetExhausted, type SteerBudget } from '../agents/computer/daemon.js'

function budget(maxSteers: number, maxChars: number): SteerBudget {
  return { steers: 0, chars: 0, maxSteers, maxChars }
}

test('a fresh budget is not exhausted', () => {
  assert.equal(steerBudgetExhausted(budget(2, 100)), false)
})

test('the steer-count cap stops injection even when characters remain', () => {
  let b = budget(2, 100_000)
  b = chargeSteerBudget(b, 1)
  assert.equal(steerBudgetExhausted(b), false, 'one of two used')
  b = chargeSteerBudget(b, 1)
  assert.equal(steerBudgetExhausted(b), true, 'the second steer spends the count budget')
})

test('the character cap stops injection even when steers remain', () => {
  let b = budget(100, 100)
  b = chargeSteerBudget(b, 99)
  assert.equal(steerBudgetExhausted(b), false, 'still one character of room')
  b = chargeSteerBudget(b, 1)
  assert.equal(steerBudgetExhausted(b), true, 'reaching the ceiling is exhaustion, not "one more"')
})

test('a single oversized steer is refused before it is sent, not truncated', () => {
  // Callers check steerBudgetExhausted BEFORE building the text; the helper
  // must therefore report exhaustion once the ceiling is reached, never let a
  // steer through and trim it afterwards.
  const b = chargeSteerBudget(budget(8, 100), 5_000)
  assert.equal(steerBudgetExhausted(b), true)
})

test('a zero cap disables injection entirely (the kill switch)', () => {
  assert.equal(steerBudgetExhausted(budget(0, 65_536)), true)
  assert.equal(steerBudgetExhausted(budget(8, 0)), true)
})

test('charging is immutable — the previous budget is unchanged', () => {
  const before = budget(8, 1000)
  const after = chargeSteerBudget(before, 400)
  assert.deepEqual(before, { steers: 0, chars: 0, maxSteers: 8, maxChars: 1000 })
  assert.deepEqual(after, { steers: 1, chars: 400, maxSteers: 8, maxChars: 1000 })
})

test('a negative length cannot refund budget', () => {
  const b = chargeSteerBudget(budget(8, 1000), -50)
  assert.equal(b.chars, 0, 'a bogus length must not hand back allowance')
  assert.equal(b.steers, 1, 'the steer still counted')
})
