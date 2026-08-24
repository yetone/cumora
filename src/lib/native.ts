/**
 * Capacitor native-runtime glue.
 *
 * Statically imports every plugin so Vite bundles them into the
 * production iOS / Android WebView build. The web bundle is the same
 * — `isNativePlatform()` guards every call so the plugin code never
 * runs in a browser tab (the imports themselves are safe; they just
 * register no listeners and never invoke native methods).
 *
 * Call `bootNative()` once from main.tsx.
 */
import { App, type URLOpenListenerEvent } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Keyboard } from '@capacitor/keyboard'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import { registerPlugin } from '@capacitor/core'

/**
 * iOS-only bridge to `ASWebAuthenticationSession` — Apple's dedicated
 * OAuth flow. Custom plugin (Swift) lives in
 * `ios/App/App/WebAuthPlugin.swift`. We use it instead of
 * `@capacitor/browser` (SFSafariViewController) because the latter
 * silently drops 302 redirects to custom URL schemes like `cumora://`,
 * which is exactly what the OAuth callback chain depends on.
 */
interface WebAuthPlugin {
  start: (opts: { url: string; callbackScheme: string }) => Promise<{ callbackUrl: string }>
}
const WebAuth = registerPlugin<WebAuthPlugin>('WebAuth')

/**
 * iOS-only bridge to `ASAuthorizationAppleIDProvider` — the native
 * "Sign in with Apple" flow. Swift implementation in
 * `ios/App/App/AppleSignInPlugin.swift`.
 *
 * Required by App Review Guideline 4.8 when an iOS app offers any
 * third-party social login (we offer Google + GitHub). The native
 * SIWA flow returns the `identity_token` JWT directly to our
 * process — no browser redirect — and the server-side verifier in
 * `server/src/apple.ts` validates it against Apple's JWKS.
 */
interface AppleSignInPlugin {
  signIn: () => Promise<{
    /** JWT signed by Apple, contains sub / email / aud / iss / exp. */
    identityToken: string
    /** Apple's stable per-(user, team) opaque user id (== JWT sub). */
    user: string
    /** Only present on the user's FIRST sign-in to this app. May be
     *  a real address or a `…@privaterelay.appleid.com` relay. */
    email?: string
    /** Only present on the user's FIRST sign-in. Combined "Given Family". */
    name?: string
  }>
}
const AppleSignIn = registerPlugin<AppleSignInPlugin>('AppleSignIn')

/** Trigger the native Sign in with Apple flow. iOS-only — caller
 *  should gate behind `nativePlatform() === 'ios'`. Throws when the
 *  user cancels (the plugin rejects with code USER_CANCELLED, which
 *  this layer re-throws unmodified). */
export async function runAppleSignIn(): Promise<{
  identityToken: string; user: string; email: string | null; name: string | null
}> {
  if (!isNativePlatform() || nativePlatform() !== 'ios') {
    throw new Error('Sign in with Apple is iOS-only in this build')
  }
  const r = await AppleSignIn.signIn()
  return {
    identityToken: r.identityToken,
    user: r.user,
    email: r.email ?? null,
    name: r.name ?? null,
  }
}

interface CapacitorWindow {
  Capacitor?: {
    isNativePlatform?: () => boolean
    getPlatform?: () => string
  }
}

export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as CapacitorWindow
  return Boolean(w.Capacitor?.isNativePlatform?.())
}

export function nativePlatform(): string | null {
  if (typeof window === 'undefined') return null
  const w = window as CapacitorWindow
  return w.Capacitor?.getPlatform?.() ?? null
}

let booted = false

async function applyNativeAppearance(resolved: 'light' | 'dark'): Promise<void> {
  if (!isNativePlatform()) return
  await StatusBar.setStyle({ style: resolved === 'dark' ? Style.Dark : Style.Light })
  if (nativePlatform() === 'android') {
    await StatusBar.setBackgroundColor({ color: resolved === 'dark' ? '#21252b' : '#FAFCFE' })
  }
}

