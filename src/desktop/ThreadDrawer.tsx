/**
 * Thread drawer — right-pane sidebar that lists every reply to a single
 * root message (i.e. all messages whose quoted_message_id == root.id).
 * Slack-style. Opens via the "N 条回复" link under each bubble.
 *
 * Data flow:
 *   - On mount / rootId change → GET /conversations/:id/messages/:rootId/replies
 *     once, then merge in the main message store's live / optimistic rows.
 *   - Composer at the bottom defaults to quoting the root (so any reply
 *     written here joins the same thread). On send we clear local input
 *     but keep the drawer open.
 */
import { useEffect, useMemo, useState } from 'react'
import { useApp } from '@/stores/app'
import { useMessages } from '@/stores/messages'
import { useParticipants } from '@/stores/participants'
import { api, type ApiMessage } from '@/api/client'
import { MessageRow } from '@/components/Message'
import { Composer } from '@/desktop/ChatPane'
import type { Message, Participant } from '@/types'
import { useT } from '@/lib/i18n'

function apiToMessage(m: ApiMessage): Message {
  const raw = m as unknown as {
    tool?: Message['tool']
    attachment?: Message['attachment']
    whisperLink?: Message['whisperLink']
    quotedMessageId?: string | null
    quoted?: Message['quoted'] | null
    replyCount?: number | null
  }
  return {
    id: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    kind: m.kind,
    body: m.body,
    at: m.at ?? '',
    reactions: m.reactions && m.reactions.length > 0 ? m.reactions : undefined,
    tool: raw.tool ?? undefined,
    attachment: raw.attachment ?? undefined,
    whisperLink: raw.whisperLink ?? undefined,
    quotedMessageId: raw.quotedMessageId ?? undefined,
    quoted: raw.quoted ?? undefined,
    replyCount: raw.replyCount ?? undefined,
  }
}

export function ThreadDrawer() {
  const t = useT()
  const openThread = useApp((s) => s.openThread)
  const close = useApp((s) => s.closeThreadView)
  const byId = useParticipants((s) => s.byId)
  const convoMessages = useMessages((s) => openThread ? (s.byConvo[openThread.convoId] ?? []) : [])
  const root = useMessages((s) => {
    if (!openThread) return undefined
    return (s.byConvo[openThread.convoId] ?? []).find((m) => m.id === openThread.rootId)
  })

  const [replies, setReplies] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const liveReplies = useMemo(() => {
    if (!openThread) return []
    return convoMessages.filter((m) => m.quotedMessageId === openThread.rootId)
  }, [convoMessages, openThread?.rootId])

  const visibleReplies = useMemo(() => {
    const out = [...replies]

    for (const live of liveReplies) {
      const idx = out.findIndex((existing) =>
        existing.id === live.id
          || (!!existing.clientId && existing.clientId === live.clientId)
          || (!!live.clientId && existing.clientId === live.clientId),
      )
      if (idx >= 0) out[idx] = live
      else out.push(live)
    }

    return out
  }, [replies, liveReplies])

  // Refetch on (convoId, rootId) change. The fetched snapshot covers replies
  // already persisted on the server; visibleReplies above folds in messages
  // that arrive over WS or are optimistically inserted by sendUserMessage.
  useEffect(() => {
    if (!openThread) return
    let cancelled = false
    setLoading(true); setErr(null)
    api.getReplies(openThread.convoId, openThread.rootId)
      .then((rows) => {
        if (cancelled) return
        setReplies(rows.map(apiToMessage))
      })
      .catch((e) => {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [openThread])

  if (!openThread || !root) return null

  const rootAuthor = byId[root.authorId]
  const fallbackAuthor: Participant = {
    id: root.authorId,
    kind: 'human',
    name: root.authorId,
    role: '',
    initial: (root.authorId[0] ?? '?').toUpperCase(),
    avatarBg: 'var(--ink-200)',
    status: 'avail',
  }

  return (
    <aside
      className="border-l border-ink-100 overflow-hidden relative flex flex-col"
      style={{ background: 'var(--chrome-pane)' }}
    >
      <header className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-ink-100">
        <div>
          <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-ink-400">{t('thread.title')}</div>
          <div className="text-[13px] text-ink-700 font-semibold mt-0.5">
            {visibleReplies.length} {t(visibleReplies.length === 1 ? 'thread.reply' : 'thread.replyPlural')}
          </div>
        </div>
        <button
          onClick={close}
          aria-label={t('thread.close')}
          className="w-7 h-7 rounded-md grid place-items-center text-ink-500 hover:bg-cloud hover:text-ink-900 transition"
        >×</button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
        {/* Root message — small visual treatment to distinguish from replies. */}
        <div className="rounded-lg border border-ink-100 bg-paper px-3 py-2.5">
          <MessageRow msg={root} author={rootAuthor ?? fallbackAuthor} />
        </div>
        <div className="text-[10.5px] font-bold uppercase tracking-wider text-ink-400 pt-1 border-t border-ink-100 -mb-2">
          {t('thread.replies')}
        </div>

        {loading && <div className="text-[12px] text-ink-400 italic">{t('thread.loading')}</div>}
        {err && <div className="text-[12px] text-coral-deep">{err}</div>}
        {!loading && !err && visibleReplies.length === 0 && (
          <div className="text-[12px] text-ink-400 italic">{t('thread.empty')}</div>
        )}
        {visibleReplies.map((m) => {
          const a = byId[m.authorId] ?? { ...fallbackAuthor, id: m.authorId, name: m.authorId, initial: (m.authorId[0] ?? '?').toUpperCase() }
          return <MessageRow key={m.clientId ?? m.id} msg={m} author={a} />
        })}
      </div>

      <div className="border-t border-ink-100 bg-cloud px-3 py-3">
        <div className="text-[10.5px] text-ink-400 mb-1.5">
          {t('thread.replyingTo')} <span className="text-skype-deep font-semibold">{rootAuthor?.name ?? root.authorId}</span>
        </div>
        <Composer
          convoId={openThread.convoId}
          typingNames={[]}
          threadRootId={openThread.rootId}
          placeholder={t('thread.placeholder')}
        />
      </div>
    </aside>
  )
}
