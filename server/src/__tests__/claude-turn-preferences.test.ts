import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readClaudeUserSettings } from '../agents/computer/claude-user-settings.js'

test('Claude preference import validates nested settings and never forwards arbitrary configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-turn-preferences-'))
  try {
    const file = join(root, 'settings.json')
    await writeFile(file, JSON.stringify({
      effortLevel: 'xhigh', alwaysThinkingEnabled: false, language: 'Chinese',
      modelSettings: {
        'claude-opus-5': { effortLevel: 'high', hooks: { bad: true } },
        'claude-sonnet-5': { effortLevel: 'max' },
        'invalid': 'xhigh',
      },
      hooks: { bad: true }, outputStyle: 'untrusted-style', fastMode: true,
      env: {
        CLAUDE_CODE_EFFORT_LEVEL: 'max', MAX_THINKING_TOKENS: '4096',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384', CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
        CLAUDE_CODE_DISABLE_THINKING: '0', NODE_OPTIONS: '--require bad.js',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'provider/sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider/haiku',
      },
    }))
    const read = () => readClaudeUserSettings({ CLAUDE_CONFIG_DIR: root })
    assert.deepEqual(read().turnSettings, {
      effortLevel: 'xhigh', alwaysThinkingEnabled: false, language: 'Chinese',
      modelSettings: { 'claude-opus-5': { effortLevel: 'high' } },
    })
    assert.deepEqual(read().turnEnv, {
      CLAUDE_CODE_EFFORT_LEVEL: 'max', MAX_THINKING_TOKENS: '4096',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16384', CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
      CLAUDE_CODE_DISABLE_THINKING: '0',
    })
    assert.deepEqual(read().coreEnv, {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'provider/sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider/haiku',
    })
    await writeFile(file, JSON.stringify({
      effortLevel: 'max', alwaysThinkingEnabled: 'true', language: [], modelSettings: [],
      env: { CLAUDE_CODE_EFFORT_LEVEL: '--bad', MAX_THINKING_TOKENS: '-1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '0', CLAUDE_CODE_DISABLE_THINKING: {} },
    }))
    assert.deepEqual(read().turnSettings, {})
    assert.deepEqual(read().turnEnv, {})
    await writeFile(file, '{bad json')
    assert.deepEqual(read().turnSettings, {})
    assert.deepEqual(read().turnEnv, {})
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
