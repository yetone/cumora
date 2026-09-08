/**
 * A websocket frame from the other workspace must not join this workspace's
 * roster.
 *
 * The socket is per-USER and deliberately carries every workspace the user
 * belongs to — the server resolves recipients through company membership, so
 * one connection serves them all. For someone in two workspaces, that means
 * frames from the one they are NOT looking at arrive on the same socket.
 *
 * Two of the three roster handlers are self-limiting: `participants.status` and
 * `participants.avatar` both do `if (!cur) return {}`, so a foreign id is a
 * no-op. `participants.added` INSERTS, and had no company check at all — the
 * client type did not even declare `companyId`, although the server has always
 * tagged the event (`ParticipantAddedEvent extends TenantTagged`, published
 * with `companyId` at onboardCompany.ts:398).
 *
 * The roster is what board-card assignee pickers, calendar assignees and
 * mention lists are drawn from, so a foreign agent landing in `byId` is
 * selectable — and `POST /boards/:id/cards` stores `assignee_id` without
 * checking that the participant exists in that workspace.
 *
 * `commitIfEpochCurrent` (see workspace-context-epoch.test.ts) already guards
 * the HTTP path against the same shape: a response from the previous workspace
 * committing into the current one. This is the websocket half of that rule.
 *
 * Run: node --import tsx --test server/src/__tests__/ws-tenant-events.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isForActiveWorkspace } from '../../../src/lib/tenant-events'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('a frame from another workspace is not for the active one', () => {
  assert.equal(isForActiveWorkspace('co-b', 'co-a'), false)
})

test('a frame from the active workspace is', () => {
  assert.equal(isForActiveWorkspace('co-a', 'co-a'), true)
})

test('an untagged frame is treated as current', () => {
  // Older servers may publish without the tag. Dropping those would break the
  // roster entirely, which is worse than the contamination being fixed.
  for (const missing of [undefined, null, '']) {
    assert.equal(isForActiveWorkspace(missing, 'co-a'), true, JSON.stringify(missing))
  }
})

test('a tagged frame is dropped while no workspace is active', () => {
  // Before the first workspace resolves, activeCompanyId is null. Inserting a
  // roster entry then would attribute it to whichever workspace loads next.
  assert.equal(isForActiveWorkspace('co-b', null), false)
  assert.equal(isForActiveWorkspace('co-b', undefined), false)
})

test('matching is exact, not a prefix', () => {
  // Workspace ids are user-chosen slugs, so 'acme' and 'acme-eu' coexist.
  assert.equal(isForActiveWorkspace('acme-eu', 'acme'), false)
  assert.equal(isForActiveWorkspace('acme', 'acme-eu'), false)
})

// ── and the handler that needs it actually asks ────────────────────────────

test('the participants.added handler is the one gated', () => {
  // A pure predicate cannot catch a handler that simply stops calling it, and
  // this handler is the only one that inserts. Assert the shape of the source,
  // the way the electron guards do.
  const store = readFileSync(join(REPO_ROOT, 'src', 'stores', 'participants.ts'), 'utf8')
  const branch = store.slice(store.indexOf("e.type === 'participants.added'"))
  assert.ok(branch, "the participants.added branch moved — update this guard alongside the refactor")
  const guardAt = branch.indexOf('isForActiveWorkspace(')
  const insertAt = branch.indexOf('useParticipants.setState(')
  assert.ok(guardAt >= 0, 'participants.added no longer checks the frame\'s workspace')
  assert.ok(insertAt >= 0, 'the upsert moved — update this guard alongside the refactor')
  assert.ok(guardAt < insertAt, 'the workspace check must run before the upsert, not after')
})

test('the sibling handlers still guard themselves', () => {
  // They are safe because they bail on an unknown id. If that changes, they
  // need the same company check and this test is where that shows up.
  const store = readFileSync(join(REPO_ROOT, 'src', 'stores', 'participants.ts'), 'utf8')
  const avatar = store.slice(store.indexOf("e.type === 'participants.avatar'"))
  assert.match(avatar.slice(0, 600), /if \(!cur\) return \{\}/)
})
