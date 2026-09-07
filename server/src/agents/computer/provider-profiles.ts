/** Local-only Claude credentials. Only providerProfileMetadata may cross the
 * daemon/server boundary; the configuration lives outside every Agent home. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { CLAUDE_CORE_ENV_KEYS } from './claude-user-settings.js'

export interface ProviderProfileMetadata {
  id: string
  label: string
  model: string
  fastModel: string
}

export interface ProviderProfile extends ProviderProfileMetadata {
  baseUrl: string
  auth: { apiKey: string } | { authToken: string }
}

export function isProviderProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object')
  return value as Record<string, unknown>
}

function field(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('invalid text field')
  }
  return value.trim()
}

/** Explicit projection also protects against accidentally reporting newly
 * added private fields. The server repeats this projection on untrusted input. */
export function providerProfileMetadata(profile: ProviderProfileMetadata): ProviderProfileMetadata {
  return { id: profile.id, label: profile.label, model: profile.model, fastModel: profile.fastModel }
}

export function sanitizeProviderProfiles(value: unknown): ProviderProfileMetadata[] {
  if (!Array.isArray(value)) return []
  const result = new Map<string, ProviderProfileMetadata>()
  for (const item of value.slice(0, 50)) {
    try {
      const p = record(item)
      if (!isProviderProfileId(p.id)) continue
      result.set(p.id, { id: p.id, label: field(p.label, 80), model: field(p.model, 160), fastModel: field(p.fastModel, 160) })
    } catch { /* malformed discovery metadata is not selectable */ }
  }
  return [...result.values()]
}

export function parseProviderProfiles(raw: unknown): ProviderProfile[] {
  try {
    const config = record(raw)
    if (config.version !== 1 || !Array.isArray(config.profiles) || config.profiles.length > 50) throw new Error()
    const ids = new Set<string>()
    return config.profiles.map((value) => {
      const p = record(value)
      if (!isProviderProfileId(p.id) || ids.has(p.id)) throw new Error()
      ids.add(p.id)
      const baseUrl = field(p.baseUrl, 2048)
      const url = new URL(baseUrl)
      if (url.username || url.password || url.search || url.hash) throw new Error()
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error()
      const auth = record(p.auth)
      const keys = Object.keys(auth)
      if (keys.length !== 1 || !['apiKey', 'authToken'].includes(keys[0])) throw new Error()
      const secret = field(auth[keys[0]], 8192)
      return {
        id: p.id, label: field(p.label, 80), baseUrl: url.href.replace(/\/$/, ''),
        model: field(p.model, 160), fastModel: field(p.fastModel, 160),
        auth: keys[0] === 'apiKey' ? { apiKey: secret } : { authToken: secret },
      }
    })
  } catch {
    // Never put JSON values, URL parser errors, or credentials into daemon logs.
    throw new Error('invalid providers.json: expected version 1 and unique Claude profiles with id, label, baseUrl, model, fastModel and one auth credential')
  }
}

export function readProviderProfiles(path: string): ProviderProfile[] {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error('cannot open providers.json (must be a regular local file)')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('providers.json must be a regular file under 1 MiB')
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw new Error('providers.json must be owned by the daemon user with permissions 0600')
    }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(fd, 'utf8')) } catch { throw new Error('providers.json is not valid JSON') }
    return parseProviderProfiles(raw)
  } finally {
    closeSync(fd)
  }
}

/** Changing credentials, endpoint or model namespace starts a separate native
 * session. The digest stays local and is never included in discovery metadata. */
export function providerProfileFingerprint(profile?: ProviderProfile): string {
  return profile ? createHash('sha256').update(JSON.stringify({ id: profile.id, baseUrl: profile.baseUrl, auth: profile.auth, model: profile.model, fastModel: profile.fastModel })).digest('hex') : ''
}

export function providerProfileEnv(env: NodeJS.ProcessEnv, profile: ProviderProfile): NodeJS.ProcessEnv {
  if (env.CUMORA_BYOA_ALLOW_UNSANDBOXED === '1') throw new Error('provider profiles require secure BYOA mode')
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_USE_')) next[key] = ''
  }
  // Empty values suppress the restricted adapter's ~/.claude provider bootstrap.
  for (const key of CLAUDE_CORE_ENV_KEYS) next[key] = ''
  return {
    ...next,
    CUMORA_BYOA_ALLOW_UNSANDBOXED: '0',
    CUMORA_ENGINE_MODEL: '', CUMORA_TRIAGE_MODEL: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_API_KEY: 'apiKey' in profile.auth ? profile.auth.apiKey : '',
    ANTHROPIC_AUTH_TOKEN: 'authToken' in profile.auth ? profile.auth.authToken : '',
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.fastModel,
    ANTHROPIC_SMALL_FAST_MODEL: profile.fastModel,
  }
}

export function redactProviderSecret(text: string, profile?: ProviderProfile): string {
  if (!profile) return text
  const secret = 'apiKey' in profile.auth ? profile.auth.apiKey : profile.auth.authToken
  return text.split(secret).join('[redacted]')
}
