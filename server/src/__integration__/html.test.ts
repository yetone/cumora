/**
 * Integration test: GET /api/email/:messageId/html
 *
 * The endpoint is membership-gated (you can only fetch the HTML body of
 * an email thread you're a member of), runs through sanitizeEmailHtml,
 * and sets a tight CSP header so even residual hostile markup can't
 * load remote scripts inside the renderer's sandbox iframe.
 *
 * What this test covers that the unit tests can't:
 *   - The full requireCompany → membership check → query round-trip
 *   - 204 when the row exists but has no HTML part
 *   - 403 when the requester isn't a member of the conversation
 *   - CSP + nosniff headers on the success path
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent,
  seedUserMembership, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'
import { findOrCreateEmailConversation, persistEmailMessage } from '../email.js'

const ME_USER_ID = 'u-test-html'
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

/** Seed: company + me as a member + one email row with given html body,
 *  with me on the conversation's members list. Returns the messageId we
 *  GET against. */
async function seedEmailWithHtml(html: string | null): Promise<{ messageId: string; companyId: string }> {
  const { companyId, agentId } = await seedCompanyWithAgent()
  await seedUserMembership(ME_USER_ID, companyId)
  const conv = await findOrCreateEmailConversation({
    companyId, inReplyTo: null, references: [], subject: 'with html',
    memberIds: [ME_USER_ID, agentId],
  })
  const { messageId } = await persistEmailMessage({
    conversationId: conv.conversationId, companyId, authorId: agentId,
    direction: 'in', transportStatus: 'received',
    smtpMessageId: `html-test-${Date.now()}@host`,
    inReplyTo: null, references: [], subject: 'with html',
    fromAddr: 'external@example.com', toAddrs: [`${ME_USER_ID}@test.local`],
    body: 'plain body',
    html,
  })
  return { messageId, companyId }
}

async function fetchHtml(messageId: string, companyId?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (companyId) headers['x-company-id'] = companyId
  return fetch(`${baseUrl}/api/email/${encodeURIComponent(messageId)}/html`, { headers })
}

test('[integration] returns 200 + sanitized HTML + CSP for a member', async () => {
  const { messageId, companyId } = await seedEmailWithHtml(
    '<p>Hello</p><script>alert(1)</script><style>body{display:none}</style>',
  )
  const res = await fetchHtml(messageId, companyId)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  // CSP must lock down active content paths.
  const csp = res.headers.get('content-security-policy') ?? ''
  assert.ok(csp.includes("default-src 'none'"), `expected restrictive default-src in CSP, got: ${csp}`)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const body = await res.text()
  assert.ok(body.includes('<p>Hello</p>'), 'paragraph preserved')
  assert.ok(!/<script/i.test(body), 'script stripped')
  assert.ok(!/<style/i.test(body), 'style stripped')
})

test('[integration] returns 204 when the row has no HTML part', async () => {
  const { messageId, companyId } = await seedEmailWithHtml(null)
  const res = await fetchHtml(messageId, companyId)
  assert.equal(res.status, 204)
})

test('[integration] returns 404 for an unknown messageId', async () => {
  const { companyId } = await seedEmailWithHtml('<p>x</p>')
  const res = await fetchHtml('m-does-not-exist', companyId)
  assert.equal(res.status, 404)
})

test('[integration] returns 403 when the requester is not a thread member', async () => {
  // Seed an email row, then REMOVE the user from the conversation's
  // members list so the membership check fails even though the auth
  // header is valid.
  const { messageId, companyId } = await seedEmailWithHtml('<p>secret</p>')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ conversation_id: string }>(
      `DELETE FROM conversation_members
        WHERE participant_id = $2
          AND conversation_id = (
            SELECT conversation_id FROM email_messages WHERE message_id = $1
          )
        RETURNING conversation_id`,
      [messageId, ME_USER_ID],
    )
    assert.ok(rows[0])
    await client.query(`SELECT refresh_conversation_members_projection($1)`, [rows[0].conversation_id])
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  const res = await fetchHtml(messageId, companyId)
  assert.equal(res.status, 403)
})
