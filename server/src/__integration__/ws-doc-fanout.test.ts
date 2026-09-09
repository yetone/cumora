import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { createWsTicket } from '../auth.js'
import { broadcastAwareness as docBroadcastAwareness } from '../documents/rooms.js'
import { attachWebSocket } from '../ws.js'
import { pool } from '../db/pool.js'
import {
  ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'

interface SocketHarness {
  socket: WebSocket
  messages: Array<Record<string, unknown>>
  next: (predicate: (message: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
}

const USER_COUNT = 20
let server: Server
let wsUrl = ''
let wss: ReturnType<typeof attachWebSocket>

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  void promise.catch(() => {})
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function waitForMessage(socket: WebSocket, messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const existing = messages.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for document frame')), timeoutMs)
    const onMessage = (raw: WebSocket.RawData) => {
      let message: Record<string, unknown>
      try { message = JSON.parse(raw.toString()) as Record<string, unknown> } catch { return }
      messages.push(message)
      if (!predicate(message)) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolve(message)
    }
    socket.on('message', onMessage)
  })
}

async function openDocSocket(userId: string, documentId: string): Promise<SocketHarness> {
  const { ticket } = await createWsTicket(userId)
  const socket = new WebSocket(`${wsUrl}?t=${encodeURIComponent(ticket)}`)
  const messages: Array<Record<string, unknown>> = []
  socket.on('message', (raw: WebSocket.RawData) => {
    try { messages.push(JSON.parse(raw.toString()) as Record<string, unknown>) } catch { /* ignore */ }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })
  const next = (predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 5_000) =>
    waitForMessage(socket, messages, predicate, timeoutMs)
  await next((message) => message.type === 'hello')
  socket.send(JSON.stringify({ type: 'doc.subscribe', documentId, replaySupported: true }))
  await next((message) => message.type === 'doc.sync' && message.documentId === documentId)
  return { socket, messages, next }
}

async function closeSocket(harness: SocketHarness): Promise<void> {
  if (harness.socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    harness.socket.once('close', () => resolve())
    harness.socket.close()
  })
}

beforeEach(async () => {
  await resetAllTables()
})

before(async () => {
  await ensureSchemaOnce()
  server = createServer()
  wss = attachWebSocket(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('WS test server did not bind')
      wsUrl = `ws://127.0.0.1:${address.port}/ws`
      resolve()
    })
  })
})

after(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  // onHumanDisconnect publishes presence asynchronously; let those callbacks
  // finish before teardown closes the shared pool used by the Redis fan-out.
  await delay(250)
  await teardownAll(server)
})

