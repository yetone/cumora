#!/usr/bin/env node
/*
 * Linux Docker smoke for SEC-10/TST-C3.
 *
 * The image and entrypoint are real. Only /app/agent-computer.cjs and the
 * runtime HTTP surface are replaced with local fixtures, so this never calls
 * a real account, model provider, or Cumora deployment.
 */
import { createInterface } from 'node:readline'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '../..')
const fixtureLoop = resolve(repoRoot, 'server/scripts/fixtures/agent-boundary-loop.cjs')
const fixtureBackend = resolve(repoRoot, 'server/scripts/fixtures/agent-boundary-backend.py')
const image = process.env.CUMORA_AGENT_BOUNDARY_IMAGE ?? process.argv[2]
const smokeId = randomBytes(5).toString('hex')
const reportDir = resolve(
  process.env.CUMORA_AGENT_BOUNDARY_REPORT_DIR ?? `/tmp/cumora-agent-boundary-smoke-${smokeId}`,
)
const reportPath = resolve(reportDir, 'report.json')
const token = 'local-boundary-fixture-token'
const containerPrefix = `cumora-boundary-smoke-${process.pid}-${smokeId}`
const containers = []
const volumes = []
const report = {
  image,
  reportDir,
  checks: {},
  failures: [],
}

if (!image) {
  console.error('usage: node server/scripts/agent-boundary-smoke.mjs IMAGE[:TAG]')
  process.exit(2)
}

await mkdir(reportDir, { recursive: true })

function decode(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')
}

function docker(args, options = {}) {
  try {
    const stdout = execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: options.timeout ?? 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, stdout: decode(stdout), stderr: '' }
  } catch (error) {
    return {
      status: Number.isInteger(error.status) ? error.status : 1,
      stdout: decode(error.stdout),
      stderr: decode(error.stderr),
    }
  }
}

function check(name, passed, detail = undefined) {
  const entry = { passed: Boolean(passed) }
  if (detail !== undefined) entry.detail = detail
  report.checks[name] = entry
  if (!passed) report.failures.push(name)
}

function inspect(name) {
  const result = docker(['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name])
  if (result.status !== 0) return { status: 'missing', exitCode: null }
  const [status, exitCode] = result.stdout.trim().split(/\s+/)
  return { status, exitCode: Number(exitCode) }
}

function execIn(name, args, user = 0, timeout = 20_000) {
  return docker(['exec', '--user', String(user), name, ...args], { timeout })
}

function logs(name) {
  return docker(['logs', name], { timeout: 10_000 })
}

async function waitFor(predicate, timeoutMs = 60_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  return false
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return {}
  }
}

function parseStatus(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (match) out[match[1]] = match[2].trim()
  }
  return out
}

function parseProcessList(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) return null
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        uid: Number(match[3]),
        gid: Number(match[4]),
        command: match[5],
      }
    })
    .filter(Boolean)
}

