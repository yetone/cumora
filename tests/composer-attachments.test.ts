import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  descriptorsToRuntime,
  markAttachmentFailed,
  markAttachmentUploaded,
  readyAttachments,
  reconcileRuntimeWithDraft,
  runtimeToDescriptors,
} from '../src/lib/composerAttachments'
import type { ApiAttachment } from '../src/api/client'

const uploaded = (name: string, size = 1): ApiAttachment => ({
  name,
  kind: 'file',
  url: `/files/${name}`,
  key: `attachments/${name}`,
  mime: 'text/plain',
  size,
})

describe('composer attachment lifecycle', () => {
  it('keeps a failed upload isolated while its siblings remain sendable', () => {
    const [first, second] = descriptorsToRuntime([uploaded('first.txt'), uploaded('second.txt')])
    const failed = markAttachmentFailed([first, second], first.id, 'offline')

    assert.equal(failed[0].state, 'error')
    assert.deepEqual(readyAttachments(failed), [second.attachment])
    assert.deepEqual(runtimeToDescriptors(failed), [{
      name: 'second.txt', kind: 'file', url: '/files/second.txt',
      key: 'attachments/second.txt', mime: 'text/plain', size: 1,
    }])
  })

  it('preserves list order when an upload succeeds', () => {
    const [first, second] = descriptorsToRuntime([uploaded('first.txt'), uploaded('second.txt')])
    const next = markAttachmentUploaded([first, second], first.id, uploaded('first-final.txt'))
    assert.deepEqual(readyAttachments(next).map((attachment) => attachment.name), ['first-final.txt', 'second.txt'])
  })

  it('rehydrates persisted attachments in their stored order', () => {
    const restored = reconcileRuntimeWithDraft(undefined, [uploaded('a.txt'), uploaded('b.txt')])
    assert.deepEqual(restored.map((item) => item.name), ['a.txt', 'b.txt'])
  })
})
