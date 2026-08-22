import { useEffect } from 'react'
import { useDocuments } from '@/stores/documents'
import { DocumentEditor } from '@/components/DocumentEditor'
import { useAuth } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { useT } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { IPlus } from '@/components/icons'

export function DocumentsView() {
  const t = useT()
  const list = useDocuments((s) => s.list)
  const loaded = useDocuments((s) => s.loaded)
  const selectedId = useDocuments((s) => s.selectedId)
  const select = useDocuments((s) => s.select)
  const load = useDocuments((s) => s.load)
  const create = useDocuments((s) => s.create)
  const byId = useParticipants((s) => s.byId)
  const me = useAuth((s) => s.user)

  useEffect(() => { void load() }, [load])

  // Auto-pick the most recently updated doc the first time the list loads.
  useEffect(() => {
    if (loaded && !selectedId && list.length > 0) {
      select(list[0].id)
    }
  }, [loaded, list, selectedId, select])

  const handleCreate = async () => {
    try {
      const d = await create({ title: t('docs.untitled') })
      select(d.id)
    } catch (e) {
      console.warn('[docs] create failed', e)
    }
  }

  return (
    <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: '280px 1fr' }}>
      <aside className="border-r border-ink-100 bg-white flex flex-col min-h-0">
        <header className="px-4 py-3 flex items-center justify-between border-b border-ink-100">
          <h2 className="font-display text-sm font-medium text-stone-800">{t('docs.title')}</h2>
          <button
            type="button"
            onClick={handleCreate}
            className="w-7 h-7 rounded-lg grid place-items-center text-skype-deep hover:bg-skype/10 transition-colors"
            title={t('docs.newDocument')}
            aria-label={t('docs.newDocument')}
          >
            <IPlus className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto py-2">
          {!loaded && (
            <div className="px-4 py-6 text-xs text-stone-400">{t('common.loading')}</div>
          )}
          {loaded && list.length === 0 && (
            <div className="px-4 py-6 text-xs text-stone-400">
              {t('docs.empty')}
            </div>
          )}
          {list.map((d) => {
            const author = byId[d.createdBy]
            const authorName = author?.name ?? (d.createdBy === me?.id ? t('common.you') : d.createdBy)
            const active = d.id === selectedId
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => select(d.id)}
                className={cn(
                  'w-full text-left px-4 py-2.5 transition-colors block',
                  active
                    ? 'bg-skype/10 text-skype-deep'
                    : 'hover:bg-stone-50 text-stone-700',
                )}
              >
                <div className="text-sm font-medium truncate">{d.title || t('docs.untitled')}</div>
                <div className="text-[11px] text-stone-400 mt-0.5">
                  {authorName} · {timeAgo(d.updatedAt, t)}
                </div>
              </button>
            )
          })}
        </div>
      </aside>
      <main className="min-h-0 overflow-hidden bg-white">
        {selectedId ? (
          <DocumentEditor documentId={selectedId} />
        ) : (
          <div className="h-full grid place-items-center text-stone-400 text-sm">
            {list.length === 0
              ? t('docs.emptyCta')
              : t('docs.pickFromList')}
          </div>
        )}
      </main>
    </div>
  )
}

function timeAgo(iso: string, t: ReturnType<typeof useT>): string {
  const then = new Date(iso).getTime()
  const ms = Date.now() - then
  if (ms < 60_000) return t('docs.justNow')
  if (ms < 3600_000) return t('docs.minutesAgo', { n: Math.floor(ms / 60_000) })
  if (ms < 86_400_000) return t('docs.hoursAgo', { n: Math.floor(ms / 3_600_000) })
  return new Date(iso).toLocaleDateString()
}