async function startContainer({ name, capabilities, profileVolume = undefined, startupSupervisor = undefined, startupBarrier = undefined }) {
  containers.push(name)
  const statePath = resolve(reportDir, `${name}.backend.json`)
  const args = [
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `io.cumora.agent-boundary-smoke=${smokeId}`,
    '--device',
    '/dev/fuse',
    '--cap-drop',
    'ALL',
    ...capabilities.flatMap((capability) => ['--cap-add', capability]),
    '--security-opt',
    'apparmor=unconfined',
    '--add-host',
    'host.docker.internal:host-gateway',
    '-v',
    `${fixtureLoop}:/app/agent-computer.cjs:ro`,
    ...(startupSupervisor ? ['-v', `${startupSupervisor}:/usr/local/bin/agent-entrypoint:ro`] : []),
    ...(profileVolume ? ['-v', `${profileVolume}:/opt/chrome-profile`] : []),
    '-e',
    `CUMORA_AGENT_RUNTIME_URL=http://host.docker.internal:${backendPort}/runtime`,
    '-e',
    `CUMORA_AGENT_RUNTIME_TOKEN=${token}`,
    ...(startupBarrier ? ['-e', `CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER=${startupBarrier}`] : []),
    '-e',
    'CUMORA_AGENT_ID=boundary-fixture',
    image,
  ]
  const result = docker(args, { timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error(`docker run failed for ${name}: ${result.stderr.trim()}`)
  }
  return { statePath }
}

async function makeStartupBarrierSupervisor({ legacyTrap = false } = {}) {
  const sourcePath = resolve(repoRoot, 'server/docker/agent-computer-entrypoint.sh')
  let source = await readFile(sourcePath, 'utf8')
  if (legacyTrap) source = source.replace('trap on_signal TERM INT', "trap 'EXIT_STATUS=143; shutdown' TERM INT")
  const marker = '# The observer runs before any browser or model process.'
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error('startup barrier marker is missing from the real supervisor')
  const barrierDir = `/tmp/${containerPrefix}-startup-barrier`
  const barrierVariable = '$' + '{CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER:-}'
  const barrier = `# Test-only barrier inserted by agent-boundary-smoke; the surrounding supervisor is verbatim product code.\nif [[ -n "${barrierVariable}" ]]; then\n  mkdir -p "$CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER"\n  rm -f "$CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER/release"\n  mkfifo -m 0600 "$CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER/release"\n  exec 9<>"$CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER/release"\n  : >"$CUMORA_AGENT_BOUNDARY_STARTUP_BARRIER/ready"\n  IFS= read -r _ <&9 || true\nfi\n\n`
  const suffix = legacyTrap ? 'legacy-trap' : 'fixed-trap'
  const path = resolve(reportDir, `${containerPrefix}-supervisor-with-${suffix}-barrier.sh`)
  await writeFile(path, `${source.slice(0, markerIndex)}${barrier}${source.slice(markerIndex)}`, { mode: 0o755 })
  return { path, barrierDir }
}

async function prepareFsGroupProfile() {
  const profileVolume = `${containerPrefix}-chrome-profile`
  const created = docker([
    'volume',
    'create',
    '--label',
    `io.cumora.agent-boundary-smoke=${smokeId}`,
    profileVolume,
  ])
  if (created.status !== 0) throw new Error(`PVC fixture volume setup failed: ${created.stderr.trim()}`)
  volumes.push(profileVolume)
  // This is an isolated bind mount fixture, not a CSI or kubelet test. The
  // helper container applies the same root-owned/group-writable shape that a
  // Kubernetes fsGroup setup would expose to UID/GID 65532.
  const prepare = docker([
    'run',
    '--rm',
    '--entrypoint',
    '/bin/sh',
    '-v',
    `${profileVolume}:/profile`,
    image,
    '-c',
    'chown 0:65532 /profile && chmod 0770 /profile && printf legacy-profile-fixture >/profile/legacy-login.txt && chown 0:65532 /profile/legacy-login.txt && chmod 0660 /profile/legacy-login.txt',
  ])
  if (prepare.status !== 0) throw new Error(`fsGroup fixture setup failed: ${prepare.stderr.trim()}`)
  return profileVolume
}

async function waitForProbe(name) {
  return waitFor(async () => {
    const state = inspect(name)
    if (state.status === 'exited' || state.status === 'dead' || state.status === 'missing') return false
    const output = execIn(name, ['test', '-s', '/tmp/cumora-agent-boundary-fixture.json'], 65532)
    return output.status === 0
  }, 90_000)
}

async function inspectThreads(name, processes) {
  const violations = []
  for (const process of processes) {
    const expectedUid = process.command.includes('cumora-fuse') ? 65533 : 65532
    const taskList = execIn(
      name,
      ['sh', '-c', `for path in /proc/${process.pid}/task/*/status; do echo TASK:$path; cat "$path"; done`],
      0,
    )
    if (taskList.status !== 0) {
      // Chromium can retire a renderer between ps(1) and the status read.
      // It is not a long-lived process left by the boundary; only retain a
      // violation when the task still exists and remains unreadable.
      const stillPresent = execIn(name, ['test', '-e', `/proc/${process.pid}/status`], 0)
      if (stillPresent.status === 0) violations.push(`${process.pid}:status-unreadable`)
      continue
    }
    const taskStatuses = []
    let currentTask = null
    let currentStatus = null
    const validateCurrentTask = () => {
      if (!currentTask || !currentStatus) return
      const required = ['Uid', 'Gid', 'Groups', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs']
      for (const key of required) {
        if (!(key in currentStatus)) violations.push(`${process.pid}/${currentTask}:missing-${key}`)
      }
      for (const key of ['Uid', 'Gid']) {
        const ids = (currentStatus[key] ?? '').split(/\s+/).filter(Boolean)
        if (ids.length !== 4 || ids.some((id) => id !== String(expectedUid))) {
          violations.push(`${process.pid}/${currentTask}:${key}`)
        }
      }
      for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        if (currentStatus[key] !== '0000000000000000') violations.push(`${process.pid}/${currentTask}:${key}`)
      }
      if (currentStatus.NoNewPrivs !== '1') violations.push(`${process.pid}/${currentTask}:NoNewPrivs`)
      if (currentStatus.Groups !== '') violations.push(`${process.pid}/${currentTask}:Groups`)
      taskStatuses.push(currentTask)
    }
    for (const line of taskList.stdout.split('\n')) {
      if (line.startsWith('TASK:')) {
        validateCurrentTask()
        currentTask = line.slice(5)
        currentStatus = {}
        continue
      }
      const match = line.match(/^(Uid|Gid|Groups|CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):\s*(.*)$/)
      if (!match) continue
      const [key, value] = match.slice(1)
      if (currentStatus) currentStatus[key] = value
    }
    validateCurrentTask()
    if (taskStatuses.length === 0) violations.push(`${process.pid}:no-task-status`)
  }
  return violations
}

let backend
let backendPort
try {
  backend = spawn('python3', [fixtureBackend, '--state', resolve(reportDir, 'backend-state.json')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: backend.stdout })
  backendPort = Number(
    await new Promise((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture backend did not announce a port')), 10_000)
      lines.once('line', (line) => {
        clearTimeout(timer)
        resolvePort(line)
      })
      backend.once('exit', (code) => reject(new Error(`fixture backend exited (${code})`)))
    }),
  )
  if (!Number.isInteger(backendPort) || backendPort <= 0) throw new Error('invalid fixture backend port')

  const imageCheck = docker(['image', 'inspect', image])
  if (imageCheck.status !== 0) throw new Error(`image is unavailable: ${image}`)
  check('image_available', true)
  const directRootSupervisor = docker([
    'run',
    '--rm',
    '--entrypoint',
    '/usr/local/bin/agent-entrypoint',
    image,
  ])
  check('direct_root_supervisor_rejected', directRootSupervisor.status === 126)

  // Read the real supervisor and insert a test-only FIFO barrier immediately
  // after its signal trap. The image still uses the real bootstrap/entrypoint;
  // the barrier simply makes the pre-browser/model signal window deterministic
  // without adding a production sleep or test hook to the image.
  const startupBarrier = await makeStartupBarrierSupervisor()
  const startupName = `${containerPrefix}-bootstrap-signal`
  await startContainer({
    name: startupName,
    capabilities: ['SYS_ADMIN', 'SETUID', 'SETGID', 'SETPCAP', 'KILL'],
    startupSupervisor: startupBarrier.path,
    startupBarrier: startupBarrier.barrierDir,
  })
  const startupBarrierReady = await waitFor(async () => {
    const ready = execIn(startupName, ['test', '-f', `${startupBarrier.barrierDir}/ready`], 65532)
    return ready.status === 0
  }, 30_000)
  check('supervisor_startup_barrier_reached', startupBarrierReady)
  if (startupBarrierReady) {
    const startupProcesses = parseProcessList(execIn(startupName, ['ps', '-eo', 'pid=,ppid=,uid=,gid=,args='], 0).stdout)
    check('startup_barrier_has_no_model_or_browser', !startupProcesses.some((process) => /\b(node|Xvfb|chromium|opencli)\b/.test(process.command)))
    const startupTerm = execIn(startupName, ['kill', '-TERM', '1'], 65532)
    check('supervisor_startup_signal_sent', startupTerm.status === 0)
  }
  const startupExited = await waitFor(() => {
    const state = inspect(startupName)
    return state.status === 'exited' || state.status === 'dead'
  }, 30_000)
  const startupState = inspect(startupName)
  report.startupContainerState = startupState
  check('supervisor_startup_signal_exits_nonzero_143', startupExited && startupState.exitCode === 143)
  const startupFixturePath = resolve(reportDir, `${startupName}.fixture.json`)
  const startupFixtureCopy = docker(['cp', `${startupName}:/tmp/cumora-agent-boundary-fixture.json`, startupFixturePath])
  check('supervisor_startup_signal_does_not_start_model_fixture', startupFixtureCopy.status !== 0 && !existsSync(startupFixturePath))

  // Run the identical barrier against a temporary copy of the pre-fix trap.
  // It must continue into the model fixture after TERM, proving the fixed
  // on_signal exit is what closes the race rather than a timing accident.
  const legacyBarrier = await makeStartupBarrierSupervisor({ legacyTrap: true })
  const legacyName = `${containerPrefix}-legacy-trap`
  await startContainer({
    name: legacyName,
    capabilities: ['SYS_ADMIN', 'SETUID', 'SETGID', 'SETPCAP', 'KILL'],
    startupSupervisor: legacyBarrier.path,
    startupBarrier: legacyBarrier.barrierDir,
  })
  const legacyBarrierReady = await waitFor(async () => {
    const ready = execIn(legacyName, ['test', '-f', `${legacyBarrier.barrierDir}/ready`], 65532)
    return ready.status === 0
  }, 30_000)
  check('legacy_trap_barrier_reached', legacyBarrierReady)
  if (legacyBarrierReady) {
    const legacyTerm = execIn(legacyName, ['kill', '-TERM', '1'], 65532)
    check('legacy_trap_signal_sent', legacyTerm.status === 0)
    const legacyRelease = execIn(legacyName, ['sh', '-c', `printf '%s\n' release > ${legacyBarrier.barrierDir}/release`], 65532)
    check('legacy_trap_barrier_released', legacyRelease.status === 0)
    const legacyFixtureStarted = await waitForProbe(legacyName)
    check('legacy_trap_continues_into_model', legacyFixtureStarted)
    if (legacyFixtureStarted) {
      const legacyStop = execIn(legacyName, ['kill', '-TERM', '1'], 65532)
      check('legacy_trap_cleanup_signal_sent', legacyStop.status === 0)
    }
  }
  const legacyExited = await waitFor(() => {
    const state = inspect(legacyName)
    return state.status === 'exited' || state.status === 'dead'
  }, 30_000)
  report.legacyTrapContainerState = inspect(legacyName)
  check('legacy_trap_container_cleaned', legacyExited)

  const normalName = `${containerPrefix}-normal`
  const profileVolume = await prepareFsGroupProfile()
  await startContainer({
    name: normalName,
    capabilities: ['SYS_ADMIN', 'SETUID', 'SETGID', 'SETPCAP', 'KILL'],
    profileVolume,
  })
  const normalReady = await waitForProbe(normalName)
  check('model_fixture_started', normalReady)
  if (!normalReady) {
    const containerLogs = logs(normalName)
    throw new Error(`normal boundary container did not reach fixture: ${(containerLogs.stdout + containerLogs.stderr).trim()}`)
  }

  const fusePidResult = execIn(normalName, ['cat', '/run/cumora/fuse.pid'], 0)
  const fusePid = fusePidResult.stdout.trim()
  check('fuse_pid_file', fusePidResult.status === 0 && /^[1-9][0-9]*$/.test(fusePid))
  if (!/^[1-9][0-9]*$/.test(fusePid)) throw new Error('FUSE pid file is unavailable')

  const processResult = execIn(normalName, ['ps', '-eo', 'pid=,ppid=,uid=,gid=,args='], 0)
  const processes = parseProcessList(processResult.stdout)
  const persistentProcesses = processes.filter((process) => !/\bps -eo\b|^sleep\s/.test(process.command))
  report.processes = processes
  check('process_list_readable', processResult.status === 0 && processes.length > 0)
  check('no_long_lived_root_process', persistentProcesses.every((process) => process.uid !== 0))
  check('fuse_process_present', persistentProcesses.some((process) => String(process.pid) === fusePid))
  const threadViolations = await inspectThreads(normalName, persistentProcesses)
  report.threadViolations = threadViolations
  check('all_threads_fixed_identity_caps_nnp', threadViolations.length === 0, threadViolations)

  const mountInfo = execIn(normalName, ['sh', '-c', 'grep " /workspace " /proc/self/mountinfo'], 0)
  check(
    'exact_fuse_mount',
    mountInfo.status === 0 && / \/workspace .* - fuse\.cumora-workspace cumora-workspace /.test(mountInfo.stdout),
  )
  const workspaceStat = execIn(normalName, ['stat', '-c', '%u:%g:%a', '/workspace/probe.txt'], 65532)
  check('fuse_owner_is_model', workspaceStat.stdout.trim().startsWith('65532:65532:'), workspaceStat.stdout.trim())
  const fixtureReport = execIn(normalName, ['cat', '/tmp/cumora-agent-boundary-fixture.json'], 65532)
  let fixtureProbe = {}
  try {
    fixtureProbe = JSON.parse(fixtureReport.stdout)
  } catch {
    fixtureProbe = {}
  }
  check('runtime_token_available_to_model_client', fixtureReport.status === 0 && fixtureProbe.runtimeTokenPresent === true)

  const cdp = execIn(normalName, ['curl', '-fsS', 'http://127.0.0.1:9222/json/version'], 65532)
  check('real_chromium_cdp', cdp.status === 0 && cdp.stdout.includes('webSocketDebuggerUrl'))
  const doctor = execIn(normalName, ['sh', '-c', 'opencli doctor'], 65532, 30_000)
  // OpenCLI writes human diagnostics to stderr in non-TTY docker execs. The
  // successful exit is the stable contract; browser open/state below proves
  // the daemon and extension are actually usable.
  check('real_opencli_doctor', doctor.status === 0)
  const open = execIn(normalName, ['sh', '-c', `opencli browser synthetic-agent open http://host.docker.internal:${backendPort}/`], 65532, 30_000)
  const browserState = execIn(normalName, ['sh', '-c', 'opencli browser synthetic-agent state'], 65532, 30_000)
  check('real_opencli_browser', open.status === 0 && browserState.status === 0)

  const status1 = parseStatus(execIn(normalName, ['cat', '/proc/1/status'], 0).stdout)
  check('pid1_is_nonroot_tini', status1.Name === 'tini' && status1.Uid?.split(/\s+/)[0] === '65532')
  check('pid1_is_capless_nnp', ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].every((key) => status1[key] === '0000000000000000') && status1.NoNewPrivs === '1')

  const modelMount = execIn(normalName, ['sh', '-c', 'mkdir -p /tmp/model-mount && mount -t tmpfs none /tmp/model-mount'], 65532)
  check('model_cannot_mount', modelMount.status !== 0)
  const modelSignal = execIn(normalName, ['sh', '-c', `kill -TERM ${fusePid}`], 65532)
  check('model_cannot_signal_fuse', modelSignal.status !== 0)
  const tokenRootProbe = execIn(normalName, ['test', '!', '-e', '/run/cumora/fuse-token'], 0)
  check('token_deleted_after_ready_root_observer', tokenRootProbe.status === 0)
  const tokenModelProbe = execIn(normalName, ['sh', '-c', 'cat /run/cumora/fuse-token >/dev/null'], 65532)
  check('model_cannot_read_deleted_token', tokenModelProbe.status !== 0)
  const fuseEnvProbe = execIn(normalName, ['sh', '-c', `cat /proc/${fusePid}/environ >/dev/null`], 65532)
  check('model_cannot_read_fuse_environ', fuseEnvProbe.status !== 0)
  const fuseArgv = execIn(normalName, ['sh', '-c', `tr "\\000" "\\n" </proc/${fusePid}/cmdline`], 0)
  check('fuse_argv_readable_to_root_observer', fuseArgv.status === 0)
  check('token_absent_from_fuse_argv', fuseArgv.status === 0 && !fuseArgv.stdout.includes(token))
  const fuseEnv = execIn(normalName, ['sh', '-c', `tr "\\000" "\\n" </proc/${fusePid}/environ`], 0)
  check('fuse_environ_readable_to_root_observer', fuseEnv.status === 0)
  check('token_absent_from_fuse_environ', fuseEnv.status === 0 && !fuseEnv.stdout.includes(token))

  const homeStats = execIn(normalName, ['stat', '-c', '%u:%g:%a', '/home/cumora-agent', '/opt/chrome-profile', '/run/user/65532'], 0)
  const homeStatLines = homeStats.stdout.split('\n').filter(Boolean)
  check('image_users_and_runtime_dirs', homeStats.status === 0 && homeStatLines[0]?.startsWith('65532:65532:') && homeStatLines[2]?.startsWith('65532:65532:'))
  check('fsGroup_simulated_profile_owner_mode', homeStatLines[1] === '0:65532:770')
  check('fsGroup_simulated_legacy_profile_readable', execIn(normalName, ['cat', '/opt/chrome-profile/legacy-login.txt'], 65532).stdout.trim() === 'legacy-profile-fixture')
  const profileWrite = execIn(normalName, ['sh', '-c', 'printf fsGroup-write-fixture >/opt/chrome-profile/new-session.txt && test -s /opt/chrome-profile/new-session.txt'], 65532)
  check('fsGroup_simulated_legacy_profile_writable', profileWrite.status === 0)

  const normalStop = execIn(normalName, ['kill', '-TERM', '1'], 65532)
  check('model_can_request_normal_stop', normalStop.status === 0)
  const normalExited = await waitFor(() => {
    const state = inspect(normalName)
    return state.status === 'exited' || state.status === 'dead'
  }, 60_000)
  check('normal_stop_exits_container', normalExited)
  const normalState = inspect(normalName)
  report.normalContainerState = normalState
  check('normal_stop_nonzero_exit', normalState.exitCode !== 0)
  const normalFiles = await readJson(resolve(reportDir, 'backend-state.json'))
  report.normalBackendFiles = normalFiles
  check('backend_probe_write_persisted', normalFiles['probe.txt'] === 'fuse-fixture')
  check('backend_probe_fsync_persisted', normalFiles['probe-fsync.txt'] === 'fsync-fixture')
  check('normal_stop_final_fsync_persisted', normalFiles['final-stop.txt'] === 'final-fsync-fixture')

  const failureName = `${containerPrefix}-fuse-failure`
  await startContainer({
    name: failureName,
    capabilities: ['SYS_ADMIN', 'SETUID', 'SETGID', 'SETPCAP', 'KILL'],
  })
  const failureReady = await waitForProbe(failureName)
  check('failure_fixture_started', failureReady)
  if (failureReady) {
    const failurePidResult = execIn(failureName, ['cat', '/run/cumora/fuse.pid'], 0)
    const failurePid = failurePidResult.stdout.trim()
    const killFuse = execIn(failureName, ['kill', '-TERM', failurePid], 0)
    check('root_can_trigger_fuse_failure', killFuse.status === 0)
    const failureExited = await waitFor(() => {
      const state = inspect(failureName)
      return state.status === 'exited' || state.status === 'dead'
    }, 60_000)
    const failureState = inspect(failureName)
    report.failureContainerState = failureState
    check('fuse_failure_ends_container', failureExited)
    check('fuse_failure_nonzero_exit_70', failureState.exitCode === 70)
    const markerPath = resolve(reportDir, `${failureName}.marker`)
    const copiedMarker = docker(['cp', `${failureName}:/tmp/cumora-fuse-supervisor-failure`, markerPath])
    let markerText = ''
    if (copiedMarker.status === 0 && existsSync(markerPath)) markerText = await readFile(markerPath, 'utf8')
    check('fuse_failure_reason_recorded', copiedMarker.status === 0 && /reason=/.test(markerText))
  }

  for (const missing of ['SYS_ADMIN', 'SETPCAP']) {
    const name = `${containerPrefix}-missing-${missing.toLowerCase()}`
    const capabilities = ['SETUID', 'SETGID', 'KILL']
    if (missing !== 'SYS_ADMIN') capabilities.push('SYS_ADMIN')
    if (missing !== 'SETPCAP') capabilities.push('SETPCAP')
    await startContainer({ name, capabilities })
    const exited = await waitFor(() => {
      const state = inspect(name)
      return state.status === 'exited' || state.status === 'dead'
    }, 30_000)
    const output = logs(name)
    const missingState = inspect(name)
    check(`missing_${missing.toLowerCase()}_fails_closed`, exited && missingState.exitCode !== 0 && !output.stdout.includes('BOUNDARY_PROBE'))
    report[`missing_${missing.toLowerCase()}_state`] = missingState
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  report.failures.push('smoke_execution')
} finally {
  for (const name of containers) docker(['rm', '--force', name], { timeout: 20_000 })
  for (const volume of volumes) docker(['volume', 'rm', '--force', volume], { timeout: 20_000 })
  if (backend && !backend.killed) backend.kill('SIGTERM')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (report.failures.length > 0) {
  console.error(`agent-boundary-smoke: FAIL (${report.failures.join(', ')}) report=${reportPath}`)
  process.exit(1)
}
console.log(`agent-boundary-smoke: PASS report=${reportPath}`)
