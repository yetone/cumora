/**
 * `cumora agent computer` — the BYOA daemon.
 *
 * A long-running process on the user's machine (laptop or VPS) that hosts one
 * or more of their Cumora agents, using a local engine (Claude Code / Codex / pi /
 * Grok Build / Cursor Agent / OpenCode) as each agent's brain. See docs/BYOA.md.
 *
 * It talks to the Cumora server only over HTTP — no DB/Redis — so it can run
 * anywhere:
 *   - pair once:   cumora agent computer --pair <code> [--server <url>]
 *   - then run:    cumora agent computer [--server <url>]
 *
 * Per managed agent it: mints a short-lived runtime JWT, holds a wake-stream
 * SSE connection, and on each wake spawns the engine in the agent's isolated
 * home (~/.cumora/agents/<id>/). The engine acts on Cumora via a `cumora`
 * shim the daemon writes onto its PATH (which POSTs to /runtime/cli).
 *
 * Standalone: only Node builtins + the DB-free SSE parser + engine.ts.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, chmod, rm, stat, copyFile, truncate } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { delimiter, join, dirname } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
import { parseSseStream, wakeStreamWasStable } from '../runtime/sse-parse.js'
import { detectEnginesWithStatus, snapshotDetectedEngines, getAdapter, ENGINE_IDS, runEngineDoctor, type EngineId, type EngineSession, type EngineRunResult, type EngineUsage, type EngineHopReport } from './engine.js'
import { usageFromClaude, type TokenUsage } from '../cost.js'
import { parseTriage, finalizeTriage, isRateLimited } from '../triage-core.js'
import { GLANCE_YIELD_RULES } from '../glance-protocol.js'
import { SKYPE_EMOTICONS_GUIDE } from '../skype-emoticons.js'
import {
  composeMemoryDigest,
  conversationHeader,
  memoryIndexPathsForScope,
  uniqueProjectIds,
} from '../memory-scope.js'

export { conversationHeader }

const CONFIG_DIR = join(homedir(), '.cumora')
const CONFIG_PATH = join(CONFIG_DIR, 'computer.json')
const AGENTS_ROOT = join(CONFIG_DIR, 'agents')
// Per-agent engine session id, persisted OUTSIDE the agent home (so the engine's
// own cwd can't clobber it). Survives a daemon restart so the next wake can
// `--resume` the SAME engine session — recovering the in-turn context an
// interrupted long task was building, instead of starting cold.
const SESSIONS_DIR = join(CONFIG_DIR, 'sessions')
// Bounded grace on a forced shutdown (SIGTERM/SIGINT): let an in-flight turn try
// to finish before we kill the engine child. The OS supervisor SIGKILLs not long
// after SIGTERM, so this is best-effort for SHORT turns; long tasks rely on the
// session-resume above. Self-update (voluntary) doesn't use this — it waits for
// idle instead (never interrupts work). Override via CUMORA_SHUTDOWN_GRACE_MS.
const SHUTDOWN_GRACE_MS = Number(process.env.CUMORA_SHUTDOWN_GRACE_MS) || 15_000
const DEFAULT_SERVER = process.env.CUMORA_SERVER_URL || 'https://api.cumora.ai'
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000 // refresh 5min before expiry
const AGENT_POLL_MS = 60_000
const HEARTBEAT_MS = 30_000
// How often the daemon re-scans PATH for installed engines. Deliberately much
// slower than the heartbeat: detection spawns a `which`/`where` per engine, and
// nobody installs a CLI twice a minute. The heartbeat carries the CACHED result,
// so the report costs nothing on the 30s tick.
const ENGINE_RESCAN_MS = 5 * 60 * 1000
// While an engine turn is in flight, bump the run's updated_at this often so the
// server's 10-min stale-run sweeper doesn't false-positive a legitimately long
// turn (a multi-hour Bash, a deep task) as "orphaned". 60s = 10× margin under the
// 10-min reaper; cheap (one tiny UPDATE). A long task NO LONGER hits a hidden cap.
const RUN_HEARTBEAT_MS = 60_000
// Fallback inbox drain. The wake-stream SSE can be silently severed by the
// network edge (the server writes the wake onto a half-dead socket, counts it
// delivered, and does nothing more), so a live wake can be lost until the daemon
// detects the drop and reconnects. This low-frequency self-drain bounds catch-up
// latency regardless of SSE health; an empty inbox makes the turn a cheap no-op.
const INBOX_POLL_MS = 20_000
// Pre-turn wake debounce. The FIRST wake from
// an idle state arms this timer; wakes arriving within the window FOLD INTO it —
// the turn snapshots ALL unread, so a burst of group messages becomes ONE big-
// engine turn instead of N. Content-blind, no classification. Trades a small reply
// latency (a beat before the agent starts) for far fewer spawns in a busy room.
const WAKE_DEBOUNCE_MS = 2_500
// Same-turn group notice (default ON — set CUMORA_BYOA_STEER_GROUP=0
// to disable). A DIRECT ping (DM / @me / human) is ALWAYS steered into the live
// turn (see maybeSteer). With this on, plain GROUP activity arriving while busy
// ALSO gets a single CONTENT-FREE nudge ("N new message(s) in <convo> — glance
// and handle if it's yours") injected into the running turn, so the agent can
// pick it up mid-task instead of only via the post-turn coalesced
// rerun. The rerun stays as the coordination-safe BACKSTOP: if the agent handles
// the activity in-turn, the rerun's snapshot finds nothing unread and no-ops; if
// not, it still runs a clean re-glance turn. Originally shipped default-OFF
// because mid-turn group handling ran against the turn-START compose-anchor;
// that anchor is GONE — freshness is now the server-side seen-cursor (HOLD shows
// newer messages and advances the cursor), which arbitrates a mid-turn reply
// exactly like a post-wake one — so the coordination-safety objection no longer
// exists and the busy-room latency win (skip a whole wake→triage→turn cycle per
// coalesced burst) is taken by default.
const STEER_GROUP_IN_TURN = process.env.CUMORA_BYOA_STEER_GROUP !== '0'
// Throttle for the content-free group notice so a fast room can't spam the live
// session — at most one group nudge per this window (direct pings are unthrottled).
const GROUP_STEER_MIN_INTERVAL_MS = Math.max(0, Number(process.env.CUMORA_BYOA_STEER_GROUP_INTERVAL_MS ?? 8_000))
// Board-awareness: when chat is idle, check the agent's AGENDA (assigned Kanban
// cards + due calendar events) so it PROACTIVELY picks up assigned board work
// instead of only reacting to a chat push. Gated like the cloud idle scheduler:
// the agent must have been QUIET (no turn) for AGENDA_QUIET_MS — that quiet window
// is the anti-loop (after it acts, it isn't re-woken until quiet again) — and we
// check at most every AGENDA_CHECK_MS so the 20s poll doesn't hammer it.
// Tightened 3min/2min → 90s/60s: agents have NO wall-clock wakes — a judge who
// says "vote closes in 2 minutes" and goes idle can only be re-woken by a new
// message (there may be none: everyone voted), the 20s poll (no-ops once the
// inbox is acked), or THIS agenda sweep. Measured in werewolf game13: all six
// votes were in by 13:53:05 and the tally sat until a player prodded the judge
// at 13:56:53 — a 4-minute dead-air gap bounded exactly by quiet+check. 90/60
// caps "it's someone's move and nobody speaks" recovery at ~2.5min while the
// server-side agenda classifier (support-model, Cumora-subsidized — not the
// operator's quota) stays throttled by these same gates. A real fix is
// first-class agent reminders; this narrows the gap now.
const AGENDA_QUIET_MS = 90_000
const AGENDA_CHECK_MS = 60_000
const MAX_VISIBLE_ERROR_CHARS = 900
// Big-brain spawn jitter. When an SSE wake fans out to N agents on this
// computer at the same instant (e.g. a human @all in a group), N local-engine
// subprocesses would spawn in the same millisecond and slam Anthropic/OpenAI
// in lockstep — observed today as four byoa_engine_failed notices in a row
// with "Server is temporarily limiting requests · Rate limited" right after
// a counting game kicked off. Sleeping a random 0..MAX before spawning the
// big brain spreads the burst across ~1.5s so the API sees them sequentially
// instead of a stampede. Cheap (worst case: ~1.5s added to one wake's
// latency); the small-brain triage already ran first, so this only delays
// the *expensive* call we'd otherwise rate-limit-fail.
// DETERMINISTIC minimum interval between spawn starts (per-computer, applied
// to BOTH big-brain and triage paths since they share the same Anthropic/
// OpenAI account quota and the same local CLI process pool). Replaces the
// earlier RANDOM jitter approach which was probabilistic: with random
// 0-1500ms jitter, 4 simultaneous wakes could each roll a low value and
// still hit the provider in lockstep. A deterministic start-interval gate
// instead ensures each new start begins at least N ms after the previous
// one — burst rate becomes a hard 2/sec
// regardless of how many agents woke at once. Anthropic/OpenAI short-window
// burst limits are well above 2/sec so this eliminates the "Server is
// temporarily limiting requests" storms entirely without slowing the steady
// state. Override via CUMORA_BYOA_MIN_SPAWN_INTERVAL_MS.
const MIN_SPAWN_INTERVAL_MS = Math.max(0, Number(process.env.CUMORA_BYOA_MIN_SPAWN_INTERVAL_MS ?? 500))
// Per-computer cap on concurrent big-brain spawns. Without this, N agents
// woken on the same SSE fanout each go to triage + spawn in parallel and
// all hit the underlying provider (Anthropic/OpenAI) at the same wall-clock
// window — even with jitter, the user's per-account short-window burst
// limit is typically smaller than the agent count, so we observed 130
// "Server is temporarily limiting requests" hits in 17 minutes during a
// counting game with 7 agents. Serializing through this semaphore makes
// the daemon respect the provider's burst limit by construction:
// excess agents queue while the first N are in flight; queue drains naturally
// as each turn finishes. Trade-off: tail latency for late-queued agents
// while a turn is being served.
//
// DEFAULT 6 (was 2). The 2 was calibrated for the cold-spawn era — every turn
// spawned a fresh CLI process and N simultaneous spawns slammed the provider.
// Two things changed: turns now run through PERSISTENT engine sessions
// (ensureEngineSession — no per-turn process spawn to burst), and actual spawns
// are paced by the deterministic spawnPacer above. What the old default DID
// provably cause: in a broadcast room (werewolf, 7 players woken by every group
// message) the queue ran 6 deep and tail turns waited 215-359s — minutes of
// user-visible silence purely from queueing. 6 keeps a hard backstop while
// letting a whole team think in parallel. Override via CUMORA_BYOA_MAX_CONCURRENT_BIG_BRAIN.
const BIG_BRAIN_CONCURRENCY = Math.max(1, Number(process.env.CUMORA_BYOA_MAX_CONCURRENT_BIG_BRAIN ?? 6))
// Per-computer cap on concurrent SMALL-brain (triage) spawns. The same
// thundering-herd problem the big-brain sem fixes: when N agents wake on
// the same SSE fanout, each spawns its own `claude --model haiku` (or
// `codex --model gpt-5.4-mini`) for triage. Without a cap the local CLI
// processes + Anthropic/OpenAI small-model endpoint get hammered and the
// 30s TRIAGE_TIMEOUT_MS fires for the slower-queued ones, abort sends
// SIGTERM (exit 143), daemon treats abort as rate-limited and enters a
// 30s per-agent cooldown — every agent's triage stalls for 30s, no big
// brain wakes, the whole computer goes silent. Observed today: 4 agents
// `local triage RATE-LIMITED (timed out) — process exited with code 143`
// in the same second. Triage is cheaper than big brain so the default sits
// above BIG_BRAIN_CONCURRENCY. DEFAULT 8 (was 4): a 7-8 agent broadcast wake
// (werewolf, @all) queued in two waves at 4 — measured as "triage 4983-7772ms"
// where most of that was queue wait, delaying every turn behind it. 8 lets a
// full team's gate checks run in one wave; the shared spawnPacer still caps the
// provider burst rate, and the 143/timeout storm the cap exists for stays
// prevented. Override via CUMORA_BYOA_MAX_CONCURRENT_TRIAGE.
const TRIAGE_CONCURRENCY = Math.max(1, Number(process.env.CUMORA_BYOA_MAX_CONCURRENT_TRIAGE ?? 8))
// After a rate-limit hit on this agent, skip ITS turns for this long before
// retrying. Without this, a rate-limited agent re-attempts on EVERY poll +
// SSE wake, each attempt burning a wasted call on the throttled provider
// — that's where the 130 rate-limit log lines came from. A 60s cooldown
// lets the provider's short-window limit reset before we try again.
const ENGINE_BACKOFF_AFTER_RATE_LIMIT_MS = 60_000
// Neutral cwd for LOCAL small-brain triage: no persona CLAUDE.md / skills / MCP,
// so the cerebellum completion is fast and tool-free.
const TRIAGE_DIR = join(CONFIG_DIR, 'triage')
const TRIAGE_TIMEOUT_MS = 30_000

/** Per-computer concurrency gate for big-brain spawns. acquire() resolves
 *  immediately if a slot is free; otherwise it queues FIFO and resolves
 *  when an earlier holder releases. Pure in-process — bounded queue size
 *  follows the agent count (~7 typical), no memory concern. */
class BigBrainSemaphore {
  private inFlight = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight += 1
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.inFlight += 1
  }
  release(): void {
    this.inFlight -= 1
    const next = this.waiters.shift()
    if (next) next()
  }
  /** Diagnostic only — number of waiters currently queued. */
  get queueDepth(): number { return this.waiters.length }
}
const bigBrainSem = new BigBrainSemaphore(BIG_BRAIN_CONCURRENCY)
const triageSem = new BigBrainSemaphore(TRIAGE_CONCURRENCY)

/** Per-computer ADAPTIVE minimum interval between local-CLI spawns.
 *  Deterministic spacing (see MIN_SPAWN_INTERVAL_MS above) that
 *  auto-tunes to the user's actual Anthropic/OpenAI burst quota: starts
 *  at MIN_SPAWN_INTERVAL_MS (default 500ms), doubles on every
 *  rate-limit event (signaled via `onRateLimited()`), capped at 8s.
 *  After CONSECUTIVE_OK_BEFORE_HALVE (5) successive successes (signaled
 *  via `onOk()`), halves back toward the base — so a transient burst
 *  spike doesn't permanently slow steady-state throughput. This lets one
 *  daemon binary work across very different account tiers without env
 *  tuning, and converges to the user's actual quota in a minute or two
 *  of natural traffic. */
class AdaptivePacer {
  private next = 0
  private current: number
  private consecutiveOk = 0
  constructor(private readonly base: number, private readonly maxMs = 8000) {
    this.current = base
  }
  async gate(): Promise<void> {
    if (this.current <= 0) return
    const now = Date.now()
    const earliest = Math.max(now, this.next)
    this.next = earliest + this.current
    const wait = earliest - now
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  /** Called when a spawn after gate() ends up rate-limited. Doubles the
   *  interval (capped) and resets the success streak so we don't halve
   *  back too fast on the next OK. */
  onRateLimited(): void {
    const prev = this.current
    this.current = Math.min(this.maxMs, Math.max(this.base, this.current * 2))
    this.consecutiveOk = 0
    if (this.current !== prev) {
      console.warn(`[pacer] adapt: ${prev}ms → ${this.current}ms (rate-limited; cap ${this.maxMs}ms)`)
    }
  }
  /** Called when a spawn completes cleanly (no rate-limit). After enough
   *  in a row, decay back toward the base. */
  onOk(): void {
    if (this.current === this.base) return
    this.consecutiveOk += 1
    if (this.consecutiveOk >= 5) {
      const prev = this.current
      this.current = Math.max(this.base, Math.floor(this.current / 2))
      this.consecutiveOk = 0
      if (this.current !== prev) {
        console.log(`[pacer] adapt: ${prev}ms → ${this.current}ms (5 ok; decaying toward base ${this.base}ms)`)
      }
    }
  }
  get intervalMs(): number { return this.current }
}
const spawnPacer = new AdaptivePacer(MIN_SPAWN_INTERVAL_MS)

// ─── self-update ──────────────────────────────────────────────────────────
// Injected by esbuild at build time (agent-cli/build.mjs). Source-mode
// launchers may provide CUMORA_VERSION; otherwise development falls back to
// 0.0.0. The typeof guard keeps an undefined build constant safe at runtime.
declare const __CUMORA_VERSION__: string | undefined
export function resolveCurrentVersion(bundledVersion: string | undefined, envVersion = process.env.CUMORA_VERSION): string {
  return bundledVersion ?? (envVersion?.trim() || '0.0.0')
}
const CURRENT_VERSION = resolveCurrentVersion(
  typeof __CUMORA_VERSION__ === 'string' ? __CUMORA_VERSION__ : undefined,
)
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000 // re-check npm every 6h
// Log rotation: the service supervisor (launchd StandardOutPath / systemd) writes
// the daemon's stdout to ~/.cumora/daemon.log and NEVER rotates it — left alone it
// fills the user's disk. We cap it ourselves.
const MAX_LOG_BYTES = 20 * 1024 * 1024 // rotate when the live log passes 20MB
const LOG_ROTATE_MS = 5 * 60 * 1000 // check every 5 minutes
const SERVICE_LABEL = 'io.cumora.daemon'
/** The supervisor (`--install-service`) sets this so the daemon knows a clean
 *  exit will be auto-restarted on `cumora@latest` — only then do we self-exit
 *  to apply an update. A manually-run daemon just logs the available version. */
const SUPERVISED = process.env.CUMORA_SUPERVISED === '1'

export function windowsTaskName(home = homedir()): string {
  const userKey = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 12)
  return `Cumora BYOA Daemon (${userKey})`
}

/** semver-ish a > b for plain MAJOR.MINOR.PATCH (ignores pre-release tags). */
function versionGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}

interface DaemonConfig {
  serverUrl: string
  computerId: string
  deviceToken: string
}

interface AgentInfo {
  id: string
  name: string
  role: string | null
  systemPrompt: string | null
  engine: EngineId | null
  model: string | null
  fastModel: string | null
}

interface RuntimeInboxResponse {
  rows?: Array<{
    id?: string
    conversation_id?: string
    conversation_kind?: string
    conversation_title?: string
    conversation_topic?: string | null
    project_id?: string | null
    project_name?: string | null
    author_name?: string
    author_kind?: string
    body?: string
    kind?: string
    sequence?: number
  }>
}

// How many unread MESSAGE lines the pre-loaded wake digest may carry. It rides
// in EVERY chat turn's prompt (see chatDelta), so it stays small.
const DIGEST_MAX_MESSAGE_LINES = 40

/** Render the pre-loaded unread digest for the wake prompt within
 *  DIGEST_MAX_MESSAGE_LINES.
 *
 *  The budget is spent PER CONVERSATION rather than as one global "newest N
 *  lines" tail, because `ackSeen` marks the WHOLE snapshot read: anything the
 *  digest leaves out is marked read having never been shown, and since
 *  mark-read pins each conversation's cursor at its NEWEST message it can never
 *  resurface in a later wake. A global tail let a burst in one busy room evict —
 *  and then ack away — every message of a quieter conversation, including a
 *  human DM the agent could not even name afterwards. The cloud path avoids this
 *  by giving every conversation with unread its own window (see loadContext).
 *
 *  Whatever the budget still cannot fit is announced IN PLACE with its exact
 *  count and the command that reads it, so the engine can recover the rest
 *  instead of never learning it existed. Conversations keep first-seen order and
 *  their messages stay chronological; when everything fits, every unread line is
 *  shown, exactly as before.
 *
 *  Exported for tests — pure, no server and no engine. */
