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
 *   - `attachments/` — user uploads
 *   - `avatars/`     — agent portraits
 */
import { writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { createHmac } from 'node:crypto'
import {
  S3Client, PutObjectCommand, GetObjectCommand,
  DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from './env.js'
import {
  normalizeStorageKey,
  storageKeyFromPublicUrl as storageKeyFromPublicUrlForBase,
  messageAttachmentStorageKey as messageAttachmentStorageKeyForBase,
} from './storage-keys.js'

export { normalizeStorageKey }

/** Keys under these prefixes get HMAC-signed URLs when a signing secret is
 *  configured. Other prefixes (e.g. `avatars/`) are served unsigned — they
 *  carry no private user content and benefit from full CDN caching. */
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

/** One enumerated object. lastModifiedMs is the storage backend's notion
 *  of when the object was last written — GC uses it to spare keys that
 *  were uploaded recently (the row write may still be in flight). */
export interface StorageObject {
  key: string
  sizeBytes: number
  lastModifiedMs: number
}

export interface Storage {
  mode: 'local' | 'r2'
  /** Write bytes synchronously from the server side (avatar gen path).
   *  Returns the resolved public URL. */
  put(key: string, body: Buffer, mime: string): Promise<string>
  /** Return a short-lived PUT URL the browser uploads to directly, plus
   *  the public URL the file will be available at after the upload. */
  presignPut(key: string, mime: string, ttlSeconds?: number): Promise<{ uploadUrl: string; publicUrl: string }>
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
    // Existing static handler mounts UPLOAD_DIR at /uploads/.
    return `/uploads/${key}`
  }

  // Local mode has no real presign — the browser still goes through
  // `POST /uploads` (base64). Callers MUST check `storage.mode` first
  // and pick the base64 path; this method only exists to satisfy the
  // interface and will throw if reached.
  async presignPut(_key: string, _mime: string, _ttl?: number): Promise<{ uploadUrl: string; publicUrl: string }> {
    throw new Error('presignPut not supported in local mode — POST /uploads (base64) instead')
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
    catch { return false }
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

  async presignPut(key: string, mime: string, ttl = 300): Promise<{ uploadUrl: string; publicUrl: string }> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: mime,
    })
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: ttl })
    const publicUrl = await this.publicUrl(key)
    return { uploadUrl, publicUrl }
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
