/**
 * Heartbeat agenda pre-check — runs on the idle scheduler before we
 * wake an agent's brain.
 *
 * Why this exists:
 *   The plain idle wake hands a generic "is there anything worth
 *   doing?" prompt to the agent's main (brain) model. That call is
 *   expensive AND the agent has no agenda context — it has to query
 *   inbox / groups / contacts itself before it can even decide
 *   whether to act, burning a full reasoning turn on what often is
 *   "no, nothing to do."
 *
 *   This module front-runs that decision with a cheap (cerebellum)
 *   classifier. We collect the agent's actionable surface — Kanban
 *   cards assigned to or @-mentioning them in non-done columns, plus
 *   Calendar events due in the current/imminent slot — and feed it
 *   to a small JSON classifier that decides:
 *       (a) is anything genuinely worth waking the brain for? and
 *       (b) if so, what should it focus on first?
 *
 *   When the answer is yes, we wake with a focused
 *   `backgroundBrief` so the brain spends its turn EXECUTING, not
 *   deciding-whether-to-execute. When the answer is no, we skip the
 *   wake entirely — the brain never runs, no tokens spent.
 *
 *   Net effect: heartbeats become high-signal AND cheaper. The
 *   classifier is the cerebellum doing exactly what cerebellum is
 *   for: a fast yes/no on data, no real reasoning.
 */
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { getTrackedLlmClient } from './llm-ledger.js'
import { redis } from '../redis.js'

/** A Kanban card that the agent should plausibly act on. */
export interface AgendaCard {
  id: string
  board_id: string
  board_title: string
  column_id: string
  column_title: string
  title: string
  description: string | null
  assignee_id: string | null
  mentions: string[]
  updated_at: string
}

/** A calendar event in the current / imminent slot for this agent. */
export interface AgendaEvent {
  id: string
  title: string
  description: string | null
  start_at: string
  agent_prompt: string | null
  target_conversation_id: string | null
}

/** A conversation the agent is in that has gone quiet mid-flow — surfaced so the
 *  agent can proactively follow up (answer if it owes a reply, nudge if it's
 *  waiting, or prod a stalled human-started activity) instead of only ever
 *  reacting to new messages. `lastAuthorIsSelf` tells the brain which: false =
 *  someone else spoke last (you may owe a reply / be a bystander); true = you
 *  spoke last (you're awaiting them → consider a nudge). The brain reads the room
 *  and decides who/whether/how; the cerebellum only gates whether it's worth a wake. */
export interface StalledConvo {
  conversationId: string
  kind: string
  title: string | null
  lastMessageId: string
  lastAuthorId: string
  lastAuthorName: string
  lastAuthorIsSelf: boolean
  lastBody: string
  minutesSilent: number
  /** The last few messages (oldest→newest, "author: body"), so the cerebellum can
   *  tell a genuinely-waiting stall from a thread that has CONCLUDED / socially
   *  closed (a wrap-up flurry with no open ask). Without this it sees only the
   *  single last line and mistakes a finished activity for one still in motion. */
  recentTail: string
}

export interface AgentAgenda {
  cards: AgendaCard[]
  events: AgendaEvent[]
  stalls: StalledConvo[]
}

/** Patterns we treat as "the card is already finished, don't bug the
 *  agent." Matched case-insensitively against the column title — the
 *  Kanban schema doesn't carry an "is_done" flag, so column-title
 *  heuristics are the cheapest signal we have. */
const DONE_COLUMN_PATTERNS = /\b(done|complete|completed|shipped|archive|archived|closed|cancel|canceled|cancelled)\b/i

/** How far ahead a calendar event can be and still count as "current
 *  slot" for the heartbeat. 30 min gives the agent enough time to
 *  load context without surfacing things they should think about
 *  hours from now. */
const CALENDAR_LOOKAHEAD_MS = 30 * 60_000
/** How far in the past a still-active calendar event can be and still
 *  count. Covers the gap between the calendar dispatcher's last fire
 *  and this heartbeat. */
const CALENDAR_LOOKBEHIND_MS = 15 * 60_000

/** Stall window: a conversation counts as "stalled" only if its last message is
 *  at least STALL_MIN_MS old (give people time to reply naturally — don't nag)
 *  and at most STALL_MAX_MS old (don't resurrect ancient threads). Env-overridable. */
