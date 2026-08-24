/**
 * Mobile Whispers — list + room.
 *
 * Reads the real `useWhispers` store (same source as desktop's
 * WhispersView). "Whispers" are server-side conversations between
 * agents the user is not a member of — fetched via /peek/agent-chats.
 *
 * Block renderer matches desktop WhisperRoom so mention chips, code
 * blocks, document/board/card/calendar links and emoji render the same
 * way across surfaces.
 */
import { useEffect, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Pressable } from './Pressable'
import { PullToRefresh } from './PullToRefresh'
import { tapHaptic } from '@/lib/native'
import { useT } from '@/lib/i18n'
import { useWhispers, whisperMessages, type WhispersStateLike } from '@/stores/whispers'
import { useParticipants } from '@/stores/participants'
import { HiveAvatar } from '@/components/HiveAvatar'
import { Avatar, AvatarStack } from '@/components/Avatar'
import { CodeBlock, SystemRow } from '@/components/Message'
import { BoardLink } from '@/components/BoardLink'
import { CardLink } from '@/components/CardLink'
import { DocumentLink } from '@/components/DocumentLink'
import { CalendarLink } from '@/components/CalendarLink'
import { SkypeEmoji } from '@/components/SkypeEmoji'
import { TwEmoji } from '@/components/TwEmoji'
import { IBack, IMore } from '@/components/icons'
import { parseBody, parseBlocks } from '@/lib/utils'
import type { ApiWhisper, ApiWhisperMessage } from '@/api/client'
import type { Participant } from '@/types'

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const diff = now - d.getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function WhisperInline({ body }: { body: string }) {
  const tokens = parseBody(body)
  const byId = useParticipants((s) => s.byId)
  return (
    <>
      {tokens.map((t, i) => {
        if (t.kind === 'text') return <span key={i}>{t.value}</span>
        if (t.kind === 'document') return <DocumentLink key={i} id={t.id} />
        if (t.kind === 'board') return <BoardLink key={i} id={t.id} />
        if (t.kind === 'card') return <CardLink key={i} id={t.id} />
        if (t.kind === 'calendar') return <CalendarLink key={i} id={t.id} />
        if (t.kind === 'link') return (
          <a
            key={i}
            href={t.url}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all underline decoration-coral/40 decoration-1 underline-offset-2"
            style={{ color: 'var(--coral-deep)' }}
          >{t.text}</a>
        )
        if (t.kind === 'bold') return <strong key={i} className="text-ink-900 font-semibold">{t.value}</strong>
        if (t.kind === 'code') return (
          <code
            key={i}
            className="font-mono text-[12.5px] py-px px-1.5 rounded-[5px] mx-px align-[0.05em]"
            style={{
              background: 'rgba(15, 30, 50, 0.06)',
              color: 'var(--ink-900)',
              border: '1px solid rgba(15, 30, 50, 0.08)',
            }}
          >{t.value}</code>
        )
        if (t.kind === 'emoji') return <TwEmoji key={i} emoji={t.value} size={16} />
        if (t.kind === 'skype') return <SkypeEmoji key={i} name={t.name} size={18} />
        // `#N` is a peek-only view here — no jump target, render as plain text.
        if (t.kind === 'msgref') return <span key={i}>#{t.n}</span>
        const p = byId[t.id]
        const label = p?.name ?? t.id
        return (
          <span key={i} className="px-1.5 rounded font-semibold border-b-[1.5px] border-dashed"
            style={{
              background: 'linear-gradient(135deg, var(--coral-soft), rgba(255, 217, 210, 0.5))',
              color: '#B23A2A',
              borderColor: 'var(--coral)',
            }}>@{label}</span>
        )
      })}
    </>
  )
}

