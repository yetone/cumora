import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { effectiveCostUsd, priceFor, modelPriceTable, EMPTY_USAGE, type TokenUsage } from './cost.js'

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'skipped'
export type TriageSource = 'cloud' | 'byoa-claude' | 'byoa-codex' | 'byoa-grok' | 'byoa-cursor' | 'byoa-opencode' | 'byoa-pi'
export type AgentEventLevel = 'debug' | 'info' | 'warn' | 'error'

const MAX_STRING_CHARS = 24_000
const MAX_JSON_CHARS = 160_000

function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= 8) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clip(item, depth + 1))

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
    out[key] = clip(item, depth + 1)
  }
  return out
}

function jsonForDb(value: unknown): string {
  try {
    const text = JSON.stringify(clip(value))
    if (text.length <= MAX_JSON_CHARS) return text
    return JSON.stringify({ truncated: true, preview: text.slice(0, MAX_JSON_CHARS) })
  } catch {
    return JSON.stringify({ value: String(value) })
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  return String(err)
}

export async function createAgentRun(args: {
  agentId: string
  companyId?: string | null
  trigger?: Record<string, unknown>
  inputMessageIds?: string[]
  inboxCount?: number
  fingerprint?: string
}): Promise<string> {
  const id = `run-${randomUUID()}`
  await pool.query(
    `INSERT INTO agent_runs (
       id, agent_id, company_id, trigger, status, stage,
       input_message_ids, inbox_count, fingerprint
     )
     VALUES ($1,$2,$3,$4::jsonb,'running','created',$5::jsonb,$6,$7)`,
    [
      id,
      args.agentId,
      args.companyId ?? null,
      jsonForDb(args.trigger ?? {}),
      jsonForDb(args.inputMessageIds ?? []),
      args.inboxCount ?? 0,
      args.fingerprint ?? null,
    ],
  )
  return id
}

export async function recordAgentEvent(args: {
  runId: string
  agentId: string
  companyId?: string | null
  kind: string
  level?: AgentEventLevel
  title: string
  data?: Record<string, unknown>
  stage?: string
}): Promise<void> {
  await pool.query(
    `INSERT INTO agent_events (id, run_id, agent_id, company_id, kind, level, title, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      `evt-${randomUUID()}`,
      args.runId,
      args.agentId,
      args.companyId ?? null,
      args.kind,
      args.level ?? 'info',
      args.title,
      jsonForDb(args.data ?? {}),
    ],
  )
  await pool.query(
    `UPDATE agent_runs
        SET updated_at = NOW(),
            stage = COALESCE($2, stage)
      WHERE id = $1`,
    [args.runId, args.stage ?? null],
  )
}

export async function finishAgentRun(args: {
  runId: string
  status: AgentRunStatus
  summary?: string
  error?: string | null
  toolCallCount?: number
  tokenCount?: number
  /** Model id (for cache-aware pricing). */
  model?: string | null
  /** Cache-aware token breakdown. When present we also store the breakdown +
   *  effective cost; when absent, only the legacy fields are written (COALESCE
   *  leaves the cost columns at their defaults). */
  usage?: TokenUsage | null
}): Promise<void> {
  const usage = args.usage ?? null
  const cost = usage ? effectiveCostUsd(args.model, usage) : null
  // Legacy token_count = input+output sum; keep it populated for back-compat.
  const tokenCount = args.tokenCount ?? (usage
    ? usage.inputTokens + usage.cachedInputTokens + usage.cacheCreationTokens + usage.outputTokens
    : 0)
  await pool.query(
    `UPDATE agent_runs
        SET status = $2,
            stage = $2,
            summary = $3,
            error = $4,
            tool_call_count = $5,
            token_count = $6,
            input_tokens          = COALESCE($7, input_tokens),
            cached_input_tokens   = COALESCE($8, cached_input_tokens),
            cache_creation_tokens = COALESCE($9, cache_creation_tokens),
            output_tokens         = COALESCE($10, output_tokens),
            cost_usd              = COALESCE($11, cost_usd),
            cost_estimated        = COALESCE($12, cost_estimated),
            model                 = COALESCE($13, model),
            updated_at = NOW(),
            finished_at = NOW()
      WHERE id = $1`,
    [
      args.runId,
      args.status,
      args.summary ?? null,
      args.error ?? null,
      args.toolCallCount ?? 0,
      tokenCount,
      usage?.inputTokens ?? null,
      usage?.cachedInputTokens ?? null,
      usage?.cacheCreationTokens ?? null,
      usage?.outputTokens ?? null,
      cost?.usd ?? null,
      cost ? cost.estimated : null,
      args.model ?? null,
    ],
  )
}

/** Record one inbox-triage call (the small-brain gate) with its cache-aware cost.
 *  Best-effort: a DB hiccup must never break a turn. `usage` null/undefined means
 *  the engine gave us no token counts (e.g. codex) → stored as unmeasured. */
export async function recordTriage(args: {
  agentId: string
  companyId?: string | null
  source: TriageSource
  model?: string | null
  actionable: boolean
  reason?: string | null
  usage?: TokenUsage | null
  /** The big-brain run this triage WOKE (actionable=true), if known. */
  runId?: string | null
}): Promise<void> {
  const measured = !!args.usage
  const usage = args.usage ?? EMPTY_USAGE
  const cost = effectiveCostUsd(args.model, usage)
  try {
    await pool.query(
      `INSERT INTO agent_triages (
         id, agent_id, company_id, source, model, actionable, reason,
         input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens,
         cost_usd, cost_estimated, measured, run_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        `tri-${randomUUID()}`, args.agentId, args.companyId ?? null, args.source,
        args.model ?? null, args.actionable, (args.reason ?? '').slice(0, 500),
        usage.inputTokens, usage.cachedInputTokens, usage.cacheCreationTokens, usage.outputTokens,
        measured ? cost.usd : 0, cost.estimated, measured, args.runId ?? null,
      ],
    )
  } catch (err) {
    console.warn('[observability] recordTriage failed — dropping', err instanceof Error ? err.message : err)
  }
}

