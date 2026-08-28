/**
 * HttpRuntimeClient — `AgentRuntimeClient` impl that talks to the
 * cumora server's `/runtime/*` endpoints over HTTP.
 *
 * Used inside agent-runner pods. The pod's process gets:
 *   - `CUMORA_AGENT_RUNTIME_URL` — server origin (e.g. http://host.docker.internal:5181)
 *   - `CUMORA_AGENT_RUNTIME_TOKEN` — signed JWT pinning agentId + companyId
 *
 * No DB or Redis access — that's the whole point. The pod's only side
 * channel is the storage layer for attachment downloads (signed URLs).
 *
 * Shape-for-shape mirror of `InProcRuntimeClient`. The agentId and companyId
 * arguments are the SAME identity baked into the JWT — endpoints ignore
 * caller-supplied identity and use the token. We still take them as params so
 * the interface signatures match (and tests can pass them through).
 */
import type {
  AgentRuntimeClient,
  ClimateRow,
  ContextRow,
  FaceRow,
  InboxRow,
  MemoryRow,
  PersonaRow,
  RuntimeTokenUsage,
  SkillIndexEntry,
  WorklogEntry,
  WorkTaskType,
} from './client.js'
import { notifyAlert } from '../../alerting.js'

/** Per-process failure counter for the busy heartbeat. The heartbeat
 *  must not crash a turn on a transient Redis hiccup, but a SUSTAINED
 *  failure means the server-side steer routing has been broken for
 *  the duration and silently degraded back to wake-only — exactly the
 *  failure mode steering existed to fix. Once we miss this many
 *  heartbeats in a row, alert via the process-level webhook so
 *  someone notices instead of finding it in stderr next week. */
const BUSY_HEARTBEAT_ALERT_THRESHOLD = 5
let busyHeartbeatConsecutiveFailures = 0

/** Test-only: reset the module-level failure counter so test cases
 *  don't poison each other. Production code must never call this. */
export function _resetBusyHeartbeatStateForTests(): void {
  busyHeartbeatConsecutiveFailures = 0
}

export interface HttpClientOptions {
  /** Origin of the cumora server (no trailing slash). */
  baseUrl: string
  /** Signed agent-runtime JWT — sent on every request. */
  token: string
  /** Override fetch (mainly for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Per-request timeout (ms). Default 30s — agent reads can be slow when
   *  pgvector lookups warm a cold HNSW index. */
  timeoutMs?: number
}

