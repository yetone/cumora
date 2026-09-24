import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatPickerDateTime, pickerCalendarDate } from '../src/lib/picker-calendar-date.ts'

test('date picker keeps four-digit years through local calendar construction and formatting', () => {
  for (const year of [1, 4, 99, 100, 999, 1000, 2026, 9999]) {
    const date = pickerCalendarDate(year, 0, 1)
    assert.equal(date.getFullYear(), year)
    assert.equal(formatPickerDateTime(date, 0, 0), `${String(year).padStart(4, '0')}-01-01T00:00`)
  }
  assert.equal(formatPickerDateTime(pickerCalendarDate(4, 1, 29), 12, 5), '0004-02-29T12:05')
  assert.equal(formatPickerDateTime(pickerCalendarDate(100, -1, 31), 0, 0), '0099-12-31T00:00')
})
