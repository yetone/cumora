/**
 * Long-running agent-computer entry point — but only as long as
 * there's work to do.
 *
 * Lifecycle:
 *   1. Boot, set status='avail', connect SSE → /runtime/wake-stream
 *   2. Run drain() once unconditionally (catch up wakes that fired
 *      during cold-start / before the SSE attached)
 *   3. Loop: read SSE events; on `event: wake` → drain()
 *   4. After each drain finishes, kick / reset the idle timer
 *   5. If the idle timer fires (no wakes for CUMORA_AGENT_IDLE_MS):
 *      set status='resting', close the stream, exit 0. K8s deletes
 *      the Pod. PVC stays.
 *   6. SIGTERM (k8s draining the node): finish current turn, exit 0.
 *
 * Per-agent serialization is intrinsic — one process, awaits each
 * turn before the next.
 *
 * Required env (injected by the orchestrator at pod-spawn time):
 *   CUMORA_AGENT_ID            which agent this Pod IS
 *   CUMORA_AGENT_RUNTIME_URL   server origin + /runtime suffix
 *   CUMORA_AGENT_RUNTIME_TOKEN signed JWT pinning agentId + companyId
 *   CUMORA_AGENT_IDLE_MS       idle timeout (ms); default 10 min
 *   OPENAI_API_KEY             agent's LLM key
 *
 * Exit codes:
 *   0  graceful shutdown (idle, SIGTERM, SIGINT)
 *   2  bad invocation (missing env)
 *   3  unrecoverable stream error (couldn't connect after N retries)
 */
import { pool } from '../../db/pool.js'
import { runAgentTurn, type AgentTurnOptions } from '../turn.js'
import { runtime } from './select.js'
import { notifyAlert } from '../../alerting.js'
import { pushSteer } from '../steer.js'
import { parseSseStream, wakeStreamWasStable } from './sse-parse.js'
import { decidePodExit } from './pod-agent-exit.js'

interface RunnerState {
  busy: boolean
  pendingRerun: boolean
  shuttingDown: boolean
  /** ms timestamp of the last activity (turn start or wake). Drives
   *  the idle timer's decision to terminate. */
  lastActivityAt: number
  /** True once an SSE 'wake' or 'steer' event has arrived from the
   *  server. The bootstrap drain at SSE-attach does NOT flip this —
   *  it's specifically "did the server tell us there's work AFTER we
   *  subscribed?" If still false after CUMORA_AGENT_NO_WORK_MS, the
   *  no-work-exit path fires to free this pod's /dev/fuse slot for
   *  another agent. See FUSE-cap incident postmortem 2026-05-20. */
  firstWakeReceived: boolean
}

const state: RunnerState = {
  busy: false, pendingRerun: false, shuttingDown: false,
  lastActivityAt: Date.now(),
  firstWakeReceived: false,
}

let pendingTurnOptions: AgentTurnOptions | null = null

function mergeTurnOptions(next: AgentTurnOptions | null): void {
  if (!next || Object.keys(next).length === 0) return
  if (next.trigger === 'background_scan') {
    pendingTurnOptions = next
    return
  }
  if (!pendingTurnOptions) {
    pendingTurnOptions = next
    return
  }
  pendingTurnOptions = { ...pendingTurnOptions, ...next }
}

