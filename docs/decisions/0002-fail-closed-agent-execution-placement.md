# ADR 0002: Fail-closed Agent execution placement

- Status: Accepted
- Date: 2026-09-03

## Context

An Agent can run either on a paired BYOA Computer (`local` or `vps`) or on a
managed Cumora Cloud Pod. An unassigned paid Agent is intentionally eligible
for managed execution, so `computer_id = NULL` is a valid placement state.

The scheduler previously converted every host-resolution exception into the
same nullable shape. A transient PostgreSQL failure could therefore look like
an unassigned Agent, omit the company tier check, and create a managed Pod for
an Agent that was actually assigned to BYOA. The scheduler's earlier lookup was
also the only policy check, leaving a race before `ensurePod` applied the
Kubernetes manifest.

## Decision

- Host resolution is a discriminated result: `found`, `missing`, or `error`.
  A found result always includes a valid tenant and its tier; only an explicit
  `computer_id = NULL` produces an unassigned host.
- Dangling, cross-tenant, revoked, or unknown Computer assignments are invalid
  placement errors. They never fall back to cloud execution.
- The scheduler fails closed on errors. Transient lookup failures enter a
  dedicated wake retry class that is safe for durable message wakes because no
  execution location was selected or started.
- Managed-message triage and host selection live in the same retryable wake
  operation, so a retry cannot bypass the managed-runtime gate.
- `ensurePod` independently verifies that the Agent is active, is not assigned
  to BYOA, and belongs to a paid tenant. It checks at entry and again immediately
  before the first Kubernetes write; the loaded persona must match the same
  tenant.
- `ensurePod` failures carry machine-readable codes. Placement lookup failures
  can be retried without treating ordinary Pod failures as safe message replays.

## Consequences

- A database outage delays a wake instead of changing its execution location.
- Assignment corruption is visible through an alert and cannot cross a tenant,
  credential, or billing boundary.
- Host and tier resolution uses one database snapshot and adds a small cold-path
  query at the final Pod boundary. `ensurePod` is already limited to resting
  managed Agents, so the extra check is preferable to caching mutable policy.
- A BYOA reassignment or free-tier downgrade that races with Pod preparation is
  observed before PVC or Pod creation. Existing Pods are not implicitly deleted;
  lifecycle cleanup remains the assignment controller's responsibility.

## Alternatives considered

- **Catch lookup failures and assume cloud:** rejected because availability
  cannot override execution-location authorization.
- **Trust only the scheduler check:** rejected because callers can invoke
  `ensurePod` directly and placement can change before Kubernetes apply.
- **Cache host/tier decisions:** rejected because per-replica stale placement is
  exactly the unsafe state this boundary is intended to prevent.
- **Hold a database lock across Kubernetes calls:** rejected because external
  control-plane latency would create long transactions and lock contention.
