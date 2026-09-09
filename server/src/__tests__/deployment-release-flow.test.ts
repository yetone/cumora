import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { test } from 'node:test'

const testFileDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(testFileDir, '../../..')
const fakeKubectl = resolve(testFileDir, 'fixtures/deployment-fake-kubectl.mjs')

const marker = 'FAKE_SECRET_MARKER'
const companyId = 'company-flow-fixture'
const serverOld = `server@sha256:${'1'.repeat(64)}`
const serverNew = `server@sha256:${'2'.repeat(64)}`
const agentOld = `agent@sha256:${'4'.repeat(64)}`
const agentNew = `agent@sha256:${'5'.repeat(64)}`

const startupProbe = {
  httpGet: { path: '/api/livez', port: 'http' },
  periodSeconds: 5,
  timeoutSeconds: 2,
  failureThreshold: 60,
}
const readinessProbe = {
  httpGet: { path: '/api/health', port: 'http' },
  periodSeconds: 5,
  timeoutSeconds: 2,
}
const livenessProbe = {
  httpGet: { path: '/api/livez', port: 'http' },
  periodSeconds: 30,
  timeoutSeconds: 3,
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function baselineDeployment(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      name: 'cumora-server',
      namespace: 'default',
      uid: 'deployment-flow-uid',
      generation: 12,
      annotations: { 'fixture.cumora.ai/secret': marker },
    },
    spec: {
      replicas: 2,
      template: {
        metadata: {
          labels: { app: 'cumora-server' },
          annotations: { 'fixture.cumora.ai/template': marker },
        },
        spec: {
          serviceAccountName: 'cumora-server',
          automountServiceAccountToken: true,
          imagePullSecrets: [{ name: 'fixture-pull' }],
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          volumes: [
            { name: 'proxy-cert', secret: { secretName: 'cloud-sql-cert' } },
            { name: 'scratch', emptyDir: {} },
          ],
          initContainers: [{ name: 'migrate', image: `migrate@sha256:${'6'.repeat(64)}` }],
          containers: [
            {
              name: 'cloud-sql-proxy',
              image: `proxy@sha256:${'7'.repeat(64)}`,
              args: ['--port=5432'],
              env: [{ name: 'PROXY_MODE', value: 'fixture' }],
              volumeMounts: [{ name: 'proxy-cert', mountPath: '/var/run/proxy', readOnly: true }],
              securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              startupProbe: { httpGet: { path: '/readiness', port: 9090 }, periodSeconds: 1, failureThreshold: 60 },
              readinessProbe: { httpGet: { path: '/readiness', port: 9090 } },
            },
            {
              name: 'server',
              image: serverOld,
              envFrom: [{ secretRef: { name: 'cumora' } }],
              env: [{ name: 'CUMORA_AGENT_COMPUTER_IMAGE', value: agentOld }],
              volumeMounts: [{ name: 'scratch', mountPath: '/tmp/cumora' }],
              securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false },
              startupProbe,
              readinessProbe,
              livenessProbe,
              resources: { requests: { cpu: '250m', memory: '512Mi' } },
            },
          ],
        },
      },
    },
    status: {
      observedGeneration: 12,
      updatedReplicas: 2,
      readyReplicas: 2,
      availableReplicas: 2,
    },
  }
}

type ScenarioConfig = Record<string, unknown> & {
  smoke?: Record<string, boolean>
}

function makeState(config: ScenarioConfig = {}, deployment = baselineDeployment()): Record<string, any> {
  const state = {
    config: {
      baselineServerImage: serverOld,
      secretMarker: marker,
      emitSecretMarker: true,
      ...config,
    },
    initialDeployment: clone(deployment),
    deployment: clone(deployment),
    phase: 'baseline',
    secrets: {},
    jobs: {},
    history: { commands: [], patches: [], rollouts: [], appliedJobs: [] },
  }
  if (config.baselineUnhealthy) {
    const deployment = state.deployment as any
    deployment.status = {
      ...deployment.status,
      observedGeneration: deployment.metadata.generation - 1,
      updatedReplicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
    }
  }
  return state
}

