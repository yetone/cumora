/**
 * Unit tests for the AtlasCloud model-prefix routing (server/src/atlascloud.ts).
 * No network access: the underlying client is stubbed via
 * `__setAtlasCloudClientOverrideForTesting` so these tests assert the prefix
 * stripping and forwarding logic, not live AtlasCloud behavior (that's the
 * live smoke test with a real ATLASCLOUD_API_KEY).
 *
 * Run: node --import tsx --test server/src/__tests__/atlascloud.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'
import {
  __setAtlasCloudClientOverrideForTesting,
  atlascloudClient,
  atlascloudResponsesCreate,
  isAtlasCloudModel,
  stripAtlasCloudPrefix,
} from '../atlascloud.js'

function fakeResponsesClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { responses: { create } } as unknown as OpenAI
}

test('isAtlasCloudModel / stripAtlasCloudPrefix', () => {
  assert.equal(isAtlasCloudModel('atlascloud/qwen/qwen3.7-plus'), true)
  assert.equal(isAtlasCloudModel('gpt-5.5'), false)
  assert.equal(isAtlasCloudModel(null), false)
  assert.equal(isAtlasCloudModel(undefined), false)
  assert.equal(stripAtlasCloudPrefix('atlascloud/qwen/qwen3.7-plus'), 'qwen/qwen3.7-plus')
})

test('atlascloudResponsesCreate forwards the call with the prefix stripped', async () => {
  let captured: { model?: string; input?: string; max_output_tokens?: number } = {}
  __setAtlasCloudClientOverrideForTesting(fakeResponsesClient(async (args: unknown) => {
    captured = args as typeof captured
    return { id: 'resp_1', output_text: 'hi' }
  }))
  try {
    const r = await atlascloudResponsesCreate(
      { model: 'atlascloud/qwen/qwen3.7-plus', input: 'hello', max_output_tokens: 10 } as never,
      undefined,
    ) as { id: string; output_text: string }
    assert.equal(r.output_text, 'hi')
    // The model prefix is stripped before the id is forwarded to AtlasCloud.
    assert.equal(captured.model, 'qwen/qwen3.7-plus')
    assert.equal(captured.input, 'hello')
    assert.equal(captured.max_output_tokens, 10)
  } finally {
    __setAtlasCloudClientOverrideForTesting(null)
  }
})

test('atlascloudClient uses the test override when set', () => {
  const fake = fakeResponsesClient(() => ({}))
  __setAtlasCloudClientOverrideForTesting(fake)
  try {
    assert.equal(atlascloudClient(), fake)
  } finally {
    __setAtlasCloudClientOverrideForTesting(null)
  }
})
