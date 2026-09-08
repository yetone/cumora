import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { isRuntimeAgentAuthorized } from '../agents/runtime/authorization.js'
import { drainWorkspaceCleanupJobs } from '../workspace-cleanup.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

const OWNER_ID = 'u-workspace-owner'
const TARGET_ID = 'u-workspace-target'
let ownerServer: Server
let targetServer: Server
let ownerBase = ''
let targetBase = ''

async function listenFor(userId: string): Promise<{ server: Server; base: string }> {
  const app = await buildApiTestApp(userId)
  return new Promise((resolve) => {
    const server = createServer(app).listen(0, () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve({ server, base: `http://127.0.0.1:${address.port}` })
    })
  })
}

before(async () => {
  await ensureSchemaOnce()
  const owner = await listenFor(OWNER_ID)
  ownerServer = owner.server
  ownerBase = owner.base
  const target = await listenFor(TARGET_ID)
  targetServer = target.server
  targetBase = target.base
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  if (ownerServer?.listening) await new Promise<void>((resolve) => ownerServer.close(() => resolve()))
  await teardownAll(targetServer)
})

async function seedUser(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier)
     VALUES ($1, $2, $3, 'pro')`,
    [userId, `${userId}@test.local`, userId],
  )
}

async function seedCompany(companyId: string, ownerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, $2, $3, $4)`,
    [companyId, `Workspace ${companyId}`, companyId, ownerId],
  )
}

async function seedMember(
  companyId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  const exists = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId])
  if (!exists.rows[0]) await seedUser(userId)
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3)`,
    [companyId, userId, role],
  )
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', $3, NULL, $4, '#abcdef', 'avail')`,
    [userId, companyId, userId, userId.charAt(0).toUpperCase()],
  )
}

async function seedOwnedWorkspace(companyId = 'co-managed'): Promise<void> {
  await seedUser(OWNER_ID)
  await seedCompany(companyId, OWNER_ID)
  await seedMember(companyId, OWNER_ID, 'owner')
}

function companyHeaders(companyId: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-company-id': companyId }
}

test('[integration] owner lists members and changes a member role', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')

  const list = await fetch(`${ownerBase}/api/companies/co-managed/members`, {
    headers: companyHeaders('co-managed'),
  })
  assert.equal(list.status, 200)
  const members = await list.json() as Array<{ id: string; role: string; email: string }>
  assert.deepEqual(members.map((row) => [row.id, row.role]), [
    [OWNER_ID, 'owner'],
    [TARGET_ID, 'member'],
  ])
  assert.equal(members[1].email, `${TARGET_ID}@test.local`)

  const update = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'PATCH', headers: companyHeaders('co-managed'), body: JSON.stringify({ role: 'admin' }),
  })
  assert.equal(update.status, 200)
  const stored = await pool.query<{ role: string }>(
    `SELECT role FROM company_members WHERE company_id = 'co-managed' AND user_id = $1`,
    [TARGET_ID],
  )
  assert.equal(stored.rows[0].role, 'admin')
  const event = await pool.query<{ payload: { kind: string; recipientUserIds: string[] } }>(
    `SELECT payload FROM realtime_outbox WHERE channel = 'cumora:workspaces'`,
  )
  assert.equal(event.rows[0].payload.kind, 'role_changed')
  assert.deepEqual(new Set(event.rows[0].payload.recipientUserIds), new Set([OWNER_ID, TARGET_ID]))
})

