# ADR 0006: Bind runtime tokens to the exact Agent placement

- Status: Accepted
- Date: 2026-09-05

## Context

Agent runtime JWTs originally pinned only the globally stable Agent id and its
workspace. The runtime server rechecked that workspace and active-participant
state on every request, which revoked a token after a cross-workspace move but
not after a move between Computers in the same workspace. Revoking a paired
Computer likewise revoked its device credential while already minted Agent
JWTs remained usable until their one-hour expiry.

Checking only the Computer id is insufficient. Moving an Agent away and back to
the same Computer would make an older token valid again, and placement changes
can be written by onboarding and repair paths in addition to the main assignment
API.

## Decision

- Every participant row carries an opaque `runtime_assignment_id`. PostgreSQL
  replaces it whenever the participant's workspace, Computer, kind, or active
  departure state changes.
- Runtime JWTs pin `computerId` and `assignmentId` in addition to the Agent and
  workspace ids. Tokens missing either placement claim are rejected.
- Every runtime request compares all four values with the live participant row.
  Assigned Computers must also still exist in the same workspace and not be
  revoked. The same check protects each long-lived wake stream before a ping or
  event is delivered.
- Both BYOA daemons and managed pods mint tokens from the database placement
  snapshot. A managed pod spawn aborts if that placement changes before the
  Kubernetes mutation.
- The assignment rotation is a database trigger rather than application-only
  bookkeeping so bulk and administrative SQL cannot accidentally omit it.

## Consequences

- Moving or offboarding an Agent and revoking its Computer invalidate every
  previously minted runtime token immediately, including move-away/move-back
  sequences.
- Deployment invalidates runtime tokens minted by older builds because they do
  not carry placement claims. BYOA daemons obtain a new token from their
  device-authenticated endpoint; managed pods are recreated through the normal
  scheduler path.
- Every runtime request adds one indexed participant/Computer authorization
  lookup, extending the existing live workspace check rather than adding a
  second query.
- A future placement dimension that should revoke runtime authority must be
  added to the trigger condition and, when independently meaningful, to the
  signed claims.

## Alternatives considered

- **Bind only the workspace:** rejected because a removed or replaced host in
  that workspace retains authority until token expiry.
- **Bind only the Computer id:** rejected because an away-and-back assignment
  revives the old token.
- **Rotate only in `assignAgentToComputer`:** rejected because free-tier
  onboarding, repair tooling, and administrative migrations also update
  placement.
- **Keep a server-side JWT denylist:** rejected because it adds distributed
  mutable state and cleanup work when the participant row is already the live
  authorization source of truth.
