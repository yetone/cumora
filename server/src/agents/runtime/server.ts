/**
 * `/runtime/*` — HTTP surface that agent-runner pods talk to.
 *
 * Every endpoint maps 1:1 to a method on `AgentRuntimeClient`. The pod
 * never accesses Postgres or Redis directly; it issues an HTTP call,
 * the server delegates to `inprocClient`, and the response is the same
 * JSON shape declared in `client.ts`.
 *
 * Auth: every request carries `Authorization: Bearer <agent-runtime
 * JWT>`. The JWT pins `{ agentId, companyId }`. Endpoints take the
 * agentId from the *token* (not the request body) so a compromised pod
 * can't operate as someone else's agent.
 *
 * Mount at `/runtime` from `server/src/index.ts`. Not nested under
 * `/api` because the cookie-auth middleware on /api would reject these
 * (and we don't want pods sharing the human session cookie path).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { runCli } from '../cli.js'
import { buildTriageRequest, gatherClaimsByConvo } from '../inbox-triage.js'
import { buildTeamRosterText, getPersona } from '../personas.js'
import { gatherAgentAgenda, classifyAgendaActionable, renderAgendaBrief, claimStallNudge, AGENDA_CLASSIFIER_ERROR } from '../agenda.js'
import { consumeAgentTurnToken } from '../scheduler.js'
import { touchAgentRun, recordTriage, type TriageSource } from '../observability.js'
import { buildRuntimeArgv } from './cli-argv.js'
import { attachFsEndpoints } from './fs-endpoints.js'
import { inprocClient } from './inproc-client.js'
import { verifyAgentToken, type AgentRuntimeClaims } from './jwt.js'
import { attachWakeStream, } from './wake-bus.js'

export type { WakeEvent } from './wake-bus.js'

interface RuntimeRequest extends Request {
  agent?: AgentRuntimeClaims
}

function authMiddleware(req: RuntimeRequest, res: Response, next: NextFunction): void {
  const header = req.headers['authorization']
  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing bearer token' })
    return
  }
  try {
    req.agent = verifyAgentToken(header.slice('Bearer '.length).trim())
    next()
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : 'invalid token' })
  }
}

function withAgent(
  handler: (claims: AgentRuntimeClaims, req: RuntimeRequest, res: Response) => Promise<void>,
) {
  return async (req: RuntimeRequest, res: Response): Promise<void> => {
    const claims = req.agent
    if (!claims) { res.status(401).json({ error: 'unauthenticated' }); return }
    try {
      await handler(claims, req, res)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[runtime] ${req.method} ${req.path} failed`, msg)
      res.status(500).json({ error: msg })
    }
  }
}

export const runtimeRouter: Router = Router()
runtimeRouter.use(authMiddleware as never)

// ─── wake stream: server pushes events to the agent's long-running pod ─

runtimeRouter.get('/wake-stream', withAgent(async (c, _req, res) => {
  await attachWakeStream(c.sub, res)
  // Don't end — attachWakeStream keeps the response open until the
  // client disconnects.
}))

// ─── workspace FS: the Pod's FUSE driver lives over these endpoints ─

attachFsEndpoints(runtimeRouter, withAgent)

// ─── canonical action surface: cumora CLI ──────────────────────────
//
// Pods don't run the cumora CLI in-process (they have no DB access).
// Instead the in-pod `cumora` binary is a thin curl shim that POSTs
// argv here; we run it on the server's behalf. Auth: bearer token is
// the same agent-runtime JWT; we *strip* any `--as` the caller passed
// and inject the token's pinned agentId so a compromised pod can't
// impersonate another agent.
runtimeRouter.post('/cli', withAgent(async (c, req, res) => {
  const body = req.body as { argv?: unknown } | undefined
  const argv = Array.isArray(body?.argv) ? body!.argv.filter((x): x is string => typeof x === 'string') : null
  if (!argv) { res.status(400).json({ error: 'argv (string[]) required' }); return }

  // Drop any client-supplied `--as <id>` / `--as=<id>` — the JWT pins
  // identity, and we prepend `--as <jwt.sub>` so runCli resolves to the
  // pinned agent. Implementation lives in cli-argv.ts so the strip
  // rules can be unit-tested in isolation.
  const result = await runCli(buildRuntimeArgv(c.sub, argv))
  res.json({
    text: result.text,
    exitCode: result.exitCode,
    ok: result.ok,
    sideEffects: result.sideEffects ?? [],
  })
}))

// ─── reads ──────────────────────────────────────────────────────────

runtimeRouter.get('/persona', withAgent(async (c, _req, res) => {
  res.json({ persona: await inprocClient.loadPersona(c.sub) })
}))

runtimeRouter.post('/conversation/company-id', withAgent(async (_c, req, res) => {
  const body = req.body as { conversationId?: string } | undefined
  if (!body?.conversationId) { res.status(400).json({ error: 'conversationId required' }); return }
  res.json({ companyId: await inprocClient.getConversationCompanyId(body.conversationId) })
}))

runtimeRouter.get('/inbox', withAgent(async (c, req, res) => {
  const rows = await inprocClient.loadInbox(c.sub)
  // Advance the freshness-preflight "seen" boundary per-convo to the max
  // seq we just surfaced — the caller will SHOW these rows to the agent
  // (default path: daemon's snapshotUnread → brief → big brain). For
  // probe-only callers (maybeSteer's "should I steer?" check; the
  // engine-failure target lookup), pass `?probe=1` to skip the advance:
  // those paths don't necessarily inject the rows into the agent's
  // session, and advancing here would pollute the baseline past what
  // the brain has actually been shown, letting duplicate-collisions
  // slip past cmdReply's preflight (observed today: bram saw Iris's
  // "1" via maybeSteer's loadInbox, baseline advanced past Iris's seq,
  // Bram's preflight then saw nothing newer and posted a duplicate "1").
  const probe = String(req.query.probe ?? '').trim() === '1'
  if (!probe && rows.length > 0) {
    const perConvoMaxSeq = new Map<string, number>()
    for (const r of rows) {
      const cur = perConvoMaxSeq.get(r.conversation_id) ?? 0
      if (r.sequence > cur) perConvoMaxSeq.set(r.conversation_id, r.sequence)
    }
    const { recordSeen } = await import('../seen-boundary.js')
    await Promise.all([...perConvoMaxSeq.entries()].map(([cid, seq]) => recordSeen(c.sub, cid, seq)))
  }
  res.json({ rows })
}))

// BYOA: build the triage request server-side (we have the DB for inbox+context)
// but DON'T run the model — return either an empty-inbox verdict (nothing to
// judge) or the {instructions, input} prompt. The daemon runs it on its LOCAL
// small brain, so judgment never leaves the operator's machine and never spends
// cloud quota. This is the whole point of BYOA: local compute. NB: no regex
// decides anything — every actionability/mode call is the small model's.
runtimeRouter.get('/inbox-triage/payload', withAgent(async (c, _req, res) => {
  const persona = await inprocClient.loadPersona(c.sub)
  if (!persona) { res.status(404).json({ error: 'agent not found' }); return }
  const inbox = await inprocClient.loadInbox(c.sub)
  const convoIds = [...new Set(inbox.map((m) => m.conversation_id))]
  // Content-blind cost floor (NOT a loop decision). The daemon self-polls every
  // 20s, bypassing the scheduler's fan-out rate limit, so a runaway could spin
  // the local model unbounded. Bound it by the agent's activation budget — same
  // counter the cloud fan-out uses. Whether to reply is still 100% the small
  // model's call (it sees "thread heat" and goes quiet on agent-only threads);
  // this only stops cost from running away if the model fails to.
  if (convoIds.length > 0 && !(await consumeAgentTurnToken(c.sub))) {
    res.json({ verdict: {
      actionable: false,
      reason: 'turn-rate floor: over activation budget this minute — deferring (the next minute or a human revives it)',
      promptNote: '',
      source: 'rate-limited',
    } })
    return
  }
  const context = await inprocClient.loadContext(c.sub, convoIds)
  // Authoritative "real work here" signal (active worklog claims per
  // convo) — lets the gate suppress unclaimed agent-only chatter from FACT, and
  // sets the claim-aware loop-cap tier. Same gather the cloud path uses. The
  // supervision signal rides along (same as the cloud path): a human actively
  // reading the company elevates activity side-rooms to the HIGH backstop.
  const [claimsByConvo, humanActiveInCompany] = await Promise.all([
    gatherClaimsByConvo(inbox),
    persona.companyId ? inprocClient.humanRecentlyActive(persona.companyId).catch(() => false) : Promise.resolve(false),
  ])
  // Pure GATE — TRULY identical to the cloud agent's triage. Cloud (turn.ts) calls
  // classifyInboxTriage WITHOUT `strict`, i.e. the lenient prompt that biases toward
  // "relevant → wake". BYOA used to pass strict:true — the long, aggressive
  // skip-everything prompt (ACK-loop / duplicate / thread-heat suppression) meant as
  // a token-saving conservative gate. That divergence is exactly why BYOA went silent
  // on a repeated human directive (it judged "新开狼人杀 again = duplicate → skip")
  // while Cloud answered. Same model, DIFFERENT prompt → different behavior. Drop
  // strict so BYOA runs the EXACT same gate prompt as Cloud. Cost is still bounded by
  // the per-minute activation rate floor above, not by an aggressive prompt.
  res.json(buildTriageRequest({ agentId: c.sub, persona, inbox, context, claimsByConvo, humanActiveInCompany }))
}))

// BOARD-AWARENESS for BYOA: the daemon has no DB, so the server gathers this
// agent's actionable AGENDA — Kanban cards assigned to / @-mentioning them in
// non-done columns + due calendar events — and runs the SAME cheap cerebellum
// classifier the cloud idle scheduler (idle.ts) uses, returning a focused brief
// when there is real work. This is what makes a BYOA agent PROACTIVELY pick up
// assigned board tasks instead of only reacting to a chat push. The classifier
// runs on the cloud support model (Cumora-subsidized), so it does NOT spend the
// operator's quota; the operator's brain is spent only on the actual work. The
// daemon gates calls behind a "quiet for N minutes" window (its anti-loop), so
// this isn't hit every poll. Empty / non-actionable → { actionable: false }.
runtimeRouter.get('/agenda', withAgent(async (c, _req, res) => {
  if (!c.companyId) { res.json({ actionable: false }); return }
  const agenda = await gatherAgentAgenda(c.sub, c.companyId)
  if (agenda.cards.length === 0 && agenda.events.length === 0 && agenda.stalls.length === 0) {
    res.json({ actionable: false, cards: 0, events: 0, stalls: 0 })
    return
  }
  const persona = await getPersona(c.sub)
  if (!persona) { res.json({ actionable: false }); return }
  const verdict = await classifyAgendaActionable({ persona, companyId: c.companyId, agenda, agentId: c.sub })
  if (!verdict.actionable) {
    res.json({ actionable: false, cards: agenda.cards.length, events: agenda.events.length, stalls: agenda.stalls.length, reason: verdict.reason })
    return
  }
  // The cerebellum said yes. Now CLAIM each stall so exactly ONE agent nudges it
  // (and never twice for the same stall state) — keep only the stalls this agent
  // won; others are being handled by whoever claimed first. Cards/events are
  // per-agent (no race), so they pass through untouched.
  //
  // Pass source='fallback' when the verdict came from the deterministic
  // fallback (classifier 503) so the NX TTL is short (5min vs 45min) — a "no"
  // from the chosen agent shouldn't permanently lock out other members.
  const nudgeSource = verdict.reason.startsWith(AGENDA_CLASSIFIER_ERROR) ? 'fallback' : 'classified'
  const wonStalls = []
  for (const s of agenda.stalls) {
    if (await claimStallNudge(s.conversationId, { source: nudgeSource })) wonStalls.push(s)
  }
  const finalAgenda = { cards: agenda.cards, events: agenda.events, stalls: wonStalls }
  // If stalls were the ONLY reason and another agent already claimed them all,
  // there's nothing left for THIS agent to do — don't wake its big brain.
  if (finalAgenda.cards.length === 0 && finalAgenda.events.length === 0 && finalAgenda.stalls.length === 0) {
    res.json({ actionable: false, cards: 0, events: 0, stalls: 0, reason: 'stall already claimed by another agent' })
    return
  }
  res.json({
    actionable: true,
    focus: verdict.focus,
    brief: renderAgendaBrief(finalAgenda, verdict.focus),
    cards: finalAgenda.cards.length,
    events: finalAgenda.events.length,
    stalls: finalAgenda.stalls.length,
  })
}))

runtimeRouter.post('/memory/query', withAgent(async (c, req, res) => {
  const body = req.body as {
    queryText?: string
    limits?: { semantic?: number; recent?: number; total?: number }
    projectIds?: string[]
    conversationIds?: string[]
  } | undefined
  const rows = await inprocClient.loadMemory(c.sub, body?.queryText ?? '', body?.limits, {
    projectIds: body?.projectIds,
    conversationIds: body?.conversationIds,
  })
  res.json({ rows })
}))

runtimeRouter.post('/context', withAgent(async (c, req, res) => {
  const body = req.body as { conversationIds?: string[] } | undefined
  const rows = await inprocClient.loadContext(c.sub, body?.conversationIds ?? [])
  res.json({ rows })
}))

runtimeRouter.get('/climate', withAgent(async (c, _req, res) => {
  res.json({ rows: await inprocClient.loadClimate(c.sub) })
}))

runtimeRouter.get('/skills', withAgent(async (c, _req, res) => {
  res.json({ rows: await inprocClient.loadSkillsIndex(c.sub) })
}))

runtimeRouter.post('/faces', withAgent(async (_c, req, res) => {
  const body = req.body as { participantIds?: string[] } | undefined
  const rows = await inprocClient.loadFaces(body?.participantIds ?? [])
  res.json({ rows })
}))

runtimeRouter.get('/system-prompt', withAgent(async (c, _req, res) => {
  res.json({ prompt: await inprocClient.buildSystemPrompt(c.sub) })
}))

// The live team roster (names + roles + ids), scoped to the agent's company.
// BYOA agents fetch this each real turn so they know WHO their teammates are and
// what each does — the cloud agent already gets it baked into its system prompt.
runtimeRouter.get('/roster', withAgent(async (c, _req, res) => {
  const persona = await inprocClient.loadPersona(c.sub)
  if (!persona) { res.status(404).json({ error: 'agent not found' }); return }
  res.json({ roster: await buildTeamRosterText(persona.companyId, c.sub) })
}))

// ─── status + presence ──────────────────────────────────────────────

runtimeRouter.post('/status', withAgent(async (c, req, res) => {
  const body = req.body as { status?: string } | undefined
  if (!body?.status) { res.status(400).json({ error: 'status required' }); return }
  await inprocClient.setStatus(c.sub, body.status as 'avail' | 'working' | 'thinking' | 'waiting' | 'resting')
  res.json({ ok: true })
}))

runtimeRouter.post('/status/heartbeat', withAgent(async (c, req, res) => {
  const body = req.body as { status?: string } | undefined
  if (!body?.status) { res.status(400).json({ error: 'status required' }); return }
  await inprocClient.heartbeatStatus(c.sub, body.status as 'working' | 'thinking' | 'waiting')
  res.json({ ok: true })
}))

runtimeRouter.post('/typing', withAgent(async (c, req, res) => {
  const body = req.body as { conversationId?: string; done?: boolean } | undefined
  if (!body?.conversationId) { res.status(400).json({ error: 'conversationId required' }); return }
  await inprocClient.publishTyping({
    conversationId: body.conversationId,
    agentId: c.sub,
    done: Boolean(body.done),
    companyId: c.companyId,
  })
  res.json({ ok: true })
}))

// ─── observability ──────────────────────────────────────────────────

runtimeRouter.post('/runs', withAgent(async (c, req, res) => {
  const body = req.body as {
    trigger?: Record<string, unknown>
    inputMessageIds?: string[]
    inboxCount?: number
    fingerprint?: string
  } | undefined
  const runId = await inprocClient.createRun({
    agentId: c.sub,
    companyId: c.companyId,
    trigger: body?.trigger,
    inputMessageIds: body?.inputMessageIds,
    inboxCount: body?.inboxCount,
    fingerprint: body?.fingerprint,
  })
  res.json({ runId })
}))

runtimeRouter.post('/events', withAgent(async (c, req, res) => {
  const body = req.body as {
    runId?: string
    kind?: string
    level?: 'debug' | 'info' | 'warn' | 'error'
    title?: string
    data?: Record<string, unknown>
    stage?: string
  } | undefined
  if (!body?.runId || !body.kind || !body.title) {
    res.status(400).json({ error: 'runId, kind, title required' }); return
  }
  await inprocClient.recordEvent({
    runId: body.runId,
    agentId: c.sub,
    companyId: c.companyId,
    kind: body.kind,
    level: body.level,
    title: body.title,
    data: body.data,
    stage: body.stage,
  })
  res.json({ ok: true })
}))

// Record one LOCAL (BYOA) triage in the cost ledger. The daemon runs triage on
// the operator's own machine, so the server never sees its usage unless the
// daemon posts it here. Identity comes from the JWT. Best-effort. (Cloud triage
// is recorded inline in classifyInboxTriage — it never hits this route.)
runtimeRouter.post('/triage', withAgent(async (c, req, res) => {
  const body = req.body as {
    source?: string
    model?: string | null
    actionable?: boolean
    reason?: string | null
    usage?: import('./client.js').RuntimeTokenUsage | null
    daemonVersion?: string
  } | undefined
  const daemonVersion = typeof body?.daemonVersion === 'string' && body.daemonVersion.trim() ? body.daemonVersion.trim().slice(0, 32) : null
  const source: TriageSource = (body?.source as TriageSource) ?? 'byoa-claude'
  void recordTriage({
    agentId: c.sub,
    companyId: c.companyId,
    source,
    model: body?.model ?? null,
    actionable: body?.actionable === true,
    reason: body?.reason ?? null,
    usage: body?.usage ?? null,
  })
  // ALSO mirror to the universal ledger so BYOA local triage shows up next to
  // cloud spend on the Observability page. The agent_triages row keeps the
  // verdict / reason for the triage-economics view; llm_calls just holds the
  // raw call shape. Same fire-and-forget discipline as recordTriage above.
  if (body?.usage) {
    const { recordLlmCall } = await import('../llm-ledger.js')
    void recordLlmCall({
      purpose: 'inbox-triage',
      companyId: c.companyId,
      agentId: c.sub,
      source,
      model: body.model ?? '<unknown>',
      usage: {
        inputTokens: body.usage.inputTokens ?? 0,
        cachedInputTokens: body.usage.cachedInputTokens ?? 0,
        cacheCreationTokens: body.usage.cacheCreationTokens ?? 0,
        outputTokens: body.usage.outputTokens ?? 0,
      },
      latencyMs: 0,
      status: 'ok',
      extras: { actionable: body.actionable === true, reason: (body.reason ?? '').slice(0, 200) },
      daemonVersion,
    })
  }
  res.json({ ok: true })
}))

// Per-HOP trajectory for BYOA agents. The daemon's ClaudeSession /
// CodexSession emits one EngineHopReport per assistant message (Claude) or
// per turn-completed (Codex) and batches them into one POST per N hops or
// every ~250ms (whichever first). This endpoint accepts a batch + inserts
// one llm_calls row per hop with the appropriate source ('byoa-claude' |
// 'byoa-codex' | 'byoa-grok' | 'byoa-cursor' | 'byoa-opencode' | 'byoa-pi').
// Fire-and-forget; a DB hiccup must never break the wake.
runtimeRouter.post('/llm-calls', withAgent(async (c, req, res) => {
  const body = req.body as {
    source?: string
    /** agent-cli (npm cumora) version of the daemon emitting this batch. One
     *  version per batch — there's no mid-batch upgrade. Missing on pre-
     *  version daemons → rows recorded with daemon_version=NULL. */
    daemonVersion?: string
    hops?: Array<{
      purpose?: string
      runId?: string | null
      conversationId?: string | null
      model?: string
      usage?: import('./client.js').RuntimeTokenUsage | null
      latencyMs?: number
      status?: 'ok' | 'rate_limited' | 'timeout' | 'failed'
      error?: string | null
      extras?: Record<string, unknown>
    }>
  } | undefined
  const source = (
    body?.source === 'byoa-claude' || body?.source === 'byoa-codex' ||
    body?.source === 'byoa-grok' || body?.source === 'byoa-cursor' ||
    body?.source === 'byoa-opencode' || body?.source === 'byoa-pi'
  ) ? body.source : 'byoa-claude'
  const daemonVersion = typeof body?.daemonVersion === 'string' && body.daemonVersion.trim() ? body.daemonVersion.trim().slice(0, 32) : null
  const hops = Array.isArray(body?.hops) ? body!.hops : []
  if (hops.length === 0) { res.json({ ok: true, inserted: 0 }); return }
  const { recordLlmCall } = await import('../llm-ledger.js')
  // Whitelist purposes the daemon may declare — anything else gets coerced
  // to 'agent-turn' so a future daemon version naming an unknown purpose
  // doesn't smuggle a free-form string into the rollup.
  const KNOWN_PURPOSES = new Set([
    'agent-turn', 'inbox-triage', 'synthetic-wake-gate', 'agenda',
    'compaction', 'completion-verify', 'steer-summary',
  ])
  for (const h of hops) {
    const purpose = (typeof h.purpose === 'string' && KNOWN_PURPOSES.has(h.purpose) ? h.purpose : 'agent-turn') as 'agent-turn'
    const model = typeof h.model === 'string' && h.model ? h.model : '<unknown>'
    void recordLlmCall({
      purpose,
      companyId: c.companyId,
      agentId: c.sub,
      runId: h.runId ?? null,
      conversationId: h.conversationId ?? null,
      source,
      model,
      usage: h.usage ? {
        inputTokens: h.usage.inputTokens ?? 0,
        cachedInputTokens: h.usage.cachedInputTokens ?? 0,
        cacheCreationTokens: h.usage.cacheCreationTokens ?? 0,
        outputTokens: h.usage.outputTokens ?? 0,
      } : null,
      latencyMs: typeof h.latencyMs === 'number' && Number.isFinite(h.latencyMs) ? h.latencyMs : 0,
      status: h.status ?? 'ok',
      error: h.error ?? null,
      extras: h.extras,
      daemonVersion,
    })
  }
  res.json({ ok: true, inserted: hops.length })
}))

