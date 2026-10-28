import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'

import { LocalCollaboration } from '../agents/computer/local-collaboration.js'
import { LocalProjectStore } from '../agents/computer/local-project-store.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function parseRecord(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('expected a JSON object')
  return value
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  return stdout.trimEnd()
}

async function fixture(): Promise<{
  root: string
  repo: string
  homeRoot: string
  worktreeStorePath: string
  projectStorePath: string
  patchRoot: string
  local: LocalCollaboration
  anotherLocal: () => LocalCollaboration
}> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-local-collaboration-command-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const homeRoot = join(root, 'homes')
  await mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'user.name', 'Cumora Test'])
  await git(repo, ['config', 'user.email', 'cumora@example.invalid'])
  await writeFile(join(repo, '.gitignore'), 'ignored-secret.txt\n')
  await writeFile(join(repo, 'README.md'), 'initial\n')
  await git(repo, ['add', '.gitignore', 'README.md'])
  await git(repo, ['commit', '--quiet', '-m', 'initial'])
  const projectStorePath = join(root, 'state', 'projects.json')
  const worktreeStorePath = join(root, 'home-store', 'worktrees.json')
  const patchRoot = join(root, 'home-store', 'patches')
  const createLocal = () => new LocalCollaboration({
    homeRoot,
    projectStore: new LocalProjectStore(projectStorePath),
    worktreeStorePath,
    patchRoot,
  })
  return {
    root,
    repo,
    homeRoot,
    worktreeStorePath,
    projectStorePath,
    patchRoot,
    local: createLocal(),
    anotherLocal: createLocal,
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('human grants a project; A hands off a fixed commit; B accepts its own snapshot', async () => {
  const { root, repo, local } = await fixture()
  const grant = await local.run(['projects', 'grant', repo, '--json'])
  assert.equal(grant.exitCode, 0)
  const projectId = stringField(parseRecord(grant.text), 'id')

  const sourceResult = await local.run(['worktree', 'create', projectId, 'task-1', '--json'], { agentId: 'agent-a' })
  assert.equal(sourceResult.exitCode, 0)
  const source = parseRecord(sourceResult.text)
  const sourceId = stringField(source, 'id')
  const sourcePath = stringField(source, 'path')
  assert.equal(stringField(source, 'agentId'), 'agent-a')

  await writeFile(join(sourcePath, 'README.md'), 'from A\n')
  await git(sourcePath, ['add', 'README.md'])
  await git(sourcePath, ['commit', '--quiet', '-m', 'A change'])
  const head = await git(sourcePath, ['rev-parse', 'HEAD'])

  const proposalResult = await local.run(['handoff', 'propose', sourceId, 'agent-b', '--json'], { agentId: 'agent-a' })
  assert.equal(proposalResult.exitCode, 0)
  const proposal = parseRecord(proposalResult.text)
  const proposalId = stringField(proposal, 'id')
  assert.equal(stringField(proposal, 'sourceHeadCommit'), head)

  const hiddenFromA = await local.run(['handoff', 'accept', proposalId], { agentId: 'agent-a' })
  assert.equal(hiddenFromA.exitCode, 1)
  assert.match(hiddenFromA.text, /only the target Agent/)

  const visibleToB = await local.run(['handoff', 'list', '--json'], { agentId: 'agent-b' })
  assert.match(visibleToB.text, new RegExp(proposalId))
  const acceptedResult = await local.run(['handoff', 'accept', proposalId, '--json'], { agentId: 'agent-b' })
  assert.equal(acceptedResult.exitCode, 0)
  const accepted = parseRecord(acceptedResult.text)
  if (!isRecord(accepted.handoff) || !isRecord(accepted.worktree)) throw new Error('accepted handoff is missing its result records')
  const targetPath = stringField(accepted.worktree, 'path')
  const targetId = stringField(accepted.worktree, 'id')
  assert.equal(stringField(accepted.handoff, 'targetHeadCommit'), head)
  assert.equal(stringField(accepted.worktree, 'agentId'), 'agent-b')
  assert.equal(await git(targetPath, ['rev-parse', 'HEAD']), head)
  assert.match(await git(targetPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']), /^cumora\/handoff\//)

  await writeFile(join(targetPath, 'README.md'), 'from B after accepting A\n')
  const targetCommit = await local.run([
    'worktree', 'commit', targetId,
    '--expected-head', head,
    '--message', 'B continues the task',
    '--json',
  ], { agentId: 'agent-b' })
  assert.equal(targetCommit.exitCode, 0, targetCommit.text)
  const targetHead = stringField(parseRecord(targetCommit.text), 'headCommit')
  assert.notEqual(targetHead, head)
  assert.equal(await git(targetPath, ['rev-parse', 'HEAD']), targetHead)
  assert.equal(await git(join(root, 'homes', projectId, 'agent-a', 'task-1'), ['rev-parse', 'HEAD']), head)
})

test('separate coordinators serialize grants and worktree creation against shared local state', async () => {
  const { repo, local, anotherLocal } = await fixture()
  const second = anotherLocal()

  const grants = await Promise.all([
    local.run(['projects', 'grant', repo, '--json']),
    second.run(['projects', 'grant', repo, '--json']),
  ])
  assert.deepEqual(grants.map((result) => result.exitCode), [0, 0])
  const projectIds = grants.map((result) => stringField(parseRecord(result.text), 'id'))
  assert.equal(projectIds[0], projectIds[1])

  const created = await Promise.all([
    local.run(['worktree', 'create', projectIds[0]!, 'task-race', '--agent', 'agent-a', '--json']),
    second.run(['worktree', 'create', projectIds[0]!, 'task-race', '--agent', 'agent-a', '--json']),
  ])
  assert.deepEqual(created.map((result) => result.exitCode), [0, 0])
  const leaseIds = created.map((result) => stringField(parseRecord(result.text), 'id'))
  assert.equal(leaseIds[0], leaseIds[1])
  const listed = await second.run(['worktree', 'list', '--project', projectIds[0], '--json'])
  assert.equal((JSON.parse(listed.text) as unknown[]).length, 1)
})

test('the public commit command builds a local snapshot without running hooks or importing staged ignored files', async () => {
  const { root, repo, local } = await fixture()
  const grant = await local.run(['projects', 'grant', repo, '--json'])
  const projectId = stringField(parseRecord(grant.text), 'id')
  const created = await local.run(['worktree', 'create', projectId, 'task-commit', '--agent', 'agent-a', '--json'])
  const source = parseRecord(created.text)
  const sourceId = stringField(source, 'id')
  const sourcePath = stringField(source, 'path')
  const expectedHead = await git(sourcePath, ['rev-parse', 'HEAD'])
  const marker = join(root, 'pre-commit-ran')
  const referenceMarker = join(root, 'reference-transaction-ran')
  const indexMarker = join(root, 'post-index-change-ran')
  const hookPath = join(repo, '.git', 'hooks', 'pre-commit')
  const referenceHookPath = join(repo, '.git', 'hooks', 'reference-transaction')
  const indexHookPath = join(repo, '.git', 'hooks', 'post-index-change')
  await writeFile(join(sourcePath, 'ignored-secret.txt'), 'must not enter the commit\n')
  await git(sourcePath, ['add', '--force', 'ignored-secret.txt'])
  await writeFile(join(sourcePath, 'README.md'), 'snapshot committed by Cumora\n')
  await mkdir(join(repo, '.git', 'hooks'), { recursive: true })
  await writeFile(hookPath, `#!/bin/sh\nprintf ran > '${marker.replace(/'/g, "'\\''")}'\n`)
  await writeFile(referenceHookPath, `#!/bin/sh\nprintf ran > '${referenceMarker.replace(/'/g, "'\\''")}'\n`)
  await writeFile(indexHookPath, `#!/bin/sh\nprintf ran > '${indexMarker.replace(/'/g, "'\\''")}'\n`)
  await chmod(hookPath, 0o755)
  await chmod(referenceHookPath, 0o755)
  await chmod(indexHookPath, 0o755)

  const args = [
    'worktree', 'commit', sourceId,
    '--expected-head', expectedHead,
    '--message', 'snapshot commit',
    '--json',
  ]
  const result = await local.run(args, { agentId: 'agent-a' })
  assert.equal(result.exitCode, 0, result.text)
  const committed = parseRecord(result.text)
  const head = stringField(committed, 'headCommit')
  assert.equal(await git(sourcePath, ['rev-parse', 'HEAD']), head)
  assert.equal(await git(sourcePath, ['show', `${head}:README.md`]), 'snapshot committed by Cumora')
  assert.equal(await git(sourcePath, ['cat-file', '-e', `${head}:ignored-secret.txt`]).then(() => true).catch(() => false), false)
  assert.equal(await stat(marker).then(() => true).catch(() => false), false)
  assert.equal(await stat(referenceMarker).then(() => true).catch(() => false), false)
  assert.equal(await stat(indexMarker).then(() => true).catch(() => false), false)
  assert.equal(await git(sourcePath, ['diff', '--cached', '--quiet']).then(() => true).catch(() => false), true)

  const retried = await local.run(args, { agentId: 'agent-a' })
  assert.equal(retried.exitCode, 0, retried.text)
  assert.equal(stringField(parseRecord(retried.text), 'headCommit'), head)

  const foreign = await local.run(args, { agentId: 'agent-b' })
  assert.equal(foreign.exitCode, 1)
  assert.match(foreign.text, /another Agent/)
  assert.equal(await git(sourcePath, ['rev-parse', 'HEAD']), head)
})

test('a clean filter on a changed path is rejected before Git can execute it', async () => {
  const { root, repo, local } = await fixture()
  const grant = await local.run(['projects', 'grant', repo, '--json'])
  const projectId = stringField(parseRecord(grant.text), 'id')
  const created = await local.run(['worktree', 'create', projectId, 'task-filter', '--agent', 'agent-a', '--json'])
  const source = parseRecord(created.text)
  const sourceId = stringField(source, 'id')
  const sourcePath = stringField(source, 'path')
  const expectedHead = await git(sourcePath, ['rev-parse', 'HEAD'])
  const marker = join(root, 'filter-ran')
  await git(repo, ['config', 'filter.hostile.clean', `printf ran > '${marker.replace(/'/g, "'\\''")} ; cat`])
  await git(repo, ['config', 'filter.hostile.required', 'true'])
  await writeFile(join(sourcePath, '.gitattributes'), '*.filtered filter=hostile\n')
  await writeFile(join(sourcePath, 'sample.filtered'), 'filtered content\n')

  const result = await local.run([
    'worktree', 'commit', sourceId,
    '--expected-head', expectedHead,
    '--message', 'filtered content',
  ], { agentId: 'agent-a' })
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /Git clean filter/)
  assert.equal(await stat(marker).then(() => true).catch(() => false), false)
  assert.equal(await git(sourcePath, ['rev-parse', 'HEAD']), expectedHead)
})

test('an Agent cannot impersonate another Agent or grant host paths', async () => {
  const { repo, local } = await fixture()
  const granted = JSON.parse((await local.run(['projects', 'grant', repo, '--json'])).text) as { id: string }

  const host = await local.run(['projects', 'list'], { agentId: 'agent-a' })
  assert.equal(host.exitCode, 1)
  assert.match(host.text, /cannot grant, list, or revoke/)

  const spoof = await local.run(['worktree', 'create', granted.id, 'task-2', '--agent', 'agent-b'], { agentId: 'agent-a' })
  assert.equal(spoof.exitCode, 1)
  assert.match(spoof.text, /only create its own worktree/)

  const own = JSON.parse((await local.run(['worktree', 'create', granted.id, 'task-2', '--json'], { agentId: 'agent-a' })).text) as { id: string }
  const foreignShow = await local.run(['worktree', 'show', own.id], { agentId: 'agent-b' })
  assert.equal(foreignShow.exitCode, 1)
  assert.match(foreignShow.text, /another Agent/)
})

test('operators can inspect a fixed diff without accepting the handoff', async () => {
  const { repo, local } = await fixture()
  const project = JSON.parse((await local.run(['projects', 'grant', repo, '--json'])).text) as { id: string }
  const source = JSON.parse((await local.run(['worktree', 'create', project.id, 'task-diff', '--agent', 'agent-a', '--json'])).text) as { id: string; path: string }
  await writeFile(join(source.path, 'README.md'), 'review me\n')
  await git(source.path, ['add', 'README.md'])
  await git(source.path, ['commit', '--quiet', '-m', 'review me'])
  const proposal = JSON.parse((await local.run(['handoff', 'propose', source.id, 'agent-b', '--json'])).text) as { id: string }
  const shown = await local.run(['handoff', 'show', proposal.id, '--diff', '--json'])
  assert.equal(shown.exitCode, 0)
  const view = JSON.parse(shown.text) as { state: string; diff: string }
  assert.equal(view.state, 'proposed')
  assert.match(view.diff, /review me/)
})

test('unknown local commands fail without touching the network or filesystem', async () => {
  const { homeRoot } = await fixture()
  const local = new LocalCollaboration({ homeRoot })
  const result = await local.run(['bogus'])
  assert.equal(result.exitCode, 1)
  assert.match(result.text, /unknown local command/)
})
