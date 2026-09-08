/**
 * The refusal reason survives every path that stores an engine snapshot.
 *
 * Three of them do: pairing a fresh computer, reconnecting an existing one, and
 * the periodic PATH rescan. Each sanitizes its own snapshot, so wiring one and
 * not the others is a silent hole — and the first cut of this feature had
 * exactly that hole, covering only the rescan. A card that stays blank for
 * minutes after pairing is blank during the one window in which someone is
 * actually asking why their engine is missing.
 *
 * These run against a real Postgres because the property is about the stored
 * row: `available_engines` picks an agent's adapter, `detected_engines` is
 * display. A blocked engine belongs in the second and must never appear in the
 * first, or the daemon would run precisely what the sandbox gate refused.
 *
 * Run: node --import tsx --test --test-concurrency=1 server/src/__integration__/blocked-engine-reason.test.ts
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { issuePairingCode, pairComputer, reportDetectedEngines } from '../agents/computer/registry.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

const OLD_CLAUDE = 'version 2.0.9 is older than the secure minimum 2.1.248'

interface StoredEngines {
  available: string[]
  detected: Array<{ id: string; blockedReason?: string | null; path?: string | null }>
}

async function seedCompany(): Promise<{ companyId: string; ownerUserId: string }> {
  const companyId = `co-${randomUUID().slice(0, 8)}`
  const ownerUserId = `u-${companyId}`
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'Owner') ON CONFLICT (id) DO NOTHING`,
    [ownerUserId, `${companyId}@example.com`],
  )
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $1, $1, $2)`,
    [companyId, ownerUserId],
  )
  return { companyId, ownerUserId }
}

async function storedEngines(computerId: string): Promise<StoredEngines> {
  const { rows } = await pool.query<StoredEngines>(
    `SELECT available_engines AS available, detected_engines AS detected
       FROM computers WHERE id = $1`,
    [computerId],
  )
  return rows[0]
}

/** What a daemon on a machine with a too-old Claude and a good Codex sends. */
const SNAPSHOT = [
  { id: 'codex', bin: 'codex', path: '/usr/local/bin/codex', version: '0.140.0' },
  { id: 'claude', bin: 'claude', path: '/usr/local/bin/claude', version: '2.0.9', blockedReason: OLD_CLAUDE },
]

test('[integration] pairing stores the refusal reason without making it runnable', async () => {
  const { companyId, ownerUserId } = await seedCompany()
  const { code } = await issuePairingCode({ companyId, ownerUserId })

  const paired = await pairComputer({
    code, hostName: 'Dev Mac', engines: ['codex'], detected: SNAPSHOT, blocked: ['claude'],
  })
  assert.ok(paired, 'pairing failed')

  const stored = await storedEngines(paired.computerId)
  // The whole point of the separation: an agent assigned to this computer
  // resolves its adapter from available_engines, so claude must not be there.
  assert.deepEqual(stored.available, ['codex'])
  const claude = stored.detected.find((e) => e.id === 'claude')
  assert.ok(claude, 'the refused engine should still be listed for display')
  assert.equal(claude.blockedReason, OLD_CLAUDE)
  // The path matters too — "installed, and here is where" is half of what makes
  // the reason actionable.
  assert.equal(claude.path, '/usr/local/bin/claude')
  assert.equal(stored.detected.find((e) => e.id === 'codex')?.blockedReason, null)
})

test('[integration] reconnecting the same computer keeps the reason', async () => {
  // A reconnect takes the other branch inside pairComputer, with its own
  // sanitize call. Wiring one branch and not the other would make the reason
  // appear at pairing and then vanish the next time the daemon restarted.
  const { companyId, ownerUserId } = await seedCompany()
  const first = await pairComputer({
    code: (await issuePairingCode({ companyId, ownerUserId })).code,
    hostName: 'Dev Mac', engines: ['codex'], detected: SNAPSHOT, blocked: ['claude'],
  })
  assert.ok(first)

  const { code } = await issueRepairCodeFor(first.computerId, companyId, ownerUserId)
  const again = await pairComputer({
    code, hostName: 'Dev Mac', engines: ['codex'], detected: SNAPSHOT, blocked: ['claude'],
  })
  assert.ok(again)
  assert.equal(again.computerId, first.computerId, 'reconnect should reuse the row')

  const stored = await storedEngines(first.computerId)
  assert.deepEqual(stored.available, ['codex'])
  assert.equal(stored.detected.find((e) => e.id === 'claude')?.blockedReason, OLD_CLAUDE)
})

