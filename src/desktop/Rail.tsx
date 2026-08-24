import { useEffect } from 'react'
import { useApp } from '@/stores/app'
import { useAuth, useMe } from '@/stores/auth'
import { useConversations, isMuted } from '@/stores/conversations'
import { useComputers } from '@/stores/computers'
import { useDevtools } from '@/stores/devtools'
import { useParticipants } from '@/stores/participants'
import { Avatar } from '@/components/Avatar'
import { IChat, IWhisper, IAgent, IAgents, IBoard, IDoc, ICalendar, IObserve, IExit, IShip } from '@/components/icons'
import { api } from '@/api/client'
import { cn } from '@/lib/utils'
import { useT, type MessageKey } from '@/lib/i18n'
import type { Participant, ViewKey } from '@/types'

// `label` is a message key rather than the string itself — the array is
// module scope, so it can't call a translator that re-renders on a
// locale switch. Resolution happens at render.
const baseItems: Array<{ key: ViewKey['view']; Icon: typeof IChat; label: MessageKey }> = [
  { key: 'conversations', Icon: IChat, label: 'nav.conversations' },
  { key: 'whispers', Icon: IWhisper, label: 'nav.whispers' },
  { key: 'shipping', Icon: IShip, label: 'nav.ship' },
  { key: 'boards', Icon: IBoard, label: 'nav.boards' },
  { key: 'calendar', Icon: ICalendar, label: 'nav.calendar' },
  { key: 'documents', Icon: IDoc, label: 'nav.docs' },
  { key: 'agents', Icon: IAgent, label: 'nav.agents' },
  { key: 'me', Icon: IAgents, label: 'nav.me' },
]

export function Rail() {
  const t = useT()
  const view = useApp((s) => s.view)
  const setView = useApp((s) => s.setView)
  const devtoolsEnabled = useDevtools((s) => s.enabled)
  const loadDevtools = useDevtools((s) => s.load)
  // Muted conversations are intentionally excluded from this total — that's
  // the whole point of a mute. Their per-row badges still show in the list.
  const totalUnread = useConversations((s) =>
    s.list.reduce((acc, c) => acc + (isMuted(c) ? 0 : (c.unread ?? 0)), 0),
  )
  // Any paired computer running an outdated daemon → a gold dot on the avatar
  // so the upgrade nudge is visible app-wide, not just inside the You view.
  const daemonOutdated = useComputers((s) => Object.values(s.byId).some((c) => c.daemonOutdated))
  useEffect(() => {
    void loadDevtools()
  }, [loadDevtools])
  // Whispers is the OWNER-ONLY agent-chat observer view (server gates
  // /peek/agent-chats to the company owner). Hide the rail item for non-owners
  // so they never click into a 403/empty view.
  const isOwner = useAuth((s) => s.companies.find((c) => c.id === s.activeCompanyId)?.role === 'owner')
  const assembled = devtoolsEnabled
    ? [
        ...baseItems.slice(0, 3),
        { key: 'observability' as const, Icon: IObserve, label: 'nav.observe' as MessageKey },
        ...baseItems.slice(3),
      ]
    : baseItems
  const items = isOwner ? assembled : assembled.filter((i) => i.key !== 'whispers')
  // The Rail's top avatar is the SIGNED-IN user, not a mock. Resolve the
  // current user's participant record so the Gravatar (set during signup
  // / backfilled at boot) shows up properly. Fall back to a minimal
  // ad-hoc Participant when the store hasn't loaded yet — avoids any
  // flash of "Y on coral" placeholder for the real user.
  const meId = useMe()
  const authUser = useAuth((s) => s.user)
  const byId = useParticipants((s) => s.byId)
  const meParticipant: Participant | null = (meId && byId[meId]) ? byId[meId] : null
  const fallback: Participant = {
    id: authUser?.id ?? 'me',
    kind: 'human',
    name: authUser?.name ?? t('common.you'),
    initial: (authUser?.name ?? 'Y').charAt(0).toUpperCase(),
    avatarBg: 'linear-gradient(135deg, #FF7A6B, #F4B740)',
    status: 'avail',
  } as Participant
  const meAvatar = meParticipant ?? fallback

  return (
    <aside
      className="flex flex-col items-center py-[18px] gap-1.5 border-r border-ink-100"
      style={{ background: 'var(--chrome-rail)' }}
    >
      <button
        className="mb-3.5 relative"
        onClick={() => setView('me')}
        title={daemonOutdated ? t('common.daemonOutdatedTip') : (authUser?.name ?? t('common.you'))}
      >
        <Avatar p={meAvatar} size={44} ringColor="var(--cloud)" />
        {daemonOutdated && (
          <span
            className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full"
            style={{ background: 'var(--gold-deep)', border: '2px solid var(--cloud)' }}
          />
        )}
      </button>

      {items.map(({ key, Icon, label }) => {
        const active = view === key
        const badge = key === 'conversations' && totalUnread > 0 ? totalUnread : undefined
        return (
          <button
            key={key}
            onClick={() => setView(key)}
            title={t(label)}
            aria-label={t(label)}
            className={cn(
              'w-11 h-11 rounded-xl grid place-items-center transition relative',
              active ? 'bg-cloud text-skype-deep shadow-soft' : 'text-ink-500 hover:bg-cloud hover:text-skype-deep',
            )}
          >
            {active && (
              <span className="absolute -left-[18px] top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-r bg-skype" />
            )}
            <Icon className="w-[22px] h-[22px]" />
            {badge !== undefined && (
              <span
                className="absolute top-1.5 right-1.5 min-w-4 h-4 px-1 rounded-full text-[10px] font-bold grid place-items-center"
                style={{ background: 'var(--coral)', color: 'white', border: '2px solid var(--cloud)' }}
              >{badge}</span>
            )}
          </button>
        )
      })}

      <div className="flex-1" />
      <button
        onClick={async () => {
          // Revoke session server-side before clearing local state, so a
          // leaked token isn't valid anywhere after sign out. Best-effort —
          // we still clear locally if the network is down.
          try { await api.authLogout() } catch (e) { console.warn('[signout] server call failed', e) }
          useAuth.getState().clear()
          location.reload()
        }}
        className="w-11 h-11 rounded-xl grid place-items-center text-ink-400 hover:bg-cloud hover:text-coral-deep transition-colors"
        title={t('common.signOut')}
        aria-label={t('common.signOut')}
      >
        <IExit className="w-[22px] h-[22px]" />
      </button>
    </aside>
  )
}
