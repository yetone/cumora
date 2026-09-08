export type AgentRole = 'researcher' | 'designer' | 'engineer' | 'pm' | 'brand' | 'ops'
export type ParticipantKind = 'agent' | 'human'
export type Status = 'avail' | 'working' | 'thinking' | 'waiting' | 'resting'

/** Where an agent runs. 'cloud' = the built-in Cumora Cloud (managed engine);
 *  'local'/'vps' = a computer the user paired, running the BYOA daemon. */
export type ComputerKind = 'cloud' | 'local' | 'vps'
export type ComputerStatus = 'online' | 'offline' | 'busy'
/** Engine an agent's host runs it on. 'managed' = Cumora's server-side loop. */
export type EngineId = 'managed' | 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'pi' | 'gemini' | 'qwen' | 'antigravity'

export interface EngineModelOption {
  id: string
  label: string
  description?: string | null
  recommendedFor?: Array<'big' | 'small'>
}

export interface EngineModelCatalog {
  models: EngineModelOption[]
  defaultModel: string | null
  defaultFastModel: string | null
  prefersLocalDefault?: boolean
  supportsCustom: boolean
  fastModelScope: 'agent' | 'computer' | 'unsupported'
  source: 'protocol' | 'cli' | 'presets'
}

export interface DetectedEngine {
  id: EngineId
  bin: string
  path: string | null
  /** Installed version on that computer, and the newest one upstream. Null
   * when the probe found nothing or the daemon predates version reporting. */
  version?: string | null
  latest?: string | null
  outdated?: boolean
  /** How to update this engine on that computer (vendor updater, brew, or npm). */
  updateCommand?: string | null
  /** Set when Cumora refuses to drive an installed engine. */
  blockedReason?: string | null
  /** Models visible to the CLI login/config on this specific computer. */
  modelCatalog?: EngineModelCatalog
}

export interface Computer {
  id: string
  name: string
  kind: ComputerKind
  status: ComputerStatus
  availableEngines: EngineId[]
  /** Last PATH snapshot from the daemon (bin + resolved path). */
  /** Engines installed on THIS computer, as reported by the daemon running on
   *  it. Never a scan of whichever machine is displaying the card — see
   *  server/src/agents/computer/cli-version.ts. */
  detectedEngines?: DetectedEngine[]
  enginesDetectedAt?: string | null
  lastSeenAt?: string | null
  pairedAt?: string | null
  /** The cumora daemon version this computer is running (null = cloud / unknown). */
  daemonVersion?: string | null
  /** How the daemon runs: true = installed service (launchd/systemd),
   *  false = manually-run foreground command, null = cloud / unknown. */
  daemonSupervised?: boolean | null
  /** Newest published daemon version (for the upgrade banner). */
  latestDaemonVersion?: string | null
  /** True when the daemon is behind the latest version → show the upgrade banner. */
  daemonOutdated?: boolean
}

export interface Participant {
  id: string
  kind: ParticipantKind
  name: string
  role?: string
  initial: string
  /** linear-gradient or any css background — fallback when avatarUrl is empty */
  avatarBg: string
  /** AI-generated portrait URL (preferred over avatarBg when set) */
  avatarUrl?: string | null
  status: Status
  statusUpdatedAt?: string
  bio?: string
  tools?: string[]
  /** the agent's distinctive style — only set for agents */
  systemPrompt?: string
  /** big-brain (main) model override; null/undefined = use system default */
  model?: string | null
  /** small-brain (fast/auxiliary) model override */
  fastModel?: string | null
  /** id of the Computer this agent runs on (null/undefined = Cumora Cloud) */
  computerId?: string | null
  /** engine the agent's host runs it on ('managed' for cloud agents) */
  engine?: EngineId | null
  /** true = follow the computer's default engine; false = pin `engine` */
  engineInherit?: boolean
  /** Real external email address. Agents get one of the form
   *  `<id>@<companySlug>.<EMAIL_DOMAIN>` (auto-minted on first use);
   *  humans carry their auth email here for the renderer's contact
   *  picker. Null when the email feature isn't configured. */
  email?: string | null
  /** non-null = agent has been off-boarded; ISO timestamp of when */
  departedAt?: string | null
}

export type ConversationKind = 'group' | 'direct' | 'whisper' | 'email'

