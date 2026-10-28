import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttachmentDescriptor } from '../shared/attachments'
import { canSelectAttachments } from '../src/lib/attachmentPolicy'

const file = (name: string, size: number): AttachmentDescriptor => ({
  name,
  kind: 'file',
  url: `/uploads/attachments/${name}`,
  size,
})

test('client policy accepts a selection inside every limit', () => {
  assert.deepEqual(canSelectAttachments([file('a', 10)], [file('b', 20)]), { ok: true })
})

test('client policy reports count, per-file, and aggregate failures', () => {
  assert.deepEqual(canSelectAttachments([], Array.from({ length: 17 }, (_, index) => file(String(index), 1))), {
    ok: false,
    error: 'Attach at most 16 files.',
  })
  assert.deepEqual(canSelectAttachments([], [file('huge', 25 * 1024 * 1024 + 1)]), {
    ok: false,
    error: 'Each file must be 25 MiB or smaller.',
  })
  assert.deepEqual(canSelectAttachments(
    [file('a', 13 * 1024 * 1024)],
    [file('b', 13 * 1024 * 1024)],
  ), {
    ok: false,
    error: 'Attachments must total 25 MiB or less.',
  })
})
