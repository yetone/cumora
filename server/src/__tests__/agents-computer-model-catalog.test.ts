/**
 * Generic BYOA model-catalog parsing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-model-catalog.test.ts
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readClaudeUserSettings, withClaudeUserSettingsEnv } from '../agents/computer/claude-user-settings.js'
import { clearModelCatalogCache, discoverEngineModelCatalog, parseKimiConfigOptions, parseListedModels, parseOmpModels } from '../agents/computer/model-catalog.js'

// Metadata probes must never share the developer's real Codex home/login.
const isolatedHome = await mkdtemp(join(tmpdir(), 'cumora-catalog-home-'))
const originalEnv = { ...process.env }
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.env.CODEX_HOME = join(isolatedHome, '.codex')
delete process.env.OPENAI_BASE_URL
after(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  await rm(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

test('Codex discovers Fast Mode support from advertised service tiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-tiers-'))
  const script = join(root, 'catalog.cjs')
  const bin = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  const rows = [
    { model: 'fast-model', serviceTiers: [{ id: 'fast' }], isDefault: true },
    { model: 'priority-model', serviceTiers: [{ id: 'priority' }] },
    { model: 'standard-model', serviceTiers: [] },
    { model: 'legacy-model' },
  ]
  await writeFile(script, `
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id) process.stdout.write(JSON.stringify({ id: msg.id, result: msg.method === 'model/list' ? { data: ${JSON.stringify(rows)} } : {} }) + '\\n')
})
`)
  await writeFile(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0catalog.cjs" %*\r\n`
    : `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 })
  try {
    const catalog = await discoverEngineModelCatalog('codex', bin, true)
    assert.equal(catalog.source, 'protocol')
    assert.deepEqual(rows.map((row) => catalog.models.find((model) => model.id === row.model)?.supportsFastMode), [true, true, false, undefined])
  } finally {
    clearModelCatalogCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('OpenCode catalog keeps provider-qualified model ids and deduplicates them', () => {
  assert.deepEqual(
    parseListedModels('anthropic/claude-sonnet-4-6\nopenai/gpt-5.5\nanthropic/claude-sonnet-4-6\n', 'provider'),
    [
      { id: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6', description: null, recommendedFor: undefined },
      { id: 'openai/gpt-5.5', label: 'openai/gpt-5.5', description: null, recommendedFor: undefined },
    ],
  )
})

test('pi catalog accepts provider/model output and a provider plus model table', () => {
  const out = parseListedModels(
    'Provider Model Context\nanthropic claude-sonnet-4-6 200k\nopenai/gpt-5.5:high\n',
    'pi',
  )
  assert.deepEqual(out.map((model) => model.id), [
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.5:high',
  ])
})

test('Cursor catalog accepts bullets and ignores headings', () => {
  const out = parseListedModels('Available models\n* auto\n- claude-4.6-sonnet\n  gpt-5.5\n', 'cursor')
  assert.deepEqual(out.map((model) => model.id), ['auto', 'claude-4.6-sonnet', 'gpt-5.5'])
})

test('Claude custom-provider settings expose only core bootstrap values and model defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-claude-catalog-'))
  const configDir = join(root, 'config')
  await mkdir(configDir)
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({
    model: 'provider/opus-large',
    env: {
      ANTHROPIC_AUTH_TOKEN: 'settings-token',
      ANTHROPIC_BASE_URL: 'https://provider.example.test',
      ANTHROPIC_SMALL_FAST_MODEL: 'provider/haiku-small',
      UNRELATED_SECRET: 'do-not-import',
    },
  }), 'utf8')
  const env = { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_AUTH_TOKEN: 'explicit-token' }
  try {
    const settings = readClaudeUserSettings(env)
    assert.deepEqual(settings, {
      turnEnv: {},
      turnSettings: {},
      coreEnv: {
        ANTHROPIC_AUTH_TOKEN: 'settings-token',
        ANTHROPIC_BASE_URL: 'https://provider.example.test',
        ANTHROPIC_SMALL_FAST_MODEL: 'provider/haiku-small',
      },
      defaultModel: 'provider/opus-large',
      defaultFastModel: 'provider/haiku-small',
      prefersLocalDefault: true,
    })
    const merged = withClaudeUserSettingsEnv(env)
    assert.equal(merged.ANTHROPIC_AUTH_TOKEN, 'explicit-token')
    assert.equal(merged.ANTHROPIC_BASE_URL, 'https://provider.example.test')
    assert.equal(merged.UNRELATED_SECRET, undefined)

    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('claude', '/fixture/claude', true, env)
    assert.equal(catalog.defaultModel, 'provider/opus-large')
    assert.equal(catalog.defaultFastModel, 'provider/haiku-small')
    assert.equal(catalog.prefersLocalDefault, true)
    assert.equal(catalog.source, 'cli')
    assert.equal(catalog.trustedModels, true)
    assert.deepEqual(catalog.models.map((model) => model.id), [
      'provider/opus-large',
      'provider/haiku-small',
    ])
    assert.doesNotMatch(JSON.stringify(catalog), /settings-token|provider\.example\.test/)

    const modern = await discoverEngineModelCatalog('claude', '/fixture/claude', true, {
      ...env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider/current-haiku',
    })
    assert.equal(modern.defaultFastModel, 'provider/current-haiku')
    assert.equal(modern.models.some(model => model.id === 'provider/current-haiku'), true)
    assert.equal('turnSettings' in modern, false)
    assert.equal('turnEnv' in modern, false)
  } finally {
    clearModelCatalogCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('Claude settings ignore a relative config-root override instead of reading from cwd', () => {
  assert.deepEqual(readClaudeUserSettings({ CLAUDE_CONFIG_DIR: 'relative/config' }), {
    coreEnv: {},
    turnEnv: {},
    turnSettings: {},
    defaultModel: null,
    defaultFastModel: null,
    prefersLocalDefault: false,
  })
})

test('Antigravity catalog parses tab-separated models, ignores fetching banner, and marks recommendations', () => {
  const output = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
    'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  ].join('\n')

  const out = parseListedModels(output, 'antigravity')
  assert.deepEqual(out, [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: null, recommendedFor: ['small'] },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)', description: null, recommendedFor: ['big'] },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)', description: null, recommendedFor: ['big'] },
  ])
})

// ─── a failing CLI is not a catalog ─────────────────────────────────────────
//
// `runText` folds stderr into stdout and ignores the exit status, so whatever a
// CLI printed instead of a model list lands in the parser. The exit status
// would not have caught it either: measured against a real cursor-agent, an
// account with nothing provisioned prints a sentence and exits 0.

test('Cursor catalog does not turn "no models" prose into a model', () => {
  // Verbatim from `cursor-agent models` on an account with nothing provisioned
  // (exit code 0). This used to parse to a model with the id "No".
  assert.deepEqual(parseListedModels('No models available for this account.\n', 'cursor'), [])
})

test('Antigravity catalog does not turn an error into a model', () => {
  const output = [
    'Error: not authenticated. Run `antigravity login`.',
    'Failed to fetch models: connect ETIMEDOUT',
  ].join('\n')
  assert.deepEqual(parseListedModels(output, 'antigravity'), [])
})

test('a model id is the whole column, so prose cannot be one', () => {
  // The rule carries no vendor's error wording on purpose — the next CLI's
  // phrasing, in a locale we have never seen, fails the same test.
  assert.deepEqual(parseListedModels('Es sind keine Modelle verfügbar.', 'cursor'), [])
  assert.deepEqual(parseListedModels('该账户没有可用的模型', 'cursor'), [])
  // …while a genuine id still parses, bare word or not.
  assert.deepEqual(parseListedModels('auto\ngpt-5.5\n', 'cursor').map((m) => m.id), ['auto', 'gpt-5.5'])
})

test('Antigravity catalog reads space-aligned columns, not just tabs', () => {
  // A column separator is a tab OR a run of 2+ spaces; a sentence uses single
  // spaces. Reading the wider separator means the label is the label rather
  // than the whole line repeated.
  assert.deepEqual(parseListedModels('gemini-3.8-flash-high   Gemini 3.8 Flash (High)', 'antigravity'), [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', description: null, recommendedFor: ['small'] },
  ])
})

async function stubEngineCli(name: string, stdout: string): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `cumora-${name}-catalog-`))
  const bin = join(root, name)
  await writeFile(bin, `#!/bin/sh\necho ${JSON.stringify(stdout)}\nexit 0\n`, { mode: 0o755 })
  return { bin, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** A codex stand-in that answers `model/list` with exactly `rows`. Cross-platform,
 *  because the shell-script stub above only actually runs on POSIX. */
