import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AvatarMini } from '@/components/Avatar'
import { useBoards } from '@/stores/boards'
import { useCalendar } from '@/stores/calendar'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { IBoard, ICalendar, IClock, IRepeat } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import { EventEditor } from '@/components/EventEditor'
import type { BoardCard, CalendarEvent, RecurrenceRule } from '@/types'

const RECURRING_KEYS: Record<RecurrenceRule['freq'], MessageKey> = {
  daily: 'peek.recurringDaily',
  weekly: 'peek.recurringWeekly',
  monthly: 'peek.recurringMonthly',
  yearly: 'peek.recurringYearly',
}

const RECURRING_INTERVAL_KEYS: Record<RecurrenceRule['freq'], MessageKey> = {
  daily: 'peek.recurringIntervalDaily',
  weekly: 'peek.recurringIntervalWeekly',
  monthly: 'peek.recurringIntervalMonthly',
  yearly: 'peek.recurringIntervalYearly',
}

const WEEKDAY_KEYS = [
  'peek.weekdaySun',
  'peek.weekdayMon',
  'peek.weekdayTue',
  'peek.weekdayWed',
  'peek.weekdayThu',
  'peek.weekdayFri',
  'peek.weekdaySat',
] as const satisfies readonly MessageKey[]

function OpenFullIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

