/**
 * "Is the user actually watching this conversation right now?"
 *
 * `selectedConversationId` was standing in for that, and it is not the same
 * question. Nothing clears it, and three ordinary navigations leave it pointing
 * at a thread the user cannot see:
 *
 *   - the window goes behind another app (still selected, socket still live)
 *   - desktop leaves `view === 'conversations'` — DesktopApp mounts views
 *     conditionally, so the whole ChatPane is unmounted (see the note in
 *     stores/app.ts about composer drafts, which exists for the same reason)
 *   - mobile swipes back to the list or opens the info overlay, which only
 *     moves `mobileStack`
 *
 * In all three the arriving message was marked read on the spot: the sidebar
 * badge never appeared, and `POST /conversations/:id/read` advanced the
 * server's cursor to NOW(), which no reload undoes. There is no unread divider
 * in the thread, so the badge was the only thing that would have said "you
 * missed twenty messages".
 *
 * Requiring both `view` and `mobileStack` keeps this shell-agnostic: desktop
 * never moves `mobileStack` off 'chat' (only src/mobile touches it, and
 * `selectConversation` sets it), and mobile keeps `view === 'conversations'`
 * while it is in a chat.
 */
export interface WatchInputs {
  /** The conversation a message just arrived in. */
  conversationId: string
  selectedConversationId: string | null
  /** `useApp().view` — desktop's top-level section. */
  view: string
  /** `useApp().mobileStack` — which mobile screen is on top. */
  mobileStack: string
  /** Is the app itself in front? See lib/windowAttention. */
  attentive: boolean
}

export function isWatchingConversation(w: WatchInputs): boolean {
  if (!w.attentive) return false
  if (w.selectedConversationId !== w.conversationId) return false
  return w.view === 'conversations' && w.mobileStack === 'chat'
}
