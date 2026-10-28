import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { LocalProjectGrant } from './local-project-store.js'
import lockfile from 'proper-lockfile'

export type WorktreeState = 'provisioning' | 'active' | 'handed_off' | 'closed'
export type HandoffState = 'proposed' | 'accepted' | 'rejected' | 'closed'

export interface WorktreeLease {
  id: string
  repositoryId: string
  taskId: string
  agentId: string
  path: string
  /** The branch reserved for this lease and checked out in its worktree. */
  branch: string
  baseCommit: string
  headCommit: string
  dirty: boolean
  state: WorktreeState
  ownerEpoch: number
  createdAt: string
  updatedAt: string
}

export interface HandoffRecord {
  id: string
  repositoryId: string
  taskId: string
  fromAgentId: string
  toAgentId: string
  sourceWorktreeId: string
  targetWorktreeId: string | null
  sourceBaseCommit: string
  sourceHeadCommit: string
  targetHeadCommit: string | null
  sourceDirty: false
  patchFile: string
  diffDigest: string
  state: HandoffState
  createdAt: string
  acceptedAt: string | null
}

interface LocalWorktreeDocument {
  version: 1
  leases: WorktreeLease[]
  handoffs: HandoffRecord[]
}

interface LiveWorktree {
  path: string
  headCommit: string
  dirty: boolean
  branch: string | null
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>
export type GitBytesRunner = (cwd: string, args: string[]) => Promise<Buffer>
export type GitEnvironmentRunner = (
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
) => Promise<string>

export interface LocalWorktreeManagerOptions {
  /** Parent directory for per-agent worktree homes. Must be an absolute path. */
  homeRoot?: string
  /** Compatibility name for the same parent directory as homeRoot. */
  worktreeRoot?: string
  /** Private JSON metadata path. Defaults below homeRoot. */
  storePath?: string
  /** Private directory for captured patches. Defaults beside the metadata. */
  patchRoot?: string
  /** Test seams. Production callers should omit all three Git runner overrides. */
  runGit?: GitRunner
  runGitBytes?: GitBytesRunner
  runGitWithEnvironment?: GitEnvironmentRunner
}

export type LocalWorktreeErrorCode =
  | 'invalid'
  | 'not-found'
  | 'dirty'
  | 'conflict'
  | 'git'
  | 'unsupported'
  | 'unsafe-store'

export class LocalWorktreeError extends Error {
  constructor(
    readonly code: LocalWorktreeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocalWorktreeError'
  }
}

const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const PATH_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const WINDOWS_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function gitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key]
  }
  const controlledOverrides: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (/^GIT_(?:INDEX_FILE|AUTHOR_NAME|AUTHOR_EMAIL|AUTHOR_DATE|COMMITTER_NAME|COMMITTER_EMAIL|COMMITTER_DATE)$/.test(key) && value !== undefined) {
      controlledOverrides[key] = value
    }
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...controlledOverrides,
  }
}

function executeGitWithEnvironment(
  cwd: string,
  args: string[],
  overrides: NodeJS.ProcessEnv,
  encoding: 'utf8' | 'buffer',
): Promise<Buffer | string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', cwd, ...args],
      {
        encoding: encoding === 'utf8' ? 'utf8' : 'buffer',
        env: gitEnvironment(overrides),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolvePromise(stdout)
      },
    )
  })
}

function executeGit(cwd: string, args: string[], encoding: 'utf8' | 'buffer'): Promise<Buffer | string> {
  return executeGitWithEnvironment(cwd, args, {}, encoding)
}

const defaultGitRunner: GitRunner = async (cwd, args) => {
  const output = await executeGit(cwd, args, 'utf8')
  return String(output).trimEnd()
}

const defaultGitBytesRunner: GitBytesRunner = async (cwd, args) => {
  const output = await executeGit(cwd, args, 'buffer')
  return Buffer.isBuffer(output) ? output : Buffer.from(output)
}

const defaultGitEnvironmentRunner: GitEnvironmentRunner = async (cwd, args, environment) => {
  const output = await executeGitWithEnvironment(cwd, args, environment, 'utf8')
  return String(output).trimEnd()
}

function now(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasGitExitCode(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false
  const actual = (error as { code?: unknown }).code
  return actual === code || actual === String(code)
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw new LocalWorktreeError('invalid', `${label} must be an absolute local path`)
  }
  return resolve(value)
}

function assertPathToken(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !PATH_TOKEN_PATTERN.test(value) ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    WINDOWS_DEVICE_NAMES.test(value)
  ) {
    throw new LocalWorktreeError(
      'invalid',
      `${label} must be one safe path component (letters, digits, dot, underscore, or hyphen)`,
    )
  }
}

function assertCommit(value: string, label: string): void {
  if (!COMMIT_PATTERN.test(value)) {
    throw new LocalWorktreeError('invalid', `${label} must be a full Git commit id`)
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new LocalWorktreeError('unsafe-store', `${label} is not a valid timestamp`)
  }
}

function assertPrivateMode(mode: number, label: string): void {
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new LocalWorktreeError('unsafe-store', `${label} must have 0600 permissions`)
  }
}

