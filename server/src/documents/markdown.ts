import * as Y from 'yjs'

export type ProseMirrorTextNode = { type: 'text'; text: string; marks?: ProseMirrorJsonMark[] }
export type ProseMirrorElementNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: ProseMirrorJsonNode[]
}
export type ProseMirrorJsonNode = ProseMirrorTextNode | ProseMirrorElementNode

export type ProseMirrorJsonMark = {
  type: 'bold' | 'italic' | 'strike' | 'code' | 'link'
  attrs?: Record<string, unknown>
}

const FENCE_RE = /^\s*(```|~~~)\s*([A-Za-z0-9_+\-.#]*)\s*$/
// GFM table: a pipe-delimited row, and the header/body separator line
// (`|---|:---:|`). A table block = row line + separator line + 0..n rows.
const TABLE_ROW_RE = /^\s{0,3}\|(.+)\|\s*$/
const TABLE_SEP_RE = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const IMAGE_RE = /^\s{0,3}!\[([^\]\n]*)\]\((.*?)\)\s*$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const UNORDERED_RE = /^\s{0,3}[-*+]\s+(.+)$/
const ORDERED_RE = /^\s{0,3}(\d+)[.)]\s+(.+)$/

function textNode(text: string, marks?: ProseMirrorJsonMark[]): ProseMirrorJsonNode | null {
  if (!text) return null
  return marks && marks.length > 0
    ? { type: 'text', text, marks }
    : { type: 'text', text }
}

function isTextNode(node: ProseMirrorJsonNode): node is ProseMirrorTextNode {
  return node.type === 'text' && 'text' in node
}

function pushText(out: ProseMirrorJsonNode[], text: string, marks?: ProseMirrorJsonMark[]): void {
  const node = textNode(text, marks)
  if (!node) return
  const prev = out[out.length - 1]
  if (
    prev &&
    isTextNode(prev) &&
    isTextNode(node) &&
    JSON.stringify(prev.marks ?? []) === JSON.stringify(node.marks ?? [])
  ) {
    prev.text += node.text
    return
  }
  out.push(node)
}

function withMark(marks: ProseMirrorJsonMark[] | undefined, mark: ProseMirrorJsonMark): ProseMirrorJsonMark[] {
  return [...(marks ?? []), mark]
}

function findClosing(text: string, marker: string, from: number): number {
  const idx = text.indexOf(marker, from)
  return idx
}

// CommonMark allows intraword emphasis with `*` but NOT with `_`, because
// underscores are load-bearing inside ordinary words: snake_case identifiers and
// underscore-bearing URLs. Treating them as delimiters doesn't just add a stray
// italic — it CONSUMES the underscores, so `user_id and order_id` is stored as
// "user" + italic("id and order") + "id" and the characters are gone for good.
const WORD_CHAR_RE = /[\p{L}\p{N}]/u

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch)
}

/** Can a delimiter run starting at `i` OPEN an emphasis span? Only `_` is
 *  restricted, and only inside a word — we look back past the whole run of
 *  underscores so `foo__bar` is judged by the `o`, not by a sibling `_`. */
function canOpenEmphasis(text: string, i: number): boolean {
  if (text[i] !== '_') return true
  let j = i - 1
  while (j >= 0 && text[j] === '_') j -= 1
  return !isWordChar(text[j])
}

/** Index of the delimiter that actually CLOSES an emphasis span, or -1.
 *  A `_` run sitting inside a word can't close, so keep looking — that's what
 *  lets `_a_b_` still italicize `a_b` the way CommonMark does. */
function findEmphasisClose(text: string, marker: string, from: number): number {
  if (marker[0] !== '_') return findClosing(text, marker, from)
  let idx = text.indexOf(marker, from)
  while (idx >= 0) {
    let j = idx + marker.length
    while (text[j] === '_') j += 1
    if (!isWordChar(text[j])) return idx
    idx = text.indexOf(marker, idx + marker.length)
  }
  return -1
}

function findLinkClose(text: string, openBracket: number): { closeParen: number; label: string; href: string } | null {
  const closeBracket = text.indexOf(']', openBracket + 1)
  if (closeBracket < 0 || text[closeBracket + 1] !== '(') return null
  const closeParen = text.indexOf(')', closeBracket + 2)
  if (closeParen < 0) return null
  const href = text.slice(closeBracket + 2, closeParen).trim()
  if (!href) return null
  return {
    closeParen,
    label: text.slice(openBracket + 1, closeBracket),
    href,
  }
}

export function parseInlineMarkdown(text: string, marks?: ProseMirrorJsonMark[]): ProseMirrorJsonNode[] {
  const out: ProseMirrorJsonNode[] = []
  let i = 0
  while (i < text.length) {
    if (text[i] === '`') {
      const end = findClosing(text, '`', i + 1)
      if (end > i + 1) {
        pushText(out, text.slice(i + 1, end), withMark(marks, { type: 'code' }))
        i = end + 1
        continue
      }
    }
    if ((text.startsWith('**', i) || text.startsWith('__', i)) && canOpenEmphasis(text, i)) {
      const marker = text.slice(i, i + 2)
      const end = findEmphasisClose(text, marker, i + 2)
      if (end > i + 2) {
        out.push(...parseInlineMarkdown(text.slice(i + 2, end), withMark(marks, { type: 'bold' })))
        i = end + 2
        continue
      }
    }
    if (text.startsWith('~~', i)) {
      const end = findClosing(text, '~~', i + 2)
      if (end > i + 2) {
        out.push(...parseInlineMarkdown(text.slice(i + 2, end), withMark(marks, { type: 'strike' })))
        i = end + 2
        continue
      }
    }
    if ((text[i] === '*' || text[i] === '_') && text[i + 1] !== text[i] && canOpenEmphasis(text, i)) {
      const marker = text[i]
      const end = findEmphasisClose(text, marker, i + 1)
      if (end > i + 1) {
        out.push(...parseInlineMarkdown(text.slice(i + 1, end), withMark(marks, { type: 'italic' })))
        i = end + 1
        continue
      }
    }
    if (text[i] === '[' && text[i - 1] !== '!') {
      const link = findLinkClose(text, i)
      if (link) {
        out.push(...parseInlineMarkdown(link.label, withMark(marks, {
          type: 'link',
          attrs: { href: link.href },
        })))
        i = link.closeParen + 1
        continue
      }
    }

    let next = text.length
    for (const marker of ['`', '**', '__', '~~', '*', '_', '[']) {
      const idx = text.indexOf(marker, i + 1)
      if (idx >= 0 && idx < next) next = idx
    }
    pushText(out, text.slice(i, next), marks)
    i = next
  }
  return out
}

