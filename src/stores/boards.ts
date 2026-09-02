import { create } from 'zustand'
import { api, ws } from '@/api/client'
import type {
  BoardSummary, BoardSnapshot, BoardCard, BoardCardComment, BoardCardLookup,
} from '@/types'
import { pendingCreateRequestId } from '@/lib/create-idempotency'

interface BoardsState {
  /** Workspace-wide list of board summaries. Loaded once on view mount;
   *  WS events poke a refresh when boards are added/removed/renamed. */
  list: BoardSummary[]
  loadingList: boolean

  /** Currently-selected board id (null when the list view is shown). */
  selectedId: string | null
  /** Full snapshot for the selected board (columns + cards). Keyed-on-id
   *  so flipping between boards doesn't trash the previous one's data
   *  while the next snapshot is in flight. */
  snapshots: Record<string, BoardSnapshot>
  loadingBoardId: string | null

  /** Per-card comment cache. Populated on demand when a card detail
   *  panel opens; WS comment events invalidate the relevant entry. */
  comments: Record<string, BoardCardComment[]>
  /** Card-id resolver cache for artifact links that only mention `card-*`. */
  cardLookups: Record<string, BoardCardLookup>
  loadingCardId: string | null

  loadList: () => Promise<void>
  /** Wipe everything — used when switching company/workspace so the
   *  next view doesn't briefly render the previous tenant's boards. */
  reset: () => void
  selectBoard: (id: string | null) => void
  loadBoard: (id: string) => Promise<void>
  loadCard: (id: string) => Promise<BoardCardLookup>
  refreshBoard: (id: string) => Promise<void>

  createBoard: (title: string, description?: string) => Promise<string>
  renameBoard: (id: string, title: string) => Promise<void>
  deleteBoard: (id: string) => Promise<void>

  addColumn: (boardId: string, title: string) => Promise<void>
  renameColumn: (boardId: string, columnId: string, title: string) => Promise<void>
  deleteColumn: (boardId: string, columnId: string) => Promise<void>

  addCard: (boardId: string, input: {
    columnId: string; title: string; description?: string; assigneeId?: string | null
  }) => Promise<void>
  patchCard: (boardId: string, cardId: string, input: {
    title?: string; description?: string; columnId?: string; position?: number
    assigneeId?: string | null
  }) => Promise<void>
  /** Optimistic move — patches the in-memory snapshot immediately, fires
   *  the PATCH in the background, refetches on failure. */
  moveCardOptimistic: (boardId: string, cardId: string, toColumnId: string, toIndex: number) => Promise<void>
  deleteCard: (boardId: string, cardId: string) => Promise<void>

  loadComments: (boardId: string, cardId: string) => Promise<void>
  addComment: (boardId: string, cardId: string, body: string) => Promise<void>

  /** WS event handler — wire once at app boot. */
  applyEvent: (kind: string, boardId: string, cardId?: string) => void
}

function lookupCardInSnapshot(snap: BoardSnapshot, cardId: string): BoardCardLookup | null {
  const card = snap.cards.find((c) => c.id === cardId)
  if (!card) return null
  const column = snap.columns.find((c) => c.id === card.columnId)
  if (!column) return null
  return {
    board: {
      id: snap.id,
      title: snap.title,
      description: snap.description,
      createdBy: snap.createdBy,
      createdAt: snap.createdAt,
      updatedAt: snap.updatedAt,
    },
    column,
    card,
  }
}

