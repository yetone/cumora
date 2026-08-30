import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { useApp } from '@/stores/app'
import { useAuth, useMe } from '@/stores/auth'
import { useConversations, isMuted } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { Avatar } from '@/components/Avatar'
import { PreviewText } from '@/components/PreviewText'
import { HiveAvatar } from '@/components/HiveAvatar'
import { ContextMenu, type ContextMenuItem } from '@/components/ContextMenu'
import { GroupCreator } from '@/components/GroupCreator'
import { ResizeHandle } from '@/components/ResizeHandle'
import { ISearch, IMail, IPlus } from '@/components/icons'
import { cn } from '@/lib/utils'
import { api, type ApiProject, type ApiSearchResults } from '@/api/client'
import { useLocale, useT, type MessageKey } from '@/lib/i18n'

/** The reactive translator, threaded into the helpers below so they stay
 *  pure and their callers' components re-render on a locale switch. */
type Translator = ReturnType<typeof useT>
import type { Conversation, Participant } from '@/types'

const staticFilters = ['All', 'Unread', 'Agents', 'Humans', 'Groups', 'Email', 'Whispers'] as const
type StaticFilter = (typeof staticFilters)[number]
/** Display labels for the static filter chips. The enum values in
 *  `staticFilters` stay English so the existing `matches()` comparison
 *  keeps working; this Record maps each enum to its translation key. */
const FILTER_LABEL: Record<StaticFilter, MessageKey> = {
  All: 'convo.filterAll',
  Unread: 'convo.filterUnread',
  Agents: 'convo.filterAgents',
  Humans: 'convo.filterHumans',
  Groups: 'convo.filterGroups',
  Email: 'convo.filterEmail',
  Whispers: 'convo.filterWhispers',
}
/** A filter is either one of the static labels, or a project chip identified
 *  by `project:<id>`. Keeping it as a string union lets the existing chip
 *  loop iterate uniformly. */
type Filter = StaticFilter | `project:${string}`

/** Mute duration menu — Slack-shaped defaults plus relative anchors
 *  ("until tomorrow morning", "until next Monday morning"). `compute` runs
 *  at click time, not at module load, so "tomorrow" always resolves
 *  against the user's current wall-clock — not whatever it was when the
 *  app first booted. */
const MUTE_DURATIONS: Array<{ label: MessageKey; compute: () => Date }> = [
  { label: 'convo.mute15m', compute: () => new Date(Date.now() + 15 * 60_000) },
  { label: 'convo.mute1h',  compute: () => new Date(Date.now() + 60 * 60_000) },
  { label: 'convo.mute8h',  compute: () => new Date(Date.now() + 8 * 60 * 60_000) },
  { label: 'convo.mute24h', compute: () => new Date(Date.now() + 24 * 60 * 60_000) },
  {
    label: 'convo.muteTomorrow',
    // 9 AM the next calendar day, local time. If the user clicks this at
    // 02:00 on Tuesday they get silence until Wednesday 09:00 — matches
    // how a human reads "until tomorrow".
    compute: () => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      d.setHours(9, 0, 0, 0)
      return d
    },
  },
  {
    label: 'convo.muteMonday',
    // Next Monday 9 AM local. If today IS Monday we skip to the FOLLOWING
    // Monday — "next" reads as "a whole week of quiet", not "a few hours".
    compute: () => {
      const d = new Date()
      const day = d.getDay() // 0=Sun, 1=Mon ...
      const daysUntil = ((1 - day + 7) % 7) || 7
      d.setDate(d.getDate() + daysUntil)
      d.setHours(9, 0, 0, 0)
      return d
    },
  },
]

/** Short label shown next to the "Muted" menu row so users know how long
 *  they've still got left without diving into the submenu. */
function muteHint(t: Translator, mutedUntil: string | null | undefined): string {
  if (!mutedUntil) return t('convo.muteHintForever')
  const until = new Date(mutedUntil)
  if (Number.isNaN(until.getTime())) return ''
  const now = new Date()
  const sameDay = until.toDateString() === now.toDateString()
  return t('convo.muteHintUntil', {
    when: sameDay
      ? until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : until.toLocaleDateString([], { month: 'short', day: 'numeric' }),
  })
}

function matches(c: Conversation, f: Filter, byId: Record<string, { kind: string }>) {
  if (f.startsWith('project:')) {
    const projectId = f.slice('project:'.length)
    return c.projectId === projectId
  }
  if (f === 'All') return true
  // Muted convos are intentionally hidden from the Unread filter — the
  // whole point of mute is "stop nagging me about this". Their per-row
  // unread badge still shows under "All".
  if (f === 'Unread') return (c.unread ?? 0) > 0 && !isMuted(c)
  if (f === 'Whispers') return c.kind === 'whisper'
  if (f === 'Email') return c.kind === 'email'
  if (f === 'Groups') return c.kind === 'group'
  const isHumanChat = c.tag === 'human' || c.members.every((m) => byId[m]?.kind === 'human')
  if (f === 'Humans') return isHumanChat
  if (f === 'Agents') return c.kind === 'direct' && !isHumanChat
  return true
}

function _ClusterAvatar() {
  return (
    <div
      className="w-11 h-11 rounded-full relative grid place-items-center text-white font-display font-medium text-base"
      style={{
        background: 'conic-gradient(from 0deg, #B57BFF 0% 25%, var(--coral) 25% 50%, #6B7BE6 50% 75%, var(--gold) 75% 100%)',
        boxShadow: 'inset 0 0 0 3px var(--cloud)',
      }}
    >⌘</div>
  )
}

