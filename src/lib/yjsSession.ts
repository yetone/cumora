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
import type { WsEvent } from '@/api/client'
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
  /** Called when pending local state exceeds the frame limit, and with null
   *  after local state has been handed to the socket (not a persistence ACK). */
  onSyncState?: (error: Error | null) => void
}

export interface DocumentTransport {
  send(payload: unknown): boolean
  isOpen(): boolean
  connect(): Promise<void>
  on(listener: (event: WsEvent) => void): () => void
}

export function createDocumentSession(opts: OpenDocumentOptions, ws: DocumentTransport): YDocSession {
  const { documentId, user } = opts
  const doc = new Y.Doc()
  // The default top-level Y.Text used by the editor binding. Same key
  // the server-side agent tools use so an agent edit shows up here.
  doc.getText('content')

  const awareness = new Awareness(doc)
  awareness.setLocalState({ user: { id: user.id, name: user.name, color: user.color } })

  let resolveSynced: () => void = () => { /* assigned below */ }
  const synced = new Promise<void>((r) => { resolveSynced = r })

  let destroyed = false
  let receivedSnapshot = false
  let pendingUpdate: Uint8Array | null = null
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const retry = () => {
    if (destroyed || retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      if (!ws.isOpen()) return // hello will replay the Y.Doc after reconnect.
      if (receivedSnapshot) flushPending()
      else subscribe()
    }, 500)
  }

  const flushPending = () => {
    if (destroyed || !receivedSnapshot || !pendingUpdate) return
    if (!replayFitsDocFrame(pendingUpdate, documentId)) {
      opts.onSyncState?.(new Error('document replay exceeds the sync frame limit'))
      return
    }
    if (!ws.send({ type: 'doc.update', documentId, updateB64: bytesToB64(pendingUpdate) })) {
      retry()
      return
    }
    pendingUpdate = null
    opts.onSyncState?.(null)
    resolveSynced()
  }

  // Outbound: any local update goes upstream. Origin `remote` means the
  // update came in via the WS path — skip echoing it back.
  const handleUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return
    // While subscribing, the Y.Doc retains edits for the snapshot diff.
    if (!receivedSnapshot) return
    pendingUpdate = pendingUpdate ? Y.mergeUpdates([pendingUpdate, update]) : update
    flushPending()
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
    if (destroyed) return
    // The server replies with `doc.sync` carrying the encoded state.
    if (ws.isOpen()) {
      if (!ws.send({ type: 'doc.subscribe', documentId, replaySupported: true })) retry()
    }
  }

  const onWsEvent = (e: WsEvent) => {
    if (e.type === 'hello') {
      receivedSnapshot = false
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
      receivedSnapshot = true
      // Include even edits accepted by the old socket but lost in transit.
      pendingUpdate = replay
      flushPending()
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
      if (destroyed) return
      destroyed = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      off()
      doc.off('update', handleUpdate)
      awareness.off('update', handleAwarenessChange)
      // Clear local awareness so peers see us leave.
      removeAwarenessStates(awareness, [doc.clientID], 'local')
      if (ws.isOpen()) {
        ws.send({ type: 'doc.unsubscribe', documentId })
      }
      awareness.destroy()
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
