/**
 * A phone must hear an agent's reply.
 *
 * Push dispatch lived in exactly one place — the fire-and-forget block in
 * `POST /conversations/:id/messages` — and that route is gated by
 * `requireCompany(req)`, a human session. Agents never traverse it: `cumora
 * reply` runs server-side through `runCli`, and `cmdReply` committed the row
 * and enqueued the realtime broadcast, nothing more.
 *
 * So the exact case push exists for was the case it missed. A human asks an
 * agent a question on their phone and locks the screen; the socket drops, their
 * status goes 'resting'. The agent answers two minutes later and the phone
 * stays silent. In an agent-first workspace that is most inbound messages.
 *
 * The in-app surface never made this distinction: NotificationToasts fires on
 * any `message.new` that is not yours and not a system row, and resolves the
 * author out of the participants roster, which holds agents too. Desktop
 * notified, phone did not.
 *
 * Author name is the other half. Agents have no `users` row, so the old
 * users-only lookup would push with a raw agent id as the notification title.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'
import { runCli } from '../agents/cli.js'
import { __setNotifyHookForTesting } from '../push.js'

interface Captured {
  authorId: string
  authorName: string
  conversationId: string
  body: string
  recipientUserIds: string[]
}

let sent: Captured[] = []

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => {
  await resetAllTables()
  sent = []
  __setNotifyHookForTesting((a) => { sent.push(a as unknown as Captured) })
})
afterEach(() => { __setNotifyHookForTesting(null) })
after(async () => { await teardownAll() })

/** A human who is offline — exactly the person push is for. */
async function seedOfflineHuman(companyId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`,
    [userId, `${userId}@test.local`, `Human ${userId}`],
  )
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, userId],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', $3, 'owner', 'H', '#123456', 'resting')`,
    [userId, companyId, `Human ${userId}`],
  )
}

async function seedRoom(companyId: string, convoId: string, memberIds: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', 'Launch room', $3::jsonb)`,
    [convoId, companyId, JSON.stringify(memberIds)],
  )
  for (const [i, id] of memberIds.entries()) {
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, company_id, participant_id, ordinal)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [convoId, companyId, id, i],
    )
  }
}

test('[integration] an agent reply reaches the push path', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const humanId = 'u-offline'
  await seedOfflineHuman(companyId, humanId)
  await seedRoom(companyId, 'c-launch', [agentId, humanId])

  const res = await runCli(['--as', agentId, 'reply', 'c-launch', 'Q3 numbers are up 12%'])
  assert.equal(res.ok, true, res.text)

  // The dispatch is fire-and-forget; give the microtask queue a turn.
  await new Promise((r) => setTimeout(r, 150))

  assert.equal(sent.length, 1, 'the agent reply produced no push')
  assert.deepEqual(sent[0].recipientUserIds, [humanId])
  assert.match(sent[0].body, /Q3 numbers are up 12%/)
})

test('[integration] the notification is titled with the agent name, not its id', async () => {
  // Agents have no `users` row; a users-only lookup would show `a-1f2e3d4c`.
  const { companyId, agentId } = await seedCompanyWithAgent()
  const humanId = 'u-offline-2'
  await seedOfflineHuman(companyId, humanId)
  await seedRoom(companyId, 'c-launch', [agentId, humanId])

  await runCli(['--as', agentId, 'reply', 'c-launch', 'done'])
  await new Promise((r) => setTimeout(r, 150))

  assert.equal(sent.length, 1)
  assert.equal(sent[0].authorName, `Agent ${agentId}`)
  assert.notEqual(sent[0].authorName, agentId)
})

test('[integration] a human already looking at the app is still skipped', async () => {
  // The recipient filters are unchanged — this must not become a broadcast.
  const { companyId, agentId } = await seedCompanyWithAgent()
  const humanId = 'u-online'
  await seedOfflineHuman(companyId, humanId)
  await pool.query(`UPDATE participants SET status = 'avail' WHERE id = $1`, [humanId])
  await seedRoom(companyId, 'c-launch', [agentId, humanId])

  await runCli(['--as', agentId, 'reply', 'c-launch', 'hello'])
  await new Promise((r) => setTimeout(r, 150))

  const withRecipients = sent.filter((s) => s.recipientUserIds.length > 0)
  assert.equal(withRecipients.length, 0, 'pushed to someone who is on the app')
})

test('[integration] a muted conversation is still muted', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const humanId = 'u-muted'
  await seedOfflineHuman(companyId, humanId)
  await seedRoom(companyId, 'c-launch', [agentId, humanId])
  await pool.query(
    `INSERT INTO conversation_mutes (user_id, conversation_id, muted_until) VALUES ($1, 'c-launch', NULL)`,
    [humanId],
  )

  await runCli(['--as', agentId, 'reply', 'c-launch', 'hello'])
  await new Promise((r) => setTimeout(r, 150))

  const withRecipients = sent.filter((s) => s.recipientUserIds.length > 0)
  assert.equal(withRecipients.length, 0, 'pushed into a muted conversation')
})
