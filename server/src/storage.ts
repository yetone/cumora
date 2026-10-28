/**
 * Object-storage abstraction. Two backends — `LocalStorage` writes to disk
 * for dev, `R2Storage` (S3-compatible) talks to Cloudflare R2 (or any
 * S3-API bucket) and emits presigned URLs.
 *
 * Why two: local dev shouldn't require a bucket; prod shouldn't require
 * a shared filesystem. Selection is automatic — if all `R2_*` env vars are
 * present we flip to R2, otherwise we fall back to disk. Callers (router,
 * avatar-gen) never care which is active.
 *
 * Surface area kept deliberately small:
 *   - `put(key, body, mime)` — write bytes, return the public URL
 *   - `presignPut(key, mime)` — short-lived URL the browser PUTs to
 *   - `publicUrl(key)` — read URL (long-lived if R2_PUBLIC_BASE is set,
 *                       otherwise a short presigned GET)
 *   - `mode` — 'local' | 'r2', surfaced so the API can advertise it
 *
 * Keys look like `<prefix>/<uuid>.<ext>`. Prefixes are conventional:
 *   - `attachments/`       — user uploads (signed)
 *   - `email-attachments/` — inbound and outbound mail files (signed)
 *   - `avatars/`           — portraits (the only unsigned R2 prefix)
 */
import { writeFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, join, resolve, dirname } from 'node:path'
import { createHmac } from 'node:crypto'
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env.js'
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  normalizeAttachments,
  validateAttachmentInput,
  type AttachmentDescriptor,
  type AttachmentKind,
} from '../../shared/attachments.js'
import {
  normalizeStorageKey,
  storageKeyFromPublicUrl as storageKeyFromPublicUrlForBase,
  messageAttachmentStorageKey as messageAttachmentStorageKeyForBase,
} from './storage-keys.js'

export { normalizeStorageKey }

/** Keys under these prefixes get HMAC-signed URLs when a signing secret is
 *  configured. The R2 worker serves only `avatars/` without a signature;
 *  every other key is rejected at the edge until it is signed. Keep this
 *  list, `PUBLIC_PREFIXES` in `workers/r2-gate/src/index.ts`, and
 *  `STORAGE_KEY_PREFIXES` in `storage-keys.ts` in agreement — the prefix
 *  contract test fails when they drift. */
const SIGNED_PREFIXES = ['attachments/', 'email-attachments/']
function needsSignature(key: string): boolean {
  return SIGNED_PREFIXES.some((p) => key.startsWith(p))
}

export function storageKeyFromPublicUrl(raw: string): string | null {
  return storageKeyFromPublicUrlForBase(raw, env.R2_PUBLIC_BASE)
}

export function messageAttachmentStorageKey(input: { key?: unknown; url?: unknown }): string | null {
  return messageAttachmentStorageKeyForBase(input, env.R2_PUBLIC_BASE)
}

export function signedUrlExpiresSoon(raw: string, leewaySeconds = 300): boolean {
  try {
    const exp = Number(new URL(raw).searchParams.get('exp') ?? 0)
    return Number.isFinite(exp) && exp > 0 && exp <= Math.floor(Date.now() / 1000) + leewaySeconds
  } catch {
    return false
  }
}

/** Local fallback directory. Same path the static handler historically
 *  served from, so existing /uploads/<file> URLs keep working after the
 *  abstraction lands. */
export const UPLOAD_DIR = resolve(process.cwd(), 'server/uploads')

/** The chat-upload MIME allowlist also defines the extension and renderer kind
 *  for a new object. Message persistence derives both from stored metadata. */
export const CHAT_ATTACHMENT_MIME_POLICY: Record<string, { kind: 'img' | 'file'; ext: string }> = {
  'image/png': { kind: 'img', ext: 'png' },
  'image/jpeg': { kind: 'img', ext: 'jpg' },
  'image/webp': { kind: 'img', ext: 'webp' },
  'image/gif': { kind: 'img', ext: 'gif' },
  'application/pdf': { kind: 'file', ext: 'pdf' },
  'application/msword': { kind: 'file', ext: 'doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', ext: 'docx' },
  'application/vnd.ms-excel': { kind: 'file', ext: 'xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', ext: 'xlsx' },
  'application/vnd.ms-powerpoint': { kind: 'file', ext: 'ppt' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'file', ext: 'pptx' },
  'application/zip': { kind: 'file', ext: 'zip' },
  'application/x-tar': { kind: 'file', ext: 'tar' },
  'application/gzip': { kind: 'file', ext: 'gz' },
  'text/plain': { kind: 'file', ext: 'txt' },
  'text/markdown': { kind: 'file', ext: 'md' },
  'text/csv': { kind: 'file', ext: 'csv' },
  'application/json': { kind: 'file', ext: 'json' },
  'application/x-yaml': { kind: 'file', ext: 'yml' },
  'application/x-toml': { kind: 'file', ext: 'toml' },
  'audio/mpeg': { kind: 'file', ext: 'mp3' },
  'audio/wav': { kind: 'file', ext: 'wav' },
  'video/mp4': { kind: 'file', ext: 'mp4' },
  'video/quicktime': { kind: 'file', ext: 'mov' },
}

