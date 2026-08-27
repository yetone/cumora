/**
 * Materialize an image URL into a base64 `data:` URL safe to ship as OpenAI
 * `input_image`.
 *
 * Why this exists — the incident (2026-05-14):
 *
 *   OpenAI's Responses API treats `image_url` as fail-loud — they fetch the
 *   URL server-side, and a single 404 / wrong content-type / timeout /
 *   oversize image rejects the *whole* POST with HTTP 400. Combined with
 *   sub2api wrapping that as 502 and our agent runtime having no retry, one
 *   rotten avatar bricked every agent turn in any conversation referencing
 *   it. Determ. failure loop, hours of dead agents.
 *
 * The fix: GET the bytes here ourselves with strict caps (size / timeout /
 * content-type / SSRF guard), encode base64, hand OpenAI a self-contained
 * `data:` URL. OpenAI never touches the network for our images again. Any
 * fetch failure on our side → we drop the image silently → turn still runs
 * (the model loses one face, gains 0% chance of bricking).
 *
 * Security boundary: every image download in the agent runtime should use
 * `fetchImageBytes`. It resolves every hostname, rejects the entire answer
 * set when any address is non-public, then connects directly to one of the
 * validated addresses. Redirects are followed manually and repeat the same
 * validation. This closes both DNS rebinding/TOCTOU and redirect pivots into
 * loopback, link-local, metadata, or private-network services.
 *
 * Tradeoff vs. HEAD-probe + raw URL: ~33% larger request body to OpenAI
 * (base64 overhead). Image *tokens* are identical (computed from decoded
 * pixel dimensions, not wire format), so billing is unchanged; only the
 * cumora-server ↔ OpenAI hop pays. Worth it — HEAD-probe still leaks
 * failures via TOCTOU (200 on HEAD, 4xx on the GET OpenAI does later) and
 * via OpenAI's fetcher hitting different network conditions than ours.
 *
 * Cache: successes cached 10 min (CDN bytes are stable); failures cached
 * 1 min (so transient blips self-recover without sticking). Total cache
 * memory bounded at ~100 MB via byte-aware eviction.
 */

import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { type RequestOptions as HttpsRequestOptions, request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

type ImageFetchFailureReason = 'http' | 'timeout' | 'too-large' | 'bad-type' | 'blocked' | 'error'

interface MaterializeOk { ok: true; dataUrl: string; bytes: number }
interface ImageFetchFailure {
  ok: false
  reason: ImageFetchFailureReason
  status?: number
}
export type MaterializeResult = MaterializeOk | ImageFetchFailure

export interface ImageBytesOk {
  ok: true
  buffer: Buffer
  mime: string
  bytes: number
  finalUrl: string
}
export type ImageBytesResult = ImageBytesOk | ImageFetchFailure

export interface ImageFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
}

interface ResolvedAddress {
  address: string
  family: 4 | 6
}

interface ResolvedImageTarget {
  url: URL
  hostname: string
  address: string
  family: 4 | 6
}

interface ImageHttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: AsyncIterable<Uint8Array>
  cancel(): void
}

interface ImageFetchDependencies {
  lookup(hostname: string): Promise<readonly ResolvedAddress[]>
  request(target: ResolvedImageTarget, signal: AbortSignal): Promise<ImageHttpResponse>
}

interface RequiredImageFetchOptions {
  maxBytes: number
  timeoutMs: number
  maxRedirects: number
}

type ImageFetchOverride = (
  url: string,
  options: ImageFetchOptions,
) => Promise<ImageBytesResult>

/** 10 MB per image. OpenAI's per-image limits vary by model but are
 *  typically <=20 MB on the wire; staying well under avoids edge rejection
 *  and bounds attacker leverage on attachment URLs. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Bound the in-process cache memory footprint. ~100 MB allows roughly
 *  hundreds of cached avatars or tens of cached user attachments without
 *  growing unboundedly. Oldest entry is evicted when a new entry would
 *  push us over. */
const MAX_CACHE_BYTES = 100 * 1024 * 1024
const FETCH_TIMEOUT_MS = 5000
const MAX_REDIRECTS = 5
const SUCCESS_TTL_MS = 10 * 60_000
const FAILURE_TTL_MS = 60_000

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],       // current network / unspecified
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local and cloud metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.88.99.0', 24],   // deprecated 6to4 relay anycast
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved / broadcast
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4')
}

