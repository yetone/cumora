import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { loadAll } from 'js-yaml'
import { MigrationHistoryError } from '../db/migrations/manifest.js'
import {
  DEPLOYMENT_PROBE_CONTRACT,
  buildCandidatePatch,
  extractDeploymentSnapshot,
} from '../deploy/recovery.js'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { verifySchemaWithBootRetry } = await import('../db/schema-version.js')
const { pool } = await import('../db/pool.js')

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

const manifestPaths = [
  'server/k8s/cumora-server.gke.yaml',
  'server/k8s/cumora-server.orbstack.yaml',
]

const PROBE_FIXTURE_SERVER_IMAGE = `server@sha256:${'a'.repeat(64)}`
const PROBE_FIXTURE_AGENT_IMAGE = `agent@sha256:${'b'.repeat(64)}`

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

test('the recovery helper reapplies the same probe contract and workflow calls it', async () => {
  const workflowText = await readRepo('.github/workflows/deploy.yml')
  assert.match(workflowText, /scripts\/deploy-release\.mjs run/)
  assert.match(workflowText, /CANDIDATE_SERVER_IMAGE/)
  assert.match(workflowText, /ROLLOUT_TIMEOUT_SECONDS/)
  assert.match(workflowText, /VERIFIER_POLL_ATTEMPTS:\s*'75'/)
  assert.doesNotMatch(workflowText, /kubectl rollout undo/)

  const baseline = extractDeploymentSnapshot({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'cumora-server', uid: 'probe-fixture' },
    spec: {
      template: {
        metadata: { labels: { app: 'cumora-server' } },
        spec: {
          containers: [{
            name: 'server',
            image: PROBE_FIXTURE_SERVER_IMAGE,
            env: [{ name: 'CUMORA_AGENT_COMPUTER_IMAGE', value: PROBE_FIXTURE_AGENT_IMAGE }],
          }],
        },
      },
    },
  })
  const patch = buildCandidatePatch(baseline, {
    server: `server@sha256:${'c'.repeat(64)}`,
    agent: `agent@sha256:${'d'.repeat(64)}`,
  })
  const replacement = patch.find((operation) => {
    const candidate = operation as any
    return candidate?.op === 'replace' && candidate?.path === '/spec/template'
  }) as any
  assert.ok(replacement && typeof replacement.value === 'object' && replacement.value !== null)
  const patchedServer = (replacement.value as { spec: { containers: Container[] } }).spec.containers
    .find((container) => container.name === 'server')
  assert.ok(patchedServer, 'recovery helper patch must target the server container')
  for (const [name, expected] of Object.entries(DEPLOYMENT_PROBE_CONTRACT)) {
    assert.deepEqual(patchedServer[name as keyof Container], expected, `${name} helper contract`)
  }
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
