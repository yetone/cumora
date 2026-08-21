import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { runCli } from '../agents/cli.js'
import {
  ensureSchemaOnce,
  resetAllTables,
  seedCompanyWithAgent,
  seedUserMembership,
  teardownAll,
} from './_helpers.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll()
})

test('[integration] a human participant can open a CLI DM with an agent', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent({ agentId: 'reviewer' })
  const humanId = 'human-owner'
  await seedUserMembership(humanId, companyId, { displayName: 'Human Owner' })

  const result = await runCli([
    '--as', humanId, 'dm', agentId, 'Synthetic review', 'Please review the synthetic task.',
  ])

  assert.equal(result.ok, true, `human-authored DM should succeed: ${result.text}`)
  const { rows: conversations } = await pool.query<{ id: string; members: string[] }>(
    `SELECT id, members FROM conversations
      WHERE kind = 'direct'
        AND members @> $1::jsonb
        AND members @> $2::jsonb
        AND jsonb_array_length(members) = 2`,
    [JSON.stringify([humanId]), JSON.stringify([agentId])],
  )
  assert.equal(conversations.length, 1)
  assert.deepEqual(new Set(conversations[0].members), new Set([humanId, agentId]))

  const { rows: messages } = await pool.query<{ author_id: string; body: string }>(
    `SELECT author_id, body FROM messages
      WHERE conversation_id = $1 ORDER BY sequence`,
    [conversations[0].id],
  )
  assert.deepEqual(messages, [
    { author_id: humanId, body: 'Please review the synthetic task.' },
  ])
})
