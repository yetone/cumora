/**
 * Is a tenant-tagged websocket frame for the workspace the user is looking at?
 *
 * The socket is per-USER, not per-workspace, and that is deliberate: the server
 * resolves recipients through company membership so one connection serves every
 * workspace the user belongs to. For a person in two workspaces that means
 * frames from the one they are NOT looking at arrive on the same socket.
 *
 * Most handlers are self-limiting — `participants.status` and
 * `participants.avatar` both bail with `if (!cur) return {}` when the id is not
 * already in the local roster, so a foreign frame is a no-op. A handler that
 * INSERTS has no such backstop, and the roster is what board-card assignees,
 * calendar assignees and mention pickers are drawn from.
 *
 * `commitIfEpochCurrent` already guards the HTTP path against exactly this
 * shape — a response from the previous workspace landing in the current one.
 * This is the websocket half of the same rule.
 *
 * An untagged frame is treated as current: older servers may publish without
 * the tag, and dropping those would be a worse failure than the one being
 * fixed.
 */
export function isForActiveWorkspace(
  eventCompanyId: string | null | undefined,
  activeCompanyId: string | null | undefined,
): boolean {
  if (!eventCompanyId) return true
  return eventCompanyId === activeCompanyId
}
