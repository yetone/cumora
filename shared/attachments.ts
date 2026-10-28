/** Canonical chat-attachment policy and boundary parsing.
 *
 * Messages historically stored one descriptor in `messages.attachment`; email
 * and newer clients also need ordered lists. Keep the persisted/wire value
 * tolerant while giving application code one normalized shape. This module is
 * deliberately storage-free so the browser, server, and tests can share it.
 */

export const ATTACHMENT_MAX_FILES = 16
export const ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024
export const ATTACHMENT_TEXT_EXCERPT_BYTES = 50 * 1024

export const ATTACHMENT_KINDS = ['img', 'pdf', 'file', 'fig'] as const
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number]

export interface AttachmentDescriptor {
  readonly name: string
  readonly kind: AttachmentKind
  readonly url?: string
  readonly key?: string
  readonly mime?: string
  readonly size?: number
  /** Renderer-only legacy label used by old mock rows. */
  readonly meta?: string
}

export type AttachmentInput = AttachmentDescriptor | readonly AttachmentDescriptor[]

export type AttachmentValidationIssue =
  | 'invalid-shape'
  | 'too-many-files'
  | 'file-too-large'
  | 'total-too-large'

export type AttachmentValidationResult =
  | { readonly ok: true; readonly attachments: readonly AttachmentDescriptor[] }
  | { readonly ok: false; readonly issue: AttachmentValidationIssue; readonly index?: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(value)
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function parseOne(value: unknown): AttachmentDescriptor | null {
  if (!isRecord(value)) return null
  const name = nonEmptyString(value.name)
  if (!name || !isAttachmentKind(value.kind)) return null

  const parsedUrl = value.url === undefined ? undefined : nonEmptyString(value.url)
  const parsedKey = value.key === undefined ? undefined : nonEmptyString(value.key)
  if (value.url !== undefined && parsedUrl === null) return null
  if (value.key !== undefined && parsedKey === null) return null
  const url = parsedUrl ?? undefined
  const key = parsedKey ?? undefined
  if (url === undefined && key === undefined && value.meta === undefined) return null

  const parsedMime = value.mime === undefined ? undefined : nonEmptyString(value.mime)
  if (value.mime !== undefined && parsedMime === null) return null
  const mime = parsedMime ?? undefined
  const parsedMeta = value.meta === undefined ? undefined : nonEmptyString(value.meta)
  if (value.meta !== undefined && parsedMeta === null) return null
  const meta = parsedMeta ?? undefined
  if (value.size !== undefined && (typeof value.size !== 'number'
    || !Number.isSafeInteger(value.size) || value.size <= 0)) return null

  return {
    name,
    kind: value.kind,
    ...(url === undefined ? {} : { url }),
    ...(key === undefined ? {} : { key }),
    ...(mime === undefined ? {} : { mime: mime.toLowerCase() }),
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(meta === undefined ? {} : { meta }),
  }
}

/** Parse the old single-object wire value or the canonical array. A missing
 * value is an empty attachment list; malformed entries reject the whole value
 * so a router cannot partially persist a multi-file message. */
export function validateAttachmentInput(value: unknown): AttachmentValidationResult {
  if (value === null || value === undefined) return { ok: true, attachments: [] }
  if (Array.isArray(value) && value.length === 0) return { ok: true, attachments: [] }
  if (Array.isArray(value) && value.length > ATTACHMENT_MAX_FILES) {
    return { ok: false, issue: 'too-many-files' }
  }

  const raw = Array.isArray(value) ? value : [value]
  const attachments: AttachmentDescriptor[] = []
  let totalBytes = 0
  for (let index = 0; index < raw.length; index++) {
    const attachment = parseOne(raw[index])
    if (!attachment) return { ok: false, issue: 'invalid-shape', index }
    if (attachment.size !== undefined) {
      if (attachment.size > ATTACHMENT_MAX_FILE_BYTES) {
        return { ok: false, issue: 'file-too-large', index }
      }
      totalBytes += attachment.size
      if (totalBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
        return { ok: false, issue: 'total-too-large', index }
      }
    }
    attachments.push(attachment)
  }
  return { ok: true, attachments }
}

/** Normalize a persisted single attachment to a list, and pass through a
 * canonical list. Invalid legacy data becomes empty rather than crashing a
 * historical-message read. */
export function normalizeAttachments(value: unknown): readonly AttachmentDescriptor[] {
  const parsed = validateAttachmentInput(value)
  return parsed.ok ? parsed.attachments : []
}

export function attachmentTotalBytes(attachments: readonly AttachmentDescriptor[]): number {
  return attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0)
}

export type AttachmentSelectionCheck =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'too-many-files' | 'file-too-large' | 'total-too-large'
      readonly maxFiles?: number
      readonly maxBytes?: number
    }

/** Pure pre-upload check for the composer. Existing attachments are included
 * because aggregate policy applies to the whole send, not one picker action. */
export function checkAttachmentSelection(
  current: readonly AttachmentDescriptor[],
  incoming: readonly AttachmentDescriptor[],
): AttachmentSelectionCheck {
  const all = [...current, ...incoming]
  if (all.length > ATTACHMENT_MAX_FILES) {
    return { ok: false, reason: 'too-many-files', maxFiles: ATTACHMENT_MAX_FILES }
  }
  for (const attachment of incoming) {
    if (attachment.size !== undefined && attachment.size > ATTACHMENT_MAX_FILE_BYTES) {
      return { ok: false, reason: 'file-too-large', maxBytes: ATTACHMENT_MAX_FILE_BYTES }
    }
  }
  if (attachmentTotalBytes(all) > ATTACHMENT_MAX_TOTAL_BYTES) {
    return { ok: false, reason: 'total-too-large', maxBytes: ATTACHMENT_MAX_TOTAL_BYTES }
  }
  return { ok: true }
}
