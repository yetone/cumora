import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  type LocalProjectGrant,
  LocalProjectStore,
} from './local-project-store.js'

export interface LocalRepositoryLocation {
  topLevel: string
  gitDir: string
  commonGitDir: string
}

export interface GrantLocalProjectOptions {
  cloudProjectId?: string | null
}

export type LocalProjectErrorCode =
  | 'invalid-path'
  | 'not-directory'
  | 'not-repository'
  | 'unstable-path'

export class LocalProjectError extends Error {
  constructor(
    readonly code: LocalProjectErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocalProjectError'
  }
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>

export interface InspectLocalRepositoryOptions {
  /** Test seam for simulating a path that changes during validation. */
  runGit?: GitRunner
}

function runGit(cwd: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
  ]) {
    delete env[key]
  }
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        env,
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolvePromise(stdout.trimEnd())
      },
    )
  })
}

function identity(info: Awaited<ReturnType<typeof stat>>): string {
  return `${info.dev}:${info.ino}`
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const before = await stat(path).catch(() => null)
  if (!before) {
    throw new LocalProjectError('invalid-path', `${label} does not exist or cannot be resolved`)
  }
  if (!before.isDirectory()) {
    throw new LocalProjectError('not-directory', `${label} must be a directory`)
  }

  let physical: string
  try {
    physical = await realpath(path)
  } catch {
    throw new LocalProjectError('invalid-path', `${label} does not exist or cannot be resolved`)
  }
  const physicalInfo = await stat(physical).catch(() => null)
  const physicalAfter = await realpath(path).catch(() => null)
  const after = await stat(path).catch(() => null)
  if (!physicalInfo?.isDirectory()) {
    throw new LocalProjectError('not-directory', `${label} must be a directory`)
  }
  if (
    !physicalAfter ||
    physicalAfter !== physical ||
    !after ||
    !after.isDirectory() ||
    identity(before) !== identity(after) ||
    identity(after) !== identity(physicalInfo)
  ) {
    throw new LocalProjectError('unstable-path', `${label} changed while it was being resolved`)
  }
  return physical
}

function parseGitPath(output: string, label: string): string {
  if (!output || /[\r\n\0]/.test(output)) {
    throw new LocalProjectError('not-repository', `Git did not report a usable ${label}`)
  }
  return output
}

async function gitPath(cwd: string, args: string[], label: string, runner: GitRunner): Promise<string> {
  let output: string
  try {
    output = await runner(cwd, args)
  } catch (err) {
    const detail = err instanceof Error ? `: ${err.message}` : ''
    throw new LocalProjectError('not-repository', `not a Git repository${detail}`)
  }
  return parseGitPath(output, label)
}

