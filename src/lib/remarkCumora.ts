/**
 * remark plugin: Cumora's custom inline tokens on top of standard Markdown.
 *
 * react-markdown + remark-gfm parse the STANDARD grammar (headings, lists,
 * blockquotes, tables, emphasis, code, autolinks). This plugin layers on the
 * Cumora-specific tokens that no Markdown engine knows about, so they keep
 * rendering as their rich components:
 *   - `@<id>`                     → mention chip (avatar + hovercard)
 *   - `doc_… / board-… / card-… / ce-…` → live artifact link cards
 *   - unicode emoji               → Twemoji
 *   - Skype `(shortcode)`         → animated Skype emoji
 *
 * It runs `parseBody` (the single source of truth for Cumora tokenization) on
 * every remaining text node and splits matches into custom mdast nodes carrying
 * a `data.hName` so mdast→hast emits a custom element that react-markdown maps
 * to the matching component (see `cumoraMarkdownComponents` in Message.tsx).
 *
 * Text nodes only reach here AFTER remark has consumed the standard markers
 * (bold/italic/code/links), so in practice parseBody only finds the four custom
 * kinds — but we map every kind it can emit, defensively.
 */
import type { Link, Parents, Root, RootContent, Text } from 'mdast'
import { SKIP, visit } from 'unist-util-visit'
import { splitHttpUrlCandidate } from './markdownUrls'
import { parseBody, type RichToken } from './utils'

/** A custom mdast node that mdast-util-to-hast renders as `<hName …>` because of
 *  `data.hName` / `data.hProperties`. react-markdown then routes it to our
 *  component by tag name. */
function customEl(hName: string, hProperties: Record<string, string>): RootContent {
  return {
    type: 'cumora',
    data: { hName, hProperties },
    children: [],
  } as unknown as RootContent
}

function tokenToNode(t: RichToken): RootContent {
  switch (t.kind) {
    case 'mention': return customEl('cmention', { cid: t.id })
    case 'msgref': return customEl('cmsgref', { cn: String(t.n) })
    case 'document': return customEl('cartifact', { ckind: 'document', cid: t.id })
    case 'board': return customEl('cartifact', { ckind: 'board', cid: t.id })
    case 'card': return customEl('cartifact', { ckind: 'card', cid: t.id })
    case 'calendar': return customEl('cartifact', { ckind: 'calendar', cid: t.id })
    case 'emoji': return customEl('cemoji', { cchar: t.value })
    case 'skype': return customEl('cskype', { cname: t.name })
    // The standard kinds below are normally handled by remark itself; we map
    // them too so a stray literal marker in a text node still renders right.
    case 'bold': return { type: 'strong', children: [{ type: 'text', value: t.value }] } as RootContent
    case 'code': return { type: 'inlineCode', value: t.value } as RootContent
    case 'link': return { type: 'link', url: t.url, children: [{ type: 'text', value: t.text }] } as RootContent
    default: return { type: 'text', value: t.value } as RootContent
  }
}

const URL_WRAPPERS = [
  { marker: '**', type: 'strong' },
  { marker: '__', type: 'strong' },
  { marker: '~~', type: 'delete' },
  { marker: '*', type: 'emphasis' },
  { marker: '_', type: 'emphasis' },
] as const

function samePosition(a: RootContent['position'], b: RootContent['position']): boolean {
  return !!a && !!b
    && a.start.offset === b.start.offset
    && a.end.offset === b.end.offset
}

/** GFM literal autolinks can absorb Markdown closers and CJK punctuation.
 * Repair those nodes before applying Cumora's custom inline-token pass. */
function repairLiteralAutolinks(parent: Parents): void {
  for (let index = 0; index < parent.children.length; index++) {
    const node = parent.children[index]
    if (node.type !== 'link') {
      if ('children' in node && Array.isArray(node.children)) repairLiteralAutolinks(node as Parents)
      continue
    }

    const label = node.children.length === 1 && node.children[0].type === 'text'
      ? node.children[0]
      : null
    // A literal autolink's link and label cover the same source span.  This
    // excludes `[label](url)` and `<url>`, which already have explicit bounds.
    if (!label || label.value !== node.url || !samePosition(node.position, label.position)) continue

    const previous = index > 0 ? parent.children[index - 1] : null
    const wrapper = previous?.type === 'text'
      ? URL_WRAPPERS.find(({ marker }) => (
          previous.value.endsWith(marker)
          && node.url.indexOf(marker, 'https://'.length) >= 0
        ))
      : undefined
    const split = splitHttpUrlCandidate(node.url, { closingMarker: wrapper?.marker })
    if (!split.url || (split.url === node.url && !wrapper)) continue

    const fixedLink: Link = {
      ...node,
      url: split.url,
      children: [{ type: 'text', value: split.url }],
    }

    if (wrapper && previous?.type === 'text') {
      const before = previous.value.slice(0, -wrapper.marker.length)
      const trail = split.trail.slice(wrapper.marker.length)
      const formatted = {
        type: wrapper.type,
        children: [fixedLink],
      } as RootContent
      const replacement: RootContent[] = []
      if (before) replacement.push({ type: 'text', value: before })
      replacement.push(formatted)
      if (trail) replacement.push({ type: 'text', value: trail })
      parent.children.splice(index - 1, 2, ...replacement)
      index = index - 2 + replacement.length
      continue
    }

    parent.children[index] = fixedLink
    if (split.trail) {
      parent.children.splice(index + 1, 0, { type: 'text', value: split.trail })
      index++
    }
  }
}

export function remarkCumora() {
  return (tree: Root): void => {
    repairLiteralAutolinks(tree)

    // Do not tokenize text that is already a link label.  In particular, a
    // GFM literal autolink label is the URL itself; converting that text again
    // used to produce invalid nested `<a>` elements for every bare URL.
    const linkedText = new WeakSet<object>()
    visit(tree, ['link', 'linkReference'], (node) => {
      visit(node, 'text', (text) => { linkedText.add(text) })
      return SKIP
    })

    visit(tree, 'text', (node: Text, index, parent) => {
      if (!parent || typeof index !== 'number') return
      if (linkedText.has(node)) return
      const tokens = parseBody(node.value)
      // Nothing Cumora-specific in this text node — leave it untouched.
      if (tokens.length === 1 && tokens[0].kind === 'text') return
      const replacement = tokens.map(tokenToNode)
      parent.children.splice(index, 1, ...replacement)
      // Skip past the nodes we just inserted so we don't re-visit them.
      return [SKIP, index + replacement.length]
    })
  }
}