function WhisperBody({ body }: { body: string }) {
  const blocks = parseBlocks(body)
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'code-block') return <CodeBlock key={i} lang={b.lang} code={b.code} />
        return (
          <div key={i}>
            {b.text.split('\n').map((line, li) => (
              <div key={li}>{line ? <WhisperInline body={line} /> : ' '}</div>
            ))}
          </div>
        )
      })}
    </>
  )
}

function WhisperPreview({ w }: { w: ApiWhisper }) {
  const byIdList = useWhispers((s) => s.byId)
  const t = useT()
  const msgs = byIdList[w.id] ?? []
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : null
  if (!last) return <span className="font-display italic">{t('mwhisp.previewNone')}</span>
  const preview = (last.body ?? '').slice(0, 140).replace(/\n/g, ' ').trim()
  if (!preview) return <span className="font-display italic">…</span>
  return <span>{preview}</span>
}

function EyeGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function WhisperListRow({ w, onSelect }: { w: ApiWhisper; onSelect: (id: string) => void }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const ms = w.members
    .map((id) => byId[id])
    .filter((p): p is Participant => Boolean(p))
  if (ms.length < 2) return null
  const isGroup = w.kind === 'group' || ms.length > 2
  const namesLabel = ms.length <= 2
    ? null
    : ms.length === 3
      ? t('mwhisp.moreOne', { a: ms[0].name, c: ms[1].name })
      : t('mwhisp.moreN', { a: ms[0].name, c: ms[1].name, n: ms.length - 2 })

  return (
    <motion.button
      onClick={() => { void tapHaptic(); onSelect(w.id) }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 600, damping: 30, mass: 0.5 }}
      className="w-full text-left grid grid-cols-[48px_1fr_auto] gap-3 py-3 px-4 active:bg-whisper-50"
    >
      <HiveAvatar ps={ms} size={48} ringColor="var(--paper)" />
      <div className="min-w-0 self-center">
        <div className="text-[15px] font-semibold text-ink-900 leading-tight mb-0.5 flex items-center gap-1.5 truncate">
          {isGroup ? (
            <span className="truncate">{w.title || namesLabel}</span>
          ) : (
            <>
              <span className="truncate">{ms[0].name}</span>
              <span className="text-whisper text-[11px] shrink-0 italic font-normal">↔</span>
              <span className="truncate">{ms[1].name}</span>
            </>
          )}
        </div>
        <div className="text-[12.5px] text-ink-500 truncate leading-snug">
          <WhisperPreview w={w} />
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 self-center">
        <span className="text-[10.5px] text-ink-300 tabular-nums">{shortTime(w.updatedAt)}</span>
        {w.msgCount > 0 && (
          <span
            className="inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-bold leading-none tabular-nums"
            style={{
              background: 'var(--whisper-50)',
              color: 'var(--whisper-deep)',
              border: '1px solid var(--whisper-100)',
            }}
          >
            <EyeGlyph size={10} />
            {w.msgCount}
          </span>
        )}
      </div>
    </motion.button>
  )
}

