import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEPLOYMENT_PROBE_CONTRACT,
  SCHEMA_VERIFIER_MARKER,
  assertBaselineUnchanged,
  buildCandidatePatch,
  buildCandidateTemplate,
  buildMigrationJob,
  buildRestorePatch,
  buildSchemaVerifierJob,
  buildSchemaVerifierScript,
  deploymentReceiptFromObject,
  extractDeploymentSnapshot,
  hashPodTemplate,
  parseSchemaVerifierOutput,
} from '../deploy/recovery.js'

const DIGEST_OLD = 'a'.repeat(64)
const DIGEST_NEW = 'b'.repeat(64)
const DIGEST_CANDIDATE = 'c'.repeat(64)
const DIGEST_PROXY = 'd'.repeat(64)
const DIGEST_MIGRATE = 'e'.repeat(64)

function deploymentFixture(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'cumora-server', uid: 'deployment-uid-1' },
    spec: {
      template: {
        metadata: { labels: { app: 'cumora-server' }, annotations: { trace: 'fixture' } },
        spec: {
          serviceAccountName: 'cumora-server',
          imagePullSecrets: [{ name: 'quay-pull' }],
          securityContext: {
            runAsNonRoot: true,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          automountServiceAccountToken: true,
          volumes: [
            { name: 'proxy-cert', secret: { secretName: 'cloud-sql-cert' } },
            { name: 'scratch', emptyDir: {} },
          ],
          initContainers: [
            {
              name: 'migrate',
              image: `old-migrate@sha256:${DIGEST_MIGRATE}`,
              command: ['npm', 'run', 'migrate'],
            },
          ],
          containers: [
            {
              name: 'cloud-sql-proxy',
              image: `cloud-sql-proxy@sha256:${DIGEST_PROXY}`,
              args: ['--port=5432'],
              env: [{ name: 'PROXY_MODE', value: 'fixture' }],
              volumeMounts: [{ name: 'proxy-cert', mountPath: '/var/run/proxy', readOnly: true }],
              securityContext: {
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
              },
              readinessProbe: { httpGet: { path: '/readiness', port: 9090 } },
              resources: { requests: { cpu: '50m', memory: '64Mi' } },
            },
            {
              name: 'server',
              image: `server@sha256:${DIGEST_OLD}`,
              envFrom: [{ secretRef: { name: 'cumora' } }],
              env: [{ name: 'CUMORA_AGENT_COMPUTER_IMAGE', value: `agent@sha256:${DIGEST_OLD}` }],
              volumeMounts: [{ name: 'scratch', mountPath: '/tmp/cumora' }],
              securityContext: { runAsUser: 1000, allowPrivilegeEscalation: false },
              startupProbe: DEPLOYMENT_PROBE_CONTRACT.startupProbe,
              readinessProbe: DEPLOYMENT_PROBE_CONTRACT.readinessProbe,
              livenessProbe: DEPLOYMENT_PROBE_CONTRACT.livenessProbe,
              resources: { requests: { cpu: '250m', memory: '512Mi' } },
            },
          ],
        },
      },
    },
  }
}

function snapshot() {
  return extractDeploymentSnapshot(deploymentFixture(), { capturedAt: '2026-09-10T00:00:00.000Z' })
}

function templateSpec(job: Record<string, any>): Record<string, any> {
  return job.spec.template.spec
}