function TeamAvatar() {
  return (
    <div className="w-11 h-11 rounded-full relative grid place-items-center text-white font-display font-medium text-base"
      style={{ background: 'linear-gradient(135deg, var(--skype), var(--skype-ink))', boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.2)' }}>
      <span style={{ letterSpacing: '-0.02em' }}>⌘</span>
      <span className="absolute rounded-full" style={{ width: 12, height: 12, background: 'var(--avail)', boxShadow: '0 0 0 2.5px var(--paper)', bottom: -1, right: -1 }} />
    </div>
  )
}

function ConvoAvatar({ c }: { c: Conversation }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()

  // Direct chats: show the other participant's portrait.
  if (c.kind === 'direct') {
    const member = c.members.find((m) => m !== meId) ?? c.members[0]
    const p = member ? byId[member] : undefined
    if (p) return <Avatar p={p} size={44} ringColor="var(--paper)" />
    return <TeamAvatar />
  }

  // Groups + freshly-pulled groups: cluster member portraits in a honeycomb so
  // you can see who's in there at a glance. The current user moves to the
  // front so "you're in this group" reads instantly.
  if (c.kind === 'group') {
    const others: Participant[] = []
    let me: Participant | undefined
    for (const id of c.members) {
      const p = byId[id]
      if (!p) continue
      if (p.id === meId) me = p
      else others.push(p)
    }
    const ordered = me ? [me, ...others] : others
    if (ordered.length === 0) return <TeamAvatar />
    return <HiveAvatar ps={ordered} size={44} ringColor="var(--paper)" />
  }

  // Whispers: 2-person hive (the two whisperers).
  if (c.kind === 'whisper') {
    const ps = c.members.map((m) => byId[m]).filter((p): p is Participant => Boolean(p))
    if (ps.length === 0) return <TeamAvatar />
    return <HiveAvatar ps={ps} size={44} ringColor="var(--paper)" />
  }

  // Email: members hive with a small envelope badge in the corner so
  // an email thread is recognizable at a glance even before scanning
  // the title / preview.
  if (c.kind === 'email') {
    const others: Participant[] = []
    let me: Participant | undefined
    for (const id of c.members) {
      const p = byId[id]
      if (!p) continue
      if (p.id === meId) me = p
      else others.push(p)
    }
    const ordered = (me ? [me, ...others] : others).slice(0, 4)
    const inner = ordered.length > 0
      ? <HiveAvatar ps={ordered} size={44} ringColor="var(--paper)" />
      : <TeamAvatar />
    return (
      <div className="relative">
        {inner}
        <span
          className="absolute -bottom-1 -right-1 w-[18px] h-[18px] rounded-full grid place-items-center"
          style={{
            background: 'linear-gradient(135deg, #FBF8F0, #E8DEC0)',
            border: '1.5px solid var(--paper)',
            color: '#7A6A3F',
          }}
          title={t('convo.emailThread')}
        >
          <IMail className="w-2.5 h-2.5" strokeWidth={2.5} />
        </span>
      </div>
    )
  }

  return <TeamAvatar />
}

function Tag({ c }: { c: Conversation }) {
  const t = useT()
  // Note: c.subtitle (auto-generated as "cross-project · N" / "team · N")
  // intentionally NOT rendered — it duplicates the member count already
  // visible in the hive avatar and crowded the row layout. Only meaningful
  // user-facing tags surface here.
  if (c.tag === 'human') return (
    // No chip background — matches the agent role label treatment in
    // MessageRow (small uppercase tracking, no fill). Skype-deep tints
    // the label so the brand palette carries the "this is a human"
    // signal, instead of a coral accent that fights the rest of the row.
    <span
      className="text-[10px] font-semibold tracking-wider uppercase whitespace-nowrap"
      style={{ color: 'var(--skype-deep)' }}
    >{t('convo.teammateTag')}</span>
  )
  return null
}

/** Items rendered by the conversations Virtuoso — section labels and the
 *  Pinned/Rest divider live in the same flat list so the whole pane scrolls
 *  through one virtualized container. */
type ConvoListItem =
  | { type: 'loading'; key: string }
  | { type: 'label'; key: string; text: string }
  | { type: 'divider'; key: string }
  | { type: 'row'; key: string; c: Conversation }

interface RowProps {
  c: Conversation
  selected: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function MutedGlyph({ title }: { title: string }) {
  // Slack-style bell-off — small, ink-300, matches the row's secondary tone.
  return (
    <span
      role="img"
      className="inline-flex items-center justify-center w-3 h-3 shrink-0 text-ink-300"
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        <path d="M18.63 13A17.9 17.9 0 0 1 18 8" />
        <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
        <path d="M18 8a6 6 0 0 0-9.33-5" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    </span>
  )
}

function ConvoRow({ c, selected, onClick, onContextMenu }: RowProps) {
  const t = useT()
  const isFreshPulled = c.tag === 'fresh-pulled'
  const muted = isMuted(c)
  const typingIds = useMessages((s) => s.typing[c.id])
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()
  const pulledByName = c.pulledBy?.agentId
    ? byId[c.pulledBy.agentId]?.name ?? c.pulledBy.agentId
    : null
  const typingNames = (typingIds ?? [])
    .filter((id) => id !== meId)
    .map((id) => byId[id]?.name)
    .filter((n): n is string => Boolean(n))
  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={cn(
        'grid grid-cols-[44px_1fr_auto] gap-[11px] py-2.5 px-2 rounded-[11px] cursor-pointer items-center transition relative',
        !selected && 'hover:bg-sky2-50',
        selected && !isFreshPulled && 'bg-gradient-to-b from-sky2-100 to-sky2-50 ring-1 ring-inset ring-sky2-200',
        isFreshPulled && selected && 'bg-gradient-to-b from-[rgba(244,183,64,0.13)] to-[rgba(244,183,64,0.04)] ring-1 ring-inset ring-[rgba(244,183,64,0.45)] shadow-[0_0_24px_-4px_rgba(244,183,64,0.3)]',
      )}
    >
      {isFreshPulled && selected && (
        <span className="absolute -top-2 right-3 bg-cloud border border-[rgba(244,183,64,0.5)] text-gold-deep text-[9px] font-extrabold tracking-wider uppercase py-0.5 px-2 rounded-full shadow">
          {pulledByName ? t('convo.newPulledBy', { name: pulledByName }) : t('convo.new')}
        </span>
      )}
      <ConvoAvatar c={c} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          {/* Muted titles get a soft de-emphasis (ink-700 not ink-900,
              slightly translucent) so the row reads "I'm silenced"
              without screaming it. The bell-off glyph carries the
              affirmative signal. */}
          <span className={cn(
            'text-[13.5px] font-semibold truncate',
            muted ? 'text-ink-700 opacity-80' : 'text-ink-900',
          )}>{c.title}</span>
          {muted && <MutedGlyph title={muteTooltip(t, c.mutedUntil)} />}
          <Tag c={c} />
        </div>
        {typingNames.length > 0 ? (
          <div className="text-[12px] text-skype-deep leading-[1.4] truncate flex items-center gap-1.5">
            <span className="inline-flex gap-[2px] shrink-0">
              <span className="w-[3px] h-[3px] rounded-full bg-skype animate-bounce-dot" />
              <span className="w-[3px] h-[3px] rounded-full bg-skype animate-bounce-dot" style={{ animationDelay: '0.15s' }} />
              <span className="w-[3px] h-[3px] rounded-full bg-skype animate-bounce-dot" style={{ animationDelay: '0.3s' }} />
            </span>
            <span className="truncate">
              {typingNames.length === 1
                ? t('convo.typingOne', { name: typingNames[0] })
                : typingNames.length === 2
                  ? t('convo.typingTwo', { a: typingNames[0], b: typingNames[1] })
                  : t('convo.typingMore', { a: typingNames[0], n: typingNames.length - 1 })}
            </span>
          </div>
        ) : c.preview && (
          <div className="text-[12px] text-ink-500 leading-[1.4] truncate">
            <PreviewText body={c.preview} />
          </div>
        )}
      </div>
      <div className="text-right pt-0.5">
        <div className="text-[10.5px] text-ink-300 tabular-nums mb-1">{c.lastAt}</div>
        {c.unread !== undefined && c.unread > 0 && (
          <span
            className="inline-grid place-items-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold"
            style={{
              // Muted convos keep the count visible (per the spec: "still
              // show the per-row unread count") but switch to an ink chip
              // instead of coral — preserves the "silent" affordance.
              background: muted ? 'var(--ink-200)' : (isFreshPulled ? 'var(--unread-fresh)' : 'var(--coral)'),
              color: muted ? 'var(--ink-700)' : (isFreshPulled ? 'var(--unread-fresh-fg)' : 'white'),
            }}
          >{c.unread}</span>
        )}
      </div>
    </div>
  )
}

/** Tooltip for the bell-off glyph — surfaces the auto-unmute time so the
 *  user remembers when notifications come back. */
function muteTooltip(t: Translator, mutedUntil: string | null | undefined): string {
  if (!mutedUntil) return t('convo.muted')
  const until = new Date(mutedUntil)
  if (Number.isNaN(until.getTime())) return t('convo.muted')
  const now = new Date()
  const sameDay = until.toDateString() === now.toDateString()
  const fmt = sameDay
    ? until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : until.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return t('convo.mutedUntil', { when: fmt })
}

/** Strip MD/mention sigils so message snippets read as plain text — we
 *  don't render full markdown in the search dropdown, and seeing raw "**"
 *  and "[@id]" makes hits look noisy. */
function plainSnippet(s: string): string {
  return s
    .replace(/\[@[^\]]+\]/g, (m) => m.replace(/^\[@/, '@').replace(/\]$/, ''))
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
}