const blockedIpv6 = new BlockList()
for (const [network, prefix] of [
  ['::', 96],             // unspecified, loopback, IPv4-compatible
  ['::ffff:0:0', 96],     // IPv4-mapped
  ['64:ff9b::', 96],      // well-known NAT64
  ['64:ff9b:1::', 48],    // local-use NAT64
  ['100::', 64],          // discard-only
  ['2001::', 23],         // IETF protocol assignments, including Teredo
  ['2001:db8::', 32],     // documentation
  ['2002::', 16],         // 6to4 (embeds an IPv4 target)
  ['fc00::', 7],          // unique-local
  ['fe80::', 10],         // link-local
  ['fec0::', 10],         // deprecated site-local
  ['ff00::', 8],          // multicast
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6')
}

interface CacheEntry { at: number; result: MaterializeResult; bytes: number }
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0
let imageFetchOverrideForTesting: ImageFetchOverride | null = null

class BlockedImageUrlError extends Error {}

function readCache(url: string): MaterializeResult | null {
  const entry = cache.get(url)
  if (!entry) return null
  const ttl = entry.result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS
  if (Date.now() - entry.at > ttl) {
    cache.delete(url)
    cacheBytes -= entry.bytes
    return null
  }
  return entry.result
}

function writeCache(url: string, result: MaterializeResult, bytes: number): void {
  // Evict in insertion order (Map preserves it) until the new entry fits.
  // For failures bytes=0 so this is a no-op; only success entries actually
  // consume the budget.
  while (cache.size > 0 && cacheBytes + bytes > MAX_CACHE_BYTES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = cache.get(oldestKey)
    cache.delete(oldestKey)
    cacheBytes -= oldest?.bytes ?? 0
  }
  cache.set(url, { at: Date.now(), result, bytes })
  cacheBytes += bytes
}

function normalizedHostname(url: URL): string {
  // WHATWG URL keeps brackets around IPv6 literals in `hostname`; net.isIP
  // expects the raw address.
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  return hostname.toLowerCase().replace(/\.$/, '')
}

function isBlockedIp(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blockedIpv4.check(address, 'ipv4')
  if (family === 6) return blockedIpv6.check(address, 'ipv6')
  return true
}

function isReservedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname === 'home.arpa' || hostname.endsWith('.home.arpa')
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

async function resolveImageTarget(
  url: URL,
  signal: AbortSignal,
  lookup: ImageFetchDependencies['lookup'],
): Promise<ResolvedImageTarget> {
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new BlockedImageUrlError('unsupported image URL')
  }

  const hostname = normalizedHostname(url)
  if (!hostname || isReservedHostname(hostname)) {
    throw new BlockedImageUrlError('reserved image hostname')
  }

  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await abortable(lookup(hostname), signal)

  if (addresses.length === 0) throw new Error('image hostname resolved to no addresses')

  // Reject the whole answer set, rather than picking around a private answer.
  // That prevents an attacker from mixing public and private records and
  // relying on resolver/connection ordering to reach the private one.
  for (const answer of addresses) {
    if ((answer.family !== 4 && answer.family !== 6) ||
        isIP(answer.address) !== answer.family || isBlockedIp(answer.address)) {
      throw new BlockedImageUrlError('image hostname resolved to a non-public address')
    }
  }

  const selected = addresses[0]
  return { url, hostname, address: selected.address, family: selected.family }
}

function requestPinnedImage(target: ResolvedImageTarget, signal: AbortSignal): Promise<ImageHttpResponse> {
  return new Promise((resolve, reject) => {
    const options: HttpsRequestOptions = {
      protocol: target.url.protocol,
      hostname: target.address,
      family: target.family,
      port: target.url.port ? Number(target.url.port) : undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'GET',
      agent: false,
      signal,
      headers: {
        host: target.url.host,
        accept: 'image/*,*/*;q=0.1',
        'user-agent': 'CumoraImageFetcher/1.0',
      },
    }
    if (target.url.protocol === 'https:' && !isIP(target.hostname)) {
      // Keep certificate verification and SNI bound to the original public
      // hostname even though the TCP socket is pinned to a resolved address.
      options.servername = target.hostname
    }

    const onResponse = (response: import('node:http').IncomingMessage) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        cancel: () => response.destroy(),
      })
    }
    const request = target.url.protocol === 'https:'
      ? httpsRequest(options, onResponse)
      : httpRequest(options, onResponse)
    request.once('error', reject)
    request.end()
  })
}

