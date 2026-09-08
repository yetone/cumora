/**
 * Generic BYOA model-catalog parsing.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-model-catalog.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaudeUserSettings, withClaudeUserSettingsEnv } from '../agents/computer/claude-user-settings.js'
import { clearModelCatalogCache, discoverEngineModelCatalog, parseListedModels } from '../agents/computer/model-catalog.js'

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
  } finally {
    clearModelCatalogCache()
    await cleanup()
  }
})
