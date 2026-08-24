/**
 * EmailComposer — slide-in drawer for writing real email.
 *
 * Two modes:
 *   - 'new'     : blank thread; user picks recipients (To/Cc), subject, body.
 *   - 'reply'   : pre-filled from an existing email message id; the SERVER
 *                 derives subject (Re:), In-Reply-To, References, and the
 *                 recipient list. The drawer just collects body + optional
 *                 extra Cc.
 *
 * Recipient picker accepts either a bare address or a participant id
 * (resolved server-side against the active company's agents + workspace
 * humans). Pills render with avatar when the id resolves to a known
 * participant.
 *
 * Submission: POSTs to /api/email/send or /api/email/reply/:id. On
 * success: closes drawer, navigates to the resulting thread, and
 * triggers a messages reload so the new bubble shows up. On failure:
 * keeps drawer open + surfaces error inline so the user can edit + retry.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '@/stores/app'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { useMessages } from '@/stores/messages'
import { useAuth } from '@/stores/auth'
import { Avatar } from './Avatar'
import { IMail } from './icons'
import { api } from '@/api/client'
import { cn } from '@/lib/utils'
import type { Message, Participant } from '@/types'
import { useT } from '@/lib/i18n'

/** Pending or completed file attachment in the composer. We track the
 *  upload lifecycle locally so the user gets immediate feedback (filename
 *  + spinner during upload, error state on failure) without round-tripping
 *  the server. Once `state==='done'`, the entry carries the storage key
 *  the send API needs. */
