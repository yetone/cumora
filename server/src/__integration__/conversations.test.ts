/**
 * Integration tests for conversation list/search shaping.
 *
 * Direct conversation rows are shared by both participants, so the stored
 * `conversations.title` can only ever be correct for one viewer. The API must
 * return a viewer-specific title based on the other member instead.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'

const ME_USER_ID = 'u-me'
const OTHER_USER_ID = 'u-ada'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(ME_USER_ID)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll(server)
})

async function seedHumanDirectWithSelfStoredTitle(): Promise<{ companyId: string; conversationId: string }> {
  const companyId = 'c-direct-title'
  const conversationId = 'direct-ada-yetone'
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Direct Title Co', 'direct-title-co', $2)`,
    [companyId, ME_USER_ID],
  )
  await seedUserMembership(ME_USER_ID, companyId, {
    email: 'yetone@test.local',
    displayName: 'Yetone',
  })
  await seedUserMembership(OTHER_USER_ID, companyId, {
    email: 'ada@test.local',
    displayName: 'Ada',
  })
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
     VALUES ($1, 'direct', 'Yetone', $2::jsonb, 'human', $3)`,
    [conversationId, JSON.stringify([OTHER_USER_ID, ME_USER_ID]), companyId],
  )
  return { companyId, conversationId }
}

test('[integration] GET /conversations returns the other member as a direct title', async () => {
  const { companyId, conversationId } = await seedHumanDirectWithSelfStoredTitle()

  const res = await fetch(`${baseUrl}/api/conversations`, {
    headers: { 'x-company-id': companyId },
  })
  assert.equal(res.status, 200)
  const rows = await res.json() as Array<{ id: string; title: string }>
  const direct = rows.find((r) => r.id === conversationId)

  assert.equal(direct?.title, 'Ada')
})

test('[integration] GET /search uses the same perspective-specific direct title', async () => {
  const { companyId, conversationId } = await seedHumanDirectWithSelfStoredTitle()

  const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('Ada')}`, {
    headers: { 'x-company-id': companyId },
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { rooms: Array<{ id: string; title: string }> }
  const direct = body.rooms.find((r) => r.id === conversationId)

  assert.equal(direct?.title, 'Ada')
})

// ── the lastMessage / unreadCount rewrite must be semantics-preserving ──────
//
// Both used to be correlated scalar subqueries, and `unreadCount` nested a
// second one (the conversation_reads lookup) inside its COUNT — so a list of
// N conversations cost 2N+ index probes. They are LATERAL joins now, with
// conversation_reads hoisted to a plain LEFT JOIN (its PK is
// (user_id, conversation_id), so it can still match at most one row). The
// shapes below are the ones where a rewrite like this typically drifts.

interface ConversationRow {
  id: string
  unreadCount: number
  lastMessage: { id: string; kind: string; body: string; email: { subject: string } | null } | null
}

async function listConversations(companyId: string): Promise<ConversationRow[]> {
  const res = await fetch(`${baseUrl}/api/conversations`, {
    headers: { 'x-company-id': companyId },
  })
  assert.equal(res.status, 200)
  return await res.json() as ConversationRow[]
}

test('[integration] lastMessage and unreadCount survive the correlated-subquery rewrite', async () => {
  const companyId = 'c-list-shape'
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'List Shape Co', 'list-shape-co', $2)`,
    [companyId, ME_USER_ID],
  )
  await seedUserMembership(ME_USER_ID, companyId, { displayName: 'Me' })
  await seedUserMembership(OTHER_USER_ID, companyId, { displayName: 'Ada' })

  const withMessages = 'g-has-messages'
  const empty = 'g-no-messages'
  const readRoom = 'g-already-read'
  for (const [id, title] of [[withMessages, 'Busy'], [empty, 'Silent'], [readRoom, 'Caught up']]) {
    await pool.query(
      `INSERT INTO conversations (id, kind, title, members, company_id)
       VALUES ($1, 'group', $2, $3::jsonb, $4)`,
      [id, title, JSON.stringify([ME_USER_ID, OTHER_USER_ID]), companyId],
    )
  }
  // Two unread from someone else, plus one of mine — my own messages never
  // count as unread.
  for (const [seq, author] of [[1, OTHER_USER_ID], [2, ME_USER_ID], [3, OTHER_USER_ID]] as const) {
    await pool.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [`m-busy-${seq}`, withMessages, author, `message ${seq}`, seq, companyId],
    )
  }
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1, $2, $3, 'text', 'old news', 1, $4)`,
    ['m-read-1', readRoom, OTHER_USER_ID, companyId],
  )
  await pool.query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
     VALUES ($1, $2, NOW())`,
    [ME_USER_ID, readRoom],
  )

  const rows = await listConversations(companyId)
  const byId = new Map(rows.map((r) => [r.id, r]))

  const busy = byId.get(withMessages)
  assert.equal(busy?.unreadCount, 2, 'own messages must not count as unread')
  assert.equal(busy?.lastMessage?.id, 'm-busy-3', 'lastMessage is the highest sequence, not the newest row inserted')

  const silent = byId.get(empty)
  assert.equal(silent?.lastMessage, null, 'a conversation with no messages must return null, not an empty object')
  assert.equal(silent?.unreadCount, 0)

  // The read cursor is now a hoisted LEFT JOIN rather than a nested scalar —
  // this is the row that proves it is still applied per conversation.
  assert.equal(byId.get(readRoom)?.unreadCount, 0)
  assert.equal(byId.get(readRoom)?.lastMessage?.id, 'm-read-1')

  // Exactly one row per conversation: a join that fanned out would duplicate.
  assert.equal(rows.length, new Set(rows.map((r) => r.id)).size)
})

test('[integration] an email lastMessage still carries its envelope', async () => {
  const companyId = 'c-list-email'
  const conversationId = 'g-email-thread'
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'List Email Co', 'list-email-co', $2)`,
    [companyId, ME_USER_ID],
  )
  await seedUserMembership(ME_USER_ID, companyId, { displayName: 'Me' })
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ($1, 'group', 'Contracts', $2::jsonb, $3)`,
    [conversationId, JSON.stringify([ME_USER_ID]), companyId],
  )
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
     VALUES ($1, $2, $3, 'email', 'body text', 1, $4)`,
    ['m-email-1', conversationId, ME_USER_ID, companyId],
  )
  await pool.query(
    `INSERT INTO email_messages
       (message_id, conversation_id, company_id, direction, transport_status,
        subject, from_addr, to_addrs)
     VALUES ($1, $2, $3, 'in', 'received', 'Re: contract draft', 'ada@example.com', $4::jsonb)`,
    ['m-email-1', conversationId, companyId, JSON.stringify(['me@example.com'])],
  )

  const rows = await listConversations(companyId)
  const thread = rows.find((r) => r.id === conversationId)
  // The envelope is a subquery nested inside the lateral now; the sidebar
  // renders "↓ Re: contract draft" from it instead of a raw body excerpt.
  assert.equal(thread?.lastMessage?.email?.subject, 'Re: contract draft')
})
