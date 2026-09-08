/**
 * BYOA model selection.
 *
 * Cumora pins a model per agent so a CLI upgrade can't silently change an
 * agent's behaviour. That pin is resolved SERVER-side and is an Anthropic /
 * OpenAI model id — which is wrong for an operator whose local `claude` points
 * at a custom provider (CC Switch and friends). The provider has never heard of
 * `claude-opus-4-7`, so every turn dies with "There's an issue with the selected
 * model", and on hosted Cumora the operator cannot change the pin.
 *
 * CUMORA_ENGINE_MODEL is the daemon-side escape; `local` imposes nothing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-model.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEngineModel, resolveEngineFastModel, resolveTriageModel } from '../agents/computer/daemon.js'

test('with no override, the model Cumora pinned is used', () => {
  assert.equal(resolveEngineModel('claude-opus-4-7', undefined), 'claude-opus-4-7')
  assert.equal(resolveEngineFastModel('claude-haiku-4-5', undefined), 'claude-haiku-4-5')
})

test('an unset agent model stays unset', () => {
  assert.equal(resolveEngineModel(null, undefined), null)
  assert.equal(resolveEngineModel(undefined, undefined), null)
})

test('`local` passes NO model, so the CLI uses its own configuration', () => {
  assert.equal(resolveEngineModel('claude-opus-4-7', 'local'), null)
})

test('`local` also drops the small/fast pin', () => {
  // Otherwise ANTHROPIC_SMALL_FAST_MODEL would still name a model the custom
  // provider lacks and the CLI's own quick calls would fail instead.
  assert.equal(resolveEngineFastModel('claude-haiku-4-5', 'local'), null)
})

test('`local` is matched case- and whitespace-insensitively', () => {
  // It comes from a hand-edited shell profile or .env file.
  for (const v of ['local', 'LOCAL', 'Local', '  local  ']) {
    assert.equal(resolveEngineModel('claude-opus-4-7', v), null, `not honoured: ${JSON.stringify(v)}`)
  }
})

test('a concrete override replaces the pinned model', () => {
  assert.equal(resolveEngineModel('claude-opus-4-7', 'my-provider/some-model'), 'my-provider/some-model')
})

test('a concrete override leaves the fast model alone', () => {
  // Only `local` means "impose nothing"; naming a big model says nothing about
  // the small one.
  assert.equal(resolveEngineFastModel('claude-haiku-4-5', 'my-provider/some-model'), 'claude-haiku-4-5')
})

test('an empty or whitespace-only override is ignored, not treated as `local`', () => {
  // An exported-but-empty env var must not silently unpin the model.
  assert.equal(resolveEngineModel('claude-opus-4-7', ''), 'claude-opus-4-7')
  assert.equal(resolveEngineModel('claude-opus-4-7', '   '), 'claude-opus-4-7')
})

test('per-agent small brain wins over the computer-wide triage model', () => {
  assert.equal(resolveTriageModel('gpt-5.4-mini', 'gpt-5.6-luna', undefined), 'gpt-5.4-mini')
})

test('computer-wide triage model remains the fallback for an unpinned agent', () => {
  assert.equal(resolveTriageModel(null, 'gpt-5.6-luna', undefined), 'gpt-5.6-luna')
  assert.equal(resolveTriageModel(null, undefined, undefined), undefined)
})

test('local engine override suppresses the agent fast pin but keeps the explicit triage fallback', () => {
  assert.equal(resolveTriageModel('claude-haiku-4-5', 'local-provider/fast', 'local'), 'local-provider/fast')
})