test('[integration] the rescan report keeps the same separation', async () => {
  const { companyId, ownerUserId } = await seedCompany()
  const paired = await pairComputer({
    code: (await issuePairingCode({ companyId, ownerUserId })).code,
    hostName: 'Dev Mac', engines: ['codex', 'claude'], detected: SNAPSHOT,
  })
  assert.ok(paired)
  // Claude was runnable at pairing and is refused now — an in-place CLI
  // downgrade, or a newly enforced minimum. It has to leave available_engines
  // and arrive in the display list with its reason.
  await reportDetectedEngines({
    computerId: paired.computerId, engines: ['codex'], blocked: ['claude'], detected: SNAPSHOT,
  })

  const stored = await storedEngines(paired.computerId)
  assert.deepEqual(stored.available, ['codex'])
  assert.equal(stored.detected.find((e) => e.id === 'claude')?.blockedReason, OLD_CLAUDE)
})

test('[integration] fixing the cause clears the reason on the next report', async () => {
  // The reason is state, not a one-way flag: upgrading the CLI has to make the
  // card go quiet again without any other change.
  const { companyId, ownerUserId } = await seedCompany()
  const paired = await pairComputer({
    code: (await issuePairingCode({ companyId, ownerUserId })).code,
    hostName: 'Dev Mac', engines: ['codex'], detected: SNAPSHOT, blocked: ['claude'],
  })
  assert.ok(paired)
  assert.equal((await storedEngines(paired.computerId)).detected.find((e) => e.id === 'claude')?.blockedReason, OLD_CLAUDE)

  await reportDetectedEngines({
    computerId: paired.computerId,
    engines: ['codex', 'claude'],
    blocked: [],
    detected: [
      { id: 'codex', bin: 'codex', path: '/usr/local/bin/codex', version: '0.140.0' },
      { id: 'claude', bin: 'claude', path: '/usr/local/bin/claude', version: '2.1.250' },
    ],
  })

  const stored = await storedEngines(paired.computerId)
  assert.ok(stored.available.includes('claude'), 'the upgraded engine should be runnable again')
  assert.equal(stored.detected.find((e) => e.id === 'claude')?.blockedReason, null)
})

test('[integration] a daemon claiming a blocked engine is runnable does not get it both ways', async () => {
  // Belt and braces on the invariant, from the direction a buggy or hostile
  // daemon would come at it: sending the same id in both lists must not put a
  // refused engine into the list that picks an adapter.
  const { companyId, ownerUserId } = await seedCompany()
  const paired = await pairComputer({
    code: (await issuePairingCode({ companyId, ownerUserId })).code,
    hostName: 'Dev Mac', engines: ['codex'], detected: SNAPSHOT, blocked: ['claude'],
  })
  assert.ok(paired)
  await reportDetectedEngines({
    computerId: paired.computerId, engines: ['codex'], blocked: ['codex', 'claude'], detected: SNAPSHOT,
  })

  const stored = await storedEngines(paired.computerId)
  assert.deepEqual(stored.available, ['codex'], 'codex is runnable and must stay so')
  // Claimed as both: runnable wins, and it appears once rather than twice.
  assert.equal(stored.detected.filter((e) => e.id === 'codex').length, 1)
  assert.equal(stored.detected.find((e) => e.id === 'codex')?.blockedReason, null)
})

/** Mint a reconnect code for an existing computer row. */
async function issueRepairCodeFor(
  computerId: string, companyId: string, ownerUserId: string,
): Promise<{ code: string }> {
  const { issueRepairCode } = await import('../agents/computer/registry.js')
  const out = await issueRepairCode({ computerId, companyId, ownerUserId })
  assert.ok(out, 'could not mint a repair code')
  return out
}
