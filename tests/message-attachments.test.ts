import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { ApiMessage } from '../src/api/client'
import { attachmentsFromMessage } from '../src/lib/messageAttachments'

function message(overrides: Partial<ApiMessage>): ApiMessage {
  return {
    id: 'm-1', conversationId: 'room', authorId: 'user', kind: 'text',
    body: '', at: '12:00', sequence: 1, ...overrides,
  }
}

describe('message attachment normalization', () => {
  it('turns a legacy singular attachment into an ordered list', () => {
    const normalized = message({
      attachment: { name: 'old.pdf', kind: 'pdf', url: '/old.pdf', key: 'attachments/old.pdf' },
    })
    assert.deepEqual(attachmentsFromMessage(normalized), [{
      name: 'old.pdf', kind: 'pdf', url: '/old.pdf', key: 'attachments/old.pdf',
    }])
  })

  it('keeps every canonical attachment in history order', () => {
    const attachments = [
      { name: 'one.png', kind: 'img' as const, url: '/one.png' },
      { name: 'two.pdf', kind: 'pdf' as const, url: '/two.pdf' },
      { name: 'three.zip', kind: 'file' as const, url: '/three.zip' },
    ]
    assert.deepEqual(attachmentsFromMessage(message({ attachments })), attachments)
  })
})

describe('chat send wire payload', () => {
  it('sends the full ordered attachments array rather than the legacy field', () => {
    const source = readFileSync(new URL('../src/api/client.ts', import.meta.url), 'utf8')
    const sendStart = source.indexOf('sendMessage: (')
    const sendEnd = source.indexOf('/* ============== Polls', sendStart)
    const sendSource = source.slice(sendStart, sendEnd)
    assert.match(sendSource, /attachments\?: readonly ApiAttachment\[\]/)
    assert.match(sendSource, /attachments: attachments\?\.length \? attachments : undefined/)
    assert.doesNotMatch(sendSource, /attachment: attachment \?\? undefined/)
  })
})
