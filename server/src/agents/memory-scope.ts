/**
 * Project-scoped agent memory — the shared write/filter contract used by
 * BOTH the cloud path (`loadMemory` / `cumora memory` / FUSE writes) and
 * the BYOA daemon (`memoryDigest`). One identity, many groups: unpinned
 * work facts stay in the project that produced them; identity, persona,
 * skills, climate, and pinned memories stay global.
 *
 * Existing rows/files with no project provenance stay GLOBAL. This module
 * never migrates old memories into a project — that would be fake
 * isolation (live writes historically hardcoded `source: null`).
 *
 * Layout (BYOA local FS, and new cloud writes when a project is known):
 *   memory/MEMORY.md                      global index (legacy location)
 *   memory/<kind>/<id>.md                 global notes
 *   memory/projects/<projectId>/MEMORY.md per-project index
 *   memory/projects/<projectId>/<kind>/<id>.md
 *
 * Filter truth table (read of unpinned work vs pinned/identity):
 *   pinned                  → always visible
 *   no project on the row   → always visible (global, including legacy)
 *   project P, wake in P    → visible
 *   project P, wake in Q    → hidden
 *   project P, no-project conversation → hidden
 *   wake spanning P and Q   → P and Q visible; other projects hidden
 *
 * Persona / climate / skills are NOT in this file on purpose: they are
 * loaded by dedicated paths (`loadClimate`, `loadSkillsIndex`, persona)
 * that stay per-agent and global.
 */
export interface MemorySource {
  conversationId: string | null
  projectId: string | null
}

export interface MemoryScopeMeta {
  pinned?: boolean
  source?: MemorySource | null
}

/** Current wake/read context. Empty `projectIds` = no-project conversation(s)
 *  → inject GLOBAL memory only. */
export interface MemoryReadScope {
  projectIds: readonly string[]
}

export const MEMORY_ROOT = 'memory'
export const MEMORY_PROJECTS_DIR = 'memory/projects'
export const GLOBAL_MEMORY_INDEX = 'memory/MEMORY.md'
export const DEFAULT_MEMORY_DIGEST_CHARS = 4000

export interface ParsedMemoryPath {
  /** Path kind segment (`observation` / `note` / `index` for MEMORY.md). */
  kind: string
  /** File stem without `.md`. */
  id: string
  /** Project id when the path is under `memory/projects/<id>/`; else null. */
  projectId: string | null
}

/** Stamp stored on every NEW memory write. */
export function buildMemorySource(opts: {
  conversationId?: string | null
  projectId?: string | null
}): MemorySource {
  return {
    conversationId: opts.conversationId ?? null,
    projectId: opts.projectId ?? null,
  }
}

export function uniqueProjectIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Decide provenance for a new write. Path `memory/projects/<id>/…` wins
 * (the agent already chose a project folder). An explicit conversation
 * or project flag is next. Ambient "I'm thinking in these rooms" is
 * used only when it is unambiguous — mixed projects fall back to
 * GLOBAL rather than guessing, which would be fake isolation.
 */
export function pickWriteProvenance(opts: {
  explicitConversationId?: string | null
  explicitProjectId?: string | null
  path?: string
  thinking?: ReadonlyArray<{ conversationId: string; projectId: string | null }>
}): MemorySource {
  const fromPath = opts.path ? projectIdFromMemoryPath(opts.path) : null
  const thinking = opts.thinking ?? []
  const explicitConvo = emptyToNull(opts.explicitConversationId)
  const explicitProject = emptyToNull(opts.explicitProjectId)

  let conversationId: string | null = explicitConvo
  let projectId: string | null = fromPath ?? explicitProject

  if (!conversationId && thinking.length === 1) {
    conversationId = thinking[0].conversationId
  }

  if (!projectId) {
    if (explicitConvo) {
      const hit = thinking.find((t) => t.conversationId === explicitConvo)
      projectId = hit?.projectId ?? null
    } else {
      const pids = uniqueProjectIds(thinking.map((t) => t.projectId))
      if (pids.length === 1) projectId = pids[0]
      // 0 or 2+ distinct projects → leave null (global). Mixed attribution
      // would pin the note to the wrong room.
    }
  }

  if (!conversationId && projectId && thinking.length > 0) {
    const matches = thinking.filter((t) => t.projectId === projectId)
    if (matches.length === 1) conversationId = matches[0].conversationId
  }

  return buildMemorySource({ conversationId, projectId })
}

export function buildMemoryMeta(opts: {
  path: string
  kind?: string
  about?: string | null
  pinned?: boolean
  conversationId?: string | null
  projectId?: string | null
  createdAt?: string
}): Record<string, unknown> {
  const parsed = parseMemoryPath(opts.path)
  const source = pickWriteProvenance({
    explicitConversationId: opts.conversationId,
    explicitProjectId: opts.projectId,
    path: opts.path,
  })
  const segs = opts.path.split('/')
  const kind = opts.kind ?? parsed?.kind ?? segs[1] ?? 'note'
  return {
    type: 'memory',
    kind,
    about: opts.about ?? null,
    pinned: Boolean(opts.pinned),
    source,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  }
}