test('captures immutable template and builds exact CAS candidate/restore patches', () => {
  const baseline = snapshot()
  const candidate = buildCandidateTemplate(baseline, {
    server: `server@sha256:${DIGEST_NEW}`,
    agent: `agent@sha256:${DIGEST_NEW}`,
  })
  const candidateRecord = candidate as any
  const baselineRecord = baseline.podTemplate as any
  const candidateServer = candidateRecord.spec.containers.find((container: any) => container.name === 'server')
  assert.equal(candidateServer.image, `server@sha256:${DIGEST_NEW}`)
  assert.equal(candidateServer.env.find((entry: any) => entry.name === 'CUMORA_AGENT_COMPUTER_IMAGE').value, `agent@sha256:${DIGEST_NEW}`)
  assert.deepEqual(candidateRecord.spec.volumes, baselineRecord.spec.volumes)
  assert.deepEqual(candidateRecord.spec.securityContext, baselineRecord.spec.securityContext)
  assert.deepEqual(candidateRecord.metadata, (baseline.podTemplate as any).metadata)
  assert.deepEqual(candidateRecord.spec.initContainers, [], 'retired migration init container must be removed')
  assert.deepEqual(candidateServer.startupProbe, DEPLOYMENT_PROBE_CONTRACT.startupProbe)
  assert.deepEqual(candidateServer.readinessProbe, DEPLOYMENT_PROBE_CONTRACT.readinessProbe)
  assert.deepEqual(candidateServer.livenessProbe, DEPLOYMENT_PROBE_CONTRACT.livenessProbe)

  const candidatePatch = buildCandidatePatch(baseline, { server: `server@sha256:${DIGEST_NEW}` })
  assert.deepEqual(candidatePatch[0], { op: 'test', path: '/metadata/uid', value: baseline.uid })
  assert.deepEqual(candidatePatch[1], { op: 'test', path: '/spec/template', value: baseline.podTemplate })
  assert.equal((candidatePatch[2] as any)?.op, 'replace')

  const candidateReceipt = deploymentReceiptFromObject({
    ...deploymentFixture(),
    spec: { template: candidate },
  }, { observedAt: '2026-09-10T00:01:00.000Z' })
  assert.equal(candidateReceipt.serverImage, `server@sha256:${DIGEST_NEW}`)
  assert.equal(candidateReceipt.agentImage, `agent@sha256:${DIGEST_NEW}`)
  assert.equal(candidateReceipt.podTemplateHash, hashPodTemplate(candidate))
  const restorePatch = buildRestorePatch(baseline, candidateReceipt, candidateReceipt.podTemplateHash)
  assert.deepEqual(restorePatch[0], { op: 'test', path: '/metadata/uid', value: baseline.uid })
  assert.deepEqual(restorePatch[1], { op: 'test', path: '/spec/template', value: candidate })
  assert.deepEqual(restorePatch[2], { op: 'replace', path: '/spec/template', value: baseline.podTemplate })
  assert.equal(hashPodTemplate(baseline.podTemplate), baseline.podTemplateHash)

  assertBaselineUnchanged(baseline, extractDeploymentSnapshot(deploymentFixture()))
  assert.throws(
    () => buildRestorePatch(baseline, { ...candidateReceipt, uid: 'other-uid' }, candidateReceipt.podTemplateHash),
    /UID changed/,
  )
  assert.throws(
    () => buildRestorePatch(baseline, candidateReceipt, 'wrong-candidate-hash'),
    /template drifted/,
  )

  const mutableDeployment = deploymentFixture()
  ;(mutableDeployment.spec as any).template.spec.containers[1].image = 'server:latest'
  assert.throws(
    () => extractDeploymentSnapshot(mutableDeployment),
    /digest|immutable|automatic recovery/i,
  )

  const missingServerImage = deploymentFixture()
  delete (missingServerImage.spec as any).template.spec.containers[1].image
  assert.throws(() => extractDeploymentSnapshot(missingServerImage), /server container image/)

  const valueFromServerImage = deploymentFixture()
  ;(valueFromServerImage.spec as any).template.spec.containers[1].image = { valueFrom: { configMapKeyRef: { name: 'image' } } }
  assert.throws(() => extractDeploymentSnapshot(valueFromServerImage), /server container image/)

  const shortDigestServerImage = deploymentFixture()
  ;(shortDigestServerImage.spec as any).template.spec.containers[1].image = 'server@sha256:shorthex'
  assert.throws(() => extractDeploymentSnapshot(shortDigestServerImage), /sha256 digest/)

  const mutableAgentImage = deploymentFixture()
  ;(mutableAgentImage.spec as any).template.spec.containers[1].env = [
    { name: 'CUMORA_AGENT_COMPUTER_IMAGE', value: 'agent:latest' },
  ]
  assert.throws(() => extractDeploymentSnapshot(mutableAgentImage), /agent container image|sha256 digest/)

  const valueFromAgentImage = deploymentFixture()
  ;(valueFromAgentImage.spec as any).template.spec.containers[1].env = [
    { name: 'CUMORA_AGENT_COMPUTER_IMAGE', valueFrom: { secretKeyRef: { name: 'agent-image' } } },
  ]
  const valueFromAgentBaseline = extractDeploymentSnapshot(valueFromAgentImage)
  const valueFromAgentReceipt = deploymentReceiptFromObject(valueFromAgentImage)
  assert.throws(
    () => buildRestorePatch(valueFromAgentBaseline, valueFromAgentReceipt, valueFromAgentReceipt.podTemplateHash),
    /agent.*image|valueFrom|automatic recovery/i,
  )
})

