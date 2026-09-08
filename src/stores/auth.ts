/**
 * Auth state — token + current user + active company. Token persists in
 * localStorage so reloads stay signed in. Every API request reads the
 * current token from this store via getToken() (see api/client.ts).
 */
import { create } from 'zustand'
import type { ServerCapabilities } from '@/api/client'
import { commitIfEpochCurrent } from './contextEpoch'

export interface AuthCompany {
  id: string
  name: string
  slug: string
  role: string
  /** plan tier of the company (owner's tier). 'free' agents are BYOA-only. */
  tier?: 'free' | 'pro' | 'max' | string
}

export interface AuthUser {
  id: string
  email: string
  name: string
  emailVerified?: boolean
  /** OAuth providers linked to this account, e.g. ['google'] or
   *  ['google', 'github']. Populated by /auth/me. */
  providers?: string[]
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  companies: AuthCompany[]
  activeCompanyId: string | null
  /** Monotonic identity/workspace generation used to reject async results
   *  that were started before the current auth context was selected. */
  contextEpoch: number
  ready: boolean   // false until the initial /auth/me probe finishes
  /** Server-driven feature flags. Null until the first /auth/me probe
   *  populates them; consumers should treat null as "don't know yet" and
   *  default to a safe value (usually: hide optional UI). */
  serverCapabilities: ServerCapabilities | null
  setSession: (token: string, user: AuthUser, companyId: string | null) => void
  setMe: (user: AuthUser, companies: AuthCompany[], activeCompanyId: string | null) => void
  setServerCapabilities: (caps: ServerCapabilities) => void
  setActiveCompany: (id: string) => void
  addCompany: (c: AuthCompany) => void
  removeCompany: (id: string, nextCompanyId: string | null) => boolean
  clear: () => void
  markReady: () => void
}

const TOKEN_KEY = 'cumora.auth.token'
const COMPANY_KEY = 'cumora.auth.company'

