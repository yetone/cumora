import { createHash } from 'node:crypto'

/** Tenant ownership records for every storage object that can appear in a
 * message or email. The storage key is intentionally not globally readable:
 * the same object may be granted to several companies (inbound mail fan-out),
 * while an ungranted key cannot be refreshed or downloaded. */
export const ATTACHMENT_GRANTS_SQL = `
CREATE TABLE IF NOT EXISTS attachment_grants (
  storage_key TEXT NOT NULL,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('pending', 'active', 'revoked')),
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (storage_key, company_id)
);
CREATE INDEX IF NOT EXISTS idx_attachment_grants_company
  ON attachment_grants(company_id, status, created_at DESC);

-- Recover tenant ownership for objects persisted before this table existed.
INSERT INTO attachment_grants (storage_key, company_id, status)
SELECT DISTINCT candidate.storage_key, m.company_id, 'active'
  FROM messages m
 CROSS JOIN LATERAL (
   SELECT value->>'key' AS storage_key
     FROM jsonb_array_elements(
       CASE WHEN jsonb_typeof(m.attachments) = 'array' THEN m.attachments
            WHEN m.attachment IS NOT NULL THEN jsonb_build_array(m.attachment)
            ELSE '[]'::jsonb END
     ) value
   UNION ALL
   SELECT m.attachment->>'key'
     WHERE jsonb_typeof(m.attachment) = 'object'
 ) candidate
 WHERE candidate.storage_key LIKE 'attachments/%'
ON CONFLICT (storage_key, company_id) DO NOTHING;

INSERT INTO attachment_grants (storage_key, company_id, status)
SELECT DISTINCT storage_key, company_id, 'active'
  FROM email_attachments
 WHERE storage_key LIKE 'email-attachments/%'
ON CONFLICT (storage_key, company_id) DO NOTHING;
`

export function attachmentGrantsChecksum(): string {
  return createHash('sha256').update(ATTACHMENT_GRANTS_SQL).digest('hex')
}
