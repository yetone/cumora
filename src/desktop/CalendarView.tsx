/**
 * Calendar — macOS-Calendar-style scheduling surface. Three view modes
 * (Day / Week / Month) share one toolbar; each one supports:
 *
 *   - LEFT-CLICK on empty space → opens EventEditor with that slot pre-
 *     filled (1h default in time-grid views, 9-10am in month view).
 *   - LEFT-DRAG on empty space → drags out a range; on mouseup the editor
 *     opens with startAt + endAt filled in. Week/Day drag along the time
 *     axis; Month drag across adjacent day cells produces an all-day
 *     multi-day range.
 *   - RIGHT-CLICK → context menu with "New event…" at the clicked
 *     time / day.
 *   - CLICK an existing event block → opens it for editing.
 *
 * The week/day time grid is laid out at HOUR_HEIGHT px per hour, with a
 * 30-minute snap (SLOT_MINUTES). Selections never collapse below one slot
 * so a click without drag still produces a valid range.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { useMe } from '@/stores/auth'
import { Avatar } from '@/components/Avatar'
import { IPlus, ICalendar, IClock, IRepeat, ITrash } from '@/components/icons'
import { EventEditor, type EventEditorPrefill } from '@/components/EventEditor'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { CalendarEvent, RecurrenceRule } from '@/types'

interface AgendaItem {
  event: CalendarEvent
  occurrence: Date
  isRecurring: boolean
}

type ViewMode = 'day' | 'week' | 'month'
type EditingState =
  | { mode: 'edit'; event: CalendarEvent }
  | { mode: 'new'; prefill?: EventEditorPrefill }
  | null

const DAY_MS = 86_400_000
const WEEK_KEYS = [
  'cal.weekShortSun',
  'cal.weekShortMon',
  'cal.weekShortTue',
  'cal.weekShortWed',
  'cal.weekShortThu',
  'cal.weekShortFri',
  'cal.weekShortSat',
] as const
const HOUR_HEIGHT = 48
const SLOT_MINUTES = 30
const SLOT_HEIGHT = (HOUR_HEIGHT * SLOT_MINUTES) / 60

/* ─────────────────────────── date helpers ─────────────────────────── */

function startOfDay(d: Date): Date {
  const out = new Date(d); out.setHours(0, 0, 0, 0); return out
}
function startOfWeek(d: Date): Date {
  const out = startOfDay(d); out.setDate(out.getDate() - out.getDay()); return out
}
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1) }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999) }
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function formatDateLong(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}
function addDays(d: Date, n: number): Date { const out = new Date(d); out.setDate(out.getDate() + n); return out }

/* ─────────────────────────── recurrence (client mirror) ─────────────────────────── */

function stepRule(from: Date, rule: RecurrenceRule): Date {
  const interval = Math.max(1, Math.floor(rule.interval || 1))
  switch (rule.freq) {
    case 'daily':
      return new Date(from.getTime() + interval * DAY_MS)
    case 'weekly': {
      const days = rule.byweekday && rule.byweekday.length ? [...rule.byweekday].sort((a, b) => a - b) : null
      if (!days) return new Date(from.getTime() + interval * 7 * DAY_MS)
      let cand = new Date(from.getTime() + ((interval - 1) * 7 + 1) * DAY_MS)
      for (let i = 0; i < 14; i++) {
        if (days.includes(cand.getDay())) return cand
        cand = new Date(cand.getTime() + DAY_MS)
      }
      return cand
    }
    case 'monthly': {
      const out = new Date(from); out.setMonth(out.getMonth() + interval); return out
    }
    case 'yearly': {
      const out = new Date(from); out.setFullYear(out.getFullYear() + interval); return out
    }
  }
}