function turnOptionsFromWakeData(raw: string | undefined): AgentTurnOptions {
  if (!raw || raw.length > 16_384) return {}
  try {
    const parsed = JSON.parse(raw) as {
      reason?: unknown
      idleReason?: unknown
      triageNote?: unknown
      backgroundBrief?: unknown
      pollBrief?: unknown
    }
    const reason = parsed.reason
    if (
      reason !== 'message.new' &&
      reason !== 'idle' &&
      reason !== 'manual' &&
      reason !== 'background_scan' &&
      reason !== 'poll.updated'
    ) return {}
    const out: AgentTurnOptions = { trigger: reason }
    if (reason === 'idle' && typeof parsed.idleReason === 'string') {
      out.idleReason = parsed.idleReason.slice(0, 500)
    }
    if (reason === 'message.new' && typeof parsed.triageNote === 'string') {
      out.triageNote = parsed.triageNote.slice(0, 1800)
    }
    if (reason === 'background_scan' && parsed.backgroundBrief && typeof parsed.backgroundBrief === 'object') {
      const brief = parsed.backgroundBrief as { title?: unknown; body?: unknown; source?: unknown }
      if (typeof brief.title === 'string' && typeof brief.body === 'string') {
        out.backgroundBrief = {
          title: brief.title.slice(0, 200),
          body: brief.body.slice(0, 12_000),
          source: typeof brief.source === 'string' ? brief.source.slice(0, 128) : undefined,
        }
      }
    }
    if (reason === 'poll.updated' && parsed.pollBrief && typeof parsed.pollBrief === 'object') {
      const brief = parsed.pollBrief as Record<string, unknown>
      const tallies = Array.isArray(brief.tallies) ? brief.tallies.slice(0, 20).flatMap((t) => {
        if (!t || typeof t !== 'object') return []
        const tt = t as Record<string, unknown>
        if (typeof tt.optionId !== 'string' || typeof tt.text !== 'string' || typeof tt.count !== 'number') return []
        const voters = Array.isArray(tt.voters) ? tt.voters.slice(0, 50).flatMap((v) => {
          if (!v || typeof v !== 'object') return []
          const vv = v as Record<string, unknown>
          if (typeof vv.id !== 'string') return []
          return [{ id: vv.id, name: typeof vv.name === 'string' ? vv.name : vv.id }]
        }) : []
        return [{ optionId: tt.optionId, text: tt.text.slice(0, 200), count: tt.count, voters }]
      }) : []
      const pending = Array.isArray(brief.pending) ? brief.pending.slice(0, 50).flatMap((p) => {
        if (!p || typeof p !== 'object') return []
        const pp = p as Record<string, unknown>
        if (typeof pp.id !== 'string') return []
        return [{ id: pp.id, name: typeof pp.name === 'string' ? pp.name : pp.id }]
      }) : []
      const actor = brief.actor && typeof brief.actor === 'object'
        ? brief.actor as Record<string, unknown>
        : { id: null, name: null }
      const phase = brief.phase === 'close' ? 'close' as const : 'vote' as const
      const status = brief.status === 'closed' ? 'closed' as const : 'open' as const
      if (typeof brief.messageId === 'string' && typeof brief.question === 'string') {
        out.pollBrief = {
          messageId: brief.messageId,
          conversationId: typeof brief.conversationId === 'string' ? brief.conversationId : '',
          question: brief.question.slice(0, 500),
          mode: brief.mode === 'multi' ? 'multi' : 'single',
          status,
          closedReason: brief.closedReason === 'expired' || brief.closedReason === 'manual' ? brief.closedReason : null,
          expiresAt: typeof brief.expiresAt === 'string' ? brief.expiresAt : null,
          totalVotes: typeof brief.totalVotes === 'number' ? brief.totalVotes : 0,
          tallies,
          pending,
          actor: {
            id: typeof actor.id === 'string' ? actor.id : null,
            name: typeof actor.name === 'string' ? actor.name : null,
          },
          phase,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

async function drain(agentId: string, options: AgentTurnOptions | null = null): Promise<void> {
  mergeTurnOptions(options)
  state.lastActivityAt = Date.now()
  if (state.busy) { state.pendingRerun = true; return }
  state.busy = true
  try {
    do {
      state.pendingRerun = false
      const turnOptions = pendingTurnOptions ?? {}
      pendingTurnOptions = null
      const started = Date.now()
      try {
        await runAgentTurn(agentId, turnOptions)
        console.log(`[pod-agent] turn ok · ${Date.now() - started}ms`)
      } catch (err) {
        console.error(`[pod-agent] turn failed (${Date.now() - started}ms):`,
          err instanceof Error ? err.message : String(err))
      }
      state.lastActivityAt = Date.now()
    } while (state.pendingRerun && !state.shuttingDown)
  } finally {
    state.busy = false
  }
}

// parseSseStream + SseEvent moved to ./sse-parse.ts so the test
// suite can import them without booting pod-agent.ts's auto-running
// main(). Re-exported here for any callers that still depend on the
// old import path.
export type { SseEvent } from './sse-parse.js'
export { parseSseStream }

async function connectStream(agentId: string, url: string, token: string): Promise<void> {
  const res = await fetch(`${url}/wake-stream`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
    },
  })
  if (!res.ok || !res.body) {
    throw new Error(`wake-stream connect failed: HTTP ${res.status}`)
  }
  console.log(`[pod-agent] connected to wake-stream`)

  // First connect after a cold start: catch up unconditionally. Any
  // wake events that fired during the spin-up window were dropped
  // server-side (no subscriber yet) — drain() reads inbox directly,
  // so this is self-healing.
  void drain(agentId)

  for await (const evt of parseSseStream(res.body as unknown as AsyncIterable<unknown>)) {
    if (state.shuttingDown) break
    if (evt.event === 'ready') continue
    if (evt.event === 'wake') {
      // Mark "the server has told us there's work" — gates the
      // no-work-exit fast path. A bootstrap drain (line 151) does
      // NOT set this; only a real SSE wake from the bus does.
      state.firstWakeReceived = true
      // Fire-and-forget: drain() handles re-entrancy + serialization.
      // We don't `await` here because the stream itself must keep
      // pulling so we don't miss subsequent events while a turn runs.
      void drain(agentId, turnOptionsFromWakeData(evt.data))
      continue
    }
    if (evt.event === 'steer') {
      state.firstWakeReceived = true
      // Mid-turn injection: the user just posted a message that the
      // SERVER decided this agent should see WITHOUT waiting for the
      // current turn to end (because Redis says we're busy). Push
      // onto the steer queue — the turn loop's hop-boundary drain
      // will pick it up. Also kick drain() in case we happen to be
      // idle (the server's busy-check is best-effort + slightly
      // racy); in that case we'll just run a normal turn whose
      // loadInbox sees the message via the messages table.
      //
      // Payload validation: SSE data is bounded by the producer
      // (deliverSteer) in theory, but treat it as untrusted at the
      // boundary — bound author/body lengths so a buggy or hostile
      // upstream can't push megabytes of context. The truncation in
      // pushSteer covers the body case as defense-in-depth; here we
      // gate at the SSE parse layer too.
      try {
        if (!evt.data) continue
        // Cap raw SSE payload at ~16KB. Anything larger is rejected
        // outright — a legitimate steer (≤ 4KB body + small metadata)
        // never approaches this.
        if (evt.data.length > 16_384) {
          console.warn(`[pod-agent] dropped oversized steer payload (${evt.data.length} bytes)`)
          continue
        }
        const parsed = JSON.parse(evt.data) as {
          messageId?: unknown
          conversationId?: unknown
          authorName?: unknown
          body?: unknown
        }
        if (
          typeof parsed.messageId !== 'string' ||
          typeof parsed.conversationId !== 'string' ||
          typeof parsed.body !== 'string'
        ) continue
        // Per-field length caps — guards against a malformed publish.
        // pushSteer ALSO truncates body, but doing it here keeps the
        // log line consistent at the entry point.
        const messageId = parsed.messageId.slice(0, 256)
        const conversationId = parsed.conversationId.slice(0, 256)
        const authorName = typeof parsed.authorName === 'string'
          ? parsed.authorName.slice(0, 128)
          : 'user'
        const body = parsed.body.slice(0, 8192)
        if (!messageId || !conversationId) continue
        pushSteer(agentId, {
          messageId,
          conversationId,
          authorName: authorName || 'user',
          body,
          arrivedAt: Date.now(),
        })
      } catch (err) {
        console.warn(`[pod-agent] failed to parse steer payload:`,
          err instanceof Error ? err.message : err)
      }
      // Always kick drain so an idle pod still runs a turn (steer
      // races with wake on the producer side, and the wake event
      // may not have arrived yet / may have been merged).
      void drain(agentId)
      continue
    }
  }
}

/** Idle watcher — if the pod sits with no work for IDLE_MS (or fails
 *  to receive any wake at all within NO_WORK_MS of boot), it sets the
 *  agent's status to 'resting' and exits 0. K8s reaps the Pod; the
 *  PVC stays bound for the next wake-up. */
function startIdleWatcher(
  agentId: string,
  idleMs: number,
  noWorkMs: number,
  onIdle: (reason: string) => void,
): void {
  const bootedAt = Date.now()
  // Tick cadence: small enough that no-work-exit fires within ~5s
  // of crossing the threshold, but never busier than every 500ms.
  const tickMs = Math.min(5_000, Math.max(500, Math.floor(Math.min(idleMs, noWorkMs) / 10)))
  const tick = setInterval(() => {
    const reason = decidePodExit(state, bootedAt, Date.now(), idleMs, noWorkMs)
    if (reason !== null) {
      clearInterval(tick)
      onIdle(reason)
    }
  }, tickMs)
  tick.unref?.()
}

async function gracefulExit(reason: string, finalStatus: 'resting' | null): Promise<never> {
  if (state.shuttingDown) {
    // Already shutting down — wait for it.
    await new Promise<void>(() => { /* never resolve */ })
  }
  state.shuttingDown = true
  console.log(`[pod-agent] shutting down: ${reason}`)
  // Wait for in-flight turn to finish, capped at 60s.
  const deadline = Date.now() + 60_000
  while (state.busy && Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 200))
  }
  if (finalStatus) {
    try {
      const agentId = process.env.CUMORA_AGENT_ID
      if (agentId) await runtime.setStatus(agentId, finalStatus)
    } catch (err) {
      console.warn(`[pod-agent] failed to set status=${finalStatus}:`, err instanceof Error ? err.message : String(err))
    }
  }
  // pool.end() waits for every connection in the pool to drain — in
  // the pod-only world we never query pg from inside the pod, so the
  // pool is empty and this is instant; still, guard with a 2s race
  // so a stuck connection doesn't keep the Pod alive past its idle
  // bedtime.
  await Promise.race([
    pool.end().catch(() => { /* swallow */ }),
    new Promise<void>((r) => setTimeout(r, 2000)),
  ])
  process.exit(0)
}

async function main(): Promise<void> {
  const agentId = process.env.CUMORA_AGENT_ID
  const url = process.env.CUMORA_AGENT_RUNTIME_URL
  const token = process.env.CUMORA_AGENT_RUNTIME_TOKEN
  const idleMs = Number(process.env.CUMORA_AGENT_IDLE_MS ?? 3 * 60_000)
  const noWorkMs = Number(process.env.CUMORA_AGENT_NO_WORK_MS ?? 90_000)
  if (!agentId || !url || !token) {
    console.error('[pod-agent] missing env: CUMORA_AGENT_ID / CUMORA_AGENT_RUNTIME_URL / CUMORA_AGENT_RUNTIME_TOKEN')
    process.exit(2)
  }
  console.log(`[pod-agent] starting · agent=${agentId} idleMs=${idleMs} noWorkMs=${noWorkMs} pid=${process.pid}`)

  // Announce "I'm awake" — agent shows up in UI as `avail` while
  // waiting for wakes. The turn loop itself flips status to
  // working/thinking during a turn.
  try { await runtime.setStatus(agentId, 'avail') } catch { /* best-effort */ }

  // SIGTERM / SIGINT (k8s drain, ctrl-c in dev): graceful shutdown.
  // We DON'T set status=resting on SIGTERM — that signals "k8s is
  // moving me", not "I have no work". Status sticks at whatever the
  // turn left it as.
  process.on('SIGTERM', () => { void gracefulExit('SIGTERM', null) })
  process.on('SIGINT',  () => { void gracefulExit('SIGINT', null) })

  // Idle timer: ONLY this path sets status=resting.
  startIdleWatcher(agentId, idleMs, noWorkMs, (reason) => { void gracefulExit(reason, 'resting') })

  // Connect-loop with exponential backoff. SSE disconnects (server
  // restart, transient network blip) shouldn't kill the Pod.
  let backoffMs = 500
  while (!state.shuttingDown) {
    const startedAt = Date.now()
    try {
      await connectStream(agentId, url, token)
      // A clean close used to reconnect with NO delay at all and reset the
      // ladder, so an endpoint that accepts and immediately ends the stream span
      // the loop as fast as fetch could go.
      console.log(`[pod-agent] wake-stream closed by server · retry in ${backoffMs}ms`)
    } catch (err) {
      console.warn(`[pod-agent] wake-stream error: ${err instanceof Error ? err.message : String(err)} · retry in ${backoffMs}ms`)
    }
    if (state.shuttingDown) break
    // Reset the ladder only after a connection that actually stayed up; merely
    // connecting is not evidence of health.
    if (wakeStreamWasStable(Date.now() - startedAt)) backoffMs = 500
    await new Promise<void>((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

// Process-level safety nets. On modern Node (≥ 15) an unhandled
// promise rejection terminates the agent pod by default — which
// rolls the user back to the "agent went silent" failure mode we
// keep paving over. Most of our async paths either await with
// try/catch or `.catch()`-suffixed fire-and-forget; these handlers
// catch what we missed so a single transient blip can't kill the
// pod mid-task. The pod stays alive, the next wake re-runs.
process.on('unhandledRejection', (reason, _p) => {
  void notifyAlert({
    label: 'pod.unhandledRejection',
    error: reason,
    extras: { agentId: process.env.CUMORA_AGENT_ID },
  })
})
process.on('uncaughtException', (err) => {
  void notifyAlert({
    label: 'pod.uncaughtException',
    error: err,
    extras: { agentId: process.env.CUMORA_AGENT_ID },
  })
})

void main().catch((err) => {
  console.error('[pod-agent] fatal', err)
  process.exit(3)
})
