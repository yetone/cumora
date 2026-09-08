import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { addConversationMember } from '../agents/membership.js'
import { pool } from '../db/pool.js'
import {
  ensureSchemaOnce,
  resetAllTables,
  seedCompanyWithAgent,
  teardownAll,
} from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function seedGroup(companyId: string, members: string[]): Promise<string> {
  const conversationId = `conv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', 'normalized membership', $3::jsonb)`,
    [conversationId, companyId, JSON.stringify(members)],
  )
  return conversationId
}

test('[integration] tenant FKs reject a foreign participant membership', async () => {
  const tenantA = await seedCompanyWithAgent({ agentId: 'normalized-a' })
  const tenantB = await seedCompanyWithAgent({ agentId: 'normalized-b' })
  const conversationId = await seedGroup(tenantA.companyId, [tenantA.agentId])

  await assert.rejects(
    () => pool.query(
      `INSERT INTO conversation_members
         (conversation_id, company_id, participant_id, ordinal)
       VALUES ($1, $2, $3, 1)`,
      [conversationId, tenantA.companyId, tenantB.agentId],
    ),
    (error) => (error as { code?: string }).code === '23503',
  )

  const { rows } = await pool.query<{ participant_id: string }>(
    `SELECT participant_id FROM conversation_members
      WHERE conversation_id = $1 ORDER BY ordinal`,
    [conversationId],
  )
  assert.deepEqual(rows.map((row) => row.participant_id), [tenantA.agentId])
})

test('[integration] legacy JSONB writes synchronize into the normalized truth during expand', async () => {
  const tenant = await seedCompanyWithAgent({ agentId: 'projection-owner' })
  const peer = await seedCompanyWithAgent({
    companyId: tenant.companyId,
    agentId: 'projection-peer',
  })
  const conversationId = await seedGroup(tenant.companyId, [
    tenant.agentId,
    'external:sender@example.com',
  ])

  const { rows: initial } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1`,
    [conversationId],
  )
  assert.deepEqual(initial[0].members, [tenant.agentId])

  await pool.query(
    `UPDATE conversations SET members = $2::jsonb WHERE id = $1`,
    [conversationId, JSON.stringify([
      tenant.agentId,
      peer.agentId,
      'external:another@example.com',
    ])],
  )

  const { rows: synchronized } = await pool.query<{ members: string[]; normalized: string[] }>(
    `SELECT c.members,
            ARRAY(
              SELECT member.participant_id FROM conversation_members member
               WHERE member.conversation_id = c.id ORDER BY member.ordinal
            ) AS normalized
       FROM conversations c WHERE c.id = $1`,
    [conversationId],
  )
  assert.deepEqual(synchronized[0], {
    members: [tenant.agentId, peer.agentId],
    normalized: [tenant.agentId, peer.agentId],
  })

  await assert.rejects(
    () => pool.query(
      `UPDATE conversations SET members = '["missing-participant"]'::jsonb WHERE id = $1`,
      [conversationId],
    ),
    (error) => (error as { code?: string }).code === '23503',
  )

  const { rows: unchanged } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1`,
    [conversationId],
  )
  assert.deepEqual(unchanged[0].members, [tenant.agentId, peer.agentId])
})

test('[integration] membership, audit message, and realtime outbox roll back together', async () => {
  const tenant = await seedCompanyWithAgent({ agentId: 'atomic-owner' })
  const target = await seedCompanyWithAgent({
    companyId: tenant.companyId,
    agentId: 'atomic-target',
  })
  const conversationId = await seedGroup(tenant.companyId, [tenant.agentId])

  await pool.query(`
    CREATE FUNCTION ar_h3_reject_realtime_outbox()
    RETURNS TRIGGER LANGUAGE plpgsql AS $test$
    BEGIN
      RAISE EXCEPTION 'forced realtime outbox failure';
    END
    $test$;
    CREATE TRIGGER ar_h3_reject_realtime_outbox
      BEFORE INSERT ON realtime_outbox
      FOR EACH ROW EXECUTE FUNCTION ar_h3_reject_realtime_outbox();
  `)
  try {
    await assert.rejects(
      () => addConversationMember({
        conversationId,
        companyId: tenant.companyId,
        actorId: tenant.agentId,
        memberId: target.agentId,
      }),
      /forced realtime outbox failure/,
    )
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS ar_h3_reject_realtime_outbox ON realtime_outbox`)
    await pool.query(`DROP FUNCTION IF EXISTS ar_h3_reject_realtime_outbox()`)
  }

  const { rows } = await pool.query<{
    members: string[]; membership_count: number; message_count: number; outbox_count: number
  }>(
    `SELECT c.members,
            (SELECT COUNT(*)::int FROM conversation_members member
              WHERE member.conversation_id = c.id) AS membership_count,
            (SELECT COUNT(*)::int FROM messages message
              WHERE message.conversation_id = c.id) AS message_count,
            (SELECT COUNT(*)::int FROM realtime_outbox) AS outbox_count
       FROM conversations c WHERE c.id = $1`,
    [conversationId],
  )
  assert.deepEqual(rows[0], {
    members: [tenant.agentId],
    membership_count: 1,
    message_count: 0,
    outbox_count: 0,
  })
})
