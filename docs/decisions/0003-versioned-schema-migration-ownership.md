# ADR 0003: Versioned schema migrations with one deployment owner

- Status: Accepted
- Date: 2026-09-03

## Context

The server historically called one large idempotent DDL batch before opening
its HTTP listener. Kubernetes also ran the same command in every application
Pod's init container. An advisory lock serialized replicas, but restart,
autoscaling, rollout, and schema ownership still shared one failure domain.
Even a no-op batch requested locks across many hot tables, and a derived
sentinel probe had previously declared a partially upgraded schema current.

The repository already has a standalone migration entry point and a manually
approved Deploy workflow. Those are the appropriate ownership boundary; an
application replica has no reason to create or alter schema while starting.

## Decision

- Schema changes are an append-only ordered manifest. PostgreSQL records each
  exact `version`, `name`, and SHA-256 checksum in `schema_migrations`.
- An applied entry may never be edited or reordered. A checksum mismatch,
  missing prefix, or unknown future entry fails closed.
- One candidate-image Kubernetes Job runs `npm run migrate` before the Deploy
  workflow mutates the application Deployment. Failure leaves the current
  ReplicaSet untouched.
- The migration Job copies the production Cloud SQL proxy and workload identity
  settings, runs required index validity gates, and exits before rollout.
- Application Pods contain no migration init container. Startup performs one
  read-only ledger query and accepts only the schema range declared by that
  application build.
- An advisory lock remains defense in depth for accidentally duplicated deploy
  jobs; it is no longer coordination among application replicas.
- Future schema changes use expand/contract sequencing. A migration must remain
  compatible with the old application revision serving during a rolling
  update; destructive contraction occurs only after the old revision can no
  longer be restored.

## Consequences

- Restarting or scaling the API does not acquire DDL locks and cannot replay
  historical backfills.
- Deployment has an explicit schema promotion gate with durable, auditable
  version identity and required-index health.
- A first adoption run executes the frozen legacy baseline once and records it.
  Subsequent runs read the ledger and execute only newly appended versions.
  The baseline is sent one statement at a time with per-statement lock
  retries: as a single implicit transaction it holds AccessExclusiveLocks on
  ~30 tables until commit and deadlocks against live traffic on every attempt
  (the first v0.14.0 adoption Job failed that way). Every baseline statement
  is idempotent, so a rerun after a partial batch resumes safely; versions
  after the baseline keep their single-transaction atomicity.
- Local development and manual Kubernetes installation must run
  `npm run migrate` before starting the server; `npm run dev:all` performs that
  one explicit step automatically.
- Rollback compatibility is a release-design responsibility. A schema change
  outside the old build's declared range can intentionally prevent unsafe
  rollback rather than letting an old binary interpret unknown state.

## Alternatives considered

- **Keep DDL on every startup behind an advisory lock:** rejected because the
  lock serializes writers but does not separate schema failure from replica
  availability or prevent repeated hot-table lock attempts.
- **Keep a per-Pod migration init container:** rejected because every surge,
  restart, and scale-out becomes a schema owner and delays readiness.
- **Infer currency from tables, columns, or sentinel indexes:** rejected because
  absence lists drift and cannot prove which immutable transformation ran.
- **Allow checksum drift for idempotent SQL:** rejected because changing the
  meaning of an applied version destroys reproducibility and rollback evidence.
