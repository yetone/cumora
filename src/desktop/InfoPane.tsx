import { useState } from 'react'
import { useApp } from '@/stores/app'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { Avatar } from '@/components/Avatar'
import { IMail } from '@/components/icons'
import { api } from '@/api/client'
import { useT, type MessageKey } from '@/lib/i18n'

const STATUS_LABEL: Record<string, MessageKey> = {
  avail: 'info.statusAvail', working: 'info.statusWorking', thinking: 'info.statusThinking', waiting: 'info.statusWaiting', resting: 'info.statusResting',
}
const STATUS_COLOR: Record<string, string> = {
  avail: 'var(--avail)', working: 'var(--working)', thinking: 'var(--thinking)', waiting: 'var(--waiting)', resting: 'var(--resting)',
}

export function InfoPane() {
  const t = useT()
  const infoAgentId = useApp((s) => s.infoAgentId)
  const close = useApp((s) => s.closeAgentInfo)
  const select = useApp((s) => s.selectConversation)
  const setView = useApp((s) => s.setView)
  const byId = useParticipants((s) => s.byId)
  const agent = infoAgentId ? byId[infoAgentId] : undefined
  const [opening, setOpening] = useState(false)
  const [copied, setCopied] = useState(false)

  if (!agent) return null   // DesktopApp also gates on infoAgentId, defensive

  // Variable name `agent` predates humans being clickable — it's now a
  // generic Participant (agent OR human). Keeping the name for diff
  // minimization; isAgent / isHumanProfile branch the per-section chrome.
  const isAgent = agent.kind === 'agent'

  const copyEmail = async () => {
    if (!agent.email) return
    try {
      await navigator.clipboard.writeText(agent.email)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can fail in unusual contexts (no permission, no
      // navigator.clipboard) — silently degrade rather than blow up.
    }
  }

  const statusColor = STATUS_COLOR[agent.status] ?? 'var(--resting)'

  const startDM = async () => {
    if (!agent || opening) return
    setOpening(true)
    try {
      const r = await api.openDirect(agent.id)
      await useConversations.getState().reload()
      setView('conversations')
      select(r.id)
      close()
    } catch (err) {
      console.warn('[dm] open failed', err)
    } finally {
      setOpening(false)
    }
  }

  return (
    <aside
      className="border-l border-ink-100 overflow-y-auto relative"
      style={{ background: 'var(--chrome-pane)' }}
    >
      <button
        onClick={close}
        aria-label={t('info.close')}
        className="absolute top-3 right-3 z-10 w-7 h-7 rounded-full grid place-items-center text-ink-500 hover:bg-cloud hover:text-ink-900 transition border border-ink-100 bg-cloud/70 backdrop-blur-sm"
      >×</button>
      <div
        className="text-center pt-[26px] pb-[18px] px-[22px] border-b border-ink-100"
        style={{ background: 'radial-gradient(circle at 50% 0%, var(--sky-100), transparent 70%)' }}
      >
        <div className="mx-auto mb-2.5 relative inline-block">
          <Avatar p={agent} size={88} ringColor="var(--cloud)" />
        </div>
        <h3 className="font-display font-medium text-[24px] tracking-tight mb-0.5">{agent.name}</h3>
        <div className="font-display italic font-normal text-[13px] text-ink-500 mb-3">
          {agent.role ?? (isAgent ? t('convo.roleAgent') : t('convo.roleHuman'))}
        </div>
        <div className="inline-flex items-center gap-1.5 py-1.5 px-3 rounded-full bg-cloud border border-ink-100 text-[12px] text-ink-700 shadow-soft">
          <span className="w-[7px] h-[7px] rounded-full animate-pulse-soft" style={{ background: statusColor }} />
          {t(STATUS_LABEL[agent.status] ?? 'common.idle')}
        </div>
      </div>

      <div className="flex gap-2 py-3.5 px-[22px] border-b border-ink-100">
        <button
          onClick={startDM}
          disabled={opening}
          className="flex-1 py-2.5 px-3 text-white rounded-[9px] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 transition disabled:opacity-50"
          style={{
            background: 'var(--skype)',
            boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.45)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          {opening ? t('info.dmOpening') : t('info.dm')}
        </button>
        {/* Whisper / Convene are agent-team rituals; humans use plain DM. */}
        {isAgent && (
          <>
            <button className="flex-1 py-2.5 px-3 bg-skype-ink text-white rounded-[9px] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5">
              {t('info.whisper')}
            </button>
            <button className="flex-1 py-2.5 px-3 bg-cloud border border-ink-100 rounded-[9px] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 hover:border-sky2-200 hover:text-skype-deep">
              {t('info.convene')}
            </button>
          </>
        )}
      </div>

      {agent.email && (
        <div className="py-4 px-[22px] border-b border-ink-100">
          <h4 className="text-[10.5px] font-bold text-ink-300 tracking-wider uppercase mb-2.5">
            {t('info.email')}
          </h4>
          <button
            type="button"
            onClick={copyEmail}
            className="w-full py-2 px-2.5 bg-cloud border border-ink-100 rounded-[9px] flex items-center gap-2 text-[12px] text-ink-700 font-mono hover:border-sky2-200 hover:text-skype-deep transition text-left"
            title={copied ? t('info.copied') : t('info.clickToCopy')}
          >
            <IMail className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
            <span className="truncate flex-1">{agent.email}</span>
            <span className="text-[10px] uppercase tracking-wider text-ink-300 shrink-0">
              {copied ? t('info.copiedShort') : t('info.copyShort')}
            </span>
          </button>
        </div>
      )}

      {/* Tools + About are agent-only — humans don't have a system prompt
          or tool list to display. We could surface "joined this workspace
          on <date>" for humans here later, but for now the email card
          above is enough profile signal. */}
      {isAgent && (
        <>
          <div className="py-4 px-[22px] border-b border-ink-100">
            <h4 className="text-[10.5px] font-bold text-ink-300 tracking-wider uppercase mb-2.5">
              {t('info.toolsEnabled')}
            </h4>
            <div className="grid grid-cols-2 gap-1.5">
              {(agent.tools ?? []).map((tool) => (
                <div key={tool} className="py-2 px-2.5 bg-cloud border border-ink-100 rounded-[9px] flex items-center gap-2 text-[11.5px] text-ink-700">
                  <span className="w-1.5 h-1.5 rounded-full bg-avail" />
                  <b className="font-mono font-medium text-[11px]">{tool}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="py-4 px-[22px] border-b border-ink-100">
            <h4 className="text-[10.5px] font-bold text-ink-300 tracking-wider uppercase mb-2.5">
              {t('info.about', { name: agent.name })}
            </h4>
            <div
              className="py-3 px-3.5 rounded-r-lg font-display italic font-normal text-[13px] leading-[1.55] text-ink-700"
              style={{
                background: 'linear-gradient(135deg, var(--sky-50), transparent)',
                borderLeft: '2px solid var(--skype)',
              }}
            >
              {agent.bio}
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
