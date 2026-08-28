/**
 * AgentRuntimeClient — the contract between the agent loop and "the
 * outside world".
 *
 * Phase 2b goal: agent loop becomes a self-contained binary that runs
 * inside a per-agent Kubernetes pod. The binary doesn't talk to Postgres
 * directly — it talks to this interface, which is implemented two ways:
 *
 *   - `InProcRuntimeClient` — direct DB / Redis / pool access.
 *     Used today by the server-process runtime (`runAgentTurn` in
 *     turn.ts). Transitional: lets us refactor turn.ts to use this
 *     interface without changing behavior, before the HTTP path lands.
 *
 *   - `HttpRuntimeClient` — fetches over HTTP to the server's
 *     `/cli/*` endpoints, authenticated by a per-pod JWT scoped to
 *     `{ agentId, companyId, scope: 'agent-runner' }`. To be built.
 *     This is what ships inside the container image.
 *
 * Interface design notes:
 *
 *   - All methods take the agentId explicitly. Even though a pod-side
 *     HttpRuntimeClient bakes the agentId into its JWT, the InProc
 *     client doesn't have any implicit "current agent" context. Keep
 *     it explicit so the call site reads the same in both.
 *
 *   - Read methods return plain JSON-friendly shapes (the InboxRow /
 *     MemoryRow / ContextRow types defined below). No Postgres Row<T>
 *     leakage. HTTP path can serialize these as-is.
 *
 *   - Write methods are fire-and-forget at the call site (returning
 *     Promise<void>). HTTP retries / queueing handled inside the impl,
 *     not the caller.
 */

export interface InboxAttachment {
  url: string
  name: string
  kind: string
  mime?: string
  /** Storage key (`attachments/<uuid>.<ext>`) preserved for re-signing. */
  key?: string
}

export interface QuotedMessageSummary {
  id: string
  authorId: string
  authorName: string
  kind: string
  body: string
  sequence: number
}

export interface InboxRow {
  id: string
  conversation_id: string
  company_id: string | null
  conversation_title: string
  conversation_kind: string
  /** The group's topic ("what this group is for"), so every agent — the cloud
   *  turn context AND the BYOA inbox digest — stays on-task. Null if unset. */
  conversation_topic: string | null
  /** Optional: conversation's project. Direct chats and unscoped groups
   *  leave these unset so a project-less header stays byte-identical. */
  project_id?: string | null
  project_name?: string | null
  author_id: string
  /** Joined from participants.kind. Lets prompt-building code (turn.ts)
   *  identify human vs agent messages without a hardcoded id allow-list. */
  author_kind: 'human' | 'agent' | null
  author_name: string
  body: string
  kind: string
  sequence: number
  created_at: string
  attachment: InboxAttachment | null
  /** Set when this message is a reply: id of the message it quotes. */
  quoted_message_id: string | null
  /** Inline summary of the quoted-original so the agent turn sees both the
   *  reply and the context it was made in, without a second fetch. Null
   *  when not a reply OR when the quoted message has been deleted. */
  quoted: QuotedMessageSummary | null
}

export interface ReactionSummary { emoji: string; users: string[] }

/** Cache-aware token breakdown for cost accounting (mirrors cost.ts TokenUsage;
 *  defined here so the runtime interface stays free of server-only imports). */
export interface RuntimeTokenUsage {
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
}

export interface ContextRow extends InboxRow {
  is_unread: boolean
  is_self: boolean
  project_name: string | null
  reactions: ReactionSummary[]
  /** Latest HUMAN emoji reaction on this message (ISO timestamp), null/absent if
   *  none. A DB fact (participants.kind of the reactor), never content. The
   *  triage loop cap counts it as live human attention — a spectating human who
   *  reacts instead of typing keeps an agent-run activity alive. */
  human_reacted_at?: string | null
  /** When a HUMAN last READ this conversation (ISO timestamp; per-convo, so the
   *  same value rides every row of a conversation). A human with the room open
   *  advances this with each message — the strongest "someone is watching"
   *  signal, and unlike reactions it isn't limited to the context window. The
   *  triage loop cap counts it as live human attention. */
  human_last_read_at?: string | null
}

