import { useMemo, useState } from 'react'
import { useApp } from '@/stores/app'
import { useMe } from '@/stores/auth'
import { useParticipants } from '@/stores/participants'
import { useComputers } from '@/stores/computers'
import { useConversations } from '@/stores/conversations'
import { Avatar } from '@/components/Avatar'
import { IPlus } from '@/components/icons'
import { AgentEditor } from '@/components/AgentEditor'
import { api } from '@/api/client'
import { useT, type MessageKey } from '@/lib/i18n'
import { engineLabel } from '@/lib/engines'
import type { Participant } from '@/types'

const STATUS_LABEL_KEY: Record<string, MessageKey> = {
  avail: 'agents.statusAvail', working: 'agents.statusWorking', thinking: 'agents.statusThinking', waiting: 'agents.statusWaiting', resting: 'agents.statusResting',
}
const STATUS_COLOR: Record<string, string> = {
  avail: 'var(--avail)', working: 'var(--working)', thinking: 'var(--thinking)', waiting: 'var(--waiting)', resting: 'var(--resting)',
}

function AgentCard({ p, onEdit, onDelete }: {
  p: Participant
  onEdit: (p: Participant) => void
  onDelete: (p: Participant) => void
}) {
  const t = useT()
  const setView = useApp((s) => s.setView)
  const select = useApp((s) => s.selectConversation)
  const conversations = useConversations((s) => s.list)
  const host = useComputers((s) => (p.computerId ? s.byId[p.computerId] : undefined))
  const hostIcon = !host || host.kind === 'cloud' ? '☁' : host.kind === 'vps' ? '🖥' : '💻'
  const hostLabel = host ? host.name : t('agents.hostCloud')
  const hostOffline = !!host && host.kind !== 'cloud' && host.status !== 'online'
  const displayStatus = hostOffline ? 'resting' : p.status
  const displayStatusLabel = hostOffline
    ? t('agents.statusOffline')
    : t((STATUS_LABEL_KEY[p.status] ?? 'common.idle') as MessageKey)
  const engineName = (() => {
    if (!host || host.kind === 'cloud') return null
    const id = p.engine && p.engine !== 'managed'
      ? p.engine
      : (host.availableEngines[0] ?? null)
    return id ? engineLabel(id) : null
  })()
  const direct = useMemo(
    () => conversations.find((c) => c.kind === 'direct' && c.members.includes(p.id)),
    [conversations, p.id],
  )
  const [openingChat, setOpeningChat] = useState(false)

  const openChat = async () => {
    if (direct) {
      setView('conversations')
      select(direct.id)
      return
    }
    // No direct convo yet (e.g. older agent created before auto-create
    // was wired up). Create-or-find on demand via the same idempotent
    // endpoint the people-list uses.
    setOpeningChat(true)
    try {
      const { id } = await api.openDirect(p.id)
      await useConversations.getState().reload()
      setView('conversations')
      select(id)
    } catch (err) {
      console.warn('[AgentCard] openDirect failed', err)
    } finally {
      setOpeningChat(false)
    }
  }

  return (
    <div className="bg-cloud rounded-[16px] p-5 transition hover:shadow-pop relative group/card flex flex-col h-full"
      style={{ border: '1px solid var(--ink-100)' }}>
      {/* Hover actions: edit / delete */}
      <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover/card:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => onEdit(p)}
          className="w-7 h-7 rounded-full grid place-items-center bg-cloud hover:bg-sky2-50 text-ink-500 hover:text-skype-deep transition"
          style={{ border: '1px solid var(--ink-100)' }}
          title={t('agents.cardEdit')}
          aria-label={t('agents.cardEditAgent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button
          type="button"
          onClick={() => onDelete(p)}
          className="w-7 h-7 rounded-full grid place-items-center bg-cloud hover:bg-coral-soft text-ink-500 hover:text-coral-deep transition"
          style={{ border: '1px solid var(--ink-100)' }}
          title={t('agents.cardOffboard')}
          aria-label={t('agents.cardOffboardAgent')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </div>

      <div className="flex items-start gap-3.5 mb-3">
        <Avatar p={p} size={56} statusOverride={displayStatus} />
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-medium text-[20px] tracking-tight leading-tight">{p.name}</h3>
          <div className="font-display italic font-normal text-[12.5px] text-ink-500 mb-1.5">{p.role}</div>
          <div className="flex flex-nowrap items-center gap-1.5 min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold py-0.5 px-2 rounded-full shrink-0"
              style={{
                background: `${STATUS_COLOR[displayStatus]}1F`,
                color: STATUS_COLOR[displayStatus],
              }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[displayStatus] }} />
              {displayStatusLabel}
            </div>
            <div className="inline-flex items-center gap-1 min-w-0 overflow-hidden text-[11px] py-0.5 px-2 rounded-full text-ink-500"
              style={{ background: 'var(--ink-100)' }}
              title={hostOffline ? t('agents.hostOfflineTip', { host: hostLabel }) : t('agents.hostRunsOn', { host: hostLabel })}>
              <span className="shrink-0">{hostIcon}</span>
              <span className="min-w-0 truncate">{hostLabel}</span>
              {hostOffline && <span className="italic text-ink-400 shrink-0">{t('agents.hostOfflineSuffix')}</span>}
            </div>
            {engineName && (
              <div
                className="inline-flex items-center text-[11px] py-0.5 px-2 rounded-full text-ink-700 shrink-0 whitespace-nowrap"
                style={{ background: 'var(--ink-100)' }}
                title={t('agents.hostEngineTip', { engine: engineName })}
              >
                {engineName}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="text-[12.5px] text-ink-700 leading-[1.55] font-display italic font-normal mb-3.5 line-clamp-3">
        "{p.bio || p.systemPrompt || '—'}"
      </div>

      <div className="text-[9.5px] font-bold text-ink-300 tracking-wider uppercase mb-2">{t('agents.tools')}</div>
      <div className="flex flex-wrap gap-1 mb-4">
        {(p.tools ?? []).map((t) => (
          <span key={t} className="font-mono text-[10.5px] py-0.5 px-1.5 rounded text-ink-700"
            style={{ background: 'var(--ink-100)' }}>
            {t}
          </span>
        ))}
      </div>

      <div className="flex gap-2 mt-auto">
        <button
          type="button"
          onClick={openChat}
          disabled={openingChat}
          className="flex-1 py-2 px-3 bg-skype text-white rounded-[9px] text-[12px] font-semibold transition disabled:opacity-60"
          style={{ boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.4)' }}>
          {openingChat ? t('agents.openingChat') : t('agents.cardChat')}
        </button>
        <button type="button" className="flex-1 py-2 px-3 bg-cloud text-ink-700 rounded-[9px] text-[12px] font-semibold hover:border-whisper-200 hover:text-whisper-deep transition"
          style={{ border: '1px solid var(--ink-100)' }}>
          {t('agents.cardWhisper')}
        </button>
      </div>
    </div>
  )
}

function AgentCardSkeleton() {
  return (
    <div
      className="rounded-[16px] p-5 min-h-[280px] bg-cloud"
      style={{ border: '1px solid var(--ink-200)' }}
    >
      <div className="flex items-start gap-3.5 mb-3">
        <div className="w-14 h-14 rounded-full bg-ink-200 shrink-0" />
        <div className="flex-1 pt-1">
          <div className="h-5 w-28 rounded-md bg-ink-200" />
          <div className="mt-2 h-3 w-20 rounded-md bg-ink-200/80" />
          <div className="mt-2.5 flex gap-1.5">
            <div className="h-5 w-14 rounded-full bg-ink-200/80" />
            <div className="h-5 w-24 rounded-full bg-ink-200/80" />
            <div className="h-5 w-16 rounded-full bg-ink-200/80" />
          </div>
        </div>
      </div>
      <div className="h-3 w-[92%] rounded-md bg-ink-200/70 mb-2" />
      <div className="h-3 w-[70%] rounded-md bg-ink-200/70 mb-4" />
      <div className="mt-auto h-9 rounded-[9px] bg-ink-200/80" />
    </div>
  )
}

function HireCard({ onClick }: { onClick: () => void }) {
  const t = useT()
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[16px] p-5 grid place-items-center text-center min-h-[280px] cursor-pointer transition hover:bg-sky2-50 active:scale-[0.99]"
      style={{
        background: 'linear-gradient(135deg, var(--paper), var(--sky-50))',
        border: '1.5px dashed var(--ink-200)',
      }}>
      <div>
        <div className="w-12 h-12 mx-auto mb-3 grid place-items-center rounded-full bg-cloud text-skype-deep shadow-soft">
          <IPlus className="w-6 h-6" strokeWidth={2} />
        </div>
        <div className="font-display font-medium text-[18px] text-ink-900 mb-1.5" style={{ letterSpacing: '-0.01em' }}>
          {t('agents.addAgent')}
        </div>
        <div className="font-display italic font-normal text-[12.5px] text-ink-500 max-w-[200px] mx-auto leading-[1.5]">
          {t('agents.addAgentSub')}
        </div>
      </div>
    </button>
  )
}

function ConfirmOffboard({ p, onCancel, onConfirmed }: {
  p: Participant
  onCancel: () => void
  onConfirmed: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setErr(null)
    try {
      await api.offboardAgent(p.id)
      onConfirmed()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onCancel}
    >
      <div
        className="bg-cloud rounded-[16px] shadow-pop max-w-[460px] w-full p-6"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display font-medium text-[20px] tracking-tight mb-1.5">{t('agents.offboardTitle', { name: p.name })}</h3>
        <p className="text-[13px] text-ink-700 leading-[1.6] mb-3">
          {t('agents.offboardBody1', { name: p.name })}
        </p>
        <p className="text-[12.5px] text-ink-500 leading-[1.55] font-display italic mb-4">
          {t('agents.offboardBody2')}
        </p>
        {err && (
          <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg mb-3">{err}</div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-2 px-3 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{t('common.cancel')}</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="flex-1 py-2 px-3 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{ background: 'var(--coral-deep)' }}
          >{busy ? t('agents.offboarding') : t('agents.offboardButton', { name: p.name })}</button>
        </div>
      </div>
    </div>
  )
}

function FormerAgentCard({ p, onRehire }: { p: Participant; onRehire: (p: Participant) => void }) {
  const t = useT()
  const departed = p.departedAt
    ? t('agents.offboardedAt', { date: new Date(p.departedAt).toLocaleDateString() })
    : t('agents.offboarded')
  return (
    <div className="bg-cloud rounded-[14px] p-4 flex items-center gap-3 transition hover:shadow-soft"
      style={{ border: '1px solid var(--ink-100)', opacity: 0.78 }}>
      <div style={{ filter: 'grayscale(0.5)' }}>
        <Avatar p={p} size={44} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-[14px] text-ink-700 truncate">{p.name}</div>
        <div className="text-[11px] text-ink-500 italic font-display">{p.role} · {departed}</div>
      </div>
      <button
        type="button"
        onClick={() => onRehire(p)}
        className="px-3 py-1.5 rounded-[8px] text-[11.5px] font-semibold text-skype-deep bg-cloud hover:bg-sky2-50 transition inline-flex items-center gap-1"
        style={{ border: '1px solid var(--sky2-200)' }}
        title={t('agents.rehireTitle', { name: p.name })}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 10 9 10"/></svg>
        {t('agents.rehire')}
      </button>
    </div>
  )
}

export function AgentsView() {
  const t = useT()
  const byId = useParticipants((s) => s.byId)
  const meId = useMe()
  const allAgents = Object.values(byId).filter((p) => p.kind === 'agent')
  const list = allAgents.filter((p) => !p.departedAt)
  const departed = allAgents.filter((p) => p.departedAt).sort((a, b) => (b.departedAt ?? '').localeCompare(a.departedAt ?? ''))
  const humans = Object.values(byId).filter((p) => p.kind === 'human' && p.id !== meId)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Participant | null>(null)
  const [confirmingOffboard, setConfirmingOffboard] = useState<Participant | null>(null)
  const [rosterBusy, setRosterBusy] = useState(false)

  async function reloadRoster() {
    setRosterBusy(true)
    try {
      await Promise.all([
        useParticipants.getState().refresh(),
        useConversations.getState().reload(),
      ])
    } finally {
      setRosterBusy(false)
    }
  }

  const openCreate = () => { setEditing(null); setEditorOpen(true) }
  const openEdit = (p: Participant) => { setEditing(p); setEditorOpen(true) }
  const rehire = async (p: Participant) => {
    try {
      await api.rehireAgent(p.id)
      await reloadRoster()
    } catch (e) {
      console.warn('[rehire] failed', e)
    }
  }

  return (
    <main className="overflow-y-auto p-8 pt-6"
      style={{ background: 'linear-gradient(180deg, transparent, var(--paper))' }}>
      <div className="max-w-[1240px] mx-auto">
        <div className="mb-6 flex items-end gap-4">
          <div className="flex-1">
            <h1 className="font-display font-medium text-[36px] tracking-tight text-ink-900 mb-1" style={{ letterSpacing: '-0.025em' }}>
              {t('agents.teamHeadline')} <em className="italic text-skype-deep" style={{ fontWeight: 400 }}>{t('agents.teamCountEm', { count: list.length })}</em>
            </h1>
            <div className="font-display italic font-normal text-[15px] text-ink-500">
              {t('agents.teamSubtitle')}
            </div>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-[10px] text-[12.5px] font-semibold text-white transition"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
            }}
          >
            <IPlus className="w-4 h-4" strokeWidth={2.5} />
            {t('agents.newAgent')}
          </button>
        </div>

        <div className="flex gap-3 mb-6 text-[11px]">
          <div className="py-1.5 px-3 bg-cloud rounded-full text-ink-700 border border-ink-100">
            <b className="text-skype-deep font-semibold">{list.filter((a) => a.status === 'working').length}</b> {t('agents.countWorking')}
          </div>
          <div className="py-1.5 px-3 bg-cloud rounded-full text-ink-700 border border-ink-100">
            <b className="text-thinking font-semibold">{list.filter((a) => a.status === 'thinking').length}</b> {t('agents.countThinking')}
          </div>
          <div className="py-1.5 px-3 bg-cloud rounded-full text-ink-700 border border-ink-100">
            <b className="text-avail font-semibold">{list.filter((a) => a.status === 'avail').length}</b> {t('agents.countAvailable')}
          </div>
          <div className="py-1.5 px-3 bg-cloud rounded-full text-ink-700 border border-ink-100">
            <b className="text-resting font-semibold">{list.filter((a) => a.status === 'resting').length}</b> {t('agents.countResting')}
          </div>
        </div>

        {rosterBusy && (
          <div className="text-[12px] text-ink-500 mb-3">{t('agents.rosterRefreshing')}</div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy={rosterBusy}>
          {rosterBusy ? (
            Array.from({ length: Math.max(list.length, 3) + 1 }, (_, i) => (
              <AgentCardSkeleton key={i} />
            ))
          ) : (
            <>
              {list.map((a) => (
                <AgentCard key={a.id} p={a} onEdit={openEdit} onDelete={setConfirmingOffboard} />
              ))}
              <HireCard onClick={openCreate} />
            </>
          )}
        </div>

        {departed.length > 0 && (
          <div className="mt-10 mb-2">
            <h2 className="font-display font-medium text-[20px] tracking-tight text-ink-700 mb-1.5" style={{ letterSpacing: '-0.02em' }}>
              {t('agents.formerHeadline')} <em className="italic text-ink-500" style={{ fontWeight: 400, fontSize: '0.85em' }}>{t('agents.formerCount', { count: departed.length })}</em>
            </h2>
            <div className="font-display italic font-normal text-[13px] text-ink-500 mb-4">
              {t('agents.formerSubtitle')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {departed.map((p) => <FormerAgentCard key={p.id} p={p} onRehire={rehire} />)}
            </div>
          </div>
        )}

        {humans.length > 0 && (
          <div className="mt-10 mb-2">
            <h2 className="font-display font-medium text-[24px] tracking-tight text-ink-900 mb-1.5" style={{ letterSpacing: '-0.02em' }}>
              {t('agents.humansHeadline')}
            </h2>
            <div className="font-display italic font-normal text-[13.5px] text-ink-500 mb-5">
              {t('agents.humansSubtitle')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              {humans.map((p) => (
                <div key={p.id} className="bg-cloud rounded-[12px] p-4 flex items-center gap-3"
                  style={{ border: '1px solid var(--ink-100)' }}>
                  <Avatar p={p} size={40} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-[14px] text-ink-900">{p.name}</div>
                    <div className="text-[11px] text-ink-500">{t((STATUS_LABEL_KEY[p.status] ?? 'common.idle') as MessageKey)}</div>
                  </div>
                  <span className="text-[9px] font-bold py-0.5 px-1.5 rounded uppercase tracking-wider bg-coral-soft text-coral-deep">{t('common.human')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {editorOpen && (
        <AgentEditor
          agent={editing}
          onClose={() => { setEditorOpen(false); setEditing(null) }}
          onSaved={() => { void reloadRoster() }}
        />
      )}
      {confirmingOffboard && (
        <ConfirmOffboard
          p={confirmingOffboard}
          onCancel={() => setConfirmingOffboard(null)}
          onConfirmed={() => {
            setConfirmingOffboard(null)
            void reloadRoster()
          }}
        />
      )}
    </main>
  )
}
