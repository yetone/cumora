/**
 * Admin Observability — the operator-facing answer to:
 *
 *   "Of every sub2api token the platform spent this month, where did it go?"
 *
 * Source of truth is the universal `llm_calls` ledger (server/src/agents/
 * llm-ledger.ts); this page is a presentation layer over four shapes the
 * /api/admin/observability/llm endpoint returns in one round-trip:
 *
 *   - summary     — hero KPIs (total $, total calls, top burner purpose,
 *                   failure rate, active tenants, output/cached token mix)
 *   - rollup      — per-purpose × model × source breakdown, sorted by $ desc
 *   - trend       — daily-bucketed cost × purpose for the area chart
 *   - topAgents   — top spenders by agent, joined to display name
 *
 * Visual goals (per product brief): stylish, refined, rich. We lean on the
 * existing skype/ink/sky/coral palette — no new neon — and add three things
 * the rest of the admin doesn't have:
 *
 *   1. A gradient "spend" hero card that anchors the page.
 *   2. A stacked SVG area chart for the daily trend (no chart library
 *      pulled in — vendored ~80 LOC of inline SVG that matches the brand
 *      colors, no runtime tax for a single page).
 *   3. Purpose-coded swatches so the eye finds the same purpose in the
 *      KPI card, the chart, AND the rollup table.
 *
 * Filters are URL-stateless (in-page only) — the page is admin-only and the
 * audience is the operator, not a sharable dashboard, so deep linking isn't
 * worth the complexity.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Select } from '@/components/Select'
import { Combobox } from '@/components/Combobox'
import {
  adminApi,
  type LlmCallPurpose,
  type LlmCallRow,
  type LlmCallSource,
  type LlmDaemonVersionRow,
  type LlmObservabilityPayload,
  type LlmRollupRow,
  type LlmTenantRow,
  type LlmTopAgentRow,
  type LlmTrendBucket,
} from './api'

// ─── Purpose → label + swatch ────────────────────────────────────────────
//
// One source of truth for every purpose-keyed visual: a human label (short
// enough for chart legends), a one-line explainer (for the rollup table's
// secondary line + tooltip), and a swatch color used by both the chart and
// the table dot. Colors are sampled from the existing palette — sky for the
// big-model real-task tier, coral for cerebellum gates, gold for tools /
// one-shots — so the page reads as a member of the family.

interface PurposeMeta {
  label: string
  blurb: string
  swatch: string
}

const PURPOSE_META: Record<LlmCallPurpose, PurposeMeta> = {
  // Big-model real tasks — sky family (these are the sanctioned spend).
  'agent-turn':           { label: 'Agent turn',         blurb: "Main reasoning hop per turn — the agent's actual reply work.", swatch: '#0078C8' },
  'convene-speech':       { label: 'Convene speech',     blurb: 'One agent speaking inside a live convene session.',           swatch: '#4FC2F4' },
  // Cerebellum gates — coral family (these shield the big brain).
  'inbox-triage':         { label: 'Inbox triage',       blurb: 'Cloud gate that decides whether a human message wakes the brain.', swatch: '#FF7A6B' },
  'synthetic-wake-gate':  { label: 'Synthetic-wake gate',blurb: 'Gate for idle / background-scan / poll-update wakes.',         swatch: '#FFA39A' },
  'agenda':               { label: 'Agenda check',       blurb: "Heartbeat classifier on cards / events / stalls.",            swatch: '#C84E3F' },
  // Mid-turn cerebellum — wisteria family (auxiliary judgment on big-turn work).
  'compaction':           { label: 'Auto-compaction',    blurb: 'Summarizes earlier tool work when history nears the context cap.', swatch: '#9B7BD4' },
  'completion-verify':    { label: 'Completion verify',  blurb: 'Re-checks an agent’s terminal status against side effects.',   swatch: '#7A5BB8' },
  'steer-summary':        { label: 'Steer summary',      blurb: 'Digests mid-turn messages so the agent can react without history blow-up.', swatch: '#B898DD' },
  'convene-decision':     { label: 'Convene decision',   blurb: '"Did the convene reach a decision?" closer.',                 swatch: '#D4B3FF' },
  // One-shot utilities — gold family.
  'palette':              { label: 'Palette tool',       blurb: 'Agent-invoked 5-color palette generator.',                    swatch: '#F4B740' },
  'gender':               { label: 'Gender inference',   blurb: 'Avatar-pipeline gender pick.',                                swatch: '#BA8418' },
  'avatar-image':         { label: 'Avatar image',       blurb: 'Image gen at agent creation / regeneration.',                 swatch: '#D49520' },
  'agent-image':          { label: 'Agent image tool',   blurb: 'Image gen invoked by an agent mid-turn.',                     swatch: '#E8A030' },
}

const FALLBACK_SWATCH = '#94A8BC'
function metaFor(p: LlmCallPurpose | string): PurposeMeta {
  const m = (PURPOSE_META as Record<string, PurposeMeta | undefined>)[p]
  return m ?? { label: p, blurb: '', swatch: FALLBACK_SWATCH }
}

// ─── Formatters ──────────────────────────────────────────────────────────

const fmtUsd = (n: number, places = 2): string => {
  // Tight format: $1.23, $12.4K, $1.23M. Trying to read raw 9-digit
  // numbers in a hero card is hostile.
  if (!Number.isFinite(n)) return '$0'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(places)}`
}
const fmtTokens = (n: number): string => {
  if (!Number.isFinite(n)) return '0'
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (Math.abs(n) >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000)         return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
const fmtInt = (n: number): string => n.toLocaleString('en-US')
const fmtPct = (n: number, places = 1): string => `${(n * 100).toFixed(places)}%`

// ─── Unit: $ vs tokens ───────────────────────────────────────────────────
//
// The $ figures are ESTIMATES — cost.ts seeds one assumed per-token rate per
// model (verified:false unless an operator supplies CUMORA_MODEL_PRICES_JSON).
// For BYOA every user is on their own provider/plan, so the $ is meaningless to
// them; token counts are the objective truth. This toggle swaps every primary
// metric between $ and tokens. Default = tokens. Cached input tokens are ALWAYS
// shown distinctly from uncached (they bill ~10× less and behave differently),
// regardless of unit.
type Unit = 'tokens' | 'usd'
const UNITS: Array<{ key: Unit; label: string }> = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'usd',    label: 'USD $' },
]
/** Total billable tokens across every bucket of a row, cached input included
 *  (cached tokens are still tokens the model processed). reasoning is optional
 *  — only the rollup / raw-call shapes carry it. */
const totalTokens = (r: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens?: number }): number =>
  r.inputTokens + r.cachedInputTokens + r.outputTokens + (r.reasoningTokens ?? 0)
/** One primary metric formatted per the active unit. */
const fmtAmount = (unit: Unit, usd: number, tokens: number): string =>
  unit === 'usd' ? fmtUsd(usd, usd < 1 ? 4 : 2) : fmtTokens(tokens)

// ─── Range pills ─────────────────────────────────────────────────────────

