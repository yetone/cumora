/**
 * In-process Y.Doc room manager.
 *
 * One Y.Doc per opened document is held in memory while at least one
 * local subscriber (a WS client or an agent loop) is attached. When the
 * last subscriber detaches we keep the room around for a short grace
 * window so a refresh / quick re-open doesn't pay the cold-load cost.
 *
 * Persistence is append-only: every Y.Doc 'update' event is written to
 * `document_updates`. A periodic compaction merges the log into a single
 * `document_snapshots` row; the next cold load reads the snapshot + any
 * tail updates. The room manager subscribes to a Redis channel so two
 * different server instances can fan an update out to each other and
 * stay convergent — Yjs updates are CRDTs, applying the same update
 * twice is a no-op.
 */
import * as Y from 'yjs'
import type { PoolClient } from 'pg'
import { pool } from '../db/pool.js'
import {
  redis, sub, publish,
  CH_DOC_UPDATE, CH_DOC_AWARENESS,
  type DocUpdateEvent, type DocAwarenessEvent,
} from '../redis.js'
import { env } from '../env.js'
import { normalizeStorageKey, signedUrlExpiresSoon, storage, storageKeyFromPublicUrl } from '../storage.js'
import {
  markdownToYXml,
  parseMarkdownImageBlock,
  proseMirrorNodeToYXml,
  type ProseMirrorJsonNode,
} from './markdown.js'

/** A subscriber attached to a room. Updates emitted by the local Y.Doc
 *  are pushed to every subscriber except the one whose `originId`
 *  matches — that's the originator's own echo. */
export interface DocSubscriber {
  originId: string
  /** Called for every Yjs update applied to the room — local or remote. */
  onUpdate: (update: Uint8Array, originId: string) => void
  /** Called for every awareness update (cursors etc.) — never persisted. */
  onAwareness: (update: Uint8Array, originId: string) => void
}

interface Room {
  documentId: string
  companyId: string
  doc: Y.Doc
  subs: Set<DocSubscriber>
  /** Updates since last snapshot — drives the compaction threshold. */
  updatesSinceSnapshot: number
  /** Set during cold-load to coalesce concurrent waiters. */
  loaded: Promise<void>
  /** Marked true after the doc is hydrated from DB; flips OFF doc.on('update')
   *  persistence to skip writing replays back into the log. */
  hydrated: boolean
}

const COMPACT_AFTER_UPDATES = 200
const ROOM_GRACE_MS = 60_000

const rooms = new Map<string, Room>()
/** Pending eviction timers, keyed by documentId — cleared when a fresh
 *  subscriber re-attaches inside the grace window. */
const evictions = new Map<string, NodeJS.Timeout>()

/** Stable per-process id so cross-instance Redis events can be
 *  echo-suppressed when they originated here. */
const INSTANCE_ORIGIN = `instance:${env.INSTANCE_ID}`

async function loadSnapshot(
  documentId: string,
  dbClient?: PoolClient,
): Promise<{ state: Uint8Array | null; lastIncluded: bigint }> {
  const { rows } = await (dbClient ?? pool).query<{ state_bytes: Buffer; snapshot_at_update_id: string }>(
    `SELECT state_bytes, snapshot_at_update_id
       FROM document_snapshots
      WHERE document_id = $1`,
    [documentId],
  )
  const row = rows[0]
  if (!row) return { state: null, lastIncluded: 0n }
  return { state: new Uint8Array(row.state_bytes), lastIncluded: BigInt(row.snapshot_at_update_id) }
}

async function loadUpdatesAfter(
  documentId: string,
  afterId: bigint,
  dbClient?: PoolClient,
): Promise<Array<{ id: bigint; bytes: Uint8Array }>> {
  const { rows } = await (dbClient ?? pool).query<{ id: string; update_bytes: Buffer }>(
    `SELECT id, update_bytes
       FROM document_updates
      WHERE document_id = $1 AND id > $2
      ORDER BY id ASC`,
    [documentId, afterId.toString()],
  )
  return rows.map((r) => ({ id: BigInt(r.id), bytes: new Uint8Array(r.update_bytes) }))
}

async function persistUpdate(documentId: string, authorId: string, bytes: Uint8Array): Promise<void> {
  await pool.query(
    `INSERT INTO document_updates (document_id, author_id, update_bytes)
     VALUES ($1, $2, $3)`,
    [documentId, authorId, Buffer.from(bytes)],
  )
  // Bump the parent doc's updated_at so the listing API sorts the
  // freshly-edited doc to the top without a separate write.
  await pool.query(
    `UPDATE documents SET updated_at = NOW() WHERE id = $1`,
    [documentId],
  ).catch(() => { /* swallow — list ordering is best-effort */ })
}

