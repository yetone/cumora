/**
 * A reply has to move its root's count by exactly one, on every client.
 *
 * `applyEvent` bumped the quoted root only for arrivals with no local
 * counterpart (`!prior`). That is never true on the client that WROTE the
 * reply: its own server echo always matches the optimistic bubble — by real id
 * once the POST resolves, or by clientId when the echo wins the race — and
 * `sendUserMessage` never counted it at insert time either. So the author's
 * copy of the root stayed one short, permanently: `loadConversation` bails on
 * `loaded.has(id)`, so leaving and re-entering the conversation does not
 * refetch, and only a full reload repaired it.
 *
 * At zero that is not a wrong number, it is a missing door. `Message.tsx` gates
 * the app's ONLY `openThreadView` call site on `(msg.replyCount ?? 0) > 0`, so
 * the person who wrote a thread's first reply could not open the thread they
 * had just created. Their teammates could.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { Message } from '../src/types'
import { applyReplyCountDelta } from '../src/lib/replyCount'

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm-root',
    conversationId: 'g-1',
    authorId: 'u-iris',
    kind: 'text',
    body: 'ship it?',
    at: '2026-03-01T10:00:00.000Z',
    ...over,
  } as Message
}

describe('applyReplyCountDelta', () => {
  it('takes a root from no-replies to one reply — the case that opens the door', () => {
    const [root] = applyReplyCountDelta([msg()], 'm-root', 1)
    assert.equal(root.replyCount, 1)
  })

  it('counts on top of what the server already reported', () => {
    const [root] = applyReplyCountDelta([msg({ replyCount: 4 })], 'm-root', 1)
    assert.equal(root.replyCount, 5)
  })

  it('gives the count back when a reply is thrown away', () => {
    const [root] = applyReplyCountDelta([msg({ replyCount: 3 })], 'm-root', -1)
    assert.equal(root.replyCount, 2)
  })

  it('never counts below zero', () => {
    // A discard of a reply whose root was loaded after the fact.
    const [root] = applyReplyCountDelta([msg({ replyCount: 0 })], 'm-root', -1)
    assert.equal(root.replyCount, 0)
  })

  it('is a no-op for a message that is not a reply', () => {
    const list = [msg({ replyCount: 2 })]
    assert.equal(applyReplyCountDelta(list, null, 1), list)
    assert.equal(applyReplyCountDelta(list, undefined, 1), list)
  })

  it('is a no-op when the root is not in the loaded page', () => {
    // Replying to an old message the user scrolled back to and then away from.
    const list = [msg({ replyCount: 2 })]
    assert.equal(applyReplyCountDelta(list, 'm-somewhere-else', 1), list)
  })

  it('touches only the root, and does not mutate the array it was given', () => {
    const list = [msg({ replyCount: 1 }), msg({ id: 'm-other', replyCount: 7 })]
    const next = applyReplyCountDelta(list, 'm-root', 1)
    assert.equal(next[1], list[1], 'an unrelated message was rebuilt')
    assert.equal(list[0].replyCount, 1, 'the input list was mutated')
    assert.equal(next[0].replyCount, 2)
  })

  it('the author\'s full sequence lands on exactly one', () => {
    // insert the optimistic bubble (+1), then the server echo contributes 0
    // because applyEvent skips arrivals that match a prior local copy.
    let list = [msg()]
    list = applyReplyCountDelta(list, 'm-root', 1)   // sendUserMessage
    // echo: prior found -> no delta
    assert.equal(list[0].replyCount, 1, 'the author must end at exactly one, not zero and not two')
  })
})

describe('the three places that have to agree', () => {
  // The helper is pure: every test above passes just as well against a build
  // where sendUserMessage never counts. The bug was never in the arithmetic —
  // it was that only one of the three sites did any.

  it('the optimistic insert counts the reply', async () => {
    const source = await readFile(new URL('../src/stores/messages.ts', import.meta.url), 'utf8')
    const send = source.slice(source.indexOf('export async function sendUserMessage'))
    const body = send.slice(0, send.indexOf('\nexport '))
    assert.match(body, /applyReplyCountDelta\([\s\S]{0,120}quotedMessageId,\s*\n?\s*1,/,
      'sendUserMessage no longer counts the reply it just inserted — the author\'s root will stay one short and, at zero, hide the only way into the thread')
  })

  it('the server echo does not count it a second time', async () => {
    const source = await readFile(new URL('../src/stores/messages.ts', import.meta.url), 'utf8')
    assert.match(source, /if \(!prior\) next = applyReplyCountDelta\(next, m\.quotedMessageId, 1\)/,
      'the arrival bump is no longer guarded on `!prior`, so the author would double-count their own reply')
  })

  it('discarding a failed reply gives the count back', async () => {
    // Also what keeps a retry balanced: retryFailedMessage discards, then sends.
    const source = await readFile(new URL('../src/stores/messages.ts', import.meta.url), 'utf8')
    const discard = source.slice(source.indexOf('export function discardFailedMessage'))
    const body = discard.slice(0, discard.indexOf('\nexport '))
    assert.match(body, /applyReplyCountDelta\([\s\S]{0,160}-1,/,
      'a discarded reply leaves a phantom count on its root, and a retry would count twice')
  })

  it('the thread drawer is still gated on the count', async () => {
    // If this ever stops being true the bug above stops being a missing door
    // and becomes a wrong number — worth knowing which one we are fixing.
    const source = await readFile(new URL('../src/components/Message.tsx', import.meta.url), 'utf8')
    assert.match(source, /\(msg\.replyCount \?\? 0\) > 0/)
    assert.match(source, /openThreadView\(msg\.conversationId, msg\.id\)/)
  })
})
