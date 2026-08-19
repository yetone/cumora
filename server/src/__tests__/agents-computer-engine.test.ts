/**
 * Unit tests for BYOA local engine adapters.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine.test.ts
 */
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter, resolveSpawn } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const tempDirs: string[] = []
// Sessions spawn a child process. Track them so a FAILING assertion still tears
// the child down — otherwise it outlives the test and the runner never exits.
const liveSessions: Array<{ stop(): void }> = []

afterEach(async () => {
  for (const s of liveSessions.splice(0)) { try { s.stop() } catch { /* already gone */ } }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('local engine failure returns stderr tail for observability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: usage limit reached, no tokens left" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const result = await getAdapter('claude').run({
    home,
    prompt: 'wake',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /usage limit reached, no tokens left/i)
  assert.deepEqual(logs, ['Claude Code error: usage limit reached, no tokens left'])
})

test('persistent Claude startup failure keeps stderr for first send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-session-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const fakeClaude = join(binDir, 'claude')
  await writeFile(
    fakeClaude,
    '#!/bin/sh\n' +
    'echo "Claude Code error: subscription expired" >&2\n' +
    'exit 1\n',
    'utf8',
  )
  await chmod(fakeClaude, 0o755)

  const logs: string[] = []
  const session = getAdapter('claude').startSession?.({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
  })

  assert.ok(session)
  await delay(50)
  const result = await session.send('wake')

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /subscription expired/i)
  // The engine's stderr passes through verbatim, followed by the session-death
  // trace (die() now ALWAYS logs a process death — idle deaths used to be
  // silent, which made fleet-wide session disappearances undiagnosable).
  assert.equal(logs[0], 'Claude Code error: subscription expired')
  assert.equal(logs.length, 2)
  assert.match(logs[1] ?? '', /\[session\] engine process died .*exit 1/)
  })

  // Regression: nvm-windows on Windows ships an extensionless POSIX shell-shim
  // (`#!/bin/sh` wrapper) alongside the real `.cmd`. The OLD resolveSpawn iterated
  // `['', ...PATHEXT]` → matched the shim first → returned `shell:false` → Node
  // could not exec the shim and every BYOA turn died with ENOENT.
  // See https://github.com/yetone/cumora/issues/5
  test('resolveSpawn prefers .cmd over extensionless shim on Windows', { skip: !IS_WIN }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumora-resolve-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    await mkdir(binDir)
    // Both files exist — mirrors the standard nvm-windows layout.
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', 'utf8')
    await writeFile(join(binDir, 'claude.cmd'), '@echo off\nexit /b 0\n', 'utf8')
    process.env.PATH = `${binDir};${process.env.PATH ?? ''}`
    const r = resolveSpawn('claude')
    // NTFS is case-insensitive, and Windows resolves `claude.cmd` as `claude.CMD`
    // — compare with a normalized basename so the test passes regardless of FS.
    assert.equal(
      r.command.toLowerCase().endsWith('claude.cmd'),
      true,
      `must pick the .cmd, not the shim — got ${r.command}`,
    )
    assert.equal(r.shell, true, '.cmd must run via the shell')
    assert.equal(r.wantsStdinPrompt, true, '.cmd needs the big prompt via stdin')
  })

// ── Codex app-server handshake failures must kill the SESSION ────────────────
// The handshake is one-shot: threadReq is consumed at the initialize ack, and
// only a failed thread/resume re-issues a thread/start. So if the thread never
// opens, `ready` can never flip — and because the app-server SURVIVES rejecting
// the handshake, the session would keep reporting alive and the daemon would
// reuse it, parking every later prompt in queuedPrompt with nothing able to
// drain it. That is a permanently, silently dead agent.

/** A fake `codex app-server --listen stdio://`: acks `initialize`, then rejects
 *  whatever thread request follows, and STAYS ALIVE — the condition that makes
 *  the zombie possible. */