/** Resolve one explicitly supplied directory to a stable Git worktree. */
export async function inspectLocalRepository(
  requestedPath: string,
  options: InspectLocalRepositoryOptions = {},
): Promise<LocalRepositoryLocation> {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    throw new LocalProjectError('invalid-path', 'a local repository path is required')
  }
  if (requestedPath.includes('\0')) {
    throw new LocalProjectError('invalid-path', 'local repository path contains a NUL byte')
  }
  if (!isAbsolute(requestedPath)) {
    throw new LocalProjectError('invalid-path', 'local repository path must be absolute')
  }

  const lexical = resolve(requestedPath)
  const initial = await lstat(lexical).catch(() => null)
  if (!initial) throw new LocalProjectError('invalid-path', 'local repository path does not exist')
  if (!initial.isDirectory() && !initial.isSymbolicLink()) {
    throw new LocalProjectError('not-directory', 'local repository path must be a directory')
  }

  const canonical = await canonicalDirectory(lexical, 'local repository path')
  const before = await stat(canonical)
  const runner = options.runGit ?? runGit

  const insideWorkTree = await gitPath(
    canonical,
    ['rev-parse', '--is-inside-work-tree'],
    'worktree state',
    runner,
  )
  if (insideWorkTree !== 'true') {
    throw new LocalProjectError('not-repository', 'path is not inside a Git worktree')
  }

  const reportedTopLevel = await gitPath(canonical, ['rev-parse', '--show-toplevel'], 'top-level', runner)
  const reportedGitDir = await gitPath(
    canonical,
    ['rev-parse', '--absolute-git-dir'],
    'Git directory',
    runner,
  )
  const reportedCommonDir = await gitPath(
    canonical,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    'common Git directory',
    runner,
  )

  for (const [value, label] of [
    [reportedTopLevel, 'Git top-level'],
    [reportedGitDir, 'Git directory'],
    [reportedCommonDir, 'common Git directory'],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new LocalProjectError('not-repository', `Git did not report an absolute ${label}`)
    }
  }

  const topLevel = await canonicalDirectory(reportedTopLevel, 'Git top-level')
  const gitDir = await canonicalDirectory(reportedGitDir, 'Git directory')
  const commonGitDir = await canonicalDirectory(reportedCommonDir, 'common Git directory')
  if (!isWithinOrEqual(topLevel, canonical)) {
    throw new LocalProjectError('unstable-path', 'local repository path changed outside its Git top-level')
  }

  const canonicalAfter = await realpath(lexical).catch(() => null)
  const after = await stat(canonicalAfter ?? canonical).catch(() => null)
  if (!canonicalAfter || canonicalAfter !== canonical || !after || !after.isDirectory() || identity(before) !== identity(after)) {
    throw new LocalProjectError('unstable-path', 'local repository path changed while it was being resolved')
  }

  return { topLevel, gitDir, commonGitDir }
}

function opaqueCloudProjectId(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value) || value.length > 512) {
    throw new TypeError('cloudProjectId must be a non-empty opaque string or null')
  }
  return value
}

/**
 * Grant/list/revoke coordinator for explicitly approved local repositories.
 *
 * This module only reads Git's local directory layout and persists records on
 * this machine. It never reads branches, commits, or diffs and has no server
 * transport.
 */
export class LocalProjects {
  constructor(private readonly store = new LocalProjectStore()) {}

  async grant(path: string, options: GrantLocalProjectOptions = {}): Promise<LocalProjectGrant> {
    const cloudProjectId = opaqueCloudProjectId(options.cloudProjectId)
    const location = await inspectLocalRepository(path)
    const now = new Date().toISOString()
    return this.store.update((projects) => {
      const existing = projects.find((project) => project.topLevel === location.topLevel)
      if (existing) {
        const updated: LocalProjectGrant = {
          ...existing,
          ...location,
          cloudProjectId: cloudProjectId === undefined ? existing.cloudProjectId : cloudProjectId,
          updatedAt: now,
        }
        return {
          projects: projects.map((project) => (project.id === existing.id ? updated : project)),
          result: updated,
        }
      }
      const granted: LocalProjectGrant = {
        id: randomUUID(),
        ...location,
        cloudProjectId: cloudProjectId ?? null,
        grantedAt: now,
        updatedAt: now,
      }
      return { projects: [...projects, granted], result: granted }
    })
  }

  async list(): Promise<LocalProjectGrant[]> {
    return this.store.load()
  }

  async revoke(id: string): Promise<boolean> {
    if (typeof id !== 'string' || id.length === 0) return false
    return this.store.update((projects) => {
      const next = projects.filter((project) => project.id !== id)
      return { projects: next, result: next.length !== projects.length }
    })
  }

  async bindCloudProject(id: string, cloudProjectId: string | null): Promise<LocalProjectGrant | null> {
    const binding = opaqueCloudProjectId(cloudProjectId) ?? null
    return this.store.update((projects) => {
      const existing = projects.find((project) => project.id === id)
      if (!existing) return { projects: [...projects], result: null }
      const updated: LocalProjectGrant = {
        ...existing,
        cloudProjectId: binding,
        updatedAt: new Date().toISOString(),
      }
      return {
        projects: projects.map((project) => (project.id === id ? updated : project)),
        result: updated,
      }
    })
  }

  async flush(): Promise<void> {
    await this.store.flush()
  }
}