export async function bootNative(): Promise<void> {
  if (booted) return
  booted = true
  if (!isNativePlatform()) return

  // Status bar glyphs follow the resolved appearance. Style.Light =
  // dark glyphs on a light ground; Style.Dark = light glyphs on dark.
  try {
    await applyNativeAppearance(
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    )
    await StatusBar.setOverlaysWebView({ overlay: false })
  } catch (err) {
    console.warn('[native] status bar setup failed', err)
  }

  window.addEventListener('cumora:appearance', (ev) => {
    const resolved = (ev as CustomEvent<'light' | 'dark'>).detail
    void applyNativeAppearance(resolved)
  })

  // Splash — hide once React has mounted past the launch image.
  try {
    setTimeout(() => { void SplashScreen.hide() }, 400)
  } catch (err) {
    console.warn('[native] splash hide failed', err)
  }

  // Keyboard — expose height as --kb-height so layouts can react.
  try {
    Keyboard.addListener('keyboardWillShow', (info) => {
      // --kb-height on <html> (inherited everywhere); the `keyboard-open` class
      // MUST go on <body> because the CSS selector is `body.keyboard-open`
      // (and `.native` already lives on <body>). It was previously added to
      // <html>, so `body.keyboard-open .kb-aware` never matched and the
      // composer only moved via the native webview resize — which is why it
      // stopped moving at all once we switched to `resize: 'none'`.
      document.documentElement.style.setProperty('--kb-height', `${info.keyboardHeight}px`)
      document.body.classList.add('keyboard-open')
    })
    Keyboard.addListener('keyboardWillHide', () => {
      document.documentElement.style.setProperty('--kb-height', '0px')
      document.body.classList.remove('keyboard-open')
    })
  } catch (err) {
    console.warn('[native] keyboard listener failed', err)
  }

  // Hardware Android back button — let the renderer intercept first.
  try {
    App.addListener('backButton', ({ canGoBack }) => {
      const ev = new CustomEvent('cumora:hardware-back', { cancelable: true })
      const handled = !window.dispatchEvent(ev)
      if (!handled && !canGoBack) void App.exitApp()
    })
  } catch (err) {
    console.warn('[native] back-button listener failed', err)
  }

  // Deep-link callback for OAuth.
  //
  // Cumora signs in by opening Google/GitHub in SFSafariViewController
  // and asking the server to redirect to `cumora://auth#token=...`. iOS
  // routes that URL to @capacitor/app's `appUrlOpen` event — we strip the
  // fragment, fire a window event that AuthGate consumes, and dismiss the
  // browser sheet so the user lands back on the (now-signed-in) shell.
  try {
    App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
      if (!event.url) return
      console.log('[native] appUrlOpen', event.url)
      void handleDeepLink(event.url)
    })
  } catch (err) {
    console.warn('[native] appUrlOpen listener failed', err)
  }
}

/**
 * Consume a deep link the OS handed us via the cumora:// scheme.
 *
 * Two flows today:
 *   - `cumora://auth#token=...&companyId=...` — OAuth callback. We plant
 *     the fragment on our own location and dispatch a `cumora:oauth-token`
 *     event AuthGate listens for, then close the SFSafariViewController
 *     so the user re-emerges on the chat shell.
 *   - any other `cumora://...` — surfaced as `cumora:deep-link` so future
 *     handlers (invite acceptance, share-to-chat) can opt in.
 */