export interface Conversation {
  id: string
  kind: ConversationKind
  title: string
  /** display subtitle - members or whisper pair */
  subtitle?: string
  /** free-form purpose / topic line, editable by any member */
  topic?: string | null
  /** participant ids */
  members: string[]
  /** for whispers: the two agents in private chat */
  whisperPair?: [string, string]
  pinned?: boolean
  /** Per-user mute. When true, the conversation suppresses notifications and
   *  is excluded from the global unread total (but its per-row badge still
   *  shows). Pair with `mutedUntil` to know when the mute auto-expires. */
  muted?: boolean
  /** ISO timestamp when the mute auto-expires; null/undefined = forever. */
  mutedUntil?: string | null
  unread?: number
  /** Latest persisted message id from the conversation list payload. Used to
   *  detect when the sidebar preview has advanced past the open transcript. */
  lastMessageId?: string | null
  lastAt: string
  /** Raw ISO timestamp the row was last touched (last message time, or
   *  the conversation's own updatedAt when there are no messages yet).
   *  Server returns the list in this order; we keep the raw value so any
   *  client-side re-sort uses real time rather than the display label. */
  lastAtIso: string
  preview: string
  /** optional special tag */
  tag?: 'team' | 'whisper' | 'human' | 'fresh-pulled'
  /** if pulled by an agent: the convener id and reason */
  pulledBy?: { agentId: string; at: string; reason: string }
  /** when this conversation belongs to a project, the project's id + name + tint */
  projectId?: string | null
  projectName?: string | null
  projectColor?: string | null
}

export type MessageKind = 'text' | 'tool' | 'attachment' | 'whisper-link' | 'thought' | 'system' | 'email' | 'poll'

/* ============== Polls (lightweight votes inline in any conversation) ====== */

export interface PollOption {
  id: string
  text: string
}

export interface PollPayload {
  question: string
  mode: 'single' | 'multi'
  options: PollOption[]
  /** iso timestamp; null = no expiration */
  expiresAt: string | null
  /** iso when manually or auto-closed; null while open */
  closedAt: string | null
  closedReason: 'expired' | 'manual' | null
}

export interface PollTally {
  optionId: string
  count: number
  /** participant ids of voters who picked this option, sorted ASC. */
  voterIds: string[]
}

/** Headers + transport status for a single email message. Populated by the
 *  server's `/conversations/:id/messages` LEFT JOIN against `email_messages`,
 *  so it's only present when `Message.kind === 'email'`. */
export interface EmailFields {
  subject: string
  /** "Name <addr@host>" or just "addr@host" — already formatted for display. */
  from: string
  to: string[]
  cc: string[]
  /** 'in'  = arrived from outside via the Cloudflare Email Worker;
   *  'out' = sent by an agent / human in this workspace. */
  direction: 'in' | 'out'
  /** 'queued' | 'sent' | 'failed' | 'received' — drives the bubble's
   *  failed-state badge and the "still being sent" spinner. */
  transportStatus: string
  transportError?: string | null
  /** RFC 5322 Message-ID, bracket-less. Useful for debug overlays + the
   *  reply-thread anchor when the renderer eventually adds compose. */
  smtpMessageId?: string | null
  inReplyTo?: string | null
  hasHtml?: boolean
  /** RFC 3834 Auto-Submitted marker. true when the row was originated by
   *  automation — heartbeat, agent CLI, or an upstream vacation responder.
   *  The renderer can use this to dim auto-replies or keep them out of
   *  the "needs human attention" count. */
  autoSubmitted?: boolean
  /** Attachments parsed from the original MIME message. Inbound mail
   *  uploads bytes to object storage during the webhook flow; the renderer
   *  receives a signed download URL on each entry. `truncated` means the
   *  upstream attachment was too big to forward — metadata only, no bytes. */
  attachments?: Array<{
    id: string
    filename: string
    mimeType: string
    sizeBytes: number
    url: string | null
    truncated?: boolean
  }>
}

export interface ReactionEntry {
  emoji: string
  count: number
  mine?: boolean
  /** participant ids of who reacted with this emoji, sorted */
  users?: string[]
}

/** Minimal inlined view of a quoted-original — server resolves this on read so
 *  the renderer can draw the quote card without per-bubble fetches. Body is
 *  truncated to ~240 chars; full original lives at `quoted.id` if needed. */
export interface QuotedSummary {
  id: string
  authorId: string
  authorName?: string
  kind: MessageKind
  body: string
  sequence: number
}

