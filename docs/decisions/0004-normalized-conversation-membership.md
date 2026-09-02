# ADR 0004: Normalized conversation membership as authorization truth

- Status: Accepted
- Date: 2026-09-03

## Context

`conversations.members` was a JSONB array used simultaneously as an API
projection, an authorization boundary, and a routing index. It could not carry
tenant-scoped foreign keys. Invite, leave, and kick paths also rewrote the
whole array, so overlapping requests could lose a change, resurrect a removed
member, or commit a system notice that disagreed with the effective access
state. Correctness depended on every caller remembering the same predicates
and Redis publishing happened outside the membership transaction.

Email threads additionally used synthetic `external:<addr>` author markers in
the array. Those markers identify message authors, but they are not tenant
participants and must never become authorization principals.

## Decision

- `conversation_members` is the sole authorization and routing source. Its
  composite foreign keys bind each row to both the conversation tenant and an
  actual participant in that tenant.
- Membership changes insert or delete one normalized row while holding active
  participant locks followed by the conversation lock. Authorization is
  re-read in a separate statement after the conversation lock is acquired so
  a lock wait cannot retain an obsolete statement snapshot.
- The membership row, derived JSONB projection, system audit message, sequence
  counter, and realtime outbox record commit in one PostgreSQL transaction.
- `conversations.members` remains only as a response-shape compatibility
  projection for the new application. A database function rebuilds it from
  normalized rows. During the expand release, a trigger translates writes from
  the previous application revision into tenant-validated normalized rows and
  canonicalizes the projection under the same row lock.
- A conversation insert trigger converts the initial JSONB input into
  normalized rows. Synthetic external email author markers are discarded;
  any other missing or cross-tenant participant fails closed.
- Production authorization, recipient fan-out, member counts, and direct-pair
  lookup use the normalized indexes. The former JSONB GIN path and its
  session-level query-planner override are no longer runtime dependencies.

## Consequences

- PostgreSQL enforces tenant integrity and prevents orphan or foreign member
  identifiers rather than relying on route-level convention.
- Concurrent invites, leaves, and kicks serialize without whole-array lost
  updates; a failed audit or outbox write rolls the membership change back.
- Participant tenant reassignment must first detach the participant from old
  conversations. This explicit cleanup replaces stale cross-tenant member ids.
- Legacy and API consumers may continue reading `conversations.members`, but
  new code must not use that projection for authorization or routing.
- The expand release retains the legacy JSONB index and synchronization ingress
  so the previous revision can serve safely during rollout or rollback. A later
  contract release may reject projection writes and drop that index only after
  the pre-0002 revision is outside the rollback window.
- Migration 0002 backfills and canonicalizes existing rows. It rejects unknown
  internal member ids while intentionally removing external email markers.

## Alternatives considered

- **Keep JSONB and centralize array helpers:** rejected because application
  helpers cannot provide foreign keys, prevent ad hoc writes, or give the
  planner a relational tenant/member index.
- **Add only a JSONB projection trigger:** rejected because the array would
  remain the writable truth and every authorization query would still depend
  on denormalized containment semantics.
- **Use Redis sets as membership truth:** rejected because message, audit, and
  access changes need one durable transaction; Redis cannot share PostgreSQL's
  commit boundary.
- **Store external email addresses as participants:** rejected because an
  inbound address is an author identity, not an authenticated workspace
  principal, and would expand the authorization domain unnecessarily.