async function handleDeepLink(rawUrl: string): Promise<void> {
  try {
    if (!rawUrl.startsWith('cumora:')) return
    // Match the auth callback on the RAW string, not via `new URL().hostname`:
    // Android's WebView Chromium parses the host of a non-special scheme like
    // `cumora://auth` differently from Node/iOS (hostname can come back empty,
    // pathname `//auth`), so the host-based check silently missed and the OAuth
    // token was dropped on Android. The string match is parser-independent.
    if (/^cumora:\/\/auth(?:[/?#]|$)/i.test(rawUrl)) {
      // Pull the fragment (or a query-shaped token) straight out of the raw
      // URL so we don't depend on the parser splitting host vs path correctly.
      const hashIdx = rawUrl.indexOf('#')
      const qIdx = rawUrl.indexOf('?')
      const hash = hashIdx >= 0
        ? rawUrl.slice(hashIdx)
        : (qIdx >= 0 ? `#${rawUrl.slice(qIdx + 1)}` : '')
      console.log('[native] OAuth deep link, hash=', hash)
      if (hash) {
        history.replaceState(null, '', location.pathname + location.search + hash)
        window.dispatchEvent(new CustomEvent('cumora:oauth-token', { detail: hash }))
      }
      await Browser.close().catch(() => undefined)
      return
    }
    window.dispatchEvent(new CustomEvent('cumora:deep-link', { detail: rawUrl }))
  } catch (err) {
    console.warn('[native] deep-link parse failed', rawUrl, err)
  }
}

/**
 * Open a URL in the system browser (SFSafariViewController on iOS,
 * Custom Tabs on Android). Falls back to `window.open` on web so dev in
 * Vite still works.
 *
 * Note: do NOT use this for OAuth flows on iOS — SFSafariViewController
 * blocks 302 redirects to custom URL schemes. Use `runOAuth()` instead.
 */
export async function openExternalBrowser(url: string): Promise<void> {
  if (!isNativePlatform()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  try {
    await Browser.open({ url, presentationStyle: 'fullscreen' })
  } catch (err) {
    console.warn('[native] openExternalBrowser failed', err)
    window.open(url, '_blank')
  }
}

/**
 * Run an OAuth flow via `ASWebAuthenticationSession`. iOS-native; on
 * the web we fall back to a full-page `location.assign` since the
 * browser handles redirects to its own origin without a wrapper.
 *
 * Returns the callback URL (e.g. `cumora://auth#token=...`) on
 * success, or `null` if the user cancelled.
 */
export async function runOAuth(opts: {
  url: string
  callbackScheme: string
}): Promise<string | null> {
  if (!isNativePlatform()) {
    location.assign(opts.url)
    return null
  }
  // Android has no ASWebAuthenticationSession, and the WebAuth plugin is
  // iOS-only — so open the OAuth URL in a Custom Tab via @capacitor/browser.
  // The server's redirect to `cumora://auth#token=...` is routed back to the
  // app by the manifest's BROWSABLE intent-filter and caught by the global
  // `appUrlOpen` listener (see `handleDeepLink` → `cumora:oauth-token` →
  // AuthGate), which finishes sign-in and closes the tab. We resolve `null`
  // because completion is event-driven here, not carried by this promise.
  if (nativePlatform() === 'android') {
    try {
      await Browser.open({ url: opts.url })
    } catch (err) {
      console.warn('[native] runOAuth (android) Browser.open failed', err)
      throw err
    }
    return null
  }
  try {
    const result = await WebAuth.start(opts)
    return result.callbackUrl
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'USER_CANCELLED') return null
    console.warn('[native] runOAuth failed', err)
    throw err
  }
}

/** Light haptic — call on send / nav-back / FAB tap. Silent no-op on web. */
export async function tapHaptic(): Promise<void> {
  if (!isNativePlatform()) return
  try {
    await Haptics.impact({ style: ImpactStyle.Light })
  } catch {
    // ignore — haptics aren't critical
  }
}

/** Medium haptic — call when a long-press menu / context menu opens,
 *  or when a swipe gesture crosses a commit threshold. Heavier than a
 *  tap so the user feels "something engaged". */
export async function mediumHaptic(): Promise<void> {
  if (!isNativePlatform()) return
  try {
    await Haptics.impact({ style: ImpactStyle.Medium })
  } catch {
    // ignore
  }
}

/** Heavy haptic — for destructive confirmations or rare hard hits. */
export async function heavyHaptic(): Promise<void> {
  if (!isNativePlatform()) return
  try {
    await Haptics.impact({ style: ImpactStyle.Heavy })
  } catch {
    // ignore
  }
}

/** Light "tick" haptic — for crossing selection thresholds during a
 *  drag (e.g. swipe-action revealing a button, pull-to-refresh
 *  hitting the trigger point). Subtler than `tapHaptic`. */
export async function selectionHaptic(): Promise<void> {
  if (!isNativePlatform()) return
  try {
    await Haptics.selectionStart()
    await Haptics.selectionEnd()
  } catch {
    // ignore
  }
}
