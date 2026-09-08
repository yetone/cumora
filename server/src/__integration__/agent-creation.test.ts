import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { AgentCreationError, createAgentRecord } from '../agents/create.js'
import { ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll } from './_helpers.js'

const COMPANY_ID = 'co-agent-create'
const OWNER_ID = 'u-agent-create'
const COMPUTER_ID = 'comp-agent-create'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => {
  await resetAllTables()
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier)
     VALUES ($1, $2, 'Agent Creator', 'pro')`,
    [OWNER_ID, `${OWNER_ID}@test.local`],
  )
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Agent Create Co', 'agent-create-co', $2)`,
    [COMPANY_ID, OWNER_ID],
  )
  await seedUserMembership(OWNER_ID, COMPANY_ID, {
    email: `${OWNER_ID}@test.local`,
    displayName: 'Agent Creator',
  })
  await pool.query(
    `INSERT INTO computers
       (id, company_id, owner_user_id, name, kind, available_engines, status)
     VALUES ($1, $2, $3, 'Creator Mac', 'local', $4::jsonb, 'online')`,
    [COMPUTER_ID, COMPANY_ID, OWNER_ID, JSON.stringify(['claude', 'codex'])],
  )
})
after(async () => { await teardownAll() })

function input(overrides: Partial<Parameters<typeof createAgentRecord>[0]> = {}) {
  return {
    companyId: COMPANY_ID,
    tier: 'pro' as const,
    maxActiveAgents: 20,
    requestId: 'agent-create-request-1',
    name: 'Atomic Atlas',
    role: 'Researcher',
    systemPrompt: 'Investigate carefully and explain every conclusion.',
    computerId: COMPUTER_ID,
    engine: 'codex',
    inherit: false,
    ...overrides,
  }
}

test('[integration] concurrent Agent-create retries return one atomically assigned Agent', async () => {
  const [first, second] = await Promise.all([
    createAgentRecord(input()),
    createAgentRecord(input()),
  ])

  assert.equal(first.id, second.id)
  assert.deepEqual([first.created, second.created].sort(), [false, true])
  assert.deepEqual(first.placement, { kind: 'local', engine: 'codex', inherit: false })
  assert.deepEqual(second.placement, first.placement)

  const { rows } = await pool.query<{
    id: string
    computer_id: string | null
    engine: string | null
    engine_inherit: boolean
    creation_request_id: string | null
  }>(
    `SELECT id, computer_id, engine, engine_inherit, creation_request_id
       FROM participants
      WHERE company_id = $1 AND kind = 'agent'`,
    [COMPANY_ID],
  )
  assert.deepEqual(rows, [{
    id: first.id,
    computer_id: COMPUTER_ID,
    engine: 'codex',
    engine_inherit: false,
    creation_request_id: 'agent-create-request-1',
  }])
})

test('[integration] invalid placement rolls back without creating an Agent', async () => {
  await pool.query(
    'UPDATE computers SET available_engines = $2::jsonb WHERE id = $1',
    [COMPUTER_ID, JSON.stringify(['claude'])],
  )

  await assert.rejects(
    createAgentRecord(input({ requestId: 'agent-create-request-2' })),
    (error: unknown) => error instanceof AgentCreationError
      && error.status === 400
      && /invalid computer or engine/.test(error.message),
  )

  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM participants
      WHERE company_id = $1 AND kind = 'agent'`,
    [COMPANY_ID],
  )
  assert.equal(rows[0]?.count, 0)
})

test('[integration] reusing a request id with different data is rejected', async () => {
  const created = await createAgentRecord(input({ requestId: 'agent-create-request-3' }))
  assert.equal(created.created, true)

  await assert.rejects(
    createAgentRecord(input({
      requestId: 'agent-create-request-3',
      name: 'Different Agent',
    })),
    (error: unknown) => error instanceof AgentCreationError
      && error.status === 409
      && /different agent data/.test(error.message),
  )

  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM participants
      WHERE company_id = $1 AND kind = 'agent'`,
    [COMPANY_ID],
  )
  assert.equal(rows[0]?.count, 1)
})
