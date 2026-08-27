/**
 * Unit tests for the BYOA `pi` engine adapter (server/src/agents/computer/engine.ts).
 *
 * pi is not installed in CI, so every test drives a FAKE `pi` — a small Node
 * script put first on PATH — that speaks the real protocol shapes we verified
 * against pi 0.83.0: `--mode json` (session header + events, exit 0) and
 * `--mode rpc` (JSON commands on stdin → `response` frames + events; exits when
 * stdin closes). Scenarios are selected via FAKE_PI_SCENARIO; everything the
 * fake sees (argv, commands) is appended to FAKE_PI_LOG so a test can assert on
 * what the adapter actually sent.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-pi.test.ts
 */
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_PI_ARGS
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_PI = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const argv = process.argv.slice(2)
const record = (o) => { if (process.env.FAKE_PI_LOG) fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify(o) + '\\n') }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const scenario = process.env.FAKE_PI_SCENARIO || 'ok'
const mode = argv.includes('rpc') ? 'rpc' : argv.includes('json') ? 'json' : 'text'
const sidIdx = argv.indexOf('--session-id')
const SID = sidIdx >= 0 ? argv[sidIdx + 1] : 'fake-session-' + mode
record({ argv, cwd: process.cwd() })

// A turn's worth of events for prompt text \`text\` (same shapes as real pi).
function emitTurn(text, extra) {
  if (scenario === 'die') { process.stderr.write('Error: no models available. Run /login first.\\n'); process.exit(1) }
  out({ type: 'message_start', message: { role: 'assistant', content: [] } })
  out({ type: 'message_update', message: {}, assistantMessageEvent: { type: 'text_delta', delta: 'e' } })
  if (scenario === 'turn-error') {
    out({ type: 'message_end', message: { role: 'assistant', model: 'claude-test', stopReason: 'error', errorMessage: 'rate limit exceeded (429)', content: [] } })
  } else {
    out({ type: 'message_end', message: { role: 'assistant', model: 'claude-test',
      usage: { input: 2, output: 4, cacheRead: 687, cacheWrite: 10, cost: { total: 0.001 } },
      stopReason: 'stop', content: [{ type: 'text', text: 'echo:' + text + (extra || '') }] } })
  }
  out({ type: 'turn_end', message: {}, toolResults: [] })
  out({ type: 'agent_end', messages: [{}, {}], willRetry: false })
  out({ type: 'agent_settled' })
}

if (mode === 'json') {
  if (scenario === 'not-logged-in') { process.stderr.write('No models available. Set an API key or run /login.\\n'); process.exit(1) }
  out({ type: 'session', version: 3, id: SID, timestamp: 'now', cwd: process.cwd() })
  out({ type: 'agent_start' }); out({ type: 'turn_start' })
  const prompt = argv[argv.length - 1]
  out({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })
  emitTurn(prompt)
  process.exit(0)
}

if (mode === 'text') { process.stdout.write('OK\\n'); process.exit(0) }

// rpc
let buf = ''
let pendingPrompt = null
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const cmd = JSON.parse(line)
    record({ cmd })
    if (cmd.type === 'get_state') {
      out({ type: 'response', command: 'get_state', id: cmd.id, success: true, data: { sessionId: SID, isStreaming: false, messageCount: 0 } })
    } else if (cmd.type === 'prompt') {
      if (scenario === 'reject') { out({ type: 'response', command: 'prompt', id: cmd.id, success: false, error: 'Agent is already streaming' }); continue }
      out({ type: 'response', command: 'prompt', id: cmd.id, success: true })
      out({ type: 'agent_start' }); out({ type: 'turn_start' })
      if (scenario === 'wait-steer') { pendingPrompt = cmd; continue }
      emitTurn(cmd.message)
    } else if (cmd.type === 'steer') {
      out({ type: 'response', command: 'steer', success: true })
      if (pendingPrompt) { const p = pendingPrompt; pendingPrompt = null; emitTurn(p.message, ' steered:' + cmd.message) }
    } else if (cmd.type === 'abort') {
      out({ type: 'response', command: 'abort', success: true })
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

interface Fixture { root: string; binDir: string; home: string; log: string; env: NodeJS.ProcessEnv }

async function fixture(scenario = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-pi-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakePi = join(binDir, 'pi')
  await writeFile(fakePi, FAKE_PI, 'utf8')
  await chmod(fakePi, 0o755)
  const log = join(root, 'fake-pi.log')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    FAKE_PI_LOG: log,
    FAKE_PI_SCENARIO: scenario,
  }
  return { root, binDir, home, log, env }
}

