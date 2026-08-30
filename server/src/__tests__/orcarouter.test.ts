/**
 * Unit tests for the OrcaRouter model-prefix routing (server/src/orcarouter.ts).
 * No network access: the underlying client is stubbed via
 * `__setOrcaRouterClientOverrideForTesting` so these tests assert the prefix
 * stripping and forwarding logic, not live OrcaRouter behavior (that's the
 * live-smoke step with a real ORCAROUTER_API_KEY).
 *
 * Run: node --import tsx --test server/src/__tests__/orcarouter.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'
import {
  __setOrcaRouterClientOverrideForTesting,
  isOrcaRouterModel,
  orcarouterClient,
  orcarouterResponsesCreate,
  stripOrcaRouterPrefix,
} from '../orcarouter.js'

function fakeResponsesClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { responses: { create } } as unknown as OpenAI
}

test('isOrcaRouterModel / stripOrcaRouterPrefix', () => {
  assert.equal(isOrcaRouterModel('orcarouter/openai/gpt-4o-mini'), true)
  assert.equal(isOrcaRouterModel('gpt-5.5'), false)
  assert.equal(isOrcaRouterModel(null), false)
  assert.equal(isOrcaRouterModel(undefined), false)
  assert.equal(stripOrcaRouterPrefix('orcarouter/openai/gpt-4o-mini'), 'openai/gpt-4o-mini')
})

test('orcarouterResponsesCreate forwards the call with the prefix stripped', async () => {
  let captured: { model?: string; input?: string; max_output_tokens?: number } = {}
  __setOrcaRouterClientOverrideForTesting(fakeResponsesClient(async (args: unknown) => {
    captured = args as typeof captured
    return { id: 'resp_1', output_text: 'hi' }
  }))
  try {
    const r = await orcarouterResponsesCreate(
      { model: 'orcarouter/openai/gpt-4o-mini', input: 'hello', max_output_tokens: 10 } as never,
      undefined,
    ) as { id: string; output_text: string }
    assert.equal(r.output_text, 'hi')
    // The model prefix is stripped before the id is forwarded to OrcaRouter.
    assert.equal(captured.model, 'openai/gpt-4o-mini')
    assert.equal(captured.input, 'hello')
    assert.equal(captured.max_output_tokens, 10)
  } finally {
    __setOrcaRouterClientOverrideForTesting(null)
  }
})

test('orcarouterClient uses the test override when set', () => {
  const fake = fakeResponsesClient(() => ({}))
  __setOrcaRouterClientOverrideForTesting(fake)
  try {
    assert.equal(orcarouterClient(), fake)
  } finally {
    __setOrcaRouterClientOverrideForTesting(null)
  }
})