/** Highlight every case-insensitive occurrence of `needle` inside `text`. */
function highlight(text: string, needle: string): React.ReactNode {
  if (!needle) return text
  const lo = text.toLowerCase()
  const n = needle.toLowerCase()
  const out: React.ReactNode[] = []
  let i = 0
  let k = 0
  while (i < text.length) {
    const j = lo.indexOf(n, i)
    if (j < 0) { out.push(text.slice(i)); break }
    if (j > i) out.push(text.slice(i, j))
    out.push(<mark key={k++} className="bg-gold/40 text-ink-900 rounded-sm px-0.5">{text.slice(j, j + needle.length)}</mark>)
    i = j + needle.length
  }
  return <>{out}</>
}

interface SearchResultsPaneProps {
  query: string
  results: ApiSearchResults | null
  loading: boolean
  selectedIdx: number
  onHover: (idx: number) => void
  onSelectConversation: (id: string) => void
  onOpenDirect: (participantId: string) => void
}

function SearchSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    <div className="mb-2">
      <div className="px-3 pt-3 pb-1 text-[10px] font-bold text-ink-300 tracking-[0.12em] uppercase flex items-center justify-between">
        <span>{label}</span>
        <span className="text-ink-200 tracking-normal normal-case">{count}</span>
      </div>
      {children}
    </div>
  )
}

/** Shared row classes — `bg-sky2-100` highlights the keyboard-selected row.
 *  The unselected hover state shows on mouse-only nav, but we keep `onHover`
 *  syncing selectedIdx so the highlight tracks the cursor too. */
function rowClass(isSelected: boolean): string {
  return cn(
    'w-full text-left py-2 px-3 rounded-[10px] transition',
    isSelected ? 'bg-sky2-100' : 'hover:bg-sky2-50',
  )
}

