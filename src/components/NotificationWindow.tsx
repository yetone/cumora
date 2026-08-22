/**
 * Renderer for the dedicated Electron notification BrowserWindow.
 *
 * Lives in its own frameless transparent always-on-top window pinned
 * to the top-right of the primary display (see electron/main.cjs).
 * Receives toast payloads from the main app over IPC and renders them
 * stacked top-to-bottom, newest on the bottom — mirrors wails-gui's
 * toast_window_darwin.go behaviour.
 *
 * Each push gets its OWN toast card (no coalesce-by-conversation).
 * That's how yansu / wails-gui do it: multiple messages from the same
 * room appear as distinct cards stacked vertically, not as one card
 * whose body keeps swapping. Cap at MAX_TOASTS; when full, the OLDEST
 * (topmost) toast is dropped so the latest message is always visible.
 *
 * Click → IPC tells main to bring the app forward + select the convo.
 * Auto-dismiss after AUTO_DISMISS_MS; hover pauses the timer.
 */
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import { AnimatePresence, motion } from 'framer-motion'
import type { NotificationPushPayload } from '@/lib/runtime'

// Match wails-gui's tight slide-and-fade (toast_window_assets/toast.html
// — `transition: opacity 180ms ease-out, transform 180ms ease-out` +
// `transform: translateX(12px)` initial). Calm, decisive, no spring
// overshoot — stacks read as a quiet feed instead of bouncy popcorn.
const ENTRY_TRANSITION = { duration: 0.18, ease: [0.2, 0, 0, 1] as const }
// Exits mirror wails-gui's 160ms `transition: opacity 160ms ease-in,
// transform 160ms ease-in` — a touch faster than entry, feels confident.
const EXIT_TRANSITION = { duration: 0.16, ease: [0.4, 0, 1, 1] as const }
// Layout transitions (the slide-up when a higher toast dismisses and
// the cards below close the gap). Slightly slower than entry so the
// motion reads as "settling", not racing.
const LAYOUT_TRANSITION = { duration: 0.22, ease: [0.2, 0, 0, 1] as const }
// Hold the BrowserWindow destroy slightly longer than the exit
// duration so the fade-out finishes before the window vanishes.
const EXIT_HOLD_MS = 220

const AUTO_DISMISS_MS = 12_000
const MAX_TOASTS = 5

type Toast = NotificationPushPayload

