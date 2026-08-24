/**
 * Appearance (light / dark / system) — per-device, like locale and the
 * sound toggle.
 *
 * Dark mode is a CSS-variable remap (see globals.css): components keep
 * talking in `ink` / `paper` / `cloud` / `sky2`, and `html.dark` swaps
 * those tokens onto a One Dark Pro palette. No `dark:` variants, no
 * per-component theme branches.
 *
 * Kept in localStorage rather than server preferences for the same
 * reason locale is: a laptop at a bright desk and a phone in a dark
 * room should be allowed to disagree. Default is `system` so a first
 * run with no stored choice follows the OS.
 */
import { create } from 'zustand'

export type Appearance = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'

const STORAGE_KEY = 'cumora.appearance'

function isAppearance(v: string | null): v is Appearance {
  return v === 'system' || v === 'light' || v === 'dark'
}

function prefersDark(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveAppearance(pref: Appearance): ResolvedAppearance {
  if (pref === 'light' || pref === 'dark') return pref
  return prefersDark() ? 'dark' : 'light'
}

function readInitialAppearance(): Appearance {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (isAppearance(raw)) return raw
  } catch {
    /* private mode / storage disabled — fall through to system */
  }
  return 'system'
}

/**
 * Paint `html.dark`, keep native chrome in step, and tell Electron's
 * `nativeTheme` which source to follow so `prefers-color-scheme` in
 * the renderer stays honest.
 *
 * `cumora:appearance` is the Capacitor status-bar hook — native.ts
 * listens so this file doesn't import the plugin bundle.
 */
function syncDocumentAppearance(pref: Appearance, resolved: ResolvedAppearance): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#21252b' : '#00A8F0')
  window.dispatchEvent(new CustomEvent('cumora:appearance', { detail: resolved }))
  try { window.cumora?.theme?.set(pref) } catch { /* not Electron */ }
}

let media: MediaQueryList | null = null
let mediaHandler: (() => void) | null = null

function watchSystem(enabled: boolean, onChange: () => void): void {
  if (typeof window === 'undefined') return
  if (media && mediaHandler) {
    media.removeEventListener('change', mediaHandler)
    media = null
    mediaHandler = null
  }
  if (!enabled) return
  media = window.matchMedia('(prefers-color-scheme: dark)')
  mediaHandler = onChange
  media.addEventListener('change', onChange)
}

interface AppearanceState {
  appearance: Appearance
  resolved: ResolvedAppearance
  setAppearance(next: Appearance): void
}

export const useAppearanceStore = create<AppearanceState>((set, get) => {
  const initial = readInitialAppearance()
  const resolved = resolveAppearance(initial)
  syncDocumentAppearance(initial, resolved)
  watchSystem(initial === 'system', () => {
    const pref = get().appearance
    if (pref !== 'system') return
    const next = resolveAppearance('system')
    set({ resolved: next })
    syncDocumentAppearance(pref, next)
  })
  return {
    appearance: initial,
    resolved,
    setAppearance(next) {
      const resolvedNext = resolveAppearance(next)
      set({ appearance: next, resolved: resolvedNext })
      syncDocumentAppearance(next, resolvedNext)
      watchSystem(next === 'system', () => {
        if (get().appearance !== 'system') return
        const fromOs = resolveAppearance('system')
        set({ resolved: fromOs })
        syncDocumentAppearance('system', fromOs)
      })
      try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    },
  }
})
