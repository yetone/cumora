/**
 * Token → cost accounting for the triage cost-effectiveness measurement.
 *
 * The whole point of this module is to compare, HONESTLY, the cost of a small-
 * brain triage against the big-brain turn it shields. That comparison is only
 * fair when it is CACHE-AWARE: a triage runs in a fresh, cold session so EVERY
 * input token is billed at the full (uncached) rate, whereas a persistent big-
 * brain session reads most of its input from the prompt cache at ~0.1× the
 * price. So a "saving" can secretly be a loss. We price each tier separately.
 *
 * Prices are per 1M tokens, in USD, list prices. For BYOA agents the operator
 * pays a flat-rate subscription, so the dollar figure here is "meter-equivalent"
 * — what the same computation WOULD cost on the metered API — which is the
 * honest basis for "is this triage worth it". Override real contracted rates via
 * the CUMORA_MODEL_PRICES_JSON env (a JSON map of modelId → price); only those
 * count as `verified` — every seeded default is reported as an estimate.
 */

/** A cache-aware token breakdown for one model call. All counts are the RAW
 *  (uncached) counts as the provider reports them: `inputTokens` excludes the
 *  cached portion; `cachedInputTokens` is the cache-READ portion (cheap);
 *  `cacheCreationTokens` is the cache-WRITE portion (a premium over input). */
export interface TokenUsage {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
}

export interface ModelPrice {
  inPer1M: number
  cachedInPer1M: number
  cacheWritePer1M: number
  outPer1M: number
  /** true only for prices supplied by the operator (env override) — a real
   *  contracted rate. Seeded defaults are estimates and report `estimated`. */
  verified?: boolean
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
}

// Seeded prices — ALL treated as ESTIMATES (verified: false). The claude tiers
// are Anthropic's published list prices to the best of our knowledge (cache-read
// ≈ 0.1× input, cache-write ≈ 1.25× input), but we can't verify at runtime that
// they're current for the EXACT model variant in use (e.g. a specific 4.x), and
// the gpt-5.* ids are Cumora's internal cloud aliases whose true upstream rate we
// don't know at all. So nothing here is presented as authoritative: a figure is
// only `verified` (non-estimated) when the OPERATOR supplies the real contracted
// rate via CUMORA_MODEL_PRICES_JSON. Everything else surfaces as an estimate.
const SEED_PRICES: Record<string, ModelPrice> = {
  // OpenAI cloud aliases & models
  'gpt-5.5':        { inPer1M: 2.5,  cachedInPer1M: 0.25,  cacheWritePer1M: 2.5,  outPer1M: 10,   verified: false },
  'gpt-5.4-mini':   { inPer1M: 0.25, cachedInPer1M: 0.025, cacheWritePer1M: 0.25, outPer1M: 2,    verified: false },
  'gpt-4o-mini':    { inPer1M: 0.15, cachedInPer1M: 0.075, cacheWritePer1M: 0.15, outPer1M: 0.6,  verified: false },
  'gpt-4o':         { inPer1M: 2.5,  cachedInPer1M: 1.25,  cacheWritePer1M: 2.5,  outPer1M: 10,   verified: false },
  'o3-mini':        { inPer1M: 1.1,  cachedInPer1M: 0.55,  cacheWritePer1M: 1.1,  outPer1M: 4.4,  verified: false },
  'o1-mini':        { inPer1M: 1.1,  cachedInPer1M: 0.55,  cacheWritePer1M: 1.1,  outPer1M: 4.4,  verified: false },
  'o1':             { inPer1M: 15,   cachedInPer1M: 7.5,   cacheWritePer1M: 15,   outPer1M: 60,   verified: false },
  // Claude — Anthropic published list prices (input / cache-read = "cache hits &
  // refreshes" / 5m cache-write / output, per 1M). Matched by substring so version
  // suffixes resolve. Legacy Opus 4.0/4.1 ($15/$75) are listed BEFORE the general
  // `claude-opus` so the specific version wins; current Opus (4.5–4.8) is cheaper
  // ($5/$25). Haiku here = Haiku 4.5 ($1/$5); Sonnet 4.x = $3/$15.
  'claude-opus-4-1': { inPer1M: 15,  cachedInPer1M: 1.5,   cacheWritePer1M: 18.75, outPer1M: 75,  verified: false },
  'claude-opus':     { inPer1M: 5,   cachedInPer1M: 0.5,   cacheWritePer1M: 6.25,  outPer1M: 25,  verified: false },
  'claude-sonnet':   { inPer1M: 3,   cachedInPer1M: 0.3,   cacheWritePer1M: 3.75,  outPer1M: 15,  verified: false },
  'claude-haiku':    { inPer1M: 1,   cachedInPer1M: 0.1,   cacheWritePer1M: 1.25,  outPer1M: 5,   verified: false },
  // Google Gemini — published list rates
  'gemini-2.5-flash-lite': { inPer1M: 0.075, cachedInPer1M: 0.01875, cacheWritePer1M: 0.075, outPer1M: 0.3, verified: false },
  'gemini-2.5-flash':      { inPer1M: 0.15,  cachedInPer1M: 0.0375,  cacheWritePer1M: 0.15,  outPer1M: 0.6, verified: false },
  'gemini-2.5-pro':        { inPer1M: 1.25,  cachedInPer1M: 0.3125,  cacheWritePer1M: 1.25,  outPer1M: 5,   verified: false },
  'gemini-1.5-flash':      { inPer1M: 0.075, cachedInPer1M: 0.01875, cacheWritePer1M: 0.075, outPer1M: 0.3, verified: false },
  'gemini-1.5-pro':        { inPer1M: 1.25,  cachedInPer1M: 0.3125,  cacheWritePer1M: 1.25,  outPer1M: 5,   verified: false },
  'gemini-flash':          { inPer1M: 0.15,  cachedInPer1M: 0.0375,  cacheWritePer1M: 0.15,  outPer1M: 0.6, verified: false },
  'gemini-pro':            { inPer1M: 1.25,  cachedInPer1M: 0.3125,  cacheWritePer1M: 1.25,  outPer1M: 5,   verified: false },
  // xAI Grok
  'grok-3':                { inPer1M: 3.0,   cachedInPer1M: 0.75,    cacheWritePer1M: 3.0,   outPer1M: 15.0, verified: false },
  'grok-2':                { inPer1M: 2.0,   cachedInPer1M: 0.5,     cacheWritePer1M: 2.0,   outPer1M: 10.0, verified: false },
  // DeepSeek & Qwen
  'deepseek-reasoner':     { inPer1M: 0.55,  cachedInPer1M: 0.14,    cacheWritePer1M: 0.55,  outPer1M: 2.19, verified: false },
  'deepseek-chat':         { inPer1M: 0.27,  cachedInPer1M: 0.07,    cacheWritePer1M: 0.27,  outPer1M: 1.1,  verified: false },
  'qwen-plus':             { inPer1M: 0.4,   cachedInPer1M: 0.1,     cacheWritePer1M: 0.4,   outPer1M: 1.2,  verified: false },
  'qwen-turbo':            { inPer1M: 0.05,  cachedInPer1M: 0.0125,  cacheWritePer1M: 0.05,  outPer1M: 0.2,  verified: false },
  'qwen-max':              { inPer1M: 1.6,   cachedInPer1M: 0.4,     cacheWritePer1M: 1.6,   outPer1M: 4.8,  verified: false },
}

