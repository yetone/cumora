import { createHash } from 'node:crypto'

/**
 * Deployment recovery is deliberately a data-only module.  The workflow owns
 * kubectl, while this module owns the objects passed to kubectl and all of the
 * compare-and-swap rules.  Keeping those rules here lets tests exercise the
 * exact patch and Job objects used in production without contacting a cluster.
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = unknown
export type JsonObject = Record<string, unknown>

export interface PodTemplateSpec {
  containers: JsonObject[]
  initContainers?: JsonObject[]
  serviceAccountName?: string
  imagePullSecrets?: JsonValue
  securityContext?: JsonValue
  volumes?: JsonValue
  [key: string]: unknown
}

export interface PodTemplate {
  metadata: JsonObject
  spec: PodTemplateSpec
  [key: string]: unknown
}

export interface JsonPatchOperation {
  op: 'test' | 'replace'
  path: string
  value: JsonValue
}

export interface DeploymentHealth {
  generation: number | null
  observedGeneration: number | null
  desiredReplicas: number | null
  updatedReplicas: number | null
  readyReplicas: number | null
  availableReplicas: number | null
}

export interface DeploymentSnapshot {
  apiVersion: string
  kind: 'Deployment'
  name: string
  namespace: string
  uid: string
  podTemplate: PodTemplate
  podTemplateHash: string
  serverImage: string
  agentImage: string | null
  agentImageSource: 'missing' | 'inline' | 'unknown'
  baselineImage: { server: string; agent: string | null }
  health: DeploymentHealth
  baselineSmokePassed?: boolean
  baselineVerifiedAt?: string
  capturedAt: string
}

export interface DeploymentReceipt {
  uid: string
  name: string
  namespace: string
  podTemplate: PodTemplate
  podTemplateHash: string
  serverImage: string
  agentImage: string | null
  agentImageSource: 'missing' | 'inline' | 'unknown'
  baselineImage: { server: string; agent: string | null }
  observedAt: string
}

export interface CandidateImages {
  server: string
  /** Omit to preserve the baseline agent image. */
  agent?: string
}

export interface MigrationJobOptions {
  name: string
  image: string
  repairMode: 'off' | 'archive-detach'
  activeDeadlineSeconds?: number
  ttlSecondsAfterFinished?: number
}

export interface SchemaVerifierJobOptions {
  name: string
  image: string
  activeDeadlineSeconds?: number
  ttlSecondsAfterFinished?: number
}

export interface SchemaVerifierResult {
  [key: string]: unknown
  protocol: 1
  kind: 'schema-verifier'
  status: 'compatible' | 'incompatible' | 'unknown'
  currentVersion: number | null
  minSupported: number | null
  maxSupported: number | null
  code?: 'schema_uninitialized' | 'schema_behind' | 'schema_ahead' | 'migration_history_invalid'
  reasonCode?: string
}

export const SCHEMA_VERIFIER_MARKER = 'CUMORA_SCHEMA_VERIFY_RESULT'

export const SCHEMA_INCOMPATIBLE_CODES = [
  'schema_uninitialized',
  'schema_behind',
  'schema_ahead',
  'migration_history_invalid',
] as const

export const SCHEMA_UNKNOWN_REASON_CODES = [
  'module_unavailable',
  'connection_failed',
  'timeout',
  'cleanup_failed',
] as const

const DIGEST_IMAGE_PATTERN = /@sha256:[a-f0-9]{64}$/

export const DEPLOYMENT_PROBE_CONTRACT = {
  startupProbe: {
    httpGet: { path: '/api/livez', port: 'http' },
    periodSeconds: 5,
    timeoutSeconds: 2,
    failureThreshold: 60,
  },
  readinessProbe: {
    httpGet: { path: '/api/health', port: 'http' },
    periodSeconds: 5,
    timeoutSeconds: 2,
  },
  livenessProbe: {
    httpGet: { path: '/api/livez', port: 'http' },
    periodSeconds: 30,
    timeoutSeconds: 3,
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function asJsonObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) throw new Error(`${label} must be a JSON object`)
  return value as JsonObject
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Sort object keys recursively while preserving array order. */
export function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeJson(child)]),
  ) as JsonObject
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeJson(value))).digest('hex')
}

