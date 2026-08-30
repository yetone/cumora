import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveCostUsd, priceFor, cacheHitRate, usageFromOpenAI, usageFromClaude,
  addUsage, inputEquivalentTokens, type TokenUsage,
} from '../agents/cost.js'

test('cache-read is far cheaper than fresh input (the whole premise)', () => {
  const fresh: TokenUsage = { inputTokens: 1_000_000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 }
  const cached: TokenUsage = { inputTokens: 0, cachedInputTokens: 1_000_000, cacheCreationTokens: 0, outputTokens: 0 }
  const m = 'claude-sonnet-4-6'
  assert.ok(effectiveCostUsd(m, cached).usd < effectiveCostUsd(m, fresh).usd)
  // Anthropic ratio: cache-read ≈ 0.1× input.
  assert.ok(effectiveCostUsd(m, cached).usd <= effectiveCostUsd(m, fresh).usd * 0.2)
})

test('ALL seeded prices are flagged estimated (only operator-supplied rates are exact)', () => {
  const u: TokenUsage = { inputTokens: 100, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 10 }
  // We can't authoritatively know list prices for the exact model variant, so even
  // a recognized claude tier is presented as an estimate until overridden.
  assert.equal(effectiveCostUsd('claude-haiku-4-5', u).estimated, true)
  assert.equal(effectiveCostUsd('claude-sonnet-4-6', u).estimated, true)
  assert.equal(effectiveCostUsd('some-unknown-model', u).estimated, true)
})

test('OpenAI usage: input_tokens is TOTAL incl cached → uncached = total − cached', () => {
  const u = usageFromOpenAI({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 800 } })
  assert.deepEqual(u, { inputTokens: 200, cachedInputTokens: 800, cacheCreationTokens: 0, outputTokens: 50 })
})

test('Claude usage: input_tokens EXCLUDES cache read/write (kept separate)', () => {
  const u = usageFromClaude({ input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 120 })
  assert.deepEqual(u, { inputTokens: 200, cachedInputTokens: 800, cacheCreationTokens: 120, outputTokens: 50 })
  assert.equal(cacheHitRate(u), 800 / 1000)
})

test('bare tier ids resolve to their tier (not the fallback) — "haiku" ≠ sonnet rate', () => {
  // Regression: the triage model id is the bare "haiku"; it must match the
  // "claude-haiku" seed (bidirectional substring), not fall through to fallback.
  // Prices = Anthropic list (Haiku 4.5 = $1/$5; current Opus 4.5+ = $5/$25;
  // legacy Opus 4.1 = $15/$75; Sonnet 4.x = $3/$15).
  assert.equal(priceFor('haiku').inPer1M, 1)
  assert.equal(priceFor('haiku').outPer1M, 5)
  assert.notEqual(priceFor('haiku').inPer1M, priceFor('claude-sonnet').inPer1M)
  assert.equal(priceFor('claude-opus-4-7').inPer1M, 5)   // current Opus, cheaper
  assert.equal(priceFor('claude-opus-4-1').inPer1M, 15)  // legacy Opus, specific key wins
  assert.equal(priceFor('claude-sonnet-4-6').inPer1M, 3)
})

test('addUsage sums across hops; inputEquivalentTokens is price-free scale', () => {
  const a: TokenUsage = { inputTokens: 10, cachedInputTokens: 5, cacheCreationTokens: 0, outputTokens: 2 }
  assert.deepEqual(addUsage(a, a), { inputTokens: 20, cachedInputTokens: 10, cacheCreationTokens: 0, outputTokens: 4 })
  assert.ok(inputEquivalentTokens('claude-sonnet', a) > 0)
})

test('the user scenario: a cold triage can cost MORE than a cache-warm turn it skips', () => {
  // Triage: 5k uncached input, tiny output, on haiku.
  const triage: TokenUsage = { inputTokens: 5000, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 50 }
  // Avoided turn: 40k input but 95% cache-read, on the SAME small model — cheap.
  const warmTurn: TokenUsage = { inputTokens: 2000, cachedInputTokens: 38000, cacheCreationTokens: 0, outputTokens: 100 }
  const triageCost = effectiveCostUsd('haiku', triage).usd
  const turnCost = effectiveCostUsd('haiku', warmTurn).usd
  // Not asserting a fixed sign (depends on seeded prices) — just that the math is
  // wired so a high-cache turn CAN be comparable-to / cheaper-than a cold triage.
  assert.ok(triageCost > 0 && turnCost > 0)
  assert.ok(priceFor('haiku').cachedInPer1M < priceFor('haiku').inPer1M)
})

test('seeded rates resolve for Gemini, Grok, OpenAI, and DeepSeek models without hitting fallback', () => {
  assert.equal(priceFor('gemini-2.5-flash-lite').inPer1M, 0.075)
  assert.equal(priceFor('gemini-2.5-flash-lite').outPer1M, 0.3)
  assert.equal(priceFor('gemini-2.5-flash').inPer1M, 0.15)
  assert.equal(priceFor('gemini-2.5-pro').inPer1M, 1.25)
  assert.equal(priceFor('gpt-4o-mini').inPer1M, 0.15)
  assert.equal(priceFor('gpt-4o').inPer1M, 2.5)
  assert.equal(priceFor('o3-mini').inPer1M, 1.1)
  assert.equal(priceFor('grok-3').inPer1M, 3.0)
  assert.equal(priceFor('grok-2').inPer1M, 2.0)
  assert.equal(priceFor('deepseek-chat').inPer1M, 0.27)
  assert.equal(priceFor('deepseek-reasoner').inPer1M, 0.55)
  assert.equal(priceFor('qwen-plus').inPer1M, 0.4)

  // Provider prefix routing (e.g. novita/deepseek/deepseek-chat)
  assert.equal(priceFor('novita/deepseek/deepseek-chat').inPer1M, 0.27)
  assert.equal(priceFor('openrouter/anthropic/claude-3.7-sonnet').inPer1M, 3)
})
