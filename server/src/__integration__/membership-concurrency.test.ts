/**
 * Concurrent membership changes must not lose each other.
 *
 * Membership is normalized into tenant-constrained rows. Every mutation locks
 * the active participant rows and conversation in one order, changes one
 * membership row, rebuilds the JSON compatibility projection, and commits its
 * system message plus realtime outbox row in the same transaction.
 *
 * This is a hot path here rather than a theoretical one: the scheduler wakes
 * several agents for the same message, and `cumora invite` / `leave` / `kick`
 * are things those agents do in response. Concurrency is the normal case.
 *
 * These tests keep two real PostgreSQL clients on opposing lock queues. They
 * therefore cover lost updates, stale authorization, duplicate invites, and
 * the transcript/routing divergence that the old JSONB source allowed.
 *
 * Only a real Postgres can show this: it is about what two overlapping
 * statements do to one row.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import { runCli } from '../agents/cli.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'
import {
  handlePollUpdated, resolveDurableDeliveryAgent, triageWakeRecipient,
} from '../agents/scheduler.js'
import { joinAllHands } from '../onboardCompany.js'
import { resolveWsEventRecipientUserIds } from '../ws.js'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables,
  seedCompanyWithAgent, seedUserMembership, teardownAll,
} from './_helpers.js'

const HTTP_A = 'human-http-a'
const HTTP_B = 'human-http-b'
const httpServers: Server[] = []
const httpBaseUrls: string[] = []

before(async () => {
  await ensureSchemaOnce()
  for (const userId of [HTTP_A, HTTP_B]) {
    const app = await buildApiTestApp(userId)
    await new Promise<void>((resolve) => {
      const server = createServer(app).listen(0, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') httpBaseUrls.push(`http://127.0.0.1:${addr.port}`)
        httpServers.push(server)
        resolve()
      })
    })
  }
})
beforeEach(async () => { await resetAllTables() })
after(async () => {
  await Promise.all(httpServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await teardownAll()
})

async function seedAgent(companyId: string, id: string): Promise<string> {
  await seedCompanyWithAgent({ companyId, agentId: id })
  return id
}

async function seedGroup(companyId: string, members: string[]): Promise<string> {
  const convoId = `conv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', 'race', $3::jsonb)`,
    [convoId, companyId, JSON.stringify(members)],
  )
  return convoId
}

async function membersOf(convoId: string): Promise<string[]> {
  const { rows } = await pool.query<{ members: string[] }>(
    `SELECT COALESCE(
              ARRAY_AGG(participant_id ORDER BY ordinal),
              ARRAY[]::text[]
            ) AS members
       FROM conversation_members
      WHERE conversation_id = $1`,
    [convoId],
  )
  return rows[0]?.members ?? []
}

async function removeMemberWithClient(
  client: PoolClient,
  conversationId: string,
  participantId: string,
  companyId?: string,
): Promise<void> {
  await client.query(
    `DELETE FROM conversation_members
      WHERE conversation_id = $1
        AND participant_id = $2
        AND ($3::text IS NULL OR company_id = $3)`,
    [conversationId, participantId, companyId ?? null],
  )
  await client.query(`SELECT refresh_conversation_members_projection($1)`, [conversationId])
}

async function removeMember(
  conversationId: string,
  participantId: string,
  companyId?: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await removeMemberWithClient(client, conversationId, participantId, companyId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function detachParticipantWithClient(
  client: PoolClient,
  participantId: string,
  companyId: string,
): Promise<void> {
  const { rows } = await client.query<{ conversation_id: string }>(
    `DELETE FROM conversation_members
      WHERE participant_id = $1 AND company_id = $2
      RETURNING conversation_id`,
    [participantId, companyId],
  )
  for (const conversationId of new Set(rows.map((row) => row.conversation_id))) {
    await client.query(`SELECT refresh_conversation_members_projection($1)`, [conversationId])
  }
}

async function noticesOf(convoId: string): Promise<Array<{ kind?: string; participantId?: string }>> {
  const { rows } = await pool.query<{ body: string }>(
    `SELECT body FROM messages WHERE conversation_id = $1 AND kind = 'system'`, [convoId],
  )
  return rows.map(({ body }) => JSON.parse(body) as { kind?: string; participantId?: string })
}

async function waitForBlockedQuery(pattern: string, minimum: number = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1`,
      [pattern],
    )
    if ((rows[0]?.count ?? 0) >= minimum) return
    await delay(10)
  }
  throw new Error(`query never reached the expected row lock: ${pattern}`)
}

async function waitForBlockedMembershipUpdate(_fragment: 'members ||' | 'members -'): Promise<void> {
  await waitForBlockedQuery('%SELECT c.id%FROM conversations c%FOR UPDATE OF c%')
}

async function waitForBlockedMembershipGuards(minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND (
            query ILIKE '%SELECT c.id%FROM conversations c%FOR UPDATE OF c%'
            OR query ILIKE '%FROM participants%FOR UPDATE%'
          )`,
    )
    if ((rows[0]?.count ?? 0) >= minimum) return
    await delay(10)
  }
  throw new Error(`membership requests never reached ${minimum} blocked guards`)
}

test('[integration] simultaneous invites do not lose an invitee', async () => {
  // Eight at once rather than two: a single overlapping pair only sometimes
  // interleaves inside the read→write window on a local socket, and a test
  // that passes on the broken code proves nothing. With eight, a
  // last-write-wins array loses several every run.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const host = await seedAgent(companyId, 'agent-host')
  const invitees = await Promise.all(
    Array.from({ length: 8 }, (_, i) => seedAgent(companyId, `agent-i${i}`)),
  )
  const convo = await seedGroup(companyId, [host])

  const results = await Promise.all(
    invitees.map((who) => runCli(['--as', host, 'invite', convo, who])),
  )
  for (const [i, r] of results.entries()) {
    assert.equal(r.ok, true, `invite ${invitees[i]} failed: ${r.text}`)
  }

  // Every invite reported success, so every invitee must actually be a member.
  // Before the fix several were missing while their `joined` rows still stood,
  // and their normalized mailbox membership never matched again.
  const members = await membersOf(convo)
  const missing = invitees.filter((who) => !members.includes(who))
  assert.deepEqual(missing, [], `dropped despite reporting success: ${JSON.stringify(missing)}`)
  assert.equal(new Set(members).size, members.length, `duplicate members: ${JSON.stringify(members)}`)
})

test('[integration] a leave that overlaps an invite keeps both effects', async () => {
  // The worst ordering: whoever writes last resurrects or erases the other.
  // Either the leaver is put back into a conversation they left, or the
  // invitee never lands — both leave the transcript disagreeing with the row.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const b = await seedAgent(companyId, 'agent-b')
  const x = await seedAgent(companyId, 'agent-x')
  const convo = await seedGroup(companyId, [a, b])

  const [leave, invite] = await Promise.all([
    runCli(['--as', a, 'leave', convo]),
    runCli(['--as', b, 'invite', convo, x]),
  ])
  assert.equal(leave.ok, true, `leave failed: ${leave.text}`)
  assert.equal(invite.ok, true, `invite failed: ${invite.text}`)

  const members = await membersOf(convo)
  assert.ok(!members.includes(a), `${a} left but is still a member: ${JSON.stringify(members)}`)
  assert.ok(members.includes(x), `${x} was invited but is not a member: ${JSON.stringify(members)}`)
  assert.ok(members.includes(b))
})

test('[integration] a kick that overlaps an invite cannot resurrect the revoked member', async () => {
  // This is the exact authorization failure mode: a stale whole-array invite
  // write used to put a concurrently kicked participant back into `members`,
  // immediately restoring access to the private conversation.
  for (let round = 0; round < 8; round++) {
    const companyId = `c-${randomUUID().slice(0, 8)}`
    const a = await seedAgent(companyId, `agent-a-${round}`)
    const b = await seedAgent(companyId, `agent-b-${round}`)
    const revoked = await seedAgent(companyId, `agent-revoked-${round}`)
    const invited = await seedAgent(companyId, `agent-invited-${round}`)
    const convo = await seedGroup(companyId, [a, b, revoked])

    const [kick, invite] = await Promise.all([
      runCli(['--as', a, 'kick', convo, revoked]),
      runCli(['--as', b, 'invite', convo, invited]),
    ])
    assert.equal(kick.ok, true, `round ${round} kick failed: ${kick.text}`)
    assert.equal(invite.ok, true, `round ${round} invite failed: ${invite.text}`)

    const members = await membersOf(convo)
    assert.ok(!members.includes(revoked), `round ${round}: revoked member resurrected: ${JSON.stringify(members)}`)
    assert.ok(members.includes(invited), `round ${round}: concurrent invite was lost: ${JSON.stringify(members)}`)
  }
})

test('[integration] real HTTP leave and members routes preserve both concurrent effects', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'HTTP membership race', $2, $3)`,
    [companyId, companyId, HTTP_A],
  )
  const invited = 'human-http-invited'
  await seedUserMembership(HTTP_A, companyId)
  await seedUserMembership(HTTP_B, companyId)
  await seedUserMembership(invited, companyId)

  // Several independent rows make the old read/modify/write implementation
  // fail reliably without test-only hooks in production SQL.
  for (let round = 0; round < 8; round++) {
    const convo = await seedGroup(companyId, [HTTP_A, HTTP_B])
    const [leaveResponse, inviteResponse] = await Promise.all([
      fetch(`${httpBaseUrls[0]}/api/conversations/${convo}/leave`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-id': companyId },
        body: '{}',
      }),
      fetch(`${httpBaseUrls[1]}/api/conversations/${convo}/members`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-id': companyId },
        body: JSON.stringify({ id: invited }),
      }),
    ])
    assert.equal(leaveResponse.status, 200, `round ${round} leave: ${await leaveResponse.text()}`)
    assert.equal(inviteResponse.status, 200, `round ${round} invite: ${await inviteResponse.text()}`)

    const members = await membersOf(convo)
    assert.ok(!members.includes(HTTP_A), `round ${round}: HTTP leave was reverted: ${JSON.stringify(members)}`)
    assert.ok(members.includes(invited), `round ${round}: HTTP invite was lost: ${JSON.stringify(members)}`)
    assert.ok(members.includes(HTTP_B))

    const notices = await noticesOf(convo)
    assert.ok(notices.some((body) => body.kind === 'left' && body.participantId === HTTP_A))
    assert.ok(notices.some((body) => body.kind === 'joined' && body.participantId === invited))
  }
})

test('[integration] a revoked HTTP actor cannot finish a stale invite or emit a joined notice', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'HTTP actor revocation', $2, $3)`,
    [companyId, companyId, HTTP_A],
  )
  const invited = 'human-http-late-invite'
  await seedUserMembership(HTTP_A, companyId)
  await seedUserMembership(HTTP_B, companyId)
  await seedUserMembership(invited, companyId)
  const convo = await seedGroup(companyId, [HTTP_A, HTTP_B])

  // Hold an uncommitted revocation on the row. The route's initial SELECT sees
  // the old committed membership and passes; its UPDATE then blocks behind us.
  // Once the kick commits, Postgres must re-check actor membership in the
  // UPDATE predicate and reject the stale request.
  const revoker = await pool.connect()
  let committed = false
  let pending: Promise<Response> | undefined
  try {
    await revoker.query('BEGIN')
    await removeMemberWithClient(revoker, convo, HTTP_A)
    pending = fetch(`${httpBaseUrls[0]}/api/conversations/${convo}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-company-id': companyId },
      body: JSON.stringify({ id: invited }),
    })
    await waitForBlockedMembershipUpdate('members ||')
    await revoker.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await revoker.query('ROLLBACK').catch(() => {})
    revoker.release()
  }

  const response = await pending!
  assert.equal(response.status, 403, await response.text())
  const members = await membersOf(convo)
  assert.ok(!members.includes(HTTP_A))
  assert.ok(!members.includes(invited), `revoked actor added ${invited}: ${JSON.stringify(members)}`)
  assert.ok(!(await noticesOf(convo)).some((body) => body.kind === 'joined' && body.participantId === invited))
})

test('[integration] a revoked HTTP actor cannot finish a stale text message write', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'HTTP message revocation', $2, $3)`,
    [companyId, companyId, HTTP_A],
  )
  await seedUserMembership(HTTP_A, companyId)
  await seedUserMembership(HTTP_B, companyId)
  const convo = await seedGroup(companyId, [HTTP_A, HTTP_B])

  const revoker = await pool.connect()
  let committed = false
  let pending: Promise<Response> | undefined
  try {
    await revoker.query('BEGIN')
    await removeMemberWithClient(revoker, convo, HTTP_A)
    pending = fetch(`${httpBaseUrls[0]}/api/conversations/${convo}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-company-id': companyId },
      body: JSON.stringify({ body: 'must-not-land-after-kick' }),
    })
    await waitForBlockedQuery('%SELECT c.kind FROM conversations c%FOR UPDATE OF c%')
    await revoker.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await revoker.query('ROLLBACK').catch(() => {})
    revoker.release()
  }

  const response = await pending!
  assert.equal(response.status, 403, await response.text())
  const leaked = await pool.query(
    `SELECT 1 FROM messages WHERE conversation_id = $1 AND body = $2`,
    [convo, 'must-not-land-after-kick'],
  )
  assert.equal(leaked.rowCount, 0)
})

test('[integration] a revoked HTTP email reply is rejected before the provider call', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'HTTP email revocation', $2, $3)`,
    [companyId, companyId, HTTP_A],
  )
  await seedUserMembership(HTTP_A, companyId)
  await seedUserMembership(HTTP_B, companyId)
  const senderAddress = `${HTTP_A}.${companyId}@cumora.local`
  await pool.query(
    `UPDATE participants SET email = $1 WHERE id = $2 AND company_id = $3`,
    [senderAddress, HTTP_A, companyId],
  )
  const convo = `email-${randomUUID().slice(0, 8)}`
  const inboundId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1,$2,'email','revocation thread',$3::jsonb)`,
    [convo, companyId, JSON.stringify([HTTP_A, HTTP_B])],
  )
  await pool.query(
    `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1,2)`,
    [convo],
  )
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1,$2,'external:alice','email','old mail',1,$3)`,
    [inboundId, convo, companyId],
  )
  await pool.query(
    `INSERT INTO email_messages
       (message_id, conversation_id, company_id, direction, transport_status,
        smtp_message_id, subject, from_addr, to_addrs)
     VALUES ($1,$2,$3,'in','received','old-mail@example.com','secret thread',
             'Alice <alice@example.com>',$4::jsonb)`,
    [inboundId, convo, companyId, JSON.stringify([senderAddress])],
  )

  const providerLogs: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => {
    providerLogs.push(values.map(String).join(' '))
    originalLog(...values)
  }
  const revoker = await pool.connect()
  let committed = false
  let pending: Promise<Response> | undefined
  let response: Response | undefined
  try {
    await revoker.query('BEGIN')
    await removeMemberWithClient(revoker, convo, HTTP_A)
    pending = fetch(`${httpBaseUrls[0]}/api/email/reply/${inboundId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-company-id': companyId },
      body: JSON.stringify({ body: 'must-not-be-sent-after-kick' }),
    })
    await waitForBlockedQuery('%SELECT id FROM conversations%FOR UPDATE%')
    await revoker.query('COMMIT')
    committed = true
    response = await pending
  } finally {
    if (!committed) await revoker.query('ROLLBACK').catch(() => {})
    revoker.release()
    console.log = originalLog
  }

  assert.equal(response!.status, 500, await response!.text())
  assert.ok(!providerLogs.some((line) => line.includes('[email/mock]')), providerLogs.join('\n'))
  const outbound = await pool.query(
    `SELECT 1 FROM email_messages WHERE conversation_id = $1 AND direction = 'out'`,
    [convo],
  )
  assert.equal(outbound.rowCount, 0)
})

test('[integration] HTTP group and direct creation reject targets moved while participant locks wait', async () => {
  const companyA = `c-${randomUUID().slice(0, 8)}`
  const companyB = `c-${randomUUID().slice(0, 8)}`
  const directTarget = 'human-http-direct-moving'
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'HTTP room tenant A', $1, $3), ($2, 'HTTP room tenant B', $2, $3)`,
    [companyA, companyB, HTTP_A],
  )
  await seedUserMembership(HTTP_A, companyA)
  await seedUserMembership(HTTP_B, companyA)
  await seedUserMembership(directTarget, companyA)

  const moveAndRequest = async (targetId: string, url: string, body: Record<string, unknown>) => {
    const mover = await pool.connect()
    let committed = false
    let pending: Promise<Response> | undefined
    try {
      await mover.query('BEGIN')
      await mover.query(
        `UPDATE participants SET company_id = $2 WHERE id = $1 AND company_id = $3`,
        [targetId, companyB, companyA],
      )
      pending = fetch(`${httpBaseUrls[0]}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-company-id': companyA },
        body: JSON.stringify(body),
      })
      await waitForBlockedQuery('%ORDER BY id FOR SHARE%')
      await mover.query('COMMIT')
      committed = true
    } finally {
      if (!committed) await mover.query('ROLLBACK').catch(() => {})
      mover.release()
    }
    return pending!
  }

  const groupResponse = await moveAndRequest(HTTP_B, '/api/conversations', {
    title: 'must-not-create-stale-group', members: [HTTP_B],
  })
  assert.equal(groupResponse.status, 400, await groupResponse.text())

  const directResponse = await moveAndRequest(directTarget, '/api/conversations/direct', {
    otherId: directTarget,
  })
  assert.equal(directResponse.status, 404, await directResponse.text())
  const created = await pool.query(
    `SELECT 1 FROM conversations c
      WHERE c.company_id = $1
        AND (
          c.title = 'must-not-create-stale-group'
          OR EXISTS (
            SELECT 1 FROM conversation_members member
             WHERE member.conversation_id = c.id
               AND member.participant_id = $2
          )
        )`,
    [companyA, directTarget],
  )
  assert.equal(created.rowCount, 0)
})

test('[integration] a revoked CLI actor cannot finish a stale kick or emit a kicked notice', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyId, 'agent-stale-actor')
  const peer = await seedAgent(companyId, 'agent-stale-peer')
  const target = await seedAgent(companyId, 'agent-stale-target')
  const convo = await seedGroup(companyId, [actor, peer, target])

  const revoker = await pool.connect()
  let committed = false
  let pending: ReturnType<typeof runCli> | undefined
  try {
    await revoker.query('BEGIN')
    await removeMemberWithClient(revoker, convo, actor)
    pending = runCli(['--as', actor, 'kick', convo, target])
    await waitForBlockedMembershipUpdate('members -')
    await revoker.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await revoker.query('ROLLBACK').catch(() => {})
    revoker.release()
  }

  const result = await pending!
  assert.equal(result.ok, false, result.text)
  const members = await membersOf(convo)
  assert.ok(!members.includes(actor))
  assert.ok(members.includes(target), `revoked actor kicked ${target}: ${JSON.stringify(members)}`)
  assert.ok(!(await noticesOf(convo)).some((body) => body.kind === 'kicked' && body.participantId === target))
})

test('[integration] an actor tenant move that wins the participant lock cancels a stale invite', async () => {
  const companyA = `c-${randomUUID().slice(0, 8)}`
  const companyB = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyA, 'agent-moving-actor')
  const target = await seedAgent(companyA, 'agent-stays-a')
  await seedAgent(companyB, 'agent-company-b-anchor')
  const convo = await seedGroup(companyA, [actor])

  const mover = await pool.connect()
  let committed = false
  let pending: ReturnType<typeof runCli> | undefined
  try {
    await mover.query('BEGIN')
    await detachParticipantWithClient(mover, actor, companyA)
    await mover.query(
      `UPDATE participants SET company_id = $2 WHERE id = $1 AND company_id = $3`,
      [actor, companyB, companyA],
    )
    // The friendly route SELECT still sees the old committed row. The helper's
    // participant FOR UPDATE must wait and then reject the moved actor.
    pending = runCli(['--as', actor, 'invite', convo, target])
    await waitForBlockedQuery('%FROM participants%FOR UPDATE%')
    await mover.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await mover.query('ROLLBACK').catch(() => {})
    mover.release()
  }

  const result = await pending!
  assert.equal(result.ok, false, result.text)
  assert.deepEqual(await membersOf(convo), [])
  assert.equal((await noticesOf(convo)).length, 0)
})

test('[integration] a target tenant move that wins the participant lock cancels a stale invite', async () => {
  const companyA = `c-${randomUUID().slice(0, 8)}`
  const companyB = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyA, 'agent-stays-a')
  const target = await seedAgent(companyA, 'agent-moving-target')
  await seedAgent(companyB, 'agent-company-b-anchor')
  const convo = await seedGroup(companyA, [actor])

  const mover = await pool.connect()
  let committed = false
  let pending: ReturnType<typeof runCli> | undefined
  try {
    await mover.query('BEGIN')
    await mover.query(
      `UPDATE participants SET company_id = $2 WHERE id = $1 AND company_id = $3`,
      [target, companyB, companyA],
    )
    pending = runCli(['--as', actor, 'invite', convo, target])
    await waitForBlockedQuery('%FROM participants%FOR UPDATE%')
    await mover.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await mover.query('ROLLBACK').catch(() => {})
    mover.release()
  }

  const result = await pending!
  assert.equal(result.ok, false, result.text)
  assert.deepEqual(await membersOf(convo), [actor])
  assert.equal((await noticesOf(convo)).length, 0)
})

test('[integration] target offboarding that wins the participant lock cancels a stale invite', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyId, 'agent-offboard-target-actor')
  const target = await seedAgent(companyId, 'agent-offboard-invite-target')
  const convo = await seedGroup(companyId, [actor])

  const offboarder = await pool.connect()
  let committed = false
  let pending: ReturnType<typeof runCli> | undefined
  try {
    await offboarder.query('BEGIN')
    await offboarder.query(
      `UPDATE participants SET departed_at = NOW() WHERE id = $1 AND company_id = $2`,
      [target, companyId],
    )
    pending = runCli(['--as', actor, 'invite', convo, target])
    await waitForBlockedQuery('%FROM participants%FOR UPDATE%')
    await offboarder.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await offboarder.query('ROLLBACK').catch(() => {})
    offboarder.release()
  }

  const result = await pending!
  assert.equal(result.ok, false, result.text)
  assert.deepEqual(await membersOf(convo), [actor])
  assert.equal((await noticesOf(convo)).length, 0)
})

test('[integration] actor offboarding that wins the participant lock cancels a stale kick', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyId, 'agent-offboard-kick-actor')
  const peer = await seedAgent(companyId, 'agent-offboard-kick-peer')
  const target = await seedAgent(companyId, 'agent-offboard-kick-target')
  const convo = await seedGroup(companyId, [actor, peer, target])

  const offboarder = await pool.connect()
  let committed = false
  let pending: ReturnType<typeof runCli> | undefined
  try {
    await offboarder.query('BEGIN')
    await offboarder.query(
      `UPDATE participants SET departed_at = NOW() WHERE id = $1 AND company_id = $2`,
      [actor, companyId],
    )
    pending = runCli(['--as', actor, 'kick', convo, target])
    await waitForBlockedQuery('%FROM participants%FOR UPDATE%')
    await offboarder.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await offboarder.query('ROLLBACK').catch(() => {})
    offboarder.release()
  }

  const result = await pending!
  assert.equal(result.ok, false, result.text)
  assert.ok((await membersOf(convo)).includes(target))
  assert.equal((await noticesOf(convo)).length, 0)
})

test('[integration] a moved agent cannot read a stale old-tenant membership', async () => {
  const companyA = `c-${randomUUID().slice(0, 8)}`
  const companyB = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyA, 'agent-old-tenant-peer')
  const moved = await seedAgent(companyA, 'agent-moved-with-stale-member-id')
  await seedAgent(companyB, 'agent-company-b-anchor')
  const convo = await seedGroup(companyA, [actor, moved])
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1,$2,$3,'text','old tenant secret',1,$4)`,
    [`m-${randomUUID()}`, convo, actor, companyA],
  )
  const mover = await pool.connect()
  try {
    await mover.query('BEGIN')
    await detachParticipantWithClient(mover, moved, companyA)
    await mover.query(
      `UPDATE participants SET company_id = $2 WHERE id = $1 AND company_id = $3`,
      [moved, companyB, companyA],
    )
    await mover.query('COMMIT')
  } catch (error) {
    await mover.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    mover.release()
  }

  const inbox = await inprocClient.loadInbox(moved)
  assert.deepEqual(inbox, [])
})

test('[integration] a kicked poll author is not woken with later room tally details', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const author = await seedAgent(companyId, 'agent-kicked-poll-author')
  const peer = await seedAgent(companyId, 'agent-poll-peer')
  const convo = await seedGroup(companyId, [author, peer])
  const messageId = `m-${randomUUID()}`
  const poll = {
    question: 'old room secret?',
    mode: 'single' as const,
    options: [{ id: 'yes', text: 'classified option' }, { id: 'no', text: 'other' }],
    expiresAt: null,
    closedAt: null,
    closedReason: null,
  }
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, poll, company_id)
     VALUES ($1,$2,$3,'poll',$4,1,$5::jsonb,$6)`,
    [messageId, convo, author, poll.question, JSON.stringify(poll), companyId],
  )
  await removeMember(convo, author, companyId)

  const woke = await handlePollUpdated({
    type: 'poll.updated',
    conversationId: convo,
    companyId,
    messageId,
    poll,
    tallies: [{ optionId: 'yes', count: 1, voterIds: [peer] }],
    actorId: peer,
  })
  assert.equal(woke, false)
})

test('[integration] WebSocket routing uses current room membership with one durable departure exception', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const outsider = 'human-ws-outsider'
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'WS authorization', $2, $3)`,
    [companyId, companyId, HTTP_A],
  )
  await seedUserMembership(HTTP_A, companyId)
  await seedUserMembership(HTTP_B, companyId)
  await seedUserMembership(outsider, companyId)
  const convo = await seedGroup(companyId, [HTTP_A, HTTP_B])
  const ordinaryId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1,$2,$3,'text','private body',1,$4)`,
    [ordinaryId, convo, HTTP_B, companyId],
  )

  const before = await resolveWsEventRecipientUserIds({
    type: 'message.new', companyId, conversationId: convo, message: { id: ordinaryId },
  })
  assert.deepEqual([...before].sort(), [HTTP_A, HTTP_B].sort())
  assert.ok(!before.has(outsider), 'same-tenant non-member received a private conversation frame')

  await removeMember(convo, HTTP_A)
  const afterKick = await resolveWsEventRecipientUserIds({
    type: 'message.new', companyId, conversationId: convo, message: { id: ordinaryId },
  })
  assert.deepEqual([...afterKick], [HTTP_B])

  const departureId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, author_id, kind, body, sequence, company_id, delivery_recipient_id)
     VALUES ($1,$2,$3,'system',$4,2,$5,$6)`,
    [
      departureId,
      convo,
      HTTP_B,
      JSON.stringify({ kind: 'kicked', participantId: HTTP_A, actorId: HTTP_B }),
      companyId,
      HTTP_A,
    ],
  )
  const departure = await resolveWsEventRecipientUserIds({
    type: 'message.new', companyId, conversationId: convo, message: { id: departureId },
  })
  assert.deepEqual([...departure].sort(), [HTTP_A, HTTP_B].sort())

  const forged = await resolveWsEventRecipientUserIds({
    type: 'message.new', companyId, conversationId: convo, message: { id: ordinaryId },
  })
  assert.deepEqual([...forged], [HTTP_B], 'ordinary row inherited a forged departure exception')

  await pool.query(
    `UPDATE participants SET departed_at = NOW() WHERE id = $1 AND company_id = $2`,
    [HTTP_A, companyId],
  )
  const workspaceRecipients = await resolveWsEventRecipientUserIds({
    type: 'participants.status', companyId,
  })
  assert.ok(!workspaceRecipients.has(HTTP_A), 'departed account retained workspace-wide WS delivery')
  assert.deepEqual([...workspaceRecipients].sort(), [HTTP_B, outsider].sort())
})

test('[integration] a corrupt all-hands pointer cannot add a member across tenants', async () => {
  const companyA = `c-${randomUUID().slice(0, 8)}`
  const companyB = `c-${randomUUID().slice(0, 8)}`
  const memberA = await seedAgent(companyA, 'agent-company-a')
  const memberB = await seedAgent(companyB, 'agent-company-b')
  const foreignConversation = await seedGroup(companyB, [memberB])
  await pool.query(
    `UPDATE companies SET all_hands_conversation_id = $2 WHERE id = $1`,
    [companyA, foreignConversation],
  )

  await joinAllHands({ companyId: companyA, participantId: memberA })

  assert.deepEqual(await membersOf(foreignConversation), [memberB])
  assert.equal((await noticesOf(foreignConversation)).length, 0)
})

test('[integration] joinAllHands rejects a participant moved while onboarding is waiting', async () => {
  const companyA = `c-${randomUUID().slice(0, 8)}`
  const companyB = `c-${randomUUID().slice(0, 8)}`
  const anchor = await seedAgent(companyA, 'agent-all-hands-anchor')
  const moving = await seedAgent(companyA, 'agent-all-hands-moving')
  await seedAgent(companyB, 'agent-all-hands-company-b')
  const allHands = await seedGroup(companyA, [anchor])
  await pool.query(
    `UPDATE companies SET all_hands_conversation_id = $2 WHERE id = $1`,
    [companyA, allHands],
  )

  const mover = await pool.connect()
  let committed = false
  let pending: ReturnType<typeof joinAllHands> | undefined
  try {
    await mover.query('BEGIN')
    await mover.query(
      `UPDATE participants SET company_id = $2 WHERE id = $1 AND company_id = $3`,
      [moving, companyB, companyA],
    )
    pending = joinAllHands({ companyId: companyA, participantId: moving })
    await waitForBlockedQuery('%FROM participants%FOR UPDATE%')
    await mover.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await mover.query('ROLLBACK').catch(() => {})
    mover.release()
  }

  await pending!
  assert.deepEqual(await membersOf(allHands), [anchor])
  assert.equal((await noticesOf(allHands)).length, 0)
})

test('[integration] concurrent kicks of different agents both take effect', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const b = await seedAgent(companyId, 'agent-b')
  const x = await seedAgent(companyId, 'agent-x')
  const y = await seedAgent(companyId, 'agent-y')
  const convo = await seedGroup(companyId, [a, b, x, y])

  const [kx, ky] = await Promise.all([
    runCli(['--as', a, 'kick', convo, x]),
    runCli(['--as', b, 'kick', convo, y]),
  ])
  assert.equal(kx.ok, true, `kick x failed: ${kx.text}`)
  assert.equal(ky.ok, true, `kick y failed: ${ky.text}`)

  const members = await membersOf(convo)
  assert.ok(!members.includes(x), `${x} survived the kick: ${JSON.stringify(members)}`)
  assert.ok(!members.includes(y), `${y} survived the kick: ${JSON.stringify(members)}`)
  assert.deepEqual([...members].sort(), [a, b].sort())
})

test('[integration] concurrent kicks cannot bypass --confirm-empty', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyId, 'agent-confirm-actor')
  const x = await seedAgent(companyId, 'agent-confirm-x')
  const y = await seedAgent(companyId, 'agent-confirm-y')
  const convo = await seedGroup(companyId, [actor, x, y])

  // Hold the shared actor row so both commands finish their friendly snapshot
  // checks before either protected UPDATE can commit. Once released, Postgres
  // serializes the writes and the second UPDATE must re-evaluate cardinality.
  const blocker = await pool.connect()
  let committed = false
  let kickX: ReturnType<typeof runCli> | undefined
  let kickY: ReturnType<typeof runCli> | undefined
  try {
    await blocker.query('BEGIN')
    await blocker.query(
      `SELECT id FROM participants WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [actor, companyId],
    )
    kickX = runCli(['--as', actor, 'kick', convo, x])
    kickY = runCli(['--as', actor, 'kick', convo, y])
    await waitForBlockedQuery('%FROM participants%FOR UPDATE%', 2)
    await blocker.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await blocker.query('ROLLBACK').catch(() => {})
    blocker.release()
  }

  const results = await Promise.all([kickX!, kickY!])
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results))
  assert.equal(results.filter((result) => !result.ok).length, 1, JSON.stringify(results))
  const members = await membersOf(convo)
  assert.equal(members.length, 2, JSON.stringify(members))
  assert.ok(members.includes(actor))
  const kicked = (await noticesOf(convo)).filter((body) => body.kind === 'kicked')
  assert.equal(kicked.length, 1, JSON.stringify(kicked))
})

test('[integration] inviting the same agent twice at once adds them once', async () => {
  // Force both callers past their initial snapshot before the first UPDATE is
  // allowed to commit. This makes the duplicate-event regression deterministic
  // instead of hoping two local-socket requests happen to overlap.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const b = await seedAgent(companyId, 'agent-b')
  const x = await seedAgent(companyId, 'agent-x')
  const convo = await seedGroup(companyId, [a, b])

  const blocker = await pool.connect()
  let committed = false
  let inviteA: ReturnType<typeof runCli> | undefined
  let inviteB: ReturnType<typeof runCli> | undefined
  try {
    await blocker.query('BEGIN')
    await blocker.query(`UPDATE conversations SET updated_at = updated_at WHERE id = $1`, [convo])
    inviteA = runCli(['--as', a, 'invite', convo, x])
    inviteB = runCli(['--as', b, 'invite', convo, x])
    await waitForBlockedMembershipGuards(2)
    await blocker.query('COMMIT')
    committed = true
  } finally {
    if (!committed) await blocker.query('ROLLBACK').catch(() => {})
    blocker.release()
  }

  const results = await Promise.all([inviteA!, inviteB!])
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results))

  const members = await membersOf(convo)
  assert.equal(members.filter((m) => m === x).length, 1, `${x} added twice: ${JSON.stringify(members)}`)
  const joins = (await noticesOf(convo)).filter((body) => body.kind === 'joined' && body.participantId === x)
  assert.equal(joins.length, 1, `duplicate joined notices: ${JSON.stringify(joins)}`)
})

test('[integration] kicked agent receives only its durable departure notice', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const actor = await seedAgent(companyId, 'agent-kick-notice-actor')
  const target = await seedAgent(companyId, 'agent-kick-notice-target')
  const peer = await seedAgent(companyId, 'agent-kick-notice-peer')
  const convo = await seedGroup(companyId, [actor, target, peer])
  const secretId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1,$2,$3,'text','not visible after removal',1,$4)`,
    [secretId, convo, peer, companyId],
  )
  const muted = await runCli(['--as', target, 'mute', convo, '--for', '1h'])
  assert.equal(muted.ok, true, muted.text)

  const result = await runCli(['--as', actor, 'kick', convo, target])
  assert.equal(result.ok, true, result.text)
  assert.ok(!(await membersOf(convo)).includes(target))

  const inbox = await inprocClient.loadInbox(target)
  assert.equal(inbox.length, 1, JSON.stringify(inbox))
  assert.equal(inbox[0].kind, 'system')
  assert.equal(inbox[0].conversation_id, convo)
  assert.ok(!inbox.some((row) => row.id === secretId), 'removed agent received ordinary conversation history')
  const body = JSON.parse(inbox[0].body) as { kind?: string; participantId?: string }
  assert.deepEqual(body, { kind: 'kicked', participantId: target, actorId: actor })

  const { rows } = await pool.query<{ delivery_recipient_id: string | null }>(
    `SELECT delivery_recipient_id FROM messages WHERE id = $1`, [inbox[0].id],
  )
  assert.equal(rows[0]?.delivery_recipient_id, target)

  assert.equal(await resolveDurableDeliveryAgent({
    conversationId: convo,
    messageId: inbox[0].id,
    companyId,
    claimedRecipientId: target,
  }), target)
  assert.equal(await resolveDurableDeliveryAgent({
    conversationId: convo,
    messageId: secretId,
    companyId,
    claimedRecipientId: target,
  }), null, 'forged pubsub recipient turned an ordinary message into a wake')
  assert.equal(await resolveDurableDeliveryAgent({
    conversationId: convo,
    messageId: inbox[0].id,
    companyId,
    claimedRecipientId: peer,
  }), null, 'pubsub recipient did not match the persisted departure recipient')

  const cloudWake = await triageWakeRecipient(target, {
    conversationId: convo,
    messageId: inbox[0].id,
  })
  assert.equal(cloudWake, null, 'informational departure unexpectedly woke the cloud main brain')
  assert.deepEqual(await inprocClient.loadInbox(target), [])

  await pool.query(
    `UPDATE participants SET departed_at = NOW() WHERE id = $1 AND company_id = $2`,
    [target, companyId],
  )
  assert.equal(await resolveDurableDeliveryAgent({
    conversationId: convo,
    messageId: inbox[0].id,
    companyId,
    claimedRecipientId: target,
  }), null, 'departed agent remained eligible for scheduler fan-out')
})

test('[integration] leaving agent receives and can acknowledge its own departure notice', async () => {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const leaver = await seedAgent(companyId, 'agent-leave-notice-self')
  const peer = await seedAgent(companyId, 'agent-leave-notice-peer')
  const convo = await seedGroup(companyId, [leaver, peer])
  const muted = await runCli(['--as', leaver, 'mute', convo, '--for', '1h'])
  assert.equal(muted.ok, true, muted.text)

  const result = await runCli(['--as', leaver, 'leave', convo])
  assert.equal(result.ok, true, result.text)
  assert.ok(!(await membersOf(convo)).includes(leaver))

  const inbox = await inprocClient.loadInbox(leaver)
  assert.equal(inbox.length, 1, JSON.stringify(inbox))
  assert.equal(inbox[0].author_id, leaver, 'self-authored departure notice was filtered out')
  const body = JSON.parse(inbox[0].body) as { kind?: string; participantId?: string; actorId?: string }
  assert.deepEqual(body, { kind: 'left', participantId: leaver, actorId: leaver })

  await inprocClient.markConversationRead({
    agentId: leaver,
    conversationId: convo,
    upToMessageId: inbox[0].id,
  })
  assert.deepEqual(await inprocClient.loadInbox(leaver), [])
})

test('[integration] a lone sequential invite still behaves exactly as before', async () => {
  // The uncontended path is the one every user actually hits; the atomic
  // rewrite must not change it.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const a = await seedAgent(companyId, 'agent-a')
  const x = await seedAgent(companyId, 'agent-x')
  const convo = await seedGroup(companyId, [a])

  const invited = await runCli(['--as', a, 'invite', convo, x])
  assert.equal(invited.ok, true, invited.text)
  assert.deepEqual(await membersOf(convo), [a, x])

  const kicked = await runCli(['--as', a, 'kick', convo, x, '--confirm-empty'])
  assert.equal(kicked.ok, true, kicked.text)
  assert.deepEqual(await membersOf(convo), [a])
})
