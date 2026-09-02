/**
 * Wake scheduler — listens to CH_MESSAGE_NEW (Redis pubsub) and
 * routes wake events to the right agent's pod.
 *
 * Model (pod-only):
 *   1. Try deliverWake() — push SSE event to the agent's on-bus Pod
 *   2. If 0 subscribers, the Pod is `resting`. ensurePod() spins one
 *      up; the Pod, after SSE attach, runs drain() unconditionally
 *      to catch up the inbox (so we don't need to queue the wake
 *      server-side — the missed event self-heals through the
 *      inbox-read).
 *
 * Per-agent serialization is intrinsic — each agent has exactly one
 * Pod, which runs one turn at a time and collapses concurrent wakes
 * into pendingRerun internally (see runtime/pod-agent.ts).
 *
 * Idle teardown is handled by the Pod itself: after
 * CUMORA_AGENT_IDLE_MS without a wake, it sets the agent's status to
 * `resting` and exits, leaving the PVC bound for next time. The
 * server doesn't track Pod lifetimes — the next wake re-creates the
 * Pod via the orchestrator.
 */
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { CH_MESSAGE_NEW, CH_POLLS, CH_TYPING, publish, redis, sub, type MessageNewEvent, type PollUpdatedEvent } from '../redis.js'
import { notifyAlert } from '../alerting.js'
import { ensurePod } from './runtime/orchestrator.js'
import {
  resolveAgentHost,
  isByoaKind,
  type ResolvedAgentHost,
} from './computer/registry.js'
import { deliver as deliverWake, deliverSteer, type PollWakeBrief } from './runtime/wake-bus.js'
import { inprocClient, isAgentBusy } from './runtime/inproc-client.js'
import { classifyInboxTriage, type InboxTriageVerdict } from './inbox-triage.js'
import type { AgentTurnOptions } from './turn.js'
import { recipientsForRoute, routeMessage } from './routing.js'
import { Semaphore } from '../concurrency.js'

/** Bounds how many recipients the wake fan-out triages + wakes at once
 *  (per replica). See env.WAKE_FANOUT_CONCURRENCY — this is the
 *  backpressure that stops a swarm reply-storm from oversubscribing the
 *  pg pool and tripping the triage fail-open amplification loop. */
const wakeFanoutSem = new Semaphore(env.WAKE_FANOUT_CONCURRENCY)

/** Optional payload attached to a wake that the busy-agent path should
 *  also publish as a `steer` event so the running turn can react
 *  mid-flight (instead of waiting until the next wake). Built by the
 *  message-new handler from MessageNewEvent. */
export interface SteerWakePayload {
  messageId: string
  conversationId: string
  authorName: string
  body: string
  /** Tenant tag so the steer-ack typing broadcast routes to clients instead of
   *  being dropped as "untagged". Sourced from the message-new event. Optional
   *  only so test fixtures can omit it; the production wake() path always sets it. */
  companyId?: string
}

type WakeReason = 'message.new' | 'idle' | 'manual' | 'background_scan' | 'poll.updated'
type WakeOptions = Pick<AgentTurnOptions, 'idleReason' | 'backgroundBrief' | 'pollBrief' | 'triageNote'> & {
  /** Exact durable notice to acknowledge before managed-runtime triage. */
  triageTarget?: { conversationId: string; messageId: string }
  /** Message fan-out must resolve placement before delivering to a live runtime. */
  placementTriage?: boolean
}
type WakeFailureClass = 'ensure_pod' | 'host_resolution'

interface WakeRetryJob {
  id: string
  agentId: string
  reason: WakeReason
  conversationId: string | null
  steerPayload: SteerWakePayload | null
  options: WakeOptions
  attempt: number
  lastFailure: string
}

const WAKE_RETRY_DUE_KEY = 'cumora:wake-retry:due'
const WAKE_RETRY_JOB_KEY = 'cumora:wake-retry:jobs'
const WAKE_RETRY_MAX_ATTEMPTS = 60
const WAKE_RETRY_BATCH_SIZE = 25

export function _wakeRetryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.min(4, attempt))
  return Math.min(60_000, 5_000 * 2 ** n)
}

export function _shouldRetryEnsurePodFailure(reason: WakeReason, ensureReason: string): boolean {
  // message.new wakes are DURABLE because the message itself is already
  // committed to the messages table. Whenever the agent's pod next
  // attaches its wake-stream it runs drain() unconditionally, which
  // calls loadInbox — picking up everything since the agent's last
  // read cursor including any wake we "missed". Queuing a separate
  // retry on top means the pod can receive the same wake twice (once
  // via the original SSE delivery once it's healthy, once via the
  // retry), trigger an extra turn through pendingRerun, and post a
  // duplicate reply — exactly the "Nova says 3 then 1" bug.
  //
  // Synthetic wakes (idle / background_scan) don't have a backing DB
  // row, so they ARE handled here too — but via the inline poll loop
  // at the end of wakeOne, not via this scheduled-retry queue. The
  // queue is left to `manual` only (CLI/admin pokes that explicitly
  // want delivery guarantees).
  if (reason !== 'manual') return false
  if (/no such agent/i.test(ensureReason)) return false
  return true
}

/** Host lookup failed before any runtime was selected or started, so replay is
 * safe even for a durable message wake. This is deliberately separate from
 * ordinary ensurePod retries, whose message replay can duplicate a turn. */
export function _shouldRetryWakeFailure(
  reason: WakeReason,
  failureReason: string,
  failureClass: WakeFailureClass,
): boolean {
  if (failureClass === 'host_resolution') return true
  return _shouldRetryEnsurePodFailure(reason, failureReason)
}

function wakeRetryId(agentId: string, reason: WakeReason, conversationId: string | null): string {
  return `${agentId}:${reason}:${conversationId ?? '-'}`
}

