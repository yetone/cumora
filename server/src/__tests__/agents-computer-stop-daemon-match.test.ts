/**
 * `--stop` promises a full stop: the service is uninstalled AND every running
 * daemon process is killed. That promise rests entirely on classifying a
 * `ps`-reported command line as "long-running daemon" vs. "one-shot CLI", and
 * the cost of getting it wrong is asymmetric and silent — a spared daemon keeps
 * holding wake-streams and processing turns while `--stop` reports success.
 *
 * The regression these pin: the matcher's exclusions were written as
 * `--(stop|…|pair)\b|\bnpx\b`, but `|` binds looser than the group, so `\bnpx\b`
 * matched anywhere in the command line rather than only as the wrapper. Every
 * daemon launched the documented way (`npx -y cumora@latest agent computer …`,
 * which is also the LaunchAgent's ProgramArguments) was therefore spared.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-stop-daemon-match.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStoppableDaemonCommand } from '../agents/computer/daemon.js'

// ── real long-running daemons: must be killed ────────────────────────────────

test('the npx-launched daemon IS stoppable (the precedence regression)', () => {
  // Exactly the plist's ProgramArguments, and what --pair tells users to run.
  // Spared before the fix purely because "npx" appeared in its argv.
  assert.equal(
    isStoppableDaemonCommand('npx -y cumora@latest agent computer --server https://api.cumora.ai'),
    true,
  )
})

test('a daemon resolved through the _npx bin shim IS stoppable', () => {
  // How the wrapper's child actually shows up in `ps`.
  assert.equal(
    isStoppableDaemonCommand(
      'node /Users/x/.npm/_npx/302120fbb92394c3/node_modules/.bin/cumora agent computer --server https://api.cumora.ai',
    ),
    true,
  )
})

test('an `npm exec` launched daemon IS stoppable', () => {
  assert.equal(
    isStoppableDaemonCommand('npm exec cumora@latest agent computer --server https://api.cumora.ai'),
    true,
  )
})

test('a bare foreground daemon with no flags IS stoppable', () => {
  assert.equal(isStoppableDaemonCommand('cumora agent computer'), true)
})

test('the supervised daemon IS stoppable even with env noise in the command line', () => {
  // launchd-reported argv carries trailing environment; it must not confuse the match.
  assert.equal(
    isStoppableDaemonCommand(
      'npm exec cumora@latest agent computer --server https://api.cumora.ai CUMORA_SUPERVISED=1 XPC_SERVICE_NAME=io.cumora.daemon',
    ),
    true,
  )
})

// ── one-shot CLIs: must be spared ────────────────────────────────────────────

test('every one-shot flag is spared', () => {
  for (const flag of [
    '--stop', '--status', '--restart', '--logs', '--version',
    '--install-service', '--uninstall-service', '--pair',
  ]) {
    assert.equal(
      isStoppableDaemonCommand(`node /usr/local/bin/cumora agent computer ${flag}`),
      false,
      flag,
    )
  }
})

test('--pair with a value is spared', () => {
  assert.equal(
    isStoppableDaemonCommand('npx cumora@latest agent computer --pair 8lkqelTbO --server https://api.cumora.ai'),
    false,
  )
})

test('an unrelated process is never a victim', () => {
  assert.equal(isStoppableDaemonCommand('node /Users/x/some-other-tool serve --port 3000'), false)
  assert.equal(isStoppableDaemonCommand('cumora agent pod --agent-id a1'), false)
})

test('a one-shot flag is only matched behind its `--`', () => {
  // The bare words must not spare a real daemon just by appearing in a path,
  // a server URL, or a repo name — that is the same class of bug as `npx`.
  for (const cmd of [
    'node /Users/status/bin/cumora agent computer --server https://api.cumora.ai',
    'npx cumora@latest agent computer --server https://logs.internal.example.com',
    'node /opt/restart-tools/cumora agent computer --server https://api.cumora.ai',
  ]) {
    assert.equal(isStoppableDaemonCommand(cmd), true, cmd)
  }
})
