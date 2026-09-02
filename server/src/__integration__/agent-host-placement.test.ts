import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { resolveAgentHost } from '../agents/computer/registry.js'
import { verifyManagedPodPlacement } from '../agents/runtime/orchestrator.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function seedPlacementFixture(): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier) VALUES
       ('owner-pro', 'pro@test.local', 'Pro Owner', 'pro'),
       ('owner-free', 'free@test.local', 'Free Owner', 'free')`,
  )
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES
       ('co-pro', 'Pro Co', 'pro-co', 'owner-pro'),
       ('co-free', 'Free Co', 'free-co', 'owner-free')`,
  )
  await pool.query(
    `INSERT INTO computers
       (id, company_id, name, kind, available_engines, status, revoked_at)
     VALUES
       ('cloud-pro', 'co-pro', 'Cumora Cloud', 'cloud', '["managed"]', 'online', NULL),
       ('local-pro', 'co-pro', 'Laptop', 'local', '["codex"]', 'offline', NULL),
       ('revoked-pro', 'co-pro', 'Old laptop', 'local', '["codex"]', 'offline', NOW()),
       ('other-cloud', 'co-free', 'Other Cloud', 'cloud', '["managed"]', 'online', NULL)`,
  )
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, initial, avatar_bg, status, computer_id)
     VALUES
       ('agent-cloud', 'co-pro', 'agent', 'Cloud', 'C', '#111111', 'resting', 'cloud-pro'),
       ('agent-local', 'co-pro', 'agent', 'Local', 'L', '#222222', 'resting', 'local-pro'),
       ('agent-free', 'co-free', 'agent', 'Free', 'F', '#333333', 'resting', NULL),
       ('agent-revoked', 'co-pro', 'agent', 'Revoked', 'R', '#444444', 'resting', 'revoked-pro'),
       ('agent-cross', 'co-pro', 'agent', 'Cross', 'X', '#555555', 'resting', 'other-cloud')`,
  )
}

test('[integration] managed placement resolves host and tier from one tenant snapshot', async () => {
  await seedPlacementFixture()

  const cloud = await resolveAgentHost('agent-cloud')
  assert.deepEqual(cloud, {
    status: 'found',
    kind: 'cloud',
    computerId: 'cloud-pro',
    companyId: 'co-pro',
    tier: 'pro',
  })
  assert.deepEqual(await verifyManagedPodPlacement('agent-cloud'), {
    ok: true,
    companyId: 'co-pro',
    computerId: 'cloud-pro',
  })

  const byoa = await verifyManagedPodPlacement('agent-local')
  assert.equal(byoa.ok, false)
  if (!byoa.ok) assert.equal(byoa.code, 'placement_denied')

  const free = await verifyManagedPodPlacement('agent-free')
  assert.deepEqual(free, {
    ok: false,
    code: 'placement_denied',
    reason: 'managed pod denied: free tier is BYOA-only',
  })
})

test('[integration] invalid soft Computer references fail closed', async () => {
  await seedPlacementFixture()

  for (const agentId of ['agent-revoked', 'agent-cross']) {
    const host = await resolveAgentHost(agentId)
    assert.equal(host.status, 'error')
    if (host.status === 'error') assert.equal(host.code, 'invalid_assignment')

    const placement = await verifyManagedPodPlacement(agentId)
    assert.equal(placement.ok, false)
    if (!placement.ok) assert.equal(placement.code, 'placement_denied')
  }
})
