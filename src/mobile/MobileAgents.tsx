import { useMemo, useState } from 'react'
import { Avatar } from '@/components/Avatar'
import { useMe } from '@/stores/auth'
import { useApp } from '@/stores/app'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { IPlus } from '@/components/icons'
import { AgentEditor } from '@/components/AgentEditor'
import { HumanBadge } from '@/components/HumanBadge'
import { type MessageKey, useTLabel } from '@/lib/i18n'
import type { Participant } from '@/types'

// statusLabels kept as the source of truth (English fallback), so the
// author's copy edits stay in sync. The parallel statusLabelsKey gives t()
// a MessageKey to resolve without changing the data shape.
const statusLabels: Record<string, string> = {
  avail: 'Available',
  working: 'Working',
  thinking: 'Thinking',
  waiting: 'Waiting on you',
  resting: 'Resting',
}
const statusLabelsKey: Record<string, MessageKey> = {
  avail: 'magents.statusAvail',
  working: 'magents.statusWorking',
  thinking: 'magents.statusThinking',
  waiting: 'magents.statusWaiting',
  resting: 'magents.statusResting',
}

const statusColors: Record<string, string> = {
  avail: 'var(--avail)',
  working: 'var(--working)',
  thinking: 'var(--thinking)',
  waiting: 'var(--waiting)',
  resting: 'var(--resting)',
}