async function maybeCompact(room: Room): Promise<void> {
  if (room.updatesSinceSnapshot < COMPACT_AFTER_UPDATES) return
  // Snapshot the current state and find the latest update id covered.
  const state = Y.encodeStateAsUpdate(room.doc)
  const { rows } = await pool.query<{ max_id: string | null }>(
    `SELECT MAX(id)::text AS max_id FROM document_updates WHERE document_id = $1`,
    [room.documentId],
  )
  const maxId = rows[0]?.max_id ? BigInt(rows[0].max_id) : 0n
  await pool.query(
    `INSERT INTO document_snapshots (document_id, state_bytes, snapshot_at_update_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (document_id)
       DO UPDATE SET state_bytes = EXCLUDED.state_bytes,
                     snapshot_at_update_id = EXCLUDED.snapshot_at_update_id,
                     updated_at = NOW()`,
    [room.documentId, Buffer.from(state), maxId.toString()],
  )
  // Trim updates that are now safely captured in the snapshot.
  await pool.query(
    `DELETE FROM document_updates WHERE document_id = $1 AND id <= $2`,
    [room.documentId, maxId.toString()],
  )
  room.updatesSinceSnapshot = 0
}

async function hydrateDoc(documentId: string, doc: Y.Doc, dbClient?: PoolClient): Promise<void> {
  // A cold load is a two-query logical read. When the caller does not already
  // own a transaction connection, reserve one for the whole hydration rather
  // than returning it between snapshot and tail. Otherwise a pool-full wave
  // of locked CLI callers can occupy every released slot while waiting on the
  // shared `room.loaded`, leaving each hydration's tail query queued behind
  // the callers that depend on it.
  const client = dbClient ?? await pool.connect()
  try {
    const snap = await loadSnapshot(documentId, client)
    if (snap.state) Y.applyUpdate(doc, snap.state, 'hydrate')
    const tail = await loadUpdatesAfter(documentId, snap.lastIncluded, client)
    for (const u of tail) {
      Y.applyUpdate(doc, u.bytes, 'hydrate')
    }
  } finally {
    if (!dbClient) client.release()
  }
}

function roomKey(documentId: string): string {
  return documentId
}

async function getOrCreateRoom(
  documentId: string,
  companyId: string,
  dbClient?: PoolClient,
): Promise<Room> {
  // Clear any pending eviction — we're reusing the warm room.
  const pending = evictions.get(documentId)
  if (pending) { clearTimeout(pending); evictions.delete(documentId) }

  const existing = rooms.get(roomKey(documentId))
  if (existing) {
    await existing.loaded
    return existing
  }

  const doc = new Y.Doc()
  const room: Room = {
    documentId,
    companyId,
    doc,
    subs: new Set(),
    updatesSinceSnapshot: 0,
    hydrated: false,
    loaded: Promise.resolve(),
  }
  const key = roomKey(documentId)
  rooms.set(key, room)

  room.loaded = (async () => {
    await hydrateDoc(documentId, doc, dbClient)
    room.hydrated = true
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Hydration replays are tagged 'hydrate' to skip persistence + fan-out.
      if (origin === 'hydrate') return
      const isRemote = typeof origin === 'object' && origin !== null && 'remote' in origin
      const originId = (() => {
        if (typeof origin === 'string') return origin
        if (isRemote) return (origin as { remote: string }).remote
        return INSTANCE_ORIGIN
      })()
      const authorId = (() => {
        if (typeof origin === 'object' && origin !== null && 'authorId' in origin) {
          return String((origin as { authorId: string }).authorId)
        }
        return originId
      })()

      // Local subscribers get the binary update directly.
      for (const s of room.subs) {
        if (s.originId === originId) continue
        try { s.onUpdate(update, originId) } catch (e) { console.warn('[docs] sub error', e) }
      }

      // Persist + fan-out unless this update arrived FROM another instance
      // (it's already persisted there + already on the bus).
      if (!isRemote) {
        room.updatesSinceSnapshot += 1
        void persistUpdate(documentId, authorId, update).catch((e) => {
          console.warn('[docs] persistUpdate failed', e)
        })
        void publish(CH_DOC_UPDATE, {
          type: 'doc.update',
          companyId: room.companyId,
          documentId,
          updateB64: Buffer.from(update).toString('base64'),
          originId,
          authorId,
        }).catch(() => { /* swallow */ })
        void maybeCompact(room).catch((e) => console.warn('[docs] compact failed', e))
      }
    })
    normalizeMarkdownImageParagraphs(doc, pmFragment(doc), { originId: 'system:doc-image-normalize', authorId: 'system' })
    await refreshDocumentImageUrls(doc, pmFragment(doc), { originId: 'system:doc-image-refresh', authorId: 'system' })
  })().catch((error) => {
    // Never cache a rejected hydration promise. A transient DB timeout or a
    // corrupt row must fail the current waiters, but a later request should be
    // able to build a fresh room after the underlying problem is corrected.
    if (rooms.get(key) === room) rooms.delete(key)
    room.doc.destroy()
    throw error
  })

  await room.loaded
  return room
}

