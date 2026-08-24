import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@/stores/app'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { Avatar } from '@/components/Avatar'
import { api, ws, type ApiConveneSession, type ApiConveneTranscript } from '@/api/client'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

interface ConveneState {
  session: ApiConveneSession | null
  transcript: ApiConveneTranscript[]
}

export function ConveneView() {
  const t = useT()
  const convoId = useApp((s) => s.selectedConversationId)
  const conversations = useConversations((s) => s.list)
  const c = useMemo(() => conversations.find((x) => x.id === convoId), [conversations, convoId])
  const byId = useParticipants((s) => s.byId)
  const [state, setState] = useState<ConveneState>({ session: null, transcript: [] })

  useEffect(() => {
    if (!convoId) return
    api.getActiveConvene(convoId).then(async (session) => {
      if (session) {
        const transcript = await api.getConveneTranscript(session.id)
        setState({ session, transcript })
      } else {
        setState({ session: null, transcript: [] })
      }
    }).catch(() => setState({ session: null, transcript: [] }))
  }, [convoId])

  useEffect(() => {
    const off = ws.on((e) => {
      if (e.type !== 'convene') return
      if (state.session && e.sessionId !== state.session.id) return
      if (e.kind === 'started') {
        const session = e.data as ApiConveneSession
        if (session.conversation_id === convoId) setState({ session, transcript: [] })
      } else if (e.kind === 'transcript' && e.data) {
        const entry = e.data as ApiConveneTranscript
        setState((s) => ({ ...s, transcript: [...s.transcript, entry] }))
      } else if (e.kind === 'ended') {
        setState((s) => s.session ? { ...s, session: { ...s.session, state: 'ended' } } : s)
      }
    })
    return off
  }, [convoId, state.session])

  const tiles = useMemo(() => {
    const ids = c?.members ?? []
    return ids.map((id) => byId[id]).filter(Boolean)
  }, [c?.members, byId])

  const startConvene = async () => {
    if (!convoId) return
    try {
      const session = await api.startConvene(convoId, c?.title ?? t('convene.sessionTitleFallback'))
      setState({ session, transcript: [] })
    } catch (err) { console.warn(err) }
  }

  if (!convoId || !c) {
    return (
      <main className="grid place-items-center"
        style={{ background: 'radial-gradient(ellipse 80% 50% at 50% 100%, rgba(143, 211, 247, 0.18), transparent 60%), var(--paper)' }}>
        <div className="text-center">
          <div className="font-display font-medium text-[24px] text-ink-900 mb-2" style={{ letterSpacing: '-0.02em' }}>
            {t('convene.pickConvo')}
          </div>
          <div className="font-display italic text-[14px] text-ink-500">
            {t('convene.pickConvoSub')}
          </div>
        </div>
      </main>
    )
  }

  if (!state.session || state.session.state === 'ended') {
    return (
      <main className="grid place-items-center"
        style={{ background: 'radial-gradient(ellipse 80% 50% at 50% 100%, rgba(143, 211, 247, 0.18), transparent 60%), var(--paper)' }}>
        <div className="text-center max-w-sm">
          <div className="font-display font-medium text-[24px] text-ink-900 mb-2" style={{ letterSpacing: '-0.02em' }}>
            {state.session ? t('convene.lastWrapped') : t('convene.noLive')}
          </div>
          <div className="font-display italic text-[14px] text-ink-500 mb-5">
            {t('convene.ctaSub', { title: c.title })}
          </div>
          <button
            onClick={startConvene}
            className="py-3 px-5 rounded-full text-white text-[13.5px] font-semibold inline-flex items-center gap-2"
            style={{ background: 'linear-gradient(135deg, var(--skype), var(--skype-deep))', boxShadow: '0 6px 16px -4px rgba(0, 168, 240, 0.5)' }}>
            {t('convene.startBtn')}
          </button>
        </div>
      </main>
    )
  }

  return (
    <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: '1fr 360px', gridTemplateRows: 'auto 1fr' }}>
      <div className="col-span-2 py-2.5 px-5 flex items-center gap-3.5 border-b border-ink-100"
        style={{ background: 'linear-gradient(90deg, rgba(255, 122, 107, 0.08) 0%, rgba(0, 168, 240, 0.06) 100%)' }}>
        <div className="inline-flex items-center gap-2 py-1.5 px-3 bg-coral-deep text-white rounded-full text-[10.5px] font-extrabold tracking-[0.12em] uppercase">
          <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse-soft" />
          {t('convene.live')}
        </div>
        <div className="font-display font-medium text-[17px] text-ink-900" style={{ letterSpacing: '-0.01em' }}>
          {state.session.title}
        </div>
        {state.session.flair && (
          <em className="italic text-coral-deep" style={{ fontStyle: 'italic', fontWeight: 400 }}>{state.session.flair}</em>
        )}
        <div className="text-[12px] text-ink-500 ml-auto">
          {t('convene.startedAt', { time: new Date(state.session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
        </div>
      </div>

      <main className="overflow-hidden flex flex-col"
        style={{ background: 'radial-gradient(ellipse 80% 50% at 50% 100%, rgba(143, 211, 247, 0.18), transparent 60%), var(--paper)' }}>
        <section className="grid gap-3 p-4 px-[22px]"
          style={{ gridTemplateColumns: `repeat(${Math.min(5, tiles.length)}, 1fr)` }}>
          {tiles.map((p) => {
            const isSpeaking = state.transcript.length > 0 && state.transcript[state.transcript.length - 1].authorId === p.id
            return (
              <div key={p.id}
                className={cn('relative rounded-[14px] p-3 overflow-hidden transition bg-cloud',
                  isSpeaking && 'ring-2 ring-skype shadow-[0_0_0_3px_rgba(0,168,240,0.15)]')}
                style={{ border: '1.5px solid var(--ink-100)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Avatar p={p} size={32} />
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-ink-900 leading-tight">{p.name}</div>
                    <div className="font-display italic font-normal text-[11px] text-ink-500 leading-tight">{p.role ?? p.kind}</div>
                  </div>
                </div>
                <div className="text-[11.5px] font-semibold flex items-center gap-1.5"
                  style={{ color: isSpeaking ? 'var(--skype-deep)' : `var(--${p.status})` }}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse-soft" style={{ background: isSpeaking ? 'var(--skype)' : `var(--${p.status})` }} />
                  {isSpeaking
                    ? t('convene.statusSpeaking')
                    : p.status === 'thinking'
                      ? t('convene.statusThinking')
                      : p.status === 'working'
                        ? t('convene.statusWorking')
                        : t('convene.statusListening')}
                </div>
              </div>
            )
          })}
        </section>

        <div className="flex-1 overflow-y-auto p-6 max-w-3xl mx-auto w-full">
          {state.transcript.map((entry) => {
            if (entry.kind === 'decision' && entry.decision) {
              return (
                <div key={entry.id} className="my-4 py-3.5 px-4 rounded-[12px] relative"
                  style={{ background: 'linear-gradient(135deg, var(--whisper-50), rgba(255,255,255,0.5))', border: '1.5px solid var(--whisper)' }}>
                  <div className="absolute -top-2.5 left-4 bg-whisper text-white text-[9.5px] font-extrabold tracking-[0.15em] py-1 px-2.5 rounded">
                    {t('convene.decision')}
                  </div>
                  <div className="font-display font-medium text-[16px] text-ink-900 mt-1.5 mb-1">
                    {entry.decision.headline}
                  </div>
                  <div className="text-[13px] text-ink-500 leading-[1.55]">{entry.decision.body}</div>
                </div>
              )
            }
            const author = byId[entry.authorId]
            if (!author) return null
            return (
              <div key={entry.id} className="grid grid-cols-[40px_1fr] gap-3 mb-4 items-start animate-rise">
                <Avatar p={author} size={36} />
                <div>
                  <div className="font-bold text-[13px] text-ink-900 mb-0.5">{author.name}</div>
                  <div className="text-[14px] text-ink-700 leading-[1.55]">{entry.body}</div>
                </div>
              </div>
            )
          })}
        </div>
      </main>

      <aside className="border-l border-ink-100 overflow-y-auto"
        style={{ background: 'var(--chrome-pane)' }}>
        <div className="py-3.5 px-[18px] pb-2.5 border-b border-ink-100">
          <h4 className="font-display font-medium text-[16px] tracking-tight mb-1">
            {t('convene.transcriptTitle')} <em className="italic text-skype-deep" style={{ fontWeight: 400 }}>{t('convene.transcriptEm')}</em>
          </h4>
          <div className="text-[11px] text-ink-500">{t('convene.entries', { count: state.transcript.length })}</div>
        </div>
        <div className="py-3 px-[18px] pb-2 space-y-2">
          {state.transcript.map((entry) => {
            const author = byId[entry.authorId]
            if (!author) return null
            return (
              <div key={entry.id} className="text-[12px] leading-[1.5]">
                <div className="font-bold text-ink-900 text-[11px]">
                  {author.name} <span className="text-ink-300 font-normal ml-2 font-mono">{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className={cn('text-ink-700', entry.kind === 'decision' && 'text-whisper-deep font-semibold')}>{entry.body}</div>
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}