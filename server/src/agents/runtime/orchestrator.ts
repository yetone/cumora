/**
 * Agent-computer lifecycle — the server-side controller for per-agent
 * Pods.
 *
 * Each agent gets one Pod, spawned on demand when a wake arrives and
 * the previous Pod has timed-out-and-exited (status `resting`). The
 * Pod's `/workspace` is a FUSE mount of the agent's slice of
 * `agent_workspace` (`cumora-fuse` Go binary, baked into the image);
 * Postgres row-level security on a per-agent role pins what the Pod
 * can see/write.
 *
 * The Pod also bundles a headless-but-headed Chromium under Xvfb so
 * agents can drive a real browser via OpenCLI (`opencli browser ...`).
 * Chromium's --user-data-dir lives on a per-agent PVC at
 * /opt/chrome-profile so cookies / login state survive pod restarts —
 * that's the only persistent volume in the system. Everything else is
 * still DB-backed.
 *
 * We shell out to `kubectl` rather than depending on the K8s JS
 * client — one fewer dep, kubectl handles context / auth / SA tokens
 * correctly whether the server itself runs in-cluster or on a dev
 * laptop.
 */
import { spawn } from 'node:child_process'
import { env } from '../../env.js'
import { pool } from '../../db/pool.js'
import { sub2apiConfigured, sub2apiOpenAIBaseURL } from '../../sub2api.js'
import { inprocClient } from './inproc-client.js'
import { signAgentToken } from './jwt.js'
import { notifyAlert } from '../../alerting.js'
import { Semaphore } from '../../concurrency.js'
import {
  managedPodPlacement,
  resolveAgentHost,
  type AgentHostResolution,
} from '../computer/registry.js'

const KUBECTL = process.env.CUMORA_KUBECTL ?? 'kubectl'
/** kubectl context to target. In dev we pin to OrbStack so a stray
 *  `kubectl config use-context gke-...` on the dev laptop can't cause
 *  the dev server to spawn agent Pods in a real cluster. In production
 *  we leave it unset and let kubectl resolve the current context
 *  (typically the in-cluster SA when the server runs in K8s). Override
 *  the dev default with CUMORA_KUBECTL_CONTEXT (e.g. if your local
 *  context is named differently). */
const KUBECTL_CONTEXT = process.env.CUMORA_KUBECTL_CONTEXT
  ?? (env.NODE_ENV === 'production' ? '' : 'orbstack')
const IMAGE = process.env.CUMORA_AGENT_COMPUTER_IMAGE
  ?? 'quay.io/yetoneful/cumora-agent-computer:dev'
/** TTL of the JWT minted at Pod-spawn time. Pods live up to
 *  CUMORA_AGENT_IDLE_MS without restart, so the JWT lives longer than
 *  the idle ceiling to avoid mid-life expiry. */
const TOKEN_TTL_SECONDS = Number(process.env.CUMORA_AGENT_TOKEN_TTL_SECONDS ?? 24 * 60 * 60)
/** K8s namespace pods land in. Default = current context's namespace. */
const NS = process.env.CUMORA_AGENT_NAMESPACE ?? 'default'
/** Comma-separated list of imagePullSecrets to attach to the agent
 *  Pod. Needed when the image lives in a private registry (e.g.
 *  quay.io with auth, gcr.io / Artifact Registry without Workload
 *  Identity). Empty = no pull secrets, fine for public registries or
 *  OrbStack-local builds. */
const PULL_SECRETS = (process.env.CUMORA_AGENT_PULL_SECRETS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean)
/** Optional ServiceAccount the agent Pod runs as. Useful for GKE
 *  Workload Identity (binding to a GCP service account) when the
 *  agent's bash tool ends up calling GCP APIs. Empty = use the
 *  namespace's `default` SA. */
const POD_SERVICE_ACCOUNT = process.env.CUMORA_AGENT_SERVICE_ACCOUNT ?? ''

export interface KubectlResult { code: number; out: string; err: string; timedOut: boolean }

/** Default per-call timeout for kubectl shell-outs. Without this any
 *  hang in the K8s API server (network blip, throttling, slow auth
 *  refresh) leaves the orchestrator's inFlight map with a zombie
 *  promise — every subsequent caller queues behind it until process
 *  restart. 30s is comfortably above normal kubectl latencies
 *  (~50-500ms) while still bounding the worst case. */
const KUBECTL_DEFAULT_TIMEOUT_MS = 30_000
/** Grace period between SIGTERM and SIGKILL when killing a hung
 *  kubectl. kubectl rarely needs cleanup, but a small grace prevents
 *  EBUSY-on-pipe-close glitches. */
const KUBECTL_KILL_GRACE_MS = 1_000

interface KubectlOpts {
  /** Override the default per-call timeout. Apply usually wants more
   *  because image-pull validation can be slow; gets stay at default. */
  timeoutMs?: number
  /** stdin to pipe to kubectl (used by `kubectl apply -f -`). */
  stdin?: string
}

/** Caps concurrent `kubectl` child processes per replica
 *  (env.KUBECTL_MAX_CONCURRENCY). Each kubectl is a ~50–100MB Go binary
 *  charged to this pod's cgroup; an unbounded burst (one+ per wake under
 *  a storm) can OOM-kill or CPU-throttle the server pod and defeat the
 *  pod-admission cap via a check-before-spawn race. Every caller —
 *  ensurePod, podHealth, the reaper, the fuse-util probe — funnels
 *  through here, so the cap is global. */
const kubectlSem = new Semaphore(env.KUBECTL_MAX_CONCURRENCY)

function kubectl(args: string[], opts: KubectlOpts = {}): Promise<KubectlResult> {
  // Hold a permit for the FULL lifetime of the child (incl. timeout) so
  // the in-flight process count — not just the spawn rate — is bounded.
  return kubectlSem.run(() => kubectlSpawn(args, opts))
}

function kubectlSpawn(args: string[], opts: KubectlOpts = {}): Promise<KubectlResult> {
  const timeoutMs = opts.timeoutMs ?? KUBECTL_DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    const ctxArgs = KUBECTL_CONTEXT === '' ? [] : ['--context', KUBECTL_CONTEXT]
    const child = spawn(KUBECTL, [...ctxArgs, '-n', NS, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    const finish = (r: KubectlResult): void => {
      if (settled) return
      settled = true
      if (killTimer) { clearTimeout(killTimer); killTimer = null }
      if (timer) { clearTimeout(timer); }
      resolve(r)
    }
    const timer = setTimeout(() => {
      if (settled) return
      // Try graceful first, then force.
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, KUBECTL_KILL_GRACE_MS)
      // Resolve immediately rather than waiting for exit — the caller
      // is treating this as "kubectl is unresponsive", and the child's
      // exit event will fire later (we ignore it via `settled`).
      finish({
        code: 124, // curl/timeout(1) convention for "timed out"
        out,
        err: err + `\n[kubectl] killed after ${timeoutMs}ms timeout`,
        timedOut: true,
      })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e) => finish({
      code: 1, out, err: err + (e.message ?? String(e)), timedOut: false,
    }))
    child.on('exit', (code) => finish({
      code: code ?? 1, out, err, timedOut: false,
    }))
    try {
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
      else child.stdin.end()
    } catch (e) {
      // EPIPE if the child died before we wrote stdin — covered by
      // the error/exit handlers above.
      void e
    }
  })
}

/** Patterns in kubectl's stderr that signal a TRANSIENT failure
 *  (network, throttling, leader-election churn). Retrying these is
 *  worth a shot. We explicitly DO NOT retry validation errors,
 *  missing image errors, or "already exists" — those won't fix
 *  themselves. */
