import assert from 'node:assert/strict'
import test from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { enrichCliJsonWithAttachmentPaths } = await import('../agents/computer/daemon.js')

test('runtime CLI JSON exposes cached paths and text for every attachment', () => {
  const attachment = { name: 'notes.txt', kind: 'file' as const, key: 'attachments/notes.txt', mime: 'text/plain' }
  const image = { name: 'diagram.png', kind: 'img' as const, key: 'attachments/diagram.png', mime: 'image/png' }
  const failed = { name: 'missing.png', kind: 'img' as const, key: 'attachments/missing.png', mime: 'image/png' }
  const cached = {
    files: [
      {
        attachment,
        path: '/agent/home/attachments/message-1/1-a.txt',
        text: 'inline content',
        textTruncated: false,
      },
      {
        attachment: image,
        path: '/agent/home/attachments/message-1/2-a.png',
      },
    ],
    failures: [{ name: 'missing.png', key: 'attachments/missing.png', reason: 'HTTP 404' }],
  }
  const enriched = enrichCliJsonWithAttachmentPaths(
    JSON.stringify([{ id: 'message-1', body: 'see file', attachments: [attachment, image, failed], attachment }]),
    new Map([['message-1', cached]]),
    'unknown',
  )
  assert.ok(enriched)
  const rows = JSON.parse(enriched) as Array<Record<string, unknown>>
  const attachments = rows[0].attachments as Array<Record<string, unknown>>
  for (const descriptor of [
    attachments[0],
    rows[0].attachment as Record<string, unknown>,
  ]) {
    assert.equal(descriptor.localPath, '/agent/home/attachments/message-1/1-a.txt')
    assert.equal(descriptor.localText, 'inline content')
    assert.equal(descriptor.localTextTruncated, false)
  }
  assert.equal(attachments[1].localPath, '/agent/home/attachments/message-1/2-a.png')
  assert.match(String(attachments[1].localImageGuidance), /Do not claim to have seen it/)
  assert.equal(attachments[2].localPath, undefined)
  assert.equal(attachments[2].localError, 'HTTP 404')
})

test('non-JSON CLI text is left for the caller to append cache guidance', () => {
  assert.equal(enrichCliJsonWithAttachmentPaths('plain output', new Map(), 'unknown'), null)
})