test('[integration] admin cannot change roles or remove another admin', async () => {
  const realOwner = 'u-real-owner'
  await seedUser(realOwner)
  await seedCompany('co-admin', realOwner)
  await seedMember('co-admin', realOwner, 'owner')
  await seedMember('co-admin', OWNER_ID, 'admin')
  await seedMember('co-admin', TARGET_ID, 'admin')

  const update = await fetch(`${ownerBase}/api/companies/co-admin/members/${TARGET_ID}`, {
    method: 'PATCH', headers: companyHeaders('co-admin'), body: JSON.stringify({ role: 'member' }),
  })
  assert.equal(update.status, 403)

  const remove = await fetch(`${ownerBase}/api/companies/co-admin/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-admin'),
  })
  assert.equal(remove.status, 403)
})

test('[integration] regular members cannot list, change, or remove workspace members', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')

  const list = await fetch(`${targetBase}/api/companies/co-managed/members`, {
    headers: companyHeaders('co-managed'),
  })
  assert.equal(list.status, 403)
  const update = await fetch(`${targetBase}/api/companies/co-managed/members/${OWNER_ID}`, {
    method: 'PATCH', headers: companyHeaders('co-managed'), body: JSON.stringify({ role: 'member' }),
  })
  assert.equal(update.status, 403)
  const remove = await fetch(`${targetBase}/api/companies/co-managed/members/${OWNER_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(remove.status, 403)
})

test('[integration] admin can remove a member but cannot invite an admin', async () => {
  const realOwner = 'u-real-owner'
  await seedUser(realOwner)
  await seedCompany('co-admin', realOwner)
  await seedMember('co-admin', realOwner, 'owner')
  await seedMember('co-admin', OWNER_ID, 'admin')
  await seedMember('co-admin', TARGET_ID, 'member')

  const invite = await fetch(`${ownerBase}/api/companies/co-admin/invitations`, {
    method: 'POST', headers: companyHeaders('co-admin'),
    body: JSON.stringify({ email: 'new-admin@test.local', role: 'admin' }),
  })
  assert.equal(invite.status, 403)
  const remove = await fetch(`${ownerBase}/api/companies/co-admin/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-admin'),
  })
  assert.equal(remove.status, 200)
})

test('[integration] workspace owner and self-removal protections are enforced', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')

  const patchOwner = await fetch(`${ownerBase}/api/companies/co-managed/members/${OWNER_ID}`, {
    method: 'PATCH', headers: companyHeaders('co-managed'), body: JSON.stringify({ role: 'member' }),
  })
  assert.equal(patchOwner.status, 409)
  const removeSelf = await fetch(`${targetBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(removeSelf.status, 409)

  const realOwner = 'u-real-owner'
  await seedUser(realOwner)
  await seedCompany('co-admin', realOwner)
  await seedMember('co-admin', realOwner, 'owner')
  await seedMember('co-admin', OWNER_ID, 'admin')
  const removeOwner = await fetch(`${ownerBase}/api/companies/co-admin/members/${realOwner}`, {
    method: 'DELETE', headers: companyHeaders('co-admin'),
  })
  assert.equal(removeOwner.status, 409)
})

test('[integration] workspace management is tenant scoped', async () => {
  const ownerA = 'u-owner-a'
  await seedUser(ownerA)
  await seedCompany('co-a', ownerA)
  await seedMember('co-a', ownerA, 'owner')
  await seedMember('co-a', OWNER_ID, 'admin')
  const otherOwner = 'u-other-owner'
  await seedUser(otherOwner)
  await seedCompany('co-other', otherOwner)
  await seedMember('co-other', otherOwner, 'owner')

  const list = await fetch(`${ownerBase}/api/companies/co-other/members`, {
    headers: companyHeaders('co-other'),
  })
  assert.equal(list.status, 403)
  const update = await fetch(`${ownerBase}/api/companies/co-other/members/${otherOwner}`, {
    method: 'PATCH', headers: companyHeaders('co-other'), body: JSON.stringify({ role: 'member' }),
  })
  assert.equal(update.status, 403)
  const remove = await fetch(`${ownerBase}/api/companies/co-other/members/${otherOwner}`, {
    method: 'DELETE', headers: companyHeaders('co-other'),
  })
  assert.equal(remove.status, 403)
})

test('[integration] removing a member revokes tenant and conversation access atomically', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ('room-managed', 'group', 'Managed room', $1::jsonb, 'co-managed')`,
    [JSON.stringify([OWNER_ID, TARGET_ID])],
  )
  await pool.query(
    `INSERT INTO user_preferences (user_id, prefs, company_id)
     VALUES ($1, '{"theme":"dark"}'::jsonb, 'personal')`, [TARGET_ID],
  )
  await pool.query(
    `INSERT INTO agent_autonomy (user_id, agent_id, company_id)
     VALUES ($1, 'global-agent', 'personal')`, [TARGET_ID],
  )

  const remove = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(remove.status, 200)

  const membership = await pool.query(
    `SELECT 1 FROM company_members WHERE company_id = 'co-managed' AND user_id = $1`, [TARGET_ID],
  )
  assert.equal(membership.rowCount, 0)
  const participant = await pool.query<{ departed_at: Date | null }>(
    `SELECT departed_at FROM participants WHERE company_id = 'co-managed' AND id = $1`, [TARGET_ID],
  )
  assert.ok(participant.rows[0].departed_at)
  const conversation = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = 'room-managed'`,
  )
  assert.deepEqual(conversation.rows[0].members, [OWNER_ID])
  const normalized = await pool.query<{ participant_id: string }>(
    `SELECT participant_id FROM conversation_members
      WHERE conversation_id = 'room-managed' ORDER BY ordinal`,
  )
  assert.deepEqual(normalized.rows.map((row) => row.participant_id), [OWNER_ID])
  assert.equal((await pool.query(`SELECT 1 FROM user_preferences WHERE user_id = $1`, [TARGET_ID])).rowCount, 1)
  assert.equal((await pool.query(`SELECT 1 FROM agent_autonomy WHERE user_id = $1`, [TARGET_ID])).rowCount, 1)
  const event = await pool.query<{ payload: { kind: string; recipientUserIds: string[] } }>(
    `SELECT payload FROM realtime_outbox WHERE channel = 'cumora:workspaces'`,
  )
  assert.equal(event.rows[0].payload.kind, 'removed')
  assert.deepEqual(new Set(event.rows[0].payload.recipientUserIds), new Set([OWNER_ID, TARGET_ID]))

  const denied = await fetch(`${targetBase}/api/participants`, {
    headers: companyHeaders('co-managed'),
  })
  assert.equal(denied.status, 403)
})

test('[integration] removing and reinviting a member preserves and reuses direct messages', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ('direct-managed', 'direct', 'Direct room', $1::jsonb, 'co-managed')`,
    [JSON.stringify([OWNER_ID, TARGET_ID])],
  )

  const remove = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(remove.status, 200)
  const retained = await pool.query<{ participant_id: string }>(
    `SELECT participant_id FROM conversation_members
      WHERE conversation_id = 'direct-managed' ORDER BY ordinal`,
  )
  assert.deepEqual(retained.rows.map((row) => row.participant_id), [OWNER_ID, TARGET_ID])

  const rawToken = 'workspace-direct-reinvite-token'
  const tokenHash = createHash('sha256').update(rawToken).digest('base64url')
  await pool.query(
    `INSERT INTO company_invitations
       (token_hash, company_id, invited_by, email, role, max_uses, expires_at)
     VALUES ($1, 'co-managed', $2, $3, 'member', 1, NOW() + INTERVAL '1 day')`,
    [tokenHash, OWNER_ID, `${TARGET_ID}@test.local`],
  )
  const accept = await fetch(`${targetBase}/api/invitations/${rawToken}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(accept.status, 200)
  const directCount = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM conversations WHERE company_id = 'co-managed' AND kind = 'direct'`,
  )
  assert.equal(directCount.rows[0].count, 1)
})

test('[integration] a removed member can accept a new invite and becomes active again', async () => {
  await seedOwnedWorkspace()
  await seedMember('co-managed', TARGET_ID, 'member')
  const remove = await fetch(`${ownerBase}/api/companies/co-managed/members/${TARGET_ID}`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
  })
  assert.equal(remove.status, 200)

  const rawToken = 'workspace-reinvite-token'
  const tokenHash = createHash('sha256').update(rawToken).digest('base64url')
  await pool.query(
    `INSERT INTO company_invitations
       (token_hash, company_id, invited_by, email, role, max_uses, expires_at)
     VALUES ($1, 'co-managed', $2, $3, 'member', 1, NOW() + INTERVAL '1 day')`,
    [tokenHash, OWNER_ID, `${TARGET_ID}@test.local`],
  )

  const accept = await fetch(`${targetBase}/api/invitations/${rawToken}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal(accept.status, 200)
  const participant = await pool.query<{ departed_at: Date | null; status: string }>(
    `SELECT departed_at, status FROM participants WHERE company_id = 'co-managed' AND id = $1`,
    [TARGET_ID],
  )
  assert.equal(participant.rows[0].departed_at, null)
  assert.equal(participant.rows[0].status, 'avail')
})

test('[integration] owner cannot delete their only workspace', async () => {
  await seedOwnedWorkspace()
  const response = await fetch(`${ownerBase}/api/companies/co-managed`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
    body: JSON.stringify({ confirmation: 'Workspace co-managed' }),
  })
  assert.equal(response.status, 409)
  const company = await pool.query(`SELECT 1 FROM companies WHERE id = 'co-managed'`)
  assert.equal(company.rowCount, 1)
})