function parseDocument(raw: string, homeRoot: string, patchRoot: string): LocalWorktreeDocument {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new LocalWorktreeError('unsafe-store', 'local worktree store is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalWorktreeError('unsafe-store', 'local worktree store has an invalid document')
  }
  const document = value as Record<string, unknown>
  if (
    document.version !== 1 ||
    !Array.isArray(document.leases) ||
    !Array.isArray(document.handoffs)
  ) {
    throw new LocalWorktreeError('unsafe-store', 'local worktree store has an unsupported document')
  }

  const leases = document.leases as WorktreeLease[]
  const handoffs = document.handoffs as HandoffRecord[]
  const leaseIds = new Set<string>()
  const paths = new Set<string>()
  const owners = new Set<string>()
  for (const lease of leases) {
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
      throw new LocalWorktreeError('unsafe-store', 'local worktree lease is not an object')
    }
    if (leaseIds.has(lease.id)) {
      throw new LocalWorktreeError('unsafe-store', 'local worktree store contains duplicate lease ids')
    }
    leaseIds.add(lease.id)
    assertPathToken(lease.id, 'lease id')
    assertPathToken(lease.repositoryId, 'repository id')
    assertPathToken(lease.taskId, 'task id')
    assertPathToken(lease.agentId, 'agent id')
    assertCommit(lease.baseCommit, 'base commit')
    assertCommit(lease.headCommit, 'head commit')
    const path = resolve(lease.path)
    if (!isAbsolute(lease.path) || !isWithin(homeRoot, path) || paths.has(path.toLowerCase())) {
      throw new LocalWorktreeError('unsafe-store', 'worktree lease path is outside the agent home root')
    }
    paths.add(path.toLowerCase())
    if (!['provisioning', 'active', 'handed_off', 'closed'].includes(lease.state)) {
      throw new LocalWorktreeError('unsafe-store', 'worktree lease has an invalid state')
    }
    if (lease.state === 'provisioning' || lease.state === 'active') {
      const owner = `${lease.repositoryId}\0${lease.taskId}\0${lease.agentId}`
      if (owners.has(owner)) {
        throw new LocalWorktreeError('unsafe-store', 'task and agent have more than one active worktree lease in a repository')
      }
      owners.add(owner)
    }
    if (typeof lease.branch !== 'string' || lease.branch.length === 0) {
      throw new LocalWorktreeError('unsafe-store', 'worktree lease has an invalid branch')
    }
    if (typeof lease.dirty !== 'boolean' || !Number.isInteger(lease.ownerEpoch) || lease.ownerEpoch < 1) {
      throw new LocalWorktreeError('unsafe-store', 'worktree lease has invalid ownership metadata')
    }
    assertTimestamp(lease.createdAt, 'lease createdAt')
    assertTimestamp(lease.updatedAt, 'lease updatedAt')
  }

  const handoffIds = new Set<string>()
  for (const handoff of handoffs) {
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
      throw new LocalWorktreeError('unsafe-store', 'local handoff is not an object')
    }
    if (handoffIds.has(handoff.id)) {
      throw new LocalWorktreeError('unsafe-store', 'local worktree store contains duplicate handoff ids')
    }
    handoffIds.add(handoff.id)
    assertPathToken(handoff.id, 'handoff id')
    assertPathToken(handoff.repositoryId, 'repository id')
    assertPathToken(handoff.taskId, 'task id')
    assertPathToken(handoff.fromAgentId, 'source agent id')
    assertPathToken(handoff.toAgentId, 'target agent id')
    assertPathToken(handoff.sourceWorktreeId, 'source worktree id')
    assertCommit(handoff.sourceBaseCommit, 'source base commit')
    assertCommit(handoff.sourceHeadCommit, 'source head commit')
    if (handoff.targetHeadCommit !== null) assertCommit(handoff.targetHeadCommit, 'target head commit')
    if (!DIGEST_PATTERN.test(handoff.diffDigest)) {
      throw new LocalWorktreeError('unsafe-store', 'handoff diff digest is invalid')
    }
    const patchFile = resolve(handoff.patchFile)
    if (!isAbsolute(handoff.patchFile) || !isWithin(patchRoot, patchFile)) {
      throw new LocalWorktreeError('unsafe-store', 'handoff patch path must stay inside the private patch root')
    }
    if (handoff.sourceDirty !== false) {
      throw new LocalWorktreeError('unsafe-store', 'this handoff version only permits clean sources')
    }
    if (!['proposed', 'accepted', 'rejected', 'closed'].includes(handoff.state)) {
      throw new LocalWorktreeError('unsafe-store', 'handoff has an invalid state')
    }
    assertTimestamp(handoff.createdAt, 'handoff createdAt')
    if (handoff.acceptedAt !== null) assertTimestamp(handoff.acceptedAt, 'handoff acceptedAt')

    const source = leases.find((lease) => lease.id === handoff.sourceWorktreeId)
    if (!source || source.repositoryId !== handoff.repositoryId || source.taskId !== handoff.taskId || source.agentId !== handoff.fromAgentId) {
      throw new LocalWorktreeError('unsafe-store', 'handoff source metadata does not match its lease')
    }
    if (handoff.targetWorktreeId !== null) {
      const target = leases.find((lease) => lease.id === handoff.targetWorktreeId)
      if (!target || target.repositoryId !== handoff.repositoryId || target.taskId !== handoff.taskId || target.agentId !== handoff.toAgentId) {
        throw new LocalWorktreeError('unsafe-store', 'handoff target metadata does not match its lease')
      }
    }
    if (handoff.state === 'accepted' && (handoff.targetWorktreeId === null || handoff.targetHeadCommit === null || handoff.acceptedAt === null)) {
      throw new LocalWorktreeError('unsafe-store', 'accepted handoff is missing its target snapshot')
    }
    if (handoff.state === 'proposed' && source.state !== 'handed_off') {
      throw new LocalWorktreeError('unsafe-store', 'proposed handoff source is not reserved')
    }
  }

  return { version: 1, leases, handoffs }
}

/**
 * Local-only worktree leases and explicit commit handoffs.
 *
 * Each repository/task/agent has at most one active or provisioning lease
 * below the configured home root. Historical handed-off leases remain in the
 * local journal, while a return handoff receives a new generation path.
 * Proposals pin the source commit and a private base-to-head patch; acceptance
 * creates a receiver branch at that same commit. This class has no server
 * transport.
 */
export class LocalWorktreeManager {
  readonly homeRoot: string
  readonly storePath: string
  readonly patchRoot: string
  readonly lockPath: string
  private readonly runGit: GitRunner
  private readonly runGitBytes: GitBytesRunner
  private readonly runGitWithEnvironment: GitEnvironmentRunner
  private readonly repositoryLockPath: string
  private operations: Promise<void> = Promise.resolve()

