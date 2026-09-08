/**
 * An engine failure only the operator can clear must stop spinning.
 *
 * Measured on 2026-09-01, after the codex config fix had landed: nine computers
 * whose Claude was signed out produced 1,988 failed turns in forty minutes —
 * roughly one every twelve seconds each, indefinitely, with no backoff and
 * nothing telling their operator why. Retrying a signed-out CLI cannot succeed;
 * it only burns the fleet's error budget and hides real failures underneath.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-operator-fix-backoff.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { needsOperatorFix } = await import('../agents/computer/daemon.js')

test('the failures actually seen in production are recognised', () => {
  for (const err of [
    'local claude failed (exit 1): engine turn error (success): Not logged in · Please run /login',
    'local claude failed (exit 1): engine turn error (success): Credit balance is too low',
    'Invalid API key provided',
    'unauthorized',
  ]) {
    assert.equal(needsOperatorFix(err), true, `should pause on: ${err}`)
  }
})

test('transient and unknown failures keep retrying', () => {
  for (const err of [
    undefined,
    null,
    '',
    // A throttle clears itself — that is the rate-limit path, not this one.
    'Server is temporarily limiting requests',
    // A broken install is real, but the message is not unambiguous enough to
    // stop a whole agent for fifteen minutes on.
    'Missing optional dependency @openai/codex-darwin-arm64',
    'process exited with code 1',
    'engine turn error (error_during_execution): see log',
    // Must not fire on a message that merely mentions logging in.
    'the user asked how to run /login later',
  ]) {
    assert.equal(needsOperatorFix(err), false, `should keep retrying: ${err}`)
  }
})
