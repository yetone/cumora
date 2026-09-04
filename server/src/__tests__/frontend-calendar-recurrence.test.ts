/**
 * Test frontend recurrence math against the exact month-end, leap year, and
 * bi-weekly test cases to ensure client calendar views stay in parity with the
 * backend dispatcher.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextOccurrenceOnOrAfter } from '../../../src/lib/recurrence.js'
import type { RecurrenceRule } from '../../../src/types.js'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function series(seedIso: string, rule: RecurrenceRule | null, n: number): string[] {
  const seed = new Date(seedIso)
  const out: string[] = []
  let after = seed
  for (let i = 0; i < n; i++) {
    const next = nextOccurrenceOnOrAfter(seed, rule, after)
    if (!next) break
    out.push(next.toISOString().slice(0, 10))
    after = new Date(next.getTime() + 1000)
  }
  return out
}

function weekdays(seedIso: string, rule: RecurrenceRule, n: number): string[] {
  return series(seedIso, rule, n).map((d) => `${d} ${DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]}`)
}

test('frontend recurrence: monthly on the 31st clamps into short months and comes back', () => {
  assert.deepEqual(
    series('2026-01-31T09:00:00Z', { freq: 'monthly', interval: 1 }, 7),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'],
  )
})

test('frontend recurrence: yearly on Feb 29 returns at the next leap year', () => {
  assert.deepEqual(
    series('2028-02-29T09:00:00Z', { freq: 'yearly', interval: 1 }, 6),
    ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29', '2033-02-28'],
  )
})

test('frontend recurrence: every-2-weeks on Mon and Wed keeps both days in the same week', () => {
  assert.deepEqual(
    weekdays('2026-01-05T09:00:00Z', { freq: 'weekly', interval: 2, byweekday: [1, 3] }, 6),
    [
      '2026-01-05 Mon', '2026-01-07 Wed',
      '2026-01-19 Mon', '2026-01-21 Wed',
      '2026-02-02 Mon', '2026-02-04 Wed',
    ],
  )
})

test('frontend recurrence: non-recurring event fires once then terminates', () => {
  const seed = new Date('2026-04-14T09:00:00Z')
  assert.deepEqual(nextOccurrenceOnOrAfter(seed, null, seed), seed)
  assert.equal(nextOccurrenceOnOrAfter(seed, null, new Date(seed.getTime() + 1000)), null)
})

