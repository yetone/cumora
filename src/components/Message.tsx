import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import hljs from 'highlight.js/lib/common'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { remarkCumora } from '@/lib/remarkCumora'
import type { Message, Participant } from '@/types'
import { Avatar } from './Avatar'
import { HumanBadge } from './HumanBadge'
import { SkypeEmoji } from './SkypeEmoji'
import { TwEmoji } from './TwEmoji'
import { cn, parseBody, parseBlocks } from '@/lib/utils'
import { IBoard, ICalendar, IFile, IFigma, IMail } from './icons'
import { ImageViewer } from './ImageViewer'
import { useParticipants } from '@/stores/participants'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { toggleReaction, retryFailedMessage, discardFailedMessage, useMessages } from '@/stores/messages'
import { api } from '@/api/client'
import { DocumentLink } from './DocumentLink'
import { BoardLink } from './BoardLink'
import { CardLink } from './CardLink'
import { CalendarLink } from './CalendarLink'
import { useResolvedDocumentId, useResolvedBoardId, useResolvedCardId, useResolvedCalendarId } from '@/lib/useArtifactId'
import { useDocuments } from '@/stores/documents'
import { useBoards } from '@/stores/boards'
import { useCalendar } from '@/stores/calendar'
import { PollBubble } from './PollBubble'
import { LinkPreview, firstUrlInBody } from './LinkPreview'
import { useT } from '@/lib/i18n'

function MentionChip({ id }: { id: string }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const openAgentInfo = useApp((s) => s.openAgentInfo)
  const meId = useMe()
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement | null>(null)

  // `@all` is a broadcast token — no participant to resolve. Renders as a
  // coral chip with the shared community portrait inline, so it visually
  // matches participant mention chips (avatar + label) while still reading
  // as "addressed to the whole room".
  if (id === 'all') {
    return (
      <span
        className="inline-flex items-center justify-center gap-1 px-1.5 py-0.5 rounded-full font-semibold text-coral-deep bg-coral-soft"
        style={{ verticalAlign: '-0.15em' }}
      >
        <img src="/everyone.png" alt="" className="w-4 h-4 rounded-full object-cover" />
        <span style={{ lineHeight: '16px' }}>{t('msgview.atAll')}</span>
      </span>
    )
  }

  const p = byId[id]
  // Unknown reference — render as plain `@id` without chip styling, so
  // typos don't get fake-validated. Never resolves the id to a guessed name.
  if (!p) return <span className="text-ink-500">@{id}</span>

  const isMe = p.id === meId
  const isAgent = p.kind === 'agent'
  const label = isMe ? 'you' : p.name

  const enter = () => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    setHoverPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
  }
  const leave = () => setHoverPos(null)
  // Open InfoPane for any participant — humans now have profile cards too
  // (their auth email is the most useful new piece). Self-mentions still
  // skip — clicking your own @you mention shouldn't open your own profile.
  const click = () => { if (!isMe) openAgentInfo(p.id) }

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onClick={click}
        className={cn(
          // Symmetric horizontal padding (avatar + text feel balanced in the
          // chip instead of the avatar grazing the left edge), 4px gap so
          // the @ sign reads as paired with the avatar. The chip is taller
          // than the 14px text line, so we pin its vertical-align with an em
          // offset to center it on the surrounding CJK glyphs. -0.15em was
          // measured against 14px/leading-1.55 CJK text (see RichInput, which
          // uses the same value): `baseline`/`middle` ride high, -0.25em (the
          // old value) sat visibly low. Keep this in sync with RichInput.
          'inline-flex items-center justify-center gap-1 px-1.5 py-0.5 rounded-full font-semibold cursor-pointer transition',
          isAgent ? 'text-skype-deep bg-sky-50 hover:bg-sky-100'
                  : 'text-coral-deep bg-coral-soft hover:brightness-95',
        )}
        style={{ verticalAlign: '-0.15em' }}
      >
        <Avatar p={p} size={16} ringColor="var(--cloud)" showStatus={false} />
        {/* Wrap the label in its own inline-flex box so the parent chip's
         *  \`items-center\` aligns the avatar's geometric center with the
         *  label's geometric center — not with the label's default line
         *  box, which positions glyphs LOWER than its midpoint because of
         *  the font's ascender/descender split. The inner flex re-centers
         *  the glyphs vertically within a 16-px tall slot that matches
         *  the avatar height. */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 16,
            lineHeight: 1,
          }}
        >@{label}</span>
      </span>
      {hoverPos && createPortal(
        <MentionCard p={p} x={hoverPos.x} y={hoverPos.y} />,
        document.body,
      )}
    </>
  )
}

/** Elegant floating preview card shown on @mention hover. Renders via
 *  portal so it escapes scroll-container clipping. */
function MentionCard({ p, x, y }: { p: Participant; x: number; y: number }) {
  const t = useT()
  const ref = useRef<HTMLDivElement | null>(null)
  const [adjusted, setAdjusted] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    // Center horizontally on the anchor; flip up if it would clip the bottom
    let left = x - r.width / 2
    let top = y
    const margin = 8
    if (left < margin) left = margin
    if (left + r.width > window.innerWidth - margin) left = window.innerWidth - r.width - margin
    if (top + r.height > window.innerHeight - margin) top = y - r.height - 18  // flip above the anchor
    setAdjusted({ left, top })
  }, [x, y])
  const role = p.role || (p.kind === 'human' ? t('mobchat.humanTeammate') : t('common.agent'))
  return (
    <div
      ref={ref}
      className="fixed z-[60] animate-rise"
      style={{
        left: adjusted?.left ?? x,
        top: adjusted?.top ?? y,
        visibility: adjusted ? 'visible' : 'hidden',
        pointerEvents: 'none',
      }}
    >
      <div
        className="bg-cloud rounded-[14px] py-3 px-3.5 flex items-start gap-3 min-w-[240px] max-w-[300px]"
        style={{
          border: '1px solid var(--ink-100)',
          boxShadow: '0 12px 32px -10px rgba(10, 30, 60, 0.22), 0 6px 14px -6px rgba(10, 30, 60, 0.14)',
        }}
      >
        <Avatar p={p} size={44} ringColor="var(--cloud)" showStatus={false} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-[14px] text-ink-900 truncate">{p.name}</div>
          <div className="text-[11.5px] font-display italic text-ink-500 truncate mb-1">{role}</div>
          {p.bio && (
            <div className="text-[11.5px] text-ink-500 leading-[1.45] line-clamp-3">{p.bio}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Restrained, paper-toned code block matching Cumora's overall light
 *  palette. Token colors map onto the brand: keywords use --skype-deep,
 *  strings use --coral-deep, numbers --gold-deep, types --whisper-deep,
 *  comments italic --ink-300. Deliberately NOT a heavy dark card — sits
 *  inside the bubble as a calm inset instead. */
export function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    }).catch(() => { /* ignore — clipboard denied */ })
  }
  // Tokenize with highlight.js. Common-lang build covers ts/js/py/go/rust/
  // json/bash/sql/css/html/md/etc. Unknown lang → auto-detect rather than
  // refuse, so unannotated fences still get color.
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      }
      return hljs.highlightAuto(code).value
    } catch {
      // hljs throws on certain malformed inputs — fall back to escaped raw.
      const div = document.createElement('div')
      div.textContent = code
      return div.innerHTML
    }
  }, [code, lang])

  return (
    <div
      className="my-1.5 rounded-[8px] overflow-hidden font-mono"
      style={{
        background: 'rgba(15, 30, 50, 0.035)',
        border: '1px solid var(--ink-100)',
        maxWidth: '100%',
      }}
    >
      <div
        className="flex items-center px-3 py-1 text-[10px] tracking-[0.14em] uppercase"
        style={{
          color: 'var(--ink-300)',
          borderBottom: '1px solid var(--ink-100)',
        }}
      >
        <span className="font-bold">{lang || 'text'}</span>
        <button
          type="button"
          onClick={onCopy}
          className="ml-auto text-[9.5px] font-bold py-0.5 px-1.5 rounded transition tracking-[0.12em]"
          style={{
            color: copied ? 'var(--avail)' : 'var(--ink-500)',
            background: copied ? 'rgba(110, 197, 106, 0.10)' : 'transparent',
          }}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <pre
        className="cumora-code overflow-x-auto py-2.5 px-3.5 text-[12.5px] leading-[1.6]"
        style={{ color: 'var(--ink-700)', margin: 0, whiteSpace: 'pre' }}
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: `html` is
            highlight.js output over the message's own code text — hljs
            HTML-escapes the source, and the catch fallback escapes via
            textContent→innerHTML. No untrusted raw HTML reaches the DOM. */}
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  )
}

// Read a string property off a custom mdast→hast node (set via remarkCumora's
// hProperties). Reading from node.properties is the reliable path across
// react-markdown's prop transforms.
function nodeProp(node: unknown, key: string): string {
  const v = (node as { properties?: Record<string, unknown> } | undefined)?.properties?.[key]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join(' ')
  return v == null ? '' : String(v)
}

// Raw text of a code node — prefer the mdast/hast children values; fall back to
// the rendered children. Used to decide inline vs block and to feed CodeBlock.
function codeText(node: unknown, children: ReactNode): string {
  const kids = (node as { children?: Array<{ value?: string }> } | undefined)?.children
  if (kids && kids.length) {
    const joined = kids.map((c) => c.value ?? '').join('')
    if (joined) return joined
  }
  return Array.isArray(children) ? children.join('') : String(children ?? '')
}

const TABLE_BORDER = '1px solid rgba(15, 30, 50, 0.1)'

/** A backtick-wrapped value that is exactly an artifact id renders as the
 *  matching artifact link (which resolves git-style short ids) instead of a
 *  plain code chip — preserving the pre-react-markdown behavior where
 *  `` `doc_…` `` / `` `ce-…` `` were clickable. */