export function renderInboxDigest(
  byConvo: Map<string, { head: string; msgs: string[] }>,
  budget = DIGEST_MAX_MESSAGE_LINES,
): string {
  if (byConvo.size === 0) return ''
  // Water-fill quietest-first: each conversation takes at most an even share of
  // what is LEFT, so a small conversation keeps all of its messages and the busy
  // one absorbs the slack. When the total fits, this hands every conversation
  // its full set (nothing omitted, nothing announced).
  const keep = new Map<string, number>()
  let lineBudget = budget
  let unserved = byConvo.size
  for (const [id, convo] of [...byConvo].sort((a, b) => a[1].msgs.length - b[1].msgs.length)) {
    const n = Math.min(convo.msgs.length, Math.max(0, Math.floor(lineBudget / unserved)))
    keep.set(id, n)
    lineBudget -= n
    unserved -= 1
  }
  const lines: string[] = []
  for (const [id, convo] of byConvo) {
    const shown = keep.get(id) ?? 0
    lines.push(convo.head)
    // Never drop unread in SILENCE — this turn is about to mark it read.
    if (convo.msgs.length > shown) {
      lines.push(`  … ${convo.msgs.length - shown} older unread message(s) not shown — \`cumora messages ${id} --tail ${convo.msgs.length}\` to read them`)
    }
    // slice(length - shown), NOT slice(-shown): slice(-0) is slice(0) and would
    // print everything for a conversation budgeted to zero.
    lines.push(...convo.msgs.slice(convo.msgs.length - shown))
  }
  return lines.join('\n')
}

interface RuntimeInboxTriageResponse {
  actionable?: boolean
  reason?: string
  promptNote?: string
  source?: string
}

/** `/inbox-triage/payload`: either a verdict the server decided without a model
 *  (hard rule / empty inbox), or the prompt for the daemon's LOCAL small brain. */
interface RuntimeTriagePayload {
  verdict?: RuntimeInboxTriageResponse
  instructions?: string
  input?: string
  /** Direction-aware fail mode: TRUE when the wake is purely agent-to-agent
   *  (no human in the unread set) → a LOCAL triage failure fails CLOSED
   *  (suppress) instead of open, so a flaky local model can't amplify a loop.
   *  Absent/false → fail open (a human is present; never leave them hanging). */
  failClosed?: boolean
}

// ─── arg parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  pair?: string; server?: string; engine?: string
  installService?: boolean; uninstallService?: boolean; restart?: boolean; stop?: boolean
  status?: boolean; logs?: boolean; version?: boolean; doctor?: boolean; help?: boolean
} {
  const out: ReturnType<typeof parseArgs> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h' || argv[i] === 'help') out.help = true
    else if (argv[i] === '--pair') out.pair = argv[++i]
    else if (argv[i].startsWith('--pair=')) out.pair = argv[i].slice('--pair='.length)
    else if (argv[i] === '--server') out.server = argv[++i]
    else if (argv[i].startsWith('--server=')) out.server = argv[i].slice('--server='.length)
    else if (argv[i] === '--engine') out.engine = argv[++i]
    else if (argv[i].startsWith('--engine=')) out.engine = argv[i].slice('--engine='.length)
    else if (argv[i] === '--install-service') out.installService = true
    else if (argv[i] === '--uninstall-service') out.uninstallService = true
    else if (argv[i] === '--restart') out.restart = true
    else if (argv[i] === '--stop') out.stop = true
    else if (argv[i] === '--status') out.status = true
    else if (argv[i] === '--logs') out.logs = true
    else if (argv[i] === '--doctor' || argv[i] === 'doctor') out.doctor = true
    else if (argv[i] === '--version' || argv[i] === '-v') out.version = true
  }
  return out
}

// ─── HTTP helpers ───────────────────────────────────────────────────────

/** Wall-clock cap on every SHORT request/response call to the server (status,
 *  runs, token mint, heartbeat, agent sync).
 *
 *  Without this, a request that never answers — a half-open socket surviving a
 *  laptop sleep/network switch, a hung proxy, a pod that accepted the connection
 *  and stopped — parks the turn forever: `catch` only sees throws, never a
 *  promise that simply doesn't settle. The turn's `finally { this.busy = false }`
 *  never runs, so the agent stays permanently `busy`, every later wake collapses
 *  to `turn busy — coalescing`, and the heartbeat interval stops going out until
 *  the server marks the whole computer offline. One stalled socket takes down
 *  every agent on the machine.
 *
 *  Deliberately NOT applied to the wake-stream (an intentionally long-lived SSE
 *  connection, which has its own idle/backoff handling) or the npm version check. */
const HTTP_TIMEOUT_MS = Math.max(1_000, Number(process.env.CUMORA_HTTP_TIMEOUT_MS ?? 20_000))

