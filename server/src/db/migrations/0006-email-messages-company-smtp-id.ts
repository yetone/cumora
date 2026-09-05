import { createHash } from 'node:crypto'

/**
 * Migration 0006: scope email_messages.smtp_message_id uniqueness per company (#198).
 *
 * One inbound email sent to recipients across multiple companies carries the
 * same SMTP Message-ID. Scoping the unique index by company_id enables cross-tenant
 * delivery while maintaining idempotency within each tenant.
 *
 * MUST run outside a transaction block. Built CONCURRENTLY so that live production
 * inbound email writes are never blocked by an exclusive table lock.
 */
export const EMAIL_MESSAGES_COMPANY_SMTP_ID_INDEX_NAME = 'uniq_email_messages_company_smtp_id'

export const EMAIL_MESSAGES_COMPANY_SMTP_ID_SQL = `
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${EMAIL_MESSAGES_COMPANY_SMTP_ID_INDEX_NAME}
  ON email_messages(company_id, LOWER(smtp_message_id))
  WHERE smtp_message_id IS NOT NULL;
`

export const DROP_LEGACY_EMAIL_MESSAGES_SMTP_ID_SQL = `
DROP INDEX CONCURRENTLY IF EXISTS uniq_email_messages_smtp_id;
`

export function emailMessagesCompanySmtpIdChecksum(): string {
  return createHash('sha256')
    .update(EMAIL_MESSAGES_COMPANY_SMTP_ID_SQL + DROP_LEGACY_EMAIL_MESSAGES_SMTP_ID_SQL)
    .digest('hex')
}
