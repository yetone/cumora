/**
 * Contract tests for the BYOA Qwen Code adapter.
 *
 * Qwen is not installed in CI. Each test puts a fake `qwen` first on PATH and
 * replays what `qwen --output-format stream-json` actually emits — Claude
 * Code's envelope, captured from a real @qwen-code/qwen-code 0.22.3 run.
 *
 * That is the point worth pinning. Qwen Code is a Gemini CLI fork and shares
 * its flags, so the tempting assumption is that it shares Gemini's output too.
 * It does not: Gemini emits `{type,timestamp,status,stats}` and Qwen emits
 * `{type:'result',subtype,is_error,num_turns,permission_denials,usage}`. An
 * adapter derived from the other one would parse nothing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-qwen.test.ts
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEngines, getAdapter, qwenReplyFromStream, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_QWEN_ARGS
  delete process.env.CUMORA_TRIAGE_ARGS
  delete process.env.CUMORA_TRIAGE_MODEL
  process.env.PATH = ORIGINAL_PATH
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_QWEN = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const argv = process.argv.slice(2)
const scenario = process.env.FAKE_QWEN_SCENARIO || 'ok'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }
  const sid = at('--resume') || '9c29376e-3a32-4271-bbe8-462395aa8199'
  const model = at('--model') || 'qwen3-coder-plus'
  if (process.env.FAKE_QWEN_LOG) {
    fs.appendFileSync(process.env.FAKE_QWEN_LOG, JSON.stringify({
      argv, stdin, cwd: process.cwd(),
    }) + '\\n')
  }
  const out = (event) => process.stdout.write(JSON.stringify({ session_id: sid, ...event }) + '\\n')

  if (scenario === 'no-auth') {
    // Verbatim shape of a real 0.22.3 failure before the first API call.
    out({
      type: 'result', subtype: 'error_during_execution', uuid: 'f8b5c7ad',
      is_error: true, duration_ms: 0, duration_api_ms: 0, num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [],
      error: { message: 'No auth type is selected. Please configure an auth type (e.g. via settings or --auth-type) before running in non-interactive mode.' },
    })
    process.exitCode = 1
    return
  }

  if (scenario === 'two-hops') {
    out({
      type: 'assistant', uuid: 'm1',
      message: { id: 'm1', type: 'message', role: 'assistant', model,
        content: [{ type: 'tool_use', id: 't1', name: 'run_shell_command', input: {} }],
        stop_reason: 'tool_use', usage: { input_tokens: 40, output_tokens: 5 } },
    })
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } })
  }

  out({
    type: 'assistant', uuid: 'm2',
    message: { id: 'm2', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'echo:' + stdin.trim() }],
      stop_reason: null, usage: { input_tokens: 100, output_tokens: 12 } },
  })
  out({
    type: 'result', subtype: 'success', uuid: 'r1', is_error: false,
    duration_ms: 1234, duration_api_ms: 1000, num_turns: 1,
    usage: { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 40 },
    permission_denials: [],
  })
})
`

interface Fixture { root: string; home: string; log: string; env: NodeJS.ProcessEnv }

async function fixture(scenario = 'ok', extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-qwen-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(binDir)
  await mkdir(home)
  const fake = join(binDir, 'qwen')
  await writeFile(fake, FAKE_QWEN, 'utf8')
  await chmod(fake, 0o755)
  return {
    root, home, log,
    env: {
      ...process.env, ...extraEnv,
      PATH: `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`,
      FAKE_QWEN_LOG: log,
      FAKE_QWEN_SCENARIO: scenario,
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<{ argv: string[]; stdin: string; cwd: string }>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const noop = { onLog: () => {}, signal: new AbortController().signal }

// ── the turn ────────────────────────────────────────────────────────────────

test('qwen run reads the Claude-shaped envelope without a parser of its own', { skip: IS_WIN }, async () => {
  // The whole reason this adapter is thin: spawnEngine already lifts session
  // id, terminating usage and model out of exactly this shape.
  const f = await fixture()
  const res = await getAdapter('qwen').run({
    home: f.home, prompt: 'hello there', env: f.env, model: 'qwen3-coder-plus', ...noop,
  })

  assert.equal(res.exitCode, 0)
  assert.equal(res.error, undefined)
  assert.equal(res.sessionId, '9c29376e-3a32-4271-bbe8-462395aa8199')
  assert.equal(res.model, 'qwen3-coder-plus')
  assert.deepEqual(res.usage, { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 40 })

  const [call] = await fakeLog(f)
  assert.equal(call.stdin, 'hello there')
  assert.ok(!call.argv.includes('hello there'), 'the prompt must not ride in argv')
  assert.deepEqual(call.argv.slice(0, 2), ['--output-format', 'stream-json'])
  assert.ok(call.argv.includes('--yolo'))
  assert.equal(call.cwd, await realpath(f.home))
})

test('every assistant message is reported as its own hop', { skip: IS_WIN }, async () => {
  const hops: EngineHopReport[] = []
  const f = await fixture('two-hops')
  await getAdapter('qwen').run({
    home: f.home, prompt: 'x', env: f.env, onHopUsage: (h) => hops.push(h), ...noop,
  })
  assert.equal(hops.length, 2)
  assert.deepEqual(hops[0].usage, { input_tokens: 40, output_tokens: 5 })
  assert.equal(hops[0].toolUses, 1)
  assert.deepEqual(hops[1].usage, { input_tokens: 100, output_tokens: 12 })
  assert.equal(hops[1].hopIndex, 2)
})

test('qwen run resumes by session id, not by "most recent"', { skip: IS_WIN }, async () => {
  // -c/--continue resumes the newest session for the project, which is wrong
  // here: one machine runs many agents out of many homes.
  const f = await fixture()
  const res = await getAdapter('qwen').run({
    home: f.home, prompt: 'again', env: f.env, resumeSessionId: 'sess-42', ...noop,
  })
  const [call] = await fakeLog(f)
  assert.equal(call.argv[call.argv.indexOf('--resume') + 1], 'sess-42')
  assert.ok(!call.argv.includes('--continue') && !call.argv.includes('-c'))
  assert.equal(res.sessionId, 'sess-42')
})

test('a failed turn surfaces the reason', { skip: IS_WIN }, async () => {
  const f = await fixture('no-auth')
  const res = await getAdapter('qwen').run({ home: f.home, prompt: 'x', env: f.env, ...noop })
  assert.notEqual(res.exitCode, 0)
  assert.match(res.error ?? '', /No auth type is selected/)
})

// ── the reply parser ────────────────────────────────────────────────────────

test('the reply is assembled from assistant text blocks', () => {
  // Qwen has no Claude-style `{result,usage}` object to unwrap — `-o json` is
  // just these same events in an array — so triage has to concatenate.
  const stream = [
    '{"type":"assistant","session_id":"s1","message":{"model":"qwen3-coder-plus","content":[{"type":"text","text":"Hello, "}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    '{"type":"assistant","session_id":"s1","message":{"model":"qwen3-coder-plus","content":[{"type":"text","text":"world"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    '{"type":"result","subtype":"success","session_id":"s1","is_error":false,"usage":{"input_tokens":9,"output_tokens":3}}',
  ].join('\n')
  const r = qwenReplyFromStream(stream)
  assert.equal(r.text, 'Hello, world')
  assert.deepEqual(r.usage, { input_tokens: 9, output_tokens: 3 })
  assert.equal(r.model, 'qwen3-coder-plus')
  assert.equal(r.error, undefined)
})

test('a tool_use block contributes no text', () => {
  // Only `type: 'text'` blocks are the reply. Folding a tool_use's JSON input
  // into the answer would hand triage machine structure to classify.
  const stream = '{"type":"assistant","message":{"model":"m","content":[' +
    '{"type":"tool_use","id":"t","name":"run_shell_command","input":{"command":"ls"}},' +
    '{"type":"text","text":"done"}]}}'
  assert.equal(qwenReplyFromStream(stream).text, 'done')
})

test('a failed result is reported even with text already streamed', () => {
  const stream = [
    '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"partial"}]}}',
    '{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{"input_tokens":0,"output_tokens":0},"error":{"message":"Quota exceeded"}}',
  ].join('\n')
  const r = qwenReplyFromStream(stream)
  assert.equal(r.text, 'partial')
  assert.equal(r.error, 'Quota exceeded')
})

test('a failed result with no detail still reports something', () => {
  const r = qwenReplyFromStream('{"type":"result","is_error":true}')
  assert.match(r.error ?? '', /failed turn/)
})

test('non-JSON noise and truncated lines are ignored', () => {
  // Startup banners share stdout, and a capture can be cut mid-object.
  const stream = [
    'Warning: running headless with --yolo and no sandbox.',
    '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"ok"}]}}',
    '{"type":"result","is_error":fal',
  ].join('\n')
  const r = qwenReplyFromStream(stream)
  assert.equal(r.text, 'ok')
  assert.equal(r.error, undefined)
})

// ── triage ──────────────────────────────────────────────────────────────────

test('triage runs safe-mode on the cheap model and gets the text back', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const res = await getAdapter('qwen').classify({ cwd: f.home, prompt: 'classify this', env: f.env, ...noop })
  assert.equal(res.text, 'echo:classify this')
  assert.deepEqual(res.usage, { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 40 })

  const [call] = await fakeLog(f)
  // --safe-mode leaves context files, hooks, extensions, skills and MCP
  // servers unloaded; --yolo is an argv flag and still wins over it, so
  // nothing can stall on an approval nobody is there to give.
  assert.ok(call.argv.includes('--safe-mode'))
  assert.ok(call.argv.includes('--yolo'))
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'qwen3-coder-flash')
})

test('CUMORA_TRIAGE_MODEL is what triage AND the small probe run on', { skip: IS_WIN }, async () => {
  // If they diverged, doctor would report a red small brain for an operator
  // whose triage is configured correctly.
  process.env.CUMORA_TRIAGE_MODEL = 'qwen3-coder-30b'
  const f = await fixture()
  await getAdapter('qwen').classify({ cwd: f.home, prompt: 'x', env: f.env, ...noop })
  await getAdapter('qwen').probe({ tier: 'small', cwd: f.home, env: f.env, signal: noop.signal })
  const calls = await fakeLog(f)
  assert.equal(calls.length, 2)
  for (const c of calls) assert.equal(c.argv[c.argv.indexOf('--model') + 1], 'qwen3-coder-30b')
})

test('the big probe leaves the model to the operator', { skip: IS_WIN }, async () => {
  // Qwen Code is multi-provider (its own OAuth, DashScope, any OpenAI-
  // compatible base URL), so there is no cheap model id that is right for
  // everyone — pinning one would fail operators who never configured it.
  const f = await fixture()
  await getAdapter('qwen').probe({ tier: 'big', cwd: f.home, env: f.env, signal: noop.signal })
  const [call] = await fakeLog(f)
  assert.ok(!call.argv.includes('--model'))
})

test('the wake probe is skipped because the wake IS the one-shot path', { skip: IS_WIN }, async () => {
  const res = await getAdapter('qwen').probeWake({ cwd: tmpdir(), env: process.env, signal: noop.signal })
  assert.deepEqual(res, { ok: true, detail: '', skipped: true })
})

// ── home layout, overrides, detection ───────────────────────────────────────

test('qwen seedHome writes QWEN.md and its native skills directory', { skip: IS_WIN }, async () => {
  const f = await fixture()
  await getAdapter('qwen').seedHome(f.home, {
    id: 'qwen', name: 'Wen', role: 'Analyst', systemPrompt: 'Analyse only.',
  })
  const persona = await readFile(join(f.home, 'QWEN.md'), 'utf8')
  assert.match(persona, /^# Wen — Analyst/)
  assert.match(persona, /Analyse only\./)
  assert.match(persona, /`QWEN\.md` \(this file\)/)
  assert.match(persona, /`\.qwen\/skills\/` — your skills/)
  assert.doesNotMatch(persona, /CLAUDE\.md|GEMINI\.md|AGENTS\.md/)
  assert.ok(existsSync(join(f.home, 'memory', 'MEMORY.md')))
  assert.ok(existsSync(join(f.home, '.qwen', 'skills')))
})

test('CUMORA_QWEN_ARGS takes over argv but keeps resume and the stdin prompt', { skip: IS_WIN }, async () => {
  process.env.CUMORA_QWEN_ARGS = '--output-format json --debug'
  const f = await fixture()
  await getAdapter('qwen').run({
    home: f.home, prompt: 'override me', env: f.env, resumeSessionId: 'sess-9', ...noop,
  })
  const [call] = await fakeLog(f)
  assert.deepEqual(call.argv, ['--output-format', 'json', '--debug', '--resume', 'sess-9'])
  assert.equal(call.stdin, 'override me')
})

test('qwen is detected on PATH', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const before = process.env.PATH
  process.env.PATH = f.env.PATH as string
  try {
    assert.ok((await detectEngines()).includes('qwen'))
  } finally {
    process.env.PATH = before
  }
})