function nextOccurrence(event: CalendarEvent, from: Date): Date | null {
  const startAt = new Date(event.startAt)
  if (event.status !== 'active') return null
  if (!event.recurrence) return startAt.getTime() >= from.getTime() ? startAt : null
  const rule = event.recurrence
  const untilTs = rule.until ? new Date(rule.until).getTime() : Infinity
  const maxCount = rule.count ?? Infinity
  let current = new Date(startAt)
  let fired = 1
  for (let i = 0; i < 5000; i++) {
    if (current.getTime() > untilTs) return null
    if (fired > maxCount) return null
    if (current.getTime() >= from.getTime()) return current
    current = stepRule(current, rule)
    fired += 1
  }
  return null
}

function describeRecurrence(r: RecurrenceRule | null, t: ReturnType<typeof useT>): string {
  if (!r) return t('cal.oneShot')
  const every = r.interval > 1 ? t('cal.everyN', { n: r.interval }) : t('cal.every')
  const freqMap = { daily: 'cal.dayUnit', weekly: 'cal.weekUnit', monthly: 'cal.monthUnit', yearly: 'cal.yearUnit' } as const
  const pluralMap = { daily: 'cal.dayUnitPlural', weekly: 'cal.weekUnitPlural', monthly: 'cal.monthUnitPlural', yearly: 'cal.yearUnitPlural' } as const
  const unitKey = r.interval > 1 ? pluralMap[r.freq] : freqMap[r.freq]
  const base = `${every} ${t(unitKey)}`
  if (r.freq === 'weekly' && r.byweekday && r.byweekday.length) {
    return `${base} · ${r.byweekday.map((d) => t(WEEK_KEYS[d])).join(t('cal.weekdayJoin'))}`
  }
  return base
}

function expandToRange(events: CalendarEvent[], start: Date, end: Date): AgendaItem[] {
  const out: AgendaItem[] = []
  for (const ev of events) {
    if (ev.status !== 'active' && ev.status !== 'done') continue
    const seed = new Date(ev.startAt)
    if (!ev.recurrence) {
      if (seed.getTime() >= start.getTime() && seed.getTime() <= end.getTime()) {
        out.push({ event: ev, occurrence: seed, isRecurring: false })
      }
      continue
    }
    if (ev.status !== 'active') continue
    let cur = nextOccurrence(ev, start)
    let safety = 0
    while (cur && cur.getTime() <= end.getTime() && safety < 200) {
      out.push({ event: ev, occurrence: new Date(cur), isRecurring: true })
      cur = nextOccurrence(ev, new Date(cur.getTime() + 1))
      safety += 1
    }
  }
  out.sort((a, b) => a.occurrence.getTime() - b.occurrence.getTime())
  return out
}

/* ─────────────────────────── shared types ─────────────────────────── */

interface GridProps {
  cursor: Date
  events: CalendarEvent[]
  onEdit: (e: CalendarEvent) => void
  onNew: (prefill: EventEditorPrefill) => void
}

/* ─────────────────────────── ContextMenu ─────────────────────────── */

interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

