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
 * The full /cli endpoint is covered for security-critical boundaries that
 * require the real HTTP/JWT/runCli chain. Lower-level argv normalization
 * remains exhaustively covered in agents-runtime-cli-argv.test.ts.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { mintAgentRuntimeToken, revokeComputer } from '../agents/computer/registry.js'
import { signAgentToken, verifyAgentToken } from '../agents/runtime/jwt.js'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

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

async function callRaw(
  path: string,
  opts: { method?: string; token?: string; body: string },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body,
  })
  return { status: res.status, body: await res.text() }
}

/** The runtime endpoint now awaits one atomic batch. Still drain the pool in
 *  zero-write checks so a future regression to the generic fire-and-forget
 *  recorder cannot pass merely because its INSERT lands after the assertion. */
async function waitForPoolIdle(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let stablePasses = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    if (pool.waitingCount === 0 && pool.idleCount === pool.totalCount) {
      stablePasses += 1
      if (stablePasses >= 3) return
    } else {
      stablePasses = 0
    }
  }
  assert.fail('timed out waiting for queued ledger queries to drain')
}

async function waitForBlockedQuery(pattern: string, minimum = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1`,
      [pattern],
    )
    if ((rows[0]?.count ?? 0) >= minimum) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`query never reached the expected row lock: ${pattern}`)
}

async function signCurrentRuntimeToken(args: {
  agentId: string
  sourceCompanyId: string
  claimCompanyId?: string | null
  ttlSeconds?: number
}): Promise<string> {
  const { rows } = await pool.query<{
    computer_id: string | null
    runtime_assignment_id: string
  }>(
    `SELECT computer_id, runtime_assignment_id
       FROM participants
      WHERE id = $1 AND company_id = $2 AND kind = 'agent'`,
    [args.agentId, args.sourceCompanyId],
  )
  assert.ok(rows[0], 'runtime token fixture requires a live Agent placement')
  return signAgentToken({
    agentId: args.agentId,
    companyId: args.claimCompanyId === undefined ? args.sourceCompanyId : args.claimCompanyId,
    computerId: rows[0].computer_id,
    assignmentId: rows[0].runtime_assignment_id,
    ttlSeconds: args.ttlSeconds,
  })
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
  const token = await signCurrentRuntimeToken({ agentId, sourceCompanyId: companyId })
  return { agentId, companyId, token }
}

async function seedPeerAgent(companyId: string): Promise<{ agentId: string; companyId: string; token: string }> {
  const agentId = `a-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail')`,
    [agentId, companyId, agentId, agentId.slice(0, 1).toUpperCase()],
  )
  return {
    agentId,
    companyId,
    token: await signCurrentRuntimeToken({ agentId, sourceCompanyId: companyId }),
  }
}

async function assertCannotMutateForeignRun(args: {
  ownerToken: string
  attackerToken: string
}): Promise<string> {
  const created = await call('/runtime/runs', {
    token: args.ownerToken,
    body: { trigger: { kind: 'ownership-test' }, inboxCount: 0 },
  })
  assert.equal(created.status, 200)
  assert.equal(typeof created.body?.runId, 'string')
  const runId = created.body.runId as string
  assert.match(runId, /^run-/)
  await pool.query(
    `UPDATE agent_runs SET updated_at = '2000-01-01T00:00:00Z'::timestamptz WHERE id = $1`,
    [runId],
  )

  const snapshot = async () => {
    const { rows } = await pool.query(
      `SELECT status, stage, summary, error, tool_call_count, token_count,
              updated_at::text, finished_at::text
         FROM agent_runs WHERE id = $1`,
      [runId],
    )
    return rows[0]
  }
  const before = await snapshot()
  assert.ok(before, 'owner run fixture must exist before the attack')

  const attempts = [
    await call('/runtime/events', {
      token: args.attackerToken,
      body: {
        runId,
        kind: 'forged.event',
        title: 'must not land',
        stage: 'forged',
      },
    }),
    await call(`/runtime/runs/${runId}/heartbeat`, {
      token: args.attackerToken,
      body: {},
    }),
    await call(`/runtime/runs/${runId}/finish`, {
      token: args.attackerToken,
      body: { status: 'failed', summary: 'forged finish', tokenCount: 999 },
    }),
    await call('/runtime/llm-calls', {
      token: args.attackerToken,
      body: {
        source: 'byoa-codex',
        hops: [{ runId, model: 'forged-model', latencyMs: 1, status: 'ok' }],
      },
    }),
  ]
  for (const attempt of attempts) {
    assert.equal(attempt.status, 404)
    assert.match(String(attempt.body?.error ?? ''), /agent run not found/i)
  }

  await waitForPoolIdle()
  assert.deepEqual(await snapshot(), before, 'foreign requests must not alter the run row')
  const [{ rows: eventRows }, { rows: ledgerRows }] = await Promise.all([
    pool.query(`SELECT id FROM agent_events WHERE run_id = $1`, [runId]),
    pool.query(`SELECT id FROM llm_calls WHERE run_id = $1`, [runId]),
  ])
  assert.equal(eventRows.length, 0, 'foreign event must not be inserted')
  assert.equal(ledgerRows.length, 0, 'foreign run must not be attached to an LLM ledger row')
  return runId
}

