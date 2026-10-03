import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { codexRuntimeEnv, codexRuntimeHome, CODEX_SESSION_SCOPE } from '../agents/computer/codex-runtime.js'
import { migrateCodexSessions } from '../agents/computer/codex-session-migration.js'
import { getAdapter } from '../agents/computer/engine.js'
import { clearModelCatalogCache, discoverEngineModelCatalog } from '../agents/computer/model-catalog.js'
import { EngineSessionStore } from '../agents/computer/session-store.js'

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === 'win32'
const original = { ...process.env }
let root: string
let bin: string
let capture: string

// Real child processes verify the environment at the process boundary, not
// just the output of an argv builder. No authentication or model calls.
const fakeCodex = `
const fs = require('node:fs')
const record = value => fs.appendFileSync(process.env.CODEX_TEST_CAPTURE, JSON.stringify(value) + '\\n')
record({ argv: process.argv.slice(2), home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME })
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.160.0\\n')
} else if (process.argv.includes('app-server')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line)
    record(m)
    if (m.method === 'initialize') send({ id: m.id, result: {} })
    if (m.method === 'model/list') send({ id: m.id, result: { data: [{ id: 'fixture', model: 'fixture', isDefault: true }] } })
    if (m.method === 'thread/start' || m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.params.threadId || 'fixture-thread' } } })
    if (m.method === 'turn/start') {
      send({ id: m.id, result: { turn: { id: 'turn-1' } } })
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
    }
  })
} else if (process.argv.includes('exec')) {
  process.stdin.resume()
  process.stdin.on('end', () => process.stdout.write('ok\\n'))
}
`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cumora-codex-runtime-'))
  bin = join(root, 'bin')
  capture = join(root, 'calls.jsonl')
  await mkdir(bin)
  process.env.HOME = root
  process.env.USERPROFILE = root
  process.env.PATH = `${bin}${delimiter}${original.PATH ?? original.Path ?? ''}`
  process.env.CODEX_HOME = join(root, 'personal-codex')
  process.env.CODEX_SQLITE_HOME = join(root, 'personal-databases')
  process.env.CODEX_TEST_CAPTURE = capture
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '0'
  delete process.env.CUMORA_CODEX_ARGS
  delete process.env.CUMORA_TRIAGE_ARGS
  delete process.env.CUMORA_CODEX_NO_APP_SERVER
  const script = join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  await mkdir(join(bin, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
  await writeFile(script, fakeCodex)
  if (IS_WIN) {
    await writeFile(join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n`)
  } else {
    await writeFile(join(bin, 'codex'), `#!/bin/sh\nexec node "${script}" "$@"\n`)
    await chmod(join(bin, 'codex'), 0o755)
  }
})

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  clearModelCatalogCache()
  await rm(root, { recursive: true, force: true })
})

async function calls(): Promise<Array<Record<string, any>>> {
  return (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
}

test('Codex environment overrides personal storage without mutating the parent or copying personal data', async () => {
  const env = { ...process.env }
  const child = codexRuntimeEnv(env)
  assert.equal(child.CODEX_HOME, join(root, '.cumora', 'codex-runtime'))
  assert.equal(child.CODEX_SQLITE_HOME, child.CODEX_HOME)
  assert.equal(env.CODEX_HOME, join(root, 'personal-codex'))
  assert.equal(process.env.CODEX_HOME, env.CODEX_HOME)
  assert.deepEqual(await readdir(child.CODEX_HOME!), [])
})

test('exec, triage, doctor and catalog share the isolated home in secure and compatibility modes', async () => {
  const adapter = getAdapter('codex')
  for (const mode of ['0', '1']) {
    process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = mode
    const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') }
    const signal = AbortSignal.timeout(10_000)
    const turn = await adapter.run({ home: root, env, prompt: 'hello', onLog() {}, signal })
    assert.equal(turn.exitCode, 0, turn.error)
    await adapter.classify({ cwd: root, env, prompt: 'triage', signal })
    await adapter.probe({ cwd: root, env, tier: 'small', signal })
    const catalog = await discoverEngineModelCatalog('codex', join(bin, IS_WIN ? 'codex.cmd' : 'codex'), true, env)
    assert.equal(catalog.defaultModel, 'fixture')
  }
  const spawns = (await calls()).filter(call => call.argv)
  assert.equal(spawns.length, 8)
  for (const call of spawns) {
    assert.equal(call.home, codexRuntimeHome())
    assert.equal(call.sqlite, codexRuntimeHome())
  }
  const execs = spawns.filter(call => call.argv.includes('exec'))
  assert.deepEqual(execs.map(call => call.argv.includes('--ephemeral')), [false, true, true, false, true, true])
})

test('persistent sessions resume the same thread after restart; wake probes are ephemeral', { skip: IS_WIN }, async () => {
  const adapter = getAdapter('codex')
  const env = { ...process.env, CUMORA_AGENT_IPC_DIR: join(root, 'ipc'), CUMORA_AGENT_MCP_SHIM: join(root, 'shim') }
  let id: string | null = null
  for (let i = 0; i < 2; i++) {
    const session = adapter.startSession!({ home: root, env, resumeSessionId: id, onLog() {} })
    assert.ok(session)
    try {
      const result = await session.send('hello')
      assert.equal(result.exitCode, 0)
      assert.equal(session.sessionId, 'fixture-thread')
      id = session.sessionId
    } finally { await session.stop() }
  }
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  assert.equal((await adapter.probeWake!({ cwd: root, env, signal: AbortSignal.timeout(10_000) })).ok, true)
  const records = await calls()
  assert.deepEqual(records.filter(call => call.method === 'thread/resume').map(call => call.params.threadId), ['fixture-thread'])
  assert.deepEqual(records.filter(call => call.method === 'thread/start').map(call => call.params.ephemeral ?? false), [false, true])
  for (const call of records.filter(call => call.argv)) assert.equal(call.home, codexRuntimeHome())
})

test('the login command uses the dedicated home and exits without pairing or starting a daemon', async () => {
  await execFileAsync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../cli-bin.ts', import.meta.url)),
    'agent', 'computer', '--codex-login'], { env: process.env, windowsHide: true, timeout: 15_000 })
  const [login] = await calls()
  assert.deepEqual(login.argv, ['login'])
  assert.equal(login.home, codexRuntimeHome())
  assert.equal(login.sqlite, codexRuntimeHome())
  assert.deepEqual(await readdir(join(root, '.cumora')), ['codex-runtime'])
})