// Last-resort rate for an unrecognized model: mid-tier, ALWAYS flagged estimated.
const FALLBACK_PRICE: ModelPrice = { inPer1M: 3, cachedInPer1M: 0.3, cacheWritePer1M: 3.75, outPer1M: 15, verified: false }

let envOverrides: Record<string, ModelPrice> | null = null
function overrides(): Record<string, ModelPrice> {
  if (envOverrides) return envOverrides
  envOverrides = {}
  const raw = process.env.CUMORA_MODEL_PRICES_JSON
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>
      for (const [id, p] of Object.entries(parsed)) {
        envOverrides[id] = {
          inPer1M: Number(p.inPer1M ?? 0),
          cachedInPer1M: Number(p.cachedInPer1M ?? 0),
          cacheWritePer1M: Number(p.cacheWritePer1M ?? 0),
          outPer1M: Number(p.outPer1M ?? 0),
          verified: true, // operator-supplied = a real rate
        }
      }
    } catch (err) {
      console.warn('[cost] CUMORA_MODEL_PRICES_JSON is not valid JSON — ignoring:', err instanceof Error ? err.message : err)
    }
  }
  return envOverrides
}

/** Resolve the price for a model id: env override (exact) → seeded exact → seeded
 *  family substring → fallback. */
export function priceFor(model: string | null | undefined): ModelPrice {
  const id = (model ?? '').toLowerCase().trim()
  if (!id) return FALLBACK_PRICE
  // Match in BOTH directions: a full id like "claude-sonnet-4-6" contains the seed
  // key "claude-sonnet", while a bare tier id like "haiku" is contained BY the seed
  // key "claude-haiku". Checking only one direction mispriced bare ids (e.g. the
  // triage model "haiku" fell through to the fallback = sonnet rate).
  const matches = (key: string): boolean => { const k = key.toLowerCase(); return id === k || id.includes(k) || k.includes(id) }
  const ov = overrides()
  if (ov[id]) return ov[id]
  for (const [key, price] of Object.entries(ov)) if (matches(key)) return price
  if (SEED_PRICES[id]) return SEED_PRICES[id]
  for (const [key, price] of Object.entries(SEED_PRICES)) if (matches(key)) return price
  return FALLBACK_PRICE
}

