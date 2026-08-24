import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * Searchable single-select combobox — a text input that filters a dropdown as
 * you type. Use this (not <Select>) when the option list is long enough that
 * scrolling is painful (e.g. hundreds of tenants).
 *
 * Styling mirrors the app's <Select> (and the inline assignee picker in
 * BoardsView this was generalized from) so the two read as the same family.
 *
 * Each option has a `label` (the searchable text, truncates if long) and an
 * optional right-aligned `hint` (a secondary value — e.g. a per-row amount —
 * that stays visible and never truncates).
 */
export interface ComboboxOption<T extends string = string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

interface ComboboxProps<T extends string = string> {
  value: T
  options: Array<ComboboxOption<T>>
  onValueChange: (value: T) => void
  placeholder?: string
  /** Shown in the search box once the menu is open. */
  searchPlaceholder?: string
  ariaLabel?: string
  className?: string
  emptyText?: string
}

export function Combobox<T extends string = string>({
  value,
  options,
  onValueChange,
  placeholder: placeholderProp,
  searchPlaceholder: searchPlaceholderProp,
  ariaLabel,
  className,
  emptyText: emptyTextProp,
}: ComboboxProps<T>) {
  const t = useT()
  // Defaults resolve through t() so they follow the active locale;
  // callers that pass explicit strings are untouched.
  const placeholder = placeholderProp ?? t('combobox.select')
  const searchPlaceholder = searchPlaceholderProp ?? t('combobox.search')
  const emptyText = emptyTextProp ?? t('combobox.noMatches')
  const id = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const selected = options.find((o) => o.value === value) ?? null

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((o) =>
      o.label.toLowerCase().includes(needle) || (o.hint?.toLowerCase().includes(needle) ?? false),
    )
  }, [options, query])

  // Keep the highlight on the current value when the menu (re)opens, else top.
  useEffect(() => {
    if (!open) return
    const idx = filtered.findIndex((o) => o.value === value)
    setActiveIndex(idx >= 0 ? idx : 0)
  }, [open, filtered, value])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (t && rootRef.current?.contains(t)) return
      setOpen(false); setQuery('')
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open])

  const openMenu = () => { setOpen(true); setQuery(''); queueMicrotask(() => inputRef.current?.focus()) }
  const commit = (o: ComboboxOption<T> | undefined) => {
    if (!o || o.disabled) return
    onValueChange(o.value)
    setOpen(false); setQuery(''); inputRef.current?.blur()
  }

  // Closed: show the selected label (or placeholder). Open: show the live query.
  const displayValue = open ? query : (selected?.label ?? placeholder)

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div
        className={cn(
          'group relative flex h-11 w-full items-center rounded-[14px] border border-ink-100 bg-cloud text-left text-[13px] font-semibold text-ink-900 outline-none transition',
          'shadow-[0_1px_0_rgba(255,255,255,0.92)_inset,0_10px_24px_-24px_rgba(26,78,120,0.55)]',
          'hover:border-sky2-200 hover:bg-sky2-50/60',
          open && 'border-sky2-300 bg-cloud ring-4 ring-sky2-100',
        )}
        style={{ backgroundImage: 'var(--select-face)' }}
      >
        <input
          ref={inputRef}
          id={id}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-activedescendant={open && filtered[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
          value={displayValue}
          placeholder={open ? searchPlaceholder : placeholder}
          onFocus={openMenu}
          onMouseDown={() => { if (!open) openMenu() }}
          onChange={(e) => { if (!open) setOpen(true); setQuery(e.target.value) }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) { openMenu(); return } setActiveIndex((i) => Math.min(filtered.length - 1, i + 1)); return }
            if (e.key === 'ArrowUp')   { e.preventDefault(); if (!open) { openMenu(); return } setActiveIndex((i) => Math.max(0, i - 1)); return }
            if (e.key === 'Enter')     { e.preventDefault(); commit(filtered[activeIndex]); return }
            if (e.key === 'Escape')    { e.preventDefault(); setOpen(false); setQuery('') }
          }}
          className="h-full min-w-0 flex-1 rounded-[14px] bg-transparent px-3.5 pr-10 text-[13px] font-semibold text-ink-900 outline-none placeholder:text-ink-300"
        />
        {/* Selected hint (e.g. amount) shown when closed so the trigger carries
            the secondary value too. */}
        {!open && selected?.hint && (
          <span className="pointer-events-none absolute right-11 text-[12px] font-semibold tabular-nums text-ink-400">{selected.hint}</span>
        )}
        <button
          type="button"
          aria-label={t('combobox.toggleMenu')}
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { if (open) { setOpen(false); setQuery('') } else openMenu() }}
          className={cn(
            'absolute right-2 grid h-7 w-7 place-items-center rounded-[9px] border border-sky2-100 bg-sky2-50 text-skype-deep transition',
            'group-hover:bg-cloud',
            open && 'border-sky2-200 bg-sky2-50',
          )}
        >
          <svg viewBox="0 0 14 14" className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} fill="none">
            <path d="M3.5 5.5 7 9l3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          id={`${id}-listbox`}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 right-0 top-full z-[70] mt-2 max-h-72 overflow-auto rounded-[16px] border border-sky2-100 bg-cloud p-2.5 shadow-[0_22px_55px_-24px_rgba(10,30,60,0.38),0_8px_18px_-12px_rgba(10,30,60,0.2),0_0_0_1px_rgba(255,255,255,0.72)_inset] animate-rise"
        >
          {filtered.map((option, idx) => {
            const active = idx === activeIndex
            const selectedOption = option.value === value
            return (
              <button
                key={option.value}
                id={`${id}-option-${idx}`}
                type="button"
                role="option"
                aria-selected={selectedOption}
                disabled={option.disabled}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => commit(option)}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45',
                  selectedOption
                    ? 'bg-skype text-white shadow-[0_10px_22px_-16px_rgba(0,120,200,0.82)]'
                    : active
                      ? 'bg-sky2-50 text-skype-deep'
                      : 'text-ink-700 hover:bg-sky2-50 hover:text-skype-deep',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint && (
                  <span className={cn('shrink-0 pl-3 text-[11.5px] tabular-nums', selectedOption ? 'text-white/80' : 'text-ink-400')}>{option.hint}</span>
                )}
              </button>
            )
          })}
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[12.5px] font-semibold text-ink-400">{emptyText}</div>
          )}
        </div>
      )}
    </div>
  )
}
