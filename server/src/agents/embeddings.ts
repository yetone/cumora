/**
 * Memory embeddings via OpenAI's `text-embedding-3-small` (1536-dim).
 *
 * Used by:
 *   - `cumora memory note` — embeds the body at write time and stores
 *     the vector in `agent_workspace.embedding`.
 *   - `loadMemory(agentId, queryText)` — embeds the recent inbox
 *     context at wake time so the retriever can pull semantically
 *     relevant memories alongside pinned + most-recent.
 *
 * All calls are best-effort: if the API hiccups or the input is
 * empty/oversized, we return `null` and the caller falls back to
 * recency-only retrieval. That way a transient OpenAI outage doesn't
 * break the entire wake cycle.
 */
import OpenAI from 'openai'
import { env } from '../env.js'
import { pool } from '../db/pool.js'

const EMBED_MODEL = 'text-embedding-3-small'
const EMBED_DIM = 1536
/** OpenAI accepts up to ~8K tokens per input; we cap at 8K characters
 *  (~2K tokens) which is plenty for a single memory entry or a few
 *  recent inbox messages. */
const MAX_INPUT_CHARS = 8000

const client = new OpenAI({ apiKey: env.OPENAI_API_KEY })

/** Test-only override. When set, every {@link embedText} call returns
 *  whatever this function produces — bypassing the real OpenAI
 *  embeddings API. Production code never sets this; integration tests
 *  use it to make memory writes deterministic without spending
 *  embedding credits OR depending on the test runner having a real
 *  OPENAI_API_KEY in env. */
let testEmbedOverride: ((text: string) => string | null | Promise<string | null>) | null = null
export function __setEmbedTextOverrideForTesting(fn: typeof testEmbedOverride): void {
  testEmbedOverride = fn
}

/** Embed a string. Returns a Postgres-pgvector literal string ready
 *  to bind as `$N::vector` in INSERT/UPDATE, or null if it failed. */
export async function embedText(text: string): Promise<string | null> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return null
  if (testEmbedOverride) return testEmbedOverride(trimmed)
  try {
    const resp = await client.embeddings.create({
      model: EMBED_MODEL,
      input: trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed,
    })
    const vec = resp.data[0]?.embedding
    if (!Array.isArray(vec) || vec.length !== EMBED_DIM) return null
    // pgvector accepts the text form `[0.1,0.2,…]` and casts via ::vector.
    return `[${vec.join(',')}]`
  } catch (e) {
    console.warn('[embed] failed', e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Whether pgvector is actually installed in this database. Cached so
 *  loadMemory doesn't probe on every wake. `null` = not yet probed. */
let pgvectorAvailable: boolean | null = null
export async function hasPgVector(): Promise<boolean> {
  if (pgvectorAvailable !== null) return pgvectorAvailable
  try {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`,
    )
    pgvectorAvailable = !!rows[0]?.exists
  } catch {
    pgvectorAvailable = false
  }
  return pgvectorAvailable
}

/** Walk all memory rows missing an embedding and fill them in. Throttled
 *  so a large agent (thousands of memories) doesn't burst OpenAI's
 *  rate limit. Fire-and-forget at server boot. */
export async function backfillMemoryEmbeddings(opts: { batchSize?: number; delayMs?: number } = {}): Promise<void> {
  const batchSize = opts.batchSize ?? 50
  const delayMs = opts.delayMs ?? 80
  if (!(await hasPgVector())) return
  let processed = 0
  let failed = 0
  let afterAgentId: string | null = null
  let afterPath: string | null = null
  while (true) {
    const result: { rows: Array<{ agent_id: string; path: string; body: string }> } = await pool.query(
      `SELECT agent_id, path, body
         FROM agent_workspace
        WHERE path LIKE 'memory/%' AND embedding IS NULL AND body <> ''
          AND ($2::text IS NULL OR (agent_id, path) > ($2::text, $3::text))
        ORDER BY agent_id, path
        LIMIT $1`,
      [batchSize, afterAgentId, afterPath],
    )
    const rows: Array<{ agent_id: string; path: string; body: string }> = result.rows
    if (rows.length === 0) break
    for (const r of rows) {
      try {
        const vec = await embedText(r.body)
        if (!vec) {
          failed++
          continue
        }
        try {
          await pool.query(
            `UPDATE agent_workspace SET embedding = $1::vector
              WHERE agent_id = $2 AND path = $3`,
            [vec, r.agent_id, r.path],
          )
          processed++
        } catch (e) {
          failed++
          console.warn('[embed:backfill] UPDATE failed for', r.path, e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
      }
    }
    afterAgentId = rows[rows.length - 1].agent_id
    afterPath = rows[rows.length - 1].path
    if (rows.length < batchSize) break
  }
  if (processed + failed > 0) {
    console.log(`[embed:backfill] memory embeddings ready — processed=${processed} failed=${failed}`)
  }
}
