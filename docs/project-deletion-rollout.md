# Project deletion rollout

Project deletion requires the additive migration 0010. This build accepts both
schema 9 and 10, but old images accept only 9. Changing the new build's minimum
version alone does not make an old image a safe rollback target.

1. Deploy this build with the Deploy workflow's `schema_target_version` set to
   **9** (the default). The migration job stops at 9. Project deletion returns
   503 until the cleanup table exists; daemon cleanup reads return an empty list.
   Heartbeats and existing project/archive operations keep working. Smoke-test
   the rollout and let it become the known-good deployment baseline.
2. Deploy again with `schema_target_version` set to **10**. This creates the
   cleanup table and activates deletion on restarted servers. If smoke fails,
   automatic recovery now restores a baseline that also understands schema 10.
3. Update paired computer clients. Old clients can still heartbeat, but cannot
   acknowledge cleanup; their pending tasks are kept until an updated client
   reconnects or that computer is revoked.

For a non-Kubernetes migration runner, set `SCHEMA_MIGRATION_TARGET_VERSION=9`
before `npm run migrate` for step 1, and set it to `10` for step 2. Omitting it
runs all known migrations, appropriate for a fresh development database. A lower
target never downgrades an already migrated database.

Deletion clears database memories in the project transaction and records pending
computer IDs. Online computers receive a control-stream nudge. Startup/reconnect
fetches at most 50 pending project IDs at a time; successful local cleanup is
acknowledged. Local cleanup stops affected running engines before removing their
project directories, then normal agent reconciliation restarts them.

Project-scoped application memory writes check project existence immediately
before insertion. There are no triggers, advisory locks, or added heartbeat
queries. The server retries a bounded batch of cleanup jobs once per minute,
performs one delayed database cleanup after five minutes for racing writes, and
retries unacknowledged device notifications hourly. Clients retry failed cleanup
on notification or reconnection. Completed records are removed; offline-device
tasks have no expiry. These are eventual-cleanup semantics, not a
serializable guarantee against arbitrary writers bypassing application APIs.

Migration 0010 in this PR is not released. Do not apply this revised migration on
top of the earlier draft 0010: immutable migration checksums intentionally reject
that history. Disposable test databases using the old draft must be recreated.