  constructor(
    private readonly grant: LocalProjectGrant,
    options: LocalWorktreeManagerOptions,
  ) {
    const configuredRoot = options.homeRoot ?? options.worktreeRoot
    if (!configuredRoot) {
      throw new LocalWorktreeError('invalid', 'a local agent home root is required')
    }
    this.homeRoot = assertAbsolutePath(configuredRoot, 'agent home root')
    this.storePath = assertAbsolutePath(
      options.storePath ?? join(this.homeRoot, '.cumora', 'worktrees.json'),
      'worktree store path',
    )
    this.patchRoot = assertAbsolutePath(
      options.patchRoot ?? join(dirname(this.storePath), 'patches'),
      'patch root',
    )
    this.lockPath = dirname(this.storePath)
    const lockKey = createHash('sha256')
      .update(process.platform === 'win32' ? resolve(this.grant.commonGitDir).toLowerCase() : resolve(this.grant.commonGitDir))
      .digest('hex')
    this.repositoryLockPath = join(dirname(this.homeRoot), 'repository-locks', lockKey)
    this.runGit = options.runGit ?? defaultGitRunner
    this.runGitBytes = options.runGitBytes ?? defaultGitBytesRunner
    this.runGitWithEnvironment = options.runGitWithEnvironment ?? defaultGitEnvironmentRunner
  }

  async listLeases(): Promise<WorktreeLease[]> {
    await this.operations
    return withLocalLocks([this.lockPath, this.repositoryLockPath], async () =>
      (await this.load()).leases.filter((lease) => lease.repositoryId === this.grant.id),
    )
  }

  async listHandoffs(): Promise<HandoffRecord[]> {
    await this.operations
    return withLocalLocks([this.lockPath, this.repositoryLockPath], async () =>
      (await this.load()).handoffs.filter((handoff) => handoff.repositoryId === this.grant.id),
    )
  }

  readHandoffPatch(handoffId: string): Promise<Buffer> {
    return this.enqueue(async () => {
      const handoff = this.requireHandoff(await this.load(), handoffId)
      await this.verifyPrivatePatch(handoff)
      return this.readPrivateFile(handoff.patchFile, 'handoff patch')
    })
  }

