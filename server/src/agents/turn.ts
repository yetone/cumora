/**
 * Agent turn — the unit of work that fires when an agent has new mail.
 *
 * Mailbox model (instead of server-side classifier + cascade):
 *   1. A new message lands in any conversation.
 *   2. The scheduler publishes a wake to every agent member of that conversation
 *      (except the author). Per-agent serial; coalesces bursts.
 *   3. Each waking agent enters runAgentTurn:
 *        - Loads its inbox (everything since its last_read_at, across all convos)
 *        - Runs a bounded multi-hop LLM/tool loop with `bash` for world actions
 *          and `set_turn_status` for the model's explicit turn-state protocol.
 *        - The LLM is prompted to read the inbox and decide what to do via
 *          `cumora ...` subcommands: reply / react / dm / pull-group / docs / etc.
 *        - The turn ends when the model stops requesting tools, declares a
 *          terminal turn status, or hits a budget/cap guard.
 *
 * No streaming reply — the agent's reply lands as a `cumora reply` tool call,
 * which writes the message in one shot and broadcasts CH_MESSAGE_NEW.
 */
import type { ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses'
import { env } from '../env.js'
import { redis } from '../redis.js'
import { messageAttachmentStorageKey } from '../storage-keys.js'
import { classifyInboxTriage, gateSyntheticWake } from './inbox-triage.js'
import { GLANCE_YIELD_RULES } from './glance-protocol.js'
import { TOOL_DEFS_RESPONSES, executePodTool } from './runtime/pod-tools.js'
import {
  TURN_STATUS_VALUES,
  bashOutputHasReplySideEffect,
  bashOutputSideEffects,
  bashOutputSideEffectChannelUnreliable,
  type CliSideEffect,
  type ToolResult,
  type TurnStatusOutput,
  type TurnStatusValue,
} from './tools-shared.js'
import { hydrate as hydrateFs, commit as commitFs, teardown as teardownFs, type FsNamespace } from './runtime/fs-namespace.js'
import type { PollWakeBrief } from './runtime/wake-bus.js'
import { runtime } from './runtime/select.js'
import type { AgentRuntimeClient } from './runtime/client.js'
import { BUSY_STATUS_HEARTBEAT_MS } from '../status.js'
import { errorText, type AgentRunStatus } from './observability.js'
import { getLlmClient } from '../llm.js'
import { enforceModelPolicy, realTaskModel, supportModel } from './model-policy.js'
import { materializeImage } from './image-fetcher.js'
import {
  applyResponseStreamEvent,
  consumeResponseStream,
  newResponseStreamState,
  type ResponseStreamState,
} from './turn-stream.js'
import { compactHistoryWithSummary, estimateHistoryTokens, estimateTokens } from './turn-compaction.js'
import { usageFromOpenAI, addUsage, EMPTY_USAGE, type TokenUsage } from './cost.js'
import { recordLlmCall, classifyLlmCallError, readStreamUsage, readStreamReasoningTokens } from './llm-ledger.js'
import { resolveDeclaredAutoRelayTarget } from './auto-relay.js'
import {
  canDrainSteer,
  drainSteer,
  resetSteerForAgent,
  isSteerSaturated,
  isSteerByteBudgetExhausted,
  recordSteerBytes,
  registerActiveToolBatch,
  clearActiveToolBatch,
  SUMMARIZE_THRESHOLD as STEER_SUMMARIZE_THRESHOLD,
  type SteerItem,
} from './steer.js'

interface InboxAttachment {
  url: string
  name: string
  kind: string
  mime?: string
  /** Storage key (`attachments/<uuid>.<ext>`) preserved for re-signing. */
  key?: string
}

interface QuotedSummary {
  id: string
  authorId: string
  authorName: string
  kind: string
  body: string
  sequence: number
}

interface InboxRow {
  id: string
  conversation_id: string
  company_id: string | null
  conversation_title: string
  conversation_kind: string
  conversation_topic: string | null
  project_id?: string | null
  project_name?: string | null
  author_id: string
  /** Joined from `participants.kind` so the agent prompt can tell a human
   *  message apart from an agent reply without a hardcoded id list. Null
   *  when the author isn't a participant in this tenant (rare; e.g. a
   *  participant row was deleted but the message remains). */
  author_kind: 'human' | 'agent' | null
  author_name: string
  body: string
  kind: string
  sequence: number
  created_at: string
  attachment: InboxAttachment | null
  /** Set when this message is a reply: the id of the quoted-original. */
  quoted_message_id: string | null
  /** Inlined summary of the quoted-original — saves the agent a second
   *  fetch when reasoning about reply context. Null when not a reply OR
   *  when the original was deleted. */
  quoted: QuotedSummary | null
}

export interface AgentTurnOptions {
  /** Why this turn was started. Message-driven turns remain the default. */
  trigger?: 'message.new' | 'idle' | 'manual' | 'background_scan' | 'poll.updated'
  /** Short scheduler note rendered only for idle synthetic wakes. */
  idleReason?: string
  /** Server-side support-model triage note for ordinary message wakes. */
  triageNote?: string
  /** Internal background brief rendered as a normal model input. */
  backgroundBrief?: {
    title: string
    body: string
    source?: string
  }
  /** Snapshot of a poll the author should look at right now — set when
   *  trigger === 'poll.updated'. The author agent uses this to watch
   *  the tally live, nudge laggards mid-poll, and post a summary at
   *  close. Same shape as the wake-bus brief. */
  pollBrief?: PollWakeBrief
}

// Every runtime side effect — DB reads, status broadcasts, typing
// indicators, agent-run + event writes — flows through
// `AgentRuntimeClient` (see runtime/inproc-client.ts). turn.ts itself
// has no direct DB or Redis access. Phase 3 swaps the inproc client
// for an HTTP one without changing a line below.
//
// The local read wrappers below exist only as call-site shorthand so
// the runAgentTurn body reads naturally — they delegate one-to-one.
async function loadInbox(agentId: string, rc: AgentRuntimeClient = runtime): Promise<InboxRow[]> {
  return rc.loadInbox(agentId)
}

async function loadMemory(
  agentId: string,
  queryText: string,
  limits: { semantic?: number; recent?: number; total?: number } = {},
  rc: AgentRuntimeClient = runtime,
  scope: { projectIds?: readonly string[]; conversationIds?: readonly string[] } = {},
): Promise<MemoryRow[]> {
  return rc.loadMemory(agentId, queryText, limits, scope)
}

async function loadContext(
  agentId: string,
  conversationIds: string[],
  rc: AgentRuntimeClient = runtime,
): Promise<ContextRow[]> {
  return rc.loadContext(agentId, conversationIds)
}

async function loadClimate(
  agentId: string,
  rc: AgentRuntimeClient = runtime,
): Promise<ClimateRow[]> {
  return rc.loadClimate(agentId)
}

interface ReactionSummary { emoji: string; users: string[] }

interface ContextRow extends InboxRow {
  is_unread: boolean
  is_self: boolean
  conversation_topic: string | null
  project_name: string | null
  reactions: ReactionSummary[]
}

interface MemoryRow {
  id: string
  kind: string
  about: string | null
  body: string
  pinned: boolean
  created_at: string
}

function renderMemory(rows: MemoryRow[]): string {
  if (rows.length === 0) return '(no memories saved yet — use `cumora memory note "..." --about <subject>` to remember things across conversations)'
  const lines: string[] = []
  for (const m of rows) {
    const star = m.pinned ? '★ ' : '  '
    const about = m.about ? `[about ${m.about}] ` : ''
    const kind = m.kind ? `(${m.kind}) ` : ''
    lines.push(`  ${star}${kind}${about}${m.body}`)
  }
  return lines.join('\n')
}

interface ClimateRow {
  about_id: string
  affinity: number
  trust: number
  last_note: string
  updated_at: string
}

/** "+0.42" / "-0.12" / "0.00" — easier on the eye than raw floats. */
function fmtBipolar(n: number): string {
  if (!Number.isFinite(n)) return '0.00'
  const sign = n > 0 ? '+' : (n < 0 ? '' : ' ')
  return `${sign}${n.toFixed(2)}`
}

function renderClimate(rows: ClimateRow[]): string {
  if (rows.length === 0) return '(no climate read yet — your impressions of teammates are blank slate)'
  return rows.map((r) =>
    `  ${r.about_id.padEnd(10)}  affinity=${fmtBipolar(r.affinity)}  trust=${fmtBipolar(r.trust)}  ·  ${r.last_note.slice(0, 180).replace(/\n/g, ' \\n ')}`,
  ).join('\n')
}

/** Render the wake-context block shown to a poll-author agent when the
 *  scheduler wakes them on poll.updated. Different copy for the
 *  in-progress phase ("vote") vs the terminal phase ("close") — the
 *  former invites nudging stragglers, the latter invites a summary. */
function renderPollUpdateWakeContext(brief: PollWakeBrief, renderedContext: string): string {
  const phaseLabel = brief.phase === 'close'
    ? (brief.closedReason === 'expired'
        ? 'CLOSED · expired at the deadline'
        : 'CLOSED · explicitly closed')
    : (brief.expiresAt
        ? `OPEN · expires ${brief.expiresAt}`
        : 'OPEN · no deadline')
  const winner = brief.tallies.reduce<{ optionId: string; count: number } | null>(
    (best, t) => (t.count > 0 && (!best || t.count > best.count) ? { optionId: t.optionId, count: t.count } : best),
    null,
  )
  const tallyLines = brief.tallies.map((t) => {
    const pct = brief.totalVotes > 0 ? Math.round((t.count / brief.totalVotes) * 100) : 0
    const winMark = winner && winner.optionId === t.optionId && t.count > 0 ? ' ★' : ''
    const voterTxt = t.voters.length === 0
      ? '(no voters)'
      : t.voters.map((v) => v.name).join(', ')
    return `  • [${t.count.toString().padStart(2, ' ')} · ${pct.toString().padStart(3, ' ')}%]${winMark} ${t.text}\n      voters: ${voterTxt}`
  }).join('\n')
  const pendingTxt = brief.pending.length === 0
    ? '(everyone in the room has voted)'
    : brief.pending.map((p) => `${p.name} (id: ${p.id})`).join(', ')
  const actorLine = brief.actor.id
    ? `Triggered by: ${brief.actor.name ?? brief.actor.id} (id: ${brief.actor.id})`
    : 'Triggered by: the expiration sweeper (poll deadline hit)'

  const phaseGuidance = brief.phase === 'close'
    ? `The poll YOU posted has closed. Decide whether the room benefits from a short summary:
- If there's a clear outcome (a winner, a clean split, a surprise), post ONE concise reply in the same conversation with \`cumora reply ${brief.conversationId} '<one or two lines>'\`. Share what you make of it — not just the numbers. Read the recent thread above to land the tone right.
- If the result is obvious to everyone already (3 votes for one option, nobody voted for the other), a 🎉 or 👍 reaction on the poll message (\`cumora react ${brief.messageId} 🎉\`) is often plenty.
- If no one voted, don't pretend the poll mattered. Acknowledge briefly or stay silent.
- Do NOT repost the raw numbers; the bubble already shows them.`
    : `Votes are still coming in for the poll YOU posted. Decide whether the room benefits from a nudge right now:
- If at least one person in \`pending\` is someone you'd expect a vote from AND enough time has passed since you posted, a SHORT nudge is fair game (\`cumora reply ${brief.conversationId} '<one line>'\`). Address them by name; don't @everyone. Don't repeat the question — they can see it.
- If nudging would feel pushy (poll posted seconds ago, casual topic, voluntary participation), stay silent. Real people don't poke for every vote.
- DO NOT post a summary while the poll is still open.
- DO NOT vote on your own poll just to pad the count.
- If you don't think a reaction is warranted, \`set_turn_status({ status: "done", reason: "watching poll — nothing to say yet", next_step: "" })\`.`

  return `You just got woken because your poll moved. This is NOT a new chat message addressed to you — the scheduler is showing you the live tally so you can decide whether to nudge, summarize, or stay quiet.

📊 Your poll · ${phaseLabel} · ${brief.mode}-choice
   message id: ${brief.messageId}
   question: ${brief.question}
   total votes so far: ${brief.totalVotes}
${tallyLines}

Pending voters (in the conversation, haven't voted): ${pendingTxt}
${actorLine}

The conversation around the poll (so you can land your tone right):
${renderedContext}

${phaseGuidance}

If you want fuller voter detail (e.g. who switched their vote), run \`cumora poll show ${brief.messageId}\`. Do not call \`cumora poll close\` here unless you genuinely want to end an open poll early.`
}

/** True iff `body` contains an `@all` broadcast token — i.e. the author is
 *  explicitly addressing everyone in the room, not just whoever they were
 *  replying to. Negative-lookahead on `[\w-]` keeps us from matching
 *  participant ids like `@allison` or `@all-team`. Case-insensitive because
 *  the picker inserts lower-case but humans paste anything. */
const ALL_MENTION_RE = /(?<![\w@])@all(?![\w-])/i
export function hasAllMention(body: string): boolean {
  return ALL_MENTION_RE.test(body)
}

/** Did the LLM call fail because the upstream provider hit a rate / quota
 *  ceiling? Matches sub2api's local 429 (per-user daily ChatGPT-OAuth quota,
 *  returns 4-6ms with no body) as well as OpenAI-direct 429s. Used to mark
 *  the turn `skipped` (not `failed`) and surface a user-visible system
 *  notice in the affected conversations, so silence doesn't read as a bug. */
function isQuotaExhaustedError(err: unknown): boolean {
  const errObj = err as { status?: number; code?: string } | undefined
  if (errObj && typeof errObj.status === 'number' && errObj.status === 429) return true
  const text = errorText(err).toLowerCase()
  if (text.includes('429')) return true
  if (text.includes('rate_limit') || text.includes('rate limit')) return true
  if (text.includes('quota') && (text.includes('exceeded') || text.includes('exhausted'))) return true
  return false
}

function isModelProviderConnectionText(text: string): boolean {
  return text.includes('connection error') ||
    text.includes('terminated') ||
    text.includes('socket') ||
    text.includes('econnreset') ||
    text.includes('und_err') ||
    text.includes('fetch failed')
}

function isModelProviderConnectionError(err: unknown): boolean {
  return isModelProviderConnectionText(errorText(err).toLowerCase())
}

const MODEL_PROVIDER_CONNECTION_RETRY_LIMIT = 2
const MODEL_PROVIDER_CONNECTION_RETRY_BASE_MS = 500

/** Defense-in-depth hard cap on `agent_turn_failed` system notices per
 *  (agent, conversation) per rolling hour. The dedupe key was supposed to
 *  prevent runaway cascades on its own, but if anything ever leaks (a future
 *  caller forgetting to filter system messages out of the input fingerprint,
 *  for example), this cap means at worst N notices per agent-convo per hour
 *  instead of the 200+ that "Everyone" hit when the cascade fired untrapped.
 *  Excess attempts still record an observability event so the underlying
 *  failure cause is preserved in the audit trail. */
const FAILURE_NOTICE_HOURLY_CAP = 3

function modelProviderConnectionRetryDelayMs(retryCount: number): number {
  const backoff = MODEL_PROVIDER_CONNECTION_RETRY_BASE_MS * (2 ** Math.max(0, retryCount - 1))
  return backoff + Math.floor(Math.random() * 250)
}

function agentTurnFailureNoticeReason(summary: string, err?: string | null): string {
  const text = `${summary}\n${err ?? ''}`.toLowerCase()
  if (text.includes('missing turn-status') || text.includes('protocol')) return 'turn-status protocol violation'
  if (text.includes('auto-relay')) return 'reply delivery error'
  if (text.includes('max_hops') || text.includes('max hops') || text.includes('cap_reached')) return 'turn limit reached'
  if (isModelProviderConnectionText(text)) return 'model provider connection error'
  return 'runtime error'
}

/** Did the LLM call fail because OpenAI couldn't fetch one of our `image_url`s?
 *  Matches both the direct OpenAI 400 ("Error while downloading <url>...") and
 *  the sub2api-wrapped 502 that preserves that text in its upstream-error
 *  payload. Used by the strip-and-retry path to know it's safe to re-send
 *  without images instead of bubbling a permanent failure. */
function isImageFetchFailure(err: unknown): boolean {
  const text = errorText(err).toLowerCase()
  if (text.includes('error while downloading')) return true
  if (text.includes('invalid_image_url')) return true
  if (text.includes('image_url') && (text.includes('failed') || text.includes('invalid'))) return true
  return false
}

/** Return a copy of `input` with every `input_image` content block dropped.
 *  Used after an image-fetch failure: the descriptive `input_text` lines
 *  stay (so the model still knows WHO/WHAT was attached), the unfetched
 *  pixels go away. */
function stripImageInputs(input: ResponseInputItem[]): ResponseInputItem[] {
  return input.map((item) => {
    const i = item as unknown as { role?: string; content?: unknown }
    if (i.role !== 'user' || !Array.isArray(i.content)) return item
    const filtered = (i.content as Array<{ type?: string }>).filter((c) => c.type !== 'input_image')
    return { ...item, content: filtered } as unknown as ResponseInputItem
  })
}

/** Resolve a message URL to something OpenAI's input_image can fetch. */
function publicUrlFor(url: string): string {
  if (/^https?:\/\//.test(url)) return url
  // Local /uploads/<file> — make it absolute against the server's public host.
  // For dev we prefer a real reachable URL; if PUBLIC_HOST isn't set we fall back
  // to localhost which OpenAI obviously can't fetch — in that case we'll skip
  // input_image at the call site.
  const base = env.PUBLIC_HOST ?? ''
  if (!base) return url
  return base.replace(/\/+$/, '') + url
}

interface TrustedAttachmentSource {
  key: string
  url: string
  mode: 'local' | 'r2'
}

/** Resolve message content exclusively from Cumora storage. The persisted URL
 *  is presentation data and must never select a server-side fetch target;
 *  regenerate it from the validated key and fail closed for legacy/external
 *  references. External image links remain visible in text context, but are
 *  deliberately not downloaded by this process. */
async function trustedAttachmentSource(att: InboxAttachment): Promise<TrustedAttachmentSource | null> {
  const key = messageAttachmentStorageKey(att, env.R2_PUBLIC_BASE)
  if (!key) return null
  try {
    const { storage } = await import('../storage.js')
    return { key, url: await storage.publicUrl(key), mode: storage.mode }
  } catch {
    return null
  }
}

/** Render context per conversation — full recent thread with a clear boundary
 *  marking what's NEW since the agent last looked. Includes the agent's own
 *  past messages so they can self-judge "I already said that". Also surfaces
 *  "rounds since last human" so agents can sense when a thread is winding
 *  down without a human re-engaging. */
/** Format a timestamp in the server's local timezone as "HH:mm" so every
 *  agent sees the same wall-clock numbers as the user. (Was previously
 *  rendering UTC via toISOString, which caused agents to disagree about
 *  what time it actually is.) */
function localHHmm(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const h = String(date.getHours()).padStart(2, '0')
  const m = String(date.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function cleanSystemText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

function renderRecurrence(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const r = value as { freq?: unknown; interval?: unknown; byweekday?: unknown; until?: unknown; count?: unknown }
  if (typeof r.freq !== 'string') return null
  const interval = Number.isFinite(Number(r.interval)) ? Math.max(1, Math.floor(Number(r.interval))) : 1
  const parts = [`every ${interval} ${r.freq}${interval === 1 ? '' : 's'}`]
  if (Array.isArray(r.byweekday) && r.byweekday.length > 0) {
    parts.push(`weekdays=${r.byweekday.join(',')}`)
  }
  if (typeof r.until === 'string' && r.until.trim()) parts.push(`until=${r.until}`)
  if (r.count !== null && r.count !== undefined) parts.push(`count=${String(r.count)}`)
  return parts.join(', ')
}

function systemPayloadKind(raw: string): string | null {
  try {
    const p = JSON.parse(raw) as { kind?: unknown }
    return typeof p.kind === 'string' ? p.kind : null
  } catch {
    return null
  }
}

function renderCalendarSystemBody(p: {
  kind?: string
  eventId?: unknown
  eventKind?: unknown
  title?: unknown
  description?: unknown
  agentPrompt?: unknown
  assigneeId?: unknown
  targetConversationId?: unknown
  scheduledFor?: unknown
  startAt?: unknown
  endAt?: unknown
  allDay?: unknown
  recurrence?: unknown
  createdBy?: unknown
}): string {
  const title = cleanSystemText(p.title) ?? 'Untitled calendar event'
  const description = cleanSystemText(p.description)
  const agentPrompt = cleanSystemText(p.agentPrompt)
  const instruction = agentPrompt ?? title
  const recurrence = renderRecurrence(p.recurrence)
  const lines = [
    '[calendar:event] A Calendar event is due. Use the event fields below as the scheduled brief.',
    'Reason from the brief and choose what to do using the same judgement you use for any teammate request.',
    `Event title: ${title}`,
  ]
  if (typeof p.eventId === 'string' && p.eventId.trim()) lines.push(`Event id: ${p.eventId}`)
  if (typeof p.eventKind === 'string' && p.eventKind.trim()) lines.push(`Event kind: ${p.eventKind}`)
  if (typeof p.scheduledFor === 'string' && p.scheduledFor.trim()) lines.push(`Scheduled occurrence: ${p.scheduledFor}`)
  if (typeof p.startAt === 'string' && p.startAt.trim()) lines.push(`Starts: ${p.startAt}`)
  if (typeof p.endAt === 'string' && p.endAt.trim()) lines.push(`Ends: ${p.endAt}`)
  if (typeof p.allDay === 'boolean') lines.push(`All day: ${p.allDay ? 'yes' : 'no'}`)
  if (recurrence) lines.push(`Recurrence: ${recurrence}`)
  if (typeof p.assigneeId === 'string' && p.assigneeId.trim()) {
    lines.push(`Assignee: @${p.assigneeId}`)
  }
  if (typeof p.targetConversationId === 'string' && p.targetConversationId.trim()) lines.push(`Target conversation: ${p.targetConversationId}`)
  if (typeof p.createdBy === 'string' && p.createdBy.trim()) lines.push(`Created by: ${p.createdBy}`)
  lines.push('Event description:')
  lines.push(description ?? '(none)')
  lines.push('Event brief:')
  lines.push(instruction)
  if (!agentPrompt) {
    lines.push('(No separate agent prompt was set; use the event title as the brief.)')
  }
  return lines.join('\n')
}

/** System rows (membership changes etc.) ship as JSON in `body`. Translate
 *  to a short natural-language fragment so the agent reads what happened
 *  instead of staring at raw `{"kind":"kicked",...}` payloads. */
function renderSystemBody(raw: string): string {
  try {
    const p = JSON.parse(raw) as {
      kind?: string
      participantId?: string
      actorId?: string
      noticeKind?: string
      text?: string
    }
    // `kind: 'notice'` is a free-form provider-side notice (quota exhausted,
    // provider down, etc.) — no participantId, just a text body. Surfacing
    // these to the agent prompt lets it know its earlier turn never landed
    // (so it doesn't loop forever expecting a response that never came).
    if (p.kind === 'notice' && typeof p.text === 'string') {
      const tag = p.noticeKind ? `[system:${p.noticeKind}]` : '[system:notice]'
      return `${tag} ${p.text}`
    }
    if (p.kind === 'calendar_event') {
      return renderCalendarSystemBody(p)
    }
    if (!p.kind || !p.participantId) return '[system]'
    switch (p.kind) {
      case 'joined':
        return p.actorId && p.actorId !== p.participantId
          ? `[system] ${p.actorId} added ${p.participantId} to the group`
          : `[system] ${p.participantId} joined the group`
      case 'left':
        return `[system] ${p.participantId} left the group`
      case 'kicked':
        return p.actorId
          ? `[system] ${p.actorId} removed ${p.participantId} from the group`
          : `[system] ${p.participantId} was removed from the group`
      default:
        return `[system] ${p.kind}`
    }
  } catch {
    return cleanSystemText(raw) ?? '[system]'
  }
}

function renderContext(
  ctx: ContextRow[],
  unreadCount: number,
  convoCount: number,
  textExcerpts: Map<string, TextExcerpt> = new Map(),
  viewerAgentId: string = '',
): string {
  if (ctx.length === 0) return '(your inbox is empty)'
  const byConvo = new Map<string, ContextRow[]>()
  for (const it of ctx) {
    if (!byConvo.has(it.conversation_id)) byConvo.set(it.conversation_id, [])
    byConvo.get(it.conversation_id)!.push(it)
  }
  // How many UNREAD messages from others contain @all? Surfaced in the
  // header so the agent can tell at a glance "I have N broadcasts to triage,
  // not just N passing mentions". System rows are excluded — they fire the
  // pattern spuriously in announcements ("joined all hands").
  const broadcastUnread = ctx.filter((m) =>
    m.is_unread && !m.is_self && m.kind !== 'system' && hasAllMention(m.body),
  ).length
  const lines: string[] = [
    `${unreadCount} unread message(s)${broadcastUnread > 0 ? `, ${broadcastUnread} with @all (broadcast — addressed to everyone including YOU)` : ''} across ${convoCount} conversation(s). Recent context per conversation (your own past replies are tagged ▸ME so you can see what you've already said):`,
    '',
  ]
  for (const [convoId, msgs] of byConvo) {
    const head = msgs[0]
    // Count agent messages since the most recent human message in the visible
    // window — a simple "is this thread getting too chatty without human
    // re-engagement" heat indicator. Author kind comes from the joined
    // participants row (loadContext SQL), so this works for any human id,
    // not just the three the dev seed used.
    let lastHumanIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].author_kind === 'human') { lastHumanIdx = i; break }
    }
    const agentMsgsSinceHuman = lastHumanIdx >= 0 ? msgs.length - 1 - lastHumanIdx : msgs.length
    const hasUnreadCalendarDispatch = msgs.some((m) =>
      m.is_unread && m.kind === 'system' && systemPayloadKind(m.body) === 'calendar_event',
    )
    let header = `# ${convoId}  [${head.conversation_kind}]  "${head.conversation_title}"`
    if (hasUnreadCalendarDispatch) {
      header += `  📅 Calendar event due in NEW messages`
    } else if (lastHumanIdx >= 0 && agentMsgsSinceHuman >= 3) {
      header += `  ⚠ ${agentMsgsSinceHuman} agent message(s) since last human reply — the thread is winding down without human re-engagement; lean toward silence unless you have something genuinely new to add`
    } else if (lastHumanIdx < 0) {
      header += `  ⚠ no human has spoken in the visible window — only chime in if you have a clear distinct angle`
    }
    lines.push(header)
    if (head.project_name) {
      lines.push(`  Project: ${head.project_name}`)
    }
    if (head.conversation_topic) {
      lines.push(`  Topic: ${head.conversation_topic}`)
    }
    let boundaryDrawn = false
    for (const m of msgs) {
      if (m.is_unread && !boundaryDrawn) {
        lines.push(`  ─── ↓ NEW since your last visit ↓ ───`)
        boundaryDrawn = true
      }
      const t = localHHmm(m.created_at)
      const body = m.kind === 'tool'
        ? '[tool call]'
        : m.kind === 'system'
          ? renderSystemBody(m.body)
          : m.body.slice(0, 400).replace(/\n/g, ' \\n ')
      const tag = m.is_self ? '▸ME' : '   '
      let line = `  [${m.id}] ${tag} ${t}  ${m.author_name}: ${body}`
      // Inline broadcast tag — same line so the LLM can't miss it while
      // skimming, and so a flurry of replies underneath doesn't visually
      // separate the @all flag from the message it belongs to.
      if (!m.is_self && m.kind !== 'system' && hasAllMention(m.body)) {
        line += `  📣 [broadcast: @all]`
      }
      // Quote-direction tag — same line, right next to the body so a
      // peer-eavesdropping agent can't miss that this message is
      // directed at someone specific. The point: in groups, a
      // quote-reply is a soft 1:1 address. Agents who aren't the
      // quote target keep treating it as a general group message and
      // chime in unprompted; this puts the address signal in the
      // glance-zone of the wake prompt.
      if (m.quoted_message_id && m.quoted && !m.is_self) {
        if (viewerAgentId && m.quoted.authorId === viewerAgentId) {
          line += `  ↦ addressed to YOU (quote-reply)`
        } else {
          line += `  ↦ addressed to ${m.quoted.authorName} (quote-reply — not you; stay quiet unless your angle differs)`
        }
      }
      if (m.reactions && m.reactions.length > 0) {
        const summary = m.reactions
          .map((r) => `${r.emoji}×${r.users.length} (${r.users.join(', ')})`)
          .join('  ')
        line += `   ⟨${summary}⟩`
      }
      if (m.attachment) {
        const a = m.attachment
        line += ` [attachment: ${a.kind} "${a.name}" ${a.url}]`
      }
      lines.push(line)
      // Reply context: render the quoted-original right below so the LLM
      // sees BOTH the reply and what it's replying to. `↩ quoting [id]
      // author: body` mirrors how the human UI shows the quote card above
      // the bubble.
      if (m.quoted_message_id) {
        if (m.quoted) {
          const qBody = m.quoted.body.slice(0, 200).replace(/\n/g, ' \\n ')
          lines.push(`    ↩ quoting [${m.quoted.id}] ${m.quoted.authorName}: ${qBody}`)
        } else {
          lines.push(`    ↩ quoting [${m.quoted_message_id}] (original deleted)`)
        }
      }
      // Inline the text-file content below the message line so the LLM
      // actually READS the file rather than just noting it exists.
      const excerpt = textExcerpts.get(m.id)
      if (excerpt) {
        lines.push(`    ▼ file content (${m.attachment?.name ?? 'attachment'}${excerpt.truncated ? ', truncated' : ''}):`)
        lines.push(`    \`\`\`${excerpt.lang}`)
        for (const ln of excerpt.text.split('\n')) lines.push(`    ${ln}`)
        lines.push('    ```')
      }
    }
    if (!boundaryDrawn) {
      lines.push(`  (no new messages in this conversation — context only)`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/* ─── Text-file extraction for agent context ─────────────────────────
 * When a user (or another agent) attaches a text-like file, we fetch up to
 * MAX_TEXT_ATTACHMENT_BYTES of bytes and inject them directly into the
 * agent's wake prompt as a fenced code block. This is the difference
 * between "an agent NOTICES Alice sent me a config.yaml" and "an agent
 * actually READS the config.yaml" — Skype-like behaviour.
 */
const MAX_TEXT_ATTACHMENT_BYTES = 50_000  // 50 KB per file
const TEXT_LIKE_MIMES = new Set([
  'application/json', 'application/x-yaml', 'application/x-toml',
])

/** Return a short fence language label for a mime, used purely as a hint
 *  for syntax highlighting on the agent's side. */
function langFromMime(mime: string, name: string): string {
  if (mime === 'application/json') return 'json'
  if (mime === 'text/markdown') return 'md'
  if (mime === 'text/csv') return 'csv'
  if (mime === 'text/html') return 'html'
  if (mime === 'application/x-yaml') return 'yaml'
  if (mime === 'application/x-toml') return 'toml'
  // Last resort — pull a hint from the file extension.
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
  if (['ts','js','py','go','rs','sh','sql','yml','yaml','toml','md','json','csv'].includes(ext)) return ext
  return ''
}

interface TextExcerpt { lang: string; text: string; truncated: boolean }

/** Read a single text-like attachment, returning at most MAX_TEXT_ATTACHMENT_BYTES.
 *  Returns null for non-text mimes or fetch failures — callers fall back to
 *  the "[attachment: file ...]" pointer-only line. */
async function readTextAttachment(att: InboxAttachment): Promise<TextExcerpt | null> {
  const mime = (att.mime ?? '').toLowerCase()
  const looksTextual = mime.startsWith('text/') || TEXT_LIKE_MIMES.has(mime)
  if (!looksTextual) return null

  const source = await trustedAttachmentSource(att)
  if (!source) return null
  let buf: Buffer | null = null
  if (source.mode === 'local') {
    // Local-mode file — read straight from disk to avoid a needless HTTP hop.
    try {
      const { readFile } = await import('node:fs/promises')
      const { resolve, sep } = await import('node:path')
      const { UPLOAD_DIR } = await import('../storage.js')
      const root = resolve(UPLOAD_DIR)
      const path = resolve(root, source.key)
      if (!path.startsWith(`${root}${sep}`)) return null
      const data = await readFile(path)
      buf = Buffer.from(data)
    } catch {
      return null
    }
  } else {
    // R2 URL was minted from the validated key above. Reject redirects so a
    // compromised/misconfigured storage edge cannot pivot to a private host.
    if (!/^https?:\/\//.test(source.url)) return null
    try {
      const r = await fetch(source.url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      })
      if (!r.ok) return null
      buf = Buffer.from(await r.arrayBuffer())
    } catch {
      return null
    }
  }
  if (!buf) return null
  const truncated = buf.length > MAX_TEXT_ATTACHMENT_BYTES
  const sliced = truncated ? buf.subarray(0, MAX_TEXT_ATTACHMENT_BYTES) : buf
  return {
    lang: langFromMime(mime, att.name),
    text: sliced.toString('utf8'),
    truncated,
  }
}

/** Load text excerpts for every text-like attachment in the inbox in
 *  parallel. Returns a Map keyed by message id so renderContext can
 *  inline the content under the matching line. */
async function loadTextExcerpts(items: InboxRow[]): Promise<Map<string, TextExcerpt>> {
  const out = new Map<string, TextExcerpt>()
  const work: Array<Promise<void>> = []
  for (const m of items) {
    if (!m.attachment) continue
    work.push(readTextAttachment(m.attachment).then((ex) => {
      if (ex) out.set(m.id, ex)
    }))
  }
  await Promise.all(work)
  return out
}

/** Pull every image attachment out of the inbox so we can pass them as input_image.
 *  Re-signs URLs just-in-time so OpenAI's fetch from the Worker side doesn't
 *  hit an expired HMAC. */
async function collectImageAttachments(items: InboxRow[]): Promise<Array<{ messageId: string; url: string; name: string }>> {
  const out: Array<{ messageId: string; url: string; name: string }> = []
  for (const m of items) {
    const a = m.attachment
    if (!a || a.kind !== 'img' || !a.url) continue
    const source = await trustedAttachmentSource(a)
    if (!source) continue
    const url = publicUrlFor(source.url)
    // Only ship images OpenAI can actually fetch. Local /uploads paths without
    // a PUBLIC_HOST get textually mentioned but not vision-fed.
    if (!/^https?:\/\//.test(url)) continue
    out.push({ messageId: m.id, url, name: a.name })
  }
  return out
}

/**
 * Pull avatar portrait URLs for every participant the agent will see in this
 * wake (everyone who spoke in the visible context, plus the agent themselves).
 * Lets the LLM literally SEE who it's talking to / who's in the room.
 * Skips participants without an AI-generated portrait, and skips local URLs
 * when no PUBLIC_HOST is configured (OpenAI can't fetch localhost).
 */
async function loadFaces(participantIds: string[]): Promise<Array<{ id: string; name: string; role: string | null; url: string }>> {
  const rows = await runtime.loadFaces(participantIds)
  const out: Array<{ id: string; name: string; role: string | null; url: string }> = []
  for (const r of rows) {
    if (!r.avatar_url) continue
    const url = publicUrlFor(r.avatar_url)
    if (!/^https?:\/\//.test(url)) continue
    out.push({ id: r.id, name: r.name, role: r.role, url })
  }
  return out
}

/**
 * Per-agent fingerprint of the most recent inbox the agent completed against.
 * If a wake fires but the inbox is unchanged (same message IDs), we skip the
 * LLM call — nothing has changed in the agent's world since they last
 * considered it. We update this only after a successful run; failed / stalled
 * turns must be retryable instead of silently skipped forever.
 *
 * This replaces the old auto-ack-everything behavior. Skipping autoAck means
 * an agent who chose not to reply still sees those messages on the next wake
 * (now augmented with whatever peers said in the meantime), giving them a
 * second chance to decide — exactly like a human who reads a Slack message,
 * doesn't reply, and then 30s later sees a teammate's reply and decides to
 * chime in or react.
 */
const lastCompletedInbox = new Map<string, string>()

/** Maximum LLM hops per turn. Raised 4 → 8 → 100 → 200 as we kept
 *  hitting real production cases where models needed long tool chains
 *  (Iris's video-download incident at 4-hop; multi-step research tasks
 *  past 100-hop). 200 is essentially "no cap" for any realistic task;
 *  the LLM-summarized auto-compaction path below handles cost /
 *  context-window pressure by ACTUALLY SUMMARIZING earlier work, not
 *  truncating it. */
const MAX_HOPS = 200

/** Per-hop tool output bound before it is fed back to the model. This is not
 * the semantic compaction path; it is a last-mile safety valve so a single
 * enormous CLI result cannot explode the next Responses input. Keep the output
 * self-describing instead of silently slicing JSON. */
const MODEL_TOOL_OUTPUT_BYTES = 8_000

function utf8Head(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let lo = 0
  let hi = value.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) lo = mid
    else hi = mid - 1
  }
  return value.slice(0, lo)
}

function modelToolOutputPayload(value: unknown): string {
  const raw = JSON.stringify(value) ?? String(value)
  const originalBytes = Buffer.byteLength(raw, 'utf8')
  if (originalBytes <= MODEL_TOOL_OUTPUT_BYTES) return raw
  for (const headBytes of [7_000, 6_000, 5_000, 4_000, 3_000, 2_000, 1_000]) {
    const payload = JSON.stringify({
      truncated: true,
      originalBytes,
      head: utf8Head(raw, headBytes),
      note: 'Tool output was shortened by the turn runtime before model input; use a narrower CLI query if the omitted tail matters.',
    })
    if (Buffer.byteLength(payload, 'utf8') <= MODEL_TOOL_OUTPUT_BYTES) return payload
  }
  return JSON.stringify({
    truncated: true,
    originalBytes,
    head: '',
    note: 'Tool output was shortened by the turn runtime before model input; use a narrower CLI query if the omitted tail matters.',
  })
}

/** Token thresholds for auto-compaction.
 *
 *  When the previous hop's total usage exceeds `COMPACT_THRESHOLD_TOKENS`,
 *  we compact `history` BEFORE issuing the next hop's LLM call:
 *  - oversized function_call_output content gets truncated in place
 *    (the model still sees the call_id ↔ output linkage, just not the
 *    full payload)
 *  - if still over budget, oldest hop-pairs (function_call +
 *    matching function_call_output) get dropped as a unit so call_id
 *    pairing is preserved
 *  - a synthetic compaction-marker message replaces what was dropped
 *    so the model knows earlier work happened
 *
 *  `HARD_LIMIT_TOKENS` is the absolute ceiling beyond which compaction
 *  CAN'T rescue the turn (every hop pair is recent + every output is
 *  already terse). At that point we break the loop and let the next
 *  wake start fresh — same as the old `CONTEXT_BUDGET_TOKENS` break,
 *  but it's now the rare failure rather than the common path. */
/** Approximate context windows by model family. We pick the model's
 *  window dynamically so a smaller-context model (gpt-5.4-mini at 128K)
 *  compacts at the right point — a hardcoded 150K threshold on a 128K
 *  model would NEVER trigger and the turn would just hit the hard
 *  ceiling and die. Unknown / unspecified models fall back to 200K.
 *
 *  Numbers come from each model's published max input tokens. Slight
 *  underestimates (round-down) so we leave headroom for the response
 *  tokens that follow the prompt. */
function contextWindowFor(model: string | null): number {
  const m = (model ?? '').toLowerCase()
  if (m.includes('gpt-5.4-mini')) return 128_000
  if (m.includes('gpt-5.4-nano')) return 64_000
  if (m.includes('gpt-5')) return 200_000             // gpt-5.5, 5.4, 5.3, 5.2 — all ~200K input
  if (m.includes('gpt-4o')) return 128_000
  if (m.includes('gpt-4-turbo')) return 128_000
  return 200_000
}

/** Soft compaction threshold: 75% of the model's context window. Past
 *  this point we trigger an LLM-summarized compaction pass — earlier
 *  tool-call pairs are SUMMARIZED into a concise paragraph, NOT just
 *  dropped, so the agent retains semantic continuity across very long
 *  turns. */
function compactThresholdFor(model: string | null): number {
  return Math.floor(contextWindowFor(model) * 0.75)
}

/** Absolute ceiling: 95% of the model's context window. Even after
 *  compaction, if the projected input STILL exceeds this — typically
 *  only when the original user input itself is huge (a giant
 *  attachment dump) — we break the loop and let the next wake start
 *  fresh. Should be ultra-rare in practice. */
function hardLimitFor(model: string | null): number {
  return Math.floor(contextWindowFor(model) * 0.95)
}
// `COMPACTED_OUTPUT_BYTES` + `KEEP_RECENT_PAIRS` live in turn-compaction.ts
// — turn.ts only needs the token budgets above.

/**
 * Cap how many messages per conversation we render into the wake prompt. The
 * agent can run \`cumora inbox\` (or \`cumora messages <convo_id> --tail N\`)
 * to read more if needed — we don't have to pre-load everything.
 */
const _MAX_MESSAGES_PER_CONVO_IN_PROMPT = 30

const TRACE_TEXT_LIMIT = 24_000

function traceText(text: string): { text: string; length: number; truncated: boolean } {
  const truncated = text.length > TRACE_TEXT_LIMIT
  return {
    text: truncated ? `${text.slice(0, TRACE_TEXT_LIMIT)}…` : text,
    length: text.length,
    truncated,
  }
}

function traceInboxMessage(m: InboxRow): Record<string, unknown> {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    conversationTitle: m.conversation_title,
    conversationKind: m.conversation_kind,
    authorId: m.author_id,
    authorName: m.author_name,
    kind: m.kind,
    sequence: m.sequence,
    createdAt: m.created_at,
    body: traceText(m.body),
    attachment: m.attachment
      ? {
          name: m.attachment.name,
          kind: m.attachment.kind,
          mime: m.attachment.mime,
          url: m.attachment.url,
        }
      : null,
    quotedMessageId: m.quoted_message_id,
    quoted: m.quoted
      ? {
          id: m.quoted.id,
          authorId: m.quoted.authorId,
          authorName: m.quoted.authorName,
          body: traceText(m.quoted.body),
        }
      : null,
  }
}

function traceContentPart(part: unknown): Record<string, unknown> {
  const raw = (part ?? {}) as Record<string, unknown>
  const type = String(raw.type ?? 'unknown')
  if (type === 'input_text' || type === 'output_text') {
    return { type, text: traceText(String(raw.text ?? '')) }
  }
  if (type === 'input_image') {
    return {
      type,
      imageUrl: raw.image_url,
      detail: raw.detail,
    }
  }
  return { ...raw, type }
}

function traceInputItem(item: ResponseInputItem): Record<string, unknown> {
  const raw = item as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (raw.type) out.type = raw.type
  if (raw.role) out.role = raw.role
  if (raw.call_id) out.callId = raw.call_id
  if (typeof raw.output === 'string') out.output = traceText(raw.output)
  else if (raw.output !== undefined) out.output = raw.output

  if (Array.isArray(raw.content)) {
    out.content = raw.content.map(traceContentPart)
  } else if (typeof raw.content === 'string') {
    out.content = traceText(raw.content)
  } else if (raw.content !== undefined) {
    out.content = raw.content
  }
  return out
}

function traceInput(items: ResponseInputItem[]): Record<string, unknown>[] {
  return items.map(traceInputItem)
}

function traceToolDefinitions(): Record<string, unknown>[] {
  return TOOL_DEFS_RESPONSES.map((tool) => ({
    type: tool.type,
    name: tool.name,
    description: traceText(tool.description ?? ''),
  }))
}

function traceResponseOutputItem(item: unknown): Record<string, unknown> {
  const raw = (item ?? {}) as Record<string, unknown>
  const type = String(raw.type ?? 'unknown')
  if (type === 'message' && Array.isArray(raw.content)) {
    return {
      id: raw.id,
      type,
      role: raw.role,
      status: raw.status,
      content: raw.content.map(traceContentPart),
    }
  }
  if (type === 'function_call') {
    const rawArguments = String(raw.arguments ?? '')
    return {
      id: raw.id,
      type,
      name: raw.name,
      callId: raw.call_id,
      arguments: parseToolArgs(rawArguments),
      rawArguments: traceText(rawArguments),
      status: raw.status,
    }
  }
  if (type === 'reasoning') {
    return {
      id: raw.id,
      type,
      summary: raw.summary,
      status: raw.status,
    }
  }
  return { ...raw, type }
}

function parseToolArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function isTurnStatusValue(value: unknown): value is TurnStatusValue {
  return typeof value === 'string' && (TURN_STATUS_VALUES as readonly string[]).includes(value)
}

function turnStatusOutput(value: unknown): TurnStatusOutput | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as {
    status?: unknown
    reason?: unknown
    nextStep?: unknown
    next_step?: unknown
    assistantTextAction?: unknown
    assistant_text?: unknown
    replyConversationId?: unknown
    reply_conversation_id?: unknown
  }
  if (!isTurnStatusValue(raw.status)) return null
  return {
    status: raw.status,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    nextStep: typeof raw.nextStep === 'string'
      ? raw.nextStep
      : (typeof raw.next_step === 'string' ? raw.next_step : ''),
    assistantTextAction: raw.assistantTextAction === 'reply' || raw.assistantTextAction === 'drop' || raw.assistantTextAction === 'none'
      ? raw.assistantTextAction
      : (raw.assistant_text === 'reply' || raw.assistant_text === 'drop' || raw.assistant_text === 'none' ? raw.assistant_text : 'none'),
    replyConversationId: (typeof raw.replyConversationId === 'string'
      ? raw.replyConversationId
      : (typeof raw.reply_conversation_id === 'string' ? raw.reply_conversation_id : '')).trim() || null,
  }
}

function isTerminalTurnStatus(status: TurnStatusValue): boolean {
  return status === 'done' || status === 'waiting'
}

interface CompletionVerification {
  complete: boolean
  reason: string
  nextStep: string
}

function shouldVerifyTerminalCompletion(args: {
  inbox: InboxRow[]
  status: TurnStatusOutput
  postedReplyViaTool: boolean
  sideEffects: CliSideEffect[]
}): boolean {
  if (args.inbox.length === 0) return false
  if (!isTerminalTurnStatus(args.status.status)) return false
  if (args.postedReplyViaTool) return false
  // Non-reply side effects can be complete work (e.g. update a kanban card) or
  // only an acknowledgement (e.g. react with eyes before producing an image).
  // Let a model judge the exact context from the inbox + typed side effects.
  return args.sideEffects.length > 0
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim(),
    trimmed.match(/\{[\s\S]*\}/)?.[0],
  ].filter((v): v is string => Boolean(v))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next extraction shape.
    }
  }
  return null
}

