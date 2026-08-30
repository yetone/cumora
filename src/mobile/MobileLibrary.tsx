/**
 * Mobile Library — Documents, Boards, Calendar in one tab.
 *
 * Each subview reads the same store the desktop view uses (no mock data)
 * and opens artifacts through the existing artifact-peek channel
 * (openDocumentPeek / openBoardPeek / openCalendarEventPeek). The peek
 * pane in MobileApp slides up the shared editor / kanban / event UI.
 */
import { useEffect, useState } from 'react'
import { useApp } from '@/stores/app'
import { useAuth } from '@/stores/auth'
import { useDocuments } from '@/stores/documents'
import { useBoards } from '@/stores/boards'
import { useParticipants } from '@/stores/participants'
import { IDoc, IBoard, ICalendar, IPlus } from '@/components/icons'
import { MobileCalendar } from './MobileCalendar'
import { EventEditor } from '@/components/EventEditor'
import { cn } from '@/lib/utils'
import { useT, type MessageKey, useTLabel } from '@/lib/i18n'

type LibTab = 'documents' | 'boards' | 'calendar'

const TABS: Array<{ key: LibTab; label: string; Icon: typeof IDoc }> = [
  { key: 'documents', label: 'Documents', Icon: IDoc },
  { key: 'boards', label: 'Boards', Icon: IBoard },
  { key: 'calendar', label: 'Calendar', Icon: ICalendar },
]
// i18n: parallel lookup so the TABS shape above stays upstream-mergeable.
const TAB_LABEL_KEY: Record<LibTab, MessageKey> = {
  documents: 'moblib.tabDocuments',
  boards: 'moblib.tabBoards',
  calendar: 'moblib.tabCalendar',
}

