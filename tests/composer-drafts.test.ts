import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyDraftUpdate,
  parseStoredDrafts,
  serializeDrafts,
  type ComposerDrafts,
} from '../src/stores/composerDrafts'

const first = { name: 'first.pdf', kind: 'pdf' as const, url: '/first.pdf', key: 'attachments/first.pdf', size: 10 }
const second = { name: 'second.png', kind: 'img' as const, url: '/second.png', key: 'attachments/second.png', size: 20 }

describe('composer draft attachment persistence', () => {
  it('migrates the legacy singular attachment into an ordered array', () => {
    const drafts = parseStoredDrafts(JSON.stringify({
      room: { text: 'keep me', attachment: first },
    }))
    assert.deepEqual(drafts.room, { text: 'keep me', attachments: [first] })
  })

  it('round-trips multiple attachments without changing their order', () => {
    const drafts: ComposerDrafts = {
      room: { text: 'two files', attachments: [first, second] },
    }
    const json = serializeDrafts(drafts)
    assert.ok(json)
    assert.deepEqual(parseStoredDrafts(json), drafts)
  })

  it('deletes an emptied draft only when text and every attachment are gone', () => {
    const drafts: ComposerDrafts = { room: { text: '', attachments: [first] } }
    assert.deepEqual(applyDraftUpdate(drafts, 'room', (draft) => ({ ...draft, text: 'caption' })).room, {
      text: 'caption', attachments: [first],
    })
    assert.deepEqual(applyDraftUpdate(drafts, 'room', (draft) => ({ ...draft, attachments: [] })), {})
  })
})
