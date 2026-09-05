import { spawn } from 'node:child_process'
import type { EngineId } from './engine.js'
import { isCustomAnthropicEndpoint, readClaudeUserSettings, withClaudeUserSettingsEnv } from './claude-user-settings.js'
import { versionCommandInvocation } from './cli-version.js'

export type ModelCatalogSource = 'protocol' | 'cli' | 'presets'
export type FastModelScope = 'agent' | 'computer' | 'unsupported'

export interface EngineModelOption {
  id: string
  label: string
  description?: string | null
  recommendedFor?: Array<'big' | 'small'>
}

/** Model choices advertised by the daemon that actually owns the CLI login.
 * The browser must not guess from a global vendor list: Cursor plans, OpenCode
 * providers, pi extensions, and Codex accounts can all expose different models. */
export interface EngineModelCatalog {
  models: EngineModelOption[]
  defaultModel: string | null
  defaultFastModel: string | null
  /** The local CLI/provider owns the default model namespace. An unpinned
   * Agent must not inherit a deployment-level vendor model in its place. */
  prefersLocalDefault?: boolean
  supportsCustom: boolean
  fastModelScope: FastModelScope
  source: ModelCatalogSource
}

const PRESETS: Record<EngineId, EngineModelCatalog> = {
  claude: {
    models: [
      { id: 'opus', label: 'Opus', recommendedFor: ['big'] },
      { id: 'sonnet', label: 'Sonnet', recommendedFor: ['big'] },
      { id: 'haiku', label: 'Haiku', recommendedFor: ['small'] },
    ],
    defaultModel: null,
    defaultFastModel: 'haiku',
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  codex: {
    models: [
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', recommendedFor: ['small'] },
    ],
    defaultModel: null,
    defaultFastModel: 'gpt-5.4-mini',
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  grok: {
    models: [
      { id: 'grok-4.6', label: 'Grok 4.6', recommendedFor: ['big'] },
      { id: 'grok-4.5', label: 'Grok 4.5', recommendedFor: ['small'] },
    ],
    defaultModel: null,
    defaultFastModel: 'grok-4.5',
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  cursor: {
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  opencode: {
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  pi: {
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  gemini: {
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', recommendedFor: ['big'] },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', recommendedFor: ['small'] },
    ],
    defaultModel: null,
    defaultFastModel: 'gemini-2.5-flash-lite',
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  qwen: {
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'computer',
    source: 'presets',
  },
  antigravity: {
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'computer',
    source: 'presets',
  },
}

const MODEL_PROBE_TIMEOUT_MS = 10_000
const MODEL_OUTPUT_LIMIT = 2 * 1024 * 1024
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000
const catalogCache = new Map<string, { at: number; catalog: EngineModelCatalog }>()

export function clearModelCatalogCache(): void {
  catalogCache.clear()
}

function clonePreset(id: EngineId): EngineModelCatalog {
  const preset = PRESETS[id]
  return { ...preset, models: preset.models.map((model) => ({ ...model, recommendedFor: model.recommendedFor?.slice() })) }
}

function clean(value: unknown, max = 240): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

function mergeModels(discovered: EngineModelOption[], fallback: EngineModelOption[]): EngineModelOption[] {
  const out: EngineModelOption[] = []
  const seen = new Set<string>()
  for (const model of [...discovered, ...fallback]) {
    const id = clean(model.id, 160)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: clean(model.label, 160) ?? id,
      description: clean(model.description, 320),
      recommendedFor: model.recommendedFor?.filter((tier): tier is 'big' | 'small' => tier === 'big' || tier === 'small'),
    })
    if (out.length >= 128) break
  }
  return out
}

function withPreset(id: EngineId, discovered: EngineModelOption[], source: 'protocol' | 'cli', defaultModel: string | null): EngineModelCatalog {
  const preset = clonePreset(id)
  return {
    ...preset,
    models: mergeModels(discovered, preset.models),
    defaultModel: clean(defaultModel, 160),
    source,
  }
}

function stopChild(child: ReturnType<typeof spawn>): void {
  try { child.stdin?.end() } catch { /* already closed */ }
  const timer = setTimeout(() => {
    try { child.kill() } catch { /* already gone */ }
  }, 250)
  timer.unref?.()
  child.once('close', () => clearTimeout(timer))
}

function runText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const invocation = versionCommandInvocation(command, args)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      })
    } catch {
      resolve('')
      return
    }
    let output = ''
    const append = (chunk: Buffer) => {
      if (output.length < MODEL_OUTPUT_LIMIT) output += chunk.toString('utf8').slice(0, MODEL_OUTPUT_LIMIT - output.length)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(output.trim())
    }
    const timer = setTimeout(() => { stopChild(child); finish() }, MODEL_PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', finish)
    child.once('close', finish)
  })
}

/** Parse model-list output shared by OpenCode, pi and Cursor. Exported so new
 * adapters can add fixtures without spawning a real account-bound CLI. */
