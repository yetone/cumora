/**
 * Typing a model id in full and pressing Enter must pin that model.
 *
 * The BYOA model picker's first row is the placeholder
 *
 *   { value: '', label: 'Follow engine default', hint: <catalog default id> }
 *
 * and <Combobox>'s filter matches `hint` as well as `label`. For an agent with
 * no pin (`value === ''`), typing the default model id left both rows in the
 * list, the highlight stayed on the placeholder because it held the current
 * value, and Enter committed '' — so the agent was saved UNPINNED while the
 * trigger showed the typed id as its hint.
 *
 * Pinning is what stops a model upgrade in the local CLI from silently changing
 * an agent's behaviour, so the failure surfaces much later and looks like the
 * agent changed on its own.
 *
 * Run: node --import tsx --test server/src/__tests__/combobox-highlight.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialActiveIndex } from '../../../src/lib/combobox-highlight.js'

/** The BYOA model options, in the order AgentEditor builds them. */
const MODEL_ROWS = [
  { value: '', label: 'Follow engine default' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
]

// ── the case that lost the pin ─────────────────────────────────────────────

test('typing the default model id in full highlights that model, not the placeholder', () => {
  // Both rows survive the filter: the placeholder matches through its hint,
  // which IS this id. The unpinned agent's value is ''.
  const filtered = [MODEL_ROWS[0], MODEL_ROWS[1]]
  assert.equal(initialActiveIndex(filtered, '', 'gpt-5.6-sol'), 1)
})

test('the same holds when the typed id is not the catalog default', () => {
  const filtered = [MODEL_ROWS[2]]
  assert.equal(initialActiveIndex(filtered, '', 'gpt-5.4-mini'), 0)
})

test('an exact label match counts too', () => {
  // The user can type what they see rather than the id.
  const filtered = [MODEL_ROWS[0], MODEL_ROWS[1]]
  assert.equal(initialActiveIndex(filtered, '', 'GPT-5.6 Sol'), 1)
})

test('matching is case-insensitive, like the filter above it', () => {
  const filtered = [MODEL_ROWS[0], MODEL_ROWS[1]]
  assert.equal(initialActiveIndex(filtered, '', 'GPT-5.6-SOL'), 1)
  assert.equal(initialActiveIndex(filtered, '', '  gpt-5.6-sol  '), 1)
})

// ── and the behaviour that was already right ───────────────────────────────

test('with no query the highlight still follows the current value', () => {
  assert.equal(initialActiveIndex(MODEL_ROWS, 'gpt-5.4-mini', ''), 2)
  assert.equal(initialActiveIndex(MODEL_ROWS, '', ''), 0)
})

test('a partial query is left alone', () => {
  // Nothing is named exactly, so the old rule applies: the current value, which
  // here is the pinned model. Changing this would be a different decision.
  assert.equal(initialActiveIndex(MODEL_ROWS, 'gpt-5.4-mini', 'gpt'), 2)
})

test('a current value that filtered out falls back to the top', () => {
  assert.equal(initialActiveIndex([MODEL_ROWS[1]], 'gpt-5.4-mini', 'sol'), 0)
})

test('an empty list is not an index', () => {
  assert.equal(initialActiveIndex([], 'gpt-5.6-sol', 'gpt-5.6-sol'), 0)
})

test('the placeholder is still reachable by naming it', () => {
  // Pinning must not become impossible to undo from the keyboard.
  assert.equal(initialActiveIndex(MODEL_ROWS, 'gpt-5.6-sol', 'Follow engine default'), 0)
})
