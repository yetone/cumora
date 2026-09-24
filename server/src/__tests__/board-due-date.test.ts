import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBoardDueOn } from '../agents/board-due-date.js'

test('board due dates accept only real ISO calendar dates', () => {
  for (const value of ['2024-02-29', '2026-09-23', '0001-01-01', '0100-01-01', '0999-12-31', '9999-12-31']) {
    assert.equal(isBoardDueOn(value), true)
  }
  for (const value of [null, 42, '', '2026-02-29', '2026-04-31', '2026-13-01', '2026-9-23', '2026-09-23T00:00', '0000-01-01']) {
    assert.equal(isBoardDueOn(value), false, String(value))
  }
})
