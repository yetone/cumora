import { useEffect } from 'react'
import { useApp } from '@/stores/app'
import { useDocuments } from '@/stores/documents'
import { DocumentEditor } from '@/components/DocumentEditor'
import { IDoc } from '@/components/icons'
import { useT } from '@/lib/i18n'

export function DocumentPeekPane() {
  const t = useT()
  const documentId = useApp((s) => s.openDocumentId)
  const closeDocumentPeek = useApp((s) => s.closeDocumentPeek)
  const setView = useApp((s) => s.setView)
  const list = useDocuments((s) => s.list)
  const loaded = useDocuments((s) => s.loaded)
  const load = useDocuments((s) => s.load)
  const selectDocument = useDocuments((s) => s.select)
  const doc = documentId ? list.find((d) => d.id === documentId) : null

  useEffect(() => {
    if (!loaded) void load()
  }, [load, loaded])

  if (!documentId) return null

  const openFullWorkspace = () => {
    selectDocument(documentId)
    closeDocumentPeek()
    setView('documents')
  }

  if (!loaded) {
    return (
      <aside className="min-w-0 h-full border-l border-ink-100 bg-cloud grid place-items-center">
        <div className="flex flex-col items-center gap-3 text-ink-400">
          <div className="w-12 h-12 rounded-[12px] grid place-items-center bg-sky2-50 text-skype-deep">
            <IDoc className="w-5 h-5" />
          </div>
          <div className="text-[12.5px] font-display italic">{t('peek.openingDoc')}</div>
        </div>
      </aside>
    )
  }

  if (!doc) {
    return (
      <aside className="min-w-0 h-full border-l border-ink-100 bg-cloud grid place-items-center px-8 text-center">
        <div className="max-w-[260px]">
          <div className="mx-auto w-12 h-12 rounded-[12px] grid place-items-center bg-coral-soft/45 text-coral-deep">
            <IDoc className="w-5 h-5" />
          </div>
          <div className="mt-3 text-[14px] font-semibold text-ink-900">{t('peek.documentUnavailable')}</div>
          <div className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            {t('peek.documentUnavailableDetail')}
          </div>
          <button
            type="button"
            onClick={closeDocumentPeek}
            className="mt-4 h-8 px-3 rounded-[8px] text-[12px] font-semibold text-ink-600 border border-ink-100 hover:bg-sky2-50 transition"
          >
            {t('peek.closeButton')}
          </button>
        </div>
      </aside>
    )
  }

  return (
    <aside className="min-w-0 h-full border-l border-ink-100 bg-cloud overflow-hidden">
      <DocumentEditor
        documentId={documentId}
        variant="peek"
        onClose={closeDocumentPeek}
        onOpenFull={openFullWorkspace}
      />
    </aside>
  )
}