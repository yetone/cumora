/**
 * Contract tests for the BYOA OpenCode adapter.
 *
 * OpenCode is not installed in CI. Each test puts a fake `opencode` first on
 * PATH and drives the JSONL shapes emitted by `opencode run --format json`
 * v1.18.20.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEngines, getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_OPENCODE_ARGS
  delete process.env.CUMORA_TRIAGE_ARGS
  process.env.PATH = ORIGINAL_PATH
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_OPENCODE = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const argv = process.argv.slice(2)
const scenario = process.env.FAKE_OPENCODE_SCENARIO || 'ok'
let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  const sessionAt = argv.indexOf('--session')
  const modelAt = argv.indexOf('--model')
  const sid = sessionAt >= 0 ? argv[sessionAt + 1] : 'ses_opencode_new'
  const model = modelAt >= 0 ? argv[modelAt + 1] : null
  if (process.env.FAKE_OPENCODE_LOG) {
    fs.appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify({
      argv, stdin, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT || null,
    }) + '\\n')
  }
  const out = (event) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), sessionID: sid, ...event }) + '\\n')
  if (scenario === 'stream-error') {
    out({ type: 'error', error: { name: 'ProviderError', data: { message: 'model unavailable' } } })
    return
  }
  if (scenario === 'nonzero') {
    process.stderr.write('authentication required\\n')
    process.exitCode = 2
    return
  }
  if (scenario === 'stderr-json') {
    // Diagnostics may happen to be JSON. They are not part of OpenCode's
    // stdout protocol and must not alter session/error/usage state.
    process.stderr.write(JSON.stringify({ sessionID: 'ses_stderr', type: 'step_finish', part: {
      tokens: { input: 900, output: 90, reasoning: 9, cache: { read: 80, write: 7 } },
    } }) + '\\n')
    process.stderr.write(JSON.stringify({ sessionID: 'ses_stderr', type: 'error', error: {
      data: { message: 'stderr diagnostic only' },
    } }) + '\\n')
  }
  out({ type: 'step_start', part: { type: 'step-start' } })
  if (scenario === 'missing-finish') {
    out({ type: 'text', part: { type: 'text', text: 'partial', time: { end: Date.now() } } })
    return
  }
  if (scenario === 'multi-hop') {
    out({ type: 'tool_use', part: { type: 'tool', tool: 'bash', state: { status: 'completed' } } })
    out({ type: 'step_finish', part: { type: 'step-finish', tokens: {
      input: 10, output: 2, reasoning: 1, cache: { read: 4, write: 1 },
    } } })
    out({ type: 'step_start', part: { type: 'step-start' } })
  }
  const textEvent = { type: 'text', part: { type: 'text', text: 'echo:' + stdin, time: { end: Date.now() } } }
  if (scenario === 'split-unicode') {
    textEvent.part.text = 'echo:🧪' + stdin
    const line = Buffer.from(JSON.stringify({ timestamp: Date.now(), sessionID: sid, ...textEvent }) + '\\n')
    const marker = line.indexOf(Buffer.from('🧪'))
    process.stdout.write(line.subarray(0, marker + 1))
    setTimeout(() => {
      process.stdout.write(line.subarray(marker + 1))
      out({ type: 'step_finish', part: { type: 'step-finish', tokens: {
        input: 100, output: 12, reasoning: 3, cache: { read: 40, write: 2 },
      } } })
    }, 10)
    return
  }
  out(textEvent)
  out({ type: 'step_finish', part: { type: 'step-finish', model, tokens: {
    input: 100, output: 12, reasoning: 3, cache: { read: 40, write: 2 },
  } } })
})
`

interface Fixture {
  root: string
  home: string
  log: string
  env: NodeJS.ProcessEnv
}

async function fixture(scenario = 'ok', extraEnv: NodeJS.ProcessEnv = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-opencode-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(binDir)
  await mkdir(home)
  const fake = join(binDir, 'opencode')
  await writeFile(fake, FAKE_OPENCODE, 'utf8')
  await chmod(fake, 0o755)
  return {
    root,
    home,
    log,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`,
      FAKE_OPENCODE_LOG: log,
      FAKE_OPENCODE_SCENARIO: scenario,
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<{
  argv: string[]
  stdin: string
  cwd: string
  config: string | null
}>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test('opencode seedHome writes AGENTS.md, native skills, and common directories', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const adapter = getAdapter('opencode')
  await adapter.seedHome(f.home, {
    id: 'opencode', name: 'Open', role: 'Implementer', systemPrompt: 'Implement only.',
  })

  const agents = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(agents, /^# Open — Implementer/)
  assert.match(agents, /Implement only\./)
  assert.match(agents, /`AGENTS\.md` \(this file\)/)
  assert.match(agents, /`\.opencode\/skills\/` — your skills/)
  assert.doesNotMatch(agents, /CLAUDE\.md|\.claude\/skills|\.cursor\/skills/)
  assert.ok(existsSync(join(f.home, 'memory', 'MEMORY.md')))
  assert.ok(existsSync(join(f.home, 'workspace')))
  assert.ok(existsSync(join(f.home, '.opencode', 'skills')))
})

test('opencode run streams a turn, normalizes usage, and sends the prompt through stdin', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'build it & keep $literal',
    env: f.env,
    model: 'anthropic/claude-sonnet-4-6',
    fastModel: null,
    resumeSessionId: null,
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'ses_opencode_new')
  assert.equal(result.model, 'anthropic/claude-sonnet-4-6')
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 15,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 2,
  })
  assert.equal(hops.length, 1)
  assert.equal(hops[0].model, 'anthropic/claude-sonnet-4-6')
  assert.equal(hops[0].textChars, 'echo:build it & keep $literal'.length)
  assert.deepEqual(hops[0].usage, result.usage)

  const call = (await fakeLog(f))[0]
  assert.ok(call)
  assert.deepEqual(call.argv.slice(0, 4), ['run', '--format', 'json', '--auto'])
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'anthropic/claude-sonnet-4-6')
  assert.equal(call.argv.includes('build it & keep $literal'), false, 'large/shell-sensitive prompt must not use argv')
  assert.equal(call.stdin, 'build it & keep $literal')
})

test('opencode run resumes a session and uses an honest fallback model label', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'continue',
    env: f.env,
    model: null,
    fastModel: null,
    resumeSessionId: 'ses_existing',
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'ses_existing')
  assert.equal(result.model, null, 'the stream does not name an unpinned provider model')
  assert.equal(hops[0]?.model, 'opencode', 'do not invent a provider/model id')
  const argv = (await fakeLog(f))[0]?.argv ?? []
  assert.equal(argv[argv.indexOf('--session') + 1], 'ses_existing')
  assert.equal(getAdapter('opencode').startSession?.({ home: f.home, env: f.env, onLog: () => {} }) ?? null, null)
})

test('opencode reports every step_finish as a hop and sums turn usage', { skip: IS_WIN }, async () => {
  const f = await fixture('multi-hop')
  const hops: EngineHopReport[] = []
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'two steps',
    env: f.env,
    model: 'openai/gpt-5.5',
    fastModel: null,
    resumeSessionId: null,
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 0, result.error)
  assert.equal(hops.length, 2)
  assert.equal(hops[0].toolUses, 1)
  assert.deepEqual(result.usage, {
    input_tokens: 110,
    output_tokens: 18,
    cache_read_input_tokens: 44,
    cache_creation_input_tokens: 3,
  })
})

test('opencode triage is tool-free, parses JSONL, and preserves inline provider config', { skip: IS_WIN }, async () => {
  const f = await fixture('ok', {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      theme: 'system',
      agent: { mine: { description: 'keep me', mode: 'primary' } },
    }),
  })
  const result = await getAdapter('opencode').classify({
    cwd: f.home,
    prompt: 'classify this',
    env: f.env,
    model: 'openai/gpt-5.4-mini',
    signal: new AbortController().signal,
  })

  assert.equal(result.error, undefined)
  assert.equal(result.text, 'echo:classify this')
  assert.equal(result.model, 'openai/gpt-5.4-mini')
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 15,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 2,
  })
  const call = (await fakeLog(f))[0]
  assert.ok(call)
  assert.equal(call.argv.includes('--auto'), false, 'triage must never auto-approve tools')
  assert.equal(call.argv[call.argv.indexOf('--agent') + 1], 'cumora-triage')
  assert.equal(call.stdin, 'classify this')
  const config = JSON.parse(call.config ?? '{}') as {
    theme?: string
    agent?: Record<string, { description?: string; permission?: Record<string, string> }>
  }
  assert.equal(config.theme, 'system')
  assert.equal(config.agent?.mine?.description, 'keep me')
  assert.equal(config.agent?.['cumora-triage']?.permission?.['*'], 'deny')
})

test('opencode parser preserves a Unicode JSON line split across chunks', { skip: IS_WIN }, async () => {
  const f = await fixture('split-unicode')
  const result = await getAdapter('opencode').classify({
    cwd: f.home,
    prompt: 'split',
    env: f.env,
    signal: new AbortController().signal,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'echo:🧪split')
  assert.equal(result.usage?.output_tokens, 15)
})

test('opencode stream error fails a turn even when the process exits zero', { skip: IS_WIN }, async () => {
  const f = await fixture('stream-error')
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'fail',
    env: f.env,
    model: null,
    fastModel: null,
    resumeSessionId: null,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /model unavailable/)
  assert.equal(result.sessionId, 'ses_opencode_new')
})

test('opencode never parses JSON diagnostics from stderr as protocol events', { skip: IS_WIN }, async () => {
  const f = await fixture('stderr-json')
  const hops: EngineHopReport[] = []
  const logs: string[] = []
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'stderr stays diagnostic',
    env: f.env,
    model: null,
    fastModel: null,
    resumeSessionId: null,
    onLog: (line) => logs.push(line),
    onHopUsage: (hop) => hops.push(hop),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'ses_opencode_new')
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 15,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 2,
  })
  assert.equal(hops.length, 1)
  assert.ok(logs.some((line) => line.includes('stderr diagnostic only')), 'stderr stays observable')
})

test('opencode accepts a clean exit when the best-effort stream omits step_finish', { skip: IS_WIN }, async () => {
  const f = await fixture('missing-finish')
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'unfinished',
    env: f.env,
    model: null,
    fastModel: null,
    resumeSessionId: null,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'ses_opencode_new')
  assert.equal(result.usage, undefined)
})

test('opencode preserves a non-zero process failure instead of misreporting a protocol error', { skip: IS_WIN }, async () => {
  const f = await fixture('nonzero')
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'authenticate',
    env: f.env,
    model: null,
    fastModel: null,
    resumeSessionId: null,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 2)
  assert.match(result.error ?? '', /authentication required/)
})

test('opencode custom args keep stdin and resume while making output opaque', { skip: IS_WIN }, async () => {
  process.env.CUMORA_OPENCODE_ARGS = '--pure'
  const f = await fixture()
  const result = await getAdapter('opencode').run({
    home: f.home,
    prompt: 'custom',
    env: f.env,
    model: 'ignored/by-override',
    fastModel: null,
    resumeSessionId: 'ses_custom',
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'ses_custom', 'camelCase sessionID must survive the opaque override path')
  const call = (await fakeLog(f))[0]
  assert.deepEqual(call?.argv, ['run', '--pure', '--session', 'ses_custom'])
  assert.equal(call?.stdin, 'custom')
})

test('opencode detection and wake probe expose the one-shot contract', { skip: IS_WIN }, async () => {
  const f = await fixture()
  process.env.PATH = f.env.PATH
  assert.ok((await detectEngines()).includes('opencode'))
  const wake = await getAdapter('opencode').probeWake({
    cwd: f.home,
    env: f.env,
    signal: new AbortController().signal,
  })
  assert.deepEqual(wake, { ok: true, detail: '', skipped: true })
})
