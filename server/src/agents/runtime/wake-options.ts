import type { AgentTurnOptions } from '../turn.js'

const MAX_WAKE_PAYLOAD_CHARS = 16_384
const MAX_BRIEF_TITLE_CHARS = 200
const MAX_BRIEF_BODY_CHARS = 12_000
const MAX_BRIEF_SOURCE_CHARS = 128

export type WakeBackgroundBrief = NonNullable<AgentTurnOptions['backgroundBrief']>

export interface ParsedWakeData {
  conversationId: string | null
  at: number | null
  options: AgentTurnOptions
}

export function parseWakeBackgroundBrief(value: unknown): WakeBackgroundBrief | null {
  if (!value || typeof value !== 'object') return null
  const brief = value as { title?: unknown; body?: unknown; source?: unknown }
  if (typeof brief.title !== 'string' || typeof brief.body !== 'string') return null
  const title = brief.title.trim()
  const body = brief.body.trim()
  if (!title || !body) return null
  return {
    title: title.slice(0, MAX_BRIEF_TITLE_CHARS),
    body: body.slice(0, MAX_BRIEF_BODY_CHARS),
    source: typeof brief.source === 'string'
      ? brief.source.trim().slice(0, MAX_BRIEF_SOURCE_CHARS) || undefined
      : undefined,
  }
}

/** Parse the shared SSE wake envelope once for both managed Pods and BYOA
 * daemons. Keeping this at the transport boundary prevents one runner from
 * silently dropping fields that the scheduler already delivered. */
export function parseWakeData(raw: string | undefined): ParsedWakeData {
  const empty: ParsedWakeData = { conversationId: null, at: null, options: {} }
  if (!raw || raw.length > MAX_WAKE_PAYLOAD_CHARS) return empty
  try {
    const parsed = JSON.parse(raw) as {
      reason?: unknown
      conversationId?: unknown
      at?: unknown
      idleReason?: unknown
      triageNote?: unknown
      backgroundBrief?: unknown
      pollBrief?: unknown
    }
    const envelope = {
      conversationId: typeof parsed.conversationId === 'string'
        ? parsed.conversationId.slice(0, 256)
        : null,
      at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null,
    }
    const reason = parsed.reason
    if (
      reason !== 'message.new' &&
      reason !== 'idle' &&
      reason !== 'manual' &&
      reason !== 'background_scan' &&
      reason !== 'poll.updated'
    ) return { ...envelope, options: {} }

    const options: AgentTurnOptions = { trigger: reason }
    if (reason === 'idle' && typeof parsed.idleReason === 'string') {
      options.idleReason = parsed.idleReason.slice(0, 500)
    }
    if (reason === 'message.new' && typeof parsed.triageNote === 'string') {
      options.triageNote = parsed.triageNote.slice(0, 1800)
    }
    if (reason === 'manual' || reason === 'background_scan') {
      const backgroundBrief = parseWakeBackgroundBrief(parsed.backgroundBrief)
      if (backgroundBrief) options.backgroundBrief = backgroundBrief
    }
    if (reason === 'poll.updated' && parsed.pollBrief && typeof parsed.pollBrief === 'object') {
      const brief = parsed.pollBrief as Record<string, unknown>
      const tallies = Array.isArray(brief.tallies) ? brief.tallies.slice(0, 20).flatMap((t) => {
        if (!t || typeof t !== 'object') return []
        const tt = t as Record<string, unknown>
        if (typeof tt.optionId !== 'string' || typeof tt.text !== 'string' || typeof tt.count !== 'number') return []
        const voters = Array.isArray(tt.voters) ? tt.voters.slice(0, 50).flatMap((v) => {
          if (!v || typeof v !== 'object') return []
          const vv = v as Record<string, unknown>
          if (typeof vv.id !== 'string') return []
          return [{ id: vv.id, name: typeof vv.name === 'string' ? vv.name : vv.id }]
        }) : []
        return [{ optionId: tt.optionId, text: tt.text.slice(0, 200), count: tt.count, voters }]
      }) : []
      const pending = Array.isArray(brief.pending) ? brief.pending.slice(0, 50).flatMap((p) => {
        if (!p || typeof p !== 'object') return []
        const pp = p as Record<string, unknown>
        if (typeof pp.id !== 'string') return []
        return [{ id: pp.id, name: typeof pp.name === 'string' ? pp.name : pp.id }]
      }) : []
      const actor = brief.actor && typeof brief.actor === 'object'
        ? brief.actor as Record<string, unknown>
        : { id: null, name: null }
      const phase = brief.phase === 'close' ? 'close' as const : 'vote' as const
      const status = brief.status === 'closed' ? 'closed' as const : 'open' as const
      if (typeof brief.messageId === 'string' && typeof brief.question === 'string') {
        options.pollBrief = {
          messageId: brief.messageId,
          conversationId: typeof brief.conversationId === 'string' ? brief.conversationId : '',
          question: brief.question.slice(0, 500),
          mode: brief.mode === 'multi' ? 'multi' : 'single',
          status,
          closedReason: brief.closedReason === 'expired' || brief.closedReason === 'manual' ? brief.closedReason : null,
          expiresAt: typeof brief.expiresAt === 'string' ? brief.expiresAt : null,
          totalVotes: typeof brief.totalVotes === 'number' ? brief.totalVotes : 0,
          tallies,
          pending,
          actor: {
            id: typeof actor.id === 'string' ? actor.id : null,
            name: typeof actor.name === 'string' ? actor.name : null,
          },
          phase,
        }
      }
    }

    return { ...envelope, options }
  } catch {
    return empty
  }
}