const RANGES: Array<{ label: string; days: number }> = [
  { label: '24h', days: 1 },
  { label: '7d',  days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

// Auto-refresh cadences (ms). 0 = off. The data pipeline itself is at most ~2min
// stale (the server-side rollup worker), so sub-minute polling mostly re-reads
// the same numbers — but it matches the "live dashboard" expectation and the
// drill-down (raw rows) IS live.
const REFRESH_INTERVALS: Array<{ label: string; ms: number }> = [
  { label: 'Auto-refresh: Off', ms: 0 },
  { label: 'Every 30s', ms: 30_000 },
  { label: 'Every 1m',  ms: 60_000 },
  { label: 'Every 5m',  ms: 300_000 },
]

// ─── Source filter ───────────────────────────────────────────────────────
//
// The ledger now records BOTH cloud sub2api AND BYOA local spend (the daemon
// emits per-hop trajectory via /runtime/llm-calls). Cloud rows are real $;
// BYOA rows are meter-equivalent — same per-token rate, but the operator's
// actual bill is a flat subscription. Default is "All", but the explicit
// filter is here so the operator can isolate either side when investigating
// a spike: "did cloud cost spike, or just BYOA token usage?"

// One BYOA pill covering BOTH engines (byoa-claude + byoa-codex). The rollup
// table still shows them as separate rows (different engine/model); this is
// just the filter — the operator rarely wants to isolate a single BYOA engine,
// and "Cloud vs BYOA" is the split that matters.
type SourceFilter = 'all' | 'cloud' | 'byoa'
const SOURCE_FILTERS: Array<{ key: SourceFilter; label: string }> = [
  { key: 'all',   label: 'All' },
  { key: 'cloud', label: 'Cloud' },
  { key: 'byoa',  label: 'BYOA' },
]
const isByoaSource = (s: string): boolean => s === 'byoa-claude' || s === 'byoa-codex' || s === 'byoa-grok'

// ─── Component ───────────────────────────────────────────────────────────

/** What the drill-down panel is currently showing. `null` = closed; a value
 *  is the filter set that defines which rows the panel queries (and shows in
 *  its header chip). The page owns this state so the panel can be re-opened
 *  with a different bucket without unmounting (state inside the panel — sort
 *  / refresh — stays put on bucket switch). */
type DrillDown =
  | { kind: 'bucket'; purpose: LlmCallPurpose; model: string; source: LlmCallSource }
  | { kind: 'run'; runId: string }
  | { kind: 'agent'; agentId: string; agentName: string | null }

export function ObservabilityPage() {
  const [sinceDays, setSinceDays] = useState<number>(30)
  const [modelFilter, setModelFilter] = useState<string>('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  /** $ vs tokens. Defaults to tokens — the platform-neutral truth (the $
   *  figures are seeded estimates; see the Unit notes above). */
  const [unit, setUnit] = useState<Unit>('tokens')
  /** Per-tenant scope. Empty string = all accounts; a non-empty companyId
   *  narrows EVERY stat on the page to that account. The picker below the
   *  filter bar populates this. */
  const [companyFilter, setCompanyFilter] = useState<string>('')
  const [data, setData] = useState<LlmObservabilityPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Open drill-down view. ESC / overlay click closes it. */
  const [drill, setDrill] = useState<DrillDown | null>(null)
  /** Manual-refresh + auto-refresh. `refreshTick` bumps to force a re-fetch
   *  (the fetch effect depends on it); `freshRef` flags that the *next* fetch
   *  should bypass the server's 30s response cache (set by user/auto refresh,
   *  not by a filter change). `lastUpdated` powers the "updated …" readout and
   *  `refreshing` spins the button without flashing the skeleton. */
  const [refreshTick, setRefreshTick] = useState(0)
  const [autoRefreshMs, setAutoRefreshMs] = useState(0)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const freshRef = useRef(false)
  const everLoadedRef = useRef(false)
  const triggerRefresh = () => { freshRef.current = true; setRefreshing(true); setRefreshTick((t) => t + 1) }

  useEffect(() => {
    let cancelled = false
    // Skeleton only on the very first load (no data yet); a refresh or filter
    // change keeps the current data on screen until the new payload lands, so
    // the page never flashes empty.
    if (!everLoadedRef.current) setLoading(true)
    setError(null)
    const fresh = freshRef.current
    freshRef.current = false
    adminApi.observabilityLlm({
      sinceDays,
      ...(modelFilter.trim() ? { model: modelFilter.trim() } : {}),
      ...(companyFilter ? { companyId: companyFilter } : {}),
      ...(fresh ? { fresh: true } : {}),
    })
      .then((r) => { if (!cancelled) { setData(r); setLastUpdated(Date.now()); everLoadedRef.current = true } })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) { setLoading(false); setRefreshing(false) } })
    return () => { cancelled = true }
  }, [sinceDays, modelFilter, companyFilter, refreshTick])

  // Auto-refresh: while a non-zero interval is selected, force a fresh re-fetch
  // on that cadence. Cleared/reset whenever the interval changes.
  useEffect(() => {
    if (!autoRefreshMs) return
    const id = setInterval(() => triggerRefresh(), autoRefreshMs)
    return () => clearInterval(id)
  }, [autoRefreshMs])

  // Apply source filter CLIENT-SIDE — the payload is small and we want toggle
  // changes to be instant, not another round-trip. The summary KPIs stay
  // GLOBAL (across all sources) so the "Top burner" card still answers "of
  // EVERYTHING, what's the biggest" — that's the question the operator
  // actually wants there. Per-source breakdowns live in the rollup table.
  const filtered = useMemo(() => {
    if (!data) return data
    if (sourceFilter === 'all') return data
    return {
      ...data,
      rollup: data.rollup.filter((r) => sourceFilter === 'byoa' ? isByoaSource(r.source) : r.source === sourceFilter),
      // Trend buckets don't carry source; leaving them as-is is the honest
      // choice — the source-filtered chart would mean re-fetching with a
      // server-side filter, deferred until needed.
    }
  }, [data, sourceFilter])

  // Top burner adapts to the unit: by $ (server's summary.topPurpose, global)
  // for USD; by total tokens (from the source-filtered rollup) for tokens —
  // because the biggest token consumer isn't always the biggest $ one (a cheap
  // high-volume model inverts the ranking, which is exactly what tokens expose).
  const topBurner = useMemo((): { purpose: LlmCallPurpose; usd: number; tokens: number } | null => {
    if (unit === 'usd') {
      const tp = data?.summary?.topPurpose
      return tp ? { purpose: tp.purpose, usd: tp.costUsd, tokens: 0 } : null
    }
    const m = new Map<LlmCallPurpose, { usd: number; tokens: number }>()
    for (const r of filtered?.rollup ?? []) {
      const cur = m.get(r.purpose) ?? { usd: 0, tokens: 0 }
      cur.usd += r.costUsd
      cur.tokens += totalTokens(r)
      m.set(r.purpose, cur)
    }
    let best: { purpose: LlmCallPurpose; usd: number; tokens: number } | null = null
    for (const [purpose, v] of m) if (!best || v.tokens > best.tokens) best = { purpose, ...v }
    return best
  }, [unit, data?.summary?.topPurpose, filtered?.rollup])

  return (
    <div className="admin-page obs-page">
      <header className="admin-page-head">
        <div>
          <h1 className="admin-h1">Observability</h1>
          <div className="admin-sub">
            Every LLM call — cloud AND BYOA — attributed to the business logic that spent it.
            {data?.summary && (
              <> Window: last {data.summary.sinceDays}d · {fmtInt(data.summary.activeTenants)} active tenants.</>
            )}
          </div>
        </div>
        <div className="admin-filters obs-filters">
          <div className="obs-pills" role="tablist" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                role="tab"
                aria-selected={sinceDays === r.days}
                className={`obs-pill${sinceDays === r.days ? ' is-active' : ''}`}
                onClick={() => setSinceDays(r.days)}
              >{r.label}</button>
            ))}
          </div>
          <div className="obs-pills" role="tablist" aria-label="Source">
            {SOURCE_FILTERS.map((s) => (
              <button
                key={s.key}
                role="tab"
                aria-selected={sourceFilter === s.key}
                className={`obs-pill${sourceFilter === s.key ? ' is-active' : ''}`}
                onClick={() => setSourceFilter(s.key)}
              >{s.label}</button>
            ))}
          </div>
          {/* Unit toggle — $ are seeded estimates; tokens are the platform-
              neutral truth (the whole reason BYOA can't trust the $). */}
          <div className="obs-pills" role="tablist" aria-label="Unit">
            {UNITS.map((u) => (
              <button
                key={u.key}
                role="tab"
                aria-selected={unit === u.key}
                className={`obs-pill${unit === u.key ? ' is-active' : ''}`}
                onClick={() => setUnit(u.key)}
                title={u.key === 'usd' ? 'Cost in USD — seeded per-model estimates, not your real platform rate' : 'Raw token counts — exact, platform-independent'}
              >{u.label}</button>
            ))}
          </div>
          <input
            className="admin-input obs-model-input"
            placeholder="Filter model (e.g. gpt-5.4-mini)"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
          />
          <TenantPicker
            tenants={data?.tenants ?? []}
            value={companyFilter}
            unit={unit}
            onChange={setCompanyFilter}
          />
          {/* Refresh controls — manual button + auto-refresh cadence. Both force
              a fresh (cache-bypassing) re-fetch with the CURRENT filters. */}
          <div className="obs-refresh-group">
            <button
              type="button"
              className="obs-refresh-btn"
              onClick={triggerRefresh}
              disabled={refreshing}
              title={lastUpdated ? `Last updated ${new Date(lastUpdated).toLocaleTimeString()} — click to refresh` : 'Refresh'}
              aria-label="Refresh now"
            >
              <span className={`obs-refresh-icon${refreshing ? ' is-spinning' : ''}`} aria-hidden>↻</span>
            </button>
            <Select
              value={String(autoRefreshMs)}
              onValueChange={(v) => setAutoRefreshMs(Number(v))}
              options={REFRESH_INTERVALS.map((r) => ({ value: String(r.ms), label: r.label }))}
              ariaLabel="Auto-refresh interval"
              className="min-w-[150px]"
            />
          </div>
        </div>
        {lastUpdated && (
          <div className="obs-updated" aria-live="polite">
            Updated {new Date(lastUpdated).toLocaleTimeString()}
            {autoRefreshMs > 0 && <> · auto every {REFRESH_INTERVALS.find((r) => r.ms === autoRefreshMs)?.label.replace('Every ', '')}</>}
            {refreshing && <> · refreshing…</>}
          </div>
        )}
      </header>

      {error && <div className="obs-error">Failed to load: {error}</div>}

      {/* Hero KPIs — paper-toned, with one richly-treated "Spend" tile as
          the visual anchor. The four cards always render so the page doesn't
          jump around between loading / loaded states. */}
      <section className="obs-hero">
        <HeroSpendCard summary={data?.summary} unit={unit} loading={loading} />
        <HeroStatCard
          label="Total calls"
          value={data?.summary ? fmtInt(data.summary.totalCalls) : '—'}
          sub={data?.summary
            ? `${fmtInt(data.summary.rateLimitedCalls)} rate-limited`
            : ' '}
          loading={loading}
        />
        <HeroStatCard
          label="Top burner"
          value={topBurner ? metaFor(topBurner.purpose).label : '—'}
          sub={topBurner
            ? `${fmtAmount(unit, topBurner.usd, topBurner.tokens)} of the window`
            : ' '}
          accent={topBurner ? metaFor(topBurner.purpose).swatch : undefined}
          loading={loading}
        />
        <HeroStatCard
          label="Failure rate"
          value={data?.summary ? fmtPct(data.summary.failureRate) : '—'}
          sub={data?.summary
            ? `${fmtTokens(data.summary.totalOutputTokens)} out · ${fmtTokens(data.summary.totalCachedInputTokens)} cached in`
            : ' '}
          accent={data?.summary && data.summary.failureRate > 0.05 ? 'var(--coral-deep)' : undefined}
          loading={loading}
        />
      </section>

      {/* Stacked area / line chart. SVG-only so we don't import a chart lib
          for one page. The trend is the SECOND-most-important visual after
          the hero: a spike in compaction $ yesterday should jump out. */}
      <section className="obs-card obs-trend-card">
        <div className="obs-card-head">
          <div>
            <div className="obs-card-title">{unit === 'usd' ? 'Daily cost by purpose' : 'Daily input tokens by purpose'}</div>
            <div className="obs-card-sub">UTC days · stacked by purpose · {modelFilter ? `model = ${modelFilter}` : 'all models'}{unit !== 'usd' && ' · cached + uncached input'}</div>
          </div>
        </div>
        <TrendChart buckets={data?.trend ?? []} unit={unit} loading={loading} />
        <PurposeLegend rollup={filtered?.rollup ?? []} unit={unit} />
      </section>

      {/* Cache health — the single biggest optimization vector. Every uncached
          input token costs ~10× the cached rate; this card tells the operator
          how much they're leaving on the table and which purpose to target. */}
      <CacheHealthCard summary={data?.summary} trend={data?.trend ?? []} rollup={filtered?.rollup ?? []} unit={unit} loading={loading} />

      {/* Per-purpose rollup. The reason this page exists. */}
      <section className="obs-card">
        <div className="obs-card-head">
          <div>
            <div className="obs-card-title">{unit === 'usd' ? 'Spend' : 'Tokens'} by purpose × model × source</div>
            <div className="obs-card-sub">
              Sorted by {unit === 'usd' ? 'cost' : 'tokens'} desc · click a column to re-sort
              {sourceFilter !== 'all' && <> · filtered to <strong>{SOURCE_FILTERS.find((s) => s.key === sourceFilter)?.label}</strong></>}
            </div>
          </div>
        </div>
        <RollupTable
          rows={filtered?.rollup ?? []}
          unit={unit}
          loading={loading}
          onDrill={(r) => setDrill({ kind: 'bucket', purpose: r.purpose, model: r.model, source: r.source })}
        />
      </section>

      {/* Top spenders — joins agent display name so the operator can SEE
          who's burning the most. Anonymous (no-agent) rows aggregate as
          one bottom row when present (e.g. avatar-image at agent creation). */}
      <section className="obs-card">
        <div className="obs-card-head">
          <div>
            <div className="obs-card-title">Top spenders</div>
            <div className="obs-card-sub">By agent · top 20 over the window</div>
          </div>
        </div>
        <TopAgentsTable
          rows={data?.topAgents ?? []}
          unit={unit}
          loading={loading}
          onDrill={(r) => r.agentId && setDrill({ kind: 'agent', agentId: r.agentId, agentName: r.agentName })}
        />
      </section>

      {/* By daemon version — correlate spend / cache behaviour with agent-cli
          releases. When a new version regresses token usage, the per-version
          rollup makes the bad bucket light up. NULL daemon_version rows
          (cloud agent-turn etc.) are excluded server-side; this card is for
          BYOA-version analysis specifically. */}
      <section className="obs-card">
        <div className="obs-card-head">
          <div>
            <div className="obs-card-title">By daemon version</div>
            <div className="obs-card-sub">Spend × cache behaviour per agent-cli release · drill into a row to see its calls</div>
          </div>
        </div>
        <DaemonVersionTable
          rows={data?.daemonVersions ?? []}
          unit={unit}
          loading={loading}
        />
      </section>

      {/* Slide-in drill-down panel — the "no SQL needed" view. Rendered as a
          sibling of the page chrome so its overlay sits on top of everything;
          the page underneath stays visible (and scrolled) so closing returns
          exactly where the operator was. */}
      <DrillPanel
        drill={drill}
        sinceDays={sinceDays}
        companyId={companyFilter || undefined}
        unit={unit}
        refreshSignal={refreshTick}
        onClose={() => setDrill(null)}
        onJumpToRun={(runId) => setDrill({ kind: 'run', runId })}
        onJumpToAgent={(agentId, agentName) => setDrill({ kind: 'agent', agentId, agentName })}
      />
    </div>
  )
}