async function fakeLog(f: Fixture): Promise<Array<{ argv?: string[]; cmd?: { type: string; id?: string; message?: string } }>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('pi seedHome lays out AGENTS.md + .pi/skills; the persona file is system-owned and rewritten', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const pi = getAdapter('pi')
  await pi.seedHome(f.home, { id: 'a1', name: 'Iris', role: 'Designer', systemPrompt: 'Dry wit. Short sentences.' })
  const agentsMd = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(agentsMd, /^# Iris — Designer/)
  assert.match(agentsMd, /## Your style\nDry wit\. Short sentences\./, 'persona systemPrompt lands in the header')
  assert.match(agentsMd, /`AGENTS\.md` \(this file\)/, 'the header must name the file pi actually reads')
  assert.match(agentsMd, /`\.pi\/skills\/` — your skills/)
  assert.ok(existsSync(join(f.home, '.pi', 'skills')))
  assert.ok(existsSync(join(f.home, 'memory', 'MEMORY.md')))
  // AGENTS.md is system-owned: a persona edit is picked up on the next seed
  // (matches Claude/Codex/Cursor). The agent's own files are never clobbered.
  await writeFile(join(f.home, 'memory', 'MEMORY.md'), 'agent notes', 'utf8')
  await pi.seedHome(f.home, { id: 'a1', name: 'Iris', role: 'Illustrator', systemPrompt: null })
  assert.match(await readFile(join(f.home, 'AGENTS.md'), 'utf8'), /^# Iris — Illustrator/)
  assert.equal(await readFile(join(f.home, 'memory', 'MEMORY.md'), 'utf8'), 'agent notes')
})

test('pi persistent session: one prompt → one turn, session id, summed usage, per-hop ledger report', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const logs: string[] = []
  const session = getAdapter('pi').startSession?.({
    home: f.home, env: f.env, model: 'anthropic/claude-test', fastModel: null,
    resumeSessionId: 'resume-me-1234', standingPrompt: 'STANDING PROMPT BODY',
    onLog: (l) => logs.push(l), onHopUsage: (r) => hops.push(r),
  })
  assert.ok(session, 'pi has a persistent (rpc) session')
  assert.equal(session.carriesStandingPrompt, true, 'standing prompt travels via --append-system-prompt')

  const result = await session.send('hello agent')
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.error, undefined)
  assert.equal(result.sessionId, 'resume-me-1234', 'the id we pinned with --session-id is the one pi reports back')
  assert.equal(result.model, 'claude-test')
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 687, cache_creation_input_tokens: 10 })
  assert.equal(hops.length, 1)
  assert.equal(hops[0].model, 'claude-test')
  assert.equal(hops[0].hopIndex, 1)
  assert.equal(hops[0].textChars, 'echo:hello agent'.length)
  assert.deepEqual(hops[0].usage, { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 687, cache_creation_input_tokens: 10 })

  // What the adapter actually sent pi.
  const seen = await fakeLog(f)
  const argv = seen[0]?.argv ?? []
  assert.ok(argv.includes('rpc'), `spawned in rpc mode: ${argv.join(' ')}`)
  assert.equal(argv[argv.indexOf('--session-id') + 1], 'resume-me-1234')
  assert.equal(argv[argv.indexOf('--model') + 1], 'anthropic/claude-test')
  assert.ok(argv.includes('--thinking') && argv[argv.indexOf('--thinking') + 1] === 'off', 'thinking off by default')
  const promptFile = argv[argv.indexOf('--append-system-prompt') + 1]
  assert.equal(await readFile(promptFile, 'utf8'), 'STANDING PROMPT BODY')
  assert.equal(argv[argv.indexOf('--skill') + 1], join(f.home, '.pi', 'skills'))
  const cmds = seen.map((s) => s.cmd).filter(Boolean)
  assert.deepEqual(cmds.map((c) => c!.type), ['get_state', 'prompt'])
  assert.equal(cmds[1]!.message, 'hello agent')
  // Streaming deltas are NOT logged; the assistant message_end is.
  assert.ok(!logs.some((l) => l.includes('message_update')), 'deltas are noise')
  assert.ok(logs.some((l) => l.includes('"message_end"')), 'message_end is logged verbatim')
  assert.ok(logs.some((l) => l === '[pi] agent_end (2 messages, willRetry=false)'), 'agent_end is collapsed to a one-liner')

  // A second turn reuses the process (no respawn) and resets the accumulators.
  hops.length = 0
  const r2 = await session.send('second')
  assert.equal(r2.exitCode, 0)
  assert.equal(hops.length, 1)
  assert.equal(hops[0].hopIndex, 1, 'hop index restarts per turn')
  assert.equal((await fakeLog(f)).filter((s) => s.argv).length, 1, 'still one process')
  session.stop()
})

