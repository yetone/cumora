/**
 * Cumora R2 gate — Cloudflare Worker that fronts `cdn.cumora.ai` and
 * gates access to the `cumora-attachments` bucket.
 *
 * Access model:
 *   - GET /avatars/<key>           → unsigned, public. Portraits aren't
 *                                    sensitive and benefit from full CDN
 *                                    caching.
 *   - GET /attachments/<key>       → must carry `?exp=<unix>&sig=<hex>`;
 *   - GET /email-attachments/<key> → uses the same signed query contract.
 *                                    `sig` = HMAC-SHA256(secret,
 *                                    `<key>:<exp>`). Both `exp` (not in
 *                                    the past) and `sig` (constant-time
 *                                    equal) are checked before reading R2.
 *   - HEAD                         → same auth as GET; useful for size
 *                                    probes from clients.
 *   - everything else              → 405.
 *
 * Secret rotation: rotate `R2_URL_SIGNING_SECRET` on both the Cumora
 * server and `wrangler secret put` here in lockstep. URLs already signed
 * with the old secret stop working at rotation time — fine, every read
 * path re-signs from the stored `attachment.key`.
 */
export interface Env {
  BUCKET: R2Bucket
  R2_URL_SIGNING_SECRET: string
}

/** Prefixes that demand a valid `?exp&sig` pair. Anything outside this
 *  list is treated as publicly cacheable. */
const SIGNED_PREFIXES = ['attachments/', 'email-attachments/']

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }
    const url = new URL(req.url)
    const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!key) return new Response('not found', { status: 404 })

    const needsSig = SIGNED_PREFIXES.some((p) => key.startsWith(p))
    if (needsSig) {
      const gate = await verifySignature(key, url.searchParams, env.R2_URL_SIGNING_SECRET)
      if (!gate.ok) return new Response(gate.reason, { status: 403 })
    }

    // Honor If-None-Match for cache revalidation. R2's get() accepts the
    // condition; a HEAD goes through head() with no body. Both shapes
    // expose the same metadata surface that we copy onto the response.
    const ifNoneMatch = req.headers.get('if-none-match') ?? undefined
    const obj: R2Object | R2ObjectBody | null = req.method === 'HEAD'
      ? await env.BUCKET.head(key)
      : await env.BUCKET.get(key, ifNoneMatch ? { onlyIf: { etagDoesNotMatch: ifNoneMatch } } : undefined)

    if (!obj) return new Response('not found', { status: 404 })

    const headers = new Headers()
    const meta = obj.httpMetadata
    if (meta?.contentType) headers.set('content-type', meta.contentType)
    if (meta?.contentLanguage) headers.set('content-language', meta.contentLanguage)
    if (meta?.contentDisposition) headers.set('content-disposition', meta.contentDisposition)
    if (meta?.contentEncoding) headers.set('content-encoding', meta.contentEncoding)
    headers.set('etag', obj.httpEtag)
    // Signed objects: short cache so a revoked attachment doesn't linger
    // at the edge for hours. Public objects: long cache, immutable.
    headers.set(
      'cache-control',
      needsSig ? 'private, max-age=300' : 'public, max-age=86400, immutable',
    )

    // The GET path can produce an `R2ObjectBody` (full read) or just an
    // `R2Object` (conditional miss → 304). HEAD always produces an
    // `R2Object`. Body is only present on the full-GET branch.
    const body: ReadableStream | null = 'body' in obj ? (obj as R2ObjectBody).body : null
    const status = req.method === 'GET' && ifNoneMatch && !body ? 304 : 200
    return new Response(req.method === 'HEAD' ? null : body, { status, headers })
  },
}

interface GateResult { ok: true } interface GateFail { ok: false; reason: string }
async function verifySignature(
  key: string,
  q: URLSearchParams,
  secret: string,
): Promise<GateResult | GateFail> {
  if (!secret) return { ok: false, reason: 'gate not configured' }
  const exp = q.get('exp')
  const sig = q.get('sig')
  if (!exp || !sig) return { ok: false, reason: 'missing exp/sig' }
  const expNum = Number(exp)
  if (!Number.isFinite(expNum)) return { ok: false, reason: 'bad exp' }
  const now = Math.floor(Date.now() / 1000)
  if (expNum < now) return { ok: false, reason: 'expired' }
  // 24h ceiling — refuse far-future signatures so a leaked URL can't
  // become a permanent backdoor by setting a giant exp.
  if (expNum - now > 86400) return { ok: false, reason: 'exp too far' }
  const expected = await hmacHex(secret, `${key}:${exp}`)
  if (!timingSafeEq(expected, sig)) return { ok: false, reason: 'bad sig' }
  return { ok: true }
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder()
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** Length-aware constant-time hex compare. Worker runtime has no
 *  `timingSafeEqual`, so we roll our own — short circuit only on length
 *  mismatch (which is observable anyway via the URL shape). */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
