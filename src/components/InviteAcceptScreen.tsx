/**
 * InviteAcceptScreen — the "you've been invited to <workspace>" landing
 * page. Renders when the URL carries an invite token via either:
 *   • path:   /invite/<token>           (web)
 *   • hash:   #invite=<token>           (electron deep link)
 *   • query:  ?invite=<token>           (legacy fallback)
 *
 * Flow:
 *   1. On mount, parse the token from the URL and call previewInvitation —
 *      unauthenticated callers learn the workspace name + inviter so the
 *      page reads "Iris invited you to Sunfire" before they sign in.
 *   2. If not signed in: show the same OAuth buttons AuthScreen uses, but
 *      we DON'T scrub the invite token from the URL — the AuthGate's
 *      OAuth-fragment handler stays scoped to `#token=…`, so the invite
 *      token survives the round-trip and we resume on return.
 *   3. Once signed in, show a "Join <workspace>" CTA. On click, POST the
 *      accept endpoint, append the company to the local auth store, and
 *      switch to it — at which point the AuthedApp key changes and the
 *      whole shell remounts on the new tenant.
 *
 * Edge cases the preview surface:
 *   • revoked / expired / consumed — terminal, show explainer.
 *   • wrong_email — the signed-in account's email doesn't match the
 *     locked-to email. Tell the user to sign out and sign in with the
 *     right account.
 *   • already_member — they already belong; just route them in.
 *   • not_found — bad link.
 */
import { useCallback, useEffect, useState } from 'react'
import { api, type ApiInvitationPreview } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { isElectron, isWebAppHost } from '@/lib/runtime'
import { useT } from '@/lib/i18n'
import { CloudLogo } from './Avatar'
import { GetDesktopAppLink } from './GetDesktopAppLink'
import { WindowDragStrip } from './WindowDragStrip'

const INVITE_TOKEN_KEY = 'cumora.pending-invite'

/** Look at the URL (path / hash / query) for an invite token. Returns
 *  the token + a no-op cleanup that scrubs it from the URL so a refresh
 *  doesn't trip the same handler again. The token is stashed in
 *  localStorage before scrubbing so the OAuth round-trip can pick it
 *  back up on return. */