test('pi persistent session: steer() rides pi\'s native steer command mid-turn; busy while a turn is in flight', { skip: IS_WIN }, async () => {
  const f = await fixture('wait-steer')
  const session = getAdapter('pi').startSession?.({ home: f.home, env: f.env, model: null, fastModel: null, onLog: () => {} })
  assert.ok(session)
  const turn = session.send('do the task')
  const busy = await session.send('another')
  assert.equal(busy.exitCode, 1)
  assert.match(busy.error ?? '', /busy/)
  await delay(150)
  session.steer('quick ping')
  const result = await turn
  assert.equal(result.exitCode, 0, result.error)
  const cmds = (await fakeLog(f)).map((s) => s.cmd).filter(Boolean)
  assert.deepEqual(cmds.map((c) => c!.type), ['get_state', 'prompt', 'steer'])
  assert.equal(cmds[2]!.message, 'quick ping')
  // Idle steer is a no-op (nothing in flight → the daemon's normal turn handles it).
  session.steer('too late')
  await delay(50)
  assert.equal((await fakeLog(f)).map((s) => s.cmd).filter(Boolean).length, 3)
  session.stop()
})

test('pi persistent session: a model error surfaces as a failed turn, not a hang', { skip: IS_WIN }, async () => {
  const f = await fixture('turn-error')
  const session = getAdapter('pi').startSession?.({ home: f.home, env: f.env, model: null, fastModel: null, onLog: () => {} })
  assert.ok(session)
  const result = await session.send('hi')
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /rate limit exceeded \(429\)/)
  assert.equal(session.alive, true, 'the process is still up — only the turn failed')
  session.stop()
})

test('pi persistent session: a prompt rejected by pi settles immediately', { skip: IS_WIN }, async () => {
  const f = await fixture('reject')
  const session = getAdapter('pi').startSession?.({ home: f.home, env: f.env, model: null, fastModel: null, onLog: () => {} })
  assert.ok(session)
  const result = await session.send('hi')
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /rejected the turn: Agent is already streaming/)
  session.stop()
})

test('pi persistent session: process death mid-turn fails the turn with stderr and is logged', { skip: IS_WIN }, async () => {
  const f = await fixture('die')
  const logs: string[] = []
  const session = getAdapter('pi').startSession?.({ home: f.home, env: f.env, model: null, fastModel: null, onLog: (l) => logs.push(l) })
  assert.ok(session)
  const result = await session.send('hi')
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /no models available/i)
  assert.ok(logs.some((l) => /\[session\] engine process died MID-TURN/.test(l)), logs.join('\n'))
  assert.equal(session.alive, false)
  const dead = await session.send('again')
  assert.equal(dead.exitCode, 1)
  assert.match(dead.error ?? '', /no models available|not alive/i)
})

