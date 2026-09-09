import * as Y from 'yjs'
import type { Pool, PoolClient } from 'pg'

/** One statement keeps snapshot and log on the same PostgreSQL MVCC view,
 * even when a compactor commits while a cold load is in progress. Read ALL
 * remaining rows: sequence IDs are allocated before transactions commit, so
 * a late commit can have an ID below snapshot_at_update_id. */
export async function readDocumentState(client: Pick<PoolClient, 'query'>, documentId: string) {
  const { rows } = await client.query<{
    is_snapshot: boolean
    id: string
    bytes: Buffer
  }>(
    `SELECT TRUE AS is_snapshot, snapshot_at_update_id::text AS id, state_bytes AS bytes
       FROM document_snapshots WHERE document_id = $1
     UNION ALL
     SELECT FALSE AS is_snapshot, id::text AS id, update_bytes AS bytes
       FROM document_updates WHERE document_id = $1`,
    [documentId],
  )
  return rows
}

/** Compact persisted bytes, never a possibly stale live room. The lock
 * serializes compactors across instances, including the first snapshot.
 * Snapshot replacement and deletion commit together; only the exact rows
 * merged below may be removed. mergeUpdates preserves pending Yjs structs
 * and deletes whose dependencies have not been persisted yet. */
export async function compactDocument(pool: Pick<Pool, 'connect'>, documentId: string): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: locks } = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked`,
      [`document-compaction:${documentId}`],
    )
    if (!locks[0].locked) {
      await client.query('ROLLBACK')
      return false
    }
    const rows = await readDocumentState(client, documentId)
    const updateIds = rows.filter((row) => !row.is_snapshot).map((row) => row.id)
    if (updateIds.length > 0) {
      const state = Y.mergeUpdates(rows.map((row) => new Uint8Array(row.bytes)))
      const maxId = rows.reduce((max, row) => BigInt(row.id) > max ? BigInt(row.id) : max, 0n)
      await client.query(
        `INSERT INTO document_snapshots (document_id, state_bytes, snapshot_at_update_id, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (document_id)
           DO UPDATE SET state_bytes = EXCLUDED.state_bytes,
                         snapshot_at_update_id = EXCLUDED.snapshot_at_update_id,
                         updated_at = NOW()`,
        [documentId, Buffer.from(state), maxId.toString()],
      )
      await client.query(
        `DELETE FROM document_updates WHERE document_id = $1 AND id = ANY($2::bigint[])`,
        [documentId, updateIds],
      )
    }
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
