/**
 * Sign-in screen — OAuth only (Google + GitHub). No password forms, no
 * signup, no forgot. Provider buttons trigger a full-page redirect to
 * /api/auth/start/<provider> on the configured server origin (relative
 * URL goes through the Vite proxy in dev; baked-in absolute URL in
 * packaged builds). The provider returns to /auth/done with a fragment
 * the AuthGate consumes on next mount.
 *
 * Server switcher: dev iteration constantly toggles between Local Dev
 * and Production; we surface that here (not buried in devtools) because
 * picking the server is a sign-in-time decision — the auth token is
 * per-server.
 */
import { useState, useEffect } from 'react'
import { api, getPairingServerOrigin, getServerOrigin, setServerOrigin } from '@/api/client'
import { isCapacitorIOS, isElectron } from '@/lib/runtime'
import { isNativePlatform, nativePlatform, runAppleSignIn, runOAuth } from '@/lib/native'
import { useAuth } from '@/stores/auth'
import { CloudLogo } from './Avatar'
import { WindowDragStrip } from './WindowDragStrip'
import { translate, useLocaleStore, useT, type MessageKey } from '@/lib/i18n'

interface ServerPreset { label: string; origin: string }
const PRESETS: ServerPreset[] = [
  { label: 'Production',  origin: 'https://api.cumora.ai' },
  { label: 'Local Dev',   origin: 'http://localhost:5181' },
]
// i18n: parallel lookup so the PRESETS shape stays upstream-mergeable.
const PRESET_LABEL_KEY: Record<string, MessageKey> = {
  'Production': 'auth.presetProduction',
  'Local Dev': 'auth.presetLocalDev',
}