async function scheduleWakeRetry(
  agentId: string,
  reason: WakeReason,
  conversationId: string | null,
  steerPayload: SteerWakePayload | null,
  options: WakeOptions,
  attempt: number,
  failureReason: string,
  failureClass: WakeFailureClass = 'ensure_pod',
): Promise<void> {
  if (!_shouldRetryWakeFailure(reason, failureReason, failureClass)) return
  const id = wakeRetryId(agentId, reason, conversationId)
  if (attempt > WAKE_RETRY_MAX_ATTEMPTS) {
    await redis.hdel(WAKE_RETRY_JOB_KEY, id).catch(() => { /* ignore */ })
    void notifyAlert({
      label: 'scheduler.wake_retry_exhausted',
      error: new Error(`wake retry exhausted for ${agentId}: ${failureReason}`),
      extras: { agentId, reason, conversationId, attempt, failureReason },
    })
    return
  }
  const dueAt = Date.now() + _wakeRetryDelayMs(attempt)
  const job: WakeRetryJob = {
    id, agentId, reason, conversationId, steerPayload, options,
    attempt,
    lastFailure: failureReason,
  }
  await redis.hset(WAKE_RETRY_JOB_KEY, id, JSON.stringify(job))
  await redis.zadd(WAKE_RETRY_DUE_KEY, dueAt, id)
  console.warn(`[scheduler] ${agentId} ${reason} wake retry scheduled in ${Math.round((dueAt - Date.now()) / 1000)}s after ${failureClass}: ${failureReason}`)
}

async function pollWakeRetriesOnce(): Promise<void> {
  const ids = await redis.zrangebyscore(WAKE_RETRY_DUE_KEY, 0, Date.now(), 'LIMIT', 0, WAKE_RETRY_BATCH_SIZE)
  for (const id of ids) {
    const claimed = await redis.zrem(WAKE_RETRY_DUE_KEY, id)
    if (claimed !== 1) continue
    const raw = await redis.hget(WAKE_RETRY_JOB_KEY, id)
    if (!raw) continue
    await redis.hdel(WAKE_RETRY_JOB_KEY, id).catch(() => { /* ignore */ })
    let job: WakeRetryJob
    try {
      job = JSON.parse(raw) as WakeRetryJob
    } catch {
      continue
    }
    wakeOne(
      job.agentId,
      job.reason,
      job.conversationId,
      job.steerPayload,
      job.options,
      job.attempt,
    ).catch((err) => {
      console.error(`[scheduler] wake retry ${job.id} failed:`, err instanceof Error ? err.message : err)
      scheduleWakeRetry(
        job.agentId,
        job.reason,
        job.conversationId,
        job.steerPayload,
        job.options,
        job.attempt + 1,
        err instanceof Error ? err.message : String(err),
      ).catch(() => { /* ignore */ })
    })
  }
}

function startWakeRetryWorker(intervalMs: number = 5_000): NodeJS.Timeout {
  const tick = (): void => {
    pollWakeRetriesOnce().catch((err) =>
      console.error('[scheduler] wake retry worker failed:', err instanceof Error ? err.message : err),
    )
  }
  setImmediate(tick)
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  return t
}

/** Wake one agent. Exposed so non-message-new triggers (kanban card
 *  mentions, calendar dispatches, …) can use the same SSE-or-spawn path. */
export async function wakeAgent(
  agentId: string,
  reason: WakeReason,
  conversationId: string | null = null,
  steerPayload: SteerWakePayload | null = null,
  options: WakeOptions = {},
): Promise<void> {
  return wakeOne(agentId, reason, conversationId, steerPayload, options)
}

// ─── low-priority wake backpressure (FUSE-cap incident 2026-05-20) ──
//
// `idle` and `background_scan` wake reasons are SYNTHETIC — they were
// generated by the server's own schedulers, not by a real user
// message. During a cumora-server crashloop, idle ticks accumulate in
// the schedulers' clock backlog, and on recovery they fire all at
// once: the idle scheduler can issue a wake per agent per tenant in
// rapid succession, the scanner the same. Each wake → ensurePod →
// new agent pod → reserves one /dev/fuse cluster slot.
//
// The fix is a hard cap on synthetic wakes per cumora-server process
// per minute. User-facing reasons (`message.new`, `manual`) are NEVER
// rate-limited — they correspond to a real user action and must go
// through promptly. Per-process counter is fine because the actual
// scheduler scope (idle.ts, scanner.ts) IS per-process; multiple
// replicas multiply the budget naturally (a 2-replica deploy gets
// 2 × LOW_PRIORITY_WAKE_BUDGET_PER_MIN cluster-wide).
const LOW_PRIORITY_WAKE_BUDGET_PER_MIN = 20
let lowPriWindowStart = Date.now()
let lowPriUsed = 0
let lowPriDroppedInWindow = 0

// Agent turn rate limit — a CONTENT-BLIND cost floor, not a loop decision.
// Whether a thread is "a loop" and whether to reply is the small model's call
// (it sees the per-conversation "thread heat" signal and goes quiet on an
// agent-only thread). This limit only bounds how often any one agent can be
// activated by AGENT-driven traffic, so a runaway (or a model that won't stop)
// can't burn unbounded cost. It never looks at message content, and
// human-driven wakes are never throttled. Generous enough that normal use never
// trips it; low enough to cap a ping-pong.
const AGENT_TURN_RATE_PER_MINUTE = 30

/** Consume one agent-turn token (rolling 60s window). Returns false when the
 *  agent is over its content-blind activation budget. Fail-open on Redis errors.
 *  Shared by the cloud fan-out and the BYOA triage endpoint so one agent has one
 *  budget across both paths. */
export async function consumeAgentTurnToken(agentId: string): Promise<boolean> {
  try {
    const key = `cumora:turn-rate:${agentId}`
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, 60).catch(() => { /* best-effort */ })
    return count <= AGENT_TURN_RATE_PER_MINUTE
  } catch {
    return true // fail-open
  }
}

/** Returns true if a low-priority wake is allowed under the current
 *  rolling 60s budget. Mutates internal counters. Exported for tests. */
export function _consumeLowPriorityWakeBudget(now: number = Date.now()): boolean {
  if (now - lowPriWindowStart >= 60_000) {
    if (lowPriDroppedInWindow > 0) {
      console.warn(`[scheduler] low-priority wake budget window closing: used=${lowPriUsed} dropped=${lowPriDroppedInWindow}`)
    }
    lowPriWindowStart = now
    lowPriUsed = 0
    lowPriDroppedInWindow = 0
  }
  if (lowPriUsed >= LOW_PRIORITY_WAKE_BUDGET_PER_MIN) {
    lowPriDroppedInWindow++
    return false
  }
  lowPriUsed++
  return true
}