function PeekHeader({
  icon,
  label,
  title,
  meta,
  onClose,
  onOpenFull,
}: {
  icon: ReactNode
  label: string
  title: string
  meta?: string
  onClose: () => void
  onOpenFull?: () => void
}) {
  const t = useT()
  return (
    <header className="shrink-0 border-b border-ink-100 bg-gradient-to-b from-white to-sky2-50/35 px-4 py-3">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 h-9 w-9 shrink-0 rounded-[10px] grid place-items-center bg-cloud border border-ink-100 text-skype-deep">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-400">{label}</div>
          <h2 className="mt-0.5 truncate text-[16px] font-semibold leading-[1.25] text-ink-900">{title}</h2>
          {meta && <div className="mt-1 truncate text-[11.5px] text-ink-500">{meta}</div>}
        </div>
        {onOpenFull && (
          <button
            type="button"
            onClick={onOpenFull}
            className="h-8 w-8 rounded-[8px] grid place-items-center text-ink-500 hover:text-skype-deep hover:bg-sky2-100 transition"
            title={t('peek.openFull')}
            aria-label={t('peek.openFull')}
          >
            <OpenFullIcon />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 rounded-[8px] grid place-items-center text-ink-400 hover:text-ink-900 hover:bg-ink-100/70 transition"
          title={t('peek.closeArtifact')}
          aria-label={t('peek.closeArtifact')}
        >
          <CloseIcon />
        </button>
      </div>
    </header>
  )
}

function PeekLoading({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="h-full bg-cloud grid place-items-center">
      <div className="flex flex-col items-center gap-3 text-ink-400">
        <div className="w-12 h-12 rounded-[12px] grid place-items-center bg-sky2-50 text-skype-deep">
          {icon}
        </div>
        <div className="text-[12.5px] font-display italic">{label}</div>
      </div>
    </div>
  )
}

function PeekUnavailable({
  icon,
  title,
  detail,
  onClose,
}: {
  icon: ReactNode
  title: string
  detail: string
  onClose: () => void
}) {
  const t = useT()
  return (
    <div className="h-full bg-cloud grid place-items-center px-8 text-center">
      <div className="max-w-[280px]">
        <div className="mx-auto w-12 h-12 rounded-[12px] grid place-items-center bg-coral-soft/45 text-coral-deep">
          {icon}
        </div>
        <div className="mt-3 text-[14px] font-semibold text-ink-900">{title}</div>
        <div className="mt-1 text-[12px] text-ink-500 leading-relaxed">{detail}</div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 h-8 px-3 rounded-[8px] text-[12px] font-semibold text-ink-600 border border-ink-100 hover:bg-sky2-50 transition"
        >
          {t('peek.closeButton')}
        </button>
      </div>
    </div>
  )
}

function formatShortDate(iso: string, t: ReturnType<typeof useT>): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return t('peek.recently')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatEventRange(event: CalendarEvent, t: ReturnType<typeof useT>): string {
  const start = new Date(event.startAt)
  if (Number.isNaN(start.getTime())) return event.allDay ? t('peek.allDay') : t('peek.timeUnavailable')
  if (event.allDay) return start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const startLabel = `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} - ${formatTime(start)}`
  if (!event.endAt) return startLabel
  const end = new Date(event.endAt)
  if (Number.isNaN(end.getTime())) return startLabel
  const sameDay = start.toDateString() === end.toDateString()
  return sameDay
    ? `${startLabel}-${formatTime(end)}`
    : `${startLabel}-${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${formatTime(end)}`
}

function describeRecurrence(r: RecurrenceRule | null, t: ReturnType<typeof useT>): string {
  if (!r) return t('peek.oneShot')
  const base = r.interval === 1
    ? t(RECURRING_KEYS[r.freq])
    : t(RECURRING_INTERVAL_KEYS[r.freq], { n: r.interval })
  if (r.freq === 'weekly' && r.byweekday && r.byweekday.length) {
    const days = r.byweekday.map((d) => t(WEEKDAY_KEYS[d])).join(t('peek.weekdaySeparator'))
    return t('peek.recurringWeeklyDays', { base, days })
  }
  return base
}

export function BoardPeekContent({
  boardId,
  focusCardId,
  onClose,
  onOpenFull,
}: {
  boardId: string
  focusCardId?: string | null
  onClose: () => void
  onOpenFull?: () => void
}) {
  const t = useT()
  const list = useBoards((s) => s.list)
  const loadingList = useBoards((s) => s.loadingList)
  const loadList = useBoards((s) => s.loadList)
  const loadBoard = useBoards((s) => s.loadBoard)
  const loadingBoardId = useBoards((s) => s.loadingBoardId)
  const snap = useBoards((s) => s.snapshots[boardId])
  const summary = list.find((b) => b.id === boardId) ?? null
  const didRequestList = useRef(false)
  const requestedBoardId = useRef<string | null>(null)

  useEffect(() => {
    if (!summary && !loadingList && !didRequestList.current) {
      didRequestList.current = true
      void loadList().catch(() => { /* stale or missing board reference */ })
    }
  }, [loadList, loadingList, summary])

  useEffect(() => {
    if (!snap && loadingBoardId !== boardId && requestedBoardId.current !== boardId) {
      requestedBoardId.current = boardId
      void loadBoard(boardId).catch(() => { /* handled by unavailable state */ })
    }
  }, [boardId, loadBoard, loadingBoardId, snap])

  const cardsByColumn = useMemo(() => {
    const m = new Map<string, BoardCard[]>()
    if (!snap) return m
    for (const col of snap.columns) m.set(col.id, [])
    for (const card of snap.cards) {
      const arr = m.get(card.columnId)
      if (arr) arr.push(card)
    }
    for (const cards of m.values()) cards.sort((a, b) => a.position - b.position)
    return m
  }, [snap])

  const isBoardPending = !snap && (loadingBoardId === boardId || loadingList || requestedBoardId.current !== boardId)

  if (isBoardPending) {
    return <PeekLoading icon={<IBoard className="w-5 h-5" />} label={t('peek.openingBoard')} />
  }

  if (!snap) {
    return (
      <PeekUnavailable
        icon={<IBoard className="w-5 h-5" />}
        title={t('peek.boardUnavailable')}
        detail={t('peek.boardUnavailableDetail')}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-cloud">
      <PeekHeader
        icon={<IBoard className="w-5 h-5" />}
        label={t('peek.labelBoard')}
        title={snap.title}
        meta={t('peek.boardMeta', {
          columns: snap.columns.length,
          cards: snap.cards.length,
          time: formatShortDate(snap.updatedAt, t),
        })}
        onClose={onClose}
        onOpenFull={onOpenFull}
      />
      {snap.description && (
        <div className="shrink-0 px-4 py-3 border-b border-ink-100 text-[12.5px] leading-relaxed text-ink-600 bg-white/55">
          {snap.description}
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="h-full flex gap-3 p-4">
          {snap.columns.map((col) => {
            const cards = cardsByColumn.get(col.id) ?? []
            return (
              <section key={col.id} className="w-[220px] shrink-0 h-full min-h-0 flex flex-col rounded-[10px] border border-ink-100 bg-white/70">
                <div className="px-3 py-2.5 border-b border-ink-100 flex items-center gap-2">
                  <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-800">{col.title}</div>
                  <span className="text-[11px] font-semibold text-ink-400">{cards.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                  {cards.length === 0 && (
                    <div className="rounded-[8px] border border-dashed border-ink-100 px-3 py-4 text-center text-[11.5px] text-ink-400">
                      {t('peek.empty')}
                    </div>
                  )}
                  {cards.map((card) => (
                    <BoardPeekCard key={card.id} card={card} focused={card.id === focusCardId} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function BoardPeekCard({ card, focused }: { card: BoardCard; focused: boolean }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const assignee = card.assigneeId ? byId[card.assigneeId] : null
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!focused) return
    const id = window.setTimeout(() => {
      ref.current?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
    }, 80)
    return () => window.clearTimeout(id)
  }, [focused])

  return (
    <article
      ref={ref}
      className={cn(
        'rounded-[8px] border px-3 py-2.5 shadow-[0_10px_24px_-22px_rgba(0,80,140,0.35)] transition',
        focused
          ? 'border-sky2-200 bg-sky2-50 ring-2 ring-sky2-100'
          : 'border-ink-100 bg-cloud',
      )}
    >
      {focused && (
        <div className="mb-1.5 inline-flex rounded-full bg-sky2-100 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.12em] text-skype-deep">
          {t('peek.openedFromChat')}
        </div>
      )}
      <div className="text-[12.5px] font-medium leading-snug text-ink-800 line-clamp-3">{card.title}</div>
      {(assignee || card.commentCount > 0 || card.mentions.length > 0) && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-500">
          {assignee && (
            <span className="min-w-0 inline-flex items-center gap-1.5">
              <AvatarMini p={assignee} size={18} />
              <span className="truncate">{assignee.name}</span>
            </span>
          )}
          {card.commentCount > 0 && <span className="ml-auto shrink-0">{t('peek.commentsCount', { count: card.commentCount })}</span>}
          {!assignee && card.mentions.length > 0 && <span className="truncate">@{card.mentions.slice(0, 2).join(' @')}</span>}
        </div>
      )}
    </article>
  )
}

export function CalendarEventPeekContent({
  eventId,
  onClose,
  onOpenFull,
}: {
  eventId: string
  onClose: () => void
  onOpenFull?: () => void
}) {
  const t = useT()
  const loadingEventId = useCalendar((s) => s.loadingEventId)
  const loadEvent = useCalendar((s) => s.loadEvent)
  const removeEvent = useCalendar((s) => s.remove)
  const runEventNow = useCalendar((s) => s.runNow)
  const event = useCalendar((s) => s.events.find((e) => e.id === eventId) ?? null)
  const byId = useParticipants((s) => s.byId)
  const conversations = useConversations((s) => s.list)
  const assignee = event?.assigneeId ? byId[event.assigneeId] : null
  const targetConversation = event?.targetConversationId
    ? conversations.find((c) => c.id === event.targetConversationId) ?? null
    : null
  const didRequestCalendar = useRef(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<null | 'delete' | 'run'>(null)

  useEffect(() => {
    if (!event && loadingEventId !== eventId && !didRequestCalendar.current) {
      didRequestCalendar.current = true
      void loadEvent(eventId).catch((err) => {
        setFailed(err instanceof Error ? err.message : String(err))
      })
    }
  }, [event, eventId, loadEvent, loadingEventId])

  if (!event && !failed) {
    return <PeekLoading icon={<ICalendar className="w-5 h-5" />} label={t('peek.openingEvent')} />
  }

  if (!event) {
    return (
      <PeekUnavailable
        icon={<ICalendar className="w-5 h-5" />}
        title={t('peek.eventUnavailable')}
        detail={failed || t('peek.eventUnavailableDetail')}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-cloud">
      <PeekHeader
        icon={<ICalendar className="w-5 h-5" />}
        label={t('peek.labelCalendarEvent')}
        title={event.title || t('peek.untitledEvent')}
        meta={t('peek.eventMeta', {
          kind: event.kind === 'agent_task' ? t('peek.agentTask') : t('peek.personal'),
          status: event.status,
        })}
        onClose={onClose}
        onOpenFull={onOpenFull}
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
        <section className="rounded-[12px] border border-ink-100 bg-white/75 p-4">
          <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink-800">
            <IClock className="w-4 h-4 text-skype-deep" />
            <span>{formatEventRange(event, t)}</span>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-500">
            <IRepeat className="w-3.5 h-3.5" />
            <span>{describeRecurrence(event.recurrence, t)}</span>
          </div>
          {event.description && (
            <p className="mt-4 text-[13px] leading-relaxed text-ink-700 whitespace-pre-wrap">{event.description}</p>
          )}
        </section>

        <div className="mt-3 grid gap-3">
          {assignee && (
            <section className="rounded-[12px] border border-ink-100 bg-white/65 p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-400">{t('peek.assignee')}</div>
              <div className="mt-2 flex items-center gap-2">
                <AvatarMini p={assignee} size={24} />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-ink-900">{assignee.name}</div>
                  <div className="truncate text-[11.5px] text-ink-500">{assignee.role || assignee.kind}</div>
                </div>
              </div>
            </section>
          )}

          {targetConversation && (
            <section className="rounded-[12px] border border-ink-100 bg-white/65 p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-ink-400">{t('peek.conversation')}</div>
              <div className="mt-1 truncate text-[13px] font-semibold text-ink-900">{targetConversation.title}</div>
              {targetConversation.subtitle && (
                <div className="mt-0.5 truncate text-[11.5px] text-ink-500">{targetConversation.subtitle}</div>
              )}
            </section>
          )}

          {event.agentPrompt && (
            <section className="rounded-[12px] border border-sky2-100 bg-sky2-50/45 p-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-skype-deep">{t('peek.agentPrompt')}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-700 whitespace-pre-wrap">{event.agentPrompt}</p>
            </section>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-ink-100 px-4 py-3 flex items-center gap-2"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 12px)' }}
      >
        <div className="flex-1 min-w-0 text-[11px] text-ink-400 truncate">
          {t('peek.createdUpdated', { a: formatShortDate(event.createdAt, t), b: formatShortDate(event.updatedAt, t) })}
        </div>
        {event.kind === 'agent_task' && (
          <button
            type="button"
            onClick={async () => {
              if (busy) return
              setBusy('run')
              try { await runEventNow(event.id) } catch (err) { console.warn('runNow failed', err) }
              setBusy(null)
            }}
            disabled={busy !== null}
            className="py-1.5 px-3 text-[12px] font-semibold rounded-full bg-sky2-50 text-skype-deep border border-sky2-100 active:bg-sky2-100 transition disabled:opacity-60"
          >{busy === 'run' ? t('peek.running') : t('peek.runNow')}</button>
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="py-1.5 px-3 text-[12px] font-semibold rounded-full bg-cloud text-ink-700 border border-ink-100 active:bg-sky2-50 transition"
        >{t('peek.edit')}</button>
        <button
          type="button"
          onClick={async () => {
            if (busy) return
            if (!confirm(t('peek.deleteConfirm', { title: event.title || t('peek.untitledEvent') }))) return
            setBusy('delete')
            try {
              await removeEvent(event.id)
              onClose()
            } catch (err) {
              console.warn('delete failed', err)
              setBusy(null)
            }
          }}
          disabled={busy !== null}
          className="py-1.5 px-3 text-[12px] font-semibold rounded-full text-coral-deep border border-coral-soft active:bg-coral-soft/40 transition disabled:opacity-60"
        >{t('peek.delete')}</button>
      </div>
      {editing && (
        <EventEditor event={event} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}