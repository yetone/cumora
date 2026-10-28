import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'

import type { LocalProjectGrant } from '../agents/computer/local-project-store.js'
import { inspectLocalRepository } from '../agents/computer/local-projects.js'
import {
  LocalWorktreeError,
  LocalWorktreeManager,
} from '../agents/computer/local-worktrees.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout.trimEnd()
}

async function temporaryRepository(): Promise<{
  root: string
  repo: string
  grant: LocalProjectGrant
  homeRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-local-worktrees-'))
  roots.push(root)
  const repo = join(root, 'repo')
  const homeRoot = join(root, 'agent-homes')
  await mkdir(repo)
  await git(repo, ['init', '--quiet'])
  await git(repo, ['config', 'user.name', 'Cumora Test'])
  await git(repo, ['config', 'user.email', 'cumora@example.invalid'])
  await git(repo, ['config', 'core.autocrlf', 'false'])
  await writeFile(join(repo, 'README.md'), 'initial\n')
  await git(repo, ['add', 'README.md'])
  await git(repo, ['commit', '--quiet', '-m', 'initial'])
  const location = await inspectLocalRepository(repo)
  const stamp = new Date().toISOString()
  return {
    root,
    repo,
    homeRoot,
    grant: {
      id: 'project123',
      ...location,
      cloudProjectId: null,
      grantedAt: stamp,
      updatedAt: stamp,
    },
  }
}

