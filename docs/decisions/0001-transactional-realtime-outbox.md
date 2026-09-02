# ADR 0001: Transactional outbox for durable realtime invalidations

- Status: Accepted
- Date: 2026-09-02

## Context

Boards, documents, and calendar commands persist their source-of-truth state
in PostgreSQL and notify connected clients through Redis pub/sub. Previously a
handler committed PostgreSQL and then awaited Redis. During a Redis outage the
command could return an error after it had already succeeded, encouraging a
retry that created a duplicate entity; a process crash between commit and
publish could also lose the invalidation.

Redis pub/sub is a realtime transport, not durable command state. Clients
already treat these events as thin invalidations and reconcile by reading the
PostgreSQL-backed API.

## Decision

- Durable board, document, and calendar mutations insert a fully formed event
  into `realtime_outbox` in the same PostgreSQL transaction.
- A per-process worker claims rows with `FOR UPDATE SKIP LOCKED` and a lease,
  then publishes through the bounded Redis command client after commit.
- Delivery is at-least-once. Every payload carries a stable `deliveryId`;
  current consumers are naturally idempotent because they refetch or replace
  entities by id.
- Failed delivery uses exponential backoff. Invalidations are discarded after
  12 attempts or 24 hours; clients recover on their next pull. Discards are
  logged as errors rather than blocking writes forever.
- Board, document, and calendar create commands accept an actor-scoped
  `requestId`. A payload hash rejects accidental key reuse, while a retry of
  identical input returns the original entity.

## Consequences

- PostgreSQL commit is the only success boundary for these commands; Redis
  latency and outages no longer change the response.
- Multiple server replicas can drain concurrently without publishing the same
  claimed row under normal operation. A crash after publish but before the
  acknowledgement may redeliver once, which consumers must tolerate.
- Operators can inspect pending rows, attempts, age, and `last_error` directly
  in `realtime_outbox`. A growing pending queue means realtime is degraded, not
  that durable writes are failing.
- The outbox adds a small PostgreSQL write per mutation. Bounded cleanup keeps
  successful rows for 24 hours and discarded rows for seven days, providing an
  operational window without allowing terminal history to grow indefinitely.

## Alternatives considered

- **Await Redis after commit:** rejected because it reports ambiguous command
  outcomes and cannot close the commit/publish crash gap.
- **Fire-and-forget Redis only:** rejected because it removes request latency
  but silently loses invalidations during outages.
- **A dedicated broker:** deferred; the current invalidation volume does not
  justify another source of truth, and PostgreSQL already owns the transaction.