function serverContainer(state: Record<string, any>) {
  return state.deployment.spec.template.spec.containers.find((container: any) => container.name === 'server')
}

function stateHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sortKeys(child)]))
}

function decodeSecret(state: Record<string, any>, secretName: string, key: string): Record<string, any> {
  const encoded = state.secrets?.[secretName]?.data?.[key]
  assert.equal(typeof encoded, 'string', `${secretName} must contain ${key}`)
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, any>
}

async function startSmokeServer(statePath: string, config: ScenarioConfig): Promise<{ server: Server; base: string }> {
  let lastSmokePhase: string | null = null
  let lastSmokeRequest = ''
  const server = createServer(async (request, response) => {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
    const phase = String(state.phase || 'baseline')
    const pathname = (request.url || '/').split('?')[0]
    const shouldPass = config.smoke?.[phase] !== false
    const shippingRequired = String(config.shippingRequired ?? 'Y') !== 'N'
    const terminalPath = shippingRequired ? '/api/shipping/overview' : '/api/conversations'
    const shipping404Phases = Array.isArray(config.shipping404Phases) ? config.shipping404Phases.map(String) : []
    const shipping404 = pathname === '/api/shipping/overview' && shipping404Phases.includes(phase)
    if (shipping404) {
      response.statusCode = 404
      response.setHeader('content-type', 'text/plain')
      response.end(`${marker}: shipping fixture unavailable during ${phase}`)
    } else if (shouldPass) {
      response.statusCode = 200
      response.setHeader('content-type', 'application/json')
      if (pathname === '/api/health') response.end(JSON.stringify({ ok: true }))
      else if (pathname === '/api/auth/me') response.end(JSON.stringify({ companies: [{ id: companyId }] }))
      else if (pathname === '/api/conversations') response.end(JSON.stringify([]))
      else if (pathname === '/api/shipping/overview') response.end(JSON.stringify({ features: [], friction: [], dueReadbacks: [] }))
      else response.end(JSON.stringify({ ok: true }))
    } else {
      response.statusCode = 503
      response.setHeader('content-type', 'text/plain')
      response.end(`${marker}: smoke fixture rejected ${phase}`)
    }
    lastSmokePhase = phase
    lastSmokeRequest = pathname
    if (config.driftAfterSmoke === phase && pathname === terminalPath && !state.driftAfterSmokeApplied) {
      state.driftAfterSmokeApplied = true
      state.deployment.spec.template.metadata.annotations = {
        ...(state.deployment.spec.template.metadata.annotations || {}),
        'fake.cumora.ai/post-smoke-drift': marker,
      }
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  assert.equal(lastSmokePhase, null)
  assert.equal(lastSmokeRequest, '')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  state: Record<string, any>
}

let runCounter = 0

async function runScenario(config: ScenarioConfig = {}, deployment = baselineDeployment()): Promise<RunResult> {
  await chmod(fakeKubectl, 0o755)
  const root = await mkdtemp(join(tmpdir(), 'cumora-deployment-release-flow-'))
  const statePath = join(root, 'fake-kubectl-state.json')
  const state = makeState(config, deployment)
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  const smoke = await startSmokeServer(statePath, config)
  const runId = `flow-${process.pid}-${runCounter++}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KUBECTL: fakeKubectl,
    FAKE_KUBECTL_STATE: statePath,
    DEPLOYMENT: 'cumora-server',
    DEPLOYMENT_NAMESPACE: 'default',
    RECOVERY_SECRET: 'flow-baseline-secret',
    RECEIPT_SECRET: 'flow-receipt-secret',
    RECOVERY_WORKDIR: root,
    RUNNER_TEMP: root,
    GITHUB_WORKSPACE: repoRoot,
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: 'abcdef1234567890',
    CANDIDATE_SERVER_IMAGE: serverNew,
    CANDIDATE_AGENT_IMAGE: agentNew,
    INCLUDE_AGENT: 'Y',
    MIGRATION_JOB_NAME: `flow-migrate-${runId}`,
    VERIFIER_JOB_NAME: `flow-verifier-${runId}`,
    RECOVERY_POLL_MS: '1',
    MIGRATION_POLL_ATTEMPTS: '1',
    VERIFIER_POLL_ATTEMPTS: '1',
    ROLLOUT_TIMEOUT_SECONDS: '1',
    SMOKE_TIMEOUT_SECONDS: '5',
    CUMORA_SMOKE_TOKEN: 'dummy-flow-token',
    CUMORA_SMOKE_COMPANY_ID: companyId,
    CUMORA_SMOKE_BASE: smoke.base,
    CUMORA_SMOKE_REQUIRE_SHIPPING: String(config.shippingRequired ?? 'Y'),
  }
  if (config.recoveryMode !== undefined) env.RECOVERY_MODE = String(config.recoveryMode)
  else delete env.RECOVERY_MODE
  delete env.SMOKE_COMMAND

  let child: ReturnType<typeof spawn> | undefined
  let result: RunResult
  try {
    result = await new Promise<RunResult>((resolveResult) => {
      child = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-release.mjs', 'run'], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })
      const timer = setTimeout(() => child?.kill('SIGTERM'), 15_000)
      child.on('close', async (code, signal) => {
        clearTimeout(timer)
        const finalState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
        resolveResult({ code, signal, stdout, stderr, state: finalState })
      })
    })
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    await new Promise<void>((resolveClose) => smoke.server.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
  }
  return result
}

function assertNoSecretLeak(result: Pick<RunResult, 'stdout' | 'stderr'>) {
  assert.doesNotMatch(result.stdout, new RegExp(marker))
  assert.doesNotMatch(result.stderr, new RegExp(marker))
}

test('real deploy-release entrypoint completes candidate and stores API PATCH response receipt', async () => {
  const result = await runScenario({ defaultCandidatePatchResponse: true, smoke: { baseline: true, candidate: true, restored: true } })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /"status":"deployed"/)
  assertNoSecretLeak(result)
  assert.equal(result.state.phase, 'candidate')
  assert.equal(serverContainer(result.state).image, serverNew)
  assert.equal(serverContainer(result.state).env.find((entry: any) => entry.name === 'CUMORA_AGENT_COMPUTER_IMAGE').value, agentNew)
  assert.equal(result.state.history.patches.length, 1)
  assert.equal(result.state.history.rollouts.length, 1)
  assert.deepEqual(result.state.history.rollouts[0], { phase: 'candidate', setting: 'success' })
  const receipt = decodeSecret(result.state, 'flow-receipt-secret', 'receipt.json')
  assert.equal(receipt.serverImage, serverNew)
  assert.equal(receipt.podTemplate.metadata.annotations['fake.cumora.ai/writer'], 'api-default')
  assert.equal(receipt.podTemplateHash, stateHash(result.state.deployment.spec.template))
  const baseline = decodeSecret(result.state, 'flow-baseline-secret', 'baseline.json')
  assert.equal(baseline.serverImage, serverOld)
  assert.deepEqual(receipt.podTemplate.spec.volumes, baseline.podTemplate.spec.volumes)
  assert.deepEqual(receipt.podTemplate.spec.securityContext, baseline.podTemplate.spec.securityContext)
  assert.deepEqual(receipt.podTemplate.spec.containers.find((container: any) => container.name === 'server').envFrom, baseline.podTemplate.spec.containers.find((container: any) => container.name === 'server').envFrom)
})

test('candidate smoke failure restores exact baseline and leaves process failed', async () => {
  const result = await runScenario({ smoke: { baseline: true, candidate: false, restored: true } })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /candidate_failed_recovered|recovery_failed/)
  assertNoSecretLeak(result)
  assert.equal(result.state.phase, 'restored')
  assert.equal(serverContainer(result.state).image, serverOld)
  assert.equal(serverContainer(result.state).env.find((entry: any) => entry.name === 'CUMORA_AGENT_COMPUTER_IMAGE').value, agentOld)
  assert.equal(result.state.history.patches.length, 2)
  assert.deepEqual(result.state.history.rollouts.map((entry: any) => entry.phase), ['candidate', 'restored'])
  const baseline = decodeSecret(result.state, 'flow-baseline-secret', 'baseline.json')
  const restoredTemplateHash = stateHash(result.state.deployment.spec.template)
  assert.equal(restoredTemplateHash, baseline.podTemplateHash)
})

test('rollout timeout follows the same guarded recovery path', async () => {
  const result = await runScenario({ candidateRollout: 'timeout', smoke: { baseline: true, candidate: true, restored: true } })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /candidate_failed_recovered|recovery_failed/)
  assertNoSecretLeak(result)
  assert.equal(result.state.phase, 'restored')
  assert.equal(serverContainer(result.state).image, serverOld)
  assert.equal(result.state.history.patches.length, 2)
})

for (const [name, failureMessage] of [
  ['kubectl timed-out condition', 'error: timed out waiting for the condition'],
  ['deployment progress deadline', 'deployment exceeded its progress deadline'],
] as const) {
  test(`${name} is a nonzero rollout failure with guarded recovery`, async () => {
    const result = await runScenario({
      candidateRollout: 'failure',
      rolloutFailureMessage: failureMessage,
      smoke: { baseline: true, candidate: true, restored: true },
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /candidate_failed_recovered|recovery_failed/)
    assertNoSecretLeak(result)
    assert.equal(result.state.history.rollouts[0].failureMessage, failureMessage)
    assert.equal(result.state.history.patches.length, 2)
    assert.equal(result.state.phase, 'restored')
    assert.equal(serverContainer(result.state).image, serverOld)
  })
}

const verifierCases: Array<[string, ScenarioConfig, RegExp]> = [
  ['schema_ahead', { verifierResult: 'schema_ahead' }, /schema_incompatible/],
  ['incompatible', { verifierResult: 'schema_behind' }, /schema_incompatible/],
  ['unknown', { verifierResult: 'unknown' }, /schema_unknown/],
  ['malformed', { verifierResult: 'malformed' }, /schema_unknown/],
  ['missing', { verifierStatus: 'missing' }, /job_timeout/],
  ['failed', { verifierStatus: 'failed' }, /job_failed/],
  ['timedout', { verifierStatus: 'timedout' }, /job_timeout/],
]

for (const [name, verifierConfig, expectedError] of verifierCases) {
  test(`verifier ${name} never restores a failed candidate`, async () => {
    const result = await runScenario({
      ...verifierConfig,
      smoke: { baseline: true, candidate: false, restored: true },
    })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, expectedError)
    assertNoSecretLeak(result)
    assert.equal(result.state.history.patches.length, 1)
    assert.equal(result.state.phase, 'candidate')
    assert.equal(serverContainer(result.state).image, serverNew)
  })
}

test('CAS drift and UID changes prevent automatic recovery', async () => {
  for (const drift of ['drift-template', 'drift-uid']) {
    const result = await runScenario({
      candidateRollout: drift,
      smoke: { baseline: true, candidate: true, restored: true },
    })
    assert.notEqual(result.code, 0, drift)
    assertNoSecretLeak(result)
    assert.equal(result.state.history.patches.length, 1, drift)
    assert.equal(serverContainer(result.state).image, serverNew, drift)
  }
})

test('a progress-deadline rollout failure enters the same guarded recovery path', async () => {
  const result = await runScenario({
    candidateRollout: 'progressing',
    // The endpoint can still be served by old Pods while the candidate is
    // progressing.  The rollout failure still enters the full CAS/verifier
    // recovery path; the release remains nonzero.
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(result.code, 0)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 2)
  assert.equal(result.state.phase, 'restored')
  assert.equal(serverContainer(result.state).image, serverOld)
})

test('baseline and restore tolerate Shipping 404 while candidate smoke keeps Shipping strict', async () => {
  const deployed = await runScenario({
    shipping404Phases: ['baseline', 'restored'],
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.equal(deployed.code, 0, deployed.stderr)
  assertNoSecretLeak(deployed)
  assert.equal(deployed.state.phase, 'candidate')
  assert.equal(deployed.state.history.patches.length, 1)
  assert.equal(serverContainer(deployed.state).image, serverNew)

  const recovered = await runScenario({
    shipping404Phases: ['baseline', 'restored'],
    smoke: { baseline: true, candidate: false, restored: true },
  })
  assert.notEqual(recovered.code, 0)
  assert.match(recovered.stderr, /candidate_failed_recovered|recovery_failed/)
  assertNoSecretLeak(recovered)
  assert.equal(recovered.state.phase, 'restored')
  assert.equal(recovered.state.history.patches.length, 2)
  assert.equal(serverContainer(recovered.state).image, serverOld)
})

test('forward-only can publish with an unhealthy baseline but never restores a failed candidate', async () => {
  const normal = await runScenario({
    baselineUnhealthy: true,
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(normal.code, 0)
  assertNoSecretLeak(normal)
  assert.equal(normal.state.history.patches.length, 0)

  const forwardOnlySuccess = await runScenario({
    baselineUnhealthy: true,
    recoveryMode: 'forward-only',
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.equal(forwardOnlySuccess.code, 0, forwardOnlySuccess.stderr)
  assertNoSecretLeak(forwardOnlySuccess)
  assert.equal(forwardOnlySuccess.state.history.patches.length, 1)
  assert.equal(forwardOnlySuccess.state.phase, 'candidate')
  assert.equal(serverContainer(forwardOnlySuccess.state).image, serverNew)

  const forwardOnlyFailure = await runScenario({
    baselineUnhealthy: true,
    recoveryMode: 'forward-only',
    smoke: { baseline: true, candidate: false, restored: true },
  })
  assert.notEqual(forwardOnlyFailure.code, 0)
  assert.match(forwardOnlyFailure.stderr, /candidate_failed_forward_only/)
  assertNoSecretLeak(forwardOnlyFailure)
  assert.equal(forwardOnlyFailure.state.history.patches.length, 1)
  assert.equal(forwardOnlyFailure.state.phase, 'candidate')
  assert.equal(serverContainer(forwardOnlyFailure.state).image, serverNew)
})

test('mutable baseline is rejected before any migration or Deployment patch', async () => {
  const deployment = baselineDeployment()
  ;(deployment.spec as any).template.spec.containers.find((container: any) => container.name === 'server').image = 'server:latest'
  const result = await runScenario({ smoke: { baseline: true, candidate: true, restored: true } }, deployment)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /failed|digest|baseline/i)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 0)
  assert.equal(result.state.history.appliedJobs.length, 0)
})

test('unknown agent baseline is not eligible for automatic restore', async () => {
  const deployment = baselineDeployment()
  const server = (deployment.spec as any).template.spec.containers.find((container: any) => container.name === 'server')
  server.env = [{ name: 'CUMORA_AGENT_COMPUTER_IMAGE', valueFrom: { secretKeyRef: { name: 'agent-image' } } }]
  const result = await runScenario({ smoke: { baseline: true, candidate: false, restored: true } }, deployment)
  assert.notEqual(result.code, 0)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 1)
  assert.equal(serverContainer(result.state).image, serverNew)
})

for (const restoreFailure of ['restorePatchFailure', 'restoreRollout', 'restoreSmoke'] as const) {
  test(`${restoreFailure} keeps release nonzero and preserves protected baseline`, async () => {
    const config: ScenarioConfig = {
      smoke: { baseline: true, candidate: false, restored: restoreFailure !== 'restoreSmoke' },
    }
    if (restoreFailure === 'restorePatchFailure') config.restorePatchFailure = 'forbidden restore patch'
    if (restoreFailure === 'restoreRollout') config.restoreRollout = 'timeout'
    if (restoreFailure === 'restoreSmoke') config.restoreSmoke = 'fail'
    const result = await runScenario(config)
    assert.notEqual(result.code, 0)
    assertNoSecretLeak(result)
    const baseline = decodeSecret(result.state, 'flow-baseline-secret', 'baseline.json')
    assert.equal(baseline.serverImage, serverOld)
    assert.equal(result.state.history.patches.length, restoreFailure === 'restorePatchFailure' ? 1 : 2)
    if (restoreFailure === 'restorePatchFailure') assert.equal(serverContainer(result.state).image, serverNew)
    if (restoreFailure === 'restoreRollout') assert.equal(serverContainer(result.state).image, serverOld)
  })
}

test('migration failure creates the baseline record but never patches the Deployment', async () => {
  const result = await runScenario({ migrationStatus: 'failed', smoke: { baseline: true, candidate: true, restored: true } })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /job_failed/)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 0)
  assert.equal(result.state.history.appliedJobs.length, 1)
  const baseline = decodeSecret(result.state, 'flow-baseline-secret', 'baseline.json')
  assert.equal(baseline.serverImage, serverOld)
})

test('an active migration Job from another run blocks a new migration writer', async () => {
  const state = makeState({ smoke: { baseline: true, candidate: true, restored: true } })
  state.jobs['old-run-migration'] = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'old-run-migration', labels: { app: 'cumora-schema-migration' } },
    status: { active: 1 },
  }
  const result = await runScenarioWithState(state)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /migration_residual_job_present/)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 0)
  assert.equal(result.state.history.appliedJobs.length, 0)
})

test('a residual Job with active Pods is blocking even when succeeded is nonzero', async () => {
  const state = makeState({ smoke: { baseline: true, candidate: true, restored: true } })
  state.jobs['active-and-succeeded-migration'] = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'active-and-succeeded-migration', labels: { app: 'cumora-schema-recovery' } },
    status: { active: 1, succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
  }
  const result = await runScenarioWithState(state)
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /migration_residual_job_(?:present|active)/)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 0)
  assert.equal(result.state.history.appliedJobs.length, 0)
})

test('a residual Job is allowed only with terminal Complete condition and active zero', async () => {
  const state = makeState({ smoke: { baseline: true, candidate: true, restored: true } })
  state.jobs['completed-migration'] = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'completed-migration', labels: { app: 'cumora-schema-recovery' } },
    status: { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] },
  }
  const result = await runScenarioWithState(state)
  assert.equal(result.code, 0, result.stderr)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 1)
  assert.equal(result.state.phase, 'candidate')
  assert.equal(serverContainer(result.state).image, serverNew)
})

test('create-only baseline race with a different protected value is rejected', async () => {
  const result = await runScenario({
    secretCreateRaces: { 'flow-baseline-secret': 'different' },
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /failed|protected|baseline/i)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 0)
  const raced = decodeSecret(result.state, 'flow-baseline-secret', 'baseline.json')
  assert.equal(raced.uid, 'raced-secret-uid')
})

test('receipt create race and Secret API errors fail closed', async () => {
  const racedReceipt = await runScenario({
    secretCreateRaces: { 'flow-receipt-secret': 'different' },
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(racedReceipt.code, 0)
  assert.match(racedReceipt.stderr, /candidate_receipt_conflict|failed/)
  assertNoSecretLeak(racedReceipt)
  assert.equal(racedReceipt.state.history.patches.length, 1)

  const apiFailure = await runScenario({
    secretReadFailures: { 'flow-baseline-secret': 'API unavailable' },
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(apiFailure.code, 0)
  assert.match(apiFailure.stderr, /secret_read_failed/)
  assertNoSecretLeak(apiFailure)
  assert.equal(apiFailure.state.history.patches.length, 0)
})

test('a concurrent writer after the PATCH response cannot become this run receipt', async () => {
  const result = await runScenario({
    switchWriterAfterCandidateResponse: true,
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(result.code, 0)
  assertNoSecretLeak(result)
  const receipt = decodeSecret(result.state, 'flow-receipt-secret', 'receipt.json')
  assert.equal(receipt.serverImage, serverNew)
  assert.notEqual(receipt.podTemplateHash, stateHash(result.state.deployment.spec.template))
  assert.equal(serverContainer(result.state).image, serverNew)
})

test('template drift after a successful candidate smoke cannot report success', async () => {
  const result = await runScenario({
    driftAfterSmoke: 'candidate',
    smoke: { baseline: true, candidate: true, restored: true },
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /failed|candidate|template/i)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 1)
})

test('template drift after successful restore smoke cannot report recovered success', async () => {
  const result = await runScenario({
    driftAfterSmoke: 'restored',
    smoke: { baseline: true, candidate: false, restored: true },
  })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /recovery_failed|restore_receipt_mismatch|failed|template/i)
  assertNoSecretLeak(result)
  assert.equal(result.state.history.patches.length, 2)
  assert.equal(serverContainer(result.state).image, serverOld)
})

interface EntrypointResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function captureChild(child: ReturnType<typeof spawn>, timeoutMs = 8_000): Promise<EntrypointResult> {
  return new Promise((resolveResult) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ code, signal, stdout, stderr })
    })
  })
}

function waitMs(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

async function runInterruptedRecoveryScenario(removeReceipt: boolean): Promise<{ run: EntrypointResult; recovery: EntrypointResult; state: Record<string, any> }> {
  await chmod(fakeKubectl, 0o755)
  const root = await mkdtemp(join(tmpdir(), 'cumora-deployment-manual-recovery-'))
  const statePath = join(root, 'fake-kubectl-state.json')
  const config: ScenarioConfig = {
    // Stop the real run while its rollout-status child is waiting.  This
    // leaves the immutable baseline and candidate receipt persisted exactly
    // as an interrupted CI job would.
    holdCandidateRolloutMs: 1_000,
    smoke: { baseline: true, candidate: true, restored: true },
  }
  await writeFile(statePath, `${JSON.stringify(makeState(config), null, 2)}\n`, { mode: 0o600 })
  const smoke = await startSmokeServer(statePath, config)
  const runId = `manual-${process.pid}-${runCounter++}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KUBECTL: fakeKubectl,
    FAKE_KUBECTL_STATE: statePath,
    DEPLOYMENT: 'cumora-server',
    DEPLOYMENT_NAMESPACE: 'default',
    RECOVERY_SECRET: 'flow-baseline-secret',
    RECEIPT_SECRET: 'flow-receipt-secret',
    RECOVERY_WORKDIR: root,
    RUNNER_TEMP: root,
    GITHUB_WORKSPACE: repoRoot,
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: 'abcdef1234567890',
    CANDIDATE_SERVER_IMAGE: serverNew,
    CANDIDATE_AGENT_IMAGE: agentNew,
    INCLUDE_AGENT: 'Y',
    MIGRATION_JOB_NAME: `manual-migrate-${runId}`,
    VERIFIER_JOB_NAME: `manual-verifier-${runId}`,
    RECOVERY_POLL_MS: '1',
    MIGRATION_POLL_ATTEMPTS: '1',
    VERIFIER_POLL_ATTEMPTS: '1',
    ROLLOUT_TIMEOUT_SECONDS: '10',
    SMOKE_TIMEOUT_SECONDS: '5',
    CUMORA_SMOKE_TOKEN: 'dummy-flow-token',
    CUMORA_SMOKE_COMPANY_ID: companyId,
    CUMORA_SMOKE_BASE: smoke.base,
    CUMORA_SMOKE_REQUIRE_SHIPPING: 'Y',
  }
  delete env.SMOKE_COMMAND
  let runChild: ReturnType<typeof spawn> | undefined
  try {
    runChild = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-release.mjs', 'run'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const runResultPromise = captureChild(runChild, 8_000)
    let interruptedState: Record<string, any> | null = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const candidateState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
        if (candidateState.history?.patches?.length === 1 && candidateState.phase === 'candidate' && candidateState.secrets?.['flow-receipt-secret']) {
          interruptedState = candidateState
          break
        }
      } catch {
        // The fake kubectl writes a complete JSON file between calls; a poll
        // that catches its brief replacement window simply retries.
      }
      await waitMs(10)
    }
    assert.ok(interruptedState, 'real run must persist candidate receipt before interruption')
    runChild.kill('SIGTERM')
    const run = await runResultPromise
    // Let the fake rollout child finish its bounded hold before the recover
    // command starts reading the same state file.
    await waitMs(1_100)
    const beforeRecovery = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
    if (removeReceipt) delete beforeRecovery.secrets['flow-receipt-secret']
    await writeFile(statePath, `${JSON.stringify(beforeRecovery, null, 2)}\n`, { mode: 0o600 })
    const recoveryChild = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-release.mjs', 'recover'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const recovery = await captureChild(recoveryChild)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
    return { run, recovery, state }
  } finally {
    if (runChild && runChild.exitCode === null) runChild.kill('SIGTERM')
    await new Promise<void>((resolveClose) => smoke.server.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
  }
}

test('an interrupted run can recover from protected baseline and receipt via the real recover entrypoint', async () => {
  const result = await runInterruptedRecoveryScenario(false)
  assert.notEqual(result.run.code, 0, 'the intentionally interrupted run must not report success')
  assert.equal(result.run.signal, 'SIGTERM')
  assert.equal(result.recovery.code, 0, result.recovery.stderr)
  assert.match(result.recovery.stdout, /"status":"recovered"/)
  assertNoSecretLeak(result.recovery)
  assert.equal(result.state.phase, 'restored')
  assert.equal(serverContainer(result.state).image, serverOld)
  assert.equal(result.state.history.patches.length, 2)
})

test('manual recover rejects an interrupted run when its protected receipt is missing', async () => {
  const result = await runInterruptedRecoveryScenario(true)
  assert.notEqual(result.run.code, 0)
  assert.equal(result.run.signal, 'SIGTERM')
  assert.notEqual(result.recovery.code, 0)
  assert.match(result.recovery.stderr, /protected_receipt_missing/)
  assertNoSecretLeak(result.recovery)
  assert.equal(result.state.history.patches.length, 1)
  assert.equal(result.state.phase, 'candidate')
  assert.equal(serverContainer(result.state).image, serverNew)
})

async function runScenarioWithState(initialState: Record<string, any>): Promise<RunResult> {
  const config = initialState.config as ScenarioConfig
  const root = await mkdtemp(join(tmpdir(), 'cumora-deployment-release-flow-state-'))
  const statePath = join(root, 'fake-kubectl-state.json')
  await writeFile(statePath, `${JSON.stringify(initialState, null, 2)}\n`, { mode: 0o600 })
  await chmod(fakeKubectl, 0o755)
  const smoke = await startSmokeServer(statePath, config)
  const runId = `flow-${process.pid}-${runCounter++}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KUBECTL: fakeKubectl,
    FAKE_KUBECTL_STATE: statePath,
    DEPLOYMENT: 'cumora-server',
    DEPLOYMENT_NAMESPACE: 'default',
    RECOVERY_SECRET: 'flow-baseline-secret',
    RECEIPT_SECRET: 'flow-receipt-secret',
    RECOVERY_WORKDIR: root,
    RUNNER_TEMP: root,
    GITHUB_WORKSPACE: repoRoot,
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: 'abcdef1234567890',
    CANDIDATE_SERVER_IMAGE: serverNew,
    CANDIDATE_AGENT_IMAGE: agentNew,
    INCLUDE_AGENT: 'Y',
    MIGRATION_JOB_NAME: `flow-migrate-${runId}`,
    VERIFIER_JOB_NAME: `flow-verifier-${runId}`,
    RECOVERY_POLL_MS: '1',
    MIGRATION_POLL_ATTEMPTS: '1',
    VERIFIER_POLL_ATTEMPTS: '1',
    ROLLOUT_TIMEOUT_SECONDS: '1',
    SMOKE_TIMEOUT_SECONDS: '5',
    CUMORA_SMOKE_TOKEN: 'dummy-flow-token',
    CUMORA_SMOKE_COMPANY_ID: companyId,
    CUMORA_SMOKE_BASE: smoke.base,
    CUMORA_SMOKE_REQUIRE_SHIPPING: String(config.shippingRequired ?? 'Y'),
  }
  if (config.recoveryMode !== undefined) env.RECOVERY_MODE = String(config.recoveryMode)
  else delete env.RECOVERY_MODE
  delete env.SMOKE_COMMAND
  let child: ReturnType<typeof spawn> | undefined
  try {
    const result = await new Promise<RunResult>((resolveResult) => {
      child = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-release.mjs', 'run'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => { stdout += chunk })
      child.stderr?.on('data', (chunk: string) => { stderr += chunk })
      const timer = setTimeout(() => child?.kill('SIGTERM'), 15_000)
      child.on('close', async (code, signal) => {
        clearTimeout(timer)
        const finalState = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
        resolveResult({ code, signal, stdout, stderr, state: finalState })
      })
    })
    return result
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    await new Promise<void>((resolveClose) => smoke.server.close(() => resolveClose()))
    await rm(root, { recursive: true, force: true })
  }
}