function paragraph(text: string): ProseMirrorJsonNode {
  const content = parseInlineMarkdown(text)
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
}

function heading(level: number, text: string): ProseMirrorJsonNode {
  const content = parseInlineMarkdown(text)
  return content.length > 0
    ? { type: 'heading', attrs: { level }, content }
    : { type: 'heading', attrs: { level } }
}

function codeBlock(language: string | null, text: string): ProseMirrorJsonNode {
  return text
    ? { type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] }
    : { type: 'codeBlock', attrs: { language } }
}

function isSafeImageSrc(src: string): boolean {
  return /^(https?:\/\/|\/(?!\/))/i.test(src)
}

function parseImageDestination(raw: string): { src: string; title: string | null } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const angle = /^<([^>\s]+)>(?:\s+(["'])(.*?)\2)?$/.exec(trimmed)
  if (angle) {
    const src = angle[1].trim()
    return isSafeImageSrc(src) ? { src, title: angle[3] ?? null } : null
  }

  const titled = /^(\S+)(?:\s+(["'])(.*?)\2)?$/.exec(trimmed)
  if (!titled) return null
  const src = titled[1].trim()
  return isSafeImageSrc(src) ? { src, title: titled[3] ?? null } : null
}

function image(alt: string, rawDestination: string): ProseMirrorJsonNode | null {
  const dest = parseImageDestination(rawDestination)
  if (!dest) return null
  return {
    type: 'image',
    attrs: {
      src: dest.src,
      alt: alt || null,
      title: dest.title,
    },
  }
}

export function parseMarkdownImageBlock(line: string): ProseMirrorJsonNode | null {
  const img = IMAGE_RE.exec(line)
  return img ? image(img[1], img[2]) : null
}

function listItem(text: string): ProseMirrorJsonNode {
  return { type: 'listItem', content: [paragraph(text)] }
}

/** Split a GFM table row into cell texts. Handles escaped pipes (`\|`)
 *  inside cells and trims the optional leading/trailing pipe. */
export function splitTableRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') { cur += '|'; i++; continue }
    if (inner[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += inner[i]
  }
  cells.push(cur.trim())
  return cells
}

function tableCell(kind: 'tableHeader' | 'tableCell', text: string): ProseMirrorJsonNode {
  // tiptap's table schema requires block content inside cells — wrap in a
  // paragraph, running the same inline parser as everywhere else so code
  // spans / bold / links inside cells keep working.
  return { type: kind, content: [paragraph(text)] }
}

function tableRow(cells: string[], kind: 'tableHeader' | 'tableCell'): ProseMirrorJsonNode {
  return { type: 'tableRow', content: cells.map((c) => tableCell(kind, c)) }
}

function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    IMAGE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UNORDERED_RE.test(line) ||
    ORDERED_RE.test(line) ||
    TABLE_ROW_RE.test(line)
  )
}

/** Reflow image-syntax that the agent split across lines.
 *
 *  Agents often emit `![alt](url)` where the URL is a presigned CDN link
 *  hundreds of characters long. Their model output formatter happily
 *  wraps the URL — and sometimes the gap between `]` and `(` — onto new
 *  lines for readability. The block parser is line-by-line and the
 *  IMAGE_RE anchors at `^...$`, so a multi-line image never matches and
 *  the whole `![alt](url)` falls through to the paragraph branch and
 *  renders as literal text in the doc (the exact bug users see: "agent
 *  inserted a markdown link, no image showed up").
 *
 *  Fix by pre-collapsing whitespace between `![...]` and `(`, and inside
 *  `(...)` itself. URLs don't legitimately contain whitespace, so this
 *  is safe — and if the model put real spaces there by mistake, the
 *  outcome (image renders) is what they intended anyway.
 *
 *  Only image blocks are touched. The `!\[...\]` prefix is required, so
 *  ordinary text links `[label](url)` and any prose in between is left
 *  alone. `[^()]*?` is non-greedy + paren-free so we don't gobble across
 *  the *next* image's parens. */
function collapseMultilineImageBlocks(markdown: string): string {
  return markdown.replace(/(!\[[^\]\n]*\])\s*\(\s*([^()]*?)\s*\)/g, (_, alt: string, dest: string) => {
    // Preserve the CommonMark title separator in `url "title"`. Only the
    // URL portion is allowed to be reflowed; collapsing every whitespace
    // character used to turn it into `url"title"` and parse the title as
    // part of src. Titles themselves may contain spaces and must stay intact.
    const title = /\s+(["'])(.*?)\1\s*$/.exec(dest)
    if (!title || title.index === undefined) return `${alt}(${dest.replace(/\s+/g, '')})`
    const src = dest.slice(0, title.index).replace(/\s+/g, '')
    return `${alt}(${src} ${title[1]}${title[2]}${title[1]})`
  })
}

export function markdownToProseMirrorContent(markdown: string): ProseMirrorJsonNode[] {
  const lines = collapseMultilineImageBlocks(markdown).replace(/\r\n?/g, '\n').split('\n')
  const out: ProseMirrorJsonNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1]
      const language = fence[2] || null
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      out.push(codeBlock(language, body.join('\n')))
      continue
    }

    const h = HEADING_RE.exec(line)
    if (h) {
      out.push(heading(h[1].length, h[2].trim()))
      i++
      continue
    }

    if (HR_RE.test(line)) {
      out.push({ type: 'horizontalRule' })
      i++
      continue
    }

    if (IMAGE_RE.test(line)) {
      const node = parseMarkdownImageBlock(line)
      out.push(node ?? { type: 'paragraph', content: [{ type: 'text', text: line.trim() }] })
      i++
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      const quoted: string[] = []
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i])
        if (!q) break
        quoted.push(q[1])
        i++
      }
      out.push({ type: 'blockquote', content: markdownToProseMirrorContent(quoted.join('\n')) })
      continue
    }

    const unordered = UNORDERED_RE.exec(line)
    if (unordered) {
      const items: ProseMirrorJsonNode[] = []
      while (i < lines.length) {
        const item = UNORDERED_RE.exec(lines[i])
        if (!item) break
        items.push(listItem(item[1].trim()))
        i++
      }
      out.push({ type: 'bulletList', content: items })
      continue
    }

    const ordered = ORDERED_RE.exec(line)
    if (ordered) {
      const start = Number(ordered[1]) || 1
      const items: ProseMirrorJsonNode[] = []
      while (i < lines.length) {
        const item = ORDERED_RE.exec(lines[i])
        if (!item) break
        items.push(listItem(item[2].trim()))
        i++
      }
      out.push({ type: 'orderedList', attrs: { start }, content: items })
      continue
    }

    // GFM table: header row + separator row (+ body rows). Cells run the
    // normal inline parser, so `code`, **bold**, links inside cells work.
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headerCells = splitTableRow(line)
      const rows: ProseMirrorJsonNode[] = [tableRow(headerCells, 'tableHeader')]
      i += 2
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]) && !TABLE_SEP_RE.test(lines[i])) {
        // Pad/truncate body rows to the header width — tiptap's fixTables
        // would repair ragged rows anyway, but emitting a rectangular
        // table keeps the Yjs snapshot canonical from the start.
        const cells = splitTableRow(lines[i])
        while (cells.length < headerCells.length) cells.push('')
        rows.push(tableRow(cells.slice(0, headerCells.length), 'tableCell'))
        i++
      }
      out.push({ type: 'table', content: rows })
      continue
    }

    const paragraphLines: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraphLines.push(lines[i].trim())
      i++
    }
    if (paragraphLines.length === 0) {
      // A line that LOOKS like a block start but matched no block branch —
      // e.g. a pipe row with no separator line under it. Consume it as a
      // one-line paragraph; without this the loop would never advance.
      paragraphLines.push(line.trim())
      i++
    }
    out.push(paragraph(paragraphLines.join(' ')))
  }

  return out.length > 0 ? out : [{ type: 'paragraph' }]
}

function markAttrs(marks: ProseMirrorJsonMark[] | undefined): Record<string, unknown> | undefined {
  if (!marks || marks.length === 0) return undefined
  const attrs: Record<string, unknown> = {}
  for (const mark of marks) attrs[mark.type] = mark.attrs ?? {}
  return attrs
}

export function proseMirrorNodeToYXml(node: ProseMirrorJsonNode): Y.XmlElement | Y.XmlText {
  if (isTextNode(node)) {
    const text = new Y.XmlText()
    text.applyDelta([{ insert: node.text, attributes: markAttrs(node.marks) }])
    return text
  }

  const el = new Y.XmlElement(node.type)
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined) {
      // y-prosemirror stores raw ProseMirror attrs (numbers, booleans, etc.)
      // on Y.XmlElement even though yjs' public TS type only accepts strings.
      el.setAttribute(key, value as string)
    }
  }
  if (node.content && node.content.length > 0) {
    el.insert(0, node.content.map(proseMirrorNodeToYXml))
  }
  return el
}

export function markdownToYXml(markdown: string): Array<Y.XmlElement | Y.XmlText> {
  return markdownToProseMirrorContent(markdown).map(proseMirrorNodeToYXml)
}