/** Subscribe to live updates for a doc; returns the current encoded
 *  state so the caller can sync immediately. */
export async function subscribe(
  documentId: string,
  companyId: string,
  sub: DocSubscriber,
): Promise<{ initialState: Uint8Array }> {
  const room = await getOrCreateRoom(documentId, companyId)
  await refreshDocumentImageUrls(room.doc, pmFragment(room.doc), { originId: 'system:doc-image-refresh', authorId: 'system' })
  room.subs.add(sub)
  return { initialState: Y.encodeStateAsUpdate(room.doc) }
}

export function unsubscribe(documentId: string, sub: DocSubscriber): void {
  const room = rooms.get(roomKey(documentId))
  if (!room) return
  room.subs.delete(sub)
  if (room.subs.size === 0) {
    // Schedule an eviction so flapping reconnects don't churn cold loads.
    const t = setTimeout(() => {
      const stillEmpty = (rooms.get(roomKey(documentId))?.subs.size ?? 0) === 0
      if (stillEmpty) {
        rooms.delete(roomKey(documentId))
        evictions.delete(documentId)
      }
    }, ROOM_GRACE_MS)
    evictions.set(documentId, t)
  }
}

/** Apply a Yjs update produced by a local subscriber. The room's
 *  doc.on('update') hook is responsible for persistence + fan-out. */
export async function applyLocalUpdate(
  documentId: string,
  companyId: string,
  originId: string,
  authorId: string,
  update: Uint8Array,
  dbClient?: PoolClient,
): Promise<void> {
  const room = await getOrCreateRoom(documentId, companyId, dbClient)
  // origin carries everything the persistence hook needs to route the
  // event correctly. Plain object so the `remote` discriminator is absent
  // (i.e. it's a LOCAL update — must persist + fan-out).
  Y.applyUpdate(room.doc, update, { originId, authorId } as never)
}

/** Apply a Yjs update that came FROM another server instance via Redis.
 *  Tagged with `remote` so the persistence hook skips re-writing it. */
function applyRemoteUpdate(documentId: string, originId: string, update: Uint8Array): void {
  const room = rooms.get(roomKey(documentId))
  if (!room || !room.hydrated) return  // nobody's listening locally
  Y.applyUpdate(room.doc, update, { remote: originId } as never)
}

/** Awareness is ephemeral — no DB, just fan-out. */
export async function broadcastAwareness(
  documentId: string,
  companyId: string,
  originId: string,
  update: Uint8Array,
): Promise<void> {
  const room = rooms.get(roomKey(documentId))
  if (room) {
    for (const s of room.subs) {
      if (s.originId === originId) continue
      try { s.onAwareness(update, originId) } catch { /* ignore */ }
    }
  }
  await publish(CH_DOC_AWARENESS, {
    type: 'doc.awareness',
    companyId,
    documentId,
    updateB64: Buffer.from(update).toString('base64'),
    originId,
  }).catch(() => { /* swallow */ })
}

/* ============== ProseMirror-aware helpers ==============
 *
 * The editor binds TipTap's Collaboration extension to the default Yjs
 * XmlFragment (key = 'default'). Agent reads + edits go through the
 * same fragment so what the human sees IS what the agent sees — no
 * out-of-band "second body" to keep in sync. */
const PM_FRAGMENT_KEY = 'default'

function pmFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PM_FRAGMENT_KEY)
}

type ImageNormalizeOrigin = { originId: string; authorId: string }

function imageElementFromNode(node: ProseMirrorJsonNode): Y.XmlElement | null {
  const yNode = proseMirrorNodeToYXml(node)
  return yNode instanceof Y.XmlElement ? yNode : null
}

function hrefFromDeltaAttributes(attrs: unknown): string | null {
  if (!attrs || typeof attrs !== 'object') return null
  const link = (attrs as { link?: unknown }).link
  if (!link || typeof link !== 'object') return null
  const href = (link as { href?: unknown }).href
  return typeof href === 'string' && href ? href : null
}

function paragraphTextSegments(el: Y.XmlElement): Array<{ text: string; href: string | null }> | null {
  const segments: Array<{ text: string; href: string | null }> = []
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i) as Y.AbstractType<unknown>
    if (!(child instanceof Y.XmlText)) return null
    const delta = child.toDelta() as Array<{ insert?: unknown; attributes?: unknown }>
    for (const op of delta) {
      if (typeof op.insert !== 'string') return null
      segments.push({ text: op.insert, href: hrefFromDeltaAttributes(op.attributes) })
    }
  }
  return segments
}

