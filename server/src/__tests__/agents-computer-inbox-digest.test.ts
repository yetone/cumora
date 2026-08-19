/**
 * The BYOA wake digest is line-budgeted, and `ackSeen` marks the WHOLE snapshot
 * read on a clean turn. So anything the digest omits is marked read having never
 * been shown — and because mark-read pins each conversation's cursor at its
 * NEWEST message, it can never resurface in a later wake.
 *
 * That makes two properties load-bearing, and this file pins both:
 *   1. no conversation with unread may vanish from the digest entirely
 *   2. nothing may be dropped in silence — the count and how to read it must
 *      appear in place
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-inbox-digest.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderInboxDigest } from '../agents/computer/daemon.js'

type Convo = { head: string; msgs: string[] }

function build(spec: Array<[string, number]>): Map<string, Convo> {
  const m = new Map<string, Convo>()
  for (const [id, n] of spec) {
    m.set(id, {
      head: `# ${id} [group] "${id}"`,
      msgs: Array.from({ length: n }, (_, i) => `  [m-${id}-${i}] ${id}  someone: message ${i}`),
    })
  }
  return m
}

const messageLines = (digest: string): string[] =>
  digest.split('\n').filter((l) => /^ {2}\[m-/.test(l))

test('everything is shown verbatim when it fits the budget', () => {
  const digest = renderInboxDigest(build([['a', 3], ['b', 2]]), 40)
  assert.equal(messageLines(digest).length, 5)
  assert.ok(!digest.includes('not shown'), 'nothing should be announced as omitted')
  // Conversations keep first-seen order, messages stay chronological.
  assert.ok(digest.indexOf('# a ') < digest.indexOf('# b '))
  assert.ok(digest.indexOf('[m-a-0]') < digest.indexOf('[m-a-2]'))
})

test('a busy room cannot evict a quiet conversation entirely', () => {
  // The shape that bites: a human DM arrives FIRST, then a group bursts. Under a
  // global newest-N tail the DM is the oldest thing in the list, so it is the
  // first evicted — and the very next clean turn marks it read.
  const digest = renderInboxDigest(build([['dm', 1], ['busy', 200]]), 40)
  assert.ok(digest.includes('# dm '), 'the quiet conversation must still appear')
  assert.ok(
    messageLines(digest).some((l) => l.includes('[m-dm-0]')),
    'the quiet conversation\'s only unread message must be shown, not evicted',
  )
})

test('no conversation with unread disappears from the digest', () => {
  // 25 conversations x 2 unread — the offline-catch-up shape.
  const byConvo = build(Array.from({ length: 25 }, (_, i) => [`c${i}`, 2] as [string, number]))
  const digest = renderInboxDigest(byConvo, 40)
  for (const id of byConvo.keys()) {
    assert.ok(digest.includes(`# ${id} `), `conversation ${id} vanished from the digest`)
  }
})

test('omitted unread is announced with its count and how to read it', () => {
  const digest = renderInboxDigest(build([['busy', 60]]), 40)
  const shown = messageLines(digest).length
  assert.ok(shown < 60, 'the budget must actually cap the output')
  assert.match(
    digest,
    new RegExp(`… ${60 - shown} older unread message\\(s\\) not shown`),
    'the exact number dropped must be stated',
  )
  assert.match(digest, /cumora messages busy --tail 60/, 'the digest must say how to read the rest')
})

test('the budget is respected', () => {
  const digest = renderInboxDigest(build([['a', 100], ['b', 100], ['c', 100]]), 40)
  assert.ok(messageLines(digest).length <= 40, 'must not exceed the line budget')
})

test('a conversation budgeted to zero shows none of its messages, not all of them', () => {
  // Guards the slice(length - shown) vs slice(-shown) trap: slice(-0) is
  // slice(0), which would dump the whole conversation.
  const digest = renderInboxDigest(build([['a', 5], ['b', 5]]), 0)
  assert.equal(messageLines(digest).length, 0)
  assert.match(digest, /5 older unread message\(s\) not shown/)
})

test('an empty inbox renders as an empty digest', () => {
  assert.equal(renderInboxDigest(new Map(), 40), '')
})