// Heartbeat a long engine turn so the 10-min stale-run sweeper doesn't reap it.
// BYOA emits no mid-run events (cloud does), so its daemon pings this while the
// engine turn is in flight. Best-effort: a DB hiccup must not break the turn.
runtimeRouter.post('/runs/:runId/heartbeat', withAgent(async (_c, req, res) => {
  try { await touchAgentRun(String(req.params.runId)) } catch { /* swept-or-gone is fine */ }
  res.json({ ok: true })
}))

runtimeRouter.post('/runs/:runId/finish', withAgent(async (_c, req, res) => {
  const runId = String(req.params.runId)
  const body = req.body as {
    status?: 'running' | 'completed' | 'failed' | 'skipped'
    summary?: string
    error?: string | null
    toolCallCount?: number
    tokenCount?: number
    model?: string | null
    usage?: import('./client.js').RuntimeTokenUsage | null
  } | undefined
  if (!body?.status) { res.status(400).json({ error: 'status required' }); return }
  await inprocClient.finishRun({
    runId,
    status: body.status,
    summary: body.summary,
    error: body.error,
    toolCallCount: body.toolCallCount,
    tokenCount: body.tokenCount,
    model: body.model,
    usage: body.usage,
  })
  res.json({ ok: true })
}))

// ─── steering busy heartbeat ────────────────────────────────────────
//
// The pod's HttpRuntimeClient pings these every ~2s during a turn so
// the cumora-server's message-routing path can tell at a glance
// whether an agent is currently mid-turn (→ deliver a steer event)
// or idle (→ deliver a normal wake). agentId comes from the JWT, not
// the body — same impersonation defence as every other endpoint here.

