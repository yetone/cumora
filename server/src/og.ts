/**
 * Open-Graph / link-preview fetcher.
 *
 * Frontend chat bubbles call `/api/og?url=…` when they detect an autolinked
 * URL, so they can render a card with the page's title / description /
 * hero image (the same affordance Slack and iMessage show). This module
 * owns the network fetch, the metadata parser, and the Redis cache.
 *
 *   request flow:
 *     1. validate the URL (scheme, hostname, DNS-resolved IP) — no SSRF
 *     2. consult Redis (cumora:og:<url>) — 7d positive TTL, 1h negative
 *     3. fetch the HTML body, size- and time-bounded
 *     4. extract og:* / twitter:* / <title> / meta description
 *     5. cache + return
 *
 * Cache miss latency dominates; cache hits are sub-ms. The cache key is the
 * raw input URL so the same string from two messages reuses the same entry.
 */
import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { redis } from './redis.js'

const CACHE_PREFIX = 'cumora:og:'
/** Positive cache: how long a successful fetch stays valid. 7 days is long
 *  enough that hot URLs stay cached across a typical workweek, short enough
 *  that a site re-launch or article edit gets picked up within reasonable
 *  time. */
const POSITIVE_TTL_S = 7 * 24 * 3600
/** Negative cache: failed fetches (404, blocked host, parse error) get a
 *  shorter TTL so transient outages recover faster, but long enough that
 *  the same broken link in 1000 messages doesn't refire 1000 network
 *  requests in a tight loop. */
const NEGATIVE_TTL_S = 60 * 60

const FETCH_TIMEOUT_MS = 6000
/** Match fetch's bounded redirect behaviour while keeping each hop under our
 *  own destination policy. Five hops covers common short-link chains without
 *  allowing an attacker to keep the server in an unbounded redirect loop. */
const MAX_REDIRECTS = 5
/** Cap response size to keep memory bounded — OG meta lives in `<head>`,
 *  so 1 MB is plenty for any sane page. Streamed reader aborts early once
 *  this threshold is crossed. */
const MAX_BYTES = 1024 * 1024

export interface OgResult {
  url: string
  title?: string
  description?: string
  image?: string
  siteName?: string
  /** Final URL after redirects — useful when the input was a redirect-y
   *  short link (t.co, lnk.to) and the renderer wants to display the real
   *  hostname under the title. */
  finalUrl?: string
}

export class OgError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/** URL-policy failures must reach the route as 4xx responses even when they
 *  are discovered on a redirect hop. Network/content failures remain a
 *  negative preview result and retain the existing short cache behaviour. */
class OgUrlError extends OgError {}

/** Fetch + parse OG metadata for a URL. Returns null when there's nothing
 *  useful to display (no title / og:title fallback path produced anything),
 *  so callers can skip rendering an empty card. Throws `OgError` for
 *  rejected URLs (bad scheme, SSRF host) so the route handler can map them
 *  to a 4xx instead of leaking 500s. */
export async function ogPreview(rawUrl: string): Promise<OgResult | null> {
  const url = validateUrlString(rawUrl)
  const cacheKey = `${CACHE_PREFIX}${url}`

  // Cache hit (positive or negative). Negative entries serialize as the
  // string "null" so we can distinguish "looked up + nothing useful" from
  // "never looked up" without a separate flag.
  const cached = await redis.get(cacheKey)
  if (cached !== null) {
    if (cached === 'null') return null
    try { return JSON.parse(cached) as OgResult } catch { /* corrupt entry, refetch */ }
  }

  // DNS check happens AFTER URL validation but BEFORE fetch — protects
  // against rebinding / private IP ranges that didn't show in the literal
  // hostname (e.g. someone resolves to 10.0.0.1).
  await assertPublicHost(new URL(url).hostname)

  let result: OgResult | null = null
  try {
    result = await fetchAndParse(url)
  } catch (e) {
    if (e instanceof OgUrlError) throw e
    // Network or parse failure — cache the miss briefly so we don't hammer
    // the upstream. Real protocol errors (bad host, scheme) already threw
    // before this point or were rethrown above for a redirect target.
    console.warn(`[og] fetch failed for ${url}:`, e instanceof Error ? e.message : e)
    result = null
  }

  // Discard cards that have no usable display data (no title and no image)
  // — rendering an empty card is worse than rendering nothing.
  if (result && !result.title && !result.image) result = null

  await redis.set(
    cacheKey,
    result ? JSON.stringify(result) : 'null',
    'EX',
    result ? POSITIVE_TTL_S : NEGATIVE_TTL_S,
  )
  return result
}

function validateUrlString(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new OgUrlError('invalid url')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new OgUrlError('only http(s) urls are supported')
  }
  // Drop fragment for cache hit-rate (#section doesn't change OG metadata).
  u.hash = ''
  return u.toString()
}

/** Block private / loopback / link-local IP ranges. Resolves the hostname
 *  first; if any answer is a private address, refuse. Hostname literals
 *  that ARE IPs are checked directly. */
async function assertPublicHost(host: string): Promise<void> {
  // Hostname literal is itself an IP — check directly, no DNS.
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new OgUrlError('blocked private host', 403)
    return
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new OgUrlError('blocked private host', 403)
  }
  try {
    const addresses = await dnsLookup(host, { all: true })
    if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address))) {
      throw new OgUrlError('blocked private host', 403)
    }
  } catch (e) {
    if (e instanceof OgUrlError) throw e
    throw new OgUrlError('dns lookup failed', 400)
  }
}

