/**
 * `/runtime/fs/*` — the Pod's FUSE driver talks to these endpoints
 * to make `/workspace` look like a real filesystem backed by the
 * agent's slice of `agent_workspace`.
 *
 * Auth: same JWT as the rest of /runtime. The JWT pins `agentId`;
 * every query here is parametrized by `c.sub`, so a Pod literally
 * cannot read or write another agent's workspace even with a forged
 * path argument — the server's pool is the only thing talking to
 * Postgres.
 *
 * Why we keep this separate from /runtime/cli: the FUSE driver is
 * hot-path (every read_file / write_file / readdir from inside the
 * Pod becomes a request), so we want narrow, cheap endpoints. The
 * `/runtime/cli` general-purpose path is for the LLM's bash tool,
 * which doesn't need this granularity.
 *
 * Path discipline:
 *   - Paths are relative (no leading slash). Empty string = root.
 *   - Reject `..`, NUL bytes, absolute paths — same `isSafePath`
 *     guard the legacy fs-namespace had.
 *   - Implicit directories: any path prefix that's a parent of an
 *     existing row counts as a directory. There are no explicit
 *     directory rows in `agent_workspace`.
 */
import { json, type Router, type Response } from 'express'
import { pool } from '../../db/pool.js'
import { isSafePath, likeEscape } from './fs-namespace.js'
import type { AgentRuntimeClaims } from './jwt.js'
import { buildMemoryMeta } from '../memory-scope.js'
import { memoryMetaForWrite } from '../memory-write.js'

function badRequest(res: Response, msg: string): void {
  res.status(400).json({ error: msg })
}

function ensureSafePath(p: string | undefined, res: Response): string | null {
  if (p === undefined || p === null) {
    badRequest(res, 'path required')
    return null
  }
  // Allow empty string (root). Otherwise enforce shape.
  if (p === '') return ''
  if (!isSafePath(p)) {
    badRequest(res, `unsafe path: ${p}`)
    return null
  }
  return p
}

/** Memory paths land with a small meta JSONB so downstream readers
 *  (the semantic-retrieval pipeline, observability views) treat them
 *  as memory rather than scratch. Other paths get an empty meta. */
/** Sync stamp used when we only have the path (no agent). Live writes
 *  go through {@link memoryMetaForWrite} so conversation/project land
 *  in `source` instead of null. */
export function metaForPath(p: string, source?: { conversationId?: string | null; projectId?: string | null }): Record<string, unknown> {
  if (p.startsWith('memory/')) {
    return buildMemoryMeta({
      path: p,
      conversationId: source?.conversationId,
      projectId: source?.projectId,
    })
  }
  return {}
}

/** Register the /runtime/fs/* routes on a router that already has
 *  auth middleware applied. `withAgent` wraps each handler so claims
 *  are typed-in. */
