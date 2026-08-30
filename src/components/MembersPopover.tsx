/**
 * Floating popover that lists every member of a conversation. Anchored to a
 * trigger element via DOMRect; closes on outside click / Esc. Click any row
 * to pin that person's profile in the InfoPane.
 */
import { useEffect, useRef, type RefObject } from 'react'
import { Avatar } from './Avatar'
import { HumanBadge } from './HumanBadge'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useT } from '@/lib/i18n'
import type { Participant } from '@/types'

const STATUS_LABEL: Record<string, string> = {
  avail: 'Available', working: 'Working', thinking: 'Thinking', waiting: 'Waiting on you', resting: 'Resting',
}
const STATUS_COLOR: Record<string, string> = {
  avail: 'var(--avail)', working: 'var(--working)', thinking: 'var(--thinking)', waiting: 'var(--waiting)', resting: 'var(--resting)',
}

interface Props {
  members: Participant[]
  /** anchor rect (e.g. from getBoundingClientRect of the trigger) */
  anchor: DOMRect
  /** trigger element that should not count as an outside click */
  triggerRef?: RefObject<HTMLElement>
  onClose: () => void
}

export function MembersPopover({ members, anchor, triggerRef, onClose }: Props) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const openInfo = useApp((s) => s.openAgentInfo)
  const meId = useMe()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef?.current?.contains(target)) return
      if (!ref.current) return
      if (!ref.current.contains(target)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose, triggerRef])

  // Position: just below the anchor, right-edge aligned with the anchor.
  // Clamped to viewport in a layout effect.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = anchor.right - r.width
    let top = anchor.bottom + 6
    if (left < 8) left = 8
    if (left + r.width > vw - 8) left = vw - r.width - 8
    if (top + r.height > vh - 8) top = anchor.top - r.height - 6  // flip above
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchor])

  const sorted = [...members].sort((a, b) => {
    // Humans on top, then agents alphabetical.
    if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('members.ariaLabel')}
      className="fixed z-[60] w-[280px] py-1 rounded-[12px] bg-cloud animate-rise"
      style={{
        left: anchor.right - 280,
        top: anchor.bottom + 6,
        boxShadow: '0 12px 32px -10px rgba(10, 30, 60, 0.22), 0 6px 14px -6px rgba(10, 30, 60, 0.14), 0 0 0 1px rgba(0, 80, 140, 0.08)',
      }}
    >
      <div className="px-3 pt-2 pb-1.5 text-[10.5px] font-bold tracking-[0.12em] uppercase text-ink-300">
        {members.length === 1 ? t('members.countOne', { n: members.length }) : t('members.countOther', { n: members.length })}
      </div>
      <div className="max-h-[400px] overflow-y-auto py-0.5">
        {sorted.map((p) => {
          const isYou = p.id === meId
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                if (!isYou) openInfo(p.id)
                onClose()
              }}
              disabled={isYou}
              className="w-full text-left flex items-center gap-2.5 py-2 px-3 transition hover:bg-sky2-50 disabled:cursor-default disabled:hover:bg-transparent"
            >
              <Avatar p={p} size={32} ringColor="var(--cloud)" showStatus={false} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold text-ink-900 truncate">{p.name}</span>
                  {isYou && <span className="text-[9.5px] font-bold py-px px-1.5 rounded uppercase tracking-wider bg-sky2-100 text-skype-deep">{t('members.youBadge')}</span>}
                  {!isYou && p.kind === 'human' && <HumanBadge />}
                </div>
                <div className="text-[11.5px] text-ink-500 truncate flex items-center gap-1.5">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full"
                    style={{ background: STATUS_COLOR[p.status] ?? 'var(--resting)' }}
                  />
                  {STATUS_LABEL[p.status] ?? 'idle'}
                  {p.role && <><span className="text-ink-300">·</span><em className="not-italic font-display italic">{p.role}</em></>}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