export function hashPodTemplate(template: JsonObject | PodTemplate): string {
  return hashJson(template)
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function assertDigestImage(value: unknown, label: string): string {
  const image = readString(value, label)
  if (!DIGEST_IMAGE_PATTERN.test(image)) throw new Error(`${label} must be pinned by sha256 digest`)
  return image
}

function getObjectPath(root: unknown, path: string[], label: string): Record<string, unknown> {
  let current: unknown = root
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) throw new Error(`${label} is missing ${path.join('.')}`)
    current = current[segment]
  }
  if (!isRecord(current)) throw new Error(`${label} ${path.join('.')} must be an object`)
  return current
}

function getArrayPath(root: unknown, path: string[], label: string): unknown[] {
  let current: unknown = root
  for (const segment of path) {
    if (!isRecord(current) || !(segment in current)) throw new Error(`${label} is missing ${path.join('.')}`)
    current = current[segment]
  }
  if (!Array.isArray(current)) throw new Error(`${label} ${path.join('.')} must be an array`)
  return current
}

function findNamedObject(items: unknown[], name: string, label: string): Record<string, unknown> {
  const found = items.find((item) => isRecord(item) && item.name === name)
  if (!isRecord(found)) throw new Error(`${label} is missing ${name}`)
  return found
}

function agentImageValue(container: Record<string, unknown>, name: string): { value: string | null; source: 'missing' | 'inline' | 'unknown' } {
  const env = container.env
  if (!Array.isArray(env)) return { value: null, source: 'missing' }
  const entry = env.find((item) => isRecord(item) && item.name === name)
  if (!isRecord(entry)) return { value: null, source: 'missing' }
  if (typeof entry.value !== 'string') return { value: null, source: 'unknown' }
  return { value: entry.value, source: 'inline' }
}

function deploymentPodTemplate(deployment: unknown): PodTemplate {
  const template = asJsonObject(getObjectPath(deployment, ['spec', 'template'], 'Deployment'), 'Deployment pod template')
  if (!isRecord(template.metadata) || !isRecord(template.spec)) throw new Error('Deployment pod template must contain metadata and spec')
  if (!Array.isArray(template.spec.containers)) throw new Error('Deployment pod template spec.containers must be an array')
  return template as PodTemplate
}

function deploymentServerContainer(template: JsonObject): JsonObject {
  const containers = getArrayPath(template, ['spec', 'containers'], 'Deployment pod template')
  return asJsonObject(findNamedObject(containers, 'server', 'Deployment pod template containers'), 'server container')
}

export function extractDeploymentSnapshot(
  deployment: unknown,
  opts: { expectedName?: string; expectedNamespace?: string; capturedAt?: string } = {},
): DeploymentSnapshot {
  const metadata = getObjectPath(deployment, ['metadata'], 'Deployment')
  const template = deploymentPodTemplate(deployment)
  const server = deploymentServerContainer(template)
  const uid = readString(metadata.uid, 'Deployment metadata.uid')
  const apiVersion = readString((deployment as Record<string, unknown>).apiVersion, 'Deployment apiVersion')
  if (apiVersion !== 'apps/v1') throw new Error(`unsupported Deployment apiVersion: ${apiVersion}`)
  const kind = readString((deployment as Record<string, unknown>).kind, 'Deployment kind')
  if (kind !== 'Deployment') throw new Error(`expected Deployment, got ${kind}`)
  const name = readString(metadata.name, 'Deployment metadata.name')
  // kubectl includes metadata.namespace.  Fixtures and an unqualified local
  // object can omit it; Kubernetes resolves those to the default namespace.
  const namespace = typeof metadata.namespace === 'string' && metadata.namespace.length > 0 ? metadata.namespace : 'default'
  if (opts.expectedName && name !== opts.expectedName) throw new Error(`unexpected Deployment name: ${name}`)
  if (opts.expectedNamespace && namespace !== opts.expectedNamespace) throw new Error(`unexpected Deployment namespace: ${namespace}`)
  const serverImage = assertDigestImage(server.image, 'server container image')
  const agent = agentImageValue(server, 'CUMORA_AGENT_COMPUTER_IMAGE')
  if (agent.value !== null) assertDigestImage(agent.value, 'agent container image')
  return {
    apiVersion,
    kind: 'Deployment',
    name,
    namespace,
    uid,
    podTemplate: cloneJson(template),
    podTemplateHash: hashPodTemplate(template),
    serverImage,
    agentImage: agent.value,
    agentImageSource: agent.source,
    baselineImage: { server: serverImage, agent: agent.value },
    health: {
      generation: integerOrNull(metadata.generation),
      observedGeneration: integerOrNull(isRecord((deployment as Record<string, unknown>).status) ? (deployment as Record<string, Record<string, unknown>>).status.observedGeneration : null),
      desiredReplicas: integerOrNull(isRecord((deployment as Record<string, unknown>).spec) ? (deployment as Record<string, Record<string, unknown>>).spec.replicas : null),
      updatedReplicas: integerOrNull(isRecord((deployment as Record<string, unknown>).status) ? (deployment as Record<string, Record<string, unknown>>).status.updatedReplicas : null),
      readyReplicas: integerOrNull(isRecord((deployment as Record<string, unknown>).status) ? (deployment as Record<string, Record<string, unknown>>).status.readyReplicas : null),
      availableReplicas: integerOrNull(isRecord((deployment as Record<string, unknown>).status) ? (deployment as Record<string, Record<string, unknown>>).status.availableReplicas : null),
    },
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
  }
}

