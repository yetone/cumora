import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { AgentRunner } from '../agents/computer/daemon.js'
import { withClaudeUserSettingsEnv } from '../agents/computer/claude-user-settings.js'
import {
  type ProviderProfile, parseProviderProfiles, providerProfileEnv, providerProfileFingerprint,
  providerProfileMetadata, readProviderProfiles, redactProviderSecret, sanitizeProviderProfiles,
} from '../agents/computer/provider-profiles.js'

const profile: ProviderProfile = {
  id: 'work', label: 'Work', baseUrl: 'https://work.example.test',
  model: 'work/reasoning', fastModel: 'work/fast', auth: { apiKey: 'fixture-work-secret' },
}
const config = (profiles: unknown[] = [profile]) => ({ version: 1, profiles })

test('profile parsing rejects ambiguous auth, duplicate ids and unsafe URLs without logging secrets', () => {
  assert.deepEqual(parseProviderProfiles(config()), [profile])
  for (const invalid of [
    { ...profile, id: '../work' },
    { ...profile, auth: {} },
    { ...profile, auth: { apiKey: 'secret', authToken: 'secret' } },
    { ...profile, baseUrl: 'http://remote.example.test' },
    { ...profile, baseUrl: 'https://user:secret@work.example.test' },
    { ...profile, baseUrl: 'https://work.example.test?key=secret' },
    { ...profile, fastModel: '' },
  ]) {
    assert.throws(() => parseProviderProfiles(config([invalid])), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.doesNotMatch(err.message, /fixture-work-secret|user:secret|key=secret/)
      return true
    })
  }
  assert.throws(() => parseProviderProfiles(config([profile, profile])))
  assert.throws(() => parseProviderProfiles({ version: 2, profiles: [] }))
  assert.equal(parseProviderProfiles(config([{ ...profile, baseUrl: 'http://127.0.0.1:8080/' }]))[0].baseUrl, 'http://127.0.0.1:8080')
})

test('local file loading checks permissions, rejects symlinks and fails closed on corruption', () => {
  const root = mkdtempSync(join(tmpdir(), 'cumora-profiles-'))
  const file = join(root, 'providers.json')
  try {
    assert.deepEqual(readProviderProfiles(file), [])
    writeFileSync(file, JSON.stringify(config()), { mode: 0o600 })
    assert.deepEqual(readProviderProfiles(file), [profile])
    if (process.platform !== 'win32') {
      chmodSync(file, 0o644)
      assert.throws(() => readProviderProfiles(file), /0600/)
      chmodSync(file, 0o600)
      symlinkSync(file, join(root, 'linked.json'))
      assert.throws(() => readProviderProfiles(join(root, 'linked.json')), /regular local file/)
    }
    writeFileSync(file, '{"secret": "fixture-work-secret",')
    assert.throws(() => readProviderProfiles(file), /not valid JSON/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('discovery metadata is an explicit public projection', () => {
  const metadata = providerProfileMetadata(profile)
  assert.deepEqual(Object.keys(metadata).sort(), ['fastModel', 'id', 'label', 'model'])
  assert.deepEqual(sanitizeProviderProfiles([profile]), [metadata])
  assert.doesNotMatch(JSON.stringify(metadata), /fixture-work-secret|baseUrl|auth/)
})

test('profile environments cannot borrow host credentials, aliases or global model overrides', () => {
  const ambient = {
    ANTHROPIC_API_KEY: 'host-api-key', ANTHROPIC_AUTH_TOKEN: 'host-token',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'host-opus', CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth',
    CUMORA_TRIAGE_MODEL: 'host-fast', CUMORA_ENGINE_MODEL: 'host-big',
    CLAUDE_CONFIG_DIR: '/nonexistent-cumora-fixture',
  }
  const env = providerProfileEnv(ambient, profile)
  const other = providerProfileEnv(ambient, { ...profile, auth: { authToken: 'other-token' } })
  assert.equal(env.ANTHROPIC_API_KEY, 'fixture-work-secret')
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, '')
  assert.equal(other.ANTHROPIC_API_KEY, '')
  assert.equal(other.ANTHROPIC_AUTH_TOKEN, 'other-token')
  assert.equal(ambient.ANTHROPIC_API_KEY, 'host-api-key')
  for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CUMORA_TRIAGE_MODEL']) {
    assert.equal(env[key as keyof typeof env], '')
  }
  assert.deepEqual(withClaudeUserSettingsEnv(env), env)
  assert.throws(() => providerProfileEnv({ CUMORA_BYOA_ALLOW_UNSANDBOXED: '1' }, profile), /secure BYOA/)
})

test('provider runtime identity separates sessions and restarts only when runtime configuration changes', () => {
  const agent = { id: 'profile-fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'claude' as const, model: null, fastModel: null, providerProfile: profile.id }
  const cfg = { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' }
  const first = new AgentRunner(cfg, agent, 'claude', profile)
  assert.equal(first.configMatches(agent, 'claude', { ...profile, label: 'Renamed' }), true)
  assert.equal(first.configMatches(agent, 'claude'), false)
  const changed = { ...profile, auth: { apiKey: 'rotated-key' } }
  assert.equal(first.configMatches(agent, 'claude', changed), false)
  assert.notEqual(providerProfileFingerprint(profile), providerProfileFingerprint({ ...profile, baseUrl: 'https://other.example.test' }))
  type RunnerInternals = { sessionFile: string; engineModel(): string | null; engineFastModel(): string | null; triageModelPin(): string | undefined; visibleEngineError(code: number, detail: string): string }
  const a = first as unknown as RunnerInternals
  const b = new AgentRunner(cfg, agent, 'claude', changed) as unknown as RunnerInternals
  const legacy = new AgentRunner(cfg, { ...agent, providerProfile: null }, 'claude') as unknown as RunnerInternals
  assert.notEqual(a.sessionFile, b.sessionFile)
  assert.notEqual(a.sessionFile, legacy.sessionFile)
  assert.equal(basename(legacy.sessionFile), 'profile-fixture.session')
  assert.equal(a.engineModel(), profile.model)
  assert.equal(a.engineFastModel(), profile.fastModel)
  assert.equal(a.triageModelPin(), profile.fastModel)
  assert.doesNotMatch(a.visibleEngineError(1, 'auth failed: fixture-work-secret'), /fixture-work-secret/)
  assert.equal(redactProviderSecret('fixture-work-secret / fixture-work-secret', profile), '[redacted] / [redacted]')
})


test('runner replacement waits for in-flight triage and cannot respawn a stopped persistent session', async () => {
  const runner = new AgentRunner(
    { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' },
    { id: 'fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'claude', model: null, fastModel: null },
    'claude', profile,
  )
  let finish!: () => void
  const internals = runner as unknown as {
    activeTriage: Promise<unknown> | null; teardown: AbortController; ensureEngineSession(): unknown
  }
  internals.activeTriage = new Promise<void>((resolve) => { finish = resolve })
  let stopped = false
  const stopping = runner.stop({ forceEngine: true }).then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(internals.teardown.signal.aborted, true)
  assert.equal(stopped, false, 'the replacement must not start while old triage is alive')
  assert.equal(internals.ensureEngineSession(), null)
  finish()
  await stopping
  assert.equal(stopped, true)
})