test('[integration] only the owner with an exact confirmation can delete a workspace', async () => {
  await seedOwnedWorkspace()
  await seedCompany('co-alternative', OWNER_ID)
  await seedMember('co-alternative', OWNER_ID, 'owner')
  await seedMember('co-managed', TARGET_ID, 'member')

  for (const body of [{}, { confirmation: 'wrong name' }]) {
    const response = await fetch(`${ownerBase}/api/companies/co-managed`, {
      method: 'DELETE', headers: companyHeaders('co-managed'), body: JSON.stringify(body),
    })
    assert.equal(response.status, 400)
  }
  const nonOwner = await fetch(`${targetBase}/api/companies/co-managed`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
    body: JSON.stringify({ confirmation: 'Workspace co-managed' }),
  })
  assert.equal(nonOwner.status, 403)
  const company = await pool.query(`SELECT 1 FROM companies WHERE id = 'co-managed'`)
  assert.equal(company.rowCount, 1)
})

test('[integration] workspace deletion purges FK-backed and legacy soft-scoped data', async () => {
  await seedOwnedWorkspace()
  await seedCompany('co-alternative', OWNER_ID)
  await seedMember('co-alternative', OWNER_ID, 'owner')
  await seedMember('co-managed', TARGET_ID, 'member')
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
     VALUES ('agent-managed', 'co-managed', 'agent', 'Managed agent', 'ops', 'M', '#abcdef', 'avail', 'test')`,
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ('room-managed', 'group', 'Managed room', $1::jsonb, 'co-managed')`,
    [JSON.stringify([OWNER_ID, TARGET_ID, 'agent-managed'])],
  )
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ('msg-managed', 'room-managed', $1, 'text', 'history', 1, 'co-managed')`,
    [TARGET_ID],
  )
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ('doc-managed', 'co-managed', 'Managed doc', $1)`, [OWNER_ID],
  )
  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind)
     VALUES ('computer-managed', 'co-managed', 'Managed computer', 'local')`,
  )
  await pool.query(
    `INSERT INTO agent_runs (id, agent_id, company_id)
     VALUES ('run-managed', 'agent-managed', 'co-managed')`,
  )
  await pool.query(
    `INSERT INTO user_preferences (user_id, prefs, company_id)
     VALUES ($1, '{"theme":"dark"}'::jsonb, 'personal')`, [TARGET_ID],
  )
  await pool.query(
    `INSERT INTO agent_autonomy (user_id, agent_id, company_id)
     VALUES ($1, 'agent-managed', 'personal')`, [TARGET_ID],
  )
  await pool.query(
    `INSERT INTO llm_calls (id, company_id, agent_id, purpose, model)
     VALUES ('llm-managed', 'co-managed', 'agent-managed', 'agent_turn', 'test-model')`,
  )
  await pool.query(
    `INSERT INTO llm_calls_rollup
       (bucket_hour, company_id, agent_id, purpose, model, source)
     VALUES (date_trunc('hour', NOW()), 'co-managed', 'agent-managed', 'agent_turn', 'test-model', 'cloud')`,
  )
  await pool.query(
    `INSERT INTO boards (id, company_id, title, created_by)
     VALUES ('board-managed', 'co-managed', 'Managed board', $1)`, [OWNER_ID],
  )
  await pool.query(
    `INSERT INTO agent_workspace (agent_id, path, body, company_id)
     VALUES ('agent-managed', 'notes.md', 'workspace content', 'co-managed')`,
  )
  await pool.query(
    `INSERT INTO agent_tasks (id, agent_id, title, company_id)
     VALUES ('task-managed', 'agent-managed', 'test task', 'co-managed')`,
  )
  await pool.query(
    `INSERT INTO agent_climate (agent_id, about_id, company_id, last_note)
     VALUES ('agent-managed', $1, 'co-managed', 'climate note')`,
    [OWNER_ID],
  )
  await pool.query(
    `INSERT INTO agent_log (id, agent_id, kind, body, company_id)
     VALUES ('log-managed', 'agent-managed', 'note', 'log body', 'co-managed')`,
  )

  const runtimeIdentity = await pool.query<{ runtime_assignment_id: string }>(
    `SELECT runtime_assignment_id
       FROM participants
      WHERE id = 'agent-managed' AND company_id = 'co-managed'`,
  )
  assert.ok(runtimeIdentity.rows[0])
  const runtimeClaims = {
    sub: 'agent-managed',
    companyId: 'co-managed',
    computerId: null,
    assignmentId: runtimeIdentity.rows[0].runtime_assignment_id,
  }
  assert.equal(await isRuntimeAgentAuthorized(runtimeClaims), true)

  const response = await fetch(`${ownerBase}/api/companies/co-managed`, {
    method: 'DELETE', headers: companyHeaders('co-managed'),
    body: JSON.stringify({ confirmation: 'Workspace co-managed' }),
  })
  assert.equal(response.status, 200, await response.text())

  for (const [table, predicate] of [
    ['companies', `id = 'co-managed'`],
    ['company_members', `company_id = 'co-managed'`],
    ['participants', `company_id = 'co-managed'`],
    ['conversations', `company_id = 'co-managed'`],
    ['messages', `company_id = 'co-managed'`],
    ['documents', `company_id = 'co-managed'`],
    ['computers', `company_id = 'co-managed'`],
    ['agent_runs', `company_id = 'co-managed'`],
    ['boards', `company_id = 'co-managed'`],
    ['agent_workspace', `company_id = 'co-managed' OR agent_id = 'agent-managed'`],
    ['agent_tasks', `company_id = 'co-managed' OR agent_id = 'agent-managed'`],
    ['agent_climate', `company_id = 'co-managed' OR agent_id = 'agent-managed'`],
    ['agent_log', `company_id = 'co-managed' OR agent_id = 'agent-managed'`],
  ] as const) {
    const remaining = await pool.query(`SELECT 1 FROM ${table} WHERE ${predicate}`)
    assert.equal(remaining.rowCount, 0, `${table} retained workspace rows`)
  }
  const alternative = await pool.query(`SELECT 1 FROM companies WHERE id = 'co-alternative'`)
  assert.equal(alternative.rowCount, 1)
  assert.equal(await isRuntimeAgentAuthorized(runtimeClaims), false)
  assert.equal((await pool.query(`SELECT 1 FROM user_preferences WHERE user_id = $1`, [TARGET_ID])).rowCount, 1)
  assert.equal((await pool.query(`SELECT 1 FROM agent_autonomy WHERE user_id = $1`, [TARGET_ID])).rowCount, 1)
  assert.equal((await pool.query(`SELECT 1 FROM llm_calls WHERE id = 'llm-managed'`)).rowCount, 1)
  assert.equal((await pool.query(`SELECT 1 FROM llm_calls_rollup WHERE company_id = 'co-managed'`)).rowCount, 1)

  const queued = await pool.query<{ id: string; attempts: number; completed_at: Date | null }>(
    `SELECT id, attempts, completed_at FROM workspace_cleanup_jobs WHERE company_id = 'co-managed'`,
  )
  assert.equal(queued.rowCount, 1)
  const failed = await drainWorkspaceCleanupJobs({
    dependencies: { deleteAgentRuntime: async () => { throw new Error('control plane unavailable') } },
  })
  assert.deepEqual(failed, { claimed: 1, completed: 0, failed: 1 })
  const retryable = await pool.query<{ attempts: number; completed_at: Date | null }>(
    `UPDATE workspace_cleanup_jobs SET available_at = NOW()
      WHERE id = $1 RETURNING attempts, completed_at`, [queued.rows[0].id],
  )
  assert.equal(retryable.rows[0].attempts, 1)
  assert.equal(retryable.rows[0].completed_at, null)
  const retried = await drainWorkspaceCleanupJobs({
    dependencies: { deleteAgentRuntime: async () => {} },
  })
  assert.deepEqual(retried, { claimed: 1, completed: 1, failed: 0 })
})