async function api<T>(serverUrl: string, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

/** Fire-and-forget runtime call (status / runs). Never throws — observability
 *  must never break the agent loop. The timeout is what makes that promise hold
 *  for a server that stops answering rather than refusing (see HTTP_TIMEOUT_MS):
 *  an abort throws, so it lands in the catch and the turn proceeds. */
async function runtimeBest(
  serverUrl: string, path: string, token: string, body: unknown,
): Promise<unknown> {
  try {
    const res = await fetch(`${serverUrl}/runtime${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    return res.ok ? await res.json().catch(() => null) : null
  } catch { return null }
}

async function runtimeGet<T>(
  serverUrl: string, path: string, token: string,
): Promise<T | null> {
  try {
    const res = await fetch(`${serverUrl}/runtime${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    return res.ok ? await res.json().catch(() => null) as T | null : null
  } catch { return null }
}

/** Which conversation should show "<agent> is typing…" for this turn.
 *
 *  The wake's own conversation when it had one. Otherwise derive it from what is
 *  unread, because a wake frequently carries none: a poll-driven turn never does
 *  (only an SSE wake sets it, and polling is the only path left when the
 *  wake-stream is down), and a wake that lands mid-turn is coalesced through
 *  scheduleWake's busy branch, which re-kicks without a conversation.
 *
 *  `seen` is keyed by conversation_id, so the daemon already knows where the work
 *  came from. With exactly one unread conversation that's unambiguous. With
 *  several, stay silent rather than light up an arbitrary room — a wrong
 *  indicator is worse than none, and the reply itself still lands correctly.
 *
 *  Exported for tests: this decides whether a working agent looks alive or dead,
 *  and the "no indicator at all" case is the one users read as a hang. */
export function typingConversation(
  wakeConvo: string | null,
  seen: Map<string, string>,
): string | null {
  if (wakeConvo) return wakeConvo
  return seen.size === 1 ? [...seen.keys()][0] : null
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function conciseError(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .trim()
    .slice(0, MAX_VISIBLE_ERROR_CHARS)
}

// A session that has grown past the model's context window. The daemon drops the
// session on this error so the NEXT wake starts fresh — recovery is automatic.
const CONTEXT_OVERFLOW_RE = /context window|context length|context_length_exceeded|maximum context|reached its context|prompt is too long|input is too long|too many tokens/i

// A POISONED transcript: a string sliced mid-emoji left a lone UTF-16 surrogate,
// and the Anthropic API's strict JSON parser rejected the request body. Once it's
// in the persistent transcript every later turn re-sends it → wedged forever. Only
// dropping the session clears it (same recovery shape as a context overflow). We
// also scrub outgoing text (engine.ts stripLoneSurrogates) so we stop creating it.
const POISONED_BODY_RE = /no (?:low|high) surrogate|unpaired surrogate|lone surrogate|surrogate in string|request body is not valid json/i

// A STALE resume target: we passed `--resume <id>` and the engine says it has no
// such session. Dropping the id is the right recovery — the next wake starts a
// fresh session instead of re-failing against a target that no longer exists.
//
// Every branch pairs the noun with FAILURE wording. A bare mention of a session
// or conversation proves nothing: the engine's own event stream is full of them
// (see `engineDiagnosticProse`), so matching the noun alone turned every
// mid-turn engine death into a "stale resume target" and threw away the session
// id that exists to recover the interrupted turn.
const STALE_RESUME_RE = new RegExp([
  // "No conversation found with session ID: …", "no such session",
  // "No previous sessions found for this project" (gemini, when the whole
  // chats dir is gone). The trailing `s?` is load-bearing: an engine that
  // reports the miss in the PLURAL is saying the resume target is gone just as
  // plainly as the singular, and without it the daemon kept the dead id and
  // re-sent it every wake — a permanently wedged agent, not a degraded one.
  String.raw`\bno (?:such )?(?:\w+ )?(?:conversation|session|thread)s?\b`,
  // "Session not found", "conversation no longer exists", "thread has expired"
  String.raw`\b(?:conversation|session|thread)s?(?: id)?\b[^\n]{0,24}?\b(?:not found|no longer exists?|do(?:es)? not exist|doesn't exist|has expired|is expired|is invalid|is unknown)\b`,
  // "Invalid session id", "unknown conversation", "expired thread"
  String.raw`\b(?:invalid|unknown|expired|stale|malformed) (?:\w+ )?(?:conversation|session|thread)s?\b`,
  // "could not resume", "unable to resume this conversation", "failed to resume"
  String.raw`\b(?:could ?n(?:o|')?t|cannot|can't|unable to|failed to)\b[^\n]{0,24}?\bresume\b`,
  // codex app-server's own wording
  String.raw`\bthread/resume failed\b`,
].join('|'), 'i')

/** The human-readable part of an engine failure blob.
 *
 *  `failurePreview` (engine.ts) appends the tail of the engine's STDOUT to the
 *  error text, and on the Claude path that stdout is stream-json: EVERY event
 *  line carries a `"session_id"` field. Those lines are machine structure, not
 *  diagnosis, so pattern-matching them as prose is what produced the false
 *  "stale resume target" verdict on any mid-turn death. Keep an event line's
 *  error text (that IS diagnosis) and drop everything else about it. */
export function engineDiagnosticProse(err: string): string {
  const out: string[] = []
  for (const line of err.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) { out.push(line); continue }
    let ev: { is_error?: unknown; result?: unknown; error?: unknown }
    try { ev = JSON.parse(trimmed) } catch { continue }
    // `result` is prose only on a FAILED turn; on a successful one it's the
    // agent's own answer, which must never be read as an engine diagnosis.
    if (ev.is_error === true && typeof ev.result === 'string') out.push(ev.result)
    if (typeof ev.error === 'string') out.push(ev.error)
    else if (ev.error && typeof ev.error === 'object') {
      const m = (ev.error as { message?: unknown }).message
      if (typeof m === 'string') out.push(m)
    }
  }
  return out.join('\n')
}

/** True when an engine error really says the `--resume` target is gone. */
export function isStaleResumeError(err: string): boolean {
  return STALE_RESUME_RE.test(engineDiagnosticProse(err))
}

function authFailureHint(engine: EngineId, detail: string): string {
  if (CONTEXT_OVERFLOW_RE.test(detail)) {
    return 'The agent filled up its context window. Its session has been reset automatically — just wake the agent again and it will start fresh.'
  }
  if (POISONED_BODY_RE.test(detail)) {
    return 'A malformed character (a split emoji) had poisoned the agent\'s session. It has been reset automatically — just wake the agent again.'
  }
  if (!/(auth|login|token|quota|credit|billing|subscription|rate limit|usage limit|api key)/i.test(detail)) {
    return 'Check the daemon terminal for details, then wake the agent again.'
  }
  if (engine === 'claude') {
    return 'Open Claude Code on that computer and sign in, refresh quota, or add credits, then wake the agent again.'
  }
  if (engine === 'grok') {
    return 'Open Grok Build on that computer and run `grok login`, or set XAI_API_KEY, then wake the agent again.'
  }
  if (engine === 'cursor') {
    return 'Open a terminal on that computer and run `cursor-agent login` (or fix its quota / API key), then wake the agent again.'
  }
  if (engine === 'opencode') {
    return 'Open a terminal on that computer and run `opencode providers login` (or fix the selected provider/model quota), then wake the agent again.'
  }
  if (engine === 'pi') {
    return 'Open pi on that computer and run `/login` for its provider (or fix the API key / quota), then wake the agent again.'
  }
  return 'Open Codex on that computer and refresh its login or quota, then wake the agent again.'
}

function missingEngineMessage(): string {
  return [
    'no supported local agent engine found on PATH',
    '',
    'Install and sign in to at least one of:',
    '  - Claude Code: install the `claude` CLI, then run `claude` once to sign in',
    '  - Codex: install the `codex` CLI, then run `codex` once to sign in',
    '  - Grok Build: install the `grok` CLI, then run `grok login` once',
    '  - Cursor Agent: install Cursor (the `cursor-agent` CLI ships with it), then run `cursor-agent login`',
    '  - OpenCode: install the `opencode` CLI, then run `opencode providers login` once',
    '  - pi: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, then run `pi` once and `/login` a provider',
    '',
    'After that, rerun:',
    '  npx cumora@latest agent computer --pair <code>',
  ].join('\n')
}

function helpText(): string {
  return [
    'cumora agent computer — run your Cumora agents on THIS machine (BYOA)',
    '',
    'The daemon talks to a Cumora server over HTTP and drives a local agent',
    'engine (Claude Code, Codex, Grok Build, Cursor Agent, OpenCode, or pi). Pair once, then it runs in the background.',
    '',
    'Usage:',
    '  npx cumora@latest agent computer --pair <code> [--server <url>] [--engine <id>]',
    '  npx cumora@latest agent computer [--server <url>]',
    '',
    'Setup:',
    '  --pair <code>        pair this machine to your account (code from',
    '                       Cumora -> You -> Computers -> Add a computer)',
    '  --server <url>       Cumora server URL (default: ' + DEFAULT_SERVER + ')',
    '  --engine <id>        force an engine: ' + ENGINE_IDS.join(' | ') + '',
    '',
    'Background service:',
    '  --install-service    install + start the background supervisor',
    '  --uninstall-service  remove the background supervisor',
    '  --restart            restart the background service',
    '  --stop               stop the background service',
    '  --status             show pairing + service status',
    '  --logs               tail the daemon logs',
    '',
    'Diagnostics:',
    '  --doctor             check engines, PATH, login/quota',
    '  --version, -v        print the daemon version',
    '  --help, -h           show this help',
    '',
    'With no flags it starts the daemon in the foreground (must be paired first).',
  ].join('\n')
}

async function requireLocalEngine(): Promise<EngineId[]> {
  const detected = await detectEnginesWithStatus()
  if (!detected.reliable) {
    throw new Error('could not scan PATH (`which` / `where` failed). Fix that, then retry pairing.')
  }
  if (detected.engines.length === 0) throw new Error(missingEngineMessage())
  return detected.engines
}

/** Resolve the engine a daemon can actually run from its LIVE PATH inventory. */
export function resolveAvailableEngine(
  requested: EngineId | null | undefined,
  available: readonly EngineId[],
): EngineId | null {
  return requested && available.includes(requested) ? requested : (available[0] ?? null)
}

export interface EngineInventory {
  current: EngineId[]
}

/** Replace the shared engine inventory after a trustworthy PATH scan. */
export function replaceEngineInventory(inventory: EngineInventory, next: readonly EngineId[]): boolean {
  const current = inventory.current
  const changed = next.length !== current.length || next.some((engine, i) => engine !== current[i])
  if (changed) inventory.current = [...next]
  return changed
}

// ─── config ─────────────────────────────────────────────────────────────

async function loadConfig(): Promise<DaemonConfig | null> {
  try { return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as DaemonConfig }
  catch { return null }
}

async function saveConfig(cfg: DaemonConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  await chmod(CONFIG_PATH, 0o600)
}

// ─── the `cumora` shim ──────────────────────────────────────────────────
//
// A tiny Node executable named `cumora` that the engine calls via bash. It
// POSTs argv to the server's /runtime/cli, which runs the full CLI server-
// side with the agent's identity pinned by the JWT. No curl/jq dependency.
//
// Exported for tests: the output-truncation regression below is only observable
// by running the real shim text against a real pipe.
export const CUMORA_SHIM = `#!/usr/bin/env node
'use strict'
;(async () => {
  const url = process.env.CUMORA_AGENT_RUNTIME_URL
  // Prefer a token FILE (refreshed by the daemon) over the env token: a PERSISTENT
  // engine process is spawned once, so its env token goes stale on refresh — the
  // file is always current. Falls back to the env token (one-shot / codex path).
  var token = process.env.CUMORA_AGENT_RUNTIME_TOKEN
  var tokenFile = process.env.CUMORA_AGENT_RUNTIME_TOKEN_FILE
  if (tokenFile) { try { var ft = require('fs').readFileSync(tokenFile, 'utf8').trim(); if (ft) token = ft } catch (e) {} }
  if (!url || !token) { console.error('cumora: runtime env not set'); process.exit(70) }
  var argv = process.argv.slice(2)
  // Shell-safe body input. A reply written inline (cumora reply id "..text..")
  // is mangled by bash BEFORE this shim runs: backticks and $(...) get run as
  // commands and collapse to empty, quotes get eaten. So --file <path> /
  // --stdin let the body come from a file (written by the editor, no shell) or
  // a pipe; we read it LOCALLY and pass it as one argument that travels as
  // JSON and is never re-parsed by a shell, so code/quotes/$ survive verbatim.
  //
  // It goes LAST, behind a POSIX \`--\`, so the server takes it literally. Spliced
  // in place it was still read as argv: a body starting with \`---\` (markdown
  // rule, front-matter fence, diff header) parsed as a FLAG and the message was
  // silently dropped, and escapes inside it were expanded a second time.
  var fs = require('fs')
  var body = null
  var fi = argv.indexOf('--file')
  if (fi >= 0 && argv[fi + 1] !== undefined) {
    try { body = fs.readFileSync(argv[fi + 1], 'utf8') }
    catch (e) { console.error('cumora: cannot read --file ' + argv[fi + 1]); process.exit(70) }
    argv.splice(fi, 2)
  }
  var si = argv.indexOf('--stdin')
  if (si >= 0) {
    argv.splice(si, 1)
    if (body === null) { try { body = fs.readFileSync(0, 'utf8') } catch (e) { body = '' } }
  }
  if (body !== null) argv.push('--', body)
  const res = await fetch(url + '/cli', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ argv: argv }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    console.error('cumora: HTTP ' + res.status + ' ' + t)
    process.exit(70)
  }
  const data = await res.json()
  const code = typeof data.exitCode === 'number' ? data.exitCode : 0
  // Exit from the write CALLBACK, not the next statement: stdout on a PIPE is
  // ASYNC, so process.exit() kills us with the tail still buffered. The engine
  // always runs this shim with stdout piped, so a big result (cumora messages
  // --tail 30, cumora inbox --json) silently arrived truncated at the pipe
  // buffer — 64KB, or 8KB on the socketpair a stdio:'pipe' parent hands us —
  // with exit 0 and empty stderr, so nothing signalled the loss and --json
  // output simply failed to parse. Exiting IN the callback also keeps a reader
  // that closed early (| head) an exit-0 like before, instead of the unhandled
  // EPIPE crash a bare process.exitCode would produce.
  if (typeof data.text === 'string' && data.text) process.stdout.write(data.text + '\\n', () => process.exit(code))
  else process.exit(code)
})().catch((e) => { console.error('cumora:', (e && e.message) || e); process.exit(70) })
`

/** PowerShell only resolves files on PATH through PATHEXT, so the extensionless
 *  POSIX shim needs a .cmd launcher on Windows. Keep the Node program itself in
 *  one file so both launchers exercise the exact same argument/HTTP path. */
export const CUMORA_WINDOWS_SHIM = '@echo off\r\nnode "%~dp0cumora" %*\r\n'

export function prependAgentBinToPath(binDir: string, currentPath = process.env.PATH ?? ''): string {
  return currentPath ? `${binDir}${delimiter}${currentPath}` : binDir
}

export async function writeShim(
  binDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mkdir(binDir, { recursive: true })
  const shim = join(binDir, 'cumora')
  await writeFile(shim, CUMORA_SHIM, 'utf8')
  await chmod(shim, 0o755)
  if (platform === 'win32') {
    await writeFile(join(binDir, 'cumora.cmd'), CUMORA_WINDOWS_SHIM, 'utf8')
  }
}

// ─── pairing ────────────────────────────────────────────────────────────

/** A human-friendly machine name for the Computer. `os.hostname()` is
 *  unreliable on macOS — when the BSD HostName is unset (the default) it
 *  returns "localhost", not the machine's real name. So on macOS prefer the
 *  OS's friendly ComputerName ("MacBook Air"), then LocalHostName; elsewhere
 *  `os.hostname()` is fine. */
async function detectHostName(): Promise<string> {
  const base = hostname()
  if (base && base.toLowerCase() !== 'localhost') return base
  if (process.platform === 'darwin') {
    for (const key of ['ComputerName', 'LocalHostName']) {
      try {
        const { stdout } = await execFileP('scutil', ['--get', key])
        const name = stdout.trim()
        if (name) return name
      } catch { /* scutil missing / key unset — try the next */ }
    }
  }
  return base || 'My computer'
}

async function doPair(code: string, serverUrl: string, preferredEngine?: string): Promise<void> {
  const detected = await requireLocalEngine()
  // The chosen engine becomes this computer's DEFAULT — it's sent first in the
  // engines list, which the server stores as available_engines[0] and uses as
  // the engine for the starter team and any agent assigned here without an
  // explicit override. (No separate column needed: "first = default".)
  let engines = detected
  if (preferredEngine) {
    if (!ENGINE_IDS.includes(preferredEngine as EngineId)) {
      throw new Error(`--engine must be one of: ${ENGINE_IDS.join(', ')} (got "${preferredEngine}")`)
    }
    if (!detected.includes(preferredEngine as EngineId)) {
      throw new Error(`--engine ${preferredEngine} chosen, but ${preferredEngine} is not installed on this machine. Installed: ${detected.join(', ') || 'none'}.`)
    }
    engines = [preferredEngine as EngineId, ...detected.filter((e) => e !== preferredEngine)]
  }
  const snapshot = await snapshotDetectedEngines(engines)
  const paired = await api<{ computerId: string; deviceToken: string }>(
    serverUrl, '/api/computers/pair',
    { method: 'POST', body: JSON.stringify({
      code, hostName: await detectHostName(), engines, detected: snapshot,
      version: CURRENT_VERSION, supervised: SUPERVISED,
    }) },
  )
  await saveConfig({ serverUrl, computerId: paired.computerId, deviceToken: paired.deviceToken })
  console.log(`[computer] paired as ${paired.computerId} (default engine: ${engines[0] ?? 'none'}; available: ${engines.join(', ') || 'none'}) — starting…`)
}

// ─── per-agent runner ───────────────────────────────────────────────────

/** Buffered per-hop trajectory reporter. The engine sessions (ClaudeSession /
 *  CodexSession) fire `onHopUsage` for every assistant message / turn-completed
 *  event; this collects them and POSTs in batches so the universal llm_calls
 *  ledger sees BYOA trajectory at the same granularity it sees cloud, without
 *  paying a round-trip per hop.
 *
 *  Discipline:
 *    - Fire-and-forget. A network blip on the report MUST NEVER affect the
 *      engine turn that produced it.
 *    - Bounded queue (MAX_BUFFER) so a hard server outage can't blow memory on
 *      a long-running daemon — old hops are dropped first with a warn log.
 *    - Auto-flush on every WINDOW_MS tick AND when buffer hits FLUSH_AT.
 *    - flush() can be awaited at "natural pauses" (turn end) to push the tail
 *      promptly without waiting for the timer. */
type ByoaSource = `byoa-${EngineId}`

function byoaSourceOf(id: EngineId): ByoaSource {
  return `byoa-${id}`
}

interface PendingHop {
  source: ByoaSource
  purpose: 'agent-turn' | 'inbox-triage' | 'compaction' | 'completion-verify' | 'steer-summary' | 'agenda' | 'synthetic-wake-gate'
  runId: string | null
  conversationId: string | null
  model: string
  usage: TokenUsage | null
  latencyMs: number
  status: 'ok' | 'rate_limited' | 'timeout' | 'failed'
  error?: string | null
  extras?: Record<string, unknown>
}

class HopReporter {
  private buf: PendingHop[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly WINDOW_MS = 250
  private readonly FLUSH_AT = 10
  private readonly MAX_BUFFER = 500
  constructor(
    private readonly serverUrl: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  push(hop: PendingHop): void {
    if (this.stopped) return
    if (this.buf.length >= this.MAX_BUFFER) {
      // Drop the OLDEST entry — newer hops are more interesting + the bound
      // protects the process from a hung server. We log once per overflow
      // window so the log isn't a flood.
      const dropped = this.buf.shift()
      if (dropped) console.warn(`[hop-reporter] buffer overflow — dropped oldest hop (${dropped.purpose}, ${dropped.model})`)
    }
    this.buf.push(hop)
    if (this.buf.length >= this.FLUSH_AT) { void this.flush(); return }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush() }, this.WINDOW_MS)
  }

  /** Send everything queued right now. Idempotent + reentrant-safe — drains
   *  the snapshot, leaves new pushes for the next flush. Resolves after the
   *  HTTP attempt (or instantly if nothing to send). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buf.length === 0) return
    // Snapshot + clear; new pushes during the await go to a fresh buffer.
    const batch = this.buf
    this.buf = []
    // Codex + Claude batches might intermix (the same reporter is used across
    // session lifetimes), so split by source — the server endpoint takes one
    // source per call (the row's `source` column is set from it).
    const byHourceSource = new Map<ByoaSource, PendingHop[]>()
    for (const h of batch) {
      const arr = byHourceSource.get(h.source) ?? []
      arr.push(h); byHourceSource.set(h.source, arr)
    }
    let token: string
    try { token = await this.getToken() } catch { /* token unavailable — drop, daemon recovers */ return }
    await Promise.all([...byHourceSource.entries()].map(([source, hops]) =>
      // daemonVersion lets the operator correlate spend / cache patterns with
      // an agent-cli release in the Observability dashboard. One version per
      // batch — daemons never upgrade mid-batch, so every hop in this group
      // shares it on the server side.
      runtimeBest(this.serverUrl, '/llm-calls', token, { source, hops, daemonVersion: CURRENT_VERSION }),
    ))
  }

  stop(): void {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    // Final flush — best-effort, fire-and-forget.
    void this.flush()
  }
}

/** CUMORA_ENGINE_MODEL value meaning "impose no model at all — use whatever
 *  the local CLI is already configured for". */
const ENGINE_MODEL_LOCAL = 'local'

/** The model the LOCAL engine should run this agent's turns on.
 *
 *  BYOA wakes omit `--model` by default so the machine's CLI uses its own
 *  config (Claude `settings.json`, Codex `config.toml`, …). The daemon
 *  discovery list leaves `agent.model` unset; `CUMORA_ENGINE_MODEL=local`
 *  is the same no-pin path. A concrete `CUMORA_ENGINE_MODEL` still overrides.
 *
 *  Exported for tests. */
export function resolveEngineModel(
  configured: string | null | undefined,
  override: string | undefined,
): string | null {
  const o = override?.trim()
  if (!o) return configured ?? null
  return o.toLowerCase() === ENGINE_MODEL_LOCAL ? null : o
}

/** The same knob governs the small-brain pin. `local` has to impose NOTHING:
 *  otherwise ANTHROPIC_SMALL_FAST_MODEL would still name a model the custom
 *  provider lacks, and the CLI's own quick calls would fail instead of the turn.
 *  A concrete override only replaces the big-brain pin, so fast_model is left
 *  alone there. */
export function resolveEngineFastModel(
  configured: string | null | undefined,
  override: string | undefined,
): string | null {
  return override?.trim().toLowerCase() === ENGINE_MODEL_LOCAL ? null : (configured ?? null)
}

class AgentRunner {
  /** Aborted once in stop(). Handed to every one-shot `adapter.run(...)` so the
   *  engine child dies with its runner, the way the persistent session already
   *  does. Without it those children were orphaned: they keep a valid runtime
   *  token and the `cumora` shim on PATH, so they go on posting AS the agent
   *  while the replacement runner independently answers the same messages. */
  private readonly teardown = new AbortController()
  private token = ''
  private tokenExpiresAt = 0
  private home: string
  private binDir: string
  private sessionFile: string
  private busy = false
  private pendingRerun = false
  // Triage-trouble backoff: when the small-brain triage is rate-limited OR
  // fails (fail-open), we skip whole turns until this time, doubling each
  // consecutive hit — so a broken/throttled triage can't be hammered every poll
  // and (critically) can never escalate to the expensive big brain.
  private triageBackoffUntil = 0
  private triageTroubleStreak = 0
  // Big-brain rate-limit cooldown: when the LAST attempt got
  // "Server is temporarily limiting requests" from the provider, do not
  // attempt another big-brain call from THIS agent until the cooldown
  // expires. Without this, we'd re-attempt on every poll + SSE wake (each
  // burning a real call against the same throttle that just rejected us)
  // and the loop is visible to the user as 100+ rate-limit log lines and
  // 30-65s end-to-end latency per turn. Set to now + ENGINE_BACKOFF_*
  // when isRateLimited(engineError); cleared by the next successful spawn.
  private engineBackoffUntil = 0
  private stopped = false
  private lastWakeConvo: string | null = null
  /** Pre-turn debounce timer (see WAKE_DEBOUNCE_MS). Non-null = a turn is already
   *  scheduled to start shortly; further wakes fold into it instead of stacking. */
  private wakeDebounceTimer: ReturnType<typeof setTimeout> | null = null
  /** The engine session id to `--resume` next wake, so the agent keeps
   *  continuous context (its place in a running task) instead of waking cold
   *  on a frozen inbox snapshot. Captured from each run's stream-json output;
   *  cleared if a resume fails so the next wake starts a clean session. */
  private sessionId: string | null = null
  /** The long-lived engine process (persistent stream-json for claude, app-server
   *  thread for codex), created lazily and reused across wakes so turns 2..N skip
   *  the cold start. Null = not yet started, dead (respawn next turn), or this
   *  engine/config has no persistent mode (a custom args override). */
  private engineSession: EngineSession | null = null
  /** When the last engine turn (chat OR agenda) finished — the "quiet" anchor for
   *  agenda wakes, and the throttle for how often we check the board. */
  private lastTurnEndedAt = 0
  private lastAgendaCheckAt = 0
  /** Same-turn steering state: a guard against concurrent steer checks, and the
   *  last direct-message id we steered (so repeated wakes for it don't re-inject). */
  private sideSteering = false
  private lastSteeredMsgId: string | null = null
  /** Content-free group-notice state (opt-in, see STEER_GROUP_IN_TURN): the last
   *  group msg id we nudged about + when, so a fast room can't re-inject on every
   *  message (throttled by GROUP_STEER_MIN_INTERVAL_MS). */
  private lastGroupSteeredMsgId: string | null = null
  private lastGroupSteerAt = 0
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private readonly adapter
  /** Buffered ledger reporter — collects per-hop usage from the engine and
   *  POSTs to /runtime/llm-calls so the universal llm_calls ledger sees BYOA
   *  trajectory. Created lazily on first use. */
  private hopReporter: HopReporter | null = null
  /** runId of the run row currently in flight (chat or agenda). Hops emitted
   *  during this turn carry it so the ledger can link them back to the run.
   *  Cleared at turn end. */
  private currentRunId: string | null = null

  constructor(
    private readonly cfg: DaemonConfig,
    private readonly agent: AgentInfo,
    engine: EngineId,
  ) {
    this.home = join(AGENTS_ROOT, agent.id)
    this.binDir = join(this.home, 'bin')
    this.sessionFile = join(SESSIONS_DIR, `${agent.id}.session`)
    this.adapter = getAdapter(engine)
  }

  private get reporter(): HopReporter {
    if (!this.hopReporter) {
      this.hopReporter = new HopReporter(this.cfg.serverUrl, async () => this.ensureToken())
    }
    return this.hopReporter
  }

  /** Map every adapter's raw EngineUsage → universal TokenUsage. Adapters
   *  normalize their native counters into this Claude-shaped interface, so a
   *  single ledger path covers every BYOA engine. */
  private hopUsageOf(u: EngineUsage): TokenUsage {
    return usageFromClaude(u as unknown as Record<string, unknown>)
  }

  /** Called by engine sessions/stream trackers for every provider hop. Pushes
   *  one PendingHop into the batched
   *  reporter; never throws. The engine's optional enrichment hints
   *  (hopIndex/toolUses/textChars) ride along in `extras` — these are exactly
   *  the columns the operator needs to ANSWER "why was this hop expensive?"
   *  without having to pull the prompt body back. */
  private onEngineHop(report: EngineHopReport, purpose: PendingHop['purpose']): void {
    try {
      const extras: Record<string, unknown> = {}
      if (typeof report.hopIndex === 'number') extras.hopIndex = report.hopIndex
      if (typeof report.toolUses === 'number') extras.toolUses = report.toolUses
      if (typeof report.textChars === 'number') extras.textChars = report.textChars
      this.reporter.push({
        source: byoaSourceOf(this.adapter.id),
        purpose,
        runId: this.currentRunId,
        conversationId: this.lastWakeConvo,
        model: report.model,
        usage: this.hopUsageOf(report.usage),
        latencyMs: report.latencyMs ?? 0,
        status: 'ok',
        extras: Object.keys(extras).length ? extras : undefined,
      })
    } catch (err) {
      console.warn(`[computer] ${this.agent.id} hop report dropped:`, err instanceof Error ? err.message : err)
    }
  }

  /** Is a turn currently in flight? (Used by the supervisor loop to avoid
   *  restarting/auto-updating mid-turn.) */
  get isBusy(): boolean { return this.busy }

  /** Update the engine session id AND persist it to disk, so a daemon restart can
   *  `--resume` the same session and recover the interrupted turn's context. */
  private setSessionId(id: string | null): void {
    if (id === this.sessionId) return
    this.sessionId = id
    void this.persistSessionId()
  }

  /** True when an engine error means the session is unusable and the NEXT wake
   *  must start FRESH (no --resume). Two cases:
   *   1. CONTEXT-WINDOW OVERFLOW — the persistent/resumed session has grown past
   *      the model's window. Carrying it forward (--resume) just re-overflows on
   *      every wake, so the agent stays wedged ("wake again" never helps) until
   *      we drop it. This is hadResume-independent: even a single resumed session
   *      that's now too big must be abandoned.
   *   2. STALE / MISSING resume target — we tried to --resume a session the
   *      engine no longer has. Only meaningful when we actually passed one, and
   *      only when the engine SAYS SO: a mid-turn crash (OOM, sleep, provider
   *      hangup) leaves a resumable session, so it must NOT reset — that would
   *      discard the context the interrupted turn was building. */
  private mustResetSession(err: string, hadResume: boolean): boolean {
    if (this.isContextOverflow(err)) return true
    if (this.isPoisonedTranscript(err)) return true
    if (hadResume && isStaleResumeError(err)) return true
    return false
  }

  private isContextOverflow(err: string): boolean {
    return CONTEXT_OVERFLOW_RE.test(err)
  }

  private isPoisonedTranscript(err: string): boolean {
    return POISONED_BODY_RE.test(err)
  }

  /** Human-readable reason for a forced session reset (just for the log). */
  private resetReason(err: string): string {
    if (this.isContextOverflow(err)) return 'engine hit its context-window limit'
    if (this.isPoisonedTranscript(err)) return 'transcript poisoned by a malformed character (split emoji / lone surrogate)'
    return 'engine session problem'
  }

  /** Drop the session id AND tear down any persistent engine process so the next
   *  wake spawns a genuinely clean session (no --resume of the bad context). */
  private resetEngineSession(reason: string): void {
    console.warn(`[computer] ${this.agent.id} ${reason} — starting a FRESH engine session next wake`)
    this.setSessionId(null)
    this.engineSession?.stop()
    this.engineSession = null
  }

  private async persistSessionId(): Promise<void> {
    try {
      if (this.sessionId) {
        await mkdir(SESSIONS_DIR, { recursive: true })
        await writeFile(this.sessionFile, this.sessionId, 'utf8')
      } else {
        await rm(this.sessionFile, { force: true })
      }
    } catch { /* best-effort — a lost session id just means a cold next wake */ }
  }

  private async loadSessionId(): Promise<void> {
    try {
      const s = (await readFile(this.sessionFile, 'utf8')).trim()
      if (s) {
        this.sessionId = s
        console.log(`[computer] ${this.agent.id} restored engine session ${s.slice(0, 8)} from disk — will --resume (continuity across restart)`)
      }
    } catch { /* no prior session on disk — start cold */ }
  }

  async start(): Promise<void> {
    await this.adapter.seedHome(this.home, { id: this.agent.id, name: this.agent.name, role: this.agent.role, systemPrompt: this.agent.systemPrompt })
    await writeShim(this.binDir)
    await this.loadSessionId()
    void this.streamLoop()
    // SSE-independent safety net (see INBOX_POLL_MS): drain the inbox on a slow
    // tick so a wake lost to a half-dead stream is still picked up within the
    // interval. Skip while busy so it never piles on the live turn.
    this.pollTimer = setInterval(() => { if (!this.busy && !this.stopped) this.scheduleWake('poll') }, INBOX_POLL_MS)
  }

  /** Phase 1 of shutdown: stop accepting NEW wakes/turns, but leave any in-flight
   *  turn (and its engine child) running so a brief drain can let it finish. */
  beginStop(): void {
    this.stopped = true
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined }
    if (this.wakeDebounceTimer) { clearTimeout(this.wakeDebounceTimer); this.wakeDebounceTimer = null }
  }

  stop(): void {
    this.beginStop()
    this.engineSession?.stop()
    this.engineSession = null
    // Kill a one-shot engine child too. sync() tears a runner down on any
    // config change (engine/model/persona) or unassign while the daemon keeps
    // running, which is exactly where an orphan does damage: it would still be
    // acting with the OLD persona the operator just replaced.
    this.teardown.abort()
    // Drain any hops queued at shutdown so the ledger doesn't lose the tail
    // (e.g. the agent was mid-turn when the daemon restarts for an update).
    this.hopReporter?.stop()
    this.hopReporter = null
  }

  /** Does this runner's live config still match the latest server state? The
   *  engine + model + persona are captured at construction (the adapter is
   *  fixed, and seedHome runs once in start()), so when any of them changes in
   *  Cumora, sync() must tear this runner down and build a fresh one — otherwise
   *  e.g. a Claude→Codex switch wouldn't take effect until a daemon restart. */
  configMatches(agent: AgentInfo, engine: EngineId): boolean {
    return this.adapter.id === engine
      && this.agent.name === agent.name
      && this.agent.role === agent.role
      && this.agent.systemPrompt === agent.systemPrompt
      && this.agent.model === agent.model
      && this.agent.fastModel === agent.fastModel
  }

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) return this.token
    const minted = await api<{ token: string; expiresInSeconds: number }>(
      this.cfg.serverUrl, `/api/agents/${this.agent.id}/runtime-token`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.deviceToken}` }, body: '{}' },
    )
    this.token = minted.token
    this.tokenExpiresAt = Date.now() + minted.expiresInSeconds * 1000
    // Persist to the file the cumora shim reads, so a long-lived (persistent) engine
    // process always picks up the REFRESHED token rather than its stale spawn-time env.
    try { await writeFile(join(this.binDir, '.runtime-token'), this.token, { mode: 0o600 }) } catch { /* shim falls back to the env token */ }
    return this.token
  }

  /** Env handed to the engine subprocess: the `cumora` shim on PATH, wired to
   *  this agent's runtime URL + token. */
  /** Big-brain model for the local engine, after the CUMORA_ENGINE_MODEL escape. */
  private engineModel(): string | null {
    return resolveEngineModel(this.agent.model, process.env.CUMORA_ENGINE_MODEL)
  }

  /** Small/fast-brain model for the local engine, after the same escape. */
  private engineFastModel(): string | null {
    return resolveEngineFastModel(this.agent.fastModel, process.env.CUMORA_ENGINE_MODEL)
  }

  private engineEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      PATH: prependAgentBinToPath(this.binDir),
      CUMORA_AGENT_RUNTIME_URL: `${this.cfg.serverUrl}/runtime`,
      CUMORA_AGENT_RUNTIME_TOKEN: this.token,
      // A long-lived engine reads the FRESH token from this file (the env token
      // above goes stale on refresh); the shim prefers the file, falls back to env.
      CUMORA_AGENT_RUNTIME_TOKEN_FILE: join(this.binDir, '.runtime-token'),
      CUMORA_AGENT_ID: this.agent.id,
    }
  }

  /** The long-lived engine process for this agent (persistent stream-json),
   *  created lazily and reused across wakes so turns 2..N skip the cold start.
   *  Returns null if the engine has no persistent mode (Cursor/OpenCode, Codex
   *  fallback, or custom args) — the caller then uses one-shot run(). If the
   *  prior process has died it respawns, resuming this.sessionId so context
   *  carries across the restart. */
  private ensureEngineSession(): EngineSession | null {
    if (!this.adapter.startSession) return null
    if (this.engineSession?.alive) return this.engineSession
    this.engineSession = this.adapter.startSession({
      home: this.home,
      env: this.engineEnv(),
      model: this.engineModel(),
      fastModel: this.engineFastModel(),
      resumeSessionId: this.sessionId,
      standingPrompt: this.standingPrompt(),
      onLog: (line) => this.logEngineLine(line),
      // Trajectory hook — every assistant hop (Claude) / turn-completed (Codex)
      // shows up here and gets batched to the universal ledger. Purpose is
      // 'agent-turn' for ALL session-issued hops; triage / agenda / etc. ride
      // their own purpose-tagged paths (see recordTriageUsage etc.).
      onHopUsage: (r) => this.onEngineHop(r, 'agent-turn'),
    })
    if (this.engineSession) {
      console.log(`[computer] ${this.agent.id} engine session ${this.sessionId ? `respawned (resume ${this.sessionId.slice(0, 8)})` : 'spawned fresh'} — persistent, no per-wake cold start`)
    }
    return this.engineSession
  }

  private visibleEngineError(exitCode: number, detail?: string): string {
    const raw = conciseError(detail || `process exited with code ${exitCode}`)
    const redacted = raw
      .split(this.home).join('<agent home>')
      .split(homedir()).join('~')
    return `local ${this.adapter.id} failed (exit ${exitCode}): ${redacted}`
  }

  /** Keep a long engine turn alive: bump the run's updated_at every RUN_HEARTBEAT_MS
   *  so the server's 10-min stale-run sweeper doesn't reap a legitimately long turn
   *  as "orphaned". Fires once immediately, then on an interval. Returns a stop fn
   *  for the turn's finally block. No-op (and no timer) when there's no run id. */
  private beatRun(token: string, runId: string | undefined): () => void {
    if (!runId) return () => { /* nothing to heartbeat */ }
    const beat = (): void => { void runtimeBest(this.cfg.serverUrl, `/runs/${runId}/heartbeat`, token, {}) }
    beat()
    const timer = setInterval(beat, RUN_HEARTBEAT_MS)
    return () => clearInterval(timer)
  }

  private async publishEngineFailure(args: {
    token: string
    runId?: string
    conversationId: string | null
    error: string
    exitCode: number
  }): Promise<void> {
    if (args.runId) {
      await runtimeBest(this.cfg.serverUrl, '/events', args.token, {
        runId: args.runId,
        kind: 'engine.failed',
        level: 'error',
        title: `${this.adapter.id} exited ${args.exitCode}`,
        data: { error: args.error },
        stage: 'failed',
      })
    }
    const hint = authFailureHint(this.adapter.id, args.error)
    const conversationIds = await this.failureConversationIds(args.token, args.conversationId)
    await Promise.all(conversationIds.map((conversationId) => runtimeBest(this.cfg.serverUrl, '/notices', args.token, {
      conversationId,
      agentId: this.agent.id,
      noticeKind: 'byoa_engine_failed',
      text: `${this.agent.name} could not run on local ${this.adapter.id}: ${args.error}\n${hint}`,
      dedupeKey: `byoa_engine_failed:${this.agent.id}:${conversationId}:${hashText(args.error)}`,
      dedupeTtlSec: 900,
    })))
  }

  private async failureConversationIds(token: string, conversationId: string | null): Promise<string[]> {
    if (conversationId) return [conversationId]
    // PROBE: we're only looking up convo ids to notify of an engine failure —
    // we don't show these messages to the agent. Use ?probe=1 so the server
    // does NOT advance the freshness-preflight baseline for this read.
    const inbox = await runtimeGet<RuntimeInboxResponse>(this.cfg.serverUrl, '/inbox?probe=1', token)
    const ids = new Set<string>()
    for (const row of inbox?.rows ?? []) {
      if (typeof row.conversation_id === 'string' && row.conversation_id) ids.add(row.conversation_id)
      if (ids.size >= 5) break
    }
    return [...ids]
  }

  /** Preload global + current-project memory indexes. Existing
   *  `memory/MEMORY.md` stays GLOBAL; project work lives under
   *  `memory/projects/<id>/MEMORY.md`. A no-project wake injects global
   *  only — same contract as cloud `loadMemory`. */
  private async memoryDigest(projectIds: readonly string[] = []): Promise<string> {
    const parts: Array<{ label: string; body: string }> = []
    for (const rel of memoryIndexPathsForScope(projectIds)) {
      try {
        const txt = (await readFile(join(this.home, rel), 'utf8')).trim()
        if (txt) parts.push({ label: rel, body: txt })
      } catch { /* missing index is fine */ }
    }
    return composeMemoryDigest(parts)
  }

  /** Triage the inbox on the LOCAL small brain. The whole point of BYOA is that
   *  judgment runs on the operator's OWN machine — so the cerebellum is the
   *  engine's cheap fast model (Claude Haiku), NOT a cloud call. The server only
   *  builds the prompt (it has the DB for inbox+context); inference is 100%
   *  local: no network model hop, no sub2api quota (429/503), no big brain. */
  private async inboxTriage(token: string): Promise<RuntimeInboxTriageResponse | null> {
    const payload = await runtimeGet<RuntimeTriagePayload>(this.cfg.serverUrl, '/inbox-triage/payload', token)
    if (!payload) return null
    if (payload.verdict) return payload.verdict // hard rule / empty inbox — no model needed
    if (!payload.instructions || !payload.input) return null

    // Triage concurrency gate + deterministic spawn pacer. Pacer is shared
    // with the big-brain path (same Anthropic/OpenAI account quota, same
    // local CLI process pool) — every spawn waits its turn so the provider
    // never sees a burst of N simultaneous starts. See SpawnPacer doc.
    await triageSem.acquire()
    await spawnPacer.gate()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TRIAGE_TIMEOUT_MS)
    let res: { text: string; error?: string; usage?: EngineUsage; model?: string | null }
    try {
      await mkdir(TRIAGE_DIR, { recursive: true })
      res = await this.adapter.classify({
        cwd: TRIAGE_DIR,
        prompt: `${payload.instructions}\n\n${payload.input}`,
        env: this.engineEnv(),
        // Engine picks its own cheap default; CUMORA_TRIAGE_MODEL overrides it.
        model: process.env.CUMORA_TRIAGE_MODEL,
        signal: controller.signal,
      })
    } catch (err) {
      res = { text: '', error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
      triageSem.release()
    }

    if (res.error || !res.text.trim()) {
      const errText = res.error ?? 'no output'
      // CRITICAL: a rate-limited small model must NOT fail-open. Fail-open wakes
      // the expensive big brain to "decide" — which on a 429/quota/overload just
      // burns more of the user's quota and trips the big brain's own limit too
      // (the runaway that drained accounts). Fail CLOSED: skip, don't wake the
      // engine, don't ack — the caller backs off and retries when the limit lifts.
      // A TIMEOUT counts too: a triage that runs past the ceiling is almost always
      // the engine retrying a throttled provider, so treat it as a back-off signal
      // rather than fail-open into the big brain.
      if (controller.signal.aborted || isRateLimited(errText)) {
        console.warn(`[computer] ${this.agent.id} local triage RATE-LIMITED${controller.signal.aborted ? ' (timed out)' : ''} — backing off, NOT waking the big brain: ${errText.slice(0, 160)}`)
        return {
          actionable: false,
          reason: `triage rate-limited (${errText.slice(0, 120)}); backing off`,
          promptNote: '',
          source: 'rate-limited',
        }
      }
      if (payload.failClosed) {
        // Purely agent-to-agent wake: a flaky local model must NOT fail open, or
        // every triage error wakes the big brain and amplifies the very loop the
        // gate exists to stop. A missed agent↔agent reply is cheap and self-heals
        // on the next real event.
        console.warn(`[computer] ${this.agent.id} local triage failed: ${errText.slice(0, 200)} — fail CLOSED (agent-only, no human waiting)`)
        return {
          actionable: false,
          reason: `local triage failed (${errText.slice(0, 120)}); fail closed (agent-only)`,
          promptNote: '',
          source: 'fail-closed',
        }
      }
      console.warn(`[computer] ${this.agent.id} local triage failed: ${errText.slice(0, 200)} — fail open`)
      return {
        actionable: true,
        reason: `local triage failed (${errText.slice(0, 120)}); fail open`,
        promptNote:
          'Local small-brain triage failed; read the inbox/context yourself and respond only if a human needs you. ' +
          'Do not silently ack unread human messages unless the thread clearly shows they are irrelevant or already handled.',
        source: 'fail-open',
      }
    }
    const parsed = parseTriage(res.text)
    // A valid "don't reply" verdict (actionable:false) legitimately has no
    // promptNote — accept it so the gate actually gates. Only a verdict we
    // couldn't even recover `actionable` from (parsed === null) fails open.
    if (parsed) {
      const verdict = finalizeTriage(parsed, 'support-model-local')
      // Record the gate's cache-aware cost (fire-and-forget). A BYOA triage runs
      // LOCAL + cold-session — its input is uncached, the cost this ledger exists
      // to weigh. usage is present for Claude, Cursor, and OpenCode; absent for
      // the current Codex/Grok one-shot classifiers.
      void this.recordTriageUsage(token, verdict.actionable, verdict.reason, res.usage, res.model)
      return verdict
    }
    if (payload.failClosed) {
      console.warn(`[computer] ${this.agent.id} local triage unparseable: ${res.text.slice(0, 200)} — fail CLOSED (agent-only, no human waiting)`)
      return {
        actionable: false,
        reason: 'local triage produced no usable verdict; fail closed (agent-only)',
        promptNote: '',
        source: 'fail-closed',
      }
    }
    console.warn(`[computer] ${this.agent.id} local triage unparseable: ${res.text.slice(0, 200)} — fail open`)
    return {
      actionable: true,
      reason: 'local triage produced no usable verdict; fail open',
      promptNote: 'Local small-brain triage gave no clear verdict; read the inbox/context yourself and respond only if a human needs you.',
      source: 'fail-open',
    }
  }

  /** Triage model id for pricing, honoring CUMORA_TRIAGE_MODEL. Cursor,
   *  OpenCode and pi have no universal cheap alias, so a reported/pinned stream
   *  model wins and the agent model is only a fallback. */
  private triageModel(): string {
    if (process.env.CUMORA_TRIAGE_MODEL) return process.env.CUMORA_TRIAGE_MODEL
    if (this.adapter.id === 'claude') return 'haiku'
    if (this.adapter.id === 'grok') return 'grok-4.5'
    if (this.adapter.id === 'codex') return 'gpt-5.4-mini'
    if (this.adapter.id === 'opencode') return this.agent.model ?? '<opencode-default>'
    if (this.adapter.id === 'pi') return this.agent.model ?? '<pi-default>'
    return this.agent.model ?? '<cursor-default>'
  }

  /** Post one local-triage record to the cost ledger. Best-effort. */
  private async recordTriageUsage(token: string, actionable: boolean, reason: string, usage?: EngineUsage, model?: string | null): Promise<void> {
    await runtimeBest(this.cfg.serverUrl, '/triage', token, {
      source: `byoa-${this.adapter.id}`,
      model: model || this.triageModel(),
      actionable,
      reason,
      usage: usage ? usageFromClaude(usage) : null,
      // Mirror the hop reporter — every BYOA-emitted row in llm_calls carries
      // the daemon version that produced it.
      daemonVersion: CURRENT_VERSION,
    })
  }

  /** Snapshot the unread inbox: the {conversationId → latest unread message id}
   *  cursor map (for `ackSeen`), AND a human-readable digest of the unread
   *  messages to PRE-LOAD into the wake prompt. Pre-loading is what the cloud
   *  agent already does (it builds the turn input from the inbox), so the BYOA
   *  engine can read the room and reply WITHOUT first spending `cumora inbox` +
   *  `cumora messages` round-trips — each of those is an extra opus hop, and
   *  cutting them is most of the per-turn latency.
   *  Captured BEFORE the engine runs so `ackSeen` advances exactly what THIS
   *  turn saw; messages that land mid-turn keep a higher id, stay unread, and
   *  drive the coalesced rerun. */
  /** Parse a system row's wire payload as a due calendar alarm (the JSON the
   *  server's calendar dispatcher writes). Wire-format read, not content
   *  classification. Null = not a calendar dispatch. */
  private parseAlarmPayload(raw: string): { assigneeId?: string; title?: string; agentPrompt?: string } | null {
    try {
      const p = JSON.parse(raw) as { kind?: unknown; assigneeId?: unknown; title?: unknown; agentPrompt?: unknown }
      if (p?.kind !== 'calendar_event') return null
      return {
        assigneeId: typeof p.assigneeId === 'string' ? p.assigneeId : undefined,
        title: typeof p.title === 'string' ? p.title : undefined,
        agentPrompt: typeof p.agentPrompt === 'string' ? p.agentPrompt : undefined,
      }
    } catch { return null }
  }

  private async snapshotUnread(token: string): Promise<{ seen: Map<string, string>; digest: string; hasReal: boolean; projectIds: string[] }> {
    const inbox = await runtimeGet<RuntimeInboxResponse>(this.cfg.serverUrl, '/inbox', token)
    const seen = new Map<string, string>()
    // Unread grouped BY CONVERSATION (first-seen order), each with the header
    // (title + topic) the cloud agent's context also carries — so a BYOA agent
    // always sees what the group is FOR (its topic), not just the messages.
    // Grouped rather than one flat line list because the digest has a LINE
    // BUDGET, and spending it per conversation is what stops a busy room from
    // evicting — and `ackSeen` then burying — a quiet one. See renderInboxDigest.
    const byConvo = new Map<string, { head: string; msgs: string[] }>()
    // `hasReal` = is ANY unread a genuine human/agent message (not a system
    // relay/status/membership notice)? The cost gate in runTurn uses this to
    // refuse to spend ANY model on a system-only (or empty) inbox.
    let hasReal = false
    // rows are ordered created_at ASC, so the last row per conversation is its
    // newest unread message — exactly the cursor we want to advance to.
    for (const row of inbox?.rows ?? []) {
      if (typeof row.conversation_id !== 'string' || !row.conversation_id) continue
      if (typeof row.id === 'string' && row.id) seen.set(row.conversation_id, row.id)
      // A due CALENDAR dispatch is a SELF-SCHEDULED ALARM, not system noise —
      // it must count as real or a BYOA agent's own alarm can never wake its
      // engine (the cloud path special-cases these system rows the same way).
      const alarm = row.kind === 'system' && typeof row.body === 'string' ? this.parseAlarmPayload(row.body) : null
      if (row.kind !== 'system' || (alarm && (!alarm.assigneeId || alarm.assigneeId === this.agent.id))) hasReal = true
      let convo = byConvo.get(row.conversation_id)
      if (!convo) {
        const head = conversationHeader({
          conversation_id: row.conversation_id,
          conversation_kind: row.conversation_kind,
          conversation_title: row.conversation_title,
          conversation_topic: row.conversation_topic,
          project_name: row.project_name,
        })
        convo = { head, msgs: [] }
        byConvo.set(row.conversation_id, convo)
      }
      const author = row.author_name ?? 'someone'
      const who = row.author_kind ? `${author} (${row.author_kind})` : author
      // Render a due calendar alarm readably (title — prompt) so the engine
      // knows WHY it woke; other system rows stay redacted as before.
      const body = (row.kind === 'system'
        ? (alarm ? `[calendar:due] ${[alarm.title, alarm.agentPrompt].filter(Boolean).join(' — ') || 'scheduled alarm fired'}` : '[system]')
        : (row.body ?? '')).replace(/\s+/g, ' ').slice(0, 600)
      // Keep the message id + convo id on each line (like the cloud agent's
      // context) so the engine can QUOTE the exact message: `cumora reply
      // <convo> '<body>' --quote <message_id>`.
      convo.msgs.push(`  [${row.id}] ${row.conversation_id}  ${who}: ${body}`)
    }
    const projectIds = uniqueProjectIds(
      (inbox?.rows ?? []).map((r) => (typeof r.project_id === 'string' ? r.project_id : null)),
    )
    return { seen, digest: renderInboxDigest(byConvo), hasReal, projectIds }
  }

  /** Advance this agent's read cursor over the conversations it just saw, so a
   *  wake that ends WITHOUT a reply (small-brain said "skip", or the engine
   *  read the room and chose silence) does not re-trigger on the same messages
   *  every INBOX_POLL_MS. markConversationRead is monotonic, so this never
   *  regresses a cursor the engine already advanced further via `cumora reply`. */
  private async ackSeen(token: string, seen: Map<string, string>): Promise<void> {
    if (seen.size === 0) return
    await Promise.all([...seen].map(([conversationId, upToMessageId]) =>
      runtimeBest(this.cfg.serverUrl, '/conversation/mark-read', token, { conversationId, upToMessageId }),
    ))
  }

  /** Log an engine stream-json line, dropping the high-volume noise that
   *  floods the console without telling us anything: per-spawn SessionStart
   *  hook chatter (started/response × N hooks) and rate-limit keepalives. We
   *  keep the signal — assistant text, tool calls/results, init, errors. */
  private logEngineLine(line: string): void {
    if (line.includes('"hook_started"') || line.includes('"hook_response"') || line.includes('"rate_limit_event"')) return
    console.log(`[${this.agent.id}/${this.adapter.id}] ${line.slice(0, 500)}`)
  }

  private formatTriageNote(triage: RuntimeInboxTriageResponse | null): string {
    if (!triage) return ''
    const note = typeof triage?.promptNote === 'string' ? triage.promptNote.trim() : ''
    if (!note) return ''
    const state = triage.actionable === false ? 'not relevant' : 'relevant'
    const source = typeof triage.source === 'string' ? triage.source : 'server'
    const reason = typeof triage.reason === 'string' && triage.reason.trim()
      ? `\nReason: ${triage.reason.trim().slice(0, 500)}`
      : ''
    return `Small-brain inbox triage (${state}, ${source}): ${note}${reason}`
  }

  /** The INVARIANT operational scaffold — identical every turn. It goes into the
   *  engine's system prompt ONCE per session (Claude: `--append-system-prompt-file`)
   *  instead of being re-sent in every turn's message. THAT is what keeps the
   *  transcript small enough that the engine's NATIVE auto-compaction keeps up.
   *  Engines without a system-prompt file get this
   *  inlined into each turn instead (see the turn paths). Covers BOTH chat and
   *  agenda turns; the per-turn deltas (chatDelta / agendaDelta) carry only the
   *  dynamic bits. No game-specific rules — the engine coordinates in-turn via the
   *  shared glance-yield protocol, exactly like the cloud pod-agent. */
  private standingPrompt(): string {
    // RESTORED to the 5/28T22:17Z baseline SHAPE: one minimal prompt of essential
    // mechanics, with GLANCE_YIELD_RULES and a few core sections — NOT a wall of
    // ── XXX ── sections (that's the bloat the user called out: AGENT_VOICE_RULES
    // priming, MORE CUMORA COMMANDS, HELD REPLY explainer, CONTEXT COMPACTION,
    // WORKING A BOARD CARD — none of those existed at 5/28 when coord was perfect,
    // ergo none of them are required for coord). The agent discovers other CLI
    // surface via `cumora <cmd> --help` when it needs it.
    return (
      `You are a Cumora teammate — a first-class member of this team with your own voice. ` +
      `You act on Cumora through the \`cumora\` CLI on your PATH.\n\n` +
      `Read the relevant thread and respond appropriately, in your own voice — like a real teammate. ` +
      `If a human addressed the whole team, you and every peer likely woke at the same instant, so ` +
      `coordinate via the protocol below — in short: post the real next item from what's ACTUALLY been posted, ` +
      `optimistically; the server HOLDs you and shows the newer messages if a peer moved the room while you composed.\n` +
      // The shared glance-and-yield protocol — verbatim via the const so BYOA
      // coordinates identically to the cloud pod-agent.
      GLANCE_YIELD_RULES + `\n\n` +
      `Posting a message: For ANY message with backticks, code, $, quotes, or multiple lines, ` +
      `write it to a file (e.g. \`notes/reply.md\`) and post with \`cumora reply <conversationId> --file notes/reply.md\` — ` +
      `the shell mangles inline \`backtick\` / \`$(...)\` content. For short plain text, ` +
      `\`cumora reply <conversationId> 'text'\` (SINGLE quotes) is fine. When you're answering a ` +
      `SPECIFIC message, add \`--quote <message_id>\` so your reply threads to its context. ` +
      `To address a teammate, @<their-id> (the short id in \`cumora messages\` / \`cumora participants\`), ` +
      `NOT their display name.\n\n` +
      // Skype emoticons — shared with the cloud agent so a BYOA agent is as
      // expressive, not stuck on native emoji only.
      `${SKYPE_EMOTICONS_GUIDE}\n\n` +
      `Memory: durable store under \`memory/\` (global identity, indexed by \`memory/MEMORY.md\`) ` +
      `and \`memory/projects/<projectId>/\` for unpinned work facts of the current project. ` +
      `This wake injects only global + this project's index — other projects are out of scope. ` +
      `Write project decisions/materials under \`memory/projects/<id>/\` (and a pointer in that folder's MEMORY.md); ` +
      `write identity-level facts under \`memory/\`. Pinning a memory makes it global. ` +
      `Saying "got it" does NOT persist. Chat history can be wiped by compaction; memory files remain.\n\n` +
      `Drive what you own forward — see a task through. Multi-step turns are fine; you do NOT have to ` +
      `fragment. If someone DMs you mid-task, answer briefly then keep going. The only thing to avoid ` +
      `is a pointless loop. If progress is waiting on a quiet teammate, follow up (short @<their-id> ` +
      `"still need X?") and schedule your own check-back: ` +
      `\`cumora calendar create '<chase>' --at <iso> --assignee ${this.agent.id} --prompt '<what future-you does>'\`. ` +
      `Stop only when the work is truly done or it's someone else's move.\n\n` +
      `Privacy: stay inside your home directory. Never read or expose files outside it — this machine ` +
      `holds the operator's private files.`
    )
  }

  /** Per-turn CHAT delta — only the dynamic bits (the invariant HOW lives in the
   *  standing prompt). Kept small so the persistent session's transcript grows
   *  slowly and native compaction can keep up. */
  private chatDelta(memoryDigest: string, triageNote: string, inboxDigest: string, roster?: string): string {
    return (
      `You've been woken because there's new activity in your Cumora conversations, and the cerebellum triage already ` +
      `decided you should respond — your job is to DO it (write the reply / take the action), not to re-judge whether to. ` +
      `Follow your standing instructions for HOW.\n\n` +
      // A CLOCK. Without it the model has no idea what time it is (session
      // context only carries stale timestamps), so any time arithmetic —
      // most visibly `cumora calendar create --at` deadlines — silently
      // lands in the past: a werewolf judge scheduled every phase alarm ~20
      // minutes before "now" and they all fired instantly. One line, per
      // turn, always current.
      `Current time (UTC): ${new Date().toISOString()} — use this for any --at / deadline math.\n\n` +
      (triageNote ? `${triageNote}\n\n` : ``) +
      (inboxDigest
        // Pre-loaded unread (fetched for you) — mirrors how the cloud agent gets
        // its inbox in the turn input, cutting the inbox/messages hops.
        ? `Your unread messages (ALREADY FETCHED — no need to re-run \`cumora inbox\` / \`cumora messages\` to re-read ` +
          `these; but DO \`cumora glance\` before posting in a group, to catch anything posted while you compose):\n${inboxDigest}\n\n`
        : `Run \`cumora inbox\`, then \`cumora messages <conversationId> --tail 30\`, to catch up.\n\n`) +
      (memoryDigest ? `Your memory index (global \`memory/MEMORY.md\` + current project, if any):\n${memoryDigest}\n\n` : ``) +
      (roster ? `Your team right now (trust over memory — current roster; use these ids for @mentions and \`cumora dm\`):\n${roster}\n` : ``)
    ).trimEnd()
  }

  /** Per-turn AGENDA delta — dynamic bits for a proactive board-work wake; the
   *  invariant mechanics live in the standing prompt. */
  private agendaDelta(brief: string, memoryDigest: string, roster?: string): string {
    return (
      `Current time (UTC): ${new Date().toISOString()} — use this for any --at / deadline math.\n\n` +
      `You've been woken by your OWN AGENDA — Kanban cards assigned to you (or @-mentioning you), calendar slots due now, ` +
      `AND any conversation you're in that went quiet mid-flow and needs follow-up. The system already triaged that there's ` +
      `real work to progress, so ACT: pick the most timely item and move it forward; don't deliberate whether to. For a quiet ` +
      `conversation, FIRST decide if it's genuinely waiting or already CONCLUDED (wrap-ups / closing remarks / a result reached ` +
      `/ nothing pending) — if concluded, do NOT post; reviving a finished thread late is noise. Only when someone is plainly ` +
      `waiting: read the room, then send AT MOST ONE message (answer if it needs your answer; a single brief nudge otherwise) — ` +
      `never nag, never revive a finished thread. Coordinate before you commit (claim before shared work, trust card status); ` +
      `follow your standing instructions for mechanics.\n\n` +
      `${brief}\n\n` +
      (memoryDigest ? `Your memory index (global \`memory/MEMORY.md\` + current project, if any):\n${memoryDigest}\n\n` : ``) +
      (roster ? `Your team (use these ids for @mentions):\n${roster}\n` : ``)
    ).trimEnd()
  }

  /** Combine the standing scaffold with a per-turn delta. When the turn runs on a
   *  persistent session that ALREADY carries the standing prompt out-of-band
   *  (Claude's --append-system-prompt-file), we send ONLY the delta — that's the
   *  whole point. Otherwise (one-shot run, or an engine without a system-prompt
   *  file) we inline the standing prompt, preserving prior behavior. */
  private turnPrompt(session: EngineSession | null, delta: string): string {
    // If the session took the standing prompt out-of-band at spawn (Claude
    // system-prompt file / Codex developerInstructions), send ONLY the delta —
    // that's what keeps the transcript small. Otherwise inline it (one-shot path,
    // or out-of-band delivery wasn't available).
    if (session?.carriesStandingPrompt) return delta
    return `${this.standingPrompt()}\n\n════════\n\n${delta}`
  }

  /** When chat is idle, PROACTIVELY pick up assigned board work — the BYOA analog
   *  of the cloud idle scheduler's agenda heartbeat. Gated by a quiet window (the
   *  anti-loop) + a throttle so the 20s poll doesn't hammer it. Runs through the
   *  SAME persistent engine; isolated from the chat path so it can't break it. */
  private async maybeAgendaTurn(token: string): Promise<void> {
    const now = Date.now()
    if (now - this.lastTurnEndedAt < AGENDA_QUIET_MS) return
    if (now - this.lastAgendaCheckAt < AGENDA_CHECK_MS) return
    this.lastAgendaCheckAt = now
    // Same cooldown guard as runTurn — if this agent was just rate-limited
    // on a chat turn, skip the agenda heartbeat too (it'd hit the same
    // throttle). Re-fires on the next AGENDA_CHECK_MS tick after cooldown.
    // Place this BEFORE the /agenda fetch + /runs row creation so we don't
    // leak a 'running' run row that the stale-run sweeper later reaps.
    if (Date.now() < this.engineBackoffUntil) {
      const leftS = Math.round((this.engineBackoffUntil - Date.now()) / 1000)
      console.log(`[computer] ${this.agent.id} agenda skip: engine rate-limit cooldown, ${leftS}s left`)
      return
    }
    const ag = await runtimeGet<{ actionable?: boolean; brief?: string; focus?: string }>(
      this.cfg.serverUrl, '/agenda', token,
    )
    if (!ag?.actionable || !ag.brief) return
    console.log(`[computer] ${this.agent.id} agenda turn START — proactive board work${ag.focus ? `: ${ag.focus.slice(0, 80)}` : ''}`)
    await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'thinking' })
    const run = (await runtimeBest(this.cfg.serverUrl, '/runs', token, {
      trigger: { source: 'byoa-agenda', engine: this.adapter.id },
    })) as { runId?: string } | null
    // Pin the per-hop ledger's `runId` for the lifetime of this turn so every
    // hop emitted by the engine is linked back to the agent_runs row. Cleared
    // in finally below alongside the heartbeat stop.
    this.currentRunId = run?.runId ?? null
    const stopRunBeat = this.beatRun(token, run?.runId)
    let exitCode = 0
    let engineError: string | null = null
    let turnUsage: EngineUsage | undefined
    let turnModel: string | null | undefined
    // Spawn jitter + concurrency gate — same reason as the chat path (see
    // runTurn): when multiple agents on this computer hit the agenda
    // heartbeat in the same tick (they often do — same poll interval, all
    // due at once), staggering AND capping concurrent spawns keeps the
    // provider's short-window burst limit from rejecting them all.
    await bigBrainSem.acquire()
    await spawnPacer.gate()
    try {
      const [memoryDigest, roster] = await Promise.all([
        this.memoryDigest(),
        runtimeGet<{ roster: string }>(this.cfg.serverUrl, '/roster', token).then((r) => r?.roster ?? '').catch(() => ''),
      ])
      const resumeSessionId = this.sessionId
      const session = this.ensureEngineSession()
      const prompt = this.turnPrompt(session, this.agendaDelta(ag.brief, memoryDigest, roster))
      const result = session
        ? await session.send(prompt)
        : await this.adapter.run({
          home: this.home, prompt, env: this.engineEnv(),
          model: this.engineModel(), fastModel: this.engineFastModel(),
          resumeSessionId: this.sessionId, onLog: (line) => this.logEngineLine(line),
          // Same trajectory hook as the persistent-session path so the
          // one-shot fallback (or codex `exec` path) also lands hops in the
          // universal ledger.
          onHopUsage: (r) => this.onEngineHop(r, 'agent-turn'),
          signal: this.teardown.signal,
        })
      if (session?.sessionId) this.setSessionId(session.sessionId)
      if (session && !session.alive) this.engineSession = null
      if (!session && result.sessionId) this.setSessionId(result.sessionId)
      exitCode = result.exitCode
      turnUsage = result.usage
      turnModel = result.model
      if (result.error) engineError = this.visibleEngineError(exitCode, result.error)
      if (engineError && this.mustResetSession(engineError, !!resumeSessionId)) {
        this.resetEngineSession(this.resetReason(engineError))
      }
    } catch (err) {
      exitCode = 1
      engineError = this.visibleEngineError(1, err instanceof Error ? (err.stack || err.message) : String(err))
    } finally {
      stopRunBeat()
      this.lastTurnEndedAt = Date.now()
      // Per-turn ledger drain: turn just ended, push any queued hops promptly
      // instead of waiting for the 250ms timer. Fire-and-forget — the void
      // wraps because a slow flush must not block the chat path.
      this.currentRunId = null
      void this.reporter.flush()
      await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'avail' })
      // Mirror chat path: release the concurrency slot regardless of outcome.
      bigBrainSem.release()
    }
    // Rate-limit: same as chat-turn path — suppress the user-facing notice
    // and just defer (no inbox state to keep here since agenda turns are
    // proactive; next heartbeat re-evaluates after cooldown).
    const agendaRateLimited = engineError ? isRateLimited(engineError) : false
    if (engineError && !agendaRateLimited) {
      await this.publishEngineFailure({ token, runId: run?.runId, conversationId: null, error: engineError, exitCode })
    }
    if (engineError && agendaRateLimited) {
      this.engineBackoffUntil = Date.now() + ENGINE_BACKOFF_AFTER_RATE_LIMIT_MS
      spawnPacer.onRateLimited()
      console.warn(`[computer] ${this.agent.id} agenda engine RATE-LIMITED — cooling down ${Math.round(ENGINE_BACKOFF_AFTER_RATE_LIMIT_MS / 1000)}s, pacer now ${spawnPacer.intervalMs}ms`)
    } else if (!engineError) {
      this.engineBackoffUntil = 0
      spawnPacer.onOk()
    }
    // Finalize the run — WITHOUT this the row stays 'running' and the 10-min
    // stale-run sweeper reaps EVERY agenda turn as "orphaned" (the bug behind the
    // recurring Failed/orphaned runs), no matter how fast the turn actually was.
    if (run?.runId) {
      await runtimeBest(this.cfg.serverUrl, `/runs/${run.runId}/finish`, token, {
        status: exitCode === 0 ? 'completed' : 'failed',
        summary: engineError ?? `byoa-agenda ${this.adapter.id} run (exit ${exitCode})`,
        error: engineError,
        model: turnModel ?? this.agent.model,
        usage: turnUsage ? usageFromClaude(turnUsage) : null,
      })
    }
    console.log(`[computer] ${this.agent.id} agenda turn DONE — exit ${exitCode}`)
  }

  /** Fire-and-forget entry to a turn. The ONLY way wakes/polls trigger runTurn,
   *  so a rejection can never become an unhandled promise rejection (which on
   *  Node ≥15 crashes the whole daemon). runTurn already catches internally;
   *  this is the belt-and-suspenders second layer. */
  private kickTurn(reason: string): void {
    void this.runTurn(reason).catch((err) => {
      console.error(`[computer] ${this.agent.id} runTurn rejected (swallowed):`,
        err instanceof Error ? err.message : err)
    })
  }

  /** Debounced entry to a turn (debounce + coalesce).
   *  If a turn is already running, the existing in-turn coalesce (pendingRerun)
   *  handles it — start nothing, the running turn will rerun. Otherwise the first
   *  wake ARMS a short timer; subsequent wakes within the window fold in (return
   *  early). When it fires we run ONE turn that snapshots ALL unread — so a burst
   *  becomes a single big-engine spawn. The poll path and SSE wakes route here. */
  private scheduleWake(reason: string, convo?: string | null): void {
    if (this.stopped) return
    if (this.busy) {
      // A turn is already running. Coalesce as usual (the rerun re-reads the inbox),
      // BUT if this wake is a DIRECT ping, STEER it into the running turn so the
      // agent answers it mid-task instead of making it wait for the turn to end.
      this.kickTurn(reason)
      if (convo) void this.maybeSteer(convo)
      return
    }
    if (this.wakeDebounceTimer) return
    this.wakeDebounceTimer = setTimeout(() => {
      this.wakeDebounceTimer = null
      this.kickTurn(reason)
    }, WAKE_DEBOUNCE_MS)
    this.wakeDebounceTimer.unref?.()
  }

  /** Same-turn steering: when a DIRECT ping (DM / @me / a human
   *  addressing me) arrives WHILE a turn is running, inject it into the live
   *  persistent session so the agent answers it mid-task, then continues — instead
   *  of the ping waiting for the (possibly long) turn to end. Best-effort; only
   *  direct pings, deduped per message, never interrupts the main task. */
  private async maybeSteer(convo: string): Promise<void> {
    const session = this.engineSession
    if (!session?.alive || this.sideSteering) return
    this.sideSteering = true
    try {
      await this.ensureToken()
      // PROBE: this is the "should I steer?" check — we filter by direct/
      // mention/human below, and only ~20% of probes actually result in a
      // steer (most wakes are group chatter, not direct). Use ?probe=1 so
      // the server does NOT advance the freshness-preflight baseline for
      // this read; if the steer fires, the agent will see the rows via
      // the actual steer text, and any duplicate-collision risk remains
      // protected by cmdReply's preflight against the baseline that
      // snapshotUnread set at the start of this turn.
      const inbox = await runtimeGet<RuntimeInboxResponse>(this.cfg.serverUrl, '/inbox?probe=1', this.token)
      const rows = (inbox?.rows ?? []).filter((r) => r.conversation_id === convo)
      if (rows.length === 0) return
      const direct = rows.some((r) =>
        r.conversation_kind === 'direct' ||
        r.author_kind === 'human' ||
        (typeof r.body === 'string' && r.body.includes(`@${this.agent.id}`)))
      if (!direct) {
        if (!STEER_GROUP_IN_TURN) return
        // Content-free GROUP nudge (opt-in): tell the busy agent that
        // activity happened WITHOUT injecting bodies — throttled, deduped by latest
        // id. The agent glances + posts through the normal server gates (freshness
        // preflight, compose-anchor, verbatim-dup); the coalesced rerun stays as the
        // coordination-safe backstop, so this only ever ACCELERATES pickup.
        const nowMs = Date.now()
        const latestGroup = rows[rows.length - 1]
        if (!latestGroup.id || latestGroup.id === this.lastGroupSteeredMsgId) return
        if (nowMs - this.lastGroupSteerAt < GROUP_STEER_MIN_INTERVAL_MS) return
        this.lastGroupSteeredMsgId = latestGroup.id
        this.lastGroupSteerAt = nowMs
        session.steer(
          `⚡ ${rows.length} new message(s) arrived in ${convo} while you work — bodies withheld to keep you focused. At a natural pause, \`cumora glance ${convo}\` and handle it if it's yours (yield/claim as usual); otherwise keep going. Do NOT drop your current task.`,
        )
        console.log(`[computer] ${this.agent.id} GROUP-NOTICE → live turn (${rows.length} msg(s) in ${convo}, content-free)`)
        return
      }
      const latest = rows[rows.length - 1]
      if (!latest.id || latest.id === this.lastSteeredMsgId) return // dedup repeated wakes for the same ping
      this.lastSteeredMsgId = latest.id
      const who = latest.author_name ?? 'someone'
      const body = (latest.body ?? '').replace(/\s+/g, ' ').slice(0, 300)
      session.steer(
        `⚡ A direct message arrived while you work — answer it BRIEFLY, then resume your current task (do NOT drop it). ${who} in ${convo}: "${body}". Reply one line now: \`cumora reply ${convo} 'text'\` — a quick answer, or "on it, mid-task, will follow up". Then continue what you were doing.`,
      )
      console.log(`[computer] ${this.agent.id} STEER → live turn (direct msg in ${convo} from ${who})`)
    } catch { /* best-effort; the coalesced rerun still handles it at turn end */ } finally {
      this.sideSteering = false
    }
  }

  /** Run one turn. Coalesces concurrent wakes: a wake during a run schedules
   *  exactly one rerun afterward (the inbox is the source of truth). `reason`
   *  is logged so the service log shows WHAT drove each turn (sse-wake /
   *  sse-steer / poll / reconnect-catchup) — key for diagnosing receipt latency
   *  (e.g. a turn that only ever fires via 'poll' means SSE wakes aren't
   *  arriving and you're eating up to INBOX_POLL_MS of delay). */
  private async runTurn(reason: string): Promise<void> {
    if (this.busy) {
      this.pendingRerun = true
      console.log(`[computer] ${this.agent.id} turn busy — coalescing (${reason})`)
      return
    }
    this.busy = true
    try {
      do {
        this.pendingRerun = false
        // Triage-trouble backoff: while triage is cooling down (after a rate-limit
        // or a fail-open), skip the WHOLE turn — no triage call, no engine spawn —
        // so we neither hammer a broken/throttled triage nor burn the big brain.
        // The poll just no-ops until the window passes; unread messages are
        // untouched and get triaged then.
        if (Date.now() < this.triageBackoffUntil) {
          const leftS = Math.round((this.triageBackoffUntil - Date.now()) / 1000)
          console.log(`[computer] ${this.agent.id} skip (${reason}): triage backoff, ${leftS}s left`)
          break
        }
        // Big-brain rate-limit cooldown: the last attempt got throttled by the
        // provider. Skip this turn cleanly (no triage call either — even small
        // brain is wasted if we can't follow up with the big one). Unread is
        // kept (no ack), so the next wake AFTER the cooldown will pick it up.
        if (Date.now() < this.engineBackoffUntil) {
          const leftS = Math.round((this.engineBackoffUntil - Date.now()) / 1000)
          console.log(`[computer] ${this.agent.id} skip (${reason}): engine rate-limit cooldown, ${leftS}s left`)
          break
        }
        const turnStart = Date.now()
        await this.ensureToken()
        const token = this.token
        // Consume the wake's conversation, so a later turn that reuses no wake
        // can't flash phantom "typing" in whatever conversation last woke us.
        // (The fallback below is derived from CURRENTLY unread messages, so it
        // can't go stale the way a leftover wake value could.)
        const wakeConvo = this.lastWakeConvo
        this.lastWakeConvo = null
        // Snapshot what's unread BEFORE triaging, so triage provably sees a
        // superset of what we may ack — a real task that lands during/after
        // triage keeps a higher id, stays out of `seen`, and so survives to
        // drive the coalesced rerun rather than being silently acked away.
        const { seen, digest, hasReal, projectIds } = await this.snapshotUnread(token)
        // Which conversation should show "<agent> is typing…"? Prefer the one the
        // wake named, but fall back to the unread we just snapshotted, because a
        // wake often carries no conversation at all:
        //
        //   - a POLL-driven turn never has one (only an SSE wake sets
        //     lastWakeConvo), and polling is the ONLY path left whenever the
        //     wake-stream is down;
        //   - a wake that arrives while this agent is mid-turn is coalesced, and
        //     scheduleWake's busy branch re-kicks without a conversation.
        //
        // Both cases are exactly when a human IS waiting, and with no indicator
        // the agent reads as dead: it can work for minutes — engine spawned, turn
        // running — while the room shows nothing at all.
        const convo = typingConversation(wakeConvo, seen)
        // HARD COST GATE (content-blind, fail-closed): if nothing unread is a
        // real human/agent message — empty, or system-only relays/status/
        // membership notices — NEVER run triage and NEVER spawn the big engine.
        // System chatter is not a task. Ack it so it stops re-triggering, go
        // available, and wait for genuine content. This is the daemon-side
        // backstop against the "stale-wake storm" (a recurring system message
        // that otherwise woke opus on every ~20s poll). The big brain is for
        // real content only — under no circumstances spend it on system noise.
        if (!hasReal) {
          await this.ackSeen(token, seen)
          await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'avail' })
          // No per-tick log: this is the idle steady state (every poll × agent),
          // same reasoning as the 'inbox empty' skip below.
          // Chat is idle → maybe there's assigned BOARD work to proactively pick up
          // (quiet+throttle gated, so this isn't a per-poll cost).
          await this.maybeAgendaTurn(token)
          continue
        }
        const triage = await this.inboxTriage(token)
        const triageMs = Date.now() - turnStart // ensureToken + snapshot + triage
        // Triage was rate-limited → STOP. Do NOT retry, do NOT wake the big brain,
        // do NOT ack (the message is retried after the cooldown). Back off
        // exponentially so a throttled model can't be hammered into burning the
        // user's quota. This is the guard against the infinite-retry runaway.
        if (triage?.source === 'rate-limited') {
          this.triageTroubleStreak += 1
          const backoff = Math.min(10 * 60_000, 30_000 * 2 ** (this.triageTroubleStreak - 1))
          this.triageBackoffUntil = Date.now() + backoff
          console.warn(`[computer] ${this.agent.id} triage RATE-LIMITED (#${this.triageTroubleStreak}, triage ${triageMs}ms) — backing off ${Math.round(backoff / 1000)}s, NOT waking the big brain, not acking`)
          await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'avail' })
          break
        }
        // FAIL-OPEN is a triage FAILURE, not a confirmed real task — so it must
        // NEVER wake the expensive big brain (that escalation was the leak that
        // burned quota). Treat it like a rate-limit: skip, do NOT ack (retry next
        // poll once triage recovers), and back off so a persistently-broken triage
        // isn't re-hit — and never spends opus — every poll.
        if (triage?.source === 'fail-open') {
          this.triageTroubleStreak += 1
          const backoff = Math.min(10 * 60_000, 30_000 * 2 ** (this.triageTroubleStreak - 1))
          this.triageBackoffUntil = Date.now() + backoff
          console.warn(`[computer] ${this.agent.id} triage FAIL-OPEN (#${this.triageTroubleStreak}, triage ${triageMs}ms) — NOT waking the big brain, backing off ${Math.round(backoff / 1000)}s, not acking`)
          await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'avail' })
          break
        }
        // A clean, usable triage clears any prior backoff.
        this.triageTroubleStreak = 0
        this.triageBackoffUntil = 0
        if (triage?.actionable === false) {
          const skipReason = typeof triage.reason === 'string' ? triage.reason : 'not relevant'
          // Only log a MEANINGFUL skip. An empty inbox is the idle steady state
          // (every INBOX_POLL_MS tick × every agent) — logging it floods the
          // console with identical "inbox empty" lines and tells us nothing.
          if (skipReason !== 'inbox empty') {
            console.log(`[computer] ${this.agent.id} skip (${reason}, triage ${triageMs}ms): ${skipReason}`)
          }
          // Ack the chatter the small brain just dismissed. Without this the
          // unread sticks and the INBOX_POLL_MS drain re-triages it forever —
          // the loop that woke (or nearly woke) the big brain on every tick.
          await this.ackSeen(token, seen)
          await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'avail' })
          // Chat had nothing for us → maybe proactively pick up assigned board work.
          await this.maybeAgendaTurn(token)
          continue
        }
        // Mirror the cloud agent EXACTLY (turn.ts): the small brain ONLY gated
        // (actionable). It does NOT decide who replies, how, or — for a relay /
        // chain — who continues, and it NEVER writes content. Wake the big engine,
        // hand it the triage note + the shared glance-yield protocol, and let it
        // self-coordinate IN-TURN (glance → yield to earlier claimants → continue
        // the chain, never restart). That is the exact path that lets the cloud pod
        // play 成语接龙 cleanly. The old BYOA-only orchestration here — responseMode
        // routing, one-of-us claimReply, mechanical direct-post, relay turn-claim —
        // was the divergence that broke chains and is GONE. Cost backstops remain:
        // the actionable gate above + the per-minute activation rate floor.
        console.log(`[computer] ${this.agent.id} turn START (${reason}) — triage ${triageMs}ms, spawning ${this.adapter.id}${convo ? ` for ${convo}` : ''}`)
        await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'thinking' })
        // "<agent> is typing…" in the conversation that woke us, refreshed
        // while the engine works (BYOA runs can be long), cleared at the end.
        let typingTimer: ReturnType<typeof setInterval> | undefined
        if (convo) {
          const ping = (): void => { void runtimeBest(this.cfg.serverUrl, '/typing', token, { conversationId: convo, done: false }) }
          // Stamp every conversation in this wake, not just the trigger.
          // Mixed-project wakes then fall back to GLOBAL on memory writes
          // instead of guessing the trigger group's project.
          const wakeConvos = [...seen.keys()]
          const thinkingIds = wakeConvos.length > 0 ? wakeConvos : [convo]
          const thinkingPing = (): void => { void runtimeBest(this.cfg.serverUrl, '/thinking/mark', token, { conversationIds: thinkingIds, ttlSec: 60 }) }
          ping()
          thinkingPing()
          typingTimer = setInterval(() => {
            ping()
            thinkingPing()
          }, 6000)
          // Compose-anchor is now stamped by the /thinking/mark handler on
          // server side (it has the agent + convo already), pinned to THIS
          // turn's start. Independent of the seen-baseline (which glance/
          // messages advance) — so a peer post landing during compose still
          // HOLDs the reply even after the agent later glances and "absorbs"
          // it. Closes the 光-光 collision: two agents both saw 爻, both
          // drafted 光, and the second glance silently advanced past the
          // first poster's message; preflight previously saw "nothing newer."
        }
        const run = (await runtimeBest(this.cfg.serverUrl, '/runs', token, {
          trigger: { source: 'byoa', engine: this.adapter.id },
        })) as { runId?: string } | null
        // Pin runId so per-hop ledger rows link back to this turn (see
        // maybeAgendaTurn for the same hook).
        this.currentRunId = run?.runId ?? null
        const stopRunBeat = this.beatRun(token, run?.runId)
        let exitCode = 0
        let engineError: string | null = null
        let turnUsage: EngineUsage | undefined
        let turnModel: string | null | undefined
        // Per-computer concurrency gate + deterministic spawn pacer.
        // Pacer enforces a minimum interval between back-to-back spawns
        // (shared with triage path) so the provider never sees a burst of
        // N simultaneous starts. Random jitter (the earlier approach)
        // was probabilistic — by chance several waiters could roll near-
        // zero and still slam the API; deterministic pacing makes the
        // burst rate a hard 1/(MIN_SPAWN_INTERVAL_MS) regardless of
        // concurrent waiter count.
        await bigBrainSem.acquire()
        await spawnPacer.gate()
        const semQueueDepth = bigBrainSem.queueDepth
        if (semQueueDepth > 0) {
          console.log(`[computer] ${this.agent.id} big-brain sem acquired (queue depth was ${semQueueDepth + 1} including self)`)
        }
        try {
          const [memoryDigest, triageNote, roster] = await Promise.all([
            this.memoryDigest(projectIds),
            Promise.resolve(this.formatTriageNote(triage)),
            // Live team roster (names + roles + ids), fetched fresh from the
            // server so a locally-run agent knows WHO its teammates are and what
            // each does — the cloud agent gets this in its system prompt. Only
            // fetched here, right before a real turn, so no-op wakes pay nothing.
            runtimeGet<{ roster: string }>(this.cfg.serverUrl, '/roster', token)
              .then((r) => r?.roster ?? '').catch(() => ''),
          ])
          const resumeSessionId = this.sessionId
          let result: EngineRunResult
          const session = this.ensureEngineSession()
          // Standing scaffold rides the session's system-prompt file; send only the
          // small per-turn delta when it does (else inline it — see turnPrompt).
          const prompt = this.turnPrompt(session, this.chatDelta(memoryDigest, triageNote, digest, roster))
          if (session) {
            // PERSISTENT path: feed this turn into the long-lived process — no cold
            // start (the first turn paid it; turns 2..N reuse the booted process).
            // Persist the session id EARLY (the engine reports it ~1-2s in) so an
            // interrupt mid-turn — even on a brand-new session — still leaves a
            // resumable id on disk, not just when the turn finishes.
            const capture = setInterval(() => { if (session.sessionId) this.setSessionId(session.sessionId) }, 2000)
            capture.unref?.()
            try {
              result = await session.send(prompt)
            } finally {
              clearInterval(capture)
            }
            if (session.sessionId) this.setSessionId(session.sessionId)
            // Process died during/after the turn → drop it so the next wake respawns
            // (with --resume this.sessionId to carry context across the restart).
            if (!session.alive) this.engineSession = null
          } else {
            // One-shot path: Cursor/OpenCode, Codex fallback, or a custom args override.
            result = await this.adapter.run({
              home: this.home,
              prompt,
              env: this.engineEnv(),
              model: this.engineModel(),
              fastModel: this.engineFastModel(),
              resumeSessionId,
              onLog: (line) => this.logEngineLine(line),
              onHopUsage: (r) => this.onEngineHop(r, 'agent-turn'),
              signal: this.teardown.signal,
            })
            if (result.sessionId) this.setSessionId(result.sessionId)
          }
          exitCode = result.exitCode
          turnUsage = result.usage
          turnModel = result.model
          if (result.error) engineError = this.visibleEngineError(exitCode, result.error)
          // A stale resume OR a context-window overflow means this session can't
          // be carried forward — drop it AND tear down any persistent process so
          // the next wake starts clean (otherwise --resume re-overflows forever).
          if (engineError && this.mustResetSession(engineError, !!resumeSessionId)) {
            this.resetEngineSession(this.resetReason(engineError))
          }
        } catch (err) {
          console.error(`[computer] ${this.agent.id} engine spawn failed:`, err instanceof Error ? err.message : err)
          exitCode = 1
          engineError = this.visibleEngineError(exitCode, err instanceof Error ? (err.stack || err.message) : String(err))
        } finally {
          stopRunBeat()
          if (typingTimer) clearInterval(typingTimer)
          // Per-turn ledger drain (mirrors the agenda finally above).
          this.currentRunId = null
          void this.reporter.flush()
          if (convo) {
            await runtimeBest(this.cfg.serverUrl, '/typing', token, { conversationId: convo, done: true })
            await runtimeBest(this.cfg.serverUrl, '/thinking/unmark', token, { conversationIds: [convo] })
          }
          // Release the semaphore slot regardless of success / error — the
          // next queued agent can now spawn. MUST be in the same finally
          // that runs after the spawn await completes (success / error /
          // abort), otherwise a stuck slot starves the whole computer.
          bigBrainSem.release()
        }
        // Rate-limit case: when the underlying provider (Anthropic / OpenAI)
        // throttles us, this is NOT an agent-visible failure — the unread
        // survives (we skip ackSeen below for any engineError), the next wake
        // re-attempts, and jitter above plus this skip-the-notice keeps the
        // user from seeing a row of "byoa_engine_failed" markers in chat for
        // what is really a transient provider throttle. Persist a quieter
        // signal to the run row instead so it shows up in observability.
        const rateLimited = engineError ? isRateLimited(engineError) : false
        if (engineError && !rateLimited) {
          await this.publishEngineFailure({
            token,
            runId: run?.runId,
            conversationId: convo,
            error: engineError,
            exitCode,
          })
        }
        if (engineError && rateLimited) {
          // ENTER cooldown: this agent skips its own turns for the
          // configured window. The unread is kept (no ack, see below);
          // the next wake AFTER the cooldown will pick it up cleanly.
          // Also clear pendingRerun so the do-while loop exits — there's
          // no point in immediately re-attempting against the same throttle.
          // ALSO tell the global adaptive pacer to slow down — multiple
          // agents hitting rate-limit means the current interval is too
          // aggressive for the account's actual burst quota.
          this.engineBackoffUntil = Date.now() + ENGINE_BACKOFF_AFTER_RATE_LIMIT_MS
          this.pendingRerun = false
          spawnPacer.onRateLimited()
          console.warn(`[computer] ${this.agent.id} engine RATE-LIMITED (sem queue depth was ${semQueueDepth}) — cooling down ${Math.round(ENGINE_BACKOFF_AFTER_RATE_LIMIT_MS / 1000)}s, pacer now ${spawnPacer.intervalMs}ms`)
        } else if (!engineError) {
          // Clean turn → clear any prior engine backoff + signal pacer.
          this.engineBackoffUntil = 0
          spawnPacer.onOk()
        }
        if (run?.runId) {
          await runtimeBest(this.cfg.serverUrl, `/runs/${run.runId}/finish`, token, {
            status: exitCode === 0 ? 'completed' : 'failed',
            summary: rateLimited ? `rate-limited (deferred for retry)` : (engineError ?? `byoa ${this.adapter.id} run (exit ${exitCode})`),
            error: rateLimited ? null : engineError,
            model: turnModel ?? this.agent.model,
            usage: turnUsage ? usageFromClaude(turnUsage) : null,
          })
        }
        // Clean turn → ack everything this turn saw. If the engine replied it
        // already advanced these cursors (monotonic ack is a no-op then); if it
        // read the room and chose silence, this is what stops the same inbox
        // from re-waking the big brain on the next drain. On engine FAILURE we
        // skip the ack so the unread survives for a retry / next wake.
        if (!engineError) await this.ackSeen(token, seen)
        await runtimeBest(this.cfg.serverUrl, '/status', token, { status: 'avail' })
        // A chat turn resets the "quiet" anchor: an agent that just acted in chat
        // isn't immediately pulled into an agenda turn (mirrors the cloud idle
        // scheduler only picking agents quiet for N minutes).
        this.lastTurnEndedAt = Date.now()
        console.log(`[computer] ${this.agent.id} turn DONE (${reason}) — total ${Date.now() - turnStart}ms, exit ${exitCode}${this.pendingRerun ? ' · rerun queued' : ''}`)
        reason = 'rerun (coalesced wake)'
      } while (this.pendingRerun && !this.stopped)
    } catch (err) {
      // A turn-level failure — token mint 502 (e.g. a server pod rolling), a
      // runtime hiccup, a transient network drop — must NEVER escape and crash
      // the daemon, which would take EVERY hosted agent offline at once. Log it
      // and end this turn; the next wake or INBOX_POLL_MS drain retries with a
      // fresh token. (ensureToken is in this try, so its throws land here.)
      console.error(`[computer] ${this.agent.id} turn aborted (will retry on next wake/poll):`,
        err instanceof Error ? err.message : err)
    } finally {
      this.busy = false
    }
  }

  /** Hold the wake-stream open; reconnect with backoff. First connect (and
   *  every reconnect) does a catch-up turn — the inbox is durable. */
  private async streamLoop(): Promise<void> {
    let backoff = 1000
    while (!this.stopped) {
      let connectedAt: number | null = null
      try {
        const token = await this.ensureToken()
        const res = await fetch(`${this.cfg.serverUrl}/runtime/wake-stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        })
        if (!res.ok || !res.body) throw new Error(`wake-stream HTTP ${res.status}`)
        console.log(`[computer] ${this.agent.id} wake-stream connected (engine: ${this.adapter.id})`)
        connectedAt = Date.now()
        this.kickTurn('reconnect-catchup') // cold-start / reconnect catch-up
        for await (const evt of parseSseStream(res.body as unknown as AsyncIterable<unknown>)) {
          if (this.stopped) break
          if (evt.event === 'wake' || evt.event === 'steer') {
            // 'wake': normal new-activity nudge. 'steer': a peer posted while we
            // were mid-turn. We can't inject into the running engine (claude -p
            // has no mid-turn interrupt), but with continuous context (--resume)
            // a catch-up turn re-reads the now-durable message and the agent
            // sees the relay with full memory of its place — so it continues
            // the sequence instead of racing on a stale snapshot. A steer that
            // lands while busy is coalesced into exactly one rerun (pendingRerun).
            let convo: string | null = null
            let deliveryMs: number | null = null
            try {
              const d = evt.data ? (JSON.parse(evt.data) as { conversationId?: string; at?: number }) : {}
              convo = typeof d.conversationId === 'string' ? d.conversationId : null
              // evt.at = server's publish time. The gap to now is the
              // server→daemon delivery latency (the first place to look when
              // "receiving a message is slow"). Includes any client/server clock
              // skew, so read it as a trend, not an absolute.
              if (typeof d.at === 'number') deliveryMs = Date.now() - d.at
              if (convo) this.lastWakeConvo = convo
            } catch { /* malformed payload — ignore */ }
            console.log(`[computer] ${this.agent.id} SSE ${evt.event} received${convo ? ` convo=${convo}` : ''}${deliveryMs != null ? ` deliveryLatency=${deliveryMs}ms` : ''}`)
            this.scheduleWake(`sse-${evt.event}`, convo)
          }
          // 'ready' is a no-op keepalive.
        }
        // The stream ended WITHOUT throwing — a clean server-side close. This
        // used to fall straight back to the loop head and re-fetch with ZERO
        // delay, re-firing reconnect-catchup every pass: measured at ~15k
        // requests/second against the API from the operator's own machine.
        if (!this.stopped) {
          console.warn(`[computer] ${this.agent.id} wake-stream closed by server · retry in ${backoff}ms`)
        }
      } catch (err) {
        if (this.stopped) break
        const _cause = (err as { cause?: { code?: string; message?: string } } | null)?.cause
        console.warn(`[computer] ${this.agent.id} stream error: ${err instanceof Error ? err.message : err}${_cause ? ` cause=${_cause.code ?? _cause.message ?? JSON.stringify(_cause)}` : ''} · retry in ${backoff}ms`)
      }
      if (this.stopped) break
      // BOTH exits back off. Reset the ladder only after a connection that
      // actually stayed up — a 200 that closes immediately must not reset it, or
      // the delay can never grow away from a pathological endpoint.
      if (wakeStreamWasStable(connectedAt === null ? null : Date.now() - connectedAt)) backoff = 1000
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
}

// ─── run loop ───────────────────────────────────────────────────────────

/** Prefix every daemon log line with an ISO-8601 timestamp so the service log
 *  (~/.cumora/daemon.log) is diagnosable: when a wake arrived, how long a turn
 *  took, etc. Only for the long-running daemon (doRun) — the one-shot
 *  --status/--version/--logs commands stay clean. */
/** Cap ~/.cumora/daemon.log so it can't fill the disk. The supervisor (launchd /
 *  systemd) holds the file open in APPEND mode, so we can't rename it (that would
 *  orphan its fd and silently stop logging). Instead we copy-truncate (logrotate's
 *  copytruncate): keep the last full chunk as daemon.log.1, then truncate the live
 *  file IN PLACE — same inode, the supervisor keeps appending to it. Total stays
 *  ~2×MAX. Best-effort and silent when there's no file (a foreground run). */
async function rotateLogsIfNeeded(): Promise<void> {
  try {
    const logPath = join(CONFIG_DIR, 'daemon.log')
    const st = await stat(logPath)
    if (st.size <= MAX_LOG_BYTES) return
    await copyFile(logPath, `${logPath}.1`)
    await truncate(logPath, 0)
    console.log(`[computer] daemon.log passed ${Math.round(MAX_LOG_BYTES / 1048576)}MB — rotated (kept daemon.log.1, truncated live log)`)
  } catch { /* no log file (foreground) or transient FS error — never crash the daemon */ }
}

function installTimestampedLogging(): void {
  const wrap = (fn: (...a: unknown[]) => void): typeof fn => (...a: unknown[]) => fn(new Date().toISOString(), ...a)
  console.log = wrap(console.log.bind(console)) as typeof console.log
  console.warn = wrap(console.warn.bind(console)) as typeof console.warn
  console.error = wrap(console.error.bind(console)) as typeof console.error
}

async function doRun(serverOverride?: string): Promise<void> {
  installTimestampedLogging()
  // Global safety net: a long-running daemon hosting every one of the user's
  // agents must NOT die because one async path threw — a transient 502 from a
  // server pod rolling, a network blip, a malformed event. Node ≥15 turns an
  // unhandled rejection into a fatal exit by default; an uncaught exception is
  // fatal too. We log and KEEP RUNNING so the agents stay online and self-heal
  // on the next wake / poll. Installed once, here at the top of the run loop.
  process.on('unhandledRejection', (reason) => {
    console.error('[computer] unhandledRejection (kept alive):', reason instanceof Error ? reason.stack || reason.message : reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('[computer] uncaughtException (kept alive):', err instanceof Error ? err.stack || err.message : err)
  })

  const cfg = await loadConfig()
  if (!cfg) {
    console.error('[computer] not paired. Run: cumora agent computer --pair <code> [--server <url>]')
    process.exitCode = 1
    return
  }
  if (serverOverride) cfg.serverUrl = serverOverride
  let initialEngines: EngineId[]
  try {
    initialEngines = await requireLocalEngine()
  } catch (err) {
    console.error(`[computer] ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 70
    return
  }
  const engineInventory: EngineInventory = { current: initialEngines }
  console.log(`[computer] cumora ${CURRENT_VERSION} · starting ${cfg.computerId} @ ${cfg.serverUrl} (engines: ${engineInventory.current.join(', ')})`)
  // Record what THIS process is running, keyed by pid, so `--status` can report
  // the version of the live service instance reliably (cross-checked against the
  // running pid — survives log rotation, no log-scraping).
  const windowsShutdownRequest = process.platform === 'win32'
    ? windowsShutdownRequestPath(process.pid)
    : null
  if (windowsShutdownRequest) await rm(windowsShutdownRequest, { force: true }).catch(() => {})
  await writeRunningState()
  if (!SUPERVISED) {
    console.log(`[computer] 💡 tip: run \`npx cumora@latest agent computer --install-service\` to keep this running in the background — auto-start when you sign in, auto-restart on crash, and auto-update. (This terminal must stay open otherwise.)`)
  }

  const runners = new Map<string, AgentRunner>()

  const sync = async (): Promise<void> => {
    let agents: AgentInfo[]
    try {
      agents = await api<AgentInfo[]>(cfg.serverUrl, '/api/computers/me/agents', {
        headers: { Authorization: `Bearer ${cfg.deviceToken}` },
      })
    } catch (err) {
      console.warn('[computer] agent sync failed:', err instanceof Error ? err.message : err)
      return
    }
    const available = engineInventory.current
    for (const agent of agents) {
      const engine = resolveAvailableEngine(agent.engine, available)
      if (!engine) {
        // A successful rescan may legitimately find that the last installed CLI
        // was removed. Stop an existing runner instead of leaving it alive on an
        // engine this machine no longer has.
        const existing = runners.get(agent.id)
        if (existing) {
          console.log(`[computer] no installed engine remains for ${agent.name} (${agent.id}) → stopping runner`)
          existing.stop()
          runners.delete(agent.id)
        }
        continue
      }
      const existing = runners.get(agent.id)
      if (existing) {
        if (existing.configMatches(agent, engine)) continue
        // Engine/model/persona was edited in Cumora — restart the runner so the
        // change takes effect on the next wake without a daemon restart.
        console.log(`[computer] agent ${agent.name} (${agent.id}) config changed → restarting on ${engine}`)
        existing.stop()
        runners.delete(agent.id)
      }
      const runner = new AgentRunner(cfg, agent, engine)
      runners.set(agent.id, runner)
      console.log(`[computer] hosting agent ${agent.name} (${agent.id}) on ${engine}`)
      await runner.start()
    }
    // Agents removed from this computer: stop their runners.
    const live = new Set(agents.map((a) => a.id))
    for (const [id, runner] of runners) {
      if (!live.has(id)) { runner.stop(); runners.delete(id) }
    }
  }

  // Engines this machine can currently run, re-scanned on a slow timer. Reported
  // on every heartbeat so installing another supported CLI takes effect without
  // re-pairing — the daemon is already online and can see PATH itself, so there
  // is no reason to make the user mint a new pairing token for it.
  const rescanEngines = async (): Promise<void> => {
    try {
      const detected = await detectEnginesWithStatus()
      if (!detected.reliable) return  // broken `which` / `where` — keep the last good list
      const next = detected.engines
      const previous = engineInventory.current
      const changed = replaceEngineInventory(engineInventory, next)
      if (changed) {
        console.log(`[computer] engines on PATH changed: ${previous.join(', ') || 'none'} → ${next.join(', ') || 'none'}`)
        // Heartbeat already advertises the live inventory. This snapshot is
        // only the PATH display the app reads — pairable engines, never the
        // detect-only bins Electron lists on the Me page.
        const snapshot = await snapshotDetectedEngines(next)
        await api(cfg.serverUrl, '/api/computers/me/engines', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.deviceToken}` },
          body: JSON.stringify({ engines: next, detected: snapshot }),
        }).catch((err) => {
          console.warn('[computer] engine snapshot report failed', err instanceof Error ? err.message : err)
        })
      }
      // This is the same live inventory sync() uses to choose an agent's
      // adapter. Updating only a heartbeat cache would advertise a newly
      // installed engine while silently running that agent on the old default.
    } catch { /* transient — the next tick retries */ }
  }

  const heartbeat = async (): Promise<void> => {
    try {
      await fetch(`${cfg.serverUrl}/api/computers/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.deviceToken}` },
        // A heartbeat that never answers must not outlive its own interval, or
        // the beats queue up behind a dead socket and the computer reads offline.
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        // `supervised` tells the server HOW this daemon runs (service vs. a
        // foreground command), so the app's upgrade banner can show the right
        // update instructions for this machine.
        body: JSON.stringify({ version: CURRENT_VERSION, supervised: SUPERVISED, engines: engineInventory.current }),
      })
    } catch { /* transient — next tick retries */ }
  }

  await heartbeat()
  await sync()
  if (runners.size === 0) {
    console.log('[computer] no agents assigned to this computer yet. Assign one in Cumora; polling…')
  }
  const poll = setInterval(() => { void sync() }, AGENT_POLL_MS)
  const beat = setInterval(() => { void heartbeat() }, HEARTBEAT_MS)
  const rescan = setInterval(() => { void rescanEngines() }, ENGINE_RESCAN_MS)
  rescan.unref?.()
  // Keep the service log from filling the disk: rotate at boot, then periodically.
  void rotateLogsIfNeeded()
  const logrot = setInterval(() => { void rotateLogsIfNeeded() }, LOG_ROTATE_MS)
  logrot.unref?.()

  let upd: ReturnType<typeof setInterval> | undefined
  let idleWatch: ReturnType<typeof setInterval> | undefined
  let controlWatch: ReturnType<typeof setInterval> | undefined
  let shuttingDown = false
  const anyBusy = (): boolean => [...runners.values()].some((r) => r.isBusy)

  // Graceful shutdown: stop accepting new wakes, give any in-flight turn a brief
  // window to FINISH (so it persists its session id + finalizes its run) before we
  // kill the engine child. A long task won't finish in the window and gets killed,
  // but its session id is on disk → the relaunched daemon `--resume`s it.
  const shutdown = async (why: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(poll); clearInterval(beat); clearInterval(logrot); clearInterval(rescan)
    if (upd) clearInterval(upd)
    if (idleWatch) clearInterval(idleWatch)
    if (controlWatch) clearInterval(controlWatch)
    if (windowsShutdownRequest) await rm(windowsShutdownRequest, { force: true }).catch(() => {})
    for (const runner of runners.values()) runner.beginStop() // no new turns; leave in-flight running
    const deadline = Date.now() + SHUTDOWN_GRACE_MS
    if (anyBusy()) console.log(`[computer] ${why}: waiting up to ${Math.round(SHUTDOWN_GRACE_MS / 1000)}s for in-flight turn(s) to finish…`)
    while (anyBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500))
    for (const runner of runners.values()) runner.stop() // now tear down engine children
    console.log(`[computer] shutting down (${why})`)
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
  if (windowsShutdownRequest) {
    controlWatch = setInterval(() => {
      if (existsSync(windowsShutdownRequest)) void shutdown('service control')
    }, 250)
    controlWatch.unref?.()
  }

  // Self-update: compare to npm's latest periodically. When supervised
  // (--install-service), a clean exit relaunches the service on cumora@latest =
  // the update. Crucially we do NOT interrupt a live turn for a (non-urgent)
  // update: once an update is detected we wait for ALL agents to go idle, then
  // exit. First check a minute after boot, then every UPDATE_CHECK_MS.
  let updateReady = false
  const exitForUpdateWhenIdle = (): void => {
    if (!updateReady || shuttingDown) return
    if (anyBusy()) return // mid-turn — defer; the idle watch retries
    void shutdown('auto-update')
  }
  const runUpdateCheck = (): void => {
    void checkForUpdate(() => {
      if (!updateReady) {
        updateReady = true
        console.log('[computer] update ready — will restart to apply it as soon as all agents are idle')
      }
      exitForUpdateWhenIdle()
    })
  }
  upd = setInterval(runUpdateCheck, UPDATE_CHECK_MS)
  idleWatch = setInterval(exitForUpdateWhenIdle, 30_000); idleWatch.unref?.()
  setTimeout(runUpdateCheck, 60_000).unref?.()
}

// ─── self-update + service ────────────────────────────────────────────────

/** Compare the running version to npm's `latest`. If behind: when supervised,
 *  exit cleanly so the service relaunches on `cumora@latest` (= the update);
 *  otherwise just log that an update is available. Never throws. */
async function checkForUpdate(onSupervisedUpdate: () => void): Promise<void> {
  try {
    const res = await fetch('https://registry.npmjs.org/cumora/latest', { headers: { Accept: 'application/json' } })
    if (!res.ok) return
    const latest = (await res.json() as { version?: string })?.version
    if (typeof latest !== 'string' || !versionGt(latest, CURRENT_VERSION)) return
    if (SUPERVISED) {
      console.log(`[computer] 🆕 cumora ${latest} available (running ${CURRENT_VERSION}) — will restart to apply once idle (in-flight turns are never interrupted for an update)`)
      onSupervisedUpdate()
    } else {
      console.log(`[computer] 🆕 cumora ${latest} available (running ${CURRENT_VERSION}). Restart to update, or run \`cumora agent computer --install-service\` for auto-updates.`)
    }
  } catch { /* offline / npm hiccup — try the next tick */ }
}

/** Absolute path to npx next to the node that's running us, so the supervisor
 *  doesn't depend on its (minimal) PATH resolving `npx`. Falls back to PATH. */
export function resolveNpx(
  platform: NodeJS.Platform = process.platform,
  execPath = process.execPath,
): string {
  const executable = platform === 'win32' ? 'npx.cmd' : 'npx'
  const sibling = join(dirname(execPath), executable)
  return existsSync(sibling) ? sibling : executable
}

function windowsSupervisorPath(): string {
  return join(CONFIG_DIR, 'daemon-supervisor.ps1')
}

function windowsSupervisorDisabledPath(): string {
  return join(CONFIG_DIR, 'daemon-supervisor.disabled')
}

function windowsShutdownRequestPath(pid: number): string {
  return join(CONFIG_DIR, `shutdown-${pid}.request`)
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** The scheduled task starts this watchdog at login. It deliberately restarts
 *  after every daemon exit, including the clean exit used to apply an update. */
export function renderWindowsSupervisor(
  npx: string,
  serverUrl: string,
  logPath: string,
  disabledPath = windowsSupervisorDisabledPath(),
  path = process.env.PATH ?? '',
): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$env:CUMORA_SUPERVISED = '1'",
    `$env:PATH = ${quotePowerShell(path)}`,
    '$utf8 = New-Object System.Text.UTF8Encoding($false)',
    `while (-not (Test-Path -LiteralPath ${quotePowerShell(disabledPath)})) {`,
    `  & ${quotePowerShell(npx)} -y cumora@latest agent computer --server ${quotePowerShell(serverUrl)} 2>&1 | ForEach-Object {`,
    `    [System.IO.File]::AppendAllText(${quotePowerShell(logPath)}, ([string]$_ + [Environment]::NewLine), $utf8)`,
    '  }',
    '  Start-Sleep -Seconds 5',
    '}',
    '',
  ].join('\r\n')
}