// ─── Hero spend card ─────────────────────────────────────────────────────

function HeroSpendCard({ summary, unit, loading }: { summary: LlmObservabilityPayload['summary'] | undefined; unit: Unit; loading: boolean }) {
  const totalUsd = summary?.totalCostUsd ?? 0
  // Tokens headline counts every billable token (cached input included); the
  // sub then splits it so the cached share — which bills ~10× less — is never
  // hidden inside the total.
  const uncachedIn = summary?.totalInputTokens ?? 0
  const cachedIn = summary?.totalCachedInputTokens ?? 0
  const out = summary?.totalOutputTokens ?? 0
  const totalTok = uncachedIn + cachedIn + out
  return (
    <div className="obs-hero-card obs-hero-spend">
      <div className="obs-hero-spend-shine" aria-hidden />
      <div className="obs-hero-label">{unit === 'usd' ? 'Spend' : 'Tokens'} · last {summary?.sinceDays ?? 30}d</div>
      <div className="obs-hero-value">{loading ? '—' : unit === 'usd' ? fmtUsd(totalUsd, totalUsd < 100 ? 4 : 2) : fmtTokens(totalTok)}</div>
      <div className="obs-hero-sub">
        {summary
          ? (unit === 'usd'
              ? <>{fmtTokens(uncachedIn + cachedIn)} input · {fmtTokens(out)} output</>
              : <>{fmtTokens(uncachedIn)} in · {fmtTokens(cachedIn)} cached · {fmtTokens(out)} out</>)
          : <> </>}
      </div>
    </div>
  )
}

function HeroStatCard({ label, value, sub, accent, loading }: {
  label: string; value: string; sub: string; accent?: string; loading: boolean
}) {
  return (
    <div className="obs-hero-card">
      <div className="obs-hero-label">{label}</div>
      <div className="obs-hero-value" style={accent ? { color: accent } : undefined}>
        {loading ? '—' : value}
      </div>
      <div className="obs-hero-sub">{sub || ' '}</div>
    </div>
  )
}

// ─── Trend chart (stacked area) ──────────────────────────────────────────

/** Render the trend as a stacked area SVG. We do this by hand (no chart lib)
 *  because:
 *   - The shape is fixed (stacked over time) — no library flexibility needed.
 *   - The page is admin-only; pulling in recharts would be a runtime tax for
 *     a page two people will ever load.
 *   - Inline SVG gives us pixel-perfect control over the paper palette. */
