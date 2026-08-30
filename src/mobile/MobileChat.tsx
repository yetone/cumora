import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Pressable } from './Pressable'
import { useLongPress } from './useLongPress'
import { MobileMessageTapback, type TapbackAction } from './MobileMessageTapback'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useConversations, isMuted } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'
import { useMessages, sendUserMessage, messagesFor, toggleReaction, VIRTUOSO_FIRST_INDEX_BASE } from '@/stores/messages'
import type { MessagesState } from '@/stores/messages'
import { Avatar, AvatarStack } from '@/components/Avatar'
import { MessageRow, TypingRow } from '@/components/Message'
import { RichInput, type RichInputHandle } from '@/components/RichInput'
import { ScrollToLatestButton } from '@/components/ScrollToLatestButton'
import { IBack, IConvene, IMore, IClip, IAt, ISmile, ISend, ISearch } from '@/components/icons'
import { api, type ApiAttachment } from '@/api/client'
import type { Message, Participant } from '@/types'
import { cn } from '@/lib/utils'
import { isImeComposing } from '@/lib/keyboard'
import { tapHaptic } from '@/lib/native'
import { COMPOSER_EMOJIS } from '@/lib/emoji'
import { SKYPE_EMOJIS, findSkypeByShortcode } from '@/lib/skypeEmojis'
import { TwEmoji } from '@/components/TwEmoji'
import { SkypeEmoji } from '@/components/SkypeEmoji'
import { useT, type MessageKey } from '@/lib/i18n'