test('20-user document fan-out batches auth work and preserves immediate revoke', async () => {
  const companyId = `ws-doc-company-${randomUUID().slice(0, 8)}`
  const documentId = `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const users = Array.from({ length: USER_COUNT }, (_, index) => `ws-doc-user-${index}-${randomUUID().slice(0, 6)}`)
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'WS document fan-out', $2, $3)`,
    [companyId, companyId, users[0]],
  )
  for (const userId of users) await seedUserMembership(userId, companyId)
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ($1, $2, 'WS fan-out', $3)`,
    [documentId, companyId, users[0]],
  )

  const sockets = await Promise.all(users.map((userId) => openDocSocket(userId, documentId)))
  try {
    const local = new Y.Doc()
    local.getText('content').insert(0, 'first update')
    sockets[0].socket.send(JSON.stringify({
      type: 'doc.update', documentId,
      updateB64: Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64'),
    }))
    await Promise.all(sockets.slice(1).map((harness) =>
      harness.next((message) => message.type === 'doc.update' && message.documentId === documentId)))

    // Direct room emission bypasses inbound auth and makes the outbound pool
    // budget observable while the document rows are locked. A relation lock is
    // deliberate: NOWAIT only changes tuple-lock handling, while this forces
    // the real outbound authorization SELECT into pg_stat_activity's Lock wait
    // state for both the old per-viewer path and the new batched path.
    const databaseUrl = process.env.INTEGRATION_DATABASE_URL ?? process.env.DATABASE_URL
    assert.ok(databaseUrl)
    const barrier = new Client({ connectionString: databaseUrl })
    const observer = new Client({ connectionString: databaseUrl })
    await barrier.connect()
    await observer.connect()
    try {
      await barrier.query('BEGIN')
      await barrier.query('LOCK TABLE documents IN ACCESS EXCLUSIVE MODE')
      const budgetOrigin = `budget-${randomUUID()}`
      const budgetFanout = docBroadcastAwareness(documentId, companyId, budgetOrigin, new Uint8Array([1, 2, 3, 4]))
      const { rows: observerPidRows } = await observer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const observerPid = observerPidRows[0]?.pid
      assert.ok(observerPid, 'observer must expose a PostgreSQL backend pid')
      let maximumBusy = 0
      let observedAuthWait = false
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const { rows } = await observer.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> $1
              AND state <> 'idle'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%FROM documents%'
              AND query ILIKE '%JOIN company_members cm%'
              AND query ILIKE '%FOR SHARE%'`,
          [observerPid],
        )
        const waitingAuth = rows[0]?.count ?? 0
        if (waitingAuth > 0) observedAuthWait = true
        maximumBusy = Math.max(maximumBusy, pool.totalCount - pool.idleCount)
        if (observedAuthWait && maximumBusy > 4) break
        await delay(10)
      }
      assert.equal(observedAuthWait, true, 'never observed a real outbound authorization query waiting on the document lock')
      assert.ok(maximumBusy <= 4, `document auth exceeded the global semaphore bound: ${maximumBusy}`)
      await withTimeout(pool.query('SELECT 1'), 'a new application-pool query while auth is locked')
      await barrier.query('COMMIT')
      await budgetFanout
      await Promise.all(sockets.map((harness) =>
        harness.next((message) => message.type === 'doc.awareness'
          && message.documentId === documentId
          && message.originId === budgetOrigin)))
    } finally {
      await barrier.query('ROLLBACK').catch(() => {})
      await barrier.end().catch(() => {})
      await observer.end().catch(() => {})
    }

    const revoked = sockets[1]
    const revokedBefore = revoked.messages.length
    await pool.query(
      `UPDATE participants SET departed_at = NOW() WHERE id = $1 AND company_id = $2`,
      [users[1], companyId],
    )
    const next = new Y.Doc()
    next.getText('content').insert(0, 'after revoke marker')
    const revokedUpdateB64 = Buffer.from(Y.encodeStateAsUpdate(next)).toString('base64')
    sockets[0].socket.send(JSON.stringify({
      type: 'doc.update', documentId,
      updateB64: revokedUpdateB64,
    }))
    await Promise.all(sockets.slice(2).map((harness) =>
      harness.next((message) => message.type === 'doc.update'
        && message.documentId === documentId
        && message.updateB64 === revokedUpdateB64)))
    await delay(150)
    assert.equal(
      revoked.messages.slice(revokedBefore).some((message) =>
        message.type === 'doc.update' && message.updateB64 === revokedUpdateB64),
      false,
      'revoked subscriber received a post-commit document frame',
    )

    const fifoTarget = sockets[2]
    const beforeFifo = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM document_updates WHERE document_id = $1 AND author_id = $2`,
      [documentId, users[2]],
    )
    fifoTarget.socket.send(JSON.stringify({ type: 'doc.unsubscribe', documentId }))
    const fifoUpdate = new Y.Doc()
    fifoUpdate.getText('content').insert(0, 'must not pass unsubscribe')
    fifoTarget.socket.send(JSON.stringify({
      type: 'doc.update', documentId,
      updateB64: Buffer.from(Y.encodeStateAsUpdate(fifoUpdate)).toString('base64'),
    }))
    await delay(200)
    const afterFifo = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM document_updates WHERE document_id = $1 AND author_id = $2`,
      [documentId, users[2]],
    )
    assert.equal(afterFifo.rows[0]?.count, beforeFifo.rows[0]?.count, 'unsubscribe/update order was not FIFO')
  } finally {
    await Promise.all(sockets.map(closeSocket))
  }
})
