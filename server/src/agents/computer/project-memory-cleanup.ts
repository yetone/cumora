import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

export interface DeletedProjectMemory {
  projectId: string
  agentIds: string[]
}

function safeComponent(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)
}

/** Find actual local project directories, including homes of agents moved away.
 * Server-side memory rows cannot describe memories written only on this device. */
export async function localProjectMemoryTargets(agentsRoot: string, projectId: string): Promise<DeletedProjectMemory> {
  if (!safeComponent(projectId)) throw new Error('invalid project cleanup ID')
  const agentIds: string[] = []
  let entries: string[]
  try { entries = await readdir(agentsRoot) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projectId, agentIds }
    throw error
  }
  for (const id of entries) {
    if (!safeComponent(id)) continue
    try {
      await lstat(join(agentsRoot, id, 'memory', 'projects', projectId))
      agentIds.push(id)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return { projectId, agentIds }
}

/** Safe to replay after failed cleanup or acknowledgement.
 * Never follow a junction/symlink in an engine-writable agent home. */
export async function cleanupDeletedProjectMemories(agentsRoot: string, deletions: DeletedProjectMemory[]): Promise<void> {
  if (!deletions.length) return
  let root: string
  try { root = await realpath(agentsRoot) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const errors: unknown[] = []
  for (const deletion of deletions) {
    if (!safeComponent(deletion.projectId) || !Array.isArray(deletion.agentIds)) continue
    for (const agentId of deletion.agentIds) {
      if (!safeComponent(agentId)) continue
      try {
        let target = root
        for (const component of [agentId, 'memory', 'projects', deletion.projectId]) {
          target = join(target, component)
          const stat = await lstat(target)
          if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe project memory directory: ${target}`)
        }
        const actual = await realpath(target)
        const within = relative(root, actual)
        if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('project memory path escapes agent storage')
        await rm(target, { recursive: true, force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error)
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'project memory cleanup failed; retry required')
}
