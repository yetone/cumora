import type { ApiConversation, ApiMessage } from '@/api/client'
import type { Conversation } from '@/types'

/**
 * Pure helpers shared by the two paths that produce a sidebar row: the
 * `GET /conversations` fetch and the in-place patch a `message.new` WS event
 * performs.
 *
 * They live here rather than in the store because the equivalence between
 * those two paths is the whole point — a new message repaints one row instead
 * of refetching the list, which is only safe if the patch lands the row in the
 * exact state a refetch would have.
 */

/** Sidebar timestamp: clock for today, "Yest", then M/D. */
export function timeFromIso(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
  if ((now.getTime() - d.getTime()) < 86400e3 * 2) return 'Yest'
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/**
 * Narrow a WS `message.new` payload to the last-message shape the row renderer
 * reads. The two differ only in the timestamp field name and in the email
 * envelope, which the event carries in full — everything the preview needs is
 * already on the wire, which is why the patch does not need a refetch.
 */
export function lastMessageFromWs(m: ApiMessage): NonNullable<ApiConversation['lastMessage']> {
  return {
    id: m.id,
    authorId: m.authorId,
    kind: m.kind,
    body: m.body,
    tool: m.tool,
    attachment: m.attachment,
    createdAt: m.createdAt ?? m.at,
    email: m.email
      ? { subject: m.email.subject, direction: m.email.direction, from: m.email.from }
      : null,
  }
}

/**
 * Sidebar order, mirroring the server's `ORDER BY c.pinned DESC,
 * c.updated_at DESC`. Applied after a patch so a freshly-active row rises to
 * where a refetch would have put it.
 */
export function bySidebarOrder(a: Conversation, b: Conversation): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  return (b.lastAtIso ?? '').localeCompare(a.lastAtIso ?? '')
}