export function attachFsEndpoints(
  router: Router,
  withAgent: (handler: (c: AgentRuntimeClaims, req: import('express').Request, res: Response) => Promise<void>) => import('express').RequestHandler,
): void {

  // GET /runtime/fs/list?path=<dir>   — children of <dir>
  // Returns { entries: [{ name: string, isDir: boolean }] }
  router.get('/fs/list', withAgent(async (c, req, res) => {
    const dir = ensureSafePath(typeof req.query.path === 'string' ? req.query.path : '', res)
    if (dir === null) return
    const prefix = dir === '' ? '' : dir + '/'
    // ESCAPE '\\' on the LIKE so user-supplied `%` and `_` chars in
    // `dir` get treated as literals after likeEscape, not as
    // wildcards. Otherwise `path=foo_bar` would also match
    // `fooxbar/...`. Cross-agent isolation is intact regardless (the
    // `agent_id = $1` clause is JWT-pinned), but the API contract is
    // "list children of EXACTLY this prefix."
    const { rows } = await pool.query<{ path: string }>(
      `SELECT path FROM agent_workspace WHERE agent_id = $1 AND path LIKE $2 || '%' ESCAPE '\\'`,
      [c.sub, likeEscape(prefix)],
    )
    const seen = new Map<string, boolean>()    // name → isDir
    for (const r of rows) {
      const rel = r.path.slice(prefix.length)
      if (!rel) continue
      const slash = rel.indexOf('/')
      if (slash < 0) seen.set(rel, false)
      else seen.set(rel.slice(0, slash), true)
    }
    res.json({ entries: [...seen.entries()].map(([name, isDir]) => ({ name, isDir })) })
  }))

  // GET /runtime/fs/read?path=<file>  — file body (text)
  router.get('/fs/read', withAgent(async (c, req, res) => {
    const p = ensureSafePath(typeof req.query.path === 'string' ? req.query.path : '', res)
    if (p === null) return
    if (p === '') { badRequest(res, 'cannot read root'); return }
    const { rows } = await pool.query<{ body: string }>(
      `SELECT body FROM agent_workspace WHERE agent_id = $1 AND path = $2 LIMIT 1`,
      [c.sub, p],
    )
    if (rows.length === 0) { res.status(404).json({ error: 'not found' }); return }
    res.json({ body: rows[0].body })
  }))

  // PUT /runtime/fs/write   { path, body }   — upsert
  // FUSE flushes the whole file in one JSON request. Preserve the historical
  // 34MB compatibility ceiling, but install it here so runtime authentication
  // and current-assignment validation always run before the body is consumed.
  router.put('/fs/write', json({ limit: '34mb' }), withAgent(async (c, req, res) => {
    const body = req.body as { path?: string; body?: string; conversationId?: string } | undefined
    const p = ensureSafePath(body?.path, res)
    if (p === null) return
    if (p === '') { badRequest(res, 'cannot write root'); return }
    const text = typeof body?.body === 'string' ? body.body : ''
    const meta = p.startsWith('memory/')
      ? await memoryMetaForWrite(c.sub, { path: p, conversationId: body?.conversationId ?? null })
      : metaForPath(p)
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, meta, company_id, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (agent_id, path) DO UPDATE
         SET body = EXCLUDED.body,
             company_id = COALESCE(EXCLUDED.company_id, agent_workspace.company_id),
             meta = COALESCE(agent_workspace.meta, EXCLUDED.meta),
             updated_at = NOW()`,
      [c.sub, p, text, JSON.stringify(meta), c.companyId],
    )
    // Memory paths get re-embedded asynchronously by the embeddings
    // worker on the server (fire-and-forget). Done out-of-band so the
    // FUSE write call returns quickly.
    if (p.startsWith('memory/')) {
      void (async () => {
        try {
          const { embedText } = await import('../embeddings.js')
          const vec = await embedText(text)
          if (vec) {
            await pool.query(
              `UPDATE agent_workspace SET embedding = $1::vector
                WHERE agent_id = $2 AND path = $3`,
              [vec, c.sub, p],
            )
          }
        } catch (err) {
          console.warn('[runtime/fs] async embed failed', err instanceof Error ? err.message : String(err))
        }
      })()
    }
    res.json({ ok: true })
  }))

  // DELETE /runtime/fs/unlink?path=<file>
  router.delete('/fs/unlink', withAgent(async (c, req, res) => {
    const p = ensureSafePath(typeof req.query.path === 'string' ? req.query.path : '', res)
    if (p === null) return
    if (p === '') { badRequest(res, 'cannot unlink root'); return }
    await pool.query(
      `DELETE FROM agent_workspace WHERE agent_id = $1 AND path = $2`,
      [c.sub, p],
    )
    res.json({ ok: true })
  }))

  // GET /runtime/fs/stat?path=<path>   — does it exist? as file or dir?
  // Returns { exists: boolean, isDir: boolean, size: number }
  router.get('/fs/stat', withAgent(async (c, req, res) => {
    const p = ensureSafePath(typeof req.query.path === 'string' ? req.query.path : '', res)
    if (p === null) return
    if (p === '') {
      // Root always exists, always a directory.
      res.json({ exists: true, isDir: true, size: 0 })
      return
    }
    // Try exact match (file).
    const fileRow = await pool.query<{ size: number }>(
      `SELECT LENGTH(body) AS size FROM agent_workspace
        WHERE agent_id = $1 AND path = $2 LIMIT 1`,
      [c.sub, p],
    )
    if (fileRow.rows.length > 0) {
      res.json({ exists: true, isDir: false, size: Number(fileRow.rows[0].size) })
      return
    }
    // Try implicit directory (at least one row under this prefix).
    // Same ESCAPE rationale as in /fs/list above.
    const dirRow = await pool.query<{ n: number }>(
      `SELECT 1 AS n FROM agent_workspace
        WHERE agent_id = $1 AND path LIKE $2 || '%' ESCAPE '\\' LIMIT 1`,
      [c.sub, likeEscape(p + '/')],
    )
    if (dirRow.rows.length > 0) {
      res.json({ exists: true, isDir: true, size: 0 })
      return
    }
    res.json({ exists: false, isDir: false, size: 0 })
  }))
}
