/**
 * A BYOA turn must release every "thinking" claim it took, and forget the
 * per-turn HELD count for every conversation it touched.
 *
 * The bug: `/thinking/mark` is called with the whole unread snapshot
 * (`[...seen.keys()]`), but `/thinking/unmark` was called with `[convo]` — the
 * single room chosen for the "<agent> is typing…" indicator. When a wake spans
 * several conversations, every room except the indicator's one kept its claim
 * until the 60s TTL, and its HELD counter until its 1800s TTL.
 *
 * The claim TTL expiring is cosmetic. The HELD counter surviving is not: it
 * means an agent held twice in room X, whose turn ended while the indicator was
 * in room Y, wakes into a fresh turn that escalates on its very FIRST hold
 * ("this is HELD #3 in this turn") for a turn that has held once.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-turn-thinking-convos.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnThinkingConvos } from '../agents/computer/daemon.js'

/** `seen` as snapshotUnread builds it: conversation_id → newest unread msg id. */
const unread = (...ids: string[]): Map<string, string> =>
  new Map(ids.map((id, i) => [id, `m-${i}`]))

test('every conversation the turn snapshotted is claimed and released', () => {
  const seen = unread('g-alpha', 'g-beta', 'g-gamma')
  const ids = turnThinkingConvos('g-alpha', seen)
  assert.deepEqual(ids.sort(), ['g-alpha', 'g-beta', 'g-gamma'],
    'a claim taken on a conversation must be released on that same conversation')
})

test('the indicator room is included even when it is not the only unread', () => {
  const ids = turnThinkingConvos('g-alpha', unread('g-alpha', 'g-beta'))
  assert.ok(ids.includes('g-alpha'), 'the room showing "typing…" is composing too')
})

test('a turn with no unread falls back to the indicator room', () => {
  assert.deepEqual(turnThinkingConvos('g-solo', unread()), ['g-solo'])
})

test('a turn with neither unread nor an indicator room releases nothing', () => {
  assert.deepEqual(turnThinkingConvos(null, unread()), [])
})

test('no duplicates when the indicator room is also unread', () => {
  const ids = turnThinkingConvos('g-alpha', unread('g-alpha'))
  assert.deepEqual(ids, ['g-alpha'])
})