runtimeRouter.post('/busy/heartbeat', withAgent(async (c, req, res) => {
  const body = req.body as { ttlSec?: number } | undefined
  const ttlSec = typeof body?.ttlSec === 'number' && body.ttlSec > 0 && body.ttlSec <= 300 ? body.ttlSec : 5
  await inprocClient.recordBusyHeartbeat(c.sub, ttlSec)
  res.json({ ok: true })
}))

runtimeRouter.post('/busy/clear', withAgent(async (c, _req, res) => {
  await inprocClient.clearBusyHeartbeat(c.sub)
  res.json({ ok: true })
}))

// ─── thinking-claim — peer-visible "I'm composing" signal ─────────
runtimeRouter.post('/thinking/mark', withAgent(async (c, req, res) => {
  const body = req.body as { conversationIds?: string[]; ttlSec?: number } | undefined
  const ids = Array.isArray(body?.conversationIds) ? body!.conversationIds.filter((s) => typeof s === 'string') : []
  const ttlSec = typeof body?.ttlSec === 'number' && body.ttlSec > 0 && body.ttlSec <= 600 ? body.ttlSec : 60
  await inprocClient.markThinking(c.sub, ids, ttlSec)
  // Stamp the freshness-preflight compose-anchor for these convos at THE
  // SAME moment (NX-preserved, so heartbeats don't keep bumping it later
  // and defeating the point — the anchor must reflect TURN START, not
  // "most recent heartbeat"). The cli.cmdReply preflight uses this anchor
  // to detect peer posts that landed mid-compose even when the agent's
  // own glance has since advanced the seen-baseline past them.
  if (ids.length > 0) {
    const { recordComposeAnchor, getComposeAnchor } = await import('../seen-boundary.js')
    const now = Date.now()
    await Promise.all(ids.map(async (cid) => {
      const existing = await getComposeAnchor(c.sub, cid)
      if (existing > 0 && now - existing < 30 * 60_000) return // already stamped this turn — keep the first
      await recordComposeAnchor(c.sub, cid, now)
    }))
  }
  res.json({ ok: true })
}))
runtimeRouter.post('/thinking/unmark', withAgent(async (c, req, res) => {
  const body = req.body as { conversationIds?: string[] } | undefined
  const ids = Array.isArray(body?.conversationIds) ? body!.conversationIds.filter((s) => typeof s === 'string') : []
  await inprocClient.unmarkThinking(c.sub, ids)
  // Clear the compose-anchor too — turn ended, next turn gets a fresh anchor.
  if (ids.length > 0) {
    const { clearComposeAnchor } = await import('../seen-boundary.js')
    await Promise.all(ids.map((cid) => clearComposeAnchor(c.sub, cid)))
  }
  res.json({ ok: true })
}))
runtimeRouter.get('/thinking/peek', withAgent(async (_c, req, res) => {
  const cid = typeof req.query.conversationId === 'string' ? req.query.conversationId : ''
  if (!cid) { res.status(400).json({ error: 'conversationId required' }); return }
  const agents = await inprocClient.peekThinking(cid)
  res.json({ agents })
}))

