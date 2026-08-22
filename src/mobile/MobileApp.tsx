import { lazy, Suspense, useEffect, useState } from 'react'
import { AnimatePresence, motion, useTransform, type MotionValue } from 'framer-motion'
import { useApp } from '@/stores/app'
import { useT } from '@/lib/i18n'
import { MobileChatList } from './MobileChatList'
import { MobileChat, MobileChatInfo } from './MobileChat'
import { MobileTabBar } from './MobileTabBar'
import { MobileWhispersList, MobileWhisperRoom } from './MobileWhispers'
import { MobileConvene } from './MobileConvene'
import { MobileLibrary } from './MobileLibrary'
import { MobileAgents } from './MobileAgents'
import { MobileMe } from './MobileMe'
import { DocumentEditor } from '@/components/DocumentEditor'
import { BoardPeekContent, CalendarEventPeekContent } from '@/components/ArtifactPeekContent'
import { useDocuments } from '@/stores/documents'
import { IDoc } from '@/components/icons'
import { initPushNotifications } from '@/lib/push'
import { MobileParticipantInfo } from './MobileParticipantInfo'
import { useSwipeBackProps } from './useSwipeBack'
import { ViewBoundary } from './ViewBoundary'

const ShippingWorkspace = lazy(() => import('@/components/ShippingWorkspace').then((module) => ({ default: module.ShippingWorkspace })))

/** iOS UINavigationController push/pop spring. CRITICALLY DAMPED:
 *  damping ratio ζ = damping / (2·√(k·m)) = 38 / (2·√320) ≈ 1.06,
 *  i.e. juuust on the overdamped side of critical. The earlier
 *  "softer" attempt at 320/30 had ζ ≈ 0.84 — visibly underdamped —
 *  which made the entry slide overshoot ~3% past zero before
 *  settling, reading as "the page bounces left after it lands".
 *  Critical damping is what UIKit's default push uses; we match
 *  that here so there is no overshoot. Spring (not tween) is still
 *  the right transition type because the swipe-back commit reuses
 *  the same curve with the user's release velocity carried over. */
const slideTransition = { type: 'spring' as const, stiffness: 320, damping: 38, mass: 1 }
/** Cross-tab fades. iOS's UITabBarController doesn't animate the
 *  swap at all (just a hard cut on selection), but a hard cut on a
 *  hybrid app where each tab has loading time / network state reads
 *  as "jank". 140ms is just long enough to mask the layout pop. */
const fadeTransition = { duration: 0.14, ease: [0.4, 0, 0.2, 1] as const }

