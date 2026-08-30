/**
 * WebShell — the entire UI surface that ships on app.cumora.ai (and any
 * other public `app.*` hostname). Cumora is a desktop-only product, so
 * the web client is intentionally minimal: it can sign a user in via
 * OAuth, surface the waitlist verdict, and hand the session off to the
 * desktop app via the `cumora://` deep link. Nothing else — no chat,
 * no admin, no in-browser fallback.
 *
 * App.tsx routes here when `isWebAppHost` is true. Authenticated visitors
 * see <WebHandoff> (auto-fires the deep link); unauthenticated visitors
 * see <WebLanding> (Google / GitHub sign-in + an "I already have the
 * app" CTA). Approved-entry links from the welcome email can also expose
 * the desktop download fallback even while the public waitlist gate is on.
 */
import { useEffect, useState } from 'react'
import { api } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { AuthGate } from '@/components/AuthGate'
import { useT } from '@/lib/i18n'
import { CloudLogo } from '@/components/Avatar'
import { GetDesktopAppLink } from '@/components/GetDesktopAppLink'

function tryDeepLink(url: string) {
  // Same-tab nav triggers the OS protocol handler when registered. If the
  // scheme isn't registered the browser silently does nothing (no "site
  // can't be reached" page), which is the desired UX — the user just
  // stays on this page and clicks Download.
  try { location.href = url } catch { /* swallow */ }
}

function buildAuthDeepLink(token: string, companyId: string | null): string {
  const frag = new URLSearchParams()
  frag.set('token', token)
  if (companyId) frag.set('companyId', companyId)
  return `cumora://auth#${frag.toString()}`
}

export function WebShell() {
  return (
    <AuthGate unauthFallback={<WebLanding />}>
      <WebHandoff />
    </AuthGate>
  )
}

/** Signed-in handoff screen. Auto-fires the cumora:// deep link once on
 *  mount; the manual button is a re-arm in case the browser swallowed
 *  the first attempt (e.g. user was tabbed away). */
function WebHandoff() {
  const t = useT()
  const token = useAuth((s) => s.token)
  const companyId = useAuth((s) => s.activeCompanyId)
  const clear = useAuth((s) => s.clear)

  useEffect(() => {
    if (!token) return
    tryDeepLink(buildAuthDeepLink(token, companyId))
  }, [token, companyId])

  const openApp = () => {
    if (!token) return
    tryDeepLink(buildAuthDeepLink(token, companyId))
  }

  const signOut = async () => {
    try { await api.authLogout() } catch { /* swallow */ }
    clear()
  }

  return (
    <div
      className="fixed inset-0 grid place-items-center"
      style={{ background: 'var(--paper)' }}
    >
      <div className="w-[360px] flex flex-col items-center gap-7 text-center">
        <CloudLogo size={64} />
        <div className="space-y-1">
          <div className="font-display text-[22px] text-ink-900">{t('web.signedIn')}</div>
          <div className="font-display italic text-[13px] text-ink-400">
            {t('web.openingDesktop')}
          </div>
        </div>
        <div className="w-full flex flex-col gap-2.5">
          <button
            type="button"
            onClick={openApp}
            className="w-full py-3 rounded-[12px] text-[14px] font-semibold text-white transition"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.5)',
            }}
          >{t('web.openDesktop')}</button>
          <GetDesktopAppLink variant="button-secondary" />
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-[12px] text-ink-400 hover:text-ink-700 transition font-display italic mt-1"
          >{t('web.signOut')}</button>
        </div>
        <div className="text-[11px] text-ink-300 font-display italic">
          {t('web.onlyDesktopNote')}
        </div>
      </div>
    </div>
  )
}

/** Unauthenticated landing. Sign-in kicks the standard OAuth round-trip;
 *  the result lands back here either as a signed-in session (→ Handoff),
 *  as a waitlist verdict (→ WaitlistConfirmedScreen, handled in App.tsx),
 *  or as a suspended verdict (→ SuspendedScreen, also App.tsx). */
