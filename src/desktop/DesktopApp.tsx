import { lazy, Suspense, useEffect } from 'react'
import { useApp } from '@/stores/app'
import { useDevtools } from '@/stores/devtools'
import { isElectron } from '@/lib/runtime'
import { useResizableWidth } from '@/lib/useResizableWidth'
import { TitleBar } from './TitleBar'
import { Rail } from './Rail'
import { ConversationsPane } from './ConversationsPane'
import { ChatPane } from './ChatPane'
import { InfoPane } from './InfoPane'
import { ThreadDrawer } from './ThreadDrawer'
import { DocumentPeekPane } from './DocumentPeekPane'
import { BoardPeekPane } from './BoardPeekPane'
import { CalendarPeekPane } from './CalendarPeekPane'
import { WhispersView } from './WhispersView'
import { ConveneView } from './ConveneView'
import { AgentsView } from './AgentsView'
import { BoardsView } from './BoardsView'
import { CalendarView } from './CalendarView'
import { DocumentsView } from './DocumentsView'
import { ObservabilityView } from './ObservabilityView'
import { MeView } from './MeView'
import { EmailComposer } from '@/components/EmailComposer'
import { useT } from '@/lib/i18n'

const ShippingView = lazy(() => import('./ShippingView').then((module) => ({ default: module.ShippingView })))

function ConversationsLayout() {
  const infoOpen = useApp((s) => s.infoAgentId !== null)
  const threadOpen = useApp((s) => s.openThread !== null)
  const documentOpen = useApp((s) => s.openDocumentId !== null)
  const boardOpen = useApp((s) => s.openBoardId !== null)
  const calendarOpen = useApp((s) => s.openCalendarEventId !== null)
  // Thread + info + artifact peeks compete for the same right slot. Opening one closes the
  // other implicitly via the store action (see openThreadView /
  // openAgentInfo / artifact peek actions). Render thread if both somehow
  // ended up set, since the thread is the more action-oriented pane.
  const artifactOpen = documentOpen || boardOpen || calendarOpen
  const rightOpen = threadOpen || infoOpen || artifactOpen
  const rightColumn = documentOpen || boardOpen ? 'clamp(420px, 42vw, 640px)' : '420px'
  const { width, onResizeStart } = useResizableWidth('sidebar:conversations', 320, { min: 240, max: 520 })
  return (
    <div
      className="grid h-full overflow-hidden"
      style={{ gridTemplateColumns: rightOpen ? `${width}px minmax(0, 1fr) ${rightColumn}` : `${width}px minmax(0, 1fr)` }}
    >
      <ConversationsPane onResizeStart={onResizeStart} />
      <ChatPane />
      {threadOpen
        ? <ThreadDrawer />
        : documentOpen
          ? <DocumentPeekPane />
          : boardOpen
            ? <BoardPeekPane />
            : calendarOpen
              ? <CalendarPeekPane />
              : infoOpen
                ? <InfoPane />
                : null}
    </div>
  )
}

export function DesktopApp() {
  const t = useT()
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const devtoolsEnabled = useDevtools((s) => s.enabled)
  const devtoolsLoaded = useDevtools((s) => s.loaded)
  const loadDevtools = useDevtools((s) => s.load)

  useEffect(() => {
    void loadDevtools()
  }, [loadDevtools])

  useEffect(() => {
    if (view === 'observability' && devtoolsLoaded && !devtoolsEnabled) setView('conversations')
  }, [devtoolsEnabled, devtoolsLoaded, setView, view])

  // In Electron, fill the full window. In browser, render as a "windowed app" card.
  const wrap = isElectron
    ? {
        width: '100vw',
        height: '100vh',
        margin: 0,
        borderRadius: 0,
        boxShadow: 'none',
      }
    : {
        width: 'min(1480px, calc(100vw - 48px))',
        height: 'calc(100vh - 48px)',
        boxShadow: '0 50px 100px -20px rgba(10, 30, 60, 0.25), 0 30px 60px -30px rgba(10, 30, 60, 0.3), 0 0 0 1px rgba(0, 80, 140, 0.06)',
      }

  return (
    <div
      className={isElectron ? 'relative z-10 bg-cloud overflow-hidden grid grid-rows-[44px_1fr]' : 'relative z-10 mx-auto my-6 bg-cloud rounded-[18px] overflow-hidden grid grid-rows-[44px_1fr] backdrop-blur'}
      style={wrap}
    >
      <TitleBar />
      <div className="grid h-full min-h-0 overflow-hidden" style={{ gridTemplateColumns: '72px minmax(0, 1fr)' }}>
        <Rail />
        {view === 'conversations' && <ConversationsLayout />}
        {view === 'whispers' && <WhispersView />}
        {view === 'convene' && <ConveneView />}
        {view === 'agents' && <AgentsView />}
        {view === 'boards' && <BoardsView />}
        {view === 'calendar' && <CalendarView />}
        {view === 'documents' && <DocumentsView />}
        {view === 'shipping' && <Suspense fallback={<div className="h-full grid place-items-center text-sm text-ink-400">{t('desktop.openingShip')}</div>}><ShippingView /></Suspense>}
        {view === 'observability' && devtoolsEnabled && <ObservabilityView />}
        {view === 'me' && <MeView />}
      </div>
      {/* Email composer drawer — globally rendered so opening it works
          from any view (sidebar Compose CTA, EmailCard reply button). */}
      <EmailComposer />
    </div>
  )
}