function linkedImageParagraphNode(el: Y.XmlElement): ProseMirrorJsonNode | null {
  const segments = paragraphTextSegments(el)
  if (!segments || segments.length === 0) return null

  const chars: Array<{ ch: string; href: string | null }> = []
  for (const segment of segments) {
    for (const ch of segment.text) chars.push({ ch, href: segment.href })
  }

  let start = 0
  let end = chars.length - 1
  while (start <= end && !chars[start].ch.trim()) start++
  while (end >= start && !chars[end].ch.trim()) end--
  if (start > end || chars[start].ch !== '!' || chars[start].href) return null

  const firstLinked = chars[start + 1]
  if (!firstLinked?.href) return null
  const href = firstLinked.href
  let alt = ''
  for (let i = start + 1; i <= end; i++) {
    if (chars[i].href !== href) return null
    alt += chars[i].ch
  }
  if (!alt.trim()) return null
  return { type: 'image', attrs: { src: href, alt: alt.trim(), title: null } }
}

function paragraphImageNode(el: Y.XmlElement): ProseMirrorJsonNode | null {
  return parseMarkdownImageBlock(inlineText(el).trim()) ?? linkedImageParagraphNode(el)
}

function normalizeMarkdownImageParagraphChildren(parent: Y.XmlFragment | Y.XmlElement): number {
  let changed = 0
  for (let i = parent.length - 1; i >= 0; i--) {
    const child = parent.get(i) as Y.AbstractType<unknown>
    if (!(child instanceof Y.XmlElement)) continue

    const replacement = child.nodeName === 'paragraph' ? paragraphImageNode(child) : null
    if (replacement) {
      const yImage = imageElementFromNode(replacement)
      if (yImage) {
        parent.delete(i, 1)
        parent.insert(i, [yImage])
        changed++
      }
      continue
    }

    changed += normalizeMarkdownImageParagraphChildren(child)
  }
  return changed
}

function normalizeMarkdownImageParagraphs(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  origin: ImageNormalizeOrigin,
): number {
  let changed = 0
  doc.transact(() => {
    changed = normalizeMarkdownImageParagraphChildren(fragment)
  }, origin as never)
  return changed
}

function imageStorageKey(el: Y.XmlElement): string | null {
  return normalizeStorageKey(xmlAttrString(el, 'storageKey')) ??
    storageKeyFromPublicUrl(xmlAttrString(el, 'src'))
}

function shouldRefreshDocumentImageUrl(src: string, key: string): boolean {
  if (!src) return true
  const srcKey = storageKeyFromPublicUrl(src)
  if (!srcKey) return true
  if (srcKey !== key) return true
  if (src.startsWith('/uploads/')) return storage.mode === 'r2'
  if (!src.includes('exp=') && !src.includes('sig=')) return storage.mode === 'r2' && key.startsWith('attachments/')
  return signedUrlExpiresSoon(src)
}

function collectImageElements(parent: Y.XmlFragment | Y.XmlElement, out: Y.XmlElement[]): void {
  for (let i = 0; i < parent.length; i++) {
    const child = parent.get(i) as Y.AbstractType<unknown>
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'image') out.push(child)
    collectImageElements(child, out)
  }
}

async function refreshDocumentImageUrls(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  origin: ImageNormalizeOrigin,
): Promise<number> {
  const images: Y.XmlElement[] = []
  collectImageElements(fragment, images)
  const updates: Array<{ el: Y.XmlElement; key: string; url: string | null }> = []
  for (const el of images) {
    const src = xmlAttrString(el, 'src')
    const currentKey = normalizeStorageKey(xmlAttrString(el, 'storageKey'))
    const key = currentKey ?? imageStorageKey(el)
    if (!key) continue
    const shouldRefresh = shouldRefreshDocumentImageUrl(src, key)
    const url = shouldRefresh ? await storage.publicUrl(key) : null
    if (!currentKey || (url && url !== src)) updates.push({ el, key, url })
  }
  if (updates.length === 0) return 0
  doc.transact(() => {
    for (const update of updates) {
      update.el.setAttribute('storageKey', update.key)
      if (update.url) update.el.setAttribute('src', update.url)
    }
  }, origin as never)
  return updates.length
}

/** Walk a ProseMirror Y.XmlFragment depth-first, yielding every Y.XmlText
 *  leaf. Used for plain-text extraction and find-and-replace edits. */
