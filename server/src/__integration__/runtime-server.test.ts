/**
 * Integration test: the `/runtime/*` HTTP surface that agent-runner pods
 * talk to (server/src/agents/runtime/server.ts).
 *
 * The unit tests in __tests__ cover the argv-strip helper and the JWT
 * sign/verify in isolation; this file glues them together with a real
 * Express mount + real Postgres so we can assert the *security-critical*
 * end-to-end behaviour:
 *
 *  - Auth gate: missing / wrong-scheme / bad-sig / expired tokens are
 *    rejected with 401 BEFORE any handler logic runs.
 *  - Identity pin: when a request body claims `agentId: <spoof>` while
 *    the JWT pins someone else, the row that lands in Postgres uses the
 *    JWT subject, not the body claim.
 *  - Conversation scope: context reads return only conversations in the
 *    JWT-pinned agent's tenant where that agent is a current member.
 *  - Payload validation: 400s for missing required fields, without ever
 *    touching the DB.
 *
 * The full /cli endpoint (which actually spawns runCli) is intentionally
 * not exercised here — booting the CLI requires the whole agent stack.
 * Its security-critical bit (argv strip + JWT-sub injection) lives in
 * agents-runtime-cli-argv.test.ts as a unit test.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { mintAgentRuntimeToken } from '../agents/computer/registry.js'
import { signAgentToken, verifyAgentToken } from '../agents/runtime/jwt.js'
import { pool } from '../db/pool.js'

let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  // Mount the runtime router on a minimal Express app. We can't use the
  // real index.ts entrypoint because it boots schedulers + cron + redis
  // subscribers we don't want in this test process.
  const expressMod = await import('express')
  const express = expressMod.default
  const { runtimeRouter } = await import('../agents/runtime/server.js')
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/runtime', runtimeRouter)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll(server)
})

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let parsed: any = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: res.status, body: parsed }
}

async function seedAgent(): Promise<{ agentId: string; companyId: string; token: string }> {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const agentId = `a-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [companyId, `Co ${companyId}`, companyId, 'test-owner'],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail')`,
    [agentId, companyId, agentId, agentId.slice(0, 1).toUpperCase()],
  )
  const token = signAgentToken({ agentId, companyId })
  return { agentId, companyId, token }
}

async function mintAssignedAgentRuntimeToken(args: {
  agentId: string
  companyId: string
}): Promise<string> {
  const computerId = `comp-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind, available_engines, status)
       VALUES ($1, $2, $3, 'local', '["codex"]'::jsonb, 'online')`,
    [computerId, args.companyId, `Computer ${computerId}`],
  )
  await pool.query(
    `UPDATE participants SET computer_id = $1, engine = 'codex'
      WHERE id = $2 AND company_id = $3`,
    [computerId, args.agentId, args.companyId],
  )
  const minted = await mintAgentRuntimeToken({ computerId, agentId: args.agentId })
  assert.ok(minted, 'the production BYOA path should mint a token for an assigned agent')
  return minted.token
}

async function seedContextConversation(opts: {
  companyId: string
  members: string[]
  authorId: string
  body: string
}): Promise<string> {
  const conversationId = `cv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
       VALUES ($1, 'group', $2, $3::jsonb, $4)`,
    [conversationId, `Context ${conversationId}`, JSON.stringify(opts.members), opts.companyId],
  )
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, 1, $5)`,
    [`m-${randomUUID()}`, conversationId, opts.authorId, opts.body, opts.companyId],
  )
  return conversationId
}

// ── auth gate ──────────────────────────────────────────────────────────

test('[integration] runtime: missing Authorization → 401', async () => {
  const r = await call('/runtime/inbox', { method: 'GET' })
  assert.equal(r.status, 401)
  assert.match(String(r.body?.error ?? ''), /bearer/i)
})

test('[integration] runtime: wrong scheme (Basic instead of Bearer) → 401', async () => {
  const r = await call('/runtime/inbox', {
    method: 'GET',
    headers: { authorization: 'Basic dXNlcjpwYXNz' },
  })
  assert.equal(r.status, 401)
})

test('[integration] runtime: bad signature → 401', async () => {
  // Mint a valid token, then tamper with the signature segment.
  const { token } = await seedAgent()
  const tampered = token.replace(/\.[^.]*$/, '.AAAA')
  const r = await call('/runtime/inbox', { method: 'GET', token: tampered })
  assert.equal(r.status, 401)
  assert.match(String(r.body?.error ?? ''), /signature|malformed/i)
})

test('[integration] runtime: malformed token (not three segments) → 401', async () => {
  const r = await call('/runtime/inbox', { method: 'GET', token: 'not-a-jwt' })
  assert.equal(r.status, 401)
  assert.match(String(r.body?.error ?? ''), /malformed/i)
})

test('[integration] runtime: expired token → 401', async () => {
  const { agentId, companyId } = await seedAgent()
  // ttlSeconds = -1 → exp = now - 1s, definitely expired.
  const tok = signAgentToken({ agentId, companyId, ttlSeconds: -1 })
  const r = await call('/runtime/inbox', { method: 'GET', token: tok })
  assert.equal(r.status, 401)
  assert.match(String(r.body?.error ?? ''), /expired/i)
})

test('[integration] runtime: /context requires a tenant-pinned token', async () => {
  const { agentId } = await seedAgent()
  const token = signAgentToken({ agentId, companyId: null })
  const r = await call('/runtime/context', { token, body: { conversationIds: [] } })
  assert.equal(r.status, 403)
  assert.match(String(r.body?.error ?? ''), /companyId claim required/i)
})

test('[integration] runtime: /context enforces tenant and conversation membership', async () => {
  const { agentId, companyId, token } = await seedAgent()
  const peerId = `a-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', 'P', '#abcdef', 'avail')`,
    [peerId, companyId, peerId],
  )

  const allowedId = await seedContextConversation({
    companyId,
    members: [agentId, peerId],
    authorId: peerId,
    body: 'member-visible',
  })
  const nonMemberId = await seedContextConversation({
    companyId,
    members: [peerId],
    authorId: peerId,
    body: 'same-tenant-private',
  })
  const otherTenant = await seedAgent()
  const crossTenantId = await seedContextConversation({
    companyId: otherTenant.companyId,
    // Even a forged members array cannot override the JWT tenant boundary.
    members: [agentId, otherTenant.agentId],
    authorId: otherTenant.agentId,
    body: 'cross-tenant-private',
  })

  const r = await call('/runtime/context', {
    token,
    body: { conversationIds: [allowedId, nonMemberId, crossTenantId] },
  })

  assert.equal(r.status, 200)
  assert.deepEqual(
    (r.body?.rows ?? []).map((row: { conversation_id: string; company_id: string; body: string }) => ({
      conversationId: row.conversation_id,
      companyId: row.company_id,
      body: row.body,
    })),
    [{ conversationId: allowedId, companyId, body: 'member-visible' }],
  )
})

test('[integration] runtime: /context rejects a stale production token after tenant reassignment', async () => {
  const originalTenant = await seedAgent()
  const currentTenant = await seedAgent()
  const staleToken = await mintAssignedAgentRuntimeToken(originalTenant)

  // Model a real stale-credential lifecycle without fabricating JWT claims:
  // the BYOA path minted the token while the agent belonged to tenant A, then
  // an administrative data migration moved that globally-unique agent id to
  // tenant B. The old token remains cryptographically valid until it expires.
  const moved = await pool.query(
    `UPDATE participants
        SET company_id = $1, computer_id = NULL, engine = NULL
      WHERE id = $2 AND company_id = $3`,
    [currentTenant.companyId, originalTenant.agentId, originalTenant.companyId],
  )
  assert.equal(moved.rowCount, 1)
  const staleClaims = verifyAgentToken(staleToken)
  assert.equal(staleClaims.sub, originalTenant.agentId)
  assert.equal(staleClaims.companyId, originalTenant.companyId)

  const crossTenantId = await seedContextConversation({
    companyId: currentTenant.companyId,
    members: [originalTenant.agentId, currentTenant.agentId],
    authorId: currentTenant.agentId,
    body: 'post-move-private',
  })

  const { rows: currentAgentRows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM participants WHERE id = $1 AND kind = 'agent'`,
    [originalTenant.agentId],
  )
  assert.deepEqual(currentAgentRows, [{ company_id: currentTenant.companyId }])

  // The pre-fix query joined the requesting agent to the conversation's
  // company instead of the JWT company. It therefore accepted this current
  // tenant-B membership even though the still-valid token is pinned to A.
  const r = await call('/runtime/context', {
    token: staleToken,
    body: { conversationIds: [crossTenantId] },
  })

  assert.equal(r.status, 200)
  assert.deepEqual(r.body?.rows ?? [], [])
})

test('[integration] runtime: /faces requires a tenant-pinned token', async () => {
  const { agentId } = await seedAgent()
  const token = signAgentToken({ agentId, companyId: null })
  const r = await call('/runtime/faces', { token, body: { participantIds: [agentId] } })
  assert.equal(r.status, 403)
  assert.match(String(r.body?.error ?? ''), /companyId claim required/i)
})

test('[integration] runtime: /faces returns participants only from the JWT tenant', async () => {
  const caller = await seedAgent()
  const otherTenant = await seedAgent()
  await pool.query(
    `UPDATE participants SET avatar_url = CASE id
       WHEN $1 THEN 'https://cdn.example.test/caller.png'
       WHEN $2 THEN 'https://cdn.example.test/other.png'
     END
     WHERE id = ANY($3::text[])`,
    [caller.agentId, otherTenant.agentId, [caller.agentId, otherTenant.agentId]],
  )

  const r = await call('/runtime/faces', {
    token: caller.token,
    body: { participantIds: [caller.agentId, otherTenant.agentId] },
  })

  assert.equal(r.status, 200)
  assert.deepEqual(
    (r.body?.rows ?? []).map((row: { id: string; name: string; role: string | null; avatar_url: string | null }) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      avatarUrl: row.avatar_url,
    })),
    [{
      id: caller.agentId,
      name: caller.agentId,
      role: 'tester',
      avatarUrl: 'https://cdn.example.test/caller.png',
    }],
  )
})

// ── identity pin: agentId comes from JWT, not request body ────────────

test('[integration] runtime: /runs records the JWT subject, not whatever the body claims', async () => {
  const { agentId, companyId, token } = await seedAgent()
  // Try to spoof: body claims a different agentId. The endpoint shape
  // doesn't actually read agentId from body (the server takes it from
  // c.sub), but we send the spoof anyway to catch any regression that
  // adds a body.agentId read.
  const r = await call('/runtime/runs', {
    token,
    body: { trigger: { kind: 'test' }, inboxCount: 0, agentId: 'someone-else' },
  })
  assert.equal(r.status, 200)
  const runId = String(r.body?.runId ?? '')
  assert.ok(runId.length > 0, 'runId returned')
  const { rows } = await pool.query<{ agent_id: string; company_id: string }>(
    `SELECT agent_id, company_id FROM agent_runs WHERE id = $1`,
    [runId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].agent_id, agentId, 'JWT subject pins agent_id')
  assert.equal(rows[0].company_id, companyId, 'JWT companyId pins company_id')
})

test('[integration] runtime: /events row uses JWT subject for agent_id', async () => {
  const { agentId, companyId, token } = await seedAgent()
  // First create a run to attach an event to (events.run_id FK → agent_runs.id).
  const runRes = await call('/runtime/runs', {
    token, body: { trigger: { kind: 'test' }, inboxCount: 0 },
  })
  const runId = String(runRes.body.runId)
  const r = await call('/runtime/events', {
    token,
    body: {
      runId,
      kind: 'test.event',
      title: 'pinning check',
      data: { hi: 1 },
      // Body claims someone else's id — must be ignored.
      agentId: 'someone-else',
      companyId: 'wrong-co',
    },
  })
  assert.equal(r.status, 200)
  const { rows } = await pool.query<{ agent_id: string; company_id: string; kind: string }>(
    `SELECT agent_id, company_id, kind FROM agent_events WHERE run_id = $1 AND kind = 'test.event'`,
    [runId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].agent_id, agentId)
  assert.equal(rows[0].company_id, companyId)
})

// ── payload validation ────────────────────────────────────────────────

test('[integration] runtime: /events 400 when runId / kind / title is missing', async () => {
  const { token } = await seedAgent()
  const r = await call('/runtime/events', { token, body: { kind: 'x', title: 'y' } })
  assert.equal(r.status, 400)
  assert.match(String(r.body?.error ?? ''), /runId|kind|title/i)
})

test('[integration] runtime: /status 400 when status field missing', async () => {
  const { token } = await seedAgent()
  const r = await call('/runtime/status', { token, body: {} })
  assert.equal(r.status, 400)
})

test('[integration] runtime: /typing 400 when conversationId missing', async () => {
  const { token } = await seedAgent()
  const r = await call('/runtime/typing', { token, body: { done: false } })
  assert.equal(r.status, 400)
})

test('[integration] runtime: /runs/:runId/finish 400 when status missing', async () => {
  const { token } = await seedAgent()
  const r = await call('/runtime/runs/some-run/finish', { token, body: {} })
  assert.equal(r.status, 400)
})

test('[integration] runtime: /notices 400 when any of the required fields missing', async () => {
  const { token } = await seedAgent()
  const r = await call('/runtime/notices', { token, body: { conversationId: 'c-1' } })
  assert.equal(r.status, 400)
  assert.match(String(r.body?.error ?? ''), /required/i)
})

// ── happy-path smokes (round-trips through inproc-client into PG) ─────

test('[integration] runtime: /runs + /runs/:runId/finish persists status transition', async () => {
  const { agentId, token } = await seedAgent()
  const created = await call('/runtime/runs', { token, body: { trigger: { kind: 't' }, inboxCount: 0 } })
  assert.equal(created.status, 200)
  const runId = String(created.body.runId)

  const done = await call(`/runtime/runs/${runId}/finish`, {
    token, body: { status: 'completed', summary: 'ok', toolCallCount: 3, tokenCount: 1234 },
  })
  assert.equal(done.status, 200)

  const { rows } = await pool.query<{ status: string; summary: string; tool_call_count: number; token_count: number; agent_id: string }>(
    `SELECT status, summary, tool_call_count, token_count, agent_id FROM agent_runs WHERE id = $1`,
    [runId],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].summary, 'ok')
  assert.equal(rows[0].tool_call_count, 3)
  assert.equal(rows[0].token_count, 1234)
  assert.equal(rows[0].agent_id, agentId)
})