export function deploymentReceiptFromObject(
  deployment: unknown,
  opts: { observedAt?: string } = {},
): DeploymentReceipt {
  const snapshot = extractDeploymentSnapshot(deployment, { capturedAt: opts.observedAt })
  return {
    uid: snapshot.uid,
    name: snapshot.name,
    namespace: snapshot.namespace,
    podTemplate: snapshot.podTemplate,
    podTemplateHash: snapshot.podTemplateHash,
    serverImage: snapshot.serverImage,
    agentImage: snapshot.agentImage,
    agentImageSource: snapshot.agentImageSource,
    baselineImage: snapshot.baselineImage,
    observedAt: snapshot.capturedAt,
  }
}

function assertSnapshotShape(snapshot: DeploymentSnapshot): void {
  if (snapshot.kind !== 'Deployment') throw new Error('recovery baseline must describe a Deployment')
  if (snapshot.apiVersion !== 'apps/v1') throw new Error('recovery baseline must use apps/v1')
  readString(snapshot.uid, 'recovery baseline uid')
  readString(snapshot.name, 'recovery baseline name')
  readString(snapshot.namespace, 'recovery baseline namespace')
  if (!isRecord(snapshot.podTemplate)) throw new Error('recovery baseline podTemplate must be an object')
  const actualHash = hashPodTemplate(snapshot.podTemplate)
  if (actualHash !== snapshot.podTemplateHash) {
    throw new Error('recovery baseline podTemplateHash does not match podTemplate')
  }
  assertDigestImage(snapshot.serverImage, 'recovery baseline serverImage')
  if (snapshot.agentImage !== null && typeof snapshot.agentImage !== 'string') {
    throw new Error('recovery baseline agentImage must be a string or null')
  }
  if (snapshot.agentImage !== null) assertDigestImage(snapshot.agentImage, 'recovery baseline agentImage')
  if (!['missing', 'inline', 'unknown'].includes(snapshot.agentImageSource)) throw new Error('invalid recovery baseline agent image source')
  if (snapshot.baselineImage?.server !== snapshot.serverImage || snapshot.baselineImage?.agent !== snapshot.agentImage) {
    throw new Error('recovery baseline baselineImage does not match image fields')
  }
  const server = deploymentServerContainer(snapshot.podTemplate)
  if (server.image !== snapshot.serverImage) throw new Error('recovery baseline server image does not match podTemplate')
  const agent = agentImageValue(server, 'CUMORA_AGENT_COMPUTER_IMAGE')
  if (agent.value !== snapshot.agentImage || agent.source !== snapshot.agentImageSource) {
    throw new Error('recovery baseline agent image does not match podTemplate')
  }
}