function* iterXmlText(parent: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlText> {
  const len = parent.length
  for (let i = 0; i < len; i++) {
    const child = parent.get(i) as Y.AbstractType<unknown>
    if (child instanceof Y.XmlText) {
      yield child
    } else if (child instanceof Y.XmlElement) {
      yield* iterXmlText(child)
    }
  }
}

/** Render the doc's ProseMirror content as plain text. Block elements
 *  (paragraph, heading, listItem…) are separated by a single newline so
 *  the result reads naturally without HTML markup. */
function inlineText(parent: Y.XmlFragment | Y.XmlElement): string {
  const buf: string[] = []
  for (const t of iterXmlText(parent)) buf.push(t.toString())
  return buf.join('')
}

function xmlAttrNumber(el: Y.XmlElement, key: string, fallback: number): number {
  const value = el.getAttribute(key)
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function xmlAttrString(el: Y.XmlElement, key: string): string {
  const value = el.getAttribute(key)
  return typeof value === 'string' ? value : ''
}

/** Pure in-memory extraction of all storage keys referenced in a document.
 *  Checks native image nodes, markdown image paragraphs, link marks, and
 *  embedded attachment references without triggering any URL refresh or DB write. */
export function extractStorageKeysFromDoc(doc: Y.Doc): string[] {
  const keys = new Set<string>()
  const fragment = pmFragment(doc)

  function inspectString(val: string) {
    if (!val) return
    const direct = normalizeStorageKey(val) ?? storageKeyFromPublicUrl(val)
    if (direct) {
      keys.add(direct)
      return
    }
    const matches = val.matchAll(/(?:attachments|email-attachments|avatars)\/[A-Za-z0-9_.-]+/g)
    for (const m of matches) {
      const k = normalizeStorageKey(m[0])
      if (k) keys.add(k)
    }
  }

  function walk(parent: Y.XmlFragment | Y.XmlElement) {
    for (let i = 0; i < parent.length; i++) {
      const child = parent.get(i) as Y.AbstractType<unknown>
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'image') {
          const key = imageStorageKey(child)
          if (key) {
            keys.add(key)
          } else {
            inspectString(xmlAttrString(child, 'src'))
          }
        } else if (child.nodeName === 'paragraph') {
          const replacement = paragraphImageNode(child)
          if (replacement && 'attrs' in replacement && replacement.attrs?.src) {
            inspectString(String(replacement.attrs.src))
          }
        }
        walk(child)
      } else if (child instanceof Y.XmlText) {
        const delta = child.toDelta() as Array<{ insert?: unknown; attributes?: unknown }>
        for (const op of delta) {
          const href = hrefFromDeltaAttributes(op.attributes)
          if (href) inspectString(href)
          if (typeof op.insert === 'string' && (op.insert.includes('attachments/') || op.insert.includes('avatars/'))) {
            inspectString(op.insert)
          }
        }
      }
    }
  }

  walk(fragment)
  return Array.from(keys)
}

/** Collect storage keys for a document. Reuses an active in-memory room if present,
 *  otherwise hydrates a temporary in-memory Y.Doc without adding to the room map,
 *  registering listeners, or refreshing presigned URLs. */
export async function collectDocumentStorageKeys(
  documentId: string,
  dbClient?: PoolClient,
): Promise<string[]> {
  const existing = rooms.get(roomKey(documentId))
  if (existing) {
    try {
      await existing.loaded
      return extractStorageKeysFromDoc(existing.doc)
    } catch {
      // Fall through to cold hydration if existing room threw
    }
  }

  const doc = new Y.Doc()
  try {
    await hydrateDoc(documentId, doc, dbClient)
    return extractStorageKeysFromDoc(doc)
  } finally {
    doc.destroy()
  }
}

/** Evict an in-memory document room immediately, e.g. upon document deletion. */
export function evictDocumentRoom(documentId: string): void {
  const pending = evictions.get(documentId)
  if (pending) {
    clearTimeout(pending)
    evictions.delete(documentId)
  }
  const room = rooms.get(roomKey(documentId))
  if (room) {
    rooms.delete(roomKey(documentId))
    room.subs.clear()
    room.doc.destroy()
  }
}

function escapeMarkdownImageText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/]/g, '\\]')
}

function imageToMarkdown(el: Y.XmlElement): string {
  const src = xmlAttrString(el, 'src')
  const alt = escapeMarkdownImageText(xmlAttrString(el, 'alt'))
  const title = xmlAttrString(el, 'title').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  if (!src) return alt || '[image]'
  return `![${alt}](${src}${title ? ` "${title}"` : ''})`
}

function elementToPlainLines(el: Y.XmlElement): string[] {
  switch (el.nodeName) {
    case 'paragraph':
      return [inlineText(el)]
    case 'heading':
      return [`${'#'.repeat(Math.max(1, Math.min(6, xmlAttrNumber(el, 'level', 1))))} ${inlineText(el)}`]
    case 'codeBlock': {
      const language = String(el.getAttribute('language') ?? '')
      return [`\`\`\`${language}`, inlineText(el), '```']
    }
    case 'blockquote':
      return elementChildrenToPlainLines(el).map((line) => line ? `> ${line}` : '>')
    case 'bulletList':
      return listToPlainLines(el, '-')
    case 'orderedList':
      return listToPlainLines(el, `${xmlAttrNumber(el, 'start', 1)}.`)
    case 'listItem':
      return elementChildrenToPlainLines(el)
    case 'horizontalRule':
      return ['---']
    case 'image':
      return [imageToMarkdown(el)]
    case 'table':
      return tableToPlainLines(el)
    default: {
      const childLines = elementChildrenToPlainLines(el)
      return childLines.length > 0 ? childLines : [inlineText(el)]
    }
  }
}