function parseCompletionVerification(raw: string): CompletionVerification | null {
  const parsed = extractJsonObject(raw)
  if (!parsed) return null
  if (typeof parsed.complete !== 'boolean') return null
  const reason = String(parsed.reason ?? '').trim().slice(0, 800)
  const nextStep = String(parsed.next_step ?? parsed.nextStep ?? '').trim().slice(0, 800)
  return {
    complete: parsed.complete,
    reason: reason || (parsed.complete ? 'completion accepted' : 'completion rejected'),
    nextStep,
  }
}

function verifierSideEffects(effects: CliSideEffect[]): string {
  if (effects.length === 0) return '(none)'
  return JSON.stringify(effects.slice(-20), null, 2)
}

async function verifyTerminalCompletion(args: {
  persona: { name: string; model: string | null }
  tenant: string | null
  agentId: string
  renderedContext: string
  turnStatus: TurnStatusOutput
  sideEffects: CliSideEffect[]
}): Promise<CompletionVerification> {
  const client = await getLlmClient(args.tenant)
  // Completion verification is auxiliary judgment, not a real task — small model.
  const model = enforceModelPolicy(env.OPENAI_COMPACTION_MODEL || supportModel(), 'completion-verify')
  const instructions = `You are Cumora's turn-completion verifier. Decide whether agent "${args.persona.name}" may safely end this turn.

Use semantic judgment, not keyword rules. Read the actual conversation and the actual side effects. A reaction can be a valid lightweight response only when the human did not ask for a deliverable, answer, artifact, image, file, external action, or status report that remains missing. If the human asked for work and the side effects only acknowledge it, completion is false.

Do not require this specific agent to repeat work already genuinely completed by another teammate in the visible context. Do require continuation when nobody has delivered the requested result or a clear user-visible failure/clarifying question.

Reply ONLY as JSON: {"complete":boolean,"reason":"short factual reason","next_step":"what the agent should do next if incomplete, otherwise empty"}.`
  const VERIFIER_TIMEOUT_MS = 10_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('completion verifier timed out')), VERIFIER_TIMEOUT_MS)
  // Stream-local ledger state. We record EXACTLY ONCE at the natural end of
  // the stream (success path) or in the catch (failure path) — never twice.
  const t0 = Date.now()
  let usage: TokenUsage | null = null
  let reasoning = 0
  let recorded = false
  const record = (status: 'ok' | 'rate_limited' | 'timeout' | 'failed', error?: string) => {
    if (recorded) return
    recorded = true
    void recordLlmCall({
      purpose: 'completion-verify', companyId: args.tenant, agentId: args.agentId,
      model, usage, reasoningTokens: reasoning,
      latencyMs: Date.now() - t0, status, error,
    })
  }
  try {
    const stream = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'Conversation context visible to the agent:',
                args.renderedContext.slice(0, 24_000),
                '',
                'Agent terminal status declaration:',
                JSON.stringify(args.turnStatus, null, 2),
                '',
                'World side effects produced during this turn:',
                verifierSideEffects(args.sideEffects),
                '',
                'May the runtime accept this terminal status, or must the same agent continue the turn?',
              ].join('\n'),
            },
          ],
        },
      ],
      stream: true,
      max_output_tokens: 500,
      reasoning: { effort: 'low' },
      signal: ctrl.signal,
    } as unknown as Parameters<typeof client.responses.create>[0])

    let collected = ''
    for await (const ev of stream as AsyncIterable<ResponseStreamEvent>) {
      if (ctrl.signal.aborted) throw new Error('completion verifier aborted')
      const u = readStreamUsage(ev as unknown as { type?: string } & Record<string, unknown>)
      if (u) { usage = u; reasoning = readStreamReasoningTokens(ev as unknown as { type?: string } & Record<string, unknown>) }
      if (ev.type === 'response.output_text.delta') {
        collected += (ev as unknown as { delta: string }).delta
      } else if (ev.type === 'response.output_text.done') {
        collected = (ev as unknown as { text: string }).text || collected
      }
    }
    const verdict = parseCompletionVerification(collected)
    if (!verdict) throw new Error(`completion verifier returned invalid JSON: ${collected.slice(0, 500)}`)
    record('ok')
    return verdict
  } catch (err) {
    record(classifyLlmCallError(err), err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Render a slice of ResponseInputItems into a flat human-readable
 *  block for the summarizer LLM. We deliberately keep this terse —
 *  the summarizer doesn't need the full JSON shape, just the gist of
 *  what tools ran and what came back. Capped at 32K chars to keep the
 *  summarization call cost bounded; older items past the cap get
 *  elided with a count line. */
function formatItemsForSummary(items: ResponseInputItem[]): string {
  const MAX_BYTES = 32_000
  const lines: string[] = []
  let elided = 0
  for (const item of items) {
    const r = item as unknown as Record<string, unknown>
    const type = String(r?.type ?? 'unknown')
    let line = ''
    if (type === 'function_call') {
      const name = String(r.name ?? '?')
      const callId = String(r.call_id ?? '?')
      const args = String(r.arguments ?? '')
      line = `function_call ${name} (call_id=${callId})\n  args: ${args.slice(0, 600)}`
    } else if (type === 'function_call_output') {
      const callId = String(r.call_id ?? '?')
      const out = String(r.output ?? '')
      line = `function_call_output (call_id=${callId})\n  output: ${out.slice(0, 1200)}`
    } else if (type === 'item_reference') {
      // These are bookkeeping only — they don't carry user-visible
      // content. Skip them in the summary input so we don't waste
      // tokens.
      continue
    } else {
      // message items inserted by previous compaction passes, etc.
      line = `${type}: ${JSON.stringify(r).slice(0, 600)}`
    }
    if (lines.join('\n\n').length + line.length > MAX_BYTES) {
      elided += 1
      continue
    }
    lines.push(line)
  }
  if (elided > 0) lines.push(`[+${elided} more item${elided === 1 ? '' : 's'} elided to fit the summarizer's input budget]`)
  return lines.join('\n\n')
}

/** Ask the LLM to produce a concise summary of the to-be-compacted
 *  portion of history. One round-trip; result is spliced into history
 *  as a synthetic message that replaces the dropped items.
 *
 *  Same client as the turn-loop's main LLM call (per-tenant via
 *  getLlmClient → sub2api), same model. The prompt explicitly asks
 *  for an "actionable continuation note" rather than narrative prose
 *  so the agent reading it can immediately resume. */
async function summarizeHistoryItems(
  itemsToDrop: ResponseInputItem[],
  persona: { name: string; model: string | null },
  tenant: string | null,
  agentId: string,
): Promise<string> {
  const flattened = formatItemsForSummary(itemsToDrop)
  if (flattened.length === 0) return '(no earlier work to summarize)'
  const client = await getLlmClient(tenant)
  // Prefer OPENAI_COMPACTION_MODEL when configured — auto-compaction is
  // a one-shot summarization pass and lets the operator route it to a
  // cheaper model without affecting the agent's main reasoning quality.
  // Falls back to the agent's own model so unset == "current behavior".
  // Summarizing earlier tool work is auxiliary, not a real task — small model.
  const model = enforceModelPolicy(env.OPENAI_COMPACTION_MODEL || supportModel(), 'compaction')
  const instructions = `You are summarizing earlier tool work that agent "${persona.name}" did during a single turn, so the agent can continue without seeing the raw history. Write a concise, factual "what I've done so far" note (≤ 800 words) that includes:

- Which tools were called, and what each returned (paths, IDs, key strings, error messages — keep the SPECIFIC data, not the generalities)
- What was learned or decided as a result
- Anything the agent should remember to do NEXT

Skip narrative framing. No headings, no bullet symbols unless they aid clarity. Plain paragraphs. Treat the output as a private memo to your future self.`
  const t0 = Date.now()
  let usage: TokenUsage | null = null
  let reasoning = 0
  let recorded = false
  // Pre-compaction size as a local estimate — the operator can compare this
  // against output_tokens to see "the summarizer ate 50K tokens of context
  // and produced 800 tokens of memo, that's a 60× compression on this turn".
  // estimateTokens is the same heuristic the 75%-budget guard uses, so the
  // number here is consistent with what triggered the compaction in the
  // first place.
  const inputCharsBefore = flattened.length
  const inputTokensBefore = estimateTokens(flattened)
  const record = (status: 'ok' | 'rate_limited' | 'timeout' | 'failed', error?: string) => {
    if (recorded) return
    recorded = true
    void recordLlmCall({
      purpose: 'compaction', companyId: tenant, agentId,
      model, usage, reasoningTokens: reasoning,
      latencyMs: Date.now() - t0, status, error,
      extras: { itemsDropped: itemsToDrop.length, inputCharsBefore, inputTokensBefore },
    })
  }
  try {
    const stream = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `Earlier tool calls and outputs for this turn (${itemsToDrop.length} items):\n\n${flattened}` },
          ],
        },
      ],
      stream: true,
      max_output_tokens: 1500,
      reasoning: { effort: 'low' },
    } as unknown as Parameters<typeof client.responses.create>[0])

    let collected = ''
    for await (const ev of stream as AsyncIterable<ResponseStreamEvent>) {
      const u = readStreamUsage(ev as unknown as { type?: string } & Record<string, unknown>)
      if (u) { usage = u; reasoning = readStreamReasoningTokens(ev as unknown as { type?: string } & Record<string, unknown>) }
      if (ev.type === 'response.output_text.delta') {
        collected += (ev as unknown as { delta: string }).delta
      } else if (ev.type === 'response.output_text.done') {
        collected = (ev as unknown as { text: string }).text || collected
      }
    }
    const text = collected.trim()
    if (!text) throw new Error('empty summary from LLM')
    record('ok')
    return text
  } catch (err) {
    record(classifyLlmCallError(err), err instanceof Error ? err.message : String(err))
    console.warn(`[turn] ${agentId} summarizeHistoryItems failed:`, err instanceof Error ? err.message : err)
    throw err
  }
}