export function NotificationWindow() {
  const [toasts, setToasts] = useState<Toast[]>([])

  // The Electron BrowserWindow is `transparent: true`, but that only
  // matters if the html/body/root chain is also transparent. The shared
  // global stylesheet paints `body` opaque (paper color) which would
  // light up the entire 360x480 frame as a white rectangle whenever the
  // window is shown. Force the whole DOM background to transparent for
  // just this renderer.
  useEffect(() => {
    const prev: Array<[HTMLElement, string]> = []
    for (const el of [document.documentElement, document.body, document.getElementById('root')!]) {
      prev.push([el, el.style.background])
      el.style.background = 'transparent'
    }
    return () => { for (const [el, b] of prev) el.style.background = b }
  }, [])

  // Subscribe to pushes from main, then signal that we're ready so any
  // pushes that arrived during the create→load→mount window get
  // flushed. Window stays HIDDEN until we then signal `painted` after
  // the first toast actually renders — without that gate, main would
  // showInactive() while the React tree still has zero toasts, and
  // users would see a brief flash of the empty 360-wide rectangle in
  // the screen corner before the toast painted.
  useEffect(() => {
    const bridge = window.cumora?.notify
    if (!bridge) return
    const offPush = bridge.onPush((p) => {
      // No chime here — moved to the 0→1 transition effect below so
      // the bell fires INSIDE the same requestAnimationFrame that
      // signals `painted`. Audio + visible toast land in the same
      // frame; firing chime on data arrival made it precede the paint.
      // No coalesce — every push becomes its own toast, even if it shares
      // a conversationId with a still-visible one. Merging-by-convo was
      // making rapid messages from the same room look like "the previous
      // toast got replaced in place" rather than a real stack.
      // wails-gui's toast_window_darwin.go takes the same per-push
      // approach (`toastState.visible = append(toastState.visible, inst)`).
      setToasts((prev) => {
        // Dedupe by underlying messageId. Defensive against the WS bus
        // (or a duplicated subscriber) delivering the same message.new
        // twice — you'd otherwise see three identical Bram cards stacked.
        // toast.id includes a timestamp so React keys stay unique, but
        // messageId is the real identity.
        if (p.messageId && prev.some((t) => t.messageId === p.messageId)) {
          return prev
        }
        // Append at the BOTTOM. Older toasts stay anchored at the top;
        // new arrivals slide in below. When MAX is reached we drop the
        // OLDEST (top) so the latest message is always visible.
        const merged: Toast[] = [...prev, p]
        return merged.length > MAX_TOASTS ? merged.slice(merged.length - MAX_TOASTS) : merged
      })
    })
    bridge.ready()
    return offPush
  }, [])

  // Tell main process to flip the BrowserWindow between click-receiving
  // (toast visible) and "destroy me" (no toasts). Only fires on actual
  // transitions — never on the initial mount with an empty toast array,
  // because at mount time main is in the middle of waiting for our
  // `ready()` to flush a just-queued push. A `setInteractive(false)`
  // here would race the flush and destroy the window before its first
  // toast renders.
  //
  // Also signals `painted` on the 0→1 transition — after a frame, so
  // the toast is visible by the time main shows the window. This is
  // what prevents the "empty white rectangle flashes briefly before
  // the toast appears" bug.
  const prevToastCount = useRef(0)
  const stackRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const next = toasts.length
    const prev = prevToastCount.current
    prevToastCount.current = next
    if (prev === 0 && next > 0) {
      window.cumora?.notify?.setInteractive(true)
      // Two RAFs: first frame React commits the new toast to the DOM
      // and layout runs; on the second frame `stackRef` has its real
      // height. We send setHeight FIRST so main resizes the still-
      // hidden window to fit, THEN painted so main shows it at the
      // correct size. Sending in the opposite order made the panel
      // briefly appear at the 120px initial height before resizing,
      // which the user perceived as a tall white rectangle flash.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const h = stackRef.current?.getBoundingClientRect().height ?? 0
          if (h > 0) window.cumora?.notify?.setHeight(Math.ceil(h) + 12)
          window.cumora?.notify?.painted()
        })
      })
    } else if (prev > 0 && next === 0) {
      // Hold the destroy until AnimatePresence finishes its exit
      // animation. Without this delay, main destroys the window
      // mid-animation and the toast appears to vanish abruptly.
      const t = setTimeout(() => { window.cumora?.notify?.setInteractive(false) }, EXIT_HOLD_MS)
      return () => clearTimeout(t)
    } else if (next > prev) {
      // New (non-coalesced) toast added while panel is already visible.
      // Fire painted again so main relays a chime IPC for this toast
      // too. No setInteractive — panel is already accepting clicks.
      requestAnimationFrame(() => window.cumora?.notify?.painted())
    }
  }, [toasts.length])

  const dismiss = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id))
  const onClick = (t: Toast) => {
    window.cumora?.notify?.focusConvo(t.conversationId)
    dismiss(t.id)
  }

  // ResizeObserver handles ONGOING height changes (dismiss / new toast
  // added). The initial fit-to-content sizing is done in the 0→1
  // transition above (two-rAF) so the first paint of the window is
  // already at the right height, not the 120px initial guess.
  useEffect(() => {
    const el = stackRef.current
    if (!el) return
    const send = () => {
      const h = el.getBoundingClientRect().height
      if (h > 0) window.cumora?.notify?.setHeight(Math.ceil(h) + 12 /* breathing room */)
    }
    const ro = new ResizeObserver(send)
    ro.observe(el)
    send()
    return () => ro.disconnect()
  }, [toasts.length])

  return (
    <div
      // Transparent body — the BrowserWindow is `transparent: true` (see
      // main.cjs), and we want only the toast cards to paint. Anything
      // here that draws a fill would show up as a panel-shaped backdrop.
      ref={stackRef}
      className="fixed inset-x-0 top-0 flex flex-col gap-2 pt-2 pr-2 items-end pointer-events-none"
      style={{ background: 'transparent' }}
    >
      {/* `popLayout` keeps surviving toasts smoothly re-flowing into the
          gap when one above them dismisses, instead of snapping. */}
      <AnimatePresence initial={false} mode="popLayout">
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            // wails-gui's entry: slide 12px from the right + fade in.
            // No scale, no spring — just a clean translate + opacity.
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            // Exit slides slightly further (16px) than the entry's 12px
            // so dismissal reads as a deliberate sweep-off, not a
            // mirrored reverse-of-entry.
            exit={{ opacity: 0, x: 16, transition: EXIT_TRANSITION }}
            transition={{
              opacity: ENTRY_TRANSITION,
              x: ENTRY_TRANSITION,
              // `layout` animates `y` as siblings reflow when a toast
              // above dismisses. Slightly slower so the slide-up feels
              // like settling, not racing the entry of a new toast.
              layout: LAYOUT_TRANSITION,
            }}
            // GPU-only properties (transform + opacity) so the animation
            // runs on the compositor thread — buttery even when the
            // renderer's main thread is busy.
            style={{ willChange: 'transform, opacity' }}
            className="pointer-events-auto"
          >
            <ToastCard
              toast={t}
              onClick={() => onClick(t)}
              onDismiss={() => dismiss(t.id)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/**
 * Avatar that mirrors the conversation-list look: portrait when we have
 * one, otherwise the agent's stable color block with their initial. The
 * notification BrowserWindow is a separate renderer (different page from
 * the main app's React tree), so it can't reach into the participants
 * store directly — the main app passes `authorInitial` + `authorAvatarBg`
 * with every push so this fallback is consistent with the convo list.
 */
function AuthorAvatar({ toast }: { toast: Toast }) {
  const [imgBroke, setImgBroke] = useState(false)
  // Reset on every URL change so a fresh toast (possibly reusing this
  // component slot) gets a clean shot at <img>. Without this, a single
  // load failure would stick imgBroke=true across subsequent toasts.
  useEffect(() => { setImgBroke(false) }, [toast.authorAvatarUrl])
  const hasImg = !!toast.authorAvatarUrl && !imgBroke
  const initial = (toast.authorInitial ?? toast.authorName.charAt(0) ?? '?').toUpperCase()
  return (
    <div
      className="w-8 h-8 rounded-full shrink-0 grid place-items-center font-display font-medium text-white text-[13px] overflow-hidden relative"
      style={{
        background: hasImg ? 'transparent' : (toast.authorAvatarBg ?? 'var(--ink-300)'),
        letterSpacing: '-0.02em',
      }}
    >
      {hasImg ? (
        <img
          src={toast.authorAvatarUrl!}
          alt={toast.authorName}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => setImgBroke(true)}
        />
      ) : (
        <span>{initial}</span>
      )}
    </div>
  )
}

function ToastCard({ toast, onClick, onDismiss }: { toast: Toast; onClick: () => void; onDismiss: () => void }) {
  const t = useT()
  const [hovered, setHovered] = useState(false)
  useEffect(() => {
    if (hovered) return
    const elapsed = Date.now() - toast.at
    const remaining = Math.max(800, AUTO_DISMISS_MS - elapsed)
    const id = window.setTimeout(onDismiss, remaining)
    return () => window.clearTimeout(id)
  }, [hovered, toast.at, onDismiss])

  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="text-left"
      style={{
        // Solid opaque card on a transparent BrowserWindow. Mirrors
        // wails-gui (toast_window_assets/toast.html — `--panel: #ffffff`
        // + `border: 1px solid rgba(33, 28, 22, 0.12)`, no box-shadow).
        //
        // We can't give each toast its own NSWindow inside Electron, so
        // when toasts stack inside ONE window their CSS drop shadows
        // bleed into each other and look like a single big frosted
        // rectangle. wails-gui's answer is "no toast-level shadow at all"
        // — separation comes from the 1px hairline border + spacing. We
        // do the same; just a tiny low-spread shadow for lift, nothing
        // that extends past the card more than a few pixels.
        background: '#ffffff',
        borderRadius: 14,
        padding: '14px 16px',
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)',
        border: '1px solid rgba(33, 28, 22, 0.12)',
        cursor: 'pointer',
        minWidth: 280,
        maxWidth: 340,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Close (×) — appears on hover. stopPropagation so the click
          dismisses without also triggering the toast's main onClick
          (which would focus the convo + dismiss). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
        aria-label={t('notif.dismissAria')}
        className="absolute grid place-items-center rounded-full text-ink-500 hover:bg-ink-100 hover:text-ink-900 transition"
        style={{
          top: 6, right: 6,
          width: 20, height: 20,
          opacity: hovered ? 1 : 0,
          // Slight delay so the close button doesn't snap in on
          // single-pixel mouse jitters across the toast edge.
          transitionProperty: 'opacity, background-color, color',
          transitionDuration: '120ms',
          fontSize: 14, lineHeight: 1, fontWeight: 600,
        }}
      >×</button>
      <div className="flex items-start gap-2.5 pr-5">
        <AuthorAvatar toast={toast} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-ink-900 truncate">
              {toast.authorName}
            </span>
            <span className="text-[10.5px] text-ink-300 italic font-display truncate">
              {toast.conversationTitle}
            </span>
            {toast.unreadCount !== undefined && toast.unreadCount > 1 && (
              <span
                // Matches the canonical unread chip in the conversation list
                // (ConversationsPane.tsx:289-300) — solid coral + white digit,
                // tabular nums, fixed 18px circle. Earlier soft-coral variant
                // looked like a foreign dialect of the same color family.
                className="ml-auto inline-grid place-items-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold shrink-0 tabular-nums"
                style={{ background: 'var(--coral)', color: 'white' }}
                title={`${toast.unreadCount} unread in this conversation`}
              >{toast.unreadCount}</span>
            )}
          </div>
          <div
            className="text-[12.5px] text-ink-700 mt-0.5 leading-[1.4]"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {toast.body}
          </div>
        </div>
      </div>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0, right: 0, bottom: 0,
          height: 2,
          background: 'linear-gradient(90deg, var(--skype), var(--sky-glow))',
          transformOrigin: 'left center',
          animation: hovered ? 'none' : `cumora-toast-drain ${AUTO_DISMISS_MS}ms linear forwards`,
        }}
      />
    </div>
  )
}