/** The full known price menu (seeded tiers + any operator env overrides), for a
 *  UI reference table so users can see exactly what each model costs. `estimated`
 *  is true for everything except operator-supplied (CUMORA_MODEL_PRICES_JSON) rates. */
export function modelPriceTable(): Array<{
  model: string; inPer1M: number; cachedInPer1M: number; cacheWritePer1M: number; outPer1M: number; estimated: boolean
}> {
  const rows: Array<{ model: string; inPer1M: number; cachedInPer1M: number; cacheWritePer1M: number; outPer1M: number; estimated: boolean }> = []
  const add = (model: string, p: ModelPrice): void => {
    if (rows.some((r) => r.model === model)) return
    rows.push({ model, inPer1M: p.inPer1M, cachedInPer1M: p.cachedInPer1M, cacheWritePer1M: p.cacheWritePer1M, outPer1M: p.outPer1M, estimated: p.verified !== true })
  }
  for (const [model, p] of Object.entries(overrides())) add(model, p)
  for (const [model, p] of Object.entries(SEED_PRICES)) add(model, p)
  return rows
}

/** Cache-aware effective cost in USD for one model call. `estimated` is true when
 *  the price is a seeded guess / fallback rather than an operator-supplied rate —
 *  surface it in the UI so the dollar figure is never mistaken for a real bill. */
export function effectiveCostUsd(model: string | null | undefined, usage: TokenUsage): { usd: number; estimated: boolean } {
  const p = priceFor(model)
  const usd =
    (usage.inputTokens * p.inPer1M +
      usage.cachedInputTokens * p.cachedInPer1M +
      usage.cacheCreationTokens * p.cacheWritePer1M +
      usage.outputTokens * p.outPer1M) / 1_000_000
  return { usd, estimated: p.verified !== true }
}

/** Total cost expressed in "uncached-input-token equivalents" — a price-free way
 *  to compare calls on one scale (how many fresh input tokens this call's spend
 *  is worth at the model's own rates). Useful when the operator distrusts the $. */
export function inputEquivalentTokens(model: string | null | undefined, usage: TokenUsage): number {
  const p = priceFor(model)
  if (p.inPer1M <= 0) return usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationTokens + usage.outputTokens
  const { usd } = effectiveCostUsd(model, usage)
  return Math.round((usd * 1_000_000) / p.inPer1M)
}

/** Cache-hit rate = cache-read input / total input tokens (0..1). NaN-safe → 0. */
export function cacheHitRate(usage: TokenUsage): number {
  const totalInput = usage.inputTokens + usage.cachedInputTokens
  return totalInput > 0 ? usage.cachedInputTokens / totalInput : 0
}

/** The subset of provider usage fields we read (OpenAI Responses + Anthropic). */
interface RawUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Map an OpenAI Responses `usage` to cache-aware TokenUsage. OpenAI's
 *  `input_tokens` is the TOTAL input INCLUDING the cached portion, so we subtract
 *  `input_tokens_details.cached_tokens` to get the uncached part. OpenAI auto-
 *  caches with no separate write charge → cacheCreationTokens = 0. */
export function usageFromOpenAI(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as RawUsage
  const total = Number(u.input_tokens ?? 0)
  const cached = Number(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0)
  return {
    inputTokens: Math.max(0, total - cached),
    cachedInputTokens: cached,
    cacheCreationTokens: 0,
    outputTokens: Number(u.output_tokens ?? 0),
  }
}

/** Map an Anthropic / Claude Code stream-json `usage` to TokenUsage. Anthropic's
 *  `input_tokens` already EXCLUDES the cached read/write portions, which are
 *  reported separately as cache_read_input_tokens / cache_creation_input_tokens. */
export function usageFromClaude(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as RawUsage
  return {
    inputTokens: Number(u.input_tokens ?? 0),
    cachedInputTokens: Number(u.cache_read_input_tokens ?? 0),
    cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
  }
}

/** Sum two usages (accumulate across the multiple model hops of one turn). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}

/** True when there's any token signal at all (distinguishes "measured but zero"
 *  from "no usage reported", e.g. codex). */
export function hasUsage(u: TokenUsage): boolean {
  return u.inputTokens + u.cachedInputTokens + u.cacheCreationTokens + u.outputTokens > 0
}
