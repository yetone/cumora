import { useMemo, useState } from 'react'
import type { Message, PollTally } from '@/types'
import { api } from '@/api/client'
import { useParticipants } from '@/stores/participants'
import { useMe } from '@/stores/auth'
import { useT } from '@/lib/i18n'
import { Avatar } from './Avatar'
import { cn } from '@/lib/utils'

/**
 * Poll bubble. Renders a kind='poll' message — question + clickable options
 * with live progress bars, voter avatar stacks, and a status footer.
 *
 * Visual language inherits the existing artifact cards (email, document):
 *   - rounded-[12px] border-ink-100 bg-cloud container
 *   - sky2 family for the "selected / counted" hue
 *   - ink-50/100/300/500 for ambient text + dividers
 *
 * Multi-choice mode buffers picks locally and commits on "Submit" so a 3-of-3
 * vote doesn't fire three HTTP requests. Single-choice commits immediately —
 * one click = one vote = instant feedback.
 */

interface Props {
  msg: Message
}

function timeRemaining(iso: string | null): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'expired'
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return '< 1m'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function PollBubble({ msg }: Props) {
  const t = useT()
  const meId = useMe()
  const byId = useParticipants((s) => s.byId)
  const poll = msg.poll
  const tallies = useMemo(() => msg.pollTallies ?? [], [msg.pollTallies])
  const tallyByOption = useMemo(() => {
    const map = new Map<string, PollTally>()
    for (const t of tallies) map.set(t.optionId, t)
    return map
  }, [tallies])

  const myCurrentVotes = useMemo(() => {
    const out = new Set<string>()
    if (!meId) return out
    for (const t of tallies) {
      if (t.voterIds.includes(meId)) out.add(t.optionId)
    }
    return out
  }, [tallies, meId])

  // For multi mode we buffer picks until the user hits "Submit".
  // For single mode pendingPicks is just a 1-element overlay during the
  // optimistic flash before the WS echo lands.
  const [pendingPicks, setPendingPicks] = useState<Set<string> | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // ALL hooks have to live above the conditional return below, otherwise
  // React sees a different hook count between renders (a poll arriving via
  // WS as bare metadata first, then patched with the full payload, would
  // crash the conversation). Keep this useMemo here, not under the early
  // exit.
  const hasUnsavedDelta = useMemo(() => {
    if (!pendingPicks) return false
    if (pendingPicks.size !== myCurrentVotes.size) return true
    for (const id of pendingPicks) if (!myCurrentVotes.has(id)) return true
    return false
  }, [pendingPicks, myCurrentVotes])

  if (!poll) return null

  const isClosed = !!poll.closedAt
  const totalVotes = tallies.reduce((s, t) => s + t.count, 0)
  const author = byId[msg.authorId]

  const displayedPicks = pendingPicks ?? myCurrentVotes

  const commit = async (optionIds: string[]) => {
    setSubmitting(true)
    setErrorMsg(null)
    try {
      await api.castPollVote(msg.id, optionIds)
      // The WS echo will repaint via the messages store; clear the local
      // overlay so we render from the canonical tallies.
      setPendingPicks(null)
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : t('pollBubble.voteFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const onOptionClick = (optionId: string) => {
    if (isClosed || submitting) return
    if (poll.mode === 'single') {
      // Click again on your existing pick = retract. Otherwise = switch.
      const willRetract = myCurrentVotes.has(optionId) && myCurrentVotes.size === 1
      setPendingPicks(new Set(willRetract ? [] : [optionId]))
      void commit(willRetract ? [] : [optionId])
    } else {
      // Toggle inside the buffered selection.
      const base = pendingPicks ?? new Set(myCurrentVotes)
      const next = new Set(base)
      if (next.has(optionId)) next.delete(optionId)
      else next.add(optionId)
      setPendingPicks(next)
    }
  }

  const onSubmitMulti = () => {
    if (!pendingPicks) return
    void commit(Array.from(pendingPicks))
  }
  const onResetMulti = () => setPendingPicks(null)

  const winner = isClosed && tallies.length > 0
    ? tallies.reduce((best, t) => (t.count > best.count ? t : best), tallies[0])
    : null

  const remaining = !isClosed ? timeRemaining(poll.expiresAt) : null

  return (
    <div
      className={cn(
        'mt-2 w-full max-w-[min(100%,580px)] rounded-[12px] border bg-cloud',
        isClosed ? 'border-ink-100 opacity-90' : 'border-ink-100',
        'shadow-[0_1px_0_rgba(15,23,42,0.02)]',
      )}
    >
      {/* Header strip */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5 text-[11.5px] text-ink-500">
        <span aria-hidden className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-sky2-50 text-skype-deep">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="4" height="9" rx="1" />
            <rect x="10" y="6" width="4" height="14" rx="1" />
            <rect x="17" y="14" width="4" height="6" rx="1" />
          </svg>
        </span>
        <span className="font-semibold text-ink-700">{t('pollBubble.pollLabel')}</span>
        <span className="text-ink-300">·</span>
        <span>{author?.name ?? msg.authorId}</span>
        {poll.mode === 'multi' && (
          <span className="ml-1 px-1.5 py-0.5 rounded-full bg-ink-50 text-ink-500 text-[10px] tracking-wide uppercase">{t('pollBubble.multi')}</span>
        )}
        <span className="ml-auto text-ink-400 tabular-nums">
          {isClosed
            ? (poll.closedReason === 'expired' ? t('pollBubble.expired') : t('pollBubble.closed'))
            : (remaining ? t('pollBubble.leftSfx', { n: remaining }) : t('pollBubble.open'))}
        </span>
      </div>

      {/* Question */}
      <div className="px-3.5 pb-2 text-[14px] font-semibold text-ink-900 leading-snug">
        {poll.question}
      </div>

      {/* Options */}
      <div className="px-2.5 pb-2 flex flex-col gap-1">
        {poll.options.map((opt) => {
          const tally = tallyByOption.get(opt.id)
          const count = tally?.count ?? 0
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
          const checked = displayedPicks.has(opt.id)
          const isWinner = winner && winner.optionId === opt.id && count > 0
          const voters = tally?.voterIds ?? []
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onOptionClick(opt.id)}
              disabled={isClosed}
              className={cn(
                'group relative w-full text-left px-3 py-2 rounded-[10px] border transition',
                'flex items-center gap-2.5',
                isClosed ? 'cursor-default' : 'cursor-pointer',
                checked
                  ? 'border-sky2-200 bg-sky2-50'
                  : 'border-transparent hover:border-sky2-100 hover:bg-sky2-50/60',
                isWinner && 'border-sky2-300',
              )}
            >
              {/* Bottom progress bar — width is this option's share of ALL
                  votes (pct, not relative-to-max), so the bars read as the
                  actual vote split at a glance. NB the old full-height fill
                  used bg-ink-50/70 — ink-50 doesn't exist in the palette, so
                  it silently rendered nothing. */}
              <span
                aria-hidden
                className="absolute inset-x-1 bottom-[2px] h-[3px] rounded-full bg-ink-100/60 overflow-hidden pointer-events-none"
              >
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
                    checked ? 'bg-skype' : 'bg-sky2-300',
                  )}
                  style={{ width: `${pct}%` }}
                />
              </span>
              {/* checkbox / radio dot */}
              <span
                aria-hidden
                className={cn(
                  'relative z-[1] shrink-0 inline-flex items-center justify-center transition',
                  poll.mode === 'single' ? 'w-4 h-4 rounded-full' : 'w-4 h-4 rounded-[4px]',
                  checked
                    ? 'bg-skype-deep border border-skype-deep text-white'
                    : 'border border-ink-200 bg-cloud',
                )}
              >
                {checked && (
                  poll.mode === 'single'
                    ? <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    : (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )
                )}
              </span>
              <span className="relative z-[1] flex-1 min-w-0 text-[13.5px] text-ink-800 truncate">
                {opt.text}
                {isWinner && (
                  <span className="ml-1.5 text-[11px] text-skype-deep" title={t('pollBubble.winningTitle')}>★</span>
                )}
              </span>
              <span className="relative z-[1] flex items-center gap-1.5 text-[11.5px] tabular-nums text-ink-500">
                {voters.length > 0 && <VoterStack voterIds={voters} />}
                <span className="font-semibold text-ink-700">{count}</span>
                {totalVotes > 0 && <span className="text-ink-400">· {pct}%</span>}
              </span>
            </button>
          )
        })}
      </div>

      {/* Footer / multi-choice submit */}
      <div className="px-3.5 pb-3 pt-1 flex items-center gap-2 text-[11.5px] text-ink-500 min-h-[28px]">
        <span className="tabular-nums">
          {totalVotes === 0 ? t('pollBubble.noVotes') : (totalVotes === 1 ? t('pollBubble.nVotesOne', { n: totalVotes }) : t('pollBubble.nVotesOther', { n: totalVotes }))}
        </span>
        {!isClosed && myCurrentVotes.size > 0 && (
          <>
            <span className="text-ink-300">·</span>
            <span>{t('pollBubble.youVoted')}</span>
          </>
        )}
        {errorMsg && (
          <span className="text-coral-deep">· {errorMsg}</span>
        )}
        {!isClosed && poll.mode === 'multi' && hasUnsavedDelta && (
          <span className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={onResetMulti}
              disabled={submitting}
              className="px-2 py-0.5 rounded-full text-ink-500 hover:bg-ink-50 transition"
            >
              {t('pollBubble.reset')}
            </button>
            <button
              type="button"
              onClick={onSubmitMulti}
              disabled={submitting}
              className="px-2.5 py-0.5 rounded-full bg-skype-deep text-white font-semibold tracking-wide hover:brightness-105 transition disabled:opacity-50"
            >
              {submitting ? t('pollBubble.saving') : t('pollBubble.submit')}
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

function VoterStack({ voterIds }: { voterIds: string[] }) {
  const byId = useParticipants((s) => s.byId)
  const MAX = 3
  const shown = voterIds.slice(0, MAX)
  const extra = voterIds.length - shown.length
  return (
    <span className="flex items-center -space-x-1">
      {shown.map((id) => {
        const p = byId[id]
        if (!p) return (
          <span
            key={id}
            className="inline-flex w-4 h-4 rounded-full bg-ink-200 ring-1 ring-cloud"
            title={id}
          />
        )
        return (
          <span key={id} className="inline-flex ring-1 ring-cloud rounded-full" title={p.name}>
            <Avatar p={p} size={16} showStatus={false} ringColor="var(--cloud)" />
          </span>
        )
      })}
      {extra > 0 && (
        <span
          className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-ink-100 text-[9px] font-semibold text-ink-600 ring-1 ring-cloud tabular-nums"
          title={`+${extra} more`}
        >
          +{extra}
        </span>
      )}
    </span>
  )
}
