/**
 * Guard: the tray unread dot must not sit behind the macOS early-return.
 *
 * `setDockUnreadDot` is the only path a change in unread state travels — the
 * renderer sends `dock:set-unread-dot`, main calls this, and nothing else
 * carries the value. The function mirrors the state to the system tray, which
 * is the Windows/Linux surface for exactly the same indicator; the tray section
 * says so itself: "Menu bar item on macOS, system tray on Win/Linux. Same
 * unread-dot indicator the dock uses."
 *
 * The mirror call was placed AFTER `if (process.platform !== 'darwin') return`.
 * So on Windows and Linux it was unreachable, and the only other call to
 * `setTrayUnreadDot` is the one-shot restore inside tray creation. The tray
 * image was therefore set once, at startup, from a state that is false then,
 * and never updated again — the dot could never appear on those platforms.
 *
 * electron/ has no runtime test harness, so this is a source-level guard in the
 * same shape as electron-native-image.test.ts: pin the ordering, and self-test
 * the matcher so it cannot quietly become a no-op.
 *
 * Run: node --import tsx --test server/src/__tests__/electron-tray-unread-dot.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN_CJS = join(REPO_ROOT, 'electron', 'main.cjs')

/** The body of `setDockUnreadDot`, or null if the function moved or was renamed. */
function dockUnreadDotBody(source: string): string | null {
  const match = source.match(/function setDockUnreadDot\([^)]*\)\s*\{([\s\S]*?)\n\}/)
  return match ? match[1] : null
}

/** Does the tray mirror run before the macOS-only bail-out? */
function mirrorsTrayBeforeDarwinReturn(body: string): boolean {
  const mirror = body.indexOf('setTrayUnreadDot(')
  const bail = body.search(/if \(process\.platform !== 'darwin'[^)]*\) return/)
  if (mirror < 0 || bail < 0) return false
  return mirror < bail
}

test('the tray mirror runs before the macOS-only return', () => {
  const body = dockUnreadDotBody(readFileSync(MAIN_CJS, 'utf8'))
  assert.ok(body, 'setDockUnreadDot not found — update this guard alongside the refactor')
  assert.ok(
    mirrorsTrayBeforeDarwinReturn(body),
    'setTrayUnreadDot is unreachable on Windows/Linux: it sits after the darwin early-return',
  )
})

test('setDockUnreadDot is still the only path a change arrives on', () => {
  // If a second updater appears, this guard stops being the whole story and
  // whoever adds it should see that here rather than discover it on Windows.
  const source = readFileSync(MAIN_CJS, 'utf8')
  const calls = source.match(/(?<!function )setTrayUnreadDot\(/g) ?? []
  assert.equal(
    calls.length, 2,
    `expected the mirror in setDockUnreadDot plus the one-shot restore in tray creation, found ${calls.length}`,
  )
  assert.match(source, /ipcMain\.on\('dock:set-unread-dot'/)
})

// ── the matcher must be able to fail ───────────────────────────────────────

test('the guard rejects the ordering that shipped', () => {
  const broken = [
    "  dockUnreadDotVisible = !!visible",
    "  if (process.platform !== 'darwin' || !app.dock) return",
    "  scheduleRegularDockRepair()",
    "  setTrayUnreadDot(dockUnreadDotVisible)",
  ].join('\n')
  assert.equal(mirrorsTrayBeforeDarwinReturn(broken), false)
})

test('the guard accepts the ordering that works', () => {
  const fixed = [
    "  dockUnreadDotVisible = !!visible",
    "  setTrayUnreadDot(dockUnreadDotVisible)",
    "  if (process.platform !== 'darwin' || !app.dock) return",
  ].join('\n')
  assert.equal(mirrorsTrayBeforeDarwinReturn(fixed), true)
})

test('the anchor fails loudly rather than silently passing', () => {
  assert.equal(dockUnreadDotBody('function somethingElse() {\n  return 1\n}'), null)
})