const STALL_MIN_MS = Number(process.env.CUMORA_STALL_MIN_MS) || 5 * 60_000
const STALL_MAX_MS = Number(process.env.CUMORA_STALL_MAX_MS) || 6 * 60 * 60_000
/** Cooldown between nudges to the SAME conversation, across ALL agents. Keyed on
 *  conversation only (NOT last-message-id) — a nudge changes the last message, so
 *  a per-message key would re-arm 5min later and nag. This guarantees a stalled
 *  conversation is nudged at most ONCE per cooldown by exactly ONE agent. Env-
 *  overridable; set very large for "one nudge per stall episode, basically once". */
const NUDGE_COOLDOWN_MS = Number(process.env.CUMORA_NUDGE_COOLDOWN_MS) || 45 * 60_000
/** SHORTER cooldown for nudges driven by the DETERMINISTIC fallback
 *  (cerebellum unavailable). Rationale: the deterministic rule is conservative
 *  on input but doesn't know whether the WOKEN agent's big brain will actually
 *  decide to post — if it declines, the 45min cerebellum-grade cooldown locks
 *  out everyone else and a single "no" decides the stall's fate. A short TTL
 *  lets other members get a turn at the same stall with a different big-brain
 *  judgment. The 45min lock is right when the cerebellum SAID "yes nudge";
 *  it's wrong as the only knob for an outage-time fallback. */
const NUDGE_COOLDOWN_FALLBACK_MS = Number(process.env.CUMORA_NUDGE_COOLDOWN_FALLBACK_MS) || 5 * 60_000

/** Claim the right to nudge a stalled conversation. Returns true for the FIRST
 *  caller (across all member agents); everyone else — and the same agent on a
 *  later heartbeat — gets false until the cooldown lapses. ONE key per
 *  CONVERSATION (NX + cooldown TTL).
 *
 *  Pass `source: 'fallback'` when the wake is from the deterministic agenda
 *  fallback (classifier 503), to use the shorter cooldown — a "no" from the
 *  chosen agent shouldn't permanently silence a stall the cerebellum can't
 *  even weigh in on. Default 'classified' preserves the 45min cooldown for
 *  the normal LLM-gated path. */
export async function claimStallNudge(
  conversationId: string,
  opts?: { source?: 'classified' | 'fallback' },
): Promise<boolean> {
  // Fallback path: after N successive nudges land without the stall
  // ACTUALLY advancing (new message in the convo), stop. The LLM judgment
  // has converged — every woken big brain is declining for the same
  // reason. Re-wakes every 5min after that point burn tokens for no
  // changed decision. The counter is the per-conversation declines
  // counter; the cap is small (3) so a stall the team has truly given
  // up on stops auto-firing — without permanently silencing it, because
  // the counter expires on the next NEW message in the convo (someone
  // posting resets the conversation state). Classified-path nudges
  // already use the 45min cooldown so they don't need a separate cap.
  if (opts?.source === 'fallback') {
    const declineKey = `cumora:nudge-declines:${conversationId}`
    const declines = await redis.get(declineKey).then((v) => Number(v) || 0).catch(() => 0)
    if (declines >= 3) return false
  }
  const key = `cumora:nudge:${conversationId}`
  const cooldownMs = opts?.source === 'fallback' ? NUDGE_COOLDOWN_FALLBACK_MS : NUDGE_COOLDOWN_MS
  const ttlSec = Math.ceil(cooldownMs / 1000)
  const res = await redis.set(key, '1', 'EX', ttlSec, 'NX').catch(() => null)
  if (res === 'OK' && opts?.source === 'fallback') {
    // Record the decline-attempt counter (TTL matches the stall window so
    // it auto-expires; resets on any actual conversation message via the
    // counter-reset path below). The naming is "declines" but it really
    // tracks "fallback claims granted without a follow-on post" — we can't
    // know whether the agent posted until later; the cleaner-on-post path
    // (resetStallNudgeDeclines) handles the truthing.
    const declineKey = `cumora:nudge-declines:${conversationId}`
    await redis.multi()
      .incr(declineKey)
      .expire(declineKey, Math.ceil(NUDGE_COOLDOWN_MS / 1000))
      .exec()
      .catch(() => null)
  }
  return res === 'OK'
}

/** Called when a NEW message lands in a conversation — clears the
 *  decline counter so future fallback nudges (if the convo stalls again
 *  LATER) get a fresh budget. The counter only existed to stop a single
 *  stalled state from being re-poked indefinitely; new activity = new
 *  state = new budget. Fire-and-forget. */
