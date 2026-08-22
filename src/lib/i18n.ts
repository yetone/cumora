/**
 * Minimal i18n layer — locale state, lookup, and interpolation.
 *
 * Deliberately dependency-free. The alternative (react-i18next & friends)
 * brings a plugin system, a loader pipeline, and a namespace concept we'd
 * use none of: the dictionaries are small enough to ship in the bundle,
 * and there is no server-side rendering to hydrate around. What's left
 * fits in this file.
 *
 * Shape of the contract:
 *   - `en` is the source of truth. Every key exists there, and its type
 *     is what every other locale is checked against — a missing or
 *     misspelled key in a translation is a compile error, not a blank
 *     string at runtime.
 *   - Lookup falls back to English for anything a locale hasn't
 *     translated yet, so a partial locale renders a mixed UI rather than
 *     an empty one. Partial is the normal state of a translation.
 *   - The locale is a PER-DEVICE choice in localStorage, like the sound
 *     toggle (see stores/sound.ts). Syncing it through server
 *     preferences would push one language onto every device a user signs
 *     in from, which is the wrong default for someone reading English at
 *     work and Chinese at home.
 */
import { create } from 'zustand'
import { en } from '@/locales/en'
import { zhCN } from '@/locales/zh-CN'

export type Locale = 'en' | 'zh-CN'
export type MessageKey = keyof typeof en

/** Order here is the order the language picker renders. `label` is
 *  intentionally written in the language itself — someone looking for
 *  Chinese scans for 简体中文, not for "Chinese (Simplified)". */
export const LOCALES: Array<{ code: Locale; label: string; english: string }> = [
  { code: 'en', label: 'English', english: 'English' },
  { code: 'zh-CN', label: '简体中文', english: 'Chinese (Simplified)' },
]

const DICTS: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  'zh-CN': zhCN,
}

const STORAGE_KEY = 'cumora.locale'

function isLocale(v: string | null): v is Locale {
  return v === 'en' || v === 'zh-CN'
}

/** First run: no stored choice, so take the browser's. `zh`, `zh-Hans`,
 *  `zh-CN`, `zh-SG` all mean "this person reads Chinese" for our purposes
 *  — we only ship Simplified, so anything Chinese-ish lands there rather
 *  than falling through to English. Traditional-script users get
 *  Simplified until a zh-TW dictionary exists; a wrong-script UI they can
 *  switch is still better than an English one they can't read. */
function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const tags = [navigator.language, ...(navigator.languages ?? [])]
  for (const tag of tags) {
    if (!tag) continue
    const lower = tag.toLowerCase()
    if (lower.startsWith('zh')) return 'zh-CN'
    if (lower.startsWith('en')) return 'en'
  }
  return 'en'
}

function readInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (isLocale(raw)) return raw
  } catch {
    /* private mode / storage disabled — fall through to detection */
  }
  return detectLocale()
}

/** Keep the document's language attribute in step. Screen readers pick
 *  their voice from it, and CSS `:lang()` selectors key off it. */
function syncDocumentLang(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

interface LocaleState {
  locale: Locale
  setLocale(next: Locale): void
}

export const useLocaleStore = create<LocaleState>((set) => {
  const initial = readInitialLocale()
  syncDocumentLang(initial)
  return {
    locale: initial,
    setLocale(next) {
      set({ locale: next })
      syncDocumentLang(next)
      try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* ignore */ }
    },
  }
})

/** `{name}`-style placeholders. Anything without a matching var is left
 *  as-is rather than blanked, so a typo shows up as visible `{whoops}`
 *  text instead of silently swallowing the sentence. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : String(v)
  })
}

export function translate(
  locale: Locale,
  key: MessageKey,
  vars?: Record<string, string | number>,
): string {
  const template = DICTS[locale][key] ?? en[key] ?? key
  return interpolate(template, vars)
}

/** Reactive translator for components — re-renders on a locale switch. */
export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  const locale = useLocaleStore((s) => s.locale)
  return (key, vars) => translate(locale, key, vars)
}

/** The current locale, for components that need to branch on it (date
 *  formatting, list separators) rather than look a message up. */
export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale)
}

/** Non-reactive translator, for module scope and event handlers. A
 *  component that renders the result must use {@link useT} instead —
 *  this one won't re-render anything when the locale changes. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(useLocaleStore.getState().locale, key, vars)
}

/** Translated-label lookup with an inline-English fallback — the overlay
 *  used by files that keep the author's English literals in the tree for
 *  upstream mergeability. Prefers the translated key; returns the fallback
 *  when the key is empty, missing from the bundle, or resolves to itself.
 *  Pass the component's `useT()` translator as `t`. */
export function tLabel(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  key: MessageKey | '' | undefined,
  fallback: string,
  vars?: Record<string, string | number>,
): string {
  if (!key) return fallback
  const v = t(key, vars)
  return v && v !== key ? v : fallback
}

/** Component-friendly form of {@link tLabel}: binds the current locale's
 *  translator once, so a component writes `const tLabel = useTLabel()`
 *  instead of re-declaring the wrapper. */
export function useTLabel(): (key: MessageKey | '' | undefined, fallback: string, vars?: Record<string, string | number>) => string {
  const t = useT()
  return (key, fallback, vars) => tLabel(t, key, fallback, vars)
}
