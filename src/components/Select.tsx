import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  /** Optional trailing text shown right-aligned and NOT truncated — for a
   *  secondary value (e.g. a per-row amount) that must stay visible even when
   *  the label is long. The label truncates; the hint is preserved. */
  hint?: string
  disabled?: boolean
}

interface SelectProps<T extends string = string> {
  value: T
  options: Array<SelectOption<T>>
  onValueChange: (value: T) => void
  id?: string
  ariaLabel?: string
  disabled?: boolean
  className?: string
}

function nextEnabledIndex<T extends string>(
  options: Array<SelectOption<T>>,
  current: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1
  for (let step = 1; step <= options.length; step += 1) {
    const idx = (current + step * direction + options.length) % options.length
    if (!options[idx].disabled) return idx
  }
  return -1
}

export function Select<T extends string = string>({
  value,
  options,
  onValueChange,
  id,
  ariaLabel,
  disabled = false,
  className,
}: SelectProps<T>) {
  const autoId = useId()
  const selectId = id ?? autoId
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [animateMenu, setAnimateMenu] = useState(false)
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const selected = options[selectedIndex]
  const [activeIndex, setActiveIndex] = useState(selectedIndex)

  useEffect(() => {
    if (!open) return
    setActiveIndex(selectedIndex)
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      setOpen(false)
      setAnimateMenu(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setAnimateMenu(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = (idx: number) => {
    const option = options[idx]
    if (!option || option.disabled) return
    setOpen(false)
    setAnimateMenu(false)
    onValueChange(option.value)
  }

  const openMenu = () => {
    if (disabled) return
    setActiveIndex(selectedIndex)
    setAnimateMenu(true)
    setOpen(true)
  }

  const onButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        openMenu()
        return
      }
      setActiveIndex((idx) => nextEnabledIndex(options, idx, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (!open) {
        setAnimateMenu(true)
        setOpen(true)
      }
      const start = event.key === 'Home' ? -1 : 0
      const direction = event.key === 'Home' ? 1 : -1
      setActiveIndex(nextEnabledIndex(options, start, direction))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open) commit(activeIndex)
      else openMenu()
    }
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        id={selectId}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${selectId}-menu`}
        aria-activedescendant={open && activeIndex >= 0 ? `${selectId}-option-${activeIndex}` : undefined}
        onClick={() => {
          if (disabled) return
          if (open) {
            setOpen(false)
            setAnimateMenu(false)
          } else {
            openMenu()
          }
        }}
        onKeyDown={onButtonKeyDown}
        className={cn(
          'group flex h-11 w-full items-center justify-between gap-3 rounded-[14px] border border-ink-100 bg-cloud px-3.5 text-left text-[13px] font-semibold text-ink-900 outline-none transition',
          'shadow-[0_1px_0_rgba(255,255,255,0.92)_inset,0_10px_24px_-24px_rgba(26,78,120,0.55)]',
          'hover:border-sky2-200 hover:bg-sky2-50/60',
          'focus:border-sky2-300 focus:bg-cloud focus:ring-4 focus:ring-sky2-100',
          open && 'border-sky2-300 bg-cloud ring-4 ring-sky2-100',
          disabled && 'cursor-not-allowed opacity-55',
        )}
        style={{
          backgroundImage: 'var(--select-face)',
        }}
      >
        <span className="min-w-0 flex-1 truncate">{selected?.label ?? 'Select'}</span>
        {selected?.hint && (
          <span className="shrink-0 text-[12px] font-semibold tabular-nums text-ink-400">{selected.hint}</span>
        )}
        <span
          aria-hidden="true"
          className={cn(
            'grid h-7 w-7 shrink-0 place-items-center rounded-[9px] border border-sky2-100 bg-sky2-50 text-skype-deep transition',
            'group-hover:bg-cloud group-focus:bg-sky2-50',
            open && 'rotate-180 border-sky2-200 bg-sky2-50',
          )}
        >
          <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none">
            <path d="M3.5 5.5 7 9l3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      <div
        id={`${selectId}-menu`}
        role="listbox"
        aria-labelledby={selectId}
        aria-hidden={!open}
        onAnimationEnd={() => setAnimateMenu(false)}
        className={cn(
          'absolute left-0 right-0 top-full z-[70] mt-2 max-h-72 overflow-auto rounded-[16px] border border-sky2-100 bg-cloud p-2.5 shadow-[0_22px_55px_-24px_rgba(10,30,60,0.38),0_8px_18px_-12px_rgba(10,30,60,0.2),0_0_0_1px_rgba(255,255,255,0.72)_inset]',
          'origin-top transition-[opacity,transform,visibility] duration-150 ease-out',
          open ? 'visible translate-y-0 scale-100 opacity-100' : 'invisible pointer-events-none -translate-y-1 scale-[0.985] opacity-0',
          animateMenu && 'animate-rise',
        )}
      >
        {options.map((option, idx) => {
          const selectedOption = option.value === value
          const active = idx === activeIndex
          return (
            <button
              key={option.value}
              id={`${selectId}-option-${idx}`}
              type="button"
              role="option"
              aria-selected={selectedOption}
              disabled={option.disabled}
              tabIndex={open ? 0 : -1}
              onMouseEnter={() => setActiveIndex(idx)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(idx)}
              className={cn(
                'flex h-8 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-45',
                selectedOption
                  ? 'bg-skype text-white shadow-[0_10px_22px_-16px_rgba(0,120,200,0.82)]'
                  : active
                    ? 'bg-sky2-50 text-skype-deep'
                    : 'text-ink-700 hover:bg-sky2-50 hover:text-skype-deep',
              )}
            >
              <span className="grid h-4 w-4 shrink-0 place-items-center">
                {selectedOption && (
                  <svg viewBox="0 0 12 10" className="h-3 w-3" fill="none">
                    <path d="M1.5 5.1 4.4 8 10.5 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.hint && (
                <span className={cn(
                  'shrink-0 pl-2 text-[11.5px] tabular-nums',
                  selectedOption ? 'text-white/80' : 'text-ink-400',
                )}>{option.hint}</span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