function WebLanding() {
  const t = useT()
  const [busy, setBusy] = useState<'google' | 'github' | 'gitlab' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Same gating as AuthScreen: GitLab is opt-in, so only offer it when this
  // deployment actually has credentials for it.
  const [gitlabEnabled, setGitlabEnabled] = useState(false)
  const approvedEntry = new URLSearchParams(location.search).has('approved')

  useEffect(() => {
    let cancelled = false
    void api.authProviders()
      .then((r) => { if (!cancelled) setGitlabEnabled(r.providers.includes('gitlab')) })
      .catch(() => { /* older server or offline — leave the button hidden */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''))
    const error = params.get('error')
    if (error) setErr(decodeURIComponent(error))
  }, [])

  const go = (provider: 'google' | 'github' | 'gitlab') => {
    setBusy(provider); setErr(null)
    const returnUrl = `${location.origin}${location.pathname}`
    location.assign(api.authStartUrl(provider, { returnUrl }))
  }

  return (
    <div
      className="fixed inset-0 grid place-items-center"
      style={{ background: 'var(--paper)' }}
    >
      <div className="w-[360px] flex flex-col items-center gap-7">
        <CloudLogo size={64} />
        <div className="text-center space-y-1">
          <div className="font-display text-[22px] text-ink-900">{t('web.desktopApp')}</div>
          <div className="font-display italic text-[13px] text-ink-400">
            {t('web.desktopAppSub')}
          </div>
        </div>
        <div className="w-full flex flex-col gap-3">
          <button
            type="button"
            onClick={() => go('google')}
            disabled={busy !== null}
            className="h-11 rounded-[10px] border border-ink-100 bg-cloud hover:bg-sky2-50 text-ink-900 transition-colors flex items-center justify-center gap-3 text-[14px] font-medium disabled:opacity-60"
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
          {gitlabEnabled && (
            <button
              type="button"
              onClick={() => go('gitlab')}
              disabled={busy !== null}
              className="h-11 rounded-[10px] bg-[#fc6d26] hover:bg-[#e24329] text-white transition-colors flex items-center justify-center gap-3 text-[14px] disabled:opacity-60"
            >
              <GitLabMark />
              {busy === 'gitlab' ? t('auth.redirecting') : t('auth.continueWithGitlab')}
            </button>
          )}
        </div>
        {err && (
          <div className="text-[12px] text-red-600 text-center max-w-full break-words">
            {err}
          </div>
        )}
        <div className="w-full flex items-center gap-3 text-[11px] text-ink-300 font-display italic">
          <div className="flex-1 h-px bg-ink-100" />
          {t('web.or')}
          <div className="flex-1 h-px bg-ink-100" />
        </div>
        <div className="w-full flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => tryDeepLink('cumora://open')}
            className="w-full py-3 rounded-[12px] text-[14px] font-semibold text-ink-700 transition"
            style={{ background: 'var(--cloud)', border: '1px solid var(--ink-100)' }}
          >{t('web.openDesktop')}</button>
          <GetDesktopAppLink
            variant="button-secondary"
            gateBypass={approvedEntry}
            className="w-full py-2.5 rounded-[12px] text-[12.5px] font-semibold text-ink-500 transition text-center hover:text-ink-700"
            style={{}}
          />
        </div>
        <div className="text-[11px] text-ink-300 text-center font-display italic">
          {t('web.providerNote2')}
        </div>
      </div>
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

function GitLabMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21.4 8.7 11.2H15.3L12 21.4zM3.6 11.2 2.3 15.3a.9.9 0 0 0 .33 1L12 21.4 3.6 11.2zM3.6 11.2h5.1L6.5 4.4a.45.45 0 0 0-.86 0L3.6 11.2zM20.4 11.2l1.3 4.1a.9.9 0 0 1-.33 1L12 21.4l8.4-10.2zM20.4 11.2h-5.1l2.2-6.8a.45.45 0 0 1 .86 0l2.04 6.8z" />
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
