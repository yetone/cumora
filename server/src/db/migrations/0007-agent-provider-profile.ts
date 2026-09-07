import { createHash } from 'node:crypto'

/** Bind runtime credentials to the selected local provider as well as the host. */
export const AGENT_PROVIDER_PROFILE_SQL = `
ALTER TABLE participants
  ADD COLUMN provider_profile TEXT CHECK (provider_profile ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$');

CREATE OR REPLACE FUNCTION rotate_participant_runtime_assignment_id()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $migration$
BEGIN
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.computer_id IS DISTINCT FROM OLD.computer_id
     OR NEW.provider_profile IS DISTINCT FROM OLD.provider_profile
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.departed_at IS DISTINCT FROM OLD.departed_at THEN
    NEW.runtime_assignment_id := gen_random_uuid()::text;
  END IF;
  RETURN NEW;
END;
$migration$;

DROP TRIGGER participants_runtime_assignment_rotation ON participants;
CREATE TRIGGER participants_runtime_assignment_rotation
BEFORE UPDATE OF company_id, computer_id, kind, departed_at, provider_profile ON participants
FOR EACH ROW
EXECUTE FUNCTION rotate_participant_runtime_assignment_id();
`

export function agentProviderProfileChecksum(): string {
  return createHash('sha256').update(AGENT_PROVIDER_PROFILE_SQL).digest('hex')
}