export function assertBaselineUnchanged(existing: DeploymentSnapshot, candidate: DeploymentSnapshot | DeploymentReceipt): void {
  assertSnapshotShape(existing)
  if ('apiVersion' in candidate) assertSnapshotShape(candidate)
  else assertReceiptShape(candidate)
  if (existing.uid !== candidate.uid || existing.podTemplateHash !== candidate.podTemplateHash) {
    throw new Error('recovery baseline already exists and differs; refusing to replace it')
  }
}

export function assertDeploymentHealthy(snapshot: DeploymentSnapshot): void {
  const health = snapshot.health
  if (!health || health.generation === null || health.observedGeneration !== health.generation) {
    throw new Error('Deployment baseline rollout is not observed')
  }
  if (
    health.desiredReplicas === null ||
    health.updatedReplicas !== health.desiredReplicas ||
    health.readyReplicas !== health.desiredReplicas ||
    health.availableReplicas !== health.desiredReplicas
  ) {
    throw new Error('Deployment baseline rollout replicas are not healthy')
  }
}

export function assertRecoveryEligible(baseline: DeploymentSnapshot): void {
  assertDeploymentHealthy(baseline)
  if (baseline.baselineSmokePassed !== true) {
    throw new Error('Deployment baseline smoke was not proven before migration')
  }
}

function patchContainer(
  template: PodTemplate,
  images: CandidateImages,
): PodTemplate {
  assertDigestImage(images.server, 'candidate server image')
  if (images.agent !== undefined) assertDigestImage(images.agent, 'candidate agent image')
  const patched = cloneJson(template)
  const spec = patched.spec
  const containers = spec.containers
  const server = asJsonObject(findNamedObject(containers, 'server', 'pod template containers'), 'server container')
  server.image = images.server
  server.startupProbe = cloneJson(DEPLOYMENT_PROBE_CONTRACT.startupProbe as unknown as JsonObject)
  server.readinessProbe = cloneJson(DEPLOYMENT_PROBE_CONTRACT.readinessProbe as unknown as JsonObject)
  server.livenessProbe = cloneJson(DEPLOYMENT_PROBE_CONTRACT.livenessProbe as unknown as JsonObject)

  if (images.agent !== undefined) {
    const env = Array.isArray(server.env) ? server.env.filter((entry) => !(isRecord(entry) && entry.name === 'CUMORA_AGENT_COMPUTER_IMAGE')) : []
    env.push({ name: 'CUMORA_AGENT_COMPUTER_IMAGE', value: images.agent })
    server.env = env as JsonValue
  }

  if (Array.isArray(spec.initContainers)) {
    spec.initContainers = spec.initContainers.filter((entry) => !(isRecord(entry) && entry.name === 'migrate')) as JsonObject[]
  }
  return patched as PodTemplate
}

export function buildCandidateTemplate(baseline: DeploymentSnapshot, images: CandidateImages): PodTemplate {
  assertSnapshotShape(baseline)
  return patchContainer(baseline.podTemplate, images)
}

function jsonPatchTest(path: string, value: JsonValue): JsonPatchOperation {
  return { op: 'test', path, value: cloneJson(value) }
}

function jsonPatchReplace(path: string, value: JsonValue): JsonPatchOperation {
  return { op: 'replace', path, value: cloneJson(value) }
}

export function buildCandidatePatch(
  baseline: DeploymentSnapshot,
  images: CandidateImages,
): JsonPatchOperation[] {
  assertSnapshotShape(baseline)
  const candidate = buildCandidateTemplate(baseline, images)
  return [
    jsonPatchTest('/metadata/uid', baseline.uid),
    jsonPatchTest('/spec/template', baseline.podTemplate),
    jsonPatchReplace('/spec/template', candidate),
  ]
}

export function buildRestorePatch(
  baseline: DeploymentSnapshot,
  current: DeploymentReceipt,
  expectedCandidateHash: string,
): JsonPatchOperation[] {
  assertSnapshotShape(baseline)
  assertReceiptShape(current)
  if (baseline.agentImageSource === 'unknown' || current.agentImageSource === 'unknown') {
    throw new Error('agent image valueFrom is not a safe automatic recovery baseline')
  }
  if (current.uid !== baseline.uid) throw new Error('Deployment UID changed; refusing automatic recovery')
  if (current.podTemplateHash !== expectedCandidateHash) {
    throw new Error('Deployment pod template drifted from the candidate receipt; refusing automatic recovery')
  }
  return [
    jsonPatchTest('/metadata/uid', baseline.uid),
    jsonPatchTest('/spec/template', current.podTemplate),
    jsonPatchReplace('/spec/template', baseline.podTemplate),
  ]
}

