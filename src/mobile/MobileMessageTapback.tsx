/**
 * iOS Messages "Tapback"-style context menu for a chat message.
 *
 * Long-pressing a bubble on mobile pops this up:
 *
 *   ┌─────────────────────────────────┐
 *   │  👍  ❤️  😂  ‼️  ❓  ➕         │  ← reaction strip
 *   ├─────────────────────────────────┤
 *   │  Reply                          │  ← action rows
 *   │  Copy text                      │
 *   │  Delete                         │
 *   └─────────────────────────────────┘
 *
 * Anchors to the touch coords. The menu balloon spring-grows out
 * of that point (transformOrigin = anchor), matches iOS Messages'
 * tapback presentation. Behind the menu: full-screen dim + heavy
 * blur so the message stays visible but the rest of the UI dims out.
 *
 * Why a dedicated component instead of reusing MobileContextMenu:
 * the reaction strip wants its own layout / animation (each emoji
 * pops in staggered, like iOS Messages does), and the action rows
 * below want to be visually grouped with it. Mashing a horizontal
 * pill into MobileContextMenu's vertical-list shape would have made
 * both components worse.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { TwEmoji } from '@/components/TwEmoji'
import { tapHaptic } from '@/lib/native'
import { cn } from '@/lib/utils'

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏']

export interface TapbackAction {
  label: string
  destructive?: boolean
  onClick: () => void
}

export interface MobileMessageTapbackProps {
  open: boolean
  anchor: { x: number; y: number } | null
  /** Reactions the user already has on this message (just the
   *  emoji strings) — they get highlighted in the strip so the user
   *  knows tapping again removes their reaction. */
  myReactions?: string[]
  onReact: (emoji: string) => void
  actions: TapbackAction[]
  onClose: () => void
}

const MENU_WIDTH = 256
const MARGIN = 12
const GAP = 14

export function MobileMessageTapback({
  open, anchor, myReactions = [], onReact, actions, onClose,
}: MobileMessageTapbackProps) {
  const [vp, setVp] = useState({ w: 390, h: 800 })
  useEffect(() => {
    const update = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const placement = useMemo(() => {
    if (!anchor) return null
    const reactionStripHeight = 56
    const actionRowHeight = 44
    const estimatedHeight = reactionStripHeight + (actions.length * actionRowHeight) + 8
    const flipUp = anchor.y + GAP + estimatedHeight > vp.h - MARGIN
    let left = anchor.x - MENU_WIDTH / 2
    if (left < MARGIN) left = MARGIN
    if (left + MENU_WIDTH > vp.w - MARGIN) left = vp.w - MARGIN - MENU_WIDTH
    const top = flipUp ? anchor.y - GAP - estimatedHeight : anchor.y + GAP
    const originX = ((anchor.x - left) / MENU_WIDTH) * 100
    const originY = flipUp ? 100 : 0
    return { left, top, originX, originY }
  }, [anchor, actions.length, vp])

  return (
    <AnimatePresence>
      {open && anchor && placement && (
        <motion.div
          key="tapback-menu"
          className="fixed inset-0 z-50"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {/* Backdrop — heavier than the dropdown menu's because
              the tapback presentation is "this message is in
              focus", not "show me a quick list". */}
          <div
            className="absolute inset-0"
            style={{
              background: 'rgba(10, 30, 60, 0.32)',
              backdropFilter: 'blur(12px) saturate(160%)',
              WebkitBackdropFilter: 'blur(12px) saturate(160%)',
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
              borderRadius: 16,
              background: 'rgba(252, 253, 254, 0.94)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              boxShadow: '0 22px 44px -12px rgba(10, 30, 60, 0.34), 0 8px 16px -6px rgba(10, 30, 60, 0.20)',
              border: '1px solid rgba(255, 255, 255, 0.5)',
            }}
            initial={{ scale: 0.82, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 440, damping: 32, mass: 0.7 }}
          >
            {/* Reaction strip — staggered emoji pop-in, iOS Messages
                tapback style. Each emoji is a 38px tap-target with
                a subtle background fill when the user already has
                it on this message. */}
            <div className="flex items-center justify-between gap-1 px-2.5 py-2.5 border-b border-ink-100">
              {QUICK_REACTIONS.map((e, i) => {
                const isMine = myReactions.includes(e)
                return (
                  <motion.button
                    key={e}
                    type="button"
                    onClick={() => {
                      void tapHaptic()
                      onReact(e)
                      onClose()
                    }}
                    className={cn(
                      'w-9 h-9 rounded-full grid place-items-center text-[22px] leading-none transition-colors',
                      isMine ? 'bg-skype/15' : 'bg-transparent',
                    )}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{
                      type: 'spring',
                      stiffness: 500,
                      damping: 22,
                      mass: 0.6,
                      delay: 0.04 + i * 0.025,
                    }}
                    whileTap={{ scale: 1.25 }}
                  >
                    <TwEmoji emoji={e} size={22} />
                  </motion.button>
                )
              })}
            </div>
            <div role="menu">
              {actions.map((a, i) => (
                <button
                  type="button"
                  key={i}
                  role="menuitem"
                  onClick={() => {
                    void tapHaptic()
                    a.onClick()
                    onClose()
                  }}
                  className={cn(
                    'w-full text-left px-4 py-3 text-[14.5px]',
                    'active:bg-ink-100/60',
                    i < actions.length - 1 && 'border-b border-ink-100',
                    a.destructive ? 'text-coral-deep font-medium' : 'text-ink-900',
                  )}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