function attachmentKindForMime(mime: string): AttachmentKind {
  if (mime === 'application/pdf') return 'pdf'
  return CHAT_ATTACHMENT_MIME_POLICY[mime]?.kind ?? 'file'
}

/** Validate a presign request against the same policy the message write uses. */
export function validateChatUpload(input: {
  name: unknown
  mime: unknown
  size: unknown
}):
  | { ok: true; name: string; mime: string; size: number; kind: AttachmentKind }
  | { ok: false; status: 400 | 413 | 415; error: string } {
  const name = String(input.name ?? '').trim().slice(0, 200)
  const mime = String(input.mime ?? '').trim().toLowerCase()
  const size = Number(input.size ?? 0)
  if (!name || !mime) return { ok: false, status: 400, error: 'name + mime required' }
  if (!Number.isSafeInteger(size) || size <= 0 || size > ATTACHMENT_MAX_FILE_BYTES) {
    return { ok: false, status: 413, error: `size out of range (got ${size}, max ${ATTACHMENT_MAX_FILE_BYTES})` }
  }
  const policy = CHAT_ATTACHMENT_MIME_POLICY[mime]
  if (!policy) return { ok: false, status: 415, error: `mime not allowed: ${mime}` }
  return { ok: true, name, mime, size, kind: attachmentKindForMime(mime) }
}

const STORAGE_MIME_BY_EXTENSION = new Map<string, string>()
for (const [mime, policy] of Object.entries(CHAT_ATTACHMENT_MIME_POLICY)) {
  STORAGE_MIME_BY_EXTENSION.set(policy.ext, mime)
}

function normalizedMime(raw: string): string {
  return raw.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/** Local uploads use a small sidecar for the exact MIME supplied when the
 *  server wrote the bytes. The sidecar never becomes a message attachment. */
async function putLocalMimeMetadata(key: string, mime: string): Promise<void> {
  const marker = localMimeMarker(key)
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, mime)
}

function localMimeMarker(key: string): string {
  return join(UPLOAD_DIR, dirname(key), `${basename(key)}.cumora-mime`)
}

/** Local files have no object-store Content-Type header. Their server-minted
 *  extension is the storage-side type record used for persistence and reads. */
export function mimeTypeFromStorageKey(key: string): string | undefined {
  const extension = key.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  return extension ? STORAGE_MIME_BY_EXTENSION.get(extension) : undefined
}

/** One enumerated object. lastModifiedMs is the storage backend's notion
 *  of when the object was last written — GC uses it to spare keys that
 *  were uploaded recently (the row write may still be in flight). */
export interface StorageObject {
  key: string
  sizeBytes: number
  lastModifiedMs: number
}

/** Authoritative metadata for one stored object. Callers use this instead of
 *  trusting browser-supplied MIME or size values when persisting a message. */
export interface StoredObjectMetadata {
  key: string
  sizeBytes: number
  mime?: string
}

export interface Storage {
  mode: 'local' | 'r2'
  /** Write bytes synchronously from the server side (avatar gen path).
   *  Returns the resolved public URL. */
  put(key: string, body: Buffer, mime: string): Promise<string>
  /** Return a short-lived PUT URL the browser uploads to directly, plus
   *  the public URL the file will be available at after the upload. */
  presignPut(
    key: string,
    mime: string,
    sizeBytes: number,
    ttlSeconds?: number,
  ): Promise<{ uploadUrl: string; publicUrl: string }>
  /** Return object metadata, or null when the key does not exist. */
  statObject(key: string): Promise<StoredObjectMetadata | null>
  /** Resolve a long-lived public URL for a key. R2 mode emits a presigned
   *  GET when no public base is configured. */
  publicUrl(key: string): Promise<string>
  /** Enumerate every object whose key starts with `prefix`. Used by the
   *  GC sweep to find orphans not referenced by any DB row. Both backends
   *  walk lazily / paginated under the hood; the caller gets the flat
   *  list. */
  listObjectsByPrefix(prefix: string): Promise<StorageObject[]>
  /** Best-effort removal of one object. Never throws — returns false if
   *  the key didn't exist OR the backend complained — so the GC loop
   *  doesn't stall on a single bad row. */
  deleteObject(key: string): Promise<boolean>
}

