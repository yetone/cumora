/**
 * Minimal HS256 JWT for runtime-pod ↔ server auth.
 *
 * Server signs one token per runtime with `{ sub: agentId, companyId,
 * computerId, assignmentId, scope: 'agent-runner', iat, exp }`. The runtime
 * presents it on every `/runtime/*` request. Server verifies sig + exp + scope
 * and pins both identity and live placement — endpoints never trust an agentId
 * or Computer from the request body.
 *
 * Why homegrown instead of `jose`: the surface area is small (sign +
 * verify, fixed alg, fixed claim shape), the secret never leaves the
 * server, and avoiding the dep keeps the agent-loop bundle smaller
 * (HttpRuntimeClient only needs the token string, not the lib).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../env.js'

export interface AgentRuntimeClaims {
  /** agent participant id — pinned at sign time, immutable for the token's life. */
  sub: string
  /** company id the agent belongs to. Pinned so requests can't cross tenants. */
  companyId: string | null
  /** Exact assigned Computer. Null represents an explicitly unassigned Agent. */
  computerId: string | null
  /** Opaque generation rotated by PostgreSQL on every authority-bearing move. */
  assignmentId: string
  /** Fixed string; lets the server reject tokens minted for other purposes. */
  scope: 'agent-runner'
  /** issued-at, unix seconds. */
  iat: number
  /** expiry, unix seconds. Pod lifetimes are short — default 1h. */
  exp: number
}

const DEFAULT_TTL_SECONDS = 60 * 60

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function sign(headerB64: string, payloadB64: string): string {
  const mac = createHmac('sha256', env.AGENT_RUNTIME_SECRET)
  mac.update(`${headerB64}.${payloadB64}`)
  return b64url(mac.digest())
}

/** Mint a token for a freshly-spawned agent pod. */
export function signAgentToken(args: {
  agentId: string
  companyId: string | null
  computerId: string | null
  assignmentId: string
  ttlSeconds?: number
}): string {
  const now = Math.floor(Date.now() / 1000)
  const claims: AgentRuntimeClaims = {
    sub: args.agentId,
    companyId: args.companyId,
    computerId: args.computerId,
    assignmentId: args.assignmentId,
    scope: 'agent-runner',
    iat: now,
    exp: now + (args.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  }
  const headerB64 = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims)))
  const sigB64 = sign(headerB64, payloadB64)
  return `${headerB64}.${payloadB64}.${sigB64}`
}

/** Verify + decode. Throws on any tampering, expiry, or scope mismatch. */
export function verifyAgentToken(token: string): AgentRuntimeClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [headerB64, payloadB64, sigB64] = parts
  const expected = sign(headerB64, payloadB64)
  const a = Buffer.from(sigB64)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature')
  const claims = JSON.parse(fromB64url(payloadB64).toString('utf8')) as AgentRuntimeClaims
  if (claims.scope !== 'agent-runner') throw new Error('bad scope')
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token expired')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('missing sub')
  if (claims.companyId !== null && (typeof claims.companyId !== 'string' || !claims.companyId)) {
    throw new Error('invalid companyId')
  }
  if (claims.computerId !== null && (typeof claims.computerId !== 'string' || !claims.computerId)) {
    throw new Error('invalid computerId')
  }
  if (typeof claims.assignmentId !== 'string' || !claims.assignmentId) {
    throw new Error('missing assignmentId')
  }
  return claims
}