export function MobileChat() {
  const t = useT()
  const convoId = useApp((s) => s.selectedConversationId)
  const select = useApp((s) => s.selectConversation)
  const pushStack = useApp((s) => s.pushMobileStack)
  const setView = useApp((s) => s.setView)
  const byConvo = useMessages((s) => (convoId ? s.byConvo[convoId] : undefined))
  const streaming = useMessages((s) => s.streaming)
  const typingIds = useMessages((s) => (convoId ? s.typing[convoId] ?? null : null))
  const [menuOpen, setMenuOpen] = useState(false)
  const [conveneStarting, setConveneStarting] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiTab, setEmojiTab] = useState<'std' | 'skype'>('std')
  // Older-history pager — virtualization handles the runtime cost of mounting
  // long threads; we still fetch in pages of 80 so a 5k-message room doesn't
  // pay a single huge SQL + JSON parse on cold open. See messages store
  // (`MESSAGES_PAGE_SIZE`) for the server's matching default.
  const hasMoreOlder = useMessages((s) => (convoId ? s.hasMoreOlder[convoId] ?? false : false))
  const loadingOlder = useMessages((s) => (convoId ? s.loadingOlder.has(convoId) : false))
  const loadOlder = useMessages((s) => s.loadOlder)
  // Anchor for upward pagination — the store decrements this per prepend so
  // Virtuoso holds scroll position when older history pages in.
  const firstItemIndex = useMessages((s) => (convoId ? s.firstItemIndex[convoId] ?? VIRTUOSO_FIRST_INDEX_BASE : VIRTUOSO_FIRST_INDEX_BASE))
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)
  const list = useMemo(
    () => messagesFor({ byConvo: byConvo ? { [convoId!]: byConvo } : {}, streaming } as MessagesState, convoId),
    [byConvo, streaming, convoId],
  )
  // Drives the bottom-right "scroll to latest" pill — true means we're pinned
  // at the bottom and the pill stays hidden. Note: there's also an existing
  // `scrollToLatest` (declared below) that snaps with `behavior:'auto'` for the
  // iOS-keyboard path; explicit user clicks want a smooth animation, so we
  // keep a separate handler instead of reusing it.
  const [atBottom, setAtBottom] = useState(true)
  const smoothScrollToLatest = useCallback(() => {
    if (list.length === 0) return
    virtuosoRef.current?.scrollToIndex({ index: list.length - 1, align: 'end', behavior: 'smooth' })
  }, [list.length])
  const conversations = useConversations((s) => s.list)
  const c = useMemo(() => conversations.find((x) => x.id === convoId), [conversations, convoId])
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()
  // Per-convo composer draft, persisted in the global store so the text
  // survives MobileChat unmounts (chat → list → chat keeps the half-typed
  // message). Send + convo-switch clears the entry; the cleanup happens
  // inside `send()` and the convoId effect below.
  const draft = useApp((s) => (convoId ? s.composerDrafts[convoId]?.text ?? '' : ''))
  const setComposerDraft = useApp((s) => s.setComposerDraft)
  const setDraft = useCallback((text: string) => {
    if (!convoId) return
    setComposerDraft(convoId, text)
  }, [convoId, setComposerDraft])
  const [attachment, setAttachment] = useState<ApiAttachment | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  // Per-convo "replying to" pointer, lifted from the global app store so
  // it persists across mounts and matches the desktop composer's UX.
  const replyingToId = useApp((s) => convoId ? s.replyingTo[convoId] : undefined)
  const setReplyingTo = useApp((s) => s.setReplyingTo)
  const replyingToMsg = useMemo(
    () => (replyingToId && byConvo ? byConvo.find((m) => m.id === replyingToId) : undefined),
    [byConvo, replyingToId],
  )
  // @-mention picker state. Hoisted above the early-return below because
  // every hook must run on every render — see ChatPane.tsx note for the
  // same rule. `mention` is null when the picker is closed.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const editorRef = useRef<RichInputHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)

  // Members the user can @-mention. Excludes self. Safe when `c` is
  // undefined (convo not yet loaded) — picker just stays empty.
  const memberPool = useMemo<Participant[]>(() => {
    if (!c) return []
    return c.members
      .map((id) => byId[id])
      .filter((p): p is Participant => Boolean(p) && p.id !== meId)
  }, [c, byId, meId])

  // Picker shows the broadcast token `@all` alongside individual members.
  // Tagged union so insert / keyboard nav can tell them apart without a
  // sentinel id collision (a participant could theoretically be named "all").
  type MentionEntry = { kind: 'all' } | { kind: 'participant'; p: Participant }
  const filteredMentions = useMemo<MentionEntry[]>(() => {
    if (!mention) return []
    const q = mention.query.toLowerCase()
    const out: MentionEntry[] = []
    if (memberPool.length > 0 && (q === '' || 'all'.startsWith(q))) {
      out.push({ kind: 'all' })
    }
    for (const p of memberPool) {
      if (p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)) {
        out.push({ kind: 'participant', p })
        if (out.length >= 7) break
      }
    }
    return out
  }, [mention, memberPool])

  // Virtuoso auto-sticks to the bottom on append via `followOutput`; the
  // legacy manual `el.scrollTop = el.scrollHeight` effect is gone with the
  // <div> stream container it depended on.

  // Reset attachment / mention / emoji-picker side state on convo
  // switch. The composer text itself is reset by REMOUNTING RichInput
  // via `key={convoId}` on the JSX below — that path reads the right
  // draft from the store via defaultValue without going through
  // setValue/moveCaretToEnd, which on iOS implicitly focuses the
  // contenteditable in-gesture and pops the soft keyboard.
  useEffect(() => {
    if (!convoId) return
    setAttachment(null)
    setUploadError(null)
    setMention(null)
    setEmojiOpen(false)
  }, [convoId])

  const onStartReached = useCallback(() => {
    if (!convoId) return
    if (!hasMoreOlder || loadingOlder) return
    void loadOlder(convoId)
  }, [convoId, hasMoreOlder, loadingOlder, loadOlder])

  // Dynamic flags for the stream Header, handed to Virtuoso via `context` so
  // the Header component identity stays stable (see StreamHeader). Memoized so
  // a fresh object only appears when a flag actually changes — not on every
  // streaming tick.
  const streamCtx = useMemo<StreamCtx>(
    () => ({ hasMoreOlder, loadingOlder }),
    [hasMoreOlder, loadingOlder],
  )

  // Snapshot of when this convo opened. Only messages created AFTER
  // this timestamp get the rise-in fade — older history that scrolls
  // back into view via Virtuoso virtualization stays static.
  // Re-snapshot on convo switch so the new convo gets the same
  // "fresh messages only animate" treatment.
  const convoOpenedAtRef = useRef<number>(Date.now())
  useEffect(() => {
    convoOpenedAtRef.current = Date.now()
  }, [convoId])

  // Centralized "jump to message" (quote / `#N`) — virtuoso.scrollToIndex
  // mounts off-screen rows reliably, unlike the old getElementById path that
  // silently no-op'd when Virtuoso had recycled the row. Flashes once mounted.
  const pendingJumpId = useApp((s) => s.pendingJumpMessageId)
  const clearPendingJump = useApp((s) => s.clearPendingJump)
  useEffect(() => {
    if (!pendingJumpId) return
    const index = list.findIndex((m) => m.id === pendingJumpId)
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
      const targetId = pendingJumpId
      const deadline = Date.now() + 800
      const tryFlash = (): void => {
        const el = document.getElementById(`m-${targetId}`)
        if (el) {
          el.classList.add('quote-jump-flash')
          window.setTimeout(() => el.classList.remove('quote-jump-flash'), 1400)
        } else if (Date.now() < deadline) {
          window.setTimeout(tryFlash, 60)
        }
      }
      window.setTimeout(tryFlash, 80)
    }
    clearPendingJump()
  }, [pendingJumpId, list, clearPendingJump])

  // Long-press tapback state. When set, MobileMessageTapback renders
  // an iOS Messages-style reaction strip + action menu anchored to
  // the touch coords. Cleared on dismiss / action / convo switch.
  const [tapback, setTapback] = useState<{ msg: Message; coords: { x: number; y: number } } | null>(null)
  useEffect(() => { setTapback(null) }, [convoId])

  // Keep the latest message visible when the soft keyboard pops up.
  // iOS fires `focusin` on the contenteditable AND a `visualViewport`
  // resize as the keyboard animates in (~300ms). We listen to both
  // so the snap-to-bottom happens at the right moment regardless of
  // which fires first / when the layout settles.
  const scrollToLatest = useCallback(() => {
    const n = list.length
    if (n === 0) return
    virtuosoRef.current?.scrollToIndex({ index: n - 1, align: 'end', behavior: 'auto' })
  }, [list.length])
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      // Only scroll if the editor is focused — otherwise a keyboard
      // resize from some other element shouldn't yank this list.
      const active = document.activeElement
      if (active && active.closest('.rich-input')) scrollToLatest()
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [scrollToLatest])

  // Tap (or scroll) on the message stream while the composer is focused
  // dismisses the soft keyboard — like a native chat. We listen in the CAPTURE
  // phase on the stream container so we run BEFORE the message row's own touch
  // handlers (the long-press/tap-back lives on the rows): a genuine TAP gets
  // swallowed so the first touch only dismisses the keyboard instead of also
  // popping the reaction strip (the "need to tap twice" bug). A scroll-drag
  // still dismisses but is NOT swallowed, so the list scrolls normally.
  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    let armed = false
    const composerFocused = () => {
      const a = document.activeElement as HTMLElement | null
      return !!(a && a.closest('.rich-input'))
    }
    const onStart = (e: TouchEvent) => {
      if (!composerFocused()) { armed = false; return }
      armed = true
      ;(document.activeElement as HTMLElement | null)?.blur() // dismiss keyboard
      // Stop the touch reaching the message row. useLongPress arms its 450ms
      // timer on touchstart and cancels it on touchend; if we only swallowed
      // touchend the timer would still fire and pop the "Reaction / Copy"
      // tap-back. Cutting it at touchstart means the row never engages at all.
      // We do NOT preventDefault, so the list still scrolls under the finger.
      e.stopPropagation()
    }
    const onEnd = (e: TouchEvent) => {
      if (!armed) return
      armed = false
      e.stopPropagation()
      e.preventDefault() // block the synthesized click so nothing else fires
    }
    el.addEventListener('touchstart', onStart, { capture: true })
    el.addEventListener('touchend', onEnd, { capture: true })
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true })
      el.removeEventListener('touchend', onEnd, { capture: true })
    }
  }, [])

  // Reply tap → focus composer. On mobile this lifts the soft keyboard,
  // which is the whole point: hitting reply without the keyboard
  // appearing feels broken. BUT only on user-initiated reply changes —
  // if the user just navigated INTO this convo and there happens to be
  // a leftover replyingToId in the store, focusing on mount would pop
  // the keyboard the user didn't ask for. Guard with a ref that
  // distinguishes the initial value from in-session changes.
  const replyingToInitializedRef = useRef(false)
  useEffect(() => {
    if (!replyingToInitializedRef.current) {
      replyingToInitializedRef.current = true
      return
    }
    if (!replyingToId) return
    requestAnimationFrame(() => editorRef.current?.focus())
  }, [replyingToId])

  if (!convoId || !c) return null

  // Resolve typing ids → display names. Three hardenings over the naive
  // `byId[id]?.name`:
  //   1. Drop the local user (`id !== meId`) — "you are typing…" with your
  //      own composer right there reads as a glitch (matches desktop + the
  //      conversation list, which already filter self; the chat didn't).
  //   2. `.trim()` + fall back to a label: a resolved participant whose name
  //      is blank/whitespace would otherwise slip past a plain `Boolean(n)`
  //      filter and render "<b></b> is typing…" — i.e. the nameless
  //      "is typing…" bug. Now it shows the real name, or a graceful
  //      "An agent / Someone" when the roster row has no usable name.
  //   3. Genuinely-unknown ids (not in byId yet) are still dropped so a
  //      stale/cross-room typing ping can't surface a phantom indicator.
  const typingNames = (typingIds ?? [])
    .filter((id) => id !== meId)
    .map((id) => {
      const p = byId[id]
      if (!p) return null
      const name = p.name?.trim()
      return name || (p.kind === 'agent' ? t('mclist.fallbackAgent') : t('mclist.fallbackSomeone'))
    })
    .filter((n): n is string => Boolean(n))
  const muted = isMuted(c)

  const onConvene = async () => {
    if (!convoId || conveneStarting) return
    setConveneStarting(true)
    try {
      await api.startConvene(convoId, c.title || t('convene.sessionTitleFallback'))
      setView('convene')
    } catch (err) {
      console.warn('start convene failed', err)
    } finally {
      setConveneStarting(false)
    }
  }

  const toggleMute = async () => {
    if (!convoId) return
    try {
      await api.setMute(convoId, !muted)
      await useConversations.getState().reload()
    } catch (err) { console.warn('mute toggle failed', err) }
    setMenuOpen(false)
  }

  const leaveConvo = async () => {
    if (!convoId) return
    if (!confirm(t('mobchat.confirmLeaveBody'))) {
      setMenuOpen(false)
      return
    }
    try {
      await api.leaveConversation(convoId)
      select(null)
      await useConversations.getState().reload()
    } catch (err) { console.warn('leave failed', err) }
    setMenuOpen(false)
  }

  const upload = async (file: File) => {
    setUploading(true); setUploadError(null)
    try {
      const a = await api.uploadFile(file)
      setAttachment(a)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setUploadError(msg)
      window.setTimeout(() => setUploadError(null), 4500)
    } finally {
      setUploading(false)
    }
  }
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) await upload(f)
  }

  // Recompute mention state when the draft or caret moves. Mirrors the
  // desktop logic in ChatPane.tsx so the behaviour stays consistent:
  // - find the latest `@` before the caret
  // - require it sit at the start or after whitespace (not mid-word)
  // - bail if a space has already been typed after `@`
  // - bail if the query is suspiciously long (>30 chars)
  const updateMention = (text: string, caret: number) => {
    const slice = text.slice(0, caret)
    const at = slice.lastIndexOf('@')
    if (at < 0) { setMention(null); return }
    const before = at === 0 ? '' : text[at - 1]
    if (before && !/\s/.test(before)) { setMention(null); return }
    const after = slice.slice(at + 1)
    if (/\s/.test(after)) { setMention(null); return }
    if (after.length > 30) { setMention(null); return }
    setMention({ start: at, query: after })
    setMentionIndex(0)
  }

  /** Splice the partially-typed `@query` out of the serialized draft and
   *  replace it with `@<id> `. Then push the new value into RichInput,
   *  which re-serializes and lets `resolveMention` inflate the token
   *  into an avatar+name chip. Caret lands at the end (acceptable
   *  trade-off, matches desktop ChatPane behaviour). */
  const insertMention = (entry: MentionEntry) => {
    if (!mention) return
    const before = draft.slice(0, mention.start)
    const after = draft.slice(mention.start + 1 + mention.query.length)
    const token = entry.kind === 'all' ? 'all' : entry.p.id
    // Smart separator: if `before` doesn't already end in whitespace,
    // prepend one — happens when the new mention immediately follows
    // a previous mention chip (the typed `@` ends up between the chip
    // and its trailing space, leaving `before` as "@previd"). Without
    // this we'd serialize "@alice@bob" and inflate to two chips
    // squashed together.
    const sep = before && !/\s$/.test(before) ? ' ' : ''
    const insert = `${sep}@${token} `
    const next = `${before}${insert}${after}`.replace(/ {2,}$/, ' ')
    setDraft(next)
    setMention(null)
    editorRef.current?.setValue(next)
    requestAnimationFrame(() => editorRef.current?.focus())
  }

  /** Insert any string at the current caret position (used by the
   *  emoji picker). For Skype shortcodes we route through insertSkype
   *  so the editor renders the animated image inline; everything else
   *  is plain text. */
  const insertAtCursor = (s: string) => {
    const editor = editorRef.current
    if (!editor) return
    const skype = findSkypeByShortcode(s)
    if (skype) editor.insertSkype(skype.key)
    else editor.insertText(s)
    requestAnimationFrame(() => editor.focus())
  }

  /** Tap "@" toolbar button — insert an "@" at the caret to open the
   *  picker. RichInput's onChange will fire `updateMention` for us. */
  const openMentionByButton = () => {
    const editor = editorRef.current
    if (!editor) return
    const caret = editor.getCaretOffset()
    const value = editor.getValue()
    const prevChar = caret > 0 ? value[caret - 1] : ''
    // If we're not at the start of a word, inject a space first so the
    // mention rule (`@` must follow whitespace) actually triggers.
    const prefix = prevChar && !/\s/.test(prevChar) ? ' @' : '@'
    editor.insertText(prefix)
    requestAnimationFrame(() => editor.focus())
  }

  const send = () => {
    const v = draft.trim()
    if (!v && !attachment) return
    if (!convoId) return
    sendUserMessage(convoId, v, attachment, replyingToId ?? null)
    setDraft('')
    editorRef.current?.setValue('')
    setAttachment(null)
    setMention(null)
    setReplyingTo(convoId, null)
    void tapHaptic()
    editorRef.current?.focus()
    // Force-scroll to the new bottom. `followOutput="auto"` only
    // pins to the bottom when the user is already AT the bottom —
    // if they scrolled up to read history before sending, the auto-
    // follow won't fire and the user's own message lands off-screen.
    // Run on the next two frames so Virtuoso has measured the
    // newly-appended row (frame 1) before we scroll to it (frame 2).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const n = useMessages.getState().byConvo?.[convoId]?.length ?? 0
        if (n > 0) {
          virtuosoRef.current?.scrollToIndex({ index: n - 1, align: 'end', behavior: 'smooth' })
        }
      })
    })
  }
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(e)) return

    // Mention picker keyboard nav. On mobile the picker is primarily
    // tap-driven, but external keyboards (iPad, Bluetooth) hit these.
    if (mention && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % filteredMentions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + filteredMentions.length) % filteredMentions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        insertMention(filteredMentions[mentionIndex])
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }
  const canSend = (draft.trim().length > 0 || attachment !== null) && !uploading
  const memberPs = c.members
    .map((m) => byId[m])
    .filter((p): p is Participant => Boolean(p))
  const agents = memberPs.filter((p) => p.kind === 'agent')

  return (
    <section className="flex flex-col h-full bg-cloud overflow-x-hidden">
      {/* Header */}
      <header
        className="bg-cloud/95 backdrop-blur-md sticky top-0 z-10 border-b border-ink-100"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="px-2 py-2.5 flex items-center gap-2">
          <Pressable
            onClick={() => select(null)}
            className="w-10 h-10 grid place-items-center text-ink-700 active:bg-sky2-50 rounded-full"
          >
            <IBack className="w-[22px] h-[22px]" strokeWidth={2} />
          </Pressable>
          <Pressable
            onClick={() => pushStack('info')}
            scale={0.985}
            className="flex-1 flex items-center gap-2.5 py-1 active:opacity-70"
          >
            <AvatarStack ps={agents} size={26} max={3} />
            <div className="text-left flex-1 min-w-0">
              <div className="font-display font-medium text-[16px] text-ink-900 leading-tight truncate" style={{ letterSpacing: '-0.01em' }}>
                {c.title}
              </div>
              <div className="text-[11px] font-semibold flex items-center gap-1 leading-none mt-0.5 text-working">
                <span className="w-1.5 h-1.5 rounded-full animate-pulse-soft bg-working" />
                {t('mobchat.agentsHeader', { n: agents.length })}
              </div>
            </div>
          </Pressable>
          <Pressable
            onClick={onConvene}
            disabled={conveneStarting}
            className="w-10 h-10 grid place-items-center text-ink-700 active:bg-sky2-50 rounded-full disabled:opacity-50"
            aria-label={t('mobchat.startConvene')}
          >
            <IConvene className="w-[20px] h-[20px]" />
          </Pressable>
          <div className="relative">
            <Pressable
              onClick={() => setMenuOpen((v) => !v)}
              haptic="medium"
              className="w-10 h-10 grid place-items-center text-ink-700 active:bg-sky2-50 rounded-full"
              aria-label={t('mobchat.more')}
            >
              <IMore className="w-[20px] h-[20px]" />
            </Pressable>
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setMenuOpen(false)}
                />
                <div
                  className="absolute right-2 top-11 z-30 min-w-[180px] py-1 rounded-[12px] bg-paper animate-rise"
                  style={{
                    border: '1px solid var(--ink-100)',
                    boxShadow: '0 12px 28px -8px rgba(10, 30, 60, 0.20), 0 4px 10px -4px rgba(10, 30, 60, 0.12)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => { pushStack('info'); setMenuOpen(false) }}
                    className="w-full text-left py-2.5 px-3.5 text-[13px] text-ink-700 active:bg-sky2-50"
                  >
                    {t('mobchat.viewDetails')}
                  </button>
                  <button
                    type="button"
                    onClick={toggleMute}
                    className="w-full text-left py-2.5 px-3.5 text-[13px] text-ink-700 active:bg-sky2-50"
                  >
                    {muted ? t('mobchat.unmute') : t('mobchat.muteNotifications')}
                  </button>
                  <div className="h-px bg-ink-100 mx-1.5 my-1" />
                  <button
                    type="button"
                    onClick={leaveConvo}
                    className="w-full text-left py-2.5 px-3.5 text-[13px] text-coral-deep active:bg-coral-soft/60"
                  >
                    {t('mobchat.leaveConversation')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Stream — virtualized via react-virtuoso. Long conversations no
          longer mount every bubble at once; rows outside the viewport
          stay un-rendered, and the older-history pager fires when the
          user scrolls past the top. */}
      <div
        ref={streamRef}
        className="flex-1 relative"
        style={{
          background: 'var(--chat-wash)',
        }}
      >
        <Virtuoso
          ref={virtuosoRef}
          className="h-full"
          data={list}
          firstItemIndex={firstItemIndex}
          // Pin to the bottom on first mount + every append. 'smooth' would
          // animate every WS streaming chunk and feel laggy; 'auto' jumps
          // for new messages while leaving the user free to scroll up.
          followOutput="auto"
          initialTopMostItemIndex={Math.max(0, list.length - 1)}
          startReached={onStartReached}
          // Padding lives inside Header / Footer so virtuoso can measure the
          // first/last items without a wrapping flex container fighting it.
          // STREAM_COMPONENTS is a module-level constant (stable identity) and
          // the dynamic header flags ride along on `context` — recreating this
          // object per render remounted the top-of-list node on every stream
          // tick and was a primary cause of scroll-up jitter. See StreamHeader.
          components={STREAM_COMPONENTS}
          context={streamCtx}
          itemContent={(_index, m) => {
            const author = byId[m.authorId]
            // System / whisper rows render without a resolved author (e.g. the
            // calendar-fired notice has a synthetic system author id).
            if (!author && m.kind !== 'system' && m.kind !== 'whisper-link') return <div className="h-0" />
            // Animate only freshly-arrived messages, not historical
            // rows being remounted as Virtuoso virtualizes the
            // scrollback. Without this gate, scrolling up replays a
            // fade on every row that re-enters the viewport.
            const createdAt = m.at ? new Date(m.at).getTime() : 0
            const animate = createdAt > convoOpenedAtRef.current
            return (
              <MessageRowMobileShell
                msg={m}
                author={author}
                animate={animate}
                onLongPress={(coords) => setTapback({ msg: m, coords })}
              />
            )
          }}
          computeItemKey={(_index, m) => m.clientId ?? m.id}
          // First-pass height estimate for rows Virtuoso hasn't measured yet.
          // A real mobile row (avatar + author line + a few lines of body, and
          // often a card) lands well above the old 88px guess, so every
          // unmeasured row used to "correct" from 88→real as it scrolled into
          // view — on iOS momentum scroll those corrections read as violent
          // jitter. 120 is closer to the median row, shrinking each correction.
          defaultItemHeight={120}
          // Mount + measure rows generously OFF-SCREEN before they're visible.
          // The bigger the TOP cushion, the more upward rows are already at
          // their true height by the time the user scrolls to them, so the
          // size correction settles out of view instead of shoving the row the
          // user is reading. This is the single most effective lever against
          // scroll-up jitter in a variable-height virtual list.
          increaseViewportBy={{ top: 2000, bottom: 800 }}
          atBottomStateChange={setAtBottom}
        />
        {/* Bottom-right "scroll to latest" pill — only when the user has
            scrolled up off the bottom. Sits just above the composer with a
            larger inset than desktop so it clears the soft-keyboard safe area. */}
        <ScrollToLatestButton visible={!atBottom} onClick={smoothScrollToLatest} bottomOffset={20} />
      </div>
      {/* Composer */}
      <div
        className="border-t border-ink-100 bg-cloud px-3 pt-1.5 kb-aware"
      >
        <div className="px-1 pb-1">
          <TypingRow names={typingNames} />
        </div>
        {attachment && (
          <div className="mb-2 inline-flex items-center gap-2.5 py-1.5 px-2 bg-sky2-50 border border-sky2-100 rounded-lg max-w-full">
            {attachment.kind === 'img' ? (
              <img src={attachment.url} alt={attachment.name}
                className="w-10 h-10 object-cover rounded-md shrink-0" />
            ) : (
              <div className="w-10 h-10 rounded-md grid place-items-center shrink-0"
                style={{ background: 'linear-gradient(135deg, #2A2A35, #1A1A22)' }}>
                <IClip className="w-4 h-4 text-white/85" strokeWidth={1.8} />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-ink-700 truncate max-w-[220px]">{attachment.name}</div>
              <div className="text-[10.5px] text-ink-500 truncate">{attachment.mime ?? attachment.kind}{attachment.size ? ` · ${Math.round(attachment.size / 1024)}KB` : ''}</div>
            </div>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              className="ml-1 w-6 h-6 rounded-md grid place-items-center text-ink-500 active:bg-cloud transition shrink-0"
              aria-label={t('mobchat.removeAttachment')}
            >×</button>
          </div>
        )}
        {uploading && (
          <div className="mb-2 text-[11.5px] text-ink-500 italic">{t('mobchat.uploading')}</div>
        )}
        {uploadError && (
          <div className="mb-2 text-[11.5px] py-1 px-2 rounded-md text-coral-deep bg-coral-soft inline-block max-w-full truncate">
            {uploadError}
          </div>
        )}
        {replyingToId && convoId && (
          <div className="mb-2 flex items-stretch gap-2 rounded-md bg-sky2-50 border border-sky2-100 pl-2 pr-1 py-1.5">
            <div className="w-[3px] rounded bg-skype shrink-0" />
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
              <div className="text-[10.5px] font-bold uppercase tracking-wider text-skype-deep">
                {t('mobchat.replyingTo', { name: byId[replyingToMsg?.authorId ?? '']?.name ?? replyingToMsg?.authorId ?? '…' })}
              </div>
              <div className="text-[12px] text-ink-500 truncate">
                {replyingToMsg ? replyingToMsg.body.slice(0, 140).replace(/\n/g, ' ') : t('mobchat.replyLoading')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(convoId, null)}
              className="w-6 h-6 rounded-md grid place-items-center text-ink-500 active:bg-cloud transition shrink-0 self-center"
              aria-label={t('mobchat.cancelReply')}
            >×</button>
          </div>
        )}
        {/* Mention picker. Lives ABOVE the composer row so the keyboard +
            textarea stay anchored at the bottom and the picker grows up.
            onMouseDown preventDefault keeps the textarea from blurring
            when a row is tapped (which would close the picker first). */}
        {mention && filteredMentions.length > 0 && (
          <div
            className="mb-2 rounded-[12px] bg-paper animate-rise overflow-hidden"
            style={{
              border: '1px solid var(--ink-100)',
              boxShadow: '0 12px 28px -8px rgba(10, 30, 60, 0.20), 0 4px 10px -4px rgba(10, 30, 60, 0.12)',
              maxHeight: 240,
              overflowY: 'auto',
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-300">
              {mention.query ? `${t('mobchat.mentionHeader')} ${t('mobchat.mentionQuerySuffix', { query: mention.query })}` : t('mobchat.mentionHeader')}
            </div>
            {filteredMentions.map((entry, i) => {
              const active = i === mentionIndex
              if (entry.kind === 'all') {
                return (
                  <button
                    key="__all"
                    type="button"
                    onClick={() => insertMention(entry)}
                    className={cn(
                      'w-full text-left flex items-center gap-2.5 py-2 px-3 transition',
                      active ? 'bg-sky2-50' : 'active:bg-sky2-50',
                    )}
                  >
                    <img src="/everyone.png" alt="" className="w-[28px] h-[28px] rounded-full object-cover" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-semibold text-ink-900 truncate">{t('mobchat.everyone')}</div>
                      <div className="text-[11px] text-ink-500 truncate">{t('mobchat.notifyAll')}</div>
                    </div>
                  </button>
                )
              }
              const p = entry.p
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => insertMention(entry)}
                  className={cn(
                    'w-full text-left flex items-center gap-2.5 py-2 px-3 transition',
                    active ? 'bg-sky2-50' : 'active:bg-sky2-50',
                  )}
                >
                  <Avatar p={p} size={28} ringColor="var(--paper)" showStatus={false} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink-900 truncate">{p.name}</div>
                    <div className="text-[11px] text-ink-500 truncate">@{p.id}{p.role ? ` · ${p.role}` : ''}</div>
                  </div>
                </button>
              )
            })}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          // No `accept` filter — server's MIME whitelist is the source
          // of truth. Browser-side accept is only a hint anyway.
          className="hidden"
          onChange={onPickFile}
        />
        {/* Two-row composer: textarea + send on top so the input gets
            the full width, action buttons (attach / mention) below. */}
        <div className="flex items-end gap-2">
          <div
            className="flex-1 bg-paper rounded-[20px] py-2 px-3.5 min-h-[40px] flex items-center"
            style={{ border: '1px solid var(--ink-100)' }}
          >
            <RichInput
              key={convoId}
              ref={editorRef}
              defaultValue={draft}
              placeholder={t('mobchat.typeAtToSummon')}
              ariaLabel={t('mobchat.composerAria')}
              className="rich-input flex-1 whitespace-pre-wrap bg-transparent outline-none text-[14px] text-ink-900 leading-[1.4]"
              style={{ minHeight: '1.4em' }}
              maxHeight={120}
              enterKeyHint="send"
              autoCapitalize="sentences"
              autoCorrect="on"
              onChange={(value, caret) => {
                setDraft(value)
                updateMention(value, caret)
              }}
              onFocus={() => {
                // Snap on focus AND on visualViewport resize (the
                // useEffect above). Focus runs immediately, the
                // resize runs once the keyboard finishes animating
                // in — together they cover both fast and slow
                // keyboard paths across iOS versions.
                requestAnimationFrame(scrollToLatest)
              }}
              onBlur={() => setTimeout(() => setMention(null), 120)}
              onKeyDown={onKey}
              resolveMention={(id) => {
                if (id === 'all') {
                  return { name: 'all', initial: '@', avatarBg: 'var(--ink-300)', kind: 'human' }
                }
                const p = byId[id]
                if (!p) return null
                return {
                  name: p.id === meId ? 'you' : p.name,
                  initial: p.initial || p.name.charAt(0).toUpperCase(),
                  avatarBg: typeof p.avatarBg === 'string' ? p.avatarBg : 'var(--ink-300)',
                  kind: p.kind,
                  avatarUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : undefined,
                }
              }}
            />
          </div>
          <Pressable
            onClick={send}
            disabled={!canSend}
            scale={0.9}
            className="w-10 h-10 grid place-items-center rounded-full text-white shrink-0 disabled:opacity-40"
            style={{
              background: canSend
                ? 'linear-gradient(135deg, var(--skype), var(--skype-deep))'
                : 'var(--ink-200)',
              boxShadow: canSend ? '0 4px 12px -3px rgba(0, 168, 240, 0.5)' : 'none',
            }}
            aria-label={t('mobchat.sendAria')}
          >
            <ISend className="w-[18px] h-[18px]" strokeWidth={2} />
          </Pressable>
        </div>
        <div className="flex items-center gap-1 pt-1.5 pb-0.5">
          <Pressable
            onClick={() => fileRef.current?.click()}
            className="w-9 h-9 grid place-items-center text-ink-500 rounded-full active:bg-sky2-50"
            aria-label={t('mobchat.attachFile')}
          >
            <IClip className="w-[20px] h-[20px]" />
          </Pressable>
          <Pressable
            onMouseDown={(e) => e.preventDefault()}
            onClick={openMentionByButton}
            className={cn(
              'w-9 h-9 grid place-items-center rounded-full active:bg-sky2-50',
              mention ? 'text-skype-deep bg-sky2-50' : 'text-ink-500',
            )}
            aria-label={t('mobchat.mentionAria')}
          >
            <IAt className="w-[20px] h-[20px]" />
          </Pressable>
          <Pressable
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEmojiOpen((v) => !v)}
            className={cn(
              'w-9 h-9 grid place-items-center rounded-full active:bg-sky2-50',
              emojiOpen ? 'text-skype-deep bg-sky2-50' : 'text-ink-500',
            )}
            aria-label={t('mobchat.emojiAria')}
          >
            <ISmile className="w-[20px] h-[20px]" />
          </Pressable>
        </div>
        {/* Emoji picker — inline above the composer's tool row so the
            keyboard doesn't cover it. Tabs match the desktop popover
            (Standard Twemoji + Skype emoticons). */}
        {emojiOpen && (
          <div
            className="mt-2 mb-1 rounded-[12px] bg-paper overflow-hidden animate-rise"
            style={{
              border: '1px solid var(--ink-100)',
              boxShadow: '0 -8px 20px -8px rgba(10, 30, 60, 0.10)',
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex gap-1 px-2 pt-2">
              {(['std', 'skype'] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  onClick={() => setEmojiTab(k)}
                  className={cn(
                    'flex-1 text-[11px] font-semibold uppercase tracking-wider py-1.5 rounded-[6px] transition',
                    emojiTab === k ? 'bg-sky2-100 text-skype-deep' : 'text-ink-500 active:bg-sky2-50',
                  )}
                >{k === 'std' ? t('mobchat.emojiStd') : t('mobchat.emojiSkype')}</button>
              ))}
            </div>
            <div className="px-2 py-2 max-h-[220px] overflow-y-auto">
              {emojiTab === 'std' ? (
                <div className="grid grid-cols-8 gap-0.5">
                  {COMPOSER_EMOJIS.map((e) => (
                    <button
                      type="button"
                      key={e}
                      onClick={() => insertAtCursor(e)}
                      className="h-9 grid place-items-center rounded active:bg-sky2-50 transition"
                      aria-label={e}
                    ><TwEmoji emoji={e} size={22} /></button>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-0.5">
                  {SKYPE_EMOJIS.map((e) => (
                    <button
                      type="button"
                      key={e.key}
                      onClick={() => insertAtCursor(e.shortcodes[0])}
                      className="h-10 grid place-items-center rounded active:bg-sky2-50 transition"
                      aria-label={e.label}
                    ><SkypeEmoji name={e.key} size={28} autoPlaySound={false} /></button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <MobileMessageTapback
        open={tapback !== null}
        anchor={tapback?.coords ?? null}
        myReactions={tapback ? (tapback.msg.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji) : []}
        onReact={(emoji) => {
          if (tapback) void toggleReaction(tapback.msg.id, emoji)
        }}
        actions={tapback ? buildMessageTapbackActions(tapback.msg, convoId, setReplyingTo, meId, t) : []}
        onClose={() => setTapback(null)}
      />
    </section>
  )
}

/** Dynamic flags the virtualized stream's Header needs, threaded through
 *  Virtuoso's `context` prop instead of through a fresh `components` object
 *  every render. */
type StreamCtx = { hasMoreOlder: boolean; loadingOlder: boolean }

/** Top-of-list node: either the older-history loading affordance or the
 *  "Beginning" divider once the first page is reached. Defined at MODULE
 *  scope — never recreated per render — which is the whole point: an inline
 *  `components={{ Header: () => … }}` literal makes a brand-new component
 *  *type* on every render, and React unmounts+remounts a node whose type
 *  identity changed. Cumora streams agent messages many times per second, so
 *  that inline Header was being torn down and rebuilt on every streaming tick,
 *  re-measuring the very top of the list and nudging every row below it — a
 *  primary driver of the scroll-up jitter. The flags now arrive via `context`,
 *  which RE-RENDERS these stable components without remounting them.
 *
 *  Height stays constant across the loading↔idle toggle: while more history
 *  exists we always render the same `py-1 px-2.5` pill (text swaps between
 *  "Loading earlier…" and a blank space), so paging never changes the
 *  header's height and never re-anchors the scroll. */
function StreamHeader({ context }: { context?: StreamCtx }) {
  const t = useT()
  const hasMoreOlder = context?.hasMoreOlder ?? false
  const loadingOlder = context?.loadingOlder ?? false
  return (
    <div className="px-3 pt-4 flex flex-col gap-3">
      {hasMoreOlder ? (
        <div className="self-center py-1 px-2.5 rounded-full text-[10.5px] font-medium text-ink-400">
          {loadingOlder ? t('chat.loadingEarlier') : ' '}
        </div>
      ) : (
        <div className="flex items-center gap-3 text-ink-300 text-[10.5px] font-bold tracking-[0.08em] uppercase">
          <span className="flex-1 h-px bg-gradient-to-r from-transparent via-ink-100 to-transparent" />
          {t('chat.beginning')}
          <span className="flex-1 h-px bg-gradient-to-r from-transparent via-ink-100 to-transparent" />
        </div>
      )}
    </div>
  )
}

function StreamFooter() {
  return <div className="h-3" />
}

/** Stable identity — passed to Virtuoso once so it never sees a changed
 *  `components` reference (see StreamHeader for why that matters). */
const STREAM_COMPONENTS = { Header: StreamHeader, Footer: StreamFooter }

/** Per-message wrapper that attaches the long-press detector and
 *  preserves the same padding the bare MessageRow used to ship inside
 *  Virtuoso's itemContent. The wrapper exists as its own component
 *  so the long-press hook gets its own state slot — re-using one
 *  detector across all visible items would cross-fire.
 *
 *  `userSelect: none` + `WebkitTouchCallout: none` are critical:
 *  without them, iOS WKWebView's long-press triggers system text
 *  selection AT THE SAME TIME as our Tapback menu, with the system
 *  occasionally extending the selection across the whole screen
 *  before our menu paints on top — "全屏的文字都被选中了". iOS
 *  Messages itself doesn't allow per-bubble text selection for
 *  exactly this reason; Copy comes through the Tapback menu (our
 *  "Copy text" row), which puts the body on the clipboard
 *  programmatically. */
function MessageRowMobileShell({
  msg, author, animate, onLongPress,
}: {
  msg: Message
  author?: Participant
  animate: boolean
  onLongPress: (coords: { x: number; y: number }) => void
}) {
  const press = useLongPress(onLongPress)
  return (
    <div
      className="px-3 py-2"
      style={{
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
      }}
      {...press}
    >
      <MessageRow msg={msg} author={author} delay={0} animate={animate} />
    </div>
  )
}

/** Build the tapback action rows for a message. Reply is always
 *  available; Copy text appears when the message has a body; Delete
 *  is the user's own messages only. Future passes can layer on
 *  Quote, Thread, Forward, etc. without changing the menu chrome. */
function buildMessageTapbackActions(
  msg: Message,
  convoId: string | null,
  setReplyingTo: (convoId: string, msgId: string | null) => void,
  meId: string | null,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): TapbackAction[] {
  const out: TapbackAction[] = []
  out.push({
    label: t('mobchat.tapbackReply'),
    onClick: () => { if (convoId) setReplyingTo(convoId, msg.id) },
  })
  if (msg.body && msg.body.trim()) {
    out.push({
      label: t('mobchat.tapbackCopy'),
      onClick: () => {
        // Best-effort — `navigator.clipboard.writeText` returns a
        // promise we don't await; failures fall through silently
        // (rare on iOS WKWebView, and there's no good recovery).
        void navigator.clipboard?.writeText(msg.body).catch(() => { /* ignore */ })
      },
    })
  }
  // Delete is only offered for the user's own messages. Mirrors the
  // desktop ChatPane permission model: agents own their own rows.
  if (meId && msg.authorId === meId) {
    out.push({
      label: t('common.delete'),
      destructive: true,
      onClick: () => {
        // Wire deletion later — for now just close, no destructive
        // call. Keeping the row in the menu so the affordance is
        // discoverable + we can light it up the moment the API
        // surface is ready.
      },
    })
  }
  return out
}

export function MobileChatInfo() {
  const t = useT()
  const pushStack = useApp((s) => s.pushMobileStack)
  const setView = useApp((s) => s.setView)
  const convoId = useApp((s) => s.selectedConversationId)
  const c = useConversations((s) => s.list.find((x) => x.id === convoId))
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()
  const openAgentInfo = useApp((s) => s.openAgentInfo)
  const [busy, setBusy] = useState(false)
  // Inline editors for the group's name + topic (groups only — a DM title is
  // derived from the other person and isn't user-editable). Plus a member
  // search filter. All declared before the early returns so the hook order
  // stays stable across renders.
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [editingTopic, setEditingTopic] = useState(false)
  const [topicDraft, setTopicDraft] = useState('')
  const [memberQuery, setMemberQuery] = useState('')
  if (!c) return null

  // For DM / whisper, the page is fundamentally about the OTHER person —
  // show their hero. For a GROUP, there is no single "focus" member, so
  // we render a group-scoped hero (avatar stack + title + counts) and
  // skip the per-agent tools/bio sections. Picking some arbitrary "first
  // agent" and giant-profile-ing them at the top alongside the member
  // list below is what made the group page look like a mash-up.
  const isGroup = c.kind === 'group'
  const focusId = isGroup ? null : (c.members.find((m) => m !== meId) ?? c.members[0])
  const focus = focusId ? byId[focusId] : undefined
  if (!isGroup && !focus) return null

  const muted = isMuted(c)
  const memberPs = c.members.map((m) => byId[m]).filter((p): p is Participant => Boolean(p))
  const agentCount = memberPs.filter((p) => p.kind === 'agent').length
  const humanCount = memberPs.filter((p) => p.kind === 'human').length
  const groupAgents = memberPs.filter((p) => p.kind === 'agent')
  const statusTone = focus?.status ?? 'avail'
  // Localized status pill — same five tones as the desktop ChatPane, just
  // looked up through the i18n layer here so the mobile info card renders
  // the same Chinese/English as everywhere else.
  const statusLabel: Record<string, string> = {
    avail: t('info.statusAvail'),
    working: t('info.statusWorking'),
    thinking: t('info.statusThinking'),
    waiting: t('info.statusWaiting'),
    resting: t('info.statusResting'),
  }

  const startConvene = async () => {
    if (!convoId || busy) return
    setBusy(true)
    try {
      await api.startConvene(convoId, c.title || 'live work session')
      setView('convene')
    } catch (err) { console.warn('start convene failed', err) }
    setBusy(false)
  }

  const onToggleMute = async () => {
    if (!convoId) return
    try {
      await api.setMute(convoId, !muted)
      await useConversations.getState().reload()
    } catch (err) { console.warn('mute toggle failed', err) }
  }

  const onLeave = async () => {
    if (!convoId) return
    if (!confirm(t('mobchat.confirmLeaveBody'))) return
    try {
      await api.leaveConversation(convoId)
      useApp.getState().selectConversation(null)
      await useConversations.getState().reload()
    } catch (err) { console.warn('leave failed', err) }
  }

  // Group rename + topic edit. Optimistic local write, rolled back on a
  // failed network call — mirrors the desktop ChatPane pattern so both
  // surfaces behave identically.
  const startEditTitle = () => { setTitleDraft(c.title); setEditingTitle(true) }
  const saveTitle = async () => {
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!convoId || !next || next === c.title) return
    const prev = c.title
    useConversations.setState((s) => ({ list: s.list.map((x) => x.id === convoId ? { ...x, title: next } : x) }))
    try { await api.setTitle(convoId, next) }
    catch (err) {
      console.warn('[title] rename failed', err)
      useConversations.setState((s) => ({ list: s.list.map((x) => x.id === convoId ? { ...x, title: prev } : x) }))
    }
  }
  const startEditTopic = () => { setTopicDraft(c.topic ?? ''); setEditingTopic(true) }
  const saveTopic = async () => {
    const next = topicDraft.trim() || null
    setEditingTopic(false)
    if (!convoId) return
    const prev = c.topic ?? null
    if (next === prev) return
    useConversations.setState((s) => ({ list: s.list.map((x) => x.id === convoId ? { ...x, topic: next } : x) }))
    try { await api.setTopic(convoId, next) }
    catch (err) {
      console.warn('[topic] save failed', err)
      useConversations.setState((s) => ({ list: s.list.map((x) => x.id === convoId ? { ...x, topic: prev } : x) }))
    }
  }

  // Member search filter — matches name OR id, case-insensitive (same rule
  // as the desktop add-members picker).
  const mq = memberQuery.trim().toLowerCase()
  const filteredMembers = mq
    ? memberPs.filter((p) => p.name.toLowerCase().includes(mq) || p.id.toLowerCase().includes(mq))
    : memberPs

  return (
    <section className="flex flex-col h-full bg-paper overflow-y-auto">
      <header
        className="border-b border-ink-100 bg-cloud/95 backdrop-blur-md sticky top-0 z-10"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="px-2 py-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => pushStack('chat')}
            className="w-10 h-10 grid place-items-center text-ink-700 active:bg-sky2-50 rounded-full transition"
            aria-label={t('mpinfo.back')}
          >
            <IBack className="w-[22px] h-[22px]" strokeWidth={2} />
          </button>
          <h1 className="font-display font-medium text-[18px] text-ink-900" style={{ letterSpacing: '-0.01em' }}>{t('mobchat.details')}</h1>
        </div>
      </header>

      {isGroup ? (
        <div
          className="text-center pt-7 pb-5 px-5 border-b border-ink-100"
          style={{ background: 'radial-gradient(circle at 50% 0%, var(--sky-100), transparent 70%)' }}
        >
          <div className="mx-auto mb-3 inline-flex justify-center">
            <AvatarStack ps={groupAgents} size={64} max={5} />
          </div>
          {editingTitle ? (
            <input
              autoFocus
              type="text"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void saveTitle() }
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              maxLength={80}
              className="block w-full text-center bg-transparent outline-none border-b border-skype-deep font-display font-medium text-[26px] tracking-tight text-ink-900 pb-0.5 mb-1"
            />
          ) : (
            <button
              type="button"
              onClick={startEditTitle}
              className="font-display font-medium text-[26px] tracking-tight mb-1 active:text-skype-deep transition border-b border-dashed border-ink-200 leading-tight max-w-full truncate"
              title={t('mobchat.tapToRename')}
            >{c.title}</button>
          )}
          <div className="font-display italic text-[14px] text-ink-500">
            {memberPs.length} {memberPs.length === 1 ? t('mobchat.memberOne') : t('mobchat.memberMany')}
            {agentCount > 0 && ` · ${agentCount} ${agentCount === 1 ? t('mobchat.agentOne') : t('mobchat.agentMany')}`}
          </div>
          {/* Topic — tap to edit; prompt to add when empty. */}
          {editingTopic ? (
            <input
              autoFocus
              type="text"
              value={topicDraft}
              onChange={(e) => setTopicDraft(e.target.value)}
              onBlur={saveTopic}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void saveTopic() }
                if (e.key === 'Escape') setEditingTopic(false)
              }}
              placeholder={t('mobchat.topicPlaceholder')}
              maxLength={200}
              className="mt-2 block w-full text-center bg-transparent text-[12.5px] text-ink-700 italic font-display placeholder:text-ink-300 outline-none border-b border-sky2-200 focus:border-skype-deep transition pb-0.5"
            />
          ) : c.topic ? (
            <button
              type="button"
              onClick={startEditTopic}
              className="mt-2 block mx-auto max-w-full truncate text-[12.5px] text-ink-500 italic font-display active:text-skype-deep transition"
              title={t('mobchat.tapToEditTopic')}
            >{c.topic}</button>
          ) : (
            <button
              type="button"
              onClick={startEditTopic}
              className="mt-2 inline-block text-[12.5px] text-ink-300 italic font-display active:text-skype-deep transition"
            >{t('mobchat.addTopic')}</button>
          )}
        </div>
      ) : focus ? (
        <div
          className="text-center pt-7 pb-5 px-5 border-b border-ink-100"
          style={{ background: 'radial-gradient(circle at 50% 0%, var(--sky-100), transparent 70%)' }}
        >
          <div className="mx-auto mb-3 inline-block">
            <Avatar p={focus} size={96} ringColor="var(--paper)" />
          </div>
          <h3 className="font-display font-medium text-[26px] tracking-tight mb-1">{focus.name}</h3>
          {focus.role && (
            <div className="font-display italic text-[14px] text-ink-500 mb-3.5">{focus.role}</div>
          )}
          <div className="inline-flex items-center gap-2 py-2 px-4 rounded-full bg-cloud border border-ink-100 text-[13px] text-ink-700 shadow-soft">
            <span className="w-2 h-2 rounded-full animate-pulse-soft" style={{ background: `var(--${statusTone})` }} />
            {statusLabel[statusTone] ?? statusTone}
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 px-4 py-4 border-b border-ink-100">
        <button
          type="button"
          onClick={startConvene}
          disabled={busy}
          className="py-3 px-4 rounded-xl text-white font-semibold text-[13px] active:opacity-80 transition disabled:opacity-50"
          style={{ background: 'var(--skype-ink)' }}
        >
          {busy ? t('mobchat.starting') : t('mobchat.convene')}
        </button>
        <button
          type="button"
          onClick={onToggleMute}
          className="py-3 px-4 rounded-xl bg-cloud border border-ink-100 text-ink-700 font-semibold text-[13px] active:bg-sky2-50 transition"
        >
          {muted ? t('mobchat.unmute') : t('mobchat.mute')}
        </button>
      </div>

      {c.kind !== 'direct' && (
        <div className="py-4 px-5 border-b border-ink-100">
          <h4 className="text-[10.5px] font-bold text-ink-300 tracking-wider uppercase mb-3">{t('mobchat.members')}</h4>
          <div className="grid grid-cols-3 gap-2 mb-3">
            <Stat n={String(memberPs.length)} l={t('mobchat.statMembers')} />
            <Stat n={String(agentCount)} l={t('mobchat.statAgents')} />
            <Stat n={String(humanCount)} l={t('mobchat.statHumans')} />
          </div>
          {/* Search — only worth showing once the list is long enough to
              warrant scanning. Filters by name or @id. */}
          {memberPs.length > 5 && (
            <div className="mb-2.5 flex items-center gap-2 px-2.5 py-1.5 rounded-[10px] bg-paper" style={{ border: '1px solid var(--ink-100)' }}>
              <ISearch className="w-3.5 h-3.5 text-ink-300 shrink-0" strokeWidth={2.4} />
              <input
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                placeholder={t('mobchat.searchMembersPh')}
                className="flex-1 min-w-0 text-[13px] text-ink-700 bg-transparent outline-none placeholder:text-ink-300"
              />
              {memberQuery && (
                <button
                  type="button"
                  onClick={() => setMemberQuery('')}
                  className="w-6 h-6 -mr-1 grid place-items-center text-ink-400 active:text-ink-600 shrink-0"
                  aria-label={t('mobchat.clearSearch')}
                >×</button>
              )}
            </div>
          )}
          <div className="flex flex-col divide-y divide-ink-100 bg-cloud rounded-[12px]" style={{ border: '1px solid var(--ink-100)' }}>
            {filteredMembers.map((p) => {
              const isSelf = p.id === meId
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={isSelf}
                  onClick={() => openAgentInfo(p.id)}
                  className={cn(
                    'flex items-center gap-3 py-2.5 px-3 text-left transition first:rounded-t-[12px] last:rounded-b-[12px]',
                    !isSelf && 'active:bg-sky2-50',
                  )}
                >
                  <Avatar p={p} size={32} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink-900 truncate">
                      {p.name}{isSelf && <span className="text-ink-300 font-normal">{t('mobchat.youSuffix')}</span>}
                    </div>
                    <div className="text-[11px] text-ink-500 truncate font-display italic">
                      {p.kind === 'agent' ? (p.role ?? t('common.agent')) : t('mobchat.humanTeammate')}
                    </div>
                  </div>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: `var(--${p.status ?? 'avail'})` }} />
                  {!isSelf && <IBack className="w-4 h-4 text-ink-200 shrink-0 rotate-180" strokeWidth={2} />}
                </button>
              )
            })}
            {filteredMembers.length === 0 && (
              <div className="py-5 text-center text-[12px] text-ink-400 italic font-display">
                {t('mobchat.noMembersMatch', { query: memberQuery })}
              </div>
            )}
          </div>
        </div>
      )}

      {!isGroup && focus && (focus.tools ?? []).length > 0 && (
        <div className="py-4 px-5 border-b border-ink-100">
          <h4 className="text-[10.5px] font-bold text-ink-300 tracking-wider uppercase mb-3">{t('mobchat.tools')}</h4>
          <div className="grid grid-cols-2 gap-2">
            {(focus.tools ?? []).map((t) => (
              <div key={t} className="py-2.5 px-3 bg-cloud border border-ink-100 rounded-[10px] flex items-center gap-2 text-[12.5px] text-ink-700">
                <span className="w-1.5 h-1.5 rounded-full bg-skype" />
                <b className="font-mono font-medium text-[11.5px] truncate">{t}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isGroup && focus?.bio && (
        <div className="py-4 px-5 border-b border-ink-100">
          <h4 className="text-[10.5px] font-bold text-ink-300 tracking-wider uppercase mb-3">{t('mobchat.about')}</h4>
          <div
            className="py-3 px-3.5 rounded-r-lg font-display italic text-[13px] leading-[1.55] text-ink-700"
            style={{
              background: 'linear-gradient(135deg, var(--sky-50), transparent)',
              borderLeft: '2px solid var(--skype)',
            }}
          >
            {focus.bio}
          </div>
        </div>
      )}

      <div className="py-4 px-5">
        <button
          type="button"
          onClick={onLeave}
          className="w-full py-3 px-4 rounded-[12px] text-[13px] font-semibold text-coral-deep transition text-left active:opacity-70"
          style={{ border: '1px solid rgba(255, 122, 107, 0.3)' }}
        >
          {t('mobchat.leaveConversation')}
          <span className="block font-display italic text-[11px] text-ink-500 mt-0.5">{t('mobchat.agentsContinueWithout')}</span>
        </button>
      </div>
    </section>
  )
}

function Stat({ n, l }: { n: string; l: string }) {
  return (
    <div className="py-3 px-2 bg-cloud border border-ink-100 rounded-[10px] text-center">
      <div className="font-display text-[22px] font-medium text-ink-900 leading-none" style={{ letterSpacing: '-0.02em' }}>{n}</div>
      <div className="text-[10px] font-bold text-ink-500 uppercase tracking-wider mt-1">{l}</div>
    </div>
  )
}