/** Coalesce bursts without losing one assigned card. The debounce/rerun paths
 * carry only one pending turn payload, so multiple briefs are folded into one
 * bounded brief instead of letting the last wake overwrite the first. */
export function mergeWakeBackgroundBriefs(
  current: WakeBackgroundBrief | null | undefined,
  next: WakeBackgroundBrief | null | undefined,
): WakeBackgroundBrief | null {
  if (!current) return next ?? null
  if (!next) return current
  if (
    current.title === next.title &&
    current.body === next.body &&
    current.source === next.source
  ) return current

  const currentSection = `## ${current.title}\n${current.body}`
  const nextSection = `## ${next.title}\n${next.body}`
  const separator = '\n\n'
  // Keep room for both sides even when one producer reaches the transport cap.
  // Card/board ids are at the start of each generated section, so neither wake
  // becomes unidentifiable after truncation.
  const nextBudget = Math.min(
    nextSection.length,
    Math.floor((MAX_BRIEF_BODY_CHARS - separator.length) / 2),
  )
  const currentBudget = MAX_BRIEF_BODY_CHARS - separator.length - nextBudget
  return {
    title: current.title === next.title ? current.title : 'Multiple assigned board updates',
    body: `${currentSection.slice(0, currentBudget)}${separator}${nextSection.slice(0, nextBudget)}`,
    source: current.source === next.source ? current.source : undefined,
  }
}

/** Merge wake options through the Pod's debounce/rerun slot. A manual card
 * brief outranks message/scanner metadata because it has no durable inbox row;
 * conversation activity is still loaded by the turn and rendered alongside it. */
export function mergeWakeTurnOptions(
  current: AgentTurnOptions | null,
  next: AgentTurnOptions | null,
): AgentTurnOptions | null {
  if (!next || Object.keys(next).length === 0) return current
  if (!current) return next
  if (current.trigger === 'manual' || next.trigger === 'manual') {
    const backgroundBrief = mergeWakeBackgroundBriefs(
      current.trigger === 'manual' ? current.backgroundBrief : null,
      next.trigger === 'manual' ? next.backgroundBrief : null,
    )
    return {
      ...current,
      ...next,
      trigger: 'manual',
      ...(backgroundBrief ? { backgroundBrief } : {}),
    }
  }
  if (next.trigger === 'background_scan') return next
  const backgroundBrief = mergeWakeBackgroundBriefs(
    current.backgroundBrief,
    next.backgroundBrief,
  )
  return {
    ...current,
    ...next,
    ...(backgroundBrief ? { backgroundBrief } : {}),
  }
}

/** A manual board brief is itself real work even when chat has no unread row. */
export function wakeHasActionableInput(
  hasRealInboxMessage: boolean,
  backgroundBrief: WakeBackgroundBrief | null | undefined,
): boolean {
  return hasRealInboxMessage || Boolean(
    backgroundBrief?.title.trim() && backgroundBrief.body.trim(),
  )
}