export function MobileLibrary() {
  // i18n: prefer the translated key, fall back to the inline English.
  const tLabel = useTLabel()
  const [tab, setTab] = useState<LibTab>('documents')
  const create = useDocuments((s) => s.create)
  const createBoard = useBoards((s) => s.createBoard)
  const openDocumentPeek = useApp((s) => s.openDocumentPeek)
  const openBoardPeek = useApp((s) => s.openBoardPeek)
  const [creating, setCreating] = useState(false)
  const [eventEditorOpen, setEventEditorOpen] = useState(false)

  const onPlus = async () => {
    if (creating) return
    if (tab === 'calendar') {
      setEventEditorOpen(true)
      return
    }
    setCreating(true)
    try {
      if (tab === 'documents') {
        const d = await create({ title: tLabel('docs.untitled', 'Untitled') })
        openDocumentPeek(d.id)
      } else if (tab === 'boards') {
        const id = await createBoard(tLabel('moblib.untitledBoard', 'Untitled board'))
        openBoardPeek(id, null)
      }
    } catch (err) {
      console.warn('[library] create failed', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="relative flex flex-col h-full bg-paper">
      <div className="sticky top-0 z-10 backdrop-blur-md bg-paper/95"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <div className="px-4 pt-2 pb-2">
          <h1 className="font-display font-medium text-[26px] tracking-tight text-ink-900 leading-none">
            Library
          </h1>
          <div className="text-[12.5px] text-ink-500 mt-0.5 font-display italic">
            documents, boards & schedule
          </div>
        </div>
        <div className="px-3 pb-3 flex gap-1.5">
          {TABS.map(({ key, label, Icon }) => {
            const active = tab === key
            return (
              <button
                type="button"
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  'flex-1 py-2 px-3 rounded-[10px] text-[12.5px] font-semibold flex items-center justify-center gap-1.5 transition border',
                  active
                    ? 'bg-sky2-50 text-skype-deep border-sky2-200'
                    : 'bg-cloud text-ink-500 border-ink-100 active:bg-sky2-50',
                )}
              >
                <Icon className="w-[14px] h-[14px]" strokeWidth={active ? 2 : 1.6} />
                {tLabel(TAB_LABEL_KEY[key], label)}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === 'documents' && <DocumentsList />}
        {tab === 'boards' && <BoardsList />}
        {tab === 'calendar' && <MobileCalendar />}
      </div>

      {/* Universal FAB anchored to the section, not the scroller — so
          it stays in viewport while the user scrolls a long month grid
          or board list. Color/label switch per-tab to keep the affordance
          honest about what + means. */}
      <button
        type="button"
        onClick={onPlus}
        disabled={creating}
        aria-label={tab === 'documents' ? 'New document' : tab === 'boards' ? 'New board' : 'New event'}
        className="absolute right-4 bottom-4 z-20 w-14 h-14 rounded-full grid place-items-center text-white active:scale-95 transition disabled:opacity-50"
        style={{
          background: tab === 'documents'
            ? 'linear-gradient(135deg, var(--skype), var(--skype-deep))'
            : tab === 'boards'
              ? 'linear-gradient(135deg, #7C5CFF, #5340CC)'
              : 'linear-gradient(135deg, var(--coral), var(--coral-deep))',
          boxShadow: tab === 'documents'
            ? '0 12px 28px -8px rgba(0, 168, 240, 0.5), 0 0 0 1px rgba(0, 80, 140, 0.06)'
            : tab === 'boards'
              ? '0 12px 28px -8px rgba(124, 92, 255, 0.55), 0 0 0 1px rgba(60, 30, 140, 0.06)'
              : '0 12px 28px -8px rgba(255, 122, 107, 0.5), 0 0 0 1px rgba(180, 60, 50, 0.06)',
        }}
      >
        <IPlus className="w-6 h-6" strokeWidth={2} />
      </button>

      {eventEditorOpen && (
        <EventEditor event={null} onClose={() => setEventEditorOpen(false)} />
      )}
    </section>
  )
}

function timeAgo(iso: string, t: ReturnType<typeof useT>): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return t('docs.justNow')
  if (ms < 3600_000) return t('docs.minutesAgo', { n: Math.floor(ms / 60_000) })
  if (ms < 86_400_000) return t('docs.hoursAgo', { n: Math.floor(ms / 3_600_000) })
  return new Date(iso).toLocaleDateString()
}

function DocumentsList() {
  const t = useT()
  const tLabel = useTLabel()
  const list = useDocuments((s) => s.list)
  const loaded = useDocuments((s) => s.loaded)
  const load = useDocuments((s) => s.load)
  const openDocumentPeek = useApp((s) => s.openDocumentPeek)
  const byId = useParticipants((s) => s.byId)
  const me = useAuth((s) => s.user)

  useEffect(() => { void load() }, [load])

  return (
    <div className="pb-24">
      {!loaded && (
        <div className="px-6 py-10 text-center text-[13px] text-ink-300 font-display italic">{t('common.loading')}</div>
      )}
      {loaded && list.length === 0 && (
        <div className="px-6 py-12 text-center text-[13px] text-ink-500 font-display italic leading-relaxed">
          No documents yet. Tap the + to create one — humans and agents both edit live.
        </div>
      )}
      <div className="divide-y divide-ink-100">
        {list.map((d) => {
          const author = byId[d.createdBy]
          const authorName = author?.name ?? (d.createdBy === me?.id ? 'You' : d.createdBy)
          return (
            <button
              type="button"
              key={d.id}
              onClick={() => openDocumentPeek(d.id)}
              className="w-full text-left grid grid-cols-[36px_1fr_auto] gap-3 py-3 px-4 active:bg-sky2-50 transition"
            >
              <div className="w-9 h-9 rounded-[10px] grid place-items-center bg-sky2-50 text-skype-deep">
                <IDoc className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-ink-900 truncate">{d.title || tLabel('docs.untitled', 'Untitled')}</div>
                <div className="text-[11.5px] text-ink-500 truncate font-display italic">
                  {authorName} · {timeAgo(d.updatedAt, t)}
                </div>
              </div>
              <span className="self-center text-ink-300 text-[18px]">›</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function BoardsList() {
  const t = useT()
  const tLabel = useTLabel()
  const list = useBoards((s) => s.list)
  const loadingList = useBoards((s) => s.loadingList)
  const loadList = useBoards((s) => s.loadList)
  const openBoardPeek = useApp((s) => s.openBoardPeek)
  const byId = useParticipants((s) => s.byId)
  const me = useAuth((s) => s.user)

  useEffect(() => { void loadList() }, [loadList])

  return (
    <div className="pb-24">
      {loadingList && list.length === 0 && (
        <div className="px-6 py-10 text-center text-[13px] text-ink-300 font-display italic">{t('common.loading')}</div>
      )}
      {!loadingList && list.length === 0 && (
        <div className="px-6 py-12 text-center text-[13px] text-ink-500 font-display italic leading-relaxed">
          No boards yet. Tap the + to start one — agents can move cards through it on their own.
        </div>
      )}
      <div className="divide-y divide-ink-100">
        {list.map((b) => {
          const author = byId[b.createdBy]
          const authorName = author?.name ?? (b.createdBy === me?.id ? 'You' : b.createdBy)
          return (
            <button
              type="button"
              key={b.id}
              onClick={() => openBoardPeek(b.id, null)}
              className="w-full text-left grid grid-cols-[36px_1fr_auto] gap-3 py-3 px-4 active:bg-sky2-50 transition"
            >
              <div className="w-9 h-9 rounded-[10px] grid place-items-center text-skype-deep"
                style={{ background: 'rgba(124, 92, 255, 0.10)' }}>
                <IBoard className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-ink-900 truncate">{b.title || tLabel('moblib.untitledBoard', 'Untitled board')}</div>
                <div className="text-[11.5px] text-ink-500 truncate font-display italic">
                  {b.description ? b.description : `${authorName} · ${timeAgo(b.updatedAt, t)}`}
                </div>
              </div>
              <span className="self-center text-ink-300 text-[18px]">›</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

