import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const recovery = await import('../server/src/deploy/recovery.ts')

const DEFAULT_ROLLOUT_TIMEOUT_SECONDS = 600
const DEFAULT_JOB_TIMEOUT_SECONDS = 600
const DEFAULT_POLL_SECONDS = 3
const DEFAULT_POLL_ATTEMPTS = 30

class CommandFailure extends Error {
  constructor(code, details = {}) {
    super(code)
    this.code = code
    this.details = details
  }
}

function envRequired(name) {
  const value = process.env[name]
  if (!value) throw new CommandFailure(`missing_${name.toLowerCase()}`)
  return value
}

function parseJson(raw, code) {
  try {
    return JSON.parse(raw)
  } catch {
    throw new CommandFailure(code)
  }
}

function isComplete(job) {
  return Number(job?.status?.succeeded ?? 0) > 0 || (Array.isArray(job?.status?.conditions) && job.status.conditions.some((condition) => condition?.type === 'Complete' && condition?.status === 'True'))
}

function isFailed(job) {
  // A non-zero failed counter can coexist with active retries.  Only the
  // terminal Failed condition proves that a Job is no longer a writer.
  return Array.isArray(job?.status?.conditions) && job.status.conditions.some((condition) => condition?.type === 'Failed' && condition?.status === 'True')
}

function hasActiveWriter(job) {
  return Number(job?.status?.active ?? 0) > 0
}

function hasTerminalCondition(job) {
  return isFailed(job) || (Array.isArray(job?.status?.conditions) && job.status.conditions.some((condition) => condition?.type === 'Complete' && condition?.status === 'True'))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new CommandFailure('process_spawn_failed', { cause: error }))
    })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new CommandFailure('process_timeout', { stdout, stderr, signal }))
      } else if (exitCode !== 0) {
        reject(new CommandFailure('process_failed', { stdout, stderr, exitCode, signal }))
      } else {
        resolve({ stdout, stderr })
      }
    })
    if (options.input) child.stdin.write(options.input)
    child.stdin.end()
  })
}

function namespaceArgs() {
  const namespace = process.env.DEPLOYMENT_NAMESPACE
  return namespace ? ['-n', namespace] : []
}

async function kubectl(args, options = {}) {
  const command = process.env.KUBECTL || 'kubectl'
  try {
    return await runProcess(command, [...namespaceArgs(), ...args], options)
  } catch (error) {
    if (error instanceof CommandFailure) throw new CommandFailure(`kubectl_${error.code}`, error.details)
    throw error
  }
}

function workPath(name) {
  const root = process.env.RECOVERY_WORKDIR || process.env.RUNNER_TEMP || '/tmp'
  return join(root, `cumora-deploy-${process.env.GITHUB_RUN_ID || 'local'}-${name}`)
}