export function parseListedModels(text: string, style: 'provider' | 'pi' | 'cursor'): EngineModelOption[] {
  const models: EngineModelOption[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
    if (!line || /^(available\s+)?models?\b/i.test(line) || /^provider\s+model\b/i.test(line)) continue
    let id: string | null = null
    if (style === 'provider') {
      id = line.match(/(?:^|\s)([a-z0-9][\w.-]*\/[\w./:@+-]+)/i)?.[1] ?? null
    } else if (style === 'pi') {
      id = line.match(/(?:^|\s)([a-z0-9][\w.-]*\/[\w./:@+-]+)/i)?.[1] ?? null
      if (!id) {
        const pair = line.replace(/^[*✓>•-]+\s*/, '').split(/\s+/)
        if (pair.length >= 2 && /^[a-z0-9][\w.-]*$/i.test(pair[0]) && /^[a-z0-9][\w.:@/+-]*[-.:/][\w.:@/+-]*$/i.test(pair[1])) {
          id = `${pair[0]}/${pair[1]}`
        }
      }
    } else {
      const candidate = line.replace(/^[*✓>•-]+\s*/, '').match(/^([a-z0-9][\w./:@+-]*)/i)?.[1] ?? null
      if (candidate && !/^(available|current|default|name|model)$/i.test(candidate)) id = candidate
    }
    const normalized = clean(id, 160)
    if (normalized) models.push({ id: normalized, label: normalized })
  }
  return mergeModels(models, [])
}

interface CodexListItem {
  id?: unknown
  model?: unknown
  displayName?: unknown
  description?: unknown
  isDefault?: unknown
}

function discoverCodex(command: string): Promise<{ models: EngineModelOption[]; defaultModel: string | null } | null> {
  return new Promise((resolve) => {
    const invocation = versionCommandInvocation(command, ['app-server', '--listen', 'stdio://'])
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      })
    } catch {
      resolve(null)
      return
    }
    child.stdin?.on('error', () => { /* close/error below owns the result */ })
    let settled = false
    let buffer = ''
    const finish = (value: { models: EngineModelOption[]; defaultModel: string | null } | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopChild(child)
      resolve(value)
    }
    const send = (message: object) => {
      try { child.stdin?.write(`${JSON.stringify(message)}\n`) } catch { finish(null) }
    }
    const timer = setTimeout(() => finish(null), MODEL_PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', () => finish(null))
    child.once('close', () => finish(null))
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('{')) continue
        let message: { id?: unknown; result?: { data?: unknown } }
        try { message = JSON.parse(line) as typeof message } catch { continue }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: { includeHidden: false, limit: 128 } })
          continue
        }
        if (message.id !== 2 || !Array.isArray(message.result?.data)) continue
        const rows = message.result.data as CodexListItem[]
        const models = rows.map((row): EngineModelOption | null => {
          const id = clean(row.model, 160) ?? clean(row.id, 160)
          if (!id) return null
          return {
            id,
            label: clean(row.displayName, 160) ?? id,
            description: clean(row.description, 320),
            recommendedFor: row.isDefault === true ? ['big'] : undefined,
          }
        }).filter((row): row is EngineModelOption => row !== null)
        const defaultModel = rows.find((row) => row.isDefault === true)
        finish({ models, defaultModel: clean(defaultModel?.model, 160) ?? clean(defaultModel?.id, 160) })
      }
    })
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'cumora-daemon', version: '1.0.0' }, capabilities: { experimentalApi: true } },
    })
  })
}

/** Discover the account/config-specific catalog without making a model call.
 * Failure is deliberately soft: a compact preset catalog plus custom entry is
 * still more useful than hiding the selector or blocking an engine rescan. */
export async function discoverEngineModelCatalog(
  id: EngineId,
  binPath: string | null,
  refresh = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineModelCatalog> {
  const preset = clonePreset(id)
  if (!binPath) return preset
  const cacheKey = `${id}\u0000${binPath}`
  const cached = catalogCache.get(cacheKey)
  if (!refresh && cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.catalog

  let catalog: EngineModelCatalog | null = null
  if (id === 'claude') {
    const settings = readClaudeUserSettings(env)
    const coreEnv = withClaudeUserSettingsEnv(env)
    const defaultFastModel = clean(coreEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 160)
      ?? clean(coreEnv.ANTHROPIC_SMALL_FAST_MODEL, 160)
    const prefersLocalDefault = isCustomAnthropicEndpoint(clean(coreEnv.ANTHROPIC_BASE_URL, 4096))
    const configured = [settings.defaultModel, defaultFastModel]
      .filter((model): model is string => !!model)
      .map((model) => ({ id: model, label: model }))
    if (configured.length || prefersLocalDefault) {
      catalog = {
        ...preset,
        // Anthropic aliases are useful first-party presets, but claiming they
        // exist on an arbitrary custom endpoint is misleading. Operators can
        // still type any provider-specific id via supportsCustom.
        models: mergeModels(configured, prefersLocalDefault ? [] : preset.models),
        defaultModel: settings.defaultModel,
        defaultFastModel: defaultFastModel ?? (prefersLocalDefault ? null : preset.defaultFastModel),
        prefersLocalDefault,
        source: 'cli',
      }
    }
  } else if (id === 'codex') {
    const result = await discoverCodex(binPath)
    if (result?.models.length) catalog = withPreset(id, result.models, 'protocol', result.defaultModel)
  } else if (id === 'cursor') {
    const models = parseListedModels(await runText(binPath, ['models']), 'cursor')
    if (models.length) catalog = withPreset(id, models, 'cli', null)
  } else if (id === 'opencode') {
    const models = parseListedModels(await runText(binPath, ['models']), 'provider')
    if (models.length) catalog = withPreset(id, models, 'cli', null)
  } else if (id === 'pi') {
    const models = parseListedModels(await runText(binPath, ['--list-models']), 'pi')
    if (models.length) catalog = withPreset(id, models, 'cli', null)
  }

  if (catalog) catalogCache.set(cacheKey, { at: Date.now(), catalog })
  return catalog ?? preset
}
