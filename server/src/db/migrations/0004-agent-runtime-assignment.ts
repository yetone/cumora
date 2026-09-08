import { createHash } from 'node:crypto'

/**
 * Migration 0004: give every Agent placement an opaque runtime generation.
 *
 * The trigger is deliberately database-owned. Placement changes also happen in
 * bulk onboarding and administrative repair SQL, so rotating only in one API
 * helper would eventually leave a stale-token bypass on another write path.
 */
export const AGENT_RUNTIME_ASSIGNMENT_SQL = `
ALTER TABLE participants
  ADD COLUMN runtime_assignment_id TEXT NOT NULL DEFAULT gen_random_uuid()::text;

CREATE FUNCTION rotate_participant_runtime_assignment_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $migration$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.computer_id IS DISTINCT FROM OLD.computer_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.departed_at IS DISTINCT FROM OLD.departed_at THEN
    NEW.runtime_assignment_id := gen_random_uuid()::text;
  END IF;
  RETURN NEW;
END;
$migration$;

CREATE TRIGGER participants_runtime_assignment_rotation
BEFORE UPDATE OF company_id, computer_id, kind, departed_at ON participants
FOR EACH ROW
EXECUTE FUNCTION rotate_participant_runtime_assignment_id();
`

export function agentRuntimeAssignmentChecksum(): string {
  return createHash('sha256').update(AGENT_RUNTIME_ASSIGNMENT_SQL).digest('hex')
}
