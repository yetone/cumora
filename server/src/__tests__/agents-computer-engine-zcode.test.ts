/**
 * Contract tests for the BYOA ZCode (`zcode`) adapter.
 *
 * The fake bridge implements the zcode-acp-server wire surface the adapter
 * actually speaks — initialize / session/new|load / session/set_config_option /
 * session/prompt over newline-delimited JSON-RPC — and is injected through
 * CUMORA_ZCODE_ACP_BIN, the same escape hatch operators use, so the resolution
 * seam stays under test. Scenarios cover the pin-retry semantics, the
 * stale-resume self-heal at load time, and the "Session is not active" →
 * resume-not-found mapping at prompt time.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_BRIDGE = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const readline = require('node:readline')
const mode = process.env.FAKE_ACP_MODE || 'ok'
const log = process.env.FAKE_ACP_LOG
let nextSid = 0
let loaded = false
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  if (!req.id || !req.method) return
  if (log) fs.appendFileSync(log, JSON.stringify({ method: req.method, params: req.params }) + '\\n')
  const reply = (result) => out({ jsonrpc: '2.0', id: req.id, result })
  const fail = (message) => out({ jsonrpc: '2.0', id: req.id, error: { message } })
  if (req.method === 'initialize') return reply({})
  if (req.method === 'session/load') {
    if (mode === 'stale-load') return fail('Internal error')
    loaded = true
    return reply({ sessionId: req.params.sessionId })
  }
  if (req.method === 'session/new') {
    loaded = false
    return reply({ sessionId: 'fresh-' + (++nextSid) })
  }
  if (req.method === 'session/set_config_option') {
    if (mode === 'reject-pin') return fail('Internal error')
    return reply({ kind: 'model', currentValue: req.params.value })
  }
  if (req.method === 'session/prompt') {
    if (mode === 'stale-prompt' && loaded) return fail('Session is not active')
    if (mode === 'die-midturn') return process.exit(3)
    out({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })
    return reply({ stopReason: 'end_turn' })
  }
  return reply({})
})
`

interface Fixture { home: string; log: string; env: NodeJS.ProcessEnv; logs: string[] }

async function fixture(scenario = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-zcode-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(home, { recursive: true })
  const fake = join(root, 'fake-acp-bridge.cjs')
  await writeFile(fake, FAKE_BRIDGE, 'utf8')
  await chmod(fake, 0o755)
  const logs: string[] = []
  return {
    home, log, logs,
    env: {
      ...process.env,
      CUMORA_ZCODE_ACP_BIN: fake,
      FAKE_ACP_MODE: scenario,
      FAKE_ACP_LOG: log,
    },
  }
}

async function bridgeLog(f: Fixture): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('zcode persistent session pins the model once and rides one session across wakes', async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const session = getAdapter('zcode').startSession?.({
    home: f.home,
    env: f.env,
    model: 'GLM-5.3',
    standingPrompt: 'scaffold',
    onLog: (line) => f.logs.push(line),
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.ok(session)
  assert.equal(session.carriesStandingPrompt, false, 'no out-of-band standing-prompt channel — the daemon inlines it')

  const first = await session.send('first prompt')
  const second = await session.send('second prompt')
  await session.stop()

  assert.equal(first.exitCode, 0)
  assert.equal(first.sessionId, 'fresh-1')
  assert.equal(second.exitCode, 0)
  assert.equal(second.sessionId, 'fresh-1', 'the same bridge session carries both wakes')
  assert.equal(hops.length, 2, 'one hop per wake')

  const requests = await bridgeLog(f)
  const pins = requests.filter((r) => r.method === 'session/set_config_option')
  assert.equal(pins.length, 1, 'an accepted pin is sent once, not on every wake')
  assert.equal(pins[0].params.configId, 'model')
  assert.equal(pins[0].params.value, 'GLM-5.3')
  const prompts = requests.filter((r) => r.method === 'session/prompt')
  assert.deepEqual(prompts.map((r) => (r.params.prompt as Array<{ text: string }>)[0].text), ['first prompt', 'second prompt'])
  assert.ok(prompts.every((r) => r.params.sessionId === 'fresh-1'))
})

test('zcode retries a rejected model pin on the next wake and still turns', async () => {
  const f = await fixture('reject-pin')
  const session = getAdapter('zcode').startSession?.({
    home: f.home,
    env: f.env,
    model: 'GLM-5.3',
    standingPrompt: null,
    onLog: (line) => f.logs.push(line),
  })
  assert.ok(session)
  const first = await session.send('first prompt')
  const second = await session.send('second prompt')
  await session.stop()

  assert.equal(first.exitCode, 0, 'a rejected pin is a preference loss, not a turn failure')
  assert.equal(second.exitCode, 0)
  assert.ok(f.logs.some((line) => line.includes('model pin rejected')))
  const requests = await bridgeLog(f)
  assert.equal(requests.filter((r) => r.method === 'session/set_config_option').length, 2, 'a rejected pin retries on each wake')
})

test('zcode self-heals a stale resume at load time and reports a fresh session', async () => {
  const f = await fixture('stale-load')
  const session = getAdapter('zcode').startSession?.({
    home: f.home,
    env: f.env,
    model: null,
    standingPrompt: null,
    resumeSessionId: 'stale-sid',
    onLog: (line) => f.logs.push(line),
  })
  assert.ok(session)
  const result = await session.send('first prompt after restart')
  await session.stop()

  assert.equal(result.exitCode, 0)
  assert.equal(result.sessionId, 'fresh-1', 'the fresh session replaces the stale one')
  assert.ok(f.logs.some((line) => line.includes('session/load failed') && line.includes('starting a fresh session')))
  const requests = await bridgeLog(f)
  assert.equal(requests[1]?.method, 'session/load')
  assert.equal(requests[2]?.method, 'session/new')
})

test('zcode maps a mid-life missing backend session to resume-not-found', async () => {
  const f = await fixture('stale-prompt')
  const session = getAdapter('zcode').startSession?.({
    home: f.home,
    env: f.env,
    model: null,
    standingPrompt: null,
    resumeSessionId: 'real-but-dead',
    onLog: (line) => f.logs.push(line),
  })
  assert.ok(session)
  const result = await session.send('prompt a vanished session')
  await session.stop()

  assert.equal(result.exitCode, 1)
  assert.equal(result.failure?.kind, 'resume-not-found', 'the bridge\'s "Session is not active" is not in the generic patterns — the adapter maps it')
  assert.ok(result.error?.includes('Session is not active'))
})

test('zcode a bridge dying MID-TURN resolves the turn as a failure, never rejects', async () => {
  const f = await fixture('die-midturn')
  const session = getAdapter('zcode').startSession?.({
    home: f.home,
    env: f.env,
    model: null,
    standingPrompt: null,
    onLog: (line) => f.logs.push(line),
  })
  assert.ok(session)
  // die() races send()'s own settlement here: the rpc waiters reject while the
  // in-flight turn is already closed. send() must still RESOLVE a failure.
  const result = await session.send('prompt that kills the bridge')
  await session.stop()

  assert.equal(result.exitCode, 3)
  assert.ok(result.error)
  assert.notEqual(result.failure?.kind, 'resume-not-found', 'no resume involved — the generic classifier owns this kind')
})

test('zcode probeWake exercises the bridge handshake and one-shot run returns text', async () => {
  const f = await fixture()
  const adapter = getAdapter('zcode')
  const wake = await adapter.probeWake({ cwd: f.home, env: f.env, signal: AbortSignal.timeout(10_000) })
  assert.equal(wake.ok, true)

  const run = await adapter.run({
    home: f.home,
    prompt: 'echo prompt',
    env: f.env,
    signal: AbortSignal.timeout(10_000),
    onLog: () => {},
  })
  assert.equal(run.exitCode, 0)
  assert.equal(run.sessionId, 'fresh-1')
})
