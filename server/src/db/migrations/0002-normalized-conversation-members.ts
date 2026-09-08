import { createHash } from 'node:crypto'

/**
 * Migration 0002: make normalized rows the conversation-membership truth.
 *
 * Keep this string immutable after release. The manifest stores its SHA-256,
 * and both the migration owner and application startup verify that identity.
 */
export const NORMALIZED_CONVERSATION_MEMBERS_SQL = `
ALTER TABLE conversations ALTER COLUMN company_id SET NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'conversations_id_company_key'
       AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_id_company_key UNIQUE (id, company_id);
  END IF;
END
$migration$;

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL,
  company_id      TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  ordinal         INTEGER NOT NULL CHECK (ordinal >= 0),
  joined_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, participant_id),
  CONSTRAINT conversation_members_conversation_fk
    FOREIGN KEY (conversation_id, company_id)
    REFERENCES conversations(id, company_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT conversation_members_participant_fk
    FOREIGN KEY (participant_id, company_id)
    REFERENCES participants(id, company_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX conversation_members_conversation_ordinal_key
  ON conversation_members(conversation_id, ordinal);
CREATE INDEX idx_conversation_members_participant
  ON conversation_members(company_id, participant_id, conversation_id);

-- Fail closed instead of silently dropping a legacy member that does not
-- resolve to a participant in the conversation's tenant. Synthetic external
-- email author markers were never authorization principals and are removed
-- from the compatibility projection during normalization.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM conversations c
      CROSS JOIN LATERAL jsonb_array_elements_text(c.members) member(id)
      LEFT JOIN participants p
        ON p.id = member.id AND p.company_id = c.company_id
     WHERE p.id IS NULL
       AND member.id NOT LIKE 'external:%'
  ) THEN
    RAISE EXCEPTION 'cannot normalize conversation membership: foreign or missing participant'
      USING ERRCODE = '23503';
  END IF;
END
$migration$;

INSERT INTO conversation_members (
  conversation_id, company_id, participant_id, ordinal, joined_at
)
SELECT seeded.conversation_id,
       seeded.company_id,
       seeded.participant_id,
       seeded.ordinal,
       seeded.joined_at
  FROM (
    SELECT DISTINCT ON (c.id, member.id)
           c.id AS conversation_id,
           c.company_id,
           member.id AS participant_id,
           (member.ord - 1)::integer AS ordinal,
           c.created_at AS joined_at
      FROM conversations c
      CROSS JOIN LATERAL jsonb_array_elements_text(c.members)
        WITH ORDINALITY AS member(id, ord)
     WHERE member.id NOT LIKE 'external:%'
     ORDER BY c.id, member.id, member.ord
  ) seeded;

-- Canonicalize the retained JSONB projection once. Authorization and routing
-- never read this column after this migration; it exists for response-shape
-- compatibility and can always be rebuilt from conversation_members.
UPDATE conversations c
   SET members = COALESCE(
     (
       SELECT jsonb_agg(cm.participant_id ORDER BY cm.ordinal, cm.participant_id)
         FROM conversation_members cm
        WHERE cm.conversation_id = c.id
          AND cm.company_id = c.company_id
     ),
     '[]'::jsonb
   );

CREATE FUNCTION refresh_conversation_members_projection(p_conversation_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  projected JSONB;
BEGIN
  SELECT COALESCE(
           jsonb_agg(cm.participant_id ORDER BY cm.ordinal, cm.participant_id),
           '[]'::jsonb
         )
    INTO projected
    FROM conversation_members cm
   WHERE cm.conversation_id = p_conversation_id;

  UPDATE conversations
     SET members = projected,
         updated_at = NOW()
   WHERE id = p_conversation_id;

  RETURN projected;
END
$function$;

CREATE FUNCTION seed_conversation_members_from_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO conversation_members (
    conversation_id, company_id, participant_id, ordinal, joined_at
  )
  SELECT NEW.id,
         NEW.company_id,
         seeded.participant_id,
         seeded.ordinal,
         NEW.created_at
    FROM (
      SELECT DISTINCT ON (member.id)
             member.id AS participant_id,
             (member.ord - 1)::integer AS ordinal
        FROM jsonb_array_elements_text(NEW.members)
          WITH ORDINALITY AS member(id, ord)
       WHERE member.id NOT LIKE 'external:%'
       ORDER BY member.id, member.ord
    ) seeded;

  PERFORM refresh_conversation_members_projection(NEW.id);
  RETURN NEW;
END
$function$;

-- Expand-phase compatibility for the revision that may still be serving while
-- migration 0002 runs. A legacy JSONB write is translated into normalized rows
-- under the same conversation row lock; new code never uses this ingress. A
-- later contract migration can replace this function with a hard rejection
-- after the pre-0002 application can no longer be rolled back.
CREATE FUNCTION synchronize_conversation_members_projection()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  expected JSONB;
BEGIN
  SELECT COALESCE(
           jsonb_agg(cm.participant_id ORDER BY cm.ordinal, cm.participant_id),
           '[]'::jsonb
         )
    INTO expected
    FROM conversation_members cm
   WHERE cm.conversation_id = NEW.id
     AND cm.company_id = NEW.company_id;

  -- refresh_conversation_members_projection already supplied the canonical
  -- normalized value; do not feed that value back through the compatibility
  -- ingress.
  IF NEW.members IS NOT DISTINCT FROM expected THEN RETURN NEW; END IF;

  DELETE FROM conversation_members WHERE conversation_id = OLD.id;
  INSERT INTO conversation_members (
    conversation_id, company_id, participant_id, ordinal, joined_at
  )
  SELECT NEW.id,
         NEW.company_id,
         seeded.participant_id,
         seeded.ordinal,
         NOW()
    FROM (
      SELECT DISTINCT ON (member.id)
             member.id AS participant_id,
             (member.ord - 1)::integer AS ordinal
        FROM jsonb_array_elements_text(NEW.members)
          WITH ORDINALITY AS member(id, ord)
       WHERE member.id NOT LIKE 'external:%'
       ORDER BY member.id, member.ord
    ) seeded;

  SELECT COALESCE(
           jsonb_agg(cm.participant_id ORDER BY cm.ordinal, cm.participant_id),
           '[]'::jsonb
         )
    INTO NEW.members
    FROM conversation_members cm
   WHERE cm.conversation_id = NEW.id
     AND cm.company_id = NEW.company_id;
  RETURN NEW;
END
$function$;

CREATE TRIGGER conversations_seed_members_after_insert
AFTER INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION seed_conversation_members_from_projection();

CREATE TRIGGER conversations_sync_legacy_members_projection
BEFORE UPDATE OF members ON conversations
FOR EACH ROW EXECUTE FUNCTION synchronize_conversation_members_projection();
`

export function normalizedConversationMembersChecksum(): string {
  return createHash('sha256').update(NORMALIZED_CONVERSATION_MEMBERS_SQL).digest('hex')
}
