import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import lockfile from 'proper-lockfile'

export interface LocalProjectGrant {
  /** Stable identifier for local grant/revoke operations. */
  id: string
  /** Canonical Git worktree root. Kept on this machine only. */
  topLevel: string
  /** Canonical worktree-specific Git directory. */
  gitDir: string
  /** Canonical shared Git directory (common across linked worktrees). */
  commonGitDir: string
  /** Server-owned project identity. Cumora never interprets this value. */
  cloudProjectId: string | null
  grantedAt: string
  updatedAt: string
}

interface LocalProjectDocument {
  version: 1
  projects: LocalProjectGrant[]
}

const STORE_VERSION = 1
const GRANT_KEYS = [
  'cloudProjectId',
  'commonGitDir',
  'gitDir',
  'grantedAt',
  'id',
  'topLevel',
  'updatedAt',
] as const

export function defaultLocalProjectStorePath(home = homedir()): string {
  return join(home, '.cumora', 'local-projects.json')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function assertGrant(value: unknown, index: number): asserts value is LocalProjectGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`local project record ${index} is not an object`)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== GRANT_KEYS.length || keys.some((key, i) => key !== GRANT_KEYS[i])) {
    throw new Error(`local project record ${index} has unexpected fields`)
  }
  if (!isNonEmptyString(record.id)) throw new Error(`local project record ${index} has no id`)
  for (const field of ['topLevel', 'gitDir', 'commonGitDir'] as const) {
    if (!isNonEmptyString(record[field]) || !isAbsolute(record[field])) {
      throw new Error(`local project record ${index} has an invalid ${field}`)
    }
  }
  if (record.cloudProjectId !== null && !isNonEmptyString(record.cloudProjectId)) {
    throw new Error(`local project record ${index} has an invalid cloudProjectId`)
  }
  if (!isTimestamp(record.grantedAt) || !isTimestamp(record.updatedAt)) {
    throw new Error(`local project record ${index} has invalid timestamps`)
  }
}

function parseDocument(raw: string): LocalProjectGrant[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('local project store is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local project store has an invalid document')
  }
  const document = value as Record<string, unknown>
  if (Object.keys(document).sort().join(',') !== 'projects,version' || document.version !== STORE_VERSION) {
    throw new Error('local project store has an unsupported version or fields')
  }
  if (!Array.isArray(document.projects)) {
    throw new Error('local project store has no projects array')
  }
  assertProjects(document.projects)
  return document.projects as LocalProjectGrant[]
}

function assertProjects(values: readonly unknown[]): asserts values is LocalProjectGrant[] {
  values.forEach(assertGrant)
  const grants = values as LocalProjectGrant[]
  const ids = new Set<string>()
  const roots = new Set<string>()
  for (const grant of grants) {
    if (ids.has(grant.id)) throw new Error('local project store contains a duplicate id')
    if (roots.has(grant.topLevel)) throw new Error('local project store contains a duplicate repository')
    ids.add(grant.id)
    roots.add(grant.topLevel)
  }
}

/**
 * Private, local-only persistence for repository grants.
 *
 * The store deliberately has no server client or upload path. Updates are
 * serialized, and every replacement is written beside the destination as a
 * mode-0600 file before being atomically renamed into place.
 */
export class LocalProjectStore {
  readonly filePath: string
  readonly lockPath: string
  private writes: Promise<void> = Promise.resolve()

  constructor(filePath = defaultLocalProjectStorePath()) {
    this.filePath = filePath
    this.lockPath = dirname(filePath)
  }

  async load(): Promise<LocalProjectGrant[]> {
    await this.writes
    return this.loadUnqueued()
  }

  /** Apply a read-modify-write operation without racing other store writes. */
  update<T>(
    mutate: (projects: readonly LocalProjectGrant[]) => {
      projects: LocalProjectGrant[]
      result: T
    },
  ): Promise<T> {
    return this.enqueue(async () => {
      return withLocalLock(this.lockPath, async () => {
        const current = await this.loadUnqueued()
        const next = mutate(current)
        assertProjects(next.projects)
        await this.atomicWrite(next.projects)
        return next.result
      })
    })
  }

  async replace(projects: LocalProjectGrant[]): Promise<void> {
    assertProjects(projects)
    await this.enqueue(() => withLocalLock(this.lockPath, () => this.atomicWrite(projects)))
  }

  async flush(): Promise<void> {
    await this.writes
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writes.then(operation, operation)
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async loadUnqueued(): Promise<LocalProjectGrant[]> {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      const pathInfo = await lstat(this.filePath)
      if (!pathInfo.isFile()) throw new Error('local project store must be a regular local file')
      if (process.platform !== 'win32' && (pathInfo.mode & 0o077) !== 0) {
        throw new Error('local project store must have 0600 permissions')
      }

      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      handle = await open(this.filePath, constants.O_RDONLY | noFollow)
      const opened = await handle.stat()
      if (!opened.isFile()) throw new Error('local project store must be a regular local file')
      if (process.platform !== 'win32' && (opened.mode & 0o077) !== 0) {
        throw new Error('local project store must have 0600 permissions')
      }
      return parseDocument(await handle.readFile('utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private async atomicWrite(projects: LocalProjectGrant[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    const document: LocalProjectDocument = { version: STORE_VERSION, projects }
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, this.filePath)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

async function withLocalLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await mkdir(path, { recursive: true, mode: 0o700 })
  const release = await lockfile.lock(path, { retries: { retries: 120, minTimeout: 25, maxTimeout: 250 } })
  try { return await operation() }
  finally { await release() }
}
