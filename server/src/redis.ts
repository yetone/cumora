import IORedis from 'ioredis'
import { env } from './env.js'

// When the agent runtime is in http mode (pod talking to a remote
// server), Redis is never used from this process — every pub/sub flows
// through /runtime/* on the server side. Connect lazily so the bundle
// doesn't spam ECONNREFUSED logs in pods that don't have a Redis
// nearby. In server mode the first publish/subscribe wakes it up
// instantly.
const lazyConnect = process.env.CUMORA_RUNTIME_CLIENT === 'http'

/** Single shared client for normal commands. */
export const redis = new IORedis(env.REDIS_URL, {
  // Durable writes must never hang forever after PostgreSQL COMMIT while a
  // disconnected Redis client quietly accumulates an offline queue. Callers
  // can now fail-open or retry explicitly within a bounded deadline.
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 2_000,
  enableReadyCheck: true,
  lazyConnect,
})

/** Separate connection for blocking SUBSCRIBE — required by the Redis protocol. */
export const sub = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect,
})

redis.on('error', (e) => console.error('[redis]', e))
sub.on('error', (e) => console.error('[redis sub]', e))

/* === Channel keys === */
export const CH_MESSAGE_NEW = 'cumora:msg.new'
export const CH_MESSAGE_DELTA = 'cumora:msg.delta'
export const CH_TYPING = 'cumora:typing'
export const CH_STATUS = 'cumora:status'
export const CH_REACTIONS = 'cumora:reactions'
export const CH_POLLS = 'cumora:polls'
export const CH_GROUP_PULLED = 'cumora:group.pulled'
export const CH_CONVO_UPDATED = 'cumora:convo.updated'
export const CH_CONVENE = 'cumora:convene'
export const CH_BOARDS = 'cumora:boards'
export const CH_DOCS = 'cumora:docs'
/* === Collaborative documents (CRDT) ===
 *
 * Yjs binary updates are base64-encoded into the JSON envelope so they
 * fan out through the same Redis bus + WS path as every other event.
 * `originId` is the WS client (or agent) that produced the update so the
 * fan-out can echo-suppress on the sender's own socket. */
export const CH_DOC_UPDATE = 'cumora:doc.update'
export const CH_DOC_AWARENESS = 'cumora:doc.awareness'
/** A user / agent was @-mentioned inside a doc. Fanned out via the
 *  generic tenant-scoped WS bridge (NOT the per-doc subscription
 *  bridge) — recipients listen by their participant id, regardless of
 *  whether they currently have the doc open. */
export const CH_DOC_MENTION = 'cumora:doc.mention'
export const CH_CALENDAR_REMINDER = 'cumora:calendar.reminder'
/** Calendar row CRUD + dispatch-driven status changes. Sent on create /
 *  update / delete / cancel / run-now / dispatcher auto-done so every
 *  client in the company can patch their Calendar view in real time. */
export const CH_CALENDAR_EVENTS = 'cumora:calendar.events'
/** Workspace membership/role invalidation. Unlike ordinary tenant broadcasts,
 * removal/deletion events must still reach users whose company_members row has
 * already gone, so the WS bridge routes this channel by recipientUserIds. */
export const CH_WORKSPACES = 'cumora:workspaces'

/* === Event types ===
 *
 * Multi-tenant note: every event carries an optional `companyId`. The WS
 * fan-out filters payloads against the receiving socket's set of company
 * memberships. Events without `companyId` are treated as conservatively
 * routable (skipped) — keep the field populated at every publish site.
 */
interface TenantTagged {
  companyId?: string
  /** Stable transactional-outbox delivery id. Redis delivery is at-least-once. */
  deliveryId?: string
}