// ─── worklog — anti-duplicate-work claims ───────────────────────────
// Mirrors the thinking-claim endpoints but for heavy actions
// (web-search, doc draft, image gen) rather than typing indicators.
runtimeRouter.post('/worklog/claim', withAgent(async (c, req, res) => {
  const body = req.body as {
    scopeKey?: string
    taskType?: string
    subject?: string
    ttlSec?: number
  } | undefined
  if (!body?.scopeKey || !body.taskType || !body.subject) {
    res.status(400).json({ error: 'scopeKey, taskType, subject required' }); return
  }
  const result = await inprocClient.claimWork({
    scopeKey: body.scopeKey,
    agentId: c.sub,
    taskType: body.taskType as Parameters<typeof inprocClient.claimWork>[0]['taskType'],
    subject: body.subject,
    ttlSec: typeof body.ttlSec === 'number' && body.ttlSec > 0 && body.ttlSec <= 3600 ? body.ttlSec : undefined,
  })
  res.json(result)
}))
runtimeRouter.post('/worklog/release', withAgent(async (c, req, res) => {
  const body = req.body as {
    scopeKey?: string
    taskType?: string
    subject?: string
  } | undefined
  if (!body?.scopeKey || !body.taskType || !body.subject) {
    res.status(400).json({ error: 'scopeKey, taskType, subject required' }); return
  }
  await inprocClient.releaseWork({
    scopeKey: body.scopeKey,
    agentId: c.sub,
    taskType: body.taskType as Parameters<typeof inprocClient.releaseWork>[0]['taskType'],
    subject: body.subject,
  })
  res.json({ ok: true })
}))
runtimeRouter.get('/worklog/peek', withAgent(async (_c, req, res) => {
  const sk = typeof req.query.scopeKey === 'string' ? req.query.scopeKey : ''
  if (!sk) { res.status(400).json({ error: 'scopeKey required' }); return }
  const entries = await inprocClient.peekWorklog(sk)
  res.json({ entries })
}))

