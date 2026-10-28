import { createHash } from 'node:crypto'

/**
 * Canonical ordered chat-attachment list. The legacy `attachment` column
 * remains a first-entry compatibility projection for clients and readers
 * that predate multi-attachment messages.
 */
export const MESSAGE_ATTACHMENTS_SQL = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB;

-- Backfill once from the historical single descriptor. A canonical array that
-- already exists wins, so rerunning this statement cannot reorder attachments.
UPDATE messages
   SET attachments = jsonb_build_array(attachment)
 WHERE attachments IS NULL
   AND attachment IS NOT NULL;

-- New messages use a non-null array. Nullable during backfill avoids a table
-- rewrite and remains compatible with old writers during the expand phase.
CREATE OR REPLACE FUNCTION sync_message_attachment_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $migration$
BEGIN
  IF NEW.attachments IS NOT NULL THEN
    NEW.attachments := CASE
      WHEN jsonb_typeof(NEW.attachments) = 'array' THEN NEW.attachments
      WHEN jsonb_typeof(NEW.attachments) = 'object' THEN jsonb_build_array(NEW.attachments)
      ELSE '[]'::jsonb
    END;
    NEW.attachment := CASE
      WHEN jsonb_array_length(NEW.attachments) = 0 THEN NULL
      ELSE NEW.attachments->0
    END;
  ELSIF NEW.attachment IS NOT NULL THEN
    -- Expand-phase compatibility for a server revision that still writes only
    -- the legacy column while this migration is being deployed.
    NEW.attachments := jsonb_build_array(NEW.attachment);
  ELSE
    NEW.attachments := '[]'::jsonb;
  END IF;
  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS messages_sync_attachment_projection ON messages;
CREATE TRIGGER messages_sync_attachment_projection
BEFORE INSERT OR UPDATE OF attachment, attachments ON messages
FOR EACH ROW EXECUTE FUNCTION sync_message_attachment_projection();
`

export function messageAttachmentsChecksum(): string {
  return createHash('sha256').update(MESSAGE_ATTACHMENTS_SQL).digest('hex')
}