export interface MessageNewEvent extends TenantTagged {
  type: 'message.new'
  conversationId: string
  message: {
    id: string
    conversationId: string
    authorId: string
    kind: string
    body: string
    sequence: number
    at: string
    reactions?: unknown
    tool?: unknown
    attachment?: unknown
    /** Echoed verbatim from the POST body when the sender provided one.
     *  The renderer uses it to dedup the WS echo against its still-temp
     *  optimistic bubble when the WS event races the POST response — id
     *  alone can't match because the optimistic is keyed by tempId. */
    clientId?: string
    /** Durable one-shot recipient for membership departure notices. The
     * scheduler verifies this value against the persisted message before
     * adding it to wake fan-out. */
    deliveryRecipientId?: string
    /** When this message is a reply, the id of the quoted-original. */
    quotedMessageId?: string
    /** Inlined summary so the renderer can draw the quote card on receipt
     *  without re-fetching. Matches the QuotedSummary shape used elsewhere. */
    quoted?: {
      id: string
      authorId: string
      authorName: string
      kind: string
      body: string
      sequence: number
    }
    /** Set when kind === 'email'. Mirrors the EmailFields shape on the
     *  renderer side so a freshly arriving email bubble renders correctly
     *  without waiting for a full /messages refetch. */
    email?: {
      subject: string
      from: string
      to: string[]
      cc: string[]
      direction: 'in' | 'out'
      transportStatus: string
      transportError?: string | null
      smtpMessageId?: string | null
      inReplyTo?: string | null
      hasHtml?: boolean
      /** RFC 3834: true when the row was originated by automation
       *  (heartbeat, agent CLI, vacation responder upstream). Renderer
       *  uses it to dim auto-replies or filter them out of unread. */
      autoSubmitted?: boolean
      /** Inbound + outbound attachments. Already resolved to public URLs
       *  by the sender; truncated entries carry url=null. */
      attachments?: Array<{
        id: string
        filename: string
        mimeType: string
        sizeBytes: number
        url: string | null
        truncated?: boolean
      }>
    }
    /** Set when kind === 'poll'. Mirrors the PollPayload shape on the
     *  renderer side so a freshly-created poll bubble can render its
     *  question + options without waiting for a /messages refetch. */
    poll?: {
      question: string
      mode: 'single' | 'multi'
      options: Array<{ id: string; text: string }>
      expiresAt: string | null
      closedAt: string | null
      closedReason: 'expired' | 'manual' | null
    }
    /** Empty array on poll creation; real tallies arrive via the
     *  separate PollUpdatedEvent stream. Included here so the renderer
     *  doesn't have to special-case undefined → empty for fresh polls. */
    pollTallies?: Array<{
      optionId: string
      count: number
      voterIds: string[]
    }>
  }
}

export interface MessageDeltaEvent extends TenantTagged {
  type: 'message.delta'
  conversationId: string
  messageId: string
  authorId: string
  delta: string
  /** sequence number for this in-flight message; assigned at start */
  sequence: number
  /** when true, no more deltas — final body has been written to DB */
  done: boolean
}

export interface TypingEvent extends TenantTagged {
  type: 'typing'
  conversationId: string
  /** which agent's status changed */
  agentId: string
  /** false = started typing; true = stopped */
  done: boolean
}

export interface StatusEvent extends TenantTagged {
  type: 'participants.status'
  participantId: string
  status: string
  statusUpdatedAt?: string
}

/** Fired when a BYOA Computer (agent host) goes online/offline. Clients
 *  patch their local computers store so the Computers panel + agent chips
 *  reflect host availability live. */
export interface ComputerStatusEvent extends TenantTagged {
  type: 'computers.status'
  computerId: string
  status: 'online' | 'offline' | 'busy'
}

/** Fired when an agent's avatar gets (re-)generated. Clients patch their
 *  local participants store so the new portrait appears without waiting
 *  for the periodic refresh tick. */
export interface AvatarEvent extends TenantTagged {
  type: 'participants.avatar'
  participantId: string
  avatarUrl: string
}

/** Fired when a human accepts an invite (or is otherwise newly mirrored
 *  into a company's `participants`). Existing members upsert their local
 *  byId map so the newcomer shows up in member chips / conversation
 *  rosters without waiting for the 60s background refresher. Also drives
 *  the conversations store to add the new id to the all-hands members
 *  array so the per-row member-count badges update live. */