export function windowsScheduledTaskCommand(scriptPath: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath.replaceAll('"', '""')}"`
}

export function windowsScheduledTaskCreateArgs(
  scriptPath: string,
  taskName = windowsTaskName(),
): string[] {
  return [
    '/Create', '/TN', taskName,
    '/TR', windowsScheduledTaskCommand(scriptPath),
    '/SC', 'ONLOGON', '/RL', 'LIMITED', '/IT', '/F',
  ]
}

export function windowsScheduledTaskSettingsCommand(taskName = windowsTaskName()): string {
  return `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable; Set-ScheduledTask -TaskName ${quotePowerShell(taskName)} -Settings $settings | Out-Null`
}

export function windowsScheduledTaskQueryCommand(taskName = windowsTaskName()): string {
  return `try { Get-ScheduledTask -TaskName ${quotePowerShell(taskName)} -ErrorAction Stop | Out-Null; exit 0 } catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound_TaskName,*') { exit 3 }; Write-Error $_; exit 1 }`
}

async function isWindowsTaskInstalled(taskName = windowsTaskName()): Promise<boolean> {
  try {
    await execFileP('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', windowsScheduledTaskQueryCommand(taskName),
    ])
    return true
  } catch (err) {
    if (String((err as { code?: number | string }).code) === '3') return false
    throw err
  }
}