export function AuthScreen() {
  const t = useT()
  const [busy, setBusy] = useState<'google' | 'github' | 'apple' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)

  // AuthGate strips a successful fragment after consuming it. A failure
  // fragment looks like `#token=&companyId=&error=...` — surface that
  // so the user knows the previous attempt didn't take.
  useEffect(() => {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''))
    const error = params.get('error')
    if (error) setErr(decodeURIComponent(error))
  }, [])

  // Re-arm the sign-in buttons when the user returns to this window after
  // abandoning the OAuth tab. Without this, the Electron renderer stays
  // mounted with busy=provider after openExternal — both buttons disabled
  // forever, no way to retry. Three signals cover the cases:
  //   - window focus: user clicked back into the Electron window.
  //   - visibilitychange → visible: tab/window came back from hidden.
  //   - 90s safety timer: focus events occasionally miss (e.g. user
  //     never clicked away from the Electron window because the OAuth
  //     tab opened in the background).
  // The browser-flow case (location.assign) is unaffected — full-page
  // nav unmounts this component before any listener can fire.
  useEffect(() => {
    if (busy === null) return
    const reset = () => setBusy(null)
    const onVisibility = () => { if (document.visibilityState === 'visible') reset() }
    window.addEventListener('focus', reset)
    document.addEventListener('visibilitychange', onVisibility)
    const safety = window.setTimeout(reset, 90_000)
    return () => {
      window.removeEventListener('focus', reset)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearTimeout(safety)
    }
  }, [busy])

  /** Native Sign in with Apple — iOS-only. Uses the
   *  ASAuthorization flow via our Swift plugin, then POSTs the
   *  identity_token to /auth/apple/native and stamps the session
   *  directly through useAuth — no fragment-redirect dance needed
   *  because the whole flow stays in-process. */
  async function goApple() {
    setBusy('apple'); setErr(null)
    try {
      const { identityToken, name } = await runAppleSignIn()
      const r = await api.authAppleNative({ identityToken, name })
      useAuth.getState().setSession(r.token, { id: r.user.id, email: r.user.email, name: r.user.displayName }, r.companyId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'canceled' || msg.includes('USER_CANCELLED')) {
        // Silent — user closed the sheet on purpose.
      } else {
        setErr(msg)
      }
      setBusy(null)
    }
  }

  function go(provider: 'google' | 'github') {
    setBusy(provider); setErr(null)
    if (isElectron && window.cumora?.auth) {
      // Open the user's real browser (Safari / Chrome) so they see the
      // provider's authentic URL bar and so Google's embedded-webview
      // bans don't bite us. We pass `?return=http://127.0.0.1:47823/auth/done`
      // — the loopback HTTP server in main.cjs serves a styled
      // "Signed in" page that POSTs the fragment back to the main
      // process, which IPCs the renderer (see AuthGate's onToken).
      // getServerOrigin() is '' in dev (relative, for the Vite proxy) —
      // use the pairing origin so local dev opens the local server instead
      // of falling through to production.
      const origin = getPairingServerOrigin() || 'https://api.cumora.ai'
      // Arm a single-use nonce and thread it through the return URL. The server
      // round-trips it back onto /auth/done, the loopback page carries it into
      // the cumora:// deep link, and main accepts the token only if the nonce
      // matches — so a drive-by deep link the app never initiated is rejected
      // (anti session-fixation). arm() is Electron-only.
      const auth = window.cumora.auth
      void (async () => {
        let ret = 'http://127.0.0.1:47823/auth/done'
        try {
          const nonce = await auth.arm?.()
          if (nonce) ret += `?n=${encodeURIComponent(nonce)}`
        } catch { /* no arm available → fall through unarmed; token will be rejected, user retries */ }
        void auth.openExternal(
          `${origin}/api/auth/start/${provider}?return=${encodeURIComponent(ret)}`,
        )
      })()
      return
    }
    if (isNativePlatform()) {
      // iOS / Android: run the OAuth flow inside ASWebAuthenticationSession
      // (our WebAuthPlugin). It hands the final cumora://auth#... callback
      // straight back to us — no SFSafariViewController, no broken 302
      // redirect to a custom URL scheme.
      // See the Electron branch above — same reasoning for preferring the
      // pairing origin over getServerOrigin() in dev.
      const origin = getPairingServerOrigin() || 'https://api.cumora.ai'
      const ret = encodeURIComponent('cumora://auth')
      void (async () => {
        try {
          const callbackUrl = await runOAuth({
            url: `${origin}/api/auth/start/${provider}?return=${ret}`,
            callbackScheme: 'cumora',
          })
          if (!callbackUrl) {
            // User cancelled — re-enable the button.
            setBusy(null)
            return
          }
          // ASWebAuthenticationSession delivers the final URL with the
          // token fragment. Plant it as our `location.hash` so AuthGate's
          // existing fragment-consumption logic picks it up.
          const u = new URL(callbackUrl)
          const hash = u.hash || (u.search ? `#${u.search.replace(/^\?/, '')}` : '')
          if (!hash) {
            setErr(translate(useLocaleStore.getState().locale, 'auth.noTokenReturned'))
            setBusy(null)
            return
          }
          history.replaceState(null, '', location.pathname + location.search + hash)
          window.dispatchEvent(new CustomEvent('cumora:oauth-token', { detail: hash }))
        } catch (err) {
          setErr(err instanceof Error ? err.message : 'sign-in failed')
          setBusy(null)
        }
      })()
      return
    }
    // Browser fallback — full-page nav, fragment-on-redirect handled by
    // AuthGate on next mount. Pass the *current* page as `?return=` so
    // a user signing in from admin.cumora.ai lands back on
    // admin.cumora.ai (not the server's default app.cumora.ai). The
    // origin must be in CUMORA_AUTH_RETURN_ALLOWLIST or the server
    // will reject it.
    const ret = encodeURIComponent(`${location.origin}${location.pathname}`)
    location.assign(`${api.authStartUrl(provider)}?return=${ret}`)
  }

  return (
    <div
      className="fixed inset-0 grid place-items-center"
      style={{ background: 'var(--paper)' }}
    >
      <WindowDragStrip />
      <div className="w-[320px] flex flex-col items-center gap-8">
        <CloudLogo size={64} />
        <div className="text-center">
          <div className="font-display text-[22px] text-ink-900">{t('auth.welcome')}</div>
          <div className="font-display italic text-[13px] text-ink-400 mt-1">
            {t('auth.signInToContinue')}
          </div>
        </div>
        <div className="w-full flex flex-col gap-3">
          {/* Sign in with Apple — iOS-only for now. Apple Review
              Guideline 4.8 requires SIWA be offered as an equivalent
              option whenever an iOS app exposes any third-party
              social login. We use the native ASAuthorization flow
              (no browser tab) so iOS users get the system-styled
              sheet + biometric. */}
          {isCapacitorIOS && nativePlatform() === 'ios' && (
            <button
              type="button"
              onClick={goApple}
              disabled={busy !== null}
              className="h-11 rounded-[10px] bg-black hover:bg-[#111] text-white transition-colors flex items-center justify-center gap-3 text-[14px] disabled:opacity-60"
            >
              <AppleMark />
              {busy === 'apple' ? t('auth.signingIn') : t('auth.continueWithApple')}
            </button>
          )}
          <button
            type="button"
            onClick={() => go('google')}
            disabled={busy !== null}
            className="h-11 rounded-[10px] border border-ink-200 bg-white hover:bg-cloud transition-colors flex items-center justify-center gap-3 text-[14px] text-ink-800 disabled:opacity-60"
          >
            <GoogleMark />
            {busy === 'google' ? t('auth.redirecting') : t('auth.continueWithGoogle')}
          </button>
          <button
            type="button"
            onClick={() => go('github')}
            disabled={busy !== null}
            className="h-11 rounded-[10px] bg-[#1f2328] hover:bg-[#2a3037] text-white transition-colors flex items-center justify-center gap-3 text-[14px] disabled:opacity-60"
          >
            <GitHubMark />
            {busy === 'github' ? t('auth.redirecting') : t('auth.continueWithGithub')}
          </button>
        </div>
        {err && (
          <div className="text-[12px] text-red-600 text-center max-w-full break-words">
            {err}
          </div>
        )}
        <div className="text-[11px] text-ink-300 text-center font-display italic">
          {t('auth.providerNote')}
        </div>
        <ServerSwitch open={picker} onToggle={() => setPicker((v) => !v)} />
      </div>
    </div>
  )
}