/** Render a small batch of steered messages verbatim into a single
 *  user `input_text` item. Used for batches at or below
 *  STEER_SUMMARIZE_THRESHOLD where the model benefits from exact
 *  wording (1–3 messages: short clarifications, corrections,
 *  redirections).
 *
 *  When `draftAssistantText` is non-empty, the rendered item also
 *  includes the model's would-be answer that we interrupted —
 *  framed as "you were about to send X, then this arrived." Without
 *  this the model would lose memory of what it just said (each
 *  Responses API hop is stateless), so it might re-derive the same
 *  answer or get confused about whether it spoke yet. */
function renderSteerBatchVerbatim(
  batch: SteerItem[],
  draftAssistantText?: string | null,
): string {
  const lines: string[] = []
  const draft = (draftAssistantText ?? '').trim()
  if (draft) {
    lines.push('[Mid-turn update — you were about to send the following reply, but new input arrived first]')
    lines.push('')
    lines.push('Your draft answer (not yet sent):')
    lines.push(draft)
    lines.push('')
    lines.push(`New messages from the user (${batch.length}):`)
  } else {
    lines.push(`[Mid-turn update — ${batch.length} new message${batch.length === 1 ? '' : 's'} received while you were working]`)
    lines.push('')
  }
  // Each item is tagged with the conversation it came from. Without this
  // the model sees "@yetone: 接龙" floating with no context and tends to
  // post the reply into whichever conversation it was last engaged with
  // — exactly the cross-conv steer confusion we ran into when a DM
  // arrived while a group idiom-chain task was pending.
  lines.push(batch.map((s) => `@${s.authorName} (in conversation ${s.conversationId}):\n${s.body}`).join('\n\n'))
  lines.push('')
  lines.push(
    'Re-assess your current plan in light of these and continue. CRITICAL — ' +
    'each new message above is tagged "(in conversation <id>)". When you reply, ' +
    'use `cumora reply <that exact id> ...` so the response lands in the ' +
    'conversation it came FROM, not the conversation you were just working in. ' +
    'If the new message is in a DIFFERENT conversation than your pending ' +
    'task, you have TWO responsibilities: (a) respond to the new message ' +
    'in its own conversation, and (b) finish or update your earlier task ' +
    'in its own conversation — do NOT post the earlier task\'s answer into ' +
    'the new conversation. If they supersede earlier instructions, follow ' +
    'the most recent. Do NOT re-send your draft verbatim if the new input ' +
    'changes the answer.',
  )
  return lines.join('\n')
}

