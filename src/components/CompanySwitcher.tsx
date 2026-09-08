/**
 * CompanySwitcher — small dropdown in the title bar that shows the active
 * tenant and lets the user hop between companies they're a member of, plus
 * spin up a new one. Lives in TitleBar.tsx.
 *
 * The active company id is stored in the auth store and read by the API
 * client into the `x-company-id` header on every request, so switching here
 * routes all subsequent traffic to the new tenant.
 */
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { useT } from '@/lib/i18n'
import { useApp } from '@/stores/app'
import { useAuth } from '@/stores/auth'
import { InvitePeopleModal } from './InvitePeopleModal'
import { WorkspaceSettingsModal } from './WorkspaceSettingsModal'

export function CompanySwitcher() {
  const t = useT()
  const companies = useAuth((s) => s.companies)
  const activeId = useAuth((s) => s.activeCompanyId)
  const setActive = useAuth((s) => s.setActiveCompany)
  const addCompany = useAuth((s) => s.addCompany)
  const selectConversation = useApp((s) => s.selectConversation)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const popRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false); setCreating(false); setErr(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const active = companies.find((c) => c.id === activeId) ?? companies[0] ?? null

  const switchCompany = (id: string) => {
    if (id !== activeId) {
      selectConversation(null)
      setActive(id)
    }
    setOpen(false)
  }

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true); setErr(null)
    try {
      const created = await api.createCompany(name)
      selectConversation(null)
      addCompany({ id: created.id, name: created.name, slug: created.slug, role: created.role })
      setNewName(''); setCreating(false); setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] font-medium text-ink-700 hover:bg-cloud transition"
        style={{ border: '1px solid var(--ink-100)', background: 'var(--paper)' }}
      >
        <span
          className="w-4 h-4 rounded grid place-items-center text-[10px] font-bold text-white"
          style={{ background: 'var(--skype)' }}
        >
          {active ? active.name.charAt(0).toUpperCase() : '·'}
        </span>
        <span className="max-w-[140px] truncate">{active?.name ?? t('company.noWorkspace')}</span>
        <span className="text-ink-300 text-[10px] leading-none">▾</span>
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute top-full mt-1 right-0 min-w-[240px] rounded-[10px] py-1.5 z-50"
          style={{
            background: 'var(--paper)',
            border: '1px solid var(--ink-100)',
            boxShadow: '0 12px 32px -8px rgba(10, 30, 60, 0.18), 0 4px 8px -2px rgba(10, 30, 60, 0.08)',
          }}
        >
          <div className="px-3 py-1 text-[10.5px] uppercase tracking-wide text-ink-300 font-display">
            {t('company.switchWorkspace')}
          </div>
          {companies.map((c) => (
            <button
              type="button"
              key={c.id}
              onClick={() => switchCompany(c.id)}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-cloud transition"
            >
              <span
                className="w-5 h-5 rounded grid place-items-center text-[10px] font-bold text-white shrink-0"
                style={{ background: 'var(--skype)' }}
              >
                {c.name.charAt(0).toUpperCase()}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] text-ink-900 truncate">{c.name}</span>
                <span className="block text-[10.5px] text-ink-300 italic font-display">{c.role}</span>
              </span>
              {c.id === activeId && <span className="text-skype-deep text-[12px]">●</span>}
            </button>
          ))}

          <div className="my-1 mx-2 h-px bg-ink-100" />

          {active && (active.role === 'owner' || active.role === 'admin') && (
            <>
              <button
                type="button"
                onClick={() => { setSettingsOpen(true); setOpen(false) }}
                className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-cloud transition text-[12px] text-ink-700"
              >
                <span className="w-5 h-5 rounded grid place-items-center shrink-0 text-[11px]" style={{ background: 'var(--sky-50)', color: 'var(--skype)' }}>⚙</span>
                <span className="flex-1">{t('company.workspaceSettings')}</span>
              </button>
              <button
                type="button"
                onClick={() => { setInviteOpen(true); setOpen(false) }}
                className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-cloud transition text-[12px] text-ink-700"
              >
                <span
                  className="w-5 h-5 rounded grid place-items-center shrink-0 text-[11px]"
                  style={{ background: 'var(--sky-50)', color: 'var(--skype)' }}
                >+</span>
                <span className="flex-1">{t('company.invitePeoplePrefix')}<b className="font-semibold">{active.name}</b></span>
              </button>
            </>
          )}

          {creating ? (
            <div className="px-3 py-2 space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitNew() }}
                placeholder={t('company.workspaceNamePh')}
                className="w-full px-2 py-1.5 text-[12.5px] rounded outline-none"
                style={{ border: '1.5px solid var(--ink-100)', background: 'var(--paper)' }}
              />
              {err && <div className="text-[11px] text-coral-deep">{err}</div>}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void submitNew()}
                  disabled={!newName.trim() || busy}
                  className="flex-1 py-1.5 rounded text-[12px] font-semibold text-white disabled:opacity-50"
                  style={{ background: 'var(--skype)' }}
                >{busy ? '…' : t('company.createBtn')}</button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setNewName(''); setErr(null) }}
                  className="px-3 py-1.5 rounded text-[12px] text-ink-500 hover:bg-cloud"
                >{t('common.cancel')}</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-cloud transition text-[12px] text-ink-700"
            >
              <span className="w-5 h-5 rounded grid place-items-center text-ink-500 shrink-0" style={{ border: '1px dashed var(--ink-100)' }}>+</span>
              {t('company.createNew')}
            </button>
          )}
        </div>
      )}
      {inviteOpen && active && (
        <InvitePeopleModal
          companyId={active.id}
          companyName={active.name}
          actorRole={active.role}
          onClose={() => setInviteOpen(false)}
        />
      )}
      {settingsOpen && active && (
        <WorkspaceSettingsModal
          company={active}
          companyCount={companies.length}
          onInvite={() => { setSettingsOpen(false); setInviteOpen(true) }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