async function stubCodexListing(rows: Array<Record<string, unknown>>): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-listing-'))
  const script = join(root, 'catalog.cjs')
  const bin = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  await writeFile(script, `
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (msg.id) process.stdout.write(JSON.stringify({ id: msg.id, result: msg.method === 'model/list' ? { data: ${JSON.stringify(rows)} } : {} }) + '\\n')
})
`)
  await writeFile(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0catalog.cjs" %*\r\n`
    : `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 })
  return { bin, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('a provider that lists one model offers only that model, not the preset tail', async () => {
  // The review case: a gateway account returns a single model. The preset used
  // to be appended behind the real listing, so the picker offered six
  // antigravity ids the account cannot run — each marked "Recommended", each
  // selectable as a computer default that every inheriting Agent would fail on.
  const { bin, cleanup } = await stubCodexListing([{ model: 'gateway/only-model', displayName: 'Only Model', isDefault: true }])
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('codex', bin, true)
    assert.equal(catalog.source, 'protocol')
    assert.equal(catalog.trustedModels, true, 'a listing this build produced is vouched for')
    assert.deepEqual(catalog.models.map((model) => model.id), ['gateway/only-model'])
    // The preset's fast default is `gpt-5.4-mini`, which this account never
    // listed, so the hint must not promise it either.
    assert.equal(catalog.defaultFastModel, null)
  } finally {
    clearModelCatalogCache()
    await cleanup()
  }
})

test('a listing keeps the preset fast default only when the account listed it', async () => {
  const { bin, cleanup } = await stubCodexListing([{ model: 'gpt-5.4-mini' }, { model: 'gpt-5.6-sol', isDefault: true }])
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('codex', bin, true)
    assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-5.4-mini', 'gpt-5.6-sol'])
    assert.equal(catalog.defaultFastModel, 'gpt-5.4-mini')
  } finally {
    clearModelCatalogCache()
    await cleanup()
  }
})

test('native Codex pagination retains a failed refresh and clears a successful empty listing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-paged-'))
  const state = join(root, 'state.json')
  const script = join(root, 'catalog.cjs')
  const bin = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex')
  await writeFile(script, `
const fs = require('node:fs')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  if (!msg.id) return
  let response = { result: {} }
  if (msg.method === 'model/list') {
    const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'))
    response = state.fail ? { error: { message: 'offline' } } : { result: state.empty ? { data: [] } :
      msg.params.cursor ? { data: [{ model: 'auto/second', displayName: 'Second' }] } :
      { data: [{ model: 'auto/first', isDefault: true }], nextCursor: 'second-page' } }
  }
  process.stdout.write(JSON.stringify({ id: msg.id, ...response }) + '\\n')
})
`)
  await writeFile(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0catalog.cjs" %*\r\n`
    : `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 })
  try {
    await writeFile(state, '{}')
    const listed = await discoverEngineModelCatalog('codex', bin, true)
    assert.deepEqual(listed.models.map(model => model.id), ['auto/first', 'auto/second'])
    await writeFile(state, '{"fail":true}')
    const failed = await discoverEngineModelCatalog('codex', bin, true)
    assert.equal(failed.stale, true)
    assert.deepEqual(failed.models, listed.models)
    await writeFile(state, '{"empty":true}')
    const empty = await discoverEngineModelCatalog('codex', bin, true)
    assert.equal(empty.stale, undefined)
    assert.equal(empty.trustedModels, true)
    assert.deepEqual(empty.models, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a CLI that listed nothing offers nothing, not a model named after its excuse', async () => {
  // End to end through the real dispatch. Cursor has no preset — cumora takes
  // its whole catalog from the CLI — so before the fix the picker's only entry
  // was "No", and picking it would have run `--model No`.
  const { bin, cleanup } = await stubEngineCli('cursor-agent', 'No models available for this account.')
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('cursor', bin, true)
    assert.deepEqual(catalog.models, [])
    assert.equal(catalog.source, 'presets', 'a CLI that listed nothing was treated as having listed models')
  } finally {
    clearModelCatalogCache()
    await cleanup()
  }
})

test('an engine with a preset keeps it when its CLI fails to list', async () => {
  // Discovered models are merged AHEAD of the preset, so a parsed error line
  // does not just add noise — it takes the top of the picker and drops the
  // engine's real default.
  const { bin, cleanup } = await stubEngineCli('antigravity', 'Error: not authenticated. Run antigravity login.')
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('antigravity', bin, true)
    assert.equal(catalog.source, 'presets')
    assert.equal(catalog.models[0]?.id, 'gemini-3.8-flash-high')
    assert.equal(catalog.models.some((model) => /^Error/.test(model.id)), false)
    // A fallback is not a listing: without this flag the app withholds the rows.
    assert.equal(catalog.trustedModels, undefined)
  } finally {
    clearModelCatalogCache()
    await cleanup()
  }
})

/** Cross-platform omp stand-in: the binary prints `payload` whatever the argv,
 *  which is all discovery reads. */
async function stubOmpListing(payload: string): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-omp-listing-'))
  const script = join(root, 'models.mjs')
  const bin = join(root, process.platform === 'win32' ? 'omp.cmd' : 'omp')
  await writeFile(script, `process.stdout.write(${JSON.stringify(payload)})\n`)
  await writeFile(bin, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "%~dp0models.mjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 })
  return { bin, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('omp catalog keys rows on the provider-qualified selector and drops non-chat entries', async () => {
  // The bare `id` is provider-relative; pinning it silently no-ops, so a parser
  // that takes `id` would produce a picker whose every choice does nothing.
  const payload = JSON.stringify({
    models: [
      { provider: 'magpie', kind: 'chat', id: 'auto/dfmodel', selector: 'magpie/auto/dfmodel', name: 'magpie/auto/dfmodel' },
      { provider: 'deepseek', kind: 'chat', id: 'deepseek-v4-flash', selector: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'openai', kind: 'embedding', id: 'embed', selector: 'openai/embed', name: 'Embeddings' },
      { provider: 'deepseek', kind: 'chat', id: 'deepseek-v4-flash', selector: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
  })
  assert.deepEqual(parseOmpModels(payload), [
    { id: 'magpie/auto/dfmodel', label: 'magpie/auto/dfmodel', description: null, recommendedFor: undefined },
    { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: null, recommendedFor: undefined },
  ])

  const { bin, cleanup } = await stubOmpListing(payload)
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('omp', bin, true)
    assert.equal(catalog.source, 'cli')
    assert.equal(catalog.trustedModels, true)
    assert.equal(catalog.supportsCustom, true)
    assert.equal(catalog.fastModelScope, 'agent')
    assert.deepEqual(catalog.models.map((model) => model.id), ['magpie/auto/dfmodel', 'deepseek/deepseek-v4-flash'])
  } finally {
    clearModelCatalogCache()
    await cleanup()
  }
})

test('omp discovery falls back to its preset on an empty or non-JSON listing', async () => {
  for (const payload of ['{"models":[]}', 'not json at all', '']) {
    const { bin, cleanup } = await stubOmpListing(payload)
    try {
      clearModelCatalogCache()
      const catalog = await discoverEngineModelCatalog('omp', bin, true)
      assert.equal(catalog.source, 'presets', payload)
      assert.deepEqual(catalog.models, [], payload)
      assert.equal(catalog.trustedModels, undefined, payload)
    } finally {
      clearModelCatalogCache()
      await cleanup()
    }
  }
})


test('Kimi configOptions expose only model metadata and preserve the local default', () => {
  const parsed = parseKimiConfigOptions([
    { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto' }] },
    {
      id: 'model', currentValue: 'provider/current',
      options: [
        { value: 'provider/current', name: 'Current model', description: 'Default route', apiKey: 'never-return' },
        { value: 'provider/other', name: 'Other model', headers: { Authorization: 'never-return' } },
        { value: 'provider/current', name: 'Duplicate id with a different label' },
        { name: 'Missing an executable id' },
      ],
    },
  ])
  assert.equal(parsed.defaultModel, 'provider/current')
  assert.deepEqual(parsed.models, [
    { id: 'provider/current', label: 'Current model', description: 'Default route', recommendedFor: undefined, supportsFastMode: false },
    { id: 'provider/other', label: 'Other model', description: null, recommendedFor: undefined, supportsFastMode: false },
  ])
  assert.equal(JSON.stringify(parsed).includes('never-return'), false)
})

test('Kimi ACP catalog discovery initializes, reads, and deletes an empty session without prompting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-kimi-catalog-'))
  const script = join(root, 'catalog.mjs')
  const log = join(root, 'calls.jsonl')
  const configOptions = [
    { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto' }] },
    {
      id: 'model', currentValue: 'provider/current',
      options: [
        { value: 'provider/current', name: 'Current model', apiKey: 'never-return' },
        { value: 'provider/other', name: 'Other model', description: 'Alternate route' },
      ],
    },
  ]
  await writeFile(script, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const argv = process.argv.slice(2)
if (JSON.stringify(argv) !== JSON.stringify(['acp'])) process.exit(2)
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(msg) + '\\n')
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  if (msg.method === 'initialize') reply({ protocolVersion: 1 })
  else if (msg.method === 'session/new') reply({ sessionId: 'catalog-session', configOptions: ${JSON.stringify(configOptions)} })
  else if (msg.method === 'session/delete') reply({})
  else if (msg.method === 'session/prompt') process.exit(19)
})
`)
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('kimi', script, true, { ...process.env })
    assert.equal(catalog.source, 'protocol')
    assert.equal(catalog.trustedModels, true)
    assert.equal(catalog.defaultModel, 'provider/current')
    assert.equal(catalog.defaultFastModel, null)
    assert.equal(catalog.prefersLocalDefault, true)
    assert.equal(catalog.supportsCustom, true)
    assert.deepEqual(catalog.models.map((model) => model.id), ['provider/current', 'provider/other'])
    assert.equal(JSON.stringify(catalog).includes('never-return'), false)
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(calls.map((call) => call.method), ['initialize', 'session/new', 'session/delete'])
    assert.equal(calls.some((call) => call.method === 'session/prompt'), false)
  } finally {
    clearModelCatalogCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('Kimi catalog failure is stale and untrusted rather than a fabricated listing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-kimi-catalog-missing-'))
  try {
    const catalog = await discoverEngineModelCatalog('kimi', join(root, 'missing-kimi.mjs'), true, { ...process.env })
    assert.equal(catalog.source, 'presets')
    assert.equal(catalog.stale, true)
    assert.equal(catalog.trustedModels, undefined)
    assert.deepEqual(catalog.models, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Kimi catalog without a current model leaves the deploy fallback available', async () => {
  const peer = await stubKimiPeer(`
  if (msg.method === 'initialize') reply({ protocolVersion: 1 })
  else if (msg.method === 'session/new') reply({ sessionId: 'no-default', configOptions: [{ id: 'model', options: [{ value: 'provider/other', name: 'Other model' }] }] })
  else if (msg.method === 'session/delete') reply({})
  `)
  try {
    clearModelCatalogCache()
    const catalog = await discoverEngineModelCatalog('kimi', peer.script, true, { ...process.env })
    assert.equal(catalog.defaultModel, null)
    assert.equal(catalog.prefersLocalDefault, false)
  } finally {
    clearModelCatalogCache()
    await peer.cleanup()
  }
})