export async function resetStallNudgeDeclines(conversationId: string): Promise<void> {
  if (!conversationId) return
  await redis.del(`cumora:nudge-declines:${conversationId}`).catch(() => null)
}

/** Pull cards assigned to (or @-mentioning) the agent in non-done
 *  columns. Capped tightly so we never feed the classifier a wall of
 *  context. Stale cards (untouched for 30 days) are ignored — they're
 *  almost always abandoned work. */
async function loadAssignedCards(agentId: string, companyId: string): Promise<AgendaCard[]> {
  const { rows } = await pool.query<AgendaCard>(
    `SELECT c.id, c.board_id, b.title AS board_title,
            c.column_id, col.title AS column_title,
            c.title, c.description, c.assignee_id,
            COALESCE(c.mentions, '[]'::jsonb) AS mentions,
            c.updated_at::text AS updated_at
       FROM board_cards c
       JOIN boards b ON b.id = c.board_id
       JOIN board_columns col ON col.id = c.column_id
      WHERE b.company_id = $1
        AND (c.assignee_id = $2 OR c.mentions @> to_jsonb($2::text))
        AND c.updated_at > NOW() - INTERVAL '30 days'
      ORDER BY c.updated_at DESC
      LIMIT 20`,
    [companyId, agentId],
  )
  return rows.filter((r) => !DONE_COLUMN_PATTERNS.test(r.column_title ?? ''))
}

/** Pull calendar events for this agent that fall inside the current
 *  slot window. We deliberately keep `recurrence` off the result —
 *  the classifier doesn't need rule semantics, just the next concrete
 *  occurrence time, and the calendar dispatcher already handles the
 *  recurrence math for actual dispatches. */
async function loadDueEvents(agentId: string, companyId: string, now: Date): Promise<AgendaEvent[]> {
  const lookbehindFloor = new Date(now.getTime() - CALENDAR_LOOKBEHIND_MS)
  const lookaheadCeiling = new Date(now.getTime() + CALENDAR_LOOKAHEAD_MS)
  const { rows } = await pool.query<AgendaEvent>(
    `SELECT id, title, description, start_at::text AS start_at,
            agent_prompt, target_conversation_id
       FROM calendar_events
      WHERE company_id = $1
        AND assignee_id = $2
        AND status = 'active'
        AND start_at BETWEEN $3 AND $4
      ORDER BY start_at ASC
      LIMIT 10`,
    [companyId, agentId, lookbehindFloor, lookaheadCeiling],
  )
  return rows
}

/** Conversations the agent is a member of whose LATEST text message sits in the
 *  stall window [STALL_MIN_MS, STALL_MAX_MS] of silence. The participant-led
 *  normalized membership index narrows the conversations first, then
 *  idx_messages_convo_created serves the LATERAL latest-message lookup. */
async function loadStalledConversations(agentId: string, companyId: string): Promise<StalledConvo[]> {
  const { rows } = await pool.query<{
    conversation_id: string; kind: string; title: string | null
    last_message_id: string; last_author_id: string; last_author_name: string
    last_author_is_self: boolean; last_body: string; minutes_silent: string; recent_tail: string | null
  }>(
    `WITH convos AS (
         SELECT c.id, c.kind, c.title
           FROM conversations c
          WHERE c.company_id = $2
            AND EXISTS (
              SELECT 1 FROM conversation_members cm
               WHERE cm.conversation_id = c.id
                 AND cm.company_id = c.company_id
                 AND cm.participant_id = $1
            )
       )
       SELECT co.id AS conversation_id, co.kind, co.title,
              m.id AS last_message_id, m.author_id AS last_author_id,
              COALESCE(p.name, m.author_id) AS last_author_name,
              (m.author_id = $1) AS last_author_is_self,
              LEFT(m.body, 160) AS last_body,
              (EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 60)::int::text AS minutes_silent,
              (
                SELECT string_agg(t.line, E'\n' ORDER BY t.created_at ASC)
                  FROM (
                    SELECT COALESCE(tp.name, tm.author_id) || ': ' || LEFT(tm.body, 100) AS line, tm.created_at
                      FROM messages tm
                      LEFT JOIN participants tp ON tp.id = tm.author_id AND tp.company_id = $2
                     WHERE tm.conversation_id = co.id AND tm.kind = 'text'
                     ORDER BY tm.created_at DESC
                     LIMIT 6
                  ) t
              ) AS recent_tail
         FROM convos co
         JOIN LATERAL (
           SELECT * FROM messages mm
            WHERE mm.conversation_id = co.id AND mm.kind = 'text'
            ORDER BY mm.created_at DESC
            LIMIT 1
         ) m ON true
         LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = $2
        WHERE m.created_at <= NOW() - ($3::double precision * INTERVAL '1 millisecond')
          AND m.created_at >= NOW() - ($4::double precision * INTERVAL '1 millisecond')
        ORDER BY m.created_at DESC
        LIMIT 10`,
    [agentId, companyId, STALL_MIN_MS, STALL_MAX_MS],
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    kind: r.kind,
    title: r.title,
    lastMessageId: r.last_message_id,
    lastAuthorId: r.last_author_id,
    lastAuthorName: r.last_author_name,
    lastAuthorIsSelf: r.last_author_is_self,
    lastBody: r.last_body,
    minutesSilent: Number(r.minutes_silent),
    recentTail: r.recent_tail ?? '',
  }))
}