export class HttpRuntimeClient implements AgentRuntimeClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        let msg = text
        try { msg = (JSON.parse(text) as { error?: string }).error ?? text } catch { /* keep raw */ }
        throw new Error(`runtime ${method} ${path} → ${res.status}: ${msg}`)
      }
      return text.length === 0 ? (undefined as unknown as T) : (JSON.parse(text) as T)
    } finally {
      clearTimeout(timer)
    }
  }

  private async callWithRetry<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { attempts: number; baseDelayMs: number; maxDelayMs: number },
  ): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt < opts.attempts; attempt++) {
      try {
        return await this.call<T>(method, path, body)
      } catch (err) {
        lastErr = err
        if (attempt === opts.attempts - 1) break
        const delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw lastErr
  }

  // ─── reads ────────────────────────────────────────────────────────

  async loadPersona(_agentId: string): Promise<PersonaRow | null> {
    const out = await this.call<{ persona: PersonaRow | null }>('GET', '/persona')
    return out.persona
  }

  async getConversationCompanyId(conversationId: string): Promise<string | null> {
    const out = await this.call<{ companyId: string | null }>(
      'POST', '/conversation/company-id', { conversationId },
    )
    return out.companyId
  }


  async loadInbox(_agentId: string): Promise<InboxRow[]> {
    const out = await this.call<{ rows: InboxRow[] }>('GET', '/inbox')
    return out.rows
  }

  async loadMemory(
    _agentId: string,
    queryText: string,
    limits: { semantic?: number; recent?: number; total?: number } = {},
    scope: { projectIds?: readonly string[]; conversationIds?: readonly string[] } = {},
  ): Promise<MemoryRow[]> {
    const out = await this.call<{ rows: MemoryRow[] }>('POST', '/memory/query', { queryText, limits, ...scope })
    return out.rows
  }

  async loadContext(
    _agentId: string,
    _companyId: string,
    conversationIds: string[],
  ): Promise<ContextRow[]> {
    const out = await this.call<{ rows: ContextRow[] }>('POST', '/context', { conversationIds })
    return out.rows
  }

  async loadClimate(_agentId: string): Promise<ClimateRow[]> {
    const out = await this.call<{ rows: ClimateRow[] }>('GET', '/climate')
    return out.rows
  }

  async loadSkillsIndex(_agentId: string): Promise<SkillIndexEntry[]> {
    const out = await this.call<{ rows: SkillIndexEntry[] }>('GET', '/skills')
    return out.rows
  }

  async loadFaces(participantIds: string[]): Promise<FaceRow[]> {
    const out = await this.call<{ rows: FaceRow[] }>('POST', '/faces', { participantIds })
    return out.rows
  }

  async buildSystemPrompt(_agentId: string): Promise<string | null> {
    const out = await this.call<{ prompt: string | null }>('GET', '/system-prompt')
    return out.prompt
  }

  // ─── status + presence ────────────────────────────────────────────

  async setStatus(
    _agentId: string,
    status: 'avail' | 'working' | 'thinking' | 'waiting' | 'resting',
  ): Promise<void> {
    // Status updates are UX-only (the status pill in the conversation
    // header). A fetch hiccup here used to propagate up and kill the
    // whole turn — exact same failure mode as recordEvent. Swallow.
    try {
      await this.call<{ ok: true }>('POST', '/status', { status })
    } catch (err) {
      console.warn(`[runtime] setStatus(${status}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async heartbeatStatus(
    _agentId: string,
    status: 'working' | 'thinking' | 'waiting',
  ): Promise<void> {
    // Heartbeat is a TTL refresh on the status pill. Missing one is
    // harmless; failing the turn would be self-defeating.
    try {
      await this.call<{ ok: true }>('POST', '/status/heartbeat', { status })
    } catch (err) {
      console.warn(`[runtime] heartbeatStatus(${status}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async publishTyping(args: {
    conversationId: string
    agentId: string
    done: boolean
    companyId?: string | null
  }): Promise<void> {
    // Typing indicator. UX hint, not turn-critical. The turn.ts
    // finally block already tries to publish a `done:true` even if
    // the `done:false` at turn start failed — so a half-pair is
    // fine here, and a full failure of both is no worse than the
    // user seeing no dots at all.
    try {
      await this.call<{ ok: true }>('POST', '/typing', {
        conversationId: args.conversationId,
        done: args.done,
      })
    } catch (err) {
      console.warn(`[runtime] publishTyping(done=${args.done}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  // ─── observability ────────────────────────────────────────────────

  async createRun(args: {
    agentId: string
    companyId?: string | null
    trigger?: Record<string, unknown>
    inputMessageIds?: string[]
    inboxCount?: number
    fingerprint?: string
  }): Promise<string> {
    const out = await this.call<{ runId: string }>('POST', '/runs', {
      trigger: args.trigger,
      inputMessageIds: args.inputMessageIds,
      inboxCount: args.inboxCount,
      fingerprint: args.fingerprint,
    })
    return out.runId
  }

  async recordEvent(event: {
    runId: string
    agentId: string
    companyId?: string | null
    kind: string
    level?: 'debug' | 'info' | 'warn' | 'error'
    title: string
    data?: Record<string, unknown>
    stage?: string
  }): Promise<void> {
    // Observability is best-effort. A transient fetch failure (cumora-
    // server mid-restart, NEG cutover, DNS blip) MUST NOT propagate
    // out and kill the agent turn — production agents have crashed
    // mid-task that way. We log and swallow.
    try {
      await this.call<{ ok: true }>('POST', '/events', {
        runId: event.runId,
        kind: event.kind,
        level: event.level,
        title: event.title,
        data: event.data,
        stage: event.stage,
      })
    } catch (err) {
      console.warn(`[runtime] recordEvent(${event.kind}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async finishRun(args: {
    runId: string
    status: 'running' | 'completed' | 'failed' | 'skipped'
    summary?: string
    error?: string | null
    toolCallCount?: number
    tokenCount?: number
    model?: string | null
    usage?: RuntimeTokenUsage | null
  }): Promise<void> {
    // Belt-and-braces: turn.ts's finally block already wraps this in a
    // .catch, but a fetch failure here used to ALSO surface as an
    // uncaught rejection in the pod's drain loop. Swallow at source so
    // both layers agree the call is best-effort. Unlike debug events,
    // this row transition is user-visible operational state, so retry
    // through short rolling deploy / NEG cutover gaps before dropping.
    try {
      await this.callWithRetry<{ ok: true }>('POST', `/runs/${encodeURIComponent(args.runId)}/finish`, {
        status: args.status,
        summary: args.summary,
        error: args.error,
        toolCallCount: args.toolCallCount,
        tokenCount: args.tokenCount,
        model: args.model,
        usage: args.usage,
      }, {
        attempts: 4,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
      })
    } catch (err) {
      console.warn(`[runtime] finishRun(${args.runId}, ${args.status}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async postSystemNotice(args: {
    conversationId: string
    companyId?: string | null
    agentId: string
    noticeKind: string
    text: string
    dedupeKey: string
    dedupeTtlSec: number
  }): Promise<{ posted: boolean }> {
    return this.call<{ posted: boolean }>('POST', `/notices`, {
      conversationId: args.conversationId,
      companyId: args.companyId,
      agentId: args.agentId,
      noticeKind: args.noticeKind,
      text: args.text,
      dedupeKey: args.dedupeKey,
      dedupeTtlSec: args.dedupeTtlSec,
    })
  }

  async recordBusyHeartbeat(agentId: string, ttlSec: number = 5): Promise<void> {
    // Fire-and-forget — busy heartbeat failures must NOT kill a turn.
    // The agentId from the request body is ignored server-side; the
    // JWT subject is authoritative (`c.sub` in server.ts).
    try {
      await this.call<{ ok: true }>('POST', `/busy/heartbeat`, { ttlSec })
      // Success: reset the failure counter. If we'd been failing and
      // now we recover, the next failure starts a fresh streak rather
      // than firing an alert based on stale history.
      busyHeartbeatConsecutiveFailures = 0
    } catch (err) {
      busyHeartbeatConsecutiveFailures += 1
      console.warn(`[runtime] recordBusyHeartbeat failed — dropping (consecutive=${busyHeartbeatConsecutiveFailures})`,
        err instanceof Error ? err.message : err)
      // Threshold reached → alert. notifyAlert dedupes on
      // (label, error-message-prefix) inside ALERT_DEDUPE_MS so a
      // sustained outage doesn't hammer the webhook. The alerting
      // hook itself never throws, so this won't cascade.
      if (busyHeartbeatConsecutiveFailures === BUSY_HEARTBEAT_ALERT_THRESHOLD) {
        void notifyAlert({
          label: 'pod.busy_heartbeat_degraded',
          error: err,
          extras: {
            agentId,
            consecutiveFailures: busyHeartbeatConsecutiveFailures,
            consequence: 'steer routing has degraded to wake-only for this pod',
          },
        })
      }
    }
  }

  async clearBusyHeartbeat(_agentId: string): Promise<void> {
    try {
      await this.call<{ ok: true }>('POST', `/busy/clear`, {})
    } catch (err) {
      console.warn(`[runtime] clearBusyHeartbeat failed — dropping`,
        err instanceof Error ? err.message : err)
    }
  }

  async markThinking(_agentId: string, conversationIds: string[], ttlSec: number = 60): Promise<void> {
    if (conversationIds.length === 0) return
    try {
      await this.call<{ ok: true }>('POST', `/thinking/mark`, { conversationIds, ttlSec })
    } catch (err) {
      console.warn(`[runtime] markThinking failed`,
        err instanceof Error ? err.message : err)
    }
  }

  async unmarkThinking(_agentId: string, conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return
    try {
      await this.call<{ ok: true }>('POST', `/thinking/unmark`, { conversationIds })
    } catch (err) {
      console.warn(`[runtime] unmarkThinking failed`,
        err instanceof Error ? err.message : err)
    }
  }

  async peekThinking(conversationId: string): Promise<Array<{ agentId: string; claimedAt: number }>> {
    try {
      const out = await this.call<{ agents: Array<{ agentId: string; claimedAt: number }> }>(
        'GET',
        `/thinking/peek?conversationId=${encodeURIComponent(conversationId)}`,
      )
      return out.agents
    } catch (err) {
      console.warn(`[runtime] peekThinking failed`,
        err instanceof Error ? err.message : err)
      return []
    }
  }

  async claimWork(args: {
    scopeKey: string
    agentId: string
    taskType: WorkTaskType
    subject: string
    ttlSec?: number
  }): Promise<
    | { accepted: true }
    | { accepted: false; existing: WorklogEntry }
  > {
    try {
      return await this.call<
        | { accepted: true }
        | { accepted: false; existing: WorklogEntry }
      >('POST', `/worklog/claim`, {
        scopeKey: args.scopeKey,
        taskType: args.taskType,
        subject: args.subject,
        ttlSec: args.ttlSec,
      })
    } catch (err) {
      console.warn(`[runtime] claimWork failed — fail-open`,
        err instanceof Error ? err.message : err)
      return { accepted: true }
    }
  }

  async releaseWork(args: {
    scopeKey: string
    agentId: string
    taskType: WorkTaskType
    subject: string
  }): Promise<void> {
    try {
      await this.call<{ ok: true }>('POST', `/worklog/release`, {
        scopeKey: args.scopeKey,
        taskType: args.taskType,
        subject: args.subject,
      })
    } catch (err) {
      console.warn(`[runtime] releaseWork failed — TTL will clean`,
        err instanceof Error ? err.message : err)
    }
  }

  async peekWorklog(scopeKey: string): Promise<WorklogEntry[]> {
    try {
      const out = await this.call<{ entries: WorklogEntry[] }>(
        'GET',
        `/worklog/peek?scopeKey=${encodeURIComponent(scopeKey)}`,
      )
      return out.entries
    } catch (err) {
      console.warn(`[runtime] peekWorklog failed`,
        err instanceof Error ? err.message : err)
      return []
    }
  }

  /** Supervision signal is a server-side DB fact; the HTTP runtime never builds
   *  triage requests itself (the server does, via /inbox-triage/payload), so
   *  this conservatively reports "no human watching". */
  async humanRecentlyActive(_companyId: string, _windowMinutes?: number): Promise<boolean> {
    return false
  }

  async markConversationRead(args: {
    agentId: string
    conversationId: string
    upToMessageId: string
  }): Promise<void> {
    try {
      await this.call<{ ok: true }>('POST', `/conversation/mark-read`, {
        conversationId: args.conversationId,
        upToMessageId: args.upToMessageId,
      })
    } catch (err) {
      console.warn(`[runtime] markConversationRead failed — dropping`,
        err instanceof Error ? err.message : err)
    }
  }
}
