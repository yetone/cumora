/**
 * useLongPress — touch-driven long-press detector for mobile rows.
 *
 * Returns the props you spread on the target element. The detector
 * fires `onLongPress(coords)` after 450ms of held touch with no
 * significant movement, passing the original touch position so a
 * context menu can anchor to it. A move past the 10px tap tolerance
 * cancels BOTH the long-press timer and the deferred `onTap` — that
 * way scrolling through a list of pressable rows can't accidentally
 * fire either gesture.
 *
 * Right-click on desktop is treated as a synthetic long-press (the
 * Vite dev server doesn't have a finger), so the same context menu
 * is reachable during development.
 */
import { useRef } from 'react'
import { mediumHaptic, tapHaptic } from '@/lib/native'

export interface LongPressCoords {
  x: number
  y: number
}

export function useLongPress(
  onLongPress: (coords: LongPressCoords) => void,
  onTap?: () => void,
) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<LongPressCoords | null>(null)
  const triggeredRef = useRef(false)
  const movedRef = useRef(false)

  const clear = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      const coords = { x: t.clientX, y: t.clientY }
      startRef.current = coords
      triggeredRef.current = false
      movedRef.current = false
      clear()
      timerRef.current = window.setTimeout(() => {
        triggeredRef.current = true
        void mediumHaptic()
        onLongPress(coords)
      }, 450)
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0]
      if (!t || !startRef.current) return
      const dx = Math.abs(t.clientX - startRef.current.x)
      const dy = Math.abs(t.clientY - startRef.current.y)
      if (dx > 10 || dy > 10) {
        clear()
        movedRef.current = true
      }
    },
    onTouchEnd: () => {
      clear()
      if (!triggeredRef.current && !movedRef.current && onTap) {
        // Fire haptic on touchEnd — that's the moment we actually
        // commit to firing onTap, so the bzzt is synced to user
        // intent rather than to a touchdown that might have been a
        // scroll attempt.
        void tapHaptic()
        onTap()
      }
    },
    onTouchCancel: () => { clear(); movedRef.current = false },
    ...(onTap ? {
      onClick: (e: React.MouseEvent) => {
        e.preventDefault()
        const nativeEvent = e.nativeEvent as MouseEvent & {
          pointerType?: string
          sourceCapabilities?: { firesTouchEvents?: boolean }
        }
        if (nativeEvent.pointerType === 'touch' || nativeEvent.sourceCapabilities?.firesTouchEvents) return
        onTap()
      },
    } : {}),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      onLongPress({ x: e.clientX, y: e.clientY })
    },
  }
}