export function MobileAgents() {
  // Non-invasive i18n: prefer translated MessageKey, fall back to the
  // author's original English literal so future copy edits stay in sync.
  const tLabel = useTLabel()
  const byId = useParticipants((s) => s.byId)
  const convoList = useConversations((s) => s.list)
  const setView = useApp((s) => s.setView)
  const select = useApp((s) => s.selectConversation)
  const meId = useMe()
  const [editing, setEditing] = useState<Participant | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  // Real roster, scoped to the active workspace via the participants store
  // (which is itself re-fetched on workspace switch). Drop departed agents
  // and the signed-in user.
  const { agents, humans } = useMemo(() => {
    const all = Object.values(byId).filter((p) => !p.departedAt)
    return {
      agents: all.filter((p): p is Participant => p.kind === 'agent'),
      humans: all.filter((p): p is Participant => p.kind === 'human' && p.id !== meId),
    }
  }, [byId, meId])

  /** Tap an agent → jump to the direct chat with me + them. */
  const goChat = (agentId: string) => {
    if (!meId) return
    const direct = convoList.find((c) =>
      c.kind === 'direct' && c.members.includes(meId) && c.members.includes(agentId),
    )
    if (direct) {
      setView('conversations')
      select(direct.id)
    }
  }

  return (
    <section className="flex flex-col h-full overflow-hidden bg-paper">
      <div className="sticky top-0 z-10 backdrop-blur-md"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', background: 'rgba(250, 252, 254, 0.95)' }}>
        <div className="px-4 pt-2 pb-3">
          <h1 className="font-display font-medium text-[26px] tracking-tight text-ink-900 leading-none">
            {tLabel('magents.titleLead', 'Your team')} <em className="not-italic text-skype-deep" style={{ fontStyle: 'italic', fontWeight: 400 }}>{tLabel('magents.titleCount', `of ${agents.length}`, { n: agents.length })}</em>
          </h1>
          <div className="text-[12.5px] text-ink-500 mt-0.5 font-display italic">
            {tLabel('magents.subtitle', 'agents work on their own, loop you in when needed')}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 px-3">
        <div className="flex gap-1.5 mb-3 mt-1 text-[10.5px] overflow-x-auto scroll-clean">
          {[
            ['working', agents.filter((a) => a.status === 'working').length],
            ['thinking', agents.filter((a) => a.status === 'thinking').length],
            ['available', agents.filter((a) => a.status === 'avail').length],
            ['resting', agents.filter((a) => a.status === 'resting').length],
          ].map(([lbl, n]) => (
            <div key={lbl as string} className="py-1 px-2.5 bg-cloud rounded-full text-ink-700 whitespace-nowrap"
              style={{ border: '1px solid var(--ink-100)' }}>
              <b className="font-semibold text-skype-deep mr-1">{n as number}</b>{lbl as string}
            </div>
          ))}
        </div>

        <div className="space-y-2.5">
          {agents.length === 0 && (
            <div className="text-center text-ink-300 italic font-display py-12 text-[13px]">
              {tLabel('magents.empty', 'No agents in this workspace yet. Hire one below.')}
            </div>
          )}
          {agents.map((p) => (
            <button
              key={p.id}
              type="button"
              className="w-full text-left bg-cloud rounded-[14px] p-3.5 active:scale-[0.99] transition"
              style={{ border: '1px solid var(--ink-100)' }}
              onClick={() => goChat(p.id)}
            >
              <div className="flex items-start gap-3 mb-2.5">
                <Avatar p={p} size={48} />
                <div className="flex-1 min-w-0">
                  <h3 className="font-display font-medium text-[18px] tracking-tight leading-tight" style={{ letterSpacing: '-0.01em' }}>{p.name}</h3>
                  {p.role && (
                    <div className="font-display italic text-[12px] text-ink-500 leading-tight mb-1">{p.role}</div>
                  )}
                  <div className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold py-0.5 px-2 rounded-full"
                    style={{ background: `${statusColors[p.status]}1F`, color: statusColors[p.status] }}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColors[p.status] }} />
                    {statusLabels[p.status] ? tLabel(statusLabelsKey[p.status], statusLabels[p.status]) : ''}
                  </div>
                </div>
              </div>
              {p.bio && (
                <div className="text-[12px] text-ink-700 leading-[1.5] font-display italic mb-2.5">"{p.bio}"</div>
              )}
              {(p.tools ?? []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(p.tools ?? []).slice(0, 4).map((t) => (
                    <span key={t} className="font-mono text-[10px] py-0.5 px-1.5 rounded bg-ink-100 text-ink-700">{t}</span>
                  ))}
                </div>
              )}
            </button>
          ))}

          <button
            type="button"
            onClick={() => { setEditing(null); setEditorOpen(true) }}
            className="w-full rounded-[14px] p-5 flex items-center justify-center gap-3 text-skype-deep mt-2 active:scale-[0.99] transition"
            style={{ background: 'linear-gradient(135deg, var(--paper), var(--sky-50))', border: '1.5px dashed var(--ink-200)' }}
          >
            <div className="w-10 h-10 grid place-items-center rounded-full bg-cloud shadow-soft">
              <IPlus className="w-5 h-5" strokeWidth={2} />
            </div>
            <div className="text-left">
              <div className="font-display font-medium text-[15px] text-ink-900" style={{ letterSpacing: '-0.01em' }}>{tLabel('magents.hireTitle', 'Hire an agent')}</div>
              <div className="font-display italic text-[11.5px] text-ink-500">{tLabel('magents.hireSub', 'design a new teammate')}</div>
            </div>
          </button>
        </div>

        {editorOpen && (
          <AgentEditor agent={editing} onClose={() => { setEditorOpen(false); setEditing(null) }} />
        )}

        {humans.length > 0 && (
          <>
            <div className="px-2 pt-6 pb-2 text-[10px] font-bold text-ink-300 tracking-[0.12em] uppercase">{tLabel('magents.humansHead', 'Human teammates')}</div>
            <div className="space-y-2">
              {humans.map((p) => (
                <div key={p.id} className="bg-cloud rounded-[12px] p-3.5 flex items-center gap-3"
                  style={{ border: '1px solid var(--ink-100)' }}>
                  <Avatar p={p} size={36} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-[14px] text-ink-900 leading-tight">{p.name}</div>
                    <div className="text-[11px] text-ink-500 mt-0.5">{statusLabels[p.status] ? tLabel(statusLabelsKey[p.status], statusLabels[p.status]) : ''}</div>
                  </div>
                  <HumanBadge />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
