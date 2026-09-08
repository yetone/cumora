import { createHash } from 'node:crypto'

/**
 * Migration 0003: durable cleanup work for deleted workspaces.
 *
 * The row deliberately has no company FK: it must survive the transaction
 * that deletes the company so external storage and runtime resources can be
 * retried after a crash or transient control-plane failure.
 */
export const WORKSPACE_CLEANUP_JOBS_SQL = `
CREATE TABLE workspace_cleanup_jobs (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  agent_ids    TEXT[] NOT NULL DEFAULT '{}',
  storage_keys TEXT[] NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  locked_by    TEXT,
  locked_until TIMESTAMP WITH TIME ZONE,
  last_error   TEXT,
  completed_at TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workspace_cleanup_jobs_pending
  ON workspace_cleanup_jobs(available_at, created_at, id)
  WHERE completed_at IS NULL;

CREATE INDEX idx_workspace_cleanup_jobs_completed
  ON workspace_cleanup_jobs(completed_at)
  WHERE completed_at IS NOT NULL;
`

export function workspaceCleanupJobsChecksum(): string {
  return createHash('sha256').update(WORKSPACE_CLEANUP_JOBS_SQL).digest('hex')
}