function assertReceiptShape(receipt: DeploymentReceipt): void {
  readString(receipt.uid, 'candidate receipt uid')
  readString(receipt.name, 'candidate receipt name')
  readString(receipt.namespace, 'candidate receipt namespace')
  if (!isRecord(receipt.podTemplate)) throw new Error('candidate receipt podTemplate must be an object')
  if (hashPodTemplate(receipt.podTemplate) !== receipt.podTemplateHash) {
    throw new Error('candidate receipt podTemplateHash does not match podTemplate')
  }
  assertDigestImage(receipt.serverImage, 'candidate receipt serverImage')
  if (receipt.agentImage !== null) assertDigestImage(receipt.agentImage, 'candidate receipt agentImage')
  if (!['missing', 'inline', 'unknown'].includes(receipt.agentImageSource)) throw new Error('invalid candidate receipt agent image source')
  if (receipt.baselineImage?.server !== receipt.serverImage || receipt.baselineImage?.agent !== receipt.agentImage) {
    throw new Error('candidate receipt baselineImage does not match image fields')
  }
  const server = deploymentServerContainer(receipt.podTemplate)
  if (server.image !== receipt.serverImage) throw new Error('candidate receipt server image does not match podTemplate')
  const agent = agentImageValue(server, 'CUMORA_AGENT_COMPUTER_IMAGE')
  if (agent.value !== receipt.agentImage || agent.source !== receipt.agentImageSource) {
    throw new Error('candidate receipt agent image does not match podTemplate')
  }
}

export function assertReceiptShapeForRecovery(receipt: DeploymentReceipt): void {
  assertReceiptShape(receipt)
}

export function assertRecoveryStateBinding(
  baseline: DeploymentSnapshot,
  receipt: DeploymentReceipt,
): void {
  assertSnapshotShape(baseline)
  assertReceiptShape(receipt)
  if (baseline.uid !== receipt.uid || baseline.name !== receipt.name || baseline.namespace !== receipt.namespace) {
    throw new Error('protected recovery receipt is bound to a different Deployment')
  }
}

function cleanContainerForJob(container: JsonObject): JsonObject {
  const result = cloneJson(container)
  for (const field of [
    'ports',
    'startupProbe',
    'readinessProbe',
    'livenessProbe',
    'lifecycle',
    'terminationMessagePath',
    'terminationMessagePolicy',
  ]) delete result[field]
  return result
}

function podSpecForJob(template: JsonObject): { pod: JsonObject; server: JsonObject; proxy: JsonObject; proxyStartupProbe: JsonValue } {
  const spec = asJsonObject(getObjectPath(template, ['spec'], 'pod template'), 'pod template spec')
  const allInit = Array.isArray(spec.initContainers) ? spec.initContainers : []
  const allContainers = getArrayPath(spec, ['containers'], 'pod template')
  const proxySource = [...allInit, ...allContainers].find((item) => isRecord(item) && item.name === 'cloud-sql-proxy')
  if (!isRecord(proxySource)) throw new Error('Deployment pod template has no cloud-sql-proxy container')
  const server = findNamedObject(allContainers, 'server', 'pod template containers')
  const pod = cloneJson(spec)
  delete pod.containers
  delete pod.initContainers
  delete pod.ephemeralContainers
  const proxyStartupProbe = isJsonValue(proxySource.startupProbe)
    ? cloneJson(proxySource.startupProbe)
    : {
        httpGet: { path: '/readiness', port: 9090 },
        periodSeconds: 1,
        failureThreshold: 60,
      }
  return { pod, server: cleanContainerForJob(server), proxy: cleanContainerForJob(proxySource), proxyStartupProbe }
}

function upsertEnv(container: JsonObject, name: string, value: string): void {
  const env = Array.isArray(container.env) ? container.env.filter((entry) => !(isRecord(entry) && entry.name === name)) : []
  env.push({ name, value })
  container.env = env as JsonValue
}

