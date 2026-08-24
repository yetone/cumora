/**
 * Regression tests for message attachment storage references.
 *
 * Run: node --import tsx --test server/src/__tests__/storage-keys.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  messageAttachmentStorageKey,
  normalizeStorageKey,
  storageKeyFromPublicUrl,
} from '../storage-keys.js'

const PUBLIC_BASE = 'https://cdn.cumora.test/private-files'

test('rejects arbitrary text-attachment URLs, including private network targets', () => {
  for (const url of [
    'http://127.0.0.1:5181/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://10.0.0.8/internal',
    'https://attacker.example/payload.txt',
  ]) {
    assert.equal(messageAttachmentStorageKey({ url }, PUBLIC_BASE), null)
  }
})

test('accepts local and configured-public-base attachment URLs', () => {
  assert.equal(
    messageAttachmentStorageKey({ url: '/uploads/attachments/abc123.txt' }, PUBLIC_BASE),
    'attachments/abc123.txt',
  )
  assert.equal(
    messageAttachmentStorageKey({ url: `${PUBLIC_BASE}/attachments/abc123.txt?exp=1&sig=x` }, PUBLIC_BASE),
    'attachments/abc123.txt',
  )
})

test('accepts a valid explicit key while ignoring an unverifiable presigned URL', () => {
  assert.equal(
    messageAttachmentStorageKey({
      key: 'attachments/abc123.txt',
      url: 'https://bucket.example.invalid/presigned-object?signature=opaque',
    }, PUBLIC_BASE),
    'attachments/abc123.txt',
  )
})

test('rejects conflicting trusted key and URL references', () => {
  assert.equal(
    messageAttachmentStorageKey({
      key: 'attachments/one.txt',
      url: `${PUBLIC_BASE}/attachments/two.txt`,
    }, PUBLIC_BASE),
    null,
  )
})

test('message attachments cannot reference other storage namespaces', () => {
  assert.equal(messageAttachmentStorageKey({ key: 'avatars/person.png' }, PUBLIC_BASE), null)
  assert.equal(messageAttachmentStorageKey({ key: 'email-attachments/mail.txt' }, PUBLIC_BASE), null)
})

test('rejects traversal, encoded traversal, backslashes, and empty keys', () => {
  for (const key of [
    'attachments/../../etc/passwd',
    'attachments/%2e%2e/secret.txt',
    'attachments\\..\\secret.txt',
    'attachments/',
  ]) {
    assert.equal(normalizeStorageKey(key), null)
  }
})

test('public URL parsing is pinned to the configured origin and base path', () => {
  assert.equal(
    storageKeyFromPublicUrl(`${PUBLIC_BASE}/attachments/report.md`, PUBLIC_BASE),
    'attachments/report.md',
  )
  assert.equal(
    storageKeyFromPublicUrl('https://cdn.cumora.test/other/attachments/report.md', PUBLIC_BASE),
    null,
  )
  assert.equal(
    storageKeyFromPublicUrl('https://cdn.cumora.test.evil.example/private-files/attachments/report.md', PUBLIC_BASE),
    null,
  )
})
