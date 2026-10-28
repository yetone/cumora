import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

process.env.OPENAI_API_KEY ??= 'test-key'
const {
  ATTACHMENT_MAX_FILE_BYTES,
  ATTACHMENT_MAX_FILES,
} = await import('../../../shared/attachments.js')
const {
  freshenMessageAttachments,
  resolveMessageAttachments,
  storage,
  UPLOAD_DIR,
  validateChatUpload,
} = await import('../storage.js')
import type { AttachmentDescriptor } from '../../../shared/attachments.js'
import type { StoredObjectMetadata } from '../storage.js'

const attachment = (name: string, extra: Partial<AttachmentDescriptor> = {}): AttachmentDescriptor => ({
  name,
  kind: 'file',
  key: `attachments/${name}`,
  ...extra,
})

function backend(objects: Record<string, StoredObjectMetadata>) {
  return {
    async statObject(key: string) {
      return objects[key] ?? null
    },
    async publicUrl(key: string) {
      return `https://files.test/${key}?fresh=1`
    },
  }
}

test('legacy singular input resolves to an ordered canonical list', async () => {
  const key = 'attachments/legacy.txt'
  const result = await resolveMessageAttachments(
    attachment('legacy.txt'),
    backend({ [key]: { key, sizeBytes: 12, mime: 'text/plain' } }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.attachments, [{
    name: 'legacy.txt', kind: 'file', key,
    url: 'https://files.test/attachments/legacy.txt?fresh=1',
    mime: 'text/plain', size: 12,
  }])
})

test('multi-file input preserves order and derives kind, size, and MIME from storage', async () => {
  const keys = ['attachments/second.png', 'attachments/first.pdf']
  const result = await resolveMessageAttachments(
    [
      attachment('second.png', { kind: 'pdf', size: 3 }),
      attachment('first.pdf', { kind: 'img', size: 5 }),
    ],
    backend({
      [keys[0]]: { key: keys[0], sizeBytes: 3, mime: 'image/png' },
      [keys[1]]: { key: keys[1], sizeBytes: 5, mime: 'application/pdf' },
    }),
  )
  assert.equal(result.ok, true)
  if (!result.ok) return

  const trusted = await resolveMessageAttachments(
    [
      attachment('second.png', { size: 3 }),
      attachment('first.pdf', { size: 5 }),
    ],
    backend({
      [keys[0]]: { key: keys[0], sizeBytes: 3, mime: 'image/png' },
      [keys[1]]: { key: keys[1], sizeBytes: 5, mime: 'application/pdf' },
    }),
  )
  assert.equal(trusted.ok, true)
  if (!trusted.ok) return
  assert.deepEqual(trusted.attachments.map(({ name, kind, size, mime }) => ({ name, kind, size, mime })), [
    { name: 'second.png', kind: 'img', size: 3, mime: 'image/png' },
    { name: 'first.pdf', kind: 'pdf', size: 5, mime: 'application/pdf' },
  ])
})

test('missing object is rejected before persistence', async () => {
  const result = await resolveMessageAttachments(attachment('missing.txt'), backend({}))
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'attachment object does not exist',
    index: 0,
  })
})

test('message attachment resolution requires an active tenant grant when supplied', async () => {
  const key = 'attachments/granted.txt'
  const result = await resolveMessageAttachments(
    attachment('granted.txt'),
    backend({ [key]: { key, sizeBytes: 4, mime: 'text/plain' } }),
    { attachmentGrant: async () => false },
  )
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'attachment is not granted to this workspace',
    index: 0,
  })
})

