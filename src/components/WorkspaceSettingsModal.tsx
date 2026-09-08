import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiWorkspaceMember, api, ws } from '@/api/client'
import { useT } from '@/lib/i18n'
import { type AuthCompany, useAuth } from '@/stores/auth'

interface Props {
  company: AuthCompany
  companyCount: number
  onInvite: () => void
  onClose: () => void
}

export function WorkspaceSettingsModal({ company, companyCount, onInvite, onClose }: Props) {
  const t = useT()
  const meId = useAuth((s) => s.user?.id)
  const removeCompany = useAuth((s) => s.removeCompany)
  const [members, setMembers] = useState<ApiWorkspaceMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const memberLoadGeneration = useRef(0)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !deleting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleting, onClose])

  const loadMembers = useCallback(async (showLoading: boolean) => {
    const generation = ++memberLoadGeneration.current
    if (showLoading) setLoading(true)
    setError(null)
    try {
      const rows = await api.listWorkspaceMembers(company.id)
      if (generation === memberLoadGeneration.current) setMembers(rows)
    } catch (reason) {
      if (generation === memberLoadGeneration.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (generation === memberLoadGeneration.current) setLoading(false)
    }
  }, [company.id])

  useEffect(() => {
    void loadMembers(true)
    return () => { memberLoadGeneration.current += 1 }
  }, [loadMembers])

  useEffect(() => ws.on((event) => {
    if (event.type !== 'workspace.membership' || event.companyId !== company.id) return
    void loadMembers(false)
  }), [company.id, loadMembers])

  const changeRole = async (member: ApiWorkspaceMember, role: 'member' | 'admin') => {
    if (member.role === role) return
    setBusyMemberId(member.id); setError(null)
    try {
      const result = await api.updateWorkspaceMemberRole(company.id, member.id, role)
      setMembers((current) => current.map((row) => row.id === member.id ? result.member : row))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyMemberId(null)
    }
  }

  const removeMember = async (member: ApiWorkspaceMember) => {
    if (!window.confirm(t('workspace.removeConfirm', { name: member.name }))) return
    setBusyMemberId(member.id); setError(null)
    try {
      await api.removeWorkspaceMember(company.id, member.id)
      setMembers((current) => current.filter((row) => row.id !== member.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusyMemberId(null)
    }
  }

  const deleteWorkspace = async () => {
    if (deleteConfirmation !== company.name || deleting || companyCount <= 1) return
    setDeleting(true); setDeleteError(null)
    try {
      const result = await api.deleteCompany(company.id, deleteConfirmation)
      if (removeCompany(company.id, result.nextCompanyId)) ws.reconnect()
      onClose()
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[120] grid place-items-center p-4" role="dialog" aria-modal="true" aria-label={t('workspace.settingsTitle')}>
      <button
        type="button"
        className="absolute inset-0 bg-ink-900/35"
        aria-label={t('common.close')}
        disabled={deleting}
        onClick={onClose}
      />
      <div className="relative w-full max-w-[620px] max-h-[86vh] overflow-y-auto rounded-[16px] bg-paper shadow-2xl border border-ink-100">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 px-5 py-4 bg-paper border-b border-ink-100">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold text-ink-900">{t('workspace.settingsTitle')}</h2>
            <div className="mt-0.5 text-[12px] text-ink-400 truncate">{company.name}</div>
          </div>
          <button
            type="button"
            disabled={deleting}
            onClick={onClose}
            className="w-8 h-8 rounded-full hover:bg-cloud text-ink-400 text-[20px] leading-none disabled:opacity-40"
          >×</button>
        </div>

        <section className="px-5 py-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-[13px] font-semibold text-ink-800">{t('workspace.membersTitle')}</h3>
              <p className="text-[11.5px] text-ink-400 mt-0.5">{t('workspace.membersHelp')}</p>
            </div>
            <button type="button" onClick={onInvite} className="px-3 py-1.5 rounded-[8px] text-[12px] font-semibold text-white bg-skype hover:opacity-90">
              {t('workspace.inviteBtn')}
            </button>
          </div>

          {error && <div className="mb-3 rounded-[8px] bg-coral-soft/40 px-3 py-2 text-[11.5px] text-coral-deep">{error}</div>}
          {loading ? (
            <div className="py-7 text-center text-[12px] italic font-display text-ink-300">{t('workspace.loadingMembers')}</div>
          ) : (
            <div className="rounded-[10px] border border-ink-100 divide-y divide-ink-100 overflow-hidden">
              {members.map((member) => {
                const canChangeRole = company.role === 'owner' && member.role !== 'owner'
                const canRemove = member.id !== meId && member.role !== 'owner'
                  && (company.role === 'owner' || (company.role === 'admin' && member.role === 'member'))
                const busy = busyMemberId === member.id
                return (
                  <div key={member.id} className="flex items-center gap-3 px-3 py-2.5 bg-paper">
                    <div className="w-9 h-9 rounded-full grid place-items-center shrink-0 text-[13px] font-semibold text-white overflow-hidden bg-skype">
                      {member.avatarUrl
                        ? <img src={member.avatarUrl} alt="" className="w-full h-full object-cover" />
                        : member.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] font-medium text-ink-900 truncate">{member.name}</span>
                        {member.id === meId && <span className="text-[10px] text-ink-300">{t('workspace.you')}</span>}
                      </div>
                      <div className="text-[10.5px] text-ink-400 truncate">{member.email}</div>
                    </div>
                    {canChangeRole ? (
                      <select
                        value={member.role}
                        disabled={busy}
                        onChange={(event) => void changeRole(member, event.target.value as 'member' | 'admin')}
                        className="h-8 rounded-[7px] border border-ink-100 bg-paper px-2 text-[11.5px] text-ink-700 disabled:opacity-50"
                      >
                        <option value="member">{t('workspace.roleMember')}</option>
                        <option value="admin">{t('workspace.roleAdmin')}</option>
                      </select>
                    ) : (
                      <span className="px-2 text-[10.5px] uppercase tracking-wide font-semibold text-ink-400">
                        {member.role === 'owner' ? t('workspace.roleOwner') : member.role === 'admin' ? t('workspace.roleAdmin') : t('workspace.roleMember')}
                      </span>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void removeMember(member)}
                        className="px-2 py-1.5 rounded-[7px] text-[11px] font-medium text-coral-deep hover:bg-coral-soft/35 disabled:opacity-50"
                      >{busy ? '…' : t('workspace.removeBtn')}</button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {company.role === 'owner' && (
          <section className="m-5 mt-1 rounded-[12px] border border-coral/35 bg-coral-soft/15 p-4">
            <h3 className="text-[13px] font-semibold text-coral-deep">{t('workspace.dangerTitle')}</h3>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-500">
              {companyCount <= 1 ? t('workspace.onlyWorkspace') : t('workspace.deleteHelp')}
            </p>
            <label className="block mt-3 text-[10.5px] font-semibold uppercase tracking-wide text-ink-400">
              {t('workspace.typeName', { name: company.name })}
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                disabled={deleting || companyCount <= 1}
                className="min-w-0 flex-1 h-9 rounded-[8px] border border-ink-100 bg-paper px-3 text-[12px] outline-none focus:border-coral disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void deleteWorkspace()}
                disabled={deleting || companyCount <= 1 || deleteConfirmation !== company.name}
                className="h-9 px-3 rounded-[8px] bg-coral-deep text-white text-[11.5px] font-semibold disabled:opacity-40"
              >{deleting ? t('workspace.deleting') : t('workspace.deleteBtn')}</button>
            </div>
            {deleteError && <div className="mt-2 text-[11.5px] text-coral-deep">{deleteError}</div>}
          </section>
        )}
      </div>
    </div>
  )
}