/** Serialize a ProseMirror table back to GFM so agents reading the doc
 *  (readDocumentText) see the same `| a | b |` markdown they authored,
 *  instead of one flattened line per cell. Pipes inside cells are escaped. */
function tableToPlainLines(table: Y.XmlElement): string[] {
  const lines: string[] = []
  for (let i = 0; i < table.length; i++) {
    const row = table.get(i) as Y.AbstractType<unknown>
    if (!(row instanceof Y.XmlElement) || row.nodeName !== 'tableRow') continue
    const cells: string[] = []
    for (let j = 0; j < row.length; j++) {
      const cell = row.get(j) as Y.AbstractType<unknown>
      if (!(cell instanceof Y.XmlElement)) continue
      cells.push(elementChildrenToPlainLines(cell).join(' ').replace(/\|/g, '\\|'))
    }
    lines.push(`| ${cells.join(' | ')} |`)
    if (lines.length === 1) lines.push(`|${' --- |'.repeat(cells.length)}`)
  }
  return lines
}

function elementChildrenToPlainLines(parent: Y.XmlElement): string[] {
  const lines: string[] = []
  for (let i = 0; i < parent.length; i++) {
    const child = parent.get(i) as Y.AbstractType<unknown>
    if (child instanceof Y.XmlElement) lines.push(...elementToPlainLines(child))
    else if (child instanceof Y.XmlText) lines.push(child.toString())
  }
  return lines
}

function listToPlainLines(list: Y.XmlElement, marker: string): string[] {
  const lines: string[] = []
  let index = marker.endsWith('.') ? Number.parseInt(marker, 10) || 1 : 0
  for (let i = 0; i < list.length; i++) {
    const child = list.get(i) as Y.AbstractType<unknown>
    if (!(child instanceof Y.XmlElement)) continue
    const itemLines = elementToPlainLines(child)
    const itemMarker = marker.endsWith('.') ? `${index++}.` : marker
    if (itemLines.length === 0) {
      lines.push(itemMarker)
      continue
    }
    lines.push(`${itemMarker} ${itemLines[0]}`)
    for (const line of itemLines.slice(1)) lines.push(`  ${line}`)
  }
  return lines
}

function fragmentToPlainText(fragment: Y.XmlFragment): string {
  const lines: string[] = []
  const len = fragment.length
  for (let i = 0; i < len; i++) {
    const child = fragment.get(i) as Y.AbstractType<unknown>
    if (child instanceof Y.XmlElement) {
      lines.push(...elementToPlainLines(child))
    } else if (child instanceof Y.XmlText) {
      lines.push(child.toString())
    }
  }
  return lines.join('\n')
}

/** Read-only access to the doc's current plain-text body. Used by REST
 *  bootstrap responses + agent tools that don't want to hold a WS
 *  session. Extracted by walking the ProseMirror fragment. */
export async function readDocumentText(
  documentId: string,
  companyId: string,
  dbClient?: PoolClient,
): Promise<string> {
  const room = await getOrCreateRoom(documentId, companyId, dbClient)
  await refreshDocumentImageUrls(room.doc, pmFragment(room.doc), { originId: 'system:doc-image-refresh', authorId: 'system' })
  return fragmentToPlainText(pmFragment(room.doc))
}

/** Append agent-authored prose to the document as native ProseMirror nodes.
 *  Agents naturally write markdown, while the human editor stores rich
 *  TipTap/Yjs structure. Convert at the insertion boundary so collaborators
 *  see headings, lists, quotes, code blocks, and inline marks instead of raw
 *  markdown punctuation. */
function insertAgentMarkdown(fragment: Y.XmlFragment, text: string, index?: number): void {
  const nodes = markdownToYXml(text)
  if (index === undefined) {
    fragment.push(nodes)
  } else {
    fragment.insert(index, nodes)
  }
}

/** Edit primitive for agents: ProseMirror-aware so the human's editor
 *  sees the change as a structured update rather than a raw byte
 *  rewrite. Three op kinds:
 *
 *   - `append`: markdown-authored blocks at the end of the doc.
 *   - `replace`: first occurrence of `find` → `replace` (text content
 *     only — marks on the matched range survive untouched).
 *   - `insertParagraph`: markdown-authored blocks prepended (index 0) or at the
 *     end depending on `at`.
 *
 *  Wrapped in a single Yjs transaction so observers see one update. */
