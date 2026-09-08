import { type ClassValue, clsx } from 'clsx'
import { useEffect, useState } from 'react'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const MOBILE_BREAKPOINT = 768

function isNativeMobile(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }
  if (!w.Capacitor?.isNativePlatform?.()) return false
  const platform = w.Capacitor.getPlatform?.()
  return platform === 'ios' || platform === 'android'
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    if (isNativeMobile()) return true
    return window.innerWidth < MOBILE_BREAKPOINT
  })

  useEffect(() => {
    if (isNativeMobile()) {
      setIsMobile(true)
      return
    }
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return isMobile
}

export function statusColor(status: string): string {
  switch (status) {
    case 'avail': return 'var(--avail)'
    case 'working': return 'var(--working)'
    case 'thinking': return 'var(--thinking)'
    case 'waiting': return 'var(--waiting)'
    case 'resting': return 'var(--resting)'
    default: return 'var(--resting)'
  }
}

/** parse a message body and return rich inline tokens (mentions, bold,
 *  inline code, emoji). Emojis are split out as their own tokens so
 *  renderers can swap in Twemoji SVGs instead of native glyphs. */
export type RichToken =
  | { kind: 'text'; value: string }
  | { kind: 'document'; id: string }
  | { kind: 'board'; id: string }
  | { kind: 'card'; id: string }
  | { kind: 'calendar'; id: string }
  // `id` is the raw participant id captured from "@<id>"; renderers resolve
  // it to a display name via the participants store at render time. We do
  // NOT carry a "looks like an agent" guess here — the renderer asks the
  // store for the real kind.
  | { kind: 'mention'; id: string }
  /** A per-conversation message sequence reference, e.g. `#259` — agents emit
   *  these to point at an earlier message. Renderer turns it into a clickable
   *  chip that scrolls to the referenced message (and hover-previews it). */
  | { kind: 'msgref'; n: number }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'emoji'; value: string }
  | { kind: 'skype'; name: string }
  // Autolinked URL. `text` is the display form (usually identical to `url`,
  // possibly trimmed of trailing sentence punctuation that the regex
  // accidentally swept up); `url` is what we navigate to.
  | { kind: 'link'; url: string; text: string }

import emojiRegex from 'emoji-regex'
import { findSkypeByShortcode, SKYPE_SHORTCODE_RE } from '@/lib/skypeEmojis'
import { splitHttpUrlCandidate } from './markdownUrls'

const DOC_REF_TOKEN_RE = /^doc_[A-Za-z0-9]+$/
const BOARD_REF_TOKEN_RE = /^board-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const CARD_REF_TOKEN_RE = /^card-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/
const CALENDAR_REF_TOKEN_RE = /^ce-[A-Za-z0-9-]+$/

/** Walk a plain-text segment and split out emoji + Skype shortcodes into
 *  their own tokens. Used after the structured-token regex has done its
 *  first pass; we only re-tokenize what's left as `text`.
 *
 *  Skype shortcodes are sliced first since they're literal text patterns
 *  like "(rofl)" — they can't contain unicode emoji, so it's safe to
 *  match them, then run the emoji pass on the remaining text spans. */
function splitEmoji(seg: string, out: RichToken[]): void {
  if (!seg) return
  // Pass 1: cut out Skype shortcodes. Resets `lastIndex` because the
  // shared regex is `/g` and survives between calls.
  SKYPE_SHORTCODE_RE.lastIndex = 0
  let last = 0
  let m: RegExpExecArray | null
  while ((m = SKYPE_SHORTCODE_RE.exec(seg)) !== null) {
    if (m.index > last) splitUnicodeEmoji(seg.slice(last, m.index), out)
    const skype = findSkypeByShortcode(m[0])
    if (skype) out.push({ kind: 'skype', name: skype.key })
    else out.push({ kind: 'text', value: m[0] }) // shouldn't happen, but stay literal
    last = m.index + m[0].length
  }
  if (last < seg.length) splitUnicodeEmoji(seg.slice(last), out)
}

function splitUnicodeEmoji(seg: string, out: RichToken[]): void {
  if (!seg) return
  const re = emojiRegex()
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(seg)) !== null) {
    if (m.index > last) out.push({ kind: 'text', value: seg.slice(last, m.index) })
    out.push({ kind: 'emoji', value: m[0] })
    last = m.index + m[0].length
  }
  if (last < seg.length) out.push({ kind: 'text', value: seg.slice(last) })
}