/** Install a per-user supervisor (LaunchAgent on macOS, systemd --user on
 *  Linux, Task Scheduler on Windows) that runs
 *  `npx -y cumora@latest agent computer --server <url>` with auto-restart +
 *  start-at-login. `@latest` + restart-on-update is what makes the daemon
 *  self-update (see checkForUpdate). Must be paired first. */
async function installService(serverUrl: string): Promise<void> {
  if (!(await loadConfig())) {
    throw new Error('pair this computer first: cumora agent computer --pair <code>')
  }
  const npx = resolveNpx()
  const logPath = join(CONFIG_DIR, 'daemon.log')
  await mkdir(CONFIG_DIR, { recursive: true })

  if (process.platform === 'darwin') {
    const dir = join(homedir(), 'Library', 'LaunchAgents')
    await mkdir(dir, { recursive: true })
    const plistPath = join(dir, `${SERVICE_LABEL}.plist`)
    const args = [npx, '-y', 'cumora@latest', 'agent', 'computer', '--server', serverUrl]
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH ?? ''}</string>
    <key>CUMORA_SUPERVISED</key><string>1</string>
  </dict>
</dict></plist>
`
    await writeFile(plistPath, plist, 'utf8')
    await execFileP('launchctl', ['unload', plistPath]).catch(() => { /* not loaded yet */ })
    await execFileP('launchctl', ['load', plistPath])
    console.log(`[computer] installed LaunchAgent ${SERVICE_LABEL} — auto-start, auto-restart, auto-update. Logs: ${logPath}`)
    console.log(`[computer] you can now close this terminal; the service is running in the background.`)
    return
  }

  if (process.platform === 'linux') {
    const dir = join(homedir(), '.config', 'systemd', 'user')
    await mkdir(dir, { recursive: true })
    const unitPath = join(dir, 'cumora.service')
    const unit = `[Unit]
Description=Cumora BYOA daemon
After=network-online.target

[Service]
ExecStart=${npx} -y cumora@latest agent computer --server ${serverUrl}
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH ?? ''}
Environment=CUMORA_SUPERVISED=1

