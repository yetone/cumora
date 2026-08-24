/** Pure storage-reference policy shared by API persistence and agent reads.
 *
 * A message attachment URL is presentation data: signatures expire and the
 * client can alter it. Only a server-generated `attachments/` key may choose
 * what the server reads. Keeping this module free of env/storage imports makes
 * the trust boundary directly unit-testable. */

const STORAGE_KEY_PREFIXES = ['attachments/', 'email-attachments/', 'avatars/']

function stripQueryAndHash(value: string): string {
  return value.split('?')[0].split('#')[0]
}

export function normalizeStorageKey(raw: string): string | null {
  try {
    const key = decodeURIComponent(stripQueryAndHash(raw.trim()).replace(/^\/+/, ''))
    if (!key || key.length > 1024) return null
    if (/[\\\u0000-\u001f\u007f]/.test(key) || key.includes('?') || key.includes('#')) return null
    const segments = key.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
    const prefix = STORAGE_KEY_PREFIXES.find((candidate) => key.startsWith(candidate))
    if (!prefix || key.length === prefix.length) return null
    return key
  } catch {
    return null
  }
}

/** Derive a storage key only from a local upload URL or the configured R2
 * public origin. Arbitrary absolute URLs are never storage references. */
export function storageKeyFromPublicUrl(raw: string, r2PublicBase: string): string | null {
  const value = raw.trim()
  if (!value) return null

  if (value.startsWith('/uploads/')) {
    return normalizeStorageKey(value.slice('/uploads/'.length))
  }

  if (!r2PublicBase) return null
  try {
    const url = new URL(value)
    const base = new URL(r2PublicBase)
    const basePath = base.pathname.replace(/\/+$/, '')
    if (url.origin !== base.origin) return null
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) return null
    const rawKey = basePath
      ? url.pathname.slice(basePath.length + 1)
      : url.pathname.replace(/^\/+/, '')
    return normalizeStorageKey(rawKey)
  } catch {
    return null
  }
}

/** Select the authoritative object key for a chat message attachment.
 *
 * A valid explicit key wins even when its accompanying URL is a presigned S3
 * URL that cannot be derived from R2_PUBLIC_BASE; consumers must regenerate
 * the URL from that key. If both fields identify known storage objects they
 * must agree, preventing a confused-reference mismatch. */
export function messageAttachmentStorageKey(
  input: { key?: unknown; url?: unknown },
  r2PublicBase: string,
): string | null {
  const rawKey = typeof input.key === 'string' ? input.key.trim() : ''
  const fromUrl = typeof input.url === 'string'
    ? storageKeyFromPublicUrl(input.url, r2PublicBase)
    : null

  if (rawKey) {
    const fromKey = normalizeStorageKey(rawKey)
    if (!fromKey?.startsWith('attachments/')) return null
    if (fromUrl && fromUrl !== fromKey) return null
    return fromKey
  }

  return fromUrl?.startsWith('attachments/') ? fromUrl : null
}
