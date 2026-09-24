import { pool } from './db/pool.js'
import type { PoolClient } from 'pg'
import { deliverComputerControl } from './agents/computer/control-bus.js'

/** Capability probe is only used by deletion and reconnect endpoints, never heartbeats. */
export async function projectDeletionAvailable(): Promise<boolean> {
  const { rows } = await pool.query(`SELECT to_regclass('project_memory_deletions') IS NOT NULL AS ready`)
  return rows[0].ready
}

async function eraseProjectMemories(client: PoolClient, companyId: string, projectId: string): Promise<void> {
  await client.query(
    `DELETE FROM agent_workspace
      WHERE company_id = $1 AND left(path, 7) = 'memory/'
        AND (meta #>> '{source,projectId}' = $2
             OR path = 'memory/projects/' || $2
             OR starts_with(path, 'memory/projects/' || $2 || '/'))`,
    [companyId, projectId],
  )
  await client.query(`DELETE FROM agent_memory WHERE company_id = $1 AND source->>'projectId' = $2`, [companyId, projectId])
}

async function notifyComputers(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => deliverComputerControl(id, 'project.deleted').catch((error) => {
    console.warn('[project-cleanup] notification failed; durable task will retry', error)
  })))
}

/** Keep deletion, memory erasure and offline-device cleanup instructions atomic. */
export async function deleteArchivedProject(companyId: string, projectId: string, confirmation: string): Promise<boolean> {
  const client = await pool.connect()
  let computerIds: string[] = []
  try {
    await client.query('BEGIN')
    const { rowCount } = await client.query(
      `DELETE FROM projects WHERE id = $1 AND company_id = $2 AND status = 'archived' AND name = $3`,
      [projectId, companyId, confirmation],
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return false
    }
    // The server cannot inventory local-only memories, including those left by
    // moved agents. Send one project ID per device; each device inspects its disk.
    const { rows } = await client.query<{ pending_computer_ids: string[] }>(
      `INSERT INTO project_memory_deletions (company_id, project_id, pending_computer_ids)
       VALUES ($1, $2, ARRAY(SELECT id FROM computers
         WHERE company_id = $1 AND kind <> 'cloud' AND revoked_at IS NULL))
       RETURNING pending_computer_ids`,
      [companyId, projectId],
    )
    computerIds = rows[0].pending_computer_ids
    await eraseProjectMemories(client, companyId, projectId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await notifyComputers(computerIds)
  return true
}

/** One bounded server-side retry, rather than a query on every device heartbeat.
 * The five-minute grace exceeds the normal 60s statement / 30s idle-tx limits,
 * allowing writes that passed the application check before deletion to settle. */
export async function drainProjectMemoryDeletions(): Promise<void> {
  const client = await pool.connect()
  const notify = new Set<string>()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<{ company_id: string; project_id: string; pending_computer_ids: string[]; database_cleaned_at: string | null }>(
      `SELECT company_id, project_id, pending_computer_ids, database_cleaned_at FROM project_memory_deletions
       WHERE next_cleanup_at <= NOW() ORDER BY next_cleanup_at LIMIT 10 FOR UPDATE SKIP LOCKED`,
    )
    for (const row of rows) {
      if (!row.database_cleaned_at) await eraseProjectMemories(client, row.company_id, row.project_id)
      const { rows: updated } = await client.query<{ pending_computer_ids: string[] }>(
        `UPDATE project_memory_deletions SET
           pending_computer_ids = ARRAY(SELECT id FROM computers
             WHERE id = ANY($3::text[]) AND company_id = $1 AND revoked_at IS NULL),
           database_cleaned_at = COALESCE(database_cleaned_at, NOW()),
           next_cleanup_at = NOW() + INTERVAL '1 hour'
         WHERE company_id = $1 AND project_id = $2 RETURNING pending_computer_ids`,
        [row.company_id, row.project_id, row.pending_computer_ids],
      )
      for (const id of updated[0].pending_computer_ids) notify.add(id)
      if (updated[0].pending_computer_ids.length === 0) {
        await client.query(`DELETE FROM project_memory_deletions WHERE company_id = $1 AND project_id = $2`, [row.company_id, row.project_id])
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
  await notifyComputers([...notify])
}

export async function startProjectMemoryCleanupWorker(): Promise<void> {
  if (!await projectDeletionAvailable()) return // compatibility rollout on schema 9
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await drainProjectMemoryDeletions() }
    catch (error) { console.warn('[project-cleanup] retry failed', error) }
    finally { running = false }
  }
  void tick()
  setInterval(() => { void tick() }, 60_000).unref()
}