test('local object lookup ignores only missing MIME sidecars', {
  skip: storage.mode !== 'local',
}, async () => {
  const name = `sidecar-${randomUUID()}.txt`
  const key = `attachments/${name}`
  const objectPath = join(UPLOAD_DIR, key)
  const sidecarPath = join(UPLOAD_DIR, dirname(key), `${basename(key)}.cumora-mime`)
  try {
    await storage.put(key, Buffer.from('body'), 'text/plain')
    await rm(sidecarPath)
    const metadata = await storage.statObject(key)
    assert.equal(metadata?.sizeBytes, 4)
    assert.equal(metadata?.mime, undefined)

    await mkdir(sidecarPath)
    await assert.rejects(storage.statObject(key), (error: unknown) => {
      assert.notEqual((error as NodeJS.ErrnoException).code, 'ENOENT')
      return true
    })
  } finally {
    await Promise.all([
      rm(objectPath, { force: true }),
      rm(sidecarPath, { recursive: true, force: true }),
    ])
  }
})

test('declared and actual sizes must match exactly', async () => {
  const key = 'attachments/report.pdf'
  const result = await resolveMessageAttachments(
    attachment('report.pdf', { size: 10 }),
    backend({ [key]: { key, sizeBytes: 11, mime: 'application/pdf' } }),
  )
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'attachment size does not match uploaded object',
    index: 0,
  })
})

test('forged MIME is rejected', async () => {
  const key = 'attachments/script.txt'
  const result = await resolveMessageAttachments(
    attachment('script.txt', { mime: 'text/html' }),
    backend({ [key]: { key, sizeBytes: 1, mime: 'text/plain' } }),
  )
  assert.deepEqual(result, {
    ok: false,
    status: 400,
    error: 'attachment MIME does not match uploaded object',
    index: 0,
  })
})

test('file count and total storage size are enforced', async () => {
  const tooMany = Array.from({ length: ATTACHMENT_MAX_FILES + 1 }, (_, index) => attachment(`${index}.txt`))
  assert.deepEqual(await resolveMessageAttachments(tooMany, backend({})), {
    ok: false,
    status: 413,
    error: 'too many attachments (maximum 16)',
  })

  const keys = ['attachments/a.bin', 'attachments/b.bin']
  const result = await resolveMessageAttachments(
    keys.map((key, index) => ({ name: `${index}.bin`, kind: 'file', key })),
    backend({
      [keys[0]]: { key: keys[0], sizeBytes: 13 * 1024 * 1024, mime: 'application/zip' },
      [keys[1]]: { key: keys[1], sizeBytes: 13 * 1024 * 1024, mime: 'application/zip' },
    }),
  )
  assert.deepEqual(result, {
    ok: false,
    status: 413,
    error: 'attachments exceed 25 MiB total',
    index: 1,
  })
})

test('actual stored object over the per-file limit is rejected', async () => {
  const key = 'attachments/huge.zip'
  const result = await resolveMessageAttachments(
    attachment('huge.zip'),
    backend({ [key]: { key, sizeBytes: ATTACHMENT_MAX_FILE_BYTES + 1, mime: 'application/zip' } }),
  )
  assert.deepEqual(result, {
    ok: false,
    status: 413,
    error: 'attachment object size is invalid (maximum 25 MiB)',
    index: 0,
  })
})

test('response freshening retains all entries and sets the legacy first entry', async () => {
  const result = await freshenMessageAttachments([
    attachment('one.txt', { url: '/uploads/attachments/one.txt' }),
    attachment('two.txt', { url: '/uploads/attachments/two.txt' }),
  ])
  assert.deepEqual(result.attachments.map((item) => item.name), ['one.txt', 'two.txt'])
  assert.deepEqual(result.attachment, result.attachments[0])
})

test('presign validation caps the declared Content-Length at 25 MiB', () => {
  assert.deepEqual(validateChatUpload({
    name: 'note.txt', mime: 'text/plain', size: ATTACHMENT_MAX_FILE_BYTES + 1,
  }), {
    ok: false,
    status: 413,
    error: `size out of range (got ${ATTACHMENT_MAX_FILE_BYTES + 1}, max ${ATTACHMENT_MAX_FILE_BYTES})`,
  })
  assert.deepEqual(validateChatUpload({ name: 'note.txt', mime: 'text/plain', size: 12 }), {
    ok: true, name: 'note.txt', mime: 'text/plain', size: 12, kind: 'file',
  })
})
