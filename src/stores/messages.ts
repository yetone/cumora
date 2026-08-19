import { create } from 'zustand'
import type { Message, ReactionEntry } from '@/types'
import { api, ApiError, ws, type WsEvent, type ApiMessage } from '@/api/client'
import { useApp } from '@/stores/app'
import { getMeId } from '@/stores/auth'

const EMPTY_MESSAGES: Message[] = []

/** Default page size for both initial load and "load older". Matches the
 *  server's default cap; keep these in sync. */
export const MESSAGES_PAGE_SIZE = 80

/** Starting value for react-virtuoso's `firstItemIndex`. The virtualized
 *  message list anchors its scroll on prepend ONLY when we hand it a
 *  firstItemIndex that decreases by the number of rows prepended; without it,
 *  loading older history jumps the viewport or stalls at the top. Base is
 *  arbitrary-large so a long session of paging upward never reaches 0. */
export const VIRTUOSO_FIRST_INDEX_BASE = 1_000_000

export interface MessagesState {
  byConvo: Record<string, Message[]>
  /** in-flight streaming bodies, keyed by message id */
  streaming: Record<string, { body: string; conversationId: string; authorId: string; sequence: number }>
  /** which agents are currently typing in each conversation */
  typing: Record<string, string[]>
  loaded: Set<string>
  loading: Set<string>
  /** Per-convo flag: does the server have more messages OLDER than what we
   *  currently hold? Initialized after `loadConversation`. False once a
   *  loadOlder returns fewer rows than requested. */
  hasMoreOlder: Record<string, boolean>
  /** In-flight loadOlder calls — guards against double-fire when the
   *  virtualized list scroll keeps tripping the start-reached threshold. */
  loadingOlder: Set<string>
  /** Per-convo react-virtuoso `firstItemIndex`. Starts at
   *  VIRTUOSO_FIRST_INDEX_BASE on first load and is decremented by the number
   *  of rows prepended on each loadOlder, so the list keeps its scroll anchor
   *  when older history is paged in. Updated in the SAME `set` as `byConvo`
   *  so the data growth and the index shift land in one render. */
  firstItemIndex: Record<string, number>
  errors: Record<string, string>

  loadConversation: (id: string) => Promise<void>
  loadOlder: (id: string) => Promise<void>
  reloadConversation: (id: string) => Promise<void>
  retryLoad: (id: string) => Promise<void>
  applyEvent: (e: WsEvent) => void
}