/** Heartbeat a still-running run: bump updated_at so the stale-run sweeper does
 *  NOT reap a legitimately long turn. Cloud turns stay alive implicitly (every
 *  recordAgentEvent bumps updated_at); BYOA turns emit no mid-run events, so the
 *  daemon must call this periodically while its engine turn is in flight, or any
 *  turn >maxAgeMs gets falsely closed as "orphaned". Only touches a 'running' row
 *  so it can never resurrect a finished/failed one. */
export async function touchAgentRun(runId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_runs SET updated_at = NOW() WHERE id = $1 AND status = 'running'`,
    [runId],
  )
}

export async function markStaleAgentRuns(maxAgeMs: number = 10 * 60_000): Promise<Array<{ id: string; agent_id: string }>> {
  const { rows } = await pool.query<{ id: string; agent_id: string }>(
    `UPDATE agent_runs
        SET status = 'failed',
            stage = 'orphaned',
            summary = COALESCE(NULLIF(summary, ''), 'Agent run orphaned after runtime finalization was lost'),
            error = COALESCE(error, 'Agent run was left running without heartbeat and was closed by the stale-run sweeper'),
            updated_at = NOW(),
            finished_at = NOW()
      WHERE status = 'running'
        AND updated_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')
      RETURNING id, agent_id`,
    [maxAgeMs],
  )
  return rows
}

export function startStaleAgentRunSweeper(
  intervalMs: number = 60_000,
  maxAgeMs: number = 10 * 60_000,
): NodeJS.Timeout {
  const tick = (): void => {
    void markStaleAgentRuns(maxAgeMs).then((rows) => {
      if (rows.length > 0) {
        console.warn(`[observability] closed ${rows.length} stale running agent run(s): ${rows.map((r) => r.id).join(', ')}`)
      }
    }).catch((err) => {
      console.warn('[observability] stale agent run sweeper failed:', err instanceof Error ? err.message : err)
    })
  }
  setImmediate(tick)
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  return t
}

// ─── triage economics ─────────────────────────────────────────────────────

export interface TriageAgentRow {
  agentId: string
  agentName: string
  triageCount: number
  skipCount: number
  wakeCount: number
  triageCostUsd: number
  triageOverheadUsd: number   // triage cost spent on actionable=true (paid the gate AND ran the turn)
  turnCount: number
  avgTurnCostUsd: number
  turnCacheHitRate: number
  estimatedNetSavingsUsd: number  // skipCount*avgTurnCost − triageCost (this agent's own avg)
}

export interface TriageLedgerRow {
  id: string
  agentId: string
  agentName: string
  source: TriageSource
  model: string | null
  actionable: boolean
  reason: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  costUsd: number
  costEstimated: boolean
  measured: boolean
  estSavingUsd: number | null  // for skips: this agent's avgTurnCost − this triage cost; null for wakes
  createdAt: string
}

/** The per-1M-token unit price actually used to cost a model in this window. */
export interface TriageUnitPrice {
  role: 'triage' | 'turn'   // triage = small brain (cerebellum), turn = big brain
  model: string
  inPer1M: number
  cachedInPer1M: number
  outPer1M: number
  estimated: boolean        // true = seeded/fallback (NOT an operator-supplied real rate)
}

/** A row in the full price-menu reference table. */
export interface TriagePriceRow {
  model: string
  inPer1M: number
  cachedInPer1M: number
  cacheWritePer1M: number
  outPer1M: number
  estimated: boolean
}

export interface TriageEconomics {
  sinceHours: number
  triageCount: number
  triageSkipCount: number
  triageWakeCount: number
  triageMeasuredCount: number
  triageCostUsd: number
  triageOverheadUsd: number
  triageInputTokens: number        // uncached input tokens across triages (real, plan-independent)
  triageCachedInputTokens: number
  triageOutputTokens: number
  turnCount: number
  turnCostUsd: number
  avgTurnCostUsd: number
  turnCacheHitRate: number
  estimatedAvoidedUsd: number      // Σ per-agent skipCount*avgTurnCost — the avoided BIG-BRAIN spend
  estimatedNetSavingsUsd: number   // estimatedAvoided − triageCost (LABELED estimate in the UI)
  costEstimated: boolean           // any price was a seeded/fallback estimate, not an operator rate
  byoaShare: number                // fraction of triages on BYOA (flat-rate $ → meter-equivalent, not a bill)
  unitPrices: TriageUnitPrice[]    // the actual per-token rates used (small brain vs big brain)
  priceTable: TriagePriceRow[]     // the full price menu (reference), always populated
  perAgent: TriageAgentRow[]
  recent: TriageLedgerRow[]
}

/** The honest triage ledger. Compares actual triage spend against the big-brain
 *  turns it shields, all cache-aware. The ONE counterfactual — "estimated net
 *  savings" — uses each agent's OWN recent mean turn cost as the value of an
 *  avoided turn, and is labeled as an estimate in the UI. Everything else is
 *  measured. */
export async function getTriageEconomics(args: {
  companyId: string
  agentId?: string | null
  sinceHours?: number
}): Promise<TriageEconomics> {
  const sinceHours = Math.min(720, Math.max(1, args.sinceHours ?? 24))
  const ms = sinceHours * 3_600_000
  const agentFilter = args.agentId ? 'AND t.agent_id = $3' : ''
  const runAgentFilter = args.agentId ? 'AND r.agent_id = $3' : ''
  const params: unknown[] = [args.companyId, ms]
  if (args.agentId) params.push(args.agentId)

  // IMPORTANT: cost is computed HERE, at query time, from the stored TOKEN COUNTS
  // × the CURRENT prices — NOT from the stored cost_usd (which froze whatever price
  // was in effect at record time). This way a price change (code OR
  // CUMORA_MODEL_PRICES_JSON) instantly re-prices ALL history, matching the
  // "token counts are real, prices are live" promise. We aggregate tokens grouped
  // by (agent, model) because the per-token rate is model-specific.
  const toUsage = (r: { input_tokens: string; cached_tokens: string; cache_creation_tokens: string; output_tokens: string }): TokenUsage => ({
    inputTokens: Number(r.input_tokens),
    cachedInputTokens: Number(r.cached_tokens),
    cacheCreationTokens: Number(r.cache_creation_tokens),
    outputTokens: Number(r.output_tokens),
  })

  const triAgg = await pool.query<{
    agent_id: string; agent_name: string; model: string | null; actionable: boolean;
    n: number; measured_n: number; byoa_n: number;
    input_tokens: string; cached_tokens: string; cache_creation_tokens: string; output_tokens: string;
  }>(
    `SELECT t.agent_id, COALESCE(p.name, t.agent_id) AS agent_name, t.model, t.actionable,
            count(*)::int AS n,
            count(*) FILTER (WHERE t.measured)::int AS measured_n,
            count(*) FILTER (WHERE t.source LIKE 'byoa%')::int AS byoa_n,
            COALESCE(sum(t.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(sum(t.cached_input_tokens), 0)::bigint AS cached_tokens,
            COALESCE(sum(t.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
            COALESCE(sum(t.output_tokens), 0)::bigint AS output_tokens
       FROM agent_triages t
       LEFT JOIN participants p ON p.id = t.agent_id AND p.company_id = t.company_id
      WHERE t.company_id = $1 AND t.created_at > NOW() - ($2::double precision * INTERVAL '1 millisecond') ${agentFilter}
      GROUP BY t.agent_id, agent_name, t.model, t.actionable`,
    params,
  )

  // Only measured (non-zero-token) runs feed turn cost / the avg counterfactual —
  // orphaned/0-token runs would falsely depress it.
  const runAgg = await pool.query<{
    agent_id: string; model: string | null; turn_n: number;
    input_tokens: string; cached_tokens: string; cache_creation_tokens: string; output_tokens: string;
  }>(
    `SELECT r.agent_id, r.model,
            count(*)::int AS turn_n,
            COALESCE(sum(r.input_tokens), 0)::bigint AS input_tokens,
            COALESCE(sum(r.cached_input_tokens), 0)::bigint AS cached_tokens,
            COALESCE(sum(r.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
            COALESCE(sum(r.output_tokens), 0)::bigint AS output_tokens
       FROM agent_runs r
      WHERE r.company_id = $1 AND r.started_at > NOW() - ($2::double precision * INTERVAL '1 millisecond') ${runAgentFilter}
        AND (r.input_tokens + r.cached_input_tokens + r.output_tokens) > 0
      GROUP BY r.agent_id, r.model`,
    params,
  )

  interface Acc {
    agentName: string
    triageCount: number; skipCount: number; wakeCount: number; measuredCount: number; byoaCount: number
    triageCostUsd: number; triageOverheadUsd: number
    turnCount: number; turnCostUsd: number; cacheRead: number; totalInput: number
  }
  const acc = new Map<string, Acc>()
  const accOf = (id: string, name: string): Acc => {
    let a = acc.get(id)
    if (!a) {
      a = { agentName: name, triageCount: 0, skipCount: 0, wakeCount: 0, measuredCount: 0, byoaCount: 0, triageCostUsd: 0, triageOverheadUsd: 0, turnCount: 0, turnCostUsd: 0, cacheRead: 0, totalInput: 0 }
      acc.set(id, a)
    } else if (name !== id && a.agentName === id) {
      a.agentName = name
    }
    return a
  }
  const modelsSeen = new Set<string>()

  for (const t of triAgg.rows) {
    const a = accOf(t.agent_id, t.agent_name)
    if (t.model) modelsSeen.add(t.model)
    const cost = effectiveCostUsd(t.model, toUsage(t)).usd
    a.triageCount += t.n
    a.measuredCount += t.measured_n
    a.byoaCount += t.byoa_n
    a.triageCostUsd += cost
    if (t.actionable) { a.wakeCount += t.n; a.triageOverheadUsd += cost } else { a.skipCount += t.n }
  }
  for (const r of runAgg.rows) {
    const a = accOf(r.agent_id, r.agent_id)
    if (r.model) modelsSeen.add(r.model)
    const u = toUsage(r)
    a.turnCostUsd += effectiveCostUsd(r.model, u).usd
    a.turnCount += r.turn_n
    a.cacheRead += u.cachedInputTokens
    a.totalInput += u.inputTokens + u.cachedInputTokens
  }

  // perAgent = agents that actually triaged (a run-only agent has nothing to report
  // in a TRIAGE ledger). Their turn data is still accumulated above for avg cost.
  const perAgent: TriageAgentRow[] = [...acc.entries()]
    .filter(([, a]) => a.triageCount > 0)
    .map(([agentId, a]) => {
      const avgTurnCostUsd = a.turnCount > 0 ? a.turnCostUsd / a.turnCount : 0
      return {
        agentId, agentName: a.agentName,
        triageCount: a.triageCount, skipCount: a.skipCount, wakeCount: a.wakeCount,
        triageCostUsd: a.triageCostUsd, triageOverheadUsd: a.triageOverheadUsd,
        turnCount: a.turnCount, avgTurnCostUsd,
        turnCacheHitRate: a.totalInput > 0 ? a.cacheRead / a.totalInput : 0,
        estimatedNetSavingsUsd: a.skipCount * avgTurnCostUsd - a.triageCostUsd,
      }
    })
  const avgCostByAgent = new Map(perAgent.map((a) => [a.agentId, a.avgTurnCostUsd]))

  // Recent triage ledger — each row's cost computed LIVE from its tokens.
  const recentRows = await pool.query<{
    id: string; agent_id: string; agent_name: string; source: string; model: string | null;
    actionable: boolean; reason: string | null; input_tokens: number; cached_input_tokens: number;
    cache_creation_tokens: number; output_tokens: number; measured: boolean; created_at: Date
  }>(
    `SELECT t.id, t.agent_id, COALESCE(p.name, t.agent_id) AS agent_name, t.source, t.model,
            t.actionable, t.reason, t.input_tokens, t.cached_input_tokens, t.cache_creation_tokens,
            t.output_tokens, t.measured, t.created_at
       FROM agent_triages t
       LEFT JOIN participants p ON p.id = t.agent_id AND p.company_id = t.company_id
      WHERE t.company_id = $1 AND t.created_at > NOW() - ($2::double precision * INTERVAL '1 millisecond') ${agentFilter}
      ORDER BY t.created_at DESC
      LIMIT 200`,
    params,
  )
  const recent: TriageLedgerRow[] = recentRows.rows.map((r) => {
    const usage: TokenUsage = {
      inputTokens: r.input_tokens, cachedInputTokens: r.cached_input_tokens,
      cacheCreationTokens: r.cache_creation_tokens, outputTokens: r.output_tokens,
    }
    const priced = effectiveCostUsd(r.model, usage)
    const costUsd = r.measured ? priced.usd : 0
    const avg = avgCostByAgent.get(r.agent_id) ?? 0
    return {
      id: r.id, agentId: r.agent_id, agentName: r.agent_name,
      source: r.source as TriageSource, model: r.model,
      actionable: r.actionable, reason: r.reason,
      inputTokens: r.input_tokens, cachedInputTokens: r.cached_input_tokens, outputTokens: r.output_tokens,
      costUsd, costEstimated: priced.estimated, measured: r.measured,
      estSavingUsd: r.actionable ? null : avg - costUsd,
      createdAt: r.created_at.toISOString(),
    }
  })

  // Unit prices used, by role — live via priceFor (the rates the costs above used).
  const unitPrices: TriageUnitPrice[] = []
  const seenUnit = new Set<string>()
  const pushUnit = (role: 'triage' | 'turn', model: string | null): void => {
    if (!model) return
    const key = `${role}:${model}`
    if (seenUnit.has(key)) return
    seenUnit.add(key)
    const pr = priceFor(model)
    unitPrices.push({ role, model, inPer1M: pr.inPer1M, cachedInPer1M: pr.cachedInPer1M, outPer1M: pr.outPer1M, estimated: pr.verified !== true })
  }
  for (const t of triAgg.rows) pushUnit('triage', t.model)
  for (const r of runAgg.rows) pushUnit('turn', r.model)

  // Global rollups (turn metrics over ALL agents with runs; triage metrics + the
  // net over the agents that triaged, using each agent's OWN avg turn cost).
  let triageCostUsd = 0, estimatedAvoidedUsd = 0, triageCount = 0, triageSkip = 0, triageWake = 0
  let triageMeasured = 0, triageOverhead = 0, byoaTri = 0
  let turnCostUsd = 0, turnCount = 0, cacheRead = 0, totalInput = 0
  for (const a of acc.values()) {
    turnCostUsd += a.turnCostUsd; turnCount += a.turnCount; cacheRead += a.cacheRead; totalInput += a.totalInput
    if (a.triageCount > 0) {
      triageCostUsd += a.triageCostUsd; triageCount += a.triageCount; triageSkip += a.skipCount
      triageWake += a.wakeCount; triageMeasured += a.measuredCount; triageOverhead += a.triageOverheadUsd; byoaTri += a.byoaCount
      estimatedAvoidedUsd += a.skipCount * (a.turnCount > 0 ? a.turnCostUsd / a.turnCount : 0)
    }
  }
  // triage token totals (real, plan-independent) from the by-model groups.
  const triageInputTokens = triAgg.rows.reduce((s, t) => s + Number(t.input_tokens), 0)
  const triageCachedInputTokens = triAgg.rows.reduce((s, t) => s + Number(t.cached_tokens), 0)
  const triageOutputTokens = triAgg.rows.reduce((s, t) => s + Number(t.output_tokens), 0)
  const costEstimated = [...modelsSeen].some((m) => priceFor(m).verified !== true)

  return {
    sinceHours,
    triageCount,
    triageSkipCount: triageSkip,
    triageWakeCount: triageWake,
    triageMeasuredCount: triageMeasured,
    triageCostUsd,
    triageOverheadUsd: triageOverhead,
    triageInputTokens,
    triageCachedInputTokens,
    triageOutputTokens,
    turnCount,
    turnCostUsd,
    avgTurnCostUsd: turnCount > 0 ? turnCostUsd / turnCount : 0,
    turnCacheHitRate: totalInput > 0 ? cacheRead / totalInput : 0,
    estimatedAvoidedUsd,
    estimatedNetSavingsUsd: estimatedAvoidedUsd - triageCostUsd,
    costEstimated,
    byoaShare: triageCount > 0 ? byoaTri / triageCount : 0,
    unitPrices,
    priceTable: modelPriceTable(),
    perAgent: perAgent.sort((a, b) => b.triageCount - a.triageCount),
    recent,
  }
}