const RETRYABLE_ERROR_PATTERNS: readonly RegExp[] = [
  /connection refused/i,
  /i\/o timeout/i,
  /context deadline exceeded/i,
  /TLS handshake timeout/i,
  /the server is currently unable to handle the request/i,
  /TooManyRequests/i,
  /etcdserver: leader changed/i,
  /etcdserver: request timed out/i,
  /unexpected EOF/i,
]

/** Exported for testability — production callers use kubectlWithRetry. */
export function isRetryableKubectlError(r: KubectlResult): boolean {
  if (r.code === 0) return false
  if (r.timedOut) return true
  const haystack = `${r.err}\n${r.out}`
  return RETRYABLE_ERROR_PATTERNS.some((re) => re.test(haystack))
}

/** Run a kubectl call with up to N attempts, exponential backoff. The
 *  first attempt fires immediately; retries are gated to errors we've
 *  classified as transient (see RETRYABLE_ERROR_PATTERNS). Returns the
 *  LAST result either way — the caller checks `code` and decides. */
async function kubectlWithRetry(
  args: string[],
  opts: KubectlOpts & { maxAttempts?: number; backoffMs?: number } = {},
): Promise<KubectlResult> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseBackoff = opts.backoffMs ?? 250
  let last: KubectlResult | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await kubectl(args, opts)
    if (last.code === 0) return last
    if (attempt === maxAttempts) break
    if (!isRetryableKubectlError(last)) break
    // Exponential backoff with full jitter — avoid thundering-herd on
    // a busy API server when N orchestrators all retry at once.
    const max = baseBackoff * 2 ** (attempt - 1)
    const sleep = Math.floor(Math.random() * max)
    await new Promise((r) => setTimeout(r, sleep))
  }
  return last!
}

/** DNS-1123 label safe-name for k8s metadata.name. Exported for
 *  tests — production callers should go through `podName`. */
export function safeName(agentId: string): string {
  // DNS-1123 label: lowercase, alphanumeric + dash, ≤63 chars.
  const slug = agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return `agent-${slug}`.slice(0, 63)
}

function podName(agentId: string): string { return safeName(agentId) }

/** Name of the per-agent PVC holding Chromium's profile directory.
 *  One PVC per agent; outlives the pod so cookies / login state
 *  persist across restarts. Same DNS-1123 constraints as podName. */
function chromeProfilePvcName(agentId: string): string {
  return `${safeName(agentId)}-chrome`.slice(0, 63)
}

/** Storage size for the chrome-profile PVC. Default is 500Mi which
 *  fits typical Chromium profile state (cookies + IndexedDB + cache)
 *  with comfortable headroom. Set CUMORA_CHROME_PVC_SIZE to override
 *  (use Kubernetes resource-quantity syntax: 1Gi, 200Mi, etc.). */
const CHROME_PVC_SIZE = process.env.CUMORA_CHROME_PVC_SIZE ?? '500Mi'
/** StorageClass for the chrome-profile PVC. Empty = cluster default,
 *  which is usually what you want. Override with
 *  CUMORA_CHROME_PVC_STORAGECLASS only when you need a specific class
 *  (e.g. a fast SSD pool or a zone-pinned class). */
const CHROME_PVC_STORAGECLASS = process.env.CUMORA_CHROME_PVC_STORAGECLASS ?? ''
/** When set to "false", the chrome-profile volume is an emptyDir
 *  (ephemeral, dies with the pod) instead of a PVC. Escape hatch for
 *  clusters that don't have a default StorageClass yet — agents start
 *  cleanly, they just lose Chromium's login state across restarts.
 *  Default ON so login persistence is the production behavior. */
const CHROME_PROFILE_ON_PVC = process.env.CUMORA_CHROME_PROFILE_PVC !== 'false'

/** Render the Pod manifest. restartPolicy=OnFailure so a crashed
 *  container restarts in-place, but a clean exit (idle timeout —
 *  exit 0) terminates the Pod for good. The FUSE mount of /workspace
 *  is done by the container's entrypoint, before the agent loop
 *  starts. */
/** JSON.stringify produces a double-quoted YAML-safe scalar. We use
 *  this for every interpolated value that flows into a YAML quoted
 *  string position so embedded quotes / backslashes / newlines / non-
 *  ASCII can't break the manifest shape. agentIds in practice are
 *  alphanumeric, but other fields (image, serverUrl) are
 *  user-configurable via env — defense in depth. */
function yamlQuote(value: string): string {
  return JSON.stringify(value)
}

/** Validate that a value contains only DNS-1123 label characters
 *  (lowercase alphanumeric + dashes). k8s rejects labels with
 *  uppercase, dots, etc. — we sanitize the agentId via safeName() for
 *  metadata.name but the cumora.agent LABEL value (used by selectors)
 *  has the same constraint. Throws on invalid input so the caller can
 *  surface a precise error rather than letting kubectl reject the
 *  apply with a less obvious message. */
function dnsLabelValue(value: string): string {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`invalid DNS-1123 label value: ${JSON.stringify(value)}`)
  }
  return value
}

function podManifest(args: {
  agentId: string
  token: string
  image: string
  serverUrl: string
  openaiKey: string
  /** Optional override for the OpenAI base URL. When set, the agent
   *  pod's OpenAI SDK calls go to this base instead of api.openai.com.
   *  Used to route per-agent LLM traffic through sub2api. The pod's
   *  pre-baked OpenAI SDK reads OPENAI_BASE_URL automatically. */
  openaiBaseUrl: string
  idleMs: number
  noWorkMs: number
}): string {
  const indent = (s: string): string => s.split('\n').map((l) => `              ${l}`).join('\n')
  const pullSecretsBlock = PULL_SECRETS.length === 0 ? '' : `
  imagePullSecrets:
${PULL_SECRETS.map((s) => `  - name: ${yamlQuote(s)}`).join('\n')}`
  const saBlock = POD_SERVICE_ACCOUNT === '' ? '' : `
  serviceAccountName: ${yamlQuote(POD_SERVICE_ACCOUNT)}`
  // metadata.name already went through safeName() (DNS-1123). The
  // LABEL value cumora.agent also needs DNS-1123 — selectors that
  // grep the cluster (`kubectl get pods -l cumora.agent=...`) rely
  // on this matching the name slug. Run agentId through the same
  // sanitization so the two stay in sync.
  const podSlug = safeName(args.agentId).replace(/^agent-/, '')
  const labelValue = dnsLabelValue(podSlug || 'unknown')
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName(args.agentId)}
  labels:
    app: cumora-agent
    cumora.agent: ${yamlQuote(labelValue)}
