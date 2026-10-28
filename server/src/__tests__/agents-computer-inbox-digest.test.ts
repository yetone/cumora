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
import { conversationHeader, renderInboxDigest, visibleInboxMessageIds } from '../agents/computer/daemon.js'

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

test('attachment materialization follows the messages the digest actually shows', () => {
  const byConvo = new Map([
    ['dm', {
      head: '# dm',
      msgs: ['  [dm-0] dm: one'],
      ids: ['dm-0'],
    }],
    ['busy', {
      head: '# busy',
      msgs: Array.from({ length: 60 }, (_, i) => `  [busy-${i}] busy: ${i}`),
      ids: Array.from({ length: 60 }, (_, i) => `busy-${i}`),
    }],
  ])
  const visible = visibleInboxMessageIds(byConvo, 40)
  assert.ok(visible.has('dm-0'))
  assert.ok(visible.has('busy-59'))
  assert.ok(!visible.has('busy-0'), 'older unread rows outside the digest are not downloaded')
  assert.equal(visible.size, 40)
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

// ── conversation header ──────────────────────────────────────────────────────
// A BYOA agent that sits in several project groups has to be able to tell them
// apart from the digest alone. The cloud turn has always rendered a project
// line; without it here, everything the agent knows reads as one context and
// work from one project gets quoted as background in another.

test('the header names the project the group belongs to', () => {
  const head = conversationHeader({
    conversation_id: 'c-1',
    conversation_kind: 'group',
    conversation_title: 'Paper review',
    project_name: 'Paper review',
    conversation_topic: 'ICML submission',
  })
  assert.match(head, /^# c-1 \[group\] "Paper review"/)
  assert.match(head, /\n {2}Project: Paper review/)
  assert.match(head, /\n {2}Topic: ICML submission/)
  // Project reads before topic: which project, then what this group is for.
  assert.ok(head.indexOf('Project:') < head.indexOf('Topic:'))
})

test('a project-less conversation is unchanged', () => {
  // Direct chats and ungrouped conversations are genuinely project-less; they
  // must render exactly as they did before.
  const head = conversationHeader({
    conversation_id: 'c-2',
    conversation_kind: 'dm',
    conversation_title: 'yetone',
    conversation_topic: null,
  })
  assert.equal(head, '# c-2 [dm] "yetone"')
})

test('a project with no topic still renders its project line', () => {
  const head = conversationHeader({ conversation_id: 'c-3', project_name: 'OpenRouter plan' })
  assert.equal(head, '# c-3\n  Project: OpenRouter plan')
})

test('an explicitly null project is treated as absent', () => {
  // loadInbox LEFT JOINs projects, so an unassigned conversation arrives as null
  // rather than undefined.
  const head = conversationHeader({ conversation_id: 'c-4', project_name: null, conversation_topic: 'ship it' })
  assert.equal(head, '# c-4\n  Topic: ship it')
})
