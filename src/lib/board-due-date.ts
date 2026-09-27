export type BoardDueStatus = 'none' | 'date' | 'today' | 'overdue' | 'unclassified'

/** The caller supplies a calendar day, so this never depends on server time. */
export function boardDueStatus(
  dueOn: string | null,
  columnKind: 'todo' | 'doing' | 'done' | null,
  asOf: string,
): BoardDueStatus {
  if (!dueOn) return 'none'
  if (columnKind === 'done') return 'date'
  if (dueOn < asOf) return columnKind === null ? 'unclassified' : 'overdue'
  if (columnKind === null) return 'date'
  if (dueOn === asOf) return 'today'
  return 'date'
}

export function localCalendarDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