export function parseMemoryPath(path: string): ParsedMemoryPath | null {
  if (!path.startsWith('memory/')) return null
  const segs = path.split('/')
  const projectId = segs[1] === 'projects' && segs[2] ? segs[2] : null
  const rest = projectId ? segs.slice(3) : segs.slice(1)
  if (rest.length === 0) return { kind: 'index', id: '', projectId }
  if (rest.length === 1) {
    const stem = rest[0].replace(/\.md$/, '')
    const kind = stem.toUpperCase() === 'MEMORY' ? 'index' : 'note'
    return { kind, id: stem, projectId }
  }
  const kind = rest[0] || 'note'
  const id = rest[rest.length - 1].replace(/\.md$/, '')
  return { kind, id, projectId }
}

export function projectIdFromMemoryPath(path: string): string | null {
  return parseMemoryPath(path)?.projectId ?? null
}

export function memoryWritePath(kind: string, id: string, projectId?: string | null): string {
  const k = kind || 'note'
  const file = `${id}.md`
  if (projectId) return `${MEMORY_PROJECTS_DIR}/${projectId}/${k}/${file}`
  return `${MEMORY_ROOT}/${k}/${file}`
}

export function projectMemoryIndexPath(projectId: string): string {
  return `${MEMORY_PROJECTS_DIR}/${projectId}/MEMORY.md`
}

/** Index files a wake should inject: always the global MEMORY.md, plus
 *  one per current project. No-project wake → global only. Existing
 *  `memory/MEMORY.md` stays the global index — we never move it. */
export function memoryIndexPathsForScope(projectIds: readonly string[]): string[] {
  const paths = [GLOBAL_MEMORY_INDEX]
  for (const id of uniqueProjectIds(projectIds)) {
    paths.push(projectMemoryIndexPath(id))
  }
  return paths
}

/** Project id stamped on a row: meta.source.projectId, else the path. */
export function rowProjectId(
  meta: MemoryScopeMeta | null | undefined,
  path?: string | null,
): string | null {
  const fromMeta = emptyToNull(meta?.source?.projectId)
  if (fromMeta) return fromMeta
  return path ? projectIdFromMemoryPath(path) : null
}

/**
 * Should this memory be injected for the current wake?
 *
 * Pinned memories are identity — always global, even if they were
 * written inside a project. Unpinned memories with no project (legacy
 * `source: null`, no-project writes, the global index) are global.
 * Unpinned project memories are visible only when that project is in
 * the current scope. A no-project conversation therefore sees GLOBAL
 * memory only.
 */
export function memoryVisibleInScope(
  meta: MemoryScopeMeta | null | undefined,
  path: string | undefined,
  scope: MemoryReadScope,
): boolean {
  if (meta?.pinned) return true
  const pid = rowProjectId(meta, path)
  if (!pid) return true
  return scope.projectIds.includes(pid)
}

export function filterMemories<T extends { meta?: MemoryScopeMeta | null; path?: string }>(
  rows: readonly T[],
  scope: MemoryReadScope,
): T[] {
  return rows.filter((r) => memoryVisibleInScope(r.meta, r.path, scope))
}

export function clipMemoryDigest(text: string, maxChars = DEFAULT_MEMORY_DIGEST_CHARS): string {
  const txt = text.trim()
  if (!txt) return ''
  if (txt.length <= maxChars) return txt
  return `${txt.slice(0, maxChars)}\n…(truncated — cat the file for the rest)`
}

/**
 * Join global + current-project index bodies. A lone global index is
 * returned as-is (clipped) so existing BYOA wakes stay byte-identical
 * when the agent has no project files yet.
 */
export function composeMemoryDigest(
  parts: ReadonlyArray<{ label: string; body: string }>,
  maxChars = DEFAULT_MEMORY_DIGEST_CHARS,
): string {
  const nonempty = parts.filter((p) => p.body.trim().length > 0)
  if (nonempty.length === 0) return ''
  if (nonempty.length === 1 && nonempty[0].label === GLOBAL_MEMORY_INDEX) {
    return clipMemoryDigest(nonempty[0].body, maxChars)
  }
  const chunks: string[] = []
  for (const p of nonempty) {
    const pid = projectIdFromMemoryPath(p.label)
    const header = pid ? `## project ${pid} (\`${p.label}\`)` : `## global (\`${p.label}\`)`
    chunks.push(`${header}\n${p.body.trim()}`)
  }
  return clipMemoryDigest(chunks.join('\n\n'), maxChars)
}

/** BYOA / cloud wake digest header. A project-less conversation is
 *  byte-identical to the historical `# id [kind] "title"` + optional
 *  Topic line — `Project:` is added only when a name is present. */
export function conversationHeader(row: {
  conversation_id: string
  conversation_kind?: string | null
  conversation_title?: string | null
  conversation_topic?: string | null
  project_name?: string | null
}): string {
  const kind = row.conversation_kind ? ` [${row.conversation_kind}]` : ''
  const title = row.conversation_title ? ` "${row.conversation_title}"` : ''
  let head = `# ${row.conversation_id}${kind}${title}`
  if (row.project_name) head += `\n  Project: ${row.project_name}`
  if (row.conversation_topic) head += `\n  Topic: ${row.conversation_topic}`
  return head
}

function emptyToNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s ? s : null
}