export interface ParticipantAddedEvent extends TenantTagged {
  type: 'participants.added'
  /** id + display fields needed to render the participant immediately.
   *  Mirrors the ApiParticipant shape narrowly so the frontend can patch
   *  byId without a refetch. */
  participant: {
    id: string
    kind: 'human' | 'agent'
    name: string
    role: string | null
    initial: string
    avatarBg: string
    avatarUrl: string | null
    status: string
    statusUpdatedAt: string | null
  }
  /** When the join coincided with being added to a specific conversation
   *  (typically #all-hands), the convo id — so clients can surgically
   *  patch that convo's members list. */
  conversationId?: string
}

export interface ReactionsEvent extends TenantTagged {
  type: 'message.reactions'
  conversationId: string
  messageId: string
  reactions: Array<{ emoji: string; count: number; mine?: boolean }>
}

export interface ConversationUpdatedEvent extends TenantTagged {
  type: 'conversation.updated'
  conversationId: string
  /** what changed (so clients can patch surgically instead of refetching) */
  patch: { topic?: string | null; title?: string }
}

export interface GroupPulledEvent extends TenantTagged {
  type: 'group.pulled'
  conversationId: string
  pulledById: string
}

export interface ConveneEvent extends TenantTagged {
  type: 'convene'
  sessionId: string
  conversationId: string
  /** small payload — the frontend will refetch full state */
  kind: 'started' | 'transcript' | 'ended' | 'tile'
  data?: unknown
}

/** Kanban board mutation broadcasts. Coarse-grained on purpose: each event
 *  carries the boardId of the affected board, and the client refetches
 *  that board's state. The card-level shape (id, columnId, position…) is
 *  echoed so the renderer can patch in place when it wants to skip a
 *  refetch — e.g. an optimistic drag-drop that already moved the card.
 *  Mention targets are echoed too so the notification toaster can chime
 *  for the recipient without diffing the card body. */
export interface BoardEvent extends TenantTagged {
  type: 'board.changed'
  /** what changed. Coarse — the renderer refetches on any of these. */
  kind:
    | 'board.created' | 'board.updated' | 'board.deleted'
    | 'column.created' | 'column.updated' | 'column.deleted'
    | 'card.created' | 'card.updated' | 'card.moved' | 'card.deleted'
    | 'comment.created' | 'comment.deleted'
  boardId: string
  cardId?: string
  columnId?: string
  commentId?: string
  /** Parsed @-mentions in the changed entity (card title/description or
   *  comment body). Frontends watch this for "I was just @-mentioned"
   *  toasts even when the user isn't actively viewing the board. */
  mentions?: string[]
  /** Actor who triggered the change — used to suppress self-notifications. */
  actorId?: string
}

/** Document metadata/listing changed. Content sync still uses the CRDT
 *  doc channels below; this event only tells clients to refresh the
 *  document index so newly-created agent docs appear immediately. */
export interface DocIndexEvent extends TenantTagged {
  type: 'doc.changed'
  kind: 'document.created' | 'document.updated' | 'document.deleted'
  documentId: string
  actorId?: string
}

/** A Yjs binary update has been applied to a doc room. Carried base64
 *  because the WS path is JSON-only. originId is the WS client / agent id
 *  that produced the update — listeners on that same client echo-suppress. */
export interface DocUpdateEvent extends TenantTagged {
  type: 'doc.update'
  documentId: string
  /** Base64-encoded Y.js update bytes (incremental, not full state). */
  updateB64: string
  /** Stable id of whatever produced this update. WS subscribers ignore
   *  events whose originId matches the id their socket carries. */
  originId: string
  /** Free-form author for activity / "agent just edited" notices. Usually
   *  a user id or agent id; may be the same as originId. */
  authorId: string
}

/** Awareness (cursors, selection, presence info) — ephemeral, not
 *  persisted. Same fan-out path as updates. */
export interface DocAwarenessEvent extends TenantTagged {
  type: 'doc.awareness'
  documentId: string
  updateB64: string
  originId: string
}

