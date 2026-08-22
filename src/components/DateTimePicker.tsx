/**
 * Cumora-styled date + time picker. Drop-in replacement for the native
 * `<input type="datetime-local">` and `<input type="date">`, which look
 * ugly and inconsistent across platforms.
 *
 * Value contract: 'YYYY-MM-DDTHH:mm' (local — same shape the
 * datetime-local input uses), or '' when unset. The picker emits that
 * exact format so callers don't have to change their submit logic.
 *
 * Modes:
 *   - 'datetime' — calendar + time columns (hours 0-23, minutes at 5-min
 *     granularity). Value's HH:mm is preserved across date taps.
 *   - 'date'     — calendar only; time component pinned to 00:00 and the
 *     popover closes the moment a day is picked.
 *
 * The popover is portaled and fixed-positioned so it never contributes
 * scroll overflow to an outer modal. It closes on any outside-mousedown
 * or Escape.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ICalendar } from '@/components/icons'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

interface Props {
  /** 'YYYY-MM-DDTHH:mm' (local). Empty string = unset. */
  value: string
  onChange: (next: string) => void
  /** 'datetime' shows the time columns; 'date' is date-only. */
  mode: 'datetime' | 'date'
  /** Shown in the trigger when value is empty. */
  placeholder?: string
  /** When true, the popover gets a "Clear" affordance that emits ''. */
  allowClear?: boolean
  disabled?: boolean
  /** Forwarded to the trigger for layout; defaults to full-width. */
  className?: string
}

const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MINUTE_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]
const POPOVER_GAP = 4
const POPOVER_VIEWPORT_MARGIN = 12
const POPOVER_MIN_WIDTH = { date: 272, datetime: 384 } as const

type PopoverPosition = { left: number; top: number }

function pad(n: number): string { return String(n).padStart(2, '0') }

/** Parse the local datetime string. Returns `date=null` when the input is
 *  empty or malformed; in that case the picker defaults to 09:00. */
function parseValue(s: string): { date: Date | null; hour: number; minute: number } {
  if (!s) return { date: null, hour: 9, minute: 0 }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s)
  if (!m) return { date: null, hour: 9, minute: 0 }
  return {
    date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    hour: m[4] ? Number(m[4]) : 0,
    minute: m[5] ? Number(m[5]) : 0,
  }
}

