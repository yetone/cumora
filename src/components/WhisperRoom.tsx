import { useEffect, useMemo } from 'react'
import { Avatar, AvatarStack } from './Avatar'
import { SkypeEmoji } from './SkypeEmoji'
import { TwEmoji } from './TwEmoji'
import { cn, parseBody, parseBlocks } from '@/lib/utils'
import { useParticipants } from '@/stores/participants'
import { useAuth, useMe } from '@/stores/auth'
import { useWhispers, whisperMessages, type WhispersStateLike } from '@/stores/whispers'
import { CodeBlock, SystemRow } from './Message'
import { BoardLink } from './BoardLink'
import { CardLink } from './CardLink'
import { DocumentLink } from './DocumentLink'
import { CalendarLink } from './CalendarLink'
import type { ApiWhisperMessage } from '@/api/client'
import type { Participant } from '@/types'
import { useT } from '@/lib/i18n'

/** Inline-only renderer for whisper bubbles — keeps the dashed-coral
 *  mention chip (whispers use a different visual register than the main
 *  chat). Block-level work happens in `WhisperBody` below. */
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
            className="break-all underline decoration-coral/40 decoration-1 underline-offset-2 hover:decoration-coral-deep transition-colors"
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
        // `#N` (message-seq ref) — whispers are a peek view, no jump target;
        // render as plain text so the reference reads but isn't interactive.
        if (t.kind === 'msgref') return <span key={i}>#{t.n}</span>
        // Mention — resolve to display name via the participants store.
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

/** Block-level renderer for whisper bodies — splits fenced code from prose,
 *  reuses the shared CodeBlock so styling stays consistent with the main
 *  chat, and keeps the existing line-by-line `<div>` wrap for prose so
 *  bubbles don't lose newlines. */
function WhisperBody({ body }: { body: string }) {
  const blocks = parseBlocks(body)
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'code-block') return <CodeBlock key={i} lang={b.lang} code={b.code} />
        // Prose: preserve newlines via explicit row divs (the bubble's
        // styling expects each visual line to be its own block).
        return (
          <div key={i}>
            {b.text.split('\n').map((line, li) => (
              <div key={li}>{line ? <WhisperInline body={line} /> : ' '}</div>
            ))}
          </div>
        )
      })}
    </>
  )
}

function Bubble({ msg }: { msg: ApiWhisperMessage }) {
  const byId = useParticipants((s) => s.byId)
  // System rows (joined / left / kicked) carry a JSON payload in `body`
  // and have kind='system'. Without this branch the JSON leaks into the
  // bubble as raw text. Render the shared centered "X left the group"
  // row, same as the desktop ChatPane.
  if (msg.kind === 'system') return <SystemRow msg={msg} />
  const author = byId[msg.authorId]
  if (!author) return null
  // Tool-call rows have kind='tool' and an empty body. Without this guard
  // they render as ghostly empty bubbles. Drop them entirely for now —
  // when we want to surface "X used `cumora ...`" we'll render a small
  // tool-card here instead.
  if (msg.kind === 'tool') return null
  // Defensive: any non-tool row that somehow ended up with an empty body
  // (e.g. classifier-stripped tool_call XML hallucinations) — skip it
  // rather than show an empty bubble.
  if (!msg.body || msg.body.trim() === '') return null

  // Robust timestamp parse — accept either `createdAt` (HTTP API shape) or
  // `at` (WS event shape). Invalid input falls back to "now" rather than
  // surfacing "Invalid Date".
  const tsRaw = msg.createdAt ?? (msg as { at?: string }).at
  const tsDate = tsRaw ? new Date(tsRaw) : new Date()
  const tsLabel = Number.isNaN(tsDate.getTime())
    ? ''
    : tsDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  // Whispers is an observer view — the viewer isn't a participant, so the
  // DM-style left/right split doesn't apply. Every bubble reads
  // left-aligned, like watching a log scroll past.
  return (
    <div className="grid grid-cols-[32px_1fr] gap-2.5 items-start animate-rise mr-[20%]">
      <Avatar p={author} size={32} showStatus={false} />
      <div>
        <div className="text-[11.5px] mb-1 flex gap-2">
          <span className="font-bold text-ink-900 text-[12.5px]">{author.name}</span>
          {tsLabel && <span className="text-ink-300">{tsLabel}</span>}
        </div>
        <div className="inline-block py-2.5 px-3.5 text-[13.5px] leading-[1.55] backdrop-blur-sm rounded-tl-[4px] rounded-tr-[14px] rounded-br-[14px] rounded-bl-[14px]"
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

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-whisper text-[10.5px] font-mono font-bold tracking-wider uppercase my-1">
      <span className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--whisper-200), transparent)' }} />
      — {label} —
      <span className="flex-1 h-px" style={{ background: 'linear-gradient(90deg, transparent, var(--whisper-200), transparent)' }} />
    </div>
  )
}

