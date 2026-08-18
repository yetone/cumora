/**
 * Guard: every packaged renderer entry point must load over `app://`.
 *
 * electron/main.cjs's header explains at length why `file://` cannot work for
 * the packaged renderer — the Vite bundle's absolute `/assets/…` imports
 * resolve outside the asar and 404, so nothing mounts. The main window was
 * moved to `app://cumora/index.html` for exactly that reason; the notification
 * window was left behind on `file://` and was therefore dead in every packaged
 * build (no toast ever rendered, so `notification:ready` never fired and pushes
 * queued forever).
 *
 * electron/ has no runtime test harness — it needs a real Electron process — so
 * this is a source-level guard in the same shape as guard-big-brain.test.ts:
 * pin the invariant against the live file, and self-test the matcher so the
 * guard can't quietly become a no-op.
 *
 * Run: node --import tsx --test server/src/__tests__/electron-renderer-url.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN_CJS = join(REPO_ROOT, 'electron', 'main.cjs')

/** The `loadURL(...)` / `return ...` targets a packaged build would use.
 *  We deliberately ignore anything guarded by `isDev`, which legitimately
 *  points at the Vite dev server over http. */
function packagedRendererUrls(source: string): string[] {
  const out: string[] = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*')) continue
    if (line.includes('isDev')) continue
    // Any string literal that names an index.html we hand to a BrowserWindow.
    if (!/index\.html/.test(line)) continue
    if (!/loadURL|return\s/.test(line)) continue
    out.push(line)
  }
  return out
}

test('no packaged renderer entry point loads over file://', () => {
  const urls = packagedRendererUrls(readFileSync(MAIN_CJS, 'utf8'))
  assert.ok(urls.length > 0, 'found no renderer entry points — the matcher has drifted')
  const offenders = urls.filter((l) => l.includes('file://'))
  assert.deepEqual(
    offenders, [],
    '\nA packaged renderer would load over file://, where the bundle\'s absolute\n' +
    '/assets/… imports resolve outside the asar and 404 — the renderer never mounts:\n' +
    offenders.map((l) => `  ${l}`).join('\n'),
  )
})

test('every packaged renderer entry point uses the app:// scheme', () => {
  const urls = packagedRendererUrls(readFileSync(MAIN_CJS, 'utf8'))
  for (const line of urls) {
    assert.match(line, /app:\/\/cumora\//, `not served over app://cumora/: ${line}`)
  }
})

test('the notification window is one of the entry points this guard covers', () => {
  // Cheap anchor: if the notification loader stops matching, the guard above
  // would pass vacuously for it.
  const urls = packagedRendererUrls(readFileSync(MAIN_CJS, 'utf8'))
  assert.ok(
    urls.some((l) => l.includes('#notifications')),
    'the notification window URL is no longer covered by this guard',
  )
})

// --- the matcher actually catches a regression (so the guard isn't a no-op) ---

test('the matcher flags a file:// notification URL', () => {
  // Built by concatenation so the `$`+`{` placeholder stays inert sample data.
  const bad = '  return `file://' + '$' + "{path.join(__dirname, '..', 'dist', 'index.html')}#notifications`"
  const found = packagedRendererUrls(bad)
  assert.equal(found.length, 1)
  assert.ok(found[0].includes('file://'))
})

test('the matcher ignores the isDev branch', () => {
  const dev = '  if (isDev) return `' + '$' + '{DEV_URL}/index.html#notifications`'
  assert.deepEqual(packagedRendererUrls(dev), [])
})
