import { useState } from 'react'
import { api } from '@/api/client'
import { useT } from '@/lib/i18n'
import { useAuth } from '@/stores/auth'
import { WindowDragStrip } from './WindowDragStrip'

export function NoWorkspaceScreen() {
  const t = useT()
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true); setError(null)
    try {
      await api.createCompany(trimmed)
      const session = await api.authMe()
      setMe(session.user, session.companies, session.activeCompanyId)
      setServerCapabilities(session.serverCapabilities)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 grid place-items-center bg-cloud px-5">
      <WindowDragStrip />
      <div className="w-full max-w-[420px] rounded-[18px] border border-ink-100 bg-paper px-7 py-8 text-center shadow-xl">
        <div className="mx-auto w-12 h-12 rounded-[13px] grid place-items-center bg-sky2-50 text-skype text-[22px] font-bold">+</div>
        <h1 className="mt-4 text-[19px] font-semibold text-ink-900">{t('workspace.emptyTitle')}</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">{t('workspace.emptyHelp')}</p>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
          placeholder={t('company.workspaceNamePh')}
          className="mt-5 w-full h-10 rounded-[9px] border border-ink-100 bg-paper px-3 text-[13px] outline-none focus:border-skype"
        />
        {error && <div className="mt-2 text-left text-[11.5px] text-coral-deep">{error}</div>}
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !name.trim()}
          className="mt-3 w-full h-10 rounded-[9px] bg-skype text-white text-[12.5px] font-semibold disabled:opacity-45"
        >{busy ? '…' : t('workspace.emptyCreate')}</button>
      </div>
    </div>
  )
}
