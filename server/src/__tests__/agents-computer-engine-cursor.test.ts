/**
 * Contract tests for the BYOA Cursor Agent adapter.
 *
 * Cursor is not installed in CI. Each test places a fake `cursor-agent` first
 * on PATH and drives the stream-json shapes observed from Cursor Agent
 * 2026.08.11-e8db854.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEngines, getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_CURSOR_ARGS
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_CURSOR = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const argv = process.argv.slice(2)
const record = (o) => { if (process.env.FAKE_CURSOR_LOG) fs.appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify(o) + '\\n') }
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const scenario = process.env.FAKE_CURSOR_SCENARIO || 'ok'
const resumeAt = argv.indexOf('--resume')
const modelAt = argv.indexOf('--model')
const sid = resumeAt >= 0 ? argv[resumeAt + 1] : 'cursor-session-new'
const model = modelAt >= 0 ? argv[modelAt + 1] : 'Auto'
const prompt = argv[argv.length - 1]
record({ argv, cwd: process.cwd() })
out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: sid, model, permissionMode: 'default' })
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, session_id: sid })
if (scenario === 'turn-error') {
  out({ type: 'result', subtype: 'error', is_error: true, result: 'model unavailable', session_id: sid,
    usage: { inputTokens: 100, outputTokens: 2, cacheReadTokens: 40, cacheWriteTokens: 0 } })
  process.exit(0)
}
const result = { type: 'result', subtype: 'success', is_error: false, result: 'echo:' + prompt, session_id: sid,
  usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 3 } }
if (scenario === 'split-unicode') {
  const line = Buffer.from(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:🧪' + prompt }] }, session_id: sid }) + '\\n')
  const marker = line.indexOf(Buffer.from('🧪'))
  process.stdout.write(line.subarray(0, marker + 1))
  setTimeout(() => { process.stdout.write(line.subarray(marker + 1)); out(result) }, 10)
} else {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo:' + prompt }] }, session_id: sid })
  out(result)
}
`

interface Fixture {
  root: string
  binDir: string
  home: string
  log: string
  env: NodeJS.ProcessEnv
}

async function fixture(scenario = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-cursor-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fake = join(binDir, 'cursor-agent')
  await writeFile(fake, FAKE_CURSOR, 'utf8')
  await chmod(fake, 0o755)
  const log = join(root, 'cursor.log')
  return {
    root,
    binDir,
    home,
    log,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_CURSOR_LOG: log,
      FAKE_CURSOR_SCENARIO: scenario,
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<{ argv: string[]; cwd: string }>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('cursor seedHome writes AGENTS.md and common home directories', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const cursor = getAdapter('cursor')
  await cursor.seedHome(f.home, { id: 'cursor', name: 'Cursor', role: 'Implementer', systemPrompt: 'Implement only.' })
  const agents = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(agents, /^# Cursor — Implementer/)
  assert.match(agents, /Implement only\./)
  assert.match(agents, /`AGENTS\.md` \(this file\)/)
  assert.match(agents, /`\.cursor\/skills\/` — your skills/)
  assert.doesNotMatch(agents, /CLAUDE\.md|\.claude\/skills/)
  assert.ok(existsSync(join(f.home, 'memory', 'MEMORY.md')))
  assert.ok(existsSync(join(f.home, 'workspace')))
  assert.ok(existsSync(join(f.home, '.cursor', 'skills')))
})

test('cursor run parses a fresh stream, normalizes usage, and reports one hop', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const result = await getAdapter('cursor').run({
    home: f.home,
    prompt: 'build it',
    env: f.env,
    model: 'cursor-test-model',
    fastModel: null,
    resumeSessionId: null,
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'cursor-session-new')
  assert.equal(result.model, 'cursor-test-model')
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 12,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 3,
  })
  assert.equal(hops.length, 1)
  assert.equal(hops[0].model, 'cursor-test-model')
  assert.equal(hops[0].textChars, 'echo:build it'.length)
  assert.deepEqual(hops[0].usage, result.usage)

  const argv = (await fakeLog(f))[0]?.argv ?? []
  for (const flag of ['-p', '--output-format', 'stream-json', '--force', '--trust']) {
    assert.ok(argv.includes(flag), `turn carries ${flag}: ${argv.join(' ')}`)
  }
  assert.equal(argv[argv.indexOf('--model') + 1], 'cursor-test-model')
  assert.equal(argv[argv.length - 1], 'build it')
})

test('cursor run resumes the supplied session id in a new process', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const result = await getAdapter('cursor').run({
    home: f.home,
    prompt: 'continue',
    env: f.env,
    model: null,
    fastModel: null,
    resumeSessionId: 'cursor-existing-session',
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 0, result.error)
  assert.equal(result.sessionId, 'cursor-existing-session')
  const argv = (await fakeLog(f))[0]?.argv ?? []
  assert.equal(argv[argv.indexOf('--resume') + 1], 'cursor-existing-session')
  assert.equal(getAdapter('cursor').startSession?.({ home: f.home, env: f.env, onLog: () => {} }) ?? null, null)
})

test('cursor classify is read-only, parses result text and usage, and honors the model', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const result = await getAdapter('cursor').classify({
    cwd: f.home,
    prompt: 'classify this',
    env: f.env,
    model: 'cursor-small',
    signal: new AbortController().signal,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'echo:classify this')
  assert.equal(result.model, 'cursor-small')
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 12,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 3,
  })
  const argv = (await fakeLog(f))[0]?.argv ?? []
  assert.equal(argv[argv.indexOf('--mode') + 1], 'ask')
  assert.ok(argv.includes('--trust'))
  assert.equal(argv.includes('--force'), false, 'triage must remain read-only')
})

test('cursor parser preserves JSON and Unicode split across stdout chunks', { skip: IS_WIN }, async () => {
  const f = await fixture('split-unicode')
  const result = await getAdapter('cursor').classify({
    cwd: f.home,
    prompt: 'split',
    env: f.env,
    signal: new AbortController().signal,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'echo:🧪split')
})

test('cursor stream-reported error fails even when the process exits zero', { skip: IS_WIN }, async () => {
  const f = await fixture('turn-error')
  const result = await getAdapter('cursor').run({
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
  assert.equal(result.sessionId, 'cursor-session-new')
})

test('cursor detection and wake probe expose the one-shot engine contract', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const oldPath = process.env.PATH
  process.env.PATH = f.env.PATH
  try {
    assert.ok((await detectEngines()).includes('cursor'))
  } finally {
    process.env.PATH = oldPath
  }
  const wake = await getAdapter('cursor').probeWake({ cwd: f.home, env: f.env, signal: new AbortController().signal })
  assert.deepEqual(wake, { ok: true, detail: '', skipped: true })
})