class LocalStorage implements Storage {
  mode = 'local' as const

  async put(key: string, body: Buffer, _mime: string): Promise<string> {
    const path = join(UPLOAD_DIR, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
    await putLocalMimeMetadata(key, _mime)
    // Existing static handler mounts UPLOAD_DIR at /uploads/.
    return `/uploads/${key}`
  }

  // Local mode has no real presign — the browser still goes through
  // `POST /uploads` (base64). Callers MUST check `storage.mode` first
  // and pick the base64 path; this method only exists to satisfy the
  // interface and will throw if reached.
  async presignPut(
    _key: string,
    _mime: string,
    _sizeBytes: number,
    _ttl?: number,
  ): Promise<{ uploadUrl: string; publicUrl: string }> {
    throw new Error('presignPut not supported in local mode — POST /uploads (base64) instead')
  }

  async statObject(key: string): Promise<StoredObjectMetadata | null> {
    const path = join(UPLOAD_DIR, key)
    try {
      const s = await stat(path)
      if (!s.isFile()) return null
      const metaMarker = localMimeMarker(key)
      let mime: string | undefined
      try {
        const raw = (await readFile(metaMarker, 'utf8')).trim()
        if (raw) mime = normalizedMime(raw)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return { key, sizeBytes: s.size, mime }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async publicUrl(key: string): Promise<string> {
    return `/uploads/${key}`
  }

  async listObjectsByPrefix(prefix: string): Promise<StorageObject[]> {
    // Local layout: UPLOAD_DIR/<prefix>/<files>. readdir + stat is fine —
    // local dev never accumulates the millions of objects R2 would.
    const dir = join(UPLOAD_DIR, prefix)
    let names: string[]
    try { names = await readdir(dir) }
    catch { return [] }  // no such directory == no objects
    const out: StorageObject[] = []
    for (const name of names) {
      const full = join(dir, name)
      try {
        const s = await stat(full)
        if (!s.isFile()) continue
        out.push({
          key: `${prefix.replace(/\/+$/, '')}/${name}`,
          sizeBytes: s.size,
          lastModifiedMs: s.mtimeMs,
        })
      } catch { /* ignore disappeared / unreadable */ }
    }
    return out
  }

  async deleteObject(key: string): Promise<boolean> {
    const path = join(UPLOAD_DIR, key)
    try { await unlink(path); return true }
    catch (error) {
      // Deletion is idempotent: a prior successful attempt may have removed
      // the file before the durable cleanup job could be marked complete.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      return false
    }
  }
}

class R2Storage implements Storage {
  mode = 'r2' as const
  private client: S3Client
  private bucket: string
  private publicBase: string
  private signingSecret: string
  private urlTtl: number

  constructor(opts: {
    endpoint: string; bucket: string;
    accessKeyId: string; secretAccessKey: string;
    publicBase: string;
    signingSecret: string;
    urlTtl: number;
  }) {
    this.bucket = opts.bucket
    this.publicBase = opts.publicBase
    this.signingSecret = opts.signingSecret
    this.urlTtl = opts.urlTtl
    this.client = new S3Client({
      // R2 lives in a single region; the SDK still requires *some* value.
      // "auto" is the documented choice for R2.
      region: 'auto',
      endpoint: opts.endpoint,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
      // R2 requires path-style addressing in some configs; force it on so
      // the same code works whether the user is on the default subdomain
      // setup or a custom hostname.
      forcePathStyle: true,
    })
  }

  async put(key: string, body: Buffer, mime: string): Promise<string> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: mime,
    }))
    return this.publicUrl(key)
  }

