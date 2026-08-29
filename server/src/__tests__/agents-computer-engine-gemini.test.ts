/**
 * Contract tests for the BYOA Gemini CLI adapter.
 *
 * Gemini is not installed in CI. Each test puts a fake `gemini` first on PATH
 * and replays the JSONL that `gemini --output-format stream-json` actually
 * emits — the envelope was taken from a real @google/gemini-cli 0.57.0 run and
 * from its shipped StreamJsonFormatter, not from the docs (which do not
 * describe the event shapes at all).
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-gemini.test.ts
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEngines, getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_GEMINI_ARGS
  delete process.env.CUMORA_TRIAGE_ARGS
  delete process.env.CUMORA_TRIAGE_MODEL
  process.env.PATH = ORIGINAL_PATH
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_GEMINI = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const argv = process.argv.slice(2)
const scenario = process.env.FAKE_GEMINI_SCENARIO || 'ok'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
  const sid = at('--resume') || '557c5bc6-d970-46c1-a90b-b0c33cdeff29'
  const model = at('--model') || 'gemini-2.5-pro'
  if (process.env.FAKE_GEMINI_LOG) {
    fs.appendFileSync(process.env.FAKE_GEMINI_LOG, JSON.stringify({
      argv, stdin, cwd: process.cwd(),
      trust: process.env.GEMINI_CLI_TRUST_WORKSPACE || null,
      settingsPath: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || null,
      settingsOk: (() => {
        const p = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH
        if (!p) return null
        try { JSON.parse(fs.readFileSync(p, 'utf8')); return true } catch { return false }
      })(),
    }) + '\\n')
  }
  const out = (event) => process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\\n')
  out({ type: 'init', session_id: sid, model })

  if (scenario === 'auth-error') {
    // Verbatim shape of a real 0.57.0 failure before the first API call: a
    // result event whose every counter is zero.
    out({
      type: 'result', status: 'error',
      error: { type: 'unknown', message: '[API Error: API key not valid. Please pass a valid API key.]' },
      stats: {
        total_tokens: 0, input_tokens: 0, output_tokens: 0, cached: 0, input: 0,
        duration_ms: 0, tool_calls: 0, models: { 'gemini-2.5-flash': { total_tokens: 0, input_tokens: 0, output_tokens: 0, cached: 0, input: 0 } },
      },
    })
    process.exitCode = 1
    return
  }

  if (scenario === 'soft-error') {
    // A failed turn whose process still exits 0 — quota and safety refusals
    // arrive this way, so the stream, not the exit code, is the verdict.
    out({
      type: 'result', status: 'error',
      error: { type: 'quota', message: 'Quota exceeded for this model.' },
      stats: { total_tokens: 30, input_tokens: 30, output_tokens: 0, cached: 10, input: 20, duration_ms: 5, tool_calls: 0, models: {} },
    })
    return
  }
  if (scenario === 'stale-session') {
    process.stderr.write('Error resuming session: No previous sessions found for this project.\\n')
    process.exitCode = 1
    return
  }

  out({ type: 'message', role: 'user', content: stdin })
  if (scenario === 'tools') {
    out({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'call-1', parameters: { command: 'ls' } })
    out({ type: 'tool_result', tool_id: 'call-1', status: 'success', output: 'a.ts' })
    out({ type: 'error', severity: 'warning', message: 'Loop detected, stopping execution' })
  }
  // Assistant text arrives as deltas, not one message.
  out({ type: 'message', role: 'assistant', content: 'echo:', delta: true })
  out({ type: 'message', role: 'assistant', content: stdin.trim(), delta: true })
  out({
    type: 'result', status: 'success',
    stats: {
      total_tokens: 152, input_tokens: 100, output_tokens: 12, cached: 40, input: 60,
      duration_ms: 1234, tool_calls: scenario === 'tools' ? 1 : 0,
      models: { [model]: { total_tokens: 152, input_tokens: 100, output_tokens: 12, cached: 40, input: 60 } },
    },
  })
})
`

interface Fixture {
  root: string
  home: string
  log: string
  env: NodeJS.ProcessEnv
}

async function fixture(scenario = 'ok', extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-gemini-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(binDir)
  await mkdir(home)
  const fake = join(binDir, 'gemini')
  await writeFile(fake, FAKE_GEMINI, 'utf8')
  await chmod(fake, 0o755)
  return {
    root,
    home,
    log,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`,
      FAKE_GEMINI_LOG: log,
      FAKE_GEMINI_SCENARIO: scenario,
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<{
  argv: string[]
  stdin: string
  cwd: string
  trust: string | null
  settingsPath: string | null
  settingsOk: boolean | null
}>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

const noop = { onLog: () => {}, signal: new AbortController().signal }

// ── the turn ────────────────────────────────────────────────────────────────

test('gemini run streams a turn, keeps the session id, and sends the prompt on stdin', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const res = await getAdapter('gemini').run({
    home: f.home, prompt: 'hello there', env: f.env, model: 'gemini-2.5-pro', ...noop,
  })

  assert.equal(res.exitCode, 0)
  assert.equal(res.error, undefined)
  assert.equal(res.sessionId, '557c5bc6-d970-46c1-a90b-b0c33cdeff29')
  assert.equal(res.model, 'gemini-2.5-pro')

  const [call] = await fakeLog(f)
  // The prompt never rides in argv: `gemini` reads it from stdin when no -p is
  // given, which is also what keeps a Windows .cmd shim able to carry it.
  assert.equal(call.stdin, 'hello there')
  assert.ok(!call.argv.includes('hello there'))
  assert.deepEqual(call.argv.slice(0, 2), ['--output-format', 'stream-json'])
  assert.ok(call.argv.includes('--yolo'))
  // realpath: macOS resolves /var to /private/var inside the child.
  assert.equal(call.cwd, await realpath(f.home))
})

test('the assistant deltas are joined and the echo of our own prompt is not', { skip: IS_WIN }, async () => {
  // A `message` event carries role user OR assistant. Folding the user echo in
  // would hand triage its own prompt back as the classification.
  const f = await fixture()
  const res = await getAdapter('gemini').classify({
    cwd: f.home, prompt: 'ping', env: f.env, ...noop,
  })
  assert.equal(res.text, 'echo:ping')
})

test('gemini run resumes by session UUID', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const res = await getAdapter('gemini').run({
    home: f.home, prompt: 'again', env: f.env, resumeSessionId: 'b4cb9d1e-d37e-42aa-8769-e47cf186523f', ...noop,
  })
  const [call] = await fakeLog(f)
  // --resume also accepts "latest" and a 1-based index, but only the UUID is
  // stable across wakes: an index shifts as sessions accumulate.
  assert.ok(call.argv.includes('--resume'))
  assert.equal(call.argv[call.argv.indexOf('--resume') + 1], 'b4cb9d1e-d37e-42aa-8769-e47cf186523f')
  assert.equal(res.sessionId, 'b4cb9d1e-d37e-42aa-8769-e47cf186523f')
})

test('the workspace is trusted through the environment, not a flag', { skip: IS_WIN }, async () => {
  // Gemini silently downgrades --yolo to interactive approval in an untrusted
  // folder, which strands an unattended daemon. The env var does the same job
  // as --skip-trust but is IGNORED by builds that predate it, where an unknown
  // flag would instead be a fatal argv error.
  const f = await fixture()
  await getAdapter('gemini').run({ home: f.home, prompt: 'x', env: f.env, ...noop })
  const [call] = await fakeLog(f)
  assert.equal(call.trust, 'true')
  assert.ok(!call.argv.includes('--skip-trust'))
})

// ── usage, and the field that must not be billed ────────────────────────────

test('cache reads are not billed twice', { skip: IS_WIN }, async () => {
  // THE trap in this envelope. Gemini's `stats.input_tokens` is the FULL prompt
  // (uiTelemetryService sets tokens.prompt from input_token_count, cached
  // segment included) and `stats.input` is prompt − cached. Billing the
  // similarly-named field while also reporting `cached` charges the cached
  // prefix twice — and a BYOA agent re-sends a large stable prefix every wake.
  const f = await fixture()
  const res = await getAdapter('gemini').run({ home: f.home, prompt: 'x', env: f.env, ...noop })
  assert.deepEqual(res.usage, {
    input_tokens: 60,               // stats.input, NOT stats.input_tokens (100)
    output_tokens: 12,
    cache_read_input_tokens: 40,
  })
  // 60 + 40 is the 100 the CLI called the prompt — counted once.
  assert.equal((res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0), 100)
})

test('a turn that died before its first API call reports no usage at all', { skip: IS_WIN }, async () => {
  // The auth-failure shape is a full stats block of zeros. Passing it through
  // would put a row in the cost ledger for work that never happened.
  const f = await fixture('auth-error')
  const res = await getAdapter('gemini').run({ home: f.home, prompt: 'x', env: f.env, ...noop })
  assert.equal(res.usage, undefined)
  assert.notEqual(res.exitCode, 0)
  assert.match(res.error ?? '', /API key not valid/)
})

test('a failed result event fails the turn even when the process exits 0', { skip: IS_WIN }, async () => {
  // Quota and safety refusals arrive as status:'error' on a cleanly-exiting
  // process. Trusting the exit code alone would record the turn as a success
  // that simply said nothing.
  const f = await fixture('soft-error')
  const res = await getAdapter('gemini').run({ home: f.home, prompt: 'x', env: f.env, ...noop })
  assert.equal(res.exitCode, 1)
  assert.match(res.error ?? '', /Quota exceeded/)
  // The tokens it DID burn before failing are still billed.
  assert.deepEqual(res.usage, { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10 })
})

test('the resolved model wins over the requested one', { skip: IS_WIN }, async () => {
  // `-m` takes aliases (`pro`, `flash-lite`), and a mid-turn fallback can move
  // the turn to another model. The stats key is the id that was really used,
  // and the one cost must be priced on.
  const f = await fixture()
  const res = await getAdapter('gemini').run({
    home: f.home, prompt: 'x', env: f.env, model: 'gemini-2.5-flash', ...noop,
  })
  assert.equal(res.model, 'gemini-2.5-flash')
})

test('the turn total is reported as one hop', { skip: IS_WIN }, async () => {
  // Gemini publishes token stats only at the end of a turn, so — as with codex
  // exec — there is one hop carrying the whole turn rather than a trajectory.
  const hops: EngineHopReport[] = []
  const f = await fixture('tools')
  await getAdapter('gemini').run({
    home: f.home, prompt: 'x', env: f.env, model: 'gemini-2.5-pro',
    onHopUsage: (h) => hops.push(h), ...noop,
  })
  assert.equal(hops.length, 1)
  assert.equal(hops[0].model, 'gemini-2.5-pro')
  assert.deepEqual(hops[0].usage, { input_tokens: 60, output_tokens: 12, cache_read_input_tokens: 40 })
  assert.equal(hops[0].toolUses, 1)
  assert.equal(hops[0].hopIndex, 1)
})

test('a warning-severity event does not fail the turn', { skip: IS_WIN }, async () => {
  // Loop detection and blocked tools arrive as `error` events with
  // severity:'warning'; the run survives them and the result event decides.
  const f = await fixture('tools')
  const res = await getAdapter('gemini').run({ home: f.home, prompt: 'x', env: f.env, ...noop })
  assert.equal(res.exitCode, 0)
  assert.equal(res.error, undefined)
})

// ── triage ──────────────────────────────────────────────────────────────────

test('triage runs tool-free on the cheap model', { skip: IS_WIN }, async () => {
  const f = await fixture()
  await getAdapter('gemini').classify({ cwd: f.home, prompt: 'classify this', env: f.env, ...noop })
  const [call] = await fakeLog(f)

  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'gemini-2.5-flash-lite')
  assert.ok(call.settingsPath, 'triage must point gemini at a settings file')
  // `tools.core` is an allowlist applied per tool as `coreTools.some(...)`. An
  // empty array is truthy and matches nothing, so NO core tool is registered —
  // and with no tool to confirm, a headless approval prompt that nothing would
  // answer cannot arise.
  const settings = JSON.parse(await readFile(call.settingsPath as string, 'utf8'))
  assert.deepEqual(settings, { tools: { core: [] } })
})

test('concurrent triage shares one cwd cleanly and leaves no staging files', { skip: IS_WIN }, async () => {
  // The triage cwd is SHARED — the doctor hands the same dir to every engine's
  // probe, and concurrent classifies land there too. The adapter stages the
  // settings file and renames it into place rather than writeFile-ing onto the
  // live path, because writeFile truncates first and a reader can land in that
  // window; identical content is no defence against a zero-length read.
  //
  // That window is far too narrow to provoke deterministically (spawn latency
  // dwarfs a 22-byte write), so this pins what IS observable: every concurrent
  // caller gets a parseable file, and nothing is left behind.
  const f = await fixture()
  const adapter = getAdapter('gemini')
  await Promise.all(Array.from({ length: 12 }, () =>
    adapter.classify({ cwd: f.home, prompt: 'x', env: f.env, ...noop })))

  const calls = await fakeLog(f)
  assert.equal(calls.length, 12)
  for (const call of calls) assert.equal(call.settingsOk, true, call.settingsPath ?? 'no settings path')
  const stray = (await readdir(f.home)).filter((n) => n.startsWith('.cumora-gemini-triage.') && n !== '.cumora-gemini-triage.json')
  assert.deepEqual(stray, [], 'a rename was skipped and left a staging file behind')
})

test('CUMORA_TRIAGE_MODEL overrides the triage model', { skip: IS_WIN }, async () => {
  process.env.CUMORA_TRIAGE_MODEL = 'gemini-2.5-flash'
  const f = await fixture()
  await getAdapter('gemini').classify({ cwd: f.home, prompt: 'x', env: f.env, ...noop })
  const [call] = await fakeLog(f)
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'gemini-2.5-flash')
})

test('the small doctor probe runs the SAME model triage does', { skip: IS_WIN }, async () => {
  // Otherwise doctor reports a red small brain for an operator whose triage
  // model is configured correctly.
  process.env.CUMORA_TRIAGE_MODEL = 'gemini-2.5-flash'
  const f = await fixture()
  await getAdapter('gemini').probe({ tier: 'small', cwd: f.home, env: f.env, signal: noop.signal })
  const [call] = await fakeLog(f)
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'gemini-2.5-flash')
})

test('the wake probe is skipped because the wake IS the one-shot path', { skip: IS_WIN }, async () => {
  const res = await getAdapter('gemini').probeWake({
    cwd: tmpdir(), env: process.env, signal: noop.signal,
  })
  assert.deepEqual(res, { ok: true, detail: '', skipped: true })
})

// ── home layout and overrides ───────────────────────────────────────────────

test('gemini seedHome writes GEMINI.md, native skills, and common directories', { skip: IS_WIN }, async () => {
  const f = await fixture()
  await getAdapter('gemini').seedHome(f.home, {
    id: 'gemini', name: 'Gem', role: 'Reviewer', systemPrompt: 'Review only.',
  })

  const persona = await readFile(join(f.home, 'GEMINI.md'), 'utf8')
  assert.match(persona, /^# Gem — Reviewer/)
  assert.match(persona, /Review only\./)
  assert.match(persona, /`GEMINI\.md` \(this file\)/)
  assert.match(persona, /`\.gemini\/skills\/` — your skills/)
  assert.doesNotMatch(persona, /CLAUDE\.md|AGENTS\.md|\.claude\/skills/)
  assert.ok(existsSync(join(f.home, 'memory', 'MEMORY.md')))
  assert.ok(existsSync(join(f.home, 'workspace')))
  assert.ok(existsSync(join(f.home, '.gemini', 'skills')))
})

test('CUMORA_GEMINI_ARGS takes over argv but keeps resume and the stdin prompt', { skip: IS_WIN }, async () => {
  process.env.CUMORA_GEMINI_ARGS = '--output-format json --debug'
  const f = await fixture()
  await getAdapter('gemini').run({
    home: f.home, prompt: 'override me', env: f.env, resumeSessionId: 'sid-42', ...noop,
  })
  const [call] = await fakeLog(f)
  assert.deepEqual(call.argv, ['--output-format', 'json', '--debug', '--resume', 'sid-42'])
  assert.equal(call.stdin, 'override me')
  // Continuity and the untrusted-folder stall are not the user's to opt out of.
  assert.equal(call.trust, 'true')
})

test('gemini is detected on PATH', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const before = process.env.PATH
  process.env.PATH = f.env.PATH as string
  try {
    assert.ok((await detectEngines()).includes('gemini'))
  } finally {
    process.env.PATH = before
  }
})
