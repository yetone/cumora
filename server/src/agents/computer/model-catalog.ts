import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isCustomAnthropicEndpoint, readClaudeUserSettings, withClaudeUserSettingsEnv } from './claude-user-settings.js'
import { versionCommandInvocation } from './cli-version.js'
import { codexProviderFingerprint, codexProviderRuntime } from './codex-provider.js'
import { readCodexRpc } from './codex-rpc.js'
import { CODEX_RUNTIME_CONFIG_ARGS, codexAuthFingerprint } from './codex-runtime.js'
import { configuredEngineModels } from './configured-models.js'
import type { EngineId } from './engine.js'
import { modelIdOrNull } from './model-id.js'
import { fetchProviderModels, MAX_CATALOG_MODELS, readProviderCatalogFile } from './provider-models.js'
import type { VisionCapability } from './model-capabilities.js'

export type ModelCatalogSource = 'protocol' | 'cli' | 'presets'
export type FastModelScope = 'agent' | 'computer' | 'unsupported'

export interface EngineModelOption {
  id: string
  label: string
  description?: string | null
  recommendedFor?: Array<'big' | 'small'>
  supportsFastMode?: boolean
  /** Explicitly reported vision support. Missing means unknown. */
  vision?: VisionCapability
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
  /** Choices explicitly configured or listed for this connection, without preset
   * contamination. This does not guarantee execution or model capabilities.
   * Absent on older daemons that appended unverified vendor presets. */
  trustedModels?: boolean
  stale?: boolean
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
    models: [
      { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', recommendedFor: ['big'] },
      { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', recommendedFor: ['small'] },
      { id: 'qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B Instruct' },
    ],
    defaultModel: null,
    defaultFastModel: 'qwen3-coder-flash',
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  antigravity: {
    models: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', recommendedFor: ['small'] },
      { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)', recommendedFor: ['small'] },
      { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', recommendedFor: ['big'] },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', recommendedFor: ['big'] },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', recommendedFor: ['big'] },
    ],
    defaultModel: null,
    defaultFastModel: 'gemini-3.8-flash-high',
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  zcode: {
    // The model namespace is the operator's zcode config (GLM plan or a
    // third-party provider), so there is no first-party preset to name —
    // supportsCustom lets an agent pin any id their zcode install accepts.
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
  maka: {
    // Maka selects models in its own settings; ACP does not expose model selection.
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: false,
    fastModelScope: 'agent',
    source: 'presets',
  },
  omp: {
    // The namespace is the operator's own ~/.omp provider config, so there is
    // no first-party preset to name — supportsCustom stays open for a pin.
    models: [],
    defaultModel: null,
    defaultFastModel: null,
    supportsCustom: true,
    fastModelScope: 'agent',
    source: 'presets',
  },
}

const MODEL_PROBE_TIMEOUT_MS = 10_000
// The first `omp models --json` of a fresh cache measured 11.9-13.5s here
// (warm runs answer in 1.2s), so the shared 10s cap would report an empty
// catalog on exactly the rescan after an install. Discovery rides the
// 5-minute background rescan, so the longer ceiling costs nobody a wait.
const OMP_CATALOG_TIMEOUT_MS = 30_000
const MODEL_OUTPUT_LIMIT = 2 * 1024 * 1024
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000
const catalogCache = new Map<string, {
  at: number; fingerprint: string; catalog: EngineModelCatalog
  remote?: EngineModelOption[]; protocol?: EngineModelOption[]
}>()

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
    const id = modelIdOrNull(model.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: clean(model.label, 160) ?? id,
      description: clean(model.description, 320),
      recommendedFor: model.recommendedFor?.filter((tier): tier is 'big' | 'small' => tier === 'big' || tier === 'small'),
      ...(typeof model.supportsFastMode === 'boolean' ? { supportsFastMode: model.supportsFastMode } : {}),
      ...(model.vision === 'supported' || model.vision === 'unsupported' || model.vision === 'unknown'
        ? { vision: model.vision }
        : {}),
    })
    if (out.length >= MAX_CATALOG_MODELS) break
  }
  return out
}