spec:
  restartPolicy: OnFailure${saBlock}${pullSecretsBlock}
  containers:
  - name: agent-computer
    image: ${yamlQuote(args.image)}
    imagePullPolicy: IfNotPresent
    securityContext:
      # FUSE mount needs three things to work on GKE-COS:
      #   1. CAP_SYS_ADMIN — for the mount(2) syscall.
      #   2. /dev/fuse in the cgroup device whitelist — granted by the
      #      generic-device-plugin DaemonSet (squat/generic-device-
      #      plugin) which we depend on being installed in the cluster
      #      (see server/k8s/generic-device-plugin.note).
      #   3. AppArmor unconfined — the default cri-containerd profile
      #      denies the mount syscall even with CAP_SYS_ADMIN, so the
      #      pod must opt out. Without this the agent boots but
      #      fusermount3 fails with "Permission denied" and /workspace
      #      falls through to the empty backing dir — the agent loses
      #      access to its persona files / memory FS.
      appArmorProfile:
        type: Unconfined
      capabilities:
        add: ["SYS_ADMIN"]
    resources:
      requests:
        # Measured in prod, per-pod working-set ≈ 420 MiB, but only
        # ~263 MiB is anon (irreducible) — the other ~137 MiB is
        # file-backed page cache that the kernel can evict under
        # memory pressure. Setting memory request to 320 MiB covers
        # the irreducible portion with comfortable buffer; under load
        # the limit (1.5 GiB) absorbs bursts. CPU between wakes is
        # <1% — 50m is a generous reservation for a process that
        # spends most of its life as an idle SSE listener; bursts to
        # 2 cores during page render are bounded by the limit (2500m),
        # not the request. Density per e2-standard-2 (1180m CPU / ~6
        # GiB usable after kubelet reserve): ~18 pods CPU-wise, ~18
        # pods memory-wise — balanced, no single-resource binding.
        cpu: "50m"
        memory: "320Mi"
        devic.es/fuse: 1
      limits:
        # Measured under realistic workload (4 sites opened + extracted
        # + an adapter call): memory peaked at ~1230MiB; CPU spiked to
        # 2.2 cores during page rendering. 1.5Gi memory limit leaves
        # ~250Mi headroom over peak; 2500m CPU avoids throttling
        # Chromium during JS-heavy page loads.
        cpu: "2500m"
        memory: "1.5Gi"
        # Reserves one /dev/fuse slot from the device plugin; the
        # kubelet inserts the device into the container's cgroup.
        # Resource name comes from squat/generic-device-plugin's
        # default config — it uses the 'devic.es' domain.
        devic.es/fuse: 1
    volumeMounts:
    - name: chrome-profile
      mountPath: /opt/chrome-profile
    env:
    - name: CUMORA_AGENT_ID
      value: ${yamlQuote(args.agentId)}
    - name: CUMORA_AGENT_RUNTIME_URL
      value: ${yamlQuote(args.serverUrl)}
    - name: CUMORA_AGENT_IDLE_MS
      value: ${yamlQuote(String(args.idleMs))}
    - name: CUMORA_AGENT_NO_WORK_MS
      value: ${yamlQuote(String(args.noWorkMs))}
    - name: CUMORA_PERSONA_DIR
      value: "/workspace"
    - name: CUMORA_AGENT_RUNTIME_TOKEN
      value: |-
${indent(args.token)}
    - name: OPENAI_API_KEY
      value: |-
${indent(args.openaiKey)}
    - name: OPENAI_BASE_URL
      value: |-
${indent(args.openaiBaseUrl)}
  # Spot/Preemptible toleration: GKE Spot VM nodes are tainted
  # cloud.google.com/gke-spot=true:NoSchedule by default so cluster-
  # critical pods don't accidentally land on them. Agent pods are
  # ideal Spot workloads — their state lives in DB (FUSE-mounted)
  # and the chrome-profile is emptyDir/PVC, so a 30s preemption
  # notice just means the next wake re-spawns the pod. Tolerating
  # the taint here lets the orchestrator place agents on cheap
  # Spot nodes; on-demand nodes are untainted so this is additive.
  tolerations:
  - key: cloud.google.com/gke-spot
    operator: Equal
    value: "true"
    effect: NoSchedule
  volumes:
  - name: chrome-profile
${CHROME_PROFILE_ON_PVC
    ? `    persistentVolumeClaim:\n      claimName: ${yamlQuote(chromeProfilePvcName(args.agentId))}`
    : `    emptyDir:\n      sizeLimit: ${yamlQuote(CHROME_PVC_SIZE)}`}
`
}

/** Render the PVC manifest for an agent's Chromium profile. Applied
 *  idempotently before each podManifest apply; PVCs outlive their
 *  pods so a clean idle-exit doesn't wipe login state. */
function chromeProfilePvcManifest(args: { agentId: string }): string {
  const scLine = CHROME_PVC_STORAGECLASS === ''
    ? ''
    : `\n  storageClassName: ${yamlQuote(CHROME_PVC_STORAGECLASS)}`
  // The annotation carries the RAW agentId (may contain chars
  // safeName() strips), so the GC sweeper can reverse-lookup
  // participants.id without depending on the slug being lossless.
  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${chromeProfilePvcName(args.agentId)}
  labels:
    app: cumora-agent
    cumora.agent: ${yamlQuote(dnsLabelValue(safeName(args.agentId).replace(/^agent-/, '')) || 'unknown')}
  annotations:
    cumora.dev/agent-id: ${yamlQuote(args.agentId)}
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: ${yamlQuote(CHROME_PVC_SIZE)}${scLine}
`
}

/** Exported for tests — production callers go through ensurePod. */
export const _testing = { podManifest, yamlQuote, dnsLabelValue, chromeProfilePvcManifest, chromeProfilePvcName }

// ─── cluster-wide FUSE admission control ─────────────────────────────
//
// Triggered by the FUSE-cap incident on 2026-05-20: agent pods request
// `devic.es/fuse: 1` (one slot per pod), and each prod node advertises
// 800 slots via the generic-device-plugin DaemonSet. The app-level
// admission cap is intentionally lower (AGENT_POD_ADMISSION_MAX,
// default 40) because CPU, memory, API-server churn, and provider
// concurrency are the real production ceiling.
//
// `ensurePod` must REFUSE rather than blindly apply when the cluster
// is near saturation. Refusing lets pending wakes survive in their
// inbox (message.new) or get retried by their scheduler (idle /
// scanner); blowing past the cap, conversely, leaves pods stuck in
// FailedScheduling for tens of minutes with no recovery.

export interface ClusterFuseUtilization {
  /** Number of cumora-agent pods currently using a fuse slot
   *  (Pending + Running, excluding Succeeded/Failed). */
  used: number
  /** Effective admission cap: min(cluster `devic.es/fuse` capacity,
   *  AGENT_POD_ADMISSION_MAX when that env is positive). */
  cap: number
  /** used / cap. 0 when cap is 0 (no nodes report fuse). */
  ratio: number
  /** True when result came from the in-memory cache. */
  cached: boolean
}

/** Pure parser — extracted so the unit test can pin both branches
 *  (well-formed JSON, malformed) without spawning kubectl. */
export function parseClusterFuse(nodesJson: string, podsJson: string): { used: number; cap: number } {
  let cap = 0
  try {
    const d = JSON.parse(nodesJson) as { items?: Array<{ status?: { capacity?: Record<string, string> } }> }
    for (const n of d.items ?? []) {
      const slots = Number(n.status?.capacity?.['devic.es/fuse'] ?? 0)
      if (Number.isFinite(slots) && slots > 0) cap += slots
    }
  } catch { /* ignore — return 0 */ }
  let used = 0
  try {
    const d = JSON.parse(podsJson) as { items?: Array<{ status?: { phase?: string } }> }
    for (const p of d.items ?? []) {
      const phase = p.status?.phase
      // Pending pods that haven't been bound yet don't actually hold
      // a device slot, but they DO represent demand the scheduler is
      // trying to fulfill — count them so we don't over-spawn into a
      // queue. Succeeded/Failed pods released their slot at exit.
      if (phase === 'Running' || phase === 'Pending') used++
    }
  } catch { /* ignore — return 0 */ }
  return { used, cap }
}

interface FuseUtilCache { ts: number; used: number; cap: number }
let fuseUtilCache: FuseUtilCache | null = null

/** TTL on the cluster-wide fuse sample. Short enough that bursts get
 *  re-evaluated quickly; long enough that we don't hammer the K8s API
 *  on every wake. Each successful spawn bumps `used` in-memory so the
 *  cached value tracks intra-window growth without a refresh. */
