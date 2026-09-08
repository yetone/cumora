/**
 * Which row a <Combobox> highlights when its menu opens or its filter changes.
 *
 * Pure and React-free so the rule can be pinned without rendering — the same
 * reason recurrence.ts and prompt-surface.ts are split out.
 *
 * The rule used to be "whatever row holds the current value, else the first",
 * which reads well until a row's `hint` collides with another row's `value`.
 * The BYOA model picker does exactly that: its first row is
 *
 *   { value: '', label: 'Follow engine default', hint: <the default model id> }
 *
 * and the filter matches on `hint` as well as `label`. So for an agent with no
 * pin (value === ''), typing the default model id in full left BOTH rows in the
 * list, the highlight stayed on the placeholder because it holds the current
 * value, and Enter committed '' — "follow engine default" — when the user had
 * just typed the id they wanted pinned. Pinning exists precisely so a model
 * upgrade in the underlying CLI cannot silently change an agent's behaviour, so
 * the failure is quiet and lands later.
 *
 * A query that names one option exactly now wins over the current value. With
 * no query, or with a partial one, nothing changes.
 */
export interface HighlightableOption {
  value: string
  label: string
}

export function initialActiveIndex(
  filtered: readonly HighlightableOption[],
  currentValue: string,
  query: string,
): number {
  const needle = query.trim().toLowerCase()
  if (needle) {
    const exact = filtered.findIndex(
      (option) => option.value.toLowerCase() === needle || option.label.toLowerCase() === needle,
    )
    if (exact >= 0) return exact
  }
  const current = filtered.findIndex((option) => option.value === currentValue)
  return current >= 0 ? current : 0
}