export interface MemoryRow {
  id: string
  kind: string
  about: string | null
  body: string
  pinned: boolean
  created_at: string
}

export interface ClimateRow {
  about_id: string
  affinity: number
  trust: number
  last_note: string
  updated_at: string
}

export interface SkillIndexEntry {
  name: string
  description: string
  /** `skills/<slug>/SKILL.md` — needed to load the full body on demand. */
  path: string
}

export interface PersonaRow {
  id: string
  name: string
  role: string
  /** participants.system_prompt — the persona's distinctive style. */
  style: string
  /** Per-agent model override; null = use system default. */
  model: string | null
  companyId: string
}

export interface FaceRow {
  id: string
  name: string
  role: string | null
  /** Public URL of the avatar portrait. Empty/null avatars are filtered out. */
  avatar_url: string | null
}

/** Kinds of heavy / visible-effect work an agent can claim before
 *  starting, so peers can avoid duplicating it. Keep this list short
 *  and predictable — every entry costs us schema discipline. */
export type WorkTaskType =
  | 'web-search'
  | 'web-read'
  | 'doc-create'
  | 'doc-edit'
  | 'calendar-create'
  | 'image-generate'
  // BYOA "one-of-us" reply coordination: agents claim a single message so only
  // ONE wakes its (expensive) engine to reply — the small-brain triage decides
  // a reply is warranted; this claim decides WHO, without the big model.
  | 'reply'
  // Generic, agent-driven exclusive claim, exposed
  // to the engine as `cumora claim "<unit of work>"`: before doing any non-trivial
  // unit a peer could also pick up (running an activity/game, a deliverable, a
  // phase), claim it; if the claim fails a peer owns it → move on. Prevents two
  // agents doing the same thing.
  | 'activity'

/** One in-flight work claim from the conversation's worklog. */
export interface WorklogEntry {
  agentId: string
  taskType: WorkTaskType
  /** The agent's original subject string, NOT the normalized dedup key.
   *  Surfaced verbatim in the wake prompt so peers see what's being
   *  done in human-readable form ("warm pastels for Sunday hero"). */
  subject: string
  /** Unix ms timestamp of when the claim was first taken. Preserved
   *  across heartbeat refreshes so peers see real age. */
  startedAt: number
}

/** The full surface area the agent loop needs. Phase 2b ships an
 *  InProc impl + a stub HTTP impl; later sessions fill the HTTP impl
 *  in as the corresponding `/cli/*` server endpoints land. */
export interface AgentRuntimeClient {
  // === Read agent state ===
  /** Resolve the agent's persona (name / role / style / model / company).
   *  Returns null when the id isn't a real agent. */
  loadPersona(agentId: string): Promise<PersonaRow | null>
  /** Resolve a conversation's tenant — used when the inbox is empty
   *  and we need to know which company the run belongs to. */
  getConversationCompanyId(conversationId: string): Promise<string | null>
  /** Unread messages across all of the agent's conversations. */
  loadInbox(agentId: string): Promise<InboxRow[]>
  /** Hybrid memory retrieval: pinned + semantic + recent, filtered to
   *  global + the current project(s). Pass conversationIds (preferred)
   *  or projectIds; empty/omitted scope = GLOBAL only (no-project wake). */
  loadMemory(agentId: string, queryText: string, limits?: {
    semantic?: number; recent?: number; total?: number;
  }, scope?: {
    projectIds?: readonly string[];
    conversationIds?: readonly string[];
  }): Promise<MemoryRow[]>
  /** Per-conversation recent history for every convo with unread items.
   *  Implementations must treat conversationIds as selectors, not proof of
   *  access, and enforce the authenticated tenant + current membership. */
  loadContext(agentId: string, companyId: string, conversationIds: string[]): Promise<ContextRow[]>
  /** Agent's feelings about people (the climate model). */
  loadClimate(agentId: string): Promise<ClimateRow[]>
  /** Index of installed skills (name + description only — progressive
   *  disclosure; full SKILL.md loaded lazily). */
  loadSkillsIndex(agentId: string): Promise<SkillIndexEntry[]>
  /** Participant avatar portraits — for every id passed in, returns
   *  the public URL if a portrait exists. */
  loadFaces(participantIds: string[]): Promise<FaceRow[]>

