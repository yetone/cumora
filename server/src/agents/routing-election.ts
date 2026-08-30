/**
 * Primary election for the `one-of-us` route (#70).
 *
 * The router (`routing.ts`) only answers whether an unaddressed human group
 * message needs the whole room (`each`) or ONE agent to take the turn
 * (`one-of-us`), and may propose that one agent by role fit. Everything that
 * must be deterministic across replicas happens HERE, in code, with no I/O:
 *
 *   - ordering: available agents first, stable id tie-break inside each class;
 *   - validation: a router proposal that is not a real candidate is ignored;
 *   - fallback: no valid proposal → the first ordered candidate.
 *
 * "Available" mirrors the busy-status lease the rest of the system uses
 * (`BUSY_STATUS_LEASE_MS`): an agent whose `status` is thinking/working/waiting
 * with a fresh `status_updated_at` is mid-turn elsewhere, and electing it would
 * queue a new room behind a turn it is already running. Stale busy states read
 * as available, same contract as the status pill.
 *
 * Deterministic tie-breaking matters because two replicas can evaluate the
 * same message (the per-message wake-claim makes it rare, not impossible) and
 * they must agree without coordinating. Membership order is a SQL artifact, so
 * it is never trusted: ids sort lexicographically inside each availability
 * class.
 */

/** One wake candidate as read from `participants` for this conversation. */
export interface ElectionCandidate {
  id: string
  role: string | null
  status: string | null
  /** Fresh `status_updated_at` makes a busy status real; a stale one is expired. */
  statusUpdatedAt: Date | null
}

const BUSY_STATUSES = new Set(['thinking', 'working', 'waiting'])

export function isBusyCandidate(c: ElectionCandidate, now: number, leaseMs: number): boolean {
  if (!c.status || !BUSY_STATUSES.has(c.status)) return false
  if (!c.statusUpdatedAt) return true
  return now - c.statusUpdatedAt.getTime() < leaseMs
}

/** Ordered candidate ids: available first, each class sorted by id. */
export function orderCandidates(
  candidates: readonly ElectionCandidate[],
  opts: { now?: number; leaseMs?: number } = {},
): string[] {
  const now = opts.now ?? Date.now()
  const leaseMs = opts.leaseMs ?? Number.POSITIVE_INFINITY
  const available: string[] = []
  const busy: string[] = []
  for (const c of candidates) {
    (isBusyCandidate(c, now, leaseMs) ? busy : available).push(c.id)
  }
  return [...available.sort(compareIds), ...busy.sort(compareIds)]
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The election result: `lineup[0]` is the elected primary, the rest is the
 *  deterministic fallback order the lease sweep walks when a primary goes
 *  quiet. */
export interface Election {
  lineup: string[]
  primary: string
}

/** Combine the router's role-fit proposal with the deterministic order:
 *
 *  - a proposal for an AVAILABLE candidate wins — role fit is the one signal
 *    the router has that code does not;
 *  - no proposal (or a proposal for a non-candidate / mid-turn agent) → the
 *    first available candidate in stable order;
 *  - the whole room busy → the proposal if it is a candidate, else the head of
 *    the order — waking a mid-turn agent queues the message behind its current
 *    turn (and steers it), which still beats no one being woken.
 *
 *  `null` only when the room is empty — the caller must fan out. */
export function electLineup(
  proposal: string | null | undefined,
  candidates: readonly ElectionCandidate[],
  opts: { now?: number; leaseMs?: number } = {},
): Election | null {
  const ordered = orderCandidates(candidates, opts)
  if (ordered.length === 0) return null
  const now = opts.now ?? Date.now()
  const leaseMs = opts.leaseMs ?? Number.POSITIVE_INFINITY
  const busy = new Set(
    candidates.filter((c) => isBusyCandidate(c, now, leaseMs)).map((c) => c.id),
  )
  const available = ordered.filter((id) => !busy.has(id))
  const primary =
    (proposal && available.includes(proposal) ? proposal : null) ??
    available[0] ??
    (proposal && busy.has(proposal) ? proposal : null) ??
    ordered[0]
  return { lineup: [primary, ...ordered.filter((id) => id !== primary)], primary }
}
