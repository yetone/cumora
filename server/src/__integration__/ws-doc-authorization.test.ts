/**
 * Real WebSocket/document authorization regressions.
 *
 * These tests deliberately use createWsTicket + attachWebSocket, PostgreSQL
 * row/table locks, and an observer Client outside the application's max=20
 * pool.  The document room persists asynchronously, so fan-out is triggered
 * through the exported awareness path when the test is interested in the
 * authorization boundary itself.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { createWsTicket } from '../auth.js'
import { pool } from '../db/pool.js'
import { broadcastAwareness, evictDocumentRoom } from '../documents/rooms.js'
import { attachWebSocket } from '../ws.js'
import {
  buildApiTestApp,
  ensureSchemaOnce,
  resetAllTables,
  seedUserMembership,
  teardownAll,
} from './_helpers.js'

type Frame = Record<string, unknown>

interface SocketHarness {
  socket: WebSocket
  messages: Frame[]
}

interface DocumentFixture {
  companyId: string
  documentId: string
  users: string[]
}

const ACTOR_ID = 'z-ws-doc-actor'
const OBSERVER_QUERY_TIMEOUT_MS = 5_000
const FRAME_TIMEOUT_MS = 6_000

let server: Server
let baseUrl = ''
let wsUrl = ''
let wss: ReturnType<typeof attachWebSocket>
const openSockets = new Set<SocketHarness>()
const fixtureDocumentIds = new Set<string>()

function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.INTEGRATION_DATABASE_URL
  assert.ok(url, 'integration database URL is required')
  return url
}

async function within<T>(promise: Promise<T>, label: string, timeoutMs = OBSERVER_QUERY_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // A timed-out operation can still settle later.  Attach a rejection handler
  // so a deliberately failed barrier does not become an unhandled rejection
  // while the test cleans up its connections.
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

function parseFrame(raw: WebSocket.RawData): Frame | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString())
    return parsed && typeof parsed === 'object' ? parsed as Frame : null
  } catch {
    return null
  }
}

async function waitForFrame(
  harness: SocketHarness,
  predicate: (frame: Frame) => boolean,
  label: string,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<Frame> {
  const start = harness.messages.length
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = harness.messages.slice(start).find(predicate)
    if (found) return found
    await delay(5)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function waitForBlockedQuery(
  observer: Client,
  pattern: string,
  minimum = 1,
  timeoutMs = OBSERVER_QUERY_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ count: number }>(
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
  throw new Error(`query never reached ${minimum} blocked session(s): ${pattern}`)
}

async function openSocket(userId: string): Promise<SocketHarness> {
  const { ticket } = await createWsTicket(userId)
  const socket = new WebSocket(`${wsUrl}?t=${encodeURIComponent(ticket)}`)
  const harness: SocketHarness = { socket, messages: [] }
  socket.on('message', (raw) => {
    const frame = parseFrame(raw)
    if (frame) harness.messages.push(frame)
  })
  openSockets.add(harness)

  await within(new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('open', onOpen)
      socket.off('error', onError)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  }), `WebSocket open for ${userId}`)
  await waitForFrame(harness, (frame) => frame.type === 'hello', `${userId} hello`)
  return harness
}

async function subscribeSocket(harness: SocketHarness, documentId: string, replaySupported = true, omitCapability = false): Promise<void> {
  const frame: Record<string, unknown> = { type: 'doc.subscribe', documentId }
  if (!omitCapability) frame.replaySupported = replaySupported
  harness.socket.send(JSON.stringify(frame))
  await waitForFrame(
    harness,
    (frame) => frame.type === 'doc.sync' && frame.documentId === documentId,
    `doc.sync for ${documentId}`,
  )
}

async function openDocSocket(userId: string, documentId: string): Promise<SocketHarness> {
  const harness = await openSocket(userId)
  await subscribeSocket(harness, documentId)
  return harness
}

async function closeSocket(harness: SocketHarness): Promise<void> {
  openSockets.delete(harness)
  if (harness.socket.readyState === WebSocket.CLOSED) return
  await within(new Promise<void>((resolve) => {
    const finish = () => {
      harness.socket.off('close', finish)
      resolve()
    }
    harness.socket.once('close', finish)
    harness.socket.close()
    if (harness.socket.readyState === WebSocket.CLOSED) finish()
  }), 'WebSocket close')
}

async function waitForClosed(harness: SocketHarness, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (harness.socket.readyState !== WebSocket.CLOSED && Date.now() < deadline) {
    await delay(10)
  }
  assert.equal(harness.socket.readyState, WebSocket.CLOSED, 'socket did not close after auth exhaustion')
}

async function closeAllSockets(): Promise<void> {
  await Promise.allSettled([...openSockets].map(closeSocket))
}

async function seedDocumentFixture(viewerCount: number): Promise<DocumentFixture> {
  const companyId = `ws-doc-company-${randomUUID().replace(/-/g, '').slice(0, 14)}`
  const documentId = `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const users = [
    ACTOR_ID,
    ...Array.from(
      { length: Math.max(0, viewerCount - 1) },
      (_, index) => `a-ws-doc-viewer-${index}-${randomUUID().slice(0, 6)}`,
    ),
  ]
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'WS document authorization', $2, $3)`,
    [companyId, companyId, ACTOR_ID],
  )
  for (const userId of users) await seedUserMembership(userId, companyId)
  await pool.query(
    `UPDATE company_members
        SET role = CASE WHEN user_id = $2 THEN 'owner' ELSE 'member' END
      WHERE company_id = $1`,
    [companyId, ACTOR_ID],
  )
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ($1, $2, 'WS authorization fixture', $3)`,
    [documentId, companyId, ACTOR_ID],
  )
  fixtureDocumentIds.add(documentId)
  return { companyId, documentId, users }
}

async function beginUserLock(client: Client, userId: string): Promise<void> {
  await client.query('BEGIN')
  await client.query(
    `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  )
}

async function revokeMembership(userId: string, companyId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE participants
          SET departed_at = NOW(), status = 'resting', status_updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND kind = 'human'`,
      [userId, companyId],
    )
    await client.query(
      `DELETE FROM company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, userId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function emitAwareness(
  fixture: DocumentFixture,
  originId: string,
  size = 32,
): Promise<void> {
  await broadcastAwareness(
    fixture.documentId,
    fixture.companyId,
    originId,
    new Uint8Array(size).fill(7),
  )
}

async function deleteDocument(fixture: DocumentFixture): Promise<void> {
  const response = await fetch(`${baseUrl}/api/documents/${fixture.documentId}`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      'x-company-id': fixture.companyId,
    },
  })
  const body = await response.text()
  assert.equal(response.status, 200, body)
}

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(ACTOR_ID)
  server = createServer(app)
  wss = attachWebSocket(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      baseUrl = `http://127.0.0.1:${address.port}`
      wsUrl = `ws://127.0.0.1:${address.port}/ws`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
})

afterEach(() => {
  // rooms.ts intentionally keeps empty rooms for a 60s reconnect grace
  // period. Tests own these document ids, so evicting them here cancels those
  // timers and keeps this focused integration file from holding the runner
  // open for a full grace window.
  for (const documentId of fixtureDocumentIds) evictDocumentRoom(documentId)
  fixtureDocumentIds.clear()
})

after(async () => {
  await closeAllSockets()
  // Let the Redis workspace events emitted by the lock-order case finish
  // their local fan-out before teardown closes the shared application pool.
  await delay(250)
  for (const socket of wss.clients) socket.terminate()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await teardownAll(server)
})

test('a contended peer is detached without discarding a valid peer', async () => {
  const fixture = await seedDocumentFixture(3)
  const [actor, target, peer] = await Promise.all(
    fixture.users.map((userId) => openDocSocket(userId, fixture.documentId)),
  )
  const barrier = new Client({ connectionString: databaseUrl() })
  await barrier.connect()
  try {
    await beginUserLock(barrier, fixture.users[1]!)
    const originId = `contended-${randomUUID()}`
    const targetBefore = target.messages.length
    const actorBefore = actor.messages.length
    const peerBefore = peer.messages.length
    const fanout = emitAwareness(fixture, originId)
    await Promise.all([
      waitForFrame(actor, (frame) => frame.type === 'doc.awareness' && frame.originId === originId, 'valid actor frame'),
      waitForFrame(peer, (frame) => frame.type === 'doc.awareness' && frame.originId === originId, 'valid peer frame'),
    ])
    await fanout
    await delay(100)
    assert.ok(actor.messages.slice(actorBefore).some((frame) => frame.originId === originId))
    assert.ok(peer.messages.slice(peerBefore).some((frame) => frame.originId === originId))
    assert.equal(
      target.messages.slice(targetBefore).some((frame) => frame.originId === originId),
      false,
      'a NOWAIT-contended peer received a frame from the mixed batch',
    )
    assert.equal(actor.socket.readyState, WebSocket.OPEN, 'a valid actor was detached with the contended peer')
    assert.equal(peer.socket.readyState, WebSocket.OPEN, 'a valid peer was detached with the contended peer')
    await waitForClosed(target)
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    await barrier.end().catch(() => {})
    await Promise.allSettled([actor, target, peer].map(closeSocket))
  }
})

test('legacy subscribers retry contention without a forced disconnect', async () => {
  const fixture = await seedDocumentFixture(2)
  const actor = await openDocSocket(fixture.users[0]!, fixture.documentId)
  const legacy = await openSocket(fixture.users[1]!)
  // Omit replaySupported entirely: this is the pre-capability client shape.
  await subscribeSocket(legacy, fixture.documentId, false, true)
  const barrier = new Client({ connectionString: databaseUrl() })
  await barrier.connect()
  try {
    await beginUserLock(barrier, fixture.users[1]!)
    const originId = `legacy-contention-${randomUUID()}`
    const fanout = emitAwareness(fixture, originId)
    const local = new Y.Doc()
    local.getText('content').insert(0, 'legacy optimistic edit')
    const updateB64 = Buffer.from(Y.encodeStateAsUpdate(local)).toString('base64')
    legacy.socket.send(JSON.stringify({
      type: 'doc.update', documentId: fixture.documentId, updateB64,
    }))
    // The legacy path has a longer bounded NOWAIT retry window. Releasing
    // inside it proves an old client survives ordinary row contention.
    await delay(250)
    await barrier.query('ROLLBACK')
    await fanout
    await waitForFrame(legacy, (frame) => frame.type === 'doc.awareness' && frame.originId === originId, 'legacy peer frame')
    assert.equal(legacy.socket.readyState, WebSocket.OPEN)
    assert.equal(actor.socket.readyState, WebSocket.OPEN)
    const persistDeadline = Date.now() + 5_000
    let persistedText = ''
    while (Date.now() < persistDeadline && persistedText !== 'legacy optimistic edit') {
      const { rows } = await pool.query<{ update_bytes: Buffer }>(
        `SELECT update_bytes
           FROM document_updates
          WHERE document_id = $1 AND author_id = $2
          ORDER BY id DESC LIMIT 1`,
        [fixture.documentId, fixture.users[1]],
      )
      if (rows[0]) {
        const persisted = new Y.Doc()
        Y.applyUpdate(persisted, new Uint8Array(rows[0].update_bytes))
        persistedText = persisted.getText('content').toString()
      }
      if (persistedText !== 'legacy optimistic edit') await delay(25)
    }
    assert.equal(persistedText, 'legacy optimistic edit', 'legacy optimistic update was lost during contention')
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    await barrier.end().catch(() => {})
    await Promise.allSettled([actor, legacy].map(closeSocket))
  }
})

test('revocation committed before a retried authorization prevents the queued send', async () => {
  const fixture = await seedDocumentFixture(3)
  const [actor, target, peer] = await Promise.all(
    fixture.users.map((userId) => openDocSocket(userId, fixture.documentId)),
  )
  const barrier = new Client({ connectionString: databaseUrl() })
  await barrier.connect()
  try {
    const beforeOrigin = `before-revoke-${randomUUID()}`
    await emitAwareness(fixture, beforeOrigin)
    await waitForFrame(target, (frame) => frame.type === 'doc.awareness' && frame.originId === beforeOrigin, 'pre-revoke frame')

    // NOWAIT makes this a deterministic retry barrier: the outbound batch
    // cannot lock this user, while the revoke transaction can commit because it
    // changes the participant/membership rows rather than users.
    await beginUserLock(barrier, fixture.users[1]!)
    const afterOrigin = `after-revoke-${randomUUID()}`
    const targetBefore = target.messages.length
    const fanout = emitAwareness(fixture, afterOrigin)
    await revokeMembership(fixture.users[1]!, fixture.companyId)
    await barrier.query('ROLLBACK')
    await fanout
    await waitForFrame(peer, (frame) => frame.type === 'doc.awareness' && frame.originId === afterOrigin, 'valid peer after revoke')
    await delay(100)
    assert.equal(
      target.messages.slice(targetBefore).some((frame) => frame.originId === afterOrigin),
      false,
      'a queued send crossed a committed membership revoke',
    )
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    await barrier.end().catch(() => {})
    await Promise.allSettled([actor, target, peer].map(closeSocket))
  }
})

test('a queued authorization item cannot newly deliver after document deletion commits', async () => {
  const fixture = await seedDocumentFixture(3)
  const [actor, target, peer] = await Promise.all(
    fixture.users.map((userId) => openDocSocket(userId, fixture.documentId)),
  )
  const barrier = new Client({ connectionString: databaseUrl() })
  await barrier.connect()
  try {
    // The users row is part of the live authorization lock set, while the
    // document-delete transaction does not need that row. NOWAIT therefore
    // keeps the exact marker queued/contended while deletion can commit.
    await beginUserLock(barrier, fixture.users[1]!)
    const originId = `queued-delete-${randomUUID()}`
    const targetCursor = target.messages.length
    const fanout = emitAwareness(fixture, originId)
    // emitAwareness enqueues the local room item synchronously before its
    // Redis publish await. The delete begins only after that item exists.
    await deleteDocument(fixture)
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM documents WHERE id = $1`,
      [fixture.documentId],
    )
    assert.equal(rows[0]?.count, '0')
    await barrier.query('ROLLBACK')
    await fanout
    await delay(200)
    assert.equal(
      target.messages.slice(targetCursor).some((frame) => frame.originId === originId),
      false,
      'the queued target item delivered after document deletion committed',
    )
    // Any actor/peer frame that was authorized before the delete commit is
    // allowed; this assertion deliberately says nothing about network arrival
    // order for those already-authorized sends.
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    await barrier.end().catch(() => {})
    await Promise.allSettled([actor, target, peer].map(closeSocket))
  }
})

test('close and unsubscribe during blocked hydration do not leave active subscriptions', async () => {
  const closeFixture = await seedDocumentFixture(1)
  const closeSocketHarness = await openSocket(ACTOR_ID)
  const observer = new Client({ connectionString: databaseUrl() })
  const closeBarrier = new Client({ connectionString: databaseUrl() })
  await observer.connect()
  await closeBarrier.connect()
  try {
    await closeBarrier.query('BEGIN')
    await closeBarrier.query('LOCK TABLE document_snapshots IN ACCESS EXCLUSIVE MODE')
    const closeCursor = closeSocketHarness.messages.length
    closeSocketHarness.socket.send(JSON.stringify({ type: 'doc.subscribe', documentId: closeFixture.documentId }))
    await waitForBlockedQuery(observer, '%FROM document_snapshots%')
    await closeSocket(closeSocketHarness)
    await closeBarrier.query('COMMIT')
    await delay(150)
    assert.equal(
      closeSocketHarness.messages.slice(closeCursor).some((frame) => frame.type === 'doc.sync'),
      false,
      'closed socket completed a blocked subscription',
    )
  } finally {
    await closeBarrier.query('ROLLBACK').catch(() => {})
    await closeBarrier.end().catch(() => {})
    await observer.end().catch(() => {})
    await closeSocket(closeSocketHarness)
  }

  const unsubscribeFixture = await seedDocumentFixture(1)
  const unsubscribeSocket = await openSocket(ACTOR_ID)
  const unsubscribeBarrier = new Client({ connectionString: databaseUrl() })
  const unsubscribeObserver = new Client({ connectionString: databaseUrl() })
  await unsubscribeBarrier.connect()
  await unsubscribeObserver.connect()
  try {
    await unsubscribeBarrier.query('BEGIN')
    await unsubscribeBarrier.query('LOCK TABLE document_snapshots IN ACCESS EXCLUSIVE MODE')
    unsubscribeSocket.socket.send(JSON.stringify({ type: 'doc.subscribe', documentId: unsubscribeFixture.documentId }))
    await waitForBlockedQuery(unsubscribeObserver, '%FROM document_snapshots%')
    // FIFO handling must run this only after the blocked subscribe finishes.
    unsubscribeSocket.socket.send(JSON.stringify({ type: 'doc.unsubscribe', documentId: unsubscribeFixture.documentId }))
    await unsubscribeBarrier.query('COMMIT')

    // A second subscribe proves the queued unsubscribe actually ran. The
    // first sync may be dropped legitimately: FIFO can run the queued
    // unsubscribe immediately after hydration, before the sync's outbound
    // authorization batch gets its turn.
    unsubscribeSocket.socket.send(JSON.stringify({ type: 'doc.subscribe', documentId: unsubscribeFixture.documentId }))
    await waitForFrame(
      unsubscribeSocket,
      (frame) => frame.type === 'doc.sync' && frame.documentId === unsubscribeFixture.documentId,
      'second sync after queued unsubscribe',
    )
    unsubscribeSocket.socket.send(JSON.stringify({ type: 'doc.unsubscribe', documentId: unsubscribeFixture.documentId }))
    await delay(50)
    const originId = `after-unsubscribe-${randomUUID()}`
    const cursor = unsubscribeSocket.messages.length
    await emitAwareness(unsubscribeFixture, originId)
    await delay(200)
    assert.equal(
      unsubscribeSocket.messages.slice(cursor).some((frame) => frame.originId === originId),
      false,
      'queued unsubscribe left an active room subscription',
    )
  } finally {
    await unsubscribeBarrier.query('ROLLBACK').catch(() => {})
    await unsubscribeBarrier.end().catch(() => {})
    await unsubscribeObserver.end().catch(() => {})
    await closeSocket(unsubscribeSocket)
  }
})

test('opposite actor/recipient lock pressure completes without deadlock', async () => {
  const fixture = await seedDocumentFixture(3)
  const target = fixture.users[1]!
  const sockets = await Promise.all(fixture.users.map((userId) => openDocSocket(userId, fixture.documentId)))
  const observer = new Client({ connectionString: databaseUrl() })
  const barrier = new Client({ connectionString: databaseUrl() })
  await observer.connect()
  await barrier.connect()
  try {
    // The actor is deliberately lexically after the recipient. The API path
    // locks actor membership first, then recipient participant; the fan-out
    // query sees the same rows in its recipient set. NOWAIT + per-item retry
    // must make this a bounded contention case, never a deadlock.
    await barrier.query('BEGIN')
    await barrier.query(
      `SELECT id FROM participants WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [target, fixture.companyId],
    )
    const removePromise = fetch(`${baseUrl}/api/companies/${fixture.companyId}/members/${target}`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-company-id': fixture.companyId,
      },
    })
    await waitForBlockedQuery(observer, '%FROM participants%FOR UPDATE%')
    const originId = `lock-order-${randomUUID()}`
    const fanoutPromise = emitAwareness(fixture, originId)
    await barrier.query('COMMIT')
    const [removeResponse] = await within(Promise.all([removePromise, fanoutPromise]), 'actor/recipient lock-order completion')
    const body = await removeResponse.text()
    assert.equal(removeResponse.status, 200, body)
    // Valid-peer survival under a mixed contended batch is covered above. This
    // case intentionally focuses on the opposing actor/recipient lock order:
    // both operations must complete, even if NOWAIT causes this fan-out item
    // to be dropped while the revoke owns the participant lock.
  } finally {
    await barrier.query('ROLLBACK').catch(() => {})
    await barrier.end().catch(() => {})
    await observer.end().catch(() => {})
    await Promise.allSettled(sockets.map(closeSocket))
  }
})
