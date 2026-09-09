/**
 * Browser-side Y.Doc session for a single collaborative document.
 *
 * One YDocSession per opened document. It owns a Y.Doc + Awareness
 * instance and bridges them to the existing WsClient: outbound updates
 * are emitted as `doc.update` envelopes, inbound `doc.update` /
 * `doc.sync` / `doc.awareness` frames are applied locally.
 *
 * We deliberately don't use y-websocket — the existing Cumora WS path
 * already handles auth + reconnect + tenant scoping, so an extra socket
 * would just duplicate state. Yjs binary updates are b64-wrapped so
 * they fit the JSON envelope the rest of the app speaks.
 */
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import { ws, type WsEvent } from '@/api/client'
import { applyServerSyncAndGetLocalReplay, replayFitsDocFrame } from './yjsSync'

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export interface YDocSession {
  doc: Y.Doc
  awareness: Awareness
  /** True after the server has sent its initial state. The UI can wait
   *  on this to avoid showing an empty editor for a brief moment before
   *  the doc loads. */
  synced: Promise<void>
  /** Tear down listeners + flush an awareness-clear so other clients
   *  drop the local cursor immediately. */
  destroy: () => void
}

export interface OpenDocumentOptions {
  documentId: string
  /** Free-form identity stamped on awareness so peers can render
   *  "<name> is editing". Typically the user's display name. */
  user: { id: string; name: string; color: string }
  /** Called when local state cannot fit in one authorized replay frame, and
   *  again with null after a later sync recovers. */
  onSyncState?: (error: Error | null) => void
}

export function openDocument(opts: OpenDocumentOptions): YDocSession {
  const { documentId, user } = opts
  const doc = new Y.Doc()
  // The default top-level Y.Text used by the editor binding. Same key
  // the server-side agent tools use so an agent edit shows up here.
  doc.getText('content')

  const awareness = new Awareness(doc)
  awareness.setLocalState({ user: { id: user.id, name: user.name, color: user.color } })

  let resolveSynced: () => void = () => { /* assigned below */ }
  const synced = new Promise<void>((r) => { resolveSynced = r })

  // Outbound: any local update goes upstream. Origin `remote` means the
  // update came in via the WS path — skip echoing it back.
  const handleUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return
    ws.send({
      type: 'doc.update',
      documentId,
      updateB64: bytesToB64(update),
    })
  }
  doc.on('update', handleUpdate)

  const handleAwarenessChange = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === 'remote') return
    const clients = [...changes.added, ...changes.updated, ...changes.removed]
    if (!clients.length) return
    const update = encodeAwarenessUpdate(awareness, clients)
    ws.send({
      type: 'doc.awareness',
      documentId,
      updateB64: bytesToB64(update),
    })
  }
  awareness.on('update', handleAwarenessChange)

  const subscribe = () => {
    // The server replies with `doc.sync` carrying the encoded state.
    if (ws.isOpen()) {
      ws.send({ type: 'doc.subscribe', documentId, replaySupported: true })
    }
  }

  const onWsEvent = (e: WsEvent) => {
    if (e.type === 'hello') {
      // Reconnected — re-subscribe and re-broadcast our awareness so
      // peers refresh our cursor on the new socket.
      subscribe()
      const clientId = doc.clientID
      const update = encodeAwarenessUpdate(awareness, [clientId])
      ws.send({
        type: 'doc.awareness',
        documentId,
        updateB64: bytesToB64(update),
      })
      return
    }
    if (e.type === 'doc.sync' && e.documentId === documentId) {
      const replay = applyServerSyncAndGetLocalReplay(doc, b64ToBytes(e.stateB64))
      if (!replayFitsDocFrame(replay, documentId)) {
        opts.onSyncState?.(new Error('document replay exceeds the sync frame limit'))
        return
      }
      if (replay.byteLength > 0) {
        ws.send({
          type: 'doc.update',
          documentId,
          updateB64: bytesToB64(replay),
        })
      }
      opts.onSyncState?.(null)
      resolveSynced()
      return
    }
    if (e.type === 'doc.update' && e.documentId === documentId) {
      Y.applyUpdate(doc, b64ToBytes(e.updateB64), 'remote')
      return
    }
    if (e.type === 'doc.awareness' && e.documentId === documentId) {
      applyAwarenessUpdate(awareness, b64ToBytes(e.updateB64), 'remote')
      return
    }
  }

  const off = ws.on(onWsEvent)
  // Kick off the connection if it isn't already open, then send subscribe.
  void ws.connect().then(() => subscribe())

  return {
    doc,
    awareness,
    synced,
    destroy() {
      off()
      doc.off('update', handleUpdate)
      awareness.off('update', handleAwarenessChange)
      // Clear local awareness so peers see us leave.
      removeAwarenessStates(awareness, [doc.clientID], 'local')
      if (ws.isOpen()) {
        ws.send({ type: 'doc.unsubscribe', documentId })
      }
      doc.destroy()
    },
  }
}

/** Awareness peer state as broadcast by openDocument. */
export interface AwarenessPeer {
  clientId: number
  user: { id: string; name: string; color: string }
}

export function readPeers(awareness: Awareness, selfClientId: number): AwarenessPeer[] {
  const peers: AwarenessPeer[] = []
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === selfClientId) return
    const u = (state as { user?: { id: string; name: string; color: string } }).user
    if (!u) return
    peers.push({ clientId, user: u })
  })
  return peers
}