const FUSE_CACHE_TTL_MS = 10_000

/** Threshold above which `ensurePod` refuses new spawns. 0.90 leaves
 *  a 10% buffer for in-flight scheduling latency and inFlight-dedup
 *  raciness. Below 0.90 we let everything through. */
const FUSE_ADMISSION_THRESHOLD = 0.90

/** Sample (or read from cache) the cluster's cumora-agent fuse usage.
 *  Fails open: on kubectl error returns `cap=Infinity` so callers
 *  never block on transient cluster-state read failures. */
export async function getClusterFuseUtilization(): Promise<ClusterFuseUtilization> {
  const now = Date.now()
  if (fuseUtilCache && now - fuseUtilCache.ts < FUSE_CACHE_TTL_MS) {
    const { used, cap } = fuseUtilCache
    return { used, cap, ratio: cap > 0 ? used / cap : 0, cached: true }
  }
  const [nodes, pods] = await Promise.all([
    kubectlWithRetry(['get', 'nodes', '-o', 'json'], { timeoutMs: 10_000 }),
    kubectlWithRetry(
      ['get', 'pods', '-l', 'app=cumora-agent', '-o', 'json'],
      { timeoutMs: 10_000 },
    ),
  ])
  if (nodes.code !== 0 || pods.code !== 0) {
    // Fail open — we'd rather over-spawn during a kubectl flake than
    // wedge every wake. Don't cache this so the next call retries.
    return { used: 0, cap: Number.POSITIVE_INFINITY, ratio: 0, cached: false }
  }
  const parsed = parseClusterFuse(nodes.out, pods.out)
  const appCap = env.AGENT_POD_ADMISSION_MAX
  const cap = appCap > 0 ? Math.min(parsed.cap, appCap) : parsed.cap
  fuseUtilCache = { ts: now, used: parsed.used, cap }
  return { used: parsed.used, cap, ratio: cap > 0 ? parsed.used / cap : 0, cached: false }
}

/** Test-only — clear the in-memory cache so tests don't poison each other. */
export function _resetFuseUtilCacheForTests(): void { fuseUtilCache = null }

/** Bump cached `used` after a successful spawn, so back-to-back
 *  `ensurePod` calls within the cache TTL see the increment without
 *  waiting for the next refresh. No-op if the cache is empty. */
function bumpFuseUtilUsedOnSpawn(): void {
  if (fuseUtilCache) fuseUtilCache.used++
}

export type PodPhase = '' | 'Pending' | 'Running' | 'Succeeded' | 'Failed' | 'Unknown'

export interface PodHealth {
  phase: PodPhase
  /** waiting.reason from every (init)containerStatus — surfaces ImagePullBackOff
   *  / CrashLoopBackOff / CreateContainerConfigError / etc. */
  waitingReasons: string[]
  /** PodScheduled=False, reason=Unschedulable — scheduler can't place the pod. */
  unschedulable: boolean
}

interface RawPod {
  status?: {
    phase?: string
    conditions?: Array<{ type?: string; status?: string; reason?: string }>
    containerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>
    initContainerStatuses?: Array<{ state?: { waiting?: { reason?: string } } }>
  }
}

/** Read an existing Pod's phase + the container waiting reasons that
 *  signal a stuck Pending state. Empty phase means the Pod doesn't
 *  exist. We need more than just phase: a Pod sitting in `Pending`
 *  with `ImagePullBackOff` will never recover on its own — the
 *  scheduler must delete it and reapply. */
/** Pure parser — split from the kubectl call so tests can pin the
 *  contract without spawning a real kubectl. Returns the empty/safe
 *  health shape on any parse failure. */
export function parsePodHealth(rawJson: string): PodHealth {
  let pod: RawPod
  try {
    pod = JSON.parse(rawJson) as RawPod
  } catch {
    return { phase: '', waitingReasons: [], unschedulable: false }
  }
  const phase = (pod.status?.phase ?? '') as PodPhase
  const waitingReasons: string[] = []
  for (const arr of [pod.status?.containerStatuses, pod.status?.initContainerStatuses]) {
    if (!Array.isArray(arr)) continue
    for (const cs of arr) {
      const reason = cs.state?.waiting?.reason
      if (typeof reason === 'string' && reason) waitingReasons.push(reason)
    }
  }
  const unschedulable = (pod.status?.conditions ?? []).some(
    (c) => c.type === 'PodScheduled' && c.status === 'False' && c.reason === 'Unschedulable',
  )
  return { phase, waitingReasons, unschedulable }
}

async function podHealth(agentId: string): Promise<PodHealth> {
  // `get pod` is the read path — retry on transient API-server issues.
  const r = await kubectlWithRetry(['get', 'pod', podName(agentId), '-o', 'json'])
  if (r.code !== 0) return { phase: '', waitingReasons: [], unschedulable: false }
  return parsePodHealth(r.out)
}

/** Waiting reasons that K8s will not recover from on its own — image
 *  is missing/broken, container config is invalid, or the container
 *  keeps crashing. Anything in this set means the Pod is stuck and
 *  we should reap + recreate. */
const STUCK_WAITING_REASONS = new Set([
  'ImagePullBackOff',
  'ErrImagePull',
  'CrashLoopBackOff',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'RunContainerError',
])

/** If the Pending Pod is stuck, return a short diagnostic string.
 *  Otherwise null (still legitimately pending — image pulling,
 *  init containers running, etc.). Exported for testability. */
export function stuckPendingReason(h: PodHealth): string | null {
  const bad = h.waitingReasons.find((r) => STUCK_WAITING_REASONS.has(r))
  if (bad) return bad
  if (h.unschedulable) return 'Unschedulable'
  return null
}

/** Result of `ensurePod`. `ok` distinguishes "Pod is healthy and ready
 *  to receive wakes" (created OR already pending/running) from "we
 *  couldn't get a Pod into a runnable state" (apply failed, persona
 *  missing, etc.). Callers that just want to log real failures should
 *  check `!ok` rather than string-matching `reason`. */
export type EnsurePodResult =
  | { created: true;  ok: true;  reason: string }
  | { created: false; ok: true;  reason: string }
  | {
      created: false
      ok: false
      reason: string
      code:
        | 'watchdog_timeout'
        | 'pod_reap_failed'
        | 'capacity_denied'
        | 'agent_not_found'
        | 'placement_lookup_failed'
        | 'placement_denied'
        | 'pod_apply_failed'
    }

export type ManagedPodPlacementVerification =
  | { ok: true; companyId: string; computerId: string | null }
  | {
      ok: false
      code: 'agent_not_found' | 'placement_lookup_failed' | 'placement_denied'
      reason: string
    }

/** Resolve the policy at the managed-runtime boundary. The resolver is
 * injectable only so fault-path unit tests can prove that lookup exceptions
 * and invalid assignments fail closed without invoking kubectl. */
export async function verifyManagedPodPlacement(
  agentId: string,
  resolver: (id: string) => Promise<AgentHostResolution> = resolveAgentHost,
): Promise<ManagedPodPlacementVerification> {
  let resolution: AgentHostResolution
  try {
    resolution = await resolver(agentId)
  } catch (cause) {
    resolution = {
      status: 'error',
      code: 'lookup_failed',
      reason: `host lookup failed for agent ${agentId}`,
      cause,
    }
  }
  const decision = managedPodPlacement(resolution)
  if (decision.status === 'denied') {
    return { ok: false, code: decision.code, reason: decision.reason }
  }
  return {
    ok: true,
    companyId: decision.companyId,
    computerId: decision.computerId,
  }
}