/** Test-only reset. Sets the window start to 0 (epoch) so the next
 *  consume() call — regardless of the `now` value the test passes —
 *  always rolls into a fresh window. In production this function is
 *  never called and `lowPriWindowStart` retains its `Date.now()`
 *  initial value, so rollovers happen on real wall-clock time. */
export function _resetLowPriorityWakeBudgetForTests(): void {
  lowPriWindowStart = 0
  lowPriUsed = 0
  lowPriDroppedInWindow = 0
}

/** Resolve the exceptional recipient on a departure notice. The pubsub payload
 * is only a hint: an attacker or buggy publisher cannot add an arbitrary wake
 * target because the exact message, conversation, tenant, persisted recipient,
 * and active-agent row must all agree in Postgres. Exported for the delivery
 * contract regression test. */
export async function resolveDurableDeliveryAgent(args: {
  conversationId: string
  messageId: string
  companyId: string | undefined
  claimedRecipientId: string | undefined
}): Promise<string | null> {
  if (!args.companyId || !args.claimedRecipientId) return null
  const { rows } = await pool.query<{ delivery_recipient_id: string }>(
    `SELECT dm.delivery_recipient_id
       FROM messages dm
       JOIN conversations c
         ON c.id = dm.conversation_id
        AND c.company_id = $3
       JOIN participants p
         ON p.id = dm.delivery_recipient_id
        AND p.company_id = c.company_id
        AND p.kind = 'agent'
        AND p.departed_at IS NULL
      WHERE dm.id = $1
        AND dm.conversation_id = $2
        AND dm.kind = 'system'
        AND dm.delivery_recipient_id = $4
      LIMIT 1`,
    [args.messageId, args.conversationId, args.companyId, args.claimedRecipientId],
  )
  return rows[0]?.delivery_recipient_id ?? null
}

