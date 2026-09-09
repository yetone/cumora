#!/usr/bin/env node

/*
 * A deliberately small kubectl-shaped process for deploy-release flow tests.
 *
 * The test owns the JSON state file.  This process only implements the reads
 * and create/apply/patch operations used by scripts/deploy-release.mjs; it
 * never talks to a Kubernetes API.  In particular, patching validates all
 * JSON Patch test operations before replacing anything, which models the
 * atomic CAS operation the production workflow relies on.
 */

import { readFile, writeFile } from 'node:fs/promises'

const statePath = process.env.FAKE_KUBECTL_STATE
if (!statePath) {
  process.stderr.write('FAKE_KUBECTL_STATE is required\n')
  process.exit(2)
}

const originalArgs = process.argv.slice(2)
const args = [...originalArgs]
if (args[0] === '-n') args.splice(0, 2)
const command = args.shift()

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sorted(child)]))
  }
  return value
}

function equal(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right))
}

function pointerSegments(path) {
  if (path === '') return []
  if (!path.startsWith('/')) throw new Error(`invalid JSON pointer ${path}`)
  return path.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function readPointer(root, path) {
  let value = root
  for (const segment of pointerSegments(path)) value = value?.[segment]
  return value
}

async function loadState() {
  return JSON.parse(await readFile(statePath, 'utf8'))
}

async function saveState(state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function marker(state) {
  // `logs job/...` is intentionally consumed by the strict schema-verifier
  // parser, so keep that stream protocol-clean.  Every other kubectl call
  // may carry the marker: deploy-release captures child stderr and must not
  // echo it in its own result.
  if (command !== 'logs' && state.config?.emitSecretMarker !== false) {
    process.stderr.write(`${state.config?.secretMarker || 'FAKE_SECRET_MARKER'}\n`)
  }
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exitCode = code
}

function optionValue(list, name) {
  const index = list.indexOf(name)
  return index >= 0 ? list[index + 1] : undefined
}

function hasOption(list, name) {
  return list.includes(name)
}

async function stdinText() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function emit(value) {
  if (value !== undefined && value !== null) process.stdout.write(`${JSON.stringify(value)}\n`)
}

function deploymentContainer(deployment, name) {
  return deployment?.spec?.template?.spec?.containers?.find((container) => container?.name === name)
}

function serverImage(deployment) {
  return deploymentContainer(deployment, 'server')?.image
}

function bumpHealth(deployment) {
  const generation = Number(deployment.metadata?.generation || 1) + 1
  deployment.metadata = { ...deployment.metadata, generation }
  const replicas = Number(deployment.spec?.replicas || 1)
  deployment.status = {
    ...(deployment.status || {}),
    observedGeneration: generation,
    updatedReplicas: replicas,
    readyReplicas: replicas,
    availableReplicas: replicas,
  }
}

function mutateTemplate(template, kind) {
  const next = clone(template)
  next.metadata ??= {}
  next.metadata.annotations = { ...(next.metadata.annotations || {}), 'fake.cumora.ai/writer': kind }
  return next
}

function applyPatch(deployment, operations) {
  const candidate = clone(deployment)
  for (const operation of operations) {
    if (operation?.op !== 'test') continue
    if (!equal(readPointer(candidate, operation.path), operation.value)) {
      const error = new Error(`Conflict: JSON Patch test failed at ${operation.path}`)
      error.code = 'conflict'
      throw error
    }
  }
  for (const operation of operations) {
    if (operation?.op !== 'replace') continue
    if (!['/spec/template', '/metadata/uid'].includes(operation.path)) {
      throw new Error(`unsupported replace path ${operation.path}`)
    }
    if (operation.path === '/metadata/uid') candidate.metadata.uid = clone(operation.value)
    else candidate.spec.template = clone(operation.value)
  }
  return candidate
}

function decodeSecret(secret, key) {
  const encoded = secret?.data?.[key]
  if (typeof encoded !== 'string') return null
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

function encodeJson(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8').toString('base64')
}

function raceSecret(manifest, mode) {
  const raced = clone(manifest)
  if (mode === 'different') {
    const key = Object.keys(raced.data || {})[0]
    const decoded = decodeSecret(raced, key)
    if (decoded && typeof decoded === 'object') {
      if ('uid' in decoded) decoded.uid = 'raced-secret-uid'
      else decoded.podTemplateHash = 'raced-secret-hash'
      raced.data[key] = encodeJson(decoded)
    }
  }
  return raced
}

function jobStatus(state, job) {
  const isVerifier = job?.metadata?.labels?.['recovery.cumora.ai/read-only'] === 'true'
  const setting = isVerifier ? state.config?.verifierStatus : state.config?.migrationStatus
  if (setting === 'failed') return { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] }
  if (setting === 'pending' || setting === 'timedout') return { active: 1 }
  return { succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] }
}

function verifierOutput(state) {
  if (typeof state.config?.verifierLog === 'string') return state.config.verifierLog
  const markerName = 'CUMORA_SCHEMA_VERIFY_RESULT'
  const status = state.config?.verifierResult || 'compatible'
  if (status === 'compatible') {
    return `${markerName} ${JSON.stringify({ protocol: 1, kind: 'schema-verifier', status: 'compatible', currentVersion: 7, minSupported: 7, maxSupported: 7 })}\n`
  }
  if (status === 'unknown') {
    return `${markerName} ${JSON.stringify({ protocol: 1, kind: 'schema-verifier', status: 'unknown', reasonCode: 'connection_failed', currentVersion: null, minSupported: null, maxSupported: null })}\n`
  }
  if (status === 'malformed') return `${markerName} {bad-json}\n`
  return `${markerName} ${JSON.stringify({ protocol: 1, kind: 'schema-verifier', status: 'incompatible', code: status, currentVersion: null, minSupported: null, maxSupported: null })}\n`
}

async function commandGet(state) {
  const resource = args.shift()
  const name = resource === 'jobs' ? undefined : args.shift()
  if (resource === 'deployment') {
    if (state.config?.deploymentReadFailure) return fail(`Error from server (Forbidden): ${state.config.deploymentReadFailure}`)
    return emit(clone(state.deployment))
  }
  if (resource === 'secret') {
    if (state.config?.secretReadFailures?.[name]) return fail(`Error from server (Forbidden): ${state.config.secretReadFailures[name]}`)
    const secret = state.secrets?.[name]
    if (!secret) {
      if (hasOption(args, '--ignore-not-found')) return emit(undefined)
      return fail(`Error from server (NotFound): secrets "${name}" not found`)
    }
    return emit(clone(secret))
  }
  if (resource === 'job') {
    if (state.config?.jobReadFailures?.[name]) return fail(`Error from server (Forbidden): ${state.config.jobReadFailures[name]}`)
    const job = state.jobs?.[name]
    if (!job) {
      if (hasOption(args, '--ignore-not-found')) return emit(undefined)
      return fail(`Error from server (NotFound): jobs "${name}" not found`)
    }
    return emit(clone(job))
  }
  if (resource === 'jobs') {
    const selector = optionValue(args, '-l')
    const expectedApp = selector?.split('=')[1]
    const items = Object.values(state.jobs || {}).filter((job) => !expectedApp || job?.metadata?.labels?.app === expectedApp)
    if (state.config?.residualJobsReadFailure) return fail('Error from server (Forbidden): cannot list jobs')
    return emit({ apiVersion: 'batch/v1', kind: 'JobList', items: clone(items) })
  }
  return fail(`unsupported get resource ${resource}`)
}

async function commandCreate(state) {
  const manifest = JSON.parse(await stdinText())
  const name = manifest?.metadata?.name
  if (manifest?.kind !== 'Secret' || !name) return fail('fake kubectl only creates named Secrets')
  const configuredRace = state.config?.secretCreateRaces?.[name]
  const raceSeen = state.raceSeen?.[name]
  if (configuredRace && !raceSeen) {
    state.raceSeen ??= {}
    state.raceSeen[name] = true
    if (configuredRace === 'api-failure') {
      await saveState(state)
      return fail('Error from server (Forbidden): create Secret denied')
    }
    state.secrets ??= {}
    state.secrets[name] = raceSecret(manifest, configuredRace)
    await saveState(state)
    return fail(`Error from server (AlreadyExists): secrets "${name}" already exists`)
  }
  if (state.secrets?.[name]) return fail(`Error from server (AlreadyExists): secrets "${name}" already exists`)
  state.secrets ??= {}
  state.secrets[name] = manifest
  await saveState(state)
}

async function commandApply(state) {
  const manifest = JSON.parse(await stdinText())
  const name = manifest?.metadata?.name
  if (manifest?.kind !== 'Job' || !name) return fail('fake kubectl only applies Jobs')
  if (state.config?.applyJobFailure) return fail(`Error from server: ${state.config.applyJobFailure}`)
  if (state.config?.verifierStatus === 'missing' && manifest.metadata?.labels?.['recovery.cumora.ai/read-only'] === 'true') {
    await saveState(state)
    return
  }
  state.jobs ??= {}
  state.jobs[name] = { ...manifest, status: jobStatus(state, manifest) }
  state.history.appliedJobs.push(name)
  await saveState(state)
}

async function commandPatch(state) {
  const name = args.shift()
  const patchFile = optionValue(args, '--patch-file')
  let raw
  if (patchFile) raw = await readFile(patchFile, 'utf8')
  else {
    const inline = optionValue(args, '--patch')
    raw = inline ?? await stdinText()
  }
  const operations = JSON.parse(raw)
  let next
  try {
    next = applyPatch(state.deployment, operations)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  const baselineImage = state.config?.baselineServerImage
    || state.initialDeployment?.spec?.template?.spec?.containers?.find((container) => container?.name === 'server')?.image
  const restoring = serverImage(next) === baselineImage
  if (restoring && state.config?.restorePatchFailure) return fail(`Error from server: ${state.config.restorePatchFailure}`)
  if (!restoring && state.config?.candidatePatchFailure) return fail(`Error from server: ${state.config.candidatePatchFailure}`)

  bumpHealth(next)
  if (!restoring && state.config?.defaultCandidatePatchResponse) {
    next.spec.template = mutateTemplate(next.spec.template, 'api-default')
  }
  const response = clone(next)
  state.deployment = next
  state.phase = restoring ? 'restored' : 'candidate'
  state.history.patches.push({ name, operations: clone(operations), response: clone(response), phase: state.phase })
  if (restoring && state.config?.restoreSmoke === 'fail') state.phase = 'restored'
  await saveState(state)
  emit(response)

  if (!restoring && state.config?.switchWriterAfterCandidateResponse) {
    const writer = clone(state.deployment)
    writer.spec.template = mutateTemplate(writer.spec.template, 'other-writer')
    state.deployment = writer
    state.phase = 'other-writer'
    await saveState(state)
  }
}

async function commandRollout(state) {
  const subcommand = args.shift()
  const resource = args.shift()
  if (subcommand !== 'status') return fail(`unsupported rollout subcommand ${subcommand}`)
  if (!resource?.startsWith('deployment/')) return fail('unsupported rollout target')
  const baselineImage = state.config?.baselineServerImage
    || state.initialDeployment?.spec?.template?.spec?.containers?.find((container) => container?.name === 'server')?.image
  const restoring = serverImage(state.deployment) === baselineImage
  const setting = restoring ? state.config?.restoreRollout : state.config?.candidateRollout
  const failureMessage = restoring ? state.config?.restoreRolloutFailureMessage : state.config?.rolloutFailureMessage
  state.history.rollouts.push({
    phase: restoring ? 'restored' : 'candidate',
    setting: setting || 'success',
    ...(typeof failureMessage === 'string' ? { failureMessage } : {}),
  })
  if (!restoring && Number(state.config?.holdCandidateRolloutMs || 0) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Number(state.config.holdCandidateRolloutMs)))
  }
  if (!restoring && setting === 'drift-template') state.deployment.spec.template = mutateTemplate(state.deployment.spec.template, 'drift')
  if (!restoring && setting === 'drift-uid') state.deployment.metadata.uid = 'writer-changed-uid'
  if (!restoring && setting === 'progressing') {
    state.deployment.status = { ...(state.deployment.status || {}), observedGeneration: Number(state.deployment.metadata.generation) - 1, updatedReplicas: 0, readyReplicas: 0, availableReplicas: 0 }
  }
  await saveState(state)
  if (setting && setting !== 'success') return fail(failureMessage || `Error from server: rollout ${setting}`)
}

async function commandLogs(state) {
  const name = args.shift()?.replace(/^job\//, '')
  if (!state.jobs?.[name]) return fail(`Error from server (NotFound): jobs "${name}" not found`)
  emitRaw(verifierOutput(state))
}

function emitRaw(value) {
  process.stdout.write(value)
}

async function main() {
  const state = await loadState()
  state.secrets ??= {}
  state.jobs ??= {}
  state.history ??= { commands: [], patches: [], rollouts: [], appliedJobs: [] }
  state.history.commands.push({ args: originalArgs, at: new Date().toISOString() })
  await saveState(state)
  marker(state)
  if (command === 'get') await commandGet(state)
  else if (command === 'create') await commandCreate(state)
  else if (command === 'apply') await commandApply(state)
  else if (command === 'patch') await commandPatch(state)
  else if (command === 'rollout') await commandRollout(state)
  else if (command === 'logs') await commandLogs(state)
  else fail(`unsupported kubectl command ${command}`)
}

await main()
