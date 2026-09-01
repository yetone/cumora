/**
 * Recurrence math — the pure half of the calendar.
 *
 * `calendar.ts` describes itself as two halves: this math, and the dispatcher
 * that opens a database, Redis and an email transport. Split out so the math
 * can be tested without any of that — the same reason cli-parse.ts is separate
 * from cli.ts.
 *
 * Deliberately minimal: daily / weekly (with byweekday) / monthly / yearly,
 * plus interval, until and count. No EXDATEs, no BYMONTHDAY, no BYSETPOS.
 *
 * Every occurrence is computed FROM THE SEED by index. The previous version
 * stepped forward from the last occurrence, which is fine until a step lands on
 * a date that does not exist: `setUTCMonth` turns "Jan 31 plus a month" into
 * March 3, and that overflowed value then became the seed for the next step. So
 * one impossible date did not skip one occurrence — it moved the whole series
 * permanently. "Monthly on the 31st" became "the 3rd of every month, from
 * March"; "yearly on Feb 29" became Mar 1 and never came back at the next leap
 * year. An index cannot drift.
 */

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  /** 0=Sun … 6=Sat. Only honored when freq='weekly'. Empty/undefined = use
   *  the weekday of the seed start_at. */
  byweekday?: number[]
  /** Inclusive end of the series — no occurrences after this ISO timestamp. */
  until?: string | null
  /** Hard cap on total firings (including the seed). Once reached, the
   *  series is marked 'done'. */
  count?: number | null
}

/** Add N days to a Date without mutating the input. */
function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime())
  out.setUTCDate(out.getUTCDate() + n)
  return out
}

/** `seed` shifted by N months, with the day-of-month CLAMPED into the target
 *  month rather than overflowing into the next one.
 *
 *  `setUTCMonth` overflows: a Jan 31 date asked for February becomes March 3.
 *  That alone would only skip a month, but the old code then stepped from the
 *  overflowed value, so the drift was fed back in and the whole series moved
 *  permanently — "monthly on the 31st" became "the 3rd of every month, from
 *  March". Anchoring on the seed and clamping keeps Jan 31 → Feb 28 → Mar 31,
 *  which is also what a person scheduling month-end work means. */
function addMonthsClamped(seed: Date, n: number): Date {
  const day = seed.getUTCDate()
  // Build on day 1 so the month arithmetic cannot overflow, then clamp.
  const target = new Date(Date.UTC(
    seed.getUTCFullYear(), seed.getUTCMonth() + n, 1,
    seed.getUTCHours(), seed.getUTCMinutes(), seed.getUTCSeconds(), seed.getUTCMilliseconds(),
  ))
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target
}

/** The weekdays a weekly rule fires on, or null when it should just use the
 *  seed's own weekday. Sorted and de-duplicated so the ordering below is
 *  stable regardless of how the caller wrote the rule. */
function weeklyDays(rule: RecurrenceRule): number[] | null {
  const raw = rule.byweekday
  if (!raw || raw.length === 0) return null
  const days = [...new Set(raw.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
  return days.length > 0 ? days : null
}

/**
 * The `index`-th occurrence of a rule, counted from the seed (index 0 IS the
 * seed). Every case is computed FROM THE SEED rather than from the previous
 * occurrence, which is what keeps an unrepresentable date — Feb 31, Feb 29 in
 * a common year — from permanently displacing the whole series.
 */
function occurrenceAt(seed: Date, rule: RecurrenceRule, index: number): Date {
  const interval = Math.max(1, Math.floor(rule.interval || 1))
  switch (rule.freq) {
    case 'daily':
      return addDays(seed, index * interval)
    case 'weekly': {
      const days = weeklyDays(rule)
      if (!days) return addDays(seed, index * interval * 7)
      // Occurrences are grouped into ACTIVE weeks — the seed's week, then every
      // `interval`-th week after it — and within each one they run through the
      // allowed weekdays in order. The seed's own week only offers the days at
      // or after the seed itself, so a Wednesday seed never back-fills Monday.
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
      // Years through the same clamp so Feb 29 becomes Feb 28 in a common year
      // and returns to Feb 29 at the next leap year, instead of sliding to
      // Mar 1 and staying there.
      return addMonthsClamped(seed, index * interval * 12)
  }
}

/**
 * Compute the next firing time strictly >= `after`, walking forward from
 * the event's seed `start_at`. Returns null if:
 *   - the series has no recurrence and start_at < after (already fired)
 *   - rule.until is earlier than the next computed slot
 *   - rule.count is exhausted
 */
export function nextOccurrenceOnOrAfter(
  startAt: Date,
  recurrence: RecurrenceRule | null,
  after: Date,
): Date | null {
  // One-shot: the only possible slot is start_at itself.
  if (!recurrence) {
    return startAt.getTime() >= after.getTime() ? startAt : null
  }
  const untilTs = recurrence.until ? new Date(recurrence.until).getTime() : Infinity
  const maxCount = recurrence.count ?? Infinity
  // Walk the series by INDEX from the seed rather than stepping off the last
  // value. Stepping is what let one unrepresentable date (Feb 31) move every
  // later occurrence with it; an index cannot drift.
  // Cap iterations defensively so a misconfigured rule can't tie up the tick.
  for (let index = 0; index < 5000; index++) {
    if (index + 1 > maxCount) return null          // start_at counts as #1
    const current = occurrenceAt(startAt, recurrence, index)
    if (current.getTime() > untilTs) return null
    if (current.getTime() >= after.getTime()) return current
  }
  return null
}