[Install]
WantedBy=default.target
`
    await writeFile(unitPath, unit, 'utf8')
    await execFileP('systemctl', ['--user', 'daemon-reload'])
    await execFileP('systemctl', ['--user', 'enable', '--now', 'cumora'])
    console.log(`[computer] installed systemd --user service 'cumora' — auto-start, auto-restart, auto-update. Logs: journalctl --user -u cumora -f`)
    return
  }

  if (process.platform === 'win32') {
    const scriptPath = windowsSupervisorPath()
    const disabledPath = windowsSupervisorDisabledPath()
    const taskName = windowsTaskName()
    const replacing = await isWindowsTaskInstalled(taskName)
    await writeFile(scriptPath, renderWindowsSupervisor(npx, serverUrl, logPath, disabledPath), 'utf8')
    try {
      if (!replacing) {
        await execFileP('schtasks.exe', windowsScheduledTaskCreateArgs(scriptPath, taskName))
      }
      await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command', windowsScheduledTaskSettingsCommand(taskName),
      ])
    } catch (err) {
      if (!replacing) {
        try {
          await execFileP('schtasks.exe', ['/Delete', '/TN', taskName, '/F'])
        } catch (rollbackErr) {
          throw new Error(`scheduled task setup failed and rollback could not delete '${taskName}'; the watchdog script was kept in place (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`, { cause: err })
        }
        await rm(scriptPath, { force: true }).catch(() => {})
      }
      throw err
    }
    await writeFile(disabledPath, '', 'utf8')
    await killRunningDaemons()
    await stopWindowsWatchdog(taskName)
    // The old watchdog could have spawned a daemon between the first process
    // sweep and its own exit. Sweep once more only after it cannot relaunch one.
    await killRunningDaemons()
    await rm(disabledPath, { force: true })
    try {
      await execFileP('schtasks.exe', ['/Run', '/TN', taskName])
    } catch (err) {
      throw new Error(`scheduled task installed but could not be started; retry with --restart (${err instanceof Error ? err.message : String(err)})`)
    }
    console.log(`[computer] installed scheduled task '${taskName}' — start-at-login, auto-restart, auto-update. Logs: ${logPath}`)
    console.log(`[computer] you can now close this terminal; the task is running in the background.`)
    return
  }

  throw new Error(`--install-service is not supported on ${process.platform}`)
}

async function uninstallService(): Promise<void> {
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    await execFileP('launchctl', ['unload', plistPath]).catch(() => { /* already gone */ })
    await rm(plistPath).catch(() => { /* already gone */ })
    console.log(`[computer] removed LaunchAgent ${SERVICE_LABEL}`)
    return
  }
  if (process.platform === 'linux') {
    await execFileP('systemctl', ['--user', 'disable', '--now', 'cumora']).catch(() => { /* already gone */ })
    await rm(join(homedir(), '.config', 'systemd', 'user', 'cumora.service')).catch(() => { /* already gone */ })
    await execFileP('systemctl', ['--user', 'daemon-reload']).catch(() => {})
    console.log(`[computer] removed systemd --user service 'cumora'`)
    return
  }
  if (process.platform === 'win32') {
    const taskName = windowsTaskName()
    const disabledPath = windowsSupervisorDisabledPath()
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(disabledPath, '', 'utf8')
    if (await isWindowsTaskInstalled(taskName)) {
      await execFileP('schtasks.exe', ['/Delete', '/TN', taskName, '/F'])
    }
    await killRunningDaemons()
    await stopWindowsWatchdog(taskName)
    await killRunningDaemons()
    if (await isWindowsTaskInstalled(taskName)) {
      throw new Error(`scheduled task '${taskName}' still exists after deletion`)
    }
    await rm(windowsSupervisorPath(), { force: true })
    // Keep this sentinel on every failed stop path so a surviving watchdog
    // cannot revive a daemon after the command has reported an error.
    await rm(disabledPath, { force: true })
    console.log(`[computer] removed scheduled task '${taskName}'`)
    return
  }
  throw new Error(`--uninstall-service is not supported on ${process.platform}`)
}

function darwinPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
}
function linuxUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'cumora.service')
}

/** Is the background supervisor already installed on this machine? */
async function isServiceInstalled(): Promise<boolean> {
  if (process.platform === 'darwin') return existsSync(darwinPlistPath())
  if (process.platform === 'linux') return existsSync(linuxUnitPath())
  if (process.platform === 'win32') return isWindowsTaskInstalled()
  return false
}

/** Restart the already-installed service so it re-reads computer.json — used
 *  after a re-pair so the running service adopts the new config instead of a
 *  second foreground daemon racing it. */
async function reloadService(): Promise<void> {
  if (process.platform === 'darwin') {
    const p = darwinPlistPath()
    await execFileP('launchctl', ['unload', p]).catch(() => {})
    await execFileP('launchctl', ['load', p])
    return
  }
  if (process.platform === 'linux') {
    await execFileP('systemctl', ['--user', 'restart', 'cumora'])
    return
  }
  if (process.platform === 'win32') {
    const taskName = windowsTaskName()
    const disabledPath = windowsSupervisorDisabledPath()
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(disabledPath, '', 'utf8')
    await killRunningDaemons()
    await stopWindowsWatchdog(taskName)
    await killRunningDaemons()
    await rm(disabledPath, { force: true })
    await execFileP('schtasks.exe', ['/Run', '/TN', taskName])
  }
}

/** `--restart`: a friendly wrapper so users don't have to remember
 *  `launchctl kickstart …`. Restarts the installed service (which relaunches on
 *  cumora@latest, so it's also the "apply the update now" button). */
async function restartService(): Promise<void> {
  if (!(await isServiceInstalled())) {
    console.log('[computer] service not installed — run: npx cumora@latest agent computer --install-service')
    return
  }
  if (process.platform === 'darwin') {
    const uid = process.getuid?.() ?? 0
    try {
      await execFileP('launchctl', ['kickstart', '-k', `gui/${uid}/${SERVICE_LABEL}`])
    } catch {
      await reloadService() // not currently loaded → load it
    }
  } else if (process.platform === 'linux') {
    await execFileP('systemctl', ['--user', 'restart', 'cumora'])
  } else if (process.platform === 'win32') {
    await reloadService()
  } else {
    throw new Error(`--restart is not supported on ${process.platform}`)
  }
  console.log('[computer] service restarted — it relaunches on cumora@latest (also applies any pending update). Check: npx cumora@latest agent computer --status')
}

/** `--stop`: stop the background service NOW, without uninstalling it. The job is
 *  removed from the supervisor so KeepAlive/Restart won't relaunch it; the
 *  plist/unit stays on disk, so `--restart` brings it back. (To remove it
 *  entirely, use `--uninstall-service`.) */

/** One-shot CLI invocations: these do a thing and exit, so they are never the
 *  long-running daemon we mean to stop. Anchored to the `--` so the words can't
 *  match incidentally elsewhere in the command line. */
const ONE_SHOT_FLAG_RE =
  /--(stop|status|restart|logs|version|install-service|uninstall-service|pair)\b/

/** Is this `ps`-reported command line a long-running BYOA daemon that `--stop`
 *  should kill? True only for `agent computer` with no one-shot flag.
 *
 *  The npx *wrapper* used to be excluded here too, but that exclusion was both
 *  wrong and unnecessary: `npx -y cumora@latest agent computer --server …` is
 *  exactly how the LaunchAgent (and the docs) start a real daemon, and self/parent
 *  protection is already handled by dropping process.pid / process.ppid from the
 *  candidate set. Killing the wrapper's child is what actually stops the daemon,
 *  and the wrapper exits with it. */
export function isStoppableDaemonCommand(cmd: string): boolean {
  return /agent computer/.test(cmd) && !ONE_SHOT_FLAG_RE.test(cmd)
}

async function commandLineForPid(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue).CommandLine`
    return (await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])).stdout.trim()
  }
  return (await execFileP('ps', ['-p', String(pid), '-o', 'command='])).stdout.trim()
}

