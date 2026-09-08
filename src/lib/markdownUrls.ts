/**
 * Shared URL-boundary handling for chat Markdown.
 *
 * GFM literal autolinks deliberately accept almost every non-whitespace
 * character in a URL path.  That is surprising in CJK prose, where a URL is
 * commonly followed immediately by a full-width punctuation mark, and it can
 * also swallow a Markdown closing delimiter when prose follows it without a
 * space (for example `**https://example.com**（说明）`).
 *
 * Keep this policy in one place so the Markdown renderer and link-preview
 * extractor agree on the URL that a user can actually open.
 */

/** Characters that conventionally end a URL in CJK prose.  A literal URL
 * that really needs one of these characters can still use percent encoding or
 * explicit Markdown link syntax. */
const CJK_PROSE_BOUNDARY_RE = /[，。；：！？、（）【】《》〈〉“”‘’「」『』]/u

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'"])
const BRACKET_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' }

const HTTP_URL_CANDIDATE_RE = /\bhttps?:\/\/[^\s<>"'`]+/g

export interface SplitHttpUrlOptions {
  /** A Markdown delimiter known to close immediately after the URL. */
  closingMarker?: string
}

/** Split a permissively captured HTTP(S) URL from prose that was swept into
 * the same match.  The returned `trail` is always the exact unused suffix. */
export function splitHttpUrlCandidate(
  raw: string,
  options: SplitHttpUrlOptions = {},
): { url: string; trail: string } {
  let end = raw.length

  if (options.closingMarker) {
    const markerAt = raw.indexOf(options.closingMarker, 'https://'.length)
    if (markerAt >= 0) end = Math.min(end, markerAt)
  }

  const cjkAt = raw.slice(0, end).search(CJK_PROSE_BOUNDARY_RE)
  if (cjkAt >= 0) end = Math.min(end, cjkAt)

  // Trim ordinary sentence punctuation.  Keep balanced ASCII brackets inside
  // the URL (for example a Wikipedia title ending in `)`), but remove a prose
  // closer that has no matching opener in the captured URL.
  while (end > 'https://'.length) {
    const c = raw[end - 1]
    if (TRAILING_PUNCTUATION.has(c)) {
      end--
      continue
    }
    const opener = BRACKET_PAIRS[c]
    if (!opener) break
    const inside = raw.slice(0, end - 1)
    const opens = Array.from(inside).filter((value) => value === opener).length
    const closes = Array.from(inside).filter((value) => value === c).length
    if (closes >= opens) end--
    else break
  }

  return { url: raw.slice(0, end), trail: raw.slice(end) }
}

const MARKDOWN_URL_WRAPPERS = ['**', '__', '~~', '*', '_'] as const

/** Return the first HTTP(S) URL represented by a chat Markdown body. */
export function firstHttpUrlInMarkdown(body: string): string | null {
  HTTP_URL_CANDIDATE_RE.lastIndex = 0
  const match = HTTP_URL_CANDIDATE_RE.exec(body)
  if (!match) return null

  const prefix = body.slice(0, match.index)
  const closingMarker = MARKDOWN_URL_WRAPPERS.find((marker) => prefix.endsWith(marker))
  const { url } = splitHttpUrlCandidate(match[0], { closingMarker })
  return url || null
}