function formatValue(date: Date, hour: number, minute: number): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:${pad(minute)}`
}

/** Render the trigger text. macOS-style: "May 18, 2026  09:30". */
function formatDisplay(s: string, mode: 'datetime' | 'date', placeholder: string): string {
  const { date, hour, minute } = parseValue(s)
  if (!date) return placeholder
  const left = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  if (mode === 'date') return left
  return `${left}  ${pad(hour)}:${pad(minute)}`
}

export function DateTimePicker({
  value, onChange, mode,
  placeholder = '—',
  allowClear, disabled,
  className,
}: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [cursorMonth, setCursorMonth] = useState<Date>(() => {
    const { date } = parseValue(value)
    return date ?? new Date()
  })
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null)

  const { date: selected, hour, minute } = parseValue(value)

  const updatePopoverPosition = useCallback(() => {
    if (!wrapRef.current || !popRef.current) return

    const trigger = wrapRef.current.getBoundingClientRect()
    const popW = popRef.current.offsetWidth
    const popH = popRef.current.offsetHeight

    const minLeft = POPOVER_VIEWPORT_MARGIN
    const maxLeft = Math.max(minLeft, window.innerWidth - popW - POPOVER_VIEWPORT_MARGIN)
    const left = Math.min(Math.max(trigger.left, minLeft), maxLeft)

    const belowTop = trigger.bottom + POPOVER_GAP
    const aboveTop = trigger.top - popH - POPOVER_GAP
    const spaceBelow = window.innerHeight - trigger.bottom
    const spaceAbove = trigger.top
    const shouldOpenUp = spaceBelow < popH + POPOVER_GAP + POPOVER_VIEWPORT_MARGIN && spaceAbove > spaceBelow

    const unclampedTop = shouldOpenUp ? aboveTop : belowTop
    const maxTop = Math.max(POPOVER_VIEWPORT_MARGIN, window.innerHeight - popH - POPOVER_VIEWPORT_MARGIN)
    const top = Math.min(Math.max(unclampedTop, POPOVER_VIEWPORT_MARGIN), maxTop)

    setPopoverPosition((prev) => (
      prev && prev.left === left && prev.top === top ? prev : { left, top }
    ))
  }, [])

  // Close on outside mousedown / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (wrapRef.current?.contains(target) || popRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // When the external value changes, follow the cursor month so the user
  // doesn't have to navigate manually after a programmatic update (e.g.
  // drag-select preset).
  useEffect(() => {
    const { date } = parseValue(value)
    if (!date) return
    setCursorMonth((c) => (
      c.getFullYear() === date.getFullYear() && c.getMonth() === date.getMonth()
        ? c
        : new Date(date.getFullYear(), date.getMonth(), 1)
    ))
  }, [value])

  // Position after layout so the actual popover dimensions are available.
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null)
      return
    }
    updatePopoverPosition()
  }, [open, mode, updatePopoverPosition])

  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', updatePopoverPosition)
    window.addEventListener('scroll', updatePopoverPosition, true)
    return () => {
      window.removeEventListener('resize', updatePopoverPosition)
      window.removeEventListener('scroll', updatePopoverPosition, true)
    }
  }, [open, updatePopoverPosition])

  const days = useMemo<Date[]>(() => {
    const monthStart = new Date(cursorMonth.getFullYear(), cursorMonth.getMonth(), 1)
    const gridStart = new Date(monthStart)
    gridStart.setDate(1 - monthStart.getDay())
    const out: Date[] = []
    for (let i = 0; i < 42; i++) {
      out.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i))
    }
    return out
  }, [cursorMonth])

  const today = new Date()
  const sameYMD = (a: Date | null, b: Date) =>
    !!a && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

  const pickDate = (d: Date) => {
    if (mode === 'date') {
      onChange(formatValue(d, 0, 0))
      setOpen(false)
    } else {
      onChange(formatValue(d, hour, minute))
    }
  }
  const pickHour = (h: number) => {
    const anchor = selected ?? new Date()
    onChange(formatValue(anchor, h, minute))
  }
  const pickMinute = (m: number) => {
    const anchor = selected ?? new Date()
    onChange(formatValue(anchor, hour, m))
  }

  const display = formatDisplay(value, mode, placeholder)
  const popover = open && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={popRef}
          className="fixed z-[70] bg-cloud rounded-[14px] shadow-pop py-3 px-3 overflow-x-auto"
          style={{
            border: '1px solid var(--ink-100)',
            left: popoverPosition?.left ?? 0,
            top: popoverPosition?.top ?? 0,
            width: POPOVER_MIN_WIDTH[mode],
            maxWidth: `calc(100vw - ${POPOVER_VIEWPORT_MARGIN * 2}px)`,
            visibility: popoverPosition ? 'visible' : 'hidden',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Header: month nav + today/clear */}
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setCursorMonth(new Date(cursorMonth.getFullYear(), cursorMonth.getMonth() - 1, 1))}
                className="w-7 h-7 rounded-md grid place-items-center text-ink-500 hover:bg-ink-100 transition"
                aria-label={t('dtpicker.prevMonth')}
              >‹</button>
              <span className="text-[13px] font-semibold text-ink-900 mx-1 min-w-[120px] text-center">
                {cursorMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </span>
              <button
                type="button"
                onClick={() => setCursorMonth(new Date(cursorMonth.getFullYear(), cursorMonth.getMonth() + 1, 1))}
                className="w-7 h-7 rounded-md grid place-items-center text-ink-500 hover:bg-ink-100 transition"
                aria-label={t('dtpicker.nextMonth')}
              >›</button>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const now = new Date()
                  setCursorMonth(new Date(now.getFullYear(), now.getMonth(), 1))
                  if (mode === 'date') {
                    onChange(formatValue(now, 0, 0))
                    setOpen(false)
                  } else {
                    onChange(formatValue(now, hour, minute))
                  }
                }}
                className="text-[11.5px] font-medium text-skype-deep hover:underline px-1"
              >{t('dtpicker.today')}</button>
              {allowClear && value && (
                <button
                  type="button"
                  onClick={() => { onChange(''); setOpen(false) }}
                  className="text-[11.5px] font-medium text-ink-400 hover:text-coral-deep transition px-1"
                >{t('dtpicker.clear')}</button>
              )}
            </div>
          </div>

          <div className={cn('flex gap-3', mode === 'date' && 'justify-center')}>
            {/* Calendar */}
            <div>
              <div className="grid grid-cols-7 mb-1">
                {WEEK.map((d, i) => (
                  <div key={i} className="w-9 text-center text-[10px] font-semibold text-ink-300 uppercase tracking-wider">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-0.5">
                {days.map((d, i) => {
                  const isCur = d.getMonth() === cursorMonth.getMonth()
                  const isSelected = sameYMD(selected, d)
                  const isToday = sameYMD(today, d)
                  return (
                    <button
                      type="button"
                      key={i}
                      onClick={() => pickDate(d)}
                      className={cn(
                        'w-9 h-8 rounded-md text-[12.5px] font-medium tabular-nums transition',
                        isSelected
                          ? 'bg-skype text-white shadow-soft'
                          : isToday
                            ? 'text-skype-deep font-bold ring-1 ring-sky2-300'
                            : isCur
                              ? 'text-ink-700 hover:bg-sky2-50'
                              : 'text-ink-300 hover:bg-ink-100',
                      )}
                    >{d.getDate()}</button>
                  )
                })}
              </div>
            </div>

            {/* Time columns */}
            {mode === 'datetime' && (
              <div className="flex gap-1 border-l border-ink-100 pl-3">
                <Column
                  label={t('dtpicker.hourLabel')}
                  values={Array.from({ length: 24 }, (_, h) => h)}
                  selected={hour}
                  onPick={pickHour}
                />
                <Column
                  label={t('dtpicker.minuteLabel')}
                  values={MINUTE_STEPS}
                  // Highlight the closest 5-min step so picker stays useful
                  // even when the value was set to, say, :17 via the API.
                  selected={MINUTE_STEPS.reduce(
                    (best, v) => Math.abs(v - minute) < Math.abs(best - minute) ? v : best,
                    MINUTE_STEPS[0],
                  )}
                  onPick={pickMinute}
                />
              </div>
            )}
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center justify-between px-3 h-[38px] text-[13.5px] rounded-[10px] transition outline-none',
          'border-[1.5px]',
          value ? 'text-ink-900' : 'text-ink-300',
          open
            ? 'border-sky2-300 shadow-[0_0_0_3px_var(--sky-50)]'
            : 'border-ink-100 hover:border-ink-200',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
        style={{ background: 'var(--paper)' }}
      >
        <span className="font-medium tabular-nums truncate">{display}</span>
        <ICalendar className="w-4 h-4 text-ink-400 shrink-0 ml-2" />
      </button>

      {popover}
    </div>
  )
}

function Column({ label, values, selected, onPick }: {
  label: string
  values: number[]
  selected: number
  onPick: (v: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Scroll the active row into view whenever the popover opens or the
  // active value changes (e.g. user just tapped a different hour).
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current.querySelector('[data-active="true"]') as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <div className="flex flex-col items-center">
      <div className="text-[9px] uppercase tracking-wider text-ink-300 font-bold mb-1">{label}</div>
      <div
        ref={ref}
        className="h-[232px] overflow-y-auto flex flex-col gap-0.5 pr-1 dtp-scroll"
      >
        {values.map((v) => {
          const isActive = v === selected
          return (
            <button
              type="button"
              key={v}
              data-active={isActive}
              onClick={() => onPick(v)}
              className={cn(
                'w-10 h-7 rounded-md text-[12.5px] font-medium tabular-nums transition shrink-0',
                isActive
                  ? 'bg-skype text-white'
                  : 'text-ink-600 hover:bg-sky2-50',
              )}
            >{pad(v)}</button>
          )
        })}
      </div>
      <style>{`
        .dtp-scroll {
          scrollbar-width: thin;
          scrollbar-color: var(--ink-200) transparent;
        }
        .dtp-scroll::-webkit-scrollbar { width: 4px; }
        .dtp-scroll::-webkit-scrollbar-thumb {
          background: var(--ink-200);
          border-radius: 2px;
        }
      `}</style>
    </div>
  )
}
