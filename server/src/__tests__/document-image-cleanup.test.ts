import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { extractStorageKeysFromDoc } from '../documents/rooms.js'
import { markdownToYXml, proseMirrorNodeToYXml } from '../documents/markdown.js'
import { teardownAll } from '../__integration__/_helpers.js'

after(async () => {
  await teardownAll()
})

test('extractStorageKeysFromDoc extracts native image nodes with storageKey or src', () => {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  const img1 = proseMirrorNodeToYXml({
    type: 'image',
    attrs: {
      src: 'https://cdn.cumora.ai/attachments/image-1.png',
      storageKey: 'attachments/image-1.png',
      alt: 'first',
    },
  })
  const img2 = proseMirrorNodeToYXml({
    type: 'image',
    attrs: {
      src: '/uploads/attachments/image-2.png',
      alt: 'second',
    },
  })
  const externalImg = proseMirrorNodeToYXml({
    type: 'image',
    attrs: {
      src: 'https://external-site.com/avatar.jpg',
      alt: 'external',
    },
  })

  fragment.push([img1, img2, externalImg])

  const keys = extractStorageKeysFromDoc(doc)
  assert.deepEqual(keys.sort(), ['attachments/image-1.png', 'attachments/image-2.png'])
})

test('extractStorageKeysFromDoc extracts keys from markdown image paragraphs and delta links', () => {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  const nodes = markdownToYXml('![chart](/uploads/attachments/chart.png)\n\n[Download PDF](attachments/document.pdf)')
  fragment.push(nodes)

  const keys = extractStorageKeysFromDoc(doc)
  assert.deepEqual(keys.sort(), [
    'attachments/chart.png',
    'attachments/document.pdf',
  ])
})

test('extractStorageKeysFromDoc deduplicates repeated storage keys', () => {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')

  const img1 = proseMirrorNodeToYXml({
    type: 'image',
    attrs: {
      storageKey: 'attachments/repeat.png',
      src: '/uploads/attachments/repeat.png',
    },
  })
  const img2 = proseMirrorNodeToYXml({
    type: 'image',
    attrs: {
      storageKey: 'attachments/repeat.png',
      src: '/uploads/attachments/repeat.png',
    },
  })

  fragment.push([img1, img2])

  const keys = extractStorageKeysFromDoc(doc)
  assert.deepEqual(keys, ['attachments/repeat.png'])
})
