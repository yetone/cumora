import {
  ATTACHMENT_TEXT_EXCERPT_BYTES,
  normalizeAttachments,
  type AttachmentDescriptor,
} from '../../../shared/attachments.js'

export type VisionCapability = 'supported' | 'unsupported' | 'unknown'

export type AttachmentInputPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly imageUrl: string; readonly detail: 'auto' }
  | { readonly type: 'unreadable-image'; readonly text: string }

export interface AttachmentPartOptions {
  readonly vision: VisionCapability
  readonly messageId: string
}

function isImage(attachment: AttachmentDescriptor): boolean {
  return attachment.kind === 'img' || attachment.mime?.startsWith('image/') === true
}

function imageNotice(name: string, capability: VisionCapability): string {
  const reason = capability === 'unsupported'
    ? 'the active model does not support image input'
    : capability === 'unknown'
      ? 'image support is unknown for the active model'
      : 'the image data is unavailable'
  return `Image "${name}" was not included: ${reason}. Its metadata is still available; do not claim to have seen it.`
}

/** Turn canonical descriptors into provider-neutral content parts. The caller
 * owns secure materialization and supplies the ready `imageUrl`; keeping fetch
 * policy out of this function makes the tri-state behavior testable. */
export function attachmentInputParts(
  attachments: unknown,
  options: AttachmentPartOptions,
): readonly AttachmentInputPart[] {
  const parts: AttachmentInputPart[] = []
  for (const attachment of normalizeAttachments(attachments)) {
    if (!isImage(attachment)) continue
    parts.push({ type: 'text', text: `Image attached to message ${options.messageId} ("${attachment.name}"):` })
    if (options.vision === 'supported' && attachment.url) {
      parts.push({ type: 'image', imageUrl: attachment.url, detail: 'auto' })
    } else {
      parts.push({ type: 'unreadable-image', text: imageNotice(attachment.name, options.vision) })
    }
  }
  return parts
}

/** Build an excerpt part without performing I/O. `bytes` must be the exact
 * bytes that will be shown; invalid UTF-8 is replaced rather than throwing. */
export function textExcerptPart(
  attachment: AttachmentDescriptor,
  bytes: Uint8Array,
): AttachmentInputPart {
  const text = new TextDecoder().decode(bytes.subarray(0, ATTACHMENT_TEXT_EXCERPT_BYTES))
  return {
    type: 'text',
    text: `File excerpt ("${attachment.name}"):\n${text}`,
  }
}