/** A CLI that listed models answered the question the preset was guessing at, so
 *  the preset's models must not ride along. They used to be appended behind the
 *  real listing, which meant a provider that returned one model still produced a
 *  picker offering a dozen — each wearing the preset's "Recommended" marker, each
 *  one an Agent could inherit and then fail on, because the account cannot run
 *  it. The preset still supplies what it alone knows: fast-model scope and
 *  whether custom entry is allowed. */
function fromDiscovered(id: EngineId, discovered: EngineModelOption[], source: 'protocol' | 'cli', defaultModel: string | null): EngineModelCatalog {
  const preset = clonePreset(id)
  return {
    ...preset,
    models: mergeModels(discovered, []),
    defaultModel: clean(defaultModel, 160),
    // The fast default is a hint about what an unpinned Agent will run, so a
    // preset id the account did not list is the same lie as an unlisted model.
    defaultFastModel: discovered.some((model) => model.id === preset.defaultFastModel) ? preset.defaultFastModel : null,
    source,
    trustedModels: true,
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

function runText(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = MODEL_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    const invocation = versionCommandInvocation(command, args)
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env, cwd: homedir(),
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    let exceeded = false
    const append = (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > MODEL_OUTPUT_LIMIT) exceeded = true
      if (output.length < MODEL_OUTPUT_LIMIT) output += chunk.toString('utf8').slice(0, MODEL_OUTPUT_LIMIT - output.length)
    }
    child.stdout?.on('data', append)
    child.stderr?.resume()
    let settled = false
    const finish = (ok = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok && !exceeded ? output.trim() : null)
    }
    const timer = setTimeout(() => { stopChild(child); finish() }, timeoutMs)
    timer.unref?.()
    child.once('error', () => finish())
    child.once('close', code => finish(code === 0))
  })
}

/** Split a listing line into its id column and whatever follows. Columns are
 *  separated by a tab or a run of two or more spaces — how a CLI lays out a
 *  table. Single spaces are how a sentence is written, so prose stays in one
 *  piece and `modelIdToken` can reject it whole. */
function splitIdColumn(line: string): [string, string] {
  const stripped = line.replace(/^[*✓>•-]+\s*/, '')
  const sep = stripped.search(/\t| {2,}/)
  if (sep < 0) return [stripped.trim(), '']
  return [stripped.slice(0, sep).trim(), stripped.slice(sep).trim()]
}

/** Even a successful CLI may print prose such as "No models available".
 * Only a complete ID column is a selectable model. */
function modelIdToken(column: string): string | null {
  if (!column || /\s/.test(column)) return null
  // "Error:", "Warning:" — a bare word wearing sentence punctuation, which can
  // survive the column rule when a CLI aligns its message.
  if (/^[a-z]+[.:,;!?]+$/i.test(column)) return null
  return modelIdOrNull(column)
}

/** Parse model-list output shared by OpenCode, pi, Cursor and Antigravity. Exported so new
 * adapters can add fixtures without spawning a real account-bound CLI. */
export function parseListedModels(text: string, style: 'provider' | 'pi' | 'cursor' | 'antigravity'): EngineModelOption[] {
  const models: EngineModelOption[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
    if (!line || /^(available\s+)?models?\b/i.test(line) || /^provider\s+model\b/i.test(line) || /^fetching\b/i.test(line)) continue
    let id: string | null = null
    let label: string | null = null
    let recommendedFor: Array<'big' | 'small'> | undefined
    if (style === 'provider' || style === 'pi') {
      const candidate = modelIdToken(splitIdColumn(line)[0])
      if (candidate?.includes('/')) id = candidate
      if (!id && style === 'pi') {
        const pair = line.replace(/^[*✓>•-]+\s*/, '').split(/\s+/)
        if (pair.length >= 2 && /^[a-z0-9][\w.-]*$/i.test(pair[0]) && /^[a-z0-9][\w.:@/+-]*[-.:/][\w.:@/+-]*$/i.test(pair[1])) {
          id = `${pair[0]}/${pair[1]}`
        }
      }
    } else if (style === 'antigravity') {
      const [idPart, labelPart] = splitIdColumn(line)
      const candidate = modelIdToken(idPart)
      if (candidate) {
        id = candidate
        label = labelPart || candidate
        const isSmall = /(?:^|[-_/])(?:flash|mini|haiku|lite)(?:[-_/]|$)/i.test(candidate)
        const isBig = /(?:^|[-_/])(?:pro|opus|sonnet|120b)(?:[-_/]|$)/i.test(candidate)
          || (!isSmall && /(?:^|[-_/])(?:thinking|plus|large)(?:[-_/]|$)/i.test(candidate))
        const recs: Array<'big' | 'small'> = []
        if (isBig) recs.push('big')
        if (isSmall) recs.push('small')
        if (recs.length) recommendedFor = recs
      }
    } else {
      const [column, labelPart] = splitIdColumn(line)
      const candidate = modelIdToken(column)
      if (candidate && !/^(available|current|default|id|name|model)$/i.test(candidate)) {
        id = candidate
        label = labelPart || candidate
      }
    }
    const normalized = clean(id, 160)
    if (normalized) {
      models.push({
        id: normalized,
        label: clean(label, 160) ?? normalized,
        description: null,
        recommendedFor,
      })
    }
  }
  return mergeModels(models, [])
}