/** Public entry point. Empty result = "nothing on this agent's
 *  plate"; callers fall back to the generic idle behavior. */
export async function gatherAgentAgenda(
  agentId: string,
  companyId: string,
  now: Date = new Date(),
): Promise<AgentAgenda> {
  const [cards, events, stalls] = await Promise.all([
    loadAssignedCards(agentId, companyId),
    loadDueEvents(agentId, companyId, now),
    loadStalledConversations(agentId, companyId).catch((e) => {
      console.warn('[agenda] loadStalledConversations failed', e instanceof Error ? e.message : e)
      return [] as StalledConvo[]
    }),
  ])
  return { cards, events, stalls }
}

/** Render the agenda as a compact text block for the classifier. We
 *  intentionally do not include the full description body — the
 *  classifier only needs to decide go/no-go, and the brain will see
 *  the full card via the `kanban` CLI on actual wake.
 *
 *  Prefix-cache order (providers cache the longest unchanged prefix):
 *    1. cards (change only when a card row changes)
 *    2. stall identity + recent messages (change only on new chat)
 *    3. calendar slot (slides as wall-clock crosses 30m/15m windows)
 *  Wall-clock "Nm silent" is kept in a final timing section. That preserves
 *  the original recency signal while preventing a ticking value from
 *  invalidating the stable agenda prefix on every heartbeat. */
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function renderAgendaForClassifier(agenda: AgentAgenda): string {
  const lines: string[] = []
  // Sort by id so inserting/updating one row does not reshuffle the rest and
  // bust the prefix cache of every later line. Selection (most-recent LIMIT)
  // still happens in SQL; this is display order only.
  const cards = [...agenda.cards].sort(byId)
  const stalls = [...agenda.stalls].sort((a, b) => (
    a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0
  ))
  if (cards.length > 0) {
    lines.push(`Kanban cards (${cards.length}):`)
    for (const c of cards) {
      const tag = c.assignee_id ? 'assigned' : 'mentioned'
      lines.push(`- [${tag}] "${c.title}" in ${c.board_title} / ${c.column_title} (id=${c.id}, updated ${c.updated_at})`)
    }
  }
  if (stalls.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Conversations you're in that have gone quiet (${stalls.length}) — judge each: genuinely WAITING on someone, or already CONCLUDED/wound down?`)
    for (const s of stalls) {
      const who = s.lastAuthorIsSelf ? 'YOU spoke last, no reply since' : `${s.lastAuthorName} spoke last, you haven't responded`
      lines.push(`- [${s.kind}] ${s.title ?? s.conversationId} (${s.conversationId}) — ${who}. Last few messages:`)
      for (const ln of (s.recentTail || s.lastBody).split('\n')) lines.push(`    ${ln}`)
    }
  }
  if (agenda.events.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Calendar events in current slot (${agenda.events.length}):`)
    for (const e of agenda.events) {
      const prompt = e.agent_prompt ? ` — prompt: ${e.agent_prompt.slice(0, 140)}` : ''
      lines.push(`- "${e.title}" at ${e.start_at}${prompt}`)
    }
  }
  if (stalls.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push('Current stall timing:')
    for (const s of stalls) lines.push(`- ${s.conversationId}: ${s.minutesSilent}m silent`)
  }
  if (lines.length === 0) return '(empty)'
  return lines.join('\n')
}

export interface AgendaVerdict {
  /** Whether the agent should wake right now to act on this agenda. */
  actionable: boolean
  /** One-line focus the brain should drive toward, if actionable. */
  focus: string
  /** Telemetry-only reason string; never shown to the agent. The literal
   *  string `'classifier error'` is a sentinel — callers should treat it
   *  as "triage failed, fall back to the safe path" rather than "no work
   *  to do," so a transient LLM outage doesn't silence every agent with
   *  agenda items. */
  reason: string
}

/** Sentinel value for {@link AgendaVerdict.reason} when the underlying
 *  classifier call threw. Exported so callers can detect it without
 *  string-matching. */
export const AGENDA_CLASSIFIER_ERROR = 'classifier error'

/** Parse the support model's verdict conservatively. JSON mode is not enough
 * for every OpenAI-compatible provider: DeepSeek sometimes wraps JSON, omits
 * key quotes, or truncates after all required fields. Recover only an explicit
 * actionable value. A malformed positive also needs a non-empty focus, so
 * salvage can never turn ambiguous output into a wake. */
export function parseAgendaVerdict(raw: string): {
  actionable?: unknown
  focus?: unknown
  reason?: unknown
} | null {
  const unfenced = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
  const firstBrace = unfenced.indexOf('{')
  if (firstBrace < 0) return null
  const lastBrace = unfenced.lastIndexOf('}')
  const candidate = unfenced.slice(firstBrace, lastBrace > firstBrace ? lastBrace + 1 : undefined)
  try {
    return JSON.parse(candidate) as { actionable?: unknown; focus?: unknown; reason?: unknown }
  } catch { /* conservative field salvage below */ }

  const actionMatch = candidate.match(
    /(?:["']?actionable["']?)\s*:\s*(true|false|1|0|["']true["']|["']false["'])/i,
  )
  if (!actionMatch) return null
  const actionToken = actionMatch[1].replace(/["']/g, '').toLowerCase()
  const actionable = actionToken === 'true' || actionToken === '1'
  const stringField = (name: string): string => {
    const match = candidate.match(new RegExp(`(?:["']?${name}["']?)\\s*:\\s*(["'])([\\s\\S]*?)\\1(?:\\s*[,}]|$)`, 'i'))
    return match?.[2] ?? ''
  }
  const focus = stringField('focus')
  const reason = stringField('reason')
  if (actionable && !focus.trim()) {
    return { actionable: false, focus: '', reason: 'malformed positive verdict without focus' }
  }
  return { actionable, focus, reason }
}

/** Cerebellum classifier: given the agenda + persona, decide if a
 *  wake is justified. Strict JSON. Falls back to "actionable=false"
 *  on any error so a classifier outage doesn't burn brain calls on
 *  every heartbeat. */
export async function classifyAgendaActionable(args: {
  persona: { name: string; role: string; style: string; model: string | null }
  companyId: string
  agenda: AgentAgenda
  /** Optional agent id — when provided, the ledger row is scoped to this
   *  agent so the per-agent spend rollup ("whose heartbeats burn the most")
   *  is queryable. Cloud callers (idle.ts) pass `personaId`; the BYOA
   *  endpoint passes `c.sub`. Older callers can omit it. */
  agentId?: string
}): Promise<AgendaVerdict> {
  const { persona, companyId, agenda } = args
  if (agenda.cards.length === 0 && agenda.events.length === 0 && agenda.stalls.length === 0) {
    return { actionable: false, focus: '', reason: 'empty agenda' }
  }
  const rendered = renderAgendaForClassifier(agenda)
  const styleHint = (persona.style ?? '').slice(0, 400)
  const instructions = `You are Cumora's heartbeat agenda triage. Given an agent's currently-assigned Kanban cards and their currently-due calendar events, decide whether the agent should wake up RIGHT NOW to act on something, or stay quiet.

Decide "actionable: true" only when at least one item is concrete, fresh, AND clearly belongs to this agent's role. Reject:
- vague brainstorming cards with no owner action
- cards already in a done/archive-style column
- events that are personal markers (no agent_prompt)
- duplicates of work the agent has obviously already started

ORDERING: list order is for prompt-cache stability, not priority. Judge urgency from each card's updated timestamp, each event's start time, and each stalled conversation's current silence duration and message content.

STALLED CONVERSATIONS: for each, READ the recent messages shown and judge whether it is genuinely WAITING or already CONCLUDED. actionable=true ONLY when the recent messages show a CONCRETE unanswered ask directed at someone, or an explicitly in-progress step plainly waiting on a next move. It is NOT actionable (false) when the thread has CONCLUDED or socially CLOSED — participants exchanging wrap-up / closing / acknowledgement remarks, a conclusion or result already reached, nothing pending and no one waiting on a specific next step — no matter how "quiet" it now is. A merely quiet conversation is NOT a stall; "someone spoke last and I didn't reply" is NOT by itself a reason (most messages need no reply). Resurrecting a finished conversation with a late reply is a failure — when in doubt that it's truly still waiting, choose false.

Reply ONLY as strict JSON: {"actionable": boolean, "focus": "one-line focus for the agent if actionable, else empty", "reason": "short factual reason"}.`
  const input = `Agent: ${persona.name}${persona.role ? `, ${persona.role}` : ''}
Persona / style:
${styleHint || '(none)'}

Current agenda for this agent:
${rendered}

Reply as strict JSON.`
  try {
    const client = await getTrackedLlmClient({
      purpose: 'agenda',
      companyId,
      agentId: args.agentId ?? null,
      extras: {
        cards: agenda.cards.length, events: agenda.events.length, stalls: agenda.stalls.length,
        persona: persona.name,
      },
    })
    const r = await client.responses.create({
      model: env.OPENAI_MODEL_SUPPORT,
      instructions,
      input,
      text: { format: { type: 'json_object' } },
      // DeepSeek V4 Flash regularly spends the first ~300 tokens on hidden
      // reasoning. A 300-token cap then truncates the JSON to one character,
      // which made every minute-level BYOA agenda check fail closed. Leave
      // enough room for reasoning plus the small structured verdict.
      max_output_tokens: 2000,
      reasoning: { effort: 'minimal' },
    })
    const parsed = parseAgendaVerdict(r.output_text ?? '')
    if (!parsed) throw new Error('agenda classifier returned no recoverable verdict')
    // Coerce to a real boolean *strictly*. `Boolean("no")` is `true`
    // because non-empty strings are truthy — so if the model replies
    // {"actionable": "no"} (treating it as natural language) we'd
    // wrongly wake the brain. Accept true/"true"/1 as actionable; treat
    // everything else (including "no", "false", undefined, 0) as not
    // actionable. Same for focus / reason — clamp via String + slice
    // even if the model returns a number or an array.
    const a = parsed.actionable
    const actionable = a === true || a === 'true' || a === 1
    return {
      actionable,
      focus: String(parsed.focus ?? '').slice(0, 240),
      reason: String(parsed.reason ?? '').slice(0, 240),
    }
  } catch (e) {
    console.warn('[agenda] classifier failed', e instanceof Error ? e.message : e)
    // ─── deterministic fallback ─────────────────────────────────────
    // When the cerebellum classifier is unavailable (sub2api 503 / model
    // outage / network), default fail-closed BUT carve out a narrow,
    // conservative case so the stall safety net isn't 100% broken during
    // an outage: a SINGLE recent stall where SOMEONE ELSE spoke last and
    // this agent owes a reply. The rationale:
    //   - we don't try to judge "concluded vs in-motion" without the LLM
    //     (that's exactly what the cerebellum is for); we just surface
    //     the simplest "you have an unread, nobody else has it" case.
    //   - bounded: ONE stall only (multi-stall ambiguity → fail-closed),
    //     SOMEONE-ELSE-spoke-last only (not "I spoke, nudge them" — that
    //     direction needs more judgment), minutesSilent ≤ STALL_FALLBACK_MAX
    //     (don't resurrect ancient threads), no card/event noise (those
    //     genuinely need LLM judgment on priority).
    //   - cost bounded: the per-conversation NX nudge claim (claimStallNudge)
    //     still applies downstream — at most ONE agent ever wakes the
    //     big brain for a given stall, even if all members' fallbacks
    //     fire simultaneously.
    //   - aligned with [[keep-hard-safety-backstops]]: a deterministic
    //     floor under the AI layer for the narrow case where the AI
    //     judgment is OBVIOUSLY consistent (unread message I owe a reply
    //     to, recent, alone on the agenda).
    const STALL_FALLBACK_MAX_MIN = 30
    const recentAwaitingMe = agenda.stalls.filter(
      (s) => !s.lastAuthorIsSelf && s.minutesSilent <= STALL_FALLBACK_MAX_MIN,
    )
    if (
      agenda.cards.length === 0 &&
      agenda.events.length === 0 &&
      recentAwaitingMe.length === 1
    ) {
      const s = recentAwaitingMe[0]
      return {
        actionable: true,
        focus: `Reply to ${s.lastAuthorName} in ${s.title ?? s.conversationId} — they spoke last (${s.minutesSilent}m ago) and you haven't responded.`,
        reason: `${AGENDA_CLASSIFIER_ERROR} (deterministic fallback: single recent awaiting-you stall)`,
      }
    }
    return { actionable: false, focus: '', reason: AGENDA_CLASSIFIER_ERROR }
  }
}

