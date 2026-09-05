/**
 * Claude Code's `--restricted` mode intentionally ignores user settings. That
 * is the right boundary for tools, hooks and MCP servers, but custom providers
 * commonly keep the small provider/bootstrap surface the Claude core needs in
 * ~/.claude/settings.json. Import only that narrow bootstrap surface into the
 * engine process environment; the adapter's restricted settings separately
 * deny every imported value to model-spawned subprocesses.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const MAX_SETTINGS_BYTES = 1024 * 1024

/** Never broaden this to arbitrary settings.env entries. Values in this list
 * reach the trusted Claude core process, while everything else remains ignored
 * exactly as `--restricted` promises. */
export const CLAUDE_CORE_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const

/** Anthropic's own API origins. A base URL naming one of these is not a custom
 *  provider — it is the default, written out.
 *
 *  This matters because Claude Code exports ANTHROPIC_BASE_URL into every
 *  process it spawns, pointing at Anthropic's own endpoint. Treating "the
 *  variable is set" as "a custom provider owns the model namespace" therefore
 *  fires for an ordinary first-party account whenever the daemon is started
 *  from a Claude Code session, or from any shell that exports it. */
const ANTHROPIC_FIRST_PARTY_HOSTS: ReadonlySet<string> = new Set(['api.anthropic.com'])

/** Does this base URL point somewhere other than Anthropic itself?
 *
 *  Unset is not custom. An unparseable value IS treated as custom: we cannot
 *  vouch for it as first-party, and the conservative answer is to stop claiming
 *  Anthropic's model aliases exist behind it. */
export function isCustomAnthropicEndpoint(baseUrl: string | null | undefined): boolean {
  const raw = baseUrl?.trim()
  if (!raw) return false
  try {
    return !ANTHROPIC_FIRST_PARTY_HOSTS.has(new URL(raw).hostname.toLowerCase())
  } catch {
    return true
  }
}

type ClaudeCoreEnvKey = typeof CLAUDE_CORE_ENV_KEYS[number]

export interface ClaudeUserSettings {
  coreEnv: Partial<Record<ClaudeCoreEnvKey, string>>
  defaultModel: string | null
  defaultFastModel: string | null
  prefersLocalDefault: boolean
}

const EMPTY_SETTINGS: ClaudeUserSettings = {
  coreEnv: {},
  defaultModel: null,
  defaultFastModel: null,
  prefersLocalDefault: false,
}

function cleanString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean ? clean.slice(0, max) : null
}

function settingsPath(env: NodeJS.ProcessEnv): string | null {
  const configured = cleanString(env.CLAUDE_CONFIG_DIR, 4096)
  // Never resolve a relative override against the daemon's changing cwd. An
  // explicit but ambiguous override is ignored as a whole rather than falling
  // back to a different settings file.
  if (configured && !isAbsolute(configured)) return null
  const dir = configured ?? join(homedir(), '.claude')
  return join(dir, 'settings.json')
}

/** Read only the non-executable provider bootstrap subset of Claude's user
 * settings. Malformed, oversized or absent settings fail soft so first-party
 * OAuth/keychain users retain Claude's native behaviour. */
export function readClaudeUserSettings(env: NodeJS.ProcessEnv = process.env): ClaudeUserSettings {
  try {
    const file = settingsPath(env)
    if (!file) return EMPTY_SETTINGS
    if (statSync(file).size > MAX_SETTINGS_BYTES) return EMPTY_SETTINGS
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_SETTINGS
    const record = parsed as Record<string, unknown>
    const rawEnv = record.env && typeof record.env === 'object' && !Array.isArray(record.env)
      ? record.env as Record<string, unknown>
      : {}
    const coreEnv: Partial<Record<ClaudeCoreEnvKey, string>> = {}
    for (const key of CLAUDE_CORE_ENV_KEYS) {
      const value = cleanString(rawEnv[key], key === 'ANTHROPIC_SMALL_FAST_MODEL' ? 160 : 4096)
      if (value) coreEnv[key] = value
    }
    return {
      coreEnv,
      defaultModel: cleanString(record.model, 160),
      defaultFastModel: cleanString(rawEnv.ANTHROPIC_SMALL_FAST_MODEL, 160),
      // A custom endpoint owns its model namespace. When no explicit Agent pin
      // exists, the server must not replace that namespace with its Anthropic
      // deployment default even if the local config omits a named model.
      prefersLocalDefault: isCustomAnthropicEndpoint(coreEnv.ANTHROPIC_BASE_URL),
    }
  } catch {
    return EMPTY_SETTINGS
  }
}

/** Explicit daemon environment always wins over the user settings file. */
export function withClaudeUserSettingsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged = { ...env }
  const { coreEnv } = readClaudeUserSettings(env)
  for (const key of CLAUDE_CORE_ENV_KEYS) {
    if (merged[key] === undefined && coreEnv[key] !== undefined) merged[key] = coreEnv[key]
  }
  return merged
}
