import type { PoolClient } from 'pg'

export type AttachmentGrantStatus = 'pending' | 'active' | 'revoked'

export type AttachmentGrantQueryable = Pick<PoolClient, 'query'>

function grantableStorageKey(key: string): boolean {
  return key.startsWith('attachments/') || key.startsWith('email-attachments/')
}

/** Record that a tenant may reference a storage object. The object itself is
 * still validated by storage.statObject at message/email write time. */
export async function grantAttachment(
  db: AttachmentGrantQueryable,
  companyId: string,
  storageKey: string,
  status: AttachmentGrantStatus = 'active',
): Promise<void> {
  if (!grantableStorageKey(storageKey)) return
  await db.query(
    `INSERT INTO attachment_grants (storage_key, company_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (storage_key, company_id)
     DO UPDATE SET status = EXCLUDED.status`,
    [storageKey, companyId, status],
  )
}

export async function grantAttachments(
  db: AttachmentGrantQueryable,
  companyId: string,
  storageKeys: readonly string[],
  status: AttachmentGrantStatus = 'active',
): Promise<void> {
  for (const key of [...new Set(storageKeys)]) {
    await grantAttachment(db, companyId, key, status)
  }
}

/** Only active grants authorize a tenant to read or attach an object. */
export async function hasAttachmentGrant(
  db: AttachmentGrantQueryable,
  companyId: string,
  storageKey: string,
): Promise<boolean> {
  if (!grantableStorageKey(storageKey)) return false
  const result = await db.query(
    `SELECT 1 FROM attachment_grants
      WHERE storage_key = $1 AND company_id = $2 AND status = 'active'
      LIMIT 1`,
    [storageKey, companyId],
  )
  return result.rows.length === 1
}

export function isGrantableAttachmentKey(storageKey: string): boolean {
  return grantableStorageKey(storageKey)
}