test('migration and verifier Jobs preserve pod identity, mounts, volumes, and security contexts', () => {
  const baseline = snapshot()
  const migration = buildMigrationJob(baseline, {
    name: 'cumora-migrate-test',
    image: `server@sha256:${DIGEST_CANDIDATE}`,
    repairMode: 'off',
  })
  const verifier = buildSchemaVerifierJob(baseline, {
    name: 'cumora-verify-test',
    image: baseline.serverImage,
  })
  assert.throws(
    () => buildSchemaVerifierJob(baseline, { name: 'cumora-verify-candidate', image: `server@sha256:${DIGEST_CANDIDATE}` }),
    /baseline.*image|verifier.*image|old image/i,
  )

  for (const job of [migration, verifier]) {
    const pod = templateSpec(job)
    const baselineSpec = baseline.podTemplate as any
    assert.equal(pod.serviceAccountName, 'cumora-server')
    assert.deepEqual(pod.imagePullSecrets, baselineSpec.spec.imagePullSecrets)
    assert.deepEqual(pod.securityContext, baselineSpec.spec.securityContext)
    assert.deepEqual(pod.volumes, baselineSpec.spec.volumes)
    assert.equal(pod.restartPolicy, 'Never')
    const proxy = pod.initContainers.find((container: any) => container.name === 'cloud-sql-proxy')
    assert.ok(proxy)
    assert.deepEqual(proxy.volumeMounts, baselineSpec.spec.containers[0].volumeMounts)
    assert.deepEqual(proxy.securityContext, baselineSpec.spec.containers[0].securityContext)
    assert.equal(proxy.restartPolicy, 'Always')
    assert.ok(proxy.startupProbe)
    assert.ok(!pod.initContainers.some((container: any) => container.name === 'migrate'))
  }

  const migrationServer = templateSpec(migration).containers[0]
  assert.equal(migrationServer.name, 'migrate')
  assert.deepEqual(migrationServer.envFrom, [{ secretRef: { name: 'cumora' } }])
  assert.deepEqual(migrationServer.command, ['npm', 'run', 'migrate'])
  assert.equal(migrationServer.env.find((entry: any) => entry.name === 'MIGRATION_0002_REPAIR').value, 'off')

  const verifierServer = templateSpec(verifier).containers[0]
  assert.equal(verifierServer.name, 'migrate')
  assert.deepEqual(verifierServer.envFrom, [{ secretRef: { name: 'cumora' } }])
  assert.equal(verifierServer.workingDir, '/app')
  assert.equal((verifier.spec as { activeDeadlineSeconds?: number }).activeDeadlineSeconds, 180)
  assert.deepEqual(verifierServer.command.slice(0, 5), ['node', '--import', 'tsx', '--input-type=module', '-e'])
  assert.match(verifierServer.args?.[0] ?? '', /BEGIN READ ONLY/)
})

test('verifier script is old-image-local, read-only, bounded, and uses strict protocol output', () => {
  const script = buildSchemaVerifierScript()
  assert.match(script, /\.\/server\/src\/db\/pool\.ts/)
  assert.match(script, /\.\/server\/src\/db\/schema-version\.ts/)
  assert.match(script, /BEGIN READ ONLY/)
  assert.match(script, /COMMIT/)
  assert.match(script, /pool\.end\(\)/)
  assert.doesNotMatch(script, /\/app\/server\/src\/db/)

  const compatible = parseSchemaVerifierOutput(
    `${SCHEMA_VERIFIER_MARKER} ${JSON.stringify({
      protocol: 1,
      kind: 'schema-verifier',
      status: 'compatible',
      currentVersion: 7,
      minSupported: 7,
      maxSupported: 7,
    })}\n`,
  ) as unknown as Record<string, unknown>
  assert.equal(compatible.status, 'compatible')
  assert.equal(compatible.currentVersion, 7)
  assert.equal(compatible.minSupported, 7)
  assert.equal(compatible.maxSupported, 7)

  const incompatible = parseSchemaVerifierOutput(
    `${SCHEMA_VERIFIER_MARKER} ${JSON.stringify({
      protocol: 1, kind: 'schema-verifier', status: 'incompatible', currentVersion: null,
      minSupported: null, maxSupported: null, code: 'schema_ahead',
    })}\n`,
  ) as unknown as Record<string, unknown>
  assert.equal(incompatible.status, 'incompatible')
  assert.equal(incompatible.code, 'schema_ahead')

  const unknown = parseSchemaVerifierOutput(
    `${SCHEMA_VERIFIER_MARKER} ${JSON.stringify({
      protocol: 1, kind: 'schema-verifier', status: 'unknown', currentVersion: null,
      minSupported: null, maxSupported: null, reasonCode: 'connection_failed',
    })}\n`,
  ) as unknown as Record<string, unknown>
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.reasonCode, 'connection_failed')

  for (const output of [
    '',
    `${SCHEMA_VERIFIER_MARKER} {"protocol":1,"kind":"schema-verifier","status":"compatible","currentVersion":7}\nextra\n`,
    `${SCHEMA_VERIFIER_MARKER} {"protocol":1,"kind":"schema-verifier","status":"compatible","currentVersion":0,"minSupported":7,"maxSupported":7}\n`,
    `${SCHEMA_VERIFIER_MARKER} {"protocol":1,"kind":"schema-verifier","status":"unknown"}\n`,
    `${SCHEMA_VERIFIER_MARKER} {bad-json}\n`,
    `${SCHEMA_VERIFIER_MARKER} {"protocol":1,"kind":"schema-verifier","status":"compatible","currentVersion":7,"minSupported":7,"maxSupported":7}\n${SCHEMA_VERIFIER_MARKER} {"protocol":1,"kind":"schema-verifier","status":"compatible","currentVersion":7,"minSupported":7,"maxSupported":7}\n`,
  ]) {
    assert.equal(parseSchemaVerifierOutput(output).status, 'unknown')
  }
})