export function MobileWhispersList({ onSelect }: { onSelect: (id: string) => void }) {
  const t = useT()
  const list = useWhispers((s) => s.list)
  const loaded = useWhispers((s) => s.loaded)

  useEffect(() => {
    if (!loaded) void useWhispers.getState().loadList()
  }, [loaded])

  return (
    <section className="flex flex-col h-full bg-paper">
      <div
        className="sticky top-0 z-10 bg-paper/95 backdrop-blur-md"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}
      >
        <div className="px-4 pt-2 pb-2 flex items-center gap-2.5">
          <div
            className="w-7 h-7 rounded-full grid place-items-center text-whisper-deep shrink-0"
            style={{
              background: 'radial-gradient(circle at 30% 30%, var(--whisper-100), var(--whisper-50))',
              border: '1px solid var(--whisper-100)',
            }}
          >
            <EyeGlyph size={14} />
          </div>
          <h1 className="font-display font-medium text-[26px] tracking-tight text-ink-900 leading-none">
            {t('mwhisp.title')}
          </h1>
          <span
            className="ml-auto inline-flex items-center gap-1.5 py-1 px-2.5 rounded-full text-[10px] font-bold uppercase tracking-[0.08em]"
            style={{
              background: 'var(--whisper-50)',
              color: 'var(--whisper-deep)',
              border: '1px solid var(--whisper-100)',
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-whisper animate-pulse-soft" />
            {t('mwhisp.observing')}
          </span>
        </div>
        <div className="px-4 pb-2.5 text-[12px] text-ink-500 font-display italic leading-snug">
          {t('mwhisp.headerSub')}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <PullToRefresh onRefresh={() => useWhispers.getState().loadList()}>
          <div className="pb-2">
            {!loaded && list.length === 0 && (
              <div className="px-6 py-10 text-center text-[12.5px] text-ink-300 font-display italic">
                {t('mwhisp.loading')}
              </div>
            )}
            {loaded && list.length === 0 && (
              <div className="px-6 py-10 text-center text-[13px] text-ink-500 font-display italic leading-relaxed">
                {t('mwhisp.empty')}
              </div>
            )}
            {list.map((w) => (
              <WhisperListRow key={w.id} w={w} onSelect={onSelect} />
            ))}
          </div>
        </PullToRefresh>
      </div>
    </section>
  )
}

function Bubble({ msg }: { msg: ApiWhisperMessage }) {
  const byId = useParticipants((s) => s.byId)
  if (msg.kind === 'system') return <SystemRow msg={msg} />
  if (msg.kind === 'tool') return null
  if (!msg.body || msg.body.trim() === '') return null
  const author = byId[msg.authorId]
  if (!author) return null

  const tsRaw = msg.createdAt ?? (msg as { at?: string }).at
  const tsDate = tsRaw ? new Date(tsRaw) : new Date()
  const tsLabel = Number.isNaN(tsDate.getTime())
    ? ''
    : tsDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <div className="grid grid-cols-[28px_1fr] gap-2 items-start animate-rise mr-[12%]">
      <Avatar p={author} size={28} showStatus={false} />
      <div>
        <div className="text-[10.5px] mb-1 flex gap-1.5">
          <span className="font-bold text-ink-900 text-[11.5px]">{author.name}</span>
          {tsLabel && <span className="text-ink-300">{tsLabel}</span>}
        </div>
        <div className="inline-block py-2 px-3 text-[13px] leading-[1.55] rounded-tl-[4px] rounded-tr-[14px] rounded-br-[14px] rounded-bl-[14px]"
          style={{
            background: 'rgba(255, 255, 255, 0.85)',
            border: '1px solid var(--whisper-100)',
            color: 'var(--ink-700)',
          }}>
          <WhisperBody body={msg.body} />
        </div>
      </div>
    </div>
  )
}

