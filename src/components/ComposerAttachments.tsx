import type { ComposerAttachment } from '@/lib/composerAttachments'
import { IClip } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'

function sizeLabel(size: number): string | null {
  if (!size) return null
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

export function ComposerAttachments({
  items,
  onRemove,
  onRetry,
  mobile = false,
}: {
  items: readonly ComposerAttachment[]
  onRemove: (id: string) => void
  onRetry: (id: string) => void
  mobile?: boolean
}) {
  const t = useT()
  if (items.length === 0) return null

  return (
    <div
      className={cn('mb-2 grid gap-1.5', mobile ? 'grid-cols-1' : 'grid-cols-2 max-w-[620px]')}
      role="list"
      aria-label={t('chat.attachments')}
    >
      {items.map((item) => {
        const url = item.attachment?.url
        return (
          <div
            key={item.id}
            role="listitem"
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5',
              item.state === 'error'
                ? 'border-coral-deep/30 bg-coral-soft/50'
                : 'border-sky2-100 bg-sky2-50',
            )}
          >
            {item.kind === 'img' && url ? (
              <img src={url} alt={item.name} className="h-10 w-10 shrink-0 rounded-md object-cover" />
            ) : (
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md"
                style={{ background: 'linear-gradient(135deg, #2A2A35, #1A1A22)' }}>
                <IClip className="h-4 w-4 text-white/85" strokeWidth={1.8} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-semibold text-ink-700" title={item.name}>{item.name}</div>
              <div className="truncate text-[10.5px] text-ink-500">
                {item.state === 'uploading'
                  ? t('chat.uploading')
                  : item.state === 'error'
                    ? item.error ?? t('chat.uploadFailed')
                    : [item.mime, sizeLabel(item.size)].filter(Boolean).join(' · ')}
              </div>
            </div>
            {item.state === 'error' && (
              <button
                type="button"
                onClick={() => onRetry(item.id)}
                className="shrink-0 rounded-md px-1.5 py-1 text-[10.5px] font-semibold text-coral-deep hover:bg-cloud transition"
              >{t('chat.retry')}</button>
            )}
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-500 hover:bg-cloud hover:text-ink-900 transition"
              aria-label={t('chat.removeAttachment')}
              title={t('chat.removeAttachment')}
            >×</button>
          </div>
        )
      })}
    </div>
  )
}