test('migration copies only referenced rollouts, preserves IDs and personal data, and is repeatable', async () => {
  const source = process.env.CODEX_HOME!
  const sessions = join(root, '.cumora', 'sessions')
  const id = '00000000-0000-4000-8000-000000000001'
  const rollout = join('2026', '10', '03', `rollout-2026-10-03T00-00-00-${id}.jsonl`)
  await mkdir(join(source, 'sessions', '2026', '10', '03'), { recursive: true })
  const transcript = `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: join(root, '.cumora', 'agents', 'atlas') } })}\n`
  await writeFile(join(source, 'sessions', rollout), transcript)
  await writeFile(join(source, 'auth.json'), 'private-auth')
  await writeFile(join(source, 'sessions', 'personal.jsonl'), 'private-chat')
  await mkdir(join(sessions, 'atlas'), { recursive: true })
  await writeFile(join(sessions, 'atlas', 'codex.session'), id)
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../cli-bin.ts', import.meta.url)),
    'agent', 'computer', '--migrate-codex-sessions'], { env: process.env, windowsHide: true, timeout: 15_000 })
  assert.match(result.stdout, /Migrated 1 Codex session/)
  assert.equal(await readFile(join(codexRuntimeHome(), 'sessions', rollout), 'utf8'), transcript)
  assert.equal(await new EngineSessionStore(sessions, 'atlas', 'codex', CODEX_SESSION_SCOPE).load(), id)
  assert.equal(await readFile(join(sessions, 'atlas', 'codex.session.migrated'), 'utf8'), id)
  assert.equal(await readFile(join(source, 'sessions', rollout), 'utf8'), transcript)
  assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), 'private-auth')
  assert.deepEqual(await readdir(codexRuntimeHome()), ['sessions'])
  assert.deepEqual(await migrateCodexSessions(), [])
  const store = new EngineSessionStore(sessions, 'atlas', 'codex', CODEX_SESSION_SCOPE)
  await store.save('newer-thread')
  // An interrupted migration may leave both pointers. A retry must preserve
  // the new one, and a later context reset must not resurrect the old one.
  await writeFile(join(sessions, 'atlas', 'codex.session'), id)
  assert.deepEqual(await migrateCodexSessions(), [])
  assert.equal(await store.load(), 'newer-thread')
  await store.save(null)
  assert.deepEqual(await migrateCodexSessions(), [])
  assert.equal(await store.load(), null)
})

test('an unavailable legacy rollout fails migration without switching the session pointer', async () => {
  const sessions = join(root, '.cumora', 'sessions')
  await mkdir(join(sessions, 'atlas'), { recursive: true })
  await writeFile(join(sessions, 'atlas', 'codex.session'), 'missing-thread')
  await assert.rejects(migrateCodexSessions(), /old session pointer has been preserved/)
  assert.deepEqual(await readdir(join(sessions, 'atlas')), ['codex.session'])
})

