/**
 * Floating context menu — opens at click coordinates, dismisses on outside
 * click / Esc / item activation. Items can be marked `destructive` for the
 * coral-red treatment.
 *
 * Submenus: pass `submenu: ContextMenuItem[]` on an item. Hovering the row
 * flies a nested ContextMenu in to its right (or left if clipped). Hovering
 * a sibling row WITHOUT a submenu keeps the current child open so the user
 * can travel right to it without the panel slamming shut mid-trajectory.
 * The whole stack closes on outside click / Esc / leaf activation.
 */
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface ContextMenuItem {
  label: string
  /** Called when the leaf item is activated. Skipped (and ignored) for items
   *  whose only purpose is to open a submenu. */
  onSelect?: () => void
  icon?: React.ReactNode
  destructive?: boolean
  hint?: string
  disabled?: boolean
  /** When set, the item becomes a submenu opener — hovering it reveals the
   *  nested items to the right (or left if there's no horizontal room). */
  submenu?: ContextMenuItem[]
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** Internal: marks a panel as a child so it skips outside-click handling
   *  (its parent owns dismissal of the whole stack). */
  _isChild?: boolean
}

export function ContextMenu({ x, y, items, onClose, _isChild }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Which row's submenu is currently rendered. Stays sticky as the user
  // moves across no-submenu siblings — only resets when they enter ANOTHER
  // submenu opener.
  const [openSubmenuIdx, setOpenSubmenuIdx] = useState<number | null>(null)
  const [submenuAnchor, setSubmenuAnchor] = useState<{ top: number; right: number; left: number } | null>(null)

  useEffect(() => {
    // Esc + outside-click dismissal lives on the ROOT panel only — children
    // skip both, so a click on a child item doesn't read as "outside the
    // parent" and slam the whole stack shut before the leaf handler runs.
    if (_isChild) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      // A click inside ANY [role=menu] (root or descendant) counts as
      // inside — `ref.current.contains` alone would treat the floating
      // submenu (rendered to document body) as outside.
      const inAnyMenu = (target as Element).closest?.('[role=menu]')
      if (!inAnyMenu) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose, _isChild])

  // Clamp to viewport so we don't open off-screen.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let nx = x, ny = y
    if (r.right > vw - 8) nx = Math.max(8, vw - r.width - 8)
    if (r.bottom > vh - 8) ny = Math.max(8, vh - r.height - 8)
    el.style.left = `${nx}px`
    el.style.top = `${ny}px`
  }, [x, y])

  const openItem = openSubmenuIdx !== null ? items[openSubmenuIdx] : null
  const submenuOpen = !!openItem?.submenu && submenuAnchor !== null

  return (
    <>
      <div
        ref={ref}
        role="menu"
        className="fixed z-[60] min-w-[200px] py-1 rounded-[10px] bg-cloud animate-rise"
        style={{
          left: x,
          top: y,
          boxShadow: '0 10px 30px -8px rgba(10, 30, 60, 0.20), 0 4px 10px -4px rgba(10, 30, 60, 0.12), 0 0 0 1px rgba(0, 80, 140, 0.08)',
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it, i) => {
          const hasSubmenu = !!it.submenu && it.submenu.length > 0
          return (
            <button
              type="button"
              key={i}
              role="menuitem"
              disabled={it.disabled}
              onMouseEnter={(e) => {
                if (hasSubmenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setOpenSubmenuIdx(i)
                  setSubmenuAnchor({ top: r.top, right: r.right, left: r.left })
                }
                // Sibling rows without their own submenu KEEP the current
                // child open so the user can travel right to it.
              }}
              onClick={() => {
                if (it.disabled) return
                // Submenu-only rows don't have their own action; the user
                // needs to pick a leaf. Don't dismiss the menu here.
                if (hasSubmenu) return
                it.onSelect?.()
                onClose()
              }}
              className={cn(
                'w-full text-left px-3 py-1.5 text-[12.5px] flex items-center gap-2 transition disabled:opacity-40 disabled:cursor-not-allowed',
                it.destructive
                  ? 'text-coral-deep hover:bg-coral-soft'
                  : 'text-ink-700 hover:bg-sky2-50 hover:text-skype-deep',
                openSubmenuIdx === i && 'bg-sky2-50 text-skype-deep',
              )}
            >
              {it.icon && <span className="w-4 h-4 inline-flex items-center justify-center">{it.icon}</span>}
              <span className="flex-1 font-medium">{it.label}</span>
              {it.hint && !hasSubmenu && <span className="text-[10.5px] text-ink-300">{it.hint}</span>}
              {hasSubmenu && (
                <>
                  {it.hint && <span className="text-[10.5px] text-ink-300">{it.hint}</span>}
                  <span className="text-ink-300 text-[11px] leading-none" aria-hidden>▸</span>
                </>
              )}
            </button>
          )
        })}
      </div>
      {submenuOpen && openItem?.submenu && submenuAnchor && (
        <SubmenuFly
          anchor={submenuAnchor}
          items={openItem.submenu}
          onClose={onClose}
        />
      )}
    </>
  )
}

/** Renders a child ContextMenu next to its hovered parent row. Placement
 *  prefers the right edge but flips to the left if there's no room. */
function SubmenuFly({
  anchor,
  items,
  onClose,
}: {
  anchor: { top: number; right: number; left: number }
  items: ContextMenuItem[]
  onClose: () => void
}) {
  // Estimate before render — clamp will snap to viewport on layout pass.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const ESTIMATED_W = 220
  const flipLeft = anchor.right + ESTIMATED_W + 8 > vw
  const x = flipLeft ? Math.max(8, anchor.left - ESTIMATED_W - 4) : anchor.right + 4
  const y = anchor.top - 6  // align the first item with the parent row
  return (
    <ContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      _isChild
    />
  )
}
