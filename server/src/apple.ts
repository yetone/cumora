/**
 * Sign in with Apple — server-side verification of the identity_token
 * JWT that iOS hands the client after a successful native SIWA flow.
 *
 * Unlike Google/GitHub OAuth2 (code-exchange → REST userinfo), Apple
 * gives the client an OIDC `identity_token` directly. The server's
 * job is to verify the signature against Apple's published JWKS and
 * extract the user's stable `sub` + (optionally) email. There is no
 * client-secret or code exchange to do on the iOS-native path.
 *
 * What the verified claims tell us:
 *   - `iss` is `https://appleid.apple.com` (we check this)
 *   - `aud` is the iOS app's bundle id (we check this — must match
 *      `io.cumora.app`)
 *   - `sub` is a STABLE per-(user, team) opaque identifier — same on
 *      every sign-in for the lifetime of the Apple ID's relationship
 *      with our app. This is what we link `user_identities` rows to.
 *   - `email` may be a real address OR Apple's relay
 *      `…@privaterelay.appleid.com`. Either way it's verified.
 *   - `email_verified` is always `"true"` (a string in JWT) on
 *      successful native flows.
 *
 * Apple's standalone credential/user metadata is only returned on the first
 * authorization, but the signed identity token normally keeps carrying the
 * email claim on later authorizations. Managed school accounts may have an
 * empty email claim, so returning users still resolve by their persisted
 * `sub` linkage rather than depending on email being present every time.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto'

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_ISSUER = 'https://appleid.apple.com'

interface AppleJwk {
  kty: 'RSA'
  kid: string
  use: 'sig'
  alg: 'RS256'
  n: string  // base64url-encoded modulus
  e: string  // base64url-encoded exponent
}

interface JwksCache {
  fetchedAt: number
  keys: Map<string, AppleJwk>
}
const JWKS_TTL_MS = 24 * 60 * 60 * 1000  // 24h — keys rotate quarterly
let jwksCache: JwksCache | null = null

async function fetchJwks(): Promise<Map<string, AppleJwk>> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys
  }
  const r = await fetch(APPLE_JWKS_URL)
  if (!r.ok) throw new Error(`apple JWKS fetch ${r.status}`)
  const body = await r.json() as { keys: AppleJwk[] }
  const map = new Map<string, AppleJwk>()
  for (const k of body.keys) map.set(k.kid, k)
  jwksCache = { fetchedAt: Date.now(), keys: map }
  return map
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/** Build a Node `KeyObject` from a JWK so we can hand it to
 *  `crypto.createVerify`. Node's JWK importer wants the modulus and
 *  exponent re-wrapped in a JWK object — Apple's JWKS is already in
 *  the right shape, we just have to pass it through. */
function jwkToPublicKey(jwk: AppleJwk) {
  return createPublicKey({ key: jwk as unknown as JsonWebKey, format: 'jwk' })
}

export interface AppleClaims {
  sub: string
  email: string | null
  emailVerified: boolean
  /** True when Apple's `is_private_email` claim is set — the email
   *  is a relay (`xxx@privaterelay.appleid.com`), not the user's
   *  real address. We accept it either way. */
  isPrivateEmail: boolean
  /** Audience the token was minted for. Always our bundle id on the
   *  native iOS path. Verified before this object is returned. */
  aud: string
}

/** Select the only email values that are safe to use for account lookup.
 *
 * A linked Apple `sub` is already the account identity, so its persisted
 * email wins even if a later token contains a different value. For an
 * unlinked `sub`, only an email attested by the signed Apple token may create
 * or cross-link an account. Client callback fields are deliberately absent
 * from this boundary: native credential metadata is display data, not proof
 * of email ownership. */
export function resolveTrustedAppleEmail(input: {
  linkedEmail: string | null
  tokenEmail: string | null
  tokenEmailVerified: boolean
}): string {
  const linkedEmail = (input.linkedEmail ?? '').toLowerCase().trim()
  if (linkedEmail) return linkedEmail

  const tokenEmail = (input.tokenEmail ?? '').toLowerCase().trim()
  if (!tokenEmail || !input.tokenEmailVerified) {
    throw new Error('apple sign-in: verified email not available for unlinked identity')
  }
  return tokenEmail
}

/** Verify an Apple identity_token. Throws on any tamper / expiry /
 *  wrong-audience / wrong-issuer / unknown-signing-key. Returns the
 *  trusted claims if everything checks out. */
export async function verifyAppleIdentityToken(token: string, expectedAud: string[]): Promise<AppleClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed apple identity_token')
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string]
  let header: { alg?: string; kid?: string }
  try { header = JSON.parse(fromB64url(headerB64).toString('utf8')) }
  catch { throw new Error('malformed apple identity_token header') }
  if (header.alg !== 'RS256') throw new Error(`apple alg ${header.alg ?? 'missing'} not supported`)
  if (!header.kid) throw new Error('apple identity_token missing kid')

  // Resolve signing key. If unknown, refresh JWKS once (Apple rotates
  // keys quarterly; cached map may be stale for a freshly-rotated key).
  let jwks = await fetchJwks()
  let jwk = jwks.get(header.kid)
  if (!jwk) {
    jwksCache = null
    jwks = await fetchJwks()
    jwk = jwks.get(header.kid)
  }
  if (!jwk) throw new Error(`apple identity_token signed with unknown key kid=${header.kid}`)

  // RS256 verify. The signed input is the dot-joined header.payload.
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${headerB64}.${payloadB64}`)
  verifier.end()
  const ok = verifier.verify(jwkToPublicKey(jwk), fromB64url(sigB64))
  if (!ok) throw new Error('apple identity_token bad signature')

  // Claim checks.
  interface RawClaims {
    iss?: string; aud?: string; sub?: string; iat?: number; exp?: number
    email?: string; email_verified?: string | boolean
    is_private_email?: string | boolean
  }
  let claims: RawClaims
  try { claims = JSON.parse(fromB64url(payloadB64).toString('utf8')) as RawClaims }
  catch { throw new Error('malformed apple identity_token payload') }

  if (claims.iss !== APPLE_ISSUER) throw new Error(`apple iss=${claims.iss} expected ${APPLE_ISSUER}`)
  if (!claims.sub) throw new Error('apple identity_token missing sub')
  if (!claims.aud || !expectedAud.includes(claims.aud)) {
    throw new Error(`apple aud=${claims.aud} not in [${expectedAud.join(',')}]`)
  }
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('apple identity_token expired')

  // Apple sends email_verified / is_private_email as the STRING "true",
  // not a boolean. Normalize.
  const truthy = (v: string | boolean | undefined): boolean =>
    v === true || v === 'true'

  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' && claims.email ? claims.email.toLowerCase() : null,
    emailVerified: truthy(claims.email_verified),
    isPrivateEmail: truthy(claims.is_private_email),
    aud: claims.aud,
  }
}
