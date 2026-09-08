/**
 * The window opens at the size the user left it.
 *
 * One expression answered two different questions:
 *
 *   const wa = screen.getPrimaryDisplay().workArea
 *   const initW = Math.min(saved.width ?? DEFAULT_WINDOW_STATE.width, Math.round(wa.width * 0.9))
 *
 * The 90% cap is described, correctly, as protecting FIRST RUN: the 1480×920
 * default would exceed a small laptop and macOS would clamp it, so the app felt
 * like it opened fullscreen. But it was applied to the SAVED size too, so every
 * launch shaved 10% off the size the user chose — and `persistState` writes the
 * new bounds back on the first resize event, so the original was overwritten.
 *
 * Multi-monitor made it worse: the cap read the PRIMARY display's work area
 * regardless of which display the window was restored onto. A window sized
 * 2300×1300 on an external came back at the laptop's 90%, roughly a third of
 * its area, and that third was then saved over the original.
 *
 * Run: node --import tsx --test server/src/__tests__/electron-window-size.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { initialWindowSize } = require('../../../electron/window-size.cjs') as {
  initialWindowSize: (
    saved: { width?: number; height?: number } | null,
    defaults: { width: number; height: number },
    workArea: { width: number; height: number },
    restoring: boolean,
  ) => { width: number; height: number }
}

const DEFAULTS = { width: 1480, height: 920 }
/** MacBook Air 13", after the menu bar. */
const LAPTOP = { width: 1470, height: 931 }
const EXTERNAL = { width: 2560, height: 1440 }

// ── restoring: the user's size, not 90% of it ──────────────────────────────

test('a size that fits is restored exactly', () => {
  const saved = { width: 1460, height: 925 }
  assert.deepEqual(initialWindowSize(saved, DEFAULTS, LAPTOP, true), saved)
})

test('a large size on the external display survives', () => {
  // The old code capped this against the LAPTOP's work area even though the
  // window was being restored onto the external, and persistState then wrote
  // the shrunken size back.
  const saved = { width: 2300, height: 1300 }
  assert.deepEqual(initialWindowSize(saved, DEFAULTS, EXTERNAL, true), saved)
})

test('restoring is idempotent — the size does not creep down', () => {
  // Relaunch three times; the size the user chose must not decay.
  let size = { width: 1460, height: 925 }
  for (let i = 0; i < 3; i++) size = initialWindowSize(size, DEFAULTS, LAPTOP, true)
  assert.deepEqual(size, { width: 1460, height: 925 })
})

test('a saved size larger than the display it lands on is fitted, not shrunk further', () => {
  // The external was unplugged. Bound it to what is left — but to the whole
  // work area, not 90% of it.
  assert.deepEqual(
    initialWindowSize({ width: 2300, height: 1300 }, DEFAULTS, LAPTOP, true),
    { width: 1470, height: 931 },
  )
})

// ── first run: the cap the comment describes ───────────────────────────────

test('first run is capped to 90% so it does not feel fullscreen', () => {
  assert.deepEqual(
    initialWindowSize(DEFAULTS, DEFAULTS, LAPTOP, false),
    { width: 1323, height: 838 },
  )
})

test('first run on a large display gets the configured default, not 90% of the screen', () => {
  // The default is the ceiling; the cap only ever lowers it.
  assert.deepEqual(initialWindowSize(DEFAULTS, DEFAULTS, EXTERNAL, false), DEFAULTS)
})

test('a saved record missing its size falls back to the default', () => {
  assert.deepEqual(
    initialWindowSize({}, DEFAULTS, EXTERNAL, true),
    DEFAULTS,
  )
  assert.deepEqual(initialWindowSize(null, DEFAULTS, EXTERNAL, true), DEFAULTS)
})

// ── the regression, stated as the difference ───────────────────────────────

test('restoring and first-run no longer produce the same number', () => {
  // This equality IS the bug: the old code could not tell the two apart.
  const saved = { width: 1460, height: 925 }
  const restored = initialWindowSize(saved, DEFAULTS, LAPTOP, true)
  const firstRun = initialWindowSize(DEFAULTS, DEFAULTS, LAPTOP, false)
  assert.notDeepEqual(restored, firstRun)
  assert.ok(restored.width > firstRun.width)
})
