import { pool } from './db/pool.js'

/** Keep deletion, memory erasure and offline-device cleanup instructions atomic. */
export async function deleteArchivedProject(companyId: string, projectId: string): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('project-memory:' || $1::text), hashtext($2::text))`,
      [companyId, projectId],
    )
    const { rowCount } = await client.query(
      `DELETE FROM projects WHERE id = $1 AND company_id = $2 AND status = 'archived'`,
      [projectId, companyId],
    )
    if (!rowCount) {
      await client.query('ROLLBACK')
      return false
    }
    await client.query(
      `INSERT INTO project_memory_deletions (company_id, project_id, agent_ids)
       VALUES ($1, $2, ARRAY(SELECT id FROM participants WHERE company_id = $1 AND kind = 'agent'))`,
      [companyId, projectId],
    )
    await client.query(
      `DELETE FROM agent_workspace
        WHERE company_id = $1 AND left(path, 7) = 'memory/'
          AND (meta #>> '{source,projectId}' = $2
               OR path = 'memory/projects/' || $2
               OR starts_with(path, 'memory/projects/' || $2 || '/'))`,
      [companyId, projectId],
    )
    // The legacy table is no longer written, but explicit project provenance
    // can still exist in upgraded installations.
    await client.query(
      `DELETE FROM agent_memory WHERE company_id = $1 AND source->>'projectId' = $2`,
      [companyId, projectId],
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
