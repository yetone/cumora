/**
 * Anthropic's own base URL is not a custom provider.
 *
 * Three places asked "is ANTHROPIC_BASE_URL set?" and treated yes as "a custom
 * endpoint owns the model namespace":
 *
 *   engine.ts        omit `--model haiku` from the triage spawn
 *   model-catalog.ts drop the opus/sonnet/haiku presets and defaultFastModel
 *   registry.ts      via prefersLocalDefault, drop the deploy-level model pin
 *
 * But Claude Code exports ANTHROPIC_BASE_URL into every process it spawns,
 * pointing at Anthropic's own endpoint. So a first-party account with no
 * settings.json at all took the custom-provider branch on cumora's flagship
 * engine, purely because the daemon was started from a Claude Code session —
 * or from any shell that exports the variable.
 *
 * Measured before the fix, with CLAUDE_CONFIG_DIR pointing at an empty dir:
 *
 *   without the variable   models=opus,sonnet,haiku  defaultFastModel=haiku
 *   ANTHROPIC_BASE_URL=https://api.anthropic.com
 *                          models=(none)             defaultFastModel=null
 *
 * The model picker empties and triage silently leaves Haiku for the account's
 * default big model — on the highest-frequency call an agent makes.
 *
 * Run: node --import tsx --test server/src/__tests__/claude-first-party-endpoint.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { isCustomAnthropicEndpoint } = await import('../agents/computer/claude-user-settings.js')
const { discoverEngineModelCatalog } = await import('../agents/computer/model-catalog.js')

// ── the predicate ──────────────────────────────────────────────────────────

test("Anthropic's own endpoint is not custom, however it is written", () => {
  for (const url of [
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'https://api.anthropic.com/v1',
    '  https://API.Anthropic.COM/v1/  ',
  ]) {
    assert.equal(isCustomAnthropicEndpoint(url), false, url)
  }
})

test('an absent or blank value is not custom', () => {
  for (const url of [undefined, null, '', '   ']) {
    assert.equal(isCustomAnthropicEndpoint(url), false, JSON.stringify(url))
  }
})

test('anything else is custom', () => {
  for (const url of [
    'https://provider.example.test',
    'http://localhost:8080',
    'https://anthropic.com.evil.test',      // suffix trick must not read as first-party
    'https://not-api.anthropic.com.co',
  ]) {
    assert.equal(isCustomAnthropicEndpoint(url), true, url)
  }
})

test('an unparseable value is treated as custom', () => {
  // We cannot vouch for it as first-party, and the conservative answer is to
  // stop claiming Anthropic's aliases exist behind it.
  assert.equal(isCustomAnthropicEndpoint('not a url'), true)
  assert.equal(isCustomAnthropicEndpoint('api.anthropic.com'), true) // no scheme → not parseable
})

// ── what that means for the catalog the editor renders ─────────────────────

const EMPTY_CONFIG = { CLAUDE_CONFIG_DIR: '/nonexistent-claude-config-for-tests' }

test('a first-party account keeps its presets when the variable is set', async () => {
  const catalog = await discoverEngineModelCatalog('claude', '/usr/local/bin/claude', true, {
    ...EMPTY_CONFIG,
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  })
  assert.deepEqual(catalog.models.map((m) => m.id), ['opus', 'sonnet', 'haiku'])
  assert.equal(catalog.defaultFastModel, 'haiku')
  assert.notEqual(catalog.prefersLocalDefault, true)
})

test('and is identical to having no variable at all', async () => {
  const withVar = await discoverEngineModelCatalog('claude', '/usr/local/bin/claude', true, {
    ...EMPTY_CONFIG, ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  })
  const without = await discoverEngineModelCatalog('claude', '/usr/local/bin/claude', true, {
    ...EMPTY_CONFIG,
  })
  assert.deepEqual(withVar.models, without.models)
  assert.equal(withVar.defaultFastModel, without.defaultFastModel)
})

test('a real custom endpoint still owns its namespace', async () => {
  // The behaviour this branch exists for must be untouched: claiming Anthropic's
  // aliases exist on someone else's endpoint is the thing it prevents.
  const catalog = await discoverEngineModelCatalog('claude', '/usr/local/bin/claude', true, {
    ...EMPTY_CONFIG,
    ANTHROPIC_BASE_URL: 'https://provider.example.test',
  })
  assert.deepEqual(catalog.models, [])
  assert.equal(catalog.defaultFastModel, null)
  assert.equal(catalog.prefersLocalDefault, true)
})