async function stubKimiPeer(handler: string): Promise<{ script: string; exitLog: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-kimi-peer-'))
  const script = join(root, 'peer.mjs')
  const exitLog = join(root, 'exit')
  await writeFile(script, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
process.on('exit', () => appendFileSync(${JSON.stringify(exitLog)}, String(process.pid)))
createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line)
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  ${handler}
})
`)
  return { script, exitLog, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function waitForPeerExit(exitLog: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await readFile(exitLog, 'utf8')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await delay(20)
    }
  }
  assert.fail('Kimi ACP child was not reaped')
}

function assertStaleKimiFailure(catalog: Awaited<ReturnType<typeof discoverEngineModelCatalog>>): void {
  assert.equal(catalog.source, 'presets')
  assert.equal(catalog.stale, true)
  assert.equal(catalog.trustedModels, undefined)
  assert.deepEqual(catalog.models, [])
}

test('Kimi silent-peer timeout fails stale and untrusted and reaps the child', async () => {
  const { script, exitLog, cleanup } = await stubKimiPeer('')
  try {
    const catalog = await discoverEngineModelCatalog('kimi', script, true, { ...process.env }, { kimiTimeoutMs: 30 })
    assertStaleKimiFailure(catalog)
    await waitForPeerExit(exitLog)
  } finally {
    await cleanup()
  }
})

test('Kimi output overflow fails stale and untrusted and reaps the child', async () => {
  const { script, exitLog, cleanup } = await stubKimiPeer(`
