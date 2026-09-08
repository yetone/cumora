import { useEffect, useRef } from 'react'
import { api, ws } from '@/api/client'
import { useAuth } from '@/stores/auth'
import { useConversations } from '@/stores/conversations'
import { useParticipants } from '@/stores/participants'

/** Keeps the auth company's list in sync when another owner/admin changes this
 * user's role or removes/deletes a workspace. The server targets terminal
 * removal frames directly, so this also works after membership is gone. */
export function WorkspaceSessionBridge() {
  const meId = useAuth((s) => s.user?.id ?? null)
  const setMe = useAuth((s) => s.setMe)
  const setServerCapabilities = useAuth((s) => s.setServerCapabilities)
  const refreshing = useRef(false)
  const refreshQueued = useRef(false)

  useEffect(() => {
    void ws.connect()

    const refreshMembership = async () => {
      if (refreshing.current) {
        refreshQueued.current = true
        return
      }
      refreshing.current = true
      try {
        do {
          refreshQueued.current = false
          try {
            const session = await api.authMe()
            // Snapshot immediately before committing. A local delete may have
            // updated auth state while this request was in flight.
            const before = useAuth.getState()
            setMe(session.user, session.companies, session.activeCompanyId)
            setServerCapabilities(session.serverCapabilities)
            const after = useAuth.getState()
            const beforeIds = before.companies.map((company) => company.id).sort().join('\n')
            const afterIds = after.companies.map((company) => company.id).sort().join('\n')
            if (before.activeCompanyId !== after.activeCompanyId || beforeIds !== afterIds) ws.reconnect()
          } catch (error) {
            console.warn('[workspace] failed to refresh membership state', error)
          }
        } while (refreshQueued.current)
      } finally {
        refreshing.current = false
      }
    }

    return ws.on((event) => {
      if (event.type !== 'workspace.membership' || !meId || !event.recipientUserIds.includes(meId)) return
      if (event.kind === 'workspace_deleted' || event.userId === meId) {
        void refreshMembership()
        return
      }
      // A colleague was removed. The current user's auth state is unchanged,
      // but participant and non-direct conversation rosters need reconciling.
      if (event.kind === 'removed') {
        void Promise.all([
          useParticipants.getState().refresh(),
          useConversations.getState().reload(),
        ])
      }
    })
  }, [meId, setMe, setServerCapabilities])

  return null
}
