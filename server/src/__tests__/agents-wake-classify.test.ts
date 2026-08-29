/**
 * Which wakes survive an EMPTY chat inbox.
 *
 * Most wakes exist to answer unread messages, so an empty inbox means there is
 * nothing to do. The exceptions carry their own brief. The board case is why
 * this is pinned: assigning or @-mentioning an agent on a card wakes it as
 * `manual`, which was not exempt — so `runAgentTurn` returned before the agent
 * ever looked at the card, and the board sat in Todo while the work was
 * reported complete in chat (#69).
 *
 * Pure like turn-compaction's tests — no DB, no runtime client.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-wake-classify.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyWake, renderBriefedManualWakeContext } from '../agents/turn-wake.js'

const brief = { source: 'kanban', title: 'A board card was assigned to you', body: 'card id: card-1' }

test('an ordinary message wake with an empty inbox does not run', () => {
  assert.equal(classifyWake({ trigger: 'message.new' }, 0).survivesEmptyInbox, false)
})

test('a board wake carrying a card brief runs on an empty inbox', () => {
  const w = classifyWake({ trigger: 'manual', backgroundBrief: brief }, 0)
  assert.equal(w.briefedManual, true)
  assert.equal(w.survivesEmptyInbox, true)
})

test('a bare manual wake with no brief still does not run', () => {
  // The exemption is earned by carrying something to act on, not by the
  // trigger name — otherwise any manual poke would burn a big-brain turn on
  // nothing.
  const w = classifyWake({ trigger: 'manual' }, 0)
  assert.equal(w.briefedManual, false)
  assert.equal(w.survivesEmptyInbox, false)
})

test('a briefed manual wake is not misfiled as a background scan', () => {
  // It must stay `manual`: the synthetic-wake rate limiter and the cerebellum
  // gate both key off these flags, and a human assigning a card should pass
  // through both.
  const w = classifyWake({ trigger: 'manual', backgroundBrief: brief }, 0)
  assert.equal(w.backgroundScan, false)
  assert.equal(w.idle, false)
  assert.equal(w.pollUpdate, false)
})

test('idle only counts as an idle wake when the inbox is actually empty', () => {
  assert.equal(classifyWake({ trigger: 'idle' }, 0).idle, true)
  assert.equal(classifyWake({ trigger: 'idle' }, 3).idle, false)
})

test('background scan and poll wakes still need their briefs', () => {
  assert.equal(classifyWake({ trigger: 'background_scan' }, 0).survivesEmptyInbox, false)
  assert.equal(classifyWake({ trigger: 'poll.updated' }, 0).survivesEmptyInbox, false)
  assert.equal(
    classifyWake({ trigger: 'background_scan', backgroundBrief: brief }, 0).survivesEmptyInbox,
    true,
  )
})

test('a non-empty inbox runs regardless of how it was woken', () => {
  // The guard only fires on an empty inbox; classification must not change that.
  assert.equal(classifyWake({ trigger: 'message.new' }, 5).survivesEmptyInbox, false)
})

test('a coalesced manual brief keeps unread conversation context visible', () => {
  const context = renderBriefedManualWakeContext(
    brief,
    'Conversation direct-1\n  Pat: Please send the result',
    1,
  )
  assert.match(context, /card id: card-1/)
  assert.match(context, /Pat: Please send the result/)
  assert.doesNotMatch(context, /chat inbox is empty/i)
})

test('a brief-only manual wake explicitly acts without chat', () => {
  const context = renderBriefedManualWakeContext(brief, '', 0)
  assert.match(context, /chat inbox is empty/i)
  assert.match(context, /act on THAT/i)
})