if (msg.method === 'initialize') process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1))
`)
  try {
    const catalog = await discoverEngineModelCatalog('kimi', script, true, { ...process.env }, { kimiTimeoutMs: 1_000 })
    assertStaleKimiFailure(catalog)
    await waitForPeerExit(exitLog)
  } finally {
    await cleanup()
  }
})

test('Kimi death during discovery fails stale and untrusted without an uncaught stdin error', async () => {
  const { script, exitLog, cleanup } = await stubKimiPeer(`
if (msg.method === 'initialize') {
  reply({ protocolVersion: 1 })
  setTimeout(() => process.exit(17), 5)
}
`)
  try {
    const catalog = await discoverEngineModelCatalog('kimi', script, true, { ...process.env }, { kimiTimeoutMs: 1_000 })
    assertStaleKimiFailure(catalog)
    await waitForPeerExit(exitLog)
    await delay(25)
  } finally {
    await cleanup()
  }
})

test('Kimi death after valid metadata leaves the trusted catalog intact', async () => {
  const configOptions = [{
    id: 'model', currentValue: 'provider/current',
    options: [{ value: 'provider/current', name: 'Current model' }],
  }]
  const { script, exitLog, cleanup } = await stubKimiPeer(`
if (msg.method === 'initialize') reply({ protocolVersion: 1 })
else if (msg.method === 'session/new') reply({ sessionId: 'catalog-session', configOptions: ${JSON.stringify(configOptions)} })
else if (msg.method === 'session/delete') process.exit(0)
`)
  try {
    const catalog = await discoverEngineModelCatalog('kimi', script, true, { ...process.env }, { kimiTimeoutMs: 1_000 })
    assert.equal(catalog.source, 'protocol')
    assert.equal(catalog.stale, undefined)
    assert.equal(catalog.trustedModels, true)
    assert.equal(catalog.defaultModel, 'provider/current')
    assert.deepEqual(catalog.models.map(model => model.id), ['provider/current'])
    await waitForPeerExit(exitLog)
  } finally {
    await cleanup()
  }
})