function SearchResultsPane({
  query, results, loading, selectedIdx, onHover, onSelectConversation, onOpenDirect,
}: SearchResultsPaneProps) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const q = query.trim()

  // Auto-scroll the keyboard-selected row into view. We look it up by data
  // attribute so the ref doesn't need to be re-bound on every reorder.
  const containerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-search-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  if (loading && !results) {
    return <div className="px-4 py-6 text-[12px] text-ink-300 italic font-display">{t('convo.searching')}</div>
  }
  if (!results) return null
  const total = results.participants.length + results.rooms.length + results.groups.length + results.messages.length
  if (total === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12.5px] text-ink-300 italic font-display">
        {t('convo.noMatches')} <span className="text-ink-700 not-italic font-semibold">"{q}"</span>
      </div>
    )
  }

  // Bucket offsets so each row knows its global index — that's what
  // selectedIdx points into, and what onHover reports back.
  const peopleStart = 0
  const roomsStart = peopleStart + results.participants.length
  const groupsStart = roomsStart + results.rooms.length
  const messagesStart = groupsStart + results.groups.length

  return (
    <div ref={containerRef}>
      <SearchSection label={t('convo.searchPeople')} count={results.participants.length}>
        {results.participants.map((p, i) => {
          const idx = peopleStart + i
          const sel = idx === selectedIdx
          return (
            <button
              type="button"
              key={`p-${p.id}`}
              data-search-idx={idx}
              onMouseEnter={() => onHover(idx)}
              onClick={() => onOpenDirect(p.id)}
              className={cn(rowClass(sel), 'grid grid-cols-[36px_1fr_auto] gap-[11px] items-center')}
            >
              <Avatar
                p={{
                  id: p.id, kind: p.kind, name: p.name, role: p.role ?? undefined,
                  initial: p.initial, avatarBg: p.avatarBg, avatarUrl: p.avatarUrl ?? undefined,
                  status: p.status,
                } as Participant}
                size={36}
                ringColor="var(--paper)"
                showStatus={false}
              />
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink-900 truncate">{highlight(p.name, q)}</div>
                <div className="text-[11px] text-ink-500 truncate">
                  {p.role ?? (p.kind === 'agent' ? t('convo.roleAgent') : t('convo.roleHuman'))}
                </div>
              </div>
              <span className="text-[9px] font-bold py-px px-1.5 rounded uppercase tracking-wider whitespace-nowrap"
                style={{
                  background: p.kind === 'agent' ? 'var(--sky-100, #E1F3FD)' : 'var(--coral-soft)',
                  color: p.kind === 'agent' ? 'var(--skype-deep)' : '#B23A2A',
                }}>{p.kind}</span>
            </button>
          )
        })}
      </SearchSection>

      <SearchSection label={t('convo.searchRooms')} count={results.rooms.length}>
        {results.rooms.map((r, i) => {
          const idx = roomsStart + i
          return (
            <SearchConvoButton
              key={`r-${r.id}`}
              id={r.id}
              kind={r.kind}
              title={r.title}
              members={r.members}
              byId={byId}
              query={q}
              index={idx}
              isSelected={idx === selectedIdx}
              onHover={onHover}
              onClick={() => onSelectConversation(r.id)}
            />
          )
        })}
      </SearchSection>

      <SearchSection label={t('convo.searchGroups')} count={results.groups.length}>
        {results.groups.map((g, i) => {
          const idx = groupsStart + i
          return (
            <SearchConvoButton
              key={`g-${g.id}`}
              id={g.id}
              kind="group"
              title={g.title}
              members={g.members}
              byId={byId}
              query={q}
              index={idx}
              isSelected={idx === selectedIdx}
              onHover={onHover}
              onClick={() => onSelectConversation(g.id)}
            />
          )
        })}
      </SearchSection>

      <SearchSection label={t('convo.searchMessages')} count={results.messages.length}>
        {results.messages.map((m, i) => {
          const idx = messagesStart + i
          const sel = idx === selectedIdx
          const when = new Date(m.createdAt)
          const tsLabel = Number.isNaN(when.getTime()) ? '' : when.toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          })
          return (
            <button
              type="button"
              key={`m-${m.id}`}
              data-search-idx={idx}
              onMouseEnter={() => onHover(idx)}
              onClick={() => onSelectConversation(m.conversationId)}
              className={rowClass(sel)}
            >
              <div className="flex items-center justify-between gap-2 mb-0.5">
                <div className="text-[12px] font-semibold text-ink-900 truncate">
                  <span className="text-ink-500 font-normal">{t('convo.inConvo')}</span> {m.conversationTitle}
                </div>
                <div className="text-[10px] text-ink-300 tabular-nums shrink-0">{tsLabel}</div>
              </div>
              <div className="text-[11.5px] text-ink-500 leading-[1.45] line-clamp-2">
                <span className="text-ink-700 font-medium">{m.authorName ?? t('convo.unknown')}: </span>
                {highlight(plainSnippet(m.snippet), q)}
              </div>
            </button>
          )
        })}
      </SearchSection>
    </div>
  )
}

function SearchConvoButton({ id, kind, title, members, byId, query, index, isSelected, onHover, onClick }: {
  id: string
  kind: 'direct' | 'whisper' | 'group'
  title: string
  members: string[]
  byId: Record<string, Participant>
  query: string
  index: number
  isSelected: boolean
  onHover: (idx: number) => void
  onClick: () => void
}) {
  const t = useT()
  const meId = useMe()
  const ps = members.map((m) => byId[m]).filter((p): p is Participant => Boolean(p))
  // Build a single-button row that mirrors ConvoAvatar's logic but in
  // miniature so the search dropdown rows are visually compact.
  const avatar = (() => {
    if (kind === 'direct') {
      const other = ps.find((p) => p.id !== meId) ?? ps[0]
      return other ? <Avatar p={other} size={36} ringColor="var(--paper)" showStatus={false} /> : null
    }
    return <HiveAvatar ps={ps} size={36} ringColor="var(--paper)" />
  })()
  return (
    <button
      type="button"
      key={id}
      data-search-idx={index}
      onMouseEnter={() => onHover(index)}
      onClick={onClick}
      className={cn(rowClass(isSelected), 'grid grid-cols-[36px_1fr] gap-[11px] items-center')}
    >
      {avatar}
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink-900 truncate">{highlight(title, query)}</div>
        <div className="text-[11px] text-ink-500 truncate">
          {kind === 'whisper' ? t('convo.kindWhisper') : kind === 'group' ? t('convo.kindGroup') : ''}
          {t(members.length === 1 ? 'convo.member' : 'convo.members', { n: members.length })}
        </div>
      </div>
    </button>
  )
}