/** Parse `omp models --json`. The selectable id is `selector` (provider/name),
 *  NOT the bare `id`, which is provider-relative and silently no-ops as a pin.
 *  Exported so fixtures never need a real omp install. */
export function parseOmpModels(text: string): EngineModelOption[] {
  // A banner line ahead of the payload would otherwise parse as nothing and
  // silently leave the picker on the empty preset.
  const start = text.indexOf('{')
  if (start < 0) return []
  let payload: unknown
  try { payload = JSON.parse(text.slice(start)) } catch { return [] }
  if (!payload || typeof payload !== 'object' || !('models' in payload)) return []
  if (!Array.isArray(payload.models)) return []
  const models: EngineModelOption[] = []
  for (const row of payload.models) {
    if (!row || typeof row !== 'object') continue
    if (!('kind' in row) || row.kind !== 'chat') continue
    if (!('selector' in row) || typeof row.selector !== 'string') continue
    const id = clean(row.selector, 160)
    if (!id) continue
    const label = 'name' in row && typeof row.name === 'string' ? row.name : null
    models.push({ id, label: clean(label, 160) ?? id, description: null })
  }
  return mergeModels(models, [])
}

interface CodexListItem {
  id?: unknown
  model?: unknown
  displayName?: unknown
  description?: unknown
  isDefault?: unknown
  serviceTiers?: unknown
  input_modalities?: unknown
  inputModalities?: unknown
  input?: unknown
}

async function discoverCodex(command: string, env: NodeJS.ProcessEnv, providerArgs: string[]): Promise<{ models: EngineModelOption[]; defaultModel: string | null } | null> {
  const models: EngineModelOption[] = []
  let defaultModel: string | null = null
  let cursor: string | null = null
  const cursors = new Set<string>()
  const deadline = Date.now() + MODEL_PROBE_TIMEOUT_MS
  let remainingBytes = MODEL_OUTPUT_LIMIT
  for (let page = 0; page < 8; page++) {
    if (Date.now() >= deadline || remainingBytes <= 0) return null
    const result = await readCodexRpc(command, [...CODEX_RUNTIME_CONFIG_ARGS, ...providerArgs], env,
      'model/list', { includeHidden: false, limit: 128, ...(cursor ? { cursor } : {}) },
      { timeoutMs: deadline - Date.now(), maxBytes: remainingBytes })
    if (!Array.isArray(result?.data)) return null
    remainingBytes -= Buffer.byteLength(JSON.stringify(result))
    for (const row of result.data as CodexListItem[]) {
      const id = modelIdOrNull(typeof row.model === 'string' ? row.model : typeof row.id === 'string' ? row.id : null)
      if (!id) continue
      const modalities = Array.isArray(row.input_modalities)
        ? row.input_modalities
        : Array.isArray(row.inputModalities)
          ? row.inputModalities
          : row.input && typeof row.input === 'object' && Array.isArray((row.input as { modalities?: unknown }).modalities)
            ? (row.input as { modalities: unknown[] }).modalities
            : null
      models.push({ id, label: clean(row.displayName, 160) ?? id, description: clean(row.description, 320),
        recommendedFor: row.isDefault === true ? ['big'] : undefined,
        ...(modalities ? { vision: modalities.includes('image') ? 'supported' as const : 'unsupported' as const } : {}),
        ...(Array.isArray(row.serviceTiers) ? {
          supportsFastMode: row.serviceTiers.some((tier) => tier?.id === 'fast' || tier?.id === 'priority'),
        } : {}),
      })
      if (row.isDefault === true) defaultModel = id
    }
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
    if (!cursor || models.length >= MAX_CATALOG_MODELS) return { models: models.slice(0, MAX_CATALOG_MODELS), defaultModel }
    if (cursors.has(cursor)) return null
    cursors.add(cursor)
  }
  return null
}

