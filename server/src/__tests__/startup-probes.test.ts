import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { load, loadAll } from 'js-yaml'
import { MigrationHistoryError } from '../db/migrations/manifest.js'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { verifySchemaWithBootRetry } = await import('../db/schema-version.js')
const { pool } = await import('../db/pool.js')
const execFile = promisify(execFileCallback)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readRepo = (path: string): Promise<string> => readFile(resolve(repoRoot, path), 'utf8')

interface Probe {
  httpGet?: { path?: string; port?: string | number }
  periodSeconds?: number
  timeoutSeconds?: number
  failureThreshold?: number
}

interface Container {
  name?: string
  startupProbe?: Probe
  livenessProbe?: Probe
  readinessProbe?: Probe
}

interface Deployment {
  kind?: string
  spec?: { template?: { spec?: { containers?: Container[] } } }
}

interface WorkflowStep {
  name?: string
  run?: string
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

interface ProbePatch {
  spec?: { template?: { spec?: { containers?: Container[] } } }
}

const manifestPaths = [
  'server/k8s/cumora-server.gke.yaml',
  'server/k8s/cumora-server.orbstack.yaml',
]

async function serverContainer(path: string): Promise<Container> {
  const docs = loadAll(await readRepo(path)) as unknown[]
  const deployment = docs
    .filter((doc): doc is Deployment => typeof doc === 'object' && doc !== null)
    .find((doc) => doc.kind === 'Deployment')
  const server = deployment?.spec?.template?.spec?.containers?.find((container) => container.name === 'server')
  assert.ok(server, `${path} must contain a server container in its Deployment`)
  return server
}

function assertProbe(
  probe: Probe | undefined,
  expectedPath: string,
  pathLabel: string,
  expectedPeriod: number,
  expectedTimeout: number,
): asserts probe is Probe {
  assert.ok(probe, `${pathLabel} probe is required`)
  assert.deepEqual(probe.httpGet, { path: expectedPath, port: 'http' }, `${pathLabel} endpoint`)
  assert.equal(probe.periodSeconds, expectedPeriod, `${pathLabel} period`)
  assert.equal(probe.timeoutSeconds, expectedTimeout, `${pathLabel} timeout`)
}

test('both server manifests keep startup, liveness, and readiness probes on the server container', async () => {
  for (const path of manifestPaths) {
    const server = await serverContainer(path)
    assertProbe(server.startupProbe, '/api/livez', `${path} startup`, 5, 2)
    assert.equal(server.startupProbe.failureThreshold, 60, `${path} startup failure threshold`)
    assertProbe(server.livenessProbe, '/api/livez', `${path} liveness`, 30, 3)
    assertProbe(server.readinessProbe, '/api/health', `${path} readiness`, 5, 2)
    assert.notEqual(server.livenessProbe.httpGet?.path, server.readinessProbe.httpGet?.path)
  }
})

test('the deploy patch reapplies the same probe contract and rollout deadline', async (t) => {
  const workflow = load(await readRepo('.github/workflows/deploy.yml')) as Workflow
  const patchStep = workflow.jobs?.deploy?.steps?.find((step) => step.name === 'Patch deployment')
  assert.ok(patchStep?.run, 'deploy must have a parsed Patch deployment step')
  const patch = patchStep.run
  assert.match(patch, /startupProbe:\s*\{\s*httpGet:\s*\{\s*path: "\/api\/livez",\s*port: "http"\s*\}/)
  assert.match(patch, /readinessProbe:\s*\{\s*httpGet:\s*\{\s*path: "\/api\/health",\s*port: "http"\s*\}/)
  assert.match(patch, /livenessProbe:\s*\{\s*httpGet:\s*\{\s*path: "\/api\/livez",\s*port: "http"\s*\}/)
  assert.match(patch, /periodSeconds: 5/)
  assert.match(patch, /timeoutSeconds: 2/)
  assert.match(patch, /failureThreshold: 60/)
  const rolloutStep = workflow.jobs?.deploy?.steps?.find((step) => step.name === 'Wait for rollout')
  assert.match(rolloutStep?.run ?? '', /kubectl rollout status deployment\/cumora-server --timeout=10m/)

  const filterOpen = patch.indexOf("'\n")
  const filterClose = patch.indexOf("\n')", filterOpen + 2)
  assert.ok(filterOpen >= 0 && filterClose > filterOpen, 'Patch deployment must contain a jq filter')
  const jqFilter = patch.slice(filterOpen + 2, filterClose)
  let jq: { stdout: string }
  try {
    jq = await execFile(
      'jq',
      ['-nc', '--arg', 'server', 'fixture-server', '--arg', 'agent', 'fixture-agent', jqFilter],
      { encoding: 'utf8' },
    ) as { stdout: string }
  } catch (error) {
    if (!process.env.CI && (error as { code?: unknown })?.code === 'ENOENT') {
      t.skip('jq is unavailable locally; CI must provide jq for this workflow patch test')
      return
    }
    throw error
  }
  const patchObject = JSON.parse(String(jq.stdout)) as ProbePatch
  const patchedServer = patchObject.spec?.template?.spec?.containers?.find((container) => container.name === 'server')
  assert.ok(patchedServer, 'evaluated deploy patch must target the server container')
  for (const path of manifestPaths) {
    const manifestServer = await serverContainer(path)
    assert.deepEqual(patchedServer.startupProbe, manifestServer.startupProbe, `${path} startup contract`)
    assert.deepEqual(patchedServer.readinessProbe, manifestServer.readinessProbe, `${path} readiness contract`)
    assert.deepEqual(patchedServer.livenessProbe, manifestServer.livenessProbe, `${path} liveness contract`)
  }
})

test('startup grace exceeds the schema retry and bounded connection budget', async () => {
  const delays: number[] = []
  let attempts = 0
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => {
        attempts++
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432')
      },
      sleep: async (ms) => { delays.push(ms) },
    }),
    /ECONNREFUSED/,
  )
  const retryDelayMs = delays.reduce((sum, delay) => sum + delay, 0)
  assert.equal(attempts, delays.length + 1)
  const connectionTimeoutMs = pool.options.connectionTimeoutMillis ?? 0
  assert.ok(connectionTimeoutMs > 0, 'pool connection timeout must be bounded')
  const boundedConnectionMs = attempts * connectionTimeoutMs
  for (const path of manifestPaths) {
    const server = await serverContainer(path)
    const startup = server.startupProbe
    assert.ok(startup)
    const startupBudgetMs = (startup.periodSeconds ?? 0) * (startup.failureThreshold ?? 0) * 1000
    assert.ok(
      startupBudgetMs > retryDelayMs + boundedConnectionMs,
      `${path} startup budget ${startupBudgetMs}ms must exceed ${retryDelayMs + boundedConnectionMs}ms`,
    )
  }
})

test('schema history errors remain fail-closed without transport retries', async () => {
  let calls = 0
  await assert.rejects(
    () => verifySchemaWithBootRetry({
      verifyFn: async () => {
        calls++
        throw new MigrationHistoryError('schema_behind', 'run migrations')
      },
      sleep: async () => {},
    }),
    /run migrations/,
  )
  assert.equal(calls, 1)
})
