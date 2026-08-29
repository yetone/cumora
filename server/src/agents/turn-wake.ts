/**
 * Wake classification for `runAgentTurn`.
 *
 * Lives in its own module for the same reason `turn-compaction.ts` does: it is
 * pure decision logic, and a unit test should be able to reach it without
 * dragging turn.ts's runtime client / DB graph into the process.
 */
import type { AgentTurnOptions } from './turn.js'

/** Classify a wake, and decide whether it still deserves a turn when the chat
 *  inbox is EMPTY.
 *
 *  Most wakes exist to answer unread messages, so an empty inbox means there is
 *  nothing to do. The exceptions are wakes that arrive carrying their own brief
 *  — an idle heartbeat, a background scan, a poll update, or a person acting on
 *  a board card. Those have something concrete to act on without a message.
 *
 *  The board case is the one this was extracted for: assigning or @-mentioning
 *  an agent on a card wakes it as `manual`, which was NOT exempt, so the turn
 *  returned before the agent ever looked at the card. The board then sat in Todo
 *  while the work was reported complete in chat.
 *
 *  Exported for tests — pure. */
export function classifyWake(options: AgentTurnOptions, inboxCount: number): {
  idle: boolean
  backgroundScan: boolean
  pollUpdate: boolean
  briefedManual: boolean
  survivesEmptyInbox: boolean
} {
  const idle = options.trigger === 'idle' && inboxCount === 0
  const backgroundScan = options.trigger === 'background_scan' && Boolean(options.backgroundBrief)
  const pollUpdate = options.trigger === 'poll.updated' && Boolean(options.pollBrief)
  // Stays `manual` rather than borrowing `background_scan`: a person moving a
  // card is a real user action, and the synthetic-wake rate limiter and the
  // cerebellum gate both deliberately leave those alone.
  const briefedManual = options.trigger === 'manual' && Boolean(options.backgroundBrief)
  return {
    idle, backgroundScan, pollUpdate, briefedManual,
    survivesEmptyInbox: idle || backgroundScan || pollUpdate || briefedManual,
  }
}

/** Normalize the audit/run metadata shared by synthetic scans and deliberate
 * manual briefs. The storage field predates manual briefs and is still named
 * `backgroundScan`, so its fallback values must preserve the trigger kind or a
 * source-less manual assignment is misleadingly recorded as a scanner run. */
export function describeWakeBackgroundBrief(
  options: AgentTurnOptions,
): { source: string; title: string } | undefined {
  const brief = options.backgroundBrief
  if (!brief || (options.trigger !== 'manual' && options.trigger !== 'background_scan')) {
    return undefined
  }
  const manual = options.trigger === 'manual'
  return {
    source: brief.source || (manual ? 'manual' : 'scanner'),
    title: brief.title || (manual ? 'Assigned work' : 'Background scan'),
  }
}

/** Render a deliberate manual brief without hiding chat that happened to arrive
 * in the same debounce window. The old empty-inbox-only copy said the inbox was
 * empty unconditionally, which could make a valid DM disappear behind a card
 * assignment when both wakes coalesced. */
export function renderBriefedManualWakeContext(
  brief: NonNullable<AgentTurnOptions['backgroundBrief']>,
  renderedConversationContext: string,
  inboxCount: number,
): string {
  const inboxContext = inboxCount > 0
    ? `This wake also contains unread conversation activity. Handle both the assignment and anything addressed to you:\n\n${renderedConversationContext}`
    : 'Your chat inbox is empty; this wake exists because of the action above, so act on THAT rather than looking for a message to answer.'
  return `Someone just put this on you directly — it is a deliberate human or teammate action, not a scan or a heartbeat.

${brief.title || 'Assigned work'}

${brief.body}

${inboxContext}

Handle the work, or say plainly why you are not the right owner. If you genuinely have nothing to do here, call set_turn_status({ status: "done", reason: "...", next_step: "" }) and explain — do not silently drop it.`
}
