/**
 * Shown to a returning OAuth visitor whose account is currently suspended.
 * Triggered by the `#suspended=1&email=...&reason=...` fragment that
 * handleCallback redirects to when the server-side `finalize` detects
 * `users.suspended_at IS NOT NULL`.
 *
 * Sibling to WaitlistConfirmedScreen — same chrome/styles, different
 * copy + the optional admin-supplied reason verbatim so the user can
 * dispute knowing exactly why they were locked out.
 *
 * Fragment is consumed once + scrubbed from the URL so a reload doesn't
 * stick the user on this screen; they fall back into the normal flow,
 * which (assuming they're still suspended) will re-issue the redirect
 * the next time they try to sign in.
 */
import { useState } from 'react'
import { useT } from '@/lib/i18n'

interface CarriedSuspension { email: string | null; reason: string | null }

export function consumeSuspendedFragment(): CarriedSuspension | null {
  const hash = location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  if (params.get('suspended') !== '1') return null
  const email = params.get('email')
  const reason = params.get('reason')
  history.replaceState(null, '', location.pathname + location.search)
  return { email, reason }
}

export function SuspendedScreen({ email, reason }: { email: string | null; reason: string | null }) {
  const t = useT()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) {
    // Falling out of the screen reloads → AuthGate decides what to render
    // next. The user has no active session (suspendUser deleted them all),
    // so they land back at the sign-in screen.
    location.reload()
    return null
  }
  const displayEmail = email ?? t('waitlist.suspendedEmailFallback')
  return (
    <div className="cumora-waitlist-screen">
      <div className="cumora-waitlist-card">
        <div className="cumora-waitlist-emoji" aria-hidden>🔒</div>
        <div className="cumora-waitlist-title">{t('waitlist.suspendedTitle')}</div>
        <div className="cumora-waitlist-sub" style={{ marginBottom: reason ? 16 : 24 }}>
          {(() => {
            // Split the translated body around the {email} placeholder so
            // we can wrap the rendered address in a styled <b> without
            // resorting to dangerouslySetInnerHTML.
            const rendered = t('waitlist.suspendedBody', { email: displayEmail })
            const parts = rendered.split(displayEmail)
            return (
              <>
                {parts[0]}
                <b className="cumora-waitlist-email">{displayEmail}</b>
                {parts.slice(1).join(displayEmail)}
              </>
            )
          })()}
        </div>
        {reason ? (
          <div className="cumora-suspended-reason" role="note">
            <div className="cumora-suspended-reason-label">{t('waitlist.suspendedReasonLabel')}</div>
            <div className="cumora-suspended-reason-body">{reason}</div>
          </div>
        ) : null}
        <div className="cumora-waitlist-sub" style={{ marginTop: 16, marginBottom: 24 }}>
          {t('waitlist.suspendedFooter')}
        </div>
        <button type="button" className="btn-ghost" onClick={() => setDismissed(true)}>
          {t('waitlist.suspendedDone')}
        </button>
      </div>
    </div>
  )
}