function ContextMenu({ x, y, items, onClose }: {
  x: number; y: number
  items: MenuItem[]
  onClose: () => void
}) {
  useEffect(() => {
    const onDown = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  // Clamp to viewport so a click in the bottom-right corner doesn't push
  // the menu off-screen. Approximate width 220, height = items * 32 + 8.
  const w = 220
  const h = items.length * 32 + 8
  const left = Math.min(x, window.innerWidth - w - 8)
  const top = Math.min(y, window.innerHeight - h - 8)
  return (
    <div
      className="fixed z-[100] bg-cloud rounded-lg shadow-pop py-1"
      style={{ left, top, minWidth: w, border: '1px solid var(--ink-100)' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <button
          type="button"
          key={i}
          onClick={() => { it.onClick(); onClose() }}
          className={cn(
            'w-full text-left px-3 py-1.5 text-[13px] transition hover:bg-sky2-50',
            it.danger ? 'text-coral-deep' : 'text-ink-700',
          )}
        >{it.label}</button>
      ))}
    </div>
  )
}

/* ─────────────────────────── MonthGrid ─────────────────────────── */

function MonthGrid({ cursor, events, onEdit, onNew }: GridProps) {
  const t = useT()
  const monthStart = startOfMonth(cursor)
  const monthEnd = endOfMonth(cursor)
  const gridStart = useMemo(() => {
    const d = new Date(monthStart); d.setDate(d.getDate() - d.getDay()); return d
  }, [monthStart.getTime()])
  const gridEnd = useMemo(() => {
    const d = new Date(monthEnd); d.setDate(d.getDate() + (6 - d.getDay())); return d
  }, [monthEnd.getTime()])

  const days = useMemo(() => {
    const out: Date[] = []
    for (let d = new Date(gridStart); d.getTime() <= gridEnd.getTime(); d = new Date(d.getTime() + DAY_MS)) {
      out.push(new Date(d))
    }
    return out
  }, [gridStart.getTime(), gridEnd.getTime()])

  const monthOccurrences = useMemo(
    () => expandToRange(events, gridStart, new Date(gridEnd.getTime() + DAY_MS - 1)),
    [events, gridStart.getTime(), gridEnd.getTime()],
  )
  const byDay = useMemo(() => {
    const m = new Map<string, AgendaItem[]>()
    for (const it of monthOccurrences) {
      const k = `${it.occurrence.getFullYear()}-${it.occurrence.getMonth()}-${it.occurrence.getDate()}`
      const arr = m.get(k) ?? []
      arr.push(it)
      m.set(k, arr)
    }
    return m
  }, [monthOccurrences])

  // Drag state: indices into the `days` array. We don't snap to whole
  // cells via DOM; instead each cell has an onMouseEnter that updates the
  // current index while dragging.
  const [drag, setDrag] = useState<{ startIdx: number; currentIdx: number; moved: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; date: Date } | null>(null)

  // mouseup handler — kept on window so a drag that leaves the grid still
  // completes cleanly. Reads the latest `drag` snapshot via closure on
  // every effect re-run.
  useEffect(() => {
    if (!drag) return
    const onUp = () => {
      const lo = Math.min(drag.startIdx, drag.currentIdx)
      const hi = Math.max(drag.startIdx, drag.currentIdx)
      const startDate = new Date(days[lo]); startDate.setHours(9, 0, 0, 0)
      if (lo === hi && !drag.moved) {
        // Single click on a cell — open editor at 09:00–10:00 that day.
        const end = new Date(startDate); end.setHours(10, 0, 0, 0)
        onNew({ startAt: startDate, endAt: end })
      } else {
        // Multi-day drag — produce an all-day range.
        const endDate = new Date(days[hi]); endDate.setHours(23, 59, 0, 0)
        onNew({ startAt: startDate, endAt: endDate, allDay: true })
      }
      setDrag(null)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [drag, days, onNew])

  return (
    <>
      <div className="grid grid-cols-7 px-4 pt-3 text-[11px] uppercase tracking-wide text-ink-400 select-none">
        {WEEK_KEYS.map((k) => <div key={k} className="px-2 py-1">{t(k)}</div>)}
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-4 pb-4">
        <div
          className="grid grid-cols-7 gap-px bg-ink-100 rounded-lg overflow-hidden select-none"
          style={{ gridAutoRows: 'minmax(96px, 1fr)' }}
        >
          {days.map((d, idx) => {
            const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
            const items = byDay.get(k) ?? []
            const isCurMonth = d.getMonth() === cursor.getMonth()
            const isToday = sameDay(d, new Date())
            const inSelection = drag !== null
              && idx >= Math.min(drag.startIdx, drag.currentIdx)
              && idx <= Math.max(drag.startIdx, drag.currentIdx)
            return (
              <div
                key={k}
                className={cn(
                  'bg-cloud p-1.5 min-h-0 flex flex-col gap-1 text-xs cursor-pointer relative',
                  !isCurMonth && 'opacity-40',
                  inSelection && 'bg-sky2-50',
                )}
                onMouseDown={(e) => {
                  if (e.button !== 0) return
                  if ((e.target as HTMLElement).closest('.cal-event-chip')) return
                  setDrag({ startIdx: idx, currentIdx: idx, moved: false })
                }}
                onMouseEnter={() => {
                  if (drag && drag.currentIdx !== idx) {
                    setDrag({ ...drag, currentIdx: idx, moved: true })
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ x: e.clientX, y: e.clientY, date: new Date(d) })
                }}
              >
                <div className="flex items-center justify-between">
                  <span className={cn(
                    'inline-grid place-items-center w-5 h-5 rounded-full text-[11px] font-semibold',
                    isToday ? 'bg-skype text-white' : 'text-ink-600',
                  )}>{d.getDate()}</span>
                  {items.length > 3 && (
                    <span className="text-[10px] text-ink-400">+{items.length - 3}</span>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 overflow-hidden">
                  {items.slice(0, 3).map((it, i) => (
                    <button
                      type="button"
                      key={`${it.event.id}-${i}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onEdit(it.event) }}
                      className={cn(
                        'cal-event-chip text-left truncate rounded-sm px-1 py-0.5 text-[11px] font-medium transition',
                        it.event.kind === 'agent_task'
                          ? 'bg-sky2-100 text-skype-deep hover:bg-sky2-200'
                          : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
                      )}
                      title={`${formatTime(it.occurrence)} · ${it.event.title}`}
                    >
                      <span className="opacity-70">{formatTime(it.occurrence)}</span> {it.event.title}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t('cal.newEventOn', { date: menu.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }),
              onClick: () => {
                const start = new Date(menu.date); start.setHours(9, 0, 0, 0)
                const end = new Date(menu.date); end.setHours(10, 0, 0, 0)
                onNew({ startAt: start, endAt: end })
              },
            },
            {
              label: t('cal.newAllDay'),
              onClick: () => {
                const start = new Date(menu.date); start.setHours(0, 0, 0, 0)
                const end = new Date(menu.date); end.setHours(23, 59, 0, 0)
                onNew({ startAt: start, endAt: end, allDay: true })
              },
            },
          ]}
        />
      )}
    </>
  )
}

/* ─────────────────────────── TimeGrid (Week / Day) ─────────────────────────── */

function TimeGrid({ cursor, events, onEdit, onNew, dayCount }: GridProps & { dayCount: 1 | 7 }) {
  const t = useT()
  const start = useMemo(
    () => dayCount === 7 ? startOfWeek(cursor) : startOfDay(cursor),
    [cursor.getTime(), dayCount],
  )
  const days = useMemo(
    () => Array.from({ length: dayCount }, (_, i) => addDays(start, i)),
    [start.getTime(), dayCount],
  )
  const rangeEnd = useMemo(
    () => new Date(start.getTime() + dayCount * DAY_MS),
    [start.getTime(), dayCount],
  )

  const occurrences = useMemo(
    () => expandToRange(events, start, rangeEnd),
    [events, start.getTime(), rangeEnd.getTime()],
  )
  const byDayIdx = useMemo(() => {
    const m: AgendaItem[][] = Array.from({ length: dayCount }, () => [])
    for (const occ of occurrences) {
      const di = Math.floor((occ.occurrence.getTime() - start.getTime()) / DAY_MS)
      if (di >= 0 && di < dayCount) m[di].push(occ)
    }
    return m
  }, [occurrences, start.getTime(), dayCount])

  const colRefs = useRef<Array<HTMLDivElement | null>>([])
  const [drag, setDrag] = useState<{ dayIdx: number; anchorMin: number; cursorMin: number; moved: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; date: Date } | null>(null)

  // Snap a clientY to a 30-min slot start in a given column. Returns the
  // minute-of-day for the slot containing the cursor.
  const pickSlotMinutes = (clientY: number, dayIdx: number): number => {
    const col = colRefs.current[dayIdx]
    if (!col) return 0
    const rect = col.getBoundingClientRect()
    const y = clientY - rect.top
    const slotIdx = Math.max(0, Math.min(47, Math.floor(y / SLOT_HEIGHT)))
    return slotIdx * SLOT_MINUTES
  }

  // While dragging: window-level mousemove updates the cursor slot;
  // mouseup commits the range and clears. The handlers are recreated
  // whenever `drag` changes so they always see the right anchor.
  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      const min = pickSlotMinutes(e.clientY, drag.dayIdx)
      if (min !== drag.cursorMin) {
        setDrag({ ...drag, cursorMin: min, moved: true })
      }
    }
    const onUp = () => {
      // Selection always spans at least one slot, even on a no-move
      // click — so a single click produces a 1h range (2 slots).
      const lo = Math.min(drag.anchorMin, drag.cursorMin)
      const hi = Math.max(drag.anchorMin, drag.cursorMin) + SLOT_MINUTES
      const effectiveHi = drag.moved ? hi : lo + 60 // single click = 1h default
      const startDate = new Date(days[drag.dayIdx])
      startDate.setHours(0, lo, 0, 0)
      const endDate = new Date(days[drag.dayIdx])
      endDate.setHours(0, effectiveHi, 0, 0)
      onNew({ startAt: startDate, endAt: endDate })
      setDrag(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, days, onNew])

  return (
    <>
      {/* Single scroll container holds both the sticky day header and the
       *  hour-grid body. Sharing one scroll container guarantees the
       *  header's column boundaries line up with the body's even when a
       *  vertical scrollbar appears (which would otherwise pinch the body
       *  columns while the header stays full-width). */}
      <div className="flex-1 min-h-0 overflow-auto">
        {/* Day header row (sticky) */}
        <div
          className="grid border-b border-ink-100 select-none sticky top-0 z-20 bg-cloud"
          style={{ gridTemplateColumns: `56px repeat(${dayCount}, 1fr)` }}
        >
          <div />
          {days.map((d, i) => {
            const isToday = sameDay(d, new Date())
            return (
              <div key={i} className="px-2 py-2 text-center border-l border-ink-100">
                <div className="text-[10px] uppercase tracking-wider text-ink-400">{t(WEEK_KEYS[d.getDay()])}</div>
                <div className={cn(
                  'mt-0.5 text-base font-semibold',
                  isToday ? 'text-skype' : 'text-ink-900',
                )}>{d.getDate()}</div>
              </div>
            )
          })}
        </div>
        <div
          className="grid relative select-none"
          style={{ gridTemplateColumns: `56px repeat(${dayCount}, 1fr)`, minHeight: 24 * HOUR_HEIGHT }}
        >
          {/* Time gutter */}
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="text-[10px] text-ink-400 pr-2 text-right relative"
                style={{ height: HOUR_HEIGHT }}
              >
                {h === 0 ? '' : (
                  <span className="absolute right-2 -top-1.5 bg-cloud px-0.5">{String(h).padStart(2, '0')}:00</span>
                )}
              </div>
            ))}
          </div>
          {/* Day columns */}
          {days.map((d, dayIdx) => (
            <div
              key={dayIdx}
              ref={(el) => { colRefs.current[dayIdx] = el }}
              className="relative border-l border-ink-100 cursor-cell"
              onMouseDown={(e) => {
                if (e.button !== 0) return
                if ((e.target as HTMLElement).closest('.cal-event-block')) return
                const min = pickSlotMinutes(e.clientY, dayIdx)
                setDrag({ dayIdx, anchorMin: min, cursorMin: min, moved: false })
                e.preventDefault()
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                const min = pickSlotMinutes(e.clientY, dayIdx)
                const date = new Date(d); date.setHours(0, min, 0, 0)
                setMenu({ x: e.clientX, y: e.clientY, date })
              }}
            >
              {/* Hour & half-hour rules */}
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h}>
                  <div
                    className="absolute left-0 right-0 border-t border-ink-100"
                    style={{ top: h * HOUR_HEIGHT }}
                  />
                  <div
                    className="absolute left-0 right-0 border-t border-ink-100 opacity-50"
                    style={{ top: h * HOUR_HEIGHT + HOUR_HEIGHT / 2 }}
                  />
                </div>
              ))}
              {/* Drag preview (only on the active drag column) */}
              {drag && drag.dayIdx === dayIdx && (() => {
                const lo = Math.min(drag.anchorMin, drag.cursorMin)
                const hi = Math.max(drag.anchorMin, drag.cursorMin) + SLOT_MINUTES
                const top = (lo / 60) * HOUR_HEIGHT
                const height = ((hi - lo) / 60) * HOUR_HEIGHT
                return (
                  <div
                    className="absolute left-1 right-1 rounded-md bg-skype/25 border-2 border-skype pointer-events-none"
                    style={{ top, height }}
                  >
                    <div className="text-[10px] font-semibold text-skype-deep px-1 pt-0.5">
                      {String(Math.floor(lo / 60)).padStart(2, '0')}:{String(lo % 60).padStart(2, '0')}–
                      {String(Math.floor(hi / 60)).padStart(2, '0')}:{String(hi % 60).padStart(2, '0')}
                    </div>
                  </div>
                )
              })()}
              {/* Event blocks */}
              {(byDayIdx[dayIdx] ?? []).map((occ, i) => {
                const s = occ.occurrence
                const e = occ.event.endAt ? new Date(occ.event.endAt) : null
                const startMins = s.getHours() * 60 + s.getMinutes()
                // Clip multi-day events at the visible day boundary.
                const durMin = e
                  ? Math.max(
                      30,
                      Math.min(
                        (e.getTime() - s.getTime()) / 60_000,
                        24 * 60 - startMins,
                      ),
                    )
                  : 60
                const top = (startMins / 60) * HOUR_HEIGHT
                const height = (durMin / 60) * HOUR_HEIGHT
                return (
                  <button
                    type="button"
                    key={`${occ.event.id}-${i}`}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onEdit(occ.event)}
                    className={cn(
                      'cal-event-block absolute left-1 right-1 rounded-md px-2 py-1 text-left text-[11px] font-medium overflow-hidden transition',
                      occ.event.kind === 'agent_task'
                        ? 'bg-sky2-100 text-skype-deep hover:bg-sky2-200 border border-sky2-300'
                        : 'bg-ink-100 text-ink-700 hover:bg-ink-200 border border-ink-200',
                    )}
                    style={{ top, height }}
                    title={occ.event.title}
                  >
                    <div className="truncate">{occ.event.title}</div>
                    {height > 28 && (
                      <div className="text-[10px] opacity-70 truncate">
                        {formatTime(s)}{e ? `–${formatTime(e)}` : ''}
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t('cal.newEventAt', { time: formatTime(menu.date) }),
              onClick: () => {
                const end = new Date(menu.date); end.setHours(end.getHours() + 1)
                onNew({ startAt: menu.date, endAt: end })
              },
            },
            {
              label: t('cal.newAllDay'),
              onClick: () => {
                const s = new Date(menu.date); s.setHours(0, 0, 0, 0)
                const e = new Date(menu.date); e.setHours(23, 59, 0, 0)
                onNew({ startAt: s, endAt: e, allDay: true })
              },
            },
          ]}
        />
      )}
    </>
  )
}

/* ─────────────────────────── CalendarView ─────────────────────────── */

export function CalendarView() {
  const t = useT()
  const [mode, setMode] = useState<ViewMode>('week')
  const [cursor, setCursor] = useState<Date>(() => new Date())
  const [editing, setEditing] = useState<EditingState>(null)

  const events = useCalendar((s) => s.events)
  const loaded = useCalendar((s) => s.loaded)
  const load = useCalendar((s) => s.load)
  const remove = useCalendar((s) => s.remove)
  const runNow = useCalendar((s) => s.runNow)
  const byId = useParticipants((s) => s.byId)
  const conversationsList = useConversations((s) => s.list)
  const convosById = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of conversationsList) m[c.id] = c.title
    return m
  }, [conversationsList])
  const meId = useMe()

  useEffect(() => { void load() }, [load])

  // Forward/backward step depends on the active view: month = 1 month,
  // week = 7 days, day = 1 day. Today resets to now.
  const goPrev = () => {
    if (mode === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))
    else if (mode === 'week') setCursor(addDays(cursor, -7))
    else setCursor(addDays(cursor, -1))
  }
  const goNext = () => {
    if (mode === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))
    else if (mode === 'week') setCursor(addDays(cursor, 7))
    else setCursor(addDays(cursor, 1))
  }
  const goToday = () => setCursor(new Date())

  const headerLabel = useMemo(() => {
    if (mode === 'month') {
      return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    }
    if (mode === 'week') {
      const ws = startOfWeek(cursor)
      const we = addDays(ws, 6)
      const sameMonth = ws.getMonth() === we.getMonth()
      const left = ws.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const right = sameMonth
        ? we.toLocaleDateString(undefined, { day: 'numeric', year: 'numeric' })
        : we.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      return `${left} – ${right}`
    }
    return cursor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  }, [cursor.getTime(), mode])

  // Agenda panel: next 30 days starting from today (unaffected by cursor
  // navigation, matching macOS Calendar's "Upcoming" sidebar behavior).
  const today = useMemo(() => startOfDay(new Date()), [])
  const horizon = useMemo(() => new Date(today.getTime() + 30 * DAY_MS), [today])
  const agenda = useMemo(
    () => expandToRange(events, today, horizon).slice(0, 50),
    [events, today, horizon],
  )

  const openEdit = (e: CalendarEvent) => setEditing({ mode: 'edit', event: e })
  const openNew = (prefill?: EventEditorPrefill) => setEditing({ mode: 'new', prefill })

  return (
    <div className="h-full min-h-0 grid" style={{ gridTemplateColumns: '1fr 340px' }}>
      <div className="flex flex-col min-h-0">
        <div className="px-6 py-3 border-b border-ink-100 flex items-center gap-3 shrink-0">
          <ICalendar className="w-5 h-5 text-skype" />
          <h1 className="text-lg font-semibold text-ink-900">{t('cal.title')}</h1>

          <div className="flex items-center gap-1 ml-3">
            <button type="button" onClick={goPrev}
              className="w-7 h-7 rounded-md grid place-items-center text-ink-500 hover:bg-ink-100"
              aria-label={t('cal.previous')}>‹</button>
            <button type="button" onClick={goToday}
              className="px-2 h-7 rounded-md text-xs font-medium text-ink-700 hover:bg-ink-100">{t('cal.today')}</button>
            <button type="button" onClick={goNext}
              className="w-7 h-7 rounded-md grid place-items-center text-ink-500 hover:bg-ink-100"
              aria-label={t('cal.next')}>›</button>
            <span className="ml-2 text-sm text-ink-700 font-medium">{headerLabel}</span>
          </div>

          <div className="flex-1" />

          {/* View switcher — segmented control (cloud pill) */}
          <div
            className="inline-flex items-center gap-0.5 rounded-full border border-ink-100 bg-cloud p-0.5 shadow-[var(--select-shadow)]"
          >
            {(['day', 'week', 'month'] as const).map((m) => (
              <button
                type="button"
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'px-3 h-7 rounded-full text-[12px] font-semibold capitalize transition leading-none',
                  mode === m
                    ? 'bg-sky2-50 text-skype-deep ring-1 ring-inset ring-sky2-100'
                    : 'text-ink-500 hover:text-skype-deep hover:bg-sky2-50/60',
                )}
              >{t(`cal.${m}`)}</button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => openNew()}
            className="inline-flex items-center gap-1.5 px-3.5 h-8 rounded-full text-[12.5px] font-semibold text-white transition active:scale-[0.985]"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
            }}
          >
            <IPlus className="w-4 h-4" strokeWidth={2.5} />
            {t('cal.newEvent')}
          </button>
        </div>

        {mode === 'month' && <MonthGrid cursor={cursor} events={events} onEdit={openEdit} onNew={openNew} />}
        {mode === 'week' && <TimeGrid cursor={cursor} events={events} onEdit={openEdit} onNew={openNew} dayCount={7} />}
        {mode === 'day' && <TimeGrid cursor={cursor} events={events} onEdit={openEdit} onNew={openNew} dayCount={1} />}
      </div>

      {/* Agenda side panel — unchanged across modes. */}
      <aside className="border-l border-ink-100 flex flex-col min-h-0">
        <div className="px-4 py-4 border-b border-ink-100 flex items-center gap-2 shrink-0">
          <IClock className="w-4 h-4 text-ink-500" />
          <h2 className="text-sm font-semibold text-ink-700">{t('cal.upcoming')}</h2>
          <div className="flex-1" />
          <span className="text-xs text-ink-400">{t(agenda.length === 1 ? 'cal.itemsOne' : 'cal.itemsOther', { count: agenda.length })}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-auto px-3 py-2 space-y-2">
          {!loaded && (
            <div className="text-sm text-ink-400 px-1 py-2">{t('common.loading')}</div>
          )}
          {loaded && agenda.length === 0 && (
            <div className="px-1 py-6 text-center">
              <div className="text-sm text-ink-500 mb-2">{t('cal.empty30')}</div>
              <button
                type="button"
                onClick={() => openNew()}
                className="text-xs text-skype font-medium hover:underline"
              >{t('cal.scheduleCta')}</button>
            </div>
          )}
          {agenda.map((it, idx) => {
            const assignee = it.event.assigneeId ? byId[it.event.assigneeId] : null
            const day = sameDay(it.occurrence, new Date())
              ? t('cal.today')
              : sameDay(it.occurrence, new Date(Date.now() + DAY_MS))
                ? t('cal.tomorrow')
                : formatDateLong(it.occurrence)
            return (
              <div key={`${it.event.id}-${idx}`}
                className="group bg-cloud rounded-lg border border-ink-100 hover:border-ink-200 hover:shadow-soft transition p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] text-ink-500 mb-1">
                      <span>{day}</span>
                      <span className="opacity-50">·</span>
                      <span>{formatTime(it.occurrence)}</span>
                      {it.isRecurring && (
                        <>
                          <span className="opacity-50">·</span>
                          <span className="inline-flex items-center gap-0.5 text-skype-deep">
                            <IRepeat className="w-3 h-3" />
                            {describeRecurrence(it.event.recurrence, t)}
                          </span>
                        </>
                      )}
                      {it.event.isPrivate && (
                        <>
                          <span className="opacity-50">·</span>
                          <span title={t('cal.privateHint')}>🔒</span>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => openEdit(it.event)}
                      className="text-left text-sm font-medium text-ink-900 hover:text-skype-deep block w-full truncate"
                    >{it.event.title}</button>
                    {it.event.kind === 'agent_task' && assignee && (
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <Avatar p={assignee} size={18} />
                        <span className="text-xs text-ink-600">→ {assignee.name}</span>
                        {it.event.targetConversationId && convosById[it.event.targetConversationId] && (
                          <span className="text-xs text-ink-400 truncate">
                            {t('cal.inConversation', { name: convosById[it.event.targetConversationId] })}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {it.event.kind === 'agent_task' && (
                      <button
                        type="button"
                        title={t('cal.runNow')}
                        onClick={async () => {
                          try { await runNow(it.event.id) } catch (err) { console.warn('[calendar] run-now failed', err) }
                        }}
                        className="text-[10px] text-skype-deep px-1.5 py-0.5 rounded hover:bg-sky2-100"
                      >{t('cal.runNow')}</button>
                    )}
                    {(it.event.createdBy === meId) && (
                      <button
                        type="button"
                        title={t('cal.deleteEvent')}
                        onClick={async () => {
                          if (!confirm(t('cal.deleteEventConfirm', { title: it.event.title }))) return
                          try { await remove(it.event.id) } catch (err) { console.warn('[calendar] delete failed', err) }
                        }}
                        className="text-ink-400 hover:text-coral-deep p-0.5 rounded"
                      ><ITrash className="w-3 h-3" /></button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      {editing && (
        <EventEditor
          event={editing.mode === 'edit' ? editing.event : null}
          prefill={editing.mode === 'new' ? editing.prefill ?? null : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
