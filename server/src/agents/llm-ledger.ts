/**
 * Universal sub2api / cloud-LLM call ledger.
 *
 * Why this exists:
 *   Before this module, only the main agent turn (`agent_runs`) and the inbox
 *   triage gate (`agent_triages`) were observable per-call. Every other sub2api
 *   spend — auto-compaction, completion-verify, steer-summary, convene
 *   speech/decision, palette, gender inference, avatar image-gen — was rolled
 *   into "part of the turn total" or wasn't recorded at all. That made it
 *   impossible to answer the question the operator actually needs:
 *
 *     "Which business purpose burned the most gpt-5.4-mini last month?"
 *
 * Design contract:
 *   1. One row in `llm_calls` per OUTBOUND model call. Every cloud LLM spend
 *      is attributable to a single `purpose` + tenant + agent + (optional) run.
 *   2. Recording is FIRE-AND-FORGET; a DB hiccup MUST NEVER fail the LLM call
 *      itself. Every error path here is caught and logged, never re-thrown.
 *   3. The PRIMARY entry point is `getTrackedLlmClient(ctx)` — it returns the
 *      same shape as `getLlmClient()` but auto-records every
 *      `responses.create`, `chat.completions.create`, and `images.generate`
 *      against the bound context. Forgetting it for a NEW callsite is caught
 *      at CI by `scripts/guard-llm-tracked.mjs`.
 *   4. Streaming calls (only the main agent turn today) can't surface final
 *      usage on the create() return — usage arrives on the stream as
 *      `response.completed.usage`. Those callsites stay on `getLlmClient()`
 *      directly AND manually call `recordLlmCall()` per hop from inside their
 *      stream consumer, where final usage is known. Same ledger row shape,
 *      different timing. The CI guard's allowlist documents these exceptions.
 *
 * What this is NOT for:
 *   - BYOA-local LLM calls (the operator's paired engine CLI). Those
 *     are billed against the operator's own subscription, not Cumora's sub2api,
 *     and are already accounted for in `agent_triages` (BYOA triage rows) +
 *     `agent_runs` (BYOA turn rows) with `source='byoa-*'`. Putting them into
 *     `llm_calls` would muddy the "sub2api spend" rollup that's the whole
 *     point. If we later want a unified ledger across cloud + BYOA, that's a
 *     separate, additive widening.
 */

import { randomUUID } from 'node:crypto'
import type OpenAI from 'openai'
import { pool } from '../db/pool.js'
import { getLlmClient } from '../llm.js'
import { effectiveCostUsd, priceFor, usageFromOpenAI, EMPTY_USAGE, type TokenUsage } from './cost.js'

/** The exhaustive set of business purposes that spend sub2api. Adding a new
 *  callsite REQUIRES adding its purpose here — that's the discipline knob that
 *  makes the ledger a complete picture. */
export type LlmCallPurpose =
  // Big-model real tasks (sanctioned by model-policy.ts).
  | 'agent-turn'
  | 'convene-speech'
  // Small-model cerebellum classifiers — the gpt-5.4-mini hot path.
  | 'inbox-triage'
  | 'synthetic-wake-gate'
  | 'agenda'
  | 'compaction'
  | 'completion-verify'
  | 'steer-summary'
  | 'convene-decision'
  // One-shot utilities (rare per call, but unaccounted before this ledger).
  | 'palette'
  | 'gender'
  // Image generation — two distinct cost drivers:
  //   - 'avatar-image' fires at agent CREATION (or explicit avatar regen).
  //   - 'agent-image'  fires when an agent uses the image-gen tool mid-turn.
  // Bundle them under one purpose makes the "why did images cost $X?" rollup
  // impossible — they're driven by completely different actions.
  | 'avatar-image'
  | 'agent-image'

export type LlmCallStatus = 'ok' | 'rate_limited' | 'timeout' | 'failed'
export type LlmCallSource = 'cloud' | 'byoa-claude' | 'byoa-codex' | 'byoa-grok' | 'byoa-cursor' | 'byoa-opencode' | 'byoa-pi'

/** Context bound to a tracked client. Every LLM call it makes carries this
 *  shape into the ledger. `purpose` is mandatory; everything else scopes the
 *  row to a tenant / agent / run / conversation for slice-and-dice queries. */
export interface LlmCallContext {
  purpose: LlmCallPurpose
  companyId: string | null
  agentId?: string | null
  runId?: string | null
  conversationId?: string | null
  /** Free-form purpose-specific labels (e.g. compaction's `historyTokensBefore`,
   *  triage's `actionable`). Goes into the `extras` JSONB column. */
  extras?: Record<string, unknown>
}

/** A fully-resolved ledger record. Returned-shape used by both the tracked
 *  client and direct `recordLlmCall()` callers (e.g. the streaming turn). */
