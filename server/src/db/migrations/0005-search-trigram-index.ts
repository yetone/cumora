import { createHash } from 'node:crypto'

/**
 * Migration 0005: make global message search index-backed.
 *
 * `GET /search` matched message bodies with `body ILIKE '%term%'`, which no
 * btree can serve — a leading wildcard forces a sequential scan of every row
 * the tenant/membership filter lets through. A rare or misspelled term reads
 * the whole table, and the sidebar issues a fresh search on every typing
 * pause, so a handful of concurrent searches were enough to hold the pool.
 *
 * `gin_trgm_ops` indexes the three-character shingles of each body, so the
 * planner can answer `%term%` from the index instead. Partial on `kind =
 * 'text'` for two reasons: the search route already excludes `tool` / `system`
 * rows (machine output, not human-written), and every message INSERT pays the
 * GIN maintenance cost, so keeping non-searchable kinds out of the index keeps
 * that cost off the rows nobody will ever search.
 *
 * Known boundary: a pattern shorter than three characters yields no complete
 * trigram, so a two-character query (common in CJK) still plans as a scan. The
 * route bounds those with its own `statement_timeout` rather than refusing
 * them — see the search handler in api/router.ts.
 */
export const SEARCH_TRIGRAM_INDEX_NAME = 'idx_messages_body_trgm'

/** Runs before the concurrent build, and is transactional-safe on its own. */
export const SEARCH_TRIGRAM_EXTENSION_SQL = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
`

/**
 * MUST run outside a transaction block. Built CONCURRENTLY because `messages`
 * is the hottest write path in the product: a plain CREATE INDEX takes a
 * SHARE lock and stalls every sender for the duration of the build.
 */
export const SEARCH_TRIGRAM_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${SEARCH_TRIGRAM_INDEX_NAME}
  ON messages USING gin (body gin_trgm_ops)
  WHERE kind = 'text'
`

export function searchTrigramIndexChecksum(): string {
  return createHash('sha256')
    .update(SEARCH_TRIGRAM_EXTENSION_SQL + SEARCH_TRIGRAM_INDEX_SQL)
    .digest('hex')
}