  async presignPut(
    key: string,
    mime: string,
    sizeBytes: number,
    ttl = 300,
  ): Promise<{ uploadUrl: string; publicUrl: string }> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mime,
      // SigV4 binds this header into the presigned URL. The browser's PUT must
      // carry the same Content-Length, preventing a larger object upload.
      ContentLength: sizeBytes,
    })
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: ttl })
    const publicUrl = await this.publicUrl(key)
    return { uploadUrl, publicUrl }
  }

  async statObject(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }))
      if (typeof res.ContentLength !== 'number' || !Number.isSafeInteger(res.ContentLength)) {
        throw new Error('storage object has no valid Content-Length')
      }
      return {
        key,
        sizeBytes: res.ContentLength,
        ...(res.ContentType ? { mime: res.ContentType.toLowerCase() } : {}),
      }
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name
      const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode
      if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return null
      throw error
    }
  }

  async listObjectsByPrefix(prefix: string): Promise<StorageObject[]> {
    // R2 / S3 ListObjectsV2 is paginated; loop on ContinuationToken so a
    // large bucket doesn't silently truncate at 1000.
    const out: StorageObject[] = []
    let token: string | undefined
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }))
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue
        out.push({
          key: obj.Key,
          sizeBytes: obj.Size ?? 0,
          lastModifiedMs: obj.LastModified ? obj.LastModified.getTime() : 0,
        })
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined
    } while (token)
    return out
  }

  async deleteObject(key: string): Promise<boolean> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (e) {
      console.warn(`[storage] deleteObject(${key}) failed:`, e instanceof Error ? e.message : String(e))
      return false
    }
  }

  async publicUrl(key: string): Promise<string> {
    // Prefer the explicit public base (custom domain). Cache-friendly,
    // no expiry on the URL structure itself. When a signing secret is
    // configured AND the key falls under a signed prefix, append the
    // HMAC query params — the Cloudflare Worker at the edge validates
    // these before proxying R2 reads.
    if (this.publicBase) {
      if (this.signingSecret && needsSignature(key)) {
        const exp = Math.floor(Date.now() / 1000) + this.urlTtl
        const sig = createHmac('sha256', this.signingSecret)
          .update(`${key}:${exp}`).digest('hex')
        return `${this.publicBase}/${key}?exp=${exp}&sig=${sig}`
      }
      return `${this.publicBase}/${key}`
    }
    // No public base — fall back to a long-lived presigned GET (works
    // without a CDN domain; not cacheable; rotates).
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 60 * 60 * 24 * 7 },  // 7 days
    )
  }
}

function buildStorage(): Storage {
  const have = env.R2_ENDPOINT && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY
  if (have) {
    const signingActive = Boolean(env.R2_URL_SIGNING_SECRET)
    console.log(
      `[storage] R2 active · bucket=${env.R2_BUCKET} ` +
      `publicBase=${env.R2_PUBLIC_BASE || '(presigned GET)'} ` +
      `signing=${signingActive ? 'on' : 'OFF'}`,
    )
    // Loud warning when the public base is set but signing isn't — every
    // URL under `attachments/` will be unsigned, which the Cloudflare
    // Worker gate then 403s. Almost always means the server was started
    // before R2_URL_SIGNING_SECRET landed in .env. Restart fixes it.
    if (env.R2_PUBLIC_BASE && !signingActive) {
      console.warn(
        '[storage] ⚠ R2_PUBLIC_BASE is set but R2_URL_SIGNING_SECRET is empty — ' +
        'attachment URLs will be emitted UNSIGNED and the cdn gate will 403 them. ' +
        'Check .env and restart the server.',
      )
    }
    return new R2Storage({
      endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      publicBase: env.R2_PUBLIC_BASE,
      signingSecret: env.R2_URL_SIGNING_SECRET,
      urlTtl: env.R2_URL_TTL_SECONDS,
    })
  }
  console.log('[storage] local mode · server/uploads/ (set R2_* env to use R2)')
  return new LocalStorage()
}

export const storage: Storage = buildStorage()

/** Stored attachment shape — mirror of AttachmentPayload in the router.
 *  Defined here so the freshening helper has no circular import. */
export interface StoredAttachment {
  url: string
  name: string
  kind: 'img' | 'pdf' | 'file' | 'fig'
  mime?: string
  size?: number
  key?: string
  [extra: string]: unknown
}

/** Re-sign an attachment's `url` from its stored `key` so each response
 *  carries a fresh signature. Without this, persisted message URLs would
 *  expire and break historical bubbles after the TTL window. Returns the
 *  input unchanged when no key is stored (legacy local-mode attachments)
 *  or storage doesn't need signing. */
export async function freshenAttachmentUrl<T extends StoredAttachment | null | undefined>(
  att: T,
): Promise<T> {
  if (!att) return att
  // Re-sign from the stored key, or derive it from the (possibly already-signed)
  // url — older attachments persisted no `key`, and without this they'd be stuck
  // with a stale signed url that 403s once its TTL lapses.
  const key = att.key ?? (att.url ? storageKeyFromPublicUrl(att.url) : null)
  if (!key) return att
  const url = await storage.publicUrl(key)
  if (url === att.url && att.key === key) return att
  return { ...att, url, key } as T
}

