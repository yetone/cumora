import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

/**
 * Inline poll composer. Floats above the chat input when the user types
 * `/poll` and submits via the normal Enter / Send affordance.
 *
 * Visually echoes the email composer drawer + invitation chips: cloud-bg
 * card with ink-100 border, sky2 accents on the focused option, coral on
 * destructive actions. Stays small — five fields max — so it doesn't feel
 * like a modal you have to "exit" before getting back to chat.
 */

interface Props {
  onSubmitted: () => void
  onCancel: () => void
  conversationId: string
}

const MIN_OPTIONS = 2
const MAX_OPTIONS = 10

type ExpireChoice = 'none' | '1h' | '6h' | '1d' | '3d'
const EXPIRE_LABELS: Record<ExpireChoice, string> = {
  none: '不限',
  '1h': '1 小时',
  '6h': '6 小时',
  '1d': '1 天',
  '3d': '3 天',
}
function expireToMinutes(c: ExpireChoice): number | null {
  switch (c) {
    case '1h': return 60
    case '6h': return 60 * 6
    case '1d': return 60 * 24
    case '3d': return 60 * 24 * 3
    default:   return null
  }
}

export function PollComposer({ onSubmitted, onCancel, conversationId }: Props) {
  const t = useT()
  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<'single' | 'multi'>('single')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [expire, setExpire] = useState<ExpireChoice>('1d')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const optionRefs = useRef<Array<HTMLInputElement | null>>([])
  const questionRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    questionRef.current?.focus()
  }, [])

  // Escape cancels; outside-click is not wired — the composer is small and
  // anchored above the chat input, accidental dismissal would be worse than
  // an explicit "cancel" affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const setOptionAt = (i: number, value: string) => {
    setOptions((prev) => {
      const next = prev.slice()
      next[i] = value
      return next
    })
  }

  const addOption = () => {
    setOptions((prev) => {
      if (prev.length >= MAX_OPTIONS) return prev
      return [...prev, '']
    })
    // Focus the new field on next paint.
    requestAnimationFrame(() => {
      const idx = optionRefs.current.length - 1
      optionRefs.current[idx]?.focus()
    })
  }

  const removeOption = (i: number) => {
    setOptions((prev) => {
      if (prev.length <= MIN_OPTIONS) return prev
      return prev.filter((_, j) => j !== i)
    })
  }

  const cleanedOptions = options.map((o) => o.trim()).filter(Boolean)
  const canSubmit = question.trim().length > 0 && cleanedOptions.length >= MIN_OPTIONS && !submitting

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await api.createPoll({
        conversationId,
        question: question.trim(),
        mode,
        options: cleanedOptions,
        expiresInMinutes: expireToMinutes(expire),
      })
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('poll.failedToCreate'))
      setSubmitting(false)
    }
  }

  const onOptionKey = (e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const last = i === options.length - 1
      if (last) {
        if (options[i].trim() && options.length < MAX_OPTIONS) addOption()
        else if (canSubmit) void submit()
      } else {
        optionRefs.current[i + 1]?.focus()
      }
    } else if (e.key === 'Backspace' && options[i] === '' && options.length > MIN_OPTIONS) {
      e.preventDefault()
      removeOption(i)
      requestAnimationFrame(() => optionRefs.current[Math.max(0, i - 1)]?.focus())
    }
  }

  return (
    <div
      className="mb-2 rounded-[14px] border border-ink-100 bg-cloud p-3 animate-rise"
      style={{ boxShadow: '0 18px 38px -22px rgba(10, 30, 60, 0.18), 0 2px 6px -2px rgba(10, 30, 60, 0.05)' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 mb-2 text-[11.5px] text-ink-500">
        <span aria-hidden className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-sky2-50 text-skype-deep">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="4" height="9" rx="1" />
            <rect x="10" y="6" width="4" height="14" rx="1" />
            <rect x="17" y="14" width="4" height="6" rx="1" />
          </svg>
        </span>
        <span className="font-semibold text-ink-700">{t('poll.title')}</span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto px-2 py-0.5 text-ink-500 rounded-full hover:bg-ink-50 transition"
          aria-label={t('poll.cancelAria')}
        >×</button>
      </div>

      <input
        ref={questionRef}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder={t('poll.questionPh')}
        maxLength={280}
        className="w-full px-2 py-2 text-[14px] font-semibold text-ink-900 placeholder-ink-300 bg-transparent border-b border-ink-50 focus:border-sky2-200 outline-none transition"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            optionRefs.current[0]?.focus()
          }
        }}
      />

      <div className="mt-2 flex flex-col gap-1">
        {options.map((opt, i) => (
          <div key={i} className="group flex items-center gap-2 px-2 py-1.5 rounded-[10px] hover:bg-sky2-50/40 transition">
            <span
              aria-hidden
              className={cn(
                'shrink-0 w-4 h-4 border border-ink-200',
                mode === 'single' ? 'rounded-full' : 'rounded-[4px]',
              )}
            />
            <input
              ref={(el) => { optionRefs.current[i] = el }}
              value={opt}
              onChange={(e) => setOptionAt(i, e.target.value)}
              onKeyDown={(e) => onOptionKey(e, i)}
              placeholder={`选项 ${i + 1}`}
              maxLength={120}
              className="flex-1 px-1 py-0.5 text-[13.5px] text-ink-800 placeholder-ink-300 bg-transparent outline-none"
            />
            {options.length > MIN_OPTIONS && (
              <button
                type="button"
                onClick={() => removeOption(i)}
                className="opacity-0 group-hover:opacity-100 transition w-5 h-5 rounded-full text-ink-400 hover:bg-ink-50 hover:text-coral-deep grid place-items-center"
                aria-label={t('poll.removeOptAria')}
              >×</button>
            )}
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={addOption}
            className="self-start ml-2 mt-0.5 text-[12px] text-skype-deep hover:underline tabular-nums"
          >
            + 添加选项
          </button>
        )}
      </div>

      {/* mode + expiration row */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-500">
        <div className="inline-flex rounded-full bg-ink-100/70 p-[3px] ring-1 ring-inset ring-ink-100">
          <button
            type="button"
            onClick={() => setMode('single')}
            className={cn(
              'px-3 py-0.5 rounded-full font-semibold transition',
              mode === 'single'
                ? 'bg-cloud text-ink-900 shadow-[0_1px_3px_rgba(15,23,42,0.10),0_0_0_1px_rgba(15,23,42,0.05)]'
                : 'text-ink-400 hover:text-ink-700',
            )}
          >单选</button>
          <button
            type="button"
            onClick={() => setMode('multi')}
            className={cn(
              'px-3 py-0.5 rounded-full font-semibold transition',
              mode === 'multi'
                ? 'bg-cloud text-ink-900 shadow-[0_1px_3px_rgba(15,23,42,0.10),0_0_0_1px_rgba(15,23,42,0.05)]'
                : 'text-ink-400 hover:text-ink-700',
            )}
          >多选</button>
        </div>

        <span className="text-ink-300">·</span>
        <span>过期</span>
        <div className="inline-flex flex-wrap gap-1">
          {(['none', '1h', '6h', '1d', '3d'] as ExpireChoice[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setExpire(c)}
              className={cn(
                'px-2 py-0.5 rounded-full font-semibold transition',
                expire === c
                  ? 'bg-sky2-100 text-skype-deep'
                  : 'bg-ink-50 text-ink-500 hover:bg-ink-100',
              )}
            >{EXPIRE_LABELS[c]}</button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {error && <span className="text-coral-deep">{error}</span>}
          <button
            type="button"
            onClick={onCancel}
            className="px-2.5 py-1 rounded-full text-ink-500 hover:bg-ink-50 transition"
          >取消</button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className={cn(
              'px-3 py-1 rounded-full font-semibold text-cloud transition',
              canSubmit ? 'bg-skype-deep hover:brightness-105' : 'bg-ink-200 cursor-not-allowed',
            )}
          >
            {submitting ? '发布中…' : '发起投票'}
          </button>
        </div>
      </div>
    </div>
  )
}
