/**
 * Contract tests for the BYOA Antigravity (`agy`) adapter.
 *
 * The fake binary implements Antigravity's documented bidirectional NDJSON
 * protocol: one user event on stdin per turn, one cumulative result envelope
 * back. Keeping the fixture cumulative is load-bearing — it catches the most
 * expensive adapter bug: billing prior turns again on every wake.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectEngines, getAdapter, type EngineHopReport } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const tempDirs: string[] = []

afterEach(async () => {
  delete process.env.CUMORA_TRIAGE_MODEL
  process.env.PATH = ORIGINAL_PATH
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const FAKE_AGY = `#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const readline = require('node:readline')
const argv = process.argv.slice(2)
const log = process.env.FAKE_AGY_LOG
if (log) fs.appendFileSync(log, JSON.stringify({ type: 'start', argv, cwd: process.cwd() }) + '\\n')
let turn = 0
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
out({ event: 'init', conversation_id: 'agy-conversation-1', init: { conversation_id: 'agy-conversation-1', model: 'Gemini 3.5 Flash (High)' } })
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  const event = JSON.parse(line)
  const content = event?.message?.content || ''
  if (log) fs.appendFileSync(log, JSON.stringify({ type: 'prompt', event }) + '\\n')
  turn += 1
  if (process.env.FAKE_AGY_SCENARIO === 'error') {
    out({ event: 'result', result: {
      conversation_id: 'agy-conversation-1', status: 'ERROR', response: '', error: 'quota exhausted',
      duration_seconds: 0.1, num_turns: turn,
      usage: { input_tokens: 10, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 10 },
    } })
    return
  }
  out({ event: 'step_update', step_update: {
    conversation_id: 'agy-conversation-1', step_index: turn, state: 'DONE', step_type: 'tool',
    tool_info: { name: 'run_command' },
  } })
  const usage = turn === 1
    ? { input_tokens: 100, output_tokens: 10, thinking_tokens: 4, cache_read_tokens: 40, total_tokens: 110 }
    : { input_tokens: 160, output_tokens: 16, thinking_tokens: 7, cache_read_tokens: 70, total_tokens: 176 }
  out({ event: 'result', result: {
    conversation_id: 'agy-conversation-1', status: 'SUCCESS', response: 'echo:' + content,
    duration_seconds: turn, num_turns: turn, model: 'Gemini 3.5 Flash (High)', usage,
  } })
})
`

interface Fixture { root: string; home: string; log: string; env: NodeJS.ProcessEnv }

async function fixture(scenario = 'ok'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-antigravity-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  const log = join(root, 'fake.log')
  await mkdir(binDir)
  await mkdir(home)
  const fake = join(binDir, 'agy')
  await writeFile(fake, FAKE_AGY, 'utf8')
  await chmod(fake, 0o755)
  return {
    root, home, log,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`,
      FAKE_AGY_LOG: log,
      FAKE_AGY_SCENARIO: scenario,
    },
  }
}

async function fakeLog(f: Fixture): Promise<Array<Record<string, unknown>>> {
  if (!existsSync(f.log)) return []
  return (await readFile(f.log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('antigravity persistent session uses sandboxed stream-json and bills per-turn deltas', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const hops: EngineHopReport[] = []
  const session = getAdapter('antigravity').startSession?.({
    home: f.home,
    env: f.env,
    model: 'Gemini 3.5 Flash (High)',
    onLog: () => {},
    onHopUsage: (hop) => hops.push(hop),
  })
  assert.ok(session)

  const first = await session.send('first prompt')
  const second = await session.send('second prompt')
  await session.stop()

  assert.equal(first.exitCode, 0)
  assert.equal(first.sessionId, 'agy-conversation-1')
  assert.equal(first.model, 'Gemini 3.5 Flash (High)')
  assert.deepEqual(first.usage, {
    input_tokens: 60,
    output_tokens: 10,
    cache_read_input_tokens: 40,
  })
  // The second result is cumulative (160/16/70). Only the 60/6/30 delta is
  // this turn, and cache is a subset of input: 60 - 30 = 30 fresh.
  assert.deepEqual(second.usage, {
    input_tokens: 30,
    output_tokens: 6,
    cache_read_input_tokens: 30,
  })
  assert.equal(hops.length, 2)
  assert.deepEqual(hops[1].usage, second.usage)
  assert.equal(hops[0].toolUses, 1)

  const records = await fakeLog(f)
  const start = records.find((record) => record.type === 'start') as { argv: string[]; cwd: string }
  assert.ok(start.argv.includes('--input-format'))
  assert.ok(start.argv.includes('--output-format'))
  assert.ok(start.argv.includes('--sandbox'))
  assert.ok(start.argv.includes('--dangerously-skip-permissions'))
  assert.equal(start.argv[start.argv.indexOf('--mode') + 1], 'accept-edits')
  assert.ok(!start.argv.includes('first prompt'), 'the prompt must travel on stdin, not argv')
  assert.equal(start.cwd, await realpath(f.home))
  const prompts = records.filter((record) => record.type === 'prompt') as Array<{ event: { event: string; message: { content: string } } }>
  assert.deepEqual(prompts.map((record) => record.event.message.content), ['first prompt', 'second prompt'])
})

test('antigravity triage uses plan mode and returns the current reply', { skip: IS_WIN }, async () => {
  const f = await fixture()
  process.env.CUMORA_TRIAGE_MODEL = 'Gemini 3.5 Flash (Low)'
  const result = await getAdapter('antigravity').classify({
    cwd: f.home,
    prompt: 'classify this',
    env: f.env,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.text, 'echo:classify this')
  const records = await fakeLog(f)
  const start = records.find((record) => record.type === 'start') as { argv: string[] }
  assert.equal(start.argv[start.argv.indexOf('--mode') + 1], 'plan')
  assert.equal(start.argv[start.argv.indexOf('--model') + 1], 'Gemini 3.5 Flash (Low)')
})

test('antigravity failed result surfaces its reason and still reports spent usage', { skip: IS_WIN }, async () => {
  const f = await fixture('error')
  const result = await getAdapter('antigravity').run({
    home: f.home,
    prompt: 'fail',
    env: f.env,
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /quota exhausted/)
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 })
})

test('antigravity seedHome writes AGENTS.md and native workspace skills', { skip: IS_WIN }, async () => {
  const f = await fixture()
  await getAdapter('antigravity').seedHome(f.home, {
    id: 'agy-reviewer', name: 'Aster', role: 'Reviewer', systemPrompt: 'Review independently.',
  })
  const persona = await readFile(join(f.home, 'AGENTS.md'), 'utf8')
  assert.match(persona, /Aster/)
  assert.match(persona, /Review independently/)
  assert.match(persona, /`\.agents\/skills\/` — your skills/)
  assert.ok(existsSync(join(f.home, '.agents', 'skills')))
})

test('antigravity is detected through the agy binary on PATH', { skip: IS_WIN }, async () => {
  const f = await fixture()
  const old = process.env.PATH
  process.env.PATH = f.env.PATH
  try {
    assert.ok((await detectEngines()).includes('antigravity'))
  } finally {
    process.env.PATH = old
  }
})
