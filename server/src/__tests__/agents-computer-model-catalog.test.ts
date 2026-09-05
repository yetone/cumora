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
