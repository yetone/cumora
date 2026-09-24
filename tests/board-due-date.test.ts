import { test } from 'node:test'
import assert from 'node:assert/strict'
import { boardDueStatus, localCalendarDay } from '../src/lib/board-due-date.ts'

test('due dates compare calendar days and distinguish unknown from completed columns', () => {
  assert.equal(boardDueStatus(null, 'todo', '2026-09-23'), 'none')
  assert.equal(boardDueStatus('2026-09-22', 'todo', '2026-09-23'), 'overdue')
  assert.equal(boardDueStatus('2026-09-23', 'doing', '2026-09-23'), 'today')
  assert.equal(boardDueStatus('2026-09-24', 'todo', '2026-09-23'), 'date')
  assert.equal(boardDueStatus('2026-09-22', 'done', '2026-09-23'), 'date')
  assert.equal(boardDueStatus('2026-09-22', null, '2026-09-23'), 'unclassified')
  assert.equal(boardDueStatus('2026-09-23', null, '2026-09-23'), 'date')
})

test('local calendar day uses local date fields without UTC conversion', () => {
  assert.equal(localCalendarDay(new Date(2026, 8, 23, 0, 0)), '2026-09-23')
})
