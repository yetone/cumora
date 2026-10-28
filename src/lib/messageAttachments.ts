import {
  normalizeAttachments,
  validateAttachmentInput,
  type AttachmentDescriptor,
} from '../../shared/attachments'
import type { ApiAttachment } from '@/api/client'

export interface AttachmentWireMessage {
  readonly attachment?: unknown
  readonly attachments?: unknown
}

/** Read boundary for history rows and WS frames. The canonical array wins;
 *  otherwise the old singular column is normalized into a one-item list. */
export function attachmentsFromMessage(message: AttachmentWireMessage): readonly AttachmentDescriptor[] {
  return normalizeAttachments(message.attachments ?? message.attachment)
}

/** Legacy sidebar/mock descriptors used `meta` in place of a real URL. Keep
 *  those visible even though canonical storage-boundary parsing rejects them. */
export function previewAttachmentsFromMessage(message: AttachmentWireMessage): readonly AttachmentDescriptor[] {
  const canonical = attachmentsFromMessage(message)
  if (canonical.length > 0) return canonical
  const source = message.attachments ?? message.attachment
  const raw = Array.isArray(source) ? source : source ? [source] : []
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    if (typeof record.name !== 'string' || typeof record.kind !== 'string'
      || !['img', 'pdf', 'file', 'fig'].includes(record.kind)) return []
    const candidate = {
      name: record.name,
      kind: record.kind as AttachmentDescriptor['kind'],
      ...(typeof record.url === 'string' ? { url: record.url } : {}),
      ...(typeof record.key === 'string' ? { key: record.key } : {}),
      ...(typeof record.mime === 'string' ? { mime: record.mime } : {}),
      ...(typeof record.size === 'number' ? { size: record.size } : {}),
      ...(typeof record.meta === 'string' ? { meta: record.meta } : {}),
    }
    if (validateAttachmentInput(candidate).ok) return [candidate]
    // Some older sidebar WS payloads contain only a filename and kind. They
    // can label the preview but cannot be used to read or open an attachment.
    if (record.url === undefined && record.key === undefined && record.meta === undefined) {
      return [{ name: candidate.name, kind: candidate.kind }]
    }
    return []
  })
}

export function descriptorFromApiAttachment(attachment: ApiAttachment): AttachmentDescriptor {
  return {
    name: attachment.name,
    kind: attachment.kind,
    ...(attachment.url ? { url: attachment.url } : {}),
    ...(attachment.key ? { key: attachment.key } : {}),
    ...(attachment.mime ? { mime: attachment.mime } : {}),
    ...(attachment.size ? { size: attachment.size } : {}),
  }
}

export function apiAttachmentsFromMessage(message: AttachmentWireMessage): ApiAttachment[] {
  return attachmentsFromMessage(message).map((attachment) => ({
    url: attachment.url ?? '',
    name: attachment.name,
    kind: attachment.kind,
    key: attachment.key,
    mime: attachment.mime,
    size: attachment.size,
  }))
}