  // === Identity (system prompt) ===
  /** Full system prompt incl. IDENTITY.md / SOUL.md, persona, global
   *  rules, and team roster. Null when the agent isn't a real persona. */
  buildSystemPrompt(agentId: string): Promise<string | null>

  // === Status + presence ===
  /** Set the agent's status pill ('avail' / 'thinking' / 'working' / etc).
   *  Also broadcasts the status update over the appropriate channel. */
  setStatus(agentId: string, status: 'avail' | 'working' | 'thinking' | 'waiting' | 'resting'): Promise<void>
  /** Renew a busy-status lease without changing the semantic status —
   *  used by the per-turn keep-alive heartbeat so the UI doesn't show
   *  the agent as stale mid-turn. */
  heartbeatStatus(agentId: string, status: 'working' | 'thinking' | 'waiting'): Promise<void>
  /** Publish a "typing in convo X" indicator. Multiple calls coalesce
   *  visually; pass `done: true` to clear. */
  publishTyping(args: {
    conversationId: string
    agentId: string
    done: boolean
    companyId?: string | null
  }): Promise<void>

  /** Mark this agent as "thinking about" a set of conversations — like a
   *  typing indicator, but at the protocol level and visible to PEER
   *  agents (not just the renderer). The claim timestamp is preserved
   *  across heartbeats so peers can tell who started first. Auto-
   *  expires; the turn loop refreshes the lease periodically. Used
   *  by `cumora glance` so agents can read the room before they
   *  commit a reply. */
  markThinking(agentId: string, conversationIds: string[], ttlSec?: number): Promise<void>
  /** Drop the thinking claim. Best-effort — TTL will clean up if this
   *  call fails. */
  unmarkThinking(agentId: string, conversationIds: string[]): Promise<void>
  /** Agents currently composing in this conversation, ORDERED by who
   *  claimed first (earliest claim → first in the list). The agent
   *  prompt uses this ordering to decide whether to yield: a peer
   *  whose claim is earlier than yours has the floor for redundant-
   *  angle broadcasts. */
  peekThinking(conversationId: string): Promise<Array<{ agentId: string; claimedAt: number }>>

  /** Stake a claim on a piece of in-flight work so peer agents can
   *  avoid duplicating it. `scopeKey` is the namespace: use
   *  `tenant:<companyId>` for company-wide actions (web search, doc
   *  draft, image gen — anything where two agents in the same org
   *  shouldn't be doing the same thing in parallel), or
   *  `convo:<conversationId>` for actions tied to a specific
   *  conversation. The (taskType, subject) pair within a scope is the
   *  dedup key — normalized subject = lowercased, trimmed, whitespace-
   *  collapsed, truncated. Returns `{ accepted: true }` if the claim is
   *  now held by `agentId`; `{ accepted: false, existing }` if a peer
   *  already holds it (caller should yield + react instead). Lease
   *  auto-expires after `ttlSec` (default 300s) so a crashed agent
   *  can't permanently block work. */
  claimWork(args: {
    scopeKey: string
    agentId: string
    taskType: WorkTaskType
    subject: string
    ttlSec?: number
  }): Promise<
    | { accepted: true }
    | { accepted: false; existing: WorklogEntry }
  >
  /** Release a previously-held claim. Best-effort — TTL cleans up on
   *  failure. Safe to call even if not the holder (no-op). */
  releaseWork(args: {
    scopeKey: string
    agentId: string
    taskType: WorkTaskType
    subject: string
  }): Promise<void>
  /** All in-flight work claims in this scope. Surfaced in the wake
   *  prompt so peers see "Iris is web-searching X (12s ago)" before
   *  deciding to do redundant work. */
  peekWorklog(scopeKey: string): Promise<WorklogEntry[]>
  /** Is a HUMAN actively watching this company (read activity anywhere within
   *  the window)? The triage loop cap's SUPERVISION signal — elevates
   *  agent-only activity side-rooms (which may exclude the human by the
   *  activity's own rules) to the HIGH backstop. Server-side DB fact; the
   *  HTTP client conservatively answers false (the BYOA daemon never builds
   *  triage requests itself — the server does). */
  humanRecentlyActive(companyId: string, windowMinutes?: number): Promise<boolean>