export function MobileWhisperRoom({ pairId, onBack }: { pairId: string; onBack: () => void }) {
  const t = useT()
  const list = useWhispers((s) => s.list)
  const byIdList = useWhispers((s) => s.byId)
  const streaming = useWhispers((s) => s.streaming)
  const whisper = useMemo(() => list.find((w) => w.id === pairId), [list, pairId])
  const messages = useMemo(
    () => whisperMessages({ byId: byIdList, streaming } as WhispersStateLike, pairId),
    [byIdList, streaming, pairId],
  )
  const byId = useParticipants((s) => s.byId)

  useEffect(() => {
    void useWhispers.getState().loadMessages(pairId)
  }, [pairId])

  if (!whisper) {
    return (
      <section className="flex flex-col h-full bg-paper">
        <header className="sticky top-0 z-10 backdrop-blur-md border-b border-whisper-100"
          style={{ paddingTop: 'env(safe-area-inset-top)', background: 'rgba(251, 253, 251, 0.95)' }}>
          <div className="px-2 py-2.5 flex items-center gap-2">
            <Pressable onClick={onBack} className="w-10 h-10 grid place-items-center text-ink-700 active:bg-whisper-50 rounded-full">
              <IBack className="w-[22px] h-[22px]" strokeWidth={2} />
            </Pressable>
          </div>
        </header>
        <div className="flex-1 grid place-items-center text-center px-6 text-[13px] text-ink-500 font-display italic">
          {t('mwhisp.closed')}
        </div>
      </section>
    )
  }

  const ms = whisper.members
    .map((id) => byId[id])
    .filter((p): p is Participant => Boolean(p))
  if (ms.length < 2) return null
  const isGroup = whisper.kind === 'group' || ms.length > 2

  return (
    <section className="flex flex-col h-full"
      style={{ background: 'var(--chrome-whisper)' }}>
      <header className="sticky top-0 z-10 backdrop-blur-md border-b border-whisper-100"
        style={{ paddingTop: 'env(safe-area-inset-top)', background: 'rgba(251, 253, 251, 0.95)' }}>
        <div className="px-2 py-2.5 flex items-center gap-2">
          <Pressable onClick={onBack} className="w-10 h-10 grid place-items-center text-ink-700 active:bg-whisper-50 rounded-full">
            <IBack className="w-[22px] h-[22px]" strokeWidth={2} />
          </Pressable>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {isGroup ? (
              <AvatarStack ps={ms} size={28} max={3} />
            ) : (
              <div className="flex">
                <Avatar p={ms[0]} size={28} showStatus={false} ringColor="var(--paper)" />
                <div className="-ml-2"><Avatar p={ms[1]} size={28} showStatus={false} ringColor="var(--paper)" /></div>
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="font-display font-medium text-[15px] text-ink-900 leading-tight truncate" style={{ letterSpacing: '-0.01em' }}>
                {isGroup ? (whisper.title || ms.map((m) => m.name).join(', ')) : (
                  <>
                    {ms[0].name} <em className="italic text-whisper-deep" style={{ fontWeight: 400 }}>↔</em> {ms[1].name}
                  </>
                )}
              </div>
              <div className="text-[10.5px] text-whisper-deep font-semibold mt-0.5 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-whisper animate-pulse-soft" />
                {t('mwhisp.observingCount', { n: whisper.msgCount })}
              </div>
            </div>
          </div>
          <Pressable haptic="medium" className="w-10 h-10 grid place-items-center text-ink-700 active:bg-whisper-50 rounded-full">
            <IMore className="w-[20px] h-[20px]" />
          </Pressable>
        </div>

        <div className="py-2 px-3 flex items-center gap-2 border-t border-whisper-100"
          style={{ background: 'linear-gradient(90deg, rgba(123, 108, 176, 0.10), rgba(123, 108, 176, 0.03))' }}>
          <div className="w-6 h-6 rounded-full grid place-items-center text-whisper" style={{ background: 'rgba(123, 108, 176, 0.18)' }}>
            <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
          </div>
          <div className="text-[11px] text-whisper-deep flex-1">
            <b className="font-bold tracking-wider uppercase text-[10px]">{t('mwhisp.observerMode')}</b>
            <span className="font-display italic font-normal text-ink-500 ml-1.5">{t('mwhisp.observerSub')}</span>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-3 relative">
        {messages.length === 0 && (
          <div className="text-center text-ink-300 text-[12px] font-display italic py-6">{t('mwhisp.previewNone')}</div>
        )}
        {messages.map((msg) => <Bubble key={msg.id} msg={msg} />)}
      </div>

      <div className="border-t border-whisper-100 bg-cloud px-3 pt-2.5 flex items-center gap-2 kb-aware">
        <div className="flex-1 bg-paper rounded-[20px] py-2.5 px-3.5 min-h-[40px] flex items-center"
          style={{ border: '1px solid var(--whisper-100)' }}>
          <span className="text-[13px] text-ink-300 italic flex-1">{t('mwhisp.inject')}</span>
        </div>
      </div>
    </section>
  )
}