function artifactLinkForCode(value: string): ReactNode | null {
  const v = value.trim()
  if (/^doc_[A-Za-z0-9]+$/.test(v)) return <DocumentLink id={v} />
  if (/^board-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(v)) return <BoardLink id={v} />
  if (/^card-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(v)) return <CardLink id={v} />
  if (/^ce-[A-Za-z0-9-]+$/.test(v)) return <CalendarLink id={v} />
  return null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The Cumora look for every Markdown element — standard grammar styled to
 *  match the app's paper-toned palette + chat-tight spacing, plus the custom
 *  elements remarkCumora emits (mentions, artifact cards, Twemoji, Skype). */
// The current conversation, provided by RichBody so an inline `#N` chip knows
// which conversation's `sequence` numbers to resolve against.
const ConversationIdContext = createContext<string | null>(null)

/** `#N` — a per-conversation message-sequence reference. Clickable: scrolls to
 *  the referenced message via useApp.jumpToMessage. Hover: shows a small peek
 *  card (author + body preview). If the conversation context is missing OR the
 *  message hasn't been loaded yet, falls back to plain `#N` text so the
 *  reference is never silently dropped. */
function MessageRefChip({ n }: { n: number }) {
  const convoId = useContext(ConversationIdContext)
  const target = useMessages((s) => {
    if (!convoId) return null
    const list = s.byConvo[convoId]
    if (!list) return null
    for (const m of list) {
      if ((m as { sequence?: number }).sequence === n) return m
    }
    return null
  })
  const jumpToMessage = useApp((s) => s.jumpToMessage)
  const byId = useParticipants((s) => s.byId)
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement | null>(null)

  if (!target) return <span className="text-ink-400">#{n}</span>

  const author = byId[target.authorId] ?? null
  const onClick = () => jumpToMessage(target.id)
  const enter = () => {
    if (!ref.current) return
    const r = ref.current.getBoundingClientRect()
    setHoverPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
  }
  const leave = () => setHoverPos(null)

  return (
    <>
      <span
        ref={ref}
        onClick={onClick}
        onMouseEnter={enter}
        onMouseLeave={leave}
        className="inline-flex items-center px-1.5 py-0.5 rounded-full font-semibold cursor-pointer transition text-skype-deep bg-sky-50 hover:bg-sky-100"
        // Measured against 14px / line-height 1.55 CJK text — -0.05em centers
        // the chip on the CJK glyph center; -0.15em (the MentionChip value)
        // visibly sits low here because there's no avatar to anchor it.
        style={{ verticalAlign: '-0.05em' }}
        title={`Jump to message #${n}`}
        role="link"
      >
        {/* Cap the inner height + line-height so the chip is a stable 20px
            tall — without this, it inherits the bubble's 1.55 leading and
            grows taller than expected, which is what made the older offset
            misalign. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', height: 16, lineHeight: 1 }}>#{n}</span>
      </span>
      {hoverPos && createPortal(
        <MessagePeekCard msg={target} author={author} x={hoverPos.x} y={hoverPos.y} />,
        document.body,
      )}
    </>
  )
}

/** Floating preview card shown when the user hovers a `#N` chip — mirrors the
 *  MentionCard pattern (portalled, ink-tone palette). Shows author + a short
 *  body excerpt so users can read the referenced message without jumping. */
function MessagePeekCard(
  { msg, author, x, y }: { msg: Message; author: Participant | null; x: number; y: number },
) {
  const t = useT()
  const ARROW = 8
  const W = 320
  const left = Math.max(8, Math.min(window.innerWidth - W - 8, x - W / 2))
  const top = y + ARROW
  const bodyPreview = (msg.body ?? '').replace(/\n/g, ' ').slice(0, 220)
  return (
    <div
      role="tooltip"
      className="fixed z-[80] animate-rise"
      style={{ left, top, width: W, pointerEvents: 'none' }}
    >
      <div className="rounded-[12px] bg-cloud border border-ink-100 shadow-[0_22px_44px_-22px_rgba(0,80,140,0.35)] px-3.5 py-2.5">
        <div className="flex items-center gap-2 mb-1.5">
          {author ? <Avatar p={author} size={20} ringColor="var(--cloud)" showStatus={false} /> : null}
          <div className="min-w-0 flex-1 flex items-baseline gap-2">
            <span className="font-display font-semibold text-[12.5px] text-ink-900 truncate">{author?.name ?? msg.authorId}</span>
            {author?.role ? <span className="text-[10px] text-ink-400 truncate uppercase tracking-[0.08em]">{author.role}</span> : null}
          </div>
        </div>
        <div className="text-[12.5px] text-ink-700 leading-[1.55] line-clamp-5 break-words">
          {bodyPreview || <span className="italic text-ink-400">{t('msgview.noText')}</span>}
        </div>
      </div>
    </div>
  )
}

const cumoraMarkdownComponents = {
  // ── Cumora custom inline tokens (emitted by remarkCumora) ──
  cmention: ({ node }: any) => <MentionChip id={nodeProp(node, 'cid')} />,
  cmsgref: ({ node }: any) => <MessageRefChip n={Number(nodeProp(node, 'cn')) || 0} />,
  cartifact: ({ node }: any) => {
    const id = nodeProp(node, 'cid')
    switch (nodeProp(node, 'ckind')) {
      case 'document': return <DocumentLink id={id} />
      case 'board': return <BoardLink id={id} />
      case 'card': return <CardLink id={id} />
      case 'calendar': return <CalendarLink id={id} />
      default: return <>{id}</>
    }
  },
  cemoji: ({ node }: any) => <TwEmoji emoji={nodeProp(node, 'cchar')} size={18} />,
  cskype: ({ node }: any) => <SkypeEmoji name={nodeProp(node, 'cname')} size={20} />,

  // ── Standard block grammar ──
  p: ({ children }: any) => <p className="m-0 mt-2 first:mt-0 leading-[1.55]">{children}</p>,
  // Headings use Cumora's display font + tracking-tight, matching how titles
  // read everywhere else in the app (e.g. `font-display ... tracking-tight`).
  h1: ({ children }: any) => <h1 className="font-display mt-3 first:mt-0 mb-1 text-[18px] font-semibold tracking-tight leading-snug text-ink-900">{children}</h1>,
  h2: ({ children }: any) => <h2 className="font-display mt-3 first:mt-0 mb-1 text-[16px] font-semibold tracking-tight leading-snug text-ink-900">{children}</h2>,
  h3: ({ children }: any) => <h3 className="font-display mt-2.5 first:mt-0 mb-0.5 text-[14.5px] font-semibold tracking-tight leading-snug text-ink-900">{children}</h3>,
  h4: ({ children }: any) => <h4 className="font-display mt-2 first:mt-0 mb-0.5 text-[13.5px] font-semibold text-ink-800">{children}</h4>,
  h5: ({ children }: any) => <h5 className="font-display mt-2 first:mt-0 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-500">{children}</h5>,
  h6: ({ children }: any) => <h6 className="font-display mt-2 first:mt-0 text-[11.5px] font-semibold uppercase tracking-[0.1em] text-ink-400">{children}</h6>,
  ul: ({ children }: any) => <ul className="my-1 first:mt-0 last:mb-0 pl-5 list-disc marker:text-ink-300 space-y-0.5">{children}</ul>,
  ol: ({ children }: any) => <ol className="my-1 first:mt-0 last:mb-0 pl-5 list-decimal marker:text-ink-400 space-y-0.5">{children}</ol>,
  li: ({ children }: any) => <li className="leading-[1.5] pl-0.5">{children}</li>,
  // No italic — Cumora messages are CJK-heavy and synthetic-slanted CJK looks
  // bad. A calm neutral rule + muted text reads as a quote without the slant.
  blockquote: ({ children }: any) => (
    <blockquote className="my-1.5 first:mt-0 last:mb-0 border-l-[3px] border-ink-200 pl-3 text-ink-500">{children}</blockquote>
  ),
  hr: () => <hr className="my-2.5 border-0 border-t border-ink-100" />,
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-all underline decoration-skype-200 decoration-1 underline-offset-2 hover:decoration-skype-deep transition-colors"
      style={{ color: 'var(--skype-deep)' }}
    >{children}</a>
  ),
  strong: ({ children }: any) => <strong className="font-semibold text-ink-900">{children}</strong>,
  // Inline markdown images (`![alt](url)`) arrive with no intrinsic
  // dimensions, so a bare <img> paints at 0×0 then snaps to natural size on
  // load — pushing every row below it downward. Inside the virtualized mobile
  // list that height change re-anchors the scroll and is one of the causes of
  // the "message I'm reading gets replaced" jitter. Reserve a fixed box up
  // front (same tactic as AttachmentCard) so the row height is stable from the
  // first paint; the image letterboxes into it once it loads.
  img: ({ src, alt }: any) => (
    src ? (
      <span
        className="block my-1.5 first:mt-0 last:mb-0 rounded-[10px] border border-ink-100 bg-cloud overflow-hidden"
        style={{ aspectRatio: '4 / 3', width: '100%', maxWidth: 420, maxHeight: 360 }}
      >
        <img
          src={src}
          alt={alt ?? ''}
          className="w-full h-full object-contain"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      </span>
    ) : null
  ),
  em: ({ children }: any) => <em className="italic">{children}</em>,
  del: ({ children }: any) => <del className="line-through text-ink-400">{children}</del>,
  input: ({ checked }: any) => (
    <input type="checkbox" checked={!!checked} readOnly className="mr-1.5 align-[-0.1em] accent-skype" />
  ),

  // ── Tables (remark-gfm) ──
  table: ({ children }: any) => (
    <div className="my-1.5 first:mt-0 last:mb-0 overflow-x-auto">
      <table className="border-collapse text-[13px] leading-[1.45]" style={{ border: TABLE_BORDER }}>{children}</table>
    </div>
  ),
  th: ({ children, style }: any) => (
    <th
      className="px-2.5 py-1 font-semibold text-ink-900 whitespace-nowrap"
      style={{ border: TABLE_BORDER, background: 'rgba(15, 30, 50, 0.045)', textAlign: style?.textAlign ?? 'left' }}
    >{children}</th>
  ),
  td: ({ children, style }: any) => (
    <td
      className="px-2.5 py-1 text-ink-700 align-top"
      style={{ border: TABLE_BORDER, textAlign: style?.textAlign ?? 'left' }}
    >{children}</td>
  ),

  // ── Code: fenced → CodeBlock (highlight.js); inline → paper chip ──
  pre: ({ children }: any) => <>{children}</>,
  code: ({ className, children, node }: any) => {
    const lang = /language-([\w-]+)/.exec(className || '')?.[1] ?? ''
    const raw = codeText(node, children)
    if (lang || raw.includes('\n')) {
      return <CodeBlock lang={lang} code={raw.replace(/\n$/, '')} />
    }
    // A backtick-wrapped artifact id becomes its clickable link (short-id aware).
    const artifact = artifactLinkForCode(raw)
    if (artifact) return artifact
    return (
      <code
        className="font-mono text-[12.5px] py-px px-1.5 rounded-[5px] mx-px align-[0.05em]"
        style={{ background: 'rgba(15, 30, 50, 0.06)', color: 'var(--ink-900)', border: '1px solid rgba(15, 30, 50, 0.08)' }}
      >{children}</code>
    )
  },
} as Components
/* eslint-enable @typescript-eslint/no-explicit-any */

const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkCumora]

/** Renders a message body as Markdown — full CommonMark + GFM via react-markdown,
 *  plus Cumora's own tokens (mentions / artifacts / emoji) — all styled to the
 *  app's look (see cumoraMarkdownComponents). `skipHtml` drops any raw HTML in
 *  agent/user content so messages can't inject markup. */
export function RichBody({ body, conversationId }: { body: string; conversationId?: string | null }) {
  return (
    <ConversationIdContext.Provider value={conversationId ?? null}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={cumoraMarkdownComponents} skipHtml>
        {body}
      </Markdown>
    </ConversationIdContext.Provider>
  )
}

type ArtifactRef = { type: 'document' | 'board' | 'card' | 'calendar'; id: string }

function artifactKey(ref: ArtifactRef): string {
  return `${ref.type}:${ref.id}`
}

function addArtifactRef(out: Map<string, ArtifactRef>, ref: ArtifactRef) {
  out.set(artifactKey(ref), ref)
}

function artifactRefsFromBody(body: string): ArtifactRef[] {
  const out = new Map<string, ArtifactRef>()
  for (const block of parseBlocks(body)) {
    if (block.kind !== 'prose') continue
    for (const token of parseBody(block.text)) {
      if (token.kind === 'document' || token.kind === 'board' || token.kind === 'card' || token.kind === 'calendar') {
        addArtifactRef(out, { type: token.kind, id: token.id })
      }
    }
  }
  return Array.from(out.values())
}

function artifactRefsFromPlainText(text: string): ArtifactRef[] {
  const out = new Map<string, ArtifactRef>()
  const re = /\b(doc_[A-Za-z0-9]+|board-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*|card-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*|ce-[A-Za-z0-9-]+)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = m[0]
    if (id.startsWith('doc_')) addArtifactRef(out, { type: 'document', id })
    else if (id.startsWith('board-')) addArtifactRef(out, { type: 'board', id })
    else if (id.startsWith('card-')) addArtifactRef(out, { type: 'card', id })
    else if (id.startsWith('ce-')) addArtifactRef(out, { type: 'calendar', id })
  }
  return Array.from(out.values())
}

function artifactRefsForMessage(msg: Message): ArtifactRef[] {
  const out = new Map<string, ArtifactRef>()
  for (const ref of artifactRefsFromBody(msg.body)) addArtifactRef(out, ref)
  if (msg.tool) {
    for (const ref of artifactRefsFromPlainText(`${msg.tool.arg}\n${msg.tool.detail}`)) addArtifactRef(out, ref)
  }
  return Array.from(out.values())
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const ms = Date.now() - then
  if (!Number.isFinite(then)) return 'recently'
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString()
}

function DocumentArtifactCard({ id: rawId, conversationId }: { id: string; conversationId: string }) {
  const t = useT()
  const id = useResolvedDocumentId(rawId) // git-style short-id → full id
  const loaded = useDocuments((s) => s.loaded)
  const loadDocuments = useDocuments((s) => s.load)
  const selectDocument = useDocuments((s) => s.select)
  const doc = useDocuments((s) => s.list.find((d) => d.id === id) ?? null)
  const byId = useParticipants((s) => s.byId)
  const openDocumentPeek = useApp((s) => s.openDocumentPeek)

  useEffect(() => {
    if (!loaded) void loadDocuments()
  }, [loadDocuments, loaded])

  const title = doc?.title?.trim() || (loaded ? t('docs.unavailable') : t('docs.opening'))
  const author = doc ? byId[doc.createdBy]?.name ?? doc.createdBy : null
  const updated = doc ? timeAgo(doc.updatedAt) : null
  const isPinnedHere = doc?.conversationId === conversationId

  const open = () => {
    selectDocument(id)
    openDocumentPeek(id)
  }

  return (
    <button
      type="button"
      onClick={open}
      className="mt-2 group block w-full max-w-[min(100%,580px)] text-left rounded-[12px] border border-ink-100 bg-cloud overflow-hidden transition hover:border-sky2-200 hover:shadow-[0_16px_34px_-22px_rgba(0,80,140,0.42)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky2-300"
      aria-label={`Open document ${title}`}
    >
      <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-3 px-3 py-3 items-center">
        <div
          className="relative w-[52px] h-[64px] rounded-[9px] bg-white border border-sky2-100 shadow-[0_10px_24px_-20px_rgba(0,80,140,0.35)] overflow-hidden"
          aria-hidden
        >
          <div className="h-2 bg-gradient-to-r from-skype via-sky2-200 to-coral-soft" />
          <div className="px-2.5 py-2 space-y-1.5">
            <span className="block h-1.5 rounded-full bg-ink-100 w-7" />
            <span className="block h-1 rounded-full bg-sky2-100 w-8" />
            <span className="block h-1 rounded-full bg-sky2-100 w-5" />
            <span className="block h-1 rounded-full bg-coral-soft/70 w-7" />
          </div>
          <div className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-md grid place-items-center bg-skype text-white shadow-sm">
            <IFile className="w-3 h-3" strokeWidth={1.8} />
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-skype-deep">{t('msgview.cardDocument')}</span>
            <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
            <span className="text-[10.5px] text-ink-400 truncate">{id}</span>
          </div>
          <div className="mt-1 text-[14px] font-semibold text-ink-900 truncate">{title}</div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0 text-[11.5px] text-ink-500">
            {author && <span className="truncate">{author}</span>}
            {author && updated && <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />}
            {updated && <span className="shrink-0">Updated {updated}</span>}
            {isPinnedHere && (
              <>
                <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
                <span className="shrink-0 text-gold-deep">{t('chat.inThisConversation')}</span>
              </>
            )}
          </div>
        </div>

        <div className="ml-1 h-8 px-3 rounded-full bg-sky2-50 text-skype-deep text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition group-hover:bg-skype group-hover:text-white">
          {t('common.open')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </div>
    </button>
  )
}

function BoardArtifactCard({ id: rawId }: { id: string }) {
  const t = useT()
  const id = useResolvedBoardId(rawId) // git-style short-id → full id
  const loadList = useBoards((s) => s.loadList)
  const loadingList = useBoards((s) => s.loadingList)
  const list = useBoards((s) => s.list)
  const loadBoard = useBoards((s) => s.loadBoard)
  const loadingBoardId = useBoards((s) => s.loadingBoardId)
  const snapshot = useBoards((s) => s.snapshots[id])
  const selectBoard = useBoards((s) => s.selectBoard)
  const openBoardPeek = useApp((s) => s.openBoardPeek)
  const summary = list.find((b) => b.id === id) ?? null
  const didRequestList = useRef(false)
  const requestedBoardId = useRef<string | null>(null)

  useEffect(() => {
    if (!summary && !loadingList && !didRequestList.current) {
      didRequestList.current = true
      void loadList().catch(() => { /* stale or missing board reference */ })
    }
  }, [loadList, loadingList, summary])

  useEffect(() => {
    if (!snapshot && loadingBoardId !== id && requestedBoardId.current !== id) {
      requestedBoardId.current = id
      void loadBoard(id).catch(() => { /* handled by unavailable card state */ })
    }
  }, [id, loadBoard, loadingBoardId, snapshot])

  const isBoardPending = !snapshot && (loadingBoardId === id || requestedBoardId.current !== id)
  const title = snapshot?.title?.trim() || summary?.title?.trim() || (isBoardPending ? t('docs.openingBoard') : t('peek.boardUnavailable'))
  const updated = snapshot?.updatedAt || summary?.updatedAt
  const columns = snapshot?.columns.length ?? null
  const cards = snapshot?.cards.length ?? null

  const open = () => {
    selectBoard(id)
    openBoardPeek(id)
  }

  return (
    <button
      type="button"
      onClick={open}
      className="mt-2 group block w-full max-w-[min(100%,580px)] text-left rounded-[12px] border border-ink-100 bg-cloud overflow-hidden transition hover:border-sky2-200 hover:shadow-[0_16px_34px_-24px_rgba(0,80,140,0.24)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky2-200"
      aria-label={`Open board ${title}`}
    >
      <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-3 px-3 py-3 items-center">
        <div className="relative w-[52px] h-[64px] rounded-[9px] bg-white border border-sky2-100 shadow-[0_10px_24px_-22px_rgba(0,80,140,0.22)] overflow-hidden" aria-hidden>
          <div className="h-2 bg-gradient-to-r from-sky2-200 via-sky2-100 to-sky2-100" />
          <div className="grid grid-cols-3 gap-1 px-2 py-2 h-[46px]">
            <span className="rounded bg-sky2-100" />
            <span className="rounded bg-sky2-100" />
            <span className="rounded bg-ink-100" />
          </div>
          <div className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-md grid place-items-center bg-skype-deep text-white shadow-sm">
            <IBoard className="w-3 h-3" strokeWidth={1.8} />
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-skype-deep">{t('msgview.cardKanban')}</span>
            <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
            <span className="text-[10.5px] text-ink-400 truncate">{id}</span>
          </div>
          <div className="mt-1 text-[14px] font-semibold text-ink-900 truncate">{title}</div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0 text-[11.5px] text-ink-500">
            {columns !== null && <span>{columns} columns</span>}
            {columns !== null && cards !== null && <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />}
            {cards !== null && <span>{cards} cards</span>}
            {updated && (
              <>
                <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
                <span className="shrink-0">Updated {timeAgo(updated)}</span>
              </>
            )}
          </div>
        </div>

        <div className="ml-1 h-8 px-3 rounded-full bg-sky2-50 text-skype-deep text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition group-hover:bg-skype-deep group-hover:text-white">
          {t('common.open')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </div>
    </button>
  )
}

function CardArtifactCard({ id: rawId }: { id: string }) {
  const t = useT()
  const id = useResolvedCardId(rawId) // git-style short-id → full id (best-effort for cards)
  const lookup = useBoards((s) => s.cardLookups[id])
  const loadingCardId = useBoards((s) => s.loadingCardId)
  const loadCard = useBoards((s) => s.loadCard)
  const selectBoard = useBoards((s) => s.selectBoard)
  const openBoardPeek = useApp((s) => s.openBoardPeek)
  const byId = useParticipants((s) => s.byId)
  const [failed, setFailed] = useState(false)
  const didRequestCard = useRef(false)

  useEffect(() => {
    if (lookup || failed || loadingCardId === id || didRequestCard.current) return
    didRequestCard.current = true
    void loadCard(id).catch(() => setFailed(true))
  }, [failed, id, loadCard, loadingCardId, lookup])

  const card = lookup?.card ?? null
  const assignee = card?.assigneeId ? byId[card.assigneeId]?.name ?? card.assigneeId : null
  const title = card?.title.trim() || (failed ? t('boards.cardUnavailable') : t('boards.openingCard'))
  const updated = card?.updatedAt ? timeAgo(card.updatedAt) : null
  const location = lookup ? `${lookup.board.title} -> ${lookup.column.title}` : id

  const open = () => {
    if (lookup) {
      selectBoard(lookup.board.id)
      openBoardPeek(lookup.board.id, id)
      return
    }
    void loadCard(id)
      .then((resolved) => {
        selectBoard(resolved.board.id)
        openBoardPeek(resolved.board.id, id)
      })
      .catch(() => setFailed(true))
  }

  return (
    <button
      type="button"
      onClick={open}
      className="mt-2 group block w-full max-w-[min(100%,580px)] text-left rounded-[12px] border border-ink-100 bg-cloud overflow-hidden transition hover:border-sky2-200 hover:shadow-[0_16px_34px_-24px_rgba(0,80,140,0.24)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky2-200"
      aria-label={`Open card ${title}`}
    >
      <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-3 px-3 py-3 items-center">
        <div className="relative w-[52px] h-[64px] rounded-[9px] bg-white border border-sky2-100 shadow-[0_10px_24px_-22px_rgba(0,80,140,0.22)] overflow-hidden" aria-hidden>
          <div className="h-2 bg-gradient-to-r from-sky2-200 via-sky2-100 to-cloud" />
          <div className="px-2 py-2 space-y-1.5">
            <span className="block h-1.5 rounded-full bg-ink-200 w-8" />
            <span className="block h-1 rounded-full bg-sky2-100 w-7" />
            <span className="block h-1 rounded-full bg-sky2-100 w-6" />
          </div>
          <div className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-md grid place-items-center bg-skype-deep text-white shadow-sm">
            <IBoard className="w-3 h-3" strokeWidth={1.8} />
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-skype-deep">{t('msgview.cardKanbanCard')}</span>
            <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
            <span className="text-[10.5px] text-ink-400 truncate">{id}</span>
          </div>
          <div className="mt-1 text-[14px] font-semibold text-ink-900 truncate">{title}</div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0 text-[11.5px] text-ink-500">
            <span className="truncate">{location}</span>
            {assignee && (
              <>
                <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
                <span className="truncate">{assignee}</span>
              </>
            )}
            {updated && (
              <>
                <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
                <span className="shrink-0">Updated {updated}</span>
              </>
            )}
          </div>
        </div>

        <div className="ml-1 h-8 px-3 rounded-full bg-sky2-50 text-skype-deep text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition group-hover:bg-skype-deep group-hover:text-white">
          {t('common.peek')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </div>
    </button>
  )
}

function CalendarArtifactCard({ id: rawId }: { id: string }) {
  const t = useT()
  const id = useResolvedCalendarId(rawId) // git-style short-id → full event id
  const loadingEventId = useCalendar((s) => s.loadingEventId)
  const loadEvent = useCalendar((s) => s.loadEvent)
  const event = useCalendar((s) => s.events.find((e) => e.id === id) ?? null)
  const byId = useParticipants((s) => s.byId)
  const openCalendarEventPeek = useApp((s) => s.openCalendarEventPeek)
  const [failed, setFailed] = useState(false)
  const didRequestCalendar = useRef(false)

  useEffect(() => {
    if (!event && !failed && loadingEventId !== id && !didRequestCalendar.current) {
      didRequestCalendar.current = true
      void loadEvent(id).catch(() => setFailed(true))
    }
  }, [event, failed, id, loadEvent, loadingEventId])

  const title = event?.title?.trim() || (failed ? t('peek.eventUnavailable') : t('docs.openingEvent'))
  const assignee = event?.assigneeId ? byId[event.assigneeId]?.name ?? event.assigneeId : null
  const start = event ? new Date(event.startAt) : null
  const startLabel = start && Number.isFinite(start.getTime())
    ? `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : null

  return (
    <button
      type="button"
      onClick={() => openCalendarEventPeek(id)}
      className="mt-2 group block w-full max-w-[min(100%,580px)] text-left rounded-[12px] border border-ink-100 bg-cloud overflow-hidden transition hover:border-sky2-200 hover:shadow-[0_16px_34px_-24px_rgba(0,168,240,0.20)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky2-200"
      aria-label={`Open calendar event ${title}`}
    >
      <div className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-3 px-3 py-3 items-center">
        <div className="relative w-[52px] h-[64px] rounded-[9px] bg-white border border-sky2-100 shadow-[0_10px_24px_-22px_rgba(0,168,240,0.18)] overflow-hidden" aria-hidden>
          <div className="h-2 bg-gradient-to-r from-sky2-200 via-sky2-100 to-cloud" />
          <div className="px-2 py-2">
            <span className="block text-[18px] leading-none font-semibold text-skype-deep">{start?.getDate() ?? '-'}</span>
            <span className="mt-1 block h-1 rounded-full bg-sky2-100 w-8" />
            <span className="mt-1.5 block h-1 rounded-full bg-ink-100 w-6" />
          </div>
          <div className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-md grid place-items-center bg-skype text-white shadow-sm">
            <ICalendar className="w-3 h-3" strokeWidth={1.8} />
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-skype-deep">{t('msgview.cardCalendar')}</span>
            <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
            <span className="text-[10.5px] text-ink-400 truncate">{id}</span>
          </div>
          <div className="mt-1 text-[14px] font-semibold text-ink-900 truncate">{title}</div>
          <div className="mt-1 flex items-center gap-1.5 min-w-0 text-[11.5px] text-ink-500">
            {startLabel && <span className="truncate">{startLabel}</span>}
            {event?.kind === 'agent_task' && assignee && (
              <>
                <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
                <span className="truncate">for {assignee}</span>
              </>
            )}
            {event?.status && (
              <>
                <span className="w-1 h-1 rounded-full bg-ink-200 shrink-0" />
                <span className="shrink-0 capitalize">{event.status}</span>
              </>
            )}
          </div>
        </div>

        <div className="ml-1 h-8 px-3 rounded-full bg-sky2-50 text-skype-deep text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition group-hover:bg-skype group-hover:text-white">
          {t('common.open')}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </div>
      </div>
    </button>
  )
}

function ToolCard({ msg }: { msg: Message }) {
  if (!msg.tool) return null
  const t = msg.tool
  const ico = t.icon ?? 'web'
  const icoBg: Record<string, string> = {
    web: 'linear-gradient(135deg, #4FC2A1, #2D8C72)',
    github: '#1A1A1A',
    figma: 'linear-gradient(135deg, #F24E1E, #A259FF)',
    db: 'linear-gradient(135deg, #4DB8E5, #2380B0)',
  }
  return (
    <div className="mt-2 max-w-[min(100%,580px)] bg-cloud border border-ink-100 rounded-[11px] overflow-hidden shadow-soft">
      <div className="flex items-center gap-2 px-3 py-2.5 bg-gradient-to-b from-[#F8FBFD] to-[#F2F7FB] border-b border-ink-100 text-[11.5px] font-semibold text-ink-700">
        <div
          className="w-[22px] h-[22px] rounded-md grid place-items-center text-white font-mono font-bold text-[11px]"
          style={{ background: icoBg[ico] ?? icoBg.web }}
        >{ico === 'github' ? '▲' : (ico ?? 'W')[0].toUpperCase()}</div>
        <div className="font-mono text-[11.5px] font-medium">
          {t.name} <span className="text-ink-300">· {t.arg}</span>
        </div>
        <div className="ml-auto text-[10.5px] font-bold tracking-wider px-2 py-0.5 rounded bg-[rgba(110,197,106,0.15)] text-[#3D8B3F]">
          {t.status}
        </div>
      </div>
      <div className="px-3.5 py-3 font-mono text-[11.5px] text-ink-500 leading-[1.55] whitespace-pre-line">
        {t.detail}
      </div>
    </div>
  )
}

function AttachmentCard({ msg }: { msg: Message }) {
  const [viewerOpen, setViewerOpen] = useState(false)
  if (!msg.attachment) return null
  const a = msg.attachment

  // Real image with a URL: render inline; clicking opens the lightbox.
  if (a.kind === 'img' && a.url) {
    return (
      <>
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          className="block mt-2 max-w-[min(100%,420px)] text-left cursor-zoom-in group"
        >
          {/* The server doesn't store image dimensions today, so we
              don't know the natural aspect when this row first renders.
              Without a reserved box, the <img> renders at 0×0 → grows
              to natural size on load → shifts every message below it
              downward, which inside a virtualized list compounds into
              the visible jitter users complain about while scrolling.
              Wrap in a fixed 4:3 aspect box, contain the image inside,
              and the layout is stable from first paint. Letterboxing
              (with the bubble's bg-cloud showing through) is the price
              of stability; once the upload pipeline records width/height
              this can switch to natural-aspect again. */}
          <div
            className="rounded-[11px] border border-ink-100 bg-cloud overflow-hidden transition group-hover:brightness-95"
            style={{ aspectRatio: '4 / 3', width: '100%', maxHeight: 360 }}
          >
            <img
              src={a.url}
              alt={a.name}
              className="w-full h-full object-contain"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          </div>
          <div className="mt-1 text-[11px] text-ink-500 truncate">{a.name}{a.size ? ` · ${Math.round(a.size / 1024)}KB` : ''}</div>
        </button>
        {viewerOpen && (
          <ImageViewer src={a.url} name={a.name} onClose={() => setViewerOpen(false)} />
        )}
      </>
    )
  }

  // File card fallback (PDF / docs / archives / text / etc). Renders as a
  // real `<a download>` so clicking actually saves the file — Skype-style.
  // No URL → fall back to a non-clickable div (mock seed data, in-flight
  // optimistic rows). Short extension chip helps the eye in a stack of
  // mixed attachments.
  const ext = (() => {
    const fromMime = a.mime?.split('/')?.[1]?.toLowerCase()
    const fromName = a.name.includes('.') ? a.name.split('.').pop()?.toLowerCase() : null
    return (fromName || fromMime || a.kind).slice(0, 5)
  })()
  const sizeLabel = a.size
    ? a.size > 1024 * 1024
      ? `${(a.size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(a.size / 1024))} KB`
    : null
  const inner = (
    <>
      <div
        className="w-14 h-14 rounded-lg relative grid place-items-center overflow-hidden shrink-0"
        style={{
          background: a.kind === 'fig'
            ? 'radial-gradient(circle at 30% 30%, #FF6B9D, transparent 50%), radial-gradient(circle at 70% 70%, #4FC2F4, transparent 50%), linear-gradient(135deg, #2A2545, #1A1525)'
            : 'linear-gradient(135deg, #2A2A35, #1A1A22)',
        }}
      >
        {a.kind === 'fig' ? <IFigma className="w-5 h-5" stroke="white" strokeWidth={2} /> : <IFile className="w-5 h-5" stroke="white" strokeWidth={1.5} />}
        <span className="absolute bottom-1 right-1 font-mono text-[9px] font-bold text-white bg-black/55 px-1 rounded tracking-wider uppercase">{ext}</span>
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-ink-900 truncate">{a.name}</div>
        <div className="text-[11px] text-ink-500 truncate">
          {a.mime ?? a.meta ?? ''}{sizeLabel ? ` · ${sizeLabel}` : ''}
        </div>
      </div>
    </>
  )

  if (!a.url) {
    return (
      <div className="mt-2 max-w-[min(100%,380px)] grid grid-cols-[56px_1fr] gap-2.5 p-2.5 bg-cloud border border-ink-100 rounded-[11px] items-center">
        {inner}
      </div>
    )
  }

  return (
    <a
      href={a.url}
      download={a.name}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 max-w-[min(100%,380px)] grid grid-cols-[56px_1fr] gap-2.5 p-2.5 bg-cloud border border-ink-100 rounded-[11px] items-center cursor-pointer hover:shadow-soft hover:border-sky2-200 transition no-underline"
    >
      {inner}
    </a>
  )
}

/* ============== email ==============
 * Distinct chrome from chat bubbles: pale parchment background, subject as
 * a serif headline, then a header row (from / to / cc collapsed onto one
 * line), then the body. Direction is conveyed by a tiny chip in the
 * subject row (↓ in / ↑ out) and by a leading edge color.
 *
 * Failed sends get a red border + inline note. The default body is the
 * plain-text version (server strips HTML on inbound for searchability).
 * When the message has a richer HTML version, the "html" chip becomes a
 * toggle that opens the rendered HTML inside a sandboxed iframe — the
 * server sanitizes and the sandbox forbids scripts, so even residual
 * hostile markup can't escape. */
function _EmailCard({ msg }: { msg: Message }) {
  const t = useT()
  const openComposeReply = useApp((s) => s.openComposeReply)
  const [showHtml, setShowHtml] = useState(false)
  const [htmlBody, setHtmlBody] = useState<string | null>(null)
  const [htmlError, setHtmlError] = useState<string | null>(null)
  const [htmlLoading, setHtmlLoading] = useState(false)

  useEffect(() => {
    if (!showHtml || htmlBody !== null || htmlError) return
    let cancelled = false
    setHtmlLoading(true)
    api.fetchEmailHtml(msg.id)
      .then((html) => { if (!cancelled) setHtmlBody(html ?? '') })
      .catch((e: unknown) => { if (!cancelled) setHtmlError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setHtmlLoading(false) })
    return () => { cancelled = true }
  }, [showHtml, htmlBody, htmlError, msg.id])

  if (!msg.email) return null
  const e = msg.email
  const isOut = e.direction === 'out'
  const isFailed = e.transportStatus === 'failed'
  const isQueued = e.transportStatus === 'queued'
  // Parchment palette — distinct from the chat coral / sky bubble pair so
  // an email reads as "different artifact, takes more attention" without
  // being loud about it.
  const ringColor = isFailed
    ? 'rgba(196, 60, 50, 0.55)'
    : isOut
      ? 'rgba(0, 168, 240, 0.35)'
      : 'rgba(120, 110, 95, 0.30)'
  const dirChipBg = isFailed
    ? 'var(--coral-soft)'
    : isOut
      ? 'var(--sky-100, #E1F3FD)'
      : '#F4EEDD'
  const dirChipColor = isFailed
    ? '#B23A2A'
    : isOut
      ? 'var(--skype-deep)'
      : '#7A6A3F'
  const recipients = [
    ...e.to.map((t) => ({ label: 'To', value: t })),
    ...e.cc.map((c) => ({ label: 'Cc', value: c })),
  ]
  return (
    <div
      className="mt-1 max-w-[min(100%,640px)] overflow-hidden"
      style={{
        background: 'var(--chrome-warm)',
        border: `1px solid ${ringColor}`,
        borderRadius: '14px',
        boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 8px 20px -16px rgba(60, 50, 30, 0.18)',
      }}
    >
      <div className="px-4 pt-3 pb-2 border-b border-[rgba(120,110,95,0.18)]">
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="inline-flex items-center gap-1 text-[10px] font-bold py-0.5 px-1.5 rounded uppercase tracking-wider"
            style={{ background: dirChipBg, color: dirChipColor }}
          >
            <IMail className="w-3 h-3" strokeWidth={2} />
            {isFailed ? 'failed' : isQueued ? 'queued' : isOut ? 'sent' : 'received'}
          </span>
          {e.hasHtml && (
            <button
              type="button"
              onClick={() => setShowHtml((v) => !v)}
              className={cn(
                'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded transition',
                showHtml
                  ? 'bg-[#7A6A3F] text-[#FBF8F0]'
                  : 'text-ink-400 hover:text-ink-700 hover:bg-[rgba(120,110,95,0.10)]',
              )}
              aria-pressed={showHtml}
              title={showHtml ? 'Hide HTML version' : 'Show HTML version'}
            >
              {showHtml ? 'plain' : 'html'}
            </button>
          )}
          {e.smtpMessageId && (
            <span
              className="ml-auto text-[10px] text-ink-300 font-mono truncate max-w-[180px]"
              title={e.smtpMessageId}
            >
              {e.smtpMessageId}
            </span>
          )}
        </div>
        <div className="font-display font-medium text-[16px] leading-snug text-ink-900 break-words">
          {e.subject || <span className="text-ink-400 italic">{t('email.noSubject')}</span>}
        </div>
      </div>
      <div className="px-4 py-2.5 text-[11.5px] text-ink-500 space-y-0.5 border-b border-[rgba(120,110,95,0.18)]">
        <div className="flex gap-2">
          <span className="font-semibold w-7 shrink-0 text-ink-300 uppercase tracking-wider text-[10px] pt-0.5">{t('msgview.emailFrom')}</span>
          <span className="text-ink-700 break-all">{e.from}</span>
        </div>
        {recipients.length > 0 && recipients.map((r, i) => (
          <div key={i} className="flex gap-2">
            <span className="font-semibold w-7 shrink-0 text-ink-300 uppercase tracking-wider text-[10px] pt-0.5">{r.label}</span>
            <span className="text-ink-700 break-all">{r.value}</span>
          </div>
        ))}
      </div>
      {showHtml ? (
        <div className="px-2 py-2 bg-white">
          {htmlLoading && (
            <div className="px-3 py-6 text-[12px] text-ink-400 italic">{t('msgview.loadingHtml')}</div>
          )}
          {htmlError && (
            <div className="px-3 py-3 text-[12px] text-coral-deep">
              couldn't load html: {htmlError}
            </div>
          )}
          {htmlBody !== null && !htmlError && (
            <EmailHtmlFrame html={htmlBody} />
          )}
        </div>
      ) : (
        <div className="px-4 py-3 text-[14px] leading-[1.55] text-ink-700 break-words">
          <RichBody body={msg.body} conversationId={msg.conversationId} />
        </div>
      )}
      {e.attachments && e.attachments.length > 0 && (
        <div className="px-4 py-2.5 border-t border-[rgba(120,110,95,0.18)] space-y-1">
          {e.attachments.map((a) => (
            <EmailAttachmentRow key={a.id} att={a} />
          ))}
        </div>
      )}
      {isFailed && e.transportError && (
        <div
          className="px-4 py-2 text-[11.5px] text-coral-deep border-t border-[rgba(196,60,50,0.25)]"
          style={{ background: 'rgba(196, 60, 50, 0.06)' }}
        >
          {t('email.deliveryFailedPrefix')} {e.transportError}
        </div>
      )}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-[rgba(120,110,95,0.18)]">
        <button
          type="button"
          onClick={() => openComposeReply(msg.id)}
          className="inline-flex items-center gap-1.5 py-1.5 px-3 text-[11.5px] font-semibold text-ink-700 bg-cloud border border-ink-100 rounded-[7px] hover:border-sky2-200 hover:text-skype-deep transition"
        >
          <IMail className="w-3.5 h-3.5" strokeWidth={2} />
          {t('email.reply')}
        </button>
      </div>
    </div>
  )
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function EmailAttachmentRow({ att }: { att: NonNullable<NonNullable<Message['email']>['attachments']>[number] }) {
  const isImg = att.mimeType.startsWith('image/')
  const isPdf = att.mimeType === 'application/pdf'
  const icon = isImg ? '🖼' : isPdf ? '📄' : '📎'
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink-700">
      <span className="text-[14px] leading-none">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{att.filename}</div>
        <div className="text-[10.5px] text-ink-400 uppercase tracking-wider">
          {att.mimeType}{att.sizeBytes > 0 && ` · ${humanSize(att.sizeBytes)}`}
          {att.truncated && ' · skipped (too large)'}
        </div>
      </div>
      {att.url ? (
        <a
          href={att.url}
          target="_blank"
          rel="noreferrer noopener"
          download={att.filename}
          className="shrink-0 text-[11.5px] font-semibold text-skype-deep hover:underline"
        >
          download
        </a>
      ) : (
        <span className="shrink-0 text-[11.5px] text-ink-300 italic">unavailable</span>
      )}
    </div>
  )
}

/** Sandboxed HTML email viewer. The iframe's `sandbox` attribute omits
 *  `allow-scripts` and `allow-top-navigation`, so even if the server-side
 *  sanitizer missed a vector, scripts can't run and the page can't be
 *  hijacked. `allow-popups` is the one capability we keep so a clicked
 *  link can open in a new tab; everything is forced to target=_blank +
 *  rel=noopener via a CSP-friendly wrapper around the body. */
function EmailHtmlFrame({ html }: { html: string }) {
  const t = useT()
  const ref = useRef<HTMLIFrameElement | null>(null)
  const [h, setH] = useState(120)
  // Wrap the sanitized body in a minimal HTML skeleton with a base target
  // so every link opens in a new tab (no top-frame navigation). The body
  // gets a reasonable default font + word-wrap so plain-text-shaped HTML
  // doesn't overflow horizontally.
  const wrapped = useMemo(() => `<!doctype html>
<html><head>
<meta charset="utf-8" />
<base target="_blank" />
<style>
  html, body { margin:0; padding:0; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #2A2823; word-wrap: break-word; overflow-wrap: break-word; }
  body > * { max-width: 100% !important; }
  img, table { max-width: 100% !important; height: auto; }
  a { color: #00A8F0; }
  blockquote { border-left: 3px solid rgba(120,110,95,0.3); margin: 0; padding: 4px 0 4px 12px; color: #6B6859; }
</style>
</head><body>${html}</body></html>`, [html])
  // Resize the iframe to its content height. We measure body.scrollHeight
  // after load, plus a small buffer so the last line never sits flush
  // against the chrome.
  useEffect(() => {
    const f = ref.current
    if (!f) return
    const measure = () => {
      try {
        const doc = f.contentDocument
        if (!doc?.body) return
        const next = Math.min(800, Math.max(120, doc.body.scrollHeight + 8))
        setH(next)
      } catch { /* cross-origin defensiveness, ignore */ }
    }
    f.addEventListener('load', measure)
    // Re-measure after images stream in (height can grow significantly).
    const id = window.setTimeout(measure, 500)
    return () => { f.removeEventListener('load', measure); window.clearTimeout(id) }
  }, [wrapped])
  return (
    <iframe
      ref={ref}
      srcDoc={wrapped}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      style={{ width: '100%', height: h, border: 0, background: 'white', borderRadius: 6 }}
      title={t('msgview.htmlEmailBody')}
    />
  )
}

function WhisperLink({ msg }: { msg: Message }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  if (!msg.whisperLink) return null
  const w = msg.whisperLink
  const a = byId[w.pair[0]]
  const b = byId[w.pair[1]]
  return (
    <div
      className="my-2 ml-[50px] max-w-[min(calc(100%-50px),540px)] py-2.5 px-3.5 rounded-xl border border-dashed text-[12.5px] flex items-center gap-2.5 cursor-pointer relative overflow-hidden"
      style={{
        background: 'linear-gradient(135deg, rgba(123, 108, 176, 0.09), rgba(123, 108, 176, 0.03))',
        borderColor: 'rgba(123, 108, 176, 0.42)',
        color: 'var(--whisper-deep)',
      }}
    >
      <div className="shrink-0 w-[30px] h-[30px] rounded-full grid place-items-center text-whisper" style={{ background: 'rgba(123, 108, 176, 0.18)' }}>
        <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M3 12c0-4 4-8 9-8s9 4 9 8-4 8-9 8a10 10 0 01-3-.5L3 21l1.5-5A8 8 0 013 12z"/></svg>
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-whisper-deep font-bold">{a?.name}</span>{t('msgview.and')}<span className="text-whisper-deep font-bold">{b?.name}</span>{t('msgview.whisperingSuffix')} <em className="font-display italic font-normal text-whisper-deep">{w.snippet}</em> · {w.count} messages
      </div>
      <div className="ml-auto text-[11px] font-semibold py-1 px-2.5 rounded-full bg-[rgba(124,92,255,0.15)] text-whisper-deep shrink-0">{t('msgview.peekArrow')}</div>
    </div>
  )
}

interface MessageRowProps {
  msg: Message
  /** Resolved author. Optional: system / whisper rows render without one
   *  (e.g. the calendar-fired notice is authored by a synthetic system id
   *  that isn't in the participants store). */
  author?: Participant
  delay?: number
  /** Whether to play the rise-in fade animation on mount. Default
   *  `true` for backward compatibility with the desktop view, but
   *  callers that virtualize rows (e.g. the mobile chat's Virtuoso
   *  list) should pass `false` for historical rows — otherwise every
   *  scroll-back remounts an off-screen row and replays its fade,
   *  which reads as flicker. */
  animate?: boolean
}

const QUICK_REACTIONS = ['👍', '❤️', '👀', '🌤️', '🔥', '👏', '✅', '🎯', '📌']

function ReactionPill({ msgId, r }: { msgId: string; r: import('@/types').ReactionEntry }) {
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()
  const [burst, setBurst] = useState(0)
  const userIds = r.users ?? []
  const orderedNames = (() => {
    const me: string[] = []
    const others: string[] = []
    for (const uid of userIds) {
      if (uid === meId) { me.push('You'); continue }
      const name = byId[uid]?.name
      if (!name) continue  // participant not loaded → omit, never leak raw id
      others.push(name)
    }
    others.sort((a, b) => a.localeCompare(b))
    return [...me, ...others]
  })()

  // Portal-rendered tooltip with fixed coords so it escapes any ancestor's
  // overflow / clip / transform / stacking context. Coords are computed from
  // the button's bounding rect on hover, then clamped to the viewport.
  const btnRef = useRef<HTMLButtonElement>(null)
  const [coord, setCoord] = useState<{ x: number; y: number } | null>(null)

  const onEnter = () => {
    const el = btnRef.current
    if (!el || orderedNames.length === 0) return
    const r = el.getBoundingClientRect()
    setCoord({ x: r.left + r.width / 2, y: r.top })
  }
  const onLeave = () => setCoord(null)
  const onClick = () => {
    if (!r.mine) setBurst((n) => n + 1)
    void toggleReaction(msgId, r.emoji)
  }

  return (
    <>
      <button
        ref={btnRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        onClick={onClick}
        data-mine={r.mine ? 'true' : 'false'}
        className={cn(
          'reaction-control reaction-pill rounded-full text-[11px] py-0.5 px-2 inline-flex items-center gap-1 border transition',
          r.mine
            ? 'bg-sky2-100 border-sky2-200 text-skype-deep font-semibold'
            : 'bg-cloud border-ink-100 text-ink-500 hover:border-sky2-200',
        )}
      >
        <span className="reaction-emoji inline-flex"><TwEmoji emoji={r.emoji} size={14} /></span>
        {/* No key={r.count} — that used to force unmount + replay the
            entrance animation on every count change, which under rapid
            clicks left visible stutter (multiple count spans coexisting
            for a frame). Update the text in place; the pill itself
            already does the per-click feedback via ReactionBurst. */}
        <span className="reaction-count">{r.count}</span>
        {burst > 0 && <ReactionBurst key={burst} />}
      </button>
      {coord && orderedNames.length > 0 && createPortal(
        <ReactionTooltip emoji={r.emoji} names={orderedNames} anchorX={coord.x} anchorY={coord.y} />,
        document.body,
      )}
    </>
  )
}

function ReactionBurst() {
  return (
    <span className="reaction-burst" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  )
}

function QuickReactionButton({ msgId, emoji }: { msgId: string; emoji: string }) {
  const [burst, setBurst] = useState(0)
  return (
    <button
      onClick={() => {
        setBurst((n) => n + 1)
        void toggleReaction(msgId, emoji)
      }}
      className="reaction-control reaction-quick-button w-6 h-6 rounded-full hover:bg-sky2-50 grid place-items-center"
      title={`React ${emoji}`}
      aria-label={`React ${emoji}`}
    >
      <TwEmoji emoji={emoji} size={16} />
      {burst > 0 && <ReactionBurst key={burst} />}
    </button>
  )
}

function ReactionTooltip({ emoji, names, anchorX, anchorY }: {
  emoji: string
  names: string[]
  /** anchor center-x in viewport coords */
  anchorX: number
  /** anchor top-y in viewport coords (we render above) */
  anchorY: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; arrowX: number } | null>(null)

  // Measure the tooltip after it's mounted, then reposition it relative to
  // the anchor and clamp inside the viewport. useLayoutEffect runs before the
  // browser paints, so the user never sees the initial offscreen state.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const vw = window.innerWidth
    let left = anchorX - r.width / 2
    if (left < margin) left = margin
    if (left + r.width > vw - margin) left = vw - r.width - margin
    const top = anchorY - r.height - 8        // 8px gap above the pill
    const arrowX = anchorX - left              // arrow stays under the pill center
    setPos({ left, top, arrowX })
  }, [anchorX, anchorY, names.join(',')])

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[70]"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        opacity: pos ? 1 : 0,
        transition: 'opacity 120ms ease-out',
        maxWidth: 320,
      }}
    >
      <div
        className="text-[11.5px] py-1.5 px-2.5 rounded-lg shadow-lg text-white inline-flex items-center"
        style={{ background: 'rgba(15, 30, 50, 0.92)', backdropFilter: 'blur(6px)' }}
      >
        <TwEmoji emoji={emoji} size={14} className="mr-1.5" />
        <span className="font-medium whitespace-nowrap">{names.join(', ')}</span>
      </div>
      <div
        className="w-2 h-2 rotate-45 -mt-1 absolute"
        style={{
          left: (pos?.arrowX ?? 0) - 4,
          background: 'rgba(15, 30, 50, 0.92)',
        }}
      />
    </div>
  )
}

/**
 * Centered "X joined" row for kind='system' messages. Body is a JSON payload
 * like {"kind":"joined","participantId":"atlas-9af2"}. The participant
 * name resolves from the live participants store, and clicking the chip
 * opens that person's info pane (for agents) or no-ops (for humans).
 *
 * Exported so the Whisper peek pane can reuse the same row instead of
 * dumping raw JSON into a bubble — only `body` is read, so any object
 * shaped `{ body: string }` works (covers both Message and
 * ApiWhisperMessage without a type adapter).
 */
export function SystemRow({ msg, delay = 0, animate = true }: { msg: { body: string }; delay?: number; animate?: boolean }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const openAgentInfo = useApp((s) => s.openAgentInfo)
  // Same animate-once contract as MessageRow: don't replay the rise-in fade on
  // a Virtuoso remount (scroll / quote-jump).
  const riseCls = animate ? 'animate-rise' : ''
  const riseStyle = animate ? { animationDelay: `${delay}ms` } : undefined
  let payload: {
    kind?: string
    participantId?: string
    actorId?: string
    noticeKind?: string
    text?: string
    title?: string
    eventId?: string
  } = {}
  try { payload = JSON.parse(msg.body) }
  catch { /* malformed — skip rendering */ return null }

  // Provider-state notices (e.g. AI quota exhausted, model degraded) ship
  // with `kind: 'notice'` + a free-text `text` body. No participant chip;
  // rendered as a centered italic banner with a ⚠ glyph so it reads as
  // "something stopped working" rather than "someone did something". The
  // server inserts these via runtime.postSystemNotice with per-conversation
  // Redis dedup so the same warning doesn't spam the room when multiple
  // agents hit the condition.
  if (payload.kind === 'notice' && typeof payload.text === 'string') {
    return (
      <div className={cn('flex justify-center my-3', riseCls)} style={riseStyle}>
        <div className="max-w-[min(100%,540px)] flex items-start gap-2 px-3 py-1.5 rounded-md bg-coral-soft/60 border border-coral-soft text-coral-deep text-[11.5px] font-display">
          <span className="leading-[1.4] shrink-0">⚠</span>
          <span className="leading-[1.4]">{payload.text}</span>
        </div>
      </div>
    )
  }

  if (payload.kind === 'calendar_event') {
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Calendar event'
    return (
      <div className={cn('flex justify-center my-3', riseCls)} style={riseStyle}>
        <div className="max-w-[min(100%,540px)] flex items-center gap-2 px-3 py-1.5 rounded-md bg-skype/10 border border-skype/20 text-skype text-[11.5px] font-display">
          <span className="leading-[1.4] shrink-0">📅</span>
          <span className="leading-[1.4]">Calendar fired: {title}</span>
          {typeof payload.eventId === 'string' && <CalendarLink id={payload.eventId} />}
        </div>
      </div>
    )
  }

  const subjectId = payload.participantId
  if (!subjectId) return null
  const subject = byId[subjectId]
  // If the participant record hasn't loaded yet, omit the system row
  // entirely rather than leaking the raw id. The row will re-render once
  // the participants store catches up.
  if (!subject) return null
  // Open InfoPane for whoever was clicked — works for humans too now.
  const onClick = () => openAgentInfo(subject.id)

  // 'kicked' rows additionally name the actor (who did the kicking).
  // Other kinds are subject-only.
  const actor = payload.kind === 'kicked' && payload.actorId ? byId[payload.actorId] : null

  return (
    <div className={cn('flex justify-center my-3', riseCls)} style={riseStyle}>
      <div className="text-[11.5px] text-ink-300 italic font-display flex items-center gap-1.5 flex-wrap justify-center">
        {payload.kind === 'kicked' && actor ? (
          <>
            <SystemActor p={actor} onClick={() => openAgentInfo(actor.id)} />
            <span>{t('msgview.removedActor')}</span>
            <SystemActor p={subject} onClick={onClick} />
            <span>{t('msgview.removedFromGroup')}</span>
          </>
        ) : (
          <>
            <SystemActor p={subject} onClick={onClick} />
            <span>— {payload.kind === 'joined' ? 'joined the group'
              : payload.kind === 'left'     ? 'left the group'
              : payload.kind ?? 'updated the group'}</span>
          </>
        )}
      </div>
    </div>
  )
}

/** Small subject pill — avatar + name, clickable when it's an agent (opens
 *  the info pane). Centralized so SystemRow's variants stay readable. */
function SystemActor({ p, onClick }: { p: Participant; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={p.kind !== 'agent'}
      className="inline-flex items-center gap-1.5 not-italic font-semibold text-ink-500 hover:text-skype-deep transition disabled:cursor-default disabled:hover:text-ink-500"
    >
      <Avatar p={p} size={16} ringColor="var(--paper)" showStatus={false} />
      {p.name}
    </button>
  )
}

/** Inline citation card rendered above a reply's body. Click jumps to the
 *  quoted-original via the global hash trick (`#m-${id}`) — Message rows
 *  carry that id on the wrapper div so it works as a CSS scroll target. */
function QuoteCard({ msg }: { msg: Message }) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const jumpToMessage = useApp((s) => s.jumpToMessage)
  if (!msg.quotedMessageId) return null
  const summary = msg.quoted
  // Always go through useApp.jumpToMessage — ChatPane resolves via
  // virtuoso.scrollToIndex, which mounts a row that's been recycled OR was
  // never mounted. The old getElementById path silently no-op'd in those
  // cases — the bug the user hit.
  const targetId = msg.quotedMessageId
  const jump = () => { jumpToMessage(targetId) }
  if (!summary) {
    return (
      <button
        onClick={jump}
        className="mb-1 max-w-[min(100%,580px)] flex items-stretch gap-2 text-left rounded-md bg-cloud/60 border border-ink-100 hover:border-ink-200 px-2 py-1.5 transition-colors"
      >
        <span className="w-[3px] rounded bg-ink-200" />
        <span className="min-w-0 text-[11.5px] text-ink-400 italic">{t('msgview.messageDeleted')}</span>
      </button>
    )
  }
  const authorName = summary.authorName ?? byId[summary.authorId]?.name ?? summary.authorId
  const bodyPreview = summary.kind === 'tool'
    ? '[tool call]'
    : summary.body.slice(0, 140).replace(/\n/g, ' ')
  return (
    <button
      onClick={jump}
      className="mb-1 max-w-[min(100%,580px)] flex items-stretch gap-2 text-left rounded-md bg-cloud/60 border border-ink-100 hover:border-ink-200 hover:bg-cloud px-2 py-1.5 transition-colors"
      title={t('msgview.jumpToOriginal')}
    >
      <span className="w-[3px] rounded bg-skype" />
      <span className="min-w-0 flex flex-col gap-0.5">
        <span className="text-[11.5px] font-semibold text-skype-deep truncate">{authorName}</span>
        <span className="text-[12px] text-ink-500 truncate">{bodyPreview}</span>
      </span>
    </button>
  )
}

/** Tiny reply icon — appears on hover, sets app.replyingTo so the composer
 *  picks up the quote draft. Composers are responsible for wiring this into
 *  the actual sendUserMessage call. */
function ReplyIconButton({ msg }: { msg: Message }) {
  const t = useT()
  const setReplyingTo = useApp((s) => s.setReplyingTo)
  return (
    <button
      onClick={() => setReplyingTo(msg.conversationId, msg.id)}
      className="w-6 h-6 rounded-full hover:bg-sky2-50 grid place-items-center text-ink-400 hover:text-skype-deep"
      title={t('chat.reply')}
      aria-label={t('chat.replyToMessage')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 17 4 12 9 7" />
        <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
      </svg>
    </button>
  )
}

function MessageRowImpl({ msg, author, delay = 0, animate = true }: MessageRowProps) {
  const t = useT()
  const openAgentInfo = useApp((s) => s.openAgentInfo)
  const openThreadView = useApp((s) => s.openThreadView)
  const meId = useMe()
  // System / whisper rows don't need a resolved author — handle them before
  // touching `author` so a synthetic-author system message (the calendar-fired
  // notice, authored by CALENDAR_SYSTEM_AUTHOR_ID) renders instead of being
  // dropped by the missing-author guard.
  if (msg.kind === 'whisper-link') return <WhisperLink msg={msg} />
  if (msg.kind === 'system') return <SystemRow msg={msg} delay={delay} animate={animate} />
  if (!author) return null
  const isHuman = author.kind === 'human'
  const isMine = msg.authorId === meId

  const isToolOnly = msg.kind === 'tool' && !msg.body
  const isAttachOnly = Boolean(msg.attachment) && !msg.body
  const _isEmail = msg.kind === 'email'
  const isPoll = msg.kind === 'poll'
  const artifactRefs = useMemo(
    () => artifactRefsForMessage(msg),
    [msg.body, msg.tool?.arg, msg.tool?.detail],
  )
  // Avatar click opens InfoPane for both kinds — humans now have profile
  // cards (their auth email is the most useful new piece). The "yourself"
  // case is gated below via the disabled prop.
  const onAvatarClick = () => {
    if (!isMine) openAgentInfo(author.id)
  }

  return (
    <div
      id={`m-${msg.id}`}
      className={cn(
        'group grid grid-cols-[38px_1fr] gap-3 items-start scroll-mt-20',
        animate && 'animate-rise',
      )}
      style={animate ? { animationDelay: `${delay}ms` } : undefined}
    >
      <button
        onClick={onAvatarClick}
        disabled={isMine}
        className={cn('rounded-full transition', !isMine && 'hover:opacity-80 active:scale-95 cursor-pointer')}
        title={isMine ? undefined : t('chat.showAuthorInfo', { name: author.name })}
      >
        <Avatar p={author} size={38} ringColor="var(--cloud)" />
      </button>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-bold text-[13.5px] text-ink-900">{author.name}</span>
          {author.role && !isHuman && (
            <span className="text-[10.5px] text-ink-300 font-semibold tracking-wider uppercase">{author.role}</span>
          )}
          {isHuman && !isMine && <HumanBadge />}
          <span className="ml-auto text-[10.5px] text-ink-300 tabular-nums">{msg.at}</span>
        </div>

        <QuoteCard msg={msg} />

        {!isToolOnly && !isAttachOnly && !isPoll && (
          <div
            className={cn(
              'inline-block py-2.5 px-3.5 rounded-tl-[4px] rounded-tr-[14px] rounded-br-[14px] rounded-bl-[14px] text-[14px] leading-[1.55] max-w-[min(100%,580px)] break-words',
              isMine
                ? 'border'
                : 'bg-sky2-50 border border-sky2-100 text-ink-700'
            )}
            style={isMine ? {
              background: 'linear-gradient(135deg, #FFE8E1, #FFD9D2)',
              borderColor: 'rgba(255, 122, 107, 0.25)',
              color: '#5A2B22',
            } : undefined}
          >
            <RichBody body={msg.body} conversationId={msg.conversationId} />
          </div>
        )}

        {/* Open-Graph card for the first URL in a chat-style body. Skipped
            for tool / attachment / poll / email kinds — those have their
            own card UIs and a link preview underneath would be visual
            noise. The component itself returns null when there's nothing
            useful to render, so this gate is just to avoid spurious
            network calls for non-text messages. */}
        {!isToolOnly && !isAttachOnly && !isPoll && msg.kind !== 'email' && (() => {
          const linkUrl = firstUrlInBody(msg.body)
          return linkUrl ? <LinkPreview url={linkUrl} /> : null
        })()}

        {isPoll && <PollBubble msg={msg} />}

        {msg.kind === 'tool' && <ToolCard msg={msg} />}
        {artifactRefs.length > 0 && (
          <div className="flex flex-col">
            {artifactRefs.map((ref) => (
              ref.type === 'document'
                ? <DocumentArtifactCard key={artifactKey(ref)} id={ref.id} conversationId={msg.conversationId} />
                : ref.type === 'board'
                  ? <BoardArtifactCard key={artifactKey(ref)} id={ref.id} />
                  : ref.type === 'card'
                    ? <CardArtifactCard key={artifactKey(ref)} id={ref.id} />
                    : <CalendarArtifactCard key={artifactKey(ref)} id={ref.id} />
            ))}
          </div>
        )}
        {msg.attachment && <AttachmentCard msg={msg} />}

        {(msg.failed || msg.unconfirmed) && (
          <div className="mt-1 flex items-center gap-2 text-[11px] text-coral-deep">
            <span>{msg.unconfirmed ? t('chat.deliveryUnconfirmed') : t('chat.failedToSend')}</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void retryFailedMessage(msg.conversationId, msg.id) }}
              className="font-semibold underline underline-offset-2 hover:text-coral-700"
            >{t('chat.tryAgain')}</button>
            <span className="text-ink-300">·</span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); discardFailedMessage(msg.conversationId, msg.id) }}
              className="font-semibold underline underline-offset-2 hover:text-coral-700"
            >{t('chat.dismiss')}</button>
          </div>
        )}

        {(msg.replyCount ?? 0) > 0 && (
          <button
            onClick={() => openThreadView(msg.conversationId, msg.id)}
            className="mt-1 text-[11.5px] text-skype-deep hover:underline flex items-center gap-1"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
            {msg.replyCount} {msg.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}

        <div className="mt-2 flex flex-wrap gap-1 items-center">
          {/* Dedup by emoji at the render boundary — last writer wins.
              The store's mergeReactionOrder already keeps the array
              unique, but a defensive Map here guarantees the pill row
              never doubles up even if a future code path slips a
              duplicate through. */}
          {Array.from(
            new Map((msg.reactions ?? []).map((r) => [r.emoji, r])).values(),
          ).map((r) => <ReactionPill key={r.emoji} msgId={msg.id} r={r} />)}
          {/* Quick-reaction popup + reply button, visible on hover. */}
          <div className="reaction-quick-tray opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex gap-0.5">
            {QUICK_REACTIONS.filter((e) => !(msg.reactions ?? []).some((r) => r.emoji === e && r.mine)).slice(0, 5).map((e) => (
              <QuickReactionButton key={e} msgId={msg.id} emoji={e} />
            ))}
            <ReplyIconButton msg={msg} />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Memoized wrapper around MessageRowImpl. The big win for long threads is
 *  that WS streaming events (which fire many times per second during a
 *  chat-completion stream) only mutate ONE row's reference in the store —
 *  with default shallow equality, every OTHER row's memo holds and skips
 *  the re-render. Author updates still bust the memo because `author` is
 *  resolved upstream from a Map that is replaced on participant churn;
 *  that's fine — participant churn is rare. */
export const MessageRow = memo(MessageRowImpl)

/**
 * The typing indicator. Always reserves its own row height so the thread
 * doesn't shift up/down when typers come and go — only the inner content
 * fades in/out. Supports any number of typers ("Iris is typing…",
 * "Iris and Bram are typing…", "Iris, Bram and 2 more are typing…").
 */
export function TypingRow({ names }: { names: string[] }) {
  const t = useT()
  const visible = names.length > 0
  let body: React.ReactNode = null
  if (names.length === 1) {
    body = <><b className="text-ink-700 font-semibold">{names[0]}</b>{t('msgview.typingIs')}</>
  } else if (names.length === 2) {
    body = <><b className="text-ink-700 font-semibold">{names[0]}</b>{t('msgview.and')}<b className="text-ink-700 font-semibold">{names[1]}</b>{t('msgview.typingAre')}</>
  } else if (names.length >= 3) {
    body = (
      <>
        <b className="text-ink-700 font-semibold">{names[0]}</b>{t('msgview.typingSep')}<b className="text-ink-700 font-semibold">{names[1]}</b>
        {names.length === 3
          ? <>{t('msgview.and')}<b className="text-ink-700 font-semibold">{names[2]}</b>{t('msgview.typingAre')}</>
          : <>{t('msgview.and')}<b className="text-ink-700 font-semibold">{t('msgview.nMore', { n: names.length - 2 })}</b>{t('msgview.typingAre')}</>}
      </>
    )
  }

  return (
    <div
      // Fixed height + opacity transition = no layout shift when typers
      // appear/disappear, and the dots/name fade smoothly. No internal
      // left-padding — the parent decides positioning, since this row is
      // used both inside the message stream and right above the composer.
      aria-live="polite"
      className="flex items-center gap-2 text-ink-500 text-[12px] transition-opacity duration-200"
      style={{ height: 18, opacity: visible ? 1 : 0, pointerEvents: visible ? 'auto' : 'none' }}
    >
      <span className="inline-flex gap-[3px]">
        <span className="w-[5px] h-[5px] rounded-full bg-skype animate-bounce-dot" />
        <span className="w-[5px] h-[5px] rounded-full bg-skype animate-bounce-dot" style={{ animationDelay: '0.15s' }} />
        <span className="w-[5px] h-[5px] rounded-full bg-skype animate-bounce-dot" style={{ animationDelay: '0.3s' }} />
      </span>
      <span>{body}</span>
    </div>
  )
}
