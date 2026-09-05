import { create } from 'zustand'
import { isForActiveWorkspace } from '@/lib/tenant-events'
import { useAuth } from '@/stores/auth'
import { api, ws, type ApiParticipant } from '@/api/client'
import type { Participant, Status } from '@/types'
import { invalidateAvatar, clearAvatarCache } from '@/lib/avatarCache'
import { commitIfContextCurrent } from '@/stores/auth'

interface ParticipantsState {
  byId: Record<string, Participant>
  loaded: boolean
  /** Hard reload — clears state first, used at boot / workspace switch. */
  load: () => Promise<void>
  /** Quiet re-fetch — keeps the existing roster visible during the network
   *  round-trip, then swaps. Used by the 60s background refresher so a
   *  regenerated avatar or a status nudge picks up without a blank flash. */
  refresh: () => Promise<void>
  applyStatus: (id: string, status: Status, statusUpdatedAt?: string) => void
  expireStaleStatuses: () => void
}

const BUSY_STATUS_TTL_MS = 90_000
const STATUS_EXPIRY_TICK_MS = 5_000
const BUSY_STATUSES = new Set<Status>(['thinking', 'working', 'waiting'])

function coerceStatusUpdatedAt(value?: string): string {
  return value ?? new Date().toISOString()
}

function isStaleBusy(status: Status, updatedAt?: string): boolean {
  if (!BUSY_STATUSES.has(status)) return false
  if (!updatedAt) return true
  const t = new Date(updatedAt).getTime()
  if (!Number.isFinite(t)) return true
  return Date.now() - t > BUSY_STATUS_TTL_MS
}

function normalizeStatus(status: Status, updatedAt?: string): Status {
  return isStaleBusy(status, updatedAt) ? 'avail' : status
}

/** Shared fetch impl — both load() and refresh() call this; the
 *  difference is whether they pre-clear state. */
async function fetchInto(set: (partial: Partial<ParticipantsState>) => void): Promise<void> {
  try {
    await commitIfContextCurrent(() => api.getParticipants(), (list) => {
      const byId: Record<string, Participant> = {}
      for (const p of list) byId[p.id] = fromApi(p)
      set({ byId, loaded: true })
    })
  } catch (err) {
    console.warn('[participants] fetch failed', err)
  }
}

function fromApi(p: ApiParticipant): Participant {
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    role: p.role ?? undefined,
    initial: p.initial,
    avatarBg: p.avatarBg,
    avatarUrl: p.avatarUrl ?? null,
    status: normalizeStatus(p.status, p.statusUpdatedAt),
    statusUpdatedAt: coerceStatusUpdatedAt(p.statusUpdatedAt),
    bio: p.bio ?? undefined,
    tools: p.tools ?? undefined,
    systemPrompt: p.systemPrompt ?? undefined,
    model: p.model ?? null,
    fastModel: p.fastModel ?? null,
    email: p.email ?? null,
    departedAt: p.departedAt ?? null,
    computerId: p.computerId ?? null,
    engine: (p.engine as Participant['engine']) ?? null,
    // Official API omits this field. Don't coerce missing → true or the
    // editor always shows "Default · Claude" even when engine is Cursor.
    engineInherit: p.engineInherit == null ? undefined : p.engineInherit,
  }
}

export const useParticipants = create<ParticipantsState>((set) => ({
  byId: {},
  loaded: false,
  async load() {
    // Reset before re-loading so a workspace switch never shows the
    // previous tenant's roster during the loading window. Same trigger
    // also drops the local avatar cache — we never want a portrait
    // from the previous workspace to flash on a same-id participant.
    set({ byId: {}, loaded: false })
    clearAvatarCache()
    await fetchInto(set)
  },
  async refresh() {
    // No state-clear — just fetch fresh data and swap. Used by the
    // periodic background ticker; we don't want avatars to flicker.
    await fetchInto(set)
  },
  applyStatus(id, status, updatedAt) {
    set((s) => {
      const cur = s.byId[id]
      if (!cur) return {}
      const statusUpdatedAt = coerceStatusUpdatedAt(updatedAt)
      return {
        byId: {
          ...s.byId,
          [id]: {
            ...cur,
            status: normalizeStatus(status, statusUpdatedAt),
            statusUpdatedAt,
          },
        },
      }
    })
  },
  expireStaleStatuses() {
    set((s) => {
      let changed = false
      const byId: Record<string, Participant> = {}
      for (const [id, p] of Object.entries(s.byId)) {
        if (isStaleBusy(p.status, p.statusUpdatedAt)) {
          changed = true
          byId[id] = { ...p, status: 'avail', statusUpdatedAt: new Date().toISOString() }
        } else {
          byId[id] = p
        }
      }
      return changed ? { byId } : {}
    })
  },
}))

