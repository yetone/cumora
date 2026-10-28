import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { promisify } from 'node:util'

import { LocalProjectStore } from '../agents/computer/local-project-store.js'
import { inspectLocalRepository, LocalProjectError, LocalProjects } from '../agents/computer/local-projects.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-local-projects-'))
  roots.push(root)
  return root
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout.trimEnd()
}

async function repository(root: string): Promise<string> {
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--quiet'])
  return repo
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('explicit nested and linked paths grant one canonical Git worktree', async () => {
  const root = await temporaryRoot()
  const repo = await repository(root)
  const nested = join(repo, 'src', 'nested')
  await mkdir(nested, { recursive: true })
  const linked = join(root, 'linked-repo')
  await symlink(repo, linked, process.platform === 'win32' ? 'junction' : 'dir')

  const projects = new LocalProjects(new LocalProjectStore(join(root, 'state', 'projects.json')))
  const first = await projects.grant(join(linked, 'src', 'nested'), { cloudProjectId: 'project/opaque:01' })
  const second = await projects.grant(repo)

  assert.equal(first.topLevel, await realpath(repo))
  assert.equal(first.gitDir, await realpath(join(repo, '.git')))
  assert.equal(first.commonGitDir, await realpath(join(repo, '.git')))
  assert.equal(first.cloudProjectId, 'project/opaque:01')
  assert.equal(second.id, first.id)
  assert.equal(second.cloudProjectId, first.cloudProjectId)
  assert.deepEqual(await projects.list(), [second])

  const stored = JSON.parse(await readFile(join(root, 'state', 'projects.json'), 'utf8'))
  assert.equal(stored.version, 1)
  assert.equal(stored.projects.length, 1)
  assert.deepEqual(Object.keys(stored.projects[0]).sort(), [
    'cloudProjectId',
    'commonGitDir',
    'gitDir',
    'grantedAt',
    'id',
    'topLevel',
    'updatedAt',
  ])
})

test('linked worktrees report separate git-dir and common-dir locations', async () => {
  const root = await temporaryRoot()
  const repo = await repository(root)
  await git(repo, ['config', 'user.name', 'Cumora Test'])
  await git(repo, ['config', 'user.email', 'cumora@example.invalid'])
  await git(repo, ['commit', '--allow-empty', '--quiet', '-m', 'initial'])
  const worktree = join(root, 'linked-worktree')
  await git(repo, ['worktree', 'add', '--quiet', '--detach', worktree])

  const location = await inspectLocalRepository(worktree)

  assert.equal(location.topLevel, await realpath(worktree))
  assert.notEqual(location.gitDir, location.commonGitDir)
  assert.equal(location.commonGitDir, await realpath(join(repo, '.git')))
  assert.match(location.gitDir, /[\\/]\.git[\\/]worktrees[\\/]/)
})

test('cloud binding is an opaque value and revoke removes the local grant', async () => {
  const root = await temporaryRoot()
  const repo = await repository(root)
  const store = new LocalProjectStore(join(root, 'projects.json'))
  const projects = new LocalProjects(store)
  const granted = await projects.grant(repo)

  const bound = await projects.bindCloudProject(granted.id, '  opaque id  '.trim())
  assert.equal(bound?.cloudProjectId, 'opaque id')
  assert.equal((await projects.list())[0]?.cloudProjectId, 'opaque id')
  await assert.rejects(projects.bindCloudProject(granted.id, '  padded  '), /opaque string or null/)
  assert.equal((await projects.bindCloudProject(granted.id, null))?.cloudProjectId, null)
  assert.equal(await projects.bindCloudProject('missing', 'project'), null)

  assert.equal(await projects.revoke(granted.id), true)
  assert.equal(await projects.revoke(granted.id), false)
  assert.deepEqual(await projects.list(), [])
})

test('files, plain directories, bare repositories and broken links are rejected', async () => {
  const root = await temporaryRoot()
  const file = join(root, 'file.txt')
  await writeFile(file, 'not a repository')
  const plain = join(root, 'plain')
  await mkdir(plain)
  const bare = join(root, 'bare.git')
  await mkdir(bare)
  await git(bare, ['init', '--bare', '--quiet'])
  const broken = join(root, 'broken')
  await symlink(join(root, 'missing'), broken, process.platform === 'win32' ? 'junction' : 'dir')

  await assert.rejects(inspectLocalRepository(file), (err: unknown) => {
    assert.ok(err instanceof LocalProjectError)
    assert.equal(err.code, 'not-directory')
    return true
  })
  await assert.rejects(inspectLocalRepository(plain), (err: unknown) => {
    assert.ok(err instanceof LocalProjectError)
    assert.equal(err.code, 'not-repository')
    return true
  })
  await assert.rejects(inspectLocalRepository(bare), (err: unknown) => {
    assert.ok(err instanceof LocalProjectError)
    assert.equal(err.code, 'not-repository')
    return true
  })
  await assert.rejects(inspectLocalRepository(broken), /does not exist or cannot be resolved/)
  await assert.rejects(inspectLocalRepository('repo'), /must be absolute/)
})

test('a path changed while Git is inspecting it is rejected', async () => {
  const root = await temporaryRoot()
  const repo = await repository(root)
  await assert.rejects(
    inspectLocalRepository(repo, {
      runGit: async (cwd, args) => {
        const output = await git(cwd, args)
        if (args.includes('--git-common-dir')) {
          await rename(repo, `${repo}-old`)
          await mkdir(repo)
          await git(repo, ['init', '--quiet'])
        }
        return output
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof LocalProjectError)
      assert.equal(err.code, 'unstable-path')
      return true
    },
  )
})

test('ambient Git repository variables cannot redirect explicit discovery', async () => {
  const root = await temporaryRoot()
  const plain = join(root, 'plain')
  await mkdir(plain)
  const other = await repository(root)
  const previous = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
  }
  try {
    process.env.GIT_DIR = join(other, '.git')
    process.env.GIT_WORK_TREE = other
    await assert.rejects(inspectLocalRepository(plain), (err: unknown) => {
      assert.ok(err instanceof LocalProjectError)
      assert.equal(err.code, 'not-repository')
      return true
    })
  } finally {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE'] as const) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})

test('the store is private JSON, rejects unsafe files, and cleans failed temp writes', async () => {
  const root = await temporaryRoot()
  const filePath = join(root, 'private', 'projects.json')
  const store = new LocalProjectStore(filePath)
  assert.deepEqual(await store.load(), [])

  const repo = await repository(root)
  const projects = new LocalProjects(store)
  await projects.grant(repo)
  if (process.platform !== 'win32') {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    await chmod(filePath, 0o644)
    await assert.rejects(store.load(), /0600/)
    await chmod(filePath, 0o600)
  }

  const linkedStore = join(root, 'linked-store.json')
  if (process.platform === 'win32') {
    await symlink(join(root, 'private'), linkedStore, 'junction')
  } else {
    await symlink(filePath, linkedStore, 'file')
  }
  await assert.rejects(new LocalProjectStore(linkedStore).load(), /regular local file/)

  const malformed = join(root, 'malformed.json')
  await writeFile(malformed, '{not-json', { mode: 0o600 })
  await assert.rejects(new LocalProjectStore(malformed).load(), /not valid JSON/)

  const blocked = join(root, 'blocked')
  await mkdir(blocked)
  await assert.rejects(new LocalProjectStore(blocked).replace([]))
  assert.deepEqual((await readdir(root)).sort(), expectRootEntries().sort())
})

function expectRootEntries(): string[] {
  return ['blocked', 'linked-store.json', 'malformed.json', 'private', 'repo']
}