/** Truncated-verbatim fallback for when the summarizer call fails.
 *  Without this, a 30-item batch falls back to dumping all 30 raw
 *  bodies — exactly the failure mode summarizing was meant to
 *  prevent. Show the first 5 verbatim and elide the rest with a
 *  count, so the model sees enough texture without a context blow-
 *  up. The full bodies are still in the messages table; the agent
 *  can re-read them via a tool if needed. */
function renderSteerBatchTruncated(
  batch: SteerItem[],
  draftAssistantText?: string | null,
): string {
  const KEEP = 5
  const head = batch.slice(0, KEEP)
  const elided = batch.length - head.length
  const baseRender = renderSteerBatchVerbatim(head, draftAssistantText)
  if (elided === 0) return baseRender
  return `${baseRender}\n\n[plus ${elided} more message${elided === 1 ? '' : 's'} elided — summarizer unavailable, full text still in conversation history]`
}

/** Summarize a larger steer batch through the cheap-model summarizer.
 *  Mirrors the auto-compaction summarizer (uses
 *  OPENAI_COMPACTION_MODEL when set; falls back to persona.model).
 *  On any failure, callers fall back to the TRUNCATED-verbatim render
 *  — NOT a full verbatim of the batch (which would be the exact
 *  context blow-up summarizing exists to prevent). */
async function summarizeSteerBatch(
  batch: SteerItem[],
  persona: { name: string; model: string | null },
  tenant: string | null,
  agentId: string,
  draftAssistantText?: string | null,
): Promise<string> {
  const flattened = batch.map((s) => `@${s.authorName} in ${s.conversationId}:\n${s.body}`).join('\n\n---\n\n')
  const client = await getLlmClient(tenant)
  // Digesting a mid-turn steer batch is auxiliary, not a real task — small model.
  const model = enforceModelPolicy(env.OPENAI_COMPACTION_MODEL || supportModel(), 'steer-summary')
  const draft = (draftAssistantText ?? '').trim()
  const draftBlock = draft
    ? `\n\nThe agent was ABOUT TO SEND this reply when the new messages arrived:\n---\n${draft}\n---\nFlag explicitly if any new message changes the answer they were about to give.`
    : ''
  const instructions = `You are summarizing a batch of ${batch.length} messages that arrived during agent "${persona.name}"'s current turn. They didn't see these in real time; you're producing a concise digest the agent will read mid-turn so they can react.

Style: ≤ 250 words, plain text, factual. Preserve direct asks ("please also do X", "@${persona.name} can you check Y") VERBATIM — paraphrasing loses meaning. Call out any reversed instructions, new constraints, or shifts in priority. No headings, no bullet symbols unless they aid clarity.

CRITICAL — each input message is tagged "@<author> in <conversation_id>". Your summary MUST preserve that conversation_id with every direct ask, e.g. "@yetone (in c-xyz) asks: …". Multiple conversations can be steered into the same batch; the agent needs to reply to each ask in its OWN conversation, not bunched into whichever conversation it was last working in.

Treat the output as a private memo that will be appended to the agent's input. End with one short sentence telling the agent what to do next given everything you summarized — and if more than one conversation is represented, explicitly list the conversation_ids that need a reply.${draftBlock}`
  // Bounded timeout so a hung summarizer (slow upstream, stalled
  // stream) doesn't block the hop indefinitely. The hop loop is
  // single-threaded — every second we wait here is a second the user
  // waits for a response. 10s is roughly the budget for "≤ 250 word"
  // output on a fast cheap model.
  const SUMMARIZER_TIMEOUT_MS = 10_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('steer summarizer timed out')), SUMMARIZER_TIMEOUT_MS)
  const t0 = Date.now()
  let usage: TokenUsage | null = null
  let reasoning = 0
  let recorded = false
  const record = (status: 'ok' | 'rate_limited' | 'timeout' | 'failed', error?: string) => {
    if (recorded) return
    recorded = true
    void recordLlmCall({
      purpose: 'steer-summary', companyId: tenant, agentId,
      model, usage, reasoningTokens: reasoning,
      latencyMs: Date.now() - t0, status, error,
      extras: { batchSize: batch.length, hadDraft: !!draft },
    })
  }
  try {
    const stream = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `New messages received during the turn (${batch.length} items):\n\n${flattened}` },
          ],
        },
      ],
      stream: true,
      max_output_tokens: 600,
      reasoning: { effort: 'low' },
      signal: ctrl.signal,
    } as unknown as Parameters<typeof client.responses.create>[0])

    let collected = ''
    for await (const ev of stream as AsyncIterable<ResponseStreamEvent>) {
      if (ctrl.signal.aborted) throw new Error('steer summarizer aborted')
      const u = readStreamUsage(ev as unknown as { type?: string } & Record<string, unknown>)
      if (u) { usage = u; reasoning = readStreamReasoningTokens(ev as unknown as { type?: string } & Record<string, unknown>) }
      if (ev.type === 'response.output_text.delta') {
        collected += (ev as unknown as { delta: string }).delta
      } else if (ev.type === 'response.output_text.done') {
        collected = (ev as unknown as { text: string }).text || collected
      }
    }
    const text = collected.trim()
    if (!text) throw new Error('empty summary from LLM')
    record('ok')
    const header = draft
      ? `[Mid-turn update — summary of ${batch.length} new messages; you were about to send a reply, see if it still applies]`
      : `[Mid-turn update — summary of ${batch.length} new messages]`
    return `${header}\n\n${text}`
  } catch (err) {
    record(classifyLlmCallError(err), err instanceof Error ? err.message : String(err))
    console.warn(`[turn] ${agentId} summarizeSteerBatch failed; falling back to TRUNCATED verbatim:`,
      err instanceof Error ? err.message : err)
    return renderSteerBatchTruncated(batch, draftAssistantText)
  } finally {
    clearTimeout(timer)
  }
}

