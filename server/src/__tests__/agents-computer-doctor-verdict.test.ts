/**
 * `--doctor`'s verdict has to mean "the daemon will start here".
 *
 * The doctor probes every adapter on PATH and scored itself on brain health
 * alone: `if (r.big?.ok && r.small?.ok) anyUsable = true`. But
 * `requireLocalEngine` also refuses to start the daemon when no installed
 * engine can enforce the BYOA boundary — an unsandboxed engine without
 * CUMORA_BYOA_ALLOW_UNSANDBOXED, or a secure one below its version floor.
 *
 * On a machine in that state the two disagreed completely. Measured on the
 * machine this was found on, minutes apart:
 *
 *   --doctor           → exit 0, "✓ at least one engine is fully healthy"
 *   evaluateRunnableEngines → runnable: [], blocked: [
 *       claude — version 2.1.207 is older than the secure minimum 2.1.248,
 *       codex  — version 0.134.0 is older than the secure minimum 0.138.0 ]
 *
 * The only engine scoring green was one secure BYOA refuses categorically, and
 * the version floor actually blocking the machine was never mentioned. That is
 * the worst possible answer for someone who ran the diagnostic precisely
 * because something was already wrong.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { doctorUsableEngines } from '../agents/computer/daemon.js'

const healthy = (id: string) => ({ id: id as never, installed: true, big: { ok: true }, small: { ok: true } })
const halfDead = (id: string) => ({ id: id as never, installed: true, big: { ok: true }, small: { ok: false } })
const absent = (id: string) => ({ id: id as never, installed: false })

test('an engine the gate blocks does not count, however healthy its brains', () => {
  // The exact shape of the machine this was found on: both secure engines
  // below the floor, one unsandboxed engine working perfectly.
  const results = [healthy('claude'), healthy('codex'), healthy('grok')]
  assert.deepEqual(
    doctorUsableEngines(results, { runnable: [] }), [],
    'the doctor would report green on a machine where the daemon exits 70',
  )
})

test('a runnable engine with healthy brains counts', () => {
  const results = [healthy('claude'), healthy('grok')]
  assert.deepEqual(doctorUsableEngines(results, { runnable: ['claude'] }), ['claude'])
})

test('runnable is not enough on its own — the brains still have to answer', () => {
  // The guard rail in the other direction: this must not become "the gate says
  // yes, so we are fine".
  assert.deepEqual(doctorUsableEngines([halfDead('claude')], { runnable: ['claude'] }), [])
  assert.deepEqual(doctorUsableEngines([absent('claude')], { runnable: ['claude'] }), [])
})

test('an unevaluable gate degrades to the brain-only answer, not to zero', () => {
  // A PATH scan can fail. A diagnostic that reports "nothing works" because it
  // could not run its own check is worse than the answer it used to give.
  assert.deepEqual(doctorUsableEngines([healthy('claude')], null), ['claude'])
})

test('the verdict is drawn from the gate-aware helper, not from brains alone', async () => {
  // The four tests above exercise the helper. They would all still pass against
  // a runDoctor that computed its own verdict and never called it — which is
  // exactly the state being fixed. Read the source.
  const source = await readFile(new URL('../agents/computer/daemon.ts', import.meta.url), 'utf8')
  const doctor = source.slice(source.indexOf('async function runDoctor'))
  const body = doctor.slice(0, doctor.indexOf('\n}\n') + 2)

  assert.match(body, /doctorUsableEngines\(/, 'runDoctor no longer asks the gate')
  assert.doesNotMatch(
    body, /if \(r\.big\?\.ok && r\.small\?\.ok\) anyUsable = true/,
    'the brain-only verdict is back — the doctor will report green on machines where --pair exits 70',
  )
})
