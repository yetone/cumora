/**
 * Guard: every unread total goes through isMuted(), never the raw flag.
 *
 * `muted` is a cached server value. A conversation muted "for 15 minutes"
 * keeps `muted: true` in the local row until something reloads the list, so a
 * raw read keeps silencing the count after the mute has lapsed.
 * `isMuted()` exists for exactly that, and says so:
 *
 *   "if the user keeps the app open past the expiry (e.g. muted 'for 15 min'
 *    and no traffic happens for 20), the local cached row would still claim
 *    muted=true. Recompute against `now` so the silence wears off without
 *    waiting for the next WS-triggered reload."
 *
 * Ten call sites honoured it. `ChatPane`'s empty stage did not, and it renders
 * on the same screen as the Rail badge — so at 09:16, after a 15-minute mute
 * taken at 09:00 with 4 unread, the Rail showed 4 and the empty stage showed
 * none, side by side.
 *
 * A test of isMuted() cannot catch this: the defect is a caller that never
 * asked. So this reads the source, like the electron guards do, and self-tests
 * its own matcher.
 *
 * Run: node --import tsx --test server/src/__tests__/unread-total-mute.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SRC = join(REPO_ROOT, 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** An unread aggregation that reads the raw flag instead of asking isMuted. */
const RAW_MUTE_IN_UNREAD_SUM = /\bc\.muted\s*\?[^\n]*\bunread\b/

test('no unread total reads the raw muted flag', () => {
  const offenders = walk(SRC)
    .filter((file) => RAW_MUTE_IN_UNREAD_SUM.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(REPO_ROOT.length + 1))
  assert.deepEqual(
    offenders, [],
    `these sum unread against the cached flag instead of isMuted(): ${offenders.join(', ')}`,
  )
})

test('isMuted is still the shared helper, and is still used', () => {
  // If the helper is renamed or the call sites migrate elsewhere, the check
  // above quietly becomes vacuous. Anchor on both.
  const store = readFileSync(join(SRC, 'stores', 'conversations.ts'), 'utf8')
  assert.match(store, /export function isMuted\(/)
  const callers = walk(SRC).filter((f) => /\bisMuted\(/.test(readFileSync(f, 'utf8')))
  assert.ok(callers.length >= 6, `expected isMuted to be widely used, found ${callers.length} files`)
})

// ── the matcher must be able to fail ───────────────────────────────────────

test('the guard rejects the expression that shipped', () => {
  assert.equal(
    RAW_MUTE_IN_UNREAD_SUM.test('list.reduce((n, c) => n + (c.muted ? 0 : (c.unread ?? 0)), 0)'),
    true,
  )
})

test('the guard accepts the corrected expression', () => {
  assert.equal(
    RAW_MUTE_IN_UNREAD_SUM.test('list.reduce((n, c) => n + (isMuted(c) ? 0 : (c.unread ?? 0)), 0)'),
    false,
  )
})

test('the guard leaves unrelated uses of the flag alone', () => {
  // Reading `c.muted` to render a mute icon is fine — only the unread sum is
  // wrong, because only it has an expiry to honour.
  assert.equal(RAW_MUTE_IN_UNREAD_SUM.test('const showBell = c.muted ? "off" : "on"'), false)
})
