/**
 * snapshotUnread must NOT advance lastInboxDrainAt when the /inbox fetch fails.
 *
 * runtimeGet returns null on any failure (network error, non-OK status, JSON
 * parse error). Before this fix, snapshotUnread set lastInboxDrainAt = Date.now()
 * BEFORE the fetch, unconditionally. A failed drain therefore looked identical
 * to a successful one: fallbackPollDue saw a recent lastInboxDrainAt and
 * suppressed retries for INBOX_POLL_STREAM_HEALTHY_MS (2 minutes), leaving
 * messages unread on the server.
 *
 * The fix mirrors the pattern in reportEngineSnapshot (commit ceee872): only
 * advance the watermark AFTER confirming the operation succeeded.
 *
 * This test verifies the invariant structurally: the checkpoint update must sit
 * AFTER the runtimeGet call and be guarded by its result. The same "read the
 * source" technique the scheduler-post-spawn-retry test uses — because the
 * alternative is instantiating an AgentRunner, which requires Redis, Postgres,
 * a device token, and an agent definition.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-inbox-drain-watermark.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fallbackPollDue } from '../agents/computer/daemon.js'

test('snapshotUnread only advances lastInboxDrainAt after a successful fetch', async () => {
  const source = await readFile(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8')

  // Extract snapshotUnread's body.
  const methodStart = source.indexOf('private async snapshotUnread(')
  assert.ok(methodStart !== -1, 'snapshotUnread not found in daemon.ts')
  const body = source.slice(methodStart, methodStart + 800)

  // The runtimeGet call must come BEFORE any lastInboxDrainAt assignment.
  const fetchPos = body.indexOf('runtimeGet<RuntimeInboxResponse>')
  const assignPos = body.indexOf('this.lastInboxDrainAt')
  assert.ok(fetchPos !== -1, 'runtimeGet call not found in snapshotUnread')
  assert.ok(assignPos !== -1, 'lastInboxDrainAt assignment not found in snapshotUnread')
  assert.ok(
    fetchPos < assignPos,
    'lastInboxDrainAt is set BEFORE the fetch — a failed drain suppresses ' +
    'fallbackPollDue retries for 2 minutes while messages sit unread',
  )

  // The assignment must be guarded by the fetch result (inbox is non-null).
  const guardLine = body.slice(assignPos - 80, assignPos)
  assert.match(
    guardLine, /if\s*\(inbox\)/,
    'lastInboxDrainAt must be guarded by `if (inbox)` — an unconditional ' +
    'assignment advances the watermark even when the fetch returned null',
  )
})

test('fallbackPollDue: a stale lastInboxDrainAt triggers the double-check on a healthy stream', () => {
  // The complement: after a failed drain leaves lastInboxDrainAt unchanged,
  // the NEXT tick must see the stale value and drain again rather than waiting.
  // This is the fallbackPollDue behaviour that the bug was suppressing.
  const now = 1_000_000
  const HEALTHY = 120_000

  // A drain that succeeded 10s ago → no retry needed.
  assert.equal(
    fallbackPollDue({ now, streamLastSeenAt: now - 1_000, lastInboxDrainAt: now - 10_000 }),
    false,
  )

  // A drain whose last success is >2min ago (because the recent one failed
  // and did NOT advance the watermark) → retry immediately.
  assert.equal(
    fallbackPollDue({ now, streamLastSeenAt: now - 1_000, lastInboxDrainAt: now - HEALTHY }),
    true,
    'fallbackPollDue must allow a retry when the last successful drain is stale',
  )
})