/** Placement spec for the `image` agent op.
 *
 *  Two modes:
 *   - absolute: insert at the start or end of the document
 *   - anchored: find a block (paragraph / heading / list item) whose text
 *     contains `anchorText` and place the image relative to it
 *
 *  `replace` is the killer: agents can swap a previously-emitted but
 *  inert `![alt](url)` markdown paragraph for a real image node by
 *  passing the exact markdown text as the anchor. */
export type AgentImagePlacement =
  | { mode: 'start' | 'end' }
  | { mode: 'replace' | 'after' | 'before'; anchorText: string }

/** Explicit type guard for the anchored half of {@link AgentImagePlacement}.
 *  Some TS versions (including the one CI runs) don't narrow
 *  `placement.anchorText` after `mode === 'start' / 'end'` checks even
 *  though discriminated-union rules say they should. A user-defined
 *  predicate sidesteps the issue. */
export function isAnchoredImagePlacement(
  p: AgentImagePlacement,
): p is { mode: 'replace' | 'after' | 'before'; anchorText: string } {
  return p.mode === 'replace' || p.mode === 'after' || p.mode === 'before'
}

/** Walk the fragment top-to-bottom, return (index, element) of the first
 *  XmlElement whose flattened text content contains `needle`. Returns
 *  null when no block matches — caller decides whether to fall back. */
function findFirstBlockContaining(
  fragment: Y.XmlFragment,
  needle: string,
): { index: number; element: Y.XmlElement } | null {
  for (let i = 0; i < fragment.length; i++) {
    const child = fragment.get(i) as Y.AbstractType<unknown>
    if (!(child instanceof Y.XmlElement)) continue
    if (inlineText(child).includes(needle)) return { index: i, element: child }
  }
  return null
}

/** Match spec for the image-delete agent op. */
export type AgentImageDeleteMatch =
  | { by: 'src'; src: string }
  | { by: 'src-contains'; substring: string }
  | { by: 'alt'; alt: string }

/** Find every image element under `parent` (recursively) and return their
 *  (parent-index, element) pairs. Used by the image-delete op to locate
 *  matches without mutating mid-traversal. */
function collectImageBlocks(
  parent: Y.XmlFragment | Y.XmlElement,
): Array<{ container: Y.XmlFragment | Y.XmlElement; index: number; element: Y.XmlElement }> {
  const out: Array<{ container: Y.XmlFragment | Y.XmlElement; index: number; element: Y.XmlElement }> = []
  for (let i = 0; i < parent.length; i++) {
    const child = parent.get(i) as Y.AbstractType<unknown>
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'image') out.push({ container: parent, index: i, element: child })
    else out.push(...collectImageBlocks(child))
  }
  return out
}

