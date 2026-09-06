import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from './db/pool.js'
import { env } from './env.js'
import {
  messageAttachmentStorageKey,
  normalizeStorageKey,
  storage,
  storageKeyFromPublicUrl,
} from './storage.js'
import { collectDocumentStorageKeys } from './documents/rooms.js'

interface CleanupJob {
  id: string
  agent_ids: string[]
  storage_keys: string[]
  attempts: number
}

export interface WorkspaceCleanupResult {
  claimed: number
  completed: number
  failed: number
}

export interface WorkspaceCleanupDependencies {
  deleteStorageObject: (key: string) => Promise<boolean>
  deleteAgentRuntime: (agentId: string) => Promise<void>
}

const CLAIM_LEASE_MS = 60_000
const BATCH_SIZE = 8
const COMPLETED_RETENTION_DAYS = 7
const workerId = `workspace-cleanup-${process.pid}-${randomUUID().slice(0, 8)}`
let workerTimer: NodeJS.Timeout | null = null
let workerRunning = false

export async function enqueueWorkspaceCleanup(
  client: PoolClient,
  input: { companyId: string; agentIds: string[]; storageKeys: string[] },
): Promise<string | null> {
  const agentIds = [...new Set(input.agentIds)]
  const storageKeys = [...new Set(input.storageKeys.map(normalizeStorageKey).filter((key): key is string => !!key))]
  if (agentIds.length === 0 && storageKeys.length === 0) return null
  const id = randomUUID()
  await client.query(
    `INSERT INTO workspace_cleanup_jobs (id, company_id, agent_ids, storage_keys)
     VALUES ($1, $2, $3::text[], $4::text[])`,
    [id, input.companyId, agentIds, storageKeys],
  )
  return id
}

async function claimBatch(limit: number): Promise<CleanupJob[]> {
  const { rows } = await pool.query<CleanupJob>(
    `WITH candidates AS (
       SELECT id
         FROM workspace_cleanup_jobs
        WHERE completed_at IS NULL
          AND available_at <= NOW()
          AND (locked_until IS NULL OR locked_until < NOW())
        ORDER BY created_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE workspace_cleanup_jobs j
        SET locked_by = $2,
            locked_until = NOW() + ($3 * INTERVAL '1 millisecond'),
            updated_at = NOW()
       FROM candidates c
      WHERE j.id = c.id
      RETURNING j.id, j.agent_ids, j.storage_keys, j.attempts`,
    [limit, workerId, CLAIM_LEASE_MS],
  )
  return rows
}

export async function findReferencedStorageKeys(keys: string[], client?: PoolClient): Promise<Set<string>> {
  const uniqueKeys = Array.from(new Set(keys.map(normalizeStorageKey).filter((k): k is string => Boolean(k))))
  if (uniqueKeys.length === 0) return new Set()
  const db = client ?? pool
  const referenced = new Set<string>()

  const [emailFiles, messageFiles, avatars, docCandidates] = await Promise.all([
    db.query<{ storage_key: string }>(
      `SELECT storage_key FROM email_attachments WHERE storage_key = ANY($1::text[])`,
      [uniqueKeys],
    ),
    db.query<{ attachment: unknown }>(
      `SELECT attachment
         FROM messages m
        WHERE attachment IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[]) candidate(key)
             WHERE m.attachment::text LIKE '%' || candidate.key || '%'
          )`,
      [uniqueKeys],
    ),
    db.query<{ avatar_url: string }>(
      `SELECT avatar_url
         FROM participants p
        WHERE avatar_url IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM unnest($1::text[]) candidate(key)
             WHERE p.avatar_url LIKE '%' || candidate.key || '%'
          )`,
      [uniqueKeys],
    ),
    db.query<{ document_id: string }>(
      `SELECT DISTINCT document_id FROM (
         SELECT document_id
           FROM document_updates u, unnest($1::text[]) candidate(key)
          WHERE position(convert_to(candidate.key, 'UTF8') in u.update_bytes) > 0
         UNION ALL
         SELECT document_id
           FROM document_snapshots s, unnest($1::text[]) candidate(key)
          WHERE position(convert_to(candidate.key, 'UTF8') in s.state_bytes) > 0
       ) candidates
       WHERE document_id IN (SELECT id FROM documents)`,
      [uniqueKeys],
    ),
  ])

  for (const row of emailFiles.rows) {
    const key = normalizeStorageKey(row.storage_key)
    if (key && uniqueKeys.includes(key)) referenced.add(key)
  }
  for (const row of messageFiles.rows) {
    const attachments = Array.isArray(row.attachment) ? row.attachment : [row.attachment]
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue
      const key = messageAttachmentStorageKey(attachment as { key?: unknown; url?: unknown })
      if (key && uniqueKeys.includes(key)) referenced.add(key)
    }
  }
  for (const row of avatars.rows) {
    const key = storageKeyFromPublicUrl(row.avatar_url)
    if (key && uniqueKeys.includes(key)) referenced.add(key)
  }
  await Promise.all(
    docCandidates.rows.map(async (row) => {
      const docKeys = await collectDocumentStorageKeys(row.document_id, client)
      for (const key of docKeys) {
        if (uniqueKeys.includes(key)) referenced.add(key)
      }
    }),
  )
  return referenced
}

