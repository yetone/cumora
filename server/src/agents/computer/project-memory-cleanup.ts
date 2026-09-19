import { lstat, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

export interface DeletedProjectMemory {
  projectId: string
  agentIds: string[]
}

function safeComponent(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)
}

/** Replayed every heartbeat, so offline devices and late writes are cleaned on retry.
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
  if (errors.length) throw new AggregateError(errors, 'project memory cleanup failed; retrying on next heartbeat')
}
