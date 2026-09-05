import { createHash } from 'node:crypto'

/**
 * Migration 0005: scope email_messages.smtp_message_id uniqueness per company.
 *
 * One inbound email sent to recipients across multiple companies carries the
 * same SMTP Message-ID. Scoping the unique index by company_id enables cross-tenant
 * delivery while maintaining idempotency within each tenant.
 */
export const EMAIL_MESSAGES_COMPANY_SMTP_ID_SQL = `
DROP INDEX IF EXISTS uniq_email_messages_smtp_id;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_messages_company_smtp_id
  ON email_messages(company_id, LOWER(smtp_message_id))
  WHERE smtp_message_id IS NOT NULL;
`

export function emailMessagesCompanySmtpIdChecksum(): string {
  return createHash('sha256').update(EMAIL_MESSAGES_COMPANY_SMTP_ID_SQL).digest('hex')
}
