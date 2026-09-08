/**
 * Pure recurrence math for frontend calendar views.
 *
 * Mirrors the indexed recurrence calculations from server/src/recurrence.ts
 * so desktop and mobile calendar views display the exact same dates where the
 * backend dispatcher fires them.
 *
 * Every occurrence is computed FROM THE SEED by index rather than stepping
 * from the previous occurrence. Stepping caused unrepresentable dates
 * (e.g. Jan 31 + 1 month overflowing to March 3 in setUTCMonth) to permanently
 * displace all future occurrences.
 */
import type { RecurrenceRule } from '../types.js'

export type { RecurrenceRule }

/** Add N days to a Date without mutating the input. */
function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

/**
 * `seed` shifted by N months, with the day-of-month CLAMPED into the target
 * month rather than overflowing into the next one.
 *
 * `setUTCMonth` overflows: a Jan 31 date asked for February becomes March 3.
 * Anchoring on the seed and clamping keeps Jan 31 -> Feb 28 -> Mar 31.
 */
function addMonthsClamped(seed: Date, n: number): Date {
  const day = seed.getUTCDate()
  const target = new Date(Date.UTC(
    seed.getUTCFullYear(), seed.getUTCMonth() + n, 1,
    seed.getUTCHours(), seed.getUTCMinutes(), seed.getUTCSeconds(), seed.getUTCMilliseconds(),
  ))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target
}

/**
 * The weekdays a weekly rule fires on, or null when it should just use the
 * seed's own weekday. Sorted and de-duplicated so the ordering below is
 * stable regardless of how the caller wrote the rule.
 */
function weeklyDays(rule: RecurrenceRule): number[] | null {
  const raw = rule.byweekday
  if (!raw || raw.length === 0) return null
  const days = [...new Set(raw.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
  return days.length > 0 ? days : null
}

/**
 * The `index`-th occurrence of a rule, counted from the seed (index 0 IS the
 * seed). Every case is computed FROM THE SEED rather than from the previous
 * occurrence, keeping unrepresentable dates from permanently displacing the series.
 */
function occurrenceAt(seed: Date, rule: RecurrenceRule, index: number): Date {
  const interval = Math.max(1, Math.floor(rule.interval || 1))
  switch (rule.freq) {
    case 'daily':
      return addDays(seed, index * interval)
    case 'weekly': {
      const days = weeklyDays(rule)
      if (!days) return addDays(seed, index * interval * 7)
      const seedDow = seed.getUTCDay()
      const firstWeek = days.filter((d) => d >= seedDow)
      if (index < firstWeek.length) return addDays(seed, firstWeek[index] - seedDow)
      const rest = index - firstWeek.length
      const week = Math.floor(rest / days.length) + 1
      const dow = days[rest % days.length]
      const weekStart = addDays(seed, -seedDow)
      return addDays(weekStart, week * interval * 7 + dow)
    }
    case 'monthly':
      return addMonthsClamped(seed, index * interval)
    case 'yearly':
      return addMonthsClamped(seed, index * interval * 12)
    default:
      return seed
  }
}

/**
 * Compute the next firing time strictly >= `after`, walking forward from
 * the event's seed `startAt`. Returns null if:
 *   - the series has no recurrence and startAt < after (already fired)
 *   - rule.until is earlier than the next computed slot
 *   - rule.count is exhausted
 */
export function nextOccurrenceOnOrAfter(
  startAt: Date,
  recurrence: RecurrenceRule | null,
  after: Date,
): Date | null {
  if (!recurrence) {
    return startAt.getTime() >= after.getTime() ? startAt : null
  }
  const untilTs = recurrence.until ? new Date(recurrence.until).getTime() : Infinity
  const maxCount = recurrence.count ?? Infinity
  for (let index = 0; index < 5000; index++) {
    if (index + 1 > maxCount) return null
    const current = occurrenceAt(startAt, recurrence, index)
    if (current.getTime() > untilTs) return null
    if (current.getTime() >= after.getTime()) return current
  }
  return null
}