export interface LlmCallRecord extends LlmCallContext {
  source?: LlmCallSource
  model: string
  /** null/undefined → call ran but provider gave no usage (recorded as zeros,
   *  measured=false). The cost will be 0 in that case — we never guess. */
  usage?: TokenUsage | null
  reasoningTokens?: number
  latencyMs: number
  status: LlmCallStatus
  error?: string | null
  /** The agent-cli (npm `cumora`) version that produced this row, captured by
   *  the daemon and sent in its `/runtime/llm-calls` / `/runtime/triage`
   *  payload. Cloud rows (no daemon) leave it null. Used by the operator to
   *  correlate spend / cache behaviour with a daemon release — when a new
   *  version regresses token usage, the per-version rollup makes it visible. */
  daemonVersion?: string | null
}

/** Single INSERT into `llm_calls`. Never throws — the ledger is observability,
 *  not a hard dependency of the call path. */
export async function recordLlmCall(rec: LlmCallRecord): Promise<void> {
  const measured = !!rec.usage
  const usage = rec.usage ?? EMPTY_USAGE
  // Cost is computed at insert time so the row is meaningful on its own.
  // A later operator price change re-prices new rows only; if we later want
  // back-fill, the breakdown is preserved so a recompute is one UPDATE away.
  const cost = effectiveCostUsd(rec.model, usage)
  try {
    await pool.query(
      `INSERT INTO llm_calls (
         id, company_id, agent_id, run_id, conversation_id,
         purpose, source, model,
         input_tokens, cached_input_tokens, cache_creation_tokens,
         output_tokens, reasoning_tokens,
         cost_usd, cost_estimated, measured,
         latency_ms, status, error, extras, daemon_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21)`,
      [
        `llm-${randomUUID()}`,
        rec.companyId, rec.agentId ?? null, rec.runId ?? null, rec.conversationId ?? null,
        rec.purpose, rec.source ?? 'cloud', rec.model,
        usage.inputTokens, usage.cachedInputTokens, usage.cacheCreationTokens,
        usage.outputTokens, rec.reasoningTokens ?? 0,
        measured ? cost.usd : 0, cost.estimated, measured,
        rec.latencyMs, rec.status,
        rec.error ? rec.error.slice(0, 500) : null,
        rec.extras ? JSON.stringify(rec.extras) : null,
        rec.daemonVersion ?? null,
      ],
    )
  } catch (err) {
    console.warn('[llm-ledger] insert failed — dropping', err instanceof Error ? err.message : err)
  }
}

/** Classify a thrown LLM error into one of the ledger's `status` buckets.
 *  Rate-limit detection mirrors `triage-core.isRateLimited` and the inbox-triage
 *  fail-closed branch so the same kinds of failures get the same label here.
 *  Exported because streaming callsites (turn.ts) record manually and need the
 *  same classification rules. */
export function classifyLlmCallError(err: unknown): LlmCallStatus {
  const status = (err as { status?: number } | null)?.status
  const msg = err instanceof Error ? err.message : String(err)
  if (status === 429 || status === 503 || /rate.?limit|quota|too many requests|overload/i.test(msg)) return 'rate_limited'
  if ((err as { name?: string } | null)?.name === 'AbortError' || /timeout|aborted|ETIMEDOUT|deadline/i.test(msg)) return 'timeout'
  return 'failed'
}

/** Pull final usage out of an OpenAI Responses streaming event. Streaming
 *  callsites (turn.ts: completion-verify, compaction, steer-summary, the main
 *  agent turn) consume the stream themselves and read this on every event;
 *  the LAST non-null result is the call's final usage. Returns null for events
 *  that don't carry usage (the vast majority — only `response.completed`
 *  carries the totals). */
export function readStreamUsage(ev: { type?: string } & Record<string, unknown>): TokenUsage | null {
  if (ev.type !== 'response.completed') return null
  // The event's `response` field is the full Response object, whose `usage`
  // field is the same shape that non-streaming responses.create() returns —
  // so we re-use the same mapper.
  const r = (ev as { response?: { usage?: unknown } }).response
  if (!r?.usage) return null
  return usageFromOpenAI(r.usage)
}

/** Like readStreamUsage but for `output_tokens_details.reasoning_tokens` on
 *  the completed event — surfaces non-zero reasoning spend separately. */
export function readStreamReasoningTokens(ev: { type?: string } & Record<string, unknown>): number {
  if (ev.type !== 'response.completed') return 0
  const r = (ev as { response?: { usage?: unknown } }).response
  return r?.usage ? readReasoningTokens(r.usage) : 0
}

/** OpenAI Responses surfaces reasoning tokens (when on) under
 *  `output_tokens_details.reasoning_tokens`. NaN-safe → 0. */