async function mintAssignedAgentRuntimeToken(args: {
  agentId: string
  companyId: string
}): Promise<{ token: string; computerId: string }> {
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
  return { token: minted.token, computerId }
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

test('[integration] runtime: authentication rejects malformed multi-megabyte JSON before parsing', async () => {
  const r = await callRaw('/runtime/status', {
    body: `{${'x'.repeat(5 * 1024 * 1024)}`,
  })
  assert.equal(r.status, 401)
  assert.match(r.body, /missing bearer token/i)
})

test('[integration] runtime: authenticated JSON remains bounded to 4MB', async () => {
  const { token } = await seedAgent()
  const r = await callRaw('/runtime/status', {
    token,
    body: JSON.stringify({ status: 'avail', padding: 'x'.repeat(4 * 1024 * 1024) }),
  })
  assert.equal(r.status, 413)
  assert.deepEqual(JSON.parse(r.body), { error: 'request entity too large' })
})

test('[integration] runtime: FUSE whole-file writes authenticate before their large parser', async () => {
  const r = await callRaw('/runtime/fs/write', {
    method: 'PUT',
    body: `{${'x'.repeat(5 * 1024 * 1024)}`,
  })
  assert.equal(r.status, 401)
  assert.match(r.body, /missing bearer token/i)
})

test('[integration] runtime: FUSE preserves authenticated whole-file writes above 4MB', async () => {
  const { agentId, companyId, token } = await seedAgent()
  const fileBody = 'x'.repeat(5 * 1024 * 1024)
  const r = await call('/runtime/fs/write', {
    method: 'PUT',
    token,
    body: { path: 'large-workspace-file.txt', body: fileBody },
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  const { rows } = await pool.query<{ bytes: number; company_id: string }>(
    `SELECT OCTET_LENGTH(body)::int AS bytes, company_id
       FROM agent_workspace
      WHERE agent_id = $1 AND path = 'large-workspace-file.txt'`,
    [agentId],
  )
  assert.equal(rows[0]?.bytes, Buffer.byteLength(fileBody))
  assert.equal(rows[0]?.company_id, companyId)
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
  const tok = await signCurrentRuntimeToken({
    agentId,
    sourceCompanyId: companyId,
    ttlSeconds: -1,
  })
  const r = await call('/runtime/inbox', { method: 'GET', token: tok })
  assert.equal(r.status, 401)
  assert.match(String(r.body?.error ?? ''), /expired/i)
})

test('[integration] runtime: /context requires a tenant-pinned token', async () => {
  const { agentId, companyId } = await seedAgent()
  const token = await signCurrentRuntimeToken({
    agentId,
    sourceCompanyId: companyId,
    claimCompanyId: null,
  })
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
    // The composite membership FK now prevents forging agentId into this
    // tenant at fixture time; the runtime tenant boundary must still exclude
    // a valid foreign conversation id supplied by the caller.
    members: [otherTenant.agentId],
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

test('[integration] runtime: every route rejects a stale production token after tenant reassignment', async () => {
  const originalTenant = await seedAgent()
  const currentTenant = await seedAgent()
  const { token: staleToken } = await mintAssignedAgentRuntimeToken(originalTenant)

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

  // Exercise both current-tenant reads and a mutation. The auth middleware is
  // mounted before the entire runtime router, so each must fail before its
  // handler can observe or alter the reassigned agent's tenant-B state.
  for (const request of [
    { path: '/runtime/context', body: { conversationIds: [crossTenantId] } },
    { path: '/runtime/inbox', method: 'GET' },
    { path: '/runtime/persona', method: 'GET' },
    { path: '/runtime/status', body: { status: 'working' } },
  ]) {
    const r = await call(request.path, {
      method: request.method,
      token: staleToken,
      body: request.body,
    })
    assert.equal(r.status, 403, request.path)
    assert.match(String(r.body?.error ?? ''), /assignment changed|revoked/i, request.path)
  }

  const { rows: statusRows } = await pool.query<{ status: string }>(
    `SELECT status FROM participants WHERE id = $1`,
    [originalTenant.agentId],
  )
  assert.deepEqual(statusRows, [{ status: 'avail' }])
})

test('[integration] runtime: host reassignment generations and Computer revocation invalidate old tokens', async () => {
  const agent = await seedAgent()
  const first = await mintAssignedAgentRuntimeToken(agent)
  const firstClaims = verifyAgentToken(first.token)
  assert.equal(firstClaims.computerId, first.computerId)

  const secondComputerId = `comp-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind, available_engines, status)
     VALUES ($1, $2, $3, 'local', '["codex"]'::jsonb, 'online')`,
    [secondComputerId, agent.companyId, `Computer ${secondComputerId}`],
  )
  const moved = await pool.query<{ runtime_assignment_id: string }>(
    `UPDATE participants SET computer_id = $1
      WHERE id = $2 AND company_id = $3
      RETURNING runtime_assignment_id`,
    [secondComputerId, agent.agentId, agent.companyId],
  )
  assert.equal(moved.rowCount, 1)
  assert.notEqual(moved.rows[0].runtime_assignment_id, firstClaims.assignmentId)

  const movedAway = await call('/runtime/status', {
    token: first.token,
    body: { status: 'working' },
  })
  assert.equal(movedAway.status, 403)
  assert.match(String(movedAway.body?.error ?? ''), /assignment changed|revoked/i)

  const movedBack = await pool.query<{ runtime_assignment_id: string }>(
    `UPDATE participants SET computer_id = $1
      WHERE id = $2 AND company_id = $3
      RETURNING runtime_assignment_id`,
    [first.computerId, agent.agentId, agent.companyId],
  )
  assert.equal(movedBack.rowCount, 1)
  assert.notEqual(movedBack.rows[0].runtime_assignment_id, moved.rows[0].runtime_assignment_id)
  assert.notEqual(movedBack.rows[0].runtime_assignment_id, firstClaims.assignmentId)

  // Computer id and tenant now equal the original claims again. Only the
  // database-owned assignment generation prevents this ABA replay.
  const replayed = await call('/runtime/inbox', { method: 'GET', token: first.token })
  assert.equal(replayed.status, 403)
  assert.match(String(replayed.body?.error ?? ''), /assignment changed|revoked/i)

  const current = await mintAgentRuntimeToken({
    computerId: first.computerId,
    agentId: agent.agentId,
  })
  assert.ok(current)
  assert.equal((await call('/runtime/inbox', { method: 'GET', token: current.token })).status, 200)

  assert.equal(await revokeComputer({
    computerId: first.computerId,
    companyId: agent.companyId,
  }), true)
  assert.equal(await mintAgentRuntimeToken({
    computerId: first.computerId,
    agentId: agent.agentId,
  }), null)
  const revoked = await call('/runtime/status', {
    token: current.token,
    body: { status: 'working' },
  })
  assert.equal(revoked.status, 403)
  assert.match(String(revoked.body?.error ?? ''), /assignment changed|revoked/i)
})

test('[integration] runtime: /inbox-triage/payload rejects a stale token before loading the new tenant inbox', async () => {
  const originalTenant = await seedAgent()
  const currentTenant = await seedAgent()
  const { token: staleToken } = await mintAssignedAgentRuntimeToken(originalTenant)

  const moved = await pool.query(
    `UPDATE participants
        SET company_id = $1, computer_id = NULL, engine = NULL
      WHERE id = $2 AND company_id = $3`,
    [currentTenant.companyId, originalTenant.agentId, originalTenant.companyId],
  )
  assert.equal(moved.rowCount, 1)

  await seedContextConversation({
    companyId: currentTenant.companyId,
    members: [originalTenant.agentId, currentTenant.agentId],
    authorId: currentTenant.agentId,
    body: 'new-tenant-inbox-private',
  })

  const r = await call('/runtime/inbox-triage/payload', {
    method: 'GET',
    token: staleToken,
  })

  assert.equal(r.status, 403)
  assert.match(String(r.body?.error ?? ''), /assignment changed|revoked/i)
})

test('[integration] runtime: a current token cannot use a stale member id to read or write the old tenant through /cli', async () => {
  const originalTenant = await seedAgent()
  const currentTenant = await seedAgent()
  const oldPeerId = `a-old-peer-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1,$2,'agent',$1,'peer','P','#abcdef','avail')`,
    [oldPeerId, originalTenant.companyId],
  )
  const oldConversationId = await seedContextConversation({
    companyId: originalTenant.companyId,
    members: [originalTenant.agentId],
    authorId: originalTenant.agentId,
    body: 'old-runtime-tenant-secret',
  })
  await pool.query(
    `UPDATE conversations SET topic = 'old-runtime-topic-secret' WHERE id = $1`,
    [oldConversationId],
  )
  const { rows: oldMessageRows } = await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1 AND kind = 'text' LIMIT 1`,
    [oldConversationId],
  )
  const oldMessageId = oldMessageRows[0].id
  const oldPollId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, poll, company_id)
     VALUES ($1,$2,$3,'poll','old-runtime-poll-secret',2,$4::jsonb,$5)`,
    [
      oldPollId,
      oldConversationId,
      originalTenant.agentId,
      JSON.stringify({
        question: 'old-runtime-poll-secret', mode: 'single',
        options: [{ id: 'opt-one', text: 'one' }, { id: 'opt-two', text: 'two' }],
        expiresAt: null, closedAt: null, closedReason: null,
      }),
      originalTenant.companyId,
    ],
  )

  const mover = await pool.connect()
  try {
    await mover.query('BEGIN')
    await mover.query(
      `DELETE FROM conversation_members
        WHERE conversation_id = $1
          AND participant_id = $2
          AND company_id = $3`,
      [oldConversationId, originalTenant.agentId, originalTenant.companyId],
    )
    await mover.query(`SELECT refresh_conversation_members_projection($1)`, [oldConversationId])
    const moved = await mover.query(
      `UPDATE participants SET company_id = $1 WHERE id = $2 AND company_id = $3`,
      [currentTenant.companyId, originalTenant.agentId, originalTenant.companyId],
    )
    assert.equal(moved.rowCount, 1)
    await mover.query('COMMIT')
  } catch (error) {
    await mover.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    mover.release()
  }
  const currentToken = await signCurrentRuntimeToken({
    agentId: originalTenant.agentId,
    sourceCompanyId: currentTenant.companyId,
  })

  for (const argv of [
    ['conversations', '--json'],
    ['messages', oldConversationId, '--json'],
    ['members', oldConversationId, '--json'],
    ['glance', oldConversationId, '--json'],
    ['topic', oldConversationId],
    ['search', 'old-runtime', '--json'],
    ['react', oldMessageId, '👀'],
    ['poll', 'show', oldPollId],
    ['poll', 'vote', oldPollId, 'opt-one'],
    ['poll', 'close', oldPollId],
    ['poll', 'create', oldConversationId, 'must-not-land', 'one', 'two'],
    ['dm', oldPeerId, 'forbidden', 'must-not-land'],
    ['pull-group', 'forbidden', '--members', oldPeerId, '--reason', 'must-not-land', '--say', 'must-not-land'],
    ['reply', oldConversationId, 'must-not-land'],
    ['topic-set', oldConversationId, 'must-not-land'],
    ['rename', oldConversationId, 'must-not-land'],
  ]) {
    const r = await call('/runtime/cli', { token: currentToken, body: { argv } })
    assert.equal(r.status, 200, argv.join(' '))
    assert.doesNotMatch(
      String(r.body?.text ?? ''),
      /old-runtime-(tenant|topic|poll)-secret/,
      argv.join(' '),
    )
  }

  const { rows } = await pool.query<{ body: string; topic: string | null; title: string }>(
    `SELECT m.body, c.topic, c.title
       FROM conversations c
      JOIN messages m ON m.conversation_id = c.id AND m.kind = 'text'
      WHERE c.id = $1
      ORDER BY m.sequence ASC`,
    [oldConversationId],
  )
  assert.deepEqual(rows, [{
    body: 'old-runtime-tenant-secret',
    topic: 'old-runtime-topic-secret',
    title: `Context ${oldConversationId}`,
  }])
  const { rows: sideEffects } = await pool.query<{
    reactions: number; votes: number; message_count: number; closed_at: string | null
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM message_reactions WHERE message_id = $1) AS reactions,
       (SELECT COUNT(*)::int FROM poll_votes WHERE message_id = $2) AS votes,
       (SELECT COUNT(*)::int FROM messages WHERE conversation_id = $3) AS message_count,
       (SELECT poll->>'closedAt' FROM messages WHERE id = $2) AS closed_at`,
    [oldMessageId, oldPollId, oldConversationId],
  )
  assert.deepEqual(sideEffects[0], {
    reactions: 0, votes: 0, message_count: 2, closed_at: null,
  })
  const forbiddenConversations = await pool.query(
    `SELECT 1 FROM conversations
      WHERE company_id = $1
        AND (
          pulled_by ->> 'agentId' = $2
          OR (
            kind = 'direct'
            AND EXISTS (
              SELECT 1 FROM conversation_members first_member
               WHERE first_member.conversation_id = conversations.id
                 AND first_member.participant_id = $2
            )
            AND EXISTS (
              SELECT 1 FROM conversation_members second_member
               WHERE second_member.conversation_id = conversations.id
                 AND second_member.participant_id = $3
            )
          )
        )`,
    [currentTenant.companyId, originalTenant.agentId, oldPeerId],
  )
  assert.equal(forbiddenConversations.rowCount, 0)
})

test('[integration] runtime: /cli rejects email server-path attachments before storage or mail side effects', async () => {
  const { token } = await seedAgent()
  const root = await mkdtemp(join(tmpdir(), 'cumora-email-attachment-'))
  const secretPath = join(root, 'server-secret.txt')
  const nested = join(root, 'nested')
  const symlinkPath = join(root, 'server-secret-link.txt')
  await writeFile(secretPath, 'must never leave the server')
  await mkdir(nested)
  await symlink(secretPath, symlinkPath)

  const candidates = [
    secretPath,
    `${nested}/../server-secret.txt`,
    symlinkPath,
    '/proc/self/environ',
    '/var/run/secrets/kubernetes.io/serviceaccount/token',
  ]

  try {
    const { storage } = await import('../storage.js')
    const beforeKeys = (await storage.listObjectsByPrefix('email-attachments/'))
      .map((item) => item.key)
      .sort()

    for (const candidate of candidates) {
      for (const argv of [
        ['email', 'send', '--to', 'external@example.com', '--subject', 'status', '--body', 'body', '--attach', candidate],
        ['email', 'reply', 'missing-message', '--body', 'body', '--attach', candidate],
      ]) {
        const r = await call('/runtime/cli', { token, body: { argv } })
        assert.equal(r.status, 200)
        assert.equal(r.body?.ok, false)
        assert.equal(r.body?.exitCode, 1)
        assert.match(String(r.body?.text ?? ''), /never accepts server filesystem paths/i)
      }
    }

    const afterKeys = (await storage.listObjectsByPrefix('email-attachments/'))
      .map((item) => item.key)
      .sort()
    assert.deepEqual(afterKeys, beforeKeys, 'rejected paths must not upload storage objects')

    const { rows } = await pool.query<{
      conversations: number; messages: number; emailMessages: number; emailAttachments: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM conversations) AS conversations,
         (SELECT COUNT(*)::int FROM messages) AS messages,
         (SELECT COUNT(*)::int FROM email_messages) AS "emailMessages",
         (SELECT COUNT(*)::int FROM email_attachments) AS "emailAttachments"`,
    )
    assert.deepEqual(rows[0], {
      conversations: 0,
      messages: 0,
      emailMessages: 0,
      emailAttachments: 0,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('[integration] runtime: /cli still sends text-only agent email in mock mode', async () => {
  const { token } = await seedAgent()
  const r = await call('/runtime/cli', {
    token,
    body: {
      argv: [
        'email', 'send',
        '--to', 'external@example.com',
        '--subject', 'text-only status',
        '--body', 'safe body',
      ],
    },
  })

  assert.equal(r.status, 200)
  assert.equal(r.body?.ok, true, String(r.body?.text ?? ''))
  assert.equal(r.body?.sideEffects?.[0]?.event, 'email.sent')
  assert.equal(r.body?.sideEffects?.[0]?.attachmentCount, 0)

  const { rows } = await pool.query<{ messages: number; attachments: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM email_messages) AS messages,
       (SELECT COUNT(*)::int FROM email_attachments) AS attachments`,
  )
  assert.deepEqual(rows[0], { messages: 1, attachments: 0 })
})

test('[integration] runtime: /faces requires a tenant-pinned token', async () => {
  const { agentId, companyId } = await seedAgent()
  const token = await signCurrentRuntimeToken({
    agentId,
    sourceCompanyId: companyId,
    claimCompanyId: null,
  })
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

test('[integration] runtime: same-tenant agents cannot mutate each other\'s run observability', async () => {
  const owner = await seedAgent()
  const attacker = await seedPeerAgent(owner.companyId)
  await assertCannotMutateForeignRun({
    ownerToken: owner.token,
    attackerToken: attacker.token,
  })
})

test('[integration] runtime: cross-tenant agents cannot mutate another tenant\'s run observability', async () => {
  const owner = await seedAgent()
  const attacker = await seedAgent()
  await assertCannotMutateForeignRun({
    ownerToken: owner.token,
    attackerToken: attacker.token,
  })
})

test('[integration] runtime: /llm-calls rejects a mixed-owner batch atomically', async () => {
  const caller = await seedAgent()
  const foreign = await seedAgent()
  const ownRun = await call('/runtime/runs', {
    token: caller.token,
    body: { trigger: { kind: 'own' }, inboxCount: 0 },
  })
  const foreignRun = await call('/runtime/runs', {
    token: foreign.token,
    body: { trigger: { kind: 'foreign' }, inboxCount: 0 },
  })
  assert.equal(ownRun.status, 200)
  assert.equal(foreignRun.status, 200)
  assert.equal(typeof ownRun.body?.runId, 'string')
  assert.equal(typeof foreignRun.body?.runId, 'string')
  const runIds = [ownRun.body.runId as string, foreignRun.body.runId as string]
  assert.ok(runIds.every((runId) => runId.startsWith('run-')))
  assert.notEqual(runIds[0], runIds[1])

  const rejected = await call('/runtime/llm-calls', {
    token: caller.token,
    body: {
      source: 'byoa-codex',
      hops: runIds.map((runId) => ({ runId, model: 'test-model', latencyMs: 1, status: 'ok' })),
    },
  })
  assert.equal(rejected.status, 404)
  assert.match(String(rejected.body?.error ?? ''), /agent run not found/i)

  await waitForPoolIdle()
  const { rows } = await pool.query(
    `SELECT id FROM llm_calls WHERE run_id = ANY($1::text[])`,
    [runIds],
  )
  assert.equal(rows.length, 0, 'an unauthorized hop must reject the whole batch before inserts start')
})

test('[integration] runtime: /llm-calls rejects oversized batches before scheduling inserts', async () => {
  const caller = await seedAgent()
  const model = `oversized-${randomUUID()}`
  const rejected = await call('/runtime/llm-calls', {
    token: caller.token,
    body: {
      source: 'byoa-codex',
      hops: Array.from({ length: 101 }, () => ({ model, latencyMs: 1, status: 'ok' })),
    },
  })
  assert.equal(rejected.status, 413)
  assert.match(String(rejected.body?.error ?? ''), /too many hops/i)

  await waitForPoolIdle()
  const { rows } = await pool.query(
    `SELECT id FROM llm_calls WHERE agent_id = $1 AND model = $2`,
    [caller.agentId, model],
  )
  assert.equal(rows.length, 0, 'oversized batches must be rejected before fire-and-forget inserts start')
})

test('[integration] runtime: offboarding that wins the participant lock cancels every pending run mutation', async () => {
  const owner = await seedAgent()
  const created = await call('/runtime/runs', {
    token: owner.token,
    body: { trigger: { kind: 'offboard-race' }, inboxCount: 0 },
  })
  assert.equal(created.status, 200)
  assert.equal(typeof created.body?.runId, 'string')
  const runId = created.body.runId as string
  const ledgerModel = `offboard-race-${randomUUID()}`
  await pool.query(
    `UPDATE agent_runs SET updated_at = '2000-01-01T00:00:00Z'::timestamptz WHERE id = $1`,
    [runId],
  )

  const offboarder = await pool.connect()
  let committed = false
  let pending: Promise<Array<{ status: number; body: any }>> | undefined
  try {
    await offboarder.query('BEGIN')
    await offboarder.query(
      `UPDATE participants SET departed_at = NOW() WHERE id = $1 AND company_id = $2`,
      [owner.agentId, owner.companyId],
    )
    pending = Promise.all([
      call('/runtime/events', {
        token: owner.token,
        body: { runId, kind: 'must.not.land', title: 'revoked', stage: 'revoked' },
      }),
      call(`/runtime/runs/${runId}/heartbeat`, { token: owner.token, body: {} }),
      call(`/runtime/runs/${runId}/finish`, {
        token: owner.token,
        body: { status: 'failed', summary: 'must not land' },
      }),
      call('/runtime/llm-calls', {
        token: owner.token,
        body: {
          source: 'byoa-codex',
          hops: [{ runId, model: ledgerModel, latencyMs: 1, status: 'ok' }],
        },
      }),
    ])
    await waitForBlockedQuery('%FROM participants%FOR SHARE%', 4)
    await offboarder.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await offboarder.query('ROLLBACK').catch(() => {})
    offboarder.release()
  }

  const results = await pending!
  for (const result of results) {
    assert.equal(result.status, 404)
    assert.match(String(result.body?.error ?? ''), /agent run not found/i)
  }
  const { rows: runRows } = await pool.query(
    `SELECT status, stage, summary,
            updated_at = '2000-01-01T00:00:00Z'::timestamptz AS unchanged,
            finished_at IS NULL AS unfinished
       FROM agent_runs WHERE id = $1`,
    [runId],
  )
  assert.deepEqual(runRows, [{
    status: 'running',
    stage: 'created',
    summary: null,
    unchanged: true,
    unfinished: true,
  }])
  const [{ rowCount: eventCount }, { rowCount: ledgerCount }] = await Promise.all([
    pool.query(`SELECT 1 FROM agent_events WHERE run_id = $1`, [runId]),
    pool.query(`SELECT 1 FROM llm_calls WHERE run_id = $1 AND model = $2`, [runId, ledgerModel]),
  ])
  assert.equal(eventCount, 0)
  assert.equal(ledgerCount, 0)
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

test('[integration] runtime: malformed observability fields are rejected before writes', async () => {
  const caller = await seedAgent()
  const created = await call('/runtime/runs', {
    token: caller.token,
    body: { trigger: { kind: 'malformed' }, inboxCount: 0 },
  })
  assert.equal(created.status, 200)
  assert.equal(typeof created.body?.runId, 'string')
  const runId = created.body.runId as string
  const model = `malformed-${randomUUID()}`

  const attempts = [
    await call('/runtime/events', {
      token: caller.token,
      body: { runId, kind: 'bad.event', title: 'bad', level: 'critical' },
    }),
    await call(`/runtime/runs/${runId}/finish`, {
      token: caller.token,
      body: { status: 'invented-status' },
    }),
    await call(`/runtime/runs/${runId}/finish`, {
      token: caller.token,
      body: {
        status: 'completed',
        usage: { inputTokens: '1', cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0 },
      },
    }),
    await call(`/runtime/runs/${runId}/finish`, {
      token: caller.token,
      body: { status: 'completed', tokenCount: 2_147_483_648 },
    }),
    await call(`/runtime/runs/${runId}/finish`, {
      token: caller.token,
      body: {
        status: 'completed',
        usage: {
          inputTokens: 2_147_483_647,
          cachedInputTokens: 1,
          cacheCreationTokens: 0,
          outputTokens: 0,
        },
      },
    }),
    await call('/runtime/llm-calls', {
      token: caller.token,
      body: { source: 'byoa-codex', hops: { runId, model } },
    }),
    await call('/runtime/llm-calls', {
      token: caller.token,
      body: {
        source: 'byoa-codex',
        hops: [{ runId, model, status: 'invented-status', error: { secret: 'must not reach a 500' } }],
      },
    }),
    await call('/runtime/llm-calls', {
      token: caller.token,
      body: { source: 'byoa-codex', hops: [{ runId, model, status: 'ok', latencyMs: 1.5 }] },
    }),
  ]
  for (const attempt of attempts) assert.equal(attempt.status, 400)

  const [{ rows: runRows }, { rowCount: eventCount }, { rowCount: ledgerCount }] = await Promise.all([
    pool.query(`SELECT status, stage, finished_at FROM agent_runs WHERE id = $1`, [runId]),
    pool.query(`SELECT 1 FROM agent_events WHERE run_id = $1`, [runId]),
    pool.query(`SELECT 1 FROM llm_calls WHERE run_id = $1 AND model = $2`, [runId, model]),
  ])
  assert.deepEqual(runRows, [{ status: 'running', stage: 'created', finished_at: null }])
  assert.equal(eventCount, 0)
  assert.equal(ledgerCount, 0)
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

  await pool.query(
    `UPDATE agent_runs SET updated_at = '2000-01-01T00:00:00Z'::timestamptz WHERE id = $1`,
    [runId],
  )
  const heartbeat = await call(`/runtime/runs/${runId}/heartbeat`, { token, body: {} })
  assert.equal(heartbeat.status, 200)
  assert.equal(heartbeat.body?.touched, true)
  const { rows: heartbeatRows } = await pool.query<{ touched: boolean }>(
    `SELECT updated_at > '2000-01-01T00:00:00Z'::timestamptz AS touched
       FROM agent_runs WHERE id = $1`,
    [runId],
  )
  assert.equal(heartbeatRows[0]?.touched, true)

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

test('[integration] runtime: /llm-calls atomically records multiple caller-owned hops', async () => {
  const caller = await seedAgent()
  const created = await call('/runtime/runs', {
    token: caller.token,
    body: { trigger: { kind: 'llm-ledger' }, inboxCount: 0 },
  })
  assert.equal(created.status, 200)
  assert.equal(typeof created.body?.runId, 'string')
  const runId = created.body.runId as string
  const prefix = `owned-${randomUUID()}`
  const models = [`${prefix}-1`, `${prefix}-2`, `${prefix}-3`]
  const recorded = await call('/runtime/llm-calls', {
    token: caller.token,
    body: {
      source: 'byoa-codex',
      daemonVersion: '9.9.9-test',
      hops: [
        {
          runId,
          purpose: 'agent-turn',
          model: models[0],
          usage: { inputTokens: 1, cachedInputTokens: 2, cacheCreationTokens: 3, outputTokens: 4 },
          latencyMs: 7,
          status: 'ok',
          extras: { hop: 1 },
        },
        {
          runId,
          purpose: 'compaction',
          model: models[1],
          latencyMs: 8,
          status: 'failed',
          error: 'expected test failure',
          extras: { hop: 2 },
        },
        {
          runId,
          purpose: 'completion-verify',
          model: models[2],
          usage: { inputTokens: 5, cachedInputTokens: 6, cacheCreationTokens: 7, outputTokens: 8 },
          latencyMs: 9,
          status: 'rate_limited',
          extras: { hop: 3 },
        },
      ],
    },
  })
  assert.equal(recorded.status, 200)
  assert.equal(recorded.body?.inserted, 3)

  await waitForPoolIdle()
  const { rows } = await pool.query(
    `SELECT agent_id, company_id, run_id, purpose, source, model,
            input_tokens, cached_input_tokens, cache_creation_tokens, output_tokens,
            measured, latency_ms, status, error, extras, daemon_version
       FROM llm_calls
      WHERE run_id = $1 AND model = ANY($2::text[])
      ORDER BY model`,
    [runId, models],
  )
  assert.deepEqual(rows, [
    {
      agent_id: caller.agentId, company_id: caller.companyId, run_id: runId,
      purpose: 'agent-turn', source: 'byoa-codex', model: models[0],
      input_tokens: 1, cached_input_tokens: 2, cache_creation_tokens: 3, output_tokens: 4,
      measured: true, latency_ms: 7, status: 'ok', error: null, extras: { hop: 1 }, daemon_version: '9.9.9-test',
    },
    {
      agent_id: caller.agentId, company_id: caller.companyId, run_id: runId,
      purpose: 'compaction', source: 'byoa-codex', model: models[1],
      input_tokens: 0, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 0,
      measured: false, latency_ms: 8, status: 'failed', error: 'expected test failure', extras: { hop: 2 }, daemon_version: '9.9.9-test',
    },
    {
      agent_id: caller.agentId, company_id: caller.companyId, run_id: runId,
      purpose: 'completion-verify', source: 'byoa-codex', model: models[2],
      input_tokens: 5, cached_input_tokens: 6, cache_creation_tokens: 7, output_tokens: 8,
      measured: true, latency_ms: 9, status: 'rate_limited', error: null, extras: { hop: 3 }, daemon_version: '9.9.9-test',
    },
  ])
})
