/**
 * Integration tests for the two server-side backstops that stop
 * agents from monologuing or doing duplicate work:
 *
 *   1. Anti-monologue gate in cmdReply — same agent can't post twice
 *      in a row in a multi-party convo until someone else speaks.
 *   2. Worklog claims (claimWork / releaseWork / peekWorklog) — same
 *      (taskType, subject) within a tenant scope blocks duplicate
 *      heavy work until released or TTL expires.
 *
 * Both are agent-judgment backstops that exist because the LLM-side
 * "should I keep talking / should I do this thing" prompt rules
 * repeatedly fail in practice. The tests pin the contract.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { redis } from '../redis.js'
import {
  ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll,
} from './_helpers.js'
import { runCli } from '../agents/cli.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
  // Wipe any worklog state from the previous test so claims don't
  // leak across test boundaries. SCAN+DEL because we use HASH keys
  // that FLUSHDB at the schema level doesn't touch.
  for await (const keys of redis.scanStream({ match: 'cumora:worklog:*', count: 100 })) {
    if (keys.length > 0) await redis.del(...keys)
  }
})

after(async () => {
  await teardownAll()
})

async function seedGroupWithTwoAgents(): Promise<{
  companyId: string; agentA: string; agentB: string; humanId: string; convoId: string;
}> {
  const { companyId, agentId: agentA } = await seedCompanyWithAgent()
  const agentB = `a-${randomUUID().slice(0, 8)}`
  const humanId = `h-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail')`,
    [agentB, companyId, `Agent ${agentB}`, 'B'],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')`,
    [humanId, companyId, humanId, 'H'],
  )
  const convoId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'group', $2, $3::jsonb, 'group', $4)`,
    [convoId, 'Anti-monologue test', JSON.stringify([agentA, agentB, humanId]), companyId],
  )
  return { companyId, agentA, agentB, humanId, convoId }
}

test('[integration] cmdReply blocks consecutive posts from the same agent in a group', async () => {
  const { agentA, agentB, convoId } = await seedGroupWithTwoAgents()

  // First post: succeeds, no prior history.
  const first = await runCli(['--as', agentA, 'reply', convoId, 'first message from A'])
  assert.equal(first.ok, true, `first reply should succeed: ${first.text}`)

  // Second post from same agent without anyone else speaking: blocked.
  const second = await runCli(['--as', agentA, 'reply', convoId, 'second from A — adding to my point'])
  assert.equal(second.ok, false, 'second consecutive reply should be blocked')
  assert.match(second.text, /you already posted/i)
  assert.match(second.text, /until someone else speaks/i)

  // After agent B breaks the chain, agent A may post again — but the
  // seen-cursor freshness gate runs FIRST: A has not SEEN B's
  // message yet, so A's first attempt is HELD (the hold shows the message and
  // advances A's cursor past it), and a plain resend then goes through with
  // no flag. This two-step IS the coordination contract (reply from real
  // posted state, never from a stale snapshot) — pin it.
  const fromB = await runCli(['--as', agentB, 'reply', convoId, 'B chimes in'])
  assert.equal(fromB.ok, true, `B's reply should succeed: ${fromB.text}`)

  const heldFromA = await runCli(['--as', agentA, 'reply', convoId, 'A again after B spoke'])
  assert.equal(heldFromA.ok, false, 'A\'s first attempt after B spoke is HELD (unseen peer message)')
  assert.match(heldFromA.text, /HELD/, 'the hold names itself')
  assert.match(heldFromA.text, /B chimes in/, 'the hold SHOWS the unseen message')

  const thirdFromA = await runCli(['--as', agentA, 'reply', convoId, 'A again after B spoke'])
  assert.equal(thirdFromA.ok, true, `plain resend after the hold should go through: ${thirdFromA.text}`)
})

test('[integration] --continue bypass overrides the anti-monologue gate', async () => {
  const { agentA, convoId } = await seedGroupWithTwoAgents()

  await runCli(['--as', agentA, 'reply', convoId, 'first'])
  const blocked = await runCli(['--as', agentA, 'reply', convoId, 'second'])
  assert.equal(blocked.ok, false)

  const bypassed = await runCli(['--as', agentA, 'reply', convoId, 'urgent correction', '--continue'])
  assert.equal(bypassed.ok, true, `--continue should bypass the gate: ${bypassed.text}`)
})

test('[integration] a human can post immediately after inviting an agent', async () => {
  const { companyId, humanId, convoId } = await seedGroupWithTwoAgents()
  const invitedId = `a-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', 'C', '#abcdef', 'avail')`,
    [invitedId, companyId, `Agent ${invitedId}`],
  )

  const invited = await runCli(['--as', humanId, 'invite', convoId, invitedId])
  assert.equal(invited.ok, true, `invite should succeed: ${invited.text}`)

  const followUp = await runCli([
    '--as', humanId, 'reply', convoId, `@${invitedId} please review the synthetic task`,
  ])
  assert.equal(
    followUp.ok,
    true,
    `the agent-only anti-monologue gate must not block a human follow-up: ${followUp.text}`,
  )
})

test('[integration] DM (2-member convo) is exempt from the anti-monologue gate', async () => {
  const { companyId, agentId: agentA } = await seedCompanyWithAgent()
  const humanId = `h-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')`,
    [humanId, companyId, humanId, 'H'],
  )
  const convoId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'direct', $2, $3::jsonb, 'human', $4)`,
    [convoId, humanId, JSON.stringify([agentA, humanId]), companyId],
  )

  // Even two posts in a row in a DM should succeed — DMs are explicitly
  // exempt because real-world follow-ups happen.
  const first = await runCli(['--as', agentA, 'reply', convoId, 'hi'])
  assert.equal(first.ok, true)
  const second = await runCli(['--as', agentA, 'reply', convoId, 'one more thing'])
  assert.equal(second.ok, true, `DM follow-up should not be blocked: ${second.text}`)
})

test('[unit] claimWork is atomic: first caller wins, second sees the existing entry', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  const first = await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'web-search', subject: 'warm pastels',
  })
  assert.equal(first.accepted, true)

  const second = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'web-search', subject: 'warm pastels',
  })
  assert.equal(second.accepted, false)
  if (second.accepted === false) {
    assert.equal(second.existing.agentId, 'iris')
    assert.equal(second.existing.taskType, 'web-search')
    assert.equal(second.existing.subject, 'warm pastels')
    assert.equal(typeof second.existing.startedAt, 'number')
  }
})

test('[unit] claimWork normalizes subjects so trivial rephrasing still collides', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  const first = await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'web-search', subject: 'Warm  Pastels',
  })
  assert.equal(first.accepted, true)

  // Different capitalization + extra whitespace should normalize to the
  // same dedup key and collide.
  const second = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'web-search', subject: 'warm pastels',
  })
  assert.equal(second.accepted, false)
})

test('[unit] releaseWork frees the slot only for the holder', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'doc-create', subject: 'Q3 plan',
  })

  // Bram tries to release Iris's claim — must be a no-op.
  await inprocClient.releaseWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'Q3 plan',
  })
  const stillHeld = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'Q3 plan',
  })
  assert.equal(stillHeld.accepted, false, 'Bram should NOT be able to release-then-grab')

  // Iris releases her own claim — now Bram can take it.
  await inprocClient.releaseWork({
    scopeKey, agentId: 'iris', taskType: 'doc-create', subject: 'Q3 plan',
  })
  const bramTakesIt = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'Q3 plan',
  })
  assert.equal(bramTakesIt.accepted, true, 'After Iris releases, Bram should get the claim')
})

test('[unit] peekWorklog returns all live entries sorted by start time', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'web-search', subject: 'first',
  })
  // Small delay so timestamps differ.
  await new Promise((r) => setTimeout(r, 5))
  await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'second',
  })

  const entries = await inprocClient.peekWorklog(scopeKey)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].subject, 'first')
  assert.equal(entries[1].subject, 'second')
  assert.ok(entries[0].startedAt <= entries[1].startedAt)
})

test('[integration] worklog blocks a duplicate heavy-tool claim from a peer', async () => {
  const { companyId, agentA, agentB } = await seedGroupWithTwoAgents()
  const scopeKey = `tenant:${companyId}`

  // Pre-claim as if agentA had just started searching. We avoid
  // actually calling web_search (which would hit the live tool) by
  // pre-seeding the worklog directly, then checking that agentB's
  // attempt at the same subject is blocked.
  const seeded = await inprocClient.claimWork({
    scopeKey, agentId: agentA, taskType: 'web-search', subject: 'audio editor competitive analysis',
  })
  assert.equal(seeded.accepted, true)

  // A peer sees the live claim and yields before attempting the same
  // expensive operation. Browser research now lives in the agent runtime,
  // so pin the shared worklog contract instead of a deleted CLI command.
  const duplicate = await inprocClient.claimWork({
    scopeKey, agentId: agentB, taskType: 'web-search', subject: 'audio editor competitive analysis',
  })
  assert.equal(duplicate.accepted, false, 'duplicate heavy work should be blocked')
  if (duplicate.accepted === false) {
    assert.equal(duplicate.existing.agentId, agentA)
    assert.equal(duplicate.existing.taskType, 'web-search')
  }

  // Cleanup.
  await inprocClient.releaseWork({
    scopeKey, agentId: agentA, taskType: 'web-search', subject: 'audio editor competitive analysis',
  })
})
