import { create } from 'zustand'
import { api, ws, type ApiConversation, type ApiMessage } from '@/api/client'
import type { Conversation } from '@/types'
import { bySidebarOrder, lastMessageFromWs, timeFromIso } from '@/lib/conversationRow'
import { useApp } from '@/stores/app'
import { commitIfContextCurrent, useAuth } from '@/stores/auth'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'

interface ConversationsState {
  list: Conversation[]
  loaded: boolean
  load: () => Promise<void>
  reload: () => Promise<void>
  /**
   * Repaint one sidebar row from a `message.new` event.
   *
   * Every new message used to trigger a full `reload()` — a fresh
   * `GET /conversations` per online client per message, each one recomputing
   * the last message and unread count for every conversation in the
   * workspace. The event already carries the message, so the row can be
   * patched in place. Returns false when the conversation isn't in the list
   * yet and a fetch was issued instead.
   */
  applyIncomingMessage: (
    conversationId: string,
    message: ApiMessage,
    opts: { read: boolean },
  ) => boolean
  /** Clear a row's badge without waiting for the server round trip. */
  markLocallyRead: (conversationId: string) => void
}

/** Render a system-row JSON payload as a human-readable preview line.
 *  Returns null when the payload is unparseable so the caller can fall
 *  back to a generic '(system)' label instead of leaking raw JSON. */
function renderSystemPreview(
  raw: string,
  resolveName: (id: string) => string | null,
): string | null {
  try {
    const p = JSON.parse(raw) as { kind?: string; participantId?: string; actorId?: string; title?: string }
    if (p.kind === 'calendar_event') {
      const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : 'Calendar event'
      return `Calendar fired: ${title}`
    }
    if (!p.kind || !p.participantId) return null
    const subject = resolveName(p.participantId) ?? p.participantId
    const actor = p.actorId ? (resolveName(p.actorId) ?? p.actorId) : null
    switch (p.kind) {
      case 'joined':
        return actor && actor !== subject
          ? `${actor} added ${subject} to the group`
          : `${subject} joined the group`
      case 'left':
        return `${subject} left the group`
      case 'kicked':
        return actor
          ? `${actor} removed ${subject} from the group`
          : `${subject} was removed from the group`
      default:
        return `${subject} — ${p.kind}`
    }
  } catch {
    return null
  }
}

/**
 * Render a conversation row's preview line from its last message.
 *
 * Shared by the list fetch and the WS patch below, which is the point: a
 * `message.new` event carries everything this needs, so a new message can
 * repaint one row without refetching the list — but only if both paths agree
 * on how a preview is spelled. Two encoders would drift the moment either
 * grows a case.
 */
