import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_TEXT_EXCERPT_BYTES,
  normalizeAttachments,
  type AttachmentDescriptor,
} from '../../../../shared/attachments.js'
import { normalizeStorageKey } from '../../storage-keys.js'
import type { VisionCapability } from './model-capabilities.js'

const DOWNLOAD_TIMEOUT_MS = 20_000
export const ATTACHMENT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const ATTACHMENT_CACHE_MAX_BYTES = 1024 * 1024 * 1024

export interface AttachmentCacheOptions {
  readonly maxAgeMs?: number
  readonly maxBytes?: number
  readonly now?: () => number
}

export interface AttachmentCacheCleanupResult {
  readonly removedFiles: number
  readonly removedBytes: number
  readonly remainingBytes: number
}

export interface CachedAttachment {
  readonly attachment: AttachmentDescriptor
  readonly path: string
  readonly text?: string
  readonly textTruncated?: boolean
}

export interface AttachmentCacheResult {
  readonly files: readonly CachedAttachment[]
  readonly failures: ReadonlyArray<{ name: string; reason: string; key?: string }>
}

export function isImageAttachment(attachment: AttachmentDescriptor): boolean {
  return attachment.kind === 'img' || attachment.mime?.startsWith('image/') === true
}

function safeName(name: string): string {
  const base = name.normalize('NFKC').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim()
  const cleaned = base.replace(/^\.+/, '').replace(/[<>:"|?*]/g, '_').slice(0, 160)
  return cleaned || 'attachment'
}

function textual(mime: string | undefined): boolean {
  const normalized = mime?.toLowerCase() ?? ''
  return normalized.startsWith('text/') || [
    'application/json', 'application/x-yaml', 'application/x-toml',
    'application/xml', 'application/javascript', 'application/sql',
  ].includes(normalized)
}

async function ensureCacheDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('attachment cache path is not a private directory')
  }
  await chmod(path, 0o700)
}

/** Download every attachment through the runtime JWT endpoint into this
 *  agent's home. The model never receives the bearer token or chooses a URL. */
export class AgentAttachmentCache {
  private readonly activePaths = new Set<string>()
  private turnDepth = 0
  private readonly maxAgeMs: number
  private readonly maxBytes: number
  private readonly now: () => number

  constructor(
    private readonly homeRoot: string,
    private readonly serverUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = fetch,
    options: AttachmentCacheOptions = {},
  ) {
    this.maxAgeMs = options.maxAgeMs ?? ATTACHMENT_CACHE_MAX_AGE_MS
    this.maxBytes = options.maxBytes ?? ATTACHMENT_CACHE_MAX_BYTES
    this.now = options.now ?? Date.now
    if (!Number.isFinite(this.maxAgeMs) || this.maxAgeMs < 0) {
      throw new Error('attachment cache maxAgeMs must be a non-negative finite number')
    }
    if (!Number.isFinite(this.maxBytes) || this.maxBytes < 0) {
      throw new Error('attachment cache maxBytes must be a non-negative finite number')
    }
  }

  /** Mark paths produced during a model turn as live. Cleanup never removes
   * them until the corresponding turn has finished. */
  beginTurn(): void {
    this.turnDepth += 1
  }

  /** Release the current-turn protection and run the bounded local cleanup. */
  async endTurn(): Promise<AttachmentCacheCleanupResult> {
    this.turnDepth = Math.max(0, this.turnDepth - 1)
    if (this.turnDepth > 0) {
      return this.cleanup()
    }
    this.activePaths.clear()
    const result = await this.cleanup()
    return result
  }