function TrendChart({ buckets, unit, loading }: { buckets: LlmTrendBucket[]; unit: Unit; loading: boolean }) {
  // Trend buckets carry $ and input tokens (cached + uncached) but no output —
  // so the token series is total INPUT tokens, which the card sub spells out.
  const val = (b: LlmTrendBucket): number => unit === 'usd' ? b.costUsd : b.inputTokens + b.cachedInputTokens
  // Width is responsive via viewBox; height fixed. Stack order: largest total
  // cost on the bottom so the eye reads "the big slice is at the floor".
  const W = 1000
  const H = 220
  const PADL = 56, PADR = 16, PADT = 16, PADB = 32

  // Bucket → { day, [purpose]: cost }
  const days = useMemo(() => {
    const set = new Set<string>()
    for (const b of buckets) set.add(b.day)
    return [...set].sort()
  }, [buckets])

  const { purposes, series, maxStack } = useMemo(() => {
    const totalByPurpose = new Map<LlmCallPurpose, number>()
    const byDay = new Map<string, Map<LlmCallPurpose, number>>()
    for (const b of buckets) {
      totalByPurpose.set(b.purpose, (totalByPurpose.get(b.purpose) ?? 0) + val(b))
      const m = byDay.get(b.day) ?? new Map<LlmCallPurpose, number>()
      m.set(b.purpose, (m.get(b.purpose) ?? 0) + val(b))
      byDay.set(b.day, m)
    }
    const purposes = [...totalByPurpose.entries()]
      .sort(([, a], [, b]) => b - a)   // largest contributor at the bottom
      .map(([p]) => p)
    const series = days.map((d) => {
      const m = byDay.get(d) ?? new Map<LlmCallPurpose, number>()
      return purposes.map((p) => m.get(p) ?? 0)
    })
    const totalByDay = series.map((row) => row.reduce((a, b) => a + b, 0))
    const maxStack = Math.max(0.000001, ...totalByDay)
    return { purposes, series, totalByDay, maxStack }
  }, [buckets, days, unit])

  if (loading) return <div className="obs-chart-empty">Loading…</div>
  if (days.length === 0) return <div className="obs-chart-empty">No data in this window.</div>

  const innerW = W - PADL - PADR
  const innerH = H - PADT - PADB
  // X for each day; if only one day, center it.
  const xFor = (i: number) => days.length === 1
    ? PADL + innerW / 2
    : PADL + (i / (days.length - 1)) * innerW
  const yFor = (cum: number) => PADT + (1 - cum / maxStack) * innerH

  // Build a polygon per purpose: top edge = cumulative-above (or 0 for floor
  // layer), bottom edge = cumulative-above + this layer's value.
  type Layer = { purpose: LlmCallPurpose; path: string }
  const layers: Layer[] = []
  const cumBelow = new Array(days.length).fill(0)
  // We draw from largest contributor (bottom of stack) to smallest (top).
  for (let li = 0; li < purposes.length; li++) {
    const purpose = purposes[li]!
    const top: Array<[number, number]> = []
    const bot: Array<[number, number]> = []
    for (let i = 0; i < days.length; i++) {
      const v = series[i]![li]!
      const below = cumBelow[i]
      bot.push([xFor(i), yFor(below)])
      top.push([xFor(i), yFor(below + v)])
      cumBelow[i] = below + v
    }
    const path = [
      ...bot.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`),
      ...top.reverse().map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`),
      'Z',
    ].join(' ')
    layers.push({ purpose, path })
  }

  // Y-axis: 3 horizontal grid lines at 0/50/100% of max.
  const ticks = [0, 0.5, 1].map((f) => ({
    y: PADT + (1 - f) * innerH,
    label: unit === 'usd' ? fmtUsd(maxStack * f) : fmtTokens(maxStack * f),
  }))

  // Sparse x-axis labels — first, middle, last so the chart doesn't get a
  // cluttered date strip at the bottom.
  const xLabels = days.length <= 4
    ? days.map((d, i) => ({ x: xFor(i), label: d.slice(5) }))
    : [
        { x: xFor(0),                 label: days[0]!.slice(5) },
        { x: xFor(Math.floor((days.length - 1) / 2)), label: days[Math.floor((days.length - 1) / 2)]!.slice(5) },
        { x: xFor(days.length - 1),   label: days[days.length - 1]!.slice(5) },
      ]

  return (
    <div className="obs-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Daily cost by purpose">
        {/* Grid */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={t.y} y2={t.y} stroke="var(--ink-100)" strokeWidth={1} />
            <text x={PADL - 8} y={t.y + 4} textAnchor="end" fontSize={10} fill="var(--ink-500)">{t.label}</text>
          </g>
        ))}
        {/* Stacks */}
        {layers.map((l) => {
          const m = metaFor(l.purpose)
          return (
            <path key={l.purpose} d={l.path} fill={m.swatch} fillOpacity={0.85} stroke={m.swatch} strokeWidth={0.5}>
              <title>{m.label}</title>
            </path>
          )
        })}
        {/* X labels */}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--ink-500)">{l.label}</text>
        ))}
      </svg>
    </div>
  )
}

function PurposeLegend({ rollup, unit }: { rollup: LlmRollupRow[]; unit: Unit }) {
  // Aggregate by purpose so legend dots show the TOTAL too — answers "which
  // color is the big one?" without re-scanning the chart. Uses the active unit.
  const totals = new Map<LlmCallPurpose, number>()
  for (const r of rollup) totals.set(r.purpose, (totals.get(r.purpose) ?? 0) + (unit === 'usd' ? r.costUsd : totalTokens(r)))
  const sorted = [...totals.entries()].sort(([, a], [, b]) => b - a)
  if (sorted.length === 0) return null
  return (
    <div className="obs-legend">
      {sorted.map(([p, cost]) => {
        const m = metaFor(p)
        return (
          <span key={p} className="obs-legend-chip" title={m.blurb}>
            <span className="obs-legend-dot" style={{ background: m.swatch }} />
            <span className="obs-legend-label">{m.label}</span>
            <span className="obs-legend-cost">{unit === 'usd' ? fmtUsd(cost) : fmtTokens(cost)}</span>
          </span>
        )
      })}
    </div>
  )
}

// ─── Cache health card ───────────────────────────────────────────────────
//
// Cache hit rate is the single biggest optimization vector: every input token
// that hits cache costs ~10× less than uncached. This card answers three
// questions at a glance:
//
//   1. "How bad is it?"    — overall hit rate + $ savable, hero stat
//   2. "Is it getting worse?" — daily timeseries line chart (UTC days)
//   3. "Where do I look first?" — per-purpose horizontal bars sorted by
//                                  savable $ desc, so the top of the list is
//                                  always the highest-ROI optimization target.
//
// Tone: same paper palette as the rest of the page, but the bars carry a
// subtle sky→coral gradient through the threshold (>50% sky, <20% coral) so
// the operator's eye finds the bad rows without reading labels.