function jobBase(
  template: JsonObject,
  options: { name: string; image: string; command: string[]; args?: string[] },
): { metadata: JsonObject; spec: JsonObject; pod: JsonObject; server: JsonObject; proxy: JsonObject } {
  const { pod, server, proxy, proxyStartupProbe } = podSpecForJob(template)
  server.name = 'migrate'
  server.image = options.image
  server.imagePullPolicy = 'IfNotPresent'
  server.command = options.command as unknown as JsonValue
  delete server.args
  if (options.args) server.args = options.args as unknown as JsonValue
  server.workingDir = '/app'
  pod.restartPolicy = 'Never'
  pod.initContainers = [
    {
      ...proxy,
      name: 'cloud-sql-proxy',
      restartPolicy: 'Always',
      startupProbe: proxyStartupProbe,
    },
  ] as unknown as JsonValue
  pod.containers = [server] as unknown as JsonValue
  return {
    metadata: {
      name: options.name,
      labels: { app: 'cumora-schema-recovery' },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: 600,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { app: 'cumora-schema-recovery', 'recovery.cumora.ai/managed': 'true' } },
        spec: pod,
      },
    },
    pod,
    server,
    proxy,
  }
}

export function buildMigrationJob(
  baseline: DeploymentSnapshot,
  options: MigrationJobOptions,
): JsonObject {
  assertSnapshotShape(baseline)
  assertDigestImage(options.image, 'migration image')
  if (!['off', 'archive-detach'].includes(options.repairMode)) throw new Error('invalid migration repair mode')
  const result = jobBase(baseline.podTemplate, {
    name: options.name,
    image: options.image,
    command: ['npm', 'run', 'migrate'],
  })
  result.spec.activeDeadlineSeconds = options.activeDeadlineSeconds ?? 600
  result.spec.ttlSecondsAfterFinished = options.ttlSecondsAfterFinished ?? 600
  upsertEnv(result.server, 'MIGRATION_0002_REPAIR', options.repairMode)
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: result.metadata,
    spec: result.spec,
  }
}

/**
 * This is injected into the old server image during recovery.  It imports the
 * old image's own pool, schema gate, and manifest, so a newer checkout cannot
 * accidentally decide that an old image is compatible.  The program writes a
 * single marker line and nothing else; the parser below fails closed on any
 * extra or malformed output.
 */
export function buildSchemaVerifierScript(): string {
  const marker = JSON.stringify(SCHEMA_VERIFIER_MARKER)
  return `
const marker = ${marker};
let result = { status: "unknown", reasonCode: "module_unavailable", currentVersion: null, minSupported: null, maxSupported: null };
let client;
let pool;
let MigrationHistoryError;
let manifest;
let began = false;
let committed = false;
try {
  const [poolModule, schemaModule, manifestModule] = await Promise.all([
    import("./server/src/db/pool.ts"),
    import("./server/src/db/schema-version.ts"),
    import("./server/src/db/migrations/manifest.ts"),
  ]);
  pool = poolModule.pool;
  const verifySchemaCompatibility = schemaModule.verifySchemaCompatibility;
  MigrationHistoryError = manifestModule.MigrationHistoryError;
  manifest = manifestModule;
  if (!pool || typeof pool.connect !== "function" || typeof verifySchemaCompatibility !== "function" || typeof MigrationHistoryError !== "function") throw new Error("verifier modules unavailable");
  if (!Number.isInteger(manifest.MIN_SUPPORTED_SCHEMA_VERSION) || !Number.isInteger(manifest.MAX_SUPPORTED_SCHEMA_VERSION)) throw new Error("verifier manifest unavailable");
  client = await pool.connect();
  result.minSupported = manifest.MIN_SUPPORTED_SCHEMA_VERSION;
  result.maxSupported = manifest.MAX_SUPPORTED_SCHEMA_VERSION;
  await client.query("BEGIN READ ONLY");
  began = true;
  await client.query("SET LOCAL statement_timeout = '30000ms'");
  const version = await verifySchemaCompatibility(client);
  if (!Number.isInteger(version) || version < result.minSupported || version > result.maxSupported) throw new Error("invalid schema version");
  await client.query("COMMIT");
  committed = true;
  result = { status: "compatible", currentVersion: version, minSupported: result.minSupported, maxSupported: result.maxSupported };
} catch (error) {
  result = typeof MigrationHistoryError === "function" && error instanceof MigrationHistoryError
    ? { status: "incompatible", code: ["schema_uninitialized", "schema_behind", "schema_ahead", "migration_history_invalid"].includes(error.code) ? error.code : "migration_history_invalid", currentVersion: null, minSupported: result.minSupported, maxSupported: result.maxSupported }
    : { status: "unknown", reasonCode: /timeout|deadline/i.test(String(error)) ? "timeout" : (pool ? "connection_failed" : "module_unavailable"), currentVersion: null, minSupported: result.minSupported, maxSupported: result.maxSupported };
  if (began && !committed && client) {
    try { await client.query("ROLLBACK"); } catch {}
  }
} finally {
  try { if (client) client.release(); } catch { result = { status: "unknown", reasonCode: "cleanup_failed", currentVersion: null, minSupported: result.minSupported, maxSupported: result.maxSupported }; }
  try { if (pool) await pool.end(); } catch { result = { status: "unknown", reasonCode: "cleanup_failed", currentVersion: null, minSupported: result.minSupported, maxSupported: result.maxSupported }; }
}
process.stdout.write(marker + " " + JSON.stringify({ protocol: 1, kind: "schema-verifier", ...result }) + "\\n");
`
}