export function ConversationsPane({ onResizeStart }: { onResizeStart?: (e: React.MouseEvent) => void }) {
  const t = useT()
  const locale = useLocale()
  const selected = useApp((s) => s.selectedConversationId)
  const select = useApp((s) => s.selectConversation)
  const list = useConversations((s) => s.list)
  const loaded = useConversations((s) => s.loaded)
  const byId = useParticipants((s) => s.byId)
  const [filter, setFilter] = useState<Filter>('All')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  // ⌘K / Ctrl+K — focus the search input from anywhere in the app.
  // We register globally rather than on the input so the user can trigger
  // it without first clicking the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Backend search: debounced API call with abort. We must not load every
  // message into the client — the universal search hits SQL on each
  // keystroke (after debounce) and returns four ranked buckets.
  const [results, setResults] = useState<ApiSearchResults | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults(null); setSearching(false); return }
    const ctl = new AbortController()
    setSearching(true)
    const handle = window.setTimeout(() => {
      api.search(q, ctl.signal)
        .then((r) => { setResults(r); setSearching(false) })
        .catch((err) => {
          // AbortError fires every time we cancel a stale request — silent.
          if ((err as { name?: string })?.name === 'AbortError') return
          console.warn('[search] failed', err)
          setSearching(false)
        })
    }, 150)
    return () => { window.clearTimeout(handle); ctl.abort() }
  }, [query])

  // Activating a search hit clears the search and jumps to the convo.
  // Pulled out as callbacks so the keyboard-Enter path and the click path
  // share a single implementation.
  const onSelectFromSearch = useCallback((id: string) => {
    setQuery('')
    select(id)
  }, [select])
  const onOpenDirectFromSearch = useCallback(async (pid: string) => {
    try {
      const { id } = await api.openDirect(pid)
      await useConversations.getState().reload()
      setQuery('')
      select(id)
    } catch (err) { console.warn('[search] openDirect failed', err) }
  }, [select])

  // Keyboard nav over the flat result list. The actions array mirrors the
  // visual order rendered by SearchResultsPane (people → rooms → groups →
  // messages); selectedIdx is an index into it. Enter activates; ↑/↓ and
  // Ctrl+P/Ctrl+N move; Esc clears (handled on the input itself).
  const searchActions = useMemo(() => {
    if (!results) return [] as Array<() => void>
    const out: Array<() => void> = []
    for (const p of results.participants) out.push(() => onOpenDirectFromSearch(p.id))
    for (const r of results.rooms)        out.push(() => onSelectFromSearch(r.id))
    for (const g of results.groups)       out.push(() => onSelectFromSearch(g.id))
    for (const m of results.messages)     out.push(() => onSelectFromSearch(m.conversationId))
    return out
  }, [results, onSelectFromSearch, onOpenDirectFromSearch])
  const [selectedIdx, setSelectedIdx] = useState(0)
  // Reset to the top item every time a new result set lands — otherwise
  // a stale index might point past the new (shorter) list.
  useEffect(() => { setSelectedIdx(0) }, [results])
  const [projects, setProjects] = useState<ApiProject[]>([])
  useEffect(() => {
    void api.listProjects()
      .then((list) => setProjects(list.filter((p) => p.status === 'active' && p.conversationCount > 0)))
      .catch(() => { /* ignore — chips just hide */ })
  }, [list.length])  // reload when conversations change so a new project group appears
  const [creating, setCreating] = useState(false)
  const [creatingWithMember, setCreatingWithMember] = useState<string | null>(null)
  const [addingToGroup, setAddingToGroup] = useState<{ participantId: string; name: string } | null>(null)
  const [addingMembersTo, setAddingMembersTo] = useState<Conversation | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
  const [confirmLeave, setConfirmLeave] = useState<Conversation | null>(null)
  const meId = useAuth((s) => s.user?.id ?? null)

  const otherMember = (c: Conversation): string | null => {
    return c.members.find((m) => m !== meId) ?? null
  }

  const togglePin = async (c: Conversation) => {
    try {
      await api.togglePin(c.id, !c.pinned)
      await useConversations.getState().reload()
    } catch (err) { console.warn('[pin] failed', err) }
  }

  const setMute = async (c: Conversation, mute: boolean, until: Date | null) => {
    try {
      await api.setMute(c.id, mute, until ? until.toISOString() : null)
      await useConversations.getState().reload()
    } catch (err) { console.warn('[mute] failed', err) }
  }

  const openContextMenu = (c: Conversation, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] = []
    items.push({
      label: c.pinned ? t('convo.unpin') : t('convo.pin'),
      icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 17v5"/><path d="M9 10.76V4l-2.5-1.5L5 4l1.5 1.5V10.76A6 6 0 0 0 5 16h14a6 6 0 0 0-1.5-5.24V5.5L19 4l-1.5-1.5L15 4v6.76A6 6 0 0 0 12 11a6 6 0 0 0-3-.24z"/></svg>,
      onSelect: () => togglePin(c),
    })
    // Mute lives right under Pin since both shape "how loud this convo is".
    // When already muted, surface a one-click Unmute at the top of the
    // submenu AND show the active duration as a hint on the parent row.
    const muted = isMuted(c)
    const bellOff = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.9 17.9 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    const muteSubmenu: ContextMenuItem[] = []
    if (muted) {
      muteSubmenu.push({
        label: t('convo.unmute'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
        onSelect: () => void setMute(c, false, null),
      })
    }
    for (const opt of MUTE_DURATIONS) {
      muteSubmenu.push({
        label: t(opt.label),
        onSelect: () => void setMute(c, true, opt.compute()),
      })
    }
    muteSubmenu.push({
      label: t('convo.muteForever'),
      onSelect: () => void setMute(c, true, null),
    })
    items.push({
      label: muted ? t('convo.muted') : t('convo.mute'),
      icon: bellOff,
      hint: muted ? muteHint(t, c.mutedUntil) : undefined,
      submenu: muteSubmenu,
    })
    if (c.kind === 'group') {
      items.push({
        label: t('convo.addMembers'),
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>,
        onSelect: () => setAddingMembersTo(c),
      })
      items.push({
        label: t('convo.leaveGroup'),
        destructive: true,
        icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
        onSelect: () => setConfirmLeave(c),
      })
    } else if (c.kind === 'direct') {
      // Direct chats: actions for the *other* participant.
      const otherId = otherMember(c)
      const other = otherId ? byId[otherId] : undefined
      if (other) {
        items.push({
          label: t('convo.createGroupWith', { name: other.name }),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>,
          onSelect: () => setCreatingWithMember(other.id),
        })
        items.push({
          label: t('convo.addToAGroup', { name: other.name }),
          icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>,
          onSelect: () => setAddingToGroup({ participantId: other.id, name: other.name }),
        })
      }
    }
    if (items.length === 0) return
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  const filtered = useMemo(
    () => list.filter((c) => c.kind !== 'whisper' && matches(c, filter, byId)),
    [list, filter, byId],
  )
  // Pinned floats to the top. Everything else (groups, direct chats with
  // agents, direct chats with humans) goes into one flat list — the row
  // itself already shows whether it's a group (hive avatar) or a DM
  // (single avatar), so section headers were redundant.
  const pinned = filtered.filter((c) => c.pinned)
  const rest = filtered.filter((c) => !c.pinned)

  // Flat list for virtualization — single Virtuoso renders every row, label,
  // and divider via itemContent dispatch. Search-results branch stays on its
  // own (search lists are short + show a different layout).
  const items = useMemo<ConvoListItem[]>(() => {
    const out: ConvoListItem[] = []
    if (!loaded) out.push({ type: 'loading', key: 'loading' })
    if (pinned.length > 0) {
      out.push({ type: 'label', key: 'label:pinned', text: t('convo.pinned') })
      for (const c of pinned) out.push({ type: 'row', key: `p:${c.id}`, c })
      if (rest.length > 0) out.push({ type: 'divider', key: 'divider' })
    }
    for (const c of rest) out.push({ type: 'row', key: `r:${c.id}`, c })
    return out
    // locale in the deps so the baked-in section label re-renders on a
    // language switch (t itself is identity-unstable, locale is not).
  }, [loaded, pinned, rest, locale])

  const sectionLabel = (label: string, hint?: string) => (
    <div className="px-2 pt-3 pb-1.5 text-[10px] font-bold text-ink-300 tracking-[0.12em] uppercase flex items-center justify-between">
      <span>{label}</span>
      {hint && (
        <span className="text-coral text-[10px] not-italic font-semibold tracking-wide normal-case flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-coral animate-pulse-soft" />
          {hint}
        </span>
      )}
    </div>
  )

  return (
    <aside className="relative flex flex-col overflow-hidden border-r border-ink-100 bg-paper">
      <div className="pt-3 px-[18px] pb-2 flex items-center gap-2">
        <h1 className="font-display font-medium text-[20px] tracking-tight text-ink-900 leading-none flex-1 min-w-0 truncate whitespace-nowrap">
          {t('convo.title')}
          <svg
            viewBox="0 0 24 24"
            width="17" height="17"
            className="inline-block ml-2 text-skype-deep align-[-0.18em]"
            aria-hidden="true"
          >
            {/* Two soft overlapping chat bubbles — Cumora's mark of "this is where talking happens". */}
            <path d="M3.2 5.5a3 3 0 0 1 3-3h8.6a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-2.4l-3.6 3.4v-3.4H6.2a3 3 0 0 1-3-3v-5z" fill="currentColor" opacity="0.95"/>
            <path d="M14 11.4h3.5a3 3 0 0 1 3 3v3.4a3 3 0 0 1-3 3h-1.1v2.6l-2.7-2.6h-1.6a3 3 0 0 1-3-3" fill="currentColor" opacity="0.42"/>
          </svg>
        </h1>
        {/* Compose new email — opens the EmailComposer drawer. Lives in
            the header so it's reachable regardless of which filter is
            active; mail isn't a "filter you have to be in" feature. */}
        {/* Header actions are icon-only (labels live in the tooltips) so the
            pane title never truncates or wraps at narrow pane widths. */}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex items-center p-1.5 text-ink-700 bg-cloud border border-ink-100 rounded-[7px] hover:border-sky2-200 hover:text-skype-deep transition shrink-0"
          title={t('convo.newGroup')}
          aria-label={t('convo.newGroup')}
        >
          <IPlus className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={useApp.getState().openComposeNew}
          className="inline-flex items-center p-1.5 text-ink-700 bg-cloud border border-ink-100 rounded-[7px] hover:border-sky2-200 hover:text-skype-deep transition shrink-0"
          title={t('convo.newEmail')}
          aria-label={t('convo.newEmail')}
        >
          <IMail className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      </div>

      <div className="mx-[18px] mb-1 flex items-center gap-2.5 py-1 px-3 bg-cloud border border-ink-100 rounded-[10px] text-ink-300 text-[13px] focus-within:border-sky2-300">
        <ISearch className="w-3.5 h-3.5" strokeWidth={2} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc: bail out of the search overlay entirely.
            if (e.key === 'Escape') { setQuery(''); searchRef.current?.blur(); return }
            // Navigation only matters while we have a result set to move
            // through. Both Emacs (Ctrl+P/N) and arrow keys are accepted —
            // power users on macOS hit Ctrl+P long before they reach for
            // an arrow key.
            const len = searchActions.length
            if (len === 0) return
            const isDown = e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')
            const isUp = e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')
            if (isDown) { e.preventDefault(); setSelectedIdx((i) => Math.min(len - 1, i + 1)); return }
            if (isUp)   { e.preventDefault(); setSelectedIdx((i) => Math.max(0, i - 1)); return }
            if (e.key === 'Enter') {
              e.preventDefault()
              const act = searchActions[Math.max(0, Math.min(len - 1, selectedIdx))]
              if (act) act()
            }
          }}
          className="flex-1 min-w-0 bg-transparent outline-none text-ink-700 placeholder:text-ink-300"
          placeholder={t('convo.searchPlaceholder')}
        />
        {query ? (
          <button
            type="button"
            onClick={() => { setQuery(''); searchRef.current?.focus() }}
            className="shrink-0 grid place-items-center w-4 h-4 rounded-full bg-ink-100 hover:bg-ink-200 text-ink-500 transition"
            aria-label={t('convo.clearSearch')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-2.5 h-2.5">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        ) : (
          <kbd className="font-mono text-[10px] py-px px-1.5 bg-ink-100 rounded text-ink-500 shrink-0">⌘K</kbd>
        )}
      </div>

      {/* Filter chips are hidden while a search is active — the backend
          search has its own categorization and the chips would just add
          noise / conflict with the result buckets. */}
      {!query.trim() && (
      <div
        className="px-[18px] py-1 flex gap-1.5 overflow-x-auto scroll-clean"
        style={{
          // Belt-and-suspenders scrollbar hide — covers macOS users who
          // have "Always show scrollbars" enabled in System Settings,
          // which otherwise forces a track to render despite our CSS.
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        } as React.CSSProperties}
      >
        {staticFilters.map((f) => {
          // Muted convos are excluded — mute means "don't tug at me". A
          // muted unread still shows its own per-row count, but it doesn't
          // pile onto this top-level "Unread" badge.
          const unreadTotal = list.reduce((s, c) => s + (isMuted(c) ? 0 : (c.unread ?? 0)), 0)
          const showBadge = f === 'Unread' && unreadTotal > 0
          const isActive = filter === f
          return (
            <button
              type="button"
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'py-[5px] px-[11px] text-[11px] font-semibold rounded-full whitespace-nowrap border transition inline-flex items-center gap-1.5',
                !isActive && 'bg-cloud border-ink-100 text-ink-500 hover:border-ink-200',
              )}
              style={isActive ? {
                background: 'var(--sky-100)',
                color: 'var(--skype-deep)',
                borderColor: 'var(--sky-200)',
                boxShadow: '0 1px 2px -1px rgba(0, 120, 200, 0.12)',
              } : undefined}
            >
              {t(FILTER_LABEL[f])}
              {showBadge && (
                <span
                  className="inline-grid place-items-center min-w-[16px] h-4 px-1 rounded-full text-[9.5px] font-bold"
                  style={{
                    background: isActive ? 'var(--skype)' : 'var(--coral)',
                    color: 'white',
                  }}
                >{unreadTotal}</span>
              )}
            </button>
          )
        })}
        {projects.length > 0 && (
          <span className="self-center mx-0.5 text-ink-200 text-[14px] leading-none select-none">·</span>
        )}
        {projects.map((p) => {
          const filterKey = `project:${p.id}` as const
          const isActive = filter === filterKey
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => setFilter(filterKey)}
              className={cn(
                'py-[5px] px-[11px] text-[11px] font-semibold rounded-full whitespace-nowrap border transition inline-flex items-center gap-1.5',
                !isActive && 'bg-cloud border-ink-100 text-ink-500 hover:border-ink-200',
              )}
              style={isActive ? {
                background: p.color ?? 'var(--sky-100)',
                color: p.color ? 'white' : 'var(--skype-deep)',
                borderColor: p.color ?? 'var(--sky-200)',
                boxShadow: '0 1px 2px -1px rgba(0, 120, 200, 0.12)',
              } : undefined}
              title={p.description || p.name}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: isActive ? 'rgba(255,255,255,0.85)' : (p.color ?? 'var(--ink-200)') }}
              />
              {p.name}
            </button>
          )
        })}
      </div>
      )}

      {query.trim() ? (
        // Search results — short list with its own layout; non-virtualized.
        <div className="flex-1 overflow-y-auto px-2.5 pb-[18px]">
          <SearchResultsPane
            query={query}
            results={results}
            loading={searching}
            selectedIdx={selectedIdx}
            onHover={setSelectedIdx}
            onSelectConversation={onSelectFromSearch}
            onOpenDirect={onOpenDirectFromSearch}
          />
        </div>
      ) : (
        // The real conversation list — virtualized so workspaces with hundreds
        // of rooms stay snappy. The flat `items` array mixes section labels,
        // the Pinned/Rest divider, and rows; itemContent dispatches by type.
        <div className="flex-1 min-h-0 px-2.5">
          <Virtuoso
            className="h-full"
            data={items}
            computeItemKey={(_, item) => item.key}
            // A typical row is ~62px (avatar + 2 lines). Labels/dividers are
            // smaller; Virtuoso measures everything anyway, this is just the
            // first-pass estimate so the initial scroll isn't jumpy.
            defaultItemHeight={62}
            increaseViewportBy={{ top: 600, bottom: 600 }}
            components={{ Footer: () => <div style={{ height: 18 }} /> }}
            itemContent={(_, item) => {
              if (item.type === 'loading') {
                return <div className="px-3 py-4 text-[12px] text-ink-300 italic font-display">{t('convo.loading')}</div>
              }
              if (item.type === 'label') return sectionLabel(item.text)
              if (item.type === 'divider') {
                // Hairline divider — fading double rule between Pinned + Rest.
                return (
                  <div className="px-3 my-2" aria-hidden="true">
                    <div
                      style={{
                        height: 1,
                        background: 'linear-gradient(90deg, transparent 0%, var(--ink-100) 22%, var(--ink-100) 78%, transparent 100%)',
                      }}
                    />
                  </div>
                )
              }
              const c = item.c
              return (
                <ConvoRow
                  c={c}
                  selected={selected === c.id}
                  onClick={() => select(c.id)}
                  onContextMenu={(e) => openContextMenu(c, e)}
                />
              )
            }}
          />
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {creating && <GroupCreator onClose={() => setCreating(false)} />}
      {creatingWithMember && (
        <GroupCreator
          initialPicked={[creatingWithMember]}
          onClose={() => setCreatingWithMember(null)}
        />
      )}
      {addingToGroup && (
        <AddToGroupPicker
          participantId={addingToGroup.participantId}
          participantName={addingToGroup.name}
          groups={list.filter((c) => c.kind === 'group' && !c.members.includes(addingToGroup.participantId))}
          onClose={() => setAddingToGroup(null)}
        />
      )}
      {addingMembersTo && (
        <AddMembersPicker
          group={addingMembersTo}
          candidates={Object.values(byId).filter((p) => !addingMembersTo.members.includes(p.id) && p.id !== meId)}
          onClose={() => setAddingMembersTo(null)}
        />
      )}
      {confirmLeave && (
        <ConfirmLeave
          c={confirmLeave}
          onCancel={() => setConfirmLeave(null)}
          onLeft={async () => {
            try { await api.leaveConversation(confirmLeave.id) } catch (e) { console.warn('leave failed', e) }
            await useConversations.getState().reload()
            if (selected === confirmLeave.id) select(null)
            setConfirmLeave(null)
          }}
        />
      )}
      {onResizeStart && <ResizeHandle onMouseDown={onResizeStart} />}
    </aside>
  )
}

