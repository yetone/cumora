/**
 * A small, refined "scroll to latest message" pill that appears in the
 * bottom-right of the chat stream once the user has scrolled up off the
 * bottom. Both ChatPane (desktop) and MobileChat use this — the host owns
 * the at-bottom signal (via Virtuoso's `atBottomStateChange`) and the
 * scroll action; this component is presentation-only.
 *
 * Design notes:
 * - Pill, not a hard circle — reads as a "jump back to where new things
 *   land", not a generic FAB. ~36px tall, ~36px wide for the icon-only
 *   variant; the layout naturally grows if we ever surface an unread count.
 * - Paper-toned palette (sky/ink) + a soft brand-blue glow. Border + shadow
 *   are tuned so the pill reads as floating without an aggressive drop.
 * - Entrance: fade + small lift via `animate-rise` (same utility the rest of
 *   the app uses for transient overlays). When toggled off we unmount, so
 *   the next appearance always replays the entrance — no stale "ghost".
 * - aria: a real button with a descriptive label, focus ring matches the
 *   app's `outline-sky2-300` convention.
 */
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface Props {
  visible: boolean
  onClick: () => void
  /** Optional override of the pill's vertical inset from the bottom of its
   *  positioned ancestor — mobile uses a larger value to clear the composer
   *  + safe-area; desktop's default sits just above the composer line. */
  bottomOffset?: number
}

export function ScrollToLatestButton({ visible, onClick, bottomOffset = 16 }: Props) {
  const t = useT()
  if (!visible) return null
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('scroll.scrollToLatest')}
      title={t('scroll.latestTitle')}
      className={cn(
        // Positioning: absolute within the chat stream's relative container.
        'absolute right-4 z-20 grid place-items-center',
        // Shape + size — pill, 36×36 default, comfortable touch target.
        'h-9 w-9 rounded-full',
        // Surface — paper-toned with a calm sky tint so the pill reads as
        // "tied to the conversation surface", not a generic floating UI bit.
        'bg-cloud/95 backdrop-blur-md text-skype-deep',
        // Border + shadow tune for "lifted off the page" without harshness.
        'border border-sky2-100 shadow-[0_10px_24px_-12px_rgba(0,80,140,0.35)]',
        // Interaction — quick fade, gentle scale on press for tactile feel.
        'transition-all duration-150 hover:bg-cloud hover:border-sky2-200 hover:shadow-[0_14px_30px_-12px_rgba(0,80,140,0.4)]',
        'active:scale-[0.96]',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky2-300 focus-visible:outline-offset-2',
        // Entrance animation matches other transient overlays.
        'animate-rise',
      )}
      style={{ bottom: bottomOffset }}
    >
      <ChevronDown />
    </button>
  )
}

/** Minimal chevron-down — tuned weight (1.75 stroke) so it reads at 18px
 *  without looking either spindly or chunky. Lives inline because this is
 *  the only place we draw it. */
function ChevronDown() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
