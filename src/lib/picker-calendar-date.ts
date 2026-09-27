/** Construct a local calendar day without Date's 1900 offset for years 00–99. */
export function pickerCalendarDate(year: number, monthIndex: number, day = 1): Date {
  const date = new Date(2000, 0, 1, 12)
  date.setFullYear(year, monthIndex, day)
  return date
}

export function formatPickerDateTime(date: Date, hour: number, minute: number): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}T${pad(hour, 2)}:${pad(minute, 2)}`
}
