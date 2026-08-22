/**
 * Single source of truth for "Get the desktop app" links rendered by the
 * web SPA. Every surface that wants to offer Download should use this
 * component instead of hand-rolling an <a> — that way the URL, the UA
 * detection, the gate-bypass flag, and the wording stay in lockstep
 * across the app.
 *
 * The URL deliberately carries `?download=1` so the marketing site's
 * waitlist gate (see website/index.html) doesn't intercept users who
 * are already past the gate or who don't have a path to Join Waitlist
 * to begin with (e.g. an invited user, or a recently-approved user
 * coming through the welcome email).
 */
import type { CSSProperties } from 'react'
import { useT } from '@/lib/i18n'

// `?download=1` tells the marketing site to skip its waitlist gate. We
// pass it from every surface where the viewer has *some* claim to the
// product (signed in, on the waitlist already, invited, etc.) so
// they're never bounced from a Download CTA back to Join Waitlist.
// WebLanding opts out for anonymous visitors, but opts back in for
// approved-entry links coming from the welcome email.
const DOWNLOAD_URL_BYPASS = 'https://cumora.ai/?download=1#download'
const DOWNLOAD_URL_GATED  = 'https://cumora.ai/#download'

export type GetDesktopAppLinkVariant = 'button-primary' | 'button-secondary' | 'text'

interface Props {
  variant: GetDesktopAppLinkVariant
  /** Override the auto-detected label. Pass when the surrounding copy
   *  already implies "download" so this CTA can read "Get the app" etc. */
  label?: string
  /** Skip the marketing-site waitlist gate. Default true — most callers
   *  already represent a viewer with some claim to the product. Set
   *  false on screens that don't (e.g. anonymous WebLanding). */
  gateBypass?: boolean
  className?: string
  style?: CSSProperties
}

function detectLabel(t: ReturnType<typeof useT>): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Mac OS X|Macintosh/i.test(ua)) return t('download.forMac')
  if (/Windows/i.test(ua)) return t('download.forWindows')
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return t('download.forLinux')
  return t('download.generic')
}

interface VariantDefaults {
  className: string
  style: CSSProperties | undefined
}

const VARIANT_DEFAULTS: Record<GetDesktopAppLinkVariant, VariantDefaults> = {
  'button-primary': {
    className: 'w-full py-3 rounded-[12px] text-[14px] font-semibold text-white transition text-center',
    style: {
      background: 'var(--skype)',
      boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.5)',
    },
  },
  'button-secondary': {
    className: 'w-full py-3 rounded-[12px] text-[14px] font-semibold text-ink-700 transition text-center',
    style: { background: 'var(--cloud)', border: '1px solid var(--ink-100)' },
  },
  text: {
    className: 'text-[12px] text-ink-400 hover:text-ink-700 transition font-display italic underline-offset-2 hover:underline',
    style: undefined,
  },
}

export function GetDesktopAppLink({ variant, label, gateBypass = true, className, style }: Props) {
  const t = useT()
  const text = label ?? detectLabel(t)
  const href = gateBypass ? DOWNLOAD_URL_BYPASS : DOWNLOAD_URL_GATED
  const defaults = VARIANT_DEFAULTS[variant]
  // Overrides REPLACE defaults rather than merging — passing a className
  // means "I want a completely different look for this surface". Pass
  // `style={{}}` to opt out of the variant's default style block
  // without supplying replacement style rules.
  return (
    <a
      href={href}
      className={className ?? defaults.className}
      style={style ?? defaults.style}
    >{text}</a>
  )
}
