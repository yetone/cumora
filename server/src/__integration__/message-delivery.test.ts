import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'

const USER_ID = 'u-delivery-test'
const COMPANY_ID = 'c-delivery-test'
const CONVERSATION_ID = 'g-delivery-test'
const CLIENT_ID = 'temp-delivery-test'
let server: Server
let baseUrl = ''

before(async () => {
  process.env.CUMORA_TEST_MESSAGE_FAULTS = '1'
  await ensureSchemaOnce()
  const app = await buildApiTestApp(USER_ID)
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
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Delivery Test', 'delivery-test', $2)`,
    [COMPANY_ID, USER_ID],
  )
  await seedUserMembership(USER_ID, COMPANY_ID)
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ($1, 'group', 'Delivery Test', $2::jsonb, $3)`,
    [CONVERSATION_ID, JSON.stringify([USER_ID]), COMPANY_ID],
  )
})

after(async () => {
  delete process.env.CUMORA_TEST_MESSAGE_FAULTS
  await teardownAll(server)
})

test('[integration] retrying a committed message after a lost acknowledgement returns the original', async () => {
  await assert.rejects(fetch(`${baseUrl}/api/conversations/${CONVERSATION_ID}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-company-id': COMPANY_ID,
      'x-cumora-test-message-fault': 'after-commit-drop-ack',
    },
    body: JSON.stringify({ body: 'delivery probe', clientId: CLIENT_ID }),
  }))

  const retry = await fetch(`${baseUrl}/api/conversations/${CONVERSATION_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY_ID },
    body: JSON.stringify({ body: 'delivery probe', clientId: CLIENT_ID }),
  })
  assert.equal(retry.status, 202)
  const retried = await retry.json() as { id: string; sequence: number }

  const { rows } = await pool.query<{ id: string; author_id: string; body: string; client_id: string }>(
    `SELECT id, author_id, body, client_id FROM messages WHERE conversation_id = $1`,
    [CONVERSATION_ID],
  )
  assert.deepEqual(rows, [{
    id: retried.id,
    author_id: USER_ID,
    body: 'delivery probe',
    client_id: CLIENT_ID,
  }])

  const loaded = await fetch(`${baseUrl}/api/conversations/${CONVERSATION_ID}/messages`, {
    headers: { 'x-company-id': COMPANY_ID },
  })
  assert.equal(loaded.status, 200)
  const messages = await loaded.json() as Array<{ id: string; clientId?: string }>
  assert.equal(messages.find((message) => message.id === retried.id)?.clientId, CLIENT_ID)
})

test('[integration] concurrent requests with the same client id create one message', async () => {
  const send = () => fetch(`${baseUrl}/api/conversations/${CONVERSATION_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY_ID },
    body: JSON.stringify({ body: 'concurrent delivery probe', clientId: CLIENT_ID }),
  })
  const responses = await Promise.all([send(), send()])
  assert.deepEqual(responses.map((response) => response.status), [202, 202])
  const messages = await Promise.all(responses.map((response) => response.json() as Promise<{ id: string }>))
  assert.equal(messages[0]?.id, messages[1]?.id)

  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM messages WHERE conversation_id = $1`,
    [CONVERSATION_ID],
  )
  assert.equal(rows[0]?.count, '1')
})