  /** Reap expired and least-recently-used files under this Agent's home.
   * Symlinks and directories are never followed. Active turn paths are
   * protected even when the cache is over its size limit. */
  async cleanup(): Promise<AttachmentCacheCleanupResult> {
    const root = join(this.homeRoot, 'attachments')
    const entries: Array<{ path: string; size: number; atimeMs: number }> = []
    try {
      const messages = await readdir(root, { withFileTypes: true })
      for (const message of messages) {
        if (!message.isDirectory() || message.isSymbolicLink()) continue
        const directory = join(root, message.name)
        const files = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        })
        for (const file of files) {
          if (!file.isFile() || file.isSymbolicLink()) continue
          const path = join(directory, file.name)
          try {
            const info = await stat(path)
            if (!info.isFile()) continue
            entries.push({ path, size: info.size, atimeMs: Math.max(info.atimeMs, info.mtimeMs) })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      return { removedFiles: 0, removedBytes: 0, remainingBytes: 0 }
    }

    const now = this.now()
    const expired = entries.filter((entry) =>
      !this.activePaths.has(entry.path) && now - entry.atimeMs >= this.maxAgeMs,
    )
    const candidates = entries
      .filter((entry) => !this.activePaths.has(entry.path) && !expired.includes(entry))
      .sort((a, b) => a.atimeMs - b.atimeMs)
    const expiredPaths = new Set(expired.map((entry) => entry.path))
    let remainingBytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    const remove = [...expired, ...candidates]
    let removedFiles = 0
    let removedBytes = 0
    for (const entry of remove) {
      if (!expiredPaths.has(entry.path) && remainingBytes <= this.maxBytes) break
      try {
        await rm(entry.path, { force: true })
        removedFiles += 1
        removedBytes += entry.size
        remainingBytes -= entry.size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { removedFiles, removedBytes, remainingBytes: Math.max(0, remainingBytes) }
  }

  /** Sweep after the runner has stopped. Persistent engine sessions may still
   * refer to paths from earlier turns, so keep unexpired files unless the
   * owning Agent is being removed. */
  async dispose(options: { purge?: boolean } = {}): Promise<void> {
    this.activePaths.clear()
    this.turnDepth = 0
    if (options.purge) {
      await rm(join(this.homeRoot, 'attachments'), { recursive: true, force: true })
      return
    }
    await this.cleanup()
  }

  async materialize(messageId: string, value: unknown): Promise<AttachmentCacheResult> {
    await this.cleanup()
    const safeMessage = messageId.replace(/[^a-z0-9._-]/gi, '_').slice(0, 160) || createHash('sha256')
      .update(messageId).digest('hex').slice(0, 16)
    const directory = join(this.homeRoot, 'attachments', safeMessage)
    await ensureCacheDirectory(join(this.homeRoot, 'attachments'))
    await ensureCacheDirectory(directory)
    const token = await this.getToken()
    const files: CachedAttachment[] = []
    const failures: Array<{ name: string; reason: string; key?: string }> = []

    for (const [index, attachment] of normalizeAttachments(value).entries()) {
      const key = normalizeStorageKey(attachment.key ?? '')
      if (!key?.startsWith('attachments/')) {
        failures.push({ name: attachment.name, reason: 'missing trusted Cumora attachment key' })
        continue
      }
      try {
        const target = new URL(
          `${this.serverUrl.replace(/\/+$/, '')}/runtime/attachment?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(messageId)}`,
        )
        const response = await this.fetchImpl(
          target,
          {
            headers: { Authorization: `Bearer ${token}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
          },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const declared = Number(response.headers.get('content-length') ?? 0)
        if (declared > ATTACHMENT_MAX_FILE_BYTES) throw new Error('attachment exceeds 25 MiB')
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0) throw new Error('attachment is empty')
        if (bytes.length > ATTACHMENT_MAX_FILE_BYTES) throw new Error('attachment exceeds 25 MiB')
        const extension = extname(safeName(attachment.name)).replace(/[^.a-z0-9]/gi, '').slice(0, 16)
        const file = join(directory, `${index + 1}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}${extension}`)
        const staged = `${file}.${process.pid}.${randomUUID()}.tmp`
        try {
          await writeFile(staged, bytes, { mode: 0o600, flag: 'wx' })
          await chmod(staged, 0o600).catch(() => {})
          await rename(staged, file)
        } finally {
          await rm(staged, { force: true }).catch(() => {})
        }
        if (this.turnDepth > 0) this.activePaths.add(file)
        // Keep the local file's access time fresh for LRU cleanup. This is
        // best effort because some filesystems disable atime updates.
        await utimes(file, new Date(), new Date()).catch(() => {})
        files.push({
          attachment,
          path: file,
          ...(textual(attachment.mime) ? {
            text: bytes.subarray(0, ATTACHMENT_TEXT_EXCERPT_BYTES).toString('utf8'),
            textTruncated: bytes.length > ATTACHMENT_TEXT_EXCERPT_BYTES,
          } : {}),
        })
      } catch (error) {
        failures.push({ name: attachment.name, key, reason: error instanceof Error ? error.message : 'download failed' })
      }
    }
    return { files, failures }
  }
}

export function attachmentImageGuidance(vision: VisionCapability): string {
  if (vision === 'supported') {
    return 'This image is in your Agent home. Use native image input or image viewing on this path before relying on visual details.'
  }
  if (vision === 'unsupported') {
    return 'The active model does not support image input. Do not claim to have seen this image.'
  }
  return 'Visual support is unknown. If you have a native image viewer, use the local path to inspect this image. Do not claim to have seen it unless image viewing succeeds.'
}

export function renderCachedAttachments(result: AttachmentCacheResult, vision: VisionCapability): string {
  const lines: string[] = []
  for (const file of result.files) {
    lines.push(`Attachment "${file.attachment.name}": ${file.path}`)
    if (isImageAttachment(file.attachment)) {
      lines.push(attachmentImageGuidance(vision))
    }
    if (file.text !== undefined) {
      lines.push(`File excerpt${file.textTruncated ? ' (first 50 KiB)' : ''}:`, '```', file.text, '```')
    }
  }
  for (const failure of result.failures) {
    lines.push(`Attachment "${failure.name}" could not be downloaded: ${failure.reason}`)
  }
  return lines.join('\n')
}
