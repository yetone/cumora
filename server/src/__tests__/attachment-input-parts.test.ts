import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AttachmentDescriptor } from '../../../shared/attachments.js'
import {
  attachmentInputParts,
  textExcerptPart,
  type VisionCapability,
} from '../attachments/input-parts.js'

const image: AttachmentDescriptor = {
  name: 'diagram.png',
  kind: 'img',
  mime: 'image/png',
  url: 'data:image/png;base64,c2FmZQ==',
}

test('a supported vision model receives a label and image part', () => {
  assert.deepEqual(attachmentInputParts([image], { vision: 'supported', messageId: 'm1' }), [
    { type: 'text', text: 'Image attached to message m1 ("diagram.png"):' },
    { type: 'image', imageUrl: image.url, detail: 'auto' },
  ])
})

test('a legacy single descriptor is accepted at the part-builder boundary', () => {
  assert.deepEqual(attachmentInputParts(image, { vision: 'supported', messageId: 'legacy' }), [
    { type: 'text', text: 'Image attached to message legacy ("diagram.png"):' },
    { type: 'image', imageUrl: image.url, detail: 'auto' },
  ])
})

test('unsupported and unknown vision produce distinct unreadable-image notices', () => {
  const parts = (vision: VisionCapability) => attachmentInputParts([image], { vision, messageId: 'm2' })
  const unsupported = parts('unsupported')[1]
  const unknown = parts('unknown')[1]
  assert.equal(unsupported.type, 'unreadable-image')
  assert.equal(unknown.type, 'unreadable-image')
  if (unsupported.type !== 'unreadable-image' || unknown.type !== 'unreadable-image') return
  assert.match(unsupported.text, /does not support image input/)
  assert.match(unknown.text, /support is unknown/)
  assert.doesNotMatch(unsupported.text, /support is unknown/)
})

test('a supported model still gets a notice when the image bytes are unavailable', () => {
  const parts = attachmentInputParts([{
    name: 'missing.png',
    kind: 'img',
    key: 'attachments/missing.png',
  }], {
    vision: 'supported',
    messageId: 'm3',
  })
  assert.deepEqual(parts, [
    { type: 'text', text: 'Image attached to message m3 ("missing.png"):' },
    {
      type: 'unreadable-image',
      text: 'Image "missing.png" was not included: the image data is unavailable. Its metadata is still available; do not claim to have seen it.',
    },
  ])
})

test('non-image attachments produce no image parts', () => {
  assert.deepEqual(attachmentInputParts([
    { name: 'notes.txt', kind: 'file', mime: 'text/plain' },
    { name: 'brief.pdf', kind: 'pdf' },
  ], { vision: 'supported', messageId: 'm4' }), [])
})

test('text excerpts are capped at 50 KiB and replace invalid UTF-8', () => {
  const source = new Uint8Array(50 * 1024 + 4)
  source.fill(0x61)
  source.set([0xff, 0xfe, 0xfd, 0xfc], 50 * 1024)
  const part = textExcerptPart({ name: 'notes.txt', kind: 'file', mime: 'text/plain' }, source)
  assert.equal(part.type, 'text')
  if (part.type !== 'text') return
  assert.match(part.text, /^File excerpt \("notes.txt"\):\n/)
  assert.ok(part.text.endsWith('a'))
  assert.ok(new TextEncoder().encode(part.text).length < 50 * 1024 + 100)
})