function CacheHealthCard({ summary, trend, rollup, unit, loading }: {
  summary: LlmObservabilityPayload['summary'] | undefined
  trend: LlmTrendBucket[]
  rollup: LlmRollupRow[]
  unit: Unit
  loading: boolean
}) {
  // Per-purpose aggregation from the rollup (already source-filtered upstream).
  const perPurpose = useMemo(() => {
    const m = new Map<LlmCallPurpose, {
      uncached: number; cached: number; savable: number; cost: number
    }>()
    for (const r of rollup) {
      const cur = m.get(r.purpose) ?? { uncached: 0, cached: 0, savable: 0, cost: 0 }
      cur.uncached += r.inputTokens
      cur.cached += r.cachedInputTokens
      cur.savable += r.savableUsd
      cur.cost += r.costUsd
      m.set(r.purpose, cur)
    }
    const out = [...m.entries()].map(([purpose, v]) => {
      const total = v.uncached + v.cached
      const hitRate = total > 0 ? v.cached / total : null
      return { purpose, hitRate, savableUsd: v.savable, costUsd: v.cost, uncachedIn: v.uncached, cachedIn: v.cached }
    })
    // Biggest optimization target at the top: by savable $ in USD mode, by
    // uncached (cacheable) input tokens in token mode.
    out.sort((a, b) => unit === 'usd' ? b.savableUsd - a.savableUsd : b.uncachedIn - a.uncachedIn)
    return out
  }, [rollup, unit])

  // Daily hit rate from the trend (sum across purposes per day).
  const daily = useMemo(() => {
    const m = new Map<string, { uncached: number; cached: number }>()
    for (const t of trend) {
      const cur = m.get(t.day) ?? { uncached: 0, cached: 0 }
      cur.uncached += t.inputTokens
      cur.cached += t.cachedInputTokens
      m.set(t.day, cur)
    }
    const days = [...m.entries()].sort(([a], [b]) => a < b ? -1 : 1)
    return days.map(([day, v]) => {
      const total = v.uncached + v.cached
      return { day, hitRate: total > 0 ? v.cached / total : null }
    })
  }, [trend])

  const hit = summary?.cacheHitRate
  const savable = summary?.savableUsd ?? 0

  return (
    <section className="obs-card obs-cache-card">
      <div className="obs-card-head">
        <div>
          <div className="obs-card-title">Cache health</div>
          <div className="obs-card-sub">
            How much you're paying for tokens the cache could have served.
          </div>
        </div>
      </div>

      <div className="obs-cache-hero">
        <div className="obs-cache-hero-main">
          <div className="obs-cache-hero-label">Overall hit rate</div>
          <div className={`obs-cache-hero-value ${cacheToneClass(hit)}`}>
            {hit != null ? fmtPct(hit, 1) : '—'}
          </div>
          <div className="obs-cache-hero-sub">
            {hit != null
              ? <>of {fmtTokens((summary?.totalInputTokens ?? 0) + (summary?.totalCachedInputTokens ?? 0))} input tokens served from cache</>
              : '—'}
          </div>
        </div>
        <div className="obs-cache-hero-aside">
          <div className="obs-cache-hero-label">{unit === 'usd' ? 'Money on the table' : 'Cacheable tokens'}</div>
          <div className="obs-cache-hero-value obs-cache-tone-warn">
            {loading ? '—' : unit === 'usd' ? fmtUsd(savable, savable < 1 ? 4 : 2) : fmtTokens(summary?.totalInputTokens ?? 0)}
          </div>
          <div className="obs-cache-hero-sub">
            upper bound · {unit === 'usd' ? 'if every input were cached' : 'uncached input tokens'}
          </div>
        </div>
      </div>

      <CacheDailyChart days={daily} loading={loading} />

      <div className="obs-cache-bars">
        <div className="obs-cache-bars-head">By purpose · sorted by {unit === 'usd' ? 'savable $' : 'cacheable tokens'}</div>
        {perPurpose.length === 0 && <div className="obs-empty">No input traffic in this window.</div>}
        {perPurpose.map((p) => (
          <CachePurposeBar key={p.purpose} {...p} unit={unit} />
        ))}
      </div>
    </section>
  )
}

/** Color-class for the hit-rate value: coral when bad, gold when mid, sky-
 *  deep when good. Same thresholds the per-purpose bars use, so the hero +
 *  bars stay visually consistent. */
function cacheToneClass(hitRate: number | null | undefined): string {
  if (hitRate == null) return ''
  if (hitRate >= 0.7) return 'obs-cache-tone-good'
  if (hitRate >= 0.3) return 'obs-cache-tone-mid'
  return 'obs-cache-tone-bad'
}

/** Single-line area chart of daily cache hit rate. 0–100% Y axis (fixed), so
 *  a long flat low line reads as "you're not caching, do something". Soft
 *  area fill under the line + a faint 50% midline as a target. */
