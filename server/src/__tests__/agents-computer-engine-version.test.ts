/**
 * Per-engine version reporting for BYOA computers.
 *
 * The Computers card shows what is installed on the *paired* machine, so the
 * numbers have to come from that machine's daemon. These cover the parsing and
 * update-command inference the daemon does locally, plus the server-side
 * validation that stands between a daemon's claim and what the app renders.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine-version.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const {
  parseCliVersion, isCliOutdated, isCliVersionAtLeast, inferUpdateCommand,
  parseCursorAbout, parseGrokCheck, ENGINE_VERSION_SPECS, versionCommandInvocation,
} = await import('../agents/computer/cli-version.js')
const { sanitizeDetectedEngines } = await import('../agents/computer/registry.js')

test('parseCliVersion reads the shapes real CLIs print', () => {
  assert.equal(parseCliVersion('1.2.3'), '1.2.3')
  assert.equal(parseCliVersion('claude 1.0.88 (Claude Code)'), '1.0.88')
  assert.equal(parseCliVersion('v2.10.0'), '2.10.0')
  assert.equal(parseCliVersion('codex-cli 0.5.1-alpha.2'), '0.5.1-alpha.2')
  // Some vendors ship CalVer rather than semver.
  assert.equal(parseCliVersion('2026.08.30'), '2026.08.30')
  assert.equal(parseCliVersion('no version here'), null)
  assert.equal(parseCliVersion(''), null)
  assert.equal(parseCliVersion(null), null)
})

test('Windows version probe replaces an extensionless npm shim with its runnable .cmd sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-version-'))
  try {
    const shim = join(root, 'codex')
    await writeFile(shim, '#!/bin/sh\n')
    await writeFile(`${shim}.cmd`, '@echo off\r\necho codex-cli 0.15.1\r\n')
    const comspec = String.raw`C:\Windows\System32\cmd.exe`
    assert.deepEqual(versionCommandInvocation(shim, ['--version'], 'win32', comspec), {
      command: comspec,
      args: ['/d', '/s', '/c', `""${shim}.cmd" --version"`],
      windowsVerbatimArguments: true,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isCliOutdated only fires when upstream is strictly newer', () => {
  assert.equal(isCliOutdated('1.2.3', '1.2.4'), true)
  assert.equal(isCliOutdated('1.2.3', '1.3.0'), true)
  assert.equal(isCliOutdated('1.9.0', '1.10.0'), true, 'compares numerically, not lexically')
  assert.equal(isCliOutdated('1.2.3', '1.2.3'), false)
  assert.equal(isCliOutdated('1.2.4', '1.2.3'), false, 'ahead of the registry is not outdated')
  // Unknown on either side must stay silent rather than nag.
  assert.equal(isCliOutdated(null, '1.2.3'), false)
  assert.equal(isCliOutdated('1.2.3', null), false)
})

test('isCliVersionAtLeast enforces a local security floor', () => {
  assert.equal(isCliVersionAtLeast('2.1.248', '2.1.248'), true)
  assert.equal(isCliVersionAtLeast('2.1.251', '2.1.248'), true)
  assert.equal(isCliVersionAtLeast('2.1.247', '2.1.248'), false)
  assert.equal(isCliVersionAtLeast('2.1.248-beta.1', '2.1.248'), false)
  assert.equal(isCliVersionAtLeast('0.138.0', '0.138.0'), true)
  assert.equal(isCliVersionAtLeast(null, '0.138.0'), false)
})

test('inferUpdateCommand prefers the vendor updater, then brew, then npm', () => {
  // claude has a self-updater, so brew/npm never win even from a brew path.
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.claude, '/opt/homebrew/bin/claude'),
    'claude update',
  )
  // gemini has no self-updater: brew only when it actually came from brew.
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.gemini, '/opt/homebrew/bin/gemini'),
    'brew upgrade gemini-cli',
  )
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.gemini, '/usr/local/bin/gemini'),
    'npm install -g @google/gemini-cli@latest',
  )
  // codex is npm-only.
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.codex, '/usr/local/bin/codex'),
    'npm install -g @openai/codex@latest',
  )
  // pi needs the vendor's documented flag when it falls through to npm.
  assert.equal(inferUpdateCommand({ versionArgs: ['--version'], npm: '@earendil-works/pi-coding-agent', npmFlags: '--ignore-scripts' }, '/usr/local/bin/pi'),
    'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest')
  assert.equal(
    inferUpdateCommand(ENGINE_VERSION_SPECS.antigravity, '/Users/test/.local/bin/agy'),
    'agy update',
  )
})

test('parseCursorAbout / parseGrokCheck read their vendor formats', () => {
  assert.equal(parseCursorAbout('Version 1.0.0\nLatest  1.2.0\n'), '1.2.0')
  assert.equal(parseCursorAbout('Version 1.0.0\n'), null)
  assert.equal(parseGrokCheck('{"latestVersion":"0.4.2"}'), '0.4.2')
  // Not JSON — fall back to scraping a version out of the text.
  assert.equal(parseGrokCheck('grok 0.4.2 available'), '0.4.2')
})

test('sanitizeDetectedEngines carries version fields through', () => {
  const rows = sanitizeDetectedEngines([
    {
      id: 'codex', bin: 'codex', path: '/usr/local/bin/codex',
      version: '0.5.0', latest: '0.6.0', outdated: true,
      updateCommand: 'npm install -g @openai/codex@latest',
    },
  ], ['codex'])
  assert.deepEqual(rows, [{
    id: 'codex', bin: 'codex', path: '/usr/local/bin/codex',
    version: '0.5.0', latest: '0.6.0', outdated: true,
    updateCommand: 'npm install -g @openai/codex@latest',
    blockedReason: null,
  }])
})

test('sanitizeDetectedEngines does not trust a stale outdated flag', () => {
  // A daemon claiming "outdated" while both versions read the same would nag
  // forever; the server can check that itself, so it does.
  const [row] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/x/codex', version: '1.0.0', latest: '1.0.0', outdated: true }],
    ['codex'],
  )
  assert.equal(row?.outdated, false)

  // Same when one side is missing entirely.
  const [noLatest] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/x/codex', version: '1.0.0', outdated: true }],
    ['codex'],
  )
  assert.equal(noLatest?.outdated, false)
  assert.equal(noLatest?.latest, null)
})

test('sanitizeDetectedEngines strips control characters and bounds length', () => {
  const [row] = sanitizeDetectedEngines([{
    id: 'codex', bin: 'codex', path: '/x/codex',
    version: '1.0.0', latest: '2.0.0',
    outdated: true,
    // A newline here would turn a copyable one-liner into a two-command script.
    updateCommand: 'npm i -g @openai/codex\nrm -rf /',
  }], ['codex'])
  assert.ok(!row?.updateCommand?.includes('\n'))
  assert.equal(row?.updateCommand, 'npm i -g @openai/codex rm -rf /')

  const [long] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/x/codex', version: 'v'.repeat(500) }],
    ['codex'],
  )
  assert.equal(long?.version?.length, 64)
})

test('sanitizeDetectedEngines tolerates a daemon too old to report versions', () => {
  // Pre-probe daemons send {id,bin,path}. Rendering the path alone is correct;
  // inventing a version would be worse than showing none.
  const [row] = sanitizeDetectedEngines(
    [{ id: 'codex', bin: 'codex', path: '/usr/local/bin/codex' }],
    ['codex'],
  )
  assert.equal(row?.version, null)
  assert.equal(row?.latest, null)
  assert.equal(row?.outdated, false)
  assert.equal(row?.updateCommand, null)
})

test('sanitizeDetectedEngines bounds and cleans account-specific model catalogs', () => {
  const [row] = sanitizeDetectedEngines([{
    id: 'codex', bin: 'codex', path: '/usr/local/bin/codex',
    modelCatalog: {
      source: 'protocol', supportsCustom: true, fastModelScope: 'agent',
      defaultModel: 'gpt-5.6-sol', defaultFastModel: 'gpt-5.4-mini',
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol\nspoof', recommendedFor: ['big', 'bogus'] },
        { id: 'gpt-5.6-sol', label: 'duplicate' },
        { id: '', label: 'empty' },
      ],
    },
  }], ['codex'])
  assert.deepEqual(row?.modelCatalog, {
    source: 'protocol', supportsCustom: true, fastModelScope: 'agent',
    defaultModel: 'gpt-5.6-sol', defaultFastModel: 'gpt-5.4-mini',
    models: [{
      id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol spoof', description: null, recommendedFor: ['big'],
    }],
  })
})