interface WindowsProcessInfo {
  ProcessId: number
  CommandLine: string
  Name?: string
}

export function parseWindowsProcessList(output: string): WindowsProcessInfo[] {
  if (!output.trim()) return []
  const parsed = JSON.parse(output) as WindowsProcessInfo | WindowsProcessInfo[]
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) =>
    Number.isInteger(item?.ProcessId) && item.ProcessId > 0 && typeof item.CommandLine === 'string')
}

async function windowsDaemonProcesses(): Promise<WindowsProcessInfo[]> {
  const command = [
    '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -match 'agent\\s+computer' } | Select-Object ProcessId, CommandLine) | ConvertTo-Json -Compress`,
  ].join('; ')
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  return parseWindowsProcessList(stdout)
}

async function windowsSupervisorProcesses(): Promise<WindowsProcessInfo[]> {
  const command = [
    '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    `@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { ($_.Name -ieq 'powershell.exe' -or $_.Name -ieq 'pwsh.exe') -and $_.CommandLine -match 'daemon-supervisor\\.ps1' } | Select-Object ProcessId, CommandLine, Name) | ConvertTo-Json -Compress`,
  ].join('; ')
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])
  return parseWindowsProcessList(stdout).filter((item) => isWindowsSupervisorProcess(item))
}

