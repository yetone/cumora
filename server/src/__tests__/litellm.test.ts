/**
 * Unit tests for the LiteLLM model-prefix routing (server/src/litellm.ts) and
 * the `/model/info` catalog that prices `litellm/*` calls
 * (server/src/litellm-catalog.ts). No network access: the client and the
 * catalog fetch are stubbed, so these assert the routing, parsing and refresh
 * logic, not live proxy behavior (that's the live-smoke step against a real
 * LiteLLM proxy).
 *
 * Run: node --import tsx --test server/src/__tests__/litellm.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'

// env.ts snapshots process.env on first import, so configure before loading.
process.env.LITELLM_BASE_URL = 'http://proxy.test:4000/v1/'
process.env.LITELLM_API_KEY = 'sk-litellm-test'
// cost.ts reads operator overrides once, lazily — set before the first priceFor.
process.env.CUMORA_MODEL_PRICES_JSON = JSON.stringify({ 'litellm/llama-3.3-70b': { inPer1M: 9, outPer1M: 9 } })

const { env } = await import('../env.js')
const {
  __setLiteLLMCatalogFetchForTesting,
  __setLiteLLMClientOverrideForTesting,
  isLiteLLMModel,
  liteLLMConfigured,
  liteLLMRootURL,
  litellmClient,
  litellmResponsesCreate,
  refreshLiteLLMCatalog,
  stripLiteLLMPrefix,
} = await import('../litellm.js')
const { liteLLMModelEntry, parseLiteLLMModelInfo, setLiteLLMCatalog } = await import('../litellm-catalog.js')
const { effectiveCostUsd, priceFor } = await import('../agents/cost.js')
const { getLlmClient } = await import('../llm.js')

function fakeResponsesClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { responses: { create } } as unknown as OpenAI
}

const MODEL_INFO = {
  data: [
    {
      model_name: 'gemini-2.5-flash',
      model_info: {
        input_cost_per_token: 3e-7,
        output_cost_per_token: 2.5e-6,
        cache_read_input_token_cost: 7.5e-8,
        max_input_tokens: 1_048_576,
      },
    },
    {
      model_name: 'Llama-3.3-70B',
      model_info: { input_cost_per_token: 6e-7, output_cost_per_token: 6e-7, max_tokens: 131_072 },
    },
    // Second deployment behind the same alias — first row wins.
    { model_name: 'gemini-2.5-flash', model_info: { input_cost_per_token: 1, output_cost_per_token: 1 } },
    // Self-hosted model with no cost data: context window only.
    { model_name: 'local-qwen', model_info: { input_cost_per_token: null, output_cost_per_token: null, max_input_tokens: 32_768 } },
    { model_name: 'no-info' },
    { model_info: { input_cost_per_token: 1 } },
  ],
}

test('isLiteLLMModel / stripLiteLLMPrefix', () => {
  assert.equal(isLiteLLMModel('litellm/claude-sonnet-4-6'), true)
  assert.equal(isLiteLLMModel('orcarouter/openai/gpt-4o-mini'), false)
  assert.equal(isLiteLLMModel('gpt-5.5'), false)
  assert.equal(isLiteLLMModel(null), false)
  assert.equal(isLiteLLMModel(undefined), false)
  assert.equal(stripLiteLLMPrefix('litellm/anthropic/claude-sonnet-4-6'), 'anthropic/claude-sonnet-4-6')
})

test('LITELLM_BASE_URL is accepted with or without /v1', () => {
  assert.equal(liteLLMConfigured(), true)
  assert.equal(liteLLMRootURL(), 'http://proxy.test:4000')
  const saved = env.LITELLM_BASE_URL
  try {
    env.LITELLM_BASE_URL = 'http://proxy.test:4000'
    assert.equal(liteLLMRootURL(), 'http://proxy.test:4000')
    env.LITELLM_BASE_URL = ''
    assert.equal(liteLLMConfigured(), false)
  } finally {
    env.LITELLM_BASE_URL = saved
  }
})

test('litellmClient targets <root>/v1 with the key and the shared retry/timeout budget', () => {
  const c = litellmClient()
  assert.equal(c.baseURL, 'http://proxy.test:4000/v1')
  assert.equal(c.apiKey, 'sk-litellm-test')
  assert.equal(c.maxRetries, 5)
  assert.equal(c.timeout, 5 * 60_000)
})

test('litellmResponsesCreate forwards the call with the prefix stripped', async () => {
  __setLiteLLMCatalogFetchForTesting(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }))
  let captured: { model?: string; input?: string; stream?: boolean } = {}
  __setLiteLLMClientOverrideForTesting(fakeResponsesClient(async (args: unknown) => {
    captured = args as typeof captured
    return { id: 'resp_1', output_text: 'hi' }
  }))
  try {
    const r = await litellmResponsesCreate(
      { model: 'litellm/gemini-2.5-flash', input: 'hello', stream: true } as never,
      undefined,
    ) as { id: string; output_text: string }
    assert.equal(r.output_text, 'hi')
    assert.equal(captured.model, 'gemini-2.5-flash')
    assert.equal(captured.input, 'hello')
    assert.equal(captured.stream, true)
  } finally {
    __setLiteLLMClientOverrideForTesting(null)
    __setLiteLLMCatalogFetchForTesting(null)
  }
})

test('getLlmClient routes litellm/* through the proxy client', async () => {
  __setLiteLLMCatalogFetchForTesting(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }))
  let routedModel: string | undefined
  __setLiteLLMClientOverrideForTesting(fakeResponsesClient(async (args: unknown) => {
    routedModel = (args as { model: string }).model
    return { id: 'resp_2' }
  }))
  try {
    const client = await getLlmClient(null)
    await client.responses.create({ model: 'litellm/llama-3.3-70b', input: 'x' } as never)
    assert.equal(routedModel, 'llama-3.3-70b')
  } finally {
    __setLiteLLMClientOverrideForTesting(null)
    __setLiteLLMCatalogFetchForTesting(null)
  }
})

test('parseLiteLLMModelInfo converts per-token costs to per-1M and keeps context windows', () => {
  const m = parseLiteLLMModelInfo(MODEL_INFO)
  const flash = m.get('gemini-2.5-flash')
  assert.ok(flash?.price)
  assert.ok(Math.abs(flash.price.inPer1M - 0.3) < 1e-9)
  assert.ok(Math.abs(flash.price.outPer1M - 2.5) < 1e-9)
  assert.ok(Math.abs(flash.price.cachedInPer1M - 0.075) < 1e-9)
  // No cache-write rate reported → billed at the input rate, never discounted.
  assert.ok(Math.abs(flash.price.cacheWritePer1M - 0.3) < 1e-9)
  assert.equal(flash.price.verified, false)
  assert.equal(flash.maxInputTokens, 1_048_576)

  // Aliases are matched case-insensitively; max_tokens is the fallback window.
  const llama = m.get('llama-3.3-70b')
  assert.ok(llama?.price)
  assert.ok(Math.abs(llama.price.cachedInPer1M - 0.6) < 1e-9)
  assert.equal(llama.maxInputTokens, 131_072)

  // No cost data → no price (cost.ts falls back), but the window is kept.
  assert.deepEqual(m.get('local-qwen'), { maxInputTokens: 32_768 })
  assert.equal(m.has('no-info'), false)
  assert.equal(m.size, 3)

  assert.equal(parseLiteLLMModelInfo(null).size, 0)
  assert.equal(parseLiteLLMModelInfo({ data: 'nope' }).size, 0)
})

test('priceFor uses the proxy rate for litellm/* ids, operator overrides still win', () => {
  setLiteLLMCatalog(parseLiteLLMModelInfo(MODEL_INFO))
  try {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 1_000_000 }
    // $0.30 in + $2.50 out, instead of the Sonnet-rate fallback ($3 + $15).
    const flash = effectiveCostUsd('litellm/gemini-2.5-flash', usage)
    assert.ok(Math.abs(flash.usd - 2.8) < 1e-9)
    assert.equal(flash.estimated, true)
    assert.equal(priceFor('LiteLLM/Gemini-2.5-Flash'), priceFor('litellm/gemini-2.5-flash'))
    // The operator's contracted rate beats the proxy-reported one.
    assert.equal(priceFor('litellm/llama-3.3-70b').inPer1M, 9)
    assert.equal(priceFor('litellm/llama-3.3-70b').verified, true)
    // Unpriced or unknown proxy models keep the existing fallback behavior.
    assert.deepEqual(priceFor('litellm/local-qwen'), priceFor('some-unknown-model'))
    assert.deepEqual(priceFor('litellm/not-on-proxy'), priceFor('some-unknown-model'))
    // A bare (non-prefixed) id never consults the catalog.
    assert.deepEqual(priceFor('gemini-2.5-flash'), priceFor('some-unknown-model'))
    assert.equal(liteLLMModelEntry('gemini-2.5-flash'), undefined)
  } finally {
    setLiteLLMCatalog(new Map())
  }
})

test('refreshLiteLLMCatalog loads /model/info with auth, once per TTL, one request in flight', async () => {
  const calls: Array<{ url: string; auth?: string }> = []
  __setLiteLLMCatalogFetchForTesting(async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization })
    return { ok: true, status: 200, json: async () => MODEL_INFO }
  })
  try {
    await Promise.all([refreshLiteLLMCatalog(), refreshLiteLLMCatalog()])
    await refreshLiteLLMCatalog()
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { url: 'http://proxy.test:4000/model/info', auth: 'Bearer sk-litellm-test' })
    assert.equal(liteLLMModelEntry('litellm/gemini-2.5-flash')?.maxInputTokens, 1_048_576)
  } finally {
    __setLiteLLMCatalogFetchForTesting(null)
    setLiteLLMCatalog(new Map())
  }
})

test('refreshLiteLLMCatalog never throws and keeps the previous catalog on failure', async () => {
  setLiteLLMCatalog(parseLiteLLMModelInfo(MODEL_INFO))
  const warn = console.warn
  const warnings: unknown[] = []
  console.warn = (...a: unknown[]) => { warnings.push(a) }
  try {
    __setLiteLLMCatalogFetchForTesting(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    await refreshLiteLLMCatalog()
    __setLiteLLMCatalogFetchForTesting(async () => { throw new Error('ECONNREFUSED') })
    await refreshLiteLLMCatalog()
    assert.ok(liteLLMModelEntry('litellm/gemini-2.5-flash')?.price)
    assert.equal(warnings.length, 2)
  } finally {
    console.warn = warn
    __setLiteLLMCatalogFetchForTesting(null)
    setLiteLLMCatalog(new Map())
  }
})

test('refreshLiteLLMCatalog is a no-op when the proxy is not configured', async () => {
  let called = false
  __setLiteLLMCatalogFetchForTesting(async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } })
  const saved = env.LITELLM_BASE_URL
  env.LITELLM_BASE_URL = ''
  try {
    await refreshLiteLLMCatalog()
    assert.equal(called, false)
  } finally {
    env.LITELLM_BASE_URL = saved
    __setLiteLLMCatalogFetchForTesting(null)
  }
})