async function defaultDeleteAgentRuntime(agentId: string): Promise<void> {
  if (!env.WORKSPACE_RUNTIME_CLEANUP_ENABLED) return
  const { deletePod, deleteChromeProfilePvc } = await import('./agents/runtime/orchestrator.js')
  await Promise.all([deletePod(agentId), deleteChromeProfilePvc(agentId)])
}

async function performCleanup(job: CleanupJob, dependencies: WorkspaceCleanupDependencies): Promise<void> {
  const referenced = await findReferencedStorageKeys(job.storage_keys)
  for (const key of job.storage_keys) {
    if (referenced.has(key)) continue
    if (!await dependencies.deleteStorageObject(key)) {
      throw new Error(`storage deletion failed for ${key}`)
    }
  }
  await Promise.all(job.agent_ids.map(dependencies.deleteAgentRuntime))
}

async function markCompleted(id: string): Promise<void> {
  await pool.query(
    `UPDATE workspace_cleanup_jobs
        SET completed_at = NOW(), locked_by = NULL, locked_until = NULL,
            last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND locked_by = $2`,
    [id, workerId],
  )
}

async function markFailed(job: CleanupJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const delayMs = Math.min(60 * 60_000, 1_000 * (2 ** Math.min(job.attempts, 12)))
  await pool.query(
    `UPDATE workspace_cleanup_jobs
        SET attempts = attempts + 1,
            available_at = NOW() + ($3 * INTERVAL '1 millisecond'),
            locked_by = NULL, locked_until = NULL,
            last_error = LEFT($4, 1000), updated_at = NOW()
      WHERE id = $1 AND locked_by = $2`,
    [job.id, workerId, delayMs, message],
  )
}

async function cleanupCompletedRows(): Promise<void> {
  await pool.query(
    `DELETE FROM workspace_cleanup_jobs
      WHERE completed_at <= NOW() - ($1 * INTERVAL '1 day')`,
    [COMPLETED_RETENTION_DAYS],
  )
}

/** Drain one bounded batch. Exported so integration tests can inject external
 * failures and prove that the durable job remains retryable. */
export async function drainWorkspaceCleanupJobs(options: {
  dependencies?: Partial<WorkspaceCleanupDependencies>
  batchSize?: number
} = {}): Promise<WorkspaceCleanupResult> {
  const dependencies: WorkspaceCleanupDependencies = {
    deleteStorageObject: options.dependencies?.deleteStorageObject ?? ((key) => storage.deleteObject(key)),
    deleteAgentRuntime: options.dependencies?.deleteAgentRuntime ?? defaultDeleteAgentRuntime,
  }
  await cleanupCompletedRows()
  const rows = await claimBatch(Math.max(1, Math.min(options.batchSize ?? BATCH_SIZE, 32)))
  let completed = 0
  let failed = 0
  await Promise.all(rows.map(async (row) => {
    try {
      await performCleanup(row, dependencies)
      await markCompleted(row.id)
      completed += 1
    } catch (error) {
      await markFailed(row, error)
      failed += 1
    }
  }))
  return { claimed: rows.length, completed, failed }
}

function runWorkerTick(): void {
  if (workerRunning) return
  workerRunning = true
  void drainWorkspaceCleanupJobs()
    .then((result) => {
      if (result.failed > 0) console.warn(`[workspace-cleanup] ${result.failed} job(s) delayed; cleanup will retry`)
    })
    .catch((error) => console.warn('[workspace-cleanup] drain failed', error instanceof Error ? error.message : error))
    .finally(() => { workerRunning = false })
}

export function nudgeWorkspaceCleanupWorker(): void {
  if (workerTimer) setImmediate(runWorkerTick)
}

export function startWorkspaceCleanupWorker(): NodeJS.Timeout | null {
  if (workerTimer || env.WORKSPACE_CLEANUP_INTERVAL_MS <= 0) return workerTimer
  runWorkerTick()
  workerTimer = setInterval(runWorkerTick, env.WORKSPACE_CLEANUP_INTERVAL_MS)
  workerTimer.unref()
  console.log(`[boot] workspace cleanup running every ${env.WORKSPACE_CLEANUP_INTERVAL_MS}ms`)
  return workerTimer
}

export function stopWorkspaceCleanupWorker(): void {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}