// Data reload runs on every call (workspace switches need fresh data);
// WS bindings + the periodic refresher only need to attach once per
// page lifetime.
const REFRESH_INTERVAL_MS = 60_000
let wsBound = false
export function bootParticipants() {
  void useParticipants.getState().load()
  if (wsBound) return
  wsBound = true
  ws.connect()
  ws.on((e) => {
    if (e.type === 'hello') {
      // Fresh WS connection — could be the initial connect OR a reconnect
      // after a network blip / server rollout. Redis pubsub doesn't
      // queue messages, so any `participants.avatar` / `.status` event
      // that fired while we were disconnected is gone. Refetch the
      // roster to backfill those misses. Cheap (single JSON GET) and
      // covers the only failure mode where avatar updates silently
      // stick at stale.
      void useParticipants.getState().refresh()
    } else if (e.type === 'participants.status') {
      useParticipants.getState().applyStatus(e.participantId, e.status, e.statusUpdatedAt)
    } else if (e.type === 'participants.avatar') {
      // Drop the local image cache entry for this participant so the
      // next render fetches the new portrait bytes — beats waiting for
      // the URL-keyed browser cache to expire when the URL hasn't
      // changed (e.g., overwritten-in-place Gravatar).
      invalidateAvatar(e.participantId)
      // Patch the participant row's avatarUrl in place so the new
      // remote URL flows down without a full refetch.
      useParticipants.setState((s) => {
        const cur = s.byId[e.participantId]
        if (!cur) return {}
        return { byId: { ...s.byId, [e.participantId]: { ...cur, avatarUrl: e.avatarUrl } } }
      })
    } else if (e.type === 'participants.added') {
      // The socket carries every workspace this user belongs to, so a member of
      // two workspaces receives the other one's roster events while looking at
      // this one. The sibling handlers above are self-limiting — they patch an
      // existing row and bail when the id is unknown — but this one INSERTS, so
      // a foreign participant would land in the active workspace's roster and
      // from there into assignee pickers and mention lists.
      if (!isForActiveWorkspace(e.companyId, useAuth.getState().activeCompanyId)) return
      // A new human (or agent) joined the workspace. Upsert into byId so
      // the system-row referencing them resolves immediately (otherwise
      // SystemRow returns null on unknown participantId and the inviter
      // sees nothing in the thread) and so they show up in member chips,
      // mention pickers, etc. without waiting for the 60s refresher.
      const p = e.participant
      useParticipants.setState((s) => ({
        byId: {
          ...s.byId,
          [p.id]: {
            id: p.id,
            kind: p.kind,
            name: p.name,
            role: p.role ?? undefined,
            initial: p.initial,
            avatarBg: p.avatarBg,
            avatarUrl: p.avatarUrl ?? null,
            status: normalizeStatus(p.status, p.statusUpdatedAt ?? undefined),
            statusUpdatedAt: coerceStatusUpdatedAt(p.statusUpdatedAt ?? undefined),
          },
        },
      }))
    }
  })
  // Quiet background refresh — picks up regenerated avatars and any
  // other roster drift without a workspace switch. 60s cadence is well
  // below the signed-URL TTL we'd ever bake in, so URLs never expire on
  // the client between refreshes.
  setInterval(() => {
    if (document.visibilityState === 'hidden') return  // skip when tab is hidden
    void useParticipants.getState().refresh()
  }, REFRESH_INTERVAL_MS)
  setInterval(() => {
    if (document.visibilityState === 'hidden') return  // skip when tab is hidden
    useParticipants.getState().expireStaleStatuses()
  }, STATUS_EXPIRY_TICK_MS)
}