  // === Observability ===
  /** Open a new agent_runs row; returns the runId for subsequent calls. */
  createRun(args: {
    agentId: string
    companyId?: string | null
    trigger?: Record<string, unknown>
    inputMessageIds?: string[]
    inboxCount?: number
    fingerprint?: string
  }): Promise<string>
  /** Append one event to agent_events for live observability. */
  recordEvent(event: {
    runId: string
    agentId: string
    companyId?: string | null
    kind: string
    level?: 'debug' | 'info' | 'warn' | 'error'
    title: string
    data?: Record<string, unknown>
    stage?: string
  }): Promise<void>
  /** Close out the run with final status + totals. `model` + `usage` (optional)
   *  let the server store a cache-aware effective cost for the turn. */
  finishRun(args: {
    runId: string
    status: 'running' | 'completed' | 'failed' | 'skipped'
    summary?: string
    error?: string | null
    toolCallCount?: number
    tokenCount?: number
    model?: string | null
    usage?: RuntimeTokenUsage | null
  }): Promise<void>

  /** Drop a kind='system' notice message into a conversation so members see
   *  WHY the agents went silent (LLM quota exhausted, provider down, etc.).
   *  Body shape: `{ kind: 'notice', noticeKind, text }` — SystemRow renders
   *  the text as a centered italic line.
   *
   *  `dedupeKey` + `dedupeTtlSec` deduplicate via Redis NX/EX so multiple
   *  agents 429-ing in the same room don't all post the same notice. Returns
   *  `{ posted }` — false when the dedupe window swallowed it. */
  postSystemNotice(args: {
    conversationId: string
    companyId?: string | null
    /** Author of the system row — typically the agent that hit the condition. */
    agentId: string
    /** Machine-readable category — surfaced to the agent prompt + future
     *  client-side handling. Free-form for now; e.g. 'quota_exhausted'. */
    noticeKind: string
    /** Plain-text body rendered as the centered system row. */
    text: string
    dedupeKey: string
    dedupeTtlSec: number
  }): Promise<{ posted: boolean }>

  // === Steering busy heartbeat ===
  /** Renew the per-agent "busy" lease in Redis. The cumora-server
   *  reads `busy:<agentId>` when a new user message lands to decide
   *  whether to deliver a steer event (mid-turn injection) or a
   *  plain wake (post-turn pick-up). The pod calls this at turn
   *  start and every ~2s during the turn; TTL is 5s so a crashed
   *  pod auto-clears. Fire-and-forget on the pod side. */
  recordBusyHeartbeat(agentId: string, ttlSec?: number): Promise<void>

  /** Drop the busy lease early (turn finished cleanly). Without this
   *  the lease just times out via TTL; calling it explicitly tightens
   *  the racy window between turn-end and the next message arriving. */
  clearBusyHeartbeat(agentId: string): Promise<void>

  /** Advance the per-agent conversation_reads cursor to (at least) the
   *  given message's created_at. Used at turn end to mark messages
   *  the agent already consumed via a steer drain mid-turn — without
   *  this, the next wake's loadInbox would surface those messages
   *  again and the agent would re-process them. Idempotent: if the
   *  cursor is already past, this is a no-op. */
  markConversationRead(args: {
    agentId: string
    conversationId: string
    upToMessageId: string
  }): Promise<void>
}
