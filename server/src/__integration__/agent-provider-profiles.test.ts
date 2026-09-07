import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { createAgentRecord } from '../agents/create.js'
import { assignAgentToComputer, listAgentsForComputer, mintAgentRuntimeToken, resolveComputerAssignment, sanitizeDetectedEngines } from '../agents/computer/registry.js'
import { isRuntimeAgentAuthorized } from '../agents/runtime/authorization.js'
import { verifyAgentToken } from '../agents/runtime/jwt.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

const companyId = 'co-provider-test'
const computerId = 'comp-provider-test'
const agentId = 'agent-provider-test'
const metadata = { id: 'work', label: 'Work', model: 'work/big', fastModel: 'work/small' }
const placement = { companyId, computerId, engine: 'claude', inherit: false }

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => {
  await resetAllTables()
  await seedCompanyWithAgent({ companyId, agentId })
  const detected = sanitizeDetectedEngines([{
    id: 'claude', bin: 'claude', path: '/usr/bin/claude', providerProfiles: [
      { ...metadata, baseUrl: 'https://private.example.test', auth: { apiKey: 'must-not-persist' } },
      { ...metadata, id: 'personal' },
    ],
  }], ['claude', 'codex'])
  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind, available_engines, detected_engines)
     VALUES ($1, $2, 'Fixture', 'local', $3::jsonb, $4::jsonb)`,
    [computerId, companyId, JSON.stringify(['claude', 'codex']), JSON.stringify(detected)],
  )
  await assignAgentToComputer({ ...placement, agentId })
})
after(async () => { await teardownAll() })

test('[integration] provider assignment requires explicit Claude and a profile on this computer', async () => {
  assert.ok(await resolveComputerAssignment({ ...placement, providerProfile: 'work' }))
  for (const invalid of [
    { providerProfile: 'unknown' }, { providerProfile: '../work' },
    { providerProfile: 'work', engine: 'codex' }, { providerProfile: 'work', inherit: true },
    { providerProfile: 'work', companyId: 'foreign-company' },
  ]) {
    assert.equal(await assignAgentToComputer({ ...placement, agentId, ...invalid }), null)
  }
  const { rows } = await pool.query('SELECT provider_profile FROM participants WHERE id = $1', [agentId])
  assert.equal(rows[0].provider_profile, null)
  const computers = await pool.query('SELECT detected_engines FROM computers WHERE id = $1', [computerId])
  assert.doesNotMatch(JSON.stringify(computers.rows), /must-not-persist|private\.example|baseUrl|apiKey/)
})

test('[integration] old daemons cannot discover or mint tokens for a bound profile; pins stay local', async () => {
  const oldDefault = process.env.CUMORA_DEFAULT_CLAUDE_MODEL
  process.env.CUMORA_DEFAULT_CLAUDE_MODEL = 'deployment/anthropic-model'
  try {
    const old = await mintAgentRuntimeToken({ computerId, agentId })
    assert.ok(old)
    assert.equal(await isRuntimeAgentAuthorized(verifyAgentToken(old.token)), true)
    assert.ok(await assignAgentToComputer({ ...placement, agentId, providerProfile: 'work', model: null, fastModel: null }))
    assert.equal(await isRuntimeAgentAuthorized(verifyAgentToken(old.token)), false)
    assert.equal(await mintAgentRuntimeToken({ computerId, agentId }), null)
    assert.equal(await mintAgentRuntimeToken({ computerId, agentId, providerProfile: 'personal' }), null)
    assert.deepEqual(await listAgentsForComputer(computerId), [])
    const listed = await listAgentsForComputer(computerId, true)
    assert.equal(listed[0].providerProfile, 'work')
    assert.equal(listed[0].model, null)
    assert.equal(listed[0].fastModel, null)
    const work = await mintAgentRuntimeToken({ computerId, agentId, providerProfile: 'work' })
    assert.ok(work)
    assert.equal(await isRuntimeAgentAuthorized(verifyAgentToken(work.token)), true)
    assert.ok(await assignAgentToComputer({ ...placement, agentId, providerProfile: 'personal' }))
    assert.equal(await isRuntimeAgentAuthorized(verifyAgentToken(work.token)), false)
    // Clearing a profile restores the legacy discovery/token behavior.
    await assignAgentToComputer({ ...placement, agentId, providerProfile: null })
    assert.equal((await listAgentsForComputer(computerId))[0].model, 'deployment/anthropic-model')
    assert.ok(await mintAgentRuntimeToken({ computerId, agentId }))
  } finally {
    if (oldDefault === undefined) delete process.env.CUMORA_DEFAULT_CLAUDE_MODEL
    else process.env.CUMORA_DEFAULT_CLAUDE_MODEL = oldDefault
  }
})

test('[integration] Agent creation persists the profile atomically and includes it in retry identity', async () => {
  const input = {
    ...placement, name: 'Provider Agent', tier: 'pro' as const, maxActiveAgents: 20,
    systemPrompt: 'Test fixture', providerProfile: 'work', requestId: 'profile-create-fixture',
  }
  const created = await createAgentRecord(input)
  assert.equal((await createAgentRecord(input)).id, created.id)
  assert.equal((await listAgentsForComputer(computerId, true)).find((a) => a.id === created.id)?.providerProfile, 'work')
  await assert.rejects(createAgentRecord({ ...input, providerProfile: 'personal' }), /different agent data/)
  await assert.rejects(createAgentRecord({ ...input, requestId: 'profile-invalid-fixture', providerProfile: 'missing' }), /invalid computer or engine/)
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM participants WHERE creation_request_id = $1', ['profile-invalid-fixture'])
  assert.equal(rows[0].n, 0)
})