const productionDependencies: ImageFetchDependencies = {
  lookup: async hostname => {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true })
    return answers.map(({ address, family }) => ({ address, family: family as 4 | 6 }))
  },
  request: requestPinnedImage,
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readBodyWithCap(
  response: ImageHttpResponse,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  const iterator = response.body[Symbol.asyncIterator]()
  for (;;) {
    const { done, value } = await abortable(iterator.next(), signal)
    if (done) break
    if (!value) continue
    const chunk = Buffer.from(value)
    total += chunk.byteLength
    if (total > maxBytes) {
      response.cancel()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function fetchImageBytesWithDependencies(
  rawUrl: string,
  options: RequiredImageFetchOptions,
  dependencies: ImageFetchDependencies,
): Promise<ImageBytesResult> {
  let current: URL
  try {
    current = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'blocked' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    for (let redirects = 0; ; redirects += 1) {
      const target = await resolveImageTarget(current, controller.signal, dependencies.lookup)
      const response = await abortable(dependencies.request(target, controller.signal), controller.signal)
      const location = headerValue(response.headers, 'location')

      if (isRedirect(response.status) && location) {
        response.cancel()
        if (redirects >= options.maxRedirects) return { ok: false, reason: 'blocked' }
        try {
          current = new URL(location, current)
        } catch {
          return { ok: false, reason: 'blocked' }
        }
        continue
      }

      if (response.status < 200 || response.status >= 300) {
        response.cancel()
        return { ok: false, reason: 'http', status: response.status }
      }

      const mime = (headerValue(response.headers, 'content-type') ?? '')
        .split(';')[0].trim().toLowerCase()
      if (!mime.startsWith('image/')) {
        response.cancel()
        return { ok: false, reason: 'bad-type' }
      }

      const contentLength = headerValue(response.headers, 'content-length')
      if (contentLength !== undefined) {
        const declared = Number(contentLength)
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.cancel()
          return { ok: false, reason: 'too-large' }
        }
      }

      let buffer: Buffer | null
      try {
        buffer = await readBodyWithCap(response, options.maxBytes, controller.signal)
      } catch (error) {
        response.cancel()
        throw error
      }
      if (!buffer) return { ok: false, reason: 'too-large' }
      return {
        ok: true,
        buffer,
        mime,
        bytes: buffer.byteLength,
        finalUrl: current.toString(),
      }
    }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, reason: 'timeout' }
    if (error instanceof BlockedImageUrlError) return { ok: false, reason: 'blocked' }
    return { ok: false, reason: 'error' }
  } finally {
    clearTimeout(timer)
  }
}

/** Safely download an image from a public URL. The connection is pinned to
 *  a pre-validated DNS answer and every redirect is independently checked.
 *  Never throws so callers can turn failures into their own user-facing
 *  behavior without duplicating network-policy logic. */
export async function fetchImageBytes(
  url: string,
  options: ImageFetchOptions = {},
): Promise<ImageBytesResult> {
  if (imageFetchOverrideForTesting) return await imageFetchOverrideForTesting(url, options)
  return await fetchImageBytesWithDependencies(url, {
    maxBytes: options.maxBytes ?? MAX_IMAGE_BYTES,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
  }, productionDependencies)
}

/** Integration-test hook for call sites that consume the centralized helper. */
export function __setImageFetchOverrideForTesting(override: ImageFetchOverride | null): void {
  imageFetchOverrideForTesting = override
}

/** Fetch `url`, validate it's an image we can ship, and return a base64
 *  `data:` URL on success. Never throws — callers iterate over many URLs
 *  and shouldn't have to wrap each. */
export async function materializeImage(url: string): Promise<MaterializeResult> {
  const cached = readCache(url)
  if (cached) return cached

  const fetched = await fetchImageBytes(url)
  const result: MaterializeResult = fetched.ok
    ? {
        ok: true,
        dataUrl: `data:${fetched.mime};base64,${fetched.buffer.toString('base64')}`,
        bytes: fetched.bytes,
      }
    : fetched
  const cacheBytesForEntry = result.ok ? result.dataUrl.length : 0
  writeCache(url, result, cacheBytesForEntry)
  return result
}

/** Test hook for deterministic DNS and network regression cases. */
export async function _fetchImageBytesForTest(
  url: string,
  options: ImageFetchOptions,
  dependencies: ImageFetchDependencies,
): Promise<ImageBytesResult> {
  return await fetchImageBytesWithDependencies(url, {
    maxBytes: options.maxBytes ?? MAX_IMAGE_BYTES,
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
  }, dependencies)
}

/** Test hook — clear the cache between runs so failure cases don't leak
 *  across test cases. Not used in production. */
export function _resetMaterializeCacheForTest(): void {
  cache.clear()
  cacheBytes = 0
}