/** In-flight `ensurePod` deduplication. Without this a thundering
 *  herd (e.g. 50 wakes for one resting agent within 1s) calls
 *  kubectl apply 50 times before the first apply finishes. Idempotent
 *  on the K8s side, but wasteful and noisy. We coalesce concurrent
 *  callers onto the first inflight promise; once it resolves, the
 *  entry drops out of the map and the next caller (if any) starts
 *  fresh. */
const inFlight = new Map<string, Promise<EnsurePodResult>>()

/** Watchdog timeout on the WHOLE ensurePodImpl invocation. Even with
 *  per-kubectl-call timeouts, an unexpectedly-slow DB query or a hang
 *  somewhere we didn't bound could keep the in-flight promise alive
 *  indefinitely. Without this watchdog, the inFlight Map would
 *  accumulate dead entries and every subsequent caller for the same
 *  agentId would deadlock. The sum of individual call timeouts is
 *  ~120s in the worst path (reap 40s + apply 45s + persona lookup +
 *  sub2api lookup); 180s gives a sane outer ceiling.
 *
 *  When the watchdog fires we ALSO drop the inFlight entry so
 *  callers can retry on the next wake. */
const ENSURE_POD_WATCHDOG_MS = 180_000

/** Idempotent — spin up a Pod for `agentId` if one isn't already
 *  running. Returns a hint about whether we actually created anything
 *  (for log readability).
 *
 *  Doesn't wait for the Pod to be Ready / SSE-attached. The scheduler
 *  is free to enqueue the wake event on the bus; the Pod, once it
 *  connects, drains its inbox unconditionally and catches up. */
export async function ensurePod(agentId: string): Promise<EnsurePodResult> {
  const existing = inFlight.get(agentId)
  if (existing) return existing
  const p = (async (): Promise<EnsurePodResult> => {
    let watchdogFired = false
    const watchdog = new Promise<EnsurePodResult>((resolve) =>
      setTimeout(() => {
        watchdogFired = true
        resolve({
          created: false,
          ok: false,
          code: 'watchdog_timeout',
          reason: `ensurePod watchdog: implementation did not return within ${ENSURE_POD_WATCHDOG_MS}ms`,
        })
      }, ENSURE_POD_WATCHDOG_MS).unref?.(),
    )
    try {
      const result = await Promise.race([ensurePodImpl(agentId), watchdog])
      if (watchdogFired) {
        // Alert because this means something hung BELOW the per-call
        // timeouts — a real bug we want to know about, not just a
        // slow cluster.
        void notifyAlert({
          label: 'orchestrator.ensurePod_watchdog',
          error: new Error(`ensurePod(${agentId}) exceeded ${ENSURE_POD_WATCHDOG_MS}ms`),
          extras: { agentId },
        })
      }
      return result
    } finally {
      inFlight.delete(agentId)
    }
  })()
  inFlight.set(agentId, p)
  return p
}