export interface Message {
  id: string
  conversationId: string
  authorId: string
  kind: MessageKind
  body: string
  at: string
  reactions?: ReactionEntry[]
  /** for tool messages */
  tool?: {
    name: string
    arg: string
    status: string
    detail: string
    icon?: 'web' | 'github' | 'figma' | 'db'
  }
  /** for attachments */
  attachment?: {
    name: string
    /** kind 'img' renders inline; others render as a file card */
    kind: 'img' | 'pdf' | 'file' | 'fig'
    /** real assets carry a URL; mock/legacy data may not */
    url?: string
    /** Storage key used to refresh expiring signed URLs. */
    key?: string
    mime?: string
    size?: number
    /** legacy descriptor — fallback when no real file is present (e.g. mock data) */
    meta?: string
  }
  /** for whisper-link cards in main chat */
  whisperLink?: {
    pair: [string, string]
    snippet: string
    count: number
  }
  /** Populated by the server when kind === 'email'. Carries headers,
   *  direction, and transport status so the email bubble can render the
   *  "subject + from / to / cc + sent/failed" chrome. */
  email?: EmailFields
  /** Populated by the server when kind === 'poll'. */
  poll?: PollPayload
  /** Per-option aggregated tallies for kind === 'poll'. Empty array for
   *  any other message kind. Updated in place by `poll.updated` WS events. */
  pollTallies?: PollTally[]
  /** Reply-to / quote pointer: the id of another message in this same
   *  conversation that this one is quoting. Null for non-reply messages. */
  quotedMessageId?: string
  /** Inlined summary of the quoted-original, resolved server-side so the
   *  renderer can draw the quote card without a second roundtrip. Missing
   *  when the original was deleted — bubble renders "[deleted]". */
  quoted?: QuotedSummary
  /** Number of OTHER messages quoting this one. Drives the "N 条回复" link
   *  under the bubble that opens the thread drawer. Server-computed on
   *  fetch; 0 / undefined means no replies. */
  replyCount?: number
  /** Optimistic-render flags. Only set on locally-inserted messages awaiting
   *  the server round-trip; never returned from the API. */
  pending?: boolean
  failed?: boolean
  /** The request may have committed, but neither HTTP nor WS confirmed it. */
  unconfirmed?: boolean
  /** Stable idempotency key that also survives the temp-id → real-id rename. */
  clientId?: string
}

export interface ViewKey {
  view: 'conversations' | 'whispers' | 'convene' | 'agents' | 'boards' | 'calendar' | 'documents' | 'shipping' | 'observability' | 'me' | 'library'
}

/* ============== Calendar (AI-native shared schedule) ============== */

/** Minimal recurrence rule — mirrors the server-side shape in
 *  `server/src/calendar.ts`. We keep this client-side type narrow on
 *  purpose: anything not expressible here is rejected at the form layer
 *  rather than silently dropped on save. */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  /** 0=Sun … 6=Sat. Only used when freq='weekly'. */
  byweekday?: number[]
  /** Inclusive ISO timestamp upper bound for the series. */
  until?: string | null
  /** Hard cap on total firings. */
  count?: number | null
}

export type CalendarEventKind = 'personal' | 'agent_task'
export type CalendarEventStatus = 'active' | 'paused' | 'done' | 'cancelled'
export type CalendarReminderChannel = 'toast' | 'email' | 'both'

export interface CalendarEvent {
  id: string
  companyId: string
  createdBy: string
  kind: CalendarEventKind
  title: string
  description: string | null
  /** Participant id (agent or human) that this event "fires at" — only
   *  meaningful when kind='agent_task'. Personal events ignore it. */
  assigneeId: string | null
  /** Conversation the dispatch message lands in on each firing. Null =
   *  scheduler will fall back to the creator↔assignee DM if it exists. */
  targetConversationId: string | null
  /** The body posted on each occurrence (rendered as a system message). */
  agentPrompt: string | null
  startAt: string
  endAt: string | null
  allDay: boolean
  recurrence: RecurrenceRule | null
  status: CalendarEventStatus
  lastFiredAt: string | null
  /** Pre-event heads-up: notify N minutes before each occurrence. Null
   *  means no reminder. Paired with `reminderChannel`. */
  reminderMinutesBefore: number | null
  reminderChannel: CalendarReminderChannel | null
  /** When true, only the row's `createdBy` and `assigneeId` can see it.
   *  The company owner additionally sees private rows where either side
   *  is an agent (workspace-supervision affordance). Default false. */
  isPrivate: boolean
  createdAt: string
  updatedAt: string
}

export interface CalendarDispatch {
  id: string
  eventId: string
  scheduledFor: string
  dispatchedAt: string
  status: string
  conversationId: string | null
  messageId: string | null
  error: string | null
}

/* ============== Kanban boards ============== */

export interface BoardSummary {
  id: string
  title: string
  description: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface BoardColumn {
  id: string
  title: string
  position: number
  createdAt: string
}

export interface BoardCard {
  id: string
  boardId: string
  columnId: string
  title: string
  description: string | null
  position: number
  assigneeId: string | null
  mentions: string[]
  commentCount: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface BoardCardComment {
  id: string
  authorId: string
  body: string
  mentions: string[]
  createdAt: string
}

export interface BoardSnapshot extends BoardSummary {
  columns: BoardColumn[]
  cards: BoardCard[]
}

export interface BoardCardLookup {
  board: BoardSummary
  column: BoardColumn
  card: BoardCard
}
