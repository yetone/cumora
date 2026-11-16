/**
 * Contract tests for the BYOA Kimi Code (`kimi acp`) adapter.
 *
 * The fake covers the ACP v1 surface observed against Kimi 2.6.2 and is injected
 * through CUMORA_KIMI_BIN. No test needs a Kimi install, login, or provider call.
 */
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { getAdapter, resolveKimiBin, runEngineDoctor, snapshotDetectedEngines, type EngineHopReport, type EngineSessionArgs } from '../agents/computer/engine.js'

const tempDirs: string[] = []
const liveSessions: Array<{ stop(): void | Promise<void> }> = []
const ORIGINAL_KIMI_BIN = process.env.CUMORA_KIMI_BIN
const ORIGINAL_PATH = process.env.PATH

const FAKE_KIMI_ACP_SOURCE = String.raw`
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logFile = process.env.FAKE_KIMI_LOG
const mode = process.env.FAKE_KIMI_MODE || 'ok'
const argv = process.argv.slice(2)
if (argv.length !== 1 || argv[0] !== 'acp') {
  process.stderr.write('unexpected kimi argv: ' + JSON.stringify(argv) + '\n')
  process.exit(2)
}

let prompts = 0
let pendingPrompt = null
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const record = (entry) => {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n')
}
const finishPrompt = (id, sid) => {
  send({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read AGENTS.md' } },
  })
  send({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'large-text' ? 'x'.repeat(1024 * 1024 + 128) : 'pong #' + prompts } } },
  })
  send({
    jsonrpc: '2.0', id,
    result: mode === 'with-usage'
      ? { stopReason: 'end_turn', usage: { inputTokens: 110, cachedReadTokens: 30, cachedWriteTokens: 10, outputTokens: 15 } }
      : { stopReason: 'end_turn' },
  })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  record({ argv, ...msg })
  if (msg.id !== undefined && !msg.method) {
    if (pendingPrompt) {
      const { id, sid } = pendingPrompt
      pendingPrompt = null
      finishPrompt(id, sid)
    }
    return
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Kimi Code CLI', version: '2.6.2' },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, delete: {} } },
      },
    })
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        sessionId: 'kimi-sess-fresh',
        modes: { currentModeId: 'default', availableModes: [{ id: 'default' }, { id: 'auto' }] },
        configOptions: [
          { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto' }] },
          { id: 'model', currentValue: 'provider/default-model', options: [{ value: 'provider/default-model', name: 'Default model' }] },
        ],
      },
    })
  } else if (msg.method === 'session/resume') {
    if (mode === 'fail-load' || mode === 'auth-load' || mode === 'internal-load') {
      send({
        jsonrpc: '2.0', id: msg.id,
        error: mode === 'auth-load'
          ? { code: -32002, message: 'Authentication required: run kimi login' }
          : mode === 'internal-load'
            ? { code: -32603, message: 'Internal error' }
            : { code: -32602, message: 'Invalid params: Unknown sessionId: ' + msg.params.sessionId, data: { sessionId: msg.params.sessionId } },
      })
    } else {
      if (mode === 'replay-on-resume') {
        send({
          jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'STALE_REPLAY_TEXT ' } } },
        })
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: msg.params.sessionId, configOptions: [] } })
    }
  } else if (msg.method === 'session/set_config_option') {
    if (msg.params?.configId === 'mode' && msg.params?.value === 'auto' && mode !== 'reject-mode') {
      send({ jsonrpc: '2.0', id: msg.id, result: { id: 'mode', currentValue: 'auto' } })
    } else if (msg.params?.configId === 'mode') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: unsupported mode' } })
    } else if (msg.params?.configId === 'model' && mode !== 'reject-pin') {
      const currentValue = mode === 'mismatch-pin' ? 'provider/default-model' : msg.params.value
      send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [{ id: 'model', currentValue }] } })
    } else if (msg.params?.configId === 'model') {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: Unknown model: ' + msg.params.value } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: unknown config option' } })
    }
  } else if (msg.method === 'session/delete') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
  } else if (msg.method === 'session/prompt') {
    prompts += 1
    if (mode === 'die-mid-turn') process.exit(17)
    if (mode === 'session-gone' || (mode === 'session-gone-after-first' && prompts >= 2)) {
      send({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -32602, message: 'Invalid params: Unknown sessionId: ' + msg.params.sessionId, data: { sessionId: msg.params.sessionId } },
      })
      return
    }
    if (mode === 'cancelled' || mode === 'refusal') {
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: mode } })
      return
    }
    if (mode === 'unterminated-frame') {
      process.stdout.write('{"padding":"' + 'x'.repeat(9 * 1024 * 1024))
      return
    }
    if (mode === 'ask-question') {
      pendingPrompt = { id: msg.id, sid: msg.params.sessionId }
      send({
        jsonrpc: '2.0', id: msg.id, method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'tc-question', title: 'AskUserQuestion' },
          options: [
            { optionId: 'q0_opt_0', name: 'First answer', kind: 'allow_once' },
            { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' },
          ],
        },
      })
      return
    }
    if (mode === 'ask-permission' || mode === 'ask-permission-once' || mode === 'ask-permission-reject-only') {
      pendingPrompt = { id: msg.id, sid: msg.params.sessionId }
      const options = mode === 'ask-permission'
        ? [
            { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'opt-allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
          ]
        : mode === 'ask-permission-once'
          ? [{ optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' }]
          : [{ optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' }]
      send({
        jsonrpc: '2.0', id: msg.id, method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: { toolCallId: 'tc-perm', title: 'npm test', kind: 'execute' },
          options,
        },
      })
      return
    }
    if (mode === 'ask-elicitation') {
      pendingPrompt = { id: msg.id, sid: msg.params.sessionId }
      send({
        jsonrpc: '2.0', id: msg.id, method: 'elicitation/create',
        params: {
          sessionId: msg.params.sessionId,
          message: 'Which option should the daemon choose?',
          requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      })
      return
    }
    const sid = msg.params.sessionId
    if (mode === 'split-utf8') {
      const frame = Buffer.from(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好世界' } } },
      }) + '\n', 'utf8')
      const cut = frame.indexOf(0xe4) + 1
      process.stdout.write(frame.subarray(0, cut))
      setTimeout(() => {
        process.stdout.write(frame.subarray(cut))
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
      }, 15)
      return
    }
    finishPrompt(msg.id, sid)
  }
})
`