async function ensurePodImpl(agentId: string): Promise<EnsurePodResult> {
  const startedAt = Date.now()
  // This is the final authorization boundary for managed execution. Scheduler
  // lookups are advisory only: assignment/tier can change between a wake and
  // this call, and other callers may invoke ensurePod directly.
  const initialPlacement = await verifyManagedPodPlacement(agentId)
  if (!initialPlacement.ok) {
    return { created: false, ...initialPlacement }
  }
  const recheckPlacement = async (): Promise<EnsurePodResult | null> => {
    const current = await verifyManagedPodPlacement(agentId)
    if (!current.ok) return { created: false, ...current }
    if (current.companyId !== initialPlacement.companyId) {
      return {
        created: false,
        ok: false,
        code: 'placement_denied',
        reason: 'managed pod denied: agent company changed during placement',
      }
    }
    return null
  }
  const h = await podHealth(agentId)
  if (h.phase === 'Running') {
    const denied = await recheckPlacement()
    if (denied) return denied
    return { created: false, ok: true, reason: 'already running' }
  }
  if (h.phase === 'Pending') {
    const stuck = stuckPendingReason(h)
    if (!stuck) {
      const denied = await recheckPlacement()
      if (denied) return denied
      return { created: false, ok: true, reason: 'already pending' }
    }
    // Fall through to the stuck-Pending reap path below. Don't admission-
    // gate this: reaping is a cleanup that frees a slot, not a fresh
    // demand on cluster capacity.
    // Pod will never recover on its own (ImagePullBackOff / Unschedulable /
    // CrashLoopBackOff / etc.) — reap so the apply below installs a
    // fresh manifest. kubectl apply against an immutable existing Pod
    // would fail, hence the explicit delete first.
    //
    // Alert because stuck pods point at infra problems (bad image
    // tag, exhausted node pool) that need a human to look. The reap
    // unblocks the agent in the short term but the underlying cause
    // will re-surface on the NEXT ensurePod unless someone fixes it.
    console.warn(`[orchestrator] ${agentId} pending pod is stuck (${stuck}); reaping`)
    void notifyAlert({
      label: 'orchestrator.stuck_pending_reap',
      error: new Error(`pod for ${agentId} stuck in Pending (${stuck}); reaping for fresh start`),
      extras: { agentId, stuckReason: stuck, waitingReasons: h.waitingReasons.join(',') },
    })
    // `--timeout=30s` on the kubectl side AND our wrapper timeout —
    // belt-and-braces. A pod with stuck finalizers shouldn't block
    // the orchestrator's main loop indefinitely.
    const denied = await recheckPlacement()
    if (denied) return denied
    const reap = await kubectlWithRetry(
      ['delete', 'pod', podName(agentId), '--ignore-not-found=true', '--wait=true', '--timeout=30s'],
      { timeoutMs: 40_000 },
    )
    if (reap.code !== 0) {
      // The reap failed — apply will almost certainly fail too (it
      // can't create a Pod with the same name as an existing one).
      // Surface a precise error rather than letting the apply step
      // try and produce a misleading "already exists" message.
      return {
        created: false, ok: false, code: 'pod_reap_failed',
        reason: `pod reap failed (was stuck=${stuck}): ${(reap.err || reap.out).trim()}`,
      }
    }
  } else if (h.phase === 'Succeeded' || h.phase === 'Failed' || h.phase === 'Unknown') {
    // Plain Pods (not Jobs) don't have ttlSecondsAfterFinished, so a
    // Pod that idle-exited stays in Completed state until something
    // deletes it. Reap it before applying the new manifest so kubectl
    // apply doesn't see it as an existing immutable Pod. Unknown
    // (node lost / kubelet unreachable) is also a clean-slate case.
    if (h.phase === 'Failed') {
      // Failed = the container exited non-zero AND restartPolicy gave
      // up. That's a real bug inside the pod we should surface, not
      // just an idle teardown.
      console.warn(`[orchestrator] ${agentId} previous pod ended in Failed; reaping to recreate`)
      void notifyAlert({
        label: 'orchestrator.previous_pod_failed',
        error: new Error(`previous pod for ${agentId} ended in Failed phase; recreating`),
        extras: { agentId, waitingReasons: h.waitingReasons.join(',') },
      })
    } else if (h.phase === 'Unknown') {
      console.warn(`[orchestrator] ${agentId} previous pod was in Unknown phase (node lost?); reaping`)
    }
    const denied = await recheckPlacement()
    if (denied) return denied
    await kubectlWithRetry(
      ['delete', 'pod', podName(agentId), '--ignore-not-found=true', '--wait=true', '--timeout=30s'],
      { timeoutMs: 40_000 },
    )
  }

  // Cluster-wide FUSE admission: refuse the spawn if the cluster is
  // near its /dev/fuse capacity. The scheduler puts durable
  // message.new/manual wakes into a Redis retry queue when this
  // returns !ok; idle/scanner wakes are best-effort and retry on the
  // next tick.
  // Throwing this admission AT the kubectl-apply edge stops over-spawn
  // at its narrowest possible chokepoint and keeps cluster cap from
  // being exceeded regardless of upstream caller behavior.
  const fuse = await getClusterFuseUtilization()
  if (fuse.cap > 0 && fuse.ratio >= FUSE_ADMISSION_THRESHOLD) {
    return {
      created: false, ok: false, code: 'capacity_denied',
      reason: `cluster fuse saturated: ${fuse.used}/${fuse.cap} (${Math.round(fuse.ratio * 100)}% ≥ ${Math.round(FUSE_ADMISSION_THRESHOLD * 100)}% threshold)`,
    }
  }

  const persona = await inprocClient.loadPersona(agentId).catch(() => null)
  if (!persona) {
    return { created: false, ok: false, code: 'agent_not_found', reason: 'no such agent' }
  }
  if (persona.companyId !== initialPlacement.companyId) {
    return {
      created: false,
      ok: false,
      code: 'placement_denied',
      reason: 'managed pod denied: persona tenant does not match host assignment',
    }
  }

  const token = signAgentToken({
    agentId,
    companyId: persona.companyId,
    ttlSeconds: TOKEN_TTL_SECONDS,
  })

  // Resolve the workspace's per-user sub2api key so this pod's LLM
  // traffic counts against that user's quota. Falls back to the
  // legacy single OPENAI_API_KEY when sub2api isn't configured OR the
  // workspace owner hasn't been provisioned yet. The same logic lives
  // in llm.ts but pods don't share memory with the server process —
  // we have to bake the resolved key into the manifest env at
  // pod-spawn time.
  let resolvedKey = env.OPENAI_API_KEY
  let resolvedBaseUrl = '' // empty → OpenAI SDK uses its default (api.openai.com/v1)
  if (sub2apiConfigured()) {
    try {
      const { rows } = await pool.query<{ sub2api_api_key: string | null }>(
        `SELECT u.sub2api_api_key FROM companies c
            JOIN users u ON u.id = c.owner_user_id
          WHERE c.id = $1`,
        [persona.companyId],
      )
      const k = rows[0]?.sub2api_api_key
      if (k) {
        resolvedKey = k
        resolvedBaseUrl = sub2apiOpenAIBaseURL()
      }
    } catch (e) {
      console.warn(`[orchestrator] sub2api key lookup failed for ${persona.companyId}; legacy fallback`, e instanceof Error ? e.message : e)
    }
  }

  // Re-read immediately before the first Kubernetes mutation. This closes the
  // scheduler-to-orchestrator and preparation-time race: moving the Agent to a
  // BYOA Computer or downgrading the tenant while pod health/key resolution is
  // in flight cannot still result in a managed PVC/Pod apply.
  const finalPlacementDenied = await recheckPlacement()
  if (finalPlacementDenied) return finalPlacementDenied

  // Apply the per-agent chrome-profile PVC BEFORE the pod. kubectl
  // apply is idempotent — if the PVC already exists this is a no-op.
  // The PVC outlives the pod, so an idle-exit / restart / re-spawn
  // all attach to the same volume and Chromium's cookies + login
  // state survive. Failure here is non-fatal: the pod can still run
  // (Chromium would just have an empty profile) so we log and
  // continue rather than block the agent from spawning.
  //
  // Skipped entirely when CUMORA_CHROME_PROFILE_PVC=false — used by
  // clusters that don't have a default StorageClass set up yet. The
  // pod manifest swaps the volume source to emptyDir to match.
  if (CHROME_PROFILE_ON_PVC) {
    const pvcManifest = chromeProfilePvcManifest({ agentId })
    const pvcApply = await kubectlWithRetry(['apply', '-f', '-'], { stdin: pvcManifest, timeoutMs: 20_000 })
    if (pvcApply.code !== 0) {
      console.warn(`[orchestrator] chrome PVC apply failed for ${agentId}: ${(pvcApply.err || pvcApply.out).trim()}`)
    }
  }

  const manifest = podManifest({
    agentId,
    token,
    image: IMAGE,
    serverUrl: env.AGENT_RUNTIME_SERVER_URL,
    openaiKey: resolvedKey,
    openaiBaseUrl: resolvedBaseUrl,
    idleMs: env.AGENT_IDLE_MS,
    noWorkMs: env.AGENT_NO_WORK_MS,
  })

  // `kubectl apply` is the write path. Retry on transient errors;
  // 45s timeout because validation + admission webhooks can be slow
  // when an image-pull-credential webhook runs.
  const podApply = await kubectlWithRetry(['apply', '-f', '-'], { stdin: manifest, timeoutMs: 45_000 })
  if (podApply.code !== 0) {
    const errText = (podApply.err || podApply.out).trim()
    // Alert on apply failures — when this fires, agents stay in
    // resting state and never wake up no matter how many messages
    // arrive. Highest-severity orchestrator failure mode.
    void notifyAlert({
      label: 'orchestrator.pod_apply_failed',
      error: new Error(`kubectl apply failed for ${agentId}: ${errText}`),
      extras: { agentId, elapsedMs: Date.now() - startedAt, timedOut: podApply.timedOut },
    })
    return {
      created: false,
      ok: false,
      code: 'pod_apply_failed',
      reason: `pod apply failed: ${errText}`,
    }
  }
  bumpFuseUtilUsedOnSpawn()
  console.log(`[orchestrator] ${agentId} pod spun up in ${Date.now() - startedAt}ms`)
  return { created: true, ok: true, reason: 'spun up' }
}

/** Tear down an agent's Pod. Idempotent. Normally the Pod self-
 *  terminates by exiting 0 after its idle timer fires; this is the
 *  manual / cleanup path. */
export async function deletePod(agentId: string): Promise<void> {
  // --wait=false here (unlike the in-ensurePod reap which uses --wait=true):
  // this is the manual cleanup path, callers don't care to block until
  // termination completes.
  await kubectlWithRetry(
    ['delete', 'pod', podName(agentId), '--ignore-not-found=true', '--wait=false'],
    { timeoutMs: 20_000 },
  )
}

/** Drop an agent's chrome-profile PVC. NOT called on normal idle-exit
 *  — PVCs outlive their pod so a re-spawn keeps cookies / login
 *  state. Call this only when the agent is being permanently
 *  off-boarded; otherwise the next pod will rebind to the existing
 *  PVC. Idempotent (--ignore-not-found). */
export async function deleteChromeProfilePvc(agentId: string): Promise<void> {
  await kubectlWithRetry(
    ['delete', 'pvc', chromeProfilePvcName(agentId), '--ignore-not-found=true', '--wait=false'],
    { timeoutMs: 20_000 },
  )
}

// ─── Idle chrome-profile PVC garbage collection ──────────────────────
//
// PVCs outlive their pods on purpose (so Chromium login state survives
// idle-exit), but agents that never get woken again leave orphan PVCs
// accumulating forever — at $0.10/GB·month each, 1k abandoned agents
// = $100/month of pure waste, scaling linearly with adoption. This
// sweeper deletes the PVCs for agents that:
//   • have been off-boarded (departed_at IS NOT NULL), AND/OR
//   • haven't run in the last IDLE_DAYS (no agent_runs row newer
//     than the threshold)
// Idle Pods themselves are off-PVC by the time the sweeper runs (they
// exit on idle), so deleting the volume doesn't yank from under a
// live process.

/** A PVC the GC pass found that should be considered for deletion. */
export interface IdlePvcCandidate {
  pvcName: string
  agentId: string
  lastWakeAt: Date | null
  departedAt: Date | null
  reason: 'departed' | 'idle' | 'orphan'
}