function AddToGroupPicker({ participantId, participantName, groups, onClose }: {
  participantId: string
  participantName: string
  groups: Conversation[]
  onClose: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<{ groupTitle: string } | null>(null)

  const pick = async (g: Conversation) => {
    setBusy(true); setErr(null)
    try {
      await api.addMember(g.id, participantId)
      await useConversations.getState().reload()
      setDone({ groupTitle: g.title })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[16px] shadow-pop max-w-[440px] w-full max-h-[80vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 shrink-0">
          <h3 className="font-display font-medium text-[18px] tracking-tight">{t('convo.addToTitle', { name: participantName })}</h3>
          <div className="text-[12px] text-ink-500 italic font-display mt-0.5">{t('convo.addToGroupPrompt')}</div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2.5 min-h-0">
          {done ? (
            <div className="py-6 text-center">
              <div className="text-[14px] text-ink-900 font-medium">{t('convo.addedTo')} <em className="not-italic text-skype-deep">"{done.groupTitle}"</em>.</div>
              <div className="text-[12px] text-ink-500 italic font-display mt-1">{t('convo.willSeeMessages', { name: participantName })}</div>
            </div>
          ) : groups.length === 0 ? (
            <div className="py-6 text-center text-[12.5px] text-ink-500 italic font-display">
              {t('convo.noGroupsForAdd', { name: participantName })}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {groups.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  onClick={() => pick(g)}
                  disabled={busy}
                  className="text-left flex items-center gap-3 py-2 px-2.5 rounded-[10px] transition disabled:opacity-50"
                  style={{ background: 'var(--paper)', border: '1.5px solid var(--ink-100)' }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink-900 truncate">{g.title}</div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {t(g.members.length === 1 ? 'convo.member' : 'convo.members', { n: g.members.length })}
                    </div>
                  </div>
                  <span className="text-skype-deep text-[12.5px] font-semibold">+ {t('convo.add')}</span>
                </button>
              ))}
            </div>
          )}
          {err && (
            <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg mt-3">{err}</div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-ink-100 flex items-center justify-end shrink-0 bg-paper">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{done ? t('common.done') : t('common.cancel')}</button>
        </div>
      </div>
    </div>
  )
}

function ConfirmLeave({ c, onCancel, onLeft }: {
  c: Conversation
  onCancel: () => void
  onLeft: () => void | Promise<void>
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onCancel}
    >
      <div
        className="bg-cloud rounded-[16px] shadow-pop max-w-[420px] w-full p-6"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display font-medium text-[20px] tracking-tight mb-1.5">{t('convo.leaveTitle', { title: c.title })}</h3>
        <p className="text-[13px] text-ink-700 leading-[1.6] mb-4">
          {t('convo.leaveWarning')}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-2 px-3 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{t('common.cancel')}</button>
          <button
            type="button"
            onClick={async () => { setBusy(true); await onLeft() }}
            disabled={busy}
            className="flex-1 py-2 px-3 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{ background: 'var(--coral-deep)' }}
          >{busy ? t('convo.leaving') : t('convo.leaveGroup')}</button>
        </div>
      </div>
    </div>
  )
}

/** Modal: pick one or more participants to add to an existing group.
 *  Multi-add via repeated clicks — each click fires the API call and
 *  the participant drops off the candidate list. Close when done. */
function AddMembersPicker({ group, candidates, onClose }: {
  group: Conversation
  candidates: Participant[]
  onClose: () => void
}) {
  const t = useT()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const remaining = candidates.filter((p) => !added.has(p.id))
  const filtered = query.trim()
    ? remaining.filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.id.toLowerCase().includes(query.toLowerCase()))
    : remaining

  const pick = async (p: Participant) => {
    setBusyId(p.id); setErr(null)
    try {
      await api.addMember(group.id, p.id)
      setAdded((s) => new Set(s).add(p.id))
      await useConversations.getState().reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[16px] shadow-pop max-w-[440px] w-full max-h-[80vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 shrink-0">
          <h3 className="font-display font-medium text-[18px] tracking-tight">
            {t('convo.addMembersTo')} <span className="text-skype-deep">{group.title}</span>
          </h3>
          <div className="text-[12px] text-ink-500 italic font-display mt-0.5">
            {remaining.length === 0
              ? t('convo.everyoneAlreadyInGroup')
              : t('convo.clickToAdd', { count: added.size })}
          </div>
        </div>
        {remaining.length > 0 && (
          <div className="px-5 pt-3 shrink-0">
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] bg-paper" style={{ border: '1px solid var(--ink-100)' }}>
              <ISearch className="w-3.5 h-3.5 text-ink-300" strokeWidth={2.4} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('convo.filterPlaceholder')}
                className="flex-1 text-[13px] text-ink-700 bg-transparent outline-none placeholder:text-ink-300"
              />
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto py-2">
          {filtered.length === 0 && query.trim() && (
            <div className="px-6 py-4 text-[12px] italic text-ink-300 font-display">{t('convo.noMatchQuery', { query })}</div>
          )}
          {filtered.map((p) => {
            const busy = busyId === p.id
            return (
              <button
                type="button"
                key={p.id}
                disabled={busy}
                onClick={() => void pick(p)}
                className="w-full text-left flex items-center gap-3 py-2 px-5 hover:bg-sky2-50 transition disabled:opacity-50"
              >
                <Avatar p={p} size={32} ringColor="var(--cloud)" showStatus={false} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold text-ink-900 truncate">{p.name}</div>
                  <div className="text-[11px] text-ink-500 truncate">
                    {p.role ?? (p.kind === 'human' ? t('convo.roleHuman') : t('convo.roleAgent'))}
                  </div>
                </div>
                {busy
                  ? <span className="text-[11px] text-ink-300">{t('convo.adding')}</span>
                  : <span className="text-[11px] text-skype-deep font-semibold">{t('convo.add')}</span>}
              </button>
            )
          })}
          {added.size > 0 && (
            <div className="px-5 pt-3 pb-1 text-[10px] font-bold text-ink-300 tracking-[0.12em] uppercase">
              {t('convo.justAdded')}
            </div>
          )}
          {added.size > 0 && candidates.filter((p) => added.has(p.id)).map((p) => (
            <div key={`done-${p.id}`} className="flex items-center gap-3 py-2 px-5 opacity-60">
              <Avatar p={p} size={28} ringColor="var(--cloud)" showStatus={false} />
              <div className="flex-1 text-[12.5px] text-ink-700 truncate">{p.name}</div>
              <span className="text-[10px] font-semibold text-avail">{t('convo.addedCheck')}</span>
            </div>
          ))}
        </div>
        {err && (
          <div className="px-5 py-2 text-[12px] text-coral-deep bg-coral-soft border-t border-coral-soft shrink-0">
            {err}
          </div>
        )}
        <div className="px-5 py-3 border-t border-ink-100 flex shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="ml-auto py-2 px-4 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{t('common.done')}</button>
        </div>
      </div>
    </div>
  )
}
