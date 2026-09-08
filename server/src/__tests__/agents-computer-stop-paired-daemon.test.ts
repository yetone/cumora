import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// `--stop` must kill the daemon the user actually started. The one it kept
// missing is the first-run path: `agent computer --pair <code>` on a machine
// with no service installed pairs and then falls through to `doRun`, so the
// live daemon's own command line carries `--pair` — a one-shot flag. Judged by
// its flags it was spared, while `--stop` still printed "daemon process(es)
// killed"; the daemon kept claiming agent turns until the terminal was closed.
//
// These drive the real `runComputerDaemon(['--stop'])` against real processes,
// because the bug was never in the predicate (which is right, and stays) but in
// what the caller does with it. A pure test of `isStoppableDaemonCommand` still
// passes on the broken code.

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const DAEMON = join(REPO_ROOT, 'server/src/agents/computer/daemon.ts')
const isWindows = process.platform === 'win32'

/** A process whose `ps` command line is exactly what the real CLI produces. */
function spawnDecoy(home: string, flags: string[]): { pid: number; kill: () => void } {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1 << 30)', 'agent', 'computer', ...flags],
    { stdio: 'ignore', env: { ...process.env, HOME: home } },
  )
  assert.ok(child.pid, 'decoy failed to start')
  return { pid: child.pid, kill: () => { try { child.kill('SIGKILL') } catch { /* gone */ } } }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Run the real `--stop` in a child, so it reads OUR sandbox HOME rather than
 *  the developer's — CONFIG_DIR is resolved once, at module load. */
async function runStop(home: string): Promise<string> {
  const script = `const { runComputerDaemon } = await import(${JSON.stringify(DAEMON)}); await runComputerDaemon(['--stop'])`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (c) => { out += String(c) })
  child.stderr.on('data', (c) => { out += String(c) })
  await new Promise((resolve) => child.on('close', resolve))
  return out
}

async function sandbox(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'cumora-stop-'))
  await mkdir(join(home, '.cumora'), { recursive: true })
  return home
}

async function recordRunning(home: string, pid: number): Promise<void> {
  await writeFile(
    join(home, '.cumora', 'running.json'),
    JSON.stringify({ version: '0.0.0-test', pid, startedAt: new Date().toISOString() }),
    'utf8',
  )
}

/** SIGTERM then SIGKILL, with a grace window matching the daemon's own. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 2500))
}

test('--stop kills the foreground daemon started by --pair', { skip: isWindows }, async () => {
  const home = await sandbox()
  const daemon = spawnDecoy(home, ['--pair', '8lkqelTbO'])
  try {
    // What `doRun` writes about itself once it becomes the daemon.
    await recordRunning(home, daemon.pid)
    const out = await runStop(home)
    await settle()
    assert.equal(alive(daemon.pid), false, `--stop left the paired daemon running. Output:\n${out}`)
  } finally {
    daemon.kill()
  }
})

test('a --pair CLI that never became the daemon is still spared', { skip: isWindows }, async () => {
  const home = await sandbox()
  // Someone re-pairing in another terminal: same command line, but it is NOT the
  // pid in running.json, so it has never declared itself a daemon.
  const oneShot = spawnDecoy(home, ['--pair', '8lkqelTbO'])
  const daemon = spawnDecoy(home, ['--server', 'https://api.cumora.ai'])
  try {
    await recordRunning(home, daemon.pid)
    const out = await runStop(home)
    await settle()
    assert.equal(alive(daemon.pid), false, `the real daemon survived --stop. Output:\n${out}`)
    assert.equal(alive(oneShot.pid), true, `--stop killed a sibling one-shot CLI. Output:\n${out}`)
  } finally {
    oneShot.kill()
    daemon.kill()
  }
})

test('a recycled pid in running.json is not killed', { skip: isWindows }, async () => {
  const home = await sandbox()
  // The pid file is stale and the OS has handed that pid to something else. The
  // recorded pid buys a process out of the flag rule, never out of being ours.
  const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)', 'some-other-tool', 'serve'], {
    stdio: 'ignore', env: { ...process.env, HOME: home },
  })
  assert.ok(stranger.pid)
  try {
    await recordRunning(home, stranger.pid)
    const out = await runStop(home)
    await settle()
    assert.equal(alive(stranger.pid), true, `--stop killed an unrelated process. Output:\n${out}`)
  } finally {
    try { stranger.kill('SIGKILL') } catch { /* gone */ }
  }
})
