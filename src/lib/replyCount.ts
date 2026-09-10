/**
 * The "N replies" link under a message is driven by `replyCount`, and it is the
 * only way into the thread drawer — `Message.tsx` gates the app's single
 * `openThreadView` call site on `(msg.replyCount ?? 0) > 0`. So a root whose
 * count is one short does not merely display a wrong number: at zero it hides
 * the entrance entirely, and the person who wrote the reply cannot open the
 * thread they just started.
 *
 * The count is maintained locally because the server does not publish a new one
 * with the reply. That means every path that adds or removes a reply from the
 * local list has to move it by exactly one — which is what this helper is for.
 */
import type { Message } from '@/types'

/** Shift a quoted root's local reply count. No-op when the root is not in the
 *  loaded page (an old message the user has not scrolled back to) or when the
 *  message being counted is not a reply at all. Never goes below zero. */
export function applyReplyCountDelta(
  list: Message[],
  rootId: string | null | undefined,
  delta: number,
): Message[] {
  if (!rootId || delta === 0) return list
  let hit = false
  const next = list.map((m) => {
    if (m.id !== rootId) return m
    hit = true
    return { ...m, replyCount: Math.max(0, (m.replyCount ?? 0) + delta) }
  })
  return hit ? next : list
}
