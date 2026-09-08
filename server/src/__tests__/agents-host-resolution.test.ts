import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import {
  managedPodPlacement,
  resolveAgentHost,
  type AgentHostResolution,
} from '../agents/computer/registry.js'
import { verifyManagedPodPlacement } from '../agents/runtime/orchestrator.js'

type HostDb = NonNullable<Parameters<typeof resolveAgentHost>[1]>

function fakeDb(rows: Record<string, unknown>[]): HostDb {
  return {
    query: async <T extends object>() => ({ rows: rows as T[] }),
  }
}

const paidCloudRow = {
  company_id: 'co-1',
  computer_id: 'cloud-co-1',
  runtime_assignment_id: 'assignment-1',
  resolved_computer_id: 'cloud-co-1',
  computer_company_id: 'co-1',
  kind: 'cloud',
  revoked_at: null,
  resolved_company_id: 'co-1',
  tier: 'pro',
}

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

test('resolveAgentHost distinguishes a missing agent from an unassigned paid agent', async () => {
  assert.deepEqual(await resolveAgentHost('missing', fakeDb([])), { status: 'missing' })

  const unassigned = await resolveAgentHost('agent-1', fakeDb([{
    ...paidCloudRow,
    computer_id: null,
    resolved_computer_id: null,
    computer_company_id: null,
    kind: null,
  }]))
  assert.deepEqual(unassigned, {
    status: 'found',
    kind: null,
    computerId: null,
    companyId: 'co-1',
    runtimeAssignmentId: 'assignment-1',
    tier: 'pro',
  })
})

test('resolveAgentHost reports database failure instead of synthesizing cloud placement', async () => {
  const db: HostDb = {
    query: async () => { throw new Error('database unavailable') },
  }
  const result = await resolveAgentHost('agent-1', db)
  assert.equal(result.status, 'error')
  if (result.status !== 'error') return
  assert.equal(result.code, 'lookup_failed')
  assert.match(result.reason, /host lookup failed/)
  assert.match(result.cause instanceof Error ? result.cause.message : '', /database unavailable/)
})

test('soft-reference corruption never falls back to managed cloud', async () => {
  const invalidRows = [
    { ...paidCloudRow, resolved_computer_id: null, kind: null },
    { ...paidCloudRow, computer_company_id: 'co-other' },
    { ...paidCloudRow, revoked_at: new Date() },
    { ...paidCloudRow, resolved_company_id: null },
  ]
  for (const row of invalidRows) {
    const result = await resolveAgentHost('agent-1', fakeDb([row]))
    assert.equal(result.status, 'error')
    if (result.status === 'error') assert.equal(result.code, 'invalid_assignment')
  }
})

test('managedPodPlacement permits only paid managed or explicit unassigned hosts', () => {
  const found = (overrides: Partial<Extract<AgentHostResolution, { status: 'found' }>> = {}) => ({
    status: 'found' as const,
    kind: 'cloud' as const,
    computerId: 'cloud-co-1',
    companyId: 'co-1',
    runtimeAssignmentId: 'assignment-1',
    tier: 'pro' as const,
    ...overrides,
  })

  assert.deepEqual(managedPodPlacement(found()), {
    status: 'allowed', companyId: 'co-1', computerId: 'cloud-co-1', runtimeAssignmentId: 'assignment-1',
  })
  assert.deepEqual(managedPodPlacement(found({ kind: null, computerId: null })), {
    status: 'allowed', companyId: 'co-1', computerId: null, runtimeAssignmentId: 'assignment-1',
  })
  assert.equal(managedPodPlacement(found({ kind: 'local' })).status, 'denied')
  assert.equal(managedPodPlacement(found({ kind: 'vps' })).status, 'denied')
  assert.equal(managedPodPlacement(found({ tier: 'free' })).status, 'denied')
  assert.equal(managedPodPlacement({ status: 'missing' }).status, 'denied')
})

test('ensurePod placement guard converts resolver throws into a fail-closed retry code', async () => {
  const denied = await verifyManagedPodPlacement('agent-1', async () => {
    throw new Error('transient connection reset')
  })
  assert.deepEqual(denied, {
    ok: false,
    code: 'placement_lookup_failed',
    reason: 'host lookup failed for agent agent-1',
  })
})
