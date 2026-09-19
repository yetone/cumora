/**
 * `--install-service` must not install a service that cannot start.
 *
 * The service definitions carry exactly two variables — PATH and
 * CUMORA_SUPERVISED. An unsandboxed compatibility opt-in set in the user's
 * shell is dropped at install time.
 *
 * For a user whose only engine is a compatibility one (grok, cursor, gemini,
 * qwen, opencode, pi, antigravity) that is fatal, and every step of it is
 * something the product told them to do:
 *
 *   1. pairing fails, and the CLI prints the remediation itself:
 *      "CUMORA_BYOA_ALLOW_UNSANDBOXED=1 npx cumora@latest agent computer ..."
 *   2. with the flag set, pairing succeeds and the foreground daemon runs
 *   3. that daemon prints "run `--install-service` to keep this running in the
 *      background" (daemon.ts, the !SUPERVISED tip)
 *   4. the installed service starts WITHOUT the flag, so requireLocalEngine
 *      finds an empty runnable set, doRun sets exitCode 70 and returns
 *   5. KeepAlive / Restart=always / the PowerShell supervisor loop restart it,
 *      forever, every five seconds
 *
 * The flag is carried only when the machine genuinely has nothing runnable
 * without it, so it is never persisted into a background service just because
 * it happened to be set in the shell of someone whose secure engines were fine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { renderWindowsSupervisor, _needsUnsandboxedOptIn } from '../agents/computer/daemon.js'

const WIN = (carry: boolean) =>
  renderWindowsSupervisor('npx', 'https://api.cumora.ai', 'C:/log.txt', 'C:/disabled', 'C:/bin', carry)

test('the Windows supervisor carries the opt-in when the machine needs it', () => {
  assert.match(
    WIN(true), /\$env:CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'/,
    'the supervised daemon starts without the opt-in, exits 70, and this loop restarts it every 5s forever',
  )
})

test('and does not carry it when the machine does not', () => {
  // The guard rail: a security opt-in must not be baked into a background
  // service merely because it was set in the installing shell.
  assert.doesNotMatch(WIN(false), /CUMORA_BYOA_ALLOW_UNSANDBOXED/)
})

test('the opt-in is set before the daemon is launched, not after', () => {
  const lines = WIN(true).split('\r\n')
  const optIn = lines.findIndex((l) => l.includes('CUMORA_BYOA_ALLOW_UNSANDBOXED'))
  const launch = lines.findIndex((l) => l.includes('agent computer --server'))
  assert.ok(optIn >= 0 && launch >= 0)
  assert.ok(optIn < launch, 'the variable is exported after the daemon starts, so the daemon never sees it')
})

test('the probe answers no when the opt-in was never given', async () => {
  // No flag in the environment means nothing to carry, whatever is installed —
  // and the probe must not shell out to decide that.
  assert.equal(await _needsUnsandboxedOptIn({}), false)
  assert.equal(await _needsUnsandboxedOptIn({ CUMORA_BYOA_ALLOW_UNSANDBOXED: '0' }), false)
})

test('macOS and Linux service definitions carry it on the same condition', async () => {
  // Those two are template strings written straight to disk, so there is no
  // pure function to call. Read the source: all three platforms have to agree,
  // or the bug simply moves to whichever one was missed.
  const source = await readFile(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8')

  const plist = source.slice(source.indexOf('<key>CUMORA_SUPERVISED</key>'))
  assert.match(
    plist.slice(0, 220), /carryUnsandboxed \? '[^']*CUMORA_BYOA_ALLOW_UNSANDBOXED/,
    'the LaunchAgent drops the opt-in again — it will exit 70 and KeepAlive will restart it forever',
  )

  const unit = source.slice(source.indexOf('Environment=CUMORA_SUPERVISED=1'))
  assert.match(
    unit.slice(0, 220), /carryUnsandboxed \? '[^']*CUMORA_BYOA_ALLOW_UNSANDBOXED/,
    'the systemd unit drops the opt-in again — it will exit 70 and Restart=always will restart it forever',
  )
})