export function buildSchemaVerifierJob(
  baseline: DeploymentSnapshot,
  options: SchemaVerifierJobOptions,
): JsonObject {
  assertSnapshotShape(baseline)
  if (options.image !== baseline.serverImage) {
    throw new Error('schema verifier image must be the captured baseline server image')
  }
  const result = jobBase(baseline.podTemplate, {
    name: options.name,
    image: options.image,
    command: ['node', '--import', 'tsx', '--input-type=module', '-e'],
    args: [buildSchemaVerifierScript()],
  })
  // Cloud SQL proxy startup (up to 60s), image scheduling/pull, the bounded
  // five-second pool connection, and the 30s read-only query all need room
  // before the Job is considered a verifier timeout.
  result.spec.activeDeadlineSeconds = options.activeDeadlineSeconds ?? 180
  result.spec.ttlSecondsAfterFinished = options.ttlSecondsAfterFinished ?? 600
  result.metadata.labels = {
    app: 'cumora-schema-recovery',
    'recovery.cumora.ai/managed': 'true',
    'recovery.cumora.ai/read-only': 'true',
  }
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: result.metadata,
    spec: result.spec,
  }
}

function parseMarkerValue(value: unknown): SchemaVerifierResult | null {
  if (!isRecord(value)) return null
  if (value.protocol !== 1 || value.kind !== 'schema-verifier') return null
  const currentVersion = value.currentVersion === undefined ? null : value.currentVersion
  const minSupported = value.minSupported === undefined ? null : value.minSupported
  const maxSupported = value.maxSupported === undefined ? null : value.maxSupported
  if (currentVersion !== null && !Number.isInteger(currentVersion)) return null
  if (minSupported !== null && !Number.isInteger(minSupported)) return null
  if (maxSupported !== null && !Number.isInteger(maxSupported)) return null
  if (value.status === 'compatible') {
    if (
      !Number.isInteger(currentVersion) ||
      !Number.isInteger(minSupported) ||
      !Number.isInteger(maxSupported) ||
      (currentVersion as number) < (minSupported as number) ||
      (currentVersion as number) > (maxSupported as number)
    ) return null
    return {
      protocol: 1,
      kind: 'schema-verifier',
      status: 'compatible',
      currentVersion: currentVersion as number,
      minSupported: minSupported as number,
      maxSupported: maxSupported as number,
    }
  }
  if (value.status === 'incompatible' && typeof value.code === 'string' && SCHEMA_INCOMPATIBLE_CODES.includes(value.code as typeof SCHEMA_INCOMPATIBLE_CODES[number])) {
    return {
      protocol: 1,
      kind: 'schema-verifier',
      status: 'incompatible',
      currentVersion: Number.isInteger(currentVersion) ? currentVersion as number : null,
      minSupported: Number.isInteger(minSupported) ? minSupported as number : null,
      maxSupported: Number.isInteger(maxSupported) ? maxSupported as number : null,
      code: value.code as SchemaVerifierResult['code'],
    }
  }
  if (value.status === 'unknown' && typeof value.reasonCode === 'string' && SCHEMA_UNKNOWN_REASON_CODES.includes(value.reasonCode as typeof SCHEMA_UNKNOWN_REASON_CODES[number])) {
    return {
      protocol: 1,
      kind: 'schema-verifier',
      status: 'unknown',
      currentVersion: Number.isInteger(currentVersion) ? currentVersion as number : null,
      minSupported: Number.isInteger(minSupported) ? minSupported as number : null,
      maxSupported: Number.isInteger(maxSupported) ? maxSupported as number : null,
      reasonCode: value.reasonCode as string,
    }
  }
  return null
}