export async function applyAgentEdit(
  documentId: string,
  companyId: string,
  agentId: string,
  ops: Array<
    | { kind: 'append'; text: string }
    | { kind: 'replace'; find: string; replace: string }
    | { kind: 'insertParagraph'; at: 'start' | 'end'; text: string }
    | { kind: 'replaceBlock'; anchorText: string; text: string }
    | { kind: 'image'; src: string; alt: string | null; placement: AgentImagePlacement }
    | { kind: 'imageDelete'; match: AgentImageDeleteMatch }
  >,
  dbClient?: PoolClient,
): Promise<{
  replaced: number
  imagePlaced: 'absolute' | 'anchor' | 'anchor-missed' | null
  imagesDeleted: number
  blocksReplaced: number
  deletedStorageKeys: string[]
}> {
  const room = await getOrCreateRoom(documentId, companyId, dbClient)
  const fragment = pmFragment(room.doc)
  let replaced = 0
  let imagePlaced: 'absolute' | 'anchor' | 'anchor-missed' | null = null
  let imagesDeleted = 0
  let blocksReplaced = 0
  const deletedStorageKeys: string[] = []
  const origin = { originId: `agent:${agentId}`, authorId: agentId } as never
  room.doc.transact(() => {
    for (const op of ops) {
      if (op.kind === 'append') {
        insertAgentMarkdown(fragment, op.text)
      } else if (op.kind === 'insertParagraph') {
        if (op.at === 'end') {
          insertAgentMarkdown(fragment, op.text)
        } else {
          insertAgentMarkdown(fragment, op.text, 0)
        }
      } else if (op.kind === 'replaceBlock') {
        // Structural swap: replace ONE whole block (the first containing
        // anchorText) with freshly-parsed markdown blocks. This is what
        // `replace` can't do — that op only edits text inside a block, so
        // e.g. a flattened markdown table stuck in a paragraph could never
        // be turned back into a real table without this. Anchor miss is a
        // no-op (mirrors the image-replace rule: never fall back to append).
        const hit = findFirstBlockContaining(fragment, op.anchorText)
        if (hit) {
          fragment.delete(hit.index, 1)
          insertAgentMarkdown(fragment, op.text, hit.index)
          blocksReplaced++
        }
      } else if (op.kind === 'image') {
        // Direct image-block insert — bypasses the markdown parser
        // entirely so agents get a deterministic insert regardless of
        // how their model formatter wrapped the URL. Same Y.XmlElement
        // shape the markdown image branch emits, so the human's editor
        // doesn't care which path produced it.
        const yImage = imageElementFromNode({
          type: 'image',
          attrs: { src: op.src, alt: op.alt, title: null },
        })
        if (!yImage) continue
        const p = op.placement
        if (isAnchoredImagePlacement(p)) {
          const hit = findFirstBlockContaining(fragment, p.anchorText)
          if (!hit) {
            // Anchor not found — DO NOT fall back to end. Falling back
            // would mean every `--replace` miss silently re-appends a
            // duplicate image, which is how the doc collected the mess
            // it has now. Skip the op and let the CLI return an error
            // so the agent retries with a different snippet or fixes
            // the doc by hand.
            imagePlaced = 'anchor-missed'
          } else if (p.mode === 'replace') {
            fragment.delete(hit.index, 1)
            fragment.insert(hit.index, [yImage])
            imagePlaced = 'anchor'
          } else if (p.mode === 'after') {
            fragment.insert(hit.index + 1, [yImage])
            imagePlaced = 'anchor'
          } else /* before */ {
            fragment.insert(hit.index, [yImage])
            imagePlaced = 'anchor'
          }
        } else {
          // Absolute placement (start / end).
          if (p.mode === 'start') fragment.insert(0, [yImage])
          else fragment.push([yImage])
          imagePlaced = 'absolute'
        }
      } else if (op.kind === 'imageDelete') {
        // Walk every image node in the fragment and delete those whose
        // src / alt matches the supplied criterion. Iterate from end →
        // start to keep indices stable as we splice. Collected via
        // collectImageBlocks above (which recurses through container
        // blocks like blockquote / list) so we can also reach nested
        // illustrations.
        const all = collectImageBlocks(fragment)
        const matches = all.filter(({ element }) => {
          const src = xmlAttrString(element, 'src')
          const alt = xmlAttrString(element, 'alt')
          if (op.match.by === 'src') return src === op.match.src
          if (op.match.by === 'src-contains') return src.includes(op.match.substring)
          /* by alt */ return alt === op.match.alt
        })
        // Sort descending by index so we can delete in place without
        // shifting earlier indices. Group by container (rare for nested
        // images but possible).
        matches.sort((a, b) => b.index - a.index)
        for (const m of matches) {
          const key = imageStorageKey(m.element)
          if (key) deletedStorageKeys.push(key)
          m.container.delete(m.index, 1)
          imagesDeleted++
        }
      } else if (op.kind === 'replace') {
        for (const t of iterXmlText(fragment)) {
          const s = t.toString()
          const idx = s.indexOf(op.find)
          if (idx >= 0) {
            t.delete(idx, op.find.length)
            if (op.replace.length > 0) t.insert(idx, op.replace)
            replaced++
            break
          }
        }
      }
    }
    normalizeMarkdownImageParagraphChildren(fragment)
  }, origin)
  return { replaced, imagePlaced, imagesDeleted, blocksReplaced, deletedStorageKeys }
}

/** Cross-instance bus bootstrap. Idempotent — safe to call from index.ts
 *  alongside the regular Redis subscriber. */
let busBootstrapped = false
export function bootDocumentBus(): void {
  if (busBootstrapped) return
  busBootstrapped = true

  void sub.subscribe(CH_DOC_UPDATE, CH_DOC_AWARENESS).then(() => {
    console.log('[docs] subscribed to doc redis channels')
  }).catch((e) => console.warn('[docs] redis subscribe failed', e))

  sub.on('message', (channel, payload) => {
    if (channel !== CH_DOC_UPDATE && channel !== CH_DOC_AWARENESS) return
    let parsed: DocUpdateEvent | DocAwarenessEvent
    try { parsed = JSON.parse(payload) } catch { return }
    // Drop our own loop-back so we don't double-apply locally-originated updates.
    if (parsed.originId === INSTANCE_ORIGIN) return

    const bytes = Buffer.from(parsed.updateB64, 'base64')
    const update = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (channel === CH_DOC_UPDATE) {
      applyRemoteUpdate(parsed.documentId, parsed.originId, update)
    } else {
      // For awareness, just fan out to local subs — no Y.Doc mutation.
      const room = rooms.get(roomKey(parsed.documentId))
      if (!room) return
      for (const s of room.subs) {
        if (s.originId === parsed.originId) continue
        try { s.onAwareness(update, parsed.originId) } catch { /* ignore */ }
      }
    }
  })
}

/** Expose the per-process origin so the WS bridge can stamp it on
 *  outbound payloads. */
export function instanceOrigin(): string { return INSTANCE_ORIGIN }

// Re-export redis client surface so callers don't pull from two places.
export { redis }
