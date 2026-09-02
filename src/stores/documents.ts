import { create } from 'zustand'
import { api, ws, type ApiDocument } from '@/api/client'
import { pendingCreateRequestId } from '@/lib/create-idempotency'

interface DocumentsState {
  list: ApiDocument[]
  loaded: boolean
  selectedId: string | null
  select: (id: string | null) => void
  load: () => Promise<void>
  reload: () => Promise<void>
  /** Wipe local state — used when switching company/workspace so the
   *  next view doesn't briefly render the previous tenant's documents
   *  before the API call lands. */
  reset: () => void
  create: (input?: { title?: string; conversationId?: string | null }) => Promise<ApiDocument>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useDocuments = create<DocumentsState>((set, get) => ({
  list: [],
  loaded: false,
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  load: async () => {
    if (get().loaded) return
    const { documents } = await api.listDocuments()
    set({ list: documents, loaded: true })
  },
  reload: async () => {
    const { documents } = await api.listDocuments()
    set((s) => ({
      list: documents,
      loaded: true,
      selectedId: s.selectedId && documents.some((d) => d.id === s.selectedId) ? s.selectedId : null,
    }))
  },
  reset: () => set({ list: [], loaded: false, selectedId: null }),
  create: async (input) => {
    const normalized = input ?? {}
    const retry = pendingCreateRequestId('document', {
      title: normalized.title ?? 'Untitled',
      conversationId: normalized.conversationId ?? null,
    })
    const doc = await api.createDocument({ ...normalized, requestId: retry.requestId })
    retry.complete()
    set((s) => ({ list: [doc, ...s.list.filter((d) => d.id !== doc.id)], selectedId: doc.id }))
    return doc
  },
  rename: async (id, title) => {
    await api.renameDocument(id, title)
    set((s) => ({
      list: s.list.map((d) => d.id === id ? { ...d, title, updatedAt: new Date().toISOString() } : d),
    }))
  },
  remove: async (id) => {
    await api.deleteDocument(id)
    set((s) => ({
      list: s.list.filter((d) => d.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    }))
  },
}))

ws.on((ev) => {
  if (ev.type !== 'doc.changed') return
  const state = useDocuments.getState()
  if (!state.loaded) return
  void state.reload()
})
