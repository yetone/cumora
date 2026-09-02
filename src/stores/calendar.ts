import { create } from 'zustand'
import { api, ws, type CalendarEventInput } from '@/api/client'
import type { CalendarEvent, CalendarEventStatus } from '@/types'
import { pendingCreateRequestId } from '@/lib/create-idempotency'

interface CalendarState {
  events: CalendarEvent[]
  loaded: boolean
  loading: boolean
  loadingEventId: string | null
  error: string | null
  load: () => Promise<void>
  loadEvent: (id: string) => Promise<CalendarEvent>
  reload: () => Promise<void>
  /** Wipe everything — used when switching company/workspace so the
   *  next view doesn't briefly render the previous tenant's events. */
  reset: () => void
  create: (input: CalendarEventInput) => Promise<CalendarEvent>
  update: (id: string, patch: Partial<CalendarEventInput> & { status?: CalendarEventStatus }) => Promise<CalendarEvent>
  remove: (id: string) => Promise<void>
  runNow: (id: string) => Promise<{ status: string; messageId?: string; conversationId?: string; error?: string }>
}

function replaceOrInsert(list: CalendarEvent[], next: CalendarEvent): CalendarEvent[] {
  const idx = list.findIndex((e) => e.id === next.id)
  if (idx < 0) return [...list, next].sort(byStart)
  const out = list.slice()
  out[idx] = next
  return out.sort(byStart)
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0
}

export const useCalendar = create<CalendarState>((set, get) => ({
  events: [],
  loaded: false,
  loading: false,
  loadingEventId: null,
  error: null,

  async load() {
    if (get().loaded || get().loading) return
    set({ loading: true, error: null })
    try {
      const { events } = await api.listCalendarEvents()
      set({ events: events.sort(byStart), loaded: true, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  async loadEvent(id) {
    const existing = get().events.find((e) => e.id === id)
    if (existing) return existing
    set({ loadingEventId: id, error: null })
    try {
      try {
        const { event } = await api.getCalendarEvent(id)
        set((s) => ({ events: replaceOrInsert(s.events, event) }))
        return event
      } catch (directErr) {
        const { events } = await api.listCalendarEvents()
        const sorted = events.sort(byStart)
        const event = sorted.find((e) => e.id === id)
        set({ events: sorted, loaded: true })
        if (event) return event
        throw directErr
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      set((s) => ({ loadingEventId: s.loadingEventId === id ? null : s.loadingEventId }))
    }
  },

  async reload() {
    set({ loading: true, error: null })
    try {
      const { events } = await api.listCalendarEvents()
      set({ events: events.sort(byStart), loaded: true, loading: false })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  reset() {
    set({ events: [], loaded: false, loading: false, loadingEventId: null, error: null })
  },

  async create(input) {
    const retry = pendingCreateRequestId('calendar-event', input)
    const { event } = await api.createCalendarEvent({ ...input, requestId: retry.requestId })
    retry.complete()
    set((s) => ({ events: replaceOrInsert(s.events, event) }))
    return event
  },

  async update(id, patch) {
    const { event } = await api.updateCalendarEvent(id, patch)
    set((s) => ({ events: replaceOrInsert(s.events, event) }))
    return event
  },

  async remove(id) {
    await api.deleteCalendarEvent(id)
    set((s) => ({ events: s.events.filter((e) => e.id !== id) }))
  },

  async runNow(id) {
    const r = await api.runCalendarEventNow(id)
    // The dispatch updates last_fired_at server-side; refresh that one row.
    try {
      const { events } = await api.listCalendarEvents()
      set({ events: events.sort(byStart) })
    } catch { /* keep current list */ }
    return r
  },
}))

/** WS → store wiring. Mirrors how `documents.ts` reacts to `doc.changed`:
 *  a thin event arrives from the server, the store refetches the row (or
 *  drops it from local state on delete) so the Calendar view updates
 *  without a full page reload. Only refetches when the store has already
 *  been hydrated — agents creating events while the user has never opened
 *  the calendar will be picked up by the normal load() on first view. */
ws.on((ev) => {
  if (ev.type !== 'calendar.changed') return
  const state = useCalendar.getState()
  if (!state.loaded) return
  if (ev.kind === 'event.deleted') {
    useCalendar.setState((s) => ({ events: s.events.filter((e) => e.id !== ev.eventId) }))
    return
  }
  // created / updated / dispatched → fetch the single row and merge.
  // We swallow any error: a 404 (e.g. raced against an immediate delete)
  // just means we drop the local copy on the next list reload.
  void (async () => {
    try {
      const { event } = await api.getCalendarEvent(ev.eventId)
      useCalendar.setState((s) => ({ events: replaceOrInsert(s.events, event) }))
    } catch { /* swallow — next load() reconciles */ }
  })()
})