function manager(
  grant: LocalProjectGrant,
  homeRoot: string,
  options: { storePath?: string; patchRoot?: string } = {},
): LocalWorktreeManager {
  return new LocalWorktreeManager(grant, { homeRoot, ...options })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('agent A commits, B accepts a distinct fixed snapshot, and retries are idempotent', async () => {
  const { repo, grant, homeRoot } = await temporaryRepository()
  const worktrees = manager(grant, homeRoot)
  const source = await worktrees.create('task-1', 'agent-a')
  const recovered = await worktrees.create('task-1', 'agent-a')
  assert.equal(recovered.id, source.id)
  assert.equal(source.path, join(await realpath(homeRoot), grant.id, 'agent-a', 'task-1'))

  await writeFile(join(source.path, 'README.md'), 'changed by agent A\n')
  await git(source.path, ['add', 'README.md'])
  await git(source.path, ['commit', '--quiet', '-m', 'agent A change'])
  const head = await git(source.path, ['rev-parse', 'HEAD'])

  const proposal = await worktrees.proposeHandoff(source.id, 'agent-b')
  const repeatedProposal = await worktrees.proposeHandoff(source.id, 'agent-b')
  assert.equal(repeatedProposal.id, proposal.id)
  assert.equal(proposal.sourceHeadCommit, head)
  assert.equal(proposal.sourceDirty, false)
  assert.equal(proposal.state, 'proposed')

  const patch = await readFile(proposal.patchFile)
  assert.equal(createHash('sha256').update(patch).digest('hex'), proposal.diffDigest)
  assert.match(patch.toString('utf8'), /changed by agent A/)
  if (process.platform !== 'win32') {
    assert.equal((await stat(proposal.patchFile)).mode & 0o777, 0o600)
  }

  const accepted = await worktrees.acceptHandoff(proposal.id)
  const repeatedAcceptance = await worktrees.acceptHandoff(proposal.id)
  assert.equal(accepted.handoff.state, 'accepted')
  assert.equal(accepted.handoff.targetHeadCommit, head)
  assert.equal(accepted.lease.path, join(await realpath(homeRoot), grant.id, 'agent-b', 'task-1'))
  assert.notEqual(accepted.lease.path, source.path)
  assert.equal(repeatedAcceptance.lease.id, accepted.lease.id)
  assert.equal(await readFile(join(accepted.lease.path, 'README.md'), 'utf8'), 'changed by agent A\n')
  assert.equal(await git(accepted.lease.path, ['rev-parse', 'HEAD']), head)
  assert.match(await git(accepted.lease.path, ['symbolic-ref', '--quiet', 'HEAD']), /^refs\/heads\/cumora\/handoff\//)
  assert.equal((await worktrees.listLeases()).length, 2)
  assert.equal((await worktrees.listHandoffs()).length, 1)
  assert.equal(await git(repo, ['rev-parse', head]), head)
})

test('a handoff can return to an agent with a new generation worktree', async () => {
  const { grant, homeRoot } = await temporaryRepository()
  const worktrees = manager(grant, homeRoot)
  const a1 = await worktrees.create('task-roundtrip', 'agent-a')

  await writeFile(join(a1.path, 'README.md'), 'from A\n')
  await git(a1.path, ['add', 'README.md'])
  await git(a1.path, ['commit', '--quiet', '-m', 'A change'])
  const aHead = await git(a1.path, ['rev-parse', 'HEAD'])

  const aToB = await worktrees.acceptHandoff(await worktrees.proposeHandoff(a1.id, 'agent-b').then((handoff) => handoff.id))
  assert.equal(aToB.lease.agentId, 'agent-b')
  assert.equal(aToB.lease.headCommit, aHead)

  await writeFile(join(aToB.lease.path, 'README.md'), 'from B\n')
  await git(aToB.lease.path, ['add', 'README.md'])
  await git(aToB.lease.path, ['commit', '--quiet', '-m', 'B change'])
  const bHead = await git(aToB.lease.path, ['rev-parse', 'HEAD'])

  const bToAProposal = await worktrees.proposeHandoff(aToB.lease.id, 'agent-a')
  const bToA = await worktrees.acceptHandoff(bToAProposal.id)
  assert.equal(bToA.lease.agentId, 'agent-a')
  assert.equal(bToA.lease.headCommit, bHead)
  assert.notEqual(bToA.lease.id, a1.id)
  assert.notEqual(bToA.lease.path, a1.path)
  assert.match(bToA.lease.path, /task-roundtrip--[0-9a-f]{16}$/)
  assert.equal(await git(a1.path, ['rev-parse', 'HEAD']), aHead)
  assert.equal(await git(bToA.lease.path, ['rev-parse', 'HEAD']), bHead)

  const leases = await worktrees.listLeases()
  assert.equal(leases.filter((lease) => lease.taskId === 'task-roundtrip' && lease.agentId === 'agent-a').length, 2)
  assert.equal(leases.find((lease) => lease.id === a1.id)?.state, 'handed_off')
  assert.equal(leases.find((lease) => lease.id === bToA.lease.id)?.state, 'active')
})

test('the same task and agent can have independent leases in two repositories', async () => {
  const first = await temporaryRepository()
  const secondRoot = await mkdtemp(join(tmpdir(), 'cumora-local-worktrees-second-'))
  roots.push(secondRoot)
  const secondRepo = join(secondRoot, 'repo')
  await mkdir(secondRepo)
  await git(secondRepo, ['init', '--quiet'])
  await git(secondRepo, ['config', 'user.name', 'Cumora Test'])
  await git(secondRepo, ['config', 'user.email', 'cumora@example.invalid'])
  await writeFile(join(secondRepo, 'README.md'), 'second\n')
  await git(secondRepo, ['add', 'README.md'])
  await git(secondRepo, ['commit', '--quiet', '-m', 'initial'])
  const secondLocation = await inspectLocalRepository(secondRepo)
  const secondGrant: LocalProjectGrant = {
    id: 'project456',
    ...secondLocation,
    cloudProjectId: null,
    grantedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  const firstManager = manager(first.grant, first.homeRoot)
  const secondManager = manager(secondGrant, first.homeRoot)
  const firstLease = await firstManager.create('shared-task', 'agent-a')
  const secondLease = await secondManager.create('shared-task', 'agent-a')

  assert.notEqual(firstLease.id, secondLease.id)
  assert.notEqual(firstLease.path, secondLease.path)
  assert.equal((await firstManager.listLeases()).length, 1)
  assert.equal((await secondManager.listLeases()).length, 1)
  assert.match(firstLease.path, /project123[\\/]+agent-a[\\/]+shared-task$/)
  assert.match(secondLease.path, /project456[\\/]+agent-a[\\/]+shared-task$/)
  await assert.rejects(firstManager.status(secondLease.id), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'not-found')
    return true
  })

  const foreignHandoff = await firstManager.proposeHandoff(firstLease.id, 'agent-b')
  await assert.rejects(secondManager.readHandoffPatch(foreignHandoff.id), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'not-found')
    return true
  })
  assert.deepEqual(await secondManager.listHandoffs(), [])
})

