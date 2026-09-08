/**
 * Recurrence math for calendar events.
 *
 * The old implementation stepped forward from the PREVIOUS occurrence. That is
 * fine until a step lands on a date that does not exist — `setUTCMonth` turns
 * "Jan 31 plus a month" into March 3 — because the overflowed value was then
 * fed back in as the next seed. So the error did not skip one occurrence, it
 * moved the entire series permanently: "monthly on the 31st" silently became
 * "the 3rd of every month, starting in March", and "yearly on Feb 29" became
 * Mar 1 forever, never returning at the next leap year.
 *
 * Every occurrence is now computed from the seed by index, which cannot drift.
 *
 * Run: node --import tsx --test server/src/__tests__/calendar-recurrence.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextOccurrenceOnOrAfter, type RecurrenceRule } from '../recurrence.js'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** The first `n` occurrences, walked the way the dispatcher walks them: ask for
 *  the next slot at or after just past the previous one. */
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

// ── the month-end case that used to corrupt the whole series ────────────────

test('monthly on the 31st clamps into short months and comes back', () => {
  // Was: Jan 31 → Mar 3 → Apr 3 → May 3 … February skipped and the
  // day-of-month permanently changed.
  assert.deepEqual(
    series('2026-01-31T09:00:00Z', { freq: 'monthly', interval: 1 }, 7),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31'],
  )
})

test('monthly on the 30th clamps only where it must', () => {
  assert.deepEqual(
    series('2026-01-30T09:00:00Z', { freq: 'monthly', interval: 1 }, 4),
    ['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30'],
  )
})

test('February clamping follows the leap year, not a fixed 28', () => {
  // 2028 is a leap year; the same rule must reach the 29th there.
  assert.deepEqual(
    series('2027-12-31T09:00:00Z', { freq: 'monthly', interval: 2 }, 4),
    ['2027-12-31', '2028-02-29', '2028-04-30', '2028-06-30'],
  )
})

test('yearly on Feb 29 returns at the next leap year', () => {
  // Was: Mar 1 from 2029 onward, forever — the date the user picked was gone.
  assert.deepEqual(
    series('2028-02-29T09:00:00Z', { freq: 'yearly', interval: 1 }, 6),
    ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29', '2033-02-28'],
  )
})

test('a mid-month monthly series is untouched', () => {
  // The common case has to be exactly as before; nothing here is clamped.
  assert.deepEqual(
    series('2026-01-15T09:00:00Z', { freq: 'monthly', interval: 1 }, 4),
    ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15'],
  )
})

// ── weekly ─────────────────────────────────────────────────────────────────

test('every-2-weeks on Mon and Wed keeps both days in the same week', () => {
  // Was: Mon → Wed of the NEXT week → Mon of the week after, a 9/12/9 day
  // pattern that is neither "every two weeks" nor "Mon and Wed".
  assert.deepEqual(
    weekdays('2026-01-05T09:00:00Z', { freq: 'weekly', interval: 2, byweekday: [1, 3] }, 6),
    [
      '2026-01-05 Mon', '2026-01-07 Wed',
      '2026-01-19 Mon', '2026-01-21 Wed',
      '2026-02-02 Mon', '2026-02-04 Wed',
    ],
  )
})

test('weekly on Mon and Wed is unchanged', () => {
  assert.deepEqual(
    weekdays('2026-01-05T09:00:00Z', { freq: 'weekly', interval: 1, byweekday: [1, 3] }, 5),
    ['2026-01-05 Mon', '2026-01-07 Wed', '2026-01-12 Mon', '2026-01-14 Wed', '2026-01-19 Mon'],
  )
})

test('the seed week only offers days at or after the seed', () => {
  // Seeded on a Wednesday with Mon+Wed selected: the Monday before the seed is
  // in the past and must not be back-filled.
  assert.deepEqual(
    weekdays('2026-01-07T09:00:00Z', { freq: 'weekly', interval: 1, byweekday: [1, 3] }, 4),
    ['2026-01-07 Wed', '2026-01-12 Mon', '2026-01-14 Wed', '2026-01-19 Mon'],
  )
})

test('weekly with no byweekday follows the seed weekday', () => {
  assert.deepEqual(
    weekdays('2026-01-05T09:00:00Z', { freq: 'weekly', interval: 2 }, 3),
    ['2026-01-05 Mon', '2026-01-19 Mon', '2026-02-02 Mon'],
  )
})

test('a duplicated or unsorted byweekday is normalised, not obeyed literally', () => {
  // The rule comes from JSON, so it can arrive in any order and with repeats.
  assert.deepEqual(
    weekdays('2026-01-05T09:00:00Z', { freq: 'weekly', interval: 1, byweekday: [3, 1, 3] }, 4),
    ['2026-01-05 Mon', '2026-01-07 Wed', '2026-01-12 Mon', '2026-01-14 Wed'],
  )
})

test('an empty byweekday falls back to the seed weekday instead of hanging', () => {
  // The old loop guarded against this with an iteration cap; the rule should
  // simply behave as a plain weekly.
  assert.deepEqual(
    weekdays('2026-01-05T09:00:00Z', { freq: 'weekly', interval: 1, byweekday: [] }, 3),
    ['2026-01-05 Mon', '2026-01-12 Mon', '2026-01-19 Mon'],
  )
})

// ── daily, and the series terminators ──────────────────────────────────────

test('daily with an interval is unchanged', () => {
  assert.deepEqual(
    series('2026-01-05T09:00:00Z', { freq: 'daily', interval: 3 }, 4),
    ['2026-01-05', '2026-01-08', '2026-01-11', '2026-01-14'],
  )
})

test('count includes the seed', () => {
  // The seed is occurrence #1, so count:3 yields three dates and stops.
  assert.deepEqual(
    series('2026-01-05T09:00:00Z', { freq: 'daily', interval: 1, count: 3 }, 10),
    ['2026-01-05', '2026-01-06', '2026-01-07'],
  )
})

test('until is inclusive', () => {
  assert.deepEqual(
    series('2026-01-05T09:00:00Z', { freq: 'daily', interval: 1, until: '2026-01-07T09:00:00Z' }, 10),
    ['2026-01-05', '2026-01-06', '2026-01-07'],
  )
})

test('until still terminates a clamped monthly series', () => {
  // The terminators are checked against the computed occurrence, so clamping
  // must not let a series run past its end.
  assert.deepEqual(
    series('2026-01-31T09:00:00Z', { freq: 'monthly', interval: 1, until: '2026-03-31T09:00:00Z' }, 10),
    ['2026-01-31', '2026-02-28', '2026-03-31'],
  )
})

test('a one-shot event fires once and never again', () => {
  const seed = new Date('2026-01-05T09:00:00Z')
  assert.deepEqual(nextOccurrenceOnOrAfter(seed, null, seed), seed)
  assert.equal(nextOccurrenceOnOrAfter(seed, null, new Date(seed.getTime() + 1)), null)
})

test('asking from far in the future skips ahead without drifting', () => {
  // The dispatcher asks for the next slot at or after "now", which may be many
  // occurrences in. Index-based lookup has to land on the same dates the walk
  // above produces — that equivalence is what stepping used to break.
  const next = nextOccurrenceOnOrAfter(
    new Date('2026-01-31T09:00:00Z'),
    { freq: 'monthly', interval: 1 },
    new Date('2026-06-15T00:00:00Z'),
  )
  assert.equal(next?.toISOString().slice(0, 10), '2026-06-30')
})
