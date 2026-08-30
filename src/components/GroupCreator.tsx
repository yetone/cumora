/**
 * Modal for creating a new group conversation. User picks a title and a set of
 * teammates (active agents + other humans). Yetone is auto-included.
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type ApiProject } from '@/api/client'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { useApp } from '@/stores/app'
import { Avatar } from '@/components/Avatar'
import { Input } from '@/components/Input'
import type { Participant } from '@/types'
import { useT } from '@/lib/i18n'

interface Props {
  onClose: () => void
  /** participant ids to pre-select (e.g. when entering from a direct-chat right-click) */
  initialPicked?: string[]
}

export function GroupCreator({ onClose, initialPicked }: Props) {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const select = useApp((s) => s.selectConversation)
  const setView = useApp((s) => s.setView)
  const meId = useMe()

  const candidates = useMemo<Participant[]>(() => {
    return Object.values(byId)
      .filter((p) => p.id !== meId && !p.departedAt)
      .sort((a, b) => {
        // Agents first, then humans, then alphabetical.
        if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [byId, meId])

  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initialPicked ?? []))
  const [projects, setProjects] = useState<ApiProject[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    void api.listProjects()
      .then((list) => setProjects(list.filter((p) => p.status === 'active')))
      .catch(() => { /* ignore — picker just hides */ })
  }, [])

  const toggle = (id: string) => {
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Live auto-title from selected members. "Iris, Bram & Nova" up to 3 names,
  // then "Iris, Bram & 2 more". Used as placeholder + as the value when the
  // user leaves the title blank.
  const autoTitle = useMemo(() => {
    const names = candidates.filter((p) => picked.has(p.id)).map((p) => p.name)
    if (names.length === 0) return ''
    if (names.length === 1) return names[0]
    if (names.length === 2) return `${names[0]} & ${names[1]}`
    if (names.length === 3) return `${names[0]}, ${names[1]} & ${names[2]}`
    return `${names[0]}, ${names[1]} & ${names.length - 2} more`
  }, [candidates, picked])

  const submit = async () => {
    setErr(null)
    if (picked.size === 0) { setErr(t('group.pickOne')); return }
    const finalTitle = title.trim() || autoTitle
    if (!finalTitle) { setErr(t('group.addTitle')); return }
    setBusy(true)
    try {
      const r = await api.createGroup({ title: finalTitle, members: [...picked], projectId })
      await useConversations.getState().reload()
      setView('conversations')
      select(r.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = picked.size > 0 && !busy

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[18px] shadow-pop w-full max-w-[520px] max-h-[88vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 shrink-0">
          <h2 className="font-display font-medium text-[20px] tracking-tight">{t('group.title')}</h2>
          <div className="text-[12.5px] text-ink-500 italic font-display mt-0.5">
            {t('group.intro')}
          </div>
        </div>

        <div className="px-6 py-5 overflow-y-auto flex-1 min-h-0">
          <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">
            {t('group.fieldTitle')}
            <span className="ml-1.5 text-ink-300 normal-case font-medium tracking-normal">{t('group.fieldOptional')}</span>
          </label>
          <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">
            {autoTitle
              ? t('group.leaveBlankTo', { title: autoTitle })
              : t('group.whatIsAbout')}
          </div>
          <Input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={autoTitle || t('group.titlePh')}
            autoFocus
            className="mb-5"
            maxLength={80}
          />

          {projects.length > 0 && (
            <>
              <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">
                {t('group.fieldProject')}
                <span className="ml-1.5 text-ink-300 normal-case font-medium tracking-normal">{t('group.fieldOptional')}</span>
              </label>
              <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">
                {t('group.attachProject')}
              </div>
              <div className="flex flex-wrap gap-1.5 mb-5">
                <button
                  type="button"
                  onClick={() => setProjectId(null)}
                  className="px-2.5 py-1 rounded-full text-[11.5px] font-medium transition"
                  style={{
                    background: projectId === null ? 'var(--ink-700)' : 'var(--paper)',
                    color: projectId === null ? 'white' : 'var(--ink-500)',
                    border: '1px solid var(--ink-100)',
                  }}
                >{t('group.noProject')}</button>
                {projects.map((p) => {
                  const on = projectId === p.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProjectId(p.id)}
                      className="px-2.5 py-1 rounded-full text-[11.5px] font-medium transition"
                      style={{
                        background: on ? (p.color ?? 'var(--skype)') : 'var(--paper)',
                        color: on ? 'white' : 'var(--ink-700)',
                        border: '1px solid var(--ink-100)',
                      }}
                    >{p.name}</button>
                  )
                })}
              </div>
            </>
          )}

          <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">{t('group.fieldMembers')}</label>
          <div className="text-[11.5px] text-ink-300 mb-2 font-display italic">
            {picked.size === 0 ? t('group.clickToAdd') : t('group.nSelected', { n: picked.size })}
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            {candidates.map((p) => {
              const on = picked.has(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.id)}
                  className="text-left flex items-center gap-3 py-2 px-2.5 rounded-[10px] transition"
                  style={{
                    background: on ? 'var(--sky-50)' : 'var(--paper)',
                    border: `1.5px solid ${on ? 'var(--sky2-300)' : 'var(--ink-100)'}`,
                  }}
                >
                  <Avatar p={p} size={32} ringColor="var(--paper)" showStatus={false} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink-900 truncate">{p.name}</div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {p.role || (p.kind === 'human' ? t('group.kindHuman') : t('group.kindAgent'))}
                    </div>
                  </div>
                  <span
                    className="w-5 h-5 rounded-full grid place-items-center text-[11px] font-bold transition"
                    style={{
                      background: on ? 'var(--skype)' : 'transparent',
                      color: on ? 'white' : 'var(--ink-300)',
                      border: on ? '1.5px solid var(--skype)' : '1.5px solid var(--ink-200)',
                    }}
                  >{on ? '✓' : ''}</span>
                </button>
              )
            })}
            {candidates.length === 0 && (
              <div className="text-[12.5px] text-ink-500 italic font-display py-4 text-center">
                {t('group.noTeammates')}
              </div>
            )}
          </div>

          {err && (
            <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg mt-4">
              {err}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-100 flex items-center gap-2 bg-paper shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{t('group.cancelBtn')}</button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
            }}
          >{busy ? t('group.creatingBtn') : (picked.size > 0 ? t('group.createBtnWithCount', { n: picked.size + 1 }) : t('group.createBtn'))}</button>
        </div>
      </div>
    </div>
  )
}