interface Fixture {
  home: string
  env: NodeJS.ProcessEnv
  lines: string[]
  readCalls: () => Promise<Array<{ argv?: string[]; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }>>
}

async function makeFixture(mode = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-kimi-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const bridge = join(root, 'fake-kimi.mjs')
  const logFile = join(root, 'calls.jsonl')
  await writeFile(bridge, FAKE_KIMI_ACP_SOURCE, 'utf8')
  const lines: string[] = []
  return {
    home,
    lines,
    env: {
      ...process.env,
      CUMORA_KIMI_BIN: bridge,
      FAKE_KIMI_LOG: logFile,
      FAKE_KIMI_MODE: mode,
    },
    readCalls: async () => {
      const raw = await readFile(logFile, 'utf8').catch(() => '')
      return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    },
  }
}

function startKimiSession(f: Fixture, overrides: Partial<Omit<EngineSessionArgs, 'home' | 'env'>> = {}) {
  const session = getAdapter('kimi').startSession?.({
    home: f.home,
    env: f.env,
    standingPrompt: null,
    resumeSessionId: null,
    onLog: () => {},
    ...overrides,
  })
  assert.ok(session)
  liveSessions.push(session)
  return session
}

afterEach(async () => {
  if (ORIGINAL_KIMI_BIN === undefined) delete process.env.CUMORA_KIMI_BIN
  else process.env.CUMORA_KIMI_BIN = ORIGINAL_KIMI_BIN
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  for (const session of liveSessions.splice(0)) {
    try { await session.stop() } catch { /* already gone */ }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('kimi wake and triage both use kimi acp, and only disposable triage is deleted', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('kimi')
  const session = startKimiSession(f)
  await session.send('wake turn')
  await session.stop()

  const classified = await adapter.classify({ cwd: f.home, env: f.env, prompt: 'Actionable?', signal: AbortSignal.timeout(10_000) })
  assert.equal(classified.error, undefined)
  assert.equal(classified.text, 'pong #1')

  const calls = await f.readCalls()
  assert.ok(calls.every((call) => JSON.stringify(call.argv) === JSON.stringify(['acp'])))
  assert.equal(calls.filter((call) => call.method === 'session/delete').length, 1, 'persistent wakes stay resumable; triage is disposable')
})

test('kimi orders initialize → new → auto mode → model pin → prompt and pins once across wakes', async () => {
  const f = await makeFixture()
  const logs: string[] = []
  const hops: EngineHopReport[] = []
  const session = startKimiSession(f, {
    model: 'provider/chosen-model',
    standingPrompt: 'inlined by the daemon instead',
    onLog: (line) => logs.push(line),
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.equal(session.carriesStandingPrompt, false)

  const first = await session.send('first wake')
  const second = await session.send('second wake')
  assert.equal(first.exitCode, 0)
  assert.equal(second.exitCode, 0)
  assert.equal(first.sessionId, 'kimi-sess-fresh')
  assert.equal(second.sessionId, 'kimi-sess-fresh')
  assert.equal(first.model, 'provider/chosen-model')
  assert.equal(hops.length, 2)
  assert.equal(hops[0]?.model, 'provider/chosen-model')
  assert.equal(hops[0]?.textChars, 'pong #1'.length)
  assert.ok(logs.some((line) => line.includes('[kimi] tool Read AGENTS.md')))
  assert.ok(logs.some((line) => line.includes('pong #2')))

  const calls = await f.readCalls()
  assert.deepEqual(calls.map((call) => call.method), [
    'initialize', 'session/new', 'session/set_config_option', 'session/set_config_option', 'session/prompt', 'session/prompt',
  ])
  assert.deepEqual(calls[2]?.params, { sessionId: 'kimi-sess-fresh', configId: 'mode', value: 'auto' })
  assert.deepEqual(calls[3]?.params, { sessionId: 'kimi-sess-fresh', configId: 'model', value: 'provider/chosen-model' })
})

test('kimi keeps turns alive on rejected mode and model preferences without misreporting the model', async () => {
  const f = await makeFixture('reject-mode')
  const modeSession = startKimiSession(f, { onLog: (line) => f.lines.push(line) })
  assert.equal((await modeSession.send('mode fallback')).exitCode, 0)
  assert.ok(f.lines.some((line) => line.includes('[kimi] auto mode rejected')))

  const rejected = await makeFixture('reject-pin')
  const logs: string[] = []
  const session = startKimiSession(rejected, { model: 'unknown/model', onLog: (line) => logs.push(line) })
  const first = await session.send('first wake')
  const second = await session.send('second wake')
  assert.equal(first.exitCode, 0)
  assert.equal(first.model, '<kimi-default>')
  assert.equal(second.exitCode, 0)
  assert.ok(logs.some((line) => line.includes('[kimi] model pin (unknown/model) rejected') && line.includes('engine default')))
  const calls = await rejected.readCalls()
  assert.equal(calls.filter((call) => call.method === 'session/set_config_option' && call.params?.configId === 'model').length, 1)
})

test('kimi attaches with session/resume and keeps replayed history out of the new turn', async () => {
  const f = await makeFixture('replay-on-resume')
  const logs: string[] = []
  const session = startKimiSession(f, {
    model: 'provider/chosen-model',
    resumeSessionId: 'kimi-sess-existing',
    onLog: (line) => logs.push(line),
  })
  const result = await session.send('wake after resume')
  assert.equal(result.exitCode, 0)
  assert.equal(result.sessionId, 'kimi-sess-existing')
  assert.equal(logs.some((line) => line.includes('STALE_REPLAY_TEXT')), false)
  assert.ok(logs.some((line) => line.includes('pong #1')))
  assert.deepEqual((await f.readCalls()).map((call) => call.method), [
    'initialize', 'session/resume', 'session/set_config_option', 'session/set_config_option', 'session/prompt',
  ])
})

test('kimi self-heals a stale session/resume through session/new', async () => {
  const f = await makeFixture('fail-load')
  const logs: string[] = []
  const session = startKimiSession(f, { resumeSessionId: 'kimi-sess-stale', onLog: (line) => logs.push(line) })
  const result = await session.send('after stale resume')
  assert.equal(result.exitCode, 0)
  assert.equal(result.sessionId, 'kimi-sess-fresh')
  assert.ok(logs.some((line) => line.includes('session/resume failed') && line.includes('fresh session')))
  assert.deepEqual((await f.readCalls()).slice(0, 3).map((call) => call.method), ['initialize', 'session/resume', 'session/new'])
})

test('kimi maps unknown sessions to resume-not-found, including after a successful turn', async () => {
  const gone = await makeFixture('session-gone')
  const session = startKimiSession(gone, { resumeSessionId: 'kimi-sess-stale' })
  const result = await session.send('turn on a dead session')
  assert.equal(result.exitCode, 1)
  assert.equal(result.failure?.kind, 'resume-not-found')
  assert.match(result.error ?? '', /Unknown sessionId/i)

  const afterFirst = await makeFixture('session-gone-after-first')
  const recovered = startKimiSession(afterFirst, { resumeSessionId: 'kimi-sess-existing' })
  assert.equal((await recovered.send('first turn')).exitCode, 0)
  assert.equal((await recovered.send('second turn')).failure?.kind, 'resume-not-found')
})

test('kimi auto-answers permission requests preferring allow_always, then allow_once, then cancels', async () => {
  const cases: Array<[string, unknown]> = [
    ['ask-permission', { outcome: { outcome: 'selected', optionId: 'opt-allow-always' } }],
    ['ask-permission-once', { outcome: { outcome: 'selected', optionId: 'opt-allow-once' } }],
    ['ask-permission-reject-only', { outcome: { outcome: 'cancelled' } }],
  ]
  for (const [mode, expected] of cases) {
    const f = await makeFixture(mode)
    const session = startKimiSession(f)
    const result = await session.send('do something requiring permission')
    assert.equal(result.exitCode, 0, mode)
    const calls = await f.readCalls()
    const prompt = calls.find((call) => call.method === 'session/prompt')
    const reply = calls.find((call) => call.id === prompt?.id && !call.method)
    assert.deepEqual(reply?.result, expected, mode)
    await session.stop()
  }
})

test('kimi cancels elicitation instead of inventing an operator answer', async () => {
  const f = await makeFixture('ask-elicitation')
  const session = startKimiSession(f)
  const result = await session.send('ask the operator a structured question')
  assert.equal(result.exitCode, 0)
  const calls = await f.readCalls()
  const prompt = calls.find((call) => call.method === 'session/prompt')
  const reply = calls.find((call) => call.id === prompt?.id && !call.method)
  assert.deepEqual(reply?.result, { action: 'cancel' })
})

test('kimi treats stopReason=cancelled as a failed turn', async () => {
  const f = await makeFixture('cancelled')
  const hops: EngineHopReport[] = []
  const session = startKimiSession(f, { onHopUsage: (hop) => hops.push(hop) })
  const result = await session.send('cancel this turn')
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /cancelled/i)
  assert.equal(hops.length, 0)
})

test('kimi steering stays on the next-wake path and warns only once', async () => {
  const f = await makeFixture()
  const session = startKimiSession(f, { onLog: (line) => f.lines.push(line) })
  session.steer('first ping')
  session.steer('second ping')
  assert.equal(f.lines.filter((line) => line.includes('[kimi] same-turn steer')).length, 1)
  assert.equal((await f.readCalls()).some((call) => call.method === '_session/steering'), false)
})

test('kimi process death mid-turn resolves a failure', async () => {
  const f = await makeFixture('die-mid-turn')
  const session = startKimiSession(f)
  const result = await session.send('crash now')
  assert.equal(result.exitCode, 17)
  assert.match(result.error ?? '', /exited with code 17/)
  assert.equal(session.alive, false)
})

test('kimi seedHome writes Kimi instructions and preserves existing memory', async () => {
  const f = await makeFixture()
  await mkdir(join(f.home, 'memory'), { recursive: true })
  await writeFile(join(f.home, 'memory', 'MEMORY.md'), 'operator memory', 'utf8')
  const adapter = getAdapter('kimi')
  const persona = { id: 'agent-kimi', name: 'Kimi Engineer', role: 'engineer', systemPrompt: 'Follow first principles.' }
  await adapter.seedHome(f.home, persona)
  await adapter.seedHome(f.home, persona)
  const agents = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(agents, /Kimi Engineer/)
  assert.match(agents, /\.kimi-code\/skills\//)
  assert.equal((await stat(join(f.home, '.kimi-code', 'skills'))).isDirectory(), true)
  assert.equal(await readFile(join(f.home, 'memory', 'MEMORY.md'), 'utf8'), 'operator memory')
})

test('kimi probeWake deletes its probe, one-shot run resumes, and doctor deletes its session', async () => {
  const f = await makeFixture()
  const adapter = getAdapter('kimi')
  const controller = new AbortController()
  const wake = await adapter.probeWake({ cwd: f.home, env: f.env, signal: controller.signal })
  assert.equal(wake.ok, true)

  const oneShot = await adapter.run({
    home: f.home,
    env: f.env,
    prompt: 'say pong',
    resumeSessionId: 'kimi-sess-resumed-run',
    signal: controller.signal,
    onLog: () => {},
  })
  assert.equal(oneShot.exitCode, 0)
  assert.equal(oneShot.sessionId, 'kimi-sess-resumed-run')
  assert.ok((await f.readCalls()).some((call) => call.method === 'session/resume' && call.params?.sessionId === 'kimi-sess-resumed-run'))

  const probed = await adapter.probe({ cwd: f.home, env: f.env, tier: 'big', signal: controller.signal })
  assert.equal(probed.text, 'pong #1')
  const calls = await f.readCalls()
  assert.equal(calls.filter((call) => call.method === 'session/delete').length, 2, 'wake probe and doctor are disposable; one-shot run is not')
})

test('kimi resolves no bin for another engine and reports a failed handshake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-kimi-path-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const other = join(binDir, process.platform === 'win32' ? 'omp.cmd' : 'omp')
  await writeFile(other, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(other, 0o755)
  assert.equal(resolveKimiBin({ PATH: binDir }), null)

  const wake = await getAdapter('kimi').probeWake({
    cwd: root,
    env: { ...process.env, CUMORA_KIMI_BIN: join(root, 'missing-kimi.mjs') },
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(wake.ok, false)
  assert.match(wake.detail, /kimi acp handshake failed/)
})

test('kimi maps ACP usage when supplied and tolerates its absence', async () => {
  const f = await makeFixture('with-usage')
  const hops: EngineHopReport[] = []
  const session = startKimiSession(f, { onHopUsage: (hop) => hops.push(hop) })
  const result = await session.send('turn with usage')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.usage, {
    input_tokens: 110,
    output_tokens: 15,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 10,
  })
  assert.deepEqual(hops[0]?.usage, result.usage)

  const absent = await makeFixture()
  const noUsage = startKimiSession(absent)
  const plain = await noUsage.send('turn without usage')
  assert.equal(plain.exitCode, 0)
  assert.equal(plain.usage, undefined)
})

test('kimi does not replace a session on non-stale resume failures', async () => {
  for (const mode of ['auth-load', 'internal-load']) {
    const f = await makeFixture(mode)
    const session = startKimiSession(f, { resumeSessionId: 'kimi-sess-existing' })
    const result = await session.send('must not run')
    assert.equal(result.exitCode, 1, mode)
    if (mode === 'auth-load') assert.equal(result.failure?.kind, 'authentication')
    const calls = await f.readCalls()
    assert.deepEqual(calls.map((call) => call.method), ['initialize', 'session/resume'], mode)
    assert.equal(calls.some((call) => call.method === 'session/new' || call.method === 'session/prompt'), false, mode)
  }
})

test('kimi dismisses AskUserQuestion permission bridges instead of selecting an answer', async () => {
  const f = await makeFixture('ask-question')
  const session = startKimiSession(f)
  assert.equal((await session.send('question')).exitCode, 0)
  const calls = await f.readCalls()
  const prompt = calls.find((call) => call.method === 'session/prompt')
  const reply = calls.find((call) => call.id === prompt?.id && !call.method)
  assert.deepEqual(reply?.result, { outcome: { outcome: 'cancelled' } })
})

test('kimi treats refusal as a failed turn without a successful hop', async () => {
  const f = await makeFixture('refusal')
  const hops: EngineHopReport[] = []
  const session = startKimiSession(f, { onHopUsage: (hop) => hops.push(hop) })
  const result = await session.send('blocked turn')
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /refusal/)
  assert.equal(hops.length, 0)
})

test('kimi reports the acknowledged model when a pin mismatches', async () => {
  const f = await makeFixture('mismatch-pin')
  const hops: EngineHopReport[] = []
  const session = startKimiSession(f, {
    model: 'provider/requested-model',
    onLog: (line) => f.lines.push(line),
    onHopUsage: (hop) => hops.push(hop),
  })
  const result = await session.send('model mismatch')
  assert.equal(result.exitCode, 0)
  assert.equal(result.model, 'provider/default-model')
  assert.equal(hops[0]?.model, 'provider/default-model')
  assert.ok(f.lines.some((line) => line.includes('acknowledged a different model')))
})

test('kimi rejects an unterminated oversized ACP frame', async () => {
  const f = await makeFixture('unterminated-frame')
  const session = startKimiSession(f, { onLog: (line) => f.lines.push(line) })
  const result = await session.send('oversized frame')
  assert.notEqual(result.exitCode, 0)
  assert.match(result.error ?? '', /ACP frame exceeded/)
  assert.equal(session.alive, false)
})

test('kimi bounds one-shot text accumulation', async () => {
  const f = await makeFixture('large-text')
  const result = await getAdapter('kimi').classify({
    cwd: f.home,
    env: f.env,
    prompt: 'large output',
    onLog: (line) => f.lines.push(line),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(result.error, undefined)
  assert.equal(result.text.length, 1024 * 1024)
  assert.ok(f.lines.some((line) => line.includes('one-shot text output truncated')))
})

test('kimi snapshots and doctor honor CUMORA_KIMI_BIN over a wrong PATH', { skip: process.platform === 'win32' }, async () => {
  const f = await makeFixture()
  const wrongBinDir = join(f.home, 'wrong-bin')
  await mkdir(wrongBinDir, { recursive: true })
  const wrongBin = join(wrongBinDir, 'kimi')
  await writeFile(wrongBin, '#!/bin/sh\necho wrong-kimi >&2\nexit 91\n', 'utf8')
  await chmod(wrongBin, 0o755)
  process.env.CUMORA_KIMI_BIN = f.env.CUMORA_KIMI_BIN
  process.env.PATH = `${wrongBinDir}:${ORIGINAL_PATH ?? ''}`

  const snapshot = await snapshotDetectedEngines(['kimi'])
  assert.equal(snapshot[0]?.path, f.env.CUMORA_KIMI_BIN)
  const [health] = await runEngineDoctor({
    engines: ['kimi'],
    env: { ...f.env, PATH: process.env.PATH },
    timeoutMs: 10_000,
  })
  assert.equal(health?.installed, true)
  assert.equal(health?.path, f.env.CUMORA_KIMI_BIN)
  assert.equal(health?.big?.ok, true)
  assert.equal(health?.small?.ok, true)
  assert.equal(health?.wake?.ok, true)
})

test('kimi decodes multi-byte UTF-8 split across stdout chunks', async () => {
  const f = await makeFixture('split-utf8')
  const classified = await getAdapter('kimi').classify({
    cwd: f.home,
    env: f.env,
    prompt: 'say hello in Chinese',
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(classified.error, undefined)
  assert.equal(classified.text, '你好世界')
  assert.equal(classified.text.includes('\uFFFD'), false)
})
