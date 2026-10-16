/**
 * Unit tests for the Cheaper Inference model-prefix routing
 * (server/src/cheaperinference.ts). No network access: the underlying client
 * is stubbed via `__setCheaperInferenceClientOverrideForTesting` so these
 * tests assert the prefix stripping and forwarding logic, not live Cheaper
 * Inference behavior (that's the live-smoke step with a real
 * CHEAPER_INFERENCE_API_KEY).
 *
 * Run: node --import tsx --test server/src/__tests__/cheaperinference.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'
import {
  __setCheaperInferenceClientOverrideForTesting,
  cheaperinferenceClient,
  cheaperinferenceResponsesCreate,
  isCheaperInferenceModel,
  stripCheaperInferencePrefix,
} from '../cheaperinference.js'

function fakeResponsesClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { responses: { create } } as unknown as OpenAI
}

test('isCheaperInferenceModel / stripCheaperInferencePrefix', () => {
  assert.equal(isCheaperInferenceModel('cheaperinference/gpt-5.4-mini'), true)
  assert.equal(isCheaperInferenceModel('gpt-5.5'), false)
  assert.equal(isCheaperInferenceModel('orcarouter/openai/gpt-4o-mini'), false)
  assert.equal(isCheaperInferenceModel(null), false)
  assert.equal(isCheaperInferenceModel(undefined), false)
  assert.equal(stripCheaperInferencePrefix('cheaperinference/gpt-5.4-mini'), 'gpt-5.4-mini')
})

test('cheaperinferenceResponsesCreate forwards the call with the prefix stripped', async () => {
  let captured: { model?: string; input?: string; max_output_tokens?: number } = {}
  __setCheaperInferenceClientOverrideForTesting(fakeResponsesClient(async (args: unknown) => {
    captured = args as typeof captured
    return { id: 'resp_1', output_text: 'hi' }
  }))
  try {
    const r = await cheaperinferenceResponsesCreate(
      { model: 'cheaperinference/gpt-5.4-mini', input: 'hello', max_output_tokens: 10 } as never,
      undefined,
    ) as { id: string; output_text: string }
    assert.equal(r.output_text, 'hi')
    // The model prefix is stripped before the id is forwarded to Cheaper Inference.
    assert.equal(captured.model, 'gpt-5.4-mini')
    assert.equal(captured.input, 'hello')
    assert.equal(captured.max_output_tokens, 10)
  } finally {
    __setCheaperInferenceClientOverrideForTesting(null)
  }
})

test('cheaperinferenceClient uses the test override when set', () => {
  const fake = fakeResponsesClient(() => ({}))
  __setCheaperInferenceClientOverrideForTesting(fake)
  try {
    assert.equal(cheaperinferenceClient(), fake)
  } finally {
    __setCheaperInferenceClientOverrideForTesting(null)
  }
})
