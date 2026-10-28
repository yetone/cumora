import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  checkAttachmentSelection,
  type AttachmentDescriptor,
} from '../../shared/attachments'

export { ATTACHMENT_MAX_FILES, ATTACHMENT_MAX_TOTAL_BYTES }

export type AttachmentSelectionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/** Composer-facing policy check. The canonical shared function returns a
 * machine-readable failure; this adapter supplies copy the UI can render. */
export function canSelectAttachments(
  current: readonly AttachmentDescriptor[],
  incoming: readonly AttachmentDescriptor[],
): AttachmentSelectionResult {
  const result = checkAttachmentSelection(current, incoming)
  if (result.ok) return result
  switch (result.reason) {
    case 'too-many-files':
      return { ok: false, error: `Attach at most ${result.maxFiles} files.` }
    case 'file-too-large':
      return { ok: false, error: 'Each file must be 25 MiB or smaller.' }
    case 'total-too-large':
      return { ok: false, error: 'Attachments must total 25 MiB or less.' }
    default: {
      const exhaustive: never = result.reason
      return exhaustive
    }
  }
}
