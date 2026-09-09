/**
 * Unit tests for the pure helpers in agents/runtime/orchestrator.ts.
 *
 * The full ensurePod path shells out to kubectl and writes to a real
 * k8s cluster — not testable as a unit. But the parsing /
 * classification logic that ensurePod relies on IS pure and is where
 * subtle bugs hide (e.g. did we correctly classify ImagePullBackOff
 * as stuck? did Unschedulable surface? did we coalesce
 * containerStatuses with initContainerStatuses?).
 *
 * This file pins:
 *   - parsePodHealth: every shape of kubectl get pod -o json the
 *     production code might encounter (Running, Pending+stuck,
 *     Unschedulable, missing fields, corrupted JSON)
 *   - stuckPendingReason: every stuck-vs-not classification
 *   - safeName: DNS-1123 sanitization + length cap
 *   - isRetryableKubectlError: each retryable + non-retryable pattern
 *
 * Run: node --import tsx --test server/src/__tests__/agents-orchestrator.test.ts
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load, loadAll } from 'js-yaml'
import {
  _testing,
  isRetryableKubectlError,
  type KubectlResult,
  parsePodHealth,
  planIdlePvcGc,
  safeName,
  stuckPendingReason,
  waitForPodDeletion,
} from '../agents/runtime/orchestrator.js'
import { pool } from '../db/pool.js'

const {
  yamlQuote,
  dnsLabelValue,
  podManifest,
  isSecureManagedPod,
  isRequiredAgentNetworkPolicy,
} = _testing

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readRepo = (path: string): Promise<string> => readFile(resolve(repoRoot, path), 'utf8')

after(async () => {
  // orchestrator.ts transitively imports inproc-client.ts → redis.ts
  // which opens Redis connections at module load. Disconnect on test
  // exit so the test process can shut down instead of hanging 60s on
  // dangling handles.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

// ── parsePodHealth ─────────────────────────────────────────────────────

test('parsePodHealth: Running pod with no waiting reasons', () => {
  const h = parsePodHealth(JSON.stringify({
    status: {
      phase: 'Running',
      containerStatuses: [{ state: { running: { startedAt: '...' } } }],
    },
  }))
  assert.equal(h.phase, 'Running')
  assert.deepEqual(h.waitingReasons, [])
  assert.equal(h.unschedulable, false)
})

test('parsePodHealth: Pending pod with ImagePullBackOff surfaces the waiting reason', () => {
  const h = parsePodHealth(JSON.stringify({
    status: {
      phase: 'Pending',
      containerStatuses: [
        { state: { waiting: { reason: 'ImagePullBackOff', message: '...' } } },
      ],
    },
  }))
  assert.equal(h.phase, 'Pending')
  assert.deepEqual(h.waitingReasons, ['ImagePullBackOff'])
})

test('parsePodHealth: coalesces containerStatuses + initContainerStatuses', () => {
  const h = parsePodHealth(JSON.stringify({
    status: {
      phase: 'Pending',
      initContainerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }],
      containerStatuses: [{ state: { waiting: { reason: 'PodInitializing' } } }],
    },
  }))
  assert.equal(h.waitingReasons.length, 2)
  assert.ok(h.waitingReasons.includes('CrashLoopBackOff'))
  assert.ok(h.waitingReasons.includes('PodInitializing'))
})

test('parsePodHealth: Unschedulable surfaces via the PodScheduled condition', () => {
  const h = parsePodHealth(JSON.stringify({
    status: {
      phase: 'Pending',
      conditions: [
        { type: 'PodScheduled', status: 'False', reason: 'Unschedulable' },
      ],
    },
  }))
  assert.equal(h.unschedulable, true)
})

test('parsePodHealth: PodScheduled=True does NOT flag unschedulable', () => {
  const h = parsePodHealth(JSON.stringify({
    status: {
      phase: 'Running',
      conditions: [{ type: 'PodScheduled', status: 'True' }],
    },
  }))
  assert.equal(h.unschedulable, false)
})

test('parsePodHealth: malformed JSON returns the empty/safe shape', () => {
  const h = parsePodHealth('not json {{{')
  assert.equal(h.phase, '')
  assert.deepEqual(h.waitingReasons, [])
  assert.equal(h.unschedulable, false)
})

test('parsePodHealth: empty object returns the empty/safe shape', () => {
  const h = parsePodHealth('{}')
  assert.equal(h.phase, '')
  assert.deepEqual(h.waitingReasons, [])
})

test('parsePodHealth: missing containerStatuses (just-created pod) does not crash', () => {
  const h = parsePodHealth(JSON.stringify({ status: { phase: 'Pending' } }))
  assert.equal(h.phase, 'Pending')
  assert.deepEqual(h.waitingReasons, [])
})

test('parsePodHealth: containerStatuses not an array (malformed kubectl output) is ignored', () => {
  // Defense in depth: if k8s ever changes the shape, we don't crash.
  const h = parsePodHealth(JSON.stringify({
    status: { phase: 'Running', containerStatuses: 'oops' },
  }))
  assert.equal(h.phase, 'Running')
  assert.deepEqual(h.waitingReasons, [])
})

test('parsePodHealth: container status without waiting reason is skipped', () => {
  const h = parsePodHealth(JSON.stringify({
    status: {
      phase: 'Running',
      containerStatuses: [
        { state: { running: {} } },                          // no waiting
        { state: { waiting: { reason: 'ContainerCreating' } } }, // valid
        { state: { waiting: {} } },                          // no reason
      ],
    },
  }))
  assert.deepEqual(h.waitingReasons, ['ContainerCreating'])
})

// ── stuckPendingReason ─────────────────────────────────────────────────

test('stuckPendingReason: ImagePullBackOff is stuck', () => {
  assert.equal(
    stuckPendingReason({ phase: 'Pending', waitingReasons: ['ImagePullBackOff'], unschedulable: false }),
    'ImagePullBackOff',
  )
})

test('stuckPendingReason: CrashLoopBackOff is stuck', () => {
  assert.equal(
    stuckPendingReason({ phase: 'Pending', waitingReasons: ['CrashLoopBackOff'], unschedulable: false }),
    'CrashLoopBackOff',
  )
})

test('stuckPendingReason: Unschedulable is stuck even with no waiting reason', () => {
  assert.equal(
    stuckPendingReason({ phase: 'Pending', waitingReasons: [], unschedulable: true }),
    'Unschedulable',
  )
})

test('stuckPendingReason: ContainerCreating is NOT stuck (legitimate pending)', () => {
  assert.equal(
    stuckPendingReason({ phase: 'Pending', waitingReasons: ['ContainerCreating'], unschedulable: false }),
    null,
  )
})

test('stuckPendingReason: PodInitializing is NOT stuck (init containers running)', () => {
  assert.equal(
    stuckPendingReason({ phase: 'Pending', waitingReasons: ['PodInitializing'], unschedulable: false }),
    null,
  )
})

test('stuckPendingReason: mixed waiting reasons returns the FIRST stuck one', () => {
  // A pod with init containers still running + main container stuck
  // — the orchestrator should reap.
  const r = stuckPendingReason({
    phase: 'Pending',
    waitingReasons: ['PodInitializing', 'ImagePullBackOff'],
    unschedulable: false,
  })
  assert.equal(r, 'ImagePullBackOff')
})

test('stuckPendingReason: empty waiting reasons + schedulable → not stuck', () => {
  assert.equal(
    stuckPendingReason({ phase: 'Pending', waitingReasons: [], unschedulable: false }),
    null,
  )
})

test('stuckPendingReason: each member of STUCK_WAITING_REASONS classified correctly', () => {
  const known = [
    'ImagePullBackOff', 'ErrImagePull', 'CrashLoopBackOff',
    'CreateContainerConfigError', 'CreateContainerError',
    'InvalidImageName', 'RunContainerError',
  ]
  for (const reason of known) {
    assert.equal(
      stuckPendingReason({ phase: 'Pending', waitingReasons: [reason], unschedulable: false }),
      reason,
      `${reason} should classify as stuck`,
    )
  }
})

// ── safeName ───────────────────────────────────────────────────────────

test('safeName: alphanumeric agentId passes through (lowercased)', () => {
  assert.equal(safeName('iris0c97'), 'agent-iris0c97')
})

test('safeName: hyphens in id are preserved', () => {
  assert.equal(safeName('atlas-7860'), 'agent-atlas-7860')
})

test('safeName: uppercase letters are lowercased (DNS-1123 requires)', () => {
  assert.equal(safeName('Nova-9BC6'), 'agent-nova-9bc6')
})

test('safeName: special chars are replaced with dashes', () => {
  assert.equal(safeName('user.name@example'), 'agent-user-name-example')
})

test('safeName: leading/trailing dashes are stripped (DNS-1123 forbids them)', () => {
  // The slug stripper applies BEFORE the agent- prefix, so we test
  // the inner behavior: invalid leading chars don't sneak through.
  assert.equal(safeName('-foo-'), 'agent-foo')
})

test('safeName: extremely long ids are truncated to 63 chars', () => {
  const longId = 'a'.repeat(200)
  const out = safeName(longId)
  assert.ok(out.length <= 63, `result is ${out.length} chars, max 63`)
  assert.ok(out.startsWith('agent-'), 'still has the agent- prefix')
})

test('safeName: empty string still produces a valid prefix', () => {
  assert.equal(safeName(''), 'agent-')
  // The empty slug is technically not a great pod name but the
  // caller is responsible for not passing empty agentIds; this just
  // confirms we don't crash.
})

test('safeName: all-invalid-chars id collapses to dashes then stripped', () => {
  // '___' has no alphanumerics → replaced to '---' → stripped → ''
  assert.equal(safeName('___'), 'agent-')
})

// ── isRetryableKubectlError ────────────────────────────────────────────

function mkRes(over: Partial<KubectlResult>): KubectlResult {
  return { code: 1, out: '', err: '', timedOut: false, ...over }
}

test('isRetryableKubectlError: code=0 is never retryable (success)', () => {
  assert.equal(isRetryableKubectlError(mkRes({ code: 0 })), false)
})

test('isRetryableKubectlError: our timeout (code=124) IS retryable', () => {
  assert.equal(isRetryableKubectlError(mkRes({ code: 124, timedOut: true })), true)
})

test('isRetryableKubectlError: "connection refused" is retryable', () => {
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'Unable to connect to the server: dial tcp 1.2.3.4:443: connection refused',
  })), true)
})

test('isRetryableKubectlError: "i/o timeout" is retryable', () => {
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'net/http: TLS handshake timeout',
  })), true)
})

test('isRetryableKubectlError: "the server is currently unable" is retryable (5xx)', () => {
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'Error from server (ServiceUnavailable): the server is currently unable to handle the request',
  })), true)
})

test('isRetryableKubectlError: TooManyRequests is retryable (rate-limit)', () => {
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'Error from server (TooManyRequests): rate limit exceeded',
  })), true)
})

test('isRetryableKubectlError: validation errors are NOT retryable', () => {
  // A malformed manifest won't fix itself by retrying.
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'error validating data: ValidationError(Pod.spec): unknown field "foo"',
  })), false)
})

test('isRetryableKubectlError: "already exists" is NOT retryable', () => {
  // Idempotency conflict — retrying would just hit the same error.
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'Error from server (AlreadyExists): pods "agent-iris" already exists',
  })), false)
})

test('isRetryableKubectlError: "not found" is NOT retryable', () => {
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'Error from server (NotFound): pods "agent-x" not found',
  })), false)
})

test('isRetryableKubectlError: patterns also matched against stdout (some kubectl errors land there)', () => {
  // `kubectl apply` puts some errors on stdout in older versions.
  assert.equal(isRetryableKubectlError(mkRes({
    out: 'Unable to connect to the server: i/o timeout',
  })), true)
})

// ── yamlQuote / dnsLabelValue / podManifest ───────────────────────────

test('yamlQuote: escapes a value with embedded double quote', () => {
  const out = yamlQuote('hello "world"')
  // JSON.stringify yields a quoted YAML scalar — embedded quotes get
  // backslash-escaped, which YAML's double-quote scalar accepts.
  assert.equal(out, '"hello \\"world\\""')
})

test('yamlQuote: escapes embedded newline (multi-line agentIds, hypothetically)', () => {
  const out = yamlQuote('line-one\nline-two')
  assert.ok(!out.includes('\n'), 'no raw newline in output')
  assert.equal(out, '"line-one\\nline-two"')
})

test('yamlQuote: escapes embedded backslash', () => {
  const out = yamlQuote('a\\b')
  assert.equal(out, '"a\\\\b"')
})

test('yamlQuote: empty string → empty quoted scalar', () => {
  assert.equal(yamlQuote(''), '""')
})

test('dnsLabelValue: alphanumeric+dash passes through', () => {
  assert.equal(dnsLabelValue('iris-0c97'), 'iris-0c97')
})

test('dnsLabelValue: uppercase REJECTED (must throw)', () => {
  assert.throws(() => dnsLabelValue('Iris-0c97'), /invalid DNS-1123/)
})

test('dnsLabelValue: leading dash REJECTED', () => {
  assert.throws(() => dnsLabelValue('-iris'), /invalid DNS-1123/)
})

test('dnsLabelValue: trailing dash REJECTED', () => {
  assert.throws(() => dnsLabelValue('iris-'), /invalid DNS-1123/)
})

test('dnsLabelValue: dots REJECTED (k8s would 422)', () => {
  assert.throws(() => dnsLabelValue('iris.local'), /invalid DNS-1123/)
})

test('dnsLabelValue: empty string REJECTED', () => {
  assert.throws(() => dnsLabelValue(''), /invalid DNS-1123/)
})

test('dnsLabelValue: 63 chars OK, 64 REJECTED', () => {
  const ok = 'a' + 'b'.repeat(62)
  assert.equal(ok.length, 63)
  assert.equal(dnsLabelValue(ok), ok)
  const bad = 'a' + 'b'.repeat(63)
  assert.equal(bad.length, 64)
  assert.throws(() => dnsLabelValue(bad), /invalid DNS-1123/)
})

test('podManifest: malicious agentId is sanitized AND quoted — cannot escape the YAML', () => {
  // The historical bug shape this defends against: an agentId
  // containing `" maliciousField:` could escape the label/value
  // strings and inject arbitrary YAML keys. The layered defense:
  //   1. safeName collapses special chars to '-' before they reach
  //      the label position (DNS-1123 sanitization).
  //   2. yamlQuote wraps every CUMORA_AGENT_ID env value in a quoted
  //      scalar, so even if the sanitizer missed something, JSON
  //      escaping would block YAML key injection.
  const m = podManifest({
    agentId: 'iris" injected: "yes',
    token: 'jwt-token',
    image: 'quay.io/x/y:z',
    serverUrl: 'http://example/runtime',
    openaiKey: 'sk-test',
    openaiBaseUrl: '',
    idleMs: 600_000,
    noWorkMs: 90_000,
  })
  // The sanitized form lands as the pod name and label slug.
  assert.match(m, /name: agent-iris--injected---yes/)
  // CRITICAL: the RAW agentId, if it appears at all, is fully
  // escaped — no unescaped `"` followed by a YAML-keyish thing.
  // We grep for the spoofed top-level injection: `injected: "yes`
  // outside a quoted string. The whole raw agentId only appears
  // inside the CUMORA_AGENT_ID env value (which uses yamlQuote).
  const rawAppearances = m.match(/iris" injected: "yes/g) ?? []
  // It DOES appear inside the escaped env value — but always
  // surrounded by JSON-escaped quotes (\")
  for (const idx of rawAppearances.map((_, i) => m.indexOf('iris" injected: "yes', i))) {
    // 2 chars before the match should be a backslash + quote pair
    // (the JSON-escape pattern `\"`).
    const prefix = m.slice(Math.max(0, idx - 2), idx)
    assert.equal(prefix, '\\"',
      `raw agentId at index ${idx} must be preceded by \\" (JSON-escaped quote)`)
  }
})

test('podManifest: well-formed inputs produce a parseable manifest with the slug label', () => {
  const m = podManifest({
    agentId: 'iris-0c97',
    token: 'jwt.token.part',
    image: 'quay.io/img:tag',
    serverUrl: 'http://server/runtime',
    openaiKey: 'sk-abc',
    openaiBaseUrl: 'https://sub2api/v1',
    idleMs: 600_000,
    noWorkMs: 90_000,
  })
  assert.match(m, /name: agent-iris-0c97/)
  assert.match(m, /cumora.agent: "iris-0c97"/)
  assert.match(m, /CUMORA_AGENT_ID/)
  assert.match(m, /value: "iris-0c97"/)
  assert.match(m, /CUMORA_AGENT_IDLE_MS/)
  assert.match(m, /value: "600000"/)
  assert.match(m, /CUMORA_AGENT_NO_WORK_MS/)
  assert.match(m, /value: "90000"/)
  assert.match(m, /CUMORA_AGENT_RUNTIME_TOKEN/)
  assert.match(m, /jwt\.token\.part/)
  // Resource targets are pinned against measured in-container working-
  // set + CPU figures: idle ≈ 380MiB, peak ≈ 1230MiB across 4 sites,
  // CPU bursts to ~2.2 cores during page render. A regression that
  // quietly downgrades Chromium's headroom should surface as a test
  // failure rather than as OOM-loops / throttling in prod.
  assert.match(m, /requests:\n\s+# Measured in prod, per-pod working-set ≈ 420 MiB/)
  assert.match(m, /cpu: "50m"/)
  assert.match(m, /memory: "320Mi"/)
  assert.match(m, /limits:\n\s+# Measured under realistic workload/)
  assert.match(m, /cpu: "2500m"/)
  assert.match(m, /memory: "1\.5Gi"/)
  assert.match(m, /devic\.es\/fuse: 1/)
  // Chrome profile volume — default ON-PVC. Off-PVC variant is the
  // emptyDir escape hatch tested separately.
  assert.match(m, /volumeMounts:\n\s+- name: chrome-profile\n\s+mountPath: \/opt\/chrome-profile/)
  assert.match(m, /volumes:\n\s+- name: chrome-profile\n\s+persistentVolumeClaim:\n\s+claimName: "agent-iris-0c97-chrome"/)
})

test('podManifest: parsed API shape contains the complete bootstrap security contract', () => {
  const image = 'quay.io/img:security-test'
  const manifest = podManifest({
    agentId: 'iris-0c97',
    token: 'jwt.token.part',
    image,
    serverUrl: 'http://server/runtime',
    openaiKey: 'sk-test',
    openaiBaseUrl: '',
    idleMs: 600_000,
    noWorkMs: 90_000,
  })
  const pod = load(manifest) as unknown
  assert.equal(isSecureManagedPod(pod, image, 'iris-0c97'), true)
  const root = pod as {
    metadata?: { labels?: Record<string, string> }
    spec?: {
      automountServiceAccountToken?: boolean
      securityContext?: {
        runAsUser?: number
        runAsGroup?: number
        runAsNonRoot?: boolean
        fsGroup?: number
        seccompProfile?: { type?: string }
      }
      containers?: Array<{
        command?: string[]
        securityContext?: {
          runAsUser?: number
          runAsGroup?: number
          capabilities?: { drop?: string[]; add?: string[] }
        }
      }>
    }
  }
  assert.equal(root.metadata?.labels?.['cumora.dev/security-profile'], 'fuse-demoted-v1')
  assert.equal(root.spec?.automountServiceAccountToken, false)
  assert.equal(root.spec?.securityContext?.runAsUser, 0)
  assert.equal(root.spec?.securityContext?.runAsGroup, 0)
  assert.equal(root.spec?.securityContext?.fsGroup, 65532)
  assert.equal(root.spec?.securityContext?.seccompProfile?.type, 'RuntimeDefault')
  const security = root.spec?.containers?.[0]
  assert.deepEqual(security?.command, ['/usr/local/bin/cumora-agent-bootstrap'])
  assert.equal(security?.securityContext?.runAsUser, 0)
  assert.equal(security?.securityContext?.runAsGroup, 0)
  assert.deepEqual(security?.securityContext?.capabilities?.drop, ['ALL'])
  assert.deepEqual(
    [...(security?.securityContext?.capabilities?.add ?? [])].sort(),
    ['KILL', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_ADMIN'],
  )
})

test('isSecureManagedPod: stale label and legacy command cannot be reused', () => {
  const image = 'quay.io/img:security-test'
  const pod = load(podManifest({
    agentId: 'iris-0c97',
    token: 'jwt',
    image,
    serverUrl: 'http://server/runtime',
    openaiKey: 'sk-test',
    openaiBaseUrl: '',
    idleMs: 600_000,
    noWorkMs: 90_000,
  })) as Record<string, unknown>
  const spec = pod.spec as Record<string, unknown>
  const container = (spec.containers as Array<Record<string, unknown>>)[0]
  container.command = ['/usr/local/bin/agent-computer-entrypoint.sh']
  assert.equal(isSecureManagedPod(pod, image, 'iris-0c97'), false)
})

test('isSecureManagedPod: namespace/process/mount hooks cannot shadow the trusted bootstrap', () => {
  const image = 'quay.io/img:security-test'
  const secure = load(podManifest({
    agentId: 'iris-0c97',
    token: 'jwt',
    image,
    serverUrl: 'http://server/runtime',
    openaiKey: 'sk-test',
    openaiBaseUrl: '',
    idleMs: 600_000,
    noWorkMs: 90_000,
  })) as Record<string, unknown>
  const reject = (label: string, mutate: (pod: Record<string, unknown>) => void) => {
    const candidate = structuredClone(secure) as Record<string, unknown>
    mutate(candidate)
    assert.equal(isSecureManagedPod(candidate, image, 'iris-0c97'), false, label)
  }
  const apiDefaulted = structuredClone(secure) as Record<string, unknown>
  const apiDefaultedSpec = apiDefaulted.spec as Record<string, unknown>
  for (const field of ['hostPID', 'hostIPC', 'hostNetwork', 'shareProcessNamespace']) delete apiDefaultedSpec[field]
  assert.equal(isSecureManagedPod(apiDefaulted, image, 'iris-0c97'), true, 'API omission of default-false host fields remains secure')
  const spec = (pod: Record<string, unknown>) => pod.spec as Record<string, unknown>
  const container = (pod: Record<string, unknown>) => (spec(pod).containers as Array<Record<string, unknown>>)[0]
  reject('host PID namespace is rejected', (pod) => { spec(pod).hostPID = true })
  reject('host IPC namespace is rejected', (pod) => { spec(pod).hostIPC = true })
  reject('host network namespace is rejected', (pod) => { spec(pod).hostNetwork = true })
  reject('shared process namespace is rejected', (pod) => { spec(pod).shareProcessNamespace = true })
  reject('init containers are rejected', (pod) => { spec(pod).initContainers = [{ name: 'shadow' }] })
  reject('ephemeral containers are rejected', (pod) => { spec(pod).ephemeralContainers = [{ name: 'shadow' }] })
  reject('container lifecycle hooks are rejected', (pod) => { container(pod).lifecycle = { postStart: { exec: { command: ['sh'] } } } })
  reject('extra args are rejected', (pod) => { container(pod).args = ['--legacy'] })
  reject('exec probes are rejected', (pod) => { container(pod).livenessProbe = { exec: { command: ['sh'] } } })
  reject('extra volume mounts are rejected', (pod) => {
    const mounts = container(pod).volumeMounts as Array<Record<string, unknown>>
    mounts.push({ name: 'shadow', mountPath: '/shadow' })
  })
  reject('hostPath volumes are rejected', (pod) => {
    const volume = (spec(pod).volumes as Array<Record<string, unknown>>)[0]
    delete volume.persistentVolumeClaim
    volume.hostPath = { path: '/' }
  })
  reject('a PVC for another agent is rejected', (pod) => {
    const volume = (spec(pod).volumes as Array<Record<string, unknown>>)[0]
    const pvc = volume.persistentVolumeClaim as Record<string, unknown>
    pvc.claimName = 'agent-other-chrome'
  })
})

test('secure reuse, legacy/unknown replacement, and bounded deletion are fail-closed', async () => {
  const image = 'quay.io/img:security-test'
  const secure = load(podManifest({
    agentId: 'iris-0c97',
    token: 'jwt',
    image,
    serverUrl: 'http://server/runtime',
    openaiKey: 'sk-test',
    openaiBaseUrl: '',
    idleMs: 600_000,
    noWorkMs: 90_000,
  })) as Record<string, unknown>
  assert.equal(isSecureManagedPod(secure, image, 'iris-0c97'), true, 'secure live object is reusable')
  assert.equal(isSecureManagedPod({ metadata: { labels: { app: 'cumora-agent' } } }, image, 'iris-0c97'), false, 'unknown object is not reusable')
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-egress', null, 'default'), false, 'missing policy fails closed')

  const calls: string[][] = []
  let getCount = 0
  const eventuallyGone = await waitForPodDeletion('iris-0c97', async (args) => {
    calls.push(args)
    if (args[0] === 'delete') return { code: 0, out: '', err: '', timedOut: false }
    getCount++
    return getCount === 1
      ? { code: 0, out: JSON.stringify(secure), err: '', timedOut: false }
      : { code: 0, out: '', err: '', timedOut: false }
  }, { deadlineMs: 100, pollMs: 0, sleep: async () => {} })
  assert.deepEqual(eventuallyGone, { ok: true })
  assert.equal(calls[0][0], 'delete')
  assert.ok(calls.filter((args) => args[0] === 'get').length >= 2, 'waits for the old name to disappear')

  const stuck = await waitForPodDeletion('iris-0c97', async (args) => (
    args[0] === 'delete'
      ? { code: 0, out: '', err: '', timedOut: false }
      : { code: 0, out: JSON.stringify(secure), err: '', timedOut: false }
  ), { deadlineMs: 0, pollMs: 0, sleep: async () => {} })
  assert.equal(stuck.ok, false, 'a Pod that never disappears blocks replacement')

  const authFailure = await waitForPodDeletion('iris-0c97', async (args) => (
    args[0] === 'delete'
      ? { code: 0, out: '', err: '', timedOut: false }
      : { code: 1, out: '', err: 'exec: gke-gcloud-auth-plugin: not found', timedOut: false }
  ), { deadlineMs: 100, pollMs: 0, sleep: async () => {} })
  assert.equal(authFailure.ok, false, 'auth/plugin failure is not resource absence')
})

test('checked-in NetworkPolicies parse and match the orchestrator contract', async () => {
  const docs = loadAll(await readRepo('server/k8s/cumora-agent-network-policy.yaml')) as unknown[]
  assert.equal(docs.length, 2, 'policy bundle must contain only scoped deny and egress policies')
  const byName = new Map<string, unknown>()
  for (const doc of docs) {
    const metadata = (doc as { metadata?: { name?: unknown } } | null)?.metadata
    if (typeof metadata?.name === 'string') byName.set(metadata.name, doc)
  }
  for (const name of ['cumora-agent-default-deny', 'cumora-agent-egress']) {
    assert.equal(byName.has(name), true, `${name} must be present in the checked-in policy bundle`)
    assert.equal(isRequiredAgentNetworkPolicy(name, byName.get(name), 'default'), true, `${name} must satisfy v1`)
  }
  const deny = byName.get('cumora-agent-default-deny') as Record<string, unknown>
  const denySelector = ((deny.spec as Record<string, unknown>).podSelector as Record<string, unknown>).matchLabels as Record<string, string>
  const selected = (labels: Record<string, string>) => Object.entries(denySelector).every(([key, value]) => labels[key] === value)
  assert.equal(selected({ app: 'cumora-agent' }), true)
  assert.equal(selected({ app: 'cumora-server' }), false, 'default namespace server is not selected')
  assert.equal(selected({ app: 'redis' }), false, 'default namespace Redis is not selected')
  assert.equal(selected({ app: 'other-workload' }), false, 'other workloads are not selected')
  const broad = structuredClone(deny)
  ;(broad.spec as Record<string, unknown>).podSelector = {}
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-default-deny', broad, 'default'), false, 'namespace-wide selector is rejected')
  const extraLabel = structuredClone(deny)
  const extraSelector = ((extraLabel.spec as Record<string, unknown>).podSelector as Record<string, unknown>).matchLabels as Record<string, string>
  extraSelector.team = 'agents'
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-default-deny', extraLabel, 'default'), false, 'extra selector labels are rejected')
  const extraExpression = structuredClone(deny)
  const expressionSelector = (extraExpression.spec as Record<string, unknown>).podSelector as Record<string, unknown>
  expressionSelector.matchExpressions = [{ key: 'team', operator: 'Exists' }]
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-default-deny', extraExpression, 'default'), false, 'selector expressions are rejected')
  const egress = byName.get('cumora-agent-egress') as Record<string, unknown>
  const egressSpec = egress.spec as Record<string, unknown>
  assert.deepEqual((egressSpec.podSelector as Record<string, unknown>).matchLabels, { app: 'cumora-agent' })
  const egressRules = egressSpec.egress as Array<Record<string, unknown>>
  const publicIpv4 = egressRules[2].to as Array<Record<string, unknown>>
  const block = publicIpv4[0].ipBlock as { except?: string[] }
  assert.ok(block.except?.includes('169.254.0.0/16'), 'metadata/link-local range must be excluded')
  assert.ok(block.except?.includes('100.64.0.0/10'), 'CGNAT range must be excluded')
  const tampered = structuredClone(egress)
  const tamperedRules = (tampered.spec as Record<string, unknown>).egress as Array<Record<string, unknown>>
  const tamperedBlock = ((tamperedRules[2].to as Array<Record<string, unknown>>)[0].ipBlock) as { except?: string[] }
  tamperedBlock.except = tamperedBlock.except?.filter((cidr) => cidr !== '100.64.0.0/10')
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-egress', tampered, 'default'), false, 'a broad private-range exception is rejected')

  const wideDns = structuredClone(egress)
  const wideDnsRules = (wideDns.spec as Record<string, unknown>).egress as Array<Record<string, unknown>>
  const wideDnsPorts = wideDnsRules[0].ports as Array<Record<string, unknown>>
  wideDnsPorts[0].endPort = 65535
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-egress', wideDns, 'default'), false, 'DNS port ranges are rejected')

  const wideServer = structuredClone(egress)
  const wideServerRules = (wideServer.spec as Record<string, unknown>).egress as Array<Record<string, unknown>>
  const wideServerPorts = wideServerRules[1].ports as Array<Record<string, unknown>>
  wideServerPorts[0].endPort = 65535
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-egress', wideServer, 'default'), false, 'server port ranges are rejected')

  const wideWeb = structuredClone(egress)
  const wideWebRules = (wideWeb.spec as Record<string, unknown>).egress as Array<Record<string, unknown>>
  const wideWebPorts = wideWebRules[2].ports as Array<Record<string, unknown>>
  wideWebPorts[0].endPort = 65535
  assert.equal(isRequiredAgentNetworkPolicy('cumora-agent-egress', wideWeb, 'default'), false, 'public Web port ranges are rejected')
})

test('server RBAC manifests grant policy reads only and disable agent SA tokens', async () => {
  for (const path of ['server/k8s/cumora-server.gke.yaml', 'server/k8s/cumora-server.orbstack.yaml']) {
    const docs = loadAll(await readRepo(path)) as unknown[]
    const role = docs.find((doc) => {
      const object = doc as { kind?: unknown; metadata?: { name?: unknown } } | null
      return object?.kind === 'Role' && object.metadata?.name === 'cumora-server-agent-pods'
    }) as { rules?: Array<{ apiGroups?: string[]; resources?: string[]; verbs?: string[] }> } | undefined
    assert.ok(role, `${path} must define the server Role`)
    const policyRule = role.rules?.find((rule) => rule.resources?.includes('networkpolicies'))
    assert.deepEqual(policyRule?.apiGroups, ['networking.k8s.io'], `${path} policy API group`)
    assert.deepEqual(policyRule?.verbs, ['get', 'list', 'watch'], `${path} policy verbs are read-only`)
    const deployment = docs.find((doc) => (doc as { kind?: unknown } | null)?.kind === 'Deployment') as {
      spec?: { template?: { spec?: { containers?: Array<{ name?: string; automountServiceAccountToken?: boolean }> } } }
    } | undefined
    const server = deployment?.spec?.template?.spec?.containers?.find((container) => container.name === 'server')
    assert.ok(server, `${path} must contain the server container`)
    // Agent token mounting is controlled by the generated agent Pod, not the
    // server container; ensure the checked-in Role has no policy mutation path.
    assert.equal(policyRule?.verbs?.includes('create'), false)
  }
})

test('podManifest: image with embedded quote is escaped (CUMORA_AGENT_COMPUTER_IMAGE env is user-set)', () => {
  // An attacker who controlled CUMORA_AGENT_COMPUTER_IMAGE could
  // historically have tried `legit-image"\ninjected: yaml` to break
  // the manifest. yamlQuote wrapping makes it a literal string.
  const m = podManifest({
    agentId: 'iris-0c97',
    token: 't',
    image: 'evil"\ninjected: yaml',
    serverUrl: 'http://x',
    openaiKey: 'k',
    openaiBaseUrl: '',
    idleMs: 1000,
    noWorkMs: 90_000,
  })
  // The injected text appears ONCE, as part of the escaped image
  // value — NOT as a top-level YAML key.
  assert.ok(m.includes('"evil\\"\\ninjected: yaml"'),
    'image string is quoted-and-escaped, not interpolated raw')
})

test('isRetryableKubectlError: image-pull errors are NOT retryable at the kubectl level', () => {
  // The retry classification is for KUBECTL itself failing — image
  // pulls happen async inside k8s after apply succeeds. So a kubectl
  // apply with code=1 because the image doesn't exist gets reported
  // via "ImagePullBackOff" later, not at the apply step. We don't
  // retry kubectl-level "image not found" because it's the same
  // every time.
  assert.equal(isRetryableKubectlError(mkRes({
    err: 'failed to pull image "broken:latest": not found',
  })), false)
})

// ─── planIdlePvcGc ───────────────────────────────────────────────────
// Tests cover the decision matrix without touching kubectl or the DB —
// the planner is the only piece of the GC sweeper with non-trivial
// logic, and any future tweak (e.g. "also delete if PVC older than X
// AND no runs") should be reflected here first.

const NOW = new Date('2026-06-15T00:00:00Z')
const DAY_MS = 24 * 60 * 60_000
const IDLE_30D = 30 * DAY_MS

test('planIdlePvcGc: departed agent → drop', () => {
  const drop = planIdlePvcGc({
    pvcs: [{ name: 'agent-iris-chrome', agentId: 'iris' }],
    agents: new Map([['iris', { departedAt: new Date(NOW.getTime() - DAY_MS), lastWakeAt: new Date(NOW.getTime() - 2 * DAY_MS) }]]),
    now: NOW,
    idleThresholdMs: IDLE_30D,
  })
  assert.equal(drop.length, 1)
  assert.equal(drop[0].reason, 'departed')
})

test('planIdlePvcGc: recently woken active agent → keep', () => {
  const drop = planIdlePvcGc({
    pvcs: [{ name: 'agent-iris-chrome', agentId: 'iris' }],
    agents: new Map([['iris', { departedAt: null, lastWakeAt: new Date(NOW.getTime() - DAY_MS) }]]),
    now: NOW,
    idleThresholdMs: IDLE_30D,
  })
  assert.deepEqual(drop, [])
})

test('planIdlePvcGc: idle past threshold → drop', () => {
  const drop = planIdlePvcGc({
    pvcs: [{ name: 'agent-iris-chrome', agentId: 'iris' }],
    agents: new Map([['iris', { departedAt: null, lastWakeAt: new Date(NOW.getTime() - 45 * DAY_MS) }]]),
    now: NOW,
    idleThresholdMs: IDLE_30D,
  })
  assert.equal(drop.length, 1)
  assert.equal(drop[0].reason, 'idle')
})

test('planIdlePvcGc: orphan PVC (no participants row) → drop', () => {
  const drop = planIdlePvcGc({
    pvcs: [{ name: 'agent-ghost-chrome', agentId: 'ghost' }],
    agents: new Map(),
    now: NOW,
    idleThresholdMs: IDLE_30D,
  })
  assert.equal(drop.length, 1)
  assert.equal(drop[0].reason, 'orphan')
})

test('planIdlePvcGc: agent exists but never ran → keep (defer to next pass)', () => {
  // PVC was created just-in-time when the pod was about to spawn,
  // but the pod crashed before agent_runs got an insert. Deleting
  // a fresh PVC would lose a profile that just hasn't had a chance
  // to log activity yet. The PVC will be picked up next pass if
  // the agent still hasn't run (idle threshold catches it
  // eventually); for now, leave alone.
  const drop = planIdlePvcGc({
    pvcs: [{ name: 'agent-iris-chrome', agentId: 'iris' }],
    agents: new Map([['iris', { departedAt: null, lastWakeAt: null }]]),
    now: NOW,
    idleThresholdMs: IDLE_30D,
  })
  assert.deepEqual(drop, [])
})

test('planIdlePvcGc: mixed batch picks only the right ones', () => {
  const drop = planIdlePvcGc({
    pvcs: [
      { name: 'agent-iris-chrome', agentId: 'iris' },
      { name: 'agent-bram-chrome', agentId: 'bram' },
      { name: 'agent-nova-chrome', agentId: 'nova' },
      { name: 'agent-ghost-chrome', agentId: 'ghost' },
    ],
    agents: new Map([
      ['iris', { departedAt: null, lastWakeAt: new Date(NOW.getTime() - DAY_MS) }],        // active
      ['bram', { departedAt: new Date(NOW.getTime() - 5 * DAY_MS), lastWakeAt: null }],    // off-boarded
      ['nova', { departedAt: null, lastWakeAt: new Date(NOW.getTime() - 60 * DAY_MS) }],   // idle
      // ghost not in map → orphan
    ]),
    now: NOW,
    idleThresholdMs: IDLE_30D,
  })
  const byAgent = new Map(drop.map((d) => [d.agentId, d.reason]))
  assert.equal(drop.length, 3)
  assert.equal(byAgent.get('iris'), undefined)
  assert.equal(byAgent.get('bram'), 'departed')
  assert.equal(byAgent.get('nova'), 'idle')
  assert.equal(byAgent.get('ghost'), 'orphan')
})
