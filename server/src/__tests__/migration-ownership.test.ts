import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readRepo = (path: string): Promise<string> => readFile(resolve(repoRoot, path), 'utf8')

test('application startup verifies schema compatibility and imports no migrator', async () => {
  const source = await readRepo('server/src/index.ts')
  assert.match(source, /verifySchemaWithBootRetry/)
  assert.doesNotMatch(source, /from ['"]\.\/db\/migrate\.js['"]/)
  assert.doesNotMatch(source, /ensureSchema/)
})

test('application Pod manifests contain no per-replica migration container', async () => {
  for (const path of [
    'server/k8s/cumora-server.gke.yaml',
    'server/k8s/cumora-server.orbstack.yaml',
  ]) {
    const manifest = await readRepo(path)
    assert.doesNotMatch(manifest, /^\s*- name: migrate\s*$/m, `${path} must not run DDL per replica`)
    assert.doesNotMatch(manifest, /command:\s*\["npm",\s*"run",\s*"migrate"\]/)
  }
})

test('production deploy migrates before one atomic Deployment mutation', async () => {
  const workflow = await readRepo('.github/workflows/deploy.yml')
  const migrationAt = workflow.indexOf('- name: Run candidate migrations once')
  const patchAt = workflow.indexOf('- name: Patch deployment')
  assert.ok(migrationAt >= 0, 'deploy must create a single candidate migration Job')
  assert.ok(patchAt > migrationAt, 'migration must complete before Deployment mutation')
  assert.match(workflow, /kind:\s*"Job"/)
  assert.match(workflow, /Candidate database migration did not complete; deployment was not mutated/)
  assert.match(workflow, /\{ name: "migrate", "\$patch": "delete" \}/)
})