/** One or more participants were @-mentioned in a doc. Carries enough
 *  metadata that the renderer can paint a toast WITHOUT a round trip:
 *  doc title, mentioner display name, the list of mentioned ids. The
 *  receiving client filters by checking whether the active user's id is
 *  in `mentionedIds`. */
export interface DocMentionEvent extends TenantTagged {
  type: 'doc.mention'
  documentId: string
  documentTitle: string
  mentionerId: string
  mentionerName: string
  mentionedIds: string[]
}

/** "Heads-up — this calendar event fires in N minutes." Broadcast on
 *  CH_CALENDAR_REMINDER; the WS bridge resolves recipientUserIds against live
 *  workspace membership before routing. The renderer repeats the filter as
 *  defense in depth. Recipients may be empty for agent-only events. */
export interface CalendarReminderEvent extends TenantTagged {
  type: 'calendar.reminder'
  eventId: string
  title: string
  occurrenceAt: string
  /** Minutes between now and occurrenceAt at fire time, for the toast copy. */
  leadMinutes: number
  /** When non-empty, the renderer only shows the toast if the local user
   *  id appears here. Agents are intentionally excluded (they're already
   *  woken via the dispatch path). */
  recipientUserIds: string[]
  /** Surfaces in the toast subtitle. */
  kind: 'personal' | 'agent_task'
  assigneeId: string | null
}

/** A calendar row was created / updated / deleted. We deliberately keep
 *  the payload thin — clients refetch the affected row (or the whole
 *  list, when the event signals a deletion) rather than diffing inline.
 *  This matches how `doc.changed` works and avoids having to keep two
 *  CalendarEventPayload encoders in sync (router vs. CLI). */
export interface CalendarEventChangedEvent extends TenantTagged {
  type: 'calendar.changed'
  kind:
    | 'event.created'
    | 'event.updated'
    | 'event.deleted'
    | 'event.dispatched'
  eventId: string
  /** When non-null, the participant id that drove this change. Useful
   *  for renderers that want to avoid echoing the actor's own
   *  optimistic write back at them. */
  actorId: string | null
}

export interface WorkspaceMembershipEvent extends TenantTagged {
  type: 'workspace.membership'
  kind: 'role_changed' | 'removed' | 'workspace_deleted'
  recipientUserIds: string[]
  actorId: string
  userId?: string
  role?: 'admin' | 'member'
}

/** Poll state changed — a new vote was cast, an existing vote was changed,
 *  or the poll was closed (manually or by the expiration sweeper). Carries
 *  the full denormalized poll snapshot so renderers can patch in place
 *  without a refetch. */
export interface PollUpdatedEvent extends TenantTagged {
  type: 'poll.updated'
  conversationId: string
  messageId: string
  /** Poll payload as stored on messages.poll — includes closedAt when this
   *  event marks the poll as closed. */
  poll: {
    question: string
    mode: 'single' | 'multi'
    options: Array<{ id: string; text: string }>
    expiresAt: string | null
    closedAt: string | null
    closedReason: 'expired' | 'manual' | null
  }
  /** Aggregated vote rollup: one entry per option with count + voter ids.
   *  voterIds is a stable sort so diffing across events is cheap. */
  tallies: Array<{
    optionId: string
    count: number
    voterIds: string[]
  }>
  /** The actor that triggered this event (vote.cast / vote.changed / closed).
   *  For server-driven expiration this is null. */
  actorId: string | null
}

export type BroadcastEvent = MessageNewEvent | MessageDeltaEvent | TypingEvent
  | StatusEvent | AvatarEvent | ParticipantAddedEvent | ReactionsEvent
  | GroupPulledEvent | ConversationUpdatedEvent | ConveneEvent
  | BoardEvent | DocIndexEvent | DocUpdateEvent | DocAwarenessEvent | DocMentionEvent | CalendarReminderEvent
  | CalendarEventChangedEvent
  | PollUpdatedEvent
  | ComputerStatusEvent
  | WorkspaceMembershipEvent

export async function publish(channel: string, event: BroadcastEvent): Promise<void> {
  await redis.publish(channel, JSON.stringify(event))
}