export async function runAgentTurn(agentId: string, options: AgentTurnOptions = {}): Promise<void> {
  const persona = await runtime.loadPersona(agentId)
  if (!persona) return

  const inbox = await loadInbox(agentId)
  const isIdleWake = options.trigger === 'idle' && inbox.length === 0
  const isBackgroundScanWake = options.trigger === 'background_scan' && Boolean(options.backgroundBrief)
  const isPollUpdateWake = options.trigger === 'poll.updated' && Boolean(options.pollBrief)
  if (inbox.length === 0 && !isIdleWake && !isBackgroundScanWake && !isPollUpdateWake) return

  const fingerprint = isIdleWake
    ? `idle:${new Date().toISOString()}`
    : isBackgroundScanWake
      ? `background_scan:${options.backgroundBrief?.source ?? 'scanner'}:${new Date().toISOString()}`
    : isPollUpdateWake
      ? `poll:${options.pollBrief?.messageId}:${options.pollBrief?.phase}:${options.pollBrief?.totalVotes ?? 0}:${new Date().toISOString()}`
    : inbox.map((m) => m.id).join(',')
  const convoIds = [...new Set([
    ...inbox.map((m) => m.conversation_id),
    // Poll-update wakes don't have an inbox row of their own — the
    // poll author already read the original poll message. Fold the
    // poll's conversation in so loadContext + markThinking + the
    // recentConvo typing indicator still target the right room.
    ...(isPollUpdateWake && options.pollBrief?.conversationId
      ? [options.pollBrief.conversationId]
      : []),
  ])]
  // Drop a "thinking" claim on every convo we're about to process so
  // peer agents who run `cumora glance` can see we're composing. The
  // claim auto-expires (TTL 60s) — explicit cleanup happens in the
  // finally block below. Best-effort: peekThinking is decorative,
  // not load-bearing, so a failed mark just means peers can't see us.
  if (convoIds.length > 0) {
    void runtime.markThinking(agentId, convoIds, 60).catch(() => { /* logged inside */ })
  }
  let runCompanyId = inbox.find((m) => m.company_id)?.company_id ?? null
  if (!runCompanyId && convoIds[0]) {
    runCompanyId = await runtime.getConversationCompanyId(convoIds[0])
  }
  runCompanyId ??= persona.companyId
  const runId = await runtime.createRun({
    agentId,
    companyId: runCompanyId,
    trigger: {
      source: options.trigger ?? 'scheduler',
      conversationIds: convoIds,
      idle: isIdleWake ? { reason: options.idleReason ?? 'idle heartbeat' } : undefined,
      backgroundScan: isBackgroundScanWake
        ? {
            source: options.backgroundBrief?.source ?? 'scanner',
            title: options.backgroundBrief?.title ?? 'Background scan',
          }
        : undefined,
      pollUpdate: isPollUpdateWake && options.pollBrief
        ? {
            messageId: options.pollBrief.messageId,
            phase: options.pollBrief.phase,
            status: options.pollBrief.status,
            totalVotes: options.pollBrief.totalVotes,
          }
        : undefined,
    },
    inputMessageIds: inbox.map((m) => m.id),
    inboxCount: inbox.length,
    fingerprint,
  })
  let finalStatus: AgentRunStatus = 'completed'
  let finalSummary = ''
  let finalError: string | null = null
  let recentConvo: string | undefined
  let recentConvoCompanyId: string | undefined
  let triageNote = options.triageNote?.trim() ?? ''
  let preloadedContext: ContextRow[] | null = null
  let typingStarted = false
  let totalTokensThisTurn = 0
  // Cache-aware usage SUMMED across every model hop of this turn (totalTokensThisTurn
  // tracks only the last hop, for the budget guard; this is for the cost ledger).
  let turnUsage: TokenUsage = { ...EMPTY_USAGE }
  let missingUsageHopCount = 0
  let toolCallCount = 0
  // Plain assistant text emitted by the model is only a draft; Cumora users
  // do not see it unless the agent sends it with `cumora reply` or explicitly
  // declares a relay target through `set_turn_status`.
  let pendingAssistantText = ''
  // Did the CLI report a visible reply side effect during this turn? Used to
  // suppress auto-relay so we don't double-post when the model already replied
  // in hop N and then produced more assistant text in hop N+1.
  let postedReplyViaTool = false
  let replySideEffectChannelUnreliable = false
  let cliSideEffectsThisTurn: CliSideEffect[] = []
  let markInitialInboxReadOnCompletion = false
  // If the model tries to end a hop without declaring turn status, continue
  // the same turn and ask the main model to make that decision explicitly.
  let statusRequiredNudgeCount = 0
  // Main-model turn-status protocol. The runtime records the latest
  // declaration and never infers semantic completion from silence.
  let declaredTurnStatus: TurnStatusOutput | null = null
  // Why the hop loop exited. 'max_hops' = we hit MAX_HOPS while the model was
  // still mid-task — the failure mode where an agent says "I'll do X"
  // and then goes silent because the loop ran out of headroom. 'budget'
  // = the 75%-budget guard fired. Used to emit `turn.cap_reached` for
  // observability.
  let loopExitReason: 'max_hops' | 'budget' | 'turn_status' | 'protocol_violation' = 'max_hops'
  let statusHeartbeat: ReturnType<typeof setInterval> | null = null
  // Steering busy-lease heartbeat. The cumora-server reads
  // cumora:busy:<agentId> when a new user message lands to decide
  // between deliver-wake (idle agent → next turn picks it up) and
  // deliverSteer (busy agent → inject as a steer event). TTL is 5s
  // so a hard pod crash auto-clears; we renew every 2s.
  let busyHeartbeat: ReturnType<typeof setInterval> | null = null
  // Per-turn FS namespace — hydrated below if the turn actually runs
  // (skipped on fingerprint match). Committed back to agent_workspace
  // in the finally block, then torn down regardless of outcome.
  let namespace: FsNamespace | null = null
  const stopStatusHeartbeat = () => {
    if (!statusHeartbeat) return
    clearInterval(statusHeartbeat)
    statusHeartbeat = null
  }
  const stopBusyHeartbeat = () => {
    if (!busyHeartbeat) return
    clearInterval(busyHeartbeat)
    busyHeartbeat = null
  }
  const startBusyHeartbeat = () => {
    if (busyHeartbeat) return
    // Immediate write so the gap between turn-start and first interval
    // tick is closed.
    void runtime.recordBusyHeartbeat(agentId, 5)
    busyHeartbeat = setInterval(() => {
      void runtime.recordBusyHeartbeat(agentId, 5)
    }, 2_000)
    busyHeartbeat.unref?.()
  }
  const startStatusHeartbeat = (status: 'thinking' | 'working' | 'waiting') => {
    stopStatusHeartbeat()
    statusHeartbeat = setInterval(() => {
      void runtime.heartbeatStatus(agentId, status)
        .then(() => runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'status.heartbeat',
          level: 'debug',
          title: `Agent is still ${status}`,
          data: { status },
          stage: status,
        }))
        .catch((err) => console.error(`[turn] ${agentId} failed to heartbeat ${status}`, err))
    }, BUSY_STATUS_HEARTBEAT_MS)
    statusHeartbeat.unref?.()
  }
  let failureNoticePosted = false
  const postTurnFailureNotices = async (summary: string, err?: string | null): Promise<void> => {
    if (failureNoticePosted || inbox.length === 0) return
    failureNoticePosted = true
    const uniqueConvoIds = [...new Set(inbox.map((m) => m.conversation_id))]
    const reason = agentTurnFailureNoticeReason(summary, err)
    const noticeText = `Agent run failed before it could finish (${reason}). No result was produced.`
    const withNoticeTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      const timeoutMs = 5_000
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        return await Promise.race<T>([
          promise,
          new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    for (const convoId of uniqueConvoIds) {
      const convoInbox = inbox.filter((m) => m.conversation_id === convoId)
      const convoCompanyId = convoInbox.find((m) => m.company_id)?.company_id ?? runCompanyId
      // Dedupe failure notices by the REAL inputs (human/agent replies), NOT
      // by every message in the inbox — including system messages. Otherwise a
      // failure-notice posted by THIS turn (or another agent's failure notice
      // in the same convo) lands as a new inbox row for the next wake, which
      // changes inputKey → a fresh dedupe key → a fresh notice, and so on. With
      // N agents in a broadcast convo (e.g. "Everyone") all failing on the same
      // underlying cause, that cascade goes O(N²) and the convo gets 200+
      // (system) messages in seconds. Filtering system messages out of the key
      // makes "the same real input failed" dedupe properly regardless of how
      // many notices have piled up. Calendar-event system messages are valid
      // agent inputs elsewhere (see line 564), but they're not what a failure
      // notice should be keyed on either — the key is about the work the
      // agent was attempting, which is the non-system messages.
      const inputKey = convoInbox
        .filter((m) => m.kind !== 'system')
        .map((m) => m.id).sort().join(',') || fingerprint

      // Defense in depth: even if the dedupe key fix above leaks somehow
      // (e.g. a future caller forgets the system-message filter, or some other
      // failure path I don't see), refuse to post more than
      // FAILURE_NOTICE_HOURLY_CAP notices for this (agent, convo) pair in any
      // rolling hour window. Catastrophic loops capped at this number per
      // agent rather than 200+ per convo. The counter lives in Redis with a
      // 1h TTL — overshoots and observability fall through to the normal
      // event-recording path so we can still see what was failing.
      const capKey = `notice-cap:agent_turn_failed:${agentId}:${convoId}`
      const capCount = await redis.incr(capKey).catch(() => 0)
      // INCR returns the new value; expire only on the first hit of the bucket.
      if (capCount === 1) {
        await redis.expire(capKey, 3600).catch(() => undefined)
      }
      if (capCount > FAILURE_NOTICE_HOURLY_CAP) {
        await runtime.recordEvent({
          runId, agentId, companyId: convoCompanyId,
          kind: 'turn.failure_notice',
          level: 'warn',
          title: 'Agent failure notice suppressed by hourly cap',
          data: {
            conversationId: convoId,
            reason: agentTurnFailureNoticeReason(summary, err),
            inputMessageIds: convoInbox.map((m) => m.id),
            noticePosted: false,
            cappedAt: FAILURE_NOTICE_HOURLY_CAP,
            countInWindow: capCount,
          },
          stage: 'failed',
        }).catch(() => { /* observability best-effort */ })
        continue
      }
      try {
        const res = await withNoticeTimeout(runtime.postSystemNotice({
          conversationId: convoId,
          companyId: convoCompanyId,
          agentId,
          noticeKind: 'agent_turn_failed',
          text: noticeText,
          dedupeKey: `agent_turn_failed:${convoId}:${inputKey}`,
          dedupeTtlSec: 6 * 3600,
        }), `postSystemNotice(${convoId})`)
        await runtime.recordEvent({
          runId, agentId, companyId: convoCompanyId,
          kind: 'turn.failure_notice',
          level: res.posted ? 'warn' : 'debug',
          title: res.posted ? 'Posted agent failure notice' : 'Agent failure notice deduped',
          data: {
            conversationId: convoId,
            reason,
            inputMessageIds: convoInbox.map((m) => m.id),
            noticePosted: res.posted,
          },
          stage: 'failed',
        }).catch(() => { /* observability best-effort */ })
      } catch (noticeErr) {
        console.error(`[turn] ${agentId} failed to post failure notice in ${convoId}`, noticeErr)
      }
    }
  }
  const setAgentStatus = async (status: 'avail' | 'working' | 'thinking' | 'waiting' | 'resting') => {
    if (status === 'thinking' || status === 'working' || status === 'waiting') {
      startStatusHeartbeat(status)
    } else {
      stopStatusHeartbeat()
    }
    await runtime.setStatus(agentId, status)
  }

  // Steering: tracks every messageId we consumed via a mid-turn steer
  // drain. Used at turn end to advance conversation_reads so the next
  // wake's loadInbox doesn't surface them again.
  const steeredMessageIds = new Map<string, string>() // messageId → conversationId
  let steerSaturatedEmitted = false
  let steerByteCapEmitted = false

  try {
    // Steering: discard any stale items left over from a previous turn
    // — between turns, any steer that arrives is also in the messages
    // table, so the new turn's loadInbox covers it.
    resetSteerForAgent(agentId)
    // Start the busy-lease heartbeat as soon as we know we're going to
    // run. Even if we end up in the "fingerprint match → skip" branch
    // below, the lease lifetime is bounded by the 5s TTL anyway.
    startBusyHeartbeat()
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.started',
      title: isIdleWake
        ? 'Idle wake received'
        : `Wake received with ${inbox.length} unread message${inbox.length === 1 ? '' : 's'}`,
      data: {
        trigger: options.trigger ?? 'message.new',
        inboxCount: inbox.length,
        conversationIds: convoIds,
        messageIds: inbox.map((m) => m.id),
        messages: inbox.map(traceInboxMessage),
        idleReason: isIdleWake ? options.idleReason ?? 'idle heartbeat' : undefined,
        backgroundBrief: isBackgroundScanWake
          ? {
              source: options.backgroundBrief?.source ?? 'scanner',
              title: options.backgroundBrief?.title ?? 'Background scan',
              body: traceText(options.backgroundBrief?.body ?? ''),
            }
          : undefined,
      },
      stage: 'loading_inbox',
    })

    // Skip the LLM if this agent already completed exactly this inbox in their
    // previous wake. Failed turns do not update the fingerprint, so they remain
    // retryable instead of disappearing into a silent skip.
    if (lastCompletedInbox.get(agentId) === fingerprint) {
      finalStatus = 'skipped'
      finalSummary = 'Inbox unchanged since the last completed turn'
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.skipped',
        level: 'debug',
        title: finalSummary,
        data: { fingerprint },
        stage: 'skipped',
      })
      return
    }

    const shouldRunInboxTriage =
      inbox.length > 0 &&
      (options.trigger === undefined || options.trigger === 'message.new') &&
      !triageNote
    if (shouldRunInboxTriage) {
      preloadedContext = await loadContext(agentId, convoIds)
      const verdict = await classifyInboxTriage({
        agentId,
        companyId: runCompanyId,
        persona,
        inbox,
        context: preloadedContext,
      })
      const reason = verdict.reason.trim().slice(0, 500)
      if (!verdict.actionable) {
        finalStatus = 'skipped'
        finalSummary = `Inbox triage skipped wake: ${reason || 'not relevant'}`
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.skipped',
          level: 'debug',
          title: finalSummary,
          data: { source: verdict.source, reason, inboxCount: inbox.length, conversationIds: convoIds },
          stage: 'skipped',
        })
        return
      }
      triageNote = [
        `Small-brain inbox triage (relevant, ${verdict.source}): ${verdict.promptNote.trim()}`,
        reason ? `Reason: ${reason}` : '',
      ].filter(Boolean).join('\n')
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'triage.passed',
        title: 'Small-brain inbox triage passed',
        data: { source: verdict.source, reason, inboxCount: inbox.length, conversationIds: convoIds },
        stage: 'building_prompt',
      })
    }

    // Materialize the agent's workspace into a real on-disk directory
    // for the duration of this turn. The agent's bash + read_file /
    // write_file / edit_file tools all operate on this namespace; the
    // diff vs. its initial state is committed back to agent_workspace
    // in the `finally` below. See runtime/fs-namespace.ts.
    namespace = await hydrateFs(agentId, runId)
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'fs.hydrated',
      title: `FS namespace ready (${namespace.baseline.size} file${namespace.baseline.size === 1 ? '' : 's'})`,
      data: { rootDir: namespace.rootDir, fileCount: namespace.baseline.size },
      stage: 'building_prompt',
    })

    // Pull the recent thread of every conversation that has unread items, so the
    // LLM can see what has already been said (including its own past replies)
    // and avoid repeating itself.
  // Build the memory-retrieval query from what's actually waking the
  // agent up. For message wakes, use newest unread bodies. For idle
  // synthetic wakes, retrieve broad self/team memories without inventing
  // a fake message.
  const memoryQuery = (isBackgroundScanWake
    ? [
        options.backgroundBrief?.title ?? 'background scan',
        options.backgroundBrief?.body ?? '',
      ].join('\n')
    : isIdleWake
    ? [
        'idle heartbeat',
        options.idleReason ?? '',
        'recent commitments, team context, people to follow up with, unresolved work',
      ].join('\n')
    : isPollUpdateWake
    ? [
        'poll update',
        options.pollBrief?.question ?? '',
        options.pollBrief?.phase === 'close' ? 'poll closed — summary' : 'votes coming in — nudge laggards if helpful',
      ].join('\n')
    : inbox
        .slice(0, 12)
        .map((m) => m.body ?? '')
        .filter((s) => s.length > 0)
        .join('\n')
  ).slice(0, 4000)

  const [context, memory, climate, textExcerpts, skillsIndex] = await Promise.all([
    preloadedContext ? Promise.resolve(preloadedContext) : loadContext(agentId, convoIds),
    loadMemory(agentId, memoryQuery, {}, runtime, { conversationIds: convoIds }),
    loadClimate(agentId),
    loadTextExcerpts(inbox),
    runtime.loadSkillsIndex(agentId),
  ])
  await runtime.recordEvent({
    runId, agentId, companyId: runCompanyId,
    kind: 'context.loaded',
    title: 'Loaded conversation context, memory, climate, excerpts, and skills',
    data: {
      contextMessages: context.length,
      memoryItems: memory.length,
      climateItems: climate.length,
      textExcerpts: textExcerpts.size,
      skills: skillsIndex.length,
    },
    stage: 'building_prompt',
  })

  // SYNTHETIC WAKE GATE — idle / background_scan / poll.updated are unprompted
  // (no human waiting). Per the cost principle — EVERY big-brain wake passes a
  // cerebellum judgment first; avoid the big brain whenever possible — gate them
  // with the cheap small brain on the context+memory just loaded, DEFAULTING to
  // skip. An unprompted wake with nothing concrete to do then costs only this
  // gate, never the big brain. (Message/inbox wakes were already gated above.)
  if (isIdleWake || isBackgroundScanWake || isPollUpdateWake) {
    const signals = [
      memory.slice(0, 12)
        .map((m) => `• ${String((m as { body?: unknown }).body ?? '').replace(/\s+/g, ' ').slice(0, 200)}`)
        .filter((s) => s.length > 2).join('\n'),
      context.slice(-15)
        .map((m) => `  ${m.is_self ? '▸YOU ' : ''}${m.author_name} (${m.author_kind ?? '?'}): ${(m.kind === 'system' ? '[system]' : m.body).replace(/\s+/g, ' ').slice(0, 200)}`)
        .join('\n'),
    ].filter(Boolean).join('\n')
    const brief = isBackgroundScanWake
      ? `${options.backgroundBrief?.title ?? ''} ${options.backgroundBrief?.body ?? ''}`.trim()
      : isPollUpdateWake
        ? `${options.pollBrief?.question ?? 'poll updated'} (${options.pollBrief?.phase ?? ''})`
        : (options.idleReason ?? 'idle heartbeat')
    const gate = await gateSyntheticWake({
      companyId: runCompanyId,
      personaName: persona.name,
      kind: options.trigger as 'idle' | 'background_scan' | 'poll.updated',
      brief,
      signals,
    })
    if (!gate.act) {
      finalStatus = 'skipped'
      finalSummary = `Cerebellum gate skipped ${options.trigger ?? 'synthetic'} wake: ${gate.reason || 'nothing concrete to act on'}`
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.skipped',
        level: 'debug',
        title: finalSummary,
        data: { source: 'synthetic-wake-gate', trigger: options.trigger, reason: gate.reason },
        stage: 'skipped',
      })
      return
    }
  }

  const instructions = await runtime.buildSystemPrompt(agentId)
  if (!instructions) {
    finalStatus = 'skipped'
    finalSummary = 'No system prompt/persona instructions available'
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.skipped',
      level: 'warn',
      title: finalSummary,
      stage: 'skipped',
    })
    return
  }
  await runtime.recordEvent({
    runId, agentId, companyId: runCompanyId,
    kind: 'prompt.ready',
    title: 'System prompt ready',
    data: {
      model: persona.model ?? env.OPENAI_MODEL,
      toolCount: TOOL_DEFS_RESPONSES.length,
      instructions: traceText(instructions),
    },
    stage: 'thinking',
  })

  await setAgentStatus('thinking')
  await runtime.recordEvent({
    runId, agentId, companyId: runCompanyId,
    kind: 'status.changed',
    title: 'Agent status set to thinking',
    data: { status: 'thinking' },
    stage: 'thinking',
  })

  // For typing indicator: which conversations have unread? Show typing in the
  // most-recent one (best-effort UX hint that something's processing).
  recentConvo = inbox[inbox.length - 1]?.conversation_id
  if (recentConvo) {
    recentConvoCompanyId = runCompanyId ?? (await runtime.getConversationCompanyId(recentConvo)) ?? undefined
    await runtime.publishTyping({
      conversationId: recentConvo, agentId, done: false,
      companyId: recentConvoCompanyId,
    })
    typingStarted = true
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'typing.started',
      title: 'Typing indicator started',
      data: { conversationId: recentConvo },
    })
  }

  // Single source of truth for "what time is it" — every timestamp in the
  // wake prompt is rendered in this same local timezone, so agents agree on
  // the wall clock and don't disagree about what time it is.
  const now = new Date()
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone
  const nowStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${localHHmm(now)} (${tzName})`

  // ─── In-flight peer work ──────────────────────────────────────────
  // Read the tenant-scoped worklog so the agent SEES what peers are
  // currently doing before deciding whether to do the same thing.
  // Filter out their own claims — telling them about themselves is
  // noise. Rendered as a short block right above the conversation
  // context so it shows up in the same field of view as the inbox.
  let peerWorkBlock = ''
  if (runCompanyId) {
    try {
      const entries = await runtime.peekWorklog(`tenant:${runCompanyId}`)
      const peerEntries = entries.filter((e) => e.agentId !== agentId)
      if (peerEntries.length > 0) {
        const lines = peerEntries.map((e) => {
          const ageSec = Math.max(1, Math.round((Date.now() - e.startedAt) / 1000))
          const age = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`
          return `  - ${e.agentId} is ${e.taskType} on "${e.subject}" (started ${age})`
        })
        peerWorkBlock = [
          'In-flight peer work (your teammates are CURRENTLY doing these — do NOT duplicate; react / yield instead):',
          ...lines,
          '',
        ].join('\n')
      }
    } catch {
      // Best-effort visibility — Redis trouble shouldn't fail the
      // whole wake. Just skip the section.
    }
  }

  const renderedConversationContext = renderContext(context, inbox.length, convoIds.length, textExcerpts, agentId)
  const wakeContext = isPollUpdateWake && options.pollBrief
    ? renderPollUpdateWakeContext(options.pollBrief, renderedConversationContext)
    : isBackgroundScanWake
    ? `You just got an internal background scan brief. This is not a user chat message, and there is no obligation to interrupt anyone.

Brief: ${options.backgroundBrief?.title ?? 'Background scan'}
Source: ${options.backgroundBrief?.source ?? 'scanner'}

${options.backgroundBrief?.body ?? ''}

Default to doing nothing unless your own judgment says there is a concrete, timely reason to act. If you do act, use the normal Cumora tools yourself. If not, call set_turn_status({ status: "done", reason: "nothing worth initiating from background scan", next_step: "" }) and stay silent.`
    : isIdleWake
    ? `You just got woken up by an idle heartbeat, not by a new user message.

Reason: ${options.idleReason ?? 'idle heartbeat'}.

There is no new chat message demanding a reply. This is a chance to decide, as yourself, whether there is anything genuinely worth doing now.

Useful inspection commands before taking initiative:
  bash("cumora inbox")                         — check whether any unread chat appeared since this wake was scheduled
  bash("cumora groups")                        — see groups you can speak in
  bash("cumora conversations")                 — see conversations you belong to
  bash("cumora contacts")                      — see teammates, humans, and known email contacts
  bash("cumora email inbox --unread")          — check unread email
  bash("cumora email contacts")                — see email-capable contacts
  bash("cumora doc ls")                        — see live Documents

If something is genuinely worth initiating, use the normal Cumora tools: dm, reply in a group, pull a group, send/reply to email, update memory/climate, or work on a relevant artifact. If not, call set_turn_status({ status: "done", reason: "nothing worth initiating from idle", next_step: "" }) and stay silent.`
    : `You just got woken up because activity changed in one of your conversations. Read the recent thread in each:

${renderedConversationContext}`

  const wakePrompt = `Now: ${nowStr}. (When asked "what time is it", report this — every timestamp below is rendered in the same local timezone.)

What you remember (your private cross-conversation notes — these are part of you, treat them as your beliefs and commitments):
${renderMemory(memory)}

Climate around you (how you currently feel about the people you know — affinity ∈ [-1,1] is warmth/coolness, trust ∈ [-1,1] is reliability; both are YOUR private read, not theirs about you. Update with \`cumora climate note <about_id> "<note>" --affinity <n> --trust <n>\` when something noteworthy happens):
${renderClimate(climate)}

Your skills (progressive-disclosure capability packs you've installed in your workspace — these are NAMES + DESCRIPTIONS ONLY. When a task matches one, run \`cumora skills read <name>\` to pull the full instructions into your next turn. Create new ones with \`cumora skills create <name> "<description>"\`.):
${skillsIndex.length === 0
  ? '  (no skills installed yet)'
  : skillsIndex.map((s) => `  - ${s.name} — ${s.description}`).join('\n')}

${triageNote ? `Triage note:\n${triageNote}\n\n` : ''}${peerWorkBlock}${wakeContext}

Now decide — like a real teammate would. World actions use bash(); turn state uses set_turn_status():
  bash("cumora glance <convo_id>")                       — peek at the latest messages + who else is currently composing in this convo. Use this RIGHT BEFORE replying to a 📣 broadcast — peers may have just posted while you were thinking.
  bash("cumora reply <convo_id> '<body>'")               — post a reply to that conversation
  bash("cumora reply <convo_id> '<body>' --quote <message_id>")
                                                          — QUOTE the specific message you're responding to (its [m-…] id is shown next to each message above / in cumora glance). When you're answering someone's question, addressing their point, or reacting to what THEY said, PREFER quoting that message over a bare @mention — it threads your reply to its context so everyone sees what you're responding to. (@mention pings a person; --quote shows which message you're answering.)
  bash("cumora reply <convo_id> '<body>' --generate-image '<prompt>' [--size square|wide|tall]")
                                                          — generate an image (DALL·E-class) and post it as your reply's attachment. Caption goes in <body> if you want one; \`<body>\` can be empty.
  bash("cumora reply <convo_id> '' --attach-text 'name.md' '<content>'")
                                                          — save the content as a file (md/json/csv/txt/yaml/toml) and attach it. Use when the artifact IS the message (a doc, a snippet, structured data).
  bash("cumora reply <convo_id> '<body>' --attach-bytes 'name.pdf' --bytes-b64 '<base64>' [--bytes-mime '<mime>']")
                                                          — attach ANY file type by base64-encoding the bytes. Up to 32MB. Use for non-text artifacts you produced or fetched (PDFs, archives, audio, anything binary).
  bash("cumora doc ls")                                  — list live collaborative Documents
  bash("cumora doc read <document_id>")                  — read a Document as Markdown-like text
  bash("cumora doc create '<title>' --body '<markdown>'")
  bash("cumora doc append <document_id> '<markdown>'")   — write Markdown blocks (prose, headings, lists, code) to a Document.
  bash("cumora doc image <document_id> <url> --alt '<caption>' [--at end|start | --replace '<snippet>' | --after '<snippet>' | --before '<snippet>']")
                                                          — drop in an illustration. ALWAYS use this command for images rather than appending an \`![alt](url)\` markdown block — long presigned attachment URLs wrap onto multiple lines mid-emit and the markdown form silently falls back to plain text. Use \`--replace\` to swap a broken \`![alt](url)\` markdown line for a real image (pass enough of that line as the snippet to uniquely identify it). \`--after\`/\`--before\` position relative to a known paragraph. Default (no anchor) is end. An anchored mode that doesn't match is a HARD ERROR — no image gets inserted; re-read the doc and pick a more specific snippet. Generate the image first with \`cumora image generate\` to get the URL.
  bash("cumora doc image-delete <document_id> [--src <url> | --src-contains <substr> | --alt <text>]")
                                                          — remove image blocks from a doc. Use to clean up duplicate or unwanted illustrations (e.g. residue from earlier image inserts that fell back to end-of-doc before the no-fallback rule was added).
  bash("cumora react <message_id> 🌤️")                    — react instead of replying
  bash("cumora dm <agent_id> '<topic>' '<say>'")         — open a private 1-on-1 chat with another agent
  bash("cumora pull-group ...")                          — pull a fresh group. Agent-only pulls bypass cooldown; human-including pulls share a 6h cap.
  bash("cumora ack <convo_id>")                          — mark that conversation read without replying
  bash("cumora mute <convo_id> [--for 2h]")              — stand down from a noisy group. It stops wakes + inbox delivery; a direct @mention or a quote-reply to you still gets through. The command returns a receipt explaining the rule.
  bash("cumora follow <convo_id>")                        — resume normal delivery from a group you muted
  bash("cumora ship list")                                — inspect active feature contracts and evidence progress. Use ship show <id> for the full invariant/square/release/friction snapshot.
  bash("cumora ship friction <feature_id|none> '<title>' --description '...'")
                                                          — capture work that was repeatedly confusing, brittle, or harder than it should be; it lands in the shared Ship friction inbox.
  bash("cumora ship square <feature_id> <square_id> passed --evidence '...'")
                                                          — complete an independent verification square with durable evidence. The CLI refuses self-verification when you are one of the builders.
  bash("cumora invite <convo_id> <member_id>")           — pull a teammate into a group you're in. Posts a visible "joined" system row.
  bash("cumora leave <convo_id>")                        — leave a group (if you've drifted out of scope; not for direct chats)
  bash("cumora kick <convo_id> <member_id>")             — remove a teammate from a group you're in. Use with care; posts a visible system row.
  bash("cumora memory note '...' --about <id>")          — save a lesson for future you
  bash("cumora climate note <id> '...' --affinity n --trust n")  — update how you feel about a teammate
  bash("cumora avatar regen")                            — regenerate your OWN portrait from your current persona (image-gen call).
  bash("cumora avatar set <image_url>")                  — adopt an existing image URL as your portrait (e.g. an image the user just sent you, or one you generated separately). Re-uploaded to our CDN.
  bash("cumora skills list")                             — list your installed skills (name + description only)
  bash("cumora skills read <name>")                      — load a skill's full SKILL.md when a task calls for it
  bash("cumora skills create <name> '<description>'")    — scaffold a new skill (then edit the SKILL.md to flesh out instructions / examples / edge cases)
  bash("cumora skills search '<query>'")                 — search SkillHub for a skill that solves the task at hand
  bash("cumora skills install <id_or_url>")              — install a skill from SkillHub (or any URL returning a compatible manifest)
  bash("cumora calendar create '<title>' --at <iso> --assignee ${agentId} --prompt '<what future-you should do>' [--private]")
                                                          — SCHEDULE YOURSELF (or someone else). At <iso>, the assignee gets woken with <prompt> as their brief. Add \`--every daily|weekly|monthly|yearly\` (optionally \`--interval N\`, \`--byweekday 0,1,2\`, \`--until <iso>\`, \`--count N\`) to make it RECURRING. Use this whenever you'd otherwise say "I'll do X later / tomorrow / next Monday / every morning / every Friday at 5pm" — instead of telling the user you'll come back, schedule the wake so future-you actually comes back. Add \`--private\` for internal scratch reminders you don't want to clutter the shared workspace calendar — only you (and the workspace owner) will see it. Examples:
                                                            cumora calendar create 'Daily standup digest' --at 2026-05-24T09:00:00Z --assignee ${agentId} --prompt 'Summarize yesterday's group activity and post into <convo_id>' --every daily
                                                            cumora calendar create 'Follow up with Wei on hero v3' --at 2026-05-25T15:00:00Z --assignee ${agentId} --prompt 'DM wei and ask if v3 landed'
                                                            cumora calendar list --as ${agentId}                       — see what you've already scheduled
                                                            cumora calendar cancel <event_id>                        — stop a recurring schedule you no longer need
  set_turn_status({ status, reason, next_step, assistant_text?, reply_conversation_id? })
                                                        — declare your turn state. Use this before intentionally stopping and after major milestones.
  If there is truly nothing to do, call set_turn_status({ status: "done", reason: "nothing relevant to act on", next_step: "" }) and do not send a chat reply.

Behave like a real person on a chat app:
- ANNOUNCE BEFORE LONG OR VISIBLE-EFFECT WORK. Real teammates don't act in silence. Before any action that will keep the asker waiting >3-5s without visible output OR that produces a shared real-world artifact (creating a doc, generating an image, kicking off multi-step research, sending an email, pulling a new group, scheduling a calendar event), POST A SHORT INTENT MESSAGE first via \`cumora reply\` — one line, plain language, just enough that the room knows "I'm on it and here's roughly what I'm doing." Examples: "我去开个共享文档，把每人一段拼进去 — 给我 20 秒" / "Researching the API conventions, will report back in ~30s" / "Drafting the email now". THEN do the work. THEN reply with the actual result. Two reasons: (1) in a 1:1 or DM the user staring at silence is wondering whether you crashed; (2) in a group convo, your intent message becomes the typing indicator peers were missing — anyone about to do the same thing sees it and yields, preventing parallel collisions on a shared resource. The intent message must be a SEPARATE \`cumora reply\` call, NOT chained with \`&&\` to the actual tool call — peers can't see your intent until the message lands, and that takes a moment.
- 👀 alone is fine for trivial acknowledgement ("yes I saw it, no action needed"), but it is NOT a substitute for an intent message when you're about to do real work. If you 👀 and then go quiet for 30s while you compose a doc, the room thinks you bailed.
- If you use 👀 or a short "on it" message to acknowledge long work, keep going in this SAME turn. The acknowledgement is not the answer; finish the task and post a result or a clear failure.
- A 📅 Calendar event dispatch is a scheduled brief. Understand it, decide what a teammate would do, and use tools only when they naturally fit the brief.
- Read what's there, INCLUDING your own past replies (tagged ▸ME). If you've already said the angle you'd say now, stay quiet — repeating yourself is worse than silence.
- If a peer already covered what you'd say, react or skip. Don't restate it in your own words.
- If a human (yetone, wei, maya) addressed the group and nobody has answered yet, somebody should — but you don't HAVE to be that somebody every time. Read the room.
- WHEN A HUMAN-AUTHORED MESSAGE IN A GROUP CONVERSATION IS ADDRESSED TO THE WHOLE TEAM, you and every other agent likely woke at the same instant. "Addressed to the team" means the explicit 📣 [broadcast: @all] tag OR any human-authored group message whose wording is aimed at the group as a whole rather than one named person — a plural/collective address, or an imperative to the group as a unit. The rules below apply whenever you believe the human is talking to the team, even without @all.
${GLANCE_YIELD_RULES}
- IF A PEER HAS CLAIMED A CONCRETE TASK, STAY SILENT — even without an @all broadcast tag, even if you think your role gives you a unique angle on it. When the user posts a single executable directive in a group ("插入图片", "draft the email", "summarize this thread", "generate the chart", "你帮我把 X 弄一下") and ANY peer is already responding to it — their intent message has landed, OR \`cumora glance\` shows them composing, OR a tool call from them is in flight — the room only needs ONE response: the one that's executing. Piling on with your role's commentary while the task is being done is noise, not contribution. The user is waiting for the deliverable, not for five takes on what the deliverable should look like. This rule applies REGARDLESS of whether the message was classified as a broadcast — singular "你" addressed to the group, an imperative with no @-target, a casually-phrased "someone please do X", all count. Default action: stay silent (a 👀 reaction is fine if you want to acknowledge). Wait for the result. Add value ONLY AFTER the result lands, and ONLY if it's genuinely missing something you specifically can supply. "I would have said it differently" / "from my angle, also consider…" / "great, and don't forget…" — these are noise, not value. Acting like a real teammate means trusting peers to do their work without color commentary from the sidelines.
- DO NOT FLIP-FLOP. If you scan the visible context and see the room has already voted the SAME binary decision more than twice (e.g. "use doc A" → "actually use B" → "no use A" → "ok use B"), STOP voting. The conversation has degenerated into oscillation, and another flip from you makes it worse. Stay silent, react 👀, or post a single firm message ("I'll stop weighing in; let's commit to whatever was decided 30s ago and move on") — do not add another vote that just inverts the last one. Watch out for your own LLM tendency to agree with whatever you just read; resist it. Pick the earliest-stated consensus and hold it, even if a later message disagrees.
- If nothing in the new messages concerns your role and the conversation has wandered, it's fine to do nothing. You'll get another wake when something actually shifts.
- The conversation might naturally wind down. That's good. Real teams don't talk forever.

Mechanics:
- The cumora command is on PATH and runs as you (auto --as ${agentId}).
- Quote bodies with single quotes. Real newlines work — use \\n in the string and they'll become real line breaks.
- You may run multiple cumora commands in this turn (each is a separate bash() call).
- Before intentionally ending, call set_turn_status. Use status="done" only after the request is handled; status="continue" if more work remains; status="needs_clarification" when you need to ask a concrete question; status="blocked" when you need to report a clear failure; status="waiting" only when you have already taken an action and are truly waiting for an external response.
- Plain assistant text is a private draft, not a chat message. Prefer \`cumora reply\` for user-visible text. If you already produced a draft and want the runtime to relay that exact draft, set assistant_text="reply" and reply_conversation_id="<convo_id>"; otherwise use assistant_text="drop" or omit it.`

  // Pull faces for everyone who's appeared in the visible context, plus the
  // agent themselves — vision-capable LLMs literally see who they're talking
  // to. (Faces only ship if a public-reachable avatar URL exists.)
  const distinctSpeakers = [...new Set([
    agentId,
    ...context.map((m) => m.author_id),
  ])]
  const faces = await loadFaces(distinctSpeakers)

  // Build structured input — text wake prompt plus any image attachments as
  // input_image content items so vision-capable models can actually see them.
  // (We cast through unknown because the SDK's ResponseInputItem union is
  // narrower than the runtime API actually accepts for multimodal content.)
  const images = await collectImageAttachments(inbox)
  const userContent: Array<Record<string, unknown>> = [{ type: 'input_text', text: wakePrompt }]

  // Materialize every external image URL into a base64 `data:` URL *here*
  // before shipping it as `input_image`. OpenAI's Responses API fetches
  // `image_url` itself and fail-louds the *entire* request on any non-2xx —
  // one rotten CDN avatar bricked every turn that referenced it (incident
  // 2026-05-14: deterministic 502 loop). Doing the fetch in-process keeps
  // the failure domain local: we drop bad images and the turn still runs.
  // Strip-and-retry around the LLM call below is the residual safety net
  // for cases where our materialization succeeded but OpenAI still doesn't
  // accept the bytes (rare format issues, etc.).
  const [faceMats, imageMats] = await Promise.all([
    Promise.all(faces.map(async (f) => ({ f, mat: await materializeImage(f.url) }))),
    Promise.all(images.map(async (img) => ({ img, mat: await materializeImage(img.url) }))),
  ])

  if (faces.length > 0) {
    userContent.push({
      type: 'input_text',
      text: `\n— Faces in this conversation (so you know who you're talking to; the one tagged YOU is your own appearance):`,
    })
    for (const { f, mat } of faceMats) {
      const tag = f.id === agentId ? 'YOU · ' : ''
      const role = f.role ? ` (${f.role})` : ''
      userContent.push({ type: 'input_text', text: `↳ ${tag}${f.name}${role} — id: ${f.id}` })
      if (mat.ok) {
        userContent.push({ type: 'input_image', image_url: mat.dataUrl, detail: 'low' })
      }
    }
  }

  for (const { img, mat } of imageMats) {
    userContent.push({ type: 'input_text', text: `↳ image attached to message ${img.messageId} ("${img.name}"):` })
    if (mat.ok) {
      userContent.push({ type: 'input_image', image_url: mat.dataUrl, detail: 'auto' })
    }
  }

  const skippedImages = [
    ...faceMats.filter((x) => !x.mat.ok).map((x) => ({ url: x.f.url, kind: 'face' as const, reason: (x.mat as { reason: string }).reason })),
    ...imageMats.filter((x) => !x.mat.ok).map((x) => ({ url: x.img.url, kind: 'attachment' as const, reason: (x.mat as { reason: string }).reason })),
  ]
  if (skippedImages.length > 0) {
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'image.skipped',
      level: 'warn',
      title: `Skipped ${skippedImages.length} unreachable image${skippedImages.length === 1 ? '' : 's'}`,
      data: { skipped: skippedImages },
      stage: 'building_prompt',
    }).catch(() => { /* observability best-effort */ })
  }
  const input: ResponseInputItem[] = [
    { role: 'user', content: userContent } as unknown as ResponseInputItem,
  ]
  // We used to lean on OpenAI's stateful `previous_response_id` to thread
  // context across hops — send only the new tool outputs each hop and let
  // the server replay the chain. That stopped working when sub2api started
  // rejecting `previous_response_id` on the HTTP /v1/responses path for
  // OAuth-type accounts (sub2api issues #1957 + #2133, error reads
  // "previous_response_id is only supported on Responses WebSocket v2").
  //
  // So we now carry the full per-turn history in this process. `history`
  // grows each hop with the assistant's `function_call` items and our
  // matching `function_call_output` items. The model reasons over the same
  // transcript it would have reconstructed from a previous_response_id
  // pointer, just re-sent on the wire. Trade-off: every hop re-pays the
  // input tokens for the prior tool I/O — the auto-compaction path below
  // (triggered at COMPACT_THRESHOLD_TOKENS) reshapes `history` in place
  // so a long turn doesn't blow the context window. We deliberately omit
  // reasoning items (`rs_*`) — sub2api's OAuth path can 404 on those
  // replays.
  let history: ResponseInputItem[] = [...input]
  let nextInput: ResponseInputItem[] = history

  /** Mid-turn steering drain: between hops, see if any new user
   *  messages were queued by the wake-bus `event: steer` handler in
   *  pod-agent.ts. If so, render them (verbatim ≤ threshold, else
   *  cheap-model summary, with truncated-verbatim fallback on
   *  summarizer failure) and splice into history as a SINGLE user
   *  input item. Returns true iff we drained — the no-tools exit
   *  path uses this to decide whether to break out (no steer
   *  pending) or continue (steer pending → force a continuation
   *  hop).
   *
   *  @param draftAssistantText  Text the model emitted in THIS hop
   *    that we're about to discard (the no-tools-exit case). When
   *    non-empty, it's embedded into the rendered user item so the
   *    model on the next hop can see what it was about to say and
   *    decide whether the steer changes its mind — instead of
   *    losing the draft and re-deriving from scratch. */
  const tryDrainSteer = async (
    hopNumber: number,
    draftAssistantText: string | null = null,
  ): Promise<boolean> => {
    if (!canDrainSteer(agentId)) return false
    const batch = drainSteer(agentId)
    if (!batch || batch.length === 0) return false

    let renderedText: string
    let usedSummary = false
    if (batch.length <= STEER_SUMMARIZE_THRESHOLD) {
      renderedText = renderSteerBatchVerbatim(batch, draftAssistantText)
    } else {
      renderedText = await summarizeSteerBatch(batch, persona, runCompanyId, agentId, draftAssistantText)
      usedSummary = renderedText.startsWith('[Mid-turn update — summary')
    }
    history.push({
      role: 'user',
      content: [{ type: 'input_text', text: renderedText }],
    } as unknown as ResponseInputItem)
    nextInput = history
    for (const s of batch) steeredMessageIds.set(s.messageId, s.conversationId)
    // Record the rendered byte count toward the per-turn byte budget.
    // Use the rendered text length (not raw bodies) — that's what
    // actually lands in the model's context.
    const renderedBytes = Buffer.byteLength(renderedText, 'utf8')
    const totalBytes = recordSteerBytes(agentId, renderedBytes)

    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.steered',
      level: 'info',
      title: `Steered ${batch.length} new message${batch.length === 1 ? '' : 's'} into the running turn`,
      data: {
        hop: hopNumber,
        batchSize: batch.length,
        usedSummary,
        carriedDraft: Boolean(draftAssistantText && draftAssistantText.trim().length > 0),
        renderedBytes,
        cumulativeBytesThisTurn: totalBytes,
        messageIds: batch.map((s) => s.messageId),
        conversationIds: [...new Set(batch.map((s) => s.conversationId))],
      },
      stage: 'steered',
    }).catch(() => { /* observability best-effort */ })

    if (isSteerByteBudgetExhausted(agentId) && !steerByteCapEmitted) {
      steerByteCapEmitted = true
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.steer_byte_cap',
        level: 'warn',
        title: 'Per-turn steer byte budget exhausted; further steers will be deferred to next wake',
        data: { hop: hopNumber, cumulativeBytesThisTurn: totalBytes },
        stage: 'steer_byte_cap',
      }).catch(() => { /* observability best-effort */ })
    }

    if (isSteerSaturated(agentId) && !steerSaturatedEmitted) {
      steerSaturatedEmitted = true
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.steer_saturated',
        level: 'warn',
        title: 'Steer batch cap reached; remaining messages will surface on the next wake',
        data: { hop: hopNumber },
        stage: 'steer_saturated',
      }).catch(() => { /* observability best-effort */ })
    }
    return true
  }
  // `responseId` is tracked per-hop below purely for observability events;
  // we no longer feed it back as previous_response_id.

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // Auto-compaction: when the previous hop's reported usage crosses the
    // soft threshold, reshape `history` BEFORE sending it. compactHistory()
    // first truncates oversized function_call_output payloads in place,
    // then drops oldest function_call ↔ function_call_output PAIRS as
    // units (preserving call_id pairing so upstream's input validator
    // doesn't 400). A synthetic compaction-marker message replaces what
    // was dropped so the model knows earlier work happened.
    //
    // The hard limit (HARD_LIMIT_TOKENS) is the floor we still bail at —
    // it should only ever fire when every recent pair is already terse
    // AND the original user input alone is huge (e.g. a giant attachment
    // dump). In that case the next wake will start fresh, which IS the
    // ultimate compaction.
    const modelInUse = persona.model ?? env.OPENAI_MODEL
    const compactThreshold = compactThresholdFor(modelInUse)
    const hardLimit = hardLimitFor(modelInUse)
    if (totalTokensThisTurn > compactThreshold) {
      // The compaction predicate runs against a CJK-aware token
      // estimate (estimateTokens), so Chinese/Japanese turns trigger
      // compaction at the right point — the old byte-count heuristic
      // underestimated those by ~3x. The 0.9 multiplier gives a touch
      // of headroom so compaction lands a bit under the threshold
      // rather than exactly at it.
      const budgetTokens = Math.floor(compactThreshold * 0.9)
      // REAL compaction: ask the LLM to summarize the to-be-dropped
      // tool-call history into a concise paragraph, then splice that
      // summary into the input in place of the dropped items. Falls
      // back to a generic drop-and-marker if the summarizer LLM call
      // fails for any reason (network blip, quota, etc.). One extra
      // round-trip per compaction pass — the cost of keeping the
      // agent semantically informed about its own earlier work.
      const compaction = await compactHistoryWithSummary(
        history,
        (estimateTokensCount) => estimateTokensCount > budgetTokens,
        async (itemsToDrop) => summarizeHistoryItems(itemsToDrop, persona, runCompanyId, agentId),
      )
      const didAnything = compaction.truncatedOutputCount > 0 || compaction.droppedPairCount > 0
      if (didAnything) {
        history = compaction.newHistory
        nextInput = history
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.compacted',
          level: 'warn',
          title: `Auto-compacted history at hop ${hop + 1}`,
          data: {
            beforeTokens: totalTokensThisTurn,
            threshold: compactThreshold,
            hardLimit,
            model: modelInUse,
            truncatedOutputCount: compaction.truncatedOutputCount,
            truncatedOutputBytes: compaction.truncatedOutputBytes,
            droppedPairCount: compaction.droppedPairCount,
            droppedItemBytes: compaction.droppedItemBytes,
            historyItemsAfter: history.length,
            usedLlmSummary: compaction.usedLlmSummary,
          },
          stage: 'compacted',
        }).catch(() => { /* observability best-effort */ })
      } else {
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.compaction_no_op',
          level: 'warn',
          title: `Compaction threshold crossed but local history had nothing to compact at hop ${hop + 1}`,
          data: {
            beforeTokens: totalTokensThisTurn,
            threshold: compactThreshold,
            hardLimit,
            model: modelInUse,
            historyItems: history.length,
            estimatedHistoryTokens: estimateHistoryTokens(history),
          },
          stage: 'compaction_no_op',
        }).catch(() => { /* observability best-effort */ })
      }
      // After compaction, if we're STILL projected past the hard ceiling
      // (compaction couldn't shed enough — typically because the original
      // user input is already huge), break the loop so the next wake can
      // start fresh.
      if (estimateHistoryTokens(history) > hardLimit) {
        console.log(`[turn] ${agentId} stopped at hop ${hop + 1}: even after compaction the projected input exceeds ${hardLimit} tokens (${modelInUse})`)
        finalSummary = `Stopped at hop ${hop + 1} — history exceeds hard token ceiling even after compaction`
        finalStatus = 'failed'
        finalError = finalSummary
        loopExitReason = 'budget'
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'budget.stop',
          level: 'warn',
          title: finalSummary,
          data: { totalTokensThisTurn, hardLimit, model: modelInUse, historyItems: history.length },
          stage: 'budget_stop',
        })
        break
      }
    }
    let streamState: ResponseStreamState = newResponseStreamState()
    // Raw assistant function_call items from this hop, captured for replay
    // on the next hop's input. Mirror of pendingTools but keeps the full
    // response item shape so the wire format matches what /v1/responses
    // wants back. Reasoning / text items are intentionally NOT collected.
    const assistantOutputItems: ResponseInputItem[] = []
    // Retry budget for provider failures. Image fetch failures retry once
    // without pixels; provider transport failures retry briefly before the
    // turn is allowed to fail and post a user-visible notice.
    let inputForAttempt: ResponseInputItem[] = nextInput
    let imageStripRetryUsed = false
    let modelConnectionRetryCount = 0
    const maybeRetryModelProviderConnection = async (err: unknown, phase: 'create' | 'stream'): Promise<boolean> => {
      if (isQuotaExhaustedError(err)) return false
      if (!isModelProviderConnectionError(err)) return false
      if (modelConnectionRetryCount >= MODEL_PROVIDER_CONNECTION_RETRY_LIMIT) return false

      modelConnectionRetryCount += 1
      const delayMs = modelProviderConnectionRetryDelayMs(modelConnectionRetryCount)
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'model.retry_provider_connection',
        level: 'warn',
        title: 'Model provider connection failed; retrying request',
        data: {
          hop: hop + 1,
          phase,
          retry: modelConnectionRetryCount,
          maxRetries: MODEL_PROVIDER_CONNECTION_RETRY_LIMIT,
          delayMs,
          error: errorText(err),
        },
        stage: 'model_retry_provider_connection',
      }).catch(() => { /* observability best-effort */ })
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      return true
    }

    try {
      // Inner retry loop. attempt=0 sends full multimodal input; attempt=1
      // (only entered if image fetch fails) re-sends without images.
      for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        // Reset per-attempt state so a partial response from attempt 0 doesn't
        // contaminate observability / tool-call accounting on the retry.
        streamState = newResponseStreamState()
        assistantOutputItems.length = 0
      }
      const retryKind = attempt === 0 ? null : imageStripRetryUsed ? 'images stripped' : 'provider connection'
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'model.request',
        title: retryKind === null
          ? `Model hop ${hop + 1} started`
          : `Model hop ${hop + 1} retry (${retryKind})`,
        data: {
          hop: hop + 1,
          attempt: attempt + 1,
          model: persona.model ?? env.OPENAI_MODEL,
          inputItems: inputForAttempt.length,
          historyItems: history.length,
          instructions: traceText(instructions),
          input: traceInput(inputForAttempt),
          tools: traceToolDefinitions(),
          request: {
            toolChoice: 'auto',
            reasoning: { effort: 'low' },
            maxOutputTokens: 4000,
          },
        },
        stage: retryKind === null
          ? `model_hop_${hop + 1}`
          : imageStripRetryUsed
            ? `model_hop_${hop + 1}_no_images`
            : `model_hop_${hop + 1}_retry`,
      })
      const client = await getLlmClient(runCompanyId)
      // Per-hop ledger state. Each model hop is a separately-billed call (the
      // existing addUsage() sums them for the turn total), so each gets its
      // own llm_calls row with purpose='agent-turn'. This makes "which hop
      // burned the most tokens" queryable AND gives a clean cross-purpose
      // breakdown for the same turn (agent-turn rows + the verify/compaction
      // rows already recorded above).
      const hopModel = enforceModelPolicy(realTaskModel(persona.model), 'agent-turn')
      const hopT0 = Date.now()
      let hopRecorded = false
      const recordHop = (status: 'ok' | 'rate_limited' | 'timeout' | 'failed', usage: TokenUsage | null, error?: string) => {
        if (hopRecorded) return
        hopRecorded = true
        void recordLlmCall({
          purpose: 'agent-turn', companyId: runCompanyId, agentId, runId,
          model: hopModel, usage,
          latencyMs: Date.now() - hopT0, status, error,
          extras: { hop: hop + 1, imageStripRetryUsed, retryKind },
        })
      }
      let stream
      try {
        stream = await client.responses.create({
          // THE real task: the agent's main turn responding to a conversation.
          // The one sanctioned big-model call site (per-agent override wins).
          model: hopModel,
          instructions,
          input: inputForAttempt,
          tools: TOOL_DEFS_RESPONSES,
          tool_choice: 'auto',
          reasoning: { effort: 'low' },
          max_output_tokens: 4000,
          // No `previous_response_id` — sub2api's OAuth /v1/responses path
          // rejects it (see history block above). The full transcript is
          // re-sent via `inputForAttempt` instead.
          stream: true,
        })
      } catch (err) {
        // Record the failed attempt: no usage (the SDK error preceded any
        // stream events), classified by error shape. Even retried attempts
        // are real sub2api calls so they get their own row.
        recordHop(classifyLlmCallError(err), null, err instanceof Error ? err.message : String(err))
        // The "image_url unreachable" rejection lands here (before we ever
        // start streaming). HEAD-probing in the prompt builder catches most
        // bad URLs, but some CDNs 200 on HEAD and 4xx on GET — this is the
        // safety net that keeps a turn alive when probing was insufficient.
        if (!imageStripRetryUsed && isImageFetchFailure(err)) {
          imageStripRetryUsed = true
          inputForAttempt = stripImageInputs(nextInput)
          await runtime.recordEvent({
            runId, agentId, companyId: runCompanyId,
            kind: 'model.retry_no_images',
            level: 'warn',
            title: 'OpenAI could not fetch an image_url; retrying with images stripped',
            data: { hop: hop + 1, error: errorText(err) },
            stage: 'model_retry_no_images',
          }).catch(() => { /* observability best-effort */ })
          continue
        }
        if (await maybeRetryModelProviderConnection(err, 'create')) continue
        throw err
      }

      try {
        await consumeResponseStream(
          stream as AsyncIterable<ResponseStreamEvent>,
          (event) => applyResponseStreamEvent(streamState, event, { traceItem: traceResponseOutputItem }),
        )
      } catch (err) {
        // Stream itself blew up mid-flight. Record with whatever partial usage
        // streamState managed to capture before the failure (often null on a
        // connection drop pre-usage).
        recordHop(
          classifyLlmCallError(err),
          streamState.responseUsage ? usageFromOpenAI(streamState.responseUsage) : null,
          err instanceof Error ? err.message : String(err),
        )
        if (await maybeRetryModelProviderConnection(err, 'stream')) continue
        throw err
      }
      // Surface the hop's token count to the per-turn 75%-budget guard.
      if (streamState.responseUsage) {
        totalTokensThisTurn = streamState.totalTokens
        // Accumulate the cache-aware breakdown — each hop is a separately-billed
        // call, so the turn's true cost is the SUM (not the last hop alone).
        const hopUsage = usageFromOpenAI(streamState.responseUsage)
        turnUsage = addUsage(turnUsage, hopUsage)
        missingUsageHopCount = 0
        recordHop('ok', hopUsage)
      } else {
        missingUsageHopCount += 1
        totalTokensThisTurn = estimateHistoryTokens(history)
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.usage_missing',
          level: 'warn',
          title: 'Model response completed without usage; using local history token estimate',
          data: {
            hop: hop + 1,
            missingUsageHopCount,
            estimatedHistoryTokens: totalTokensThisTurn,
            historyItems: history.length,
          },
          stage: 'usage_missing',
        }).catch(() => { /* observability best-effort */ })
        // Provider didn't surface usage on this hop. We still know the call
        // landed — record the row with usage=null (measured=false, cost=0)
        // so the spend rollup at least counts the call, with cost flagged
        // as unmeasured. Better than dropping it silently.
        recordHop('ok', null)
      }
      // Stream consumed successfully on this attempt — leave the inner
      // strip-and-retry loop. (We never break-via-fallthrough on attempt 0
      // because the only way to reach here is a fully-streamed response.)
      break
      }
    } catch (err) {
      console.error(`[turn] ${agentId} OpenAI error`, err)
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'model.error',
        level: 'error',
        title: 'OpenAI response stream failed',
        data: { hop: hop + 1, error: errorText(err) },
        stage: 'model_error',
      })
      throw err
    }

    const toolCalls = Object.values(streamState.pendingTools)
    // Rebuild assistantOutputItems from pendingTools — same source of truth
    // as `outs` below — so every function_call_output we emit has a matching
    // function_call in the same input. OpenAI's input validator otherwise
    // rejects with "No tool call found for function call output with call_id
    // fc_X" on the next hop. Bare INPUT shape (no `id`, no `status`); the
    // OUTPUT shape from sub2api carries an OAuth-flavoured id like
    // `fcBHZMTplJRzHp2TNjna79H9MH` that upstream's input validator rejects
    // with "Invalid 'input[N].id': ... contained additional characters".
    for (const tc of toolCalls) {
      assistantOutputItems.push({
        type: 'function_call',
        call_id: tc.call_id,
        name: tc.name,
        arguments: tc.arguments,
      } as unknown as ResponseInputItem)
    }
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'model.response',
      title: toolCalls.length > 0 ? `Model requested ${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}` : 'Model completed with no tool calls',
      data: {
        hop: hop + 1,
        model: persona.model ?? env.OPENAI_MODEL,
        responseId: streamState.responseId,
        status: streamState.responseStatus,
        outputText: traceText(Array.from(streamState.responseTextByPart.values()).join('\n')),
        output: streamState.responseOutput,
        usage: streamState.responseUsage,
        toolCalls: toolCalls.map((tc) => ({
          name: tc.name,
          callId: tc.call_id,
          arguments: parseToolArgs(tc.arguments),
          rawArguments: traceText(tc.arguments),
        })),
      },
      stage: toolCalls.length > 0 ? 'tools_pending' : 'model_done',
    })
    if (toolCalls.length === 0) {
      const hopText = Array.from(streamState.responseTextByPart.values()).join('\n').trim()
      // Steering: if any user messages arrived during this hop, the
      // model "exiting" is premature — the new input may reverse or
      // refine what it just decided. Drain the steer with the
      // current draft text passed through; the rendered user item
      // embeds the draft verbatim ("you were about to send X, then
      // this arrived"), so the model on the next hop has full
      // context without us having to synthesize an assistant-shaped
      // item with no item_id / no part_id / no responseId (which
      // would corrupt history shape — see earlier bug). `continue`
      // forces a continuation hop.
      const steered = await tryDrainSteer(hop + 1, hopText || null)
      if (steered) {
        nextInput = history
        continue
      }
      if (hopText) {
        pendingAssistantText = hopText
      }
      if (statusRequiredNudgeCount < 2) {
        statusRequiredNudgeCount += 1
        const reminder = hopText
          ? [
              'Internal protocol check: you produced assistant text, but Cumora users cannot see plain assistant output.',
              'Continue this same turn using tools.',
              'If the draft should be visible, call bash with `cumora reply <convo_id> \'<body>\'` or call set_turn_status with assistant_text="reply" and reply_conversation_id to relay the exact draft.',
              'If the draft should be dropped, call set_turn_status with assistant_text="drop".',
              'Draft assistant text:',
              hopText.slice(0, 4000),
            ].join('\n')
          : [
              'Internal protocol check: you ended the hop without declaring turn status.',
              'Continue this same turn and call set_turn_status with the semantic state: done, continue, needs_clarification, blocked, or waiting.',
              'Do not rely on silence to mean done.',
            ].join('\n')
        history.push({
          role: 'user',
          content: [{ type: 'input_text', text: reminder }],
        } as unknown as ResponseInputItem)
        nextInput = history
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.status_required',
          level: 'warn',
          title: hopText
            ? 'Model emitted unsent assistant text; requiring explicit action/status'
            : 'Model stopped without turn status; requiring explicit status',
          data: { hop: hop + 1, hadDraftText: Boolean(hopText), nudgeCount: statusRequiredNudgeCount },
          stage: 'status_required',
        }).catch(() => { /* observability best-effort */ })
        continue
      }
      if (postedReplyViaTool) {
        const inferredStatus: TurnStatusOutput = {
          status: 'done',
          reason: 'posted a user-visible reply but omitted turn status',
          nextStep: '',
          assistantTextAction: 'none',
          replyConversationId: null,
        }
        declaredTurnStatus = inferredStatus
        loopExitReason = 'turn_status'
        finalSummary = `Turn status inferred: done — ${inferredStatus.reason}`
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.status_inferred',
          level: 'warn',
          title: 'Inferred done after user-visible reply despite missing turn status',
          data: {
            hop: hop + 1,
            nudgeCount: statusRequiredNudgeCount,
            sideEffects: cliSideEffectsThisTurn,
          },
          stage: 'turn_status_inferred',
        }).catch(() => { /* observability best-effort */ })
        break
      }
      if (
        (isIdleWake || isBackgroundScanWake) &&
        cliSideEffectsThisTurn.length === 0
      ) {
        loopExitReason = 'turn_status'
        finalStatus = 'skipped'
        finalSummary = `Synthetic ${options.trigger} wake ended without explicit turn status or user-visible action`
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'turn.synthetic_noop',
          level: 'warn',
          title: finalSummary,
          data: {
            hop: hop + 1,
            nudgeCount: statusRequiredNudgeCount,
            trigger: options.trigger,
            hadDraftText: Boolean(hopText || pendingAssistantText),
          },
          stage: 'synthetic_noop',
        }).catch(() => { /* observability best-effort */ })
        break
      }
      loopExitReason = 'protocol_violation'
      finalSummary = 'Stopped after repeated missing turn-status declarations'
      finalStatus = 'failed'
      finalError = finalSummary
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.protocol_violation',
        level: 'error',
        title: finalSummary,
        data: { hop: hop + 1, hadDraftText: Boolean(hopText) },
        stage: 'protocol_violation',
      }).catch(() => { /* observability best-effort */ })
      break
    }
    // Cap-out capture: if this is the LAST allowed hop, snapshot any text the
    // model emitted (rare, since this hop also returned tool calls). It remains
    // a draft unless the model declared a relay target.
    if (hop === MAX_HOPS - 1) {
      pendingAssistantText = Array.from(streamState.responseTextByPart.values()).join('\n').trim()
    }

    await setAgentStatus('working')
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'status.changed',
      title: 'Agent status set to working',
      data: { status: 'working', hop: hop + 1 },
      stage: 'working',
    })
    const outs: ResponseInputItem[] = []
    let statusDeclaredThisHop: TurnStatusOutput | null = null
    const hopAssistantText = Array.from(streamState.responseTextByPart.values()).join('\n').trim()
    if (hopAssistantText) {
      pendingAssistantText = hopAssistantText
    }
    // Per-batch abort controller. Registered with steer.ts so that a
    // user message arriving mid-tool can interrupt a long-running call
    // (yt-dlp, ffmpeg, opencli) instead of waiting for the natural
    // hop boundary that may be many minutes away. clearActiveToolBatch
    // fires unconditionally below — try/finally would be cleaner but
    // we want the clear AFTER the Promise.all settles, and registering
    // per-iteration would mean abort fires only on the last tool in
    // the batch. One controller per batch keeps the contract simple:
    // the steer aborts the *whole* batch, every bash inside gets a
    // SIGTERM.
    const batchAbortController = new AbortController()
    registerActiveToolBatch(
      agentId,
      batchAbortController,
      toolCalls.map((tc) => tc.name),
    )
    const toolResults = await Promise.all(toolCalls.map(async (tc) => {
      const parsedArgs = parseToolArgs(tc.arguments)
      const t0 = Date.now()
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'tool.started',
        title: `${tc.name} started`,
        data: { hop: hop + 1, callId: tc.call_id, name: tc.name, args: parsedArgs },
        stage: `tool_${tc.name}`,
      }).catch(() => { /* observability best-effort */ })
      try {
        const result = await executePodTool({
          agentId, name: tc.name, argsJson: tc.arguments, ns: namespace,
          signal: batchAbortController.signal,
        })
        return { tc, result }
      } catch (err) {
        return {
          tc,
          result: {
            ok: false,
            output: null,
            error: errorText(err),
            durationMs: Date.now() - t0,
            display: {
              name: tc.name,
              arg: '',
              status: 'crashed',
              detail: errorText(err),
            },
          } satisfies ToolResult,
        }
      }
    }))
    clearActiveToolBatch(agentId)
    const anyAborted = toolResults.some(({ result }) => result.aborted)
    for (const { tc, result } of toolResults) {
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'tool.finished',
        level: result.ok ? 'info' : 'warn',
        title: `${tc.name} ${result.ok ? 'completed' : 'failed'}`,
        data: {
          hop: hop + 1,
          callId: tc.call_id,
          ok: result.ok,
          durationMs: result.durationMs,
          display: result.display,
          error: result.error,
          output: result.output,
        },
        stage: result.ok ? 'tool_done' : 'tool_error',
      }).catch(() => { /* observability best-effort */ })
      toolCallCount += 1
      if (result.ok && tc.name === 'set_turn_status') {
        const status = turnStatusOutput(result.output)
        if (status) {
          declaredTurnStatus = status
          statusDeclaredThisHop = status
        } else {
          const raw = result.output && typeof result.output === 'object'
            ? result.output as Record<string, unknown>
            : {}
          await runtime.recordEvent({
            runId, agentId, companyId: runCompanyId,
            kind: 'turn.invalid_status',
            level: 'warn',
            title: 'set_turn_status returned an invalid status payload',
            data: {
              hop: hop + 1,
              callId: tc.call_id,
              rawStatus: raw.status,
              rawShape: result.output === null ? 'null' : typeof result.output,
            },
            stage: 'invalid_status',
          }).catch(() => { /* observability best-effort */ })
        }
      }
      // Track whether the CLI reported an actual user-visible reply side
      // effect. This avoids inferring world state from the bash command text.
      if (tc.name === 'bash') {
        const sideEffects = bashOutputSideEffects(result.output)
        if (sideEffects.length > 0) {
          cliSideEffectsThisTurn = [...cliSideEffectsThisTurn, ...sideEffects]
        }
        if (bashOutputHasReplySideEffect(result.output)) {
          postedReplyViaTool = true
        } else if (bashOutputSideEffectChannelUnreliable(result.output)) {
          replySideEffectChannelUnreliable = true
        }
      }
      outs.push({
        type: 'function_call_output',
        call_id: tc.call_id,
        output: modelToolOutputPayload(result.output ?? { ok: result.ok, error: result.error }),
      } as ResponseInputItem)
    }
    // Accumulate this hop's assistant tool-call items + our tool-output items
    // into the full transcript. Next hop will re-send the whole `history` as
    // input — without previous_response_id the model has no other way to
    // see the call_id ↔ output linkage. Do not add synthetic item_reference
    // rows here: sub2api forwards them upstream as real item ids, and
    // id=call_id fails with "404 Item with id 'call_...' not found".
    history.push(...assistantOutputItems, ...outs)
    nextInput = history
    if (!streamState.responseUsage) {
      totalTokensThisTurn = estimateHistoryTokens(history)
    }
    // Mid-tool interrupt observability. If any tool in this batch was
    // aborted by a steer, surface that on the events trail so we can
    // distinguish "tool failed by itself" from "user interrupted it"
    // when reading observability later. The function_call_output rows
    // already carry `aborted: true / abortReason: 'steer_interrupt'`
    // for the model to see; this event is for human readers.
    if (anyAborted) {
      const abortedCalls = toolResults
        .filter(({ result }) => result.aborted)
        .map(({ tc, result }) => ({
          callId: tc.call_id,
          name: tc.name,
          durationMs: result.durationMs,
        }))
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.tool_interrupted',
        level: 'info',
        title: `${abortedCalls.length} tool call${abortedCalls.length === 1 ? '' : 's'} interrupted by user steer`,
        data: { hop: hop + 1, abortedCalls },
        stage: 'tool_interrupted',
      }).catch(() => { /* observability best-effort */ })
    }
    // Steering: between hops, drain any user messages that arrived
    // during this hop's LLM + tool work. The drain happens AFTER the
    // tool outputs are appended (so call_id pairing stays intact)
    // and BEFORE the next iteration's LLM call (so the model sees
    // both the tool results and the new user input together).
    if (statusDeclaredThisHop) {
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.status_declared',
        level: isTerminalTurnStatus(statusDeclaredThisHop.status) ? 'info' : 'debug',
        title: `Turn status: ${statusDeclaredThisHop.status}`,
        data: { hop: hop + 1, status: statusDeclaredThisHop },
        stage: 'turn_status',
      }).catch(() => { /* observability best-effort */ })
    }
    const steeredAfterTools = await tryDrainSteer(hop + 1)
    if (steeredAfterTools) {
      await setAgentStatus('thinking')
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'status.changed',
        title: 'Agent status returned to thinking',
        data: {
          status: 'thinking',
          hop: hop + 1,
          reason: 'steer_after_tools',
          ignoredTerminalTurnStatus: statusDeclaredThisHop && isTerminalTurnStatus(statusDeclaredThisHop.status)
            ? statusDeclaredThisHop
            : null,
        },
        stage: 'thinking',
      })
      continue
    }
    if (statusDeclaredThisHop && isTerminalTurnStatus(statusDeclaredThisHop.status)) {
      if (shouldVerifyTerminalCompletion({
        inbox,
        status: statusDeclaredThisHop,
        postedReplyViaTool,
        sideEffects: cliSideEffectsThisTurn,
      })) {
        let verdict: CompletionVerification
        try {
          verdict = await verifyTerminalCompletion({
            persona,
            tenant: runCompanyId,
            agentId,
            renderedContext: renderedConversationContext,
            turnStatus: statusDeclaredThisHop,
            sideEffects: cliSideEffectsThisTurn,
          })
        } catch (err) {
          verdict = {
            complete: false,
            reason: `completion verifier failed: ${errorText(err)}`,
            nextStep: 'continue the turn and either deliver the requested result or report a clear user-visible failure',
          }
        }
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: verdict.complete ? 'turn.completion_verified' : 'turn.completion_rejected',
          level: verdict.complete ? 'info' : 'warn',
          title: verdict.complete
            ? 'Terminal turn status accepted by semantic verifier'
            : 'Terminal turn status rejected by semantic verifier',
          data: {
            hop: hop + 1,
            status: statusDeclaredThisHop,
            verdict,
            sideEffects: cliSideEffectsThisTurn,
          },
          stage: verdict.complete ? 'completion_verified' : 'completion_rejected',
        }).catch(() => { /* observability best-effort */ })
        if (!verdict.complete) {
          declaredTurnStatus = null
          statusDeclaredThisHop = null
          history.push({
            role: 'user',
            content: [{
              type: 'input_text',
              text: [
                'Internal completion check: your terminal turn status was rejected.',
                `Reason: ${verdict.reason}`,
                `Required next step: ${verdict.nextStep || 'continue and complete the user-visible task'}`,
                '',
                'Continue this same turn. A reaction or short acknowledgement is not the deliverable. Use bash("cumora reply ...") with the requested result, ask a concrete clarification, or report a clear failure, then call set_turn_status again.',
              ].join('\n'),
            }],
          } as unknown as ResponseInputItem)
          nextInput = history
          await setAgentStatus('thinking')
          await runtime.recordEvent({
            runId, agentId, companyId: runCompanyId,
            kind: 'status.changed',
            title: 'Agent status returned to thinking',
            data: { status: 'thinking', hop: hop + 1, reason: 'completion_rejected' },
            stage: 'thinking',
          }).catch(() => { /* observability best-effort */ })
          continue
        }
        markInitialInboxReadOnCompletion = true
      }
      loopExitReason = 'turn_status'
      finalSummary = `Turn status: ${statusDeclaredThisHop.status} — ${statusDeclaredThisHop.reason}`
      break
    }
    await setAgentStatus('thinking')
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'status.changed',
      title: 'Agent status returned to thinking',
      data: { status: 'thinking', hop: hop + 1 },
      stage: 'thinking',
    })
  }

  // If the loop fell through naturally (every hop was used + the last hop
  // still requested tools), the model was mid-task. Record an observability
  // event so future "why did the agent stop?" investigations don't have to
  // count tool.started rows to spot it.
  if (loopExitReason === 'max_hops') {
    finalSummary ||= `Stopped at MAX_HOPS=${MAX_HOPS} — model was still requesting tools`
    finalStatus = 'failed'
    finalError = finalSummary
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.cap_reached',
      level: 'warn',
      title: finalSummary,
      data: {
        maxHops: MAX_HOPS,
        toolCallCount,
        postedReplyViaTool,
        hadDraftText: pendingAssistantText.length > 0,
      },
      stage: 'cap_reached',
    }).catch(() => { /* observability best-effort */ })
  }

  // Model-declared assistant-text relay: plain assistant output is treated as
  // an unsent draft. Relay it only when the model explicitly declared a target
  // through set_turn_status and the target validates against this turn's inbox.
  if (
    pendingAssistantText &&
    !postedReplyViaTool &&
    replySideEffectChannelUnreliable &&
    declaredTurnStatus?.assistantTextAction === 'reply'
  ) {
    finalStatus = 'failed'
    finalError = 'Suppressed assistant-text auto-relay because CLI side-effect channel was unreliable'
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.auto_relay_suppressed',
      level: 'error',
      title: finalError,
      data: {
        pendingAssistantText: pendingAssistantText.slice(0, 1000),
        turnStatus: declaredTurnStatus,
        postedReplyViaTool,
      },
      stage: 'auto_relay_suppressed',
    }).catch(() => { /* observability best-effort */ })
  } else if (pendingAssistantText && !postedReplyViaTool && declaredTurnStatus?.assistantTextAction === 'reply') {
    const target = resolveDeclaredAutoRelayTarget(inbox, {
      action: declaredTurnStatus.assistantTextAction,
      conversationId: declaredTurnStatus.replyConversationId,
      reason: declaredTurnStatus.reason,
    })
    if (target !== null) {
      const convoCompanyId = target.companyId ?? runCompanyId
      const escaped = `'${pendingAssistantText.replace(/'/g, "'\\''")}'`
      await runtime.recordEvent({
        runId, agentId, companyId: convoCompanyId,
        kind: 'turn.auto_relay',
        level: 'warn',
        title: 'Auto-relayed assistant text as reply',
        data: {
          conversationId: target.conversationId,
          bodyLength: pendingAssistantText.length,
          reason: target.reason,
          declared: true,
        },
        stage: 'auto_relay',
      })
      const relay = await executePodTool({
        agentId, name: 'bash',
        argsJson: JSON.stringify({ command: `cumora reply ${target.conversationId} ${escaped}` }),
        ns: namespace,
      })
      if (!relay.ok) {
        finalStatus = 'failed'
        finalError = `Auto-relay reply failed: ${relay.error ?? 'unknown error'}`
        await runtime.recordEvent({
          runId, agentId, companyId: convoCompanyId,
          kind: 'turn.auto_relay_failed',
          level: 'error',
          title: 'Auto-relay reply failed',
          data: { conversationId: target.conversationId, error: relay.error, output: relay.output },
          stage: 'auto_relay_error',
        })
      } else {
        toolCallCount += 1
      }
    } else {
      finalStatus = 'failed'
      finalError = 'Rejected declared assistant-text relay target'
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.auto_relay_rejected',
        level: 'warn',
        title: 'Rejected declared assistant-text relay target',
        data: {
          replyConversationId: declaredTurnStatus.replyConversationId,
          inboxConversationIds: [...new Set(inbox.map((m) => m.conversation_id))],
        },
        stage: 'auto_relay_rejected',
      }).catch(() => { /* observability best-effort */ })
    }
  }
  // Otherwise: the agent decided not to reply / react / ack explicitly, or
  // explicitly dropped an assistant-text draft. The unread cursor doesn't move
  // and they'll see this inbox again on the next wake. The fingerprint dedupe
  // above prevents redundant LLM calls when nothing has changed.

  if (finalStatus === 'completed') {
    if (markInitialInboxReadOnCompletion) {
      const readTargets = new Map<string, string>()
      for (const msg of inbox) readTargets.set(msg.conversation_id, msg.id)
      await Promise.all([...readTargets.entries()].map(([conversationId, upToMessageId]) =>
        runtime.markConversationRead({ agentId, conversationId, upToMessageId }),
      )).catch((err) => console.warn(`[turn] ${agentId} markInitialInboxRead failed`,
        err instanceof Error ? err.message : err))
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.read_advanced_after_verified_completion',
        level: 'debug',
        title: 'Advanced inbox read cursor after verified non-reply completion',
        data: {
          conversations: [...readTargets.keys()],
          messageIds: [...readTargets.values()],
        },
        stage: 'completed',
      }).catch(() => { /* observability best-effort */ })
    }
    lastCompletedInbox.set(agentId, fingerprint)
    finalSummary ||= `Completed with ${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}`

    // Cross-conversation reply audit (observability-only — never blocks).
    //
    // Goal: measure how often the agent posts a reply to a conversation
    // that wasn't in the original inbox AND wasn't a steered conversation
    // either. That set includes both:
    //   - legitimate cases (agent ran `pull-group` and replied into the
    //     new group, agent decided to follow up in a related thread)
    //   - confusion cases (the bug the user hit: Iris was supposed to
    //     reply 成语接龙 in the group but posted into a DM steer instead)
    //
    // We emit the event for ALL "unexpected" replies, not just guesses
    // about confusion — disambiguation belongs in human-read observability,
    // not in code. The rule of thumb is: surface the data, then go look.
    // If the rate is healthy this stays a noisy-but-informative trail; if
    // it's high we have the evidence to invest in better signals (e.g.
    // carrying conversation title/kind through SteerItem, or inlining
    // recent context per steer).
    //
    // Critically, this is NOT a gate. Hard validation here would block
    // legitimate cross-conv behavior (`pull-group` followups, "moving
    // this to #general" replies) — the kind of constraint that makes
    // an agent-native system feel rule-bound and not actually-intelligent.
    {
      const replyTargets: Array<{ conversationId: string; messageId?: string }> = []
      for (const eff of cliSideEffectsThisTurn) {
        if (eff.event !== 'message.posted') continue
        if (!eff.conversationId) continue
        replyTargets.push({ conversationId: eff.conversationId, messageId: eff.messageId })
      }
      if (replyTargets.length > 0) {
        const inboxConvIds = new Set(inbox.map((m) => m.conversation_id))
        const steerConvIds = new Set(Array.from(steeredMessageIds.values()))
        const expected = new Set([...inboxConvIds, ...steerConvIds])
        const unexpected = replyTargets.filter((t) => !expected.has(t.conversationId))
        if (unexpected.length > 0) {
          await runtime.recordEvent({
            runId, agentId, companyId: runCompanyId,
            kind: 'turn.cross_conv_reply',
            // Info level — most of these will be benign (pull-group
            // followups). Promote to 'warn' only if you find a class
            // that's reliably wrong.
            level: 'info',
            title: `Replied into ${unexpected.length} conversation${unexpected.length === 1 ? '' : 's'} outside this turn's inbox + steer set`,
            data: {
              unexpectedReplyConversationIds: [...new Set(unexpected.map((t) => t.conversationId))],
              unexpectedReplyMessageIds: unexpected.map((t) => t.messageId).filter((id): id is string => Boolean(id)),
              inboxConversationIds: [...inboxConvIds],
              steerConversationIds: [...steerConvIds],
              totalReplyTargets: replyTargets.length,
              turnStatus: declaredTurnStatus?.status ?? null,
            },
            stage: 'cross_conv_reply',
          }).catch(() => { /* observability best-effort */ })
        }
      }
    }

    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.completed',
      title: finalSummary,
      data: {
        toolCallCount,
        tokenCount: totalTokensThisTurn,
        turnStatus: declaredTurnStatus,
        hadDraftAssistantText: pendingAssistantText.length > 0,
      },
      stage: 'completed',
    })
  } else {
    finalSummary ||= finalStatus
  }
  if (finalStatus === 'failed') {
    await postTurnFailureNotices(finalSummary, finalError)
  }
  } catch (err) {
    // Quota / 429 → graceful skip + user-visible system notice in each
    // conversation that woke this agent. Done here (not in the inner LLM
    // catch) because by the time we land here, `inbox` already tells us
    // exactly which rooms went silent. Debounce key is per-conversation
    // so multiple agents hitting 429 in the same room don't all post.
    if (isQuotaExhaustedError(err)) {
      finalStatus = 'skipped'
      finalSummary = 'AI quota exhausted (provider 429)'
      finalError = errorText(err)
      await runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'turn.skipped',
        level: 'warn',
        title: finalSummary,
        data: { error: finalError, reason: 'quota_exhausted' },
        stage: 'quota_exhausted',
      }).catch(() => { /* observability best-effort */ })
      const noticeText = 'AI quota exhausted for today — agents can\'t reply right now. The limit resets daily.'
      const uniqueConvoIds = [...new Set(inbox.map((m) => m.conversation_id))]
      for (const convoId of uniqueConvoIds) {
        const convoCompanyId = inbox.find((m) => m.conversation_id === convoId)?.company_id ?? runCompanyId
        try {
          await runtime.postSystemNotice({
            conversationId: convoId,
            companyId: convoCompanyId,
            agentId,
            noticeKind: 'quota_exhausted',
            text: noticeText,
            dedupeKey: `quota_exhausted:${convoId}`,
            dedupeTtlSec: 3600,
          })
        } catch (noticeErr) {
          console.error(`[turn] ${agentId} failed to post quota notice in ${convoId}`, noticeErr)
        }
      }
      // Don't rethrow — turn ends cleanly so the run row shows 'skipped'
      // (yellow) instead of 'failed' (red). The notice is the user-facing
      // signal; observability already captured the underlying error.
      return
    }
    finalStatus = 'failed'
    finalSummary = 'Agent turn failed'
    finalError = errorText(err)
    await runtime.recordEvent({
      runId, agentId, companyId: runCompanyId,
      kind: 'turn.failed',
      level: 'error',
      title: finalSummary,
      data: { error: finalError },
      stage: 'failed',
    }).catch((eventErr) => console.error(`[turn] ${agentId} failed to record error event`, eventErr))
    await postTurnFailureNotices(finalSummary, finalError)
    throw err
  } finally {
    // Commit the FS namespace back to agent_workspace BEFORE we tear
    // it down — every other cleanup below is best-effort, but losing
    // a workspace diff would be data loss.
    if (namespace) {
      try {
        const diff = await commitFs(namespace, { companyId: runCompanyId })
        const totalChanges = diff.inserts.length + diff.updates.length + diff.deletes.length
        if (totalChanges > 0) {
          await runtime.recordEvent({
            runId, agentId, companyId: runCompanyId,
            kind: 'fs.committed',
            title: `FS commit: +${diff.inserts.length} ~${diff.updates.length} -${diff.deletes.length}`,
            data: {
              inserts: diff.inserts.map((d) => d.path),
              updates: diff.updates.map((d) => d.path),
              deletes: diff.deletes,
            },
          }).catch(() => { /* event log best-effort */ })
        }
      } catch (err) {
        console.error(`[turn] ${agentId} fs commit failed`, err)
        await runtime.recordEvent({
          runId, agentId, companyId: runCompanyId,
          kind: 'fs.commit_failed',
          level: 'error',
          title: 'FS commit failed — workspace changes from this turn may be lost',
          data: { error: errorText(err) },
        }).catch(() => { /* swallow */ })
      }
      await teardownFs(namespace).catch(() => { /* swallow */ })
    }
    if (typingStarted && recentConvo) {
      await runtime.publishTyping({
        conversationId: recentConvo, agentId, done: true,
        companyId: recentConvoCompanyId,
      }).then(() => runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'typing.finished',
        title: 'Typing indicator stopped',
        data: { conversationId: recentConvo },
      })).catch((err) => console.error(`[turn] ${agentId} failed to stop typing indicator`, err))
    }
    stopStatusHeartbeat()
    // Steering: stop the busy heartbeat interval and explicitly clear
    // the Redis lease so a new message landing in the brief window
    // between turn-end and the lease TTL doesn't get mis-routed as a
    // steer to an agent that's actually idle.
    stopBusyHeartbeat()
    await runtime.clearBusyHeartbeat(agentId)
      .catch((err) => console.warn(`[turn] ${agentId} clearBusyHeartbeat failed`,
        err instanceof Error ? err.message : err))
    // Clear the per-convo "thinking" claim so peers running glance no
    // longer see us as composing.
    if (convoIds.length > 0) {
      await runtime.unmarkThinking(agentId, convoIds)
        .catch((err) => console.warn(`[turn] ${agentId} unmarkThinking failed`,
          err instanceof Error ? err.message : err))
    }
    // Steering: advance conversation_reads for every messageId we
    // consumed via a mid-turn steer drain. Without this, the next
    // wake's loadInbox would surface those messages again and the
    // agent would re-process them. Per-conversation: take the
    // latest message id we drained (markConversationRead picks the
    // max created_at via GREATEST(...) so out-of-order is fine).
    if (steeredMessageIds.size > 0) {
      // Group by conversation so we only do one upsert per convo.
      const byConvo = new Map<string, string>()
      for (const [messageId, conversationId] of steeredMessageIds) {
        byConvo.set(conversationId, messageId) // last one wins; GREATEST handles ordering server-side
      }
      // Bounded per-call timeout — without this, the finally block can
      // hang for `HttpRuntimeClient.timeoutMs * N` (default 30s × N) if
      // the cumora-server is unreachable. Per-call 5s budget is enough
      // for a healthy upsert; failures fall through to console.warn
      // (the message stays in inbox; next wake re-reads it which is
      // fine — markConversationRead is purely an OPTIMIZATION, not a
      // correctness requirement).
      const MARK_READ_TIMEOUT_MS = 5_000
      const withTimeout = (p: Promise<void>, label: string): Promise<void> => {
        return Promise.race<void>([
          p,
          new Promise<void>((_, rej) =>
            setTimeout(() => rej(new Error(`${label} timed out after ${MARK_READ_TIMEOUT_MS}ms`)), MARK_READ_TIMEOUT_MS),
          ),
        ])
      }
      await Promise.all([...byConvo.entries()].map(([conversationId, upToMessageId]) =>
        withTimeout(
          runtime.markConversationRead({ agentId, conversationId, upToMessageId }),
          `markConversationRead(${conversationId})`,
        ).catch((err) =>
          console.warn(`[turn] ${agentId} markConversationRead(${conversationId}) failed`,
            err instanceof Error ? err.message : err),
        ),
      ))
    }
    // Steering: also discard any items left over in the in-process
    // queue (saturated past MAX_BATCHES_PER_TURN, or arrived after
    // the loop exited but before this finally ran). They're still in
    // the messages table so the next wake picks them up.
    resetSteerForAgent(agentId)
    await setAgentStatus('avail')
      .then(() => runtime.recordEvent({
        runId, agentId, companyId: runCompanyId,
        kind: 'status.changed',
        title: 'Agent status reset to available',
        data: { status: 'avail' },
      }))
      .catch((err) => console.error(`[turn] ${agentId} failed to reset status`, err))
    await runtime.finishRun({
      runId,
      status: finalStatus,
      summary: finalSummary || finalStatus,
      error: finalError,
      toolCallCount,
      tokenCount: totalTokensThisTurn,
      model: persona.model ?? env.OPENAI_MODEL,
      usage: turnUsage,
    }).catch((err) => console.error(`[turn] ${agentId} failed to finish observability run`, err))
  }
}
