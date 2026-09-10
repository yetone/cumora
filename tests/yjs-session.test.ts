import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import type { WsEvent } from '../src/api/client'
import { createDocumentSession, type DocumentTransport } from '../src/lib/yjsSession'

const documentId = 'test-document'
const options = { documentId, user: { id: 'user', name: 'User', color: '#123456' } }

class Transport implements DocumentTransport {
  server = new Y.Doc()
  open = true
  subscribed = false
  failUpdates = false
  dropUpdates = false
  failSubscribe = false
  sent: Array<{ type: string; updateB64?: string }> = []
  listeners = new Set<(event: WsEvent) => void>()

  async connect() {}
  isOpen() { return this.open }
  on(listener: (event: WsEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  send(payload: unknown) {
    const frame = payload as { type: string; updateB64?: string }
    this.sent.push(frame)
    if (!this.open) return false
    if (frame.type === 'doc.subscribe') {
      if (this.failSubscribe) return false
      this.subscribed = true
    }
    if (frame.type === 'doc.unsubscribe') this.subscribed = false
    if (frame.type === 'doc.update') {
      if (this.failUpdates) return false
      if (this.subscribed && !this.dropUpdates) {
        Y.applyUpdate(this.server, Buffer.from(frame.updateB64!, 'base64'))
      }
    }
    return true
  }
  emit(event: WsEvent) { this.listeners.forEach((listener) => { listener(event) }) }
  disconnect() { this.open = false; this.subscribed = false }
  hello() {
    this.open = true
    this.emit({ type: 'hello' } as WsEvent)
  }
  snapshot() {
    assert.ok(this.subscribed)
    this.emit({ type: 'doc.sync', documentId, originId: 'server',
      stateB64: Buffer.from(Y.encodeStateAsUpdate(this.server)).toString('base64') })
  }
}

for (const dropUpdates of [false, true]) {
  test(`offline edit, reconnect, continue, reopen (silent loss: ${dropUpdates})`, async (t) => {
    const transport = new Transport()
    transport.server.getText('content').insert(0, 'A')
    const session = createDocumentSession(options, transport)
    t.after(() => { session.destroy(); transport.server.destroy() })
    await Promise.resolve()
    transport.snapshot()
    await session.synced

    if (dropUpdates) transport.dropUpdates = true
    else transport.disconnect()
    session.doc.getText('content').insert(1, 'B')
    assert.equal(transport.server.getText('content').toString(), 'A')

    transport.disconnect()
    transport.dropUpdates = false
    transport.hello()
    transport.snapshot()
    session.doc.getText('content').insert(2, 'C')
    assert.equal(session.doc.getText('content').toString(), 'ABC')
    assert.equal(transport.server.getText('content').toString(), 'ABC')

    session.destroy()
    const reopened = createDocumentSession(options, transport)
    t.after(() => reopened.destroy())
    await Promise.resolve()
    transport.snapshot()
    await reopened.synced
    assert.equal(reopened.doc.getText('content').toString(), 'ABC')
  })
}

test('failed replay retries without another edit or reconnect and does not signal success early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = new Transport()
  const states: Array<Error | null> = []
  const session = createDocumentSession({ ...options, onSyncState: (error) => states.push(error) }, transport)
  t.after(() => { session.destroy(); transport.server.destroy() })
  await Promise.resolve()
  session.doc.getText('content').insert(0, 'A')
  transport.failUpdates = true
  transport.snapshot()
  let synced = false
  void session.synced.then(() => { synced = true })
  await Promise.resolve()
  assert.equal(synced, false)
  assert.deepEqual(states, [])
  transport.failUpdates = false
  t.mock.timers.tick(500)
  await session.synced
  assert.deepEqual(states, [null])
  assert.equal(transport.server.getText('content').toString(), 'A')
})

test('failed live updates retain Yjs dependencies when later edits are sent', async (t) => {
  const transport = new Transport()
  const session = createDocumentSession(options, transport)
  t.after(() => { session.destroy(); transport.server.destroy() })
  await Promise.resolve()
  transport.snapshot()
  transport.failUpdates = true
  session.doc.getText('content').insert(0, 'B')
  transport.failUpdates = false
  session.doc.getText('content').insert(1, 'C')
  assert.equal(transport.server.getText('content').toString(), 'BC')
})

test('reconnect merges offline deletion, remote edits, and edits while awaiting snapshot', async (t) => {
  const transport = new Transport()
  transport.server.getText('content').insert(0, 'AB')
  const session = createDocumentSession(options, transport)
  t.after(() => { session.destroy(); transport.server.destroy() })
  await Promise.resolve()
  transport.snapshot()
  transport.disconnect()
  session.doc.getText('content').delete(1, 1)
  transport.server.getText('content').insert(2, 'R')
  transport.hello()
  const before = transport.sent.length
  session.doc.getText('content').insert(1, 'C')
  assert.equal(transport.sent.length, before)
  transport.snapshot()
  const result = session.doc.getText('content').toString()
  assert.ok(result.includes('A') && result.includes('C') && result.includes('R'))
  assert.ok(!result.includes('B'))
  assert.equal(transport.server.getText('content').toString(), result)
})

test('failed subscription retries; destroying a session cancels retry and deferred connect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const transport = new Transport()
  transport.failSubscribe = true
  const session = createDocumentSession(options, transport)
  t.after(() => transport.server.destroy())
  await Promise.resolve()
  assert.equal(transport.subscribed, false)
  transport.failSubscribe = false
  t.mock.timers.tick(500)
  assert.equal(transport.subscribed, true)
  transport.failUpdates = true
  transport.snapshot()
  session.destroy()
  const count = transport.sent.length
  t.mock.timers.tick(1000)
  assert.equal(transport.sent.length, count)
  const immediatelyClosed = createDocumentSession(options, transport)
  immediatelyClosed.destroy()
  const closedCount = transport.sent.length
  await Promise.resolve()
  assert.equal(transport.sent.length, closedCount)
})