  /** Create or recover the one active mutable worktree for this repository/task/agent. */
  create(
    taskId: string,
    agentId: string,
    options: { baseCommit?: string; branch?: string } = {},
  ): Promise<WorktreeLease> {
    return this.enqueue(async () => {
      assertPathToken(taskId, 'task id')
      assertPathToken(agentId, 'agent id')
      await this.verifyGrantedRepository()
      const path = this.worktreePath(agentId, taskId)
      const document = await this.load()
      const existing = document.leases.find(
        (lease) =>
          lease.repositoryId === this.grant.id &&
          lease.taskId === taskId &&
          lease.agentId === agentId &&
          (lease.state === 'provisioning' || lease.state === 'active'),
      )
      if (existing) {
        if (existing.state === 'closed') {
          throw new LocalWorktreeError('conflict', `the worktree lease for ${taskId}/${agentId} is closed`)
        }
        if (options.branch && existing.branch !== options.branch) {
          throw new LocalWorktreeError('conflict', 'the existing lease uses a different branch')
        }
        if (existing.state === 'provisioning') {
          const active = await this.provisionBranchWorktree(existing)
          await this.update((current) => ({
            ...current,
            leases: current.leases.map((row) => (row.id === active.id ? active : row)),
          }))
          return active
        }
        return existing
      }

      const baseCommit = await this.resolveCommit(options.baseCommit ?? 'HEAD', this.grant.topLevel)
      const branch = await this.validateBranch(
        options.branch ?? `cumora/${agentId}/${taskId}`,
      )
      const branchOwner = document.leases.find(
        (lease) =>
          lease.repositoryId === this.grant.id &&
          lease.branch === branch &&
          lease.state !== 'closed',
      )
      if (branchOwner) {
        throw new LocalWorktreeError('conflict', `branch ${branch} is already leased`)
      }

      const stamp = now()
      const lease: WorktreeLease = {
        id: randomUUID(),
        repositoryId: this.grant.id,
        taskId,
        agentId,
        path,
        branch,
        baseCommit,
        headCommit: baseCommit,
        dirty: false,
        state: 'provisioning',
        ownerEpoch: 1,
        createdAt: stamp,
        updatedAt: stamp,
      }
      await this.update((current) => ({ ...current, leases: [...current.leases, lease] }))
      const active = await this.provisionBranchWorktree(lease)
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) => (row.id === active.id ? active : row)),
      }))
      return active
    })
  }

  async createLease(
    taskId: string,
    agentId: string,
    options: { baseCommit?: string; branch?: string } = {},
  ): Promise<WorktreeLease> {
    return this.create(taskId, agentId, options)
  }

  /** Return the live status for a worktree without exposing its Git metadata. */
  status(leaseId: string): Promise<{ lease: WorktreeLease; text: string }> {
    return this.enqueue(async () => {
      const document = await this.load()
      const lease = this.requireLease(document, leaseId)
      if (lease.state === 'closed') throw new LocalWorktreeError('conflict', 'the worktree lease is closed')
      const live = await this.inspectLease(lease)
      if (!live) throw new LocalWorktreeError('not-found', 'the leased worktree is missing')
      const text = await this.runGit(live.path, ['status', '--short', '--branch', '--untracked-files=all'])
      const updated: WorktreeLease = {
        ...lease,
        path: live.path,
        headCommit: live.headCommit,
        dirty: live.dirty,
        updatedAt: now(),
      }
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) => (row.id === leaseId ? updated : row)),
      }))
      return { lease: updated, text }
    })
  }

  /** Read a bounded, daemon-owned Git diff for a leased worktree. */
  diff(leaseId: string, options: { cached?: boolean } = {}): Promise<Buffer> {
    return this.enqueue(async () => {
      const document = await this.load()
      const lease = this.requireLease(document, leaseId)
      if (lease.state === 'closed') throw new LocalWorktreeError('conflict', 'the worktree lease is closed')
      const live = await this.inspectLease(lease)
      if (!live) throw new LocalWorktreeError('not-found', 'the leased worktree is missing')
      const args = [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        ...(options.cached ? ['--cached', 'HEAD'] : ['HEAD']),
        '--',
      ]
      return this.runGitBytes(live.path, args)
    })
  }

  /** Commit only the current filesystem snapshot, ignoring any existing Git index contents. */
  commit(leaseId: string, message: string, expectedHead: string): Promise<WorktreeLease> {
    return this.enqueue(async () => {
      if (typeof message !== 'string' || message.trim().length === 0 || message.length > 10_000 || message.includes('\0')) {
        throw new LocalWorktreeError('invalid', 'commit message must be non-empty and at most 10000 characters')
      }
      assertCommit(expectedHead, 'expected head')
      const document = await this.load()
      const lease = this.requireLease(document, leaseId)
      if (lease.state !== 'active') throw new LocalWorktreeError('conflict', 'only an active worktree can be committed')
      const live = await this.inspectLease(lease)
      if (!live) throw new LocalWorktreeError('not-found', 'the leased worktree is missing')
      if (live.headCommit !== expectedHead.toLowerCase()) {
        const parentLine = await this.runGit(live.path, ['rev-list', '--parents', '-n', '1', live.headCommit])
        const commitMessage = await this.runGit(live.path, ['show', '-s', '--format=%B', live.headCommit])
        const parentMatches = parentLine.split(/\s+/)[1]?.toLowerCase() === expectedHead.toLowerCase()
        if (parentMatches && commitMessage.trimEnd() === message.trimEnd()) {
          const currentIndexTree = await this.runGit(live.path, ['write-tree']).catch(() => '')
          const expectedTree = await this.runGit(live.path, ['rev-parse', `${expectedHead}^{tree}`]).catch(() => '')
          if (currentIndexTree === expectedTree) {
            await this.resetWorktreeIndex(live.path, live.headCommit)
          }
          const reconciled = await this.inspectLease(lease)
          if (!reconciled) throw new LocalWorktreeError('not-found', 'the leased worktree disappeared after commit')
          const updated: WorktreeLease = {
            ...lease,
            path: reconciled.path,
            headCommit: reconciled.headCommit,
            dirty: reconciled.dirty,
            updatedAt: now(),
          }
          await this.update((current) => ({
            ...current,
            leases: current.leases.map((row) => (row.id === leaseId ? updated : row)),
          }))
          return updated
        }
        throw new LocalWorktreeError('conflict', 'the worktree head changed; inspect status before committing')
      }
      if (live.branch !== lease.branch) throw new LocalWorktreeError('conflict', 'the worktree branch changed; inspect status before committing')

      const snapshot = await this.snapshotTree(live.path, expectedHead)
      const headTree = await this.runGit(live.path, ['rev-parse', `${expectedHead}^{tree}`])
      if (snapshot.tree === headTree) throw new LocalWorktreeError('conflict', 'the worktree has no changes to commit')

      const messageFile = join(dirname(this.storePath), `commit-message-${process.pid}-${randomUUID()}.txt`)
      await writeFile(messageFile, message, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      try {
        const authorEnvironment: NodeJS.ProcessEnv = {
          GIT_AUTHOR_NAME: 'Cumora Agent',
          GIT_AUTHOR_EMAIL: 'cumora-agent@localhost',
          GIT_COMMITTER_NAME: 'Cumora Agent',
          GIT_COMMITTER_EMAIL: 'cumora-agent@localhost',
        }
        const commit = await this.runGitWithEnvironment(
          live.path,
          this.gitWriteArgs(['commit-tree', snapshot.tree, '-p', expectedHead, '-F', messageFile]),
          authorEnvironment,
        )
        assertCommit(commit, 'created commit')

        const final = await this.snapshotTree(live.path, expectedHead)
        const currentHead = await this.resolveCommit('HEAD', live.path)
        if (final.tree !== snapshot.tree || currentHead !== expectedHead.toLowerCase()) {
          throw new LocalWorktreeError('conflict', 'the worktree changed while the commit was being prepared')
        }
        try {
          await this.runGit(
            this.grant.topLevel,
            this.gitWriteArgs(['update-ref', '--no-deref', `refs/heads/${lease.branch}`, commit, expectedHead]),
          )
        } catch (error) {
          if (hasGitExitCode(error, 1) || hasGitExitCode(error, 128)) {
            throw new LocalWorktreeError('conflict', 'the worktree branch changed while the commit was being published')
          }
          throw error
        }
        // Replace the shared index with the committed tree without touching the
        // worktree files. This removes stale user staging after the CAS update.
        await this.resetWorktreeIndex(live.path, commit)
      } catch (error) {
        if (error instanceof LocalWorktreeError) throw error
        throw new LocalWorktreeError('git', `cannot commit worktree: ${errorMessage(error)}`)
      } finally {
        await rm(messageFile, { force: true }).catch(() => undefined)
      }

      const committed = await this.inspectLease(lease)
      if (!committed) throw new LocalWorktreeError('not-found', 'the worktree disappeared after commit')
      const updated: WorktreeLease = {
        ...lease,
        path: committed.path,
        headCommit: committed.headCommit,
        dirty: committed.dirty,
        updatedAt: now(),
      }
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) => (row.id === leaseId ? updated : row)),
      }))
      return updated
    })
  }

  /** Re-check Git and persist the current live head/status for a lease. */
  snapshot(leaseId: string): Promise<WorktreeLease> {
    return this.enqueue(async () => {
      const document = await this.load()
      const lease = this.requireLease(document, leaseId)
      if (lease.state === 'closed') return lease
      const live = await this.inspectLease(lease)
      if (!live) throw new LocalWorktreeError('not-found', 'the leased worktree is missing')
      const updated: WorktreeLease = {
        ...lease,
        path: live.path,
        headCommit: live.headCommit,
        dirty: live.dirty,
        updatedAt: now(),
      }
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) => (row.id === leaseId ? updated : row)),
      }))
      return updated
    })
  }

  /** Pin a clean source commit and its private base-to-head patch. */
  proposeHandoff(leaseId: string, toAgentId: string): Promise<HandoffRecord> {
    return this.enqueue(async () => {
      assertPathToken(toAgentId, 'target agent id')
      const document = await this.load()
      const lease = this.requireLease(document, leaseId)
      if (lease.agentId === toAgentId) {
        throw new LocalWorktreeError('conflict', 'a handoff must use a distinct receiver worktree')
      }

      const firstLive = await this.inspectLease(lease)
      if (!firstLive) throw new LocalWorktreeError('not-found', 'the leased worktree is missing')
      if (firstLive.branch !== lease.branch) {
        throw new LocalWorktreeError('conflict', 'the worktree branch changed; inspect status before handing off')
      }
      if (firstLive.dirty) {
        throw new LocalWorktreeError('dirty', 'commit or discard local changes before handing off this worktree')
      }

      const duplicate = document.handoffs.find(
        (handoff) =>
          handoff.sourceWorktreeId === leaseId &&
          handoff.toAgentId === toAgentId &&
          handoff.sourceHeadCommit === firstLive.headCommit &&
          (handoff.state === 'proposed' || handoff.state === 'accepted'),
      )
      if (duplicate) return duplicate
      if (lease.state !== 'active') {
        throw new LocalWorktreeError('conflict', 'only an active worktree can be handed off')
      }

      const patch = await this.runGitBytes(this.grant.topLevel, [
        'diff',
        '--binary',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        lease.baseCommit,
        firstLive.headCommit,
        '--',
      ])
      const diffDigest = createHash('sha256').update(patch).digest('hex')
      const patchFile = await this.writePrivatePatch(diffDigest, patch)

      const secondLive = await this.inspectLease(lease)
      if (!secondLive) throw new LocalWorktreeError('not-found', 'the leased worktree disappeared')
      if (secondLive.branch !== lease.branch) {
        throw new LocalWorktreeError('conflict', 'the worktree branch changed while preparing the handoff')
      }
      if (secondLive.dirty) {
        throw new LocalWorktreeError('dirty', 'worktree became dirty while preparing the handoff')
      }
      if (secondLive.headCommit !== firstLive.headCommit) {
        throw new LocalWorktreeError('conflict', 'worktree head changed while preparing the handoff')
      }

      const stamp = now()
      const record: HandoffRecord = {
        id: randomUUID(),
        repositoryId: lease.repositoryId,
        taskId: lease.taskId,
        fromAgentId: lease.agentId,
        toAgentId,
        sourceWorktreeId: lease.id,
        targetWorktreeId: null,
        sourceBaseCommit: lease.baseCommit,
        sourceHeadCommit: firstLive.headCommit,
        targetHeadCommit: null,
        sourceDirty: false,
        patchFile,
        diffDigest,
        state: 'proposed',
        createdAt: stamp,
        acceptedAt: null,
      }
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) =>
          row.id === lease.id
            ? {
                ...row,
                path: secondLive.path,
                headCommit: secondLive.headCommit,
                dirty: false,
                state: 'handed_off',
                updatedAt: stamp,
              }
            : row,
        ),
        handoffs: [...current.handoffs, record],
      }))
      return record
    })
  }

  /** Explicitly accept a proposal into a distinct receiver-owned branch. */
  acceptHandoff(handoffId: string): Promise<{ handoff: HandoffRecord; lease: WorktreeLease }> {
    return this.enqueue(async () => {
      let document = await this.load()
      const handoff = this.requireHandoff(document, handoffId)
      if (handoff.state === 'accepted') {
        if (!handoff.targetWorktreeId) {
          throw new LocalWorktreeError('unsafe-store', 'accepted handoff has no target worktree')
        }
        return { handoff, lease: this.requireLease(document, handoff.targetWorktreeId) }
      }
      if (handoff.state !== 'proposed') {
        throw new LocalWorktreeError('conflict', 'handoff is no longer available')
      }

      const source = this.requireLease(document, handoff.sourceWorktreeId)
      if (source.agentId === handoff.toAgentId) {
        throw new LocalWorktreeError('conflict', 'handoff target must be a distinct agent')
      }
      await this.verifyPrivatePatch(handoff)
      await this.verifyGrantedRepository()
      const sourceHead = await this.resolveCommit(handoff.sourceHeadCommit, this.grant.topLevel)
      if (sourceHead !== handoff.sourceHeadCommit) {
        throw new LocalWorktreeError('conflict', 'handoff source commit is no longer available')
      }
      const sourceLive = await this.inspectLease(source)
      if (!sourceLive) throw new LocalWorktreeError('not-found', 'the handoff source worktree is missing')
      if (sourceLive.branch !== source.branch || sourceLive.headCommit !== handoff.sourceHeadCommit || sourceLive.dirty) {
        throw new LocalWorktreeError('conflict', 'handoff source changed after the proposal; create a new handoff')
      }

      let target = handoff.targetWorktreeId
        ? document.leases.find((lease) => lease.id === handoff.targetWorktreeId)
        : undefined
      const priorTargetLease = document.leases.find(
        (lease) =>
          lease.id !== handoff.targetWorktreeId &&
          lease.repositoryId === this.grant.id &&
          lease.taskId === handoff.taskId &&
          lease.agentId === handoff.toAgentId &&
          lease.state !== 'closed',
      )
      const targetPath = this.worktreePath(
        handoff.toAgentId,
        handoff.taskId,
        priorTargetLease ? handoff.id : undefined,
      )

      if (target && !['provisioning', 'active'].includes(target.state)) {
        throw new LocalWorktreeError('conflict', 'target handoff worktree is no longer available')
      }
      if (
        !target &&
        document.leases.some(
          (lease) =>
            lease.repositoryId === this.grant.id &&
            lease.taskId === handoff.taskId &&
            lease.agentId === handoff.toAgentId &&
            (lease.state === 'provisioning' || lease.state === 'active'),
        )
      ) {
        throw new LocalWorktreeError('conflict', 'target agent already has a worktree for this task')
      }
      if (!target) {
        const stamp = now()
        const branch = await this.validateBranch(`cumora/handoff/${handoff.id}`)
        if (
          document.leases.some(
            (lease) =>
              lease.repositoryId === this.grant.id &&
              lease.branch === branch &&
              lease.state !== 'closed',
          )
        ) {
          throw new LocalWorktreeError('conflict', `branch ${branch} is already leased`)
        }
        target = {
          id: randomUUID(),
          repositoryId: this.grant.id,
          taskId: handoff.taskId,
          agentId: handoff.toAgentId,
          path: targetPath,
          branch,
          baseCommit: handoff.sourceHeadCommit,
          headCommit: handoff.sourceHeadCommit,
          dirty: false,
          state: 'provisioning',
          ownerEpoch: 1,
          createdAt: stamp,
          updatedAt: stamp,
        }
        const createdTarget = target
        await this.update((current) => ({
          ...current,
          leases: [...current.leases, createdTarget],
          handoffs: current.handoffs.map((row) =>
            row.id === handoff.id ? { ...row, targetWorktreeId: createdTarget.id } : row,
          ),
        }))
        document = await this.load()
        const persisted = this.requireHandoff(document, handoffId)
        target = this.requireLease(document, persisted.targetWorktreeId ?? '')
      }

      if (target.path !== targetPath || !target.branch || target.baseCommit !== handoff.sourceHeadCommit) {
        throw new LocalWorktreeError('unsafe-store', 'handoff target lease does not match the fixed source commit')
      }
      const provisioned = await this.provisionBranchWorktree(target)
      if (provisioned.headCommit !== handoff.sourceHeadCommit || provisioned.dirty) {
        throw new LocalWorktreeError('conflict', 'handoff target changed while acceptance was being prepared')
      }

      const acceptedAt = now()
      const accepted: HandoffRecord = {
        ...handoff,
        targetWorktreeId: target.id,
        targetHeadCommit: handoff.sourceHeadCommit,
        state: 'accepted',
        acceptedAt,
      }
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) => row.id === target?.id ? { ...provisioned, state: 'active', updatedAt: acceptedAt } : row),
        handoffs: current.handoffs.map((row) => (row.id === handoffId ? accepted : row)),
      }))
      return { handoff: accepted, lease: { ...provisioned, state: 'active', updatedAt: acceptedAt } }
    })
  }

  rejectHandoff(handoffId: string): Promise<HandoffRecord> {
    return this.enqueue(async () => {
      const document = await this.load()
      const handoff = this.requireHandoff(document, handoffId)
      if (handoff.state === 'rejected') return handoff
      if (handoff.state !== 'proposed') {
        throw new LocalWorktreeError('conflict', 'only a proposed handoff can be rejected')
      }
      const rejected: HandoffRecord = { ...handoff, state: 'rejected' }
      const source = this.requireLease(document, handoff.sourceWorktreeId)
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) =>
          row.id === source.id && row.state === 'handed_off'
            ? { ...row, state: 'active', updatedAt: now() }
            : row,
        ),
        handoffs: current.handoffs.map((row) => (row.id === handoffId ? rejected : row)),
      }))
      return rejected
    })
  }

  /** Re-check live status and remove a clean mutable worktree. */
  close(leaseId: string): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.load()
      const lease = this.requireLease(document, leaseId)
      if (lease.state === 'closed') return
      const live = await this.inspectLease(lease)
      if (live?.dirty) {
        throw new LocalWorktreeError('dirty', 'cannot close a dirty worktree')
      }
      if (live) {
        try {
          await this.runGit(this.grant.topLevel, this.gitWriteArgs(['worktree', 'remove', lease.path]))
        } catch (error) {
          throw new LocalWorktreeError('git', `cannot remove clean worktree: ${errorMessage(error)}`)
        }
      }
      await this.update((current) => ({
        ...current,
        leases: current.leases.map((row) =>
          row.id === leaseId ? { ...row, dirty: false, state: 'closed', updatedAt: now() } : row,
        ),
      }))
    })
  }

  async flush(): Promise<void> {
    await this.operations
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operations.then(
      () => withLocalLocks([this.lockPath, this.repositoryLockPath], operation),
      () => withLocalLocks([this.lockPath, this.repositoryLockPath], operation),
    )
    this.operations = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private worktreePath(agentId: string, taskId: string, generation?: string): string {
    const leaf = generation
      ? `${taskId}--${createHash('sha256').update(generation).digest('hex').slice(0, 16)}`
      : taskId
    const path = resolve(this.homeRoot, this.grant.id, agentId, leaf)
    if (!isWithin(this.homeRoot, path)) {
      throw new LocalWorktreeError('invalid', 'worktree path must stay inside the agent home root')
    }
    return path
  }

  private hooksDisabledPath(): string {
    return join(dirname(this.storePath), 'empty-hooks')
  }

  private gitWriteArgs(args: string[]): string[] {
    return ['-c', `core.hooksPath=${this.hooksDisabledPath()}`, ...args]
  }

  private async snapshotTree(cwd: string, head: string): Promise<{ tree: string }> {
    const directory = join(dirname(this.storePath), 'snapshot-indexes')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const indexPath = join(directory, `${process.pid}-${randomUUID()}.index`)
    const environment: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexPath }
    try {
      await mkdir(this.hooksDisabledPath(), { recursive: true, mode: 0o700 })
      await this.runGitWithEnvironment(cwd, this.gitWriteArgs(['read-tree', head]), environment)
      await this.assertNoConfiguredFiltersForChanges(cwd)
      const filters = await this.gitFilterOverrides(cwd)
      await this.runGitWithEnvironment(
        cwd,
        this.gitWriteArgs([...filters, 'add', '--all']),
        environment,
      )
      const tree = await this.runGitWithEnvironment(cwd, this.gitWriteArgs(['write-tree']), environment)
      if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error('Git returned an invalid snapshot tree')
      await chmod(indexPath, 0o600).catch(() => undefined)
      return { tree: tree.toLowerCase() }
    } finally {
      await rm(indexPath, { force: true }).catch(() => undefined)
    }
  }

  private async resetWorktreeIndex(path: string, commit: string): Promise<void> {
    try {
      await this.runGit(path, this.gitWriteArgs(['read-tree', '--reset', commit]))
    } catch (error) {
      throw new LocalWorktreeError('git', `cannot reset worktree index after commit: ${errorMessage(error)}`)
    }
  }

  private async assertNoConfiguredFiltersForChanges(cwd: string): Promise<void> {
    const status = await this.runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const fields = status.split('\0')
    const paths: string[] = []
    for (let index = 0; index < fields.length; index++) {
      const entry = fields[index]
      if (!entry) continue
      if (entry.length < 4) throw new LocalWorktreeError('git', 'Git returned malformed worktree status')
      const code = entry.slice(0, 2)
      paths.push(entry.slice(3))
      if (/[RC]/.test(code)) {
        const pairedPath = fields[++index]
        if (pairedPath) paths.push(pairedPath)
      }
    }
    for (let start = 0; start < paths.length; start += 32) {
      const attributes = await this.runGitWithEnvironment(cwd, [
        'check-attr', '-z', 'filter', '--', ...paths.slice(start, start + 32),
      ], {})
      const values = attributes.split('\0')
      for (let index = 0; index + 2 < values.length; index += 3) {
        if (values[index + 1] === 'filter' && values[index + 2] !== 'unspecified' && values[index + 2] !== 'unset') {
          throw new LocalWorktreeError('unsupported', 'changed files use a Git clean filter; ask the operator to commit this change')
        }
      }
    }
  }

  private async gitFilterOverrides(cwd: string): Promise<string[]> {
    let output: string
    try {
      output = await this.runGit(cwd, ['config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|smudge)$'])
    } catch (error) {
      if (hasGitExitCode(error, 1)) return []
      throw new LocalWorktreeError('git', `cannot inspect Git filter configuration: ${errorMessage(error)}`)
    }
    const filters = new Set<string>()
    for (const key of output.split(/\r?\n/)) {
      const match = /^filter\.(.*)\.(?:clean|process|smudge)$/.exec(key)
      if (match?.[1]) filters.add(match[1])
    }
    return [...filters].flatMap((filter) => [
      '-c', `filter.${filter}.clean=`,
      '-c', `filter.${filter}.process=`,
      '-c', `filter.${filter}.smudge=`,
      '-c', `filter.${filter}.required=false`,
    ])
  }

  private async validateBranch(branch: string): Promise<string> {
    if (
      typeof branch !== 'string' ||
      branch.length === 0 ||
      branch.length > 240 ||
      branch.startsWith('-') ||
      /[\0-\x20\x7f~^:?*[\\]/.test(branch) ||
      branch.includes('..') ||
      branch.includes('@{') ||
      branch.startsWith('/') ||
      branch.endsWith('/') ||
      branch.endsWith('.') ||
      branch.endsWith('.lock') ||
      branch.includes('//')
    ) {
      throw new LocalWorktreeError('invalid', 'branch is not a valid Git branch name')
    }
    try {
      const checked = await this.runGit(this.grant.topLevel, ['check-ref-format', '--branch', branch])
      if (checked !== branch) {
        throw new Error('Git normalized the branch name')
      }
    } catch (error) {
      throw new LocalWorktreeError('invalid', `invalid Git branch: ${errorMessage(error)}`)
    }
    return branch
  }

  private async provisionBranchWorktree(lease: WorktreeLease): Promise<WorktreeLease> {
    if (!lease.branch) {
      throw new LocalWorktreeError('unsafe-store', 'mutable worktree lease has no branch')
    }
    let live = await this.inspectLease(lease)
    if (!live) {
      await mkdir(dirname(lease.path), { recursive: true, mode: 0o700 })
      try {
        await mkdir(this.hooksDisabledPath(), { recursive: true, mode: 0o700 })
        const safeConfig = this.gitWriteArgs(await this.gitFilterOverrides(this.grant.topLevel))
        const ref = `refs/heads/${lease.branch}`
        const branchExists = await this.runGit(this.grant.topLevel, ['show-ref', '--verify', '--quiet', ref]).then(() => true).catch((error) => {
          if (hasGitExitCode(error, 1)) return false
          throw error
        })
        if (branchExists) {
          const branchHead = await this.resolveCommit(ref, this.grant.topLevel)
          if (branchHead !== lease.baseCommit) {
            throw new LocalWorktreeError('conflict', 'the provisioning branch already points at another commit')
          }
          await this.runGit(this.grant.topLevel, [...safeConfig, 'worktree', 'add', lease.path, ref])
        } else {
          await this.runGit(this.grant.topLevel, [
            ...safeConfig,
            'worktree',
            'add',
            '-b',
            lease.branch,
            lease.path,
            lease.baseCommit,
          ])
        }
      } catch (error) {
        if (error instanceof LocalWorktreeError) throw error
        live = await this.inspectLease(lease)
        if (!live) {
          throw new LocalWorktreeError('git', `cannot create worktree: ${errorMessage(error)}`)
        }
      }
      live = await this.inspectLease(lease)
    }
    if (!live) throw new LocalWorktreeError('git', 'Git did not create the leased worktree')
    if (live.branch !== lease.branch) {
      throw new LocalWorktreeError('conflict', 'leased path is not checked out on its assigned branch')
    }
    if (live.dirty) {
      throw new LocalWorktreeError('dirty', 'recovered worktree contains uncommitted changes')
    }
    const active: WorktreeLease = {
      ...lease,
      path: live.path,
      headCommit: live.headCommit,
      dirty: false,
      state: 'active',
      updatedAt: now(),
    }
    return active
  }

  private async inspectLease(lease: WorktreeLease): Promise<LiveWorktree | null> {
    await this.verifyGrantedRepository()
    if (!isAbsolute(lease.path) || !isWithin(this.homeRoot, resolve(lease.path))) {
      throw new LocalWorktreeError('unsafe-store', 'worktree lease path is outside the agent home root')
    }
    const info = await lstat(lease.path).catch(() => null)
    if (!info) return null
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new LocalWorktreeError('unsafe-store', 'leased worktree path must be a real directory')
    }
    const physical = await realpath(lease.path).catch(() => null)
    if (!physical || !isWithin(this.homeRoot, physical)) {
      throw new LocalWorktreeError('unsafe-store', 'leased worktree path escaped the agent home root')
    }
    const topLevel = await realpath(
      await this.runGit(physical, ['rev-parse', '--show-toplevel']).catch((error) => {
        throw new LocalWorktreeError('git', `leased path is not a Git worktree: ${errorMessage(error)}`)
      }),
    )
    if (!samePath(topLevel, physical)) {
      throw new LocalWorktreeError('conflict', 'leased path is not the root of its Git worktree')
    }
    const commonGitDir = await realpath(
      await this.runGit(physical, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    )
    if (!samePath(commonGitDir, this.grant.commonGitDir)) {
      throw new LocalWorktreeError('conflict', 'leased path belongs to a different repository')
    }
    const headCommit = await this.resolveCommit('HEAD', physical)
    const status = await this.runGit(physical, [
      'status',
      '--porcelain=v2',
      '--untracked-files=all',
    ])
    const branch = await this.runGit(physical, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(
      () => '',
    )
    return {
      path: physical,
      headCommit,
      dirty: status.length > 0,
      branch: branch || null,
    }
  }

  private async verifyGrantedRepository(): Promise<void> {
    try {
      const root = await realpath(this.grant.topLevel)
      const topLevel = await realpath(await this.runGit(root, ['rev-parse', '--show-toplevel']))
      const gitDir = await realpath(await this.runGit(root, ['rev-parse', '--path-format=absolute', '--git-dir']))
      const commonGitDir = await realpath(await this.runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
      if (
        !samePath(root, this.grant.topLevel) ||
        !samePath(topLevel, this.grant.topLevel) ||
        !samePath(gitDir, this.grant.gitDir) ||
        !samePath(commonGitDir, this.grant.commonGitDir)
      ) {
        throw new LocalWorktreeError('conflict', 'the granted repository identity changed')
      }
    } catch (error) {
      if (error instanceof LocalWorktreeError) throw error
      throw new LocalWorktreeError('conflict', `the granted repository is no longer available: ${errorMessage(error)}`)
    }
  }

  private async resolveCommit(revision: string, cwd: string): Promise<string> {
    if (
      typeof revision !== 'string' ||
      revision.length === 0 ||
      revision.length > 240 ||
      revision.startsWith('-') ||
      /[\0-\x20\x7f~^:?*[\\]/.test(revision) ||
      revision.includes('..') ||
      revision.includes('@{')
    ) {
      throw new LocalWorktreeError('invalid', 'revision is not a safe Git ref')
    }
    try {
      const resolved = await this.runGit(cwd, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${revision}^{commit}`,
      ])
      if (!COMMIT_PATTERN.test(resolved)) {
        throw new Error('Git returned an invalid commit id')
      }
      return resolved.toLowerCase()
    } catch (error) {
      throw new LocalWorktreeError('git', `cannot resolve commit ${revision}: ${errorMessage(error)}`)
    }
  }

  private requireLease(document: LocalWorktreeDocument, leaseId: string): WorktreeLease {
    const lease = document.leases.find((row) => row.id === leaseId && row.repositoryId === this.grant.id)
    if (!lease) throw new LocalWorktreeError('not-found', `worktree lease ${leaseId} was not found`)
    return lease
  }

  private requireHandoff(document: LocalWorktreeDocument, handoffId: string): HandoffRecord {
    const handoff = document.handoffs.find((row) => row.id === handoffId && row.repositoryId === this.grant.id)
    if (!handoff) throw new LocalWorktreeError('not-found', `handoff ${handoffId} was not found`)
    return handoff
  }

  private async verifyPrivatePatch(handoff: HandoffRecord): Promise<void> {
    const patch = await this.readPrivateFile(handoff.patchFile, 'handoff patch')
    const digest = createHash('sha256').update(patch).digest('hex')
    if (digest !== handoff.diffDigest) {
      throw new LocalWorktreeError('conflict', 'handoff patch digest does not match its metadata')
    }
  }

  private async writePrivatePatch(digest: string, patch: Buffer): Promise<string> {
    await mkdir(this.patchRoot, { recursive: true, mode: 0o700 })
    const patchFile = join(this.patchRoot, `${digest}.patch`)
    const existing = await lstat(patchFile).catch(() => null)
    if (existing) {
      const bytes = await this.readPrivateFile(patchFile, 'handoff patch')
      const existingDigest = createHash('sha256').update(bytes).digest('hex')
      if (existingDigest !== digest) {
        throw new LocalWorktreeError('conflict', 'existing handoff patch has the wrong digest')
      }
      return patchFile
    }
    const temporary = `${patchFile}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, patch, { flag: 'wx', mode: 0o600 })
      await rename(temporary, patchFile)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    const written = await lstat(patchFile)
    assertPrivateMode(written.mode, 'handoff patch')
    return patchFile
  }

  private async load(): Promise<LocalWorktreeDocument> {
    try {
      const raw = await this.readPrivateFile(this.storePath, 'local worktree store')
      return parseDocument(raw.toString('utf8'), this.homeRoot, this.patchRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, leases: [], handoffs: [] }
      }
      throw error
    }
  }

  private async readPrivateFile(path: string, label: string): Promise<Buffer> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new LocalWorktreeError('unsafe-store', `${label} must be a regular local file`)
    }
    assertPrivateMode(info.mode, label)
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(path, constants.O_RDONLY | noFollow)
    try {
      const opened = await handle.stat()
      if (!opened.isFile()) {
        throw new LocalWorktreeError('unsafe-store', `${label} must be a regular local file`)
      }
      assertPrivateMode(opened.mode, label)
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }

  private async update(
    mutate: (document: LocalWorktreeDocument) => LocalWorktreeDocument,
  ): Promise<void> {
    const current = await this.load()
    const next = mutate(current)
    parseDocument(JSON.stringify(next), this.homeRoot, this.patchRoot)
    await mkdir(dirname(this.storePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, this.storePath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

async function withLocalLocks<T>(paths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort()
  const releases: Array<() => Promise<void>> = []
  try {
    for (const path of ordered) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      releases.push(await lockfile.lock(path, { retries: { retries: 120, minTimeout: 25, maxTimeout: 250 } }))
    }
    return await operation()
  } finally {
    for (const release of releases.reverse()) await release()
  }
}
