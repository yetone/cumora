import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'

process.env.NODE_ENV = 'test'
process.env.OPENAI_API_KEY ??= 'test-key'
process.env.AGENT_RUNTIME_SECRET = 'test-agent-runtime-secret-with-enough-entropy'

const { env } = await import('../env.js')
const { signAgentToken, verifyAgentToken } = await import('../agents/runtime/jwt.js')

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signRawClaims(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const signature = createHmac('sha256', env.AGENT_RUNTIME_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

test('runtime JWT round-trips the exact placement identity', () => {
  const token = signAgentToken({
    agentId: 'agent-1',
    companyId: 'company-1',
    computerId: 'computer-1',
    assignmentId: 'assignment-1',
  })
  const claims = verifyAgentToken(token)
  assert.deepEqual(
    {
      sub: claims.sub,
      companyId: claims.companyId,
      computerId: claims.computerId,
      assignmentId: claims.assignmentId,
      scope: claims.scope,
    },
    {
      sub: 'agent-1',
      companyId: 'company-1',
      computerId: 'computer-1',
      assignmentId: 'assignment-1',
      scope: 'agent-runner',
    },
  )
})

test('runtime JWTs minted before placement binding fail closed', () => {
  const now = Math.floor(Date.now() / 1000)
  const legacy = signRawClaims({
    sub: 'agent-1',
    companyId: 'company-1',
    scope: 'agent-runner',
    iat: now,
    exp: now + 3600,
  })
  assert.throws(() => verifyAgentToken(legacy), /computerId|assignmentId/)
})
