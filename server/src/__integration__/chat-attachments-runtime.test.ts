import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { validateAttachmentInput } from '../../../shared/attachments.js'
import { signAgentToken } from '../agents/runtime/jwt.js'
import { pool } from '../db/pool.js'
import { drainRealtimeOutbox } from '../realtime-outbox.js'
import { CH_MESSAGE_NEW, redis } from '../redis.js'
import { storage, UPLOAD_DIR } from '../storage.js'
import { findReferencedStorageKeys } from '../workspace-cleanup.js'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent,
  seedUserMembership, teardownAll,
} from './_helpers.js'

const USER_ID = 'u-chat-attachments'
const COMPANY_ID = 'c-chat-attachments'
const CONVERSATION_ID = 'g-chat-attachments'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(USER_ID)
  const expressMod = await import('express')
  app.use('/uploads', expressMod.default.static(UPLOAD_DIR))
  const { runtimeRouter } = await import('../agents/runtime/server.js')
  app.use('/runtime', runtimeRouter)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Chat attachment test', 'chat-attachment-test', $2)`,
    [COMPANY_ID, USER_ID],
  )
  await seedUserMembership(USER_ID, COMPANY_ID)
  const agent = await seedCompanyWithAgent({ companyId: COMPANY_ID, agentId: 'a-chat-attachments' })
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ($1, 'group', 'Chat attachment test', $2::jsonb, $3)`,
    [CONVERSATION_ID, JSON.stringify([USER_ID, agent.agentId]), COMPANY_ID],
  )
})

after(async () => { await teardownAll(server) })

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY_ID },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

async function runtimeToken(): Promise<string> {
  const { rows } = await pool.query<{
    computer_id: string | null
    runtime_assignment_id: string
  }>(
    `SELECT computer_id, runtime_assignment_id
       FROM participants
      WHERE id = 'a-chat-attachments' AND company_id = $1`,
    [COMPANY_ID],
  )
  assert.ok(rows[0])
  return signAgentToken({
    agentId: 'a-chat-attachments',
    companyId: COMPANY_ID,
    computerId: rows[0].computer_id,
    assignmentId: rows[0].runtime_assignment_id,
  })
}

test('[integration] UI-shaped two-attachment send reaches Redis and both runtime downloads', async () => {
  const firstBytes = Buffer.from('first attachment from the composer')
  const secondBytes = Buffer.from('second attachment from the composer')
  const uploadedKeys: string[] = []
  let subscriber: ReturnType<typeof redis.duplicate> | undefined

  try {
    const first = await post('/uploads', {
      name: 'first.md', mime: 'text/markdown', dataBase64: firstBytes.toString('base64'),
    })
    const second = await post('/uploads', {
      name: 'second.md', mime: 'text/markdown', dataBase64: secondBytes.toString('base64'),
    })
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    const firstUpload = validateAttachmentInput(first.body)
    const secondUpload = validateAttachmentInput(second.body)
    assert.ok(firstUpload.ok)
    assert.ok(secondUpload.ok)
    const firstAttachment = firstUpload.attachments[0]
    const secondAttachment = secondUpload.attachments[0]
    assert.ok(firstAttachment?.key && firstAttachment.url && firstAttachment.mime && firstAttachment.size !== undefined)
    assert.ok(secondAttachment?.key && secondAttachment.url && secondAttachment.mime && secondAttachment.size !== undefined)
    uploadedKeys.push(firstAttachment.key, secondAttachment.key)

    const sent = await post(`/conversations/${CONVERSATION_ID}/messages`, {
      body: 'summarize both files',
      attachments: [firstAttachment, secondAttachment],
    })
    assert.equal(sent.status, 202)
    assert.ok(sent.body && typeof sent.body === 'object' && 'id' in sent.body && typeof sent.body.id === 'string')
    const messageId = sent.body.id

    const persisted = await pool.query<{
      attachments: Array<Record<string, unknown>>
      attachment: Record<string, unknown>
    }>(
      `SELECT attachments, attachment FROM messages WHERE id = $1`, [messageId],
    )
    assert.equal(persisted.rows[0]?.attachments.length, 2)
    assert.equal(persisted.rows[0]?.attachments[0]?.key, firstAttachment.key)
    assert.equal(persisted.rows[0]?.attachments[1]?.key, secondAttachment.key)
    assert.equal(persisted.rows[0]?.attachment.key, firstAttachment.key)
    const referenced = await findReferencedStorageKeys([firstAttachment.key, secondAttachment.key])
    assert.deepEqual([...referenced].sort(), [firstAttachment.key, secondAttachment.key].sort())

    const grants = await pool.query<{ storage_key: string; status: string }>(
      `SELECT storage_key, status FROM attachment_grants
        WHERE company_id = $1 ORDER BY storage_key`, [COMPANY_ID],
    )
    assert.deepEqual(grants.rows, [
      { storage_key: firstAttachment.key, status: 'active' },
      { storage_key: secondAttachment.key, status: 'active' },
    ].sort((a, b) => a.storage_key.localeCompare(b.storage_key)))

    const outbox = await pool.query<{ channel: string; published_at: Date | null }>(
      `SELECT channel, published_at FROM realtime_outbox
        WHERE channel = $1`, [CH_MESSAGE_NEW],
    )
    assert.equal(outbox.rows.length, 1)
    assert.equal(outbox.rows[0]?.published_at, null)

    const activeSubscriber = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null })
    subscriber = activeSubscriber
    const redisEvent = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for Redis message.new')), 5_000)
      activeSubscriber.once('message', (channel, message) => {
        if (channel !== CH_MESSAGE_NEW) return
        clearTimeout(timer)
        resolve(JSON.parse(message) as Record<string, unknown>)
      })
    })
    await activeSubscriber.subscribe(CH_MESSAGE_NEW)
    const drained = await drainRealtimeOutbox()
    assert.deepEqual(drained, { claimed: 1, published: 1, failed: 0, discarded: 0 })
    const event = await redisEvent
    assert.equal(event.type, 'message.new')
    assert.equal((event.message as Record<string, unknown>).id, messageId)
    const published = await pool.query<{ published_at: Date | null }>(
      `SELECT published_at FROM realtime_outbox WHERE channel = $1`, [CH_MESSAGE_NEW],
    )
    assert.ok(published.rows[0]?.published_at)

    const token = await runtimeToken()
    for (const [key, expected] of [[firstAttachment.key, firstBytes], [secondAttachment.key, secondBytes]] as const) {
      const response = await fetch(
        `${baseUrl}/runtime/attachment?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(messageId)}`,
        { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' },
      )
      assert.equal(response.status, 303)
      const location = response.headers.get('location')
      assert.ok(location)
      const downloaded = await fetch(new URL(location, baseUrl))
      assert.equal(downloaded.status, 200)
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), expected)
    }
  } finally {
    subscriber?.disconnect()
    await Promise.all(uploadedKeys.map((key) => storage.deleteObject(key)))
  }
})
