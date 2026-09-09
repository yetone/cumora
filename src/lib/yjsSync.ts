import * as Y from 'yjs'

/** The server's WebSocket maxPayload. Replay checks the serialized envelope,
 * including base64/JSON framing, instead of guessing a raw Yjs byte budget. */
export const DOC_WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

export function replayFitsDocFrame(update: Uint8Array, documentId: string): boolean {
  const base64Bytes = Math.ceil(update.byteLength / 3) * 4
  const envelopeBytes = new TextEncoder().encode(JSON.stringify({
    type: 'doc.update', documentId, updateB64: '',
  })).byteLength
  return envelopeBytes + base64Bytes <= DOC_WS_MAX_PAYLOAD_BYTES
}

/** Apply a server snapshot and return local state that the snapshot did not
 * contain. The caller sends the returned update through the normal authorized
 * doc.update path. Yjs may encode a no-op as a non-empty update; callers must
 * inspect byteLength rather than assume an empty state is zero bytes. */
export function applyServerSyncAndGetLocalReplay(doc: Y.Doc, serverState: Uint8Array): Uint8Array {
  const localUpdate = Y.encodeStateAsUpdate(doc)
  const serverVector = Y.encodeStateVectorFromUpdate(serverState)
  const replay = Y.diffUpdate(localUpdate, serverVector)
  Y.applyUpdate(doc, serverState, 'remote')
  return replay
}