function CacheDailyChart({ days, loading }: {
  days: Array<{ day: string; hitRate: number | null }>
  loading: boolean
}) {
  const W = 1000, H = 160, PADL = 56, PADR = 16, PADT = 16, PADB = 32
  const innerW = W - PADL - PADR
  const innerH = H - PADT - PADB

  if (loading) return <div className="obs-chart-empty obs-cache-chart-empty">Loading…</div>
  if (days.length === 0) return <div className="obs-chart-empty obs-cache-chart-empty">No daily data yet.</div>

  // Points; skip nulls (no traffic) so the line interpolates instead of dropping to 0.
  const points = days
    .map((d, i) => ({ i, day: d.day, y: d.hitRate }))
    .filter((p) => p.y != null) as Array<{ i: number; day: string; y: number }>

  const xFor = (i: number) => days.length === 1
    ? PADL + innerW / 2
    : PADL + (i / (days.length - 1)) * innerW
  const yFor = (rate: number) => PADT + (1 - rate) * innerH

  const linePath = points.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${xFor(p.i).toFixed(1)},${yFor(p.y).toFixed(1)}`).join(' ')
  const areaPath = points.length > 0
    ? `${linePath} L${xFor(points[points.length - 1]!.i).toFixed(1)},${(H - PADB).toFixed(1)} L${xFor(points[0]!.i).toFixed(1)},${(H - PADB).toFixed(1)} Z`
    : ''

  // Y ticks at 0/50/100%.
  const yTicks = [0, 0.5, 1].map((r) => ({ y: yFor(r), label: `${Math.round(r * 100)}%` }))
  // Sparse X labels (first/middle/last).
  const xLabels = days.length <= 4
    ? days.map((d, i) => ({ x: xFor(i), label: d.day.slice(5) }))
    : [
        { x: xFor(0),                                  label: days[0]!.day.slice(5) },
        { x: xFor(Math.floor((days.length - 1) / 2)),  label: days[Math.floor((days.length - 1) / 2)]!.day.slice(5) },
        { x: xFor(days.length - 1),                    label: days[days.length - 1]!.day.slice(5) },
      ]

  return (
    <div className="obs-cache-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Daily cache hit rate">
        <defs>
          <linearGradient id="obsCacheGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--skype-deep)" stopOpacity={0.18} />
            <stop offset="100%" stopColor="var(--skype-deep)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Grid + the 50% target line */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={t.y} y2={t.y} stroke="var(--ink-100)" strokeWidth={1} strokeDasharray={i === 1 ? '4 4' : ''} />
            <text x={PADL - 8} y={t.y + 4} textAnchor="end" fontSize={10} fill="var(--ink-500)">{t.label}</text>
          </g>
        ))}
        {/* Area + line */}
        {areaPath && <path d={areaPath} fill="url(#obsCacheGrad)" />}
        {linePath && <path d={linePath} fill="none" stroke="var(--skype-deep)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {/* Data points */}
        {points.map((p, idx) => (
          <circle key={idx} cx={xFor(p.i)} cy={yFor(p.y)} r={2.5} fill="var(--skype-deep)">
            <title>{`${p.day}: ${fmtPct(p.y, 1)}`}</title>
          </circle>
        ))}
        {/* X labels */}
        {xLabels.map((l, i) => (
          <text key={i} x={l.x} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--ink-500)">{l.label}</text>
        ))}
      </svg>
    </div>
  )
}

/** One horizontal bar — purpose dot + label, then a progress-style bar
 *  whose fill width is the hit rate. The right side shows savable $ — the
 *  actionable number. */
function CachePurposeBar({ purpose, hitRate, savableUsd, costUsd, uncachedIn, cachedIn, unit }: {
  purpose: LlmCallPurpose
  hitRate: number | null
  savableUsd: number
  costUsd: number
  uncachedIn: number
  cachedIn: number
  unit: Unit
}) {
  const m = metaFor(purpose)
  const ratePct = hitRate != null ? Math.max(0, Math.min(1, hitRate)) * 100 : 0
  const total = uncachedIn + cachedIn
  return (
    <div className="obs-cache-bar-row" title={`${fmtTokens(cachedIn)} of ${fmtTokens(total)} input tokens cached`}>
      <div className="obs-cache-bar-purpose">
        <span className="obs-dot" style={{ background: m.swatch }} aria-hidden />
        <span className="obs-cache-bar-label">{m.label}</span>
      </div>
      <div className="obs-cache-bar-track">
        <div
          className={`obs-cache-bar-fill ${cacheToneClass(hitRate)}`}
          style={{ width: `${ratePct}%` }}
          aria-label={`${ratePct.toFixed(0)}%`}
        />
        <span className="obs-cache-bar-rate">{hitRate != null ? fmtPct(hitRate, 0) : '—'}</span>
      </div>
      <div className="obs-cache-bar-savable">
        {unit === 'usd'
          ? <>
              {savableUsd > 0 ? <span className="obs-cache-bar-savable-amt">{fmtUsd(savableUsd, savableUsd < 1 ? 4 : 2)}</span> : <span className="obs-cache-bar-savable-na">—</span>}
              <span className="obs-cache-bar-savable-sub"> of {fmtUsd(costUsd, costUsd < 1 ? 4 : 2)}</span>
            </>
          : <>
              {uncachedIn > 0 ? <span className="obs-cache-bar-savable-amt">{fmtTokens(uncachedIn)}</span> : <span className="obs-cache-bar-savable-na">—</span>}
              <span className="obs-cache-bar-savable-sub"> of {fmtTokens(uncachedIn + cachedIn)} in</span>
            </>}
      </div>
    </div>
  )
}

// ─── Rollup table ────────────────────────────────────────────────────────

type SortKey = 'costUsd' | 'totalTok' | 'calls' | 'inputTokens' | 'outputTokens' | 'failureRate' | 'cacheHitRate'

function RollupTable({ rows, unit, loading, onDrill }: { rows: LlmRollupRow[]; unit: Unit; loading: boolean; onDrill: (r: LlmRollupRow) => void }) {
  // The headline column re-keys with the unit so the default sort always
  // matches what's on screen ($ desc in USD, total tokens desc in tokens).
  const headlineKey: SortKey = unit === 'usd' ? 'costUsd' : 'totalTok'
  const [sort, setSort] = useState<{ key: SortKey; dir: 'desc' | 'asc' }>({ key: 'costUsd', dir: 'desc' })
  // Keep the active sort pinned to the headline column when the unit flips, so
  // toggling $↔tokens doesn't leave the list sorted by a now-hidden metric.
  useEffect(() => { setSort((s) => (s.key === 'costUsd' || s.key === 'totalTok') ? { key: headlineKey, dir: 'desc' } : s) }, [headlineKey])
  const enriched = useMemo(() => rows.map((r) => {
    const failureRate = r.calls > 0 ? (r.calls - r.okCalls) / r.calls : 0
    const totalIn = r.inputTokens + r.cachedInputTokens
    const cacheHitRate = totalIn > 0 ? r.cachedInputTokens / totalIn : 0
    return { ...r, failureRate, cacheHitRate, totalTok: totalTokens(r) }
  }), [rows])
  const sorted = useMemo(() => {
    const out = [...enriched]
    out.sort((a, b) => (b[sort.key] as number) - (a[sort.key] as number))
    if (sort.dir === 'asc') out.reverse()
    return out
  }, [enriched, sort])

  const head = (label: string, key: SortKey, align: 'left' | 'right' = 'right') => (
    <button
      type="button"
      className={`obs-th-btn obs-th-${align}${sort.key === key ? ' is-active' : ''}`}
      onClick={() => setSort((s) => s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' })}
    >
      {label}{sort.key === key && <span className="obs-sort-arrow">{sort.dir === 'desc' ? '↓' : '↑'}</span>}
    </button>
  )

  if (loading && rows.length === 0) return <div className="obs-empty">Loading…</div>
  if (!loading && rows.length === 0) return <div className="obs-empty">No spend in this window. (Either no traffic, or the ledger hasn’t recorded any calls yet.)</div>

  return (
    <div className="obs-table">
      <div className="obs-thead">
        <div className="obs-th-left">Purpose</div>
        <div className="obs-th-left">Model · source</div>
        <div>{unit === 'usd' ? head('Cost', 'costUsd') : head('Tokens', 'totalTok')}</div>
        <div>{head('Calls', 'calls')}</div>
        <div>{head('Input', 'inputTokens')}</div>
        <div>{head('Output', 'outputTokens')}</div>
        <div>{head('Cache hit', 'cacheHitRate')}</div>
        <div>{head('Failed', 'failureRate')}</div>
      </div>
      {sorted.map((r, i) => {
        const m = metaFor(r.purpose)
        return (
          <button
            type="button"
            className="obs-row obs-row-button"
            key={`${r.purpose}-${r.model}-${r.source}-${i}`}
            onClick={() => onDrill(r)}
            title="Click to see every call in this bucket"
          >
            <div className="obs-cell-purpose">
              <span className="obs-dot" style={{ background: m.swatch }} aria-hidden />
              <div className="obs-cell-purpose-text">
                <div className="obs-cell-purpose-label">{m.label}</div>
                <div className="obs-cell-purpose-blurb">{m.blurb}</div>
              </div>
            </div>
            <div className="obs-cell-model">
              <div className="obs-mono">{r.model}</div>
              <div className="obs-cell-source">
                {r.source}
                {/* BYOA cost is meter-equivalent — what the same tokens WOULD
                    cost on the metered API. The operator's actual bill is a
                    flat subscription. Flagging this on the row keeps the $
                    column honest without hiding the comparable signal. */}
                {unit === 'usd' && isByoaSource(r.source) && <span className="obs-meter-flag" title="BYOA spend is meter-equivalent (what these tokens would cost on the metered API) — operator's actual bill is a flat subscription">·meter</span>}
                {unit === 'usd' && r.costEstimated && <span className="obs-est-flag" title="Cost computed from a seeded estimate, not an operator-supplied rate">·est</span>}
              </div>
            </div>
            <div className="obs-cell-num obs-cell-cost">{unit === 'usd' ? fmtUsd(r.costUsd, r.costUsd < 1 ? 4 : 2) : fmtTokens(r.totalTok)}</div>
            <div className="obs-cell-num">{fmtInt(r.calls)}</div>
            <div className="obs-cell-num">
              {fmtTokens(r.inputTokens + r.cachedInputTokens)}
              {r.cachedInputTokens > 0 && <span className="obs-cell-sub"> · {fmtTokens(r.cachedInputTokens)} cached</span>}
            </div>
            <div className="obs-cell-num">{fmtTokens(r.outputTokens)}</div>
            <div className="obs-cell-num">{r.cacheHitRate > 0 ? fmtPct(r.cacheHitRate, 0) : '—'}</div>
            <div className="obs-cell-num">
              {r.failureRate > 0
                ? <span style={{ color: r.failureRate > 0.1 ? 'var(--coral-deep)' : 'var(--ink-700)' }}>{fmtPct(r.failureRate, 1)}</span>
                : '—'}
              {r.rateLimitedCalls > 0 && <span className="obs-cell-sub"> · {r.rateLimitedCalls} rl</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/** Small round agent avatar: portrait image when present, colored-initial
 *  fallback otherwise (mirrors the app's Avatar fallback, but self-contained so
 *  the admin bundle needn't construct a full Participant). */
function AgentAvatar({ url, initial, bg, size = 26 }: { url: string | null; initial: string | null; bg: string | null; size?: number }) {
  const [broke, setBroke] = useState(false)
  const showImg = !!url && !broke
  return (
    <span className="obs-agent-avatar" style={{ width: size, height: size, background: showImg ? 'transparent' : (bg ?? 'var(--ink-200)') }} aria-hidden>
      {showImg
        ? <img src={url} alt="" width={size} height={size} onError={() => setBroke(true)} />
        : <span>{initial ?? '?'}</span>}
    </span>
  )
}

function TopAgentsTable({ rows, unit, loading, onDrill }: { rows: LlmObservabilityPayload['topAgents']; unit: Unit; loading: boolean; onDrill: (r: LlmTopAgentRow) => void }) {
  // Server ranks by $ desc; in token mode re-rank client-side (only ~20 rows)
  // so the biggest token consumer — not the biggest spender — sits on top.
  const sorted = useMemo(
    () => unit === 'usd' ? rows : [...rows].sort((a, b) => totalTokens(b) - totalTokens(a)),
    [rows, unit],
  )
  if (loading && rows.length === 0) return <div className="obs-empty">Loading…</div>
  if (!loading && rows.length === 0) return <div className="obs-empty">No agent-attributed spend in this window.</div>
  return (
    <div className="obs-table obs-table-compact">
      <div className="obs-thead obs-thead-compact">
        <div className="obs-th-left">Agent</div>
        <div className="obs-th-left">Company</div>
        <div className="obs-th-right">{unit === 'usd' ? 'Cost' : 'Tokens'}</div>
        <div className="obs-th-right">Calls</div>
      </div>
      {sorted.map((r, i) => (
        <button
          type="button"
          className={`obs-row obs-row-compact${r.agentId ? ' obs-row-button' : ''}`}
          key={`${r.agentId ?? 'anon'}-${i}`}
          onClick={() => r.agentId && onDrill(r)}
          disabled={!r.agentId}
          title={r.agentId ? "Click to see every call this agent made" : "Anonymous bucket — not drillable"}
        >
          <div className="obs-cell-agent">
            {r.agentId && <AgentAvatar url={r.agentAvatarUrl} initial={r.agentInitial} bg={r.agentAvatarBg} />}
            <div className="obs-cell-agent-text">
              <div className="obs-cell-purpose-label">{r.agentName ?? (r.agentId ? <span className="obs-mono">{r.agentId.slice(0, 12)}</span> : <em>—</em>)}</div>
              {r.agentId && <div className="obs-mono obs-cell-sub">{r.agentId}</div>}
            </div>
          </div>
          <div className="obs-cell-sub">
            {r.companyName ?? (r.companyId ? <span className="obs-mono">{r.companyId}</span> : '—')}
          </div>
          <div className="obs-cell-num obs-cell-cost">
            {unit === 'usd' ? fmtUsd(r.costUsd, r.costUsd < 1 ? 4 : 2) : fmtTokens(totalTokens(r))}
            {unit !== 'usd' && r.cachedInputTokens > 0 && <span className="obs-cell-sub"> · {fmtTokens(r.cachedInputTokens)} cached</span>}
          </div>
          <div className="obs-cell-num">{fmtInt(r.calls)}</div>
        </button>
      ))}
    </div>
  )
}

// ─── Daemon-version rollup ────────────────────────────────────────────────
//
// "After v0.1.X shipped, did average cost-per-hop go up?" The single most
// useful release-regression-spotter the page has. Each row is one
// (daemonVersion × source) combo, sorted by lastSeen DESC so the freshest
// version sits at the top. Cache hit % is the headline column — a release
// that broke session caching shows up here as a giant drop.
//
// Same visual shape as TopAgents/Rollup so the page reads as a family. The
// "last seen" column shows a relative timestamp so the operator immediately
// knows whether a version is still live.

function DaemonVersionTable({ rows, unit, loading }: {
  rows: LlmDaemonVersionRow[]
  unit: Unit
  loading: boolean
}) {
  if (loading && rows.length === 0) return <div className="obs-empty">Loading…</div>
  if (!loading && rows.length === 0) return (
    <div className="obs-empty">
      No daemon-version data yet. Operators' daemons start populating this once they upgrade to the version that reports it.
    </div>
  )
  return (
    <div className="obs-table obs-table-daemon">
      <div className="obs-thead obs-thead-daemon">
        <div className="obs-th-left">Version</div>
        <div className="obs-th-left">Source</div>
        <div className="obs-th-right">Calls</div>
        <div className="obs-th-right">{unit === 'usd' ? 'Cost' : 'Tokens'}</div>
        <div className="obs-th-right">Cache hit</div>
        <div className="obs-th-right">Avg / call</div>
        <div className="obs-th-right">Failed</div>
        <div className="obs-th-right">Last seen</div>
      </div>
      {rows.map((r, i) => {
        const totalIn = r.inputTokens + r.cachedInputTokens
        const hitRate = totalIn > 0 ? r.cachedInputTokens / totalIn : null
        const totalTok = r.inputTokens + r.cachedInputTokens + r.outputTokens
        const avgCost = r.calls > 0 ? r.costUsd / r.calls : 0
        const avgTok = r.calls > 0 ? totalTok / r.calls : 0
        return (
          <div className="obs-row obs-row-daemon" key={`${r.daemonVersion}-${r.source}-${i}`}>
            <div className="obs-cell-version">
              <span className="obs-cell-purpose-label">v{r.daemonVersion}</span>
            </div>
            <div className="obs-cell-source">{r.source}{isByoaSource(r.source) && <span className="obs-meter-flag">·meter</span>}</div>
            <div className="obs-cell-num">{fmtInt(r.calls)}</div>
            <div className="obs-cell-num obs-cell-cost">{unit === 'usd' ? fmtUsd(r.costUsd, r.costUsd < 1 ? 4 : 2) : fmtTokens(totalTok)}</div>
            <div className="obs-cell-num">{hitRate != null ? <span className={cacheToneClass(hitRate)}>{fmtPct(hitRate, 1)}</span> : '—'}</div>
            <div className="obs-cell-num">{unit === 'usd' ? fmtUsd(avgCost, 6) : fmtTokens(avgTok)}</div>
            <div className="obs-cell-num">{r.failureRate > 0 ? <span style={{ color: r.failureRate > 0.1 ? 'var(--coral-deep)' : 'var(--ink-700)' }}>{fmtPct(r.failureRate, 1)}</span> : '—'}</div>
            <div className="obs-cell-num obs-cell-sub-only" title={new Date(r.lastSeen).toLocaleString()}>{relativeTime(r.lastSeen)}</div>
          </div>
        )
      })}
    </div>
  )
}

/** Tiny "now-3h" / "2d ago" formatter for the "Last seen" column. The full
 *  timestamp lives in the title attribute. */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const ms = Date.now() - t
  if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

// ─── Drill-down panel ────────────────────────────────────────────────────
//
// The "no SQL needed" view. Opens from any rollup row click; shows the actual
// llm_calls rows that drove that bucket, each with its extras JSONB expanded.
// Three open shapes:
//
//   - bucket   — clicked a rollup row → narrowed to one (purpose, model, source)
//   - run      — clicked "view this run's trail" inside an open panel → all
//                hops for ONE run_id, sorted by hopIndex / created_at
//   - agent    — clicked an agent in the Top Spenders table → all calls by
//                that agent_id in the window
//
// The panel owns its own local sort + refresh state. Switching `drill`
// objects from outside refetches but keeps the sort UI sticky.

type CallSort = 'cost' | 'latency' | 'hop' | 'created'

function DrillPanel({ drill, sinceDays, companyId, unit, refreshSignal, onClose, onJumpToRun, onJumpToAgent }: {
  drill: DrillDown | null
  sinceDays: number
  /** Inherits the page's tenant scope so a clicked rollup row stays inside
   *  that tenant. When undefined, the drill ranges over all accounts. */
  companyId?: string
  unit: Unit
  /** Bumped by the page's refresh button / auto-refresh so an open panel
   *  re-fetches its (always-live, raw) rows in lockstep with the dashboard. */
  refreshSignal: number
  onClose: () => void
  onJumpToRun: (runId: string) => void
  onJumpToAgent: (agentId: string, agentName: string | null) => void
}) {
  const [rows, setRows] = useState<LlmCallRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<CallSort>('cost')

  // Re-fetch when the drill target OR the sort changes. sinceDays + the
  // page's tenant scope are also relevant — a tighter window means fewer rows
  // even within one bucket; flipping accounts narrows the rows further.
  useEffect(() => {
    if (!drill) { setRows(null); return }
    let cancelled = false
    setLoading(true); setErr(null)
    const params: Parameters<typeof adminApi.observabilityLlmCalls>[0] = { sinceDays, limit: 100, sortBy }
    if (drill.kind === 'bucket') { params.purpose = drill.purpose; params.model = drill.model; params.source = drill.source }
    else if (drill.kind === 'run')   { params.runId = drill.runId }
    else if (drill.kind === 'agent') { params.agentId = drill.agentId }
    if (companyId) params.companyId = companyId
    adminApi.observabilityLlmCalls(params)
      .then((r) => { if (!cancelled) setRows(r) })
      .catch((e: unknown) => { if (!cancelled) setErr(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [drill, sinceDays, sortBy, companyId, refreshSignal])

  // ESC closes — common dashboard expectation, free implementation here.
  useEffect(() => {
    if (!drill) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drill, onClose])

  if (!drill) return null

  const meta = drill.kind === 'bucket' ? metaFor(drill.purpose) : null
  const title =
    drill.kind === 'bucket' ? meta!.label
    : drill.kind === 'run'   ? 'Run trail'
    : drill.kind === 'agent' ? (drill.agentName ?? 'Agent')
    : '—'
  const subtitle =
    drill.kind === 'bucket' ? <><span className="obs-mono">{drill.model}</span> · {drill.source}</>
    : drill.kind === 'run'   ? <span className="obs-mono">{drill.runId}</span>
    : drill.kind === 'agent' ? <span className="obs-mono">{drill.agentId}</span>
    : null

  return (
    <>
      <div className="obs-drill-scrim" onClick={onClose} aria-hidden />
      <aside className="obs-drill" role="dialog" aria-label={`Drill-down: ${title}`}>
        <header className="obs-drill-head">
          <div className="obs-drill-titlebar">
            {meta && <span className="obs-dot" style={{ background: meta.swatch }} aria-hidden />}
            <div>
              <div className="obs-drill-title">{title}</div>
              <div className="obs-drill-sub">{subtitle}</div>
            </div>
          </div>
          <button type="button" className="obs-drill-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="obs-drill-sortbar">
          <span className="obs-drill-sortbar-label">Sort</span>
          {(['cost', 'latency', 'hop', 'created'] as CallSort[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`obs-pill${sortBy === s ? ' is-active' : ''}`}
              onClick={() => setSortBy(s)}
            >{s}</button>
          ))}
        </div>

        <div className="obs-drill-body">
          {err && <div className="obs-error">Failed to load: {err}</div>}
          {loading && !rows && <div className="obs-empty">Loading…</div>}
          {rows && rows.length === 0 && <div className="obs-empty">No calls in this window.</div>}
          {rows && rows.map((c) => (
            <DrillCallCard
              key={c.id}
              call={c}
              unit={unit}
              onJumpToRun={onJumpToRun}
              onJumpToAgent={onJumpToAgent}
            />
          ))}
        </div>
      </aside>
    </>
  )
}

function DrillCallCard({ call, unit, onJumpToRun, onJumpToAgent }: {
  call: LlmCallRow
  unit: Unit
  onJumpToRun: (runId: string) => void
  onJumpToAgent: (agentId: string, agentName: string | null) => void
}) {
  // Cache hit %: cached / (uncached + cached). NaN-safe.
  const totalIn = call.inputTokens + call.cachedInputTokens
  const cacheHit = totalIn > 0 ? call.cachedInputTokens / totalIn : null
  // The five extras we WANT to surface as first-class chips when present
  // (these are the ones the engine + daemon write). Anything else still
  // shows up via the generic kv list below so nothing's invisible.
  const ex = call.extras ?? {}
  const hopIndex = typeof ex.hopIndex === 'number' ? ex.hopIndex : (typeof ex.hop === 'number' ? ex.hop : null)
  const toolUses = typeof ex.toolUses === 'number' ? ex.toolUses : null
  const textChars = typeof ex.textChars === 'number' ? ex.textChars : null
  const itemsDropped = typeof ex.itemsDropped === 'number' ? ex.itemsDropped : null
  const inputTokensBefore = typeof ex.inputTokensBefore === 'number' ? ex.inputTokensBefore : null
  // Compaction's compression ratio is THE diagnostic: tokens in vs out.
  const compressionRatio = call.purpose === 'compaction' && inputTokensBefore && call.outputTokens > 0
    ? Math.round(inputTokensBefore / call.outputTokens)
    : null

  // Other extras → generic kv list (ones we haven't already chipped).
  const KNOWN_KEYS = new Set(['hopIndex', 'hop', 'toolUses', 'textChars', 'itemsDropped', 'inputTokensBefore'])
  const otherExtras: Array<[string, unknown]> = Object.entries(ex).filter(([k]) => !KNOWN_KEYS.has(k))

  const m = metaFor(call.purpose)
  return (
    <article className="obs-drill-card">
      <div className="obs-drill-card-head">
        <span className="obs-dot" style={{ background: m.swatch }} aria-hidden />
        <div className="obs-drill-card-headtext">
          <div className="obs-drill-card-title">
            {m.label}
            <span className="obs-drill-card-when">· {new Date(call.createdAt).toLocaleString()}</span>
          </div>
          <div className="obs-drill-card-sub">
            <span className="obs-mono">{call.model}</span>
            <span> · {call.source}</span>
            {unit === 'usd' && call.costEstimated && <span className="obs-est-flag">·est</span>}
            {unit === 'usd' && isByoaSource(call.source) && <span className="obs-meter-flag">·meter</span>}
            {call.daemonVersion && (
              <span className="obs-version-flag" title={`Recorded by daemon (npm cumora) version ${call.daemonVersion}`}>
                · v{call.daemonVersion}
              </span>
            )}
            <span className={call.status === 'ok' ? '' : 'obs-drill-status-bad'}> · {call.status}</span>
          </div>
        </div>
        <div className="obs-drill-card-cost">{unit === 'usd' ? fmtUsd(call.costUsd, call.costUsd < 1 ? 4 : 2) : fmtTokens(totalTokens(call))}</div>
      </div>

      {/* First-class chips for the high-signal extras. Order is intentional
          (hop index → tool calls → output mix → compaction diagnostic), so
          the eye scans the bottleneck first. */}
      <div className="obs-drill-chips">
        {hopIndex != null  && <Chip label="hop"      value={`#${hopIndex}`} />}
        {toolUses != null  && <Chip label="tools"    value={fmtInt(toolUses)} />}
        {textChars != null && <Chip label="text"     value={`${fmtInt(textChars)}c`} />}
        {compressionRatio  && <Chip label="compress" value={`${compressionRatio}×`} title="inputTokensBefore / outputTokens" />}
        {itemsDropped != null && <Chip label="dropped" value={fmtInt(itemsDropped)} />}
        {call.latencyMs && call.latencyMs > 0 && <Chip label="latency" value={`${(call.latencyMs / 1000).toFixed(1)}s`} />}
      </div>

      <div className="obs-drill-numgrid">
        <NumCell label="input" value={fmtTokens(call.inputTokens)} />
        <NumCell label="cached" value={fmtTokens(call.cachedInputTokens)} hint={cacheHit != null ? fmtPct(cacheHit, 0) : undefined} />
        <NumCell label="output" value={fmtTokens(call.outputTokens)} />
        <NumCell label="reasoning" value={call.reasoningTokens > 0 ? fmtTokens(call.reasoningTokens) : '—'} />
      </div>

      {call.error && (
        <div className="obs-drill-err">
          <div className="obs-drill-err-label">error</div>
          <div className="obs-drill-err-body">{call.error}</div>
        </div>
      )}

      {otherExtras.length > 0 && (
        <details className="obs-drill-rawextras">
          <summary>extras ({otherExtras.length})</summary>
          <dl>
            {otherExtras.map(([k, v]) => (
              <div key={k} className="obs-drill-kv">
                <dt>{k}</dt>
                <dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      <footer className="obs-drill-card-foot">
        {call.runId && (
          <button type="button" className="obs-drill-link" onClick={() => onJumpToRun(call.runId!)}>
            run trail <span className="obs-mono">{call.runId.slice(0, 8)}…</span>
          </button>
        )}
        {call.agentId && (
          <button type="button" className="obs-drill-link" onClick={() => onJumpToAgent(call.agentId!, call.agentName)}>
            agent {call.agentName ?? <span className="obs-mono">{call.agentId.slice(0, 8)}…</span>}
          </button>
        )}
      </footer>
    </article>
  )
}

function Chip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="obs-drill-chip" title={title}>
      <span className="obs-drill-chip-k">{label}</span>
      <span className="obs-drill-chip-v">{value}</span>
    </span>
  )
}

function NumCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="obs-drill-num">
      <div className="obs-drill-num-label">{label}</div>
      <div className="obs-drill-num-value">{value}</div>
      {hint && <div className="obs-drill-num-hint">{hint}</div>}
    </div>
  )
}

