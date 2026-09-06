/**
 * Integration test: POST /webhooks/email/inbound end-to-end.
 *
 * Requires a real Postgres + Redis. Run via:
 *   INTEGRATION_DATABASE_URL=postgres://$USER@localhost:5432/cumora_test \
 *     npm run test:integration
 *
 * What we verify here — the bits a unit test on a pure function CAN'T:
 *   - HMAC signature gate (401 on a mismatched / missing sig)
 *   - Recipient resolution against participants.email
 *   - email_messages + email_attachments rows actually land in PG
 *   - Idempotent dedup on a re-delivered Message-ID
 *   - 404 when no recipient resolves (so the worker can bounce upstream)
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import {
  buildTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent,
  signInboundPayload, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'

let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildTestApp()
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

/** Wrap a POST helper so each test stays a one-liner. */
async function postInbound(body: unknown, opts?: { signature?: string }): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(body)
  const sig = opts?.signature ?? signInboundPayload(raw)
  return postInboundRaw(raw, sig)
}

async function postInboundRaw(raw: string, signature: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/webhooks/email/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cumora-signature': signature },
    body: raw,
  })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

test('[integration] rejects requests with a bad HMAC signature', async () => {
  const r = await postInbound(
    {
      messageId: 'mid@host',
      from: 'alice@external.com',
      to: ['anyone@cumora.local'],
      subject: 'hello',
      text: 'body',
    },
    { signature: 'sha256=deadbeef' },
  )
  assert.equal(r.status, 401)
})

test('[integration] rejects requests missing the signature header', async () => {
  const raw = JSON.stringify({ messageId: 'mid@host', from: 'alice@external.com', to: ['x@cumora.local'] })
  const res = await fetch(`${baseUrl}/webhooks/email/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
  assert.equal(res.status, 400)
})

test('[integration] rejects a bad HMAC before attempting to parse malformed JSON', async () => {
  const r = await postInboundRaw('{malformed', `sha256=${'0'.repeat(64)}`)
  assert.equal(r.status, 401)
  assert.deepEqual(r.body, { error: 'bad signature' })
})

test('[integration] parses JSON only after a valid HMAC succeeds', async () => {
  const raw = '{malformed'
  const r = await postInboundRaw(raw, signInboundPayload(raw))
  assert.equal(r.status, 400)
  assert.deepEqual(r.body, { error: 'invalid JSON body' })
})

test('[integration] rejects a missing signature before a multi-megabyte malformed body is parsed', async () => {
  const res = await fetch(`${baseUrl}/webhooks/email/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{${'x'.repeat(1024 * 1024)}`,
  })
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: 'missing signature' })
})

test('[integration] returns 404 when no recipient resolves to a known agent', async () => {
  await seedCompanyWithAgent({ agentEmail: 'aurora@cumora.local' })
  const r = await postInbound({
    messageId: 'never-delivered@host',
    from: 'alice@external.com',
    to: ['nobody@cumora.local'],
    subject: 'hi',
    text: 'body',
  })
  assert.equal(r.status, 404)
  // Nothing should land in PG when the address doesn't resolve.
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM email_messages')
  assert.equal(rows[0].n, 0)
})

test('[integration] persists email_messages + publishes wake event on resolved recipient', async () => {
  const { companyId, agentId, agentEmail } = await seedCompanyWithAgent()
  const r = await postInbound({
    messageId: 'first-msg@host',
    from: 'Alice <alice@external.com>',
    to: [agentEmail],
    subject: 'Hello there',
    text: 'Test body',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.deliveries.length, 1)

  // Verify the row landed and is attributed to the right tenant + agent.
  const { rows } = await pool.query<{
    company_id: string; direction: string; subject: string; auto_submitted: boolean;
  }>(
    `SELECT em.company_id, em.direction, em.subject, em.auto_submitted
       FROM email_messages em
      WHERE em.smtp_message_id = $1`,
    ['first-msg@host'],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company_id, companyId)
  assert.equal(rows[0].direction, 'in')
  assert.equal(rows[0].subject, 'Hello there')
  assert.equal(rows[0].auto_submitted, false)

  // Members of the freshly-created conversation should include the agent.
  const { rows: convo } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE kind = 'email' LIMIT 1`,
  )
  assert.equal(convo.length, 1)
  assert.ok(convo[0].members.includes(agentId), `conversation members should include the recipient agent: ${JSON.stringify(convo[0].members)}`)
})

test('[integration] dedups a re-delivered Message-ID', async () => {
  const { agentEmail } = await seedCompanyWithAgent()
  const payload = {
    messageId: 'dup-mid@host',
    from: 'alice@external.com',
    to: [agentEmail],
    subject: 'idempotent',
    text: 'body',
  }
  const r1 = await postInbound(payload)
  assert.equal(r1.status, 200)
  const r2 = await postInbound(payload)
  assert.equal(r2.status, 200)
  assert.equal(r2.body.deduplicated, true)
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM email_messages WHERE smtp_message_id = $1', ['dup-mid@host'])
  assert.equal(rows[0].n, 1, 'second delivery must not create a second email_messages row')
})

test('[integration] flags inbound auto_submitted when worker forwarded the header', async () => {
  const { agentEmail } = await seedCompanyWithAgent()
  const r = await postInbound({
    messageId: 'auto-msg@host',
    from: 'vacation@external.com',
    to: [agentEmail],
    subject: 'Out of office',
    text: "I'm away.",
    autoSubmitted: 'auto-replied',
  })
  assert.equal(r.status, 200)
  const { rows } = await pool.query<{ auto_submitted: boolean }>(
    `SELECT auto_submitted FROM email_messages WHERE smtp_message_id = $1`,
    ['auto-msg@host'],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].auto_submitted, true)
})