export const useBoards = create<BoardsState>((set, get) => ({
  list: [],
  loadingList: false,
  selectedId: null,
  snapshots: {},
  loadingBoardId: null,
  comments: {},
  cardLookups: {},
  loadingCardId: null,

  loadList: async () => {
    set({ loadingList: true })
    try {
      const rows = await api.listBoards()
      set({ list: rows })
    } finally {
      set({ loadingList: false })
    }
  },

  reset: () => set({
    list: [],
    loadingList: false,
    selectedId: null,
    snapshots: {},
    loadingBoardId: null,
    comments: {},
    cardLookups: {},
    loadingCardId: null,
  }),

  selectBoard: (id) => {
    set({ selectedId: id })
    if (id && !get().snapshots[id]) void get().loadBoard(id)
  },

  loadBoard: async (id) => {
    set({ loadingBoardId: id })
    try {
      const snap = await api.getBoard(id)
      set((s) => ({ snapshots: { ...s.snapshots, [id]: snap } }))
    } finally {
      set((s) => ({ loadingBoardId: s.loadingBoardId === id ? null : s.loadingBoardId }))
    }
  },

  loadCard: async (id) => {
    const cached = get().cardLookups[id]
    if (cached) return cached
    set({ loadingCardId: id })
    try {
      const existing = Object.values(get().snapshots)
        .map((snap) => lookupCardInSnapshot(snap, id))
        .find((lookup): lookup is BoardCardLookup => Boolean(lookup))
      const lookup = existing ?? await (async () => {
        try {
          return await api.getBoardCard(id)
        } catch (directErr) {
          await get().loadList()
          for (const board of get().list) {
            const snap = get().snapshots[board.id] ?? await api.getBoard(board.id)
            if (!get().snapshots[board.id]) {
              set((s) => ({ snapshots: { ...s.snapshots, [board.id]: snap } }))
            }
            const resolved = lookupCardInSnapshot(snap, id)
            if (resolved) return resolved
          }
          throw directErr
        }
      })()
      set((s) => {
        const snap = s.snapshots[lookup.board.id]
        const nextSnapshots = snap
          ? {
              ...s.snapshots,
              [lookup.board.id]: {
                ...snap,
                cards: snap.cards.some((c) => c.id === id)
                  ? snap.cards.map((c) => c.id === id ? lookup.card : c)
                  : [...snap.cards, lookup.card],
              },
            }
          : s.snapshots
        return {
          cardLookups: { ...s.cardLookups, [id]: lookup },
          snapshots: nextSnapshots,
        }
      })
      return lookup
    } finally {
      set((s) => ({ loadingCardId: s.loadingCardId === id ? null : s.loadingCardId }))
    }
  },

  refreshBoard: async (id) => {
    // Same as loadBoard but doesn't toggle the loading flag — used by WS
    // event handlers so the UI doesn't flicker on every nudge.
    try {
      const snap = await api.getBoard(id)
      set((s) => ({ snapshots: { ...s.snapshots, [id]: snap } }))
    } catch { /* ignore — stale snapshot is fine */ }
  },

  createBoard: async (title, description) => {
    const retry = pendingCreateRequestId('board', { title, description: description ?? null })
    const r = await api.createBoard({ title, description, requestId: retry.requestId })
    retry.complete()
    await get().loadList()
    set({ selectedId: r.id })
    await get().loadBoard(r.id)
    return r.id
  },

  renameBoard: async (id, title) => {
    await api.updateBoard(id, { title })
    await get().loadList()
    await get().refreshBoard(id)
  },

  deleteBoard: async (id) => {
    await api.deleteBoard(id)
    set((s) => {
      const { [id]: _gone, ...rest } = s.snapshots
      const cardLookups = Object.fromEntries(
        Object.entries(s.cardLookups).filter(([, lookup]) => lookup.board.id !== id),
      )
      return {
        list: s.list.filter((b) => b.id !== id),
        snapshots: rest,
        cardLookups,
        selectedId: s.selectedId === id ? null : s.selectedId,
      }
    })
  },

  addColumn: async (boardId, title) => {
    await api.addBoardColumn(boardId, title)
    await get().refreshBoard(boardId)
  },
  renameColumn: async (boardId, columnId, title) => {
    await api.updateBoardColumn(boardId, columnId, { title })
    await get().refreshBoard(boardId)
  },
  deleteColumn: async (boardId, columnId) => {
    await api.deleteBoardColumn(boardId, columnId)
    await get().refreshBoard(boardId)
  },

  addCard: async (boardId, input) => {
    await api.createCard(boardId, input)
    await get().refreshBoard(boardId)
  },

  patchCard: async (boardId, cardId, input) => {
    await api.updateCard(boardId, cardId, input)
    await get().refreshBoard(boardId)
    set((s) => {
      const { [cardId]: _gone, ...cardLookups } = s.cardLookups
      return { cardLookups }
    })
  },

  moveCardOptimistic: async (boardId, cardId, toColumnId, toIndex) => {
    // Snapshot-replay pattern: compute the new positions locally, patch
    // the snapshot in place, then fire the PATCH. On failure, refetch
    // — the server's view wins.
    const prev = get().snapshots[boardId]
    if (!prev) {
      await get().patchCard(boardId, cardId, { columnId: toColumnId })
      return
    }
    const cards = prev.cards.slice()
    const cardIdx = cards.findIndex((c) => c.id === cardId)
    if (cardIdx === -1) return
    const card = cards[cardIdx]
    const remaining = cards.filter((c) => c.id !== cardId)
    const destSiblings = remaining
      .filter((c) => c.columnId === toColumnId)
      .sort((a, b) => a.position - b.position)
    const clamped = Math.max(0, Math.min(toIndex, destSiblings.length))
    const before = destSiblings[clamped - 1]
    const after = destSiblings[clamped]
    const newPos = before && after
      ? (before.position + after.position) / 2
      : before
        ? before.position + 1000
        : after
          ? after.position - 1000
          : 1000
    const moved: BoardCard = { ...card, columnId: toColumnId, position: newPos }
    const next = [...remaining, moved]
    set((s) => ({ snapshots: { ...s.snapshots, [boardId]: { ...prev, cards: next } } }))
    try {
      await api.updateCard(boardId, cardId, { columnId: toColumnId, position: newPos })
      set((s) => {
        const { [cardId]: _gone, ...cardLookups } = s.cardLookups
        return { cardLookups }
      })
    } catch (e) {
      console.warn('[boards] move failed, refetching', e)
      await get().refreshBoard(boardId)
    }
  },

  deleteCard: async (boardId, cardId) => {
    await api.deleteCard(boardId, cardId)
    set((s) => {
      const snap = s.snapshots[boardId]
      const { [cardId]: _gone, ...cardLookups } = s.cardLookups
      if (!snap) return { cardLookups }
      return {
        cardLookups,
        snapshots: {
          ...s.snapshots,
          [boardId]: { ...snap, cards: snap.cards.filter((c) => c.id !== cardId) },
        },
      }
    })
  },

  loadComments: async (boardId, cardId) => {
    const rows = await api.listCardComments(boardId, cardId)
    set((s) => ({ comments: { ...s.comments, [cardId]: rows } }))
  },

  addComment: async (boardId, cardId, body) => {
    await api.addCardComment(boardId, cardId, body)
    await get().loadComments(boardId, cardId)
    // Bumping commentCount in the snapshot avoids a refetch flicker while
    // the next refreshBoard catches up.
    set((s) => {
      const snap = s.snapshots[boardId]
      if (!snap) return {}
      return {
        snapshots: {
          ...s.snapshots,
          [boardId]: {
            ...snap,
            cards: snap.cards.map((c) =>
              c.id === cardId ? { ...c, commentCount: c.commentCount + 1 } : c,
            ),
          },
        },
      }
    })
  },

  applyEvent: (kind, boardId, cardId) => {
    if (cardId) {
      set((s) => {
        const { [cardId]: _gone, ...cardLookups } = s.cardLookups
        return { cardLookups }
      })
    }
    if (kind.startsWith('board.') && (kind === 'board.created' || kind === 'board.deleted' || kind === 'board.updated')) {
      void get().loadList()
    }
    if (get().snapshots[boardId] || get().selectedId === boardId) {
      void get().refreshBoard(boardId)
    }
  },
}))

/** Wire WS → store at module load. Mirrors how the messages store hooks
 *  itself to the same event bus — boards changes flowing in from other
 *  clients (or from agents via the CLI) land here and trigger refresh. */
ws.on((ev) => {
  if (ev.type !== 'board.changed') return
  useBoards.getState().applyEvent(ev.kind, ev.boardId, ev.cardId)
})