// ─── steering dedup: advance per-agent conversation_reads cursor ─────
//
// At turn end the pod tells us which messages it already consumed via
// a mid-turn steer drain, so the next wake's loadInbox doesn't surface
// them again. agentId from JWT (c.sub).
runtimeRouter.post('/conversation/mark-read', withAgent(async (c, req, res) => {
  const body = req.body as { conversationId?: string; upToMessageId?: string } | undefined
  if (!body?.conversationId || !body.upToMessageId) {
    res.status(400).json({ error: 'conversationId and upToMessageId required' }); return
  }
  await inprocClient.markConversationRead({
    agentId: c.sub,
    conversationId: body.conversationId,
    upToMessageId: body.upToMessageId,
  })
  res.json({ ok: true })
}))

runtimeRouter.post('/notices', withAgent(async (c, req, res) => {
  const body = req.body as {
    conversationId?: string
    noticeKind?: string
    text?: string
    dedupeKey?: string
    dedupeTtlSec?: number
  } | undefined
  if (!body?.conversationId || !body.noticeKind || !body.text || !body.dedupeKey) {
    res.status(400).json({ error: 'conversationId, noticeKind, text, dedupeKey required' })
    return
  }
  // Identity comes from the JWT, NEVER the body — a notice is always about
  // THIS agent (e.g. its own engine failure). Trusting a body-supplied
  // agentId/companyId would let any valid token spoof another agent as the
  // author, cross-tenant. Scope the target conversation to the token's
  // company and require this agent to be a member of it.
  const member = await inprocClient.isConversationMember(body.conversationId, c.sub, c.companyId)
  if (!member) {
    res.status(403).json({ error: 'not a member of that conversation' })
    return
  }
  const out = await inprocClient.postSystemNotice({
    conversationId: body.conversationId,
    companyId: c.companyId,
    agentId: c.sub,
    noticeKind: body.noticeKind,
    text: body.text,
    dedupeKey: body.dedupeKey,
    dedupeTtlSec: body.dedupeTtlSec ?? 3600,
  })
  res.json(out)
}))