/** Discover the account/config-specific catalog without making a model call.
 * Failure is deliberately soft: the preset still names the engine's own
 * defaults and the app keeps custom entry open, which beats blocking an engine
 * rescan. The preset is not a listing though, so it never carries
 * `trustedModels` and the app shows no rows for it. */
export async function discoverEngineModelCatalog(
  id: EngineId,
  binPath: string | null,
  refresh = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineModelCatalog> {
  const preset = clonePreset(id)
  if (!binPath) return preset
  // Unreadable configuration cannot establish which connection owns old rows.
  const failed = (): EngineModelCatalog => ({
    ...preset, models: [], defaultModel: null, defaultFastModel: null, stale: true,
  })
  // Native listings already resolve all configured backend providers. Re-read
  // them on a rescan rather than caching under an unknown connection identity.
  const listing = {
    cursor: ['models', 'cursor'], opencode: ['models', 'provider'],
    pi: ['--list-models', 'pi'], antigravity: ['models', 'antigravity'],
    grok: ['models', 'cursor'],
  } as const
  if (id in listing) {
    const [arg, style] = listing[id as keyof typeof listing]
    const output = await runText(binPath, [arg], env)
    const models = output === null ? [] : parseListedModels(output, style)
    return models.length || output === '' ? fromDiscovered(id, models, 'cli', null) : preset
  }
  if (id === 'omp') {
    const models = parseOmpModels(await runText(binPath, ['models', '--json'], env, OMP_CATALOG_TIMEOUT_MS) ?? '')
    return models.length ? fromDiscovered(id, models, 'cli', null) : preset
  }
  if (id === 'gemini' || id === 'qwen' || id === 'zcode') {
    try {
      const configured = configuredEngineModels(id, env)
      return configured ? { ...fromDiscovered(id, configured.models, 'cli', configured.defaultModel),
        defaultFastModel: null, prefersLocalDefault: true } : preset
    } catch { return failed() }
  }
  if (id !== 'claude' && id !== 'codex') return preset
  const settings = id === 'claude' ? readClaudeUserSettings(env) : null
  if (settings?.readFailure) return failed()
  const coreEnv = id === 'claude' ? withClaudeUserSettingsEnv(env) : env
  let codex
  try {
    if (id === 'codex') codex = await codexProviderRuntime(binPath, env)
  } catch { return failed() }
  const identity = id === 'claude'
    ? [coreEnv.ANTHROPIC_BASE_URL, coreEnv.ANTHROPIC_API_KEY, coreEnv.ANTHROPIC_AUTH_TOKEN]
    : [codex?.provider.identity, codexAuthFingerprint()]
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const cacheKey = `${id}\0${binPath}\0${hash(identity)}`
  const fingerprint = id === 'claude' ? hash([settings, coreEnv.ANTHROPIC_MODEL, coreEnv.ANTHROPIC_DEFAULT_OPUS_MODEL,
    coreEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, coreEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, coreEnv.ANTHROPIC_SMALL_FAST_MODEL])
    : hash([codexProviderFingerprint(env), readProviderCatalogFile(codex?.provider.catalogFile ?? null)])
  const cached = catalogCache.get(cacheKey)
  if (!refresh && cached && cached.fingerprint === fingerprint && Date.now() - cached.at < MODEL_CACHE_TTL_MS) return cached.catalog

  let catalog: EngineModelCatalog | null = null
  let remoteModels = cached?.remote
  let protocolModels = cached?.protocol
  if (id === 'claude' && settings) {
    const defaultFastModel = modelIdOrNull(coreEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      ?? modelIdOrNull(coreEnv.ANTHROPIC_SMALL_FAST_MODEL)
    const prefersLocalDefault = isCustomAnthropicEndpoint(coreEnv.ANTHROPIC_BASE_URL)
    const defaultModel = modelIdOrNull(coreEnv.ANTHROPIC_MODEL) ?? settings.defaultModel
    const mapped = [defaultModel, coreEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, coreEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
      coreEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, coreEnv.ANTHROPIC_SMALL_FAST_MODEL]
      .filter((model): model is string => !!model).map(id => ({ id, label: id }))
    let remote: EngineModelOption[] | null = null
    const hasPicker = settings.models !== undefined
    if (!hasPicker && prefersLocalDefault && coreEnv.ANTHROPIC_BASE_URL) {
      try {
        const base = new URL(coreEnv.ANTHROPIC_BASE_URL)
        if (['http:', 'https:'].includes(base.protocol) && !base.username && !base.password) {
          const path = base.pathname.replace(/\/+$/, '')
          base.pathname = `${path}${/\/v1$/.test(path) ? '' : '/v1'}/models`
          base.hash = ''
          const token = coreEnv.ANTHROPIC_AUTH_TOKEN
          const key = coreEnv.ANTHROPIC_API_KEY
          remote = await fetchProviderModels({ url: base.href, headers: {
            'anthropic-version': '2023-06-01', ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(key ? { 'x-api-key': key } : {}),
          } })
        }
      } catch { /* Only local declarations remain available. */ }
    }
    const configured = mergeModels(settings.models ?? [], mapped)
    remoteModels = hasPicker ? undefined : remote ?? cached?.remote
    if (hasPicker || configured.length || prefersLocalDefault || remote !== null) {
      catalog = { ...preset,
        models: mergeModels(configured, remoteModels ?? (hasPicker || prefersLocalDefault ? [] : preset.models))
          .map(model => prefersLocalDefault ? { ...model, supportsFastMode: false } : model),
        defaultModel,
        defaultFastModel: defaultFastModel ?? (prefersLocalDefault ? null : preset.defaultFastModel),
        prefersLocalDefault, source: 'cli', trustedModels: true,
        ...(!hasPicker && prefersLocalDefault && coreEnv.ANTHROPIC_BASE_URL && remote === null ? { stale: true } : {}),
      }
    }
  } else if (codex) {
    const { provider, env: runtimeEnv } = codex
    const result = await discoverCodex(binPath, runtimeEnv, provider.args)
    const remote = !result && !cached?.protocol && provider.connection ? await fetchProviderModels(provider.connection) : null
    const local = readProviderCatalogFile(provider.catalogFile)
    if (provider.defaultModel && !local.some(model => model.id === provider.defaultModel)) {
      local.push({ id: provider.defaultModel, label: provider.defaultModel })
    }
    remoteModels = result || cached?.protocol ? undefined : remote ?? cached?.remote
    protocolModels = result?.models ?? cached?.protocol
    if (result || remote !== null || local.length || cached) {
      const protocol = protocolModels ?? []
      const native = new Map(protocol.map(model => [model.id, model]))
      const explicit = local.map(model => ({ ...native.get(model.id), ...model,
        label: model.label !== model.id ? model.label : native.get(model.id)?.label ?? model.label,
        description: model.description ?? native.get(model.id)?.description,
        ...(!native.has(model.id) ? { supportsFastMode: false } : {}),
      }))
      const rows = mergeModels(explicit, mergeModels(protocol, (remoteModels ?? [])
        .map(model => ({ ...model, supportsFastMode: false }))))
      catalog = { ...fromDiscovered(id, rows, 'protocol', provider.defaultModel ?? result?.defaultModel ?? null),
        prefersLocalDefault: provider.prefersLocalDefault,
        ...(provider.prefersLocalDefault ? { defaultFastModel: null } : {}),
        ...(!result ? { stale: true } : {}),
      }
    }
  }

  if (!catalog && cached) return { ...cached.catalog, stale: true }
  if (catalog) {
    if (catalogCache.size >= 64 && !catalogCache.has(cacheKey)) catalogCache.delete(catalogCache.keys().next().value!)
    catalogCache.set(cacheKey, { at: Date.now(), fingerprint, catalog, remote: remoteModels, protocol: protocolModels })
  }
  return catalog ?? preset
}