function previewOf(last: ApiConversation['lastMessage']): string {
  // Empty string when there's no message yet — the row renderer skips the
  // preview line entirely so an empty conversation doesn't show a stray "—".
  if (!last) return ''
  // Resolve the author's DISPLAY NAME from the participants store. If the
  // participant isn't loaded yet, omit the author prefix entirely — never
  // fall back to the raw id (which may carry a server-side collision
  // suffix like `iris-a0ab` that we shouldn't be exposing to UI).
  const meId = useAuth.getState().user?.id
  const byId = useParticipants.getState().byId
  const resolveName = (id: string): string | null => {
    if (id === meId) return 'You'
    return byId[id]?.name ?? null
  }
  const authorName = resolveName(last.authorId)
  // Rewrite raw `@<id>` mention tokens to `@<DisplayName>` so previews
  // don't leak participant ids like `@u-27c9522d-3b7`. Mirror the regex
  // used by parseBody() so we tokenize exactly what the chat renderer
  // treats as a mention. `@all` is preserved as-is.
  const humanizeMentions = (s: string): string =>
    s.replace(/@[A-Za-z][\w-]*/g, (m) => {
      const id = m.slice(1)
      if (id === 'all') return m
      const name = resolveName(id)
      return name ? `@${name}` : m
    })
  const trimmedBody = humanizeMentions(last.body?.trim() ?? '')
  if (last.kind === 'tool' && last.tool) {
    const t = last.tool as { name?: string; arg?: string }
    return authorName
      ? `${authorName}: used ${t.name ?? 'tool'}`
      : `used ${t.name ?? 'tool'}`
  }
  if (last.kind === 'email' && last.email) {
    // Subject leads — that's how mailbox apps preview a thread. Body
    // excerpt follows in muted text only when there's room.
    const arrow = last.email.direction === 'in' ? '↓' : '↑'
    const subject = last.email.subject || '(no subject)'
    const snippet = trimmedBody ? ` — ${trimmedBody.slice(0, 60)}` : ''
    return `${arrow} ${subject}${snippet}`
  }
  if (last.kind === 'system') {
    // System rows ship as JSON bodies — translate to a short
    // human-readable line ("Bram joined the group" / "Scout removed
    // Iris") instead of leaking raw `{"kind":"left",...}` payloads.
    return renderSystemPreview(last.body, resolveName) ?? '(system)'
  }
  if (last.attachment) {
    // Attachment messages (user uploads) — the row stores attachment
    // metadata in a separate jsonb column and `body` carries only the
    // optional caption. Prefix with a 📎 + filename so the row reads
    // as "shared a file" instead of going blank when the user uploads
    // without a caption.
    const a = last.attachment
    const verb = a.kind === 'img' ? '📷' : '📎'
    const filename = a.name ?? (a.kind === 'img' ? 'image' : 'file')
    const label = trimmedBody
      ? `${verb} ${filename} — ${trimmedBody.slice(0, 80)}`
      : `${verb} ${filename}`
    return authorName ? `${authorName}: ${label}` : label
  }
  if (trimmedBody) {
    return authorName ? `${authorName}: ${trimmedBody.slice(0, 100)}` : trimmedBody.slice(0, 100)
  }
  return ''
}

function fromApi(c: ApiConversation): Conversation {
  const last = c.lastMessage
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    subtitle: c.subtitle ?? undefined,
    topic: c.topic ?? null,
    members: c.members,
    pinned: c.pinned,
    muted: c.muted,
    mutedUntil: c.mutedUntil,
    unread: c.unreadCount > 0 ? c.unreadCount : undefined,
    lastMessageId: last?.id ?? null,
    lastAt: timeFromIso(last?.createdAt ?? c.updatedAt),
    lastAtIso: last?.createdAt ?? c.updatedAt,
    preview: previewOf(last),
    tag: (c.tag ?? undefined) as Conversation['tag'],
    pulledBy: c.pulledBy ?? undefined,
    projectId: c.projectId,
    projectName: c.projectName,
    projectColor: c.projectColor,
  }
}

function refreshActiveMessagesIfSidebarMoved(conversations: Conversation[]): void {
  const active = useApp.getState().selectedConversationId
  if (!active) return
  const activeConvo = conversations.find((c) => c.id === active)
  const lastMessageId = activeConvo?.lastMessageId
  if (!lastMessageId) return

  const messages = useMessages.getState()
  if (messages.loading.has(active)) return
  const cached = messages.byConvo[active]
  if (!cached && !messages.loaded.has(active)) return
  if (cached?.some((m) => m.id === lastMessageId)) return

  void messages.reloadConversation(active)
}

/**
 * "Effective" mute state: server says muted=true, AND any per-row expiry
 * hasn't lapsed since the last list reload. The server already filters
 * expired mutes out, but if the user keeps the app open past the expiry
 * (e.g. muted "for 15 min" and no traffic happens for 20), the local
 * cached row would still claim muted=true. Recompute against `now` so the
 * silence wears off without waiting for the next WS-triggered reload.
 */
export function isMuted(c: Pick<Conversation, 'muted' | 'mutedUntil'>): boolean {
  if (!c.muted) return false
  if (!c.mutedUntil) return true  // muted forever
  return new Date(c.mutedUntil).getTime() > Date.now()
}