/** Render the agenda as the `backgroundBrief.body` we hand to the
 *  brain's turn. Includes enough specificity (ids, titles, slot
 *  times, agent_prompts) that the agent can act without re-querying,
 *  but stays terse — the agent will pull full card / event detail
 *  via the normal CLI tools if it needs them.
 *
 *  Note: the brain's default `background_scan` framing in turn.ts
 *  says "default to doing nothing," which is the right stance for
 *  generic activity scans. For agenda wakes that doctrine is too
 *  cautious — the cerebellum has already decided this is worth a
 *  brain call — so we open the body with an explicit "the system
 *  already triaged this; pick the most timely item and progress it"
 *  override. */
export function renderAgendaBrief(agenda: AgentAgenda, focus: string): string {
  const lines: string[] = [
    `This wake comes from your own agenda — Kanban cards assigned to you and Calendar slots that are due now. The system has already triaged that there is real work to progress here, so act: pick the most timely item, move it forward (write the card comment, ship the deliverable, send the DM, draft the doc), and call set_turn_status when done. Override the generic "default to doing nothing" stance for this wake.`,
    '',
  ]
  if (focus) {
    lines.push(`Focus from agenda triage: ${focus}`)
    lines.push('')
  }
  if (agenda.cards.length > 0) {
    lines.push(`Your active Kanban cards (${agenda.cards.length}):`)
    for (const c of agenda.cards) {
      const tag = c.assignee_id ? 'assigned to you' : '@you mentioned'
      lines.push(`- ${c.id}  [${c.board_title} / ${c.column_title}]  ${c.title}  (${tag})`)
      if (c.description) lines.push(`    ${c.description.replace(/\n/g, ' ').slice(0, 200)}`)
    }
    lines.push('')
    lines.push(`Inspect with: bash("cumora kanban show <board_id>") or bash("cumora card show <card_id>").`)
  }
  if (agenda.events.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Calendar events in your current slot (${agenda.events.length}):`)
    for (const e of agenda.events) {
      lines.push(`- ${e.id}  at ${e.start_at}  ${e.title}`)
      if (e.agent_prompt) lines.push(`    prompt: ${e.agent_prompt.slice(0, 240)}`)
    }
  }
  if (agenda.stalls.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Conversations that have gone quiet — possible follow-ups (${agenda.stalls.length}). FIRST decide if each is genuinely WAITING or already DONE. If the recent messages show the activity CONCLUDED or the thread socially closed (wrap-ups, closing / acknowledgement remarks, a result already reached, nothing pending, no one waiting on a specific next step) → it is FINISHED: do NOT post. Reviving a finished thread with a late message is noise, not teamwork. Only act when someone is plainly waiting:`)
    for (const s of agenda.stalls) {
      lines.push(`- ${s.conversationId} [${s.kind}] "${s.title ?? ''}" — ${s.lastAuthorIsSelf ? 'YOU spoke last' : `${s.lastAuthorName} spoke last`}, ${s.minutesSilent}m ago. Recent:`)
      for (const ln of (s.recentTail || s.lastBody).split('\n')) lines.push(`    ${ln}`)
    }
    lines.push(`If (and ONLY if) one is genuinely unfinished and someone is waiting: read the room (\`cumora messages <id>\`), then send AT MOST ONE message — answer it if it needs your answer, or a single brief nudge. Never nag, never pile on, never revive a finished thread.`)
  }
  return lines.join('\n')
}

/** Exported for unit-test access — never call from production code. */
export const __test = {
  DONE_COLUMN_PATTERNS,
  renderAgendaForClassifier,
}