export function consumeInviteFromUrl(): { token: string; clear: () => void } | null {
  const url = new URL(window.location.href)
  const pathMatch = url.pathname.match(/^\/invite\/([^/?#]+)\/?$/)
  if (pathMatch) {
    const token = decodeURIComponent(pathMatch[1])
    const clear = () => {
      // Drop the /invite/<token> prefix while preserving any query / hash
      // that was on the URL.
      const nextUrl = `${url.origin}/${url.search}${url.hash}`
      try { history.replaceState(null, '', nextUrl) } catch { /* swallow */ }
    }
    return { token, clear }
  }
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''))
  const fromHash = hashParams.get('invite')
  if (fromHash) {
    const token = decodeURIComponent(fromHash)
    const clear = () => {
      hashParams.delete('invite')
      const remaining = hashParams.toString()
      const nextUrl = `${url.origin}${url.pathname}${url.search}${remaining ? '#' + remaining : ''}`
      try { history.replaceState(null, '', nextUrl) } catch { /* swallow */ }
    }
    return { token, clear }
  }
  const fromQuery = url.searchParams.get('invite')
  if (fromQuery) {
    const token = decodeURIComponent(fromQuery)
    const clear = () => {
      url.searchParams.delete('invite')
      const nextUrl = `${url.origin}${url.pathname}${url.searchParams.toString() ? '?' + url.searchParams.toString() : ''}${url.hash}`
      try { history.replaceState(null, '', nextUrl) } catch { /* swallow */ }
    }
    return { token, clear }
  }
  return null
}

/** Persist a pending invite token across the OAuth round-trip. The
 *  AuthScreen redirects the browser away (Google / GitHub) — when the
 *  user lands back on AUTH_DONE_URL the path/hash is reset to the auth
 *  fragment shape, and `consumeInviteFromUrl` won't find the token.
 *  Pulling it from localStorage instead keeps the flow seamless. */
export function stashPendingInvite(token: string): void {
  try { localStorage.setItem(INVITE_TOKEN_KEY, token) } catch { /* swallow */ }
}

export function getPendingInvite(): string | null {
  try { return localStorage.getItem(INVITE_TOKEN_KEY) } catch { return null }
}

export function clearPendingInvite(): void {
  try { localStorage.removeItem(INVITE_TOKEN_KEY) } catch { /* swallow */ }
}

interface Props {
  token: string
  onDone: () => void
}

export function InviteAcceptScreen({ token, onDone }: Props) {
  const t = useT()
  const token_ = token
  const tokenUserId = useAuth((s) => s.user?.id ?? null)
  const tokenStr = useAuth((s) => s.token)
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const setActive = useAuth((s) => s.setActiveCompany)
  const companies = useAuth((s) => s.companies)
  const user = useAuth((s) => s.user)

  const [preview, setPreview] = useState<ApiInvitationPreview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [acceptErr, setAcceptErr] = useState<string | null>(null)
  // After a successful accept in the WEB build, we stop on a success
  // screen with "Open in Cumora app" + "Download" CTAs instead of
  // dropping the user straight into the SPA. The desktop app skips
  // this — they're already in the app, so we route them in.
  const [joinedCompany, setJoinedCompany] = useState<{ id: string; name: string; slug: string } | null>(null)

  const loadPreview = useCallback(async () => {
    setPreviewErr(null)
    try {
      const r = await api.previewInvitation(token_)
      setPreview(r)
    } catch (e) {
      setPreviewErr(e instanceof Error ? e.message : String(e))
    }
  }, [token_])

  useEffect(() => { void loadPreview() }, [loadPreview, tokenStr])

  const accept = useCallback(async () => {
    setBusy(true); setAcceptErr(null)
    try {
      const r = await api.acceptInvitation(token_)
      // Refresh /auth/me so the companies list (used by the switcher) gets
      // the freshly-joined workspace without a manual reload.
      try {
        const me = await api.authMe()
        setMe(me.user, me.companies, r.company.id)
        setServerCapabilities(me.serverCapabilities)
      } catch {
        // Fallback — surgically append + switch with what we already have.
        const existing = companies.find((c) => c.id === r.company.id)
        if (!existing) {
          // Minimal augmentation — re-fetching authMe is the normal path,
          // but if THAT fails we still want the user to land in the new
          // company. Mutate via setActiveCompany after a manual reload of
          // companies via listCompanies as a last resort.
          const list = await api.listCompanies().catch(() => null)
          if (list && user) setMe(user, list.map((c) => ({
            id: c.id, name: c.name, slug: c.slug, role: c.role,
          })), r.company.id)
        } else {
          setActive(r.company.id)
        }
      }
      clearPendingInvite()
      if (isElectron) {
        // Already in the app — drop straight into the workspace, no
        // success interstitial needed.
        onDone()
      } else {
        // Web flow: park on the success screen so the user can choose
        // between continuing in the browser, opening the desktop app via
        // deep link, or downloading it. Auto-routing into the SPA was
        // the wrong default — most invitees probably want the native app.
        setJoinedCompany({ id: r.company.id, name: r.company.name, slug: r.company.slug })
      }
    } catch (e) {
      setAcceptErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [token_, setMe, setServerCapabilities, setActive, companies, user, onDone])

  // Auto-accept the moment we have a session AND the preview is `valid`.
  // Saves a redundant click when the user just signed in to redeem the
  // invite — the page goes preview → busy → into the workspace fluidly.
  useEffect(() => {
    if (!tokenStr) return
    if (preview?.status !== 'valid') return
    if (busy) return
    if (joinedCompany) return  // already redeemed — don't re-POST in a loop
    void accept()
  }, [tokenStr, preview, busy, accept, joinedCompany])

  const inv = preview?.invitation
  const companyName = inv?.company.name ?? 'Cumora'
  const inviter = inv?.inviterName ?? 'Someone'
  const signedIn = !!tokenStr && !!tokenUserId

  return (
    <div className="fixed inset-0 grid place-items-center p-6" style={{ background: 'var(--paper)' }}>
      <WindowDragStrip />
      <div
        className="w-full max-w-[420px] rounded-[18px] p-8 flex flex-col items-center gap-6"
        style={{
          background: 'white',
          border: '1px solid var(--ink-100)',
          boxShadow: '0 30px 60px -30px rgba(10, 30, 60, 0.20), 0 0 0 1px rgba(0, 80, 140, 0.04)',
        }}
      >
        <CloudLogo size={56} />

        {joinedCompany && (
          <JoinedSuccessBlock
            companyName={joinedCompany.name}
            onContinueInBrowser={() => { setJoinedCompany(null); onDone() }}
          />
        )}

        {!joinedCompany && previewErr && (
          <ErrorBlock
            title={t('inviteAccept.couldntLoadTitle')}
            body={previewErr}
            onDismiss={() => { clearPendingInvite(); onDone() }}
          />
        )}

        {!joinedCompany && !preview && !previewErr && (
          <div className="text-[13px] text-ink-400 italic font-display">{t('inviteAccept.checking')}</div>
        )}

        {!joinedCompany && preview && preview.status === 'not_found' && (
          <ErrorBlock
            title={t('inviteAccept.linkBrokenTitle')}
            body={t('inviteAccept.linkBrokenBody')}
            onDismiss={() => { clearPendingInvite(); onDone() }}
          />
        )}

        {!joinedCompany && preview && preview.status === 'revoked' && (
          <ErrorBlock
            title={t('inviteAccept.revokedTitle')}
            body={t('inviteAccept.revokedBody', { name: companyName })}
            onDismiss={() => { clearPendingInvite(); onDone() }}
          />
        )}

        {!joinedCompany && preview && preview.status === 'expired' && (
          <ErrorBlock
            title={t('inviteAccept.expiredTitle')}
            body={t('inviteAccept.expiredBody', { name: companyName })}
            onDismiss={() => { clearPendingInvite(); onDone() }}
          />
        )}

        {!joinedCompany && preview && preview.status === 'consumed' && (
          <ErrorBlock
            title={t('inviteAccept.usedTitle')}
            body={t('inviteAccept.usedBody', { name: companyName })}
            onDismiss={() => { clearPendingInvite(); onDone() }}
          />
        )}

        {!joinedCompany && preview && preview.status === 'wrong_email' && inv && (
          <div className="flex flex-col items-center gap-4 text-center">
            <h1 className="font-display text-[20px] text-ink-900">{t('inviteAccept.wrongAccount')}</h1>
            <p className="text-[13px] text-ink-500 font-display italic leading-relaxed">
              {t('inviteAccept.wrongAccountBody', {
                company: companyName,
                email: inv.email ?? '',
                current: user?.email ?? '',
              })}
            </p>
            <button
              type="button"
              onClick={() => { useAuth.getState().clear() }}
              className="px-4 py-2 rounded-[10px] text-[13px] font-semibold transition"
              style={{ background: 'var(--ink-700)', color: 'white' }}
            >{t('inviteAccept.signOut')}</button>
          </div>
        )}

        {!joinedCompany && preview && preview.status === 'already_member' && (
          <AlreadyMemberBlock
            companyName={companyName}
            onSwitchInBrowser={() => {
              if (inv) setActive(inv.company.id)
              clearPendingInvite()
              onDone()
            }}
          />
        )}

        {!joinedCompany && preview && preview.status === 'valid' && inv && (
          <div className="flex flex-col items-center gap-5 text-center w-full">
            <div className="space-y-1">
              <div className="text-[12.5px] text-ink-400 font-display italic">
                {t('inviteAccept.invitedBy', { name: inviter })}
              </div>
              <h1 className="font-display text-[24px] tracking-tight text-ink-900">
                {companyName}
              </h1>
              {inv.note && (
                <div className="text-[12.5px] text-ink-500 font-display italic mt-2 px-3 py-2 rounded-[10px]"
                     style={{ background: 'var(--cloud)' }}>
                  "{inv.note}"
                </div>
              )}
            </div>

            {!signedIn ? (
              <SignInToAccept token={token_} />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void accept()}
                  disabled={busy}
                  className="w-full py-3 rounded-[12px] text-[14px] font-semibold text-white transition disabled:opacity-60"
                  style={{
                    background: 'var(--skype)',
                    boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.5)',
                  }}
                >{busy ? t('inviteAccept.joinBusy') : t('inviteAccept.joinAs', { company: companyName, role: inv.role })}</button>
                <button
                  type="button"
                  onClick={() => { clearPendingInvite(); onDone() }}
                  className="text-[12px] text-ink-400 hover:text-ink-700 transition font-display italic"
                >{t('inviteAccept.notNow')}</button>
              </>
            )}

            {acceptErr && (
              <div className="text-[12px] text-coral-deep text-center max-w-full break-words">
                {acceptErr}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Best-effort cumora:// deep link. If the OS protocol handler isn't
 *  registered, browsers fail silently (no broken-page) and the user just
 *  stays put — at which point the visible Download button below is the
 *  next thing they reach for. */
function tryOpenDesktopApp() {
  try { location.href = 'cumora://open' } catch { /* swallow */ }
}

/** Success state shown after a successful accept in the WEB build. Offers
 *  "Open in Cumora app" (best-effort cumora:// deep link) and a download
 *  CTA, with "continue in browser" as the soft fallback. */
function JoinedSuccessBlock({ companyName, onContinueInBrowser }: {
  companyName: string
  onContinueInBrowser: () => void
}) {
  const t = useT()
  return (
    <div className="flex flex-col items-center gap-5 text-center w-full">
      <div
        className="w-12 h-12 rounded-full grid place-items-center"
        style={{ background: 'var(--sky-100)', color: 'var(--skype-deep)' }}
        aria-hidden
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <div className="space-y-1">
        <h1 className="font-display text-[22px] tracking-tight text-ink-900">
          {t('inviteAccept.welcomeTo', { name: companyName })}
        </h1>
        <p className="text-[12.5px] text-ink-500 font-display italic">
          {t('inviteAccept.welcomeBody')}
        </p>
      </div>
      <div className="w-full flex flex-col gap-2.5">
        <button
          type="button"
          onClick={tryOpenDesktopApp}
          className="w-full py-3 rounded-[12px] text-[14px] font-semibold text-white transition"
          style={{
            background: 'var(--skype)',
            boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.5)',
          }}
        >{t('inviteAccept.openApp')}</button>
        <GetDesktopAppLink variant="button-secondary" />
        {!isWebAppHost && (
          <button
            type="button"
            onClick={onContinueInBrowser}
            className="text-[12px] text-ink-400 hover:text-ink-700 transition font-display italic mt-1"
          >{t('inviteAccept.continueInBrowser')}</button>
        )}
      </div>
    </div>
  )
}

/** Shown when the preview reports `already_member` — the signed-in user
 *  is already in the target workspace, so accepting is a no-op. The
 *  practical reason they hit this screen is usually "I clicked the
 *  invite link on a new device / fresh browser" — so we lead with
 *  "Open in desktop" + "Download" to cover the install case, and keep
 *  the "switch in browser" path as a soft tertiary. */
function AlreadyMemberBlock({ companyName, onSwitchInBrowser }: {
  companyName: string
  onSwitchInBrowser: () => void
}) {
  const t = useT()
  return (
    <div className="flex flex-col items-center gap-5 text-center w-full">
      <h1 className="font-display text-[20px] text-ink-900">{t('inviteAccept.alreadyIn', { name: companyName })}</h1>
      <p className="text-[12.5px] text-ink-500 font-display italic -mt-2">
        {t('inviteAccept.alreadyInBody')}
      </p>
      <div className="w-full flex flex-col gap-2.5">
        <button
          type="button"
          onClick={tryOpenDesktopApp}
          className="w-full py-3 rounded-[12px] text-[14px] font-semibold text-white transition"
          style={{
            background: 'var(--skype)',
            boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.5)',
          }}
        >{t('inviteAccept.openDesktop')}</button>
        <GetDesktopAppLink variant="button-secondary" />
        {!isWebAppHost && (
          <button
            type="button"
            onClick={onSwitchInBrowser}
            className="text-[12px] text-ink-400 hover:text-ink-700 transition font-display italic mt-1"
          >{t('inviteAccept.continueInBrowser')}</button>
        )}
      </div>
    </div>
  )
}

function ErrorBlock({ title, body, onDismiss }: { title: string; body: string; onDismiss?: () => void }) {
  const tokenStr = useAuth((s) => s.token)
  const t = useT()
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <h1 className="font-display text-[20px] text-ink-900">{title}</h1>
      <p className="text-[13px] text-ink-500 font-display italic leading-relaxed">{body}</p>
      {tokenStr && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="px-4 py-2 rounded-[10px] text-[12.5px] font-semibold text-ink-700 transition"
          style={{ background: 'var(--cloud)', border: '1px solid var(--ink-100)' }}
        >{t('inviteAccept.continueToCumora')}</button>
      )}
    </div>
  )
}

function SignInToAccept({ token }: { token: string }) {
  const t = useT()
  const [busy, setBusy] = useState<'google' | 'github' | null>(null)
  const go = (provider: 'google' | 'github') => {
    setBusy(provider)
    // Persist BEFORE redirect so the post-OAuth landing can resume here.
    stashPendingInvite(token)
    if (isElectron && window.cumora?.auth) {
      const origin = (typeof localStorage !== 'undefined' && localStorage.getItem('cumora.serverUrl'))
        || (import.meta.env.VITE_CUMORA_API_BASE as string | undefined)
        || 'https://api.cumora.ai'
      const inv = encodeURIComponent(token)
      // Arm a single-use nonce (anti session-fixation — see AuthScreen). The
      // nonce rides the return URL's query and must match on the inbound token.
      const auth = window.cumora.auth
      void (async () => {
        let done = 'http://127.0.0.1:47823/auth/done'
        try {
          const nonce = await auth.arm?.()
          if (nonce) done += `?n=${encodeURIComponent(nonce)}`
        } catch { /* unarmed fallback → token rejected, user retries */ }
        const ret = encodeURIComponent(done)
        void auth.openExternal(`${origin}/api/auth/start/${provider}?return=${ret}&invite=${inv}`)
      })()
      return
    }
    location.assign(api.authStartUrl(provider, { inviteToken: token }))
  }
  return (
    <div className="w-full flex flex-col gap-2.5">
      <div className="text-[12.5px] text-ink-500 font-display italic text-center">
        {t('auth.signInToAccept')}
      </div>
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
      <div className="text-[10.5px] text-ink-300 text-center font-display italic">
        {t('auth.providerNote')}
      </div>
      <div className="text-[11.5px] text-ink-400 text-center font-display italic pt-1">
        {t('inviteAccept.getCumoraPre')}
        <GetDesktopAppLink variant="text" label={t('inviteAccept.getCumora')} />
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

function GitHubMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1-.02-1.95-3.2.69-3.88-1.54-3.88-1.54-.52-1.32-1.28-1.67-1.28-1.67-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.9-.39.99 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.07.78 2.16 0 1.56-.01 2.81-.01 3.19 0 .31.21.67.8.55C20.22 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
    </svg>
  )
}
