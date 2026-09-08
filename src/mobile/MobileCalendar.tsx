/**
 * Mobile Calendar — month grid + day detail sheet.
 *
 * Designed to feel native (iOS Calendar / Feishu mobile): the month
 * grid spans 6 weeks, each day shows up to 3 event chips with a "+N"
 * overflow, taps drill into a day sheet, and a single FAB on the
 * Library tab opens the shared `EventEditor` modal. Recurrence
 * expansion + status filtering mirror the desktop CalendarView, so a
 * weekly agent task created on PC shows up in the right cells here.
 */
import { useEffect, useMemo, useState } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import { EventEditor, type EventEditorPrefill } from '@/components/EventEditor'
import { Avatar } from '@/components/Avatar'
import { ICalendar, IClock, IRepeat } from '@/components/icons'
import { tapHaptic } from '@/lib/native'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { nextOccurrenceOnOrAfter } from '@/lib/recurrence'
import type { CalendarEvent } from '@/types'

const DAY_MS = 86_400_000
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface AgendaItem {
  event: CalendarEvent
  occurrence: Date
  isRecurring: boolean
}

/* ──────────────── date / recurrence helpers (mirror desktop) ──────────────── */

function startOfDay(d: Date): Date {
  const out = new Date(d); out.setHours(0, 0, 0, 0); return out
}
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1) }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999) }
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function nextOccurrence(event: CalendarEvent, from: Date): Date | null {
  if (event.status !== 'active') return null
  return nextOccurrenceOnOrAfter(new Date(event.startAt), event.recurrence ?? null, from)
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

function chipTone(ev: CalendarEvent): { bg: string; fg: string; border: string } {
  if (ev.kind === 'agent_task') {
    return {
      bg: 'rgba(124, 92, 255, 0.10)',
      fg: 'var(--whisper-deep)',
      border: 'rgba(124, 92, 255, 0.18)',
    }
  }
  return {
    bg: 'rgba(0, 168, 240, 0.10)',
    fg: 'var(--skype-deep)',
    border: 'rgba(0, 168, 240, 0.18)',
  }
}

/* ──────────────── component ──────────────── */

export function MobileCalendar() {
  const t = useT()
  const events = useCalendar((s) => s.events)
  const loaded = useCalendar((s) => s.loaded)
  const load = useCalendar((s) => s.load)
  const byId = useParticipants((s) => s.byId)
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()))
  const [selectedDay, setSelectedDay] = useState<Date | null>(() => startOfDay(new Date()))
  const [editing, setEditing] = useState<
    | { mode: 'edit'; event: CalendarEvent }
    | { mode: 'new'; prefill?: EventEditorPrefill }
    | null
  >(null)

  useEffect(() => { void load() }, [load])

  const monthStart = useMemo(() => startOfMonth(cursor), [cursor])
  const monthEnd = useMemo(() => endOfMonth(cursor), [cursor])

  // Grid spans the 6 visible weeks (some leading/trailing days outside
  // the cursor month). 42 cells keeps the grid height stable so swiping
  // between months doesn't reflow.
  const gridStart = useMemo(() => {
    const d = new Date(monthStart); d.setDate(d.getDate() - d.getDay()); return d
  }, [monthStart])
  const gridEnd = useMemo(() => {
    const d = new Date(monthEnd); d.setDate(d.getDate() + (6 - d.getDay())); return d
  }, [monthEnd])
  const days = useMemo(() => {
    const out: Date[] = []
    for (let d = new Date(gridStart); d.getTime() <= gridEnd.getTime(); d = new Date(d.getTime() + DAY_MS)) {
      out.push(new Date(d))
    }
    return out
  }, [gridStart, gridEnd])

  const monthOccurrences = useMemo(
    () => expandToRange(events, gridStart, new Date(gridEnd.getTime() + DAY_MS - 1)),
    [events, gridStart, gridEnd],
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

  const selectedKey = selectedDay
    ? `${selectedDay.getFullYear()}-${selectedDay.getMonth()}-${selectedDay.getDate()}`
    : null
  const selectedItems = selectedKey ? byDay.get(selectedKey) ?? [] : []

  const goMonth = (delta: number) => {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1))
    void tapHaptic()
  }
  const goToday = () => {
    const today = new Date()
    setCursor(startOfMonth(today))
    setSelectedDay(startOfDay(today))
    void tapHaptic()
  }

  const openNew = (day: Date) => {
    const start = new Date(day); start.setHours(9, 0, 0, 0)
    const end = new Date(day); end.setHours(10, 0, 0, 0)
    setEditing({ mode: 'new', prefill: { startAt: start, endAt: end } })
  }

  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="relative bg-paper">
      {/* The whole calendar — month header, weekday row, grid, day
          detail — scrolls as one column. Nesting another overflow
          container inside the grid squished it into what looked like
          a week strip. The host (MobileLibrary's `.overflow-y-auto`)
          is the only scroller. */}

      {/* Sticky month header so the user can swipe through the grid
          and still see which month they're on. */}
      <div
        className="sticky top-0 z-10 bg-paper/95 backdrop-blur-md px-3 pt-2 pb-1 flex items-center gap-2"
      >
        <button
          type="button"
          onClick={() => goMonth(-1)}
          className="w-9 h-9 grid place-items-center rounded-full text-ink-700 active:bg-sky2-50 transition text-[20px] leading-none"
          aria-label={t('mcal.prevMonth')}
        >‹</button>
        <div className="flex-1 text-center font-display font-medium text-[17px] text-ink-900 tracking-tight" style={{ letterSpacing: '-0.01em' }}>
          {monthLabel}
        </div>
        <button
          type="button"
          onClick={() => goMonth(1)}
          className="w-9 h-9 grid place-items-center rounded-full text-ink-700 active:bg-sky2-50 transition text-[20px] leading-none"
          aria-label={t('mcal.nextMonth')}
        >›</button>
        <button
          type="button"
          onClick={goToday}
          className="py-1.5 px-3 text-[11.5px] font-semibold rounded-full bg-sky2-50 border border-sky2-100 active:bg-sky2-100 transition"
          style={{ color: 'var(--skype)' }}
        >{t('mcal.today')}</button>
      </div>

      {/* Weekday row */}
      <div className="grid grid-cols-7 px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-wide text-ink-400 select-none">
        {WEEK.map((d) => <div key={d} className="text-center">{d}</div>)}
      </div>

      {/* Month grid — always 6 rows visible. Cells are tall enough to
          hold the date pill + event dots without crowding. */}
      <div className="px-2">
        <div
          className="grid grid-cols-7 gap-px rounded-[12px] overflow-hidden select-none"
          style={{ background: 'var(--ink-100)' }}
        >
          {days.map((d) => {
            const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
            const items = byDay.get(k) ?? []
            const isCurMonth = d.getMonth() === cursor.getMonth()
            const isToday = sameDay(d, new Date())
            const isSelected = selectedDay !== null && sameDay(d, selectedDay)
            return (
              <button
                type="button"
                key={k}
                onClick={() => {
                  setSelectedDay(new Date(d))
                  void tapHaptic()
                }}
                className={cn(
                  'bg-paper relative h-[54px] py-1 flex flex-col items-center gap-1 transition',
                  !isCurMonth && 'opacity-40',
                  isSelected && 'bg-sky2-50',
                )}
              >
                <span
                  className="inline-grid place-items-center w-6 h-6 rounded-full text-[12px] font-semibold leading-none"
                  style={{
                    background: isToday ? 'var(--skype)' : 'transparent',
                    color: isToday ? 'white' : isSelected ? 'var(--skype)' : 'var(--ink-700)',
                  }}
                >{d.getDate()}</span>
                {items.length > 0 && (
                  <div className="flex gap-0.5 items-center">
                    {items.slice(0, 3).map((it) => {
                      const tone = chipTone(it.event)
                      return (
                        <span
                          key={`${it.event.id}-${it.occurrence.getTime()}`}
                          className="block w-1.5 h-1.5 rounded-full"
                          style={{ background: tone.fg }}
                        />
                      )
                    })}
                    {items.length > 3 && (
                      <span className="text-[8.5px] text-ink-400 ml-0.5">+{items.length - 3}</span>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Day detail — agenda for the selected day. Grows naturally;
          the host container handles scrolling so the user can flick
          past the grid to read the day's events. */}
      <div className="mt-3 px-3 pb-24">
        {selectedDay && (
          <DayDetail
            day={selectedDay}
            items={selectedItems}
            onEdit={(ev) => setEditing({ mode: 'edit', event: ev })}
            onNew={() => openNew(selectedDay)}
            byId={byId}
          />
        )}
        {!selectedDay && (
          <div className="px-2 py-6 text-center text-[12.5px] text-ink-400 italic">{t('mcal.pickDay')}</div>
        )}
        {!loaded && events.length === 0 && (
          <div className="px-2 py-6 text-center text-[12.5px] text-ink-300 italic">{t('mcal.loading')}</div>
        )}
      </div>

      {editing && (
        <EventEditor
          event={editing.mode === 'edit' ? editing.event : null}
          prefill={editing.mode === 'new' ? editing.prefill : undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function DayDetail({ day, items, onEdit, onNew, byId }: {
  day: Date
  items: AgendaItem[]
  onEdit: (ev: CalendarEvent) => void
  onNew: () => void
  byId: Record<string, { id: string; name: string; kind?: string; avatarUrl?: string | null; avatarBg?: string; initial?: string; status?: string }>
}) {
  const t = useT()
  const heading = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div>
      <div className="flex items-center gap-2 px-1 mb-2.5">
        <div className="font-display font-medium text-[15px] text-ink-900 tracking-tight" style={{ letterSpacing: '-0.01em' }}>
          {heading}
        </div>
        <span className="text-[11px] text-ink-400">· {items.length === 1 ? t('mcal.eventCount', { n: items.length, s: '' }) : t('mcal.eventCount', { n: items.length, s: 's' })}</span>
        <button
          type="button"
          onClick={onNew}
          className="ml-auto py-1 px-2 text-[11px] font-semibold rounded-full text-skype-deep bg-sky2-50 border border-sky2-100 active:bg-sky2-100 transition"
        >{t('mcal.newEvent')}</button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-ink-200 bg-cloud py-8 px-4 text-center"
          style={{ background: 'linear-gradient(180deg, var(--paper), var(--sky-50))' }}
        >
          <div className="mx-auto mb-2 w-9 h-9 rounded-full grid place-items-center bg-sky2-50 text-skype-deep">
            <ICalendar className="w-[18px] h-[18px]" />
          </div>
          <div className="text-[12.5px] text-ink-500 font-display italic leading-relaxed">{t('mcal.emptyDay')}</div>
          <button
            type="button"
            onClick={onNew}
            className="mt-3 py-1.5 px-3 text-[12px] font-semibold rounded-full bg-cloud border border-ink-100 text-ink-700 active:bg-sky2-50 transition"
          >{t('mcal.addEvent')}</button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => {
            const tone = chipTone(it.event)
            const ev = it.event
            const start = it.occurrence
            const end = ev.endAt ? new Date(start.getTime() + (new Date(ev.endAt).getTime() - new Date(ev.startAt).getTime())) : null
            const assignee = ev.assigneeId ? byId[ev.assigneeId] : null
            return (
              <button
                type="button"
                key={`${ev.id}-${it.occurrence.getTime()}`}
                onClick={() => onEdit(ev)}
                className="w-full text-left rounded-[12px] p-3 border active:scale-[0.99] transition"
                style={{
                  background: tone.bg,
                  borderColor: tone.border,
                }}
              >
                <div className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.12em]"
                  style={{ color: tone.fg }}
                >
                  {ev.kind === 'agent_task' ? t('mcal.agentTask') : t('mcal.personal')}
                  {it.isRecurring && (
                    <span className="inline-flex items-center gap-0.5 text-ink-400 font-normal normal-case tracking-normal text-[10.5px]">
                      <IRepeat className="w-3 h-3" /> {t('mcal.recurring')}
                    </span>
                  )}
                </div>
                <div className="mt-1 font-semibold text-[14px] text-ink-900 leading-tight truncate">
                  {ev.title || t('mcal.untitledEvent')}
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-600">
                  <IClock className="w-3 h-3 shrink-0" />
                  <span>{formatTime(start)}{end ? ` – ${formatTime(end)}` : ''}</span>
                  {assignee && (
                    <span className="ml-auto flex items-center gap-1 truncate">
                      <Avatar p={assignee as never} size={16} showStatus={false} />
                      <span className="truncate text-[11px] text-ink-500">{assignee.name}</span>
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