export function isWindowsSupervisorProcess(
  item: WindowsProcessInfo,
  scriptPath = windowsSupervisorPath(),
): boolean {
  if (!item.Name || !['powershell.exe', 'pwsh.exe'].includes(item.Name.toLowerCase())) return false
  const match = item.CommandLine.match(/(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))(?:\s|$)/i)
  const invokedScript = match?.[1] ?? match?.[2]
  return invokedScript?.toLowerCase() === scriptPath.toLowerCase()
}

async function stopWindowsWatchdog(taskName: string): Promise<void> {
  await execFileP('schtasks.exe', ['/End', '/TN', taskName]).catch(() => { /* deleted/already stopped */ })
  const deadline = Date.now() + 2_000
  let watchdogs = await windowsSupervisorProcesses()
  while (watchdogs.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    watchdogs = await windowsSupervisorProcesses()
  }
  for (const watchdog of watchdogs) {
    await execFileP('taskkill.exe', ['/PID', String(watchdog.ProcessId), '/T', '/F']).catch(() => {})
  }
  const forceDeadline = Date.now() + 2_000
  watchdogs = await windowsSupervisorProcesses()
  while (watchdogs.length > 0 && Date.now() < forceDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    watchdogs = await windowsSupervisorProcesses()
  }
  if (watchdogs.length > 0) {
    throw new Error(`Windows watchdog process(es) still running: ${watchdogs.map((item) => item.ProcessId).join(', ')}`)
  }
}

/** Stop any RUNNING daemon process — the supervised one (after the service is
 *  uninstalled), a foreground one, or a stray/orphaned one. Sources: the pid the
 *  daemon records in running.json, plus an OS process sweep for "agent computer". We
 *  verify each candidate's command line really is a long-running daemon (and is
 *  NOT this --stop command or another one-shot CLI) before stopping it. Windows
 *  uses a per-PID request file for graceful shutdown, then taskkill /T as the
 *  bounded fallback so engine descendants cannot be orphaned. */
async function killRunningDaemons(): Promise<void> {
  const candidates = new Set<number>()
  try {
    const pid = (JSON.parse(await readFile(RUNNING_STATE_PATH, 'utf8')) as { pid?: number }).pid
    if (typeof pid === 'number' && pid > 0) candidates.add(pid)
  } catch { /* no pid file */ }
  if (process.platform === 'win32') {
    for (const item of await windowsDaemonProcesses()) candidates.add(item.ProcessId)
  } else {
    try {
      const { stdout } = await execFileP('pgrep', ['-f', 'agent computer'])
      for (const l of stdout.split('\n')) { const p = parseInt(l.trim(), 10); if (p > 0) candidates.add(p) }
    } catch { /* none / pgrep unavailable */ }
  }
  candidates.delete(process.pid)
  if (typeof process.ppid === 'number') candidates.delete(process.ppid)
  const victims: number[] = []
  for (const pid of candidates) {
    try {
      const cmd = await commandLineForPid(pid)
      // A genuine long-running daemon: "agent computer" with NO one-shot flag —
      // so we never kill a sibling one-shot CLI. (Ourselves and our parent are
      // already out of `candidates`.)
      if (isStoppableDaemonCommand(cmd)) {
        victims.push(pid)
      }
    } catch { /* gone */ }
  }
  if (process.platform === 'win32') {
    if (victims.length > 0) await mkdir(CONFIG_DIR, { recursive: true })
    for (const pid of victims) {
      await writeFile(windowsShutdownRequestPath(pid), 'stop\n', 'utf8').catch(() => {})
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS + 2_000
    let survivors = victims
    while (survivors.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      const next: number[] = []
      for (const pid of survivors) {
        try {
          if (isStoppableDaemonCommand(await commandLineForPid(pid))) next.push(pid)
        } catch { /* exited */ }
      }
      survivors = next
    }
    for (const pid of survivors) {
      await execFileP('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {})
    }
    for (const pid of victims) await rm(windowsShutdownRequestPath(pid), { force: true }).catch(() => {})
    const forceDeadline = Date.now() + 2_000
    let remaining = (await windowsDaemonProcesses()).filter((item) =>
      item.ProcessId !== process.pid && item.ProcessId !== process.ppid &&
      isStoppableDaemonCommand(item.CommandLine))
    while (remaining.length > 0 && Date.now() < forceDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      remaining = (await windowsDaemonProcesses()).filter((item) =>
        item.ProcessId !== process.pid && item.ProcessId !== process.ppid &&
        isStoppableDaemonCommand(item.CommandLine))
    }
    if (remaining.length > 0) {
      throw new Error(`Windows daemon process(es) still running: ${remaining.map((item) => item.ProcessId).join(', ')}`)
    }
  } else {
    for (const pid of victims) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
    if (victims.length > 0) {
      await new Promise((r) => setTimeout(r, 1500))
      for (const pid of victims) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
    }
  }
  if (victims.length > 0) {
    console.log(`[computer] stopped ${victims.length} running daemon process(es)`)
  }
  await rm(RUNNING_STATE_PATH, { force: true }).catch(() => {})
}

/** `--stop`: a FULL stop — uninstall the background service (so the supervisor
 *  can't relaunch it) AND kill any daemon process still running. After this the
 *  agents are fully offline until you re-pair / re-install. */
async function stopService(): Promise<void> {
  if (process.platform === 'win32') {
    // Always clean up on Windows: a manually deleted task may still have left a
    // watchdog process or script behind, and that watchdog can relaunch a daemon.
    await uninstallService()
  } else if (await isServiceInstalled()) {
    await uninstallService() // removes the plist/unit + unloads → kills the supervised process
  } else {
    console.log('[computer] no background service installed — killing any running daemon process directly.')
  }
  if (process.platform !== 'win32') await killRunningDaemons()
  console.log('[computer] stopped — service removed and daemon process(es) killed. Re-pair to start again: npx cumora@latest agent computer --pair <code>')
}

/** `--status`: a one-glance summary — version, pairing, whether the background
 *  service is installed + running (PID / last exit), and where the logs are. */
async function printStatus(): Promise<void> {
  const cfg = await loadConfig()
  // The version of the binary running THIS command. May differ from what the
  // background service is actually running (it auto-updates on its own cycle),
  // so we report the service's running version separately, read from its log.
  console.log(`cli:     cumora ${CURRENT_VERSION} (this command)`)
  console.log(cfg ? `paired:  computer ${cfg.computerId} @ ${cfg.serverUrl}` : 'paired:  NO — run: npx cumora@latest agent computer --pair <code>')
  if (!(await isServiceInstalled())) {
    console.log('service: not installed — run: npx cumora@latest agent computer --install-service')
    return
  }
  let livePid: number | null = null
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('launchctl', ['list', SERVICE_LABEL])
      const pid = stdout.match(/"PID"\s*=\s*(\d+)/)?.[1]
      livePid = pid ? Number(pid) : null
      const exit = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/)?.[1]
      console.log(livePid ? `service: installed · running (pid ${livePid})` : `service: installed · NOT running${exit ? ` (last exit ${exit})` : ''}`)
    } catch {
      console.log('service: installed · not loaded (try: launchctl load ~/Library/LaunchAgents/' + SERVICE_LABEL + '.plist)')
    }
  } else if (process.platform === 'linux') {
    const active = await execFileP('systemctl', ['--user', 'is-active', 'cumora']).then((r) => r.stdout.trim()).catch(() => 'inactive')
    const pid = await execFileP('systemctl', ['--user', 'show', 'cumora', '-p', 'MainPID', '--value']).then((r) => r.stdout.trim()).catch(() => '')
    livePid = pid && pid !== '0' ? Number(pid) : null
    console.log(`service: installed · ${active}${livePid ? ` (pid ${livePid})` : ''}`)
  } else if (process.platform === 'win32') {
    try {
      const state = JSON.parse(await readFile(RUNNING_STATE_PATH, 'utf8')) as { pid?: number }
      if (typeof state.pid === 'number' && isStoppableDaemonCommand(await commandLineForPid(state.pid))) {
        livePid = state.pid
      }
    } catch { /* task is between restarts or has not started yet */ }
    console.log(livePid
      ? `service: installed · running (pid ${livePid}, Task Scheduler)`
      : `service: installed · registered in Task Scheduler`)
  }
  const running = await resolveRunningVersion(livePid)
  if (running) {
    console.log(`running: cumora ${running}${running === CURRENT_VERSION ? ' (latest)' : ' (differs from this cli — `npx cumora@latest agent computer --restart` to pick up the latest)'}`)
  } else {
    console.log('running: unknown — `npx cumora@latest agent computer --restart` to (re)start it and record the version')
  }
  console.log(`logs:    ${process.platform === 'linux' ? 'journalctl --user -u cumora -f' : join(CONFIG_DIR, 'daemon.log')}  (or: npx cumora@latest agent computer --logs)`)
}

const RUNNING_STATE_PATH = join(CONFIG_DIR, 'running.json')

/** On startup the live daemon records {version, pid, startedAt} here so
 *  `--status` can report the running instance's exact version — verified by pid
 *  so a stale file (from a since-exited process) is ignored. */
async function writeRunningState(): Promise<void> {
  try {
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(RUNNING_STATE_PATH, JSON.stringify({ version: CURRENT_VERSION, pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
  } catch { /* best-effort; --status falls back to the log */ }
}

/** The version the SERVICE is running right now. Primary source: running.json,
 *  trusted only when its recorded pid IS the live service pid (so it reflects
 *  THIS instance, not a stale one). Fallback: the latest startup line in the log
 *  (works for builds that log a version but predate running.json). '' if unknown
 *  (e.g. the running build predates both — restart it once to record it). */
async function resolveRunningVersion(livePid: number | null): Promise<string> {
  try {
    const st = JSON.parse(await readFile(RUNNING_STATE_PATH, 'utf8')) as { version?: string; pid?: number }
    if (typeof st.version === 'string' && st.version && livePid != null && st.pid === livePid) return st.version
  } catch { /* no/again-bad state file — fall back to log scan */ }
  try {
    const text = process.platform === 'linux'
      ? (await execFileP('journalctl', ['--user', '-u', 'cumora', '-n', '400', '--no-pager'])).stdout
      : await readFile(join(CONFIG_DIR, 'daemon.log'), 'utf8')
    const m = [...text.matchAll(/cumora (\d+\.\d+\.\d+) · starting/g)]
    return m.length ? m[m.length - 1][1] : ''
  } catch { return '' }
}

/** `--logs`: follow the service's output. macOS/Windows tail the log file;
 *  Linux streams journald (systemd doesn't write a file). Runs until Ctrl+C. */
async function tailLogs(): Promise<void> {
  if (process.platform === 'linux') {
    await new Promise<void>((resolve) => {
      const c = spawn('journalctl', ['--user', '-u', 'cumora', '-n', '100', '-f'], { stdio: 'inherit' })
      c.on('close', () => resolve()); c.on('error', () => resolve())
    })
    return
  }
  const logPath = join(CONFIG_DIR, 'daemon.log')
  if (!existsSync(logPath)) {
    console.log(`no log at ${logPath} yet — is the service installed and running? (npx cumora@latest agent computer --status)`)
    return
  }
  await new Promise<void>((resolve) => {
    const c = process.platform === 'win32'
      ? spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          `Get-Content -LiteralPath ${quotePowerShell(logPath)} -Encoding UTF8 -Tail 100 -Wait`,
        ], { stdio: 'inherit' })
      : spawn('tail', ['-n', '100', '-f', logPath], { stdio: 'inherit' })
    c.on('close', () => resolve()); c.on('error', () => resolve())
  })
}

// ─── doctor ─────────────────────────────────────────────────────────────

/** `cumora agent computer --doctor`: diagnose every local engine on this
 *  machine — is it installed, and are its BIG brain (main reasoning) and SMALL
 *  brain (the triage cerebellum) reachable + authed? Each tier gets a trivial
 *  one-shot probe over the SAME spawn path real wakes use, so green here means
 *  real wakes will work. Pure local: no cloud, no DB, no pairing required. */
async function runDoctor(): Promise<void> {
  console.log(`cumora ${CURRENT_VERSION} · engine doctor`)
  console.log('probing local engines (big brain = main reasoning, small brain = triage cerebellum)…\n')

  const results = await runEngineDoctor({ onLog: (l) => console.error(`  · ${l}`) })
  console.log('')

  let anyUsable = false
  for (const r of results) {
    if (!r.installed) {
      console.log(`✖ ${r.id} — not found on PATH`)
      console.log(`    install the \`${r.id}\` CLI and run it once to sign in, then re-run --doctor\n`)
      continue
    }
    console.log(`● ${r.id} — ${r.path}`)
    for (const [label, h] of [['big brain  ', r.big], ['small brain', r.small]] as const) {
      if (!h) continue
      if (h.ok) {
        console.log(`    ✓ ${label}  ok (${h.ms}ms)`)
      } else {
        console.log(`    ✖ ${label}  FAILED (${h.ms}ms): ${h.detail}`)
        console.log(`        → ${authFailureHint(r.id, h.detail)}`)
      }
    }
    // Wake-path line. Hidden when skipped (the wake collapses to one-shot exec on
    // this machine — the brain probes above already cover that shape, so a wake
    // line would be noise). Failure is shown but NOT counted against "anyUsable"
    // because run()'s one-shot exec is a working fallback whenever the wake-path
    // breaks — the user just doesn't get persistent-session benefits.
    if (r.wake && !r.wake.skipped) {
      if (r.wake.ok) {
        console.log(`    ✓ wake path   ok (${r.wake.ms}ms)`)
      } else {
        console.log(`    ⚠ wake path   FAILED (${r.wake.ms}ms): ${r.wake.detail}`)
        console.log(`        → persistent-session path unavailable; agents will fall back to one-shot exec`)
      }
    }
    if (r.big?.ok && r.small?.ok) anyUsable = true
    console.log('')
  }

  if (!anyUsable) {
    console.log('✖ no engine has BOTH brains healthy — this machine cannot currently run a BYOA agent.')
    console.log('  fix the failures above (usually: open the engine\'s app and sign in / refresh quota), then re-run:')
    console.log('    cumora agent computer --doctor')
    process.exitCode = 1
  } else {
    console.log('✓ at least one engine is fully healthy — BYOA agents on this machine can wake their brains.')
  }
}

// ─── entry ──────────────────────────────────────────────────────────────

export async function runComputerDaemon(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const serverUrl = (args.server || DEFAULT_SERVER).replace(/\/+$/, '')
  if (args.help) { console.log(helpText()); return }
  if (args.version) { console.log(CURRENT_VERSION); return }
  if (args.doctor) { await runDoctor(); return }
  if (args.restart) { await restartService(); return }
  if (args.stop) { await stopService(); return }
  if (args.status) { await printStatus(); return }
  if (args.logs) { await tailLogs(); return }
  if (args.uninstallService) { await uninstallService(); return }
  // Pair first (saves config) so a combined `--pair … --install-service` can
  // pair AND hand off to the supervisor in one paste.
  if (args.pair) {
    await doPair(args.pair, serverUrl, args.engine)
  }
  // Installing the service is terminal: it writes the supervisor (which runs
  // the daemon itself) and exits — we don't ALSO run a foreground daemon here.
  if (args.installService) {
    const cfg = await loadConfig()
    await installService(args.server ? serverUrl : (cfg?.serverUrl ?? serverUrl))
    return
  }
  // Re-paired on a machine already managed by the background service: reload
  // the service so it adopts the new config (e.g. moved to another company),
  // instead of starting a SECOND foreground daemon that races the service.
  if (args.pair && await isServiceInstalled()) {
    await reloadService()
    console.log(`[computer] re-paired — reloaded the background service with the new config. (No foreground daemon needed; you can close this terminal.)`)
    return
  }
  await doRun(args.server ? serverUrl : undefined)
}
