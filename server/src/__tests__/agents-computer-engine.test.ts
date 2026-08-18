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

afterEach(async () => {
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