/** Pure planner: given the raw PVC list + DB state, decide which to
 *  delete. Extracted so unit tests can exercise the decision matrix
 *  without needing a live cluster or DB. */
export function planIdlePvcGc(args: {
  pvcs: Array<{ name: string; agentId: string }>
  agents: Map<string, { departedAt: Date | null; lastWakeAt: Date | null }>
  now: Date
  idleThresholdMs: number
}): IdlePvcCandidate[] {
  const drop: IdlePvcCandidate[] = []
  const cutoff = args.now.getTime() - args.idleThresholdMs
  for (const pvc of args.pvcs) {
    const a = args.agents.get(pvc.agentId)
    if (!a) {
      // PVC has no matching participants row — the agent was hard-
      // deleted somehow (or pre-dates the agent-id annotation). Safe
      // to reclaim.
      drop.push({ pvcName: pvc.name, agentId: pvc.agentId, lastWakeAt: null, departedAt: null, reason: 'orphan' })
      continue
    }
    if (a.departedAt) {
      drop.push({ pvcName: pvc.name, agentId: pvc.agentId, lastWakeAt: a.lastWakeAt, departedAt: a.departedAt, reason: 'departed' })
      continue
    }
    if (a.lastWakeAt && a.lastWakeAt.getTime() < cutoff) {
      drop.push({ pvcName: pvc.name, agentId: pvc.agentId, lastWakeAt: a.lastWakeAt, departedAt: null, reason: 'idle' })
      continue
    }
    if (!a.lastWakeAt) {
      // Agent has a PVC but never logged a run. This usually means
      // the PVC was created on first wake but the agent crashed
      // before agent_runs got an insert. Skip — too risky to delete
      // a fresh PVC that just hasn't seen activity yet. The sweeper
      // will revisit next tick once the PVC is older than the
      // threshold (PVC creation timestamp is a stronger signal —
      // future iteration could read metadata.creationTimestamp).
      continue
    }
  }
  return drop
}

let chromePvcGcTimer: NodeJS.Timeout | null = null

async function listChromeProfilePvcs(): Promise<Array<{ name: string; agentId: string }>> {
  const out = await kubectlWithRetry(
    ['get', 'pvc', '-l', 'app=cumora-agent', '-o',
      'jsonpath={range .items[*]}{.metadata.name}|{.metadata.annotations.cumora\\.dev/agent-id}{"\\n"}{end}'],
    { timeoutMs: 20_000 },
  )
  if (out.code !== 0) {
    console.warn(`[chrome-pvc-gc] list failed: ${(out.err || out.out).trim()}`)
    return []
  }
  const pvcs: Array<{ name: string; agentId: string }> = []
  for (const line of out.out.split('\n')) {
    if (!line.trim()) continue
    const [name, agentId] = line.split('|')
    if (!name) continue
    // Fallback when the annotation is missing (pre-annotation PVCs):
    // strip the `agent-` prefix + `-chrome` suffix from the K8s name.
    // Lossy for agent ids that had uppercase / special chars, but
    // covers the common DNS-1123-clean case (iris-0c97, bram-c078).
    const recoveredId = agentId?.trim() || name.replace(/^agent-/, '').replace(/-chrome$/, '')
    pvcs.push({ name, agentId: recoveredId })
  }
  return pvcs
}

async function loadAgentRecencyForGc(
  agentIds: string[],
): Promise<Map<string, { departedAt: Date | null; lastWakeAt: Date | null }>> {
  const map = new Map<string, { departedAt: Date | null; lastWakeAt: Date | null }>()
  if (agentIds.length === 0) return map
  const { rows } = await pool.query<{ id: string; departed_at: Date | null; last_wake_at: Date | null }>(
    `SELECT p.id, p.departed_at,
            (SELECT MAX(ar.started_at) FROM agent_runs ar WHERE ar.agent_id = p.id) AS last_wake_at
       FROM participants p
      WHERE p.id = ANY($1::text[]) AND p.kind = 'agent'`,
    [agentIds],
  )
  for (const r of rows) {
    map.set(r.id, { departedAt: r.departed_at, lastWakeAt: r.last_wake_at })
  }
  return map
}

/** Run one GC pass. Returns the list of PVCs deleted (for logging /
 *  tests). Idle threshold + interval are configured via env vars. */
export async function sweepIdleChromeProfilePvcs(opts: {
  idleThresholdMs: number
  /** Test seam — production callers omit. */
  now?: Date
} = { idleThresholdMs: 30 * 24 * 60 * 60_000 }): Promise<IdlePvcCandidate[]> {
  const pvcs = await listChromeProfilePvcs()
  if (pvcs.length === 0) return []
  const agents = await loadAgentRecencyForGc(pvcs.map((p) => p.agentId))
  const plan = planIdlePvcGc({
    pvcs, agents,
    now: opts.now ?? new Date(),
    idleThresholdMs: opts.idleThresholdMs,
  })
  const deleted: IdlePvcCandidate[] = []
  for (const cand of plan) {
    const r = await kubectlWithRetry(
      ['delete', 'pvc', cand.pvcName, '--ignore-not-found=true', '--wait=false'],
      { timeoutMs: 20_000 },
    )
    if (r.code === 0) {
      console.log(`[chrome-pvc-gc] dropped ${cand.pvcName} (${cand.reason}, agent=${cand.agentId})`)
      deleted.push(cand)
    } else {
      console.warn(`[chrome-pvc-gc] failed to delete ${cand.pvcName}: ${(r.err || r.out).trim()}`)
    }
  }
  return deleted
}

/** Boot the periodic sweeper. Idempotent — re-calling returns the
 *  existing handle. intervalMs <= 0 disables. */
export function startChromeProfilePvcGc(opts: {
  intervalMs: number
  idleThresholdMs: number
}): { stop(): void } | null {
  if (chromePvcGcTimer) return { stop: stopChromeProfilePvcGc }
  if (opts.intervalMs <= 0) {
    console.log('[chrome-pvc-gc] disabled (interval <= 0)')
    return null
  }
  console.log(`[chrome-pvc-gc] running every ${opts.intervalMs}ms · idle threshold ${opts.idleThresholdMs}ms`)
  const tick = async () => {
    try {
      const deleted = await sweepIdleChromeProfilePvcs({ idleThresholdMs: opts.idleThresholdMs })
      if (deleted.length > 0) {
        console.log(`[chrome-pvc-gc] swept ${deleted.length} PVC${deleted.length === 1 ? '' : 's'}`)
      }
    } catch (e) {
      console.error('[chrome-pvc-gc] tick crashed:', e instanceof Error ? e.message : String(e))
    }
  }
  chromePvcGcTimer = setInterval(() => { void tick() }, opts.intervalMs)
  chromePvcGcTimer.unref()
  return { stop: stopChromeProfilePvcGc }
}

export function stopChromeProfilePvcGc(): void {
  if (chromePvcGcTimer) { clearInterval(chromePvcGcTimer); chromePvcGcTimer = null }
}

// ─── Completed/Failed agent-pod garbage collection ──────────────────
//
// Plain Pods (not Jobs) don't have TTL-after-finished, so an idle-
// exited agent pod stays in Completed phase until something deletes
// it. In normal operation `ensurePod`'s reap-on-recreate path handles
// this, but for agents that never get re-woken (deleted personas,
// long-quiet workspaces) the leftovers pile up — we observed 180+
// Completed agent pods on prod during the FUSE-cap incident. They
// don't hold fuse slots but they slow kube-controller-manager, bloat
// `kubectl get pods` output, and leave dangling PVC bindings.