test('dirty source cannot be handed off or closed', async () => {
  const { grant, homeRoot } = await temporaryRepository()
  const worktrees = manager(grant, homeRoot)
  const source = await worktrees.create('task-dirty', 'agent-a')
  await writeFile(join(source.path, 'README.md'), 'uncommitted\n')

  await assert.rejects(worktrees.proposeHandoff(source.id, 'agent-b'), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'dirty')
    return true
  })
  await assert.rejects(worktrees.close(source.id), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'dirty')
    return true
  })
  assert.equal((await worktrees.listHandoffs()).length, 0)
  assert.equal((await worktrees.listLeases())[0]?.state, 'active')
  assert.equal(await readFile(join(source.path, 'README.md'), 'utf8'), 'uncommitted\n')
})

test('rejecting a proposed handoff restores ownership and permits a later handoff', async () => {
  const { grant, homeRoot } = await temporaryRepository()
  const worktrees = manager(grant, homeRoot)
  const source = await worktrees.create('task-reject', 'agent-a')

  const first = await worktrees.proposeHandoff(source.id, 'agent-b')
  const rejected = await worktrees.rejectHandoff(first.id)
  assert.equal(rejected.state, 'rejected')
  assert.equal((await worktrees.listLeases()).find((lease) => lease.id === source.id)?.state, 'active')

  const second = await worktrees.proposeHandoff(source.id, 'agent-b')
  assert.notEqual(second.id, first.id)
  const accepted = await worktrees.acceptHandoff(second.id)
  assert.equal(accepted.handoff.state, 'accepted')
  assert.equal(accepted.lease.agentId, 'agent-b')
})

test('handoffs reject a source whose branch changes before proposal or acceptance', async () => {
  const { grant, homeRoot } = await temporaryRepository()
  const worktrees = manager(grant, homeRoot)
  const source = await worktrees.create('task-branch', 'agent-a')

  await git(source.path, ['switch', '--detach', 'HEAD'])
  await assert.rejects(worktrees.proposeHandoff(source.id, 'agent-b'), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'conflict')
    return true
  })
  await git(source.path, ['switch', source.branch])

  const proposal = await worktrees.proposeHandoff(source.id, 'agent-b')
  await git(source.path, ['switch', '--detach', 'HEAD'])
  await assert.rejects(worktrees.acceptHandoff(proposal.id), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'conflict')
    return true
  })
  assert.equal((await worktrees.listHandoffs()).find((row) => row.id === proposal.id)?.state, 'proposed')
  assert.equal((await worktrees.listLeases()).filter((row) => row.agentId === 'agent-b').length, 0)
})

test('traversal, unsafe task tokens, and invalid refs or branches are rejected', async () => {
  const { grant, homeRoot } = await temporaryRepository()
  const worktrees = manager(grant, homeRoot)

  for (const taskId of ['../escape', '..', '.', 'task/child', 'CON', 'task\0name']) {
    await assert.rejects(worktrees.create(taskId, 'agent-a'), (error: unknown) => {
      assert.ok(error instanceof LocalWorktreeError)
      assert.equal(error.code, 'invalid')
      return true
    })
  }
  await assert.rejects(worktrees.create('task', 'agent-a', { branch: '-danger' }), (error: unknown) => {
    assert.ok(error instanceof LocalWorktreeError)
    assert.equal(error.code, 'invalid')
    return true
  })
  await assert.rejects(
    worktrees.create('task', 'agent-a', { branch: 'bad..branch' }),
    (error: unknown) => {
      assert.ok(error instanceof LocalWorktreeError)
      assert.equal(error.code, 'invalid')
      return true
    },
  )
  await assert.rejects(
    worktrees.create('task', 'agent-a', { baseCommit: '--help' }),
    (error: unknown) => {
      assert.ok(error instanceof LocalWorktreeError)
      assert.equal(error.code, 'invalid')
      return true
    },
  )
  assert.deepEqual(await worktrees.listLeases(), [])
})

test('closed leases are idempotent and metadata remains private', async () => {
  const { root, grant, homeRoot } = await temporaryRepository()
  const storePath = join(root, 'private', 'worktrees.json')
  const patchRoot = join(root, 'private', 'patches')
  const worktrees = manager(grant, homeRoot, { storePath, patchRoot })
  const source = await worktrees.create('task-close', 'agent-a')
  await worktrees.close(source.id)
  await worktrees.close(source.id)
  assert.equal((await worktrees.listLeases())[0]?.state, 'closed')
  assert.equal((await stat(source.path).catch(() => null)), null)

  if (process.platform !== 'win32') {
    assert.equal((await stat(storePath)).mode & 0o777, 0o600)
    assert.deepEqual((await readdir(patchRoot).catch(() => [])), [])
  }
})
