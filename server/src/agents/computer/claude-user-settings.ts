/**
 * Claude Code's `--restricted` mode intentionally ignores user settings. That
 * is the right boundary for tools, hooks and MCP servers, but custom providers
 * keep provider bootstrap and model preferences in ~/.claude/settings.json.
 * Import only validated, non-executable fields. Environment values enter the
 * trusted core; the adapter denies those names to model-spawned subprocesses.
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
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const

/** Turn preferences must not raise the budget of triage or doctor calls. */
export const CLAUDE_TURN_ENV_KEYS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_DISABLE_THINKING',
] as const

type SavedEffort = 'low' | 'medium' | 'high' | 'xhigh'
export interface ClaudeTurnSettings {
  effortLevel?: SavedEffort
  modelSettings?: Record<string, { effortLevel: SavedEffort }>
  alwaysThinkingEnabled?: boolean
  language?: string
}

function savedEffort(value: unknown): value is SavedEffort {
  return typeof value === 'string' && ['low', 'medium', 'high', 'xhigh'].includes(value)
}

function turnSettings(record: Record<string, unknown>): ClaudeTurnSettings {
  const result: ClaudeTurnSettings = {}
  if (savedEffort(record.effortLevel)) result.effortLevel = record.effortLevel
  if (typeof record.alwaysThinkingEnabled === 'boolean') result.alwaysThinkingEnabled = record.alwaysThinkingEnabled
  const language = cleanString(record.language, 160)
  if (language) result.language = language
  if (record.modelSettings && typeof record.modelSettings === 'object' && !Array.isArray(record.modelSettings)) {
    const entries = Object.entries(record.modelSettings).slice(0, 128).flatMap(([model, value]) => {
      if (!model || model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)
        || !value || typeof value !== 'object' || Array.isArray(value)) return []
      const effort = (value as Record<string, unknown>).effortLevel
      return savedEffort(effort) ? [[model, { effortLevel: effort }] as const] : []
    })
    if (entries.length) result.modelSettings = Object.fromEntries(entries)
  }
  return result
}

function turnEnv(rawEnv: Record<string, unknown>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of CLAUDE_TURN_ENV_KEYS) {
    const value = rawEnv[key]
    if (typeof value !== 'string') continue
    if (key === 'CLAUDE_CODE_EFFORT_LEVEL') {
      if (savedEffort(value) || value === 'max' || value === 'auto') result[key] = value
    } else if (key === 'MAX_THINKING_TOKENS' || key === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS') {
      if (/^(0|[1-9]\d{0,8})$/.test(value) && (key === 'MAX_THINKING_TOKENS' || value !== '0')) result[key] = value
    } else if (value === '0' || value === '1') result[key] = value
  }
  return result
}

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
  turnEnv: NodeJS.ProcessEnv
  turnSettings: ClaudeTurnSettings
  defaultModel: string | null
  defaultFastModel: string | null
  prefersLocalDefault: boolean
}

const EMPTY_SETTINGS: ClaudeUserSettings = {
  coreEnv: {},
  turnEnv: {},
  turnSettings: {},
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

/** Read only non-executable provider bootstrap and turn preferences from user
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
      turnEnv: turnEnv(rawEnv),
      turnSettings: turnSettings(record),
      defaultModel: cleanString(record.model, 160),
      defaultFastModel: cleanString(rawEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 160)
        ?? cleanString(rawEnv.ANTHROPIC_SMALL_FAST_MODEL, 160),
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
