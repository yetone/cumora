import { createHash } from 'node:crypto'

export const PROJECT_MEMORY_DELETION_SQL = `
CREATE TABLE project_memory_deletions (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  pending_computer_ids TEXT[] NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  database_cleaned_at TIMESTAMPTZ,
  next_cleanup_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  PRIMARY KEY (company_id, project_id)
);
CREATE INDEX project_memory_deletions_due ON project_memory_deletions(next_cleanup_at);
`

export function projectMemoryDeletionChecksum(): string {
  return createHash('sha256').update(PROJECT_MEMORY_DELETION_SQL).digest('hex')
}