export function WhisperRoom({ pairId }: { pairId: string }) {
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
  const meId = useMe()
  const authUser = useAuth((s) => s.user)

  useEffect(() => {
    void useWhispers.getState().loadMessages(pairId)
  }, [pairId])

  if (!whisper) return null
  // Resolve every member to a participant — works for both 1-on-1 direct
  // chats and multi-agent groups that an agent has pulled.
  const ms = whisper.members
    .map((id) => byId[id])
    .filter((p): p is Participant => Boolean(p))
  if (ms.length < 2) return null
  const isGroup = whisper.kind === 'group' || ms.length > 2

  // Real user avatar for the composer — same resolution pattern as Rail.tsx.
  // Prefer the canonical participant row (carries Gravatar / status); fall
  // back to a synthesized record from the auth user so we never render
  // before the participants store has loaded.
  const meParticipant: Participant | null = (meId && byId[meId]) ? byId[meId] : null
  const meFallback: Participant = {
    id: authUser?.id ?? 'me',
    kind: 'human',
    name: authUser?.name ?? 'You',
    initial: (authUser?.name ?? 'Y').charAt(0).toUpperCase(),
    avatarBg: 'linear-gradient(135deg, #FF7A6B, #F4B740)',
    status: 'avail',
  } as Participant
  const meAvatar = meParticipant ?? meFallback

  return (
    <main className="grid overflow-hidden"
      style={{
        gridTemplateRows: 'auto auto 1fr auto',
        // Single continuous gradient layer — soft wisteria from top-left,
        // warm peach from bottom-right, paper base. No more banded zones
        // that get sliced by inner borders.
        background: 'radial-gradient(ellipse 70% 50% at 0% 0%, rgba(210, 201, 233, 0.28), transparent 60%), radial-gradient(ellipse 60% 40% at 100% 100%, rgba(255, 217, 210, 0.18), transparent 60%), var(--paper)',
        position: 'relative',
      }}
    >
      {/* Observer-mode chip — refined, inline, no full-width banner. */}
      <div className="px-6 pt-4 pb-1">
        <div
          className="inline-flex items-center gap-2 py-1 px-2.5 rounded-full text-[11px] text-whisper-deep"
          style={{ background: 'var(--whisper-50)', border: '1px solid var(--whisper-100)' }}
        >
          <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
          </svg>
          <b className="font-semibold tracking-wide uppercase text-[9.5px]">{t('whisper.observerMode')}</b>
          <span className="font-display italic text-ink-500 text-[11px]">{t('whisper.observerHint')}</span>
        </div>
      </div>

      {/* Header — pair of avatars for 1-on-1, stack for groups. */}
      <div className="px-6 pt-3 pb-4 flex items-center gap-4">
        {isGroup ? (
          <div className="shrink-0">
            <AvatarStack ps={ms} size={36} max={4} />
          </div>
        ) : (
          <div className="flex items-center -space-x-2 shrink-0">
            <div className="rounded-full" style={{ boxShadow: '0 0 0 2.5px var(--paper)' }}>
              <Avatar p={ms[0]} size={44} showStatus={false} />
            </div>
            <div className="rounded-full" style={{ boxShadow: '0 0 0 2.5px var(--paper)' }}>
              <Avatar p={ms[1]} size={44} showStatus={false} />
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h2 className="font-display font-medium text-[19px] tracking-tight leading-[1.1] truncate">
            {isGroup ? (
              whisper.title || ms.map((m) => m.name).join(', ')
            ) : (
              <>
                {ms[0].name}
                <span className="text-whisper mx-1.5">↔</span>
                {ms[1].name}
              </>
            )}
          </h2>
          <div className="text-[11.5px] text-ink-500 mt-0.5 truncate font-display italic">
            {isGroup ? t('whisper.nAgents', { n: ms.length }) : (whisper.about ?? t('whisper.privateThread'))}
            <span className="not-italic text-ink-300"> · </span>
            <span className="not-italic text-ink-300">
              {t('whisper.startedAt', { time: new Date(whisper.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
            </span>
          </div>
        </div>
      </div>

      {/* Thread */}
      <div className="overflow-y-auto py-3 px-6 pb-3 flex flex-col gap-3 relative">
        <Divider label={t('whisper.openedAt', { time: new Date(whisper.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })} />
        {messages.length === 0 && (
          <div className="text-center text-ink-300 text-[12px] font-display italic py-6">{t('whisper.noMessages')}</div>
        )}
        {messages.map((msg) => <Bubble key={msg.id} msg={msg} />)}
      </div>

      {/* Composer — fully transparent wrapper so the shared gradient bleeds
          through; inner pill matches the main ChatPane register. */}
      <div className="px-6 py-3 pb-[18px]">
        <div className="bg-cloud rounded-[14px] py-2.5 px-3.5 flex items-center gap-2.5"
          style={{ border: '1.5px solid var(--whisper-100)' }}>
          <Avatar p={meAvatar} size={26} ringColor="var(--cloud)" showStatus={false} />
          <div className="flex-1 text-[13px] text-ink-300">
            {t('whisper.injectPrompt')}
          </div>
        </div>
      </div>
    </main>
  )
}

export function WhisperInspector({ pairId }: { pairId: string }) {
  const list = useWhispers((s) => s.list)
  const byIdList = useWhispers((s) => s.byId)
  const streaming = useWhispers((s) => s.streaming)
  const whisper = useMemo(() => list.find((w) => w.id === pairId), [list, pairId])
  const messages = useMemo(
    () => whisperMessages({ byId: byIdList, streaming } as WhispersStateLike, pairId),
    [byIdList, streaming, pairId],
  )
  const byId = useParticipants((s) => s.byId)
  if (!whisper) return null
  const ms = whisper.members
    .map((id) => byId[id])
    .filter((p): p is Participant => Boolean(p))
  if (ms.length < 2) return null

  // Per-member turn count — works for both pairs and bigger groups.
  const turnsByAuthor: Record<string, number> = {}
  for (const m of messages) turnsByAuthor[m.authorId] = (turnsByAuthor[m.authorId] ?? 0) + 1

  return (
    <aside className="border-l overflow-y-auto"
      style={{
        background: 'var(--chrome-whisper)',
        borderColor: 'var(--whisper-100)',
      }}>
      <div className="py-5 px-5 pb-4 text-center border-b"
        style={{
          background: 'radial-gradient(circle at 50% 0%, var(--whisper-100), transparent 70%)',
          borderColor: 'var(--whisper-100)',
        }}>
        <div className="text-[9.5px] font-extrabold text-whisper tracking-[0.18em] uppercase mb-2">Whisper · {messages.length} messages</div>
        <h3 className="font-display font-medium text-[20px] tracking-tight mb-1.5">
          {whisper.about ?? whisper.title ?? 'private thread'}
        </h3>
        <div className="font-display italic text-[12px] leading-[1.6] text-ink-500 px-1.5">
          opened {new Date(whisper.createdAt).toLocaleString()}
        </div>
      </div>

      <div className="py-4 px-5 border-b border-whisper-100">
        <h4 className="text-[10.5px] font-extrabold text-whisper tracking-[0.12em] uppercase mb-2.5">
          {ms.length === 2 ? 'The two voices' : `${ms.length} voices`}
        </h4>
        <div className={cn(
          'grid gap-3',
          ms.length === 2 ? 'grid-cols-2' : 'grid-cols-2',
        )}>
          {ms.map((p) => (
            <div key={p.id} className="text-center py-2.5 px-2 bg-cloud rounded-[10px]" style={{ border: '1px solid var(--whisper-100)' }}>
              <Avatar p={p} size={36} showStatus={false} />
              <div className="text-[12px] font-bold text-ink-900 mt-1.5">{p.name}</div>
              {p.role && <div className="font-display italic text-[10px] text-ink-500 mb-2">{p.role}</div>}
              <div className="font-display text-[22px] font-medium text-whisper-deep leading-none" style={{ letterSpacing: '-0.02em' }}>{turnsByAuthor[p.id] ?? 0}</div>
              <div className="text-[9px] font-bold text-ink-300 uppercase tracking-wider mt-0.5">turns</div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
