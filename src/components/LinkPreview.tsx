import { type ReactNode, useEffect, useState } from 'react'
import { http } from '@/api/client'
import { firstHttpUrlInMarkdown } from '@/lib/markdownUrls'

/**
 * Inline OG card rendered under a chat bubble when its body contains a URL.
 *
 * Only the FIRST URL in a message gets a card — Slack / iMessage default,
 * and the right one here too: chat messages with many links almost always
 * mean "here are some references", which doesn't need a card stack.
 *
 * Resolution flow:
 *   1. Module-scope `cache` keyed by URL — mounted/unmounted bubbles share
 *      the same fetched data so scrolling in/out of view never re-fetches.
 *   2. While loading, we render NOTHING (no skeleton). A skeleton would
 *      bloat the message height and pop in/out, which is more disruptive
 *      than a card that simply appears once it's ready.
 *   3. On success: card with image (if any) + site name + title +
 *      description, clickable to open the URL in a new tab.
 *   4. On failure / no useful metadata: render nothing so the bubble looks
 *      exactly like before the feature shipped.
 *
 * The server endpoint (/api/og) does its own Redis-backed caching with a
 * 7-day TTL; the in-memory cache here only avoids redundant work during
 * one session.
 */

interface OgData {
  url: string
  title?: string
  description?: string
  image?: string
  siteName?: string
  finalUrl?: string
  empty?: boolean
}

/** Module-scope cache. Plain Map is fine — entries are tiny and the page
 *  lifespan is short. Cleared on full reload. */
const cache = new Map<string, OgData | null>()
/** In-flight de-dupe: if the same URL appears 10 times in a transcript, we
 *  fire one request, not ten. The pending Promise resolves to the result
 *  the same way the cache entry would. */
const inflight = new Map<string, Promise<OgData | null>>()

async function fetchOg(url: string): Promise<OgData | null> {
  if (cache.has(url)) return cache.get(url) ?? null
  const existing = inflight.get(url)
  if (existing) return existing
  const p = (async () => {
    try {
      const data = await http<OgData>(`/og?url=${encodeURIComponent(url)}`)
      const useful = data && !data.empty && (data.title || data.image)
      const result = useful ? data : null
      cache.set(url, result)
      return result
    } catch {
      cache.set(url, null)
      return null
    } finally {
      inflight.delete(url)
    }
  })()
  inflight.set(url, p)
  return p
}

/** Fixed card height — same whether the OG payload has a hero image
 *  or not, whether it's a text-only card or a no-metadata fallback. Any
 *  variation here would push the bubbles below up or down as the fetch
 *  resolves, which is exactly the scroll jitter we're trying to kill.
 *  Picked to fit a 60×60 thumbnail + 2 lines of text + a hostname
 *  caption without overflowing. */
const CARD_HEIGHT_PX = 80
const THUMB_PX = 60

export function LinkPreview({ url }: { url: string }) {
  // Sync initial state from cache to avoid a one-frame flash when the
  // bubble re-mounts (e.g. virtualized list scrolls a row back into view).
  const [data, setData] = useState<OgData | null>(() => cache.get(url) ?? null)
  const [loaded, setLoaded] = useState(() => cache.has(url))

  useEffect(() => {
    if (cache.has(url)) {
      setData(cache.get(url) ?? null)
      setLoaded(true)
      return
    }
    let cancelled = false
    void fetchOg(url).then((d) => {
      if (cancelled) return
      setData(d)
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [url])

  // Common wrapper so the loading skeleton, the populated card, and the
  // "no metadata" empty state are all painted at the exact same height.
  // The bubble row height never changes after first paint, which is the
  // whole point of this redesign — old hero-image cards swung between
  // ~80 px and ~200 px depending on whether og:image existed, and that
  // height swing inside a virtualized list produced the scroll jitter
  // users complained about.
  const wrap = (children: ReactNode) => (
    <div
      className="mt-1.5 flex max-w-[440px] overflow-hidden rounded-[10px] border"
      style={{
        borderColor: 'var(--ink-100)',
        background: 'var(--paper-100, #FAF8F4)',
        height: CARD_HEIGHT_PX,
        width: 360,
      }}
    >
      {children}
    </div>
  )

  if (!loaded) {
    // Loading: same-shape, low-opacity placeholder. Renders at the
    // exact final card height so the bubble doesn't grow when the fetch
    // resolves.
    return wrap(
      <div style={{ width: '100%', opacity: 0.55 }} aria-hidden />,
    )
  }

  if (!data || (!data.title && !data.image)) {
    // No usable OG payload. We still occupy the same slot so the row
    // height is invariant — render a minimal "domain only" pill so the
    // slot at least carries information rather than looking like dead
    // space. (Anchor still works.)
    let fallbackHost = ''
    try { fallbackHost = new URL(url).hostname.replace(/^www\./, '') } catch { /* keep empty */ }
    return wrap(
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center px-3 transition hover:bg-sky2-50"
        style={{ color: 'var(--ink-700)', textDecoration: 'none' }}
      >
        <span className="truncate text-[12px]">{fallbackHost || url}</span>
      </a>,
    )
  }

  // Hostname for the "from foo.com" caption — preferred over og:site_name
  // when the latter is missing, since users recognize hostnames.
  let host: string | null = null
  try { host = new URL(data.finalUrl ?? data.url).hostname.replace(/^www\./, '') } catch { /* keep null */ }

  return wrap(
    <a
      href={data.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex w-full transition-colors hover:bg-sky2-50"
      style={{ textDecoration: 'none' }}
    >
      {/* Thumbnail slot — fixed square so the layout doesn't depend on
          whether og:image exists or how the thumbnail's intrinsic aspect
          looks. Empty slot stays the same width as the thumbnail so the
          text column starts at the same x either way. */}
      <div
        className="shrink-0 overflow-hidden"
        style={{
          width: THUMB_PX,
          height: THUMB_PX,
          alignSelf: 'center',
          marginLeft: 10,
          marginRight: 12,
          borderRadius: 8,
          background: data.image ? 'rgba(15, 30, 50, 0.04)' : 'transparent',
        }}
      >
        {data.image && (
          <img
            src={data.image}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={(e) => {
              // 404 / hotlink refusal — hide the broken icon but leave
              // the slot, so the card height stays constant.
              ;(e.currentTarget as HTMLImageElement).style.display = 'none'
            }}
          />
        )}
      </div>
      <div className="min-w-0 flex-1 self-center py-2 pr-3">
        {(data.siteName || host) && (
          <div
            className="truncate text-[10px] font-medium uppercase tracking-[0.10em]"
            style={{ color: 'var(--ink-500)' }}
          >
            {data.siteName ?? host}
          </div>
        )}
        {data.title && (
          <div
            className="truncate text-[13px] font-semibold leading-[1.35]"
            style={{ color: 'var(--ink-900)' }}
          >
            {data.title}
          </div>
        )}
        {data.description && (
          <div
            className="truncate text-[11.5px] leading-[1.4]"
            style={{ color: 'var(--ink-700)' }}
          >
            {data.description}
          </div>
        )}
      </div>
    </a>,
  )
}

/** Pull the first http(s) URL out of a message body. Returns null when the
 *  body has no link; used by the bubble to decide whether to mount a
 *  LinkPreview at all. Uses the renderer's shared URL-boundary policy so the
 *  address we render is the same one we expand into a card. */
export function firstUrlInBody(body: string): string | null {
  return firstHttpUrlInMarkdown(body)
}