test('[integration] inbound SES boomerang is deduplicated against the outbound row', async () => {
  // SES rewrites Message-ID on the wire, so when we send to a cumora-domain
  // address the boomerang inbound carries an SES-minted id that doesn't
  // match the smtp_message_id we stored on the outbound. Without echo
  // dedup, this creates a second conversation with the same message —
  // the bug the user observed in production. Verify the heuristic catches
  // it: same from/to/subject within 10 minutes ⇒ inbound returns
  // deduplicated and writes NO new row.
  const { findOrCreateEmailConversation, persistEmailMessage, mintMessageId } = await import('../email.js')
  const { companyId, agentId, agentEmail } = await seedCompanyWithAgent()
  const fromAddrFull = `yetone <user-x@${process.env.EMAIL_DOMAIN}>`

  // Seed the outbound row, as if compose just sent.
  const conv = await findOrCreateEmailConversation({
    companyId, inReplyTo: null, references: [],
    subject: '你好', memberIds: [agentId],
  })
  const ourId = mintMessageId()
  await persistEmailMessage({
    conversationId: conv.conversationId, companyId, authorId: agentId,
    direction: 'out', transportStatus: 'sent',
    smtpMessageId: ourId,
    inReplyTo: null, references: [],
    subject: '你好',
    fromAddr: fromAddrFull,
    toAddrs: [agentEmail],
    body: '你好啊',
  })

  // Now fire the boomerang: SES-flavored Message-ID, but same from/to/subject.
  const sesId = `0106019e2ac91d15-${randomHex(8)}-fa0180f0be6f-000000@ap-northeast-1.amazonses.com`
  const r = await postInbound({
    messageId: sesId,
    from: fromAddrFull,
    to: [agentEmail],
    subject: '你好',
    text: '你好啊',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.deduplicated, true)
  assert.equal(r.body.echo, true, 'echo dedup must flag this as the SES boomerang')

  // Confirm: only one conversation, only one email_messages row.
  const { rows: convs } = await pool.query('SELECT count(*)::int AS n FROM conversations WHERE kind = $1', ['email'])
  assert.equal(convs[0].n, 1, 'echo dedup should NOT create a second conversation')
  const { rows: msgs } = await pool.query('SELECT count(*)::int AS n FROM email_messages')
  assert.equal(msgs[0].n, 1, 'echo dedup should NOT create a second email_messages row')
})

function randomHex(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16)
  return s
}