function timeFromIso(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const TYPING_STALE_MS = 45_000
const typingExpiryTimers = new Map<string, number>()

function typingKey(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`
}

function withoutTypingAgent(
  typing: Record<string, string[]>,
  conversationId: string,
  agentId: string,
): Record<string, string[]> {
  const cur = typing[conversationId]
  if (!cur?.includes(agentId)) return typing
  const next = cur.filter((id) => id !== agentId)
  if (next.length > 0) return { ...typing, [conversationId]: next }
  const { [conversationId]: _drop, ...rest } = typing
  return rest
}

function withTypingAgent(
  typing: Record<string, string[]>,
  conversationId: string,
  agentId: string,
): Record<string, string[]> {
  const cur = typing[conversationId] ?? []
  const without = cur.filter((id) => id !== agentId)
  return { ...typing, [conversationId]: [...without, agentId] }
}

function clearTypingExpiry(conversationId: string, agentId: string): void {
  const key = typingKey(conversationId, agentId)
  const timer = typingExpiryTimers.get(key)
  if (timer !== undefined) window.clearTimeout(timer)
  typingExpiryTimers.delete(key)
}

function clearAllTypingExpiries(): void {
  for (const timer of typingExpiryTimers.values()) window.clearTimeout(timer)
  typingExpiryTimers.clear()
}

function scheduleTypingExpiry(conversationId: string, agentId: string): void {
  clearTypingExpiry(conversationId, agentId)
  const timer = window.setTimeout(() => {
    typingExpiryTimers.delete(typingKey(conversationId, agentId))
    useMessages.setState((s) => ({
      typing: withoutTypingAgent(s.typing, conversationId, agentId),
    }))
  }, TYPING_STALE_MS)
  typingExpiryTimers.set(typingKey(conversationId, agentId), timer)
}

/** Re-derive every reaction's `mine` flag from `users` + the local user id.
 *  The server no longer computes `mine` because the same reactions array is
 *  reused over WS broadcasts where "I" is recipient-specific — see
 *  server/src/api/router.ts and server/src/agents/tools.ts for the
 *  matching server-side rationale. Anonymous (no meId) means mine=false. */
function deriveMineForReactions<R extends { users?: string[] | null }>(
  reactions: R[] | null | undefined,
): Array<R & { mine: boolean }> | undefined {
  if (!reactions || reactions.length === 0) return undefined
  const meId = getMeId()
  return reactions.map((r) => ({
    ...r,
    mine: !!meId && Array.isArray(r.users) && r.users.includes(meId),
  }))
}

function compactReactions(reactions: ReactionEntry[]): ReactionEntry[] | undefined {
  const next = reactions.filter((r) => r.count > 0)
  return next.length > 0 ? next : undefined
}

function mergeReactionOrder(
  current: ReactionEntry[] | undefined,
  incoming: ReactionEntry[] | undefined,
): ReactionEntry[] | undefined {
  if (!incoming || incoming.length === 0) return undefined
  if (!current || current.length === 0) return incoming

  const byEmoji = new Map(incoming.map((r) => [r.emoji, r]))
  const next: ReactionEntry[] = []
  const seen = new Set<string>()
  for (const r of current) {
    // Guard against a `current` array that already contains duplicates of
    // the same emoji — without this check the inner push would emit the
    // same `updated` entry once per duplicate, producing visible
    // "✅ 2 2 3"-style stutter in the pill row when rapid clicks race
    // with WS echoes. Defensive: nothing in our own pipeline should
    // produce duplicates, but we'd rather collapse than amplify.
    if (seen.has(r.emoji)) continue
    const updated = byEmoji.get(r.emoji)
    if (!updated || updated.count <= 0) continue
    next.push(updated)
    seen.add(r.emoji)
  }
  for (const r of incoming) {
    if (seen.has(r.emoji) || r.count <= 0) continue
    next.push(r)
    seen.add(r.emoji)
  }
  return next.length > 0 ? next : undefined
}

function optimisticToggleReactions(
  reactions: ReactionEntry[] | undefined,
  emoji: string,
): ReactionEntry[] | undefined {
  const meId = getMeId()
  const next = reactions ? reactions.map((r) => ({ ...r, users: r.users ? [...r.users] : undefined })) : []
  const idx = next.findIndex((r) => r.emoji === emoji)
  if (idx === -1) {
    next.push({ emoji, count: 1, mine: true, users: meId ? [meId] : undefined })
    return next
  }

  const cur = next[idx]
  const users = cur.users
  const hadMine = meId
    ? !!cur.mine || (Array.isArray(users) && users.includes(meId))
    : !!cur.mine
  const count = hadMine ? Math.max(0, cur.count - 1) : cur.count + 1
  const patchedUsers = meId
    ? hadMine
      ? users?.filter((id) => id !== meId)
      : Array.from(new Set([...(users ?? []), meId]))
    : users

  if (count === 0) next.splice(idx, 1)
  else next[idx] = { ...cur, count, mine: !hadMine, users: patchedUsers }
  return compactReactions(next)
}

function patchMessageReactions(
  messageId: string,
  updater: (reactions: ReactionEntry[] | undefined) => ReactionEntry[] | undefined,
): Map<string, ReactionEntry[] | undefined> {
  const previous = new Map<string, ReactionEntry[] | undefined>()
  useMessages.setState((s) => {
    let changed = false
    const byConvo = { ...s.byConvo }
    for (const [convoId, list] of Object.entries(s.byConvo)) {
      let listChanged = false
      const next = list.map((m) => {
        if (m.id !== messageId) return m
        previous.set(convoId, m.reactions)
        listChanged = true
        return { ...m, reactions: updater(m.reactions) }
      })
      if (listChanged) {
        byConvo[convoId] = next
        changed = true
      }
    }
    return changed ? { byConvo } : {}
  })
  return previous
}

function restoreMessageReactions(
  messageId: string,
  previous: Map<string, ReactionEntry[] | undefined>,
): void {
  if (previous.size === 0) return
  useMessages.setState((s) => {
    let changed = false
    const byConvo = { ...s.byConvo }
    for (const [convoId, reactions] of previous.entries()) {
      const list = s.byConvo[convoId]
      if (!list) continue
      byConvo[convoId] = list.map((m) => (
        m.id === messageId ? { ...m, reactions } : m
      ))
      changed = true
    }
    return changed ? { byConvo } : {}
  })
}

function fromApi(m: ApiMessage): Message {
  // Always render local HH:MM. If `at` came back as an ISO timestamp, reformat;
  // if `at` is missing, derive from createdAt; if neither, use now.
  let at: string
  if (m.at && !ISO_RE.test(m.at)) {
    at = m.at
  } else if (m.at && ISO_RE.test(m.at)) {
    at = timeFromIso(m.at)
  } else if (m.createdAt) {
    at = timeFromIso(m.createdAt)
  } else {
    at = timeFromIso()
  }
  const raw = m as unknown as {
    tool?: Message['tool']
    attachment?: Message['attachment']
    whisperLink?: Message['whisperLink']
    quotedMessageId?: string | null
    quoted?: Message['quoted'] | null
    replyCount?: number | null
    email?: Message['email'] | null
    poll?: Message['poll'] | null
    pollTallies?: Message['pollTallies'] | null
    clientId?: string | null
  }
  const out: Message = {
    id: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    kind: m.kind as Message['kind'],
    body: m.body,
    at,
    reactions: deriveMineForReactions(m.reactions),
    tool: raw.tool ?? undefined,
    attachment: raw.attachment ?? undefined,
    whisperLink: raw.whisperLink ?? undefined,
    quotedMessageId: raw.quotedMessageId ?? undefined,
    quoted: raw.quoted ?? undefined,
    replyCount: raw.replyCount ?? undefined,
    email: raw.email ?? undefined,
    poll: raw.poll ?? undefined,
    pollTallies: raw.pollTallies ?? undefined,
    clientId: raw.clientId ?? undefined,
  }
  ;(out as Message & { sequence?: number }).sequence = m.sequence
  return out
}

function sequenceOf(m: Message): number | null {
  const raw = (m as Message & { sequence?: unknown }).sequence
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function sortMessagesStable(messages: Message[]): Message[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const sa = sequenceOf(a.message)
      const sb = sequenceOf(b.message)
      if (sa !== null && sb !== null && sa !== sb) return sa - sb
      if (sa !== null && sb === null) return -1
      if (sa === null && sb !== null) return 1
      return a.index - b.index
    })
    .map((x) => x.message)
}

function mergeFetchedMessages(current: Message[] | undefined, incoming: Message[]): Message[] {
  if (!current || current.length === 0) return incoming

  const currentById = new Map(current.map((m) => [m.id, m]))
  const incomingIds = new Set(incoming.map((m) => m.id))
  const incomingClientIds = new Set(incoming.map((m) => m.clientId).filter(Boolean))
  const merged = incoming.map((m) => {
    const prev = currentById.get(m.id)
    // Keep the local optimistic key stable after a fetch returns the same
    // persisted row. Older servers may omit clientId from the snapshot.
    return prev?.clientId && !m.clientId ? { ...m, clientId: prev.clientId } : m
  })

  for (const m of current) {
    if (incomingIds.has(m.id)) continue
    if (m.clientId && incomingClientIds.has(m.clientId)) continue
    // A fetch response can be older than the WS events already applied to this
    // store. Never let that snapshot delete a message the UI has already seen;
    // later fresher fetches will merge into the same row by id.
    merged.push(m)
  }

  return sortMessagesStable(merged)
}

export const useMessages = create<MessagesState>((set, get) => ({
  byConvo: {},
  streaming: {},
  typing: {},
  loaded: new Set(),
  loading: new Set(),
  hasMoreOlder: {},
  loadingOlder: new Set(),
  firstItemIndex: {},
  errors: {},

  async loadConversation(id) {
    const s = get()
    if (s.loaded.has(id) || s.loading.has(id)) return
    set((s) => {
      const { [id]: _drop, ...restErrors } = s.errors
      return { loading: new Set(s.loading).add(id), errors: restErrors }
    })
    try {
      const msgs = await api.getMessages(id, { limit: MESSAGES_PAGE_SIZE })
      const normalized = msgs.map(fromApi)
      // Fewer rows than the page cap → we've already got everything older.
      // Equal-to-cap is ambiguous (could be exactly N or N+more) so default
      // to optimistic "more available" and let the next loadOlder confirm.
      const hasMore = normalized.length >= MESSAGES_PAGE_SIZE
      set((s) => ({
        byConvo: { ...s.byConvo, [id]: mergeFetchedMessages(s.byConvo[id], normalized) },
        loaded: new Set(s.loaded).add(id),
        loading: new Set([...s.loading].filter((x) => x !== id)),
        hasMoreOlder: { ...s.hasMoreOlder, [id]: hasMore },
        firstItemIndex: { ...s.firstItemIndex, [id]: s.firstItemIndex[id] ?? VIRTUOSO_FIRST_INDEX_BASE },
      }))
    } catch (err) {
      console.warn('[messages] loadConversation failed', err)
      const msg = err instanceof Error ? err.message : 'Something went wrong.'
      // A 404 means the conversation no longer exists (deleted server-side,
      // or a stale id leaked in from somewhere). Don't surface a hard error
      // panel for that — silently drop the selection so the chat pane falls
      // back to the "Select a conversation" empty state.
      if (/\b404\b/.test(msg) || /not found/i.test(msg)) {
        set((s) => ({
          loading: new Set([...s.loading].filter((x) => x !== id)),
        }))
        if (useApp.getState().selectedConversationId === id) {
          useApp.getState().selectConversation(null)
        }
        return
      }
      set((s) => ({
        loading: new Set([...s.loading].filter((x) => x !== id)),
        errors: { ...s.errors, [id]: msg },
      }))
    }
  },

  async reloadConversation(id) {
    try {
      // Reload pulls the same window the initial load did — last N. Older
      // history that was already paged in stays in byConvo via the merge.
      const msgs = await api.getMessages(id, { limit: MESSAGES_PAGE_SIZE })
      const normalized = msgs.map(fromApi)
      const hasMore = normalized.length >= MESSAGES_PAGE_SIZE
      set((s) => ({
        byConvo: { ...s.byConvo, [id]: mergeFetchedMessages(s.byConvo[id], normalized) },
        loaded: new Set(s.loaded).add(id),
        hasMoreOlder: {
          ...s.hasMoreOlder,
          // Don't downgrade a known-true to false just because reload landed
          // on the tail page — only widen the optimistic guess.
          [id]: s.hasMoreOlder[id] ?? hasMore,
        },
      }))
    } catch (err) {
      console.warn('[messages] reload failed', err)
    }
  },

  async loadOlder(id) {
    const s = get()
    // Guard: nothing loaded yet, no more pages known, or another loadOlder
    // is already mid-flight (virtuoso start-reached fires more than once
    // during a single momentum scroll).
    if (!s.loaded.has(id)) return
    if (s.hasMoreOlder[id] === false) return
    if (s.loadingOlder.has(id)) return
    const list = s.byConvo[id] ?? []
    if (list.length === 0) return
    // Find the oldest known sequence — that's our cursor.
    let oldest: number | null = null
    for (const m of list) {
      const seq = sequenceOf(m)
      if (seq === null) continue
      if (oldest === null || seq < oldest) oldest = seq
    }
    if (oldest === null || oldest <= 1) {
      // No sequence on any row, or we're already at the bottom of the
      // sequence space — nothing older to fetch.
      set((s) => ({ hasMoreOlder: { ...s.hasMoreOlder, [id]: false } }))
      return
    }
    set((s) => ({ loadingOlder: new Set(s.loadingOlder).add(id) }))
    try {
      const msgs = await api.getMessages(id, { before: oldest, limit: MESSAGES_PAGE_SIZE })
      const normalized = msgs.map(fromApi)
      const hasMore = normalized.length >= MESSAGES_PAGE_SIZE
      set((s) => {
        const prev = s.byConvo[id] ?? []
        const merged = mergeFetchedMessages(prev, normalized)
        // Every fetched row is strictly older than the cursor, so the net-new
        // rows (after dedup) all land at the FRONT. Shift firstItemIndex down
        // by that count in the same update as the data, so react-virtuoso
        // keeps the scroll anchored instead of jumping/stalling.
        const prepended = Math.max(0, merged.length - prev.length)
        const base = s.firstItemIndex[id] ?? VIRTUOSO_FIRST_INDEX_BASE
        return {
          byConvo: { ...s.byConvo, [id]: merged },
          hasMoreOlder: { ...s.hasMoreOlder, [id]: hasMore },
          loadingOlder: new Set([...s.loadingOlder].filter((x) => x !== id)),
          firstItemIndex: { ...s.firstItemIndex, [id]: base - prepended },
        }
      })
    } catch (err) {
      console.warn('[messages] loadOlder failed', err)
      set((s) => ({
        loadingOlder: new Set([...s.loadingOlder].filter((x) => x !== id)),
      }))
    }
  },

  async retryLoad(id) {
    // Force a fresh attempt even though the previous one technically
    // "finished" (with an error). Clear the loaded/error flags so
    // loadConversation will run instead of bailing out early.
    set((s) => {
      const { [id]: _drop, ...restErrors } = s.errors
      return {
        loaded: new Set([...s.loaded].filter((x) => x !== id)),
        errors: restErrors,
      }
    })
    await get().loadConversation(id)
  },

  applyEvent(e) {
    if (e.type === 'message.new') {
      const m = fromApi(e.message)
      clearTypingExpiry(e.conversationId, m.authorId)
      set((s) => {
        const existing = s.byConvo[e.conversationId] ?? []
        // Match the optimistic bubble against the server echo. We have to
        // try BOTH keys:
        //   - id matches when the POST has already resolved and renamed
        //     the temp bubble to the real id.
        //   - clientId matches when the WS event races ahead of the POST
        //     response — the local bubble is still keyed by tempId, so an
        //     id-only check would miss it and we'd double-render (bubble
        //     appears, server echo lands as a separate row, then the POST
        //     resolves and drops the temp → user sees a flicker).
        const prior = existing.find(
          (x) => x.id === m.id
            || (!!m.clientId && x.clientId === m.clientId && x.authorId === m.authorId),
        )
        // Carry the optimistic clientId onto the server echo so the React
        // list key (m.clientId ?? m.id) stays stable across the replacement
        // — otherwise the row remounts and re-animates.
        const merged: Message = prior?.clientId ? { ...m, clientId: prior.clientId } : m
        if (prior?.clientId) {
          console.info('[message-delivery]', {
            phase: 'client.confirmed', via: 'ws', status: 'sent',
            clientId: prior.clientId, messageId: m.id,
          })
        }
        const without = existing.filter((x) => x !== prior && x.id !== m.id)
        let next = [...without, merged].sort((a, b) => {
          const sa = (a as { sequence?: number }).sequence ?? 0
          const sb = (b as { sequence?: number }).sequence ?? 0
          return sa - sb
        })
        // Live replyCount bump on the quoted-original. Server doesn't publish
        // the new count separately; without this the "N replies" link on the
        // root would only catch up on a full refetch. Only bump for fresh
        // arrivals (`prior` was absent) so a server-echo of an optimistic
        // bubble doesn't double-count.
        if (!prior && m.quotedMessageId) {
          const rootId = m.quotedMessageId
          next = next.map((x) =>
            x.id === rootId ? { ...x, replyCount: (x.replyCount ?? 0) + 1 } : x,
          )
        }
        const { [m.id]: _drop, ...rest } = s.streaming
        return {
          streaming: rest,
          typing: withoutTypingAgent(s.typing, e.conversationId, m.authorId),
          byConvo: { ...s.byConvo, [e.conversationId]: next },
        }
      })
    } else if (e.type === 'message.delta') {
      clearTypingExpiry(e.conversationId, e.authorId)
      if (e.done) {
        set((s) => {
          const { [e.messageId]: _drop, ...rest } = s.streaming
          return {
            streaming: rest,
            typing: withoutTypingAgent(s.typing, e.conversationId, e.authorId),
          }
        })
        return
      }
      set((s) => {
        const cur = s.streaming[e.messageId]
        const body = (cur?.body ?? '') + e.delta
        return {
          typing: withoutTypingAgent(s.typing, e.conversationId, e.authorId),
          streaming: {
            ...s.streaming,
            [e.messageId]: {
              body,
              conversationId: e.conversationId,
              authorId: e.authorId,
              sequence: e.sequence,
            },
          },
        }
      })
    } else if (e.type === 'typing') {
      if (e.done) clearTypingExpiry(e.conversationId, e.agentId)
      else scheduleTypingExpiry(e.conversationId, e.agentId)
      set((s) => {
        const typing = e.done
          ? withoutTypingAgent(s.typing, e.conversationId, e.agentId)
          : withTypingAgent(s.typing, e.conversationId, e.agentId)
        return { typing }
      })
    } else if (e.type === 'message.reactions') {
      set((s) => {
        const list = s.byConvo[e.conversationId]
        if (!list) return {}
        // Server no longer ships `mine` — we re-derive it from `users` so
        // the per-recipient view is correct even though the broadcast was
        // identical across the tenant.
        const incoming = deriveMineForReactions(e.reactions)
        const next = list.map((m) =>
          m.id === e.messageId
            ? { ...m, reactions: mergeReactionOrder(m.reactions, incoming) }
            : m,
        )
        return { byConvo: { ...s.byConvo, [e.conversationId]: next } }
      })
    } else if (e.type === 'poll.updated') {
      // Patch the poll bubble in place — both the structured payload
      // (closedAt may have flipped) and the tally array.
      set((s) => {
        const list = s.byConvo[e.conversationId]
        if (!list) return {}
        const next = list.map((m) =>
          m.id === e.messageId
            ? { ...m, poll: e.poll, pollTallies: e.tallies }
            : m,
        )
        return { byConvo: { ...s.byConvo, [e.conversationId]: next } }
      })
    }
  },
}))

export const messagesFor = (s: MessagesState, convoId: string | null): Message[] => {
  if (!convoId) return EMPTY_MESSAGES
  const base = s.byConvo[convoId] ?? EMPTY_MESSAGES
  const streaming = Object.entries(s.streaming)
    .filter(([id, x]) => x.conversationId === convoId && !base.some((m) => m.id === id))
    .map(([id, x]) => ({
      id,
      conversationId: convoId,
      authorId: x.authorId,
      kind: 'text' as const,
      body: x.body,
      at: timeFromIso(),
    }))
  if (streaming.length === 0) return base
  return [...base, ...streaming]
}

function newTempId(): string {
  const rnd =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `temp-${rnd}`
}

function isDefinitiveSendFailure(error: unknown): boolean {
  return error instanceof ApiError
    && error.status >= 400
    && error.status < 500
    && ![408, 425, 429].includes(error.status)
}

export async function sendUserMessage(
  convoId: string,
  body: string,
  attachment?: import('@/api/client').ApiAttachment | null,
  quotedMessageId?: string | null,
  clientId = newTempId(),
): Promise<void> {
  const v = body.trim()
  if (!v && !attachment) return
  const meId = getMeId()
  // Without a signed-in user we can't paint an optimistic bubble (no authorId
  // to attribute it to). Fall back to the old fire-and-forget path.
  if (!meId) {
    try { await api.sendMessage(convoId, v, attachment ?? null, quotedMessageId ?? null) }
    catch (err) { console.warn('[messages] send failed', err) }
    return
  }

  // Build the optimistic quote summary from whatever's already in the store,
  // so the reply bubble shows its quote card immediately instead of popping
  // it in when the server echo arrives. We don't fetch on miss — if the
  // quoted message isn't loaded yet (rare; only happens if the user managed
  // to quote something the store evicted), the server echo will fill it in.
  let quotedSummary: import('@/types').QuotedSummary | undefined
  if (quotedMessageId) {
    const list = useMessages.getState().byConvo[convoId] ?? []
    const orig = list.find((m) => m.id === quotedMessageId)
    if (orig) {
      quotedSummary = {
        id: orig.id,
        authorId: orig.authorId,
        kind: orig.kind,
        body: orig.body.slice(0, 240),
        sequence: (orig as Message & { sequence?: number }).sequence ?? 0,
      }
    }
  }

  const tempId = clientId
  const optimistic: Message = {
    id: tempId,
    clientId: tempId,
    conversationId: convoId,
    authorId: meId,
    kind: 'text',
    body: v,
    at: timeFromIso(),
    attachment: attachment
      ? {
          name: attachment.name,
          kind: attachment.kind,
          url: attachment.url,
          key: attachment.key,
          mime: attachment.mime,
          size: attachment.size,
        }
      : undefined,
    quotedMessageId: quotedMessageId ?? undefined,
    quoted: quotedSummary,
    pending: true,
  }
  // Pin the optimistic bubble to the tail of the list — applyEvent sorts by
  // a hidden `sequence` field, so an unrelated message.new arriving mid-send
  // shouldn't shove our bubble up the timeline.
  ;(optimistic as Message & { sequence?: number }).sequence = Number.MAX_SAFE_INTEGER

  useMessages.setState((s) => ({
    byConvo: {
      ...s.byConvo,
      [convoId]: [...(s.byConvo[convoId] ?? []), optimistic],
    },
  }))

  try {
    const { id: realId } = await api.sendMessage(convoId, v, attachment ?? null, quotedMessageId ?? null, clientId)
    // Reconcile the temp bubble with the server. Either the WS `message.new`
    // already raced ahead of us (real id already in the list → drop the temp)
    // or it hasn't (rename temp → real id so the eventual WS event dedupes
    // cleanly via the existing id-equality filter in applyEvent).
    useMessages.setState((s) => {
      const list = s.byConvo[convoId] ?? []
      const realExists = list.some((m) => m.id === realId)
      const next = realExists
        ? list.filter((m) => m.id !== tempId)
        : list.map((m) =>
            m.id === tempId ? { ...m, id: realId, pending: false, failed: false, unconfirmed: false } : m,
          )
      return { byConvo: { ...s.byConvo, [convoId]: next } }
    })
    console.info('[message-delivery]', {
      phase: 'client.confirmed', via: 'http', status: 'sent', clientId, messageId: realId,
    })
  } catch (err) {
    console.warn('[messages] send failed', err)
    const failed = isDefinitiveSendFailure(err)
    useMessages.setState((s) => {
      const list = s.byConvo[convoId] ?? []
      const next = list.map((m) =>
        m.id === tempId ? { ...m, pending: false, failed, unconfirmed: !failed } : m,
      )
      return { byConvo: { ...s.byConvo, [convoId]: next } }
    })
    console.info('[message-delivery]', {
      phase: failed ? 'client.failed' : 'client.unconfirmed',
      via: 'http', status: failed ? 'failed' : 'unconfirmed',
      clientId, httpStatus: err instanceof ApiError ? err.status : undefined,
    })
  }
}

/** Drop a failed or unconfirmed optimistic bubble from the local list. An
 *  unconfirmed row may reappear on the next fetch if it reached the server. */
export function discardFailedMessage(convoId: string, tempId: string): void {
  useMessages.setState((s) => {
    const list = s.byConvo[convoId]
    if (!list) return s
    const next = list.filter((m) => m.id !== tempId)
    if (next.length === list.length) return s
    return { byConvo: { ...s.byConvo, [convoId]: next } }
  })
}

/** Retry with the original clientId so the server can return an already
 *  committed message instead of creating a duplicate. */
export async function retryFailedMessage(convoId: string, tempId: string): Promise<void> {
  const list = useMessages.getState().byConvo[convoId] ?? []
  const msg = list.find((m) => m.id === tempId)
  if (!msg) return
  const body = msg.body ?? ''
  const att = msg.attachment
  const retryAttachment: import('@/api/client').ApiAttachment | null = att
    ? { url: att.url ?? '', name: att.name, kind: att.kind, key: att.key, mime: att.mime, size: att.size }
    : null
  const quotedId = msg.quotedMessageId ?? null
  const clientId = msg.clientId ?? tempId
  discardFailedMessage(convoId, tempId)
  await sendUserMessage(convoId, body, retryAttachment, quotedId, clientId)
}

export async function toggleReaction(messageId: string, emoji: string): Promise<void> {
  const previous = patchMessageReactions(messageId, (reactions) =>
    optimisticToggleReactions(reactions, emoji),
  )
  try {
    const res = await api.toggleReaction(messageId, emoji)
    const incoming = deriveMineForReactions(res.reactions)
    patchMessageReactions(messageId, (reactions) => mergeReactionOrder(reactions, incoming))
  } catch (err) {
    restoreMessageReactions(messageId, previous)
    console.warn('[reactions] toggle failed', err)
  }
}

// Bound once; workspace switches reset the per-conversation message
// caches so old-tenant message arrays don't linger past a remount.
let wsBound = false
export function bootMessagesStream() {
  // Reset every time bootMessagesStream is called (App.tsx remounts on
  // companyId change) — drops any messages the previous tenant left
  // behind in the byConvo cache.
  clearAllTypingExpiries()
  useMessages.setState({
    byConvo: {},
    streaming: {},
    typing: {},
    loaded: new Set(),
    loading: new Set(),
    errors: {},
  })
  if (wsBound) return
  wsBound = true
  ws.connect()
  ws.on((e) => {
    if (e.type === 'hello') {
      // Fresh WS connection — could be the initial connect OR a reconnect
      // after a network blip / server rollout. Redis pubsub doesn't queue
      // events, so any `message.new` / `message.delta` / `message.reactions`
      // that fired while we were disconnected is gone. Refetch the open
      // conversation to backfill those misses, and invalidate `loaded` for
      // the rest so they refetch on next view instead of serving stale
      // cache from before the gap. Also clear streaming/typing in case we
      // missed their terminal events and they're stuck.
      const active = useApp.getState().selectedConversationId
      clearAllTypingExpiries()
      useMessages.setState({ streaming: {}, typing: {} })
      useMessages.setState((s) => ({
        loaded: new Set(active && s.loaded.has(active) ? [active] : []),
      }))
      if (active) void useMessages.getState().reloadConversation(active)
      return
    }
    useMessages.getState().applyEvent(e)
  })
}