test('daemon migrates automatically, isolates failures, deduplicates retries and recovers without restart', async () => {
  const source = process.env.CODEX_HOME!
  const sessions = join(root, '.cumora', 'sessions')
  const healthyId = '00000000-0000-4000-8000-000000000001'
  const missingId = '00000000-0000-4000-8000-000000000002'
  const healthyRollout = `rollout-2026-10-03T00-00-00-${healthyId}.jsonl`
  const missingRollout = `rollout-2026-10-03T00-00-00-${missingId}.jsonl`
  await mkdir(join(source, 'sessions'), { recursive: true })
  await writeFile(join(source, 'sessions', healthyRollout), `${JSON.stringify({ type: 'session_meta', payload: { id: healthyId } })}\n`)
  for (const [agentId, id] of [['blocked', missingId], ['healthy', healthyId]]) {
    await mkdir(join(sessions, agentId), { recursive: true })
    await writeFile(join(sessions, agentId, 'codex.session'), id)
  }
  await writeFile(join(root, '.cumora', 'computer.json'), JSON.stringify({
    serverUrl: 'http://fixture.local', computerId: 'fixture-computer', deviceToken: 'fixture-token',
  }))

  const script = (recover: boolean) => `
    import assert from 'node:assert/strict'
    import { writeFile, access } from 'node:fs/promises'
    const { ENGINE_IDS, getAdapter } = await import(${JSON.stringify(new URL('../agents/computer/engine.ts', import.meta.url).href)})
    // Do not probe engines installed on the developer's machine.
    for (const id of ENGINE_IDS) if (id !== 'codex') getAdapter(id).bin = 'cumora-fixture-missing-' + id
    const { runComputerDaemon } = await import(${JSON.stringify(new URL('../agents/computer/daemon.ts', import.meta.url).href)})
    const errors = []
    const logError = console.error
    console.error = (...args) => { errors.push(args.join(' ')); logError(...args) }
    const connected = new Set()
    let scans = 0
    const interval = globalThis.setInterval
    globalThis.setInterval = (fn, ms, ...args) => interval(fn, ms === 60_000 ? 40 : ms, ...args)
    const agents = ['blocked', 'healthy', 'new-user'].map(id => ({
      id, name: id, engine: 'codex', role: null, systemPrompt: null, model: null, fastModel: null,
    }))
    // Exercise real daemon reconciliation and runners without a backend,
    // credentials, messages or model calls. All fetches stay inside this fixture.
    globalThis.fetch = async (url, options = {}) => {
      const path = new URL(url).pathname
      if (path === '/api/computers/me/agents') { scans++; return Response.json(agents) }
      if (path.endsWith('/runtime-token')) return Response.json({ token: path.split('/')[3], expiresInSeconds: 3600 })
      if (path.endsWith('wake-stream')) connected.add(options.headers.Authorization.slice(7))
      if (path.endsWith('stream')) return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } })
      if (path === '/api/computers/heartbeat' || path === '/api/computers/me/engines') return Response.json({})
      throw new Error('Unexpected fixture request: ' + path)
    }
    const waitFor = async (condition) => {
      const deadline = Date.now() + 8000
      while (!condition()) {
        assert.ok(Date.now() < deadline, 'daemon did not reach expected state: ' + [...connected] + '; scans=' + scans)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    await runComputerDaemon([])
    await waitFor(() => scans >= 4 && connected.has('healthy') && connected.has('new-user'))
    if (${recover}) {
      assert.equal(connected.has('blocked'), false)
      assert.equal(errors.filter(line => line.includes('blocked paused:')).length, 1)
      await assert.rejects(access(${JSON.stringify(join(root, '.cumora', '.runtime-cli-ipc', 'blocked'))}), { code: 'ENOENT' })
      await writeFile(${JSON.stringify(join(source, 'sessions', missingRollout))}, ${JSON.stringify(`${JSON.stringify({ type: 'session_meta', payload: { id: missingId } })}\n`)})
      await waitFor(() => connected.has('blocked'))
      assert.equal(errors.filter(line => line.includes('blocked paused:')).length, 1)
    } else {
      await waitFor(() => connected.has('blocked'))
      assert.deepEqual(errors, [])
    }
    assert.equal(process.exitCode, undefined)
    process.exit(0)
  `
  for (const recover of [true, false]) {
    const result = await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script(recover)], {
      env: process.env, windowsHide: true, timeout: 15_000,
    })
    assert.match(result.stdout, /healthy restored codex session/)
    assert.match(result.stdout, /blocked restored codex session/)
    assert.doesNotMatch(result.stderr, /new-user paused:/)
    for (const [agentId, id] of [['blocked', missingId], ['healthy', healthyId]]) {
      assert.equal(await new EngineSessionStore(sessions, agentId, 'codex', CODEX_SESSION_SCOPE).load(), id)
      assert.equal(await readFile(join(sessions, agentId, 'codex.session.migrated'), 'utf8'), id)
    }
    assert.equal(await readFile(join(codexRuntimeHome(), 'sessions', healthyRollout), 'utf8'), await readFile(join(source, 'sessions', healthyRollout), 'utf8'))
    assert.equal(await readFile(join(codexRuntimeHome(), 'sessions', missingRollout), 'utf8'), await readFile(join(source, 'sessions', missingRollout), 'utf8'))
  }
})
