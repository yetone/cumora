/**
 * Per-(agent, conversation) "seen seq" boundary tracking, stored in Redis with
 * short TTL. Used by `cumora reply`'s freshness preflight to detect when a
 * peer posted in this conversation DURING the agent's triage+compose window,
 * so the second sender's INSERT gets HELD instead of colliding (e.g. Iris and
 * Marcus both posting "3" in a counting game).
 *
 * Why Redis and NOT conversation_reads.last_read_at:
 *   - a6e69aa tried it in `conversation_reads` and broke loadInbox: the same
 *     row's `last_read_at` is loadInbox's SELECT cursor; bumping it to NOW()
 *     made the next loadInbox return empty, daemons hung silent-busy. Anything
 *     that shares state with the inbox cursor is structurally unsafe.
 *   - Redis is OUTSIDE the DB transaction graph — no row locks, no contention
 *     with the inbox query. Atomic Lua keeps the monotonic update race-free.
 *   - TTL=10min auto-cleans; no schema change, no migration, no growth.
 *
 * Why fail-open:
 *   - This is a coordination signal, not a correctness invariant. If Redis is
 *     down or returns an error, the worst case is a duplicate-number collision
 *     (the bug we're trying to *reduce*, not eliminate) — never a daemon hang
 *     or a lost message. The previous design failed CLOSED (synchronous DB
 *     contention could stall a turn forever); this one explicitly fails open.
 */
import { redis } from '../redis.js'

const TTL_SECONDS = 600 // 10 minutes — well over any plausible compose window
const KEY_PREFIX = 'cumora:seen'

function key(agentId: string, conversationId: string): string {
  return `${KEY_PREFIX}:${agentId}:${conversationId}`
}

// Atomic monotonic SET: set key=ARGV[1] IFF ARGV[1] > current (or key absent),
// refreshing TTL on each successful set. The Lua keeps GET+SET race-free, so
// two concurrent callers racing to record different seqs always converge on
// the higher value (never regresses).
const MONOTONIC_SET_SCRIPT = `
local cur = tonumber(redis.call('GET', KEYS[1])) or 0
local newv = tonumber(ARGV[1]) or 0
if newv > cur then
  redis.call('SET', KEYS[1], newv, 'EX', ARGV[2])
  return 1
end
return 0
`

/** Record that this agent has been SHOWN messages up to (at least) `seq` in
 *  this conversation. Idempotent / monotonic: never regresses, always
 *  refreshes TTL on a higher-or-equal advance. Fire-and-forget; failures are
 *  logged but never thrown (the caller is on a turn hot path). */