test('[integration] inbound reply threads back to the original outbound conversation', async () => {
  // Regression test for the threading bug surfaced in production:
  // outbound mints a Message-ID and stores it as smtp_message_id; the
  // recipient's reply carries In-Reply-To: <that-id>; the inbound webhook
  // must look it up against email_messages.smtp_message_id and reuse the
  // same conversation rather than spawning a new one. Bug version split
  // every reply into a fresh thread.
  const { findOrCreateEmailConversation, persistEmailMessage, mintMessageId } = await import('../email.js')
  const { companyId, agentId, agentEmail } = await seedCompanyWithAgent()

  // 1. Seed the outbound row as if the user just composed + sent.
  const conv = await findOrCreateEmailConversation({
    companyId, inReplyTo: null, references: [],
    subject: 'hello', memberIds: [agentId],
  })
  const outboundMsgId = mintMessageId()
  await persistEmailMessage({
    conversationId: conv.conversationId, companyId, authorId: agentId,
    direction: 'out', transportStatus: 'sent',
    smtpMessageId: outboundMsgId,
    inReplyTo: null, references: [],
    subject: 'hello', fromAddr: agentEmail,
    toAddrs: ['alice@external.com'],
    body: 'world!',
  })

  // 2. Simulate the recipient replying with `In-Reply-To: <outboundMsgId>`.
  const r = await postInbound({
    messageId: 'reply-from-alice@external.com',
    from: 'Alice <alice@external.com>',
    to: [agentEmail],
    subject: 'Re: hello',
    text: 'Cool!',
    inReplyTo: outboundMsgId,
    references: [outboundMsgId],
  })
  assert.equal(r.status, 200)

  // 3. Both rows must live on the SAME conversation_id — the threading
  //    lookup matched the outbound's smtp_message_id.
  const { rows } = await pool.query<{ conversation_id: string }>(
    `SELECT DISTINCT conversation_id FROM email_messages
      WHERE smtp_message_id IN ($1, $2)`,
    [outboundMsgId, 'reply-from-alice@external.com'],
  )
  assert.equal(rows.length, 1, `outbound + reply must share a conversation; got rows=${JSON.stringify(rows)}`)
  assert.equal(rows[0].conversation_id, conv.conversationId)
})

test('[integration] inbound attachments land in email_attachments + storage', async () => {
  const { agentEmail } = await seedCompanyWithAgent()
  const helloBase64 = Buffer.from('Hello, world').toString('base64')
  const r = await postInbound({
    messageId: 'with-attach@host',
    from: 'alice@external.com',
    to: [agentEmail],
    subject: 'see attached',
    text: 'have a look',
    attachments: [
      { filename: 'note.txt', mimeType: 'text/plain', sizeBytes: 12, contentBase64: helloBase64 },
      { filename: 'big.bin', mimeType: 'application/octet-stream', sizeBytes: 99_999_999, contentBase64: '', truncated: true },
    ],
  })
  assert.equal(r.status, 200)
  const { rows } = await pool.query<{
    filename: string; mime_type: string; size_bytes: string; storage_key: string | null; truncated: boolean;
  }>(
    `SELECT filename, mime_type, size_bytes, storage_key, truncated
       FROM email_attachments
      ORDER BY filename`,
  )
  assert.equal(rows.length, 2)
  const big = rows.find((r) => r.filename === 'big.bin')!
  const note = rows.find((r) => r.filename === 'note.txt')!
  assert.equal(big.truncated, true)
  assert.equal(big.storage_key, null)
  assert.equal(note.truncated, false)
  assert.ok(note.storage_key && note.storage_key.startsWith('email-attachments/'),
    `expected storage_key under email-attachments/, got: ${note.storage_key}`)
})