export type ResolveMessageAttachmentsResult =
  | { readonly ok: true; readonly attachments: readonly AttachmentDescriptor[] }
  | {
      readonly ok: false
      readonly status: 400 | 413
      readonly error: string
      readonly index?: number
    }

/** Validate the ordered wire list, resolve each trusted Cumora object, and
 *  replace every client-controlled size/MIME/kind/URL with storage-derived
 *  values. Message persistence must use this result verbatim. */
export async function resolveMessageAttachments(
  raw: unknown,
  backend: Pick<Storage, 'statObject' | 'publicUrl'> = storage,
  opts: {
    mimeForLegacyKey?: (key: string) => string | undefined
    /** Tenant-bound grant check supplied by the API boundary. Keeping the
     * callback here avoids coupling storage backends to Postgres. */
    attachmentGrant?: (key: string) => Promise<boolean>
  } = {},
): Promise<ResolveMessageAttachmentsResult> {
  const parsed = validateAttachmentInput(raw)
  if (!parsed.ok) {
    const indexSuffix = parsed.index === undefined ? '' : ` at index ${parsed.index}`
    switch (parsed.issue) {
      case 'too-many-files':
        return { ok: false, status: 413, error: 'too many attachments (maximum 16)' }
      case 'file-too-large':
        return { ok: false, status: 413, error: `attachment${indexSuffix} exceeds 25 MiB` }
      case 'total-too-large':
        return { ok: false, status: 413, error: `attachments${indexSuffix} exceed 25 MiB total` }
      case 'invalid-shape':
        return { ok: false, status: 400, error: `invalid attachment${indexSuffix}` }
    }
  }

  const attachments: AttachmentDescriptor[] = []
  let totalBytes = 0
  for (let index = 0; index < parsed.attachments.length; index++) {
    const input = parsed.attachments[index]
    const key = messageAttachmentStorageKey(input)
    if (!key) {
      return { ok: false, status: 400, error: 'attachment must reference Cumora storage', index }
    }
    if (opts.attachmentGrant && !(await opts.attachmentGrant(key))) {
      return { ok: false, status: 400, error: 'attachment is not granted to this workspace', index }
    }
    let stored: StoredObjectMetadata | null
    let url: string
    try {
      ;[stored, url] = await Promise.all([backend.statObject(key), backend.publicUrl(key)])
    } catch {
      return { ok: false, status: 400, error: 'attachment storage reference is invalid', index }
    }
    if (!stored) return { ok: false, status: 400, error: 'attachment object does not exist', index }
    if (stored.sizeBytes <= 0 || stored.sizeBytes > ATTACHMENT_MAX_FILE_BYTES) {
      return { ok: false, status: 413, error: `attachment object size is invalid (maximum 25 MiB)`, index }
    }
    if (input.size !== undefined && input.size !== stored.sizeBytes) {
      return { ok: false, status: 400, error: 'attachment size does not match uploaded object', index }
    }
    totalBytes += stored.sizeBytes
    if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
      return { ok: false, status: 413, error: 'attachments exceed 25 MiB total', index }
    }

    const mime = stored.mime
      ? normalizedMime(stored.mime)
      : (opts.mimeForLegacyKey ?? mimeTypeFromStorageKey)(key)
    if (!mime || !CHAT_ATTACHMENT_MIME_POLICY[mime]) {
      return { ok: false, status: 400, error: 'attachment object has an unsupported content type', index }
    }
    if (input.mime && normalizedMime(input.mime) !== mime) {
      return { ok: false, status: 400, error: 'attachment MIME does not match uploaded object', index }
    }
    attachments.push({
      name: input.name,
      kind: attachmentKindForMime(mime),
      url,
      key,
      mime,
      size: stored.sizeBytes,
    })
  }
  return { ok: true, attachments }
}

/** Add the canonical ordered list plus the first-entry legacy projection to a
 *  message response without changing any surrounding fields. */
export async function freshenMessageAttachments(
  value: unknown,
): Promise<{ attachment?: AttachmentDescriptor; attachments: readonly AttachmentDescriptor[] }> {
  const attachments = await Promise.all(normalizeAttachments(value).map(async (attachment) => {
    const freshened = await freshenAttachmentUrl({
      ...attachment,
      url: attachment.url ?? '',
    })
    return {
      ...attachment,
      ...(freshened.url ? { url: freshened.url } : {}),
      ...(freshened.key ? { key: freshened.key } : {}),
    }
  }))
  return {
    ...(attachments[0] ? { attachment: attachments[0] } : {}),
    attachments,
  }
}