async function fakeCodexRejectingThread(root: string): Promise<string> {
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const bin = join(binDir, 'codex')
  await writeFile(
    bin,
    '#!/usr/bin/env node\n' +
    "let buf = ''\n" +
    "process.stdin.on('data', (d) => {\n" +
    "  buf += d.toString('utf8')\n" +
    "  let nl\n" +
    "  while ((nl = buf.indexOf('\\n')) >= 0) {\n" +
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)\n' +
    '    if (!line.trim()) continue\n' +
    '    let msg; try { msg = JSON.parse(line) } catch { continue }\n' +
    "    if (msg.method === 'initialize') {\n" +
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')\n" +
    "    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {\n" +
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unsupported model for this account' } }) + '\\n')\n" +
    '    }\n' +
    '  }\n' +
    '})\n' +
    // Never exit on our own: the whole point is an app-server that outlives a
    // rejected handshake.
    'setInterval(() => {}, 1 << 30)\n',
    'utf8',
  )
  await chmod(bin, 0o755)
  return binDir
}

async function startFakeCodexSession(opts: { resume?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const binDir = await fakeCodexRejectingThread(root)
  const logs: string[] = []
  const session = getAdapter('codex').startSession!({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    resumeSessionId: opts.resume ?? null,
    onLog: (l) => logs.push(l),
  })
  assert.ok(session, 'codex adapter must start a persistent session on this platform')
  liveSessions.push(session!)
  return { session: session!, logs }
}

test('a Codex session whose thread never opens dies instead of wedging', { skip: IS_WIN }, async () => {
  const { session } = await startFakeCodexSession()

  const first = await session.send('first wake')
  assert.notEqual(first.exitCode, 0, 'the rejected handshake must fail the turn')
  assert.match(String(first.error), /unsupported model for this account/)

  // The session must NOT advertise itself as reusable: the daemon drops a
  // !alive session and spawns a clean one on the next wake.
  assert.equal(session.alive, false, 'a session that can never open a thread must not stay alive')

  // And a send() that still lands on it has to settle, not hang forever.
  const second = await Promise.race([
    session.send('second wake'),
    delay(1000).then(() => 'HUNG' as const),
  ])
  assert.notEqual(second, 'HUNG', 'a later turn must settle rather than park forever in queuedPrompt')
  assert.notEqual((second as { exitCode: number }).exitCode, 0)
  assert.match(String((second as { error?: string }).error), /unsupported model for this account/,
    'the later turn should report the real handshake cause')
})

test('a Codex session whose resume fallback also fails dies instead of wedging', { skip: IS_WIN }, async () => {
  // thread/resume is rejected, the adapter retries with a fresh thread/start,
  // and that is rejected too — the second failure must still tear down.
  const { session } = await startFakeCodexSession({ resume: 'thread_stale' })

  const first = await session.send('first wake')
  assert.notEqual(first.exitCode, 0)
  assert.equal(session.alive, false, 'a failed resume AND failed fresh start must not leave a live zombie')

  const second = await Promise.race([
    session.send('second wake'),
    delay(1000).then(() => 'HUNG' as const),
  ])
  assert.notEqual(second, 'HUNG', 'a later turn must settle rather than park forever')
})

// ── stream-json events split across pipe reads ──────────────────────────────
// A pipe read chops stdout at an arbitrary byte offset, so a long event arrives
// as two 'data' chunks. Parsing each chunk in isolation threw away both halves,
// and the swallow-partial-lines catch made it silent: no ledger row, and the
// turn's authoritative usage/model/session id lost.

test('a stream-json event split across pipe chunks is still parsed', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-chunk-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)

  // One assistant event padded far past any pipe buffer, then the terminating
  // result. Emitted with NO trailing newline on the last line, which is how the
  // engines actually finish.
  const fake = join(binDir, 'claude')
  await writeFile(
    fake,
    '#!/usr/bin/env node\n' +
    "const big = 'z'.repeat(400000)\n" +
    "const assistant = { type: 'assistant', session_id: 'sess-chunked', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 11, output_tokens: 7 }, content: [{ type: 'text', text: big }] } }\n" +
    "const result = { type: 'result', session_id: 'sess-chunked', usage: { input_tokens: 11, output_tokens: 7 }, model: 'claude-sonnet-4-6' }\n" +
    "process.stdout.write(JSON.stringify(assistant) + '\\n')\n" +
    "process.stdout.write(JSON.stringify(result))\n",
    'utf8',
  )
  await chmod(fake, 0o755)

  const hops: Array<{ model: string }> = []
  const r = await getAdapter('claude').run({
    home,
    prompt: 'go',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    onLog: () => {},
    onHopUsage: (h) => hops.push({ model: h.model }),
    signal: new AbortController().signal,
  })

  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, 'sess-chunked', 'session id must survive a chunk split (else no --resume next wake)')
  assert.equal(r.usage?.output_tokens, 7, "the result event's usage must survive")
  assert.equal(r.model, 'claude-sonnet-4-6')
  assert.equal(hops.length, 1, 'the assistant hop must reach the trajectory ledger exactly once')
})

