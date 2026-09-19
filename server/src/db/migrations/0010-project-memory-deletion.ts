import { createHash } from 'node:crypto'

export const PROJECT_MEMORY_DELETION_SQL = `
CREATE TABLE project_memory_deletions (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  agent_ids TEXT[] NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, project_id)
);

-- A stale agent turn must not recreate memory after project deletion commits.
-- Use the same transaction lock as the delete operation, including for pinned notes.
CREATE FUNCTION reject_deleted_project_memory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  project TEXT;
BEGIN
  IF left(NEW.path, 7) <> 'memory/' THEN RETURN NEW; END IF;
  FOR project IN
    SELECT DISTINCT id FROM unnest(ARRAY[
      NULLIF(NEW.meta #>> '{source,projectId}', ''),
      substring(NEW.path from '^memory/projects/([^/]+)(/|$)')
    ]) AS ids(id) WHERE id IS NOT NULL ORDER BY id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtext('project-memory:' || NEW.company_id), hashtext(project));
    IF EXISTS (SELECT 1 FROM project_memory_deletions
               WHERE company_id = NEW.company_id AND project_id = project) THEN
      RAISE EXCEPTION 'cannot write memory for a deleted project' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_workspace_deleted_project_guard
BEFORE INSERT OR UPDATE ON agent_workspace
FOR EACH ROW EXECUTE FUNCTION reject_deleted_project_memory();
`

export function projectMemoryDeletionChecksum(): string {
  return createHash('sha256').update(PROJECT_MEMORY_DELETION_SQL).digest('hex')
}
