/**
 * iOS Mail-style swipe-to-action row.
 *
 * The child row drags horizontally; action buttons sit behind, revealed
 * as the user drags left. Behavioral model copied from UIKit's
 * UITableViewRowAction:
 *
 *   - drag left within constraints (right edge anchored at 0, left
 *     edge at `-REVEAL_WIDTH × actions.length`)
 *   - release past 40% of full reveal → snap to fully-open
 *   - release before threshold → spring back to closed
 *   - tap any visible action → fire its handler, then close
 *   - tap on the row body while open → just close (UIKit convention)
 *   - tick haptic when crossing the open / close threshold during drag
 *
 * Coexistence: framer-motion's drag uses pointer events. The child
 * can keep using touch / onClick handlers — drag wins when motion
 * exceeds ~3px before release, click wins on a still tap.
 */
import { animate, motion, useMotionValue } from 'framer-motion'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { selectionHaptic, tapHaptic } from '@/lib/native'

const ACTION_WIDTH = 84
const COMMIT_FRACTION = 0.4

export interface SwipeAction {
  /** Short label shown under the icon — keep to 4-6 chars
   *  ("Pin", "Mute", "Read", "Leave"). */
  label: string
  /** Optional icon node (16-22px). Defaults to no icon. */
  icon?: ReactNode
  /** Background color for the action tile. Use coral for
   *  destructive, gold for "Pin", blue for "Read", etc. */
  background?: string
  /** Text / icon color. Defaults to white. */
  color?: string
  onClick: () => void
}

export interface SwipeableRowProps {
  actions: SwipeAction[]
  children: ReactNode
  /** Mirror class on the underlying wrapper if you need to tweak the
   *  rest-state container styling. */
  className?: string
}

export function SwipeableRow({ actions, children, className }: SwipeableRowProps) {
  const x = useMotionValue(0)
  const open = useRef(false)
  const lastTickedOpen = useRef(false)
  const [revealed, setRevealed] = useState(false)
  const fullReveal = -ACTION_WIDTH * actions.length

  // Spring back to closed whenever the action list changes (e.g. an
  // action was tapped and the parent reconciled).
  useEffect(() => {
    return () => {
      open.current = false
    }
  }, [])

  const snapClosed = () => {
    open.current = false
    setRevealed(false)
    animate(x, 0, { type: 'spring', stiffness: 380, damping: 36, mass: 0.8 })
  }

  const snapOpen = () => {
    open.current = true
    setRevealed(true)
    animate(x, fullReveal, { type: 'spring', stiffness: 380, damping: 36, mass: 0.8 })
  }

  return (
    <div className={`relative ${className ?? ''}`}>
      {/* Action tiles — rendered first so they're underneath; the
          row drags over them. They sit flush to the right edge of
          the container and consume the area uncovered as the row
          slides left. */}
      <div
        className="absolute inset-y-0 right-0 flex"
        style={{ width: -fullReveal }}
        aria-hidden={!revealed}
      >
        {actions.map((a, i) => {
          const tileStyle: CSSProperties = {
            width: ACTION_WIDTH,
            background: a.background ?? 'var(--ink-200)',
            color: a.color ?? '#FFFFFF',
          }
          return (
            <button
              type="button"
              key={i}
              tabIndex={revealed ? 0 : -1}
              onClick={() => {
                void tapHaptic()
                a.onClick()
                snapClosed()
              }}
              className="flex flex-col items-center justify-center gap-1 text-[12px] font-semibold active:brightness-90"
              style={tileStyle}
            >
              {a.icon && <span className="opacity-90">{a.icon}</span>}
              <span>{a.label}</span>
            </button>
          )
        })}
      </div>

      {/* The draggable foreground — the row content. `style.x` is
          the same MV we animate on snap, so spring snaps are
          continuous with the user's drag. */}
      <motion.div
        drag="x"
        // Right edge clamped at 0 (no swiping past closed); left edge
        // clamped at `fullReveal` (no overshoot past the action set).
        dragConstraints={{ left: fullReveal, right: 0 }}
        dragElastic={0.06}
        dragMomentum={false}
        style={{ x }}
        onDrag={(_, info) => {
          // Tick haptic the moment the drag crosses the commit
          // threshold in either direction — same feel as iOS Mail's
          // bzzt when a swipe-action becomes "armed".
          const past = info.offset.x < fullReveal * COMMIT_FRACTION
          if (past !== lastTickedOpen.current) {
            lastTickedOpen.current = past
            void selectionHaptic()
          }
        }}
        onDragEnd={(_, info) => {
          if (info.offset.x < fullReveal * COMMIT_FRACTION) snapOpen()
          else snapClosed()
        }}
        className="relative bg-paper"
      >
        {children}
        {/* Tap-shield: when the row is revealed, this overlay
            absorbs taps/touches so they close the row instead of
            triggering the child's onTap (which would, e.g., open
            the conversation). pointer-events disabled when closed
            so normal interactions pass through. */}
        {revealed && (
          <div
            className="absolute inset-0"
            style={{ touchAction: 'manipulation' }}
            onPointerDownCapture={(e) => {
              e.stopPropagation()
              snapClosed()
            }}
          />
        )}
      </motion.div>
    </div>
  )
}