function MobileDocumentPeek({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const t = useT()
  const loaded = useDocuments((s) => s.loaded)
  const load = useDocuments((s) => s.load)
  const doc = useDocuments((s) => s.list.find((d) => d.id === documentId) ?? null)

  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  if (!loaded) {
    return (
      <div className="h-full bg-cloud grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-ink-400">
          <div className="w-12 h-12 rounded-[12px] grid place-items-center bg-sky2-50 text-skype-deep">
            <IDoc className="w-5 h-5" />
          </div>
          <div className="text-[12.5px] font-display italic">{t('mapp.openingDoc')}</div>
        </div>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="h-full bg-cloud grid place-items-center px-8 text-center">
        <div className="max-w-[260px]">
          <div className="mx-auto w-12 h-12 rounded-[12px] grid place-items-center bg-coral-soft/45 text-coral-deep">
            <IDoc className="w-5 h-5" />
          </div>
          <div className="mt-3 text-[14px] font-semibold text-ink-900">{t('mapp.docUnavailable')}</div>
          <div className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            {t('mapp.docUnavailableBody')}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-4 h-8 px-3 rounded-[8px] text-[12px] font-semibold text-ink-600 border border-ink-100 hover:bg-sky2-50 transition"
          >
            {t('mapp.docUnavailableClose')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <DocumentEditor
      documentId={documentId}
      variant="peek"
      onClose={onClose}
    />
  )
}

export function MobileApp() {
  const t = useT()
  const view = useApp((s) => s.view)
  const convoId = useApp((s) => s.selectedConversationId)
  const stack = useApp((s) => s.mobileStack)
  const pushStack = useApp((s) => s.pushMobileStack)
  const documentId = useApp((s) => s.openDocumentId)
  const closeDocumentPeek = useApp((s) => s.closeDocumentPeek)
  const boardId = useApp((s) => s.openBoardId)
  const boardCardId = useApp((s) => s.openBoardCardId)
  const closeBoardPeek = useApp((s) => s.closeBoardPeek)
  const calendarEventId = useApp((s) => s.openCalendarEventId)
  const closeCalendarEventPeek = useApp((s) => s.closeCalendarEventPeek)
  // Mobile reuses the desktop `infoAgentId` flag — tapping an avatar or
  // mention chip anywhere flips it on, which we surface as a slide-up
  // overlay (MobileParticipantInfo) below.
  const infoParticipantId = useApp((s) => s.infoAgentId)
  const closeAgentInfo = useApp((s) => s.closeAgentInfo)
  const [whisperId, setWhisperId] = useState<string | null>(null)

  // Edge-swipe-back gestures for deep screens. Hooks are called
  // unconditionally (the per-page motion.div is conditional, but the
  // hooks need to be stable across renders).
  const chatSwipe = useSwipeBackProps(() => pushStack('list'))
  const infoSwipe = useSwipeBackProps(() => pushStack('chat'))
  const whisperSwipe = useSwipeBackProps(() => setWhisperId(null))
  const participantSwipe = useSwipeBackProps(() => closeAgentInfo())

  // Parallax — when a top layer (chat / info / whisper room) is
  // sliding right under the user's finger, the layer ABOUT TO BE
  // REVEALED needs to peek in from the left at ~30% the speed.
  // iOS uses ~30% parallax, which is what these transforms emulate.
  // The transforms react to the SAME motion value that drives the
  // top layer's drag + AnimatePresence enter/exit, so the
  // background slides in as the foreground slides out, no extra
  // wiring needed.
  const listPeekX = useParallax(chatSwipe.x)
  const whisperListPeekX = useParallax(whisperSwipe.x)
  const artifactKey = documentId
    ? `doc-${documentId}`
    : boardId
      ? `board-${boardId}`
      : calendarEventId
        ? `calendar-${calendarEventId}`
        : null

  useEffect(() => {
    if (!convoId && stack !== 'list') pushStack('list')
  }, [convoId, stack, pushStack])

  // Wire push registration (APNs on iOS, FCM on Android) once the authed
  // mobile shell mounts. Soft no-op on web / Electron. The initializer is
  // idempotent — re-mounts (e.g. on company switch) won't re-prompt because
  // Capacitor caches the decision.
  useEffect(() => {
    void initPushNotifications()
  }, [])

  // hide tab bar in deep flows
  const showTabBar =
    !(view === 'conversations' && (stack === 'chat' || stack === 'info')) &&
    !(view === 'whispers' && whisperId !== null) &&
    !infoParticipantId

  return (
    <div className="relative z-10 h-[100dvh] w-screen flex flex-col bg-paper">
      <main className="flex-1 relative overflow-hidden">
        {/* Top-level view switcher — was previously
            `<AnimatePresence mode="wait">`, which serializes exits
            before the next enter. Problem: if ANY nested exit got
            stuck (e.g. a MotionValue still being driven by a stale
            drag handler, or framer-motion losing track of a child
            during a fast tab tap), the outer wait blocked forever
            and the new tab never mounted → persistent white screen
            that only `kill app + relaunch` could clear.
            Default mode (sync) lets the old view's fade-out and the
            new view's fade-in overlap for the ~140ms transition.
            They're both `absolute inset-0`, so the overlap reads
            as a smooth crossfade, not jank. Worst case: even if an
            exit really IS stuck, the new view still mounts on top
            and the user can keep working. */}
        <AnimatePresence>
          {/* CONVERSATIONS view — list is always rendered when this
              view is active so it can peek behind the chat / info
              overlays via parallax during swipe-back. */}
          {view === 'conversations' && (
            <motion.div key="conv-root" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Chats">
              {/* List (parallax background). `isolate` pins the
                  list's internal `z-10` sticky header inside this
                  layer's own stacking context, so it can't paint
                  on top of the chat/info overlays above. */}
              <motion.div
                className="absolute inset-0 isolate"
                // `willChange: transform` promotes the parallax
                // background to its own GPU layer so its translate
                // doesn't repaint the chat list inside on every drag
                // frame.
                style={{
                  x: stack === 'chat' ? listPeekX : 0,
                  zIndex: 0,
                  willChange: 'transform',
                }}
              >
                <MobileChatList />
              </motion.div>
              {/* Chat / Info overlays. Explicit `zIndex: 1` +
                  inline opaque background guarantees they sit
                  above the parallax list AND fully occlude it
                  regardless of Tailwind's purge / class order. */}
              <AnimatePresence>
                {/* Chat stays MOUNTED while Info is open (note the `|| info`)
                    so it sits directly beneath the info card. Swiping the
                    info card away then reveals the chat that's already
                    there — instead of the old bug where chat unmounted at
                    stack 'info', the swipe uncovered the LIST, and chat then
                    replayed its slide-in entrance on the way back. Keeping
                    it mounted also preserves the chat's scroll position. */}
                {(stack === 'chat' || stack === 'info') && (
                  <motion.div key="conv-chat" className="absolute inset-0"
                    initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
                    transition={slideTransition}
                    {...chatSwipe.props}
                    style={{ ...chatSwipe.props.style, background: 'var(--paper)', zIndex: 1 }}>
                    <MobileChat />
                  </motion.div>
                )}
                {/* Info card sits ABOVE the chat (zIndex 2). */}
                {stack === 'info' && (
                  <motion.div key="conv-info" className="absolute inset-0"
                    initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
                    transition={slideTransition}
                    {...infoSwipe.props}
                    style={{ ...infoSwipe.props.style, background: 'var(--paper)', zIndex: 2 }}>
                    <MobileChatInfo />
                  </motion.div>
                )}
              </AnimatePresence>
              </ViewBoundary>
            </motion.div>
          )}

          {/* WHISPERS view — same pattern: whisper list is always
              the background; whisper room slides in on top with the
              list parallaxing as it goes. */}
          {view === 'whispers' && (
            <motion.div key="wh-root" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Whispers">
              <motion.div
                className="absolute inset-0 isolate"
                style={{
                  x: whisperId !== null ? whisperListPeekX : 0,
                  zIndex: 0,
                  willChange: 'transform',
                }}
              >
                <MobileWhispersList onSelect={setWhisperId} />
              </motion.div>
              <AnimatePresence>
                {whisperId !== null && (
                  <motion.div key={`wh-room-${whisperId}`} className="absolute inset-0"
                    initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
                    transition={slideTransition}
                    {...whisperSwipe.props}
                    style={{ ...whisperSwipe.props.style, background: 'var(--paper)', zIndex: 1 }}>
                    <MobileWhisperRoom pairId={whisperId} onBack={() => setWhisperId(null)} />
                  </motion.div>
                )}
              </AnimatePresence>
              </ViewBoundary>
            </motion.div>
          )}

          {/* CONVENE view — reachable from chat header, shows empty state on its own */}
          {view === 'convene' && (
            <motion.div key="convene" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Convene"><MobileConvene /></ViewBoundary>
            </motion.div>
          )}

          {/* LIBRARY view — documents, boards, calendar */}
          {view === 'library' && (
            <motion.div key="library" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Library"><MobileLibrary /></ViewBoundary>
            </motion.div>
          )}

          {/* SHIP view — end-to-end contract, verification, release, and learning loop */}
          {view === 'shipping' && (
            <motion.div key="shipping" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Ship"><Suspense fallback={<div className="h-full grid place-items-center text-sm text-ink-400">{t('mapp.openingShip')}</div>}><ShippingWorkspace compact /></Suspense></ViewBoundary>
            </motion.div>
          )}

          {/* AGENTS view */}
          {view === 'agents' && (
            <motion.div key="agents" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Agents"><MobileAgents /></ViewBoundary>
            </motion.div>
          )}

          {/* ME view */}
          {view === 'me' && (
            <motion.div key="me" className="absolute inset-0"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={fadeTransition}>
              <ViewBoundary name="Me"><MobileMe /></ViewBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {showTabBar && <MobileTabBar />}
      <AnimatePresence>
        {artifactKey && (
          <motion.div
            key={artifactKey}
            className="absolute inset-0 z-40 bg-cloud"
            initial={{ y: '6%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '6%', opacity: 0 }}
            transition={slideTransition}
          >
            {documentId ? (
              <MobileDocumentPeek documentId={documentId} onClose={closeDocumentPeek} />
            ) : boardId ? (
              <BoardPeekContent boardId={boardId} focusCardId={boardCardId} onClose={closeBoardPeek} />
            ) : calendarEventId ? (
              <CalendarEventPeekContent eventId={calendarEventId} onClose={closeCalendarEventPeek} />
            ) : null}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Participant detail — slides in from the right when an avatar /
          mention chip is tapped. Sits on top of artifact peeks so a
          mention click inside a doc peek still navigates the user to
          the profile cleanly. */}
      <AnimatePresence>
        {infoParticipantId && (
          <motion.div
            key={`participant-${infoParticipantId}`}
            className="absolute inset-0 z-50 bg-paper"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={slideTransition}
            {...participantSwipe.props}
          >
            <MobileParticipantInfo />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Derive a parallax `x` for the layer SITTING UNDERNEATH a swipe-
 *  back top layer. iOS-native push/pop uses ~30% — the background
 *  moves at 30% the speed of the foreground. At top rest (x=0) the
 *  background sits 30%w to the left (just out of view); at top
 *  fully off (x=width) the background is centered (x=0).
 *
 *  Reads `window.innerWidth` ONCE per mount (cached + resized).
 *  Reading it inside the per-frame transform callback caused a layout
 *  flush every drag frame — measurable jank during the swipe. */
function useParallax(topX: MotionValue<number>) {
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth || 390 : 390))
  useEffect(() => {
    const onResize = () => setW(window.innerWidth || 390)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return useTransform(topX, (v) => -w * 0.3 + (v / w) * (w * 0.3))
}