/** Pure helper — pick agent pods that should be GC'd given the JSON
 *  output of `kubectl get pods -l app=cumora-agent -o json`. Tests
 *  pin this directly without spawning kubectl. */
export function pickAgentPodsForGc(
  podsJson: string,
  now: number,
  minAgeMs: number,
): string[] {
  let data: { items?: Array<{ metadata?: { name?: string; creationTimestamp?: string }; status?: { phase?: string } }> }
  try {
    data = JSON.parse(podsJson) as typeof data
  } catch {
    return []
  }
  const out: string[] = []
  for (const p of data.items ?? []) {
    const phase = p.status?.phase
    if (phase !== 'Succeeded' && phase !== 'Failed' && phase !== 'Unknown') continue
    const name = p.metadata?.name
    if (!name) continue
    const ts = p.metadata?.creationTimestamp
    if (ts) {
      const ageMs = now - Date.parse(ts)
      if (!Number.isFinite(ageMs) || ageMs < minAgeMs) continue
    }
    out.push(name)
  }
  return out
}

/** Periodic sweep of finished agent pods. Safe to run from any number
 *  of cumora-server replicas — `kubectl delete --ignore-not-found`
 *  collapses concurrent calls. */
export async function gcCompletedAgentPods(opts: { minAgeMs?: number } = {}): Promise<{ scanned: number; deleted: number }> {
  const minAgeMs = opts.minAgeMs ?? 5 * 60_000
  const r = await kubectlWithRetry(
    ['get', 'pods', '-l', 'app=cumora-agent', '-o', 'json'],
    { timeoutMs: 10_000 },
  )
  if (r.code !== 0) return { scanned: 0, deleted: 0 }
  const victims = pickAgentPodsForGc(r.out, Date.now(), minAgeMs)
  if (victims.length === 0) return { scanned: 0, deleted: 0 }
  // Best-effort batch delete: one kubectl call with all names. Failures
  // here are non-fatal — the next sweep retries.
  const del = await kubectlWithRetry(
    ['delete', 'pod', ...victims, '--ignore-not-found=true', '--wait=false'],
    { timeoutMs: 30_000 },
  )
  if (del.code !== 0) {
    console.warn(`[orchestrator] gcCompletedAgentPods kubectl delete failed: ${(del.err || del.out).trim().slice(0, 200)}`)
  }
  return { scanned: victims.length, deleted: del.code === 0 ? victims.length : 0 }
}

// ─── cluster fuse-pressure monitor ──────────────────────────────────
//
// Detection used to rely on users complaining "agent 不回复". Now we
// sample the cluster periodically and fire notifyAlert when pending
// agent pods stay above a threshold for a sustained window. The
// alert payload includes the saturation ratio + pending count so the
// on-call can decide whether to bump max-nodes or hunt over-spawn.

interface FusePressureState {
  /** Most recent kubectl-get-pods scan. */
  lastSampleAt: number
  /** ms timestamp when the cluster first crossed the pending threshold. */
  pressureSince: number | null
  /** ms timestamp of the last alert fired. Cooldown source. */
  lastAlertAt: number | null
}

const fusePressureState: FusePressureState = {
  lastSampleAt: 0, pressureSince: null, lastAlertAt: null,
}

/** Test-only — reset the in-process state. */
export function _resetFusePressureStateForTests(): void {
  fusePressureState.lastSampleAt = 0
  fusePressureState.pressureSince = null
  fusePressureState.lastAlertAt = null
}

/** Pure decision: given a sample, should we alert? Stateful — mutates
 *  `state` in place. Exported so the unit test can pin every branch
 *  (rising edge fires, sustained fires once, recovery clears, alert
 *  cooldown holds). */
export function evaluateFusePressureSample(
  state: FusePressureState,
  pending: number,
  fuseRatio: number,
  now: number,
  thresholds: { pendingMin: number; ratioMin: number; sustainedMs: number; alertCooldownMs: number },
): { fire: boolean; reason: string } {
  state.lastSampleAt = now
  const pressured = pending >= thresholds.pendingMin || fuseRatio >= thresholds.ratioMin
  if (!pressured) {
    state.pressureSince = null
    return { fire: false, reason: 'no pressure' }
  }
  if (state.pressureSince === null) {
    state.pressureSince = now
    return { fire: false, reason: 'pressure just started — within sustain window' }
  }
  if (now - state.pressureSince < thresholds.sustainedMs) {
    return { fire: false, reason: 'pressure not yet sustained' }
  }
  if (state.lastAlertAt !== null && now - state.lastAlertAt < thresholds.alertCooldownMs) {
    return { fire: false, reason: 'within alert cooldown' }
  }
  state.lastAlertAt = now
  return { fire: true, reason: `pending=${pending} fuseRatio=${(fuseRatio * 100).toFixed(0)}%` }
}

/** One-shot sampler: take a fresh cluster reading, run the decision,
 *  fire the alert if needed. Exported for tests. */
export async function pollClusterFusePressureOnce(): Promise<void> {
  // Reuse the admission-control cache where possible — but force a
  // fresh sample if the cache is stale (>10s).
  fuseUtilCache = null
  const fuse = await getClusterFuseUtilization()
  const pendingProbe = await kubectlWithRetry(
    [
      'get', 'pods', '-l', 'app=cumora-agent',
      '--field-selector=status.phase=Pending',
      '--no-headers',
    ],
    { timeoutMs: 10_000 },
  )
  const pending = pendingProbe.code === 0
    ? pendingProbe.out.split('\n').filter((l) => l.trim().length > 0).length
    : 0
  const decision = evaluateFusePressureSample(
    fusePressureState, pending, fuse.ratio, Date.now(),
    {
      pendingMin: 20,
      ratioMin: 0.95,
      sustainedMs: 5 * 60_000,        // 5 min of sustained pressure
      alertCooldownMs: 30 * 60_000,   // re-alert at most every 30 min
    },
  )
  if (decision.fire) {
    console.warn(`[orchestrator] cluster fuse pressure ALERT: ${decision.reason}`)
    void notifyAlert({
      label: 'orchestrator.cluster_fuse_pressure',
      error: new Error(`agent-pod cluster under sustained fuse pressure: ${decision.reason}`),
      extras: {
        pendingAgentPods: pending,
        fuseUsed: fuse.cap === Number.POSITIVE_INFINITY ? null : fuse.used,
        fuseCap: fuse.cap === Number.POSITIVE_INFINITY ? null : fuse.cap,
        fuseRatio: fuse.ratio,
      },
    })
  }
}

/** Start the cluster fuse-pressure monitor. */
export function startClusterFuseMonitor(intervalMs: number = 60_000): NodeJS.Timeout {
  const tick = (): void => {
    void pollClusterFusePressureOnce().catch((e) =>
      console.warn('[orchestrator] pollClusterFusePressureOnce threw:', e instanceof Error ? e.message : String(e)),
    )
  }
  setImmediate(tick)
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  return t
}

/** Start the GC loop. Returns the timer so the caller can clearInterval
 *  on shutdown. */
export function startCompletedPodGc(intervalMs: number = 60_000): NodeJS.Timeout {
  const tick = (): void => {
    void gcCompletedAgentPods().then((r) => {
      if (r.deleted > 0) {
        console.log(`[orchestrator] gc swept ${r.deleted} finished agent pods`)
      }
    }).catch((e) => {
      console.warn('[orchestrator] gcCompletedAgentPods threw:', e instanceof Error ? e.message : String(e))
    })
  }
  // Run once at boot, then on interval. tick.unref so the timer
  // doesn't keep the process alive on shutdown.
  setImmediate(tick)
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  return t
}