async function wakeOne(
  agentId: string,
  reason: WakeReason,
  conversationId: string | null,
  steerPayload: SteerWakePayload | null = null,
  options: WakeOptions = {},
  retryAttempt: number = 0,
): Promise<void> {
  // Synthetic wakes can be dropped under load — the next idle tick
  // or next scanner pass will re-evaluate. Real wakes never are.
  if ((reason === 'idle' || reason === 'background_scan') && !_consumeLowPriorityWakeBudget()) {
    console.warn(`[scheduler] ${agentId} ${reason} wake dropped: budget ${LOW_PRIORITY_WAKE_BUDGET_PER_MIN}/min exceeded`)
    return
  }

  // Execution placement is an authorization decision, not a nullable hint.
  // A connected runtime can receive a direct wake without starting anything;
  // placement becomes mandatory for managed-message triage and whenever zero
  // subscribers would send us toward ensurePod.
  const resolveHostForWake = async (): Promise<ResolvedAgentHost | null> => {
    const hostResult = await resolveAgentHost(agentId)
    if (hostResult.status === 'missing') {
      console.warn(`[scheduler] ${agentId} wake ignored: no active agent row`)
      return null
    }
    if (hostResult.status === 'error') {
      const cause = hostResult.cause instanceof Error
        ? `: ${hostResult.cause.message}`
        : ''
      console.error(`[scheduler] ${hostResult.reason}${cause}`)
      if (hostResult.code === 'lookup_failed') {
        await scheduleWakeRetry(
          agentId,
          reason,
          conversationId,
          steerPayload,
          options,
          retryAttempt + 1,
          hostResult.reason,
          'host_resolution',
        )
      } else {
        void notifyAlert({
          label: 'scheduler.invalid_agent_host_assignment',
          error: new Error(hostResult.reason),
          extras: { agentId, reason, conversationId },
        })
      }
      return null
    }
    return hostResult
  }

  let host: ResolvedAgentHost | null = null
  if (options.placementTriage) {
    host = await resolveHostForWake()
    if (!host) return
    // BYOA daemons triage locally. Managed Agents are gated before a live-pod
    // wake or a new Pod; the flag is serialized into retries so recovery cannot
    // bypass the same placement + triage contract.
    if (!isByoaKind(host.kind) && reason === 'message.new' && !options.triageNote) {
      const verdict = await triageWakeRecipient(agentId, options.triageTarget ?? null)
      if (!verdict) return
      options = { ...options, ...verdict }
    }
  }

  const wakePayload = {
    kind: 'wake' as const,
    reason,
    conversationId,
    ...(options.idleReason ? { idleReason: options.idleReason } : {}),
    ...(options.backgroundBrief ? { backgroundBrief: options.backgroundBrief } : {}),
    ...(options.pollBrief ? { pollBrief: options.pollBrief } : {}),
    ...(options.triageNote ? { triageNote: options.triageNote } : {}),
  }
  const delivered = await deliverWake(agentId, wakePayload)

  // Steering: if the agent's pod is currently mid-turn (busy lease in
  // Redis), ALSO publish the message body as a steer event so the
  // running turn can inject it at the next hop boundary. Steer is
  // additive to wake — the wake gets the pod's drain loop spinning,
  // and the steer carries the actual content. If the pod is idle the
  // steer payload is harmless (queue gets discarded by the new turn's
  // resetSteerForAgent at start).
  //
  // STEER_ENABLED kill-switch: if env says false, never publish a
  // steer. Wake still fires; the message is in the DB; the agent's
  // next turn picks it up via loadInbox normally. Use this knob to
  // disable steering during an incident without a redeploy.
  if (env.STEER_ENABLED && steerPayload && delivered > 0) {
    const busy = await isAgentBusy(agentId).catch(() => false)
    if (busy) {
      // Per-agent rate limit: at most STEER_RATE_PER_MINUTE steers
      // delivered in any rolling 60s window. Above that, fall through
      // to wake-only (message is still in DB → next wake picks it up).
      // Without this, a spam loop could saturate MAX_BATCHES_PER_TURN
      // within seconds and the agent's runtime budget burns down.
      const allowed = await consumeSteerRateToken(agentId)
      if (!allowed) {
        console.warn(`[scheduler] steer rate-limited for ${agentId}; falling back to wake-only`)
      } else {
        await deliverSteer(agentId, steerPayload).catch((err) =>
          console.warn(`[scheduler] deliverSteer(${agentId}) failed:`,
            err instanceof Error ? err.message : err),
        )
        // Visible acknowledgement: the steer payload won't actually be
        // injected into the LLM context until the next hop boundary
        // (turn.ts drains between LLM iterations, not mid-tool). For a
        // long-running tool call — yt-dlp / ffmpeg / opencli browser —
        // that boundary could be minutes away, during which the user
        // sees nothing at all and the agent reads as "silent."
        //
        // Fire a typing indicator on the source conversation so the
        // renderer immediately shows "<agent> is typing…" — proof to
        // the human that their steer was received and is queued. The
        // typing event auto-expires in the renderer (no `done:true`
        // teardown needed); when the agent eventually replies, the
        // typing indicator gets replaced by the new message naturally.
        if (steerPayload.conversationId) {
          await publish(CH_TYPING, {
            type: 'typing',
            conversationId: steerPayload.conversationId,
            agentId,
            done: false,
            companyId: steerPayload.companyId,
          }).catch((err) =>
            console.warn(`[scheduler] steer-ack publishTyping(${agentId}) failed:`,
              err instanceof Error ? err.message : err),
          )
        }
      }
    }
  }

  if (delivered > 0) return

  if (!host) {
    host = await resolveHostForWake()
    if (!host) return
  }

  // BYOA agents run on a user-paired Computer (the `cumora agent computer`
  // daemon), never a server-managed pod. If delivered === 0 the daemon
  // simply isn't subscribed right now (host offline / asleep) — there's
  // nothing to spin up. The wake is durable via the inbox, so the daemon
  // catches up on its next reconnect drain, same as a cold pod would.
  // Skip the pod path entirely; do NOT ensurePod / wake-retry kubectl.
  if (isByoaKind(host.kind)) {
    console.log(`[scheduler] ${agentId} is BYOA (${host.kind}); daemon offline — wake deferred to reconnect`)
    return
  }

  // Free tier is BYOA-only: it must NEVER spin a managed Cumora Cloud pod. A free
  // agent only runs when its own paired daemon is connected (delivered>0, handled
  // above) or reconnects (isByoaKind, handled above). Reaching here for a free
  // company means the agent is unassigned/managed with no live daemon — defer, do
  // NOT ensurePod. Previously this was ungated ("grandfathered free on cloud"),
  // which silently ran thousands of free agents on managed cloud — a real cost
  // leak; the polluted legacy data (cloud computers + managed engines) was cleaned
  // up separately. The wake stays durable in the inbox for whenever they pair.
  if (host.tier === 'free') {
    console.log(`[scheduler] ${agentId} is free-tier (BYOA-only); no managed pod — wake deferred until paired`)
    return
  }

  // Paid (pro/max) managed agent — spin up a Pod. The Pod will catch up on first
  // connect via its initial drain(); we don't need to deliver the
  // event explicitly afterwards because the inbox IS the source of
  // truth.
  const r = await ensurePod(agentId)
  if (r.created) {
    console.log(`[scheduler] ${agentId} resting → spinning up pod (${reason})`)
    // A successful kubectl apply does not guarantee the pod will ever
    // reach the runtime wake stream: kubelet can reject allocation
    // immediately after scheduling (for example a transient unhealthy
    // devic.es/fuse device). Queue one delayed health retry for
    // durable wakes; if the pod is healthy, the retry just delivers a
    // wake and the inbox fingerprint makes the turn no-op.
    await scheduleWakeRetry(agentId, reason, conversationId, steerPayload, options, Math.max(1, retryAttempt + 1), 'post-spawn health check')
  } else if (!r.ok) {
    console.error(`[scheduler] ${agentId} ensurePod failed: ${r.reason}`)
    await scheduleWakeRetry(
      agentId,
      reason,
      conversationId,
      steerPayload,
      options,
      retryAttempt + 1,
      r.reason,
      r.code === 'placement_lookup_failed' ? 'host_resolution' : 'ensure_pod',
    )
    return
  } else if (r.reason === 'already pending' || r.reason === 'already running') {
    await scheduleWakeRetry(agentId, reason, conversationId, steerPayload, options, retryAttempt + 1, r.reason)
  }

  // Message wakes are durable because the message is already in the inbox,
  // and the pod's cold-start drain reads that source of truth. Synthetic
  // idle/background wakes have no inbox row, so replay the wake briefly after
  // the pod is created until its SSE stream attaches.
  if (reason !== 'message.new') {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const replayed = await deliverWake(agentId, wakePayload).catch(() => 0)
      if (replayed > 0) return
    }
    console.warn(`[scheduler] ${agentId} synthetic wake (${reason}) was not delivered after pod start`)
  }
}

/** Multi-instance dedup: every cumora-server replica subscribes to
 *  CH_MESSAGE_NEW, so a single message.new fan-outs to N servers.
 *  Without this guard each replica would call wake() → ensurePod →
 *  deliverWake (Redis publish) independently — agent Pod ends up
 *  receiving N copies of the wake event (drain folds via
 *  pendingRerun, so it's correctness-safe but wasteful), and N
 *  parallel kubectl-applies fight at the K8s API server.
 *
 *  Fix: SETNX a key per message id; only the first replica that
 *  claims it proceeds. TTL=60s reaps the key automatically. */
async function claimAndWake(payload: MessageNewEvent): Promise<void> {
  const key = `cumora:wake-claim:${payload.message.id}`
  const claimed = await redis.set(key, '1', 'EX', 60, 'NX').catch(() => null)
  if (claimed === null) return     // another replica owns this wake
  await wake(payload)
}

// ─── author-name cache (Fix #10) ─────────────────────────────────────
//
// Phase 4 originally did `SELECT name FROM participants WHERE id = $1`
// for every new message to resolve the display name for the steer
// prefix. That's N+1 per group-chat message (one query per agent
// member that gets a steer). participants.name changes rarely, so a
// small LRU with a 5-minute TTL collapses the N+1 into ~0 queries in
// steady state. Cache miss is still correct — falls back to authorId.

interface CachedName { name: string; expiresAt: number }
const AUTHOR_NAME_CACHE_TTL_MS = 5 * 60_000
const AUTHOR_NAME_CACHE_MAX = 5_000 // rough cap on a single-process Map
const authorNameCache = new Map<string, CachedName>()