interface ComposerAttachment {
  /** Stable id for React keying; doubles as the upload's correlation id. */
  localId: string
  filename: string
  mimeType: string
  sizeBytes: number
  state: 'uploading' | 'done' | 'error'
  /** Set when state==='done'; the server-side storage key the send API
   *  references so Resend can fetch the file. */
  key?: string
  /** Set when state==='error'; surfaced inline next to the pill. */
  error?: string
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** A single recipient pill. `entry` is either an address string (external)
 *  or a Participant when the id resolved against the participants store —
 *  the avatar renders only in the latter case. */
interface RecipientEntry {
  raw: string
  display: string
  participant: Participant | null
}

function makeEntry(raw: string, byId: Record<string, Participant>): RecipientEntry {
  const trimmed = raw.trim()
  const p = byId[trimmed]
  if (p) return { raw: p.id, display: `${p.name}${p.email ? ` <${p.email}>` : ''}`, participant: p }
  return { raw: trimmed, display: trimmed, participant: null }
}

function PillField({
  label, entries, onChange, placeholder, autocompletePool,
}: {
  label: string
  entries: RecipientEntry[]
  onChange: (next: RecipientEntry[]) => void
  placeholder: string
  autocompletePool: Participant[]
}) {
  const [draft, setDraft] = useState('')
  const [openSuggest, setOpenSuggest] = useState(false)
  const byId = useParticipants((s) => s.byId)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Suggestions: pool members whose name / email contains the draft, minus
  // anything already in entries. Cap at 6 — more than that crowds the UI.
  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase()
    if (!q) return []
    const taken = new Set(entries.map((e) => e.raw))
    return autocompletePool
      .filter((p) => !taken.has(p.id) && (
        p.name.toLowerCase().includes(q) ||
        (p.email ?? '').toLowerCase().includes(q)
      ))
      .slice(0, 6)
  }, [draft, entries, autocompletePool])

  const commit = (raw: string) => {
    const trimmed = raw.trim().replace(/[,;]+$/, '').trim()
    if (!trimmed) return
    if (entries.some((e) => e.raw === trimmed)) { setDraft(''); return }
    onChange([...entries, makeEntry(trimmed, byId)])
    setDraft('')
    setOpenSuggest(false)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault()
      commit(draft)
    } else if (e.key === 'Backspace' && draft === '' && entries.length > 0) {
      // Backspace at empty input pops the last pill — Slack/Gmail behavior.
      onChange(entries.slice(0, -1))
    } else if (e.key === 'Escape') {
      setOpenSuggest(false)
    }
  }

  return (
    <div className="relative grid grid-cols-[60px_1fr] gap-2 items-start py-2 px-3 border-b border-ink-100">
      <span className="text-[10.5px] font-bold text-ink-300 uppercase tracking-wider pt-1.5">{label}</span>
      <div
        className="flex flex-wrap gap-1.5 items-center min-h-[28px] cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {entries.map((e) => (
          <span
            key={e.raw}
            className="inline-flex items-center gap-1 py-0.5 pl-1 pr-1.5 rounded-full bg-sky2-50 border border-sky2-100 text-[12px] text-skype-deep"
          >
            {e.participant && (
              <Avatar p={e.participant} size={16} ringColor="var(--cloud)" showStatus={false} />
            )}
            <span className="leading-none">{e.display}</span>
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); onChange(entries.filter((x) => x.raw !== e.raw)) }}
              className="ml-0.5 text-ink-300 hover:text-coral-deep leading-none"
              aria-label={`Remove ${e.display}`}
            >×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setOpenSuggest(true) }}
          onFocus={() => setOpenSuggest(Boolean(draft))}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => setOpenSuggest(false), 120)}
          placeholder={entries.length === 0 ? placeholder : ''}
          className="flex-1 min-w-[140px] outline-none border-0 bg-transparent text-[13px] text-ink-900 placeholder:text-ink-300"
        />
      </div>
      {openSuggest && suggestions.length > 0 && (
        <div
          className="absolute z-10 left-[68px] right-2 top-full mt-1 bg-cloud rounded-[10px] py-1 max-h-[220px] overflow-y-auto"
          style={{
            border: '1px solid var(--ink-100)',
            boxShadow: '0 12px 32px -10px rgba(10, 30, 60, 0.22), 0 6px 14px -6px rgba(10, 30, 60, 0.14)',
          }}
        >
          {suggestions.map((p) => (
            <button
              key={p.id}
              type="button"
              // mousedown not click — onBlur fires before click, eating the event.
              onMouseDown={(e) => { e.preventDefault(); commit(p.id) }}
              className="w-full text-left flex items-center gap-2.5 py-1.5 px-2.5 hover:bg-sky2-50 transition"
            >
              <Avatar p={p} size={28} ringColor="var(--cloud)" showStatus={false} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-ink-900 truncate">{p.name}</div>
                <div className="text-[11px] text-ink-500 truncate font-mono">{p.email ?? p.id}</div>
              </div>
              <span className="text-[9.5px] font-bold text-ink-300 uppercase tracking-wider">{p.kind}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function EmailComposer() {
  const t = useT()
  const compose = useApp((s) => s.composeEmail)
  const close = useApp((s) => s.closeCompose)
  const select = useApp((s) => s.selectConversation)
  const setView = useApp((s) => s.setView)
  const byId = useParticipants((s) => s.byId)
  const me = useAuth((s) => s.user)

  // Reset on every open — different reply target / mode means fresh state.
  // Keying the entire component on `compose` would reset on every store
  // patch we don't care about, so reset explicitly via an effect instead.
  const [to, setTo] = useState<RecipientEntry[]>([])
  const [cc, setCc] = useState<RecipientEntry[]>([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // Drag-and-drop depth counter — incremented on dragenter, decremented
  // on dragleave. Counting (rather than a single boolean) handles the
  // browser firing dragleave when the cursor crosses between nested
  // children inside the drawer. MUST live above the `if (!open) return`
  // below — hook order has to be stable across renders, including the
  // closed-drawer renders where this hook would otherwise be skipped.
  const [dragDepth, setDragDepth] = useState(0)

  const open = compose !== null
  const isReply = compose?.mode === 'reply'

  // Reply context: when we're replying, find the original message in any
  // loaded conversation so the drawer can show "Re: <subject> · from <addr>".
  // No fetch — if it's not loaded, the preview just falls back to the id.
  const replyOriginal: Message | null = useMemo(() => {
    if (!isReply) return null
    const byConvo = useMessages.getState().byConvo
    for (const list of Object.values(byConvo)) {
      const hit = list.find((m) => m.id === compose.replyToMessageId)
      if (hit) return hit
    }
    return null
  }, [isReply, compose])

  useEffect(() => {
    if (!open) return
    setTo([]); setCc([]); setSubject(''); setBody('')
    setShowCc(false); setSending(false); setError(null)
    setAttachments([])
  }, [open, compose?.mode, isReply ? compose.replyToMessageId : null])

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open || !compose) return null

  // Autocomplete pool: every participant in this workspace EXCEPT the user
  // themselves. Filter to those with an email (agents always have one once
  // minted; humans get auth.email surfaced from /participants now).
  const pool: Participant[] = Object.values(byId).filter(
    (p) => p.id !== me?.id && p.email,
  )

  /** Upload one file in the background, updating its row in the
   *  attachments state as the lifecycle progresses. We don't gate the
   *  composer on upload completion — the user can keep typing while bytes
   *  fly; `submit` later refuses to send until every attachment is `done`. */
  const startUpload = (file: File) => {
    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setAttachments((prev) => [
      ...prev,
      {
        localId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        state: 'uploading',
      },
    ])
    void (async () => {
      try {
        const uploaded = await api.uploadFile(file)
        setAttachments((prev) => prev.map((a) =>
          a.localId === localId
            ? { ...a, state: 'done', key: uploaded.key ?? '' }
            : a,
        ))
      } catch (e) {
        setAttachments((prev) => prev.map((a) =>
          a.localId === localId
            ? { ...a, state: 'error', error: e instanceof Error ? e.message : String(e) }
            : a,
        ))
      }
    })()
  }

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId))
  }

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    for (const f of files) startUpload(f)
    // Reset the input so picking the SAME file twice in a row re-fires.
    e.target.value = ''
  }

  // `dragDepth` is declared with the other hooks above so it stays in
  // the hook order even when the drawer is closed (open=false short-
  // circuits before this point). The boolean here is purely derived.
  const dragOver = dragDepth > 0

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    // Only react when the drag has files (not e.g. text selection or an
    // internal-DOM drag).
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    setDragDepth((n) => n + 1)
  }
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    setDragDepth((n) => Math.max(0, n - 1))
  }
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    // dropEffect=copy gives the user the "+" cursor — clear signal that
    // releasing will attach, not move-or-link.
    e.dataTransfer.dropEffect = 'copy'
  }
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return
    e.preventDefault()
    setDragDepth(0)
    const files = Array.from(e.dataTransfer.files ?? [])
    for (const f of files) startUpload(f)
  }

  const submit = async () => {
    setError(null)
    if (!body.trim()) { setError(t('email.errBodyRequired')); return }
    if (!isReply) {
      if (to.length === 0) { setError(t('email.errAddRecipient')); return }
      if (!subject.trim()) { setError(t('email.errSubjectRequired')); return }
    }
    // Refuse to send while any attachment is still in flight or errored —
    // sending partial would silently drop files and confuse the recipient.
    const pending = attachments.filter((a) => a.state === 'uploading')
    const failed = attachments.filter((a) => a.state === 'error')
    if (pending.length > 0) { setError(t('email.errAttachmentsUploading', { count: pending.length })); return }
    if (failed.length > 0) { setError(t('email.errRemoveFailedAttachments')); return }
    const attachmentArgs = attachments
      .filter((a) => a.state === 'done' && a.key)
      .map((a) => ({ key: a.key!, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes }))
    setSending(true)
    try {
      const result = isReply
        ? await api.replyEmail(compose.replyToMessageId, {
            body: body.trim(),
            cc: cc.map((e) => e.raw),
            attachments: attachmentArgs.length ? attachmentArgs : undefined,
          })
        : await api.sendEmail({
            to: to.map((e) => e.raw),
            cc: cc.length ? cc.map((e) => e.raw) : undefined,
            subject: subject.trim(),
            body: body.trim(),
            attachments: attachmentArgs.length ? attachmentArgs : undefined,
          })
      // Reload conversations + the affected thread's messages so the new
      // bubble appears immediately. The WS pubsub will also deliver the
      // `message.new` event but a hard reload is simpler than racing it.
      await useConversations.getState().reload()
      await useMessages.getState().reloadConversation(result.conversationId)
      setView('conversations')
      select(result.conversationId)
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[55] grid place-items-end pointer-events-none" aria-modal="true">
      {/* Click-outside backdrop. Click anywhere outside the panel to close. */}
      <button
        aria-label={t('email.closeComposerBackdropAria')}
        onClick={close}
        className="absolute inset-0 bg-ink-900/15 pointer-events-auto animate-fade-in"
        style={{ animationDuration: '120ms' }}
      />
      <div
        className="relative pointer-events-auto w-full max-w-[640px] h-full flex flex-col animate-slide-in-right"
        style={{
          background: 'var(--chrome-warm)',
          boxShadow: '-12px 0 32px -10px rgba(60, 50, 30, 0.18)',
        }}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        {dragOver && (
          <div
            // Drop overlay: covers the drawer while dragging, with a
            // dashed outline + hint text. pointer-events-none so the
            // child drop target keeps receiving the event.
            className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none animate-fade-in"
            style={{
              background: 'rgba(0, 168, 240, 0.12)',
              border: '2px dashed var(--skype)',
              borderRadius: '4px',
              animationDuration: '120ms',
            }}
          >
            <div
              className="px-5 py-3 rounded-[10px] bg-cloud border border-sky2-200 text-skype-deep font-semibold text-[13px] flex items-center gap-2"
              style={{ boxShadow: '0 8px 24px -8px rgba(0, 168, 240, 0.35)' }}
            >
              📎 {t('email.dropToAttach')}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 py-3 px-4 border-b border-[rgba(120,110,95,0.25)]">
          <IMail className="w-4 h-4 text-[#7A6A3F]" strokeWidth={2} />
          <h2 className="text-[14px] font-semibold text-ink-900 tracking-tight">
            {isReply ? t('email.composerReplyByEmail') : t('email.composerNewEmail')}
          </h2>
          <button
            type="button"
            onClick={close}
            className="ml-auto w-7 h-7 rounded-full grid place-items-center text-ink-500 hover:bg-cloud transition"
            aria-label={t('email.closeComposerAria')}
          >×</button>
        </div>

        {!isReply && (
          <PillField
            label="To"
            entries={to}
            onChange={setTo}
            placeholder={t('email.toPlaceholder')}
            autocompletePool={pool}
          />
        )}
        {!isReply && (showCc || cc.length > 0 ? (
          <PillField
            label={t('email.ccLabel')}
            entries={cc}
            onChange={setCc}
            placeholder={t('common.optional')}
            autocompletePool={pool}
          />
        ) : (
          <div className="py-1.5 px-3 border-b border-ink-100 text-right">
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="text-[11px] text-skype-deep hover:underline"
            >{t('email.addCc')}</button>
          </div>
        ))}
        {!isReply && (
          <div className="grid grid-cols-[60px_1fr] gap-2 items-center py-2 px-3 border-b border-[rgba(120,110,95,0.25)]">
            <span className="text-[10.5px] font-bold text-ink-300 uppercase tracking-wider">{t('email.subjectLabel')}</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('email.subjectPlaceholder')}
              className="outline-none border-0 bg-transparent text-[15px] text-ink-900 placeholder:text-ink-300 font-display"
            />
          </div>
        )}
        {isReply && replyOriginal?.email && (
          <div className="py-2 px-3 border-b border-[rgba(120,110,95,0.18)] bg-[rgba(120,110,95,0.04)] text-[11.5px] text-ink-500">
            <div className="flex items-baseline gap-2">
              <span className="font-bold text-ink-300 uppercase tracking-wider text-[10px]">Re:</span>
              <span className="text-ink-700 font-medium">{replyOriginal.email.subject || t('email.noSubject')}</span>
            </div>
            <div className="mt-0.5 truncate">
              {t('email.fromLabel')} <span className="text-ink-700">{replyOriginal.email.from}</span>
            </div>
          </div>
        )}
        {isReply && (
          <PillField
            label={t('email.ccLabel')}
            entries={cc}
            onChange={setCc}
            placeholder={t('email.ccPlaceholder')}
            autocompletePool={pool}
          />
        )}

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={isReply ? t('email.writeReplyPh') : t('email.writeMessagePh')}
          className="flex-1 outline-none border-0 bg-transparent py-3 px-4 text-[14px] leading-[1.55] text-ink-700 placeholder:text-ink-300 resize-none font-sans"
          autoFocus
        />

        {attachments.length > 0 && (
          <div className="py-2 px-3 border-t border-[rgba(120,110,95,0.18)] space-y-1">
            {attachments.map((a) => (
              <div key={a.localId} className="flex items-center gap-2 text-[12px]">
                <span className="text-[14px] leading-none">
                  {a.state === 'uploading' ? '⏳' : a.state === 'error' ? '⚠️' : '📎'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-ink-700 font-medium">{a.filename}</div>
                  <div className="text-[10.5px] text-ink-400 uppercase tracking-wider">
                    {a.mimeType} · {humanBytes(a.sizeBytes)}
                    {a.state === 'uploading' && ` · ${t('email.uploading')}`}
                    {a.state === 'error' && ` · ${a.error ?? t('email.uploadFailed')}`}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.localId)}
                  className="shrink-0 text-ink-300 hover:text-coral-deep text-[16px] leading-none px-1"
                  aria-label={`Remove ${a.filename}`}
                >×</button>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="py-2 px-4 text-[12px] text-coral-deep border-t border-[rgba(196,60,50,0.25)]" style={{ background: 'rgba(196, 60, 50, 0.06)' }}>
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 py-3 px-4 border-t border-[rgba(120,110,95,0.25)]">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={onFilePick}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="py-2 px-2.5 text-[12px] font-semibold text-ink-700 bg-cloud border border-ink-100 rounded-[7px] hover:border-sky2-200 hover:text-skype-deep transition disabled:opacity-50"
            title={t('email.attachFile')}
          >📎 Attach</button>
          <span className="text-[11px] text-ink-300 mr-auto">
            {t('email.fromLabel')} <span className="font-mono text-ink-500">{me?.email ?? t('email.noAuthEmail')}</span>
          </span>
          <button
            type="button"
            onClick={close}
            disabled={sending}
            className="py-2 px-3 text-[12px] font-semibold text-ink-700 hover:text-ink-900 transition disabled:opacity-50"
          >{t('common.cancel')}</button>
          <button
            type="button"
            onClick={submit}
            disabled={sending}
            className={cn(
              'py-2 px-4 text-[12px] font-semibold text-white rounded-[9px] transition disabled:opacity-50',
            )}
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.45)',
            }}
          >{sending ? t('email.sending') : isReply ? t('email.sendReply') : t('email.send')}</button>
        </div>
      </div>
    </div>
  )
}
