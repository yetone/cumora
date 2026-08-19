/**
 * Guard: no Electron icon may be built from an SVG data URL.
 *
 * `nativeImage.createFromDataURL` only decodes the raster formats Chromium
 * knows (PNG/JPEG/WebP/GIF). An SVG data URL silently yields an EMPTY image —
 * verified against this repo's own bundled Electron: `isEmpty()` true at 0x0,
 * while a PNG buffer decodes fine. There is no error and no warning.
 *
 * The tray already learned this the hard way — its comment records that "the old
 * SVG-based tray icon never appeared" — and moved to raw BGRA bitmaps. The dock
 * unread dot was left on the SVG technique, so `setDockUnreadDot`'s
 * `!img.isEmpty()` guard skipped `setIcon` every time and the dock never showed
 * an unread indicator.
 *
 * electron/ has no runtime test harness, so this is a source-level guard in the
 * same shape as guard-big-brain.test.ts: pin the invariant, and self-test the
 * matcher so it cannot quietly become a no-op.
 *
 * Run: node --import tsx --test server/src/__tests__/electron-native-image.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN_CJS = join(REPO_ROOT, 'electron', 'main.cjs')

/** Lines that hand an SVG payload to a nativeImage decoder. Comments are
 *  ignored — the file legitimately DISCUSSES this trap at length. */
function svgDecoderCalls(source: string): string[] {
  const out: string[] = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    if (!/createFromDataURL|createFromBuffer/.test(line)) continue
    if (!/svg/i.test(line)) continue
    out.push(line)
  }
  return out
}

test('no Electron icon is decoded from an SVG data URL', () => {
  const offenders = svgDecoderCalls(readFileSync(MAIN_CJS, 'utf8'))
  assert.deepEqual(
    offenders, [],
    '\nnativeImage cannot decode SVG — these produce a silently EMPTY image:\n' +
    offenders.map((l) => `  ${l}`).join('\n') +
    '\nRasterise to a BGRA bitmap and use nativeImage.createFromBitmap instead.',
  )
})

test('the dock unread icon is built from a bitmap', () => {
  // The positive half: it is not enough that the SVG is gone, the dot must
  // actually be composited into the icon.
  const src = readFileSync(MAIN_CJS, 'utf8')
  const fn = src.slice(src.indexOf('function getDockUnreadIcon'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
  assert.match(body, /createFromBitmap/, 'getDockUnreadIcon must composite via a raw bitmap')
})

// --- the matcher actually catches a regression (so the guard isn't a no-op) ---

test('the matcher flags an SVG data URL icon', () => {
  const bad = "  dockUnreadIcon = nativeImage.createFromDataURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))"
  assert.equal(svgDecoderCalls(bad).length, 1)
})

test('the matcher ignores a PNG data URL and prose about SVG', () => {
  assert.deepEqual(svgDecoderCalls("  const i = nativeImage.createFromDataURL('data:image/png;base64,' + b64)"), [])
  assert.deepEqual(svgDecoderCalls('  // SVG data URLs silently produce an empty image via createFromDataURL'), [])
})
