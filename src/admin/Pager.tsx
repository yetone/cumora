/**
 * Numbered paginator for admin list pages (Users, Waitlist). Works in
 * offset terms (0-based). Renders first/last + a window around the current
 * page with ellipses, plus Prev/Next. Hidden when there's only one page.
 */
import { useT } from '@/lib/i18n'

export function Pager({ total, pageSize, offset, loading, onPage }: {
  total: number
  pageSize: number
  offset: number
  loading?: boolean
  /** called with the new offset to load */
  onPage: (offset: number) => void
}) {
  const t = useT()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  const current = Math.floor(offset / pageSize)
  const go = (p: number): void => {
    if (loading || p < 0 || p >= pages || p === current) return
    onPage(p * pageSize)
  }

  // Build the page list: first two, current ±1, last two — deduped, with
  // an ellipsis wherever there's a gap.
  const wanted = new Set<number>()
  for (const p of [0, 1, current - 1, current, current + 1, pages - 2, pages - 1]) {
    if (p >= 0 && p < pages) wanted.add(p)
  }
  const sorted = [...wanted].sort((a, b) => a - b)
  const cells: Array<number | 'gap'> = []
  let prev = -1
  for (const p of sorted) {
    if (p - prev > 1) cells.push('gap')
    cells.push(p)
    prev = p
  }

  return (
    <div className="admin-pager">
      <span>{t('adminPager.range', { from: offset + 1, to: Math.min(offset + pageSize, total), total })}</span>
      <div className="admin-pager-btns">
        <button type="button" className="btn-ghost" disabled={current === 0 || loading} onClick={() => go(current - 1)}>{t('adminPager.prev')}</button>
        {cells.map((c, i) => c === 'gap'
          ? <span key={`gap-${i}`} className="admin-pager-ellipsis">…</span>
          : (
            <button
              type="button"
              key={c}
              className={`admin-pager-num${c === current ? ' is-active' : ''}`}
              disabled={loading}
              aria-current={c === current ? 'page' : undefined}
              onClick={() => go(c)}
            >
              {c + 1}
            </button>
          ))}
        <button type="button" className="btn-ghost" disabled={current >= pages - 1 || loading} onClick={() => go(current + 1)}>{t('adminPager.next')}</button>
      </div>
    </div>
  )
}