export function parseSchemaVerifierOutput(stdout: string, stderr = ''): SchemaVerifierResult {
  const combined = `${stdout}${stderr.length > 0 ? `\n${stderr}` : ''}`
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const markerLines = lines.filter((line) => line.startsWith(SCHEMA_VERIFIER_MARKER))
  if (markerLines.length !== 1) return unknownVerifierResult('bad_output')
  const markerLine = markerLines[0]
  if (!markerLine.startsWith(`${SCHEMA_VERIFIER_MARKER} `)) return unknownVerifierResult('bad_output')
  const payload = markerLine.slice(SCHEMA_VERIFIER_MARKER.length + 1)
  const nonMarkerLines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(`${SCHEMA_VERIFIER_MARKER} `))
  if (nonMarkerLines.length > 0) return unknownVerifierResult('bad_output')
  try {
    const value = JSON.parse(payload) as unknown
    return parseMarkerValue(value) ?? unknownVerifierResult('protocol_error')
  } catch {
    return unknownVerifierResult('bad_output')
  }
}

function unknownVerifierResult(reasonCode: SchemaVerifierResult['reasonCode']): SchemaVerifierResult {
  return {
    protocol: 1,
    kind: 'schema-verifier',
    status: 'unknown',
    currentVersion: null,
    minSupported: null,
    maxSupported: null,
    reasonCode,
  }
}

export function assertCompatibleVerifierResult(result: SchemaVerifierResult): asserts result is SchemaVerifierResult & { status: 'compatible'; currentVersion: number; minSupported: number; maxSupported: number } {
  if (
    result.protocol !== 1 ||
    result.kind !== 'schema-verifier' ||
    result.status !== 'compatible' ||
    !Number.isInteger(result.currentVersion) ||
    !Number.isInteger(result.minSupported) ||
    !Number.isInteger(result.maxSupported) ||
    (result.currentVersion as number) < (result.minSupported as number) ||
    (result.currentVersion as number) > (result.maxSupported as number)
  ) {
    throw new Error(`old image schema verifier did not prove compatibility (${result.status})`)
  }
}

export function assertDeploymentReceiptMatches(
  baseline: DeploymentSnapshot,
  current: DeploymentReceipt,
  expectedCandidateHash: string,
): void {
  assertSnapshotShape(baseline)
  assertReceiptShape(current)
  if (current.uid !== baseline.uid) throw new Error('Deployment UID changed since baseline capture')
  if (current.podTemplateHash !== expectedCandidateHash) {
    throw new Error('Deployment template changed since candidate patch')
  }
}

export function assertCandidateReceiptMatches(
  baseline: DeploymentSnapshot,
  receipt: DeploymentReceipt,
  images: CandidateImages,
): void {
  assertSnapshotShape(baseline)
  assertReceiptShape(receipt)
  if (receipt.uid !== baseline.uid || receipt.name !== baseline.name || receipt.namespace !== baseline.namespace) {
    throw new Error('candidate receipt Deployment identity changed')
  }
  if (receipt.serverImage !== images.server) throw new Error('candidate receipt server image does not match selected digest')
  const expectedAgent = images.agent ?? baseline.agentImage
  if (receipt.agentImage !== expectedAgent) throw new Error('candidate receipt agent image does not match selected digest')
  if (images.agent === undefined && receipt.agentImageSource !== baseline.agentImageSource) {
    throw new Error('candidate receipt agent image source changed')
  }
}