/** Exported for testability. Lookup happens at most once per
 *  authorId per AUTHOR_NAME_CACHE_TTL_MS, with a capacity-trim pass
 *  on overflow. Returns authorId on any DB error so the steer
 *  prefix never breaks. */
export async function resolveAuthorName(authorId: string): Promise<string> {
  const now = Date.now()
  const hit = authorNameCache.get(authorId)
  if (hit && hit.expiresAt > now) return hit.name
  // Best-effort DB read. On error we cache nothing (so the next
  // message retries) and return the id as fallback.
  try {
    const { rows } = await pool.query<{ name: string | null }>(
      `SELECT name FROM participants WHERE id = $1 LIMIT 1`, [authorId],
    )
    const name = rows[0]?.name || authorId
    // Opportunistic capacity trim — when the map exceeds the cap,
    // drop everything that's expired; if still over, drop the
    // OLDEST entries (Map iteration is insertion-ordered, so the
    // first entries are the oldest).
    if (authorNameCache.size >= AUTHOR_NAME_CACHE_MAX) {
      for (const [k, v] of authorNameCache) {
        if (v.expiresAt <= now) authorNameCache.delete(k)
      }
      while (authorNameCache.size >= AUTHOR_NAME_CACHE_MAX) {
        const firstKey = authorNameCache.keys().next().value
        if (firstKey === undefined) break
        authorNameCache.delete(firstKey)
      }
    }
    authorNameCache.set(authorId, { name, expiresAt: now + AUTHOR_NAME_CACHE_TTL_MS })
    return name
  } catch {
    return authorId
  }
}

/** Test-only: clear the author-name cache so test cases don't poison
 *  each other. Production code never calls this. */
export function _resetAuthorNameCacheForTests(): void {
  authorNameCache.clear()
}

// ─── steer rate limit (Fix #8) ───────────────────────────────────────
//
// A spam loop (compromised account, runaway script, etc.) could fire
// hundreds of messages/sec at one agent. Even with MAX_BATCHES_PER_TURN
// and MAX_BYTES_PER_TURN limiting in-pod consumption, the network +
// Redis pub/sub bandwidth + the agent's hop budget would still burn.
// Rate limit at the publish edge: at most STEER_RATE_PER_MINUTE steers
// dispatched per agent in any rolling 60s window. Beyond that, fall
// through to wake-only (message stays in DB → next wake handles).

const STEER_RATE_PER_MINUTE = 30

/** Attempts to consume one steer-rate token for the agent. Returns
 *  true if allowed, false if the rate limit is exceeded. Uses an
 *  atomic Lua-like INCR-and-check, which on first call sets a 60s
 *  TTL — so the counter naturally resets. Fail-open on Redis errors
 *  (steers continue; the wake path is correct anyway). */
async function consumeSteerRateToken(agentId: string): Promise<boolean> {
  try {
    const key = `cumora:steer-rate:${agentId}`
    // INCR is atomic; we set the TTL only on the FIRST increment so
    // the window doesn't get reset on every call. EXPIRE returns 1
    // if the TTL was applied, 0 if the key already had one or didn't
    // exist. Race-safe enough at the per-second granularity we need.
    const count = await redis.incr(key)
    if (count === 1) {
      await redis.expire(key, 60).catch(() => { /* best-effort */ })
    }
    return count <= STEER_RATE_PER_MINUTE
  } catch {
    return true // fail-open
  }
}

/** Test-only: clear the rate-limit counter for an agent so tests
 *  don't poison each other. Production never calls this. */
export async function _resetSteerRateForTests(agentId: string): Promise<void> {
  try { await redis.del(`cumora:steer-rate:${agentId}`) } catch { /* ignore */ }
}

