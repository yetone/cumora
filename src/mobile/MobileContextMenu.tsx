/**
 * iOS-style long-press context menu.
 *
 * Replaces the older "bottom sheet" pattern for long-press actions:
 * the menu now pops up adjacent to the user's finger, exactly like
 * iOS Messages / Mail / Photos. Visual model:
 *
 *   - Full-screen dim + backdrop blur fades in (200ms).
 *   - The menu balloon springs from 0.85 → 1 scale at the anchor
 *     point, with `transformOrigin` set so it appears to grow OUT
 *     of the finger.
 *   - Items render as a tight vertical list with hairline dividers
 *     and right-aligned SF-Symbol-style icons; destructive items
 *     use the coral palette and a slightly different background.
 *   - Tapping outside the menu (anywhere on the dim) dismisses.
 *   - The menu auto-flips up if it would overflow the bottom of
 *     the screen, and clamps horizontally to stay inside the
 *     viewport with an 8px margin.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { tapHaptic } from '@/lib/native'
import { cn } from '@/lib/utils'

export interface ContextMenuItem {
  label: string
  /** Optional trailing icon — rendered at 16px on the right. */
  icon?: React.ReactNode
  /** Renders the row in the destructive (red) style. */
  destructive?: boolean
  /** Disabled rows render at half opacity and ignore presses. */
  disabled?: boolean
  onClick: () => void
}

export interface MobileContextMenuProps {
  /** Open state. When false the component renders nothing. */
  open: boolean
  /** Anchor point in viewport coords — usually the long-press touch
   *  location captured by `useLongPress`. */
  anchor: { x: number; y: number } | null
  items: ContextMenuItem[]
  /** Optional caption — appears above the menu items as a header
   *  row (think: the conversation title in iOS Messages' menu). */
  caption?: React.ReactNode
  onClose: () => void
}

const MENU_WIDTH = 240
const MARGIN = 8
const GAP = 14

export function MobileContextMenu({ open, anchor, items, caption, onClose }: MobileContextMenuProps) {
  const [vp, setVp] = useState({ w: 390, h: 800 })

  useEffect(() => {
    const update = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Position the menu adjacent to the anchor. Default below-right;
  // flip above if it'd overflow the bottom; clamp left/right within
  // the viewport with an 8px breathing margin so the menu is never
  // clipped by the screen edge.
  const placement = useMemo(() => {
    if (!anchor) return null
    const headerHeight = caption ? 36 : 0
    const itemRowHeight = 44
    const estimatedHeight = headerHeight + items.length * itemRowHeight + 16
    const flipUp = anchor.y + GAP + estimatedHeight > vp.h - MARGIN
    let left = anchor.x - MENU_WIDTH / 2
    if (left < MARGIN) left = MARGIN
    if (left + MENU_WIDTH > vp.w - MARGIN) left = vp.w - MARGIN - MENU_WIDTH
    const top = flipUp ? anchor.y - GAP - estimatedHeight : anchor.y + GAP
    // Transform origin = the anchor's position relative to the menu
    // box, so the spring growth appears to emanate from the finger.
    const originX = ((anchor.x - left) / MENU_WIDTH) * 100
    const originY = flipUp ? 100 : 0
    return { left, top, originX, originY }
  }, [anchor, caption, items.length, vp])

  return (
    <AnimatePresence>
      {open && anchor && placement && (
        <motion.div
          key="ctx-menu"
          className="fixed inset-0 z-50"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* Backdrop — dim + iOS-style heavy blur. Keep the dim
              light (0.18) so the user can still see the row /
              message they long-pressed; the blur does the heavy
              lifting of separating menu from content. */}
          <div
            className="absolute inset-0"
            style={{
              background: 'rgba(10, 30, 60, 0.18)',
              backdropFilter: 'blur(8px) saturate(140%)',
              WebkitBackdropFilter: 'blur(8px) saturate(140%)',
            }}
          />
          <motion.div
            onClick={(e) => e.stopPropagation()}
            className="absolute overflow-hidden"
            style={{
              left: placement.left,
              top: placement.top,
              width: MENU_WIDTH,
              transformOrigin: `${placement.originX}% ${placement.originY}%`,
              borderRadius: 14,
              background: 'rgba(252, 253, 254, 0.92)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              boxShadow:
                '0 20px 40px -10px rgba(10, 30, 60, 0.30), 0 6px 14px -4px rgba(10, 30, 60, 0.18)',
              border: '1px solid rgba(255, 255, 255, 0.6)',
            }}
            initial={{ scale: 0.82, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 440, damping: 32, mass: 0.7 }}
          >
            {caption && (
              <div className="px-3.5 py-2 text-[11px] font-bold uppercase tracking-[0.08em] text-ink-500 border-b border-ink-100">
                {caption}
              </div>
            )}
            <div role="menu">
              {items.map((it, i) => (
                <button
                  type="button"
                  key={i}
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    if (it.disabled) return
                    void tapHaptic()
                    it.onClick()
                    onClose()
                  }}
                  className={cn(
                    'w-full flex items-center justify-between gap-3 px-3.5 py-3 text-[14.5px] text-left',
                    'active:bg-ink-100/60 disabled:opacity-40',
                    i < items.length - 1 && 'border-b border-ink-100',
                    it.destructive ? 'text-coral-deep font-medium' : 'text-ink-900',
                  )}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <span className="truncate">{it.label}</span>
                  {it.icon && <span className="shrink-0 opacity-70">{it.icon}</span>}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