export function parseBody(body: string): RichToken[] {
  const tokens: RichToken[] = []
  // Order matters: inline `code` first so backtick-wrapped @mentions / bold
  // are kept literal. Exact artifact ids inside backticks still become links.
  // The code group is non-greedy and bans newlines so multi-line fenced
  // blocks (handled by parseBlocks) never get swallowed.
  // Order matters: inline `code` and bold are anchored by their own
  // delimiters and win against the URL pattern; URLs must come before the
  // artifact id / mention patterns so that something like
  // "https://example.com/board-123" isn't shredded into a "/board-" token.
  // `#N` (per-convo message seq) requires a non-word boundary before the `#`
  // — lookbehind `(?<![A-Za-z0-9_])` keeps "C#7" out and lets bare `#259` in.
  const re = /(`[^`\n]+`|\*\*[^*]+\*\*|\bhttps?:\/\/[^\s<>"'`]+|\bdoc_[A-Za-z0-9]+\b|\bboard-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b|\bcard-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b|\bce-[A-Za-z0-9-]+\b|@[A-Za-z][\w-]*|(?<![A-Za-z0-9_])#\d{1,10}\b)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    // Text before this structured token may itself contain emoji.
    splitEmoji(body.slice(last, m.index), tokens)
    const t = m[0]
    if (t.startsWith('**')) {
      tokens.push({ kind: 'bold', value: t.slice(2, -2) })
    } else if (t.startsWith('`')) {
      const value = t.slice(1, -1)
      if (DOC_REF_TOKEN_RE.test(value)) {
        tokens.push({ kind: 'document', id: value })
      } else if (BOARD_REF_TOKEN_RE.test(value)) {
        tokens.push({ kind: 'board', id: value })
      } else if (CARD_REF_TOKEN_RE.test(value)) {
        tokens.push({ kind: 'card', id: value })
      } else if (CALENDAR_REF_TOKEN_RE.test(value)) {
        tokens.push({ kind: 'calendar', id: value })
      } else {
        tokens.push({ kind: 'code', value })
      }
    } else if (t.startsWith('http')) {
      // The non-space match can sweep up sentence punctuation like
      // "...visit https://example.com." or "(see https://example.com)".
      // Strip trailing punctuation, keeping balanced () [] {} <> inside the
      // URL (Wikipedia titles, Mediawiki anchors, etc.) and re-emitting the
      // trimmed tail as plain text so the message keeps its grammar.
      const { url, trail } = splitHttpUrlCandidate(t)
      tokens.push({ kind: 'link', url, text: url })
      if (trail) splitEmoji(trail, tokens)
    } else if (t.startsWith('doc_')) {
      tokens.push({ kind: 'document', id: t })
    } else if (t.startsWith('board-')) {
      tokens.push({ kind: 'board', id: t })
    } else if (t.startsWith('card-')) {
      tokens.push({ kind: 'card', id: t })
    } else if (t.startsWith('ce-')) {
      tokens.push({ kind: 'calendar', id: t })
    } else if (t.startsWith('#')) {
      tokens.push({ kind: 'msgref', n: Number(t.slice(1)) })
    } else {
      tokens.push({ kind: 'mention', id: t.slice(1) })
    }
    last = m.index + t.length
  }
  splitEmoji(body.slice(last), tokens)
  return tokens
}

/** Block-level splitter — separates fenced code blocks (```lang\n...```) from
 *  the surrounding prose. Prose blocks still need to go through `parseBody`
 *  for inline tokens; code blocks render as their own `<pre>`. */
export type BlockToken =
  | { kind: 'prose'; text: string }
  | { kind: 'code-block'; lang: string; code: string }

export function parseBlocks(body: string): BlockToken[] {
  const blocks: BlockToken[] = []
  // Match ```optional-lang\n...content...\n``` — content captured non-greedy
  // so consecutive blocks don't fuse. Fence must start at column 0 or after
  // a newline; we don't require this strictly (mirrors common markdown
  // permissiveness) since chat bodies are short.
  const re = /```([a-zA-Z0-9_+\-.#]*)\n([\s\S]*?)```/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) blocks.push({ kind: 'prose', text: body.slice(last, m.index) })
    blocks.push({ kind: 'code-block', lang: m[1] || '', code: m[2].replace(/\n$/, '') })
    last = m.index + m[0].length
  }
  if (last < body.length) blocks.push({ kind: 'prose', text: body.slice(last) })
  // All-prose shortcut — no allocations for the common case.
  if (blocks.length === 0) blocks.push({ kind: 'prose', text: body })
  return blocks
}
