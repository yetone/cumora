import { useEffect, useRef, useState } from 'react'
import { api, type ApiProject } from '@/api/client'
import { useT } from '@/lib/i18n'

export function DeleteProjectDialog({ project, onClose, onDeleted }: {
  project: ApiProject; onClose(): void; onDeleted(): void
}) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { dialog.current?.showModal() }, [])

  const remove = async () => {
    if (busy || confirmation !== project.name) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteProject(project.id, confirmation)
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="project-delete-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}
      className="w-[calc(100%_-_2rem)] max-w-[480px] rounded-[16px] border border-ink-100 bg-paper p-5 text-ink-900 shadow-2xl backdrop:bg-ink-900/35">
      <form onSubmit={(event) => { event.preventDefault(); void remove() }}>
        <h2 id="project-delete-title" className="text-[17px] font-semibold text-coral-deep">{t('me.deleteProjectTitle')}</h2>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-500">{t('me.deleteProjectConfirm', { name: project.name })}</p>
        <label className="mt-4 block text-[12px] font-semibold">
          {t('workspace.typeName', { name: project.name })}
          <input autoFocus autoComplete="off" value={confirmation} disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)}
            className="mt-2 h-9 w-full rounded-[8px] border border-ink-100 bg-paper px-3 outline-none focus:border-coral" />
        </label>
        {error && <p role="alert" className="mt-3 text-[12px] text-coral-deep">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={onClose}
            className="rounded-[8px] px-3 py-2 text-[12px] text-ink-500 disabled:opacity-50">{t('common.cancel')}</button>
          <button type="submit" disabled={busy || confirmation !== project.name}
            className="rounded-[8px] bg-coral-deep px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40">
            {busy ? t('me.deleteProjectBusy') : t('common.delete')}
          </button>
        </div>
      </form>
    </dialog>
  )
}