async function writePrivate(path, value) {
  await writeFile(path, `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function getDeployment(name) {
  let result
  try {
    result = await kubectl(['get', 'deployment', name, '-o', 'json'])
  } catch {
    throw new CommandFailure('deployment_read_failed')
  }
  return parseJson(result.stdout, 'deployment_json_invalid')
}

async function getJob(name) {
  const result = await kubectl(['get', 'job', name, '--ignore-not-found', '-o', 'json'])
  if (!result.stdout.trim()) return null
  return parseJson(result.stdout, 'job_json_invalid')
}

async function getSecret(name) {
  try {
    const result = await kubectl(['get', 'secret', name, '--ignore-not-found', '-o', 'json'])
    if (!result.stdout.trim()) return null
    return parseJson(result.stdout, 'secret_json_invalid')
  } catch (_error) {
    throw new CommandFailure('secret_read_failed')
  }
}

async function getOptionalJob(name) {
  try {
    return await getJob(name)
  } catch {
    throw new CommandFailure('job_read_failed')
  }
}

async function listResidualMigrationJobs() {
  const items = []
  for (const selector of ['app=cumora-schema-migration', 'app=cumora-schema-recovery']) {
    let result
    try {
      result = await kubectl(['get', 'jobs', '--ignore-not-found', '-l', selector, '-o', 'json'])
    } catch {
      throw new CommandFailure('migration_jobs_read_failed')
    }
    if (!result.stdout.trim()) continue
    const listing = parseJson(result.stdout, 'migration_jobs_json_invalid')
    if (!listing || typeof listing !== 'object' || !Array.isArray(listing.items)) throw new CommandFailure('migration_jobs_json_invalid')
    items.push(...listing.items)
  }
  return items
}

function secretData(secret, key) {
  const encoded = secret?.data?.[key]
  if (typeof encoded !== 'string') throw new CommandFailure('protected_state_missing')
  try {
    return parseJson(Buffer.from(encoded, 'base64').toString('utf8'), 'protected_state_invalid')
  } catch {
    throw new CommandFailure('protected_state_invalid')
  }
}

async function createImmutableSecret(name, key, value, labels) {
  const existing = await getSecret(name)
  if (existing) return existing
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, labels },
    immutable: true,
    type: 'Opaque',
    data: { [key]: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8').toString('base64') },
  }
  try {
    await kubectl(['create', '-f', '-'], { input: JSON.stringify(manifest) })
  } catch (error) {
    // A concurrent retry may have won the create-only race.  Read and verify
    // the protected state; never apply/update the original baseline Secret.
    if (!/already.?exists|409/i.test(`${error.details?.stderr ?? ''} ${error.details?.stdout ?? ''}`)) {
      throw new CommandFailure('protected_state_create_failed')
    }
    const raced = await getSecret(name)
    if (!raced) throw new CommandFailure('protected_state_create_failed')
    return raced
  }
  const created = await getSecret(name)
  if (!created) throw new CommandFailure('protected_state_read_failed')
  return created
}

async function captureBaseline(paths) {
  const deployment = await getDeployment(paths.deployment)
  let baseline = recovery.extractDeploymentSnapshot(deployment, {
    expectedName: paths.deployment,
    expectedNamespace: process.env.DEPLOYMENT_NAMESPACE,
  })
  const forwardOnly = process.env.RECOVERY_MODE === 'forward-only'
  if (!forwardOnly) {
    recovery.assertDeploymentHealthy(baseline)
    if (!(await smoke(false))) throw new CommandFailure('baseline_smoke_failed')
  }
  baseline = { ...baseline, baselineSmokePassed: !forwardOnly, baselineVerifiedAt: new Date().toISOString() }
  await writePrivate(paths.baseline, baseline)
  const existing = await getSecret(paths.recoverySecret)
  let protectedBaseline
  if (existing) {
    protectedBaseline = secretData(existing, 'baseline.json')
  } else {
    const created = await createImmutableSecret(paths.recoverySecret, 'baseline.json', baseline, {
      app: 'cumora-deploy-recovery',
      'recovery.cumora.ai/run-id': process.env.GITHUB_RUN_ID || 'local',
    })
    protectedBaseline = secretData(created, 'baseline.json')
  }
  recovery.assertBaselineUnchanged(protectedBaseline, baseline)
  return baseline
}

async function ensureBaselineUnchanged(paths, baseline) {
  const current = recovery.extractDeploymentSnapshot(await getDeployment(paths.deployment), {
    expectedName: baseline.name,
    expectedNamespace: baseline.namespace,
  })
  recovery.assertBaselineUnchanged(baseline, current)
  return current
}

async function runMigration(paths, baseline) {
  await ensureBaselineUnchanged(paths, baseline)
  const name = process.env.MIGRATION_JOB_NAME || `cumora-migrate-${(process.env.GITHUB_SHA || 'local').slice(0, 7)}-${process.env.GITHUB_RUN_ID || 'local'}`
  const residual = await listResidualMigrationJobs()
  if (residual.some((job) => hasActiveWriter(job) || !hasTerminalCondition(job))) throw new CommandFailure('migration_residual_job_present')
  const existing = await getOptionalJob(name)
  if (existing) throw new CommandFailure('migration_job_exists')
  const job = recovery.buildMigrationJob(baseline, {
    name,
    image: envRequired('CANDIDATE_SERVER_IMAGE'),
    repairMode: process.env.MIGRATION_REPAIR === 'archive-detach' ? 'archive-detach' : 'off',
    activeDeadlineSeconds: Number(process.env.MIGRATION_DEADLINE_SECONDS || DEFAULT_JOB_TIMEOUT_SECONDS),
  })
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(job) })
  await waitForJob(name, Number(process.env.MIGRATION_POLL_ATTEMPTS || DEFAULT_POLL_ATTEMPTS))
  return name
}

async function waitForJob(name, attempts) {
  const pollMs = Number(process.env.RECOVERY_POLL_MS || DEFAULT_POLL_SECONDS * 1_000)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const job = await getJob(name)
    if (!job) {
      if (attempt + 1 < attempts) await sleep(pollMs)
      continue
    }
    if (isComplete(job)) return job
    if (isFailed(job)) throw new CommandFailure('job_failed')
    if (attempt + 1 < attempts) await sleep(pollMs)
  }
  throw new CommandFailure('job_timeout')
}

async function applyCandidate(paths, baseline) {
  const current = await ensureBaselineUnchanged(paths, baseline)
  const images = { server: envRequired('CANDIDATE_SERVER_IMAGE') }
  if (process.env.INCLUDE_AGENT !== 'N') {
    const agent = envRequired('CANDIDATE_AGENT_IMAGE')
    images.agent = agent
  }
  const patch = recovery.buildCandidatePatch(baseline, images)
  await writePrivate(paths.candidatePatch, patch)
  let response
  try {
    response = await kubectl(['patch', 'deployment', paths.deployment, '--type=json', '--patch-file', paths.candidatePatch, '-o', 'json'])
  } catch {
    throw new CommandFailure('candidate_patch_failed')
  }
  const receiptObject = parseJson(response.stdout, 'candidate_receipt_invalid')
  const receipt = recovery.deploymentReceiptFromObject(receiptObject)
  recovery.assertCandidateReceiptMatches(baseline, receipt, images)
  await writePrivate(paths.receipt, receipt)
  const existingReceipt = await getSecret(paths.receiptSecret)
  let protectedReceipt
  if (existingReceipt) {
    protectedReceipt = secretData(existingReceipt, 'receipt.json')
  } else {
    const created = await createImmutableSecret(paths.receiptSecret, 'receipt.json', receipt, {
      app: 'cumora-deploy-recovery',
      'recovery.cumora.ai/run-id': process.env.GITHUB_RUN_ID || 'local',
      'recovery.cumora.ai/receipt': 'true',
    })
    protectedReceipt = secretData(created, 'receipt.json')
  }
  if (protectedReceipt.uid !== receipt.uid || protectedReceipt.podTemplateHash !== receipt.podTemplateHash) {
    throw new CommandFailure('candidate_receipt_conflict')
  }
  return { receipt, current }
}

async function rollout() {
  try {
    await kubectl(['rollout', 'status', `deployment/${process.env.DEPLOYMENT || 'cumora-server'}`, `--timeout=${Number(process.env.ROLLOUT_TIMEOUT_SECONDS || DEFAULT_ROLLOUT_TIMEOUT_SECONDS)}s`], {
      timeoutMs: (Number(process.env.ROLLOUT_TIMEOUT_SECONDS || DEFAULT_ROLLOUT_TIMEOUT_SECONDS) + 5) * 1_000,
    })
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

async function smoke(requireShipping = true) {
  try {
    await runProcess(process.execPath, ['scripts/release-smoke.mjs'], {
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      timeoutMs: Number(process.env.SMOKE_TIMEOUT_SECONDS || 120) * 1_000,
      env: { ...process.env, CUMORA_SMOKE_REQUIRE_SHIPPING: requireShipping ? 'Y' : 'N' },
    })
    return true
  } catch {
    return false
  }
}

async function runSchemaVerifier(paths, baseline) {
  const name = process.env.VERIFIER_JOB_NAME || `cumora-schema-verify-${(process.env.GITHUB_SHA || 'local').slice(0, 7)}-${process.env.GITHUB_RUN_ID || 'local'}`
  const existing = await getOptionalJob(name)
  if (existing) throw new CommandFailure('verifier_job_exists')
  const job = recovery.buildSchemaVerifierJob(baseline, { name, image: baseline.serverImage })
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(job) })
  const status = await waitForJob(name, Number(process.env.VERIFIER_POLL_ATTEMPTS || DEFAULT_POLL_ATTEMPTS))
  if (!isComplete(status)) throw new CommandFailure('verifier_failed')
  let logs
  try {
    logs = await kubectl(['logs', `job/${name}`, '-c', 'migrate'])
  } catch {
    throw new CommandFailure('verifier_logs_failed')
  }
  // `kubectl logs` stdout is the verifier protocol.  kubectl's own stderr is
  // transport/diagnostic output and must not be mixed into the old image's
  // strict single-marker stream.
  const result = recovery.parseSchemaVerifierOutput(logs.stdout)
  if (result.status !== 'compatible') throw new CommandFailure(result.status === 'incompatible' ? 'schema_incompatible' : 'schema_unknown')
  return result
}

async function restore(paths, baseline, expectedHash) {
  const currentObject = await getDeployment(paths.deployment)
  const current = recovery.deploymentReceiptFromObject(currentObject)
  const patch = recovery.buildRestorePatch(baseline, current, expectedHash)
  await writePrivate(paths.restorePatch, patch)
  try {
    await kubectl(['patch', 'deployment', paths.deployment, '--type=json', '--patch-file', paths.restorePatch, '-o', 'json'])
  } catch {
    throw new CommandFailure('restore_patch_failed')
  }
  if (!(await rollout()).ok) throw new CommandFailure('restore_rollout_failed')
  if (!(await smoke(false))) throw new CommandFailure('restore_smoke_failed')
  const restored = recovery.extractDeploymentSnapshot(await getDeployment(paths.deployment), {
    expectedName: baseline.name,
    expectedNamespace: baseline.namespace,
  })
  if (restored.uid !== baseline.uid || restored.podTemplateHash !== baseline.podTemplateHash) {
    throw new CommandFailure('restore_receipt_mismatch')
  }
  recovery.assertDeploymentHealthy(restored)
}

async function recover(paths, baseline) {
  recovery.assertRecoveryEligible(baseline)
  const protectedReceiptSecret = await getSecret(paths.receiptSecret)
  if (!protectedReceiptSecret) throw new CommandFailure('protected_receipt_missing')
  const protectedReceipt = secretData(protectedReceiptSecret, 'receipt.json')
  recovery.assertReceiptShapeForRecovery(protectedReceipt)
  recovery.assertRecoveryStateBinding(baseline, protectedReceipt)
  // This first CAS check is deliberately before the old-image verifier.  A
  // controller/operator drift must never be hidden by a successful verifier.
  const current = recovery.deploymentReceiptFromObject(await getDeployment(paths.deployment))
  recovery.buildRestorePatch(baseline, current, protectedReceipt.podTemplateHash)
  await runSchemaVerifier(paths, baseline)
  await restore(paths, baseline, protectedReceipt.podTemplateHash)
}

async function recoverExistingDeployment() {
  const state = paths()
  await mkdir(state.root, { recursive: true, mode: 0o700 })
  const baselineSecret = await getSecret(state.recoverySecret)
  if (!baselineSecret) throw new CommandFailure('protected_baseline_missing')
  const receiptSecret = await getSecret(state.receiptSecret)
  if (!receiptSecret) throw new CommandFailure('protected_receipt_missing')
  const baseline = secretData(baselineSecret, 'baseline.json')
  const receipt = secretData(receiptSecret, 'receipt.json')
  recovery.assertReceiptShapeForRecovery(receipt)
  recovery.assertRecoveryStateBinding(baseline, receipt)
  await writePrivate(state.baseline, baseline)
  await writePrivate(state.receipt, receipt)
  const residual = await listResidualMigrationJobs()
  if (residual.some((job) => hasActiveWriter(job) || !hasTerminalCondition(job))) {
    throw new CommandFailure('migration_residual_job_active')
  }
  const current = recovery.deploymentReceiptFromObject(await getDeployment(state.deployment))
  recovery.buildRestorePatch(baseline, current, receipt.podTemplateHash)
  recovery.assertRecoveryEligible(baseline)
  await runSchemaVerifier(state, baseline)
  await restore(state, baseline, receipt.podTemplateHash)
  return { status: 'recovered', baselineHash: baseline.podTemplateHash }
}

function paths() {
  const deployment = process.env.DEPLOYMENT || 'cumora-server'
  return {
    deployment,
    recoverySecret: envRequired('RECOVERY_SECRET'),
    receiptSecret: envRequired('RECEIPT_SECRET'),
    root: process.env.RECOVERY_WORKDIR || process.env.RUNNER_TEMP || '/tmp',
    baseline: workPath('baseline.json'),
    candidatePatch: workPath('candidate-patch.json'),
    receipt: workPath('receipt.json'),
    restorePatch: workPath('restore-patch.json'),
  }
}

export async function runDeploymentRelease() {
  const state = paths()
  await mkdir(state.root, { recursive: true, mode: 0o700 })
  const baseline = await captureBaseline(state)
  await runMigration(state, baseline)
  await applyCandidate(state, baseline)
  const rolledOut = await rollout()
  if (!rolledOut.ok) {
    if (process.env.RECOVERY_MODE === 'forward-only') throw new CommandFailure('candidate_failed_forward_only')
    try {
      await recover(state, baseline)
    } catch (error) {
      throw new CommandFailure(error instanceof CommandFailure ? error.code : 'recovery_failed')
    }
    throw new CommandFailure('candidate_failed_recovered')
  }
  if (!(await smoke(true))) {
    if (process.env.RECOVERY_MODE === 'forward-only') throw new CommandFailure('candidate_failed_forward_only')
    try {
      await recover(state, baseline)
    } catch (error) {
      throw new CommandFailure(error instanceof CommandFailure ? error.code : 'recovery_failed')
    }
    throw new CommandFailure('candidate_failed_recovered')
  }
  const candidateObject = await getDeployment(state.deployment)
  const candidateSnapshot = recovery.extractDeploymentSnapshot(candidateObject, {
    expectedName: baseline.name,
    expectedNamespace: baseline.namespace,
  })
  const candidate = recovery.deploymentReceiptFromObject(candidateObject)
  const protectedReceipt = secretData(await getSecret(state.receiptSecret), 'receipt.json')
  recovery.assertDeploymentReceiptMatches(baseline, candidate, protectedReceipt.podTemplateHash)
  recovery.assertDeploymentHealthy(candidateSnapshot)
  return { status: 'deployed', baselineHash: baseline.podTemplateHash }
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'run'
  if (command === 'run') return runDeploymentRelease()
  if (command === 'recover' || command === 'resume') return recoverExistingDeployment()
  throw new CommandFailure('unknown_command')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = await main()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`deploy-release: ${error instanceof CommandFailure ? error.code : 'failed'}\n`)
    process.exitCode = 1
  }
}