function resetWorkspaceStores(): void {
  void Promise.all([
    import('./documents').then(({ useDocuments }) => useDocuments.getState().reset()),
    import('./boards').then(({ useBoards }) => useBoards.getState().reset()),
    import('./calendar').then(({ useCalendar }) => useCalendar.getState().reset()),
    import('./shipping').then(({ useShipping }) => useShipping.getState().reset()),
    import('./app').then(({ useApp }) => useApp.getState().selectConversation(null)),
  ])
}

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  companies: [],
  activeCompanyId: localStorage.getItem(COMPANY_KEY),
  contextEpoch: 0,
  ready: false,
  serverCapabilities: null,
  setSession(token, user, companyId) {
    localStorage.setItem(TOKEN_KEY, token)
    if (companyId) localStorage.setItem(COMPANY_KEY, companyId)
    set((s) => ({ token, user, activeCompanyId: companyId, ready: true, contextEpoch: s.contextEpoch + 1 }))
    // Fresh auth → rebind the WS connection so it carries the new
    // session's ticket instead of staying on whatever it had before.
    void import('@/api/client').then(({ ws }) => ws.reconnect())
  },
  setMe(user, companies, activeCompanyId) {
    // Honour a previously-chosen company if it's still in the user's set.
    // Without this, every /auth/me probe would yank the active company back
    // to the server-default one, defeating the manual switcher.
    const stored = localStorage.getItem(COMPANY_KEY)
    const memberIds = new Set(companies.map((c) => c.id))
    const resolved = stored && memberIds.has(stored)
      ? stored
      : (activeCompanyId && memberIds.has(activeCompanyId) ? activeCompanyId : (companies[0]?.id ?? null))
    if (resolved) localStorage.setItem(COMPANY_KEY, resolved)
    else localStorage.removeItem(COMPANY_KEY)
    const previous = useAuth.getState().activeCompanyId
    set((s) => ({
      user,
      companies,
      activeCompanyId: resolved,
      contextEpoch: s.user?.id !== user.id || s.activeCompanyId !== resolved
        ? s.contextEpoch + 1
        : s.contextEpoch,
    }))
    if (previous !== resolved) resetWorkspaceStores()
  },
  setServerCapabilities(caps) {
    set({ serverCapabilities: caps })
  },
  setActiveCompany(id) {
    if (useAuth.getState().activeCompanyId === id) return
    localStorage.setItem(COMPANY_KEY, id)
    set((s) => ({ activeCompanyId: id, contextEpoch: s.contextEpoch + 1 }))
    // Force the WS connection to re-handshake. The bridge filters events
    // by company-membership which is the same regardless of "active"
    // company, but logging in / switching identities should still rebind
    // — and this is the natural place to handle it.
    void import('@/api/client').then(({ ws }) => ws.reconnect())
    // Wipe library stores so the Library tab doesn't briefly render the
    // previous workspace's documents / boards / calendar before the
    // next listXXX() lands. These stores are global singletons that
    // outlive the AuthedApp remount, so a key-change alone doesn't
    // clear them.
    resetWorkspaceStores()
  },
  /** Append a freshly-created company to the user's set and switch to it. */
  addCompany(c) {
    const prevId = useAuth.getState().activeCompanyId
    set((s) => ({
      companies: [...s.companies, c],
      activeCompanyId: c.id,
      contextEpoch: s.activeCompanyId === c.id ? s.contextEpoch : s.contextEpoch + 1,
    }))
    localStorage.setItem(COMPANY_KEY, c.id)
    // If this is a SWITCH (we already had a company), wipe library
    // stores too so the new workspace doesn't render the previous
    // one's data while the first listXXX() is in flight.
    if (prevId && prevId !== c.id) {
      resetWorkspaceStores()
    }
  },
  /** Apply the authoritative result of deleting a workspace immediately.
   * The realtime bridge still reconciles with /auth/me, but no longer needs
   * to duplicate the modal's fetch or socket reconnect. */
  removeCompany(id, nextCompanyId) {
    const current = useAuth.getState()
    if (!current.companies.some((company) => company.id === id)) return false
    const companies = current.companies.filter((company) => company.id !== id)
    const memberIds = new Set(companies.map((company) => company.id))
    const resolved = nextCompanyId && memberIds.has(nextCompanyId)
      ? nextCompanyId
      : (companies[0]?.id ?? null)
    if (resolved) localStorage.setItem(COMPANY_KEY, resolved)
    else localStorage.removeItem(COMPANY_KEY)
    set((state) => ({
      companies,
      activeCompanyId: resolved,
      contextEpoch: state.contextEpoch + 1,
    }))
    resetWorkspaceStores()
    return true
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(COMPANY_KEY)
    set((s) => ({
      token: null,
      user: null,
      companies: [],
      activeCompanyId: null,
      ready: true,
      serverCapabilities: null,
      contextEpoch: s.contextEpoch + 1,
    }))
    // Stale object-URLs from the previous user's avatars would otherwise
    // linger; clear them so the next sign-in doesn't briefly render a
    // dead URL.createObjectURL pointing at a freed blob.
    void import('@/lib/avatarCache').then(({ clearAvatarCache }) => clearAvatarCache())
    void import('@/api/client').then(({ ws }) => ws.close())
    // Composer drafts outlive a session by design (they're mirrored to
    // localStorage so a restart can't lose one), which means signing out has
    // to drop them explicitly — otherwise a half-typed message would be
    // waiting for whoever signs in next on a shared machine.
    void import('./app').then(({ useApp }) => useApp.getState().clearComposerDrafts())
    // Library stores survive logout otherwise (they're global singletons).
    resetWorkspaceStores()
  },
  markReady() {
    set({ ready: true })
  },
}))

/** Sync getter for the API client + WS connection. */
export function getAuthToken(): string | null {
  return useAuth.getState().token
}

/** Sync getter for the current user id. Returns null when no user is signed
 *  in — callers MUST handle that case explicitly. (We never default to a
 *  hardcoded user id like the old 'yetone' value, because that silently
 *  conflates "no user" with "yetone is the user" and broke DM avatars,
 *  message bubble colors, etc. for every non-yetone account.) */
export function getMeId(): string | null {
  return useAuth.getState().user?.id ?? null
}

/** React hook variant — returns the active user id, re-rendering on auth
 *  change. Same null semantics as getMeId. The app shell (AuthGate) keeps
 *  consumers from rendering before a user is set, so in practice the value
 *  is non-null wherever it matters. */
export function useMe(): string | null {
  return useAuth((s) => s.user?.id ?? null)
}

/** Sync getter for the current company id (for the x-company-id header). */
export function getActiveCompanyId(): string | null {
  return useAuth.getState().activeCompanyId
}

/** Run a request against the current auth/workspace context and commit its
 *  result only if that context is still active when the request completes. */
export async function commitIfContextCurrent<T>(
  request: () => Promise<T>,
  commit: (value: T) => void,
): Promise<boolean> {
  return commitIfEpochCurrent(
    () => useAuth.getState().contextEpoch,
    request,
    commit,
  )
}