function isBlockedIp(ip: string): boolean {
  // IPv4
  if (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('169.254.') ||
      ip.startsWith('192.168.') || ip === '0.0.0.0' ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      // GCP / AWS / Azure metadata endpoints
      ip === '169.254.169.254') {
    return true
  }
  // IPv6
  if (ip === '::1' || ip === '::' ||
      ip.toLowerCase().startsWith('fe80:') ||
      ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd')) {
    return true
  }
  return false
}

async function fetchAndParse(url: string): Promise<OgResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const { response: res, finalUrl } = await fetchWithValidatedRedirects(url, ac.signal)
    if (!res.ok) throw new OgError(`upstream ${res.status}`, 502)

    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    if (!ct.includes('text/html') && !ct.includes('xhtml')) {
      throw new OgError(`unsupported content-type: ${ct || 'unknown'}`, 415)
    }

    // Size-bounded streamed read. fetch() in Node can run unbounded if the
    // upstream sends a giant body; we cancel as soon as we've collected
    // enough to be sure the `<head>` ended.
    const reader = res.body?.getReader()
    if (!reader) throw new OgError('no response body', 502)
    const chunks: Uint8Array[] = []
    let total = 0
    while (total < MAX_BYTES) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      total += value.length
    }
    await reader.cancel().catch(() => { /* ignore — upstream may already be done */ })
    const html = Buffer.concat(chunks).toString('utf8')

    const og: OgResult = { url, finalUrl }
    const title = pickMetaContent(html, 'og:title') ?? pickMetaContent(html, 'twitter:title') ?? pickHtmlTitle(html)
    if (title) og.title = decodeEntities(title).trim().slice(0, 280)
    const desc = pickMetaContent(html, 'og:description') ?? pickMetaContent(html, 'twitter:description') ?? pickMetaName(html, 'description')
    if (desc) og.description = decodeEntities(desc).trim().slice(0, 500)
    const image = pickMetaContent(html, 'og:image') ?? pickMetaContent(html, 'twitter:image') ?? pickMetaContent(html, 'twitter:image:src')
    if (image) og.image = resolveUrl(image, finalUrl)
    const siteName = pickMetaContent(html, 'og:site_name')
    if (siteName) og.siteName = decodeEntities(siteName).trim().slice(0, 80)
    return og
  } finally {
    clearTimeout(timer)
  }
}

async function fetchWithValidatedRedirects(
  url: string,
  signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = url

  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      signal,
      // Automatic following would bypass assertPublicHost for every target
      // after the first. Resolve and validate each Location ourselves.
      redirect: 'manual',
      headers: {
        // A descriptive UA + Accept header improves the OG hit rate (some
        // sites serve a stripped page to bots that look like cURL).
        'user-agent': 'Mozilla/5.0 (compatible; CumoraBot/1.0; +https://cumora.ai)',
        'accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'accept-language': 'en-US,en;q=0.9',
      },
    })

    if (!isRedirectStatus(response.status)) return { response, finalUrl: currentUrl }

    const location = response.headers.get('location')
    if (response.body) {
      await response.body.cancel().catch(() => { /* ignore cleanup failures */ })
    }
    if (!location) throw new OgError('redirect missing location', 502)
    if (redirectCount >= MAX_REDIRECTS) throw new OgError('too many redirects', 502)

    const nextUrl = resolveRedirectUrl(location, currentUrl)
    await assertPublicHost(new URL(nextUrl).hostname)
    currentUrl = nextUrl
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function resolveRedirectUrl(location: string, base: string): string {
  try {
    return validateUrlString(new URL(location, base).toString())
  } catch (e) {
    if (e instanceof OgUrlError) throw e
    throw new OgUrlError('invalid redirect url')
  }
}

/** Tag-attribute parsers. Each meta lookup tries property-first then
 *  content-first so we don't care which attribute order the page used. */
function pickMetaContent(html: string, prop: string): string | null {
  const e = escapeRe(prop)
  return matchFirst(html, new RegExp(`<meta\\b[^>]*\\bproperty\\s*=\\s*['"]${e}['"][^>]*?\\bcontent\\s*=\\s*['"]([^'"]*)['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]*)['"][^>]*?\\bproperty\\s*=\\s*['"]${e}['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*['"]${e}['"][^>]*?\\bcontent\\s*=\\s*['"]([^'"]*)['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]*)['"][^>]*?\\bname\\s*=\\s*['"]${e}['"]`, 'i'))
}

function pickMetaName(html: string, name: string): string | null {
  const e = escapeRe(name)
  return matchFirst(html, new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*['"]${e}['"][^>]*?\\bcontent\\s*=\\s*['"]([^'"]*)['"]`, 'i'))
    ?? matchFirst(html, new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*['"]([^'"]*)['"][^>]*?\\bname\\s*=\\s*['"]${e}['"]`, 'i'))
}

function pickHtmlTitle(html: string): string | null {
  return matchFirst(html, /<title[^>]*>([^<]+)<\/title>/i)
}

function matchFirst(s: string, re: RegExp): string | null {
  const m = s.match(re)
  return m?.[1] ? m[1] : null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Resolve a relative URL (og:image often is) against the final response
 *  URL so the renderer doesn't have to. Returns the original on parse
 *  failure so we still try to render — better a broken `<img>` than a
 *  missing card. */
function resolveUrl(href: string, base: string): string {
  try { return new URL(href, base).toString() } catch { return href }
}

/** Minimal HTML entity decode for the common meta-tag escapes. Pages tend
 *  to use `&amp; &quot; &#39; &lt; &gt;` inside content="…"; everything
 *  else passes through as-is. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
}