test('[integration] delivers an inbound email to multiple recipients in the same company without duplicate collision or ghost threads', async () => {
  const { companyId, agentId: agent1Id, agentEmail: agent1Email } = await seedCompanyWithAgent()
  const agent2Id = `a-${randomUUID().slice(0, 8)}`
  const dom = process.env.EMAIL_DOMAIN || 'cumora.local'
  const agent2Email = `${agent2Id}.${companyId}@${dom}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail', $5)`,
    [agent2Id, companyId, `Agent ${agent2Id}`, agent2Id.slice(0, 1).toUpperCase(), agent2Email],
  )

  const r = await postInbound({
    messageId: 'multi-same-co@host',
    from: 'Alice <alice@external.com>',
    to: [agent1Email, agent2Email],
    subject: 'Joint announcement',
    text: 'Hello both',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.deliveries.length, 1, 'same company recipients share one delivery/message')

  // Exactly one email_messages row in the company
  const { rows: msgs } = await pool.query<{ company_id: string; message_id: string }>(
    `SELECT company_id, message_id FROM email_messages WHERE smtp_message_id = $1`,
    ['multi-same-co@host'],
  )
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].company_id, companyId)

  // Exactly one conversation created (no ghost thread with 0 messages!)
  const { rows: convos } = await pool.query<{ id: string; members: string[] }>(
    `SELECT id, members FROM conversations WHERE company_id = $1 AND kind = 'email'`,
    [companyId],
  )
  assert.equal(convos.length, 1, 'must leave exactly one conversation, no ghost thread')
  assert.ok(convos[0].members.includes(agent1Id))
  assert.ok(convos[0].members.includes(agent2Id))
})

test('[integration] delivers one inbound email addressed to two different companies independently (cross-tenant delivery)', async () => {
  const compA = await seedCompanyWithAgent()
  const compB = await seedCompanyWithAgent()

  const r = await postInbound({
    messageId: 'cross-tenant-msg@host',
    from: 'Partner <partner@external.com>',
    to: [compA.agentEmail, compB.agentEmail],
    subject: 'Cross company update',
    text: 'Hello to both teams',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.deliveries.length, 2, 'both companies receive delivery')

  // Both companies now have an email_messages row with the SAME smtp_message_id
  const { rows: msgs } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM email_messages WHERE smtp_message_id = $1 ORDER BY company_id`,
    ['cross-tenant-msg@host'],
  )
  assert.equal(msgs.length, 2)
  const storedCompanyIds = msgs.map((m) => m.company_id).sort()
  const expectedCompanyIds = [compA.companyId, compB.companyId].sort()
  assert.deepEqual(storedCompanyIds, expectedCompanyIds)

  // Neither company has a ghost conversation
  for (const cid of [compA.companyId, compB.companyId]) {
    const { rows: convos } = await pool.query<{ id: string }>(
      `SELECT c.id FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
       WHERE c.company_id = $1 AND c.kind = 'email' AND m.id IS NULL`,
      [cid],
    )
    assert.equal(convos.length, 0, `company ${cid} must have no ghost conversations`)
  }
})

test('[integration] de-duplicates identical recipient appearing in both To and Cc', async () => {
  const { companyId, agentEmail } = await seedCompanyWithAgent()

  const r = await postInbound({
    messageId: 'to-and-cc-same@host',
    from: 'Sender <sender@external.com>',
    to: [agentEmail],
    cc: [agentEmail],
    subject: 'Duplicate header test',
    text: 'Testing To and Cc deduplication',
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.deliveries.length, 1)

  const { rows: msgs } = await pool.query(
    `SELECT message_id FROM email_messages WHERE smtp_message_id = $1`,
    ['to-and-cc-same@host'],
  )
  assert.equal(msgs.length, 1)

  const { rows: convos } = await pool.query(
    `SELECT id FROM conversations WHERE company_id = $1 AND kind = 'email'`,
    [companyId],
  )
  assert.equal(convos.length, 1)
})

test('[integration] cleans up newly created conversation if message persistence fails', async () => {
  const { companyId } = await seedCompanyWithAgent()

  // We deliberately test the ghost thread cleanup: if persistEmailMessage throws
  // (e.g. invalid foreign key or database constraint), the created conversation must not remain.
  const { findOrCreateEmailConversation } = await import('../email.js')
  const conv = await findOrCreateEmailConversation({
    companyId,
    inReplyTo: null,
    references: [],
    subject: 'Ghost test',
    memberIds: [],
  })
  assert.equal(conv.created, true)

  // Verify ghost cleanup query
  await pool.query(
    `DELETE FROM conversations
      WHERE id = $1 AND company_id = $2
        AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1)`,
    [conv.conversationId, companyId],
  )

  const { rows: remaining } = await pool.query(
    `SELECT id FROM conversations WHERE id = $1`,
    [conv.conversationId],
  )
  assert.equal(remaining.length, 0, 'empty conversation should be cleaned up')
})