test('a multi-byte character split across pipe chunks is not corrupted', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-utf8-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)

  // Pad so the event is long enough to be chopped, and fill it with multi-byte
  // characters so a boundary is very likely to land mid-codepoint.
  const fake = join(binDir, 'claude')
  await writeFile(
    fake,
    '#!/usr/bin/env node\n' +
    "const big = '中'.repeat(150000)\n" +
    "const ev = { type: 'result', session_id: 'sess-utf8', usage: { input_tokens: 1, output_tokens: 2 }, model: 'm', note: big }\n" +
    "process.stdout.write(JSON.stringify(ev) + '\\n')\n",
    'utf8',
  )
  await chmod(fake, 0o755)

  const r = await getAdapter('claude').run({
    home,
    prompt: 'go',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    onLog: () => {},
    signal: new AbortController().signal,
  })

  assert.equal(r.sessionId, 'sess-utf8', 'a codepoint split mid-boundary must not corrupt the JSON')
  assert.equal(r.usage?.output_tokens, 2)
})

// ── one-shot engine children must die with their runner ─────────────────────
// The persistent session is torn down by AgentRunner.stop(); the one-shot child
// was not, because its AbortSignal came from a controller nothing ever aborted.
// An orphan keeps a valid runtime token and the `cumora` shim on PATH, so it
// goes on posting AS the agent while the replacement runner answers the same
// messages — with the OLD persona the operator just changed.

test('an already-aborted signal kills the engine child immediately', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-abort-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)

  // A child that would run for a very long time if left alone.
  const fake = join(binDir, 'claude')
  await writeFile(fake, '#!/bin/sh\nsleep 120\n', 'utf8')
  await chmod(fake, 0o755)

  // The queued-turn case: the signal is ALREADY aborted by the time run() is
  // reached, so a listener registered afterwards would never fire.
  const ac = new AbortController()
  ac.abort()

  const r = await Promise.race([
    getAdapter('claude').run({
      home,
      prompt: 'go',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      onLog: () => {},
      signal: ac.signal,
    }),
    delay(5000).then(() => 'ORPHANED' as const),
  ])
  assert.notEqual(r, 'ORPHANED', 'the child outlived its aborted signal — it would keep posting as the agent')
  assert.notEqual((r as { exitCode: number }).exitCode, 0, 'a killed turn must not report success')
})

test('aborting mid-run kills the engine child', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-abort2-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)
  const fake = join(binDir, 'claude')
  await writeFile(fake, '#!/bin/sh\nsleep 120\n', 'utf8')
  await chmod(fake, 0o755)

  const ac = new AbortController()
  const p = getAdapter('claude').run({
    home,
    prompt: 'go',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    onLog: () => {},
    signal: ac.signal,
  })
  await delay(150)
  ac.abort()
  const r = await Promise.race([p, delay(5000).then(() => 'ORPHANED' as const)])
  assert.notEqual(r, 'ORPHANED', 'abort must terminate the child')
  assert.notEqual((r as { exitCode: number }).exitCode, 0)
})

test('a normal run is unaffected by the abort wiring', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-noabort-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)
  const fake = join(binDir, 'claude')
  await writeFile(fake, '#!/bin/sh\necho ok\nexit 0\n', 'utf8')
  await chmod(fake, 0o755)

  const r = await getAdapter('claude').run({
    home,
    prompt: 'go',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(r.exitCode, 0)
})
