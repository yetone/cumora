import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import {
  claimPrimary,
  getClaim,
  sweepRoutingClaimsOnce,
} from '../agents/routing-claims.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll()
})

const COMPANY_ID = 'co-routing-test'
const USER_ID = 'u-routing-test'
const CONVERSATION_ID = 'conv-routing-test'
const AGENT_A = 'agent-routing-a'
const AGENT_B = 'agent-routing-b'

async function seedFixture() {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, 'Routing Co', $1, $2)`,
    [COMPANY_ID, USER_ID],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, initial, avatar_bg, status)
     VALUES ($1, $2, 'agent', 'Agent A', 'A', '#112233', 'avail'),
            ($3, $2, 'agent', 'Agent B', 'B', '#445566', 'avail')`,
    [AGENT_A, COMPANY_ID, AGENT_B],
  )
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', 'Routing Channel', $3::jsonb)`,
    [CONVERSATION_ID, COMPANY_ID, JSON.stringify([AGENT_A, AGENT_B])],
  )
}

test('[integration] routing-claims: claimPrimary persists claim with cursor_advanced_at and handles re-delivery', async () => {
  await seedFixture()
  const messageId = 'msg-claim-1'

  const claim = await claimPrimary({
    messageId,
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    orderedCandidates: [AGENT_A, AGENT_B],
  })

  assert.ok(claim)
  assert.equal(claim.messageId, messageId)
  assert.equal(claim.status, 'pending')
  assert.equal(claim.cursor, 0)
  assert.deepEqual(claim.candidates, [AGENT_A, AGENT_B])

  const fetched = await getClaim(messageId)
  assert.ok(fetched)
  assert.equal(fetched.messageId, messageId)
  assert.ok(fetched.cursorAdvancedAt instanceof Date)

  // Re-delivery returns existing row without inserting a new one
  const reDelivery = await claimPrimary({
    messageId,
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    orderedCandidates: [AGENT_B, AGENT_A],
  })
  assert.ok(reDelivery)
  assert.deepEqual(reDelivery.candidates, [AGENT_A, AGENT_B])
})

test('[integration] routing-claims: sweep executes CTE without syntax errors and advances quiet candidate', async () => {
  await seedFixture()
  const messageId = 'msg-sweep-1'

  await claimPrimary({
    messageId,
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    orderedCandidates: [AGENT_A, AGENT_B],
  })

  // Expire the lease in the past
  await pool.query(
    `UPDATE agent_routing_claims
        SET lease_expires_at = NOW() - INTERVAL '10 seconds'
      WHERE message_id = $1`,
    [messageId],
  )

  // Sweep runs on real Postgres — CTE with FOR UPDATE SKIP LOCKED must execute cleanly
  const decisions = await sweepRoutingClaimsOnce({
    hasRunSince: async () => false, // Primary started no run
  })

  assert.equal(decisions.length, 1)
  assert.deepEqual(decisions[0], {
    kind: 'advance',
    agentId: AGENT_B,
    conversationId: CONVERSATION_ID,
  })

  const updated = await getClaim(messageId)
  assert.equal(updated?.cursor, 1)
  assert.equal(updated?.status, 'pending')
})

test('[integration] routing-claims: sweep marks claim served when candidate has run since advance timestamp', async () => {
  await seedFixture()
  const messageId = 'msg-sweep-served'

  await claimPrimary({
    messageId,
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    orderedCandidates: [AGENT_A, AGENT_B],
  })

  await pool.query(
    `UPDATE agent_routing_claims
        SET lease_expires_at = NOW() - INTERVAL '10 seconds'
      WHERE message_id = $1`,
    [messageId],
  )

  let evaluatedSince: any = null
  const decisions = await sweepRoutingClaimsOnce({
    hasRunSince: async (_agentId, since) => {
      evaluatedSince = since
      return true
    },
  })

  assert.equal(decisions.length, 0)
  assert.ok(evaluatedSince)
  assert.ok(evaluatedSince instanceof Date)

  const updated = await getClaim(messageId)
  assert.equal(updated?.status, 'served')
})

test('[integration] routing-claims: sweep exhausts and falls back to full-room fanout when all candidates go quiet', async () => {
  await seedFixture()
  const messageId = 'msg-sweep-exhaust'

  await claimPrimary({
    messageId,
    companyId: COMPANY_ID,
    conversationId: CONVERSATION_ID,
    orderedCandidates: [AGENT_A, AGENT_B],
  })

  // Set cursor to 1 (last candidate) and expire lease
  await pool.query(
    `UPDATE agent_routing_claims
        SET cursor = 1, lease_expires_at = NOW() - INTERVAL '10 seconds'
      WHERE message_id = $1`,
    [messageId],
  )

  const decisions = await sweepRoutingClaimsOnce({
    hasRunSince: async () => false,
  })

  assert.equal(decisions.length, 1)
  assert.deepEqual(decisions[0], {
    kind: 'exhaust',
    conversationId: CONVERSATION_ID,
    room: [AGENT_A, AGENT_B],
  })

  const updated = await getClaim(messageId)
  assert.equal(updated?.status, 'exhausted')
})