async function wake(payload: MessageNewEvent): Promise<void> {
  const conversationId = payload.conversationId
  const authorId = payload.message.authorId
  const messageKind = payload.message.kind
  const messageBody = payload.message.body
  const messageId = payload.message.id

  // Steering: build a steer payload only for user-visible message
  // kinds — system notices (quota exhausted, etc.) are noise the
  // model doesn't need re-injected mid-turn. Resolve the author's
  // display name via the cache above so a group chat with N agents
  // doesn't trigger N participants-lookups per message.
  let steerPayload: SteerWakePayload | null = null
  if (messageKind !== 'system' && messageBody && messageBody.length > 0) {
    const authorName = await resolveAuthorName(authorId)
    steerPayload = { messageId, conversationId, authorName, body: messageBody, companyId: payload.companyId ?? '' }
  }

  const { rows: convoRows } = await pool.query<{
    members: string[]
    kind: string
    company_id: string
    muted_agent_ids: string[]
  }>(
    `SELECT c.members, c.kind, c.company_id,
            COALESCE(array_agg(mu.user_id) FILTER (WHERE mu.user_id IS NOT NULL), ARRAY[]::text[]) AS muted_agent_ids
       FROM conversations c
       LEFT JOIN conversation_mutes mu ON mu.conversation_id = c.id
        AND (mu.muted_until IS NULL OR mu.muted_until > NOW())
      WHERE c.id = $1
      GROUP BY c.id`,
    [conversationId],
  )
  const conversation = convoRows[0]
  if (!conversation) return
  const members = conversation?.members ?? []
  if (steerPayload) steerPayload.companyId = conversation.company_id
  const mutedAgentIds = new Set(conversation?.muted_agent_ids ?? [])
  let quotedAuthorId = payload.message.quoted?.authorId ?? null
  if (!quotedAuthorId && payload.message.quotedMessageId && mutedAgentIds.size > 0) {
    const { rows } = await pool.query<{ author_id: string }>(
      `SELECT author_id FROM messages WHERE id = $1 AND conversation_id = $2`,
      [payload.message.quotedMessageId, conversationId],
    )
    quotedAuthorId = rows[0]?.author_id ?? null
  }
  const { rows: currentAgentRows } = await pool.query<{ id: string }>(
    `SELECT id FROM participants
      WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL
        AND id = ANY($2::text[])`,
    [conversation.company_id, members],
  )
  const currentAgents = new Set(currentAgentRows.map((row) => row.id))
  const agentRecipients: string[] = []
  for (const m of members) {
    if (m === authorId) continue
    // Treat conversations.members as untrusted denormalized data. A malformed
    // cross-tenant id must never become a wake/steer recipient for this tenant.
    if (!currentAgents.has(m)) continue
    if (mutedAgentIds.has(m) && !shouldDeliverToMutedAgent({
      agentId: m,
      conversationKind: conversation?.kind ?? 'group',
      body: messageBody,
      quotedAuthorId,
    })) continue
    agentRecipients.push(m)
  }

  // Whether to reply into an agent-only thread is the small model's decision
  // (it sees the per-conversation "thread heat" signal and goes quiet). The
  // scheduler no longer makes that call — it only applies a content-blind cost
  // floor: when an AGENT's message would wake peers, drop the wake for any
  // recipient that is over its activation budget, so a runaway can't burn
  // unbounded cost. Human-driven wakes are NEVER throttled.
  const authorIsAgent = currentAgents.has(authorId) || Boolean((await pool.query(
    `SELECT 1 FROM participants
      WHERE id = $1 AND company_id = $2
        AND kind = 'agent' AND departed_at IS NULL`,
    [authorId, conversation.company_id],
  )).rowCount)
  let recipients = agentRecipients
  if (authorIsAgent) {
    const allowed = await Promise.all(
      agentRecipients.map(async (m) => (await consumeAgentTurnToken(m)) ? m : null),
    )
    recipients = allowed.filter((m): m is string => m !== null)
    const dropped = agentRecipients.length - recipients.length
    if (dropped > 0) {
      console.warn(`[scheduler] turn-rate floor: dropped ${dropped} agent-driven wake(s) in ${conversationId} (over ${AGENT_TURN_RATE_PER_MINUTE}/min)`)
    }
  }

  // A leave/kick commits the membership removal before this event is
  // published, so the departing agent no longer appears in `members`. The
  // persisted message may name one durable delivery recipient; the query
  // above validates that it is an active agent in this conversation's tenant
  // before we restore it to fan-out. Departure explanations bypass mute and
  // the agent-authored cost floor because this is the final access-revocation
  // notice, not ordinary conversation chatter.
  const deliveryAgentId = await resolveDurableDeliveryAgent({
    conversationId,
    messageId,
    companyId: conversation.company_id,
    claimedRecipientId: payload.message.deliveryRecipientId,
  })
  if (deliveryAgentId && !recipients.includes(deliveryAgentId)) {
    recipients = [...recipients, deliveryAgentId]
  }

  // ROUTING (#70). A human message that explicitly NAMES agents is usually for
  // them, and waking the rest of the room costs a full big-brain turn each to
  // reach "not mine" — production measures ~26% of group wakes replying with
  // nothing. Ask the cerebellum ONCE per message (not once per agent) whether the
  // named agents are the intended audience, and narrow only then.
  //
  // Deliberately conservative, because narrowing is the one mistake that is
  // SILENT — a agent that should have answered and was never woken leaves no
  // reply, no typing indicator, no agent_runs row. So this only ever runs for a
  // human-authored group message with a real named subset, and every uncertainty
  // (@all, no targets, a model error, an unparseable answer) keeps today's full
  // fan-out. See routing.ts.
  if (!authorIsAgent && (conversation?.kind ?? 'group') !== 'direct' && recipients.length > 1) {
    const targets = [
      ...mentionedAgentIds(messageBody, recipients),
      ...(quotedAuthorId && recipients.includes(quotedAuthorId) ? [quotedAuthorId] : []),
    ]
    const uniqueTargets = [...new Set(targets)]
    if (uniqueTargets.length > 0) {
      const mode = await routeMessage({
        companyId: payload.companyId ?? null,
        body: messageBody,
        conversationKind: conversation?.kind ?? 'group',
        candidates: recipients,
        targets: uniqueTargets,
      })
      const routed = recipientsForRoute(mode, recipients, uniqueTargets)
      if (routed.length !== recipients.length) {
        console.log(`[scheduler] routed ${conversationId} to ${routed.join(', ')} (mode=${mode}, ${recipients.length - routed.length} wake(s) avoided)`)
      }
      recipients = routed
    }
  }

  // Always parallel fan-out. We tried a scheduler-side serial queue
  // for @all (stagger → event-driven Redis state machine) — both
  // worked mechanically but felt like nothing a real team would do.
  // Real coordination happens at the AGENT level: see the room,
  // glance once more before committing, defer when a peer is on it.
  // Those affordances live in pod-agent + the `cumora glance` tool +
  // the broadcast etiquette section of the persona prompt — the
  // scheduler wakes every subscribed, non-muted agent at the same time,
  // like a Slack room. A muted agent only passes through for an exact
  // mention or quoted reply.
  await fanOutWake(
    recipients,
    conversationId,
    steerPayload,
    deliveryAgentId ? { recipientId: deliveryAgentId, messageId } : null,
  )
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Muted rooms are genuinely absent from an agent's delivery stream. The
 * only intentional escape hatches are a direct conversation, an explicit
 * @agent-id token, or a reply to one of that agent's messages. Exported so
 * the delivery contract stays regression-testable without Redis/Postgres. */
export function shouldDeliverToMutedAgent(args: {
  agentId: string
  conversationKind: string
  body: string
  quotedAuthorId: string | null
}): boolean {
  if (args.conversationKind === 'direct') return true
  if (args.quotedAuthorId === args.agentId) return true
  const mention = new RegExp(`(^|[^\\w@])@${escapeRegex(args.agentId)}(?![\\w-])`, 'i')
  return mention.test(args.body)
}

/** Which of `agentMemberIds` this message explicitly @-mentions.
 *
 *  Same token rule as {@link shouldDeliverToMutedAgent} — an exact `@id`, not a
 *  prefix and not an email — so "addressed to" means one thing everywhere.
 *
 *  This is a PROMPT signal, never a delivery decision. Narrowing the wake to
 *  the mentioned agents looks tempting and is not safe: a mentioned BYOA agent
 *  whose laptop is closed has its wake deferred, and the peers who would have
 *  covered were never woken — so the room stays silent. Worse, an excluded peer
 *  who posts anything else in that room auto-acks their read cursor to NOW
 *  (`cumora reply`), which puts the human's message permanently BEHIND the
 *  cursor: not deferred, gone. So every member still wakes, and the mention only
 *  tells them who it was for.
 *
 *  Exported for tests. */
export function mentionedAgentIds(body: string, agentMemberIds: readonly string[]): string[] {
  if (!body) return []
  return agentMemberIds.filter((id) =>
    new RegExp(`(^|[^\\w@])@${escapeRegex(id)}(?![\\w-])`, 'i').test(body))
}

/** Exported for tests — pulled out of `wake` so the wake-policy is
 *  easy to assert on. Fire-and-forget per recipient. */
function renderTriageNote(verdict: InboxTriageVerdict): string {
  const state = verdict.actionable ? 'relevant' : 'not relevant'
  const reason = verdict.reason.trim() ? `\nReason: ${verdict.reason.trim().slice(0, 500)}` : ''
  return `Small-brain inbox triage (${state}, ${verdict.source}): ${verdict.promptNote.trim()}${reason}`
}

export async function triageWakeRecipient(
  agentId: string,
  durableDelivery: { conversationId: string; messageId: string } | null = null,
): Promise<WakeOptions | null> {
  try {
    const persona = await inprocClient.loadPersona(agentId)
    if (!persona) return null
    let inbox = await inprocClient.loadInbox(agentId)
    if (inbox.length === 0) return null
    if (durableDelivery) {
      const terminal = inbox.find((row) =>
        row.id === durableDelivery.messageId &&
        row.conversation_id === durableDelivery.conversationId)
      if (terminal) {
        // Managed/cloud agents do not need an expensive main-brain turn for an
        // informational departure. Consume the exact persisted row here, which
        // mirrors the BYOA daemon's system-only snapshot+ack path and prevents
        // the terminal notice from replaying forever or resurfacing after a
        // later re-invite. Other unread work remains eligible for normal triage.
        await inprocClient.markConversationRead({
          agentId,
          conversationId: terminal.conversation_id,
          upToMessageId: terminal.id,
        })
        console.log(`[scheduler] ${agentId} acknowledged durable departure notice ${terminal.id}`)
        inbox = inbox.filter((row) => row.id !== terminal.id)
        if (inbox.length === 0) return null
      }
    }
    const convoIds = [...new Set(inbox.map((m) => m.conversation_id))]
    const context = await inprocClient.loadContext(agentId, persona.companyId, convoIds)
    const verdict = await classifyInboxTriage({
      agentId,
      companyId: persona.companyId,
      persona,
      inbox,
      context,
    })
    if (!verdict.actionable) {
      console.log(`[scheduler] ${agentId} message.new skipped by inbox triage: ${verdict.reason}`)
      return null
    }
    return { triageNote: renderTriageNote(verdict) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[scheduler] ${agentId} inbox triage unavailable; waking fail-open: ${reason}`)
    return {
      triageNote:
        `Small-brain inbox triage failed in the scheduler, so this wake is fail-open. ` +
        `Read the inbox/context yourself and do not reply unless the new messages concern you. Reason: ${reason.slice(0, 500)}`,
    }
  }
}

export async function fanOutWake(
  recipients: string[],
  conversationId: string,
  steerPayload: SteerWakePayload | null,
  durableDelivery: { recipientId: string; messageId: string } | null = null,
): Promise<void> {
  // Bounded fan-out (env.WAKE_FANOUT_CONCURRENCY). Each recipient's work
  // — host resolve, the support-model triage (3 DB reads + a model call)
  // and wakeOne (Redis publish + ensurePod/kubectl) — runs under one
  // semaphore so a large group / agent reply-storm can't stampede the pg
  // pool and trip the triage fail-open amplification loop (the
  // 2026-05-27 connection-exhaustion outage). Excess recipients queue
  // and drain at a sustainable rate; a delayed wake still self-heals —
  // the message is durable in the inbox, the pod drains on attach, and
  // the per-message wake-claim TTLs out in 60s.
  await Promise.all(recipients.map((m) => wakeFanoutSem.run(async () => {
    // One recipient failing (triage throw, kubectl flake) must not stop
    // the others or escape into the Redis on-message handler.
    try {
      // wakeOne owns the single placement decision and managed triage. Keeping
      // both inside the retryable operation prevents an earlier lookup failure
      // from being reinterpreted as cloud and preserves the durable departure
      // target across a retry.
      const options: WakeOptions = durableDelivery?.recipientId === m
        ? {
            placementTriage: true,
            triageTarget: { conversationId, messageId: durableDelivery.messageId },
          }
        : { placementTriage: true }
      // Await INSIDE the slot so it's held across host resolution, triage and
      // ensurePod (kubectl). That's what bounds DB, model and child-process
      // pressure together.
      await wakeOne(m, 'message.new', conversationId, steerPayload, options)
    } catch (err) {
      console.error(`[scheduler] wakeOne(${m}) failed:`, err instanceof Error ? err.message : err)
    }
  })))
}


let started = false
export function startScheduler(): void {
  if (started) return
  started = true
  void sub.subscribe(CH_MESSAGE_NEW, (err) => {
    if (err) console.error('[scheduler] subscribe failed', err)
  })
  // Wake the poll author on every state change. Without this an agent
  // who posts a poll sees the original message land in everyone's
  // inbox but never finds out when votes actually come in — and they
  // can neither nudge laggards mid-poll nor summarize when it closes.
  void sub.subscribe(CH_POLLS, (err) => {
    if (err) console.error('[scheduler] CH_POLLS subscribe failed', err)
  })
  sub.on('message', (channel, raw) => {
    if (channel === CH_MESSAGE_NEW) {
      let payload: MessageNewEvent
      try { payload = JSON.parse(raw) as MessageNewEvent } catch { return }
      if (payload.type !== 'message.new') return
      // fire-and-forget — pool.query inside wake() or ensurePod's kubectl
      // shell-out can transiently reject. We don't want an unhandled
      // rejection here; just log and let the next wake retry. The
      // wake-claim Redis key TTLs out in 60s so a missed wake recovers
      // naturally on the next message in the same convo.
      claimAndWake(payload).catch((err) => {
        console.error(`[scheduler] claimAndWake failed for ${payload.message?.id}:`,
          err instanceof Error ? err.message : err)
      })
      return
    }
    if (channel === CH_POLLS) {
      let payload: PollUpdatedEvent
      try { payload = JSON.parse(raw) as PollUpdatedEvent } catch { return }
      if (payload.type !== 'poll.updated') return
      handlePollUpdated(payload).catch((err) => {
        console.error(`[scheduler] handlePollUpdated failed for ${payload.messageId}:`,
          err instanceof Error ? err.message : err)
      })
      return
    }
  })
  startWakeRetryWorker()
  console.log(`[scheduler] mailbox scheduler listening on ${CH_MESSAGE_NEW}, ${CH_POLLS} · runtime=pod-only`)
}

// ─── poll author wake (real-time vote watching) ──────────────────────
//
// When a poll moves (vote cast, vote changed, poll closed), wake the
// agent who AUTHORED that poll so it can:
//   • watch the tally come in
//   • nudge laggards mid-poll
//   • summarize on close
//
// Filters:
//   • author must be an active agent (humans get UI updates already)
//   • skip when the actor IS the author (we don't self-wake an agent
//     who just voted on their own poll — would also infinite-loop)
//
// Debounce:
//   • vote events claim cumora:poll-vote-wake-claim:<msg> with TTL
//     POLL_VOTE_WAKE_DEBOUNCE_SECONDS. Only the first replica/event
//     within the window wakes; subsequent votes silently drop. The
//     agent's turn reads fresh state via the brief built RIGHT BEFORE
//     the wake (and can call `cumora poll show` for newer state).
//   • close events claim a separate cumora:poll-close-wake-claim:<msg>
//     with a long TTL so cross-replica idempotency holds; closePoll
//     is itself idempotent so a duplicate event is harmless apart
//     from the wasted wake.
const POLL_VOTE_WAKE_DEBOUNCE_SECONDS = 8
const POLL_CLOSE_WAKE_CLAIM_SECONDS = 600

export async function handlePollUpdated(event: PollUpdatedEvent): Promise<boolean> {
  if (!event.companyId) return false
  const { rows } = await pool.query<{ author_id: string; members: string[] }>(
    `SELECT m.author_id, c.members
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN participants author
         ON author.id = m.author_id
        AND author.company_id = c.company_id
        AND author.kind = 'agent'
        AND author.departed_at IS NULL
      WHERE m.id = $1 AND m.company_id = $2
        AND m.conversation_id = $3
        AND c.company_id = $2
        AND c.members @> to_jsonb(ARRAY[m.author_id])`,
    [event.messageId, event.companyId, event.conversationId],
  )
  const row = rows[0]
  if (!row) return false
  const authorId = row.author_id
  // The join above is the disclosure boundary: a departed, moved, or kicked
  // poll author must not receive a later tally containing room membership,
  // voter identities, or option text.
  // Skip self-wake: if the agent voted on (or closed) their own poll,
  // they already know.
  if (event.actorId && event.actorId === authorId) return false

  const isClose = Boolean(event.poll.closedAt)
  const claimKey = isClose
    ? `cumora:poll-close-wake-claim:${event.messageId}`
    : `cumora:poll-vote-wake-claim:${event.messageId}`
  const claimTtl = isClose ? POLL_CLOSE_WAKE_CLAIM_SECONDS : POLL_VOTE_WAKE_DEBOUNCE_SECONDS
  const claimed = await redis.set(claimKey, '1', 'EX', claimTtl, 'NX').catch(() => null)
  if (claimed === null) return false // another replica owned this wake, or debounce window still open

  // Resolve display names for everyone we plan to surface in the
  // brief — author already excluded, voters from the tallies, and
  // pending voters (members − {author} − voters).
  const voterSet = new Set<string>()
  for (const t of event.tallies) {
    for (const v of t.voterIds) voterSet.add(v)
  }
  const idsToResolve = new Set<string>([...row.members, ...voterSet])
  if (event.actorId) idsToResolve.add(event.actorId)
  const names = await resolveCurrentParticipantNames([...idsToResolve], event.companyId)
  const currentIds = new Set(names.keys())
  const currentVoters = new Set([...voterSet].filter((id) => currentIds.has(id)))
  const pendingIds = row.members.filter((id) =>
    id !== authorId && currentIds.has(id) && !currentVoters.has(id))

  const brief: PollWakeBrief = {
    messageId: event.messageId,
    conversationId: event.conversationId,
    question: event.poll.question,
    mode: event.poll.mode,
    status: isClose ? 'closed' : 'open',
    closedReason: event.poll.closedReason,
    expiresAt: event.poll.expiresAt,
    totalVotes: event.tallies.reduce(
      (sum, tally) => sum + tally.voterIds.filter((id) => currentIds.has(id)).length,
      0,
    ),
    tallies: event.poll.options.map((opt) => {
      const tally = event.tallies.find((t) => t.optionId === opt.id)
      const voters = (tally?.voterIds ?? []).filter((id) => currentIds.has(id)).map((id) => ({
        id, name: names.get(id) ?? id,
      }))
      return { optionId: opt.id, text: opt.text, count: voters.length, voters }
    }),
    pending: pendingIds.map((id) => ({ id, name: names.get(id) ?? id })),
    actor: {
      id: event.actorId && currentIds.has(event.actorId) ? event.actorId : null,
      name: event.actorId && currentIds.has(event.actorId) ? (names.get(event.actorId) ?? event.actorId) : null,
    },
    phase: isClose ? 'close' : 'vote',
  }

  await wakeAgent(authorId, 'poll.updated', event.conversationId, null, { pollBrief: brief })
  return true
}

/** Resolve only current participants in the poll conversation's tenant.
 * Conversation member arrays and historical vote rows are denormalized and
 * may contain legacy foreign/departed ids; never disclose those through a
 * poll wake. */
async function resolveCurrentParticipantNames(
  ids: string[],
  companyId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  try {
    const { rows } = await pool.query<{ id: string; name: string | null }>(
      `SELECT id, name FROM participants
        WHERE company_id = $1 AND id = ANY($2::text[])
          AND kind IN ('agent', 'human') AND departed_at IS NULL`,
      [companyId, ids],
    )
    for (const r of rows) {
      const name = r.name || r.id
      out.set(r.id, name)
    }
  } catch { /* fail closed: an empty map yields no identity disclosure */ }
  return out
}
