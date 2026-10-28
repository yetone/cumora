import {
  ATTACHMENT_MAX_FILES,
  type AttachmentDescriptor,
} from '../../shared/attachments'
import { canSelectAttachments } from './attachmentPolicy'
import { descriptorFromApiAttachment } from './messageAttachments'
import type { ApiAttachment } from '@/api/client'

export type ComposerAttachmentState = 'uploading' | 'ready' | 'error'

/** Runtime-only upload state. `id` is stable for retry and removal; `file` is
 *  kept only for a failed upload and disappears as soon as it succeeds. */
export interface ComposerAttachment {
  readonly id: string
  readonly name: string
  readonly mime: string
  readonly size: number
  readonly kind: ApiAttachment['kind']
  readonly state: ComposerAttachmentState
  readonly attachment?: ApiAttachment
  readonly error?: string
  readonly file?: File
}

let attachmentSequence = 0

export function createComposerAttachment(file: File): ComposerAttachment {
  attachmentSequence += 1
  return {
    id: `attachment-${Date.now().toString(36)}-${attachmentSequence.toString(36)}`,
    name: file.name || (file.type.startsWith('image/') ? 'pasted-image' : 'file'),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    kind: file.type.startsWith('image/') ? 'img' : 'file',
    state: 'uploading',
    file,
  }
}

/** Runtime attachments mirror the persisted ones, but only ready uploads
 *  participate in aggregate policy. A failed file still reserves its place in
 *  the visual order and can retry independently. */
export function runtimeToDescriptors(items: readonly ComposerAttachment[]): AttachmentDescriptor[] {
  return items.flatMap((item) => item.state === 'ready' && item.attachment
    ? [descriptorFromApiAttachment(item.attachment)]
    : [])
}

export function descriptorsToRuntime(attachments: readonly ApiAttachment[]): ComposerAttachment[] {
  return attachments.map((attachment, index) => ({
    id: `draft-${index}-${attachment.key ?? attachment.url}`,
    name: attachment.name,
    mime: attachment.mime ?? attachment.kind,
    size: attachment.size ?? 0,
    kind: attachment.kind,
    state: 'ready',
    attachment,
  }))
}

/** Rehydrate ready runtime rows with descriptors from the persisted draft. */
export function reconcileRuntimeWithDraft(
  runtime: readonly ComposerAttachment[] | undefined,
  persisted: readonly ApiAttachment[],
): ComposerAttachment[] {
  const restored = descriptorsToRuntime(persisted)
  if (!runtime) return restored
  if (runtime.length === 0) return restored
  const restoredByKey = new Map(restored.map((item) => [
    item.attachment?.key ?? item.attachment?.url ?? item.id,
    item,
  ]))
  return runtime.map((item) => item.state === 'ready' && item.attachment
    ? restoredByKey.get(item.attachment.key ?? item.attachment.url) ?? item
    : item)
}

export function checkRuntimeSelection(
  current: readonly ComposerAttachment[],
  incomingFiles: readonly File[],
): { ok: true; incoming: ComposerAttachment[] } | { ok: false; error: string } {
  const incoming = incomingFiles.map(createComposerAttachment)
  // Count every visible row, including failed uploads. Otherwise repeatedly
  // failing files could exceed the 16-item message ceiling.
  if (current.length + incoming.length > ATTACHMENT_MAX_FILES) {
    return { ok: false, error: `Attach at most ${ATTACHMENT_MAX_FILES} files.` }
  }
  const readyCurrent = runtimeToDescriptors(current.filter((item) => item.state === 'ready'))
  const result = canSelectAttachments(
    readyCurrent,
    incoming.map((item) => ({ name: item.name, kind: item.kind, size: item.size })),
  )
  if (!result.ok) return result
  return { ok: true, incoming }
}

export function markAttachmentUploaded(
  items: readonly ComposerAttachment[],
  id: string,
  attachment: ApiAttachment,
): ComposerAttachment[] {
  return items.map((item) => item.id === id
    ? { ...item, state: 'ready', attachment, error: undefined, file: undefined }
    : item)
}

export function markAttachmentFailed(
  items: readonly ComposerAttachment[],
  id: string,
  error: string,
): ComposerAttachment[] {
  return items.map((item) => item.id === id
    ? { ...item, state: 'error', error }
    : item)
}

export function markAttachmentUploading(
  items: readonly ComposerAttachment[],
  id: string,
): ComposerAttachment[] {
  return items.map((item) => item.id === id
    ? { ...item, state: 'uploading', error: undefined }
    : item)
}

export function readyAttachments(items: readonly ComposerAttachment[]): ApiAttachment[] {
  return items.flatMap((item) => item.state === 'ready' && item.attachment ? [item.attachment] : [])
}

export function hasPendingAttachments(items: readonly ComposerAttachment[]): boolean {
  return items.some((item) => item.state === 'uploading')
}
