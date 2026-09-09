import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as Y from 'yjs'
import { applyServerSyncAndGetLocalReplay, DOC_WS_MAX_PAYLOAD_BYTES, replayFitsDocFrame } from '../src/lib/yjsSync'

test('server sync replays local optimistic edits that the snapshot lacks', () => {
  const server = new Y.Doc()
  server.getText('content').insert(0, 'server')
  const serverState = Y.encodeStateAsUpdate(server)

  const local = new Y.Doc()
  local.getText('content').insert(0, 'local')
  const replay = applyServerSyncAndGetLocalReplay(local, serverState)

  assert.ok(replay.byteLength > 0)
  const converged = new Y.Doc()
  Y.applyUpdate(converged, serverState)
  Y.applyUpdate(converged, replay)
  assert.equal(converged.getText('content').toString(), local.getText('content').toString())
})

test('server deletions are applied and replay is idempotent', () => {
  const server = new Y.Doc()
  const serverText = server.getText('content')
  serverText.insert(0, 'obsolete')
  const base = Y.encodeStateAsUpdate(server)
  serverText.delete(0, serverText.length)
  const deleted = Y.encodeStateAsUpdate(server)

  const local = new Y.Doc()
  Y.applyUpdate(local, base)
  local.getText('content').insert(0, 'local')
  const replay = applyServerSyncAndGetLocalReplay(local, deleted)

  const converged = new Y.Doc()
  Y.applyUpdate(converged, deleted)
  Y.applyUpdate(converged, replay)
  Y.applyUpdate(converged, replay)
  assert.equal(converged.getText('content').toString(), local.getText('content').toString())
})

test('oversized local replay stays in the Y.Doc for the client sync-limit guard', () => {
  const server = new Y.Doc()
  const serverState = Y.encodeStateAsUpdate(server)
  const local = new Y.Doc()
  const original = 'x'.repeat(DOC_WS_MAX_PAYLOAD_BYTES)
  local.getText('content').insert(0, original)

  const replay = applyServerSyncAndGetLocalReplay(local, serverState)
  assert.ok(replay.byteLength > 0)
  assert.equal(replayFitsDocFrame(replay, 'doc-large'), false)
  assert.equal(local.getText('content').toString(), original)
})

test('a smaller replay fits the serialized doc.update envelope', () => {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'small local edit')
  const replay = Y.encodeStateAsUpdate(doc)
  assert.equal(replayFitsDocFrame(replay, 'doc-small'), true)
})
