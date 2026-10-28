import assert from 'node:assert/strict'
import test from 'node:test'

process.env.OPENAI_API_KEY ??= 'test-key'

const { attachmentUrlMatchesStorageKey } = await import('../agents/runtime/authorization.js')

test('legacy local attachment URLs authorize the exact derived key', () => {
  assert.equal(
    attachmentUrlMatchesStorageKey('/uploads/attachments/report.pdf?download=1', 'attachments/report.pdf'),
    true,
  )
})

test('arbitrary public URLs never authorize a chat storage key', () => {
  assert.equal(
    attachmentUrlMatchesStorageKey('https://example.com/attachments/report.pdf', 'attachments/report.pdf'),
    false,
  )
})

test('a key-looking URL path cannot substitute for the requested object', () => {
  assert.equal(
    attachmentUrlMatchesStorageKey('/uploads/attachments/report.pdf', 'attachments/other.pdf'),
    false,
  )
})
