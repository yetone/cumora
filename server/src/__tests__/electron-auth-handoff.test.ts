/**
 * Guard: the loopback must not report a sign-in it dropped.
 *
 * The desktop arms a nonce, opens the system browser, and the return page POSTs
 * `{token, companyId, nonce}` back to the loopback. `dispatchAuthToken` drops a
 * token whose nonce does not match — correctly, that is the drive-by-deep-link
 * defence — but it returned `void`, and the handler answered 204 either way.
 *
 * The page keys on `r.ok`:
 *
 *   if (!r.ok) throw new Error('handoff rejected: ' + r.status);
 *   h1.textContent = 'Signed in';
 *   label.innerHTML = '<span class="ok">✓</span> Signed in';
 *   hint.textContent = 'You can close this tab.';
 *
 * So the browser told the user they were signed in, with a checkmark, while the
 * app had received nothing. Its catch branch — the one that says to open Cumora
 * itself — was unreachable for this case.
 *
 * Reaching it is ordinary: `armAuthHandoff` "supersedes any previous unused
 * nonce", and AuthScreen re-arms on window focus. Click sign-in, click back
 * into Cumora, click sign-in again, then finish the FIRST tab.
 *
 * Second half: `consumeAuthNonce` cleared the armed nonce before validating, so
 * that stale first tab also disarmed the second one — the obvious recovery,
 * going back and finishing the other tab, failed too.
 *
 * electron/ has no runtime harness, so this reads the source the way
 * electron-tray-unread-dot.test.ts does, and self-tests its matchers.
 *
 * Run: node --import tsx --test server/src/__tests__/electron-auth-handoff.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MAIN_CJS = readFileSync(join(REPO_ROOT, 'electron', 'main.cjs'), 'utf8')

function bodyOf(source: string, decl: string): string | null {
  const at = source.indexOf(decl)
  if (at < 0) return null
  const end = source.indexOf('\n}', at)
  return end < 0 ? null : source.slice(at, end)
}

/** Does the handler decide its status from the dispatch result? */
function answersTheRealStatus(handler: string): boolean {
  return /if \(dispatchAuthToken\(/.test(handler) && /statusCode = 4\d\d/.test(handler)
}

/** Does the nonce survive a value that does not match it? */
function clearsOnlyOnMatch(fn: string): boolean {
  const firstGuard = fn.search(/if \(!armed/)
  const firstClear = fn.indexOf('armedAuthNonce = null')
  if (firstGuard < 0 || firstClear < 0) return false
  return firstClear > firstGuard
}

test('the loopback answers what actually happened', () => {
  const handler = bodyOf(MAIN_CJS, "if (typeof parsed?.token !== 'string'")
  assert.ok(handler, 'the /auth/token handler moved — update this guard alongside the refactor')
  assert.ok(
    answersTheRealStatus(handler),
    'the handler answers 204 without checking whether the token was accepted',
  )
})

test('dispatchAuthToken reports acceptance on both paths', () => {
  const fn = bodyOf(MAIN_CJS, 'function dispatchAuthToken(')
  assert.ok(fn, 'dispatchAuthToken moved — update this guard alongside the refactor')
  assert.match(fn, /return false/, 'the drop path must say so')
  assert.match(fn, /return true/, 'the accept path must say so')
})

test('a mismatching nonce does not disarm the pending sign-in', () => {
  const fn = bodyOf(MAIN_CJS, 'function consumeAuthNonce(')
  assert.ok(fn, 'consumeAuthNonce moved — update this guard alongside the refactor')
  assert.ok(
    clearsOnlyOnMatch(fn),
    'the armed nonce is cleared before it is validated, so any inbound value disarms it',
  )
})

test('the timing-safe compare is still how the nonce is checked', () => {
  // The change above must not have loosened the comparison it guards.
  const fn = bodyOf(MAIN_CJS, 'function consumeAuthNonce(') ?? ''
  assert.match(fn, /crypto\.timingSafeEqual\(/)
  assert.match(fn, /nonce\.length !== armed\.length/)
})

// ── the matchers must be able to fail ──────────────────────────────────────

test('the status guard rejects the unconditional 204', () => {
  assert.equal(
    answersTheRealStatus('dispatchAuthToken(parsed.token, companyId, nonce)\nres.statusCode = 204; res.end()'),
    false,
  )
})

test('the status guard accepts a branched answer', () => {
  assert.equal(
    answersTheRealStatus('if (dispatchAuthToken(a, b, c)) { res.statusCode = 204 } else { res.statusCode = 409 }'),
    true,
  )
})

test('the nonce guard rejects clearing before validating', () => {
  assert.equal(
    clearsOnlyOnMatch('const armed = armedAuthNonce\narmedAuthNonce = null\nif (!armed) return false'),
    false,
  )
})

test('the nonce guard accepts clearing inside the guard', () => {
  assert.equal(
    clearsOnlyOnMatch('const armed = armedAuthNonce\nif (!armed) { armedAuthNonce = null; return false }'),
    true,
  )
})