function readReasoningTokens(usage: unknown): number {
  const u = (usage ?? {}) as { output_tokens_details?: { reasoning_tokens?: number } }
  const n = Number(u.output_tokens_details?.reasoning_tokens ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** Loose-typed shape we pass through; we only read `.model` / `.stream` /
 *  `.n` / `.size` to bind ledger context — we don't need to know the SDK's
 *  full request schema. */
type AnyArgs = { model?: string; stream?: boolean; n?: number; size?: string } & Record<string, unknown>
type AnyResponse = { usage?: unknown } & Record<string, unknown>

/** Returns a tracked OpenAI client. Wraps `responses.create`,
 *  `chat.completions.create`, and `images.generate` so every call is recorded
 *  to `llm_calls` under `ctx.purpose`. Everything else passes through.
 *
 *  Streaming (`{ stream: true }` on responses.create): we DO NOT record from
 *  here — usage isn't on the synchronous return, it arrives on the stream.
 *  Streaming callsites (today: only the main agent turn) must call
 *  `recordLlmCall()` themselves from inside their stream consumer. This is
 *  enforced by `scripts/guard-llm-tracked.mjs` allowlist.
 */
export async function getTrackedLlmClient(ctx: LlmCallContext): Promise<OpenAI> {
  const raw = await getLlmClient(ctx.companyId)

  // Wrap an awaited create() with timing + ledger. Used by responses & chat.
  const wrapAwaited = (
    boundCreate: (args: AnyArgs, opts?: unknown) => Promise<AnyResponse>,
  ) =>
    async (args: AnyArgs, opts?: unknown): Promise<AnyResponse> => {
      const t0 = Date.now()
      const model = String(args.model ?? '<unknown>')
      // Streaming: hand the stream back unwrapped, ledger is the caller's job.
      // We don't even record a placeholder — duplicate rows on a failed stream
      // (one here, one in finishAgentRun) would muddy per-purpose rollups.
      if (args.stream === true) {
        return await boundCreate(args, opts)
      }
      try {
        const r = await boundCreate(args, opts)
        void recordLlmCall({
          ...ctx, model,
          usage: usageFromOpenAI(r.usage),
          reasoningTokens: readReasoningTokens(r.usage),
          latencyMs: Date.now() - t0, status: 'ok',
        })
        return r
      } catch (err) {
        void recordLlmCall({
          ...ctx, model, usage: null,
          latencyMs: Date.now() - t0,
          status: classifyLlmCallError(err),
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

  // Images don't surface token usage; we still record latency/status + tag
  // `extras.n` / `extras.size` so per-image spend is countable (cost is
  // resolved by image-model rate in cost.ts, currently 0 since we haven't
  // seeded image prices — a known gap, flagged via cost_estimated=true).
  const wrapImagesGenerate = (
    boundGenerate: (args: AnyArgs, opts?: unknown) => Promise<AnyResponse>,
  ) =>
    async (args: AnyArgs, opts?: unknown): Promise<AnyResponse> => {
      const t0 = Date.now()
      const model = String(args.model ?? '<unknown>')
      try {
        const r = await boundGenerate(args, opts)
        void recordLlmCall({
          ...ctx, model, usage: null,
          latencyMs: Date.now() - t0, status: 'ok',
          extras: { ...(ctx.extras ?? {}), n: args.n ?? 1, size: args.size },
        })
        return r
      } catch (err) {
        void recordLlmCall({
          ...ctx, model, usage: null,
          latencyMs: Date.now() - t0,
          status: classifyLlmCallError(err),
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    }

  // Layered Proxy: only the methods we care about are intercepted; everything
  // else (e.g. embeddings, audio, beta) passes through unwrapped so adding a
  // new SDK area doesn't require touching this file (it just won't be tracked
  // until you teach the wrapper — and the CI guard will surface that gap).
  return new Proxy(raw, {
    get(target, prop, receiver): unknown {
      if (prop === 'responses') {
        return new Proxy(target.responses as object, {
          get(rt: object, p: string | symbol, rr: unknown): unknown {
            if (p === 'create') {
              const create = (target.responses as { create: (...a: unknown[]) => Promise<unknown> }).create
              return wrapAwaited(create.bind(target.responses) as (a: AnyArgs, o?: unknown) => Promise<AnyResponse>)
            }
            return Reflect.get(rt, p, rr)
          },
        })
      }
      if (prop === 'chat') {
        return new Proxy(target.chat as object, {
          get(ct: object, p: string | symbol, cr: unknown): unknown {
            if (p === 'completions') {
              return new Proxy((target.chat as { completions: object }).completions, {
                get(cct: object, pp: string | symbol, ccr: unknown): unknown {
                  if (pp === 'create') {
                    const create = ((target.chat as { completions: { create: (...a: unknown[]) => Promise<unknown> } }).completions).create
                    return wrapAwaited(create.bind((target.chat as { completions: object }).completions) as (a: AnyArgs, o?: unknown) => Promise<AnyResponse>)
                  }
                  return Reflect.get(cct, pp, ccr)
                },
              })
            }
            return Reflect.get(ct, p, cr)
          },
        })
      }
      if (prop === 'images') {
        return new Proxy(target.images as object, {
          get(it: object, p: string | symbol, ir: unknown): unknown {
            if (p === 'generate') {
              const gen = (target.images as { generate: (...a: unknown[]) => Promise<unknown> }).generate
              return wrapImagesGenerate(gen.bind(target.images) as (a: AnyArgs, o?: unknown) => Promise<AnyResponse>)
            }
            return Reflect.get(it, p, ir)
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/** Aggregate spend rollup by purpose, model, and source for a tenant over a
 *  time window. The PRIMARY answer the operator wants. */
export interface LlmSpendRollupRow {
  purpose: LlmCallPurpose
  model: string
  source: LlmCallSource
  calls: number
  okCalls: number
  failedCalls: number
  rateLimitedCalls: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  /** True when ANY row in the bucket used a non-verified (seeded/fallback)
   *  price — the rollup's dollar figure is then an estimate. */
  costEstimated: boolean
  /** Upper bound on $ savings if EVERY input token were served from cache at
   *  the row's model rate. Aspirational (cold one-shots can't cache), but
   *  it's the only honest "money on the table" signal — operator can sort by
   *  it on the rollup to find the biggest optimization target. */
  savableUsd: number
}

/** A single column on the global-admin summary card row. The admin dashboard
 *  shows four of these in a hero grid: total cost, total calls, top purpose
 *  (by $), failure rate. Computed in one round-trip query. */
export interface LlmSummary {
  /** Inclusive lower bound used by all four numbers. */
  sinceDays: number
  totalCalls: number
  totalCostUsd: number
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
  failureRate: number          // 0..1 — calls with status != 'ok' / totalCalls
  rateLimitedCalls: number
  topPurpose: { purpose: LlmCallPurpose; costUsd: number } | null
  /** Distinct tenants that spent anything in the window. */
  activeTenants: number
  /** Overall cache hit rate over the window: cachedInputTokens /
   *  (inputTokens + cachedInputTokens). Null when there's no input traffic at
   *  all (e.g. empty window or image-only). This is the single best
   *  optimization knob — every cached input token costs ~10× less. */
  cacheHitRate: number | null
  /** Upper-bound $ savings if EVERY input token were cached at the model's own
   *  cached rate. Computed server-side so the page doesn't need the price
   *  table. Aspirational — not every call can realistically cache (cold one-
   *  shots like palette / gender can't), but the operator can filter and
   *  decide. */
  savableUsd: number
}

/** One bucket of the daily trend stack — used to render the timeseries chart
 *  on the admin observability page. Token columns added so the Cache Health
 *  card can compute daily cache hit rate without a second round-trip
 *  (cachedInputTokens / (inputTokens + cachedInputTokens) per day). */
export interface LlmTrendBucket {
  day: string                              // YYYY-MM-DD UTC
  purpose: LlmCallPurpose
  costUsd: number
  calls: number
  inputTokens: number                      // uncached portion (provider-native)
  cachedInputTokens: number                // cache-read portion
}

/** Top spenders — "which agents are the most expensive on the cloud?" */
export interface LlmTopAgentRow {
  agentId: string | null
  companyId: string | null
  agentName: string | null
  /** Agent portrait + colored-initial fallback, for the Top-spenders avatar. */
  agentAvatarUrl: string | null
  agentAvatarBg: string | null
  agentInitial: string | null
  /** Human-readable company name (joined from companies); null = no match. */
  companyName: string | null
  costUsd: number
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export async function getLlmSpendRollup(args: {
  companyId?: string | null
  /** Inclusive lower bound. Default: 30 days ago. */
  sinceDays?: number
  /** Optional model substring filter (e.g. 'gpt-5.4-mini'). Useful for
   *  "what burned my mini?" — exactly the question this ledger was built for. */
  model?: string | null
}): Promise<LlmSpendRollupRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  // Reads the pre-aggregated llm_calls_rollup (hourly buckets), NOT raw
  // llm_calls — ~30k rows vs ~470k, no full scan. `bucket_hour` is the rollup's
  // time axis; the per-call status FILTERs became pre-summed *_calls columns.
  let where = `bucket_hour > NOW() - ($1::int * INTERVAL '1 day')`
  if (args.companyId !== undefined) {
    params.push(args.companyId)
    // company_id IS NULL ↔ "personal-key calls"; the operator may want either.
    where += args.companyId === null ? ` AND company_id IS NULL` : ` AND company_id = $${params.length}`
  }
  if (args.model) {
    params.push(`%${args.model}%`)
    where += ` AND model ILIKE $${params.length}`
  }
  const { rows } = await pool.query<{
    purpose: string; model: string; source: string
    calls: string; ok_calls: string; failed_calls: string; rate_limited_calls: string
    input_tokens: string; cached_input_tokens: string; cache_creation_tokens: string
    output_tokens: string; reasoning_tokens: string
    cost_usd: string; cost_estimated: boolean
  }>(
    `SELECT
       purpose, model, source,
       SUM(calls)::text                                             AS calls,
       SUM(ok_calls)::text                                          AS ok_calls,
       SUM(failed_calls)::text                                      AS failed_calls,
       SUM(rate_limited_calls)::text                                AS rate_limited_calls,
       SUM(input_tokens)::text                                      AS input_tokens,
       SUM(cached_input_tokens)::text                               AS cached_input_tokens,
       SUM(cache_creation_tokens)::text                             AS cache_creation_tokens,
       SUM(output_tokens)::text                                     AS output_tokens,
       SUM(reasoning_tokens)::text                                  AS reasoning_tokens,
       COALESCE(SUM(cost_usd), 0)::text                             AS cost_usd,
       BOOL_OR(cost_estimated)                                      AS cost_estimated
     FROM llm_calls_rollup
     WHERE ${where}
     GROUP BY purpose, model, source
     ORDER BY SUM(cost_usd) DESC`,
    params,
  )
  return rows.map((r) => {
    const inputTokens = Number(r.input_tokens)
    const cachedInputTokens = Number(r.cached_input_tokens)
    // Savable $ = uncached_input × (full_rate − cached_rate). The gap between
    // what we paid and what we WOULD pay if those same tokens hit the cache.
    // Caveat: we use this row's model's published rate, so a row whose price
    // is `estimated` makes savable estimated too. Image rows have inputTokens
    // = 0 → savable = 0, which is the honest answer (image API doesn't
    // surface tokens, so we can't claim there's anything to save).
    const price = priceFor(r.model)
    const gap = Math.max(0, price.inPer1M - price.cachedInPer1M)
    const savableUsd = (inputTokens * gap) / 1_000_000
    return ({
    purpose: r.purpose as LlmCallPurpose,
    model: r.model,
    source: r.source as LlmCallSource,
    calls: Number(r.calls),
    okCalls: Number(r.ok_calls),
    failedCalls: Number(r.failed_calls),
    rateLimitedCalls: Number(r.rate_limited_calls),
    inputTokens,
    cachedInputTokens,
    cacheCreationTokens: Number(r.cache_creation_tokens),
    outputTokens: Number(r.output_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    costUsd: Number(r.cost_usd),
    costEstimated: r.cost_estimated,
    savableUsd,
    })
  })
}

/** Hero KPIs for the global admin observability dashboard.
 *
 *  Reads the pre-aggregated llm_calls_rollup (~30k hourly buckets), not raw
 *  llm_calls (~470k rows, all inside the 30d window) — so this is a small
 *  aggregate, not a full seq scan. ONE pass via GROUPING SETS ((),(company_id))
 *  yields both the grand totals and the active-tenant count.
 *
 *  `topPurpose` + `savableUsd` are NOT computed here — the endpoint derives them
 *  from the `rollup` slice it already fetches in parallel (per-purpose×model
 *  with cost + per-row savable), so they cost nothing extra. Hence this returns
 *  everything EXCEPT those two; the caller assembles the full LlmSummary. */
export async function getLlmSummary(args: { sinceDays?: number; companyId?: string | null } = {}): Promise<Omit<LlmSummary, 'topPurpose' | 'savableUsd'>> {
  const sinceDays = args.sinceDays ?? 30
  // Optional per-tenant scope. `null` = personal-key calls; `undefined` (or
  // omitted) = all tenants. Same semantics as getLlmSpendRollup so the page
  // can wire ONE filter through every aggregation consistently.
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND company_id IS NULL`
    else { params.push(args.companyId); scope = `AND company_id = $${params.length}` }
  }
  const where = `bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}`
  // Reads the pre-aggregated rollup (~30k rows), not raw llm_calls. ONE pass via
  // GROUPING SETS ((), (company_id)): the grand-total row (is_total=1) gives
  // every flat aggregate, the per-company rows (is_total=0, company_id NOT NULL)
  // are COUNTED for active-tenants. GROUPING() distinguishes the super-aggregate
  // NULL from a real NULL company_id so personal-key rows can't masquerade as a
  // tenant. Per-call status FILTERs are now pre-summed *_calls columns.
  const { rows } = await pool.query<{
    is_total: number; company_id: string | null
    calls: string; cost_usd: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
    failed_calls: string; rate_limited_calls: string
  }>(
    `SELECT GROUPING(company_id)                AS is_total,
            company_id,
            SUM(calls)                          AS calls,
            COALESCE(SUM(cost_usd), 0)          AS cost_usd,
            SUM(input_tokens)                   AS input_tokens,
            SUM(cached_input_tokens)            AS cached_input_tokens,
            SUM(output_tokens)                  AS output_tokens,
            SUM(failed_calls)                   AS failed_calls,
            SUM(rate_limited_calls)             AS rate_limited_calls
       FROM llm_calls_rollup
      WHERE ${where}
      GROUP BY GROUPING SETS ((), (company_id))`,
    params,
  )
  const total = rows.find((r) => Number(r.is_total) === 1)
  const activeTenants = rows.reduce((n, r) => n + (Number(r.is_total) === 0 && r.company_id !== null ? 1 : 0), 0)
  const totalCalls = Number(total?.calls ?? 0)
  const failed = Number(total?.failed_calls ?? 0)
  const totalInputTokens = Number(total?.input_tokens ?? 0)
  const totalCachedInputTokens = Number(total?.cached_input_tokens ?? 0)
  const denom = totalInputTokens + totalCachedInputTokens
  const cacheHitRate = denom > 0 ? totalCachedInputTokens / denom : null
  return {
    sinceDays,
    totalCalls,
    totalCostUsd: Number(total?.cost_usd ?? 0),
    totalInputTokens,
    totalCachedInputTokens,
    totalOutputTokens: Number(total?.output_tokens ?? 0),
    failureRate: totalCalls > 0 ? failed / totalCalls : 0,
    rateLimitedCalls: Number(total?.rate_limited_calls ?? 0),
    activeTenants,
    cacheHitRate,
  }
}

/** Daily-bucketed cost & call counts per purpose — feeds the stacked area
 *  chart so the operator can see a spike "yesterday compaction blew up" at a
 *  glance. UTC days so the same day boundary regardless of where the operator
 *  is. Returned dense per (day, purpose) only where there's at least one
 *  call — caller can left-join to a date series if it needs zero rows. */
export async function getLlmDailyTrend(args: { sinceDays?: number; companyId?: string | null } = {}): Promise<LlmTrendBucket[]> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND company_id IS NULL`
    else { params.push(args.companyId); scope = `AND company_id = $${params.length}` }
  }
  // Daily buckets roll up from the hourly rollup's bucket_hour — date_trunc to
  // the UTC day and re-aggregate the (already-summed) hourly metrics.
  const { rows } = await pool.query<{ day: string; purpose: string; cost_usd: string; calls: string; input_tokens: string; cached_input_tokens: string }>(
    `SELECT to_char(date_trunc('day', bucket_hour AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            purpose,
            COALESCE(SUM(cost_usd), 0)::text             AS cost_usd,
            SUM(calls)::text                             AS calls,
            SUM(input_tokens)::text                      AS input_tokens,
            SUM(cached_input_tokens)::text               AS cached_input_tokens
       FROM llm_calls_rollup
      WHERE bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}
      GROUP BY day, purpose
      ORDER BY day ASC, cost_usd DESC`,
    params,
  )
  return rows.map((r) => ({
    day: r.day,
    purpose: r.purpose as LlmCallPurpose,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
  }))
}

/** One company that has any ledger activity in the window. Used to feed the
 *  Observability page's tenant picker — operator types into a search input
 *  and we narrow this list, no full-table COUNT(DISTINCT) on each keystroke. */
export interface LlmTenantRow {
  companyId: string
  name: string | null
  slug: string | null
  costUsd: number
  calls: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export async function getLlmTenants(args: { sinceDays?: number; limit?: number } = {}): Promise<LlmTenantRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const limit = Math.max(1, Math.min(500, args.limit ?? 100))
  // Aggregates the rollup (l = llm_calls_rollup), joining companies for
  // human-readable names + slugs; activity-less companies are excluded by the
  // inner GROUP (no rollup row → no row here).
  const { rows } = await pool.query<{
    company_id: string; name: string | null; slug: string | null; cost_usd: string; calls: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
  }>(
    `SELECT l.company_id,
            c.name, c.slug,
            COALESCE(SUM(l.cost_usd), 0)::text             AS cost_usd,
            SUM(l.calls)::text                             AS calls,
            SUM(l.input_tokens)::text                      AS input_tokens,
            SUM(l.cached_input_tokens)::text               AS cached_input_tokens,
            SUM(l.output_tokens)::text                     AS output_tokens
       FROM llm_calls_rollup l
       LEFT JOIN companies c ON c.id = l.company_id
      WHERE l.bucket_hour > NOW() - ($1::int * INTERVAL '1 day')
        AND l.company_id IS NOT NULL
      GROUP BY l.company_id, c.name, c.slug
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST
      LIMIT $2`,
    [sinceDays, limit],
  )
  return rows.map((r) => ({
    companyId: r.company_id,
    name: r.name,
    slug: r.slug,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
  }))
}

/** Top spenders — joins agents' display names so the admin table is
 *  human-readable. Anonymous (no agent_id) calls are bucketed as one row at
 *  the bottom (e.g. avatar-image at agent creation has no agent_id yet). */
export async function getLlmTopAgents(args: { sinceDays?: number; limit?: number; companyId?: string | null } = {}): Promise<LlmTopAgentRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const limit = Math.max(1, Math.min(200, args.limit ?? 20))
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND l.company_id IS NULL`
    else { params.push(args.companyId); scope = `AND l.company_id = $${params.length}` }
  }
  params.push(limit)
  const { rows } = await pool.query<{
    agent_id: string | null; company_id: string | null; agent_name: string | null
    agent_avatar_url: string | null; agent_avatar_bg: string | null; agent_initial: string | null
    company_name: string | null
    cost_usd: string; calls: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
  }>(
    `SELECT l.agent_id, l.company_id,
            p.name AS agent_name,
            p.avatar_url AS agent_avatar_url,
            p.avatar_bg  AS agent_avatar_bg,
            p.initial    AS agent_initial,
            c.name       AS company_name,
            COALESCE(SUM(l.cost_usd), 0)::text          AS cost_usd,
            SUM(l.calls)::text                          AS calls,
            SUM(l.input_tokens)::text                   AS input_tokens,
            SUM(l.cached_input_tokens)::text            AS cached_input_tokens,
            SUM(l.output_tokens)::text                  AS output_tokens
       FROM llm_calls_rollup l
       LEFT JOIN participants p
              ON p.id = l.agent_id
             AND (p.company_id = l.company_id OR (p.company_id IS NULL AND l.company_id IS NULL))
       LEFT JOIN companies c ON c.id = l.company_id
      WHERE l.bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}
      GROUP BY l.agent_id, l.company_id, p.name, p.avatar_url, p.avatar_bg, p.initial, c.name
      ORDER BY SUM(l.cost_usd) DESC NULLS LAST
      LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => ({
    agentId: r.agent_id,
    companyId: r.company_id,
    agentName: r.agent_name,
    agentAvatarUrl: r.agent_avatar_url,
    agentAvatarBg: r.agent_avatar_bg,
    agentInitial: r.agent_initial,
    companyName: r.company_name,
    costUsd: Number(r.cost_usd),
    calls: Number(r.calls),
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    outputTokens: Number(r.output_tokens),
  }))
}

/** One raw call row, surfaced by the drill-down panel so the operator can see
 *  EXACTLY which calls drove a bucket's spend. All the fields they'd write SQL
 *  to get — incl. the extras JSONB expanded — without writing SQL. */
export interface LlmCallRow {
  id: string
  createdAt: string
  companyId: string | null
  agentId: string | null
  agentName: string | null
  runId: string | null
  conversationId: string | null
  purpose: LlmCallPurpose
  source: LlmCallSource
  model: string
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  costEstimated: boolean
  measured: boolean
  latencyMs: number | null
  status: LlmCallStatus
  error: string | null
  extras: Record<string, unknown> | null
  /** agent-cli (npm cumora) version that produced this row. Cloud rows: null. */
  daemonVersion: string | null
}

/** Raw call rows for one bucket — driven by the drill-down panel.
 *
 *  Filters are an AND: every supplied filter narrows the result. Default sort
 *  is cost desc so the top of the panel is the highest-spend calls in that
 *  bucket. The hard limit (200) is the page-size ceiling; the page asks for
 *  50 by default. */
export async function getLlmCalls(args: {
  sinceDays?: number
  /** Tenant scope — narrow to one account. Same semantics as the rollup /
   *  summary / trend / top-agents endpoints: `null` = personal-key calls,
   *  `undefined` (or omitted) = all accounts. */
  companyId?: string | null
  /** Bucket selectors — narrow to ONE rollup row. */
  purpose?: LlmCallPurpose
  model?: string | null
  source?: LlmCallSource | null
  /** Cross-bucket selectors — for the "show me this run's trail" view. */
  runId?: string | null
  agentId?: string | null
  /** 1..200, default 50. */
  limit?: number
  /** 'cost' | 'latency' | 'hop' (extras->hopIndex) | 'created' (default cost). */
  sortBy?: 'cost' | 'latency' | 'hop' | 'created'
}): Promise<LlmCallRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const limit = Math.max(1, Math.min(200, args.limit ?? 50))
  // Build the WHERE incrementally so an absent filter doesn't constrain.
  const params: unknown[] = [sinceDays]
  const where: string[] = [`l.created_at > NOW() - ($1::int * INTERVAL '1 day')`]
  const add = (clause: string, value: unknown): void => {
    params.push(value)
    where.push(clause.replace('$$', `$${params.length}`))
  }
  if (args.purpose) add(`l.purpose = $$`, args.purpose)
  if (args.model)   add(`l.model = $$`, args.model)
  if (args.source)  add(`l.source = $$`, args.source)
  if (args.runId)   add(`l.run_id = $$`, args.runId)
  if (args.agentId) add(`l.agent_id = $$`, args.agentId)
  if (args.companyId !== undefined) {
    if (args.companyId === null) where.push(`l.company_id IS NULL`)
    else add(`l.company_id = $$`, args.companyId)
  }
  // The runId / agentId paths primarily want time-ordered trajectory; default
  // them to 'created' ASC unless the caller picks something else. The bucket
  // path defaults to 'cost' DESC so the top of the list is the heaviest call.
  const defaultSort: NonNullable<typeof args.sortBy> = (args.runId || args.agentId) ? 'created' : 'cost'
  const sortBy = args.sortBy ?? defaultSort
  const orderBy =
    sortBy === 'cost'    ? 'l.cost_usd DESC NULLS LAST'
    : sortBy === 'latency' ? 'l.latency_ms DESC NULLS LAST'
    : sortBy === 'hop'   ? `(l.extras->>'hopIndex')::int ASC NULLS LAST, l.created_at ASC`
    : 'l.created_at ASC' // 'created'
  params.push(limit)
  const { rows } = await pool.query<{
    id: string; created_at: string; company_id: string | null
    agent_id: string | null; agent_name: string | null
    run_id: string | null; conversation_id: string | null
    purpose: string; source: string; model: string
    input_tokens: string; cached_input_tokens: string; cache_creation_tokens: string
    output_tokens: string; reasoning_tokens: string
    cost_usd: string; cost_estimated: boolean; measured: boolean
    latency_ms: number | null; status: string; error: string | null
    extras: Record<string, unknown> | null
    daemon_version: string | null
  }>(
    `SELECT
       l.id, l.created_at::text, l.company_id,
       l.agent_id, p.name AS agent_name,
       l.run_id, l.conversation_id,
       l.purpose, l.source, l.model,
       l.input_tokens::text, l.cached_input_tokens::text, l.cache_creation_tokens::text,
       l.output_tokens::text, l.reasoning_tokens::text,
       l.cost_usd::text, l.cost_estimated, l.measured,
       l.latency_ms, l.status, l.error,
       l.extras, l.daemon_version
     FROM llm_calls l
     LEFT JOIN participants p
            ON p.id = l.agent_id
           AND (p.company_id = l.company_id OR (p.company_id IS NULL AND l.company_id IS NULL))
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderBy}
     LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    companyId: r.company_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    runId: r.run_id,
    conversationId: r.conversation_id,
    purpose: r.purpose as LlmCallPurpose,
    source: r.source as LlmCallSource,
    model: r.model,
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_input_tokens),
    cacheCreationTokens: Number(r.cache_creation_tokens),
    outputTokens: Number(r.output_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    costUsd: Number(r.cost_usd),
    costEstimated: r.cost_estimated,
    measured: r.measured,
    latencyMs: r.latency_ms,
    status: r.status as LlmCallStatus,
    error: r.error,
    extras: r.extras,
    daemonVersion: r.daemon_version,
  }))
}

/** One row of the per-daemon-version rollup. Answers 'after I shipped v0.1.X,
 *  did average cost-per-hop go up?' — exactly the regression-spotter the
 *  operator needs when a release lands. Cache hit rate per version is the
 *  flip side: a release that warmed caches better will show a jump here. */
export interface LlmDaemonVersionRow {
  daemonVersion: string
  source: LlmCallSource
  calls: number
  costUsd: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  failureRate: number
  /** First and last row times we saw this version in the window — useful to
   *  see when the upgrade actually rolled out. */
  firstSeen: string
  lastSeen: string
}

export async function getLlmDaemonVersionRollup(args: { sinceDays?: number; companyId?: string | null } = {}): Promise<LlmDaemonVersionRow[]> {
  const sinceDays = args.sinceDays ?? 30
  const params: unknown[] = [sinceDays]
  let scope = ''
  if (args.companyId !== undefined) {
    if (args.companyId === null) scope = `AND company_id IS NULL`
    else { params.push(args.companyId); scope = `AND company_id = $${params.length}` }
  }
  const { rows } = await pool.query<{
    daemon_version: string; source: string
    calls: string; cost_usd: string
    input_tokens: string; cached_input_tokens: string; output_tokens: string
    ok_calls: string
    first_seen: string; last_seen: string
  }>(
    // first/last seen are bucket_hour MIN/MAX → hour-precision (fine for the
    // relative "2h ago" display). ok_calls is pre-summed in the rollup.
    `SELECT daemon_version, source,
            SUM(calls)::text                                               AS calls,
            COALESCE(SUM(cost_usd), 0)::text                               AS cost_usd,
            SUM(input_tokens)::text                                        AS input_tokens,
            SUM(cached_input_tokens)::text                                 AS cached_input_tokens,
            SUM(output_tokens)::text                                       AS output_tokens,
            SUM(ok_calls)::text                                            AS ok_calls,
            MIN(bucket_hour)::text                                         AS first_seen,
            MAX(bucket_hour)::text                                         AS last_seen
       FROM llm_calls_rollup
      WHERE bucket_hour > NOW() - ($1::int * INTERVAL '1 day') ${scope}
        AND daemon_version IS NOT NULL
      GROUP BY daemon_version, source
      ORDER BY MAX(bucket_hour) DESC, SUM(cost_usd) DESC`,
    params,
  )
  return rows.map((r) => {
    const calls = Number(r.calls)
    const failed = calls - Number(r.ok_calls)
    return {
      daemonVersion: r.daemon_version,
      source: r.source as LlmCallSource,
      calls,
      costUsd: Number(r.cost_usd),
      inputTokens: Number(r.input_tokens),
      cachedInputTokens: Number(r.cached_input_tokens),
      outputTokens: Number(r.output_tokens),
      failureRate: calls > 0 ? failed / calls : 0,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    }
  })
}