export async function recordSeen(agentId: string, conversationId: string, seq: number): Promise<void> {
  if (!agentId || !conversationId) return
  if (!Number.isFinite(seq) || seq <= 0) return
  try {
    await redis.eval(MONOTONIC_SET_SCRIPT, 1, key(agentId, conversationId), String(seq), String(TTL_SECONDS))
  } catch (err) {
    console.warn(
      `[seen-boundary] recordSeen(${agentId}, ${conversationId}, ${seq}) failed — fail-open`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Read the high-water seq this agent has been SHOWN in this conversation.
 *  Returns 0 if unset, expired, or Redis error (FAIL-OPEN — treat the agent
 *  as "no boundary tracked" so the preflight is skipped, not stalled). */
export async function getSeen(agentId: string, conversationId: string): Promise<number> {
  if (!agentId || !conversationId) return 0
  try {
    const v = await redis.get(key(agentId, conversationId))
    const n = v ? Number(v) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch (err) {
    console.warn(
      `[seen-boundary] getSeen(${agentId}, ${conversationId}) failed — fail-open`,
      err instanceof Error ? err.message : err,
    )
    return 0
  }
}

// ─── Compose anchor (turn-start timestamp) ────────────────────────────────
//
// The freshness preflight above uses `recordSeen` / `getSeen`, which advance
// every time the agent runs `cumora messages` or `cumora glance`. That broke
// in one observed collision: two agents woke on the same boundary, agent B
// glanced AFTER agent A posted → glance advanced B's seen-baseline PAST A's
// new post → preflight saw "nothing newer" → B's stale draft slipped
// through, producing a same-content duplicate (the 光-光 case).
//
// The compose anchor pins the "world state when THIS turn started" by
// timestamp, INDEPENDENT of any subsequent glance/messages calls. The
// preflight queries `messages.created_at > anchor` — so anything a peer
// posted while we were composing trips a HOLD even if we later glanced and
// "absorbed" it into the seen-baseline. Same Redis-only fail-open
// semantics as seen-baseline.
//
// Lifecycle: daemon writes at turn START; cli.cmdReply reads on preflight;
// cleared on successful post (or TTL — same 10min as seen).

const ANCHOR_PREFIX = 'cumora:compose-anchor'

function anchorKey(agentId: string, conversationId: string): string {
  return `${ANCHOR_PREFIX}:${agentId}:${conversationId}`
}

/** Stamp the moment this agent's current compose started, for the freshness
 *  preflight to compare against at post time. OVERWRITES — every turn START
 *  is a fresh anchor (unlike `recordSeen`, which is monotonic). Pure Redis,
 *  fail-open. */
export async function recordComposeAnchor(agentId: string, conversationId: string, tsMs: number): Promise<void> {
  if (!agentId || !conversationId) return
  if (!Number.isFinite(tsMs) || tsMs <= 0) return
  try {
    await redis.set(anchorKey(agentId, conversationId), String(Math.floor(tsMs)), 'EX', TTL_SECONDS)
  } catch (err) {
    console.warn(
      `[seen-boundary] recordComposeAnchor(${agentId}, ${conversationId}, ${tsMs}) failed — fail-open`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Read the compose anchor (unix-ms) for this agent+convo. Returns 0 if
 *  unset / expired / Redis error → preflight falls through to the seen-
 *  baseline path (FAIL-OPEN, same posture as `getSeen`). */
export async function getComposeAnchor(agentId: string, conversationId: string): Promise<number> {
  if (!agentId || !conversationId) return 0
  try {
    const v = await redis.get(anchorKey(agentId, conversationId))
    const n = v ? Number(v) : 0
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch (err) {
    console.warn(
      `[seen-boundary] getComposeAnchor(${agentId}, ${conversationId}) failed — fail-open`,
      err instanceof Error ? err.message : err,
    )
    return 0
  }
}

/** Clear the compose anchor after the agent successfully posts in this
 *  conversation. TTL handles the leak case if this never runs. */
export async function clearComposeAnchor(agentId: string, conversationId: string): Promise<void> {
  if (!agentId || !conversationId) return
  try {
    await redis.del(anchorKey(agentId, conversationId))
  } catch {
    /* fail-open — TTL will reclaim it */
  }
}

// ─── Hold token (HELD-acknowledgement gate for override flags) ────────────
//
// `--send-anyway` (cumora reply) and `--force` (doc/calendar create) exist so
// an agent that WAS held can re-commit after reviewing the held context.
// Agents learned to pass the flag PREEMPTIVELY to save a round-trip, which
// turns the server-side gate into a no-op — the 2026-06-11/12 double-
// deliverable incidents (two agents each posting the full story; two
// 《第七天的猫》 docs) both shipped through a preemptive bypass. The hold
// token makes the override flag an ACKNOWLEDGEMENT instead of a free pass:
// the server records a token whenever it returns a HELD envelope, and the
// flag is honored only while a token exists (then consumed). An agent that
// never saw a HOLD gets the normal preflight no matter what flags it passes.
//
// Same Redis-only posture as the rest of this file, with one inversion:
// consumeHold fails OPEN to armed — if Redis is down we honor the flag
// rather than block real work (worst case is today's behavior).
//
// Lifecycle (tightened after the 2026-07-08 counting-game dup): a token is
// an acknowledgement of ONE specific shown state, valid for one immediate
// re-run. It must NOT outlive its moment, so it dies on the FIRST of:
//   - consumption (the re-run, GET+DEL atomic)
//   - the turn ending (`unmarkThinking` clears reply:* for the turn's convos)
//   - the agent acking the conversation (yield path — Saga banked a token
//     by yielding after a HOLD, and a LATER turn's preemptive --send-anyway
//     consumed it to ship a stale duplicate)
//   - a short TTL (crash backstop)
// AND, for reply scopes, the token carries the max peer seq the HELD
// envelope showed — cmdReply re-verifies at consume time that the room has
// not moved past it (see cli.ts), so even a same-turn acknowledgement can't
// sail past messages the agent was never shown.

const HOLD_TTL_SECONDS = 120 // a HELD acknowledgement is only meaningful in
// the same breath as the HELD itself: HELD → re-read → re-run is seconds,
// not minutes. Long TTLs turn yielded holds into future bypass ammunition.

const HOLD_PREFIX = 'cumora:held'

function holdKey(agentId: string, scope: string): string {
  return `${HOLD_PREFIX}:${agentId}:${scope}`
}

// GET+DEL in one atomic step so two racing override attempts can't both
// consume the same acknowledgement. Returns the stored value (string) or
// false when absent.
const CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then
  redis.call('DEL', KEYS[1])
  return v
end
return false
`

/** What a consumed hold token acknowledges. */
export interface HoldAcknowledgement {
  /** A token existed (or Redis failed open) — the override flag is armed. */
  armed: boolean
  /** The highest peer `messages.sequence` the HELD envelope showed the agent,
   *  when the recording gate knew it (reply preflight). null = armed without
   *  state info (doc/calendar title scopes, legacy token, Redis fail-open) —
   *  the caller can't staleness-check and honors the flag as before. */
  heldUpToSeq: number | null
}

/** Record that a HELD envelope was just shown to this agent for `scope`
 *  (e.g. `reply:<convoId>`, `doc-create:<normalized title>`). For reply
 *  scopes pass `heldUpToSeq` — the max peer sequence the envelope showed —
 *  so consumption can verify the acknowledgement is still current. Fire-
 *  and-forget; failures are logged, never thrown. */
export async function recordHold(agentId: string, scope: string, heldUpToSeq?: number): Promise<void> {
  if (!agentId || !scope) return
  // 'seq:<n>' when the gate knew the shown high-water seq; bare '1' when it
  // didn't (doc/calendar title scopes) — prefixed so a real seq of 1 can't
  // collide with the no-seq sentinel.
  const value = Number.isFinite(heldUpToSeq) && (heldUpToSeq as number) > 0
    ? `seq:${Math.floor(heldUpToSeq as number)}`
    : '1'
  try {
    await redis.set(holdKey(agentId, scope), value, 'EX', HOLD_TTL_SECONDS)
  } catch (err) {
    console.warn(
      `[seen-boundary] recordHold(${agentId}, ${scope}) failed — fail-open`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Consume (read + delete) the hold token for this agent+scope. `armed`
 *  says whether the agent has actually been shown a HELD envelope it can
 *  now acknowledge; `heldUpToSeq` is the state that envelope showed (when
 *  recorded with one). FAIL-OPEN to armed on Redis error: an infra hiccup
 *  must degrade to today's behavior (flag honored), never to blocked
 *  work. */
export async function consumeHold(agentId: string, scope: string): Promise<HoldAcknowledgement> {
  if (!agentId || !scope) return { armed: false, heldUpToSeq: null }
  try {
    const r = await redis.eval(CONSUME_SCRIPT, 1, holdKey(agentId, scope))
    if (typeof r !== 'string' && typeof r !== 'number') return { armed: false, heldUpToSeq: null }
    const m = /^seq:(\d+)$/.exec(String(r))
    const seq = m ? Number(m[1]) : NaN
    return { armed: true, heldUpToSeq: Number.isFinite(seq) && seq > 0 ? seq : null }
  } catch (err) {
    console.warn(
      `[seen-boundary] consumeHold(${agentId}, ${scope}) failed — fail-open (honoring override)`,
      err instanceof Error ? err.message : err,
    )
    return { armed: true, heldUpToSeq: null }
  }
}

/** Drop a lingering hold token after the agent successfully committed
 *  without needing the override — a stale token must not arm a later
 *  preemptive bypass. TTL covers the leak case. */
export async function clearHold(agentId: string, scope: string): Promise<void> {
  if (!agentId || !scope) return
  try {
    await redis.del(holdKey(agentId, scope))
  } catch {
    /* fail-open — TTL will reclaim it */
  }
}

// ─── same-turn continuation ────────────────────────────────────────
//
// The anti-monologue gate asks "is my own last message in this room something
// I decided to post, or the intent message of the work I am doing right now?"
// It could not tell, because nothing recorded WHICH run posted a message.
//
// The operating rules require an intent message before long work ("Drafting
// the email now"), a SEPARATE `cumora reply`, then the result in the SAME
// turn. In a group of three or more the gate refused that second call, so the
// flow the product mandates was the flow it rejected.
//
// A run id plus a count is enough to separate the two: a second post from the
// SAME run is the announced work being delivered; a post from a LATER run is
// the agent waking up and deciding to talk again, which is what the gate was
// built to stop. The count caps it at announce-then-deliver — a third post in
// one turn is monologuing again, and still needs `--continue`.

const TURN_POST_TTL_SECONDS = 600 // matches the gate's 10-minute window
const TURN_POST_PREFIX = 'cumora:turnpost'

function turnPostKey(agentId: string, conversationId: string): string {
  return `${TURN_POST_PREFIX}:${agentId}:${conversationId}`
}

/** Posts this run has already made in this conversation. */
export interface TurnPostRecord {
  runId: string
  posts: number
}

/** Record that `runId` just posted in `conversationId`. Increments when the
 *  same run posts again, resets when a new run takes over. Fire-and-forget:
 *  a failure only costs the exemption, never a message. */
export async function recordTurnPost(
  agentId: string, conversationId: string, runId: string,
): Promise<void> {
  if (!agentId || !conversationId || !runId) return
  try {
    const key = turnPostKey(agentId, conversationId)
    const existing = await redis.get(key)
    const prior = parseTurnPost(existing)
    const posts = prior && prior.runId === runId ? prior.posts + 1 : 1
    await redis.set(key, `${runId}:${posts}`, 'EX', TURN_POST_TTL_SECONDS)
  } catch (err) {
    console.warn(
      `[seen-boundary] recordTurnPost(${agentId}, ${conversationId}) failed`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** What this agent last posted in this conversation, and from which run.
 *  Returns null when unknown — the caller must then behave exactly as it did
 *  before this existed, which for the gate means refusing. FAIL-CLOSED on a
 *  Redis error: an infra hiccup must not hand out a monologue exemption. */
export async function readTurnPost(
  agentId: string, conversationId: string,
): Promise<TurnPostRecord | null> {
  if (!agentId || !conversationId) return null
  try {
    return parseTurnPost(await redis.get(turnPostKey(agentId, conversationId)))
  } catch (err) {
    console.warn(
      `[seen-boundary] readTurnPost(${agentId}, ${conversationId}) failed — fail-closed`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** `<runId>:<posts>`. The run id itself never contains a colon (see
 *  createRun), so splitting on the LAST one is unambiguous either way. */
export function parseTurnPost(raw: string | null | undefined): TurnPostRecord | null {
  if (!raw) return null
  const idx = raw.lastIndexOf(':')
  if (idx <= 0) return null
  const runId = raw.slice(0, idx)
  const posts = Number.parseInt(raw.slice(idx + 1), 10)
  if (!runId || !Number.isFinite(posts) || posts < 1) return null
  return { runId, posts }
}

/** Announce-then-deliver is two posts. A third is monologuing again. */
export const MAX_POSTS_PER_TURN_PER_CONVERSATION = 2
