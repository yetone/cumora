/**
 * I/O adapter on top of memory-scope.ts: resolve conversation/project
 * provenance for a live write. Callers (cli `memory note`, FUSE
 * /runtime/fs/write, workspace write into memory/) share this so Cloud
 * and BYOA don't grow two attribution schemes.
 *
 * Fail-open: Redis/DB hiccups stamp GLOBAL provenance (nulls) rather
 * than blocking the write or guessing a project.
 */
import { pool } from '../db/pool.js'
import { getThinkingConversations } from './thinking-convos.js'
import {
  buildMemoryMeta,
  pickWriteProvenance,
  projectIdFromMemoryPath,
  type MemorySource,
} from './memory-scope.js'

/** Check only project-scoped writes, immediately before INSERT. No trigger or lock.
 * A write racing deletion is removed by the delayed project cleanup job. */
export async function assertMemoryProjectExists(companyId: string | null | undefined, path: string, meta: Record<string, unknown> | null): Promise<void> {
  if (!path.startsWith('memory/')) return
  const source = meta?.source as { projectId?: string | null } | null | undefined
  const ids = [...new Set([projectIdFromMemoryPath(path), source?.projectId].filter((id): id is string => Boolean(id)))]
  if (!ids.length) return
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM projects WHERE company_id = $1 AND id = ANY($2::text[])`, [companyId, ids])
  if (rows.length !== ids.length) throw new Error('Cannot write memory for a deleted or unknown project')
}

export async function resolveMemoryWriteSource(
  agentId: string,
  opts: {
    path?: string
    conversationId?: string | null
    projectId?: string | null
  } = {},
): Promise<MemorySource> {
  const explicit = typeof opts.conversationId === 'string' && opts.conversationId.trim()
    ? opts.conversationId.trim()
    : null
  let ids: string[] = explicit ? [explicit] : []
  if (ids.length === 0) {
    try {
      ids = await getThinkingConversations(agentId)
    } catch {
      ids = []
    }
  }
  let thinking: Array<{ conversationId: string; projectId: string | null }> = []
  if (ids.length > 0) {
    try {
      const { rows } = await pool.query<{ id: string; project_id: string | null }>(
        `SELECT id, project_id FROM conversations WHERE id = ANY($1::text[])`,
        [ids],
      )
      const byId = new Map(rows.map((r) => [r.id, r.project_id ?? null]))
      thinking = ids.map((id) => ({ conversationId: id, projectId: byId.get(id) ?? null }))
    } catch {
      thinking = ids.map((id) => ({ conversationId: id, projectId: null }))
    }
  }
  return pickWriteProvenance({
    explicitConversationId: explicit,
    explicitProjectId: opts.projectId ?? null,
    path: opts.path,
    thinking,
  })
}

export async function memoryMetaForWrite(
  agentId: string,
  opts: {
    path: string
    kind?: string
    about?: string | null
    pinned?: boolean
    conversationId?: string | null
    projectId?: string | null
  },
): Promise<Record<string, unknown>> {
  const source = await resolveMemoryWriteSource(agentId, opts)
  return buildMemoryMeta({
    path: opts.path,
    kind: opts.kind,
    about: opts.about,
    pinned: opts.pinned,
    conversationId: source.conversationId,
    projectId: source.projectId,
  })
}

export async function projectIdsForConversations(conversationIds: string[]): Promise<string[]> {
  if (conversationIds.length === 0) return []
  try {
    const { rows } = await pool.query<{ project_id: string }>(
      `SELECT DISTINCT project_id FROM conversations
        WHERE id = ANY($1::text[]) AND project_id IS NOT NULL`,
      [conversationIds],
    )
    return rows.map((r) => r.project_id)
  } catch {
    return []
  }
}
