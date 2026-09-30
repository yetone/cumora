# Project deletion rollout

Project deletion requires the additive migration 0011, after the board due date
migration 0010. This build accepts both schema 10 and 11, but a rollback image
that only accepts 10 cannot run on 11. Changing the new build's minimum version
alone does not make an old image a safe rollback target.

1. Deploy this build with the Deploy workflow's `schema_target_version` set to
   **10** (the default). The migration job stops at 10. Project deletion returns
   503 until the cleanup table exists; daemon cleanup reads return an empty list.
   Heartbeats and existing project/archive operations keep working. Smoke-test
   the rollout and let it become the known-good deployment baseline.
2. Deploy again with `schema_target_version` set to **11**. This creates the
   cleanup table and activates deletion on restarted servers. If smoke fails,
   automatic recovery now restores a baseline that also understands schema 11.
3. Update paired computer clients. Old clients can still heartbeat, but cannot
   acknowledge cleanup; their pending tasks are kept until an updated client
   reconnects or that computer is revoked.

For a non-Kubernetes migration runner, set `SCHEMA_MIGRATION_TARGET_VERSION=10`
before `npm run migrate` for step 1, and set it to `11` for step 2. Omitting it
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

Migration 0011 in this PR is not released. An earlier draft used 0010 for project
deletion, which now belongs to the board due date migration. Immutable migration
checksums reject that draft history; disposable test databases that applied it
must be recreated.
