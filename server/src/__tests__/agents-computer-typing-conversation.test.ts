/**
 * A BYOA agent that is working must not look dead.
 *
 * "<agent> is typing…" is the only feedback a human gets between sending a
 * message and receiving a reply, and a BYOA turn can run for minutes. The
 * indicator is gated on the turn having a conversation id — and a wake often
 * carries none:
 *
 *   - a POLL-driven turn never has one (only an SSE wake sets lastWakeConvo), and
 *     polling is the ONLY path left whenever the wake-stream is down;
 *   - a wake arriving mid-turn is coalesced through scheduleWake's busy branch,
 *     which re-kicks the turn without a conversation.
 *
 * Both are precisely when someone IS waiting. Observed: an agent mentioned in a
 * group ran a 3-minute turn — engine spawned, `turn DONE … exit 0`, reply posted
 * — while the room showed no indicator at all for the entire turn, which reads as
 * "it never started".
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-typing-conversation.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { typingConversation } from '../agents/computer/daemon.js'

/** `seen` as snapshotUnread builds it: conversation_id → newest unread msg id. */
const unread = (...ids: string[]): Map<string, string> =>
  new Map(ids.map((id, i) => [id, `m-${i}`]))

test("the wake's own conversation always wins", () => {
  // An SSE wake named the room — that is the most precise signal available and
  // must not be second-guessed by the inbox.
  assert.equal(typingConversation('g-abc', unread('g-abc')), 'g-abc')
  assert.equal(typingConversation('g-abc', unread('g-other', 'g-third')), 'g-abc')
})

test('a poll-driven turn falls back to the single unread conversation', () => {
  // The regression: no wake conversation → previously null → no typing at all,
  // for the whole turn. This is the common case when the wake-stream is down.
  assert.equal(typingConversation(null, unread('g-6e361c41')), 'g-6e361c41')
})

test('a coalesced wake falls back the same way', () => {
  // scheduleWake's busy branch re-kicks without a conversation, so the rerun sees
  // wakeConvo = null even though a real @mention triggered it.
  assert.equal(typingConversation(null, unread('direct-linus-bcccd5')), 'direct-linus-bcccd5')
})

test('several unread conversations stay silent rather than guess', () => {
  // Lighting up an arbitrary room would be a WRONG indicator — worse than none,
  // and it would leak which other rooms the agent has unread mail in. The reply
  // still lands in the right place regardless.
  assert.equal(typingConversation(null, unread('g-one', 'g-two')), null)
  assert.equal(typingConversation(null, unread('g-one', 'g-two', 'g-three')), null)
})

test('an empty inbox produces no indicator', () => {
  // A catch-up turn with nothing unread must not flash typing anywhere — the
  // phantom-typing case the original code was guarding against.
  assert.equal(typingConversation(null, unread()), null)
})

test('an empty-string wake conversation is not treated as a name', () => {
  // Defensive: a malformed SSE payload must fall through to the inbox, not send a
  // typing ping for the conversation "".
  assert.equal(typingConversation('', unread('g-abc')), 'g-abc')
})
