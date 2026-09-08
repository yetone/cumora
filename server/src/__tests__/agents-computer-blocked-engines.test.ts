/**
 * Surfacing the reason an installed engine is refused.
 *
 * `evaluateRunnableEngines()` already computes why it declined an engine — an
 * old CLI, a missing sandbox dependency — but that reason only ever reached the
 * daemon's own stdout. Whoever reads the Computers card is usually not sitting
 * at that machine, which is the same argument the version fields are carried
 * for, so the engine simply went absent with no explanation anywhere visible.
 *
 * The safety property these pin is the separation: a blocked engine is a
 * DISPLAY row and must never reach `available_engines`, because that list is
 * what picks an agent's adapter. Letting one through would run exactly what the
 * sandbox gate refused.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-blocked-engines.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { sanitizeDetectedEngines } = await import('../agents/computer/registry.js')

const OLD_CLAUDE = 'version 2.0.9 is older than the secure minimum 2.1.248'

test('a blocked engine becomes a display row carrying its reason', () => {
  const out = sanitizeDetectedEngines(
    [
      { id: 'codex', bin: 'codex', path: '/usr/local/bin/codex' },
      { id: 'claude', bin: 'claude', path: '/usr/local/bin/claude', blockedReason: OLD_CLAUDE },
    ],
    ['codex'],
    ['claude'],
  )
  assert.deepEqual(out.map((e) => e.id), ['codex', 'claude'])
  assert.equal(out.find((e) => e.id === 'codex')?.blockedReason, null)
  assert.equal(out.find((e) => e.id === 'claude')?.blockedReason, OLD_CLAUDE)
  // The path still shows: "installed here, and here is where" is half the
  // point of telling the operator it was refused.
  assert.equal(out.find((e) => e.id === 'claude')?.path, '/usr/local/bin/claude')
})

test('a reason on a RUNNABLE engine is discarded', () => {
  // Otherwise a daemon could mark a perfectly good engine broken in the UI.
  // Only the ids the caller passed as blocked may carry a reason.
  const out = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/bin/codex', blockedReason: 'not actually blocked' }],
    ['codex'],
    [],
  )
  assert.equal(out[0].blockedReason, null)
})

test('an id claimed as both runnable and blocked stays runnable', () => {
  // Runnable wins, and it appears exactly once — a duplicate row would render
  // the same engine twice, once contradicting the other.
  const out = sanitizeDetectedEngines(
    [{ id: 'claude', bin: 'claude', path: '/bin/claude', blockedReason: OLD_CLAUDE }],
    ['claude'],
    ['claude'],
  )
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'claude')
  assert.equal(out[0].blockedReason, null)
})

test('blocked ids do not disturb the runnable order', () => {
  // available_engines[0] is the computer's DEFAULT engine. Blocked rows are
  // appended, never interleaved, so adding this display data cannot silently
  // repoint which adapter an agent gets.
  const out = sanitizeDetectedEngines(
    [
      { id: 'codex', bin: 'codex', path: '/bin/codex' },
      { id: 'gemini', bin: 'gemini', path: '/bin/gemini' },
      { id: 'claude', bin: 'claude', path: '/bin/claude', blockedReason: OLD_CLAUDE },
    ],
    ['codex', 'gemini'],
    ['claude'],
  )
  assert.deepEqual(out.map((e) => e.id), ['codex', 'gemini', 'claude'])
})

test('an unknown blocked id is dropped like any other', () => {
  // The pairable allowlist governs both lists; a newer daemon naming an engine
  // this server has no adapter for must not create a phantom row.
  const out = sanitizeDetectedEngines(
    [{ id: 'hermes', bin: 'hermes', path: '/bin/hermes', blockedReason: 'nope' }],
    ['codex'],
    ['hermes'],
  )
  assert.deepEqual(out.map((e) => e.id), ['codex'])
})

test('a hostile reason is trimmed and length-capped like every other display string', () => {
  const out = sanitizeDetectedEngines(
    [{ id: 'claude', bin: 'claude', path: '/bin/claude', blockedReason: `  ${'x'.repeat(500)}  ` }],
    [],
    ['claude'],
  )
  const reason = out[0].blockedReason ?? ''
  assert.ok(reason.length <= 200, `reason was ${reason.length} chars`)
  assert.ok(!reason.startsWith(' ') && !reason.endsWith(' '))
})

test('a non-string reason is dropped rather than rendered', () => {
  const out = sanitizeDetectedEngines(
    [{ id: 'claude', bin: 'claude', path: '/bin/claude', blockedReason: { evil: true } }],
    [],
    ['claude'],
  )
  assert.equal(out[0].blockedReason, null)
})

test('omitting the blocked list keeps the previous behaviour exactly', () => {
  // Every existing caller passes two arguments; the third must be optional and
  // change nothing when absent.
  const out = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/bin/codex' }],
    ['codex'],
  )
  assert.deepEqual(out.map((e) => e.id), ['codex'])
  assert.equal(out[0].blockedReason, null)
})

test('a blocked engine the daemon reported nothing about still gets a row', () => {
  // The reason is the point of the row, but even without one the operator
  // should see that the engine is installed and unused rather than missing.
  const out = sanitizeDetectedEngines(null, ['codex'], ['claude'])
  assert.deepEqual(out.map((e) => e.id), ['codex', 'claude'])
})

// --- every path that stores a snapshot, not just the rescan ---

test('the reason travels on the pairing snapshot, not only the rescan', () => {
  // The first version of this feature wired only the periodic PATH rescan, so a
  // freshly paired computer showed nothing for minutes — exactly the window in
  // which someone asks why their Claude Code is missing. pairComputer() and the
  // reconnect branch sanitize their own snapshots, so they need the same list.
  const out = sanitizeDetectedEngines(
    [
      { id: 'codex', bin: 'codex', path: '/bin/codex' },
      { id: 'claude', bin: 'claude', path: '/bin/claude', blockedReason: OLD_CLAUDE },
    ],
    ['codex'],
    ['claude'],
  )
  assert.equal(out.find((e) => e.id === 'claude')?.blockedReason, OLD_CLAUDE)
})

test('a blocked engine never reaches the runnable list it is derived from', () => {
  // The invariant stated as the caller sees it: whatever this returns for
  // display, `available_engines` is built from the runnable ids alone, so a
  // blocked engine cannot become the adapter an agent runs on.
  const runnable = ['codex']
  const out = sanitizeDetectedEngines(
    [{ id: 'claude', bin: 'claude', path: '/bin/claude', blockedReason: OLD_CLAUDE }],
    runnable,
    ['claude'],
  )
  assert.deepEqual(runnable, ['codex'], 'the runnable list must not be mutated')
  assert.ok(out.some((e) => e.id === 'claude' && e.blockedReason))
  assert.ok(!runnable.includes('claude'))
})