test('pi run() (one-shot) drives the same rpc path for exactly one turn and reports a resumable session id', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const result = await getAdapter('pi').run({
    home: f.home, prompt: 'wake', env: f.env, model: null, fastModel: null,
    resumeSessionId: null, onLog: () => {}, onHopUsage: (r) => hops.push(r), signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 0, result.error)
  assert.ok(result.sessionId, 'a fresh session id is minted so the next wake can resume it')
  assert.equal(hops.length, 1)
  const seen = await fakeLog(f)
  assert.equal(seen[0]?.argv?.[seen[0].argv.indexOf('--session-id') + 1], result.sessionId)
  await delay(100) // stdin closed → the fake exits on its own; nothing to assert beyond no hang
})

test('pi classify() runs a bare json one-shot and returns text + usage + the real model', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const res = await getAdapter('pi').classify({
    cwd: f.home, prompt: '{"instructions":"triage"}', env: f.env, model: 'anthropic/claude-haiku-test', signal: new AbortController().signal,
  })
  assert.equal(res.error, undefined)
  assert.equal(res.text, 'echo:{"instructions":"triage"}')
  assert.equal(res.model, 'claude-test')
  assert.deepEqual(res.usage, { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 687, cache_creation_input_tokens: 10 })
  const argv = (await fakeLog(f))[0]?.argv ?? []
  for (const flag of ['--mode', 'json', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files']) {
    assert.ok(argv.includes(flag), `bare triage spawn carries ${flag}: ${argv.join(' ')}`)
  }
  assert.equal(argv[argv.indexOf('--model') + 1], 'anthropic/claude-haiku-test')
  assert.equal(argv[argv.length - 1], '{"instructions":"triage"}', 'prompt travels as the last argv element on POSIX')
})

test('pi classify()/probe(): a not-logged-in engine surfaces its stderr as the error', { skip: IS_WIN }, async () => {
  const f = await fixture('not-logged-in')
  const res = await getAdapter('pi').classify({ cwd: f.home, prompt: 'x', env: f.env, signal: new AbortController().signal })
  assert.match(res.error ?? '', /No models available/)
  const probe = await getAdapter('pi').probe({ tier: 'big', cwd: f.home, env: f.env, signal: new AbortController().signal })
  assert.match(probe.error ?? '', /No models available/)
})

test('pi classify(): a turn-level model error is an error even though the process exits 0', { skip: IS_WIN }, async () => {
  const f = await fixture('turn-error')
  const res = await getAdapter('pi').classify({ cwd: f.home, prompt: 'x', env: f.env, signal: new AbortController().signal })
  assert.match(res.error ?? '', /rate limit exceeded/)
})

test('pi probeWake() round-trips get_state over rpc; skipped under a CUMORA_PI_ARGS override', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const ok = await getAdapter('pi').probeWake({ cwd: f.home, env: f.env, signal: new AbortController().signal })
  assert.deepEqual(ok, { ok: true, detail: '' })
  const dead = await fixture('die')
  // 'die' only fires on a prompt; get_state still answers → still ok. Kill the
  // fake's answer by pointing PATH at a pi that exits at once instead.
  await writeFile(join(dead.binDir, 'pi'), '#!/bin/sh\necho "fatal: rpc mode unavailable" >&2\nexit 2\n', 'utf8')
  const bad = await getAdapter('pi').probeWake({ cwd: dead.home, env: dead.env, signal: new AbortController().signal })
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /rpc process died before answering get_state .*fatal: rpc mode unavailable/)

  process.env.CUMORA_PI_ARGS = '--custom'
  const skipped = await getAdapter('pi').probeWake({ cwd: f.home, env: f.env, signal: new AbortController().signal })
  assert.equal(skipped.skipped, true)
  assert.equal(getAdapter('pi').startSession?.({ home: f.home, env: f.env, model: null, fastModel: null, onLog: () => {} }), null, 'override → no persistent path')
})