// ─── Tenant picker ───────────────────────────────────────────────────────
//
// Compact dropdown listing every company with ledger activity in the window,
// ranked by cost so the heaviest spenders are at the top. Selecting one
// scopes the entire page (hero, chart, rollup, top spenders, drill-down) to
// that tenant. "All accounts" clears the filter. The list comes from the
// global tenants slice of the payload — it isn't filtered by the page's own
// companyFilter so the picker can always offer every active account.
//
// Uses the shared searchable <Combobox> (200 tenants is too many to scroll —
// the operator types to filter). Options are cost/token-ranked with the spend
// in the right-aligned `hint`, "All accounts" first.

function TenantPicker({ tenants, value, unit, onChange }: {
  tenants: LlmTenantRow[]
  value: string
  unit: Unit
  onChange: (companyId: string) => void
}) {
  // Stable label per tenant so a partially-resolved companies join doesn't
  // surface bare ids in the picker. Format: "Name · $cost" / "Name · NtokT"
  // depending on the active unit; falls back to the company id when unnamed.
  const options = useMemo(() => {
    const name = (t: LlmTenantRow): string => t.name?.trim() || t.slug?.trim() || `(${t.companyId.slice(0, 8)}…)`
    // Sort by the metric that's actually ON SCREEN, descending. The server
    // ranks tenants by $; in token mode that order looks random (a cheap model
    // burns more tokens than an expensive one), so re-sort by tokens here.
    const sorted = [...tenants].sort((a, b) =>
      unit === 'usd' ? b.costUsd - a.costUsd : totalTokens(b) - totalTokens(a))
    return [
      { value: '', label: `All accounts (${tenants.length})` },
      // amount goes in `hint` (right-aligned, never truncated) so the per-tenant
      // spend stays visible even when the workspace name is long — the label
      // truncates, the number doesn't.
      ...sorted.map((t) => ({
        value: t.companyId,
        label: name(t),
        hint: fmtAmount(unit, t.costUsd, totalTokens(t)),
      })),
    ]
  }, [tenants, unit])
  return (
    <Combobox
      value={value}
      onValueChange={onChange}
      options={options}
      ariaLabel="Filter by tenant"
      placeholder="All accounts"
      searchPlaceholder="Search workspaces…"
      className="w-[320px]"
    />
  )
}
