/**
 * Shared wake payload contract for managed Pods and BYOA daemons.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-wake-options.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildKanbanWakeBrief } from '../agents/kanban-wake.js'
import {
  mergeWakeBackgroundBriefs,
  mergeWakeTurnOptions,
  parseWakeData,
  wakeHasActionableInput,
} from '../agents/runtime/wake-options.js'

test('manual Kanban wake preserves its brief and transport metadata', () => {
  const parsed = parseWakeData(JSON.stringify({
    kind: 'wake',
    reason: 'manual',
    conversationId: null,
    at: 1234,
    backgroundBrief: {
      source: 'kanban',
      title: 'A board card was assigned to you',
      body: 'card id: card-1',
    },
  }))

  assert.equal(parsed.conversationId, null)
  assert.equal(parsed.at, 1234)
  assert.equal(parsed.options.trigger, 'manual')
  assert.deepEqual(parsed.options.backgroundBrief, {
    source: 'kanban',
    title: 'A board card was assigned to you',
    body: 'card id: card-1',
  })
})

test('a manual brief is actionable without any unread chat message', () => {
  const brief = {
    source: 'kanban',
    title: 'A board card was assigned to you',
    body: 'card id: card-1',
  }
  assert.equal(wakeHasActionableInput(false, brief), true)
  assert.equal(wakeHasActionableInput(false, null), false)
  assert.equal(wakeHasActionableInput(true, null), true)
})

test('coalesced manual wakes retain every assigned card', () => {
  const first = {
    source: 'kanban',
    title: 'A board card was assigned to you',
    body: 'card id: card-1',
  }
  const second = {
    source: 'kanban',
    title: 'You were mentioned in a board card comment',
    body: 'card id: card-2',
  }
  const merged = mergeWakeBackgroundBriefs(first, second)
  assert.ok(merged)
  assert.equal(merged.source, 'kanban')
  assert.match(merged.body, /card-1/)
  assert.match(merged.body, /card-2/)
})

test('a manual card wake outranks message metadata in either coalescing order', () => {
  const manual = {
    trigger: 'manual' as const,
    backgroundBrief: {
      source: 'kanban',
      title: 'A board card was assigned to you',
      body: 'card id: card-1',
    },
  }
  const message = { trigger: 'message.new' as const, triageNote: 'new direct message' }
  for (const merged of [
    mergeWakeTurnOptions(message, manual),
    mergeWakeTurnOptions(manual, message),
  ]) {
    assert.equal(merged?.trigger, 'manual')
    assert.equal(merged?.backgroundBrief?.body, 'card id: card-1')
    assert.equal(merged?.triageNote, 'new direct message')
  }
})

test('shared Kanban brief names the card and actionable CLI commands', () => {
  const brief = buildKanbanWakeBrief({
    boardId: 'board-1',
    cardId: 'card-1',
    columnId: 'todo',
    title: 'Ship the migration',
    what: 'A board card was assigned to you',
  })

  assert.equal(brief.source, 'kanban')
  assert.match(brief.body, /Ship the migration/)
  assert.match(brief.body, /card id: card-1/)
  assert.match(brief.body, /board id: board-1/)
  assert.match(brief.body, /column id: todo/)
  assert.match(brief.body, /cumora card claim card-1/)
  assert.match(brief.body, /cumora card comment card-1/)
  assert.match(brief.body, /cumora card move card-1/)
})

test('malformed or oversized wake payloads cannot manufacture work', () => {
  assert.deepEqual(parseWakeData('{broken'), {
    conversationId: null,
    at: null,
    options: {},
  })
  assert.deepEqual(parseWakeData('x'.repeat(16_385)), {
    conversationId: null,
    at: null,
    options: {},
  })
  const missingBody = parseWakeData(JSON.stringify({
    reason: 'manual',
    backgroundBrief: { title: 'not enough' },
  }))
  assert.equal(missingBody.options.trigger, 'manual')
  assert.equal(missingBody.options.backgroundBrief, undefined)

  const emptyBrief = parseWakeData(JSON.stringify({
    reason: 'manual',
    backgroundBrief: { title: '   ', body: '\n\t' },
  }))
  assert.equal(emptyBrief.options.backgroundBrief, undefined)
  assert.equal(wakeHasActionableInput(false, { title: '', body: '' }), false)
})