/** Currently-active server origin in human-readable form. Mirrors what
 *  api.client computed at module init. Takes the translator rather than
 *  calling the hook itself — it runs inside a component's render. */
function currentOriginLabel(t: ReturnType<typeof useT>): string {
  const origin = getServerOrigin()
  if (!origin) return t('auth.sameOrigin')
  const match = PRESETS.find((p) => p.origin === origin)
  return match ? `${match.label} · ${origin}` : origin
}

function ServerSwitch({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useT()
  const [custom, setCustom] = useState('')
  const current = getServerOrigin()

  function apply(origin: string | null) {
    setServerOrigin(origin)
    // Hard reload — module-init-time SERVER_ORIGIN is now stale, and any
    // pending fetch against the old origin would race confusingly.
    location.reload()
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="text-[11px] text-ink-300 hover:text-ink-500 transition-colors font-display"
      >
        {t('auth.apiServer')}: <span className="underline decoration-dotted">{currentOriginLabel(t)}</span>
      </button>
    )
  }
  return (
    <div className="w-full border border-ink-200 rounded-[10px] p-3 bg-white/60 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-display text-ink-700">{t('auth.apiServer')}</div>
        <button type="button" onClick={onToggle} className="text-[11px] text-ink-300 hover:text-ink-500">{t('common.close')}</button>
      </div>
      {PRESETS.map((p) => (
        <button
          key={p.origin}
          type="button"
          onClick={() => apply(p.origin)}
          className={`text-left h-9 px-2 rounded-[6px] text-[12px] flex items-center justify-between hover:bg-cloud transition-colors ${current === p.origin ? 'bg-cloud' : ''}`}
        >
          <span className="font-display text-ink-800">{PRESET_LABEL_KEY[p.label] ? t(PRESET_LABEL_KEY[p.label]) : p.label}</span>
          <span className="text-[10px] text-ink-400">{p.origin}</span>
        </button>
      ))}
      <div className="flex items-stretch gap-2 pt-1">
        <input
          type="url"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="https://your-server"
          className="flex-1 h-9 px-2 rounded-[6px] border border-ink-200 text-[12px] focus:outline-none focus:border-ink-400"
        />
        <button
          type="button"
          disabled={!custom.trim()}
          onClick={() => apply(custom.trim())}
          className="h-9 px-3 rounded-[6px] bg-ink-800 text-white text-[12px] disabled:opacity-40"
        >
          {t('common.use')}
        </button>
      </div>
      {current && (
        <button
          type="button"
          onClick={() => apply(null)}
          className="text-[11px] text-ink-400 hover:text-ink-600 self-start"
        >
          {t('auth.clearOverride')}
        </button>
      )}
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  )
}

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1-.02-1.95-3.2.69-3.88-1.54-3.88-1.54-.52-1.32-1.28-1.67-1.28-1.67-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.99 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.16 0 1.56-.01 2.81-.01 3.19 0 .31.21.67.8.55C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
    </svg>
  )
}

function AppleMark() {
  return (
    <svg width="16" height="20" viewBox="0 0 384 512" fill="currentColor" aria-hidden>
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM236.1 86.7c25.5-30.3 23.2-57.9 22.4-67.9-22.5 1.3-48.6 15.3-63.5 32.5-16.4 18.4-26 41.2-23.9 66.6 24.3 1.9 46.5-10.6 65-31.2z"/>
    </svg>
  )
}
