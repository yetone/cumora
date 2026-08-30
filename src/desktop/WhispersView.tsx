import { useEffect, useState } from 'react'
import { useWhispers } from '@/stores/whispers'
import { useParticipants } from '@/stores/participants'
import { WhisperRoom } from '@/components/WhisperRoom'
import { HiveAvatar } from '@/components/HiveAvatar'
import { ResizeHandle } from '@/components/ResizeHandle'
import { cn } from '@/lib/utils'
import { useT } from '@/lib/i18n'
import { useResizableWidth } from '@/lib/useResizableWidth'
import type { Participant } from '@/types'

function StubRoom() {
  const t = useT()
  return (
    <main className="grid place-items-center text-center"
      style={{
        background: 'var(--whispers-wash)',
      }}>
      <div>
        <div className="font-display font-medium text-[28px] text-ink-900 mb-2" style={{ letterSpacing: '-0.02em' }}>
          {t('whispers.noWhispers')}
        </div>
        <div className="font-display italic text-[14px] text-ink-500 max-w-md leading-relaxed">
          {t('whispers.noWhispersBody')}
        </div>
      </div>
    </main>
  )
}

export function WhispersView() {
  const t = useT()
  const list = useWhispers((s) => s.list)
  const byId = useParticipants((s) => s.byId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { width, onResizeStart } = useResizableWidth('sidebar:whispers', 320, { min: 240, max: 520 })

  useEffect(() => {
    void useWhispers.getState().loadList()
  }, [])

  useEffect(() => {
    if (!selectedId && list[0]) setSelectedId(list[0].id)
  }, [list, selectedId])

  return (
    <div className="grid h-full overflow-hidden"
      style={{ gridTemplateColumns: `${width}px 1fr` }}>
      <aside className="relative flex flex-col overflow-hidden border-r border-ink-100 bg-paper">
        <div className="px-[18px] pt-[18px] pb-3">
          <h1 className="font-display font-medium text-[26px] tracking-tight text-ink-900 leading-none mb-1">
            {t('whispers.title')}
          </h1>
          <div className="text-[12px] text-ink-500 font-display italic">
            {t('whispers.subtitle')} · <b className="not-italic text-whisper-deep font-semibold">{list.length}</b>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-[18px]">
          {list.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-ink-300 italic font-display">
              {t('whispers.empty')}
            </div>
          )}
          {list.map((w) => {
            // Resolve every member to a participant record. Skip rows where
            // any member hasn't loaded yet (they'll reappear on next refresh).
            const ms = w.members
              .map((id) => byId[id])
              .filter((p): p is Participant => Boolean(p))
            if (ms.length < 2) return null
            const isSelected = w.id === selectedId
            const isGroup = w.kind === 'group' || ms.length > 2
            // Compact "A, B & N more" label so the row truncates gracefully.
            const namesLabel = ms.length <= 2
              ? null
              : ms.length === 3
                ? t('whispers.andOneMore', { a: ms[0].name, b: ms[1].name })
                : t('whispers.andNMore', { a: ms[0].name, b: ms[1].name, n: ms.length - 2 })
            return (
              <button
                type="button"
                key={w.id}
                onClick={() => setSelectedId(w.id)}
                className={cn(
                  // Avatar column and gap mirror ConversationsPane so a
                  // whisper row visually matches a conversation row.
                  'w-full text-left grid grid-cols-[44px_1fr_auto] gap-[11px] py-2.5 px-3 rounded-[12px] items-center transition mb-0.5',
                  !isSelected && 'hover:bg-whisper-50',
                )}
                style={isSelected ? {
                  background: 'var(--whisper-50)',
                  boxShadow: 'inset 0 0 0 1px var(--whisper-100)',
                } : undefined}
              >
                <HiveAvatar ps={ms} size={44} ringColor="var(--paper)" />
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold text-ink-900 mb-0.5 truncate flex items-center gap-1.5">
                    {isGroup ? (
                      <span className="truncate">{w.title || namesLabel}</span>
                    ) : (
                      <>
                        <span className="truncate">{ms[0].name}</span>
                        <span className="text-whisper text-[11px] shrink-0">↔</span>
                        <span className="truncate">{ms[1].name}</span>
                      </>
                    )}
                  </div>
                  <div className="text-[11.5px] text-ink-500 leading-[1.4] truncate font-display italic">
                    {isGroup && namesLabel
                      ? namesLabel
                      : (w.about ?? t('whispers.privateThread'))}
                    <span className="not-italic text-ink-300"> · {w.msgCount}</span>
                  </div>
                </div>
                <div className="text-[10.5px] text-ink-300 tabular-nums">
                  {new Date(w.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
              </button>
            )
          })}
        </div>
        <ResizeHandle onMouseDown={onResizeStart} />
      </aside>

      {selectedId ? <WhisperRoom pairId={selectedId} /> : <StubRoom />}
    </div>
  )
}
