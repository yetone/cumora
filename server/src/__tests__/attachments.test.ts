import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  normalizeAttachments,
  validateAttachmentInput,
  type AttachmentDescriptor,
} from '../../../shared/attachments.js'

const file = (name: string, size?: number): AttachmentDescriptor => ({
  name,
  kind: 'file',
  url: `/uploads/attachments/${name}`,
  ...(size === undefined ? {} : { size }),
})

test('policy constants are 16 files, 25 MiB aggregate, 25 MiB each', () => {
  assert.equal(ATTACHMENT_MAX_FILES, 16)
  assert.equal(ATTACHMENT_MAX_FILE_BYTES, 25 * 1024 * 1024)
  assert.equal(ATTACHMENT_MAX_TOTAL_BYTES, 25 * 1024 * 1024)
})

test('a legacy single attachment normalizes to one entry without changing it', () => {
  const legacy = { name: 'report.pdf', kind: 'pdf', url: '/uploads/attachments/report.pdf', mime: 'APPLICATION/PDF' } as const
  assert.deepEqual(normalizeAttachments(legacy), [{ ...legacy, mime: 'application/pdf' }])
})

test('a canonical attachment list preserves order', () => {
  const attachments = [file('one.txt'), { name: 'two.png', kind: 'img', key: 'attachments/two.png' }] as const
  const parsed = validateAttachmentInput(attachments)
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.attachments, attachments)
})

test('null, undefined, and an empty list normalize to no attachments', () => {
  for (const value of [null, undefined, []]) assert.deepEqual(normalizeAttachments(value), [])
})

test('malformed or non-canonical descriptors reject the entire input', () => {
  for (const value of [
    {},
    { name: '', kind: 'file', url: '/uploads/a' },
    { name: 'x', kind: 'exe', url: '/uploads/a' },
    { name: 'x', kind: 'file' },
    { name: 'x', kind: 'file', url: '   ' },
    { name: 'x', kind: 'file', url: '/uploads/a', size: -1 },
    { name: 'x', kind: 'file', url: '/uploads/a', size: 1.5 },
    [file('valid.txt'), null],
  ]) {
    const parsed = validateAttachmentInput(value)
    assert.equal(parsed.ok, false, JSON.stringify(value))
    if (!parsed.ok) assert.equal(parsed.issue, 'invalid-shape')
  }
})

test('legacy render-only meta descriptors survive normalization', () => {
  const parsed = validateAttachmentInput({ name: 'mock.pdf', kind: 'pdf', meta: '12 pages' })
  assert.deepEqual(parsed, { ok: true, attachments: [{ name: 'mock.pdf', kind: 'pdf', meta: '12 pages' }] })
})

test('file count, per-file, and aggregate limits are enforced', () => {
  assert.deepEqual(
    validateAttachmentInput(Array.from({ length: 17 }, (_, index) => file(`${index}.txt`))),
    { ok: false, issue: 'too-many-files' },
  )
  assert.deepEqual(
    validateAttachmentInput(file('huge.bin', ATTACHMENT_MAX_FILE_BYTES + 1)),
    { ok: false, issue: 'file-too-large', index: 0 },
  )
  assert.deepEqual(
    validateAttachmentInput([
      file('one.bin', 13 * 1024 * 1024),
      file('two.bin', 13 * 1024 * 1024),
    ]),
    { ok: false, issue: 'total-too-large', index: 1 },
  )
  assert.equal(validateAttachmentInput(Array.from({ length: 16 }, (_, index) => file(`${index}.txt`))).ok, true)
})