export const useConversations = create<ConversationsState>((set, get) => ({
  list: [],
  loaded: false,
  async load() {
    // Clear stale data immediately so a workspace switch never shows the
    // previous tenant's conversations during the loading window.
    set({ list: [], loaded: false })
    try {
      await commitIfContextCurrent(() => api.getConversations(), (list) => {
        const conversations = list.map(fromApi)
        set({ list: conversations, loaded: true })
        refreshActiveMessagesIfSidebarMoved(conversations)
      })
    } catch (err) {
      console.warn('[conversations] load failed', err)
    }
  },
  async reload() {
    try {
      await commitIfContextCurrent(() => api.getConversations(), (list) => {
        const conversations = list.map(fromApi)
        set({ list: conversations })
        refreshActiveMessagesIfSidebarMoved(conversations)
      })
    } catch (err) {
      console.warn('[conversations] reload failed', err)
    }
  },
  applyIncomingMessage(conversationId, message, opts) {
    const existing = get().list.find((c) => c.id === conversationId)
    // A conversation we've never seen — a group just created, or one we were
    // added to. There is no row to patch, so fall back to a fetch.
    if (!existing) { void get().reload(); return false }

    const last = lastMessageFromWs(message)
    // The server counts unread as `author_id <> me AND created_at > last_read`.
    // Mirror the author half here: a message this user sent from the CLI or
    // another device echoes back over WS, and counting it would show a badge
    // that the next reconcile silently takes away again.
    const mine = message.authorId === useAuth.getState().user?.id
    const unread = opts.read
      ? undefined                                    // the user is looking at it
      : mine
        ? existing.unread                            // own message: no change
        : (existing.unread ?? 0) + 1
    const next: Conversation = {
      ...existing,
      lastMessageId: last.id,
      lastAt: timeFromIso(last.createdAt),
      lastAtIso: last.createdAt,
      preview: previewOf(last),
      unread,
    }
    const list = get().list.map((c) => (c.id === conversationId ? next : c)).sort(bySidebarOrder)
    set({ list })
    refreshActiveMessagesIfSidebarMoved(list)
    return true
  },
  markLocallyRead(conversationId) {
    set((s) => ({
      list: s.list.map((c) => (c.id === conversationId ? { ...c, unread: undefined } : c)),
    }))
  },
}))

// WS bindings are attached once for the page lifetime; data reload runs
// on every call so workspace switches (App.tsx remounts the tree on
// companyId change) pick up the new tenant's data.
let wsBound = false
export function bootConversations() {
  void useConversations.getState().load()
  if (wsBound) return
  wsBound = true
  ws.connect()
  ws.on((e) => {
    if (e.type === 'hello') {
      // WS (re)connected — Redis pubsub didn't queue events for the gap,
      // so any `message.new` / `group.pulled` / `conversation.updated`
      // that fired while we were disconnected is gone. Refetch the list
      // so last-message previews and unread badges backfill without a
      // manual page refresh.
      void useConversations.getState().reload()
      return
    }
    if (e.type === 'message.new') {
      // Patch the one row this message touched. The event carries the whole
      // message, so a refetch would only re-derive what we already have —
      // for every conversation in the workspace, on every online client.
      const active = useApp.getState().selectedConversationId
      const isActive = e.conversationId === active
      useConversations.getState().applyIncomingMessage(e.conversationId, e.message, { read: isActive })
      // Still tell the server the user has seen it, so the badge stays gone
      // across reloads and other devices. Local state is already correct, so
      // this no longer needs to be awaited before repainting.
      if (isActive) {
        void api.markRead(e.conversationId).catch(() => { /* retried on next view */ })
      }
      return
    }
    if (e.type === 'group.pulled') {
      // A group that did not exist a moment ago — there is no row to patch.
      void useConversations.getState().reload()
      return
    }
    if (e.type === 'conversation.updated') {
      // Surgical patch — apply patch fields to the matching conversation in
      // place without a full network reload.
      useConversations.setState((s) => ({
        list: s.list.map((c) => {
          if (c.id !== e.conversationId) return c
          const next: Conversation = { ...c }
          if (e.patch.topic !== undefined) next.topic = e.patch.topic
          if (e.patch.title !== undefined) next.title = e.patch.title
          return next
        }),
      }))
    }
  })
}
