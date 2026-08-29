import type { WakeBackgroundBrief } from './runtime/wake-options.js'

export interface KanbanWakeCard {
  boardId: string
  cardId: string
  columnId?: string | null
  title?: string | null
  what: string
}

export interface KanbanAssigneeChange {
  nextAssigneeId: string | null
  changed: boolean
}

/** Normalize the PATCH assignee field and distinguish a real reassignment
 * from clients that echo the card's existing controlled value on every edit.
 * Only a real transition should produce an assignment wake. */
export function resolveKanbanAssigneeChange(
  currentAssigneeId: string | null,
  requestedAssigneeId: unknown,
): KanbanAssigneeChange {
  const specified = typeof requestedAssigneeId === 'string' || requestedAssigneeId === null
  if (!specified) {
    return { nextAssigneeId: currentAssigneeId, changed: false }
  }
  const nextAssigneeId = requestedAssigneeId === null
    ? null
    : requestedAssigneeId.trim() || null
  return {
    nextAssigneeId,
    changed: nextAssigneeId !== currentAssigneeId,
  }
}

export function buildKanbanWakeBrief(card: KanbanWakeCard): WakeBackgroundBrief {
  const title = card.title?.slice(0, 200) || null
  return {
    source: 'kanban',
    title: card.what.slice(0, 200),
    body: [
      title ? `Card: ${title}` : null,
      `card id: ${card.cardId}`,
      `board id: ${card.boardId}`,
      card.columnId ? `column id: ${card.columnId}` : null,
      '',
      'Drive it with the board tools rather than only replying in chat:',
      `  cumora card claim ${card.cardId}`,
      `  cumora card comment ${card.cardId} "<progress / evidence>"`,
      `  cumora card move ${card.cardId} <column_id>`,
      '',
      'If the work finishes here, leave the card in a state that says so — a board that still reads Todo while the work is done is worse than no board.',
    ].filter((line) => line !== null).join('\n').slice(0, 12_000),
  }
}

type KanbanWakeAgent = (
  agentId: string,
  reason: 'manual',
  conversationId: null,
  steerPayload: null,
  options: { backgroundBrief: WakeBackgroundBrief },
) => Promise<void>

let wakeAgentForTesting: KanbanWakeAgent | null = null

/** Test seam for proving CLI/REST actions reach the scheduler with the complete
 * brief. Production always leaves this null and dynamically loads scheduler. */
export function __setKanbanWakeAgentForTesting(fn: KanbanWakeAgent | null): void {
  wakeAgentForTesting = fn
}

/** Wake every active agent named by a Kanban action. Both the REST router and
 * agent CLI use this chokepoint so neither path can accidentally emit a bare
 * manual wake: `card` is required and always becomes a background brief. */
export async function wakeKanbanAgents(args: {
  companyId: string
  mentions: string[] | undefined
  actorId: string
  card: KanbanWakeCard
}): Promise<void> {
  try {
    if (!args.mentions || args.mentions.length === 0) return
    const targets = [...new Set(args.mentions)].filter((id) => id !== args.actorId)
    if (targets.length === 0) return
    const { pool } = await import('../db/pool.js')
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM participants
        WHERE kind = 'agent'
          AND company_id = $1
          AND id = ANY($2::text[])
          AND departed_at IS NULL`,
      [args.companyId, targets],
    )
    if (rows.length === 0) return
    const wakeAgent = wakeAgentForTesting ?? (await import('./scheduler.js')).wakeAgent
    const backgroundBrief = buildKanbanWakeBrief(args.card)
    for (const row of rows) {
      void wakeAgent(row.id, 'manual', null, null, { backgroundBrief }).catch((err) => {
        console.warn(`[kanban] wake ${row.id} failed`, err instanceof Error ? err.message : err)
      })
    }
  } catch (err) {
    // The board mutation has already committed. Wake delivery is best-effort,
    // and a transient DB/Redis failure must not become an unhandled rejection.
    console.warn('[kanban] wake agents failed:', err instanceof Error ? err.message : err)
  }
}
