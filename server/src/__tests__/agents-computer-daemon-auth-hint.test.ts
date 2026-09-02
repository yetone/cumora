import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authFailureHint } from '../agents/computer/daemon.js'
import { ENGINE_IDS, type EngineId } from '../agents/computer/engine.js'

test('authFailureHint provides specific guidance for every supported engine', () => {
  for (const engine of ENGINE_IDS) {
    const hint = authFailureHint(engine as EngineId, '401 invalid api key or unauthorized')
    assert.ok(hint.length > 0, `hint for ${engine} should not be empty`)
    // None of the non-codex engines should mention Codex
    if (engine !== 'codex') {
      assert.ok(!hint.includes('Open Codex'), `hint for ${engine} should not tell the user to Open Codex: "${hint}"`)
    }
  }
})

test('authFailureHint correctly mentions the relevant CLI/tool for each engine', () => {
  assert.match(authFailureHint('claude', 'quota exceeded'), /Claude Code/)
  assert.match(authFailureHint('codex', 'quota exceeded'), /Codex/)
  assert.match(authFailureHint('grok', 'quota exceeded'), /grok/)
  assert.match(authFailureHint('cursor', 'quota exceeded'), /cursor-agent/)
  assert.match(authFailureHint('opencode', 'quota exceeded'), /opencode/)
  assert.match(authFailureHint('pi', 'quota exceeded'), /pi/)
  assert.match(authFailureHint('gemini', 'quota exceeded'), /gemini/)
  assert.match(authFailureHint('qwen', 'quota exceeded'), /qwen/)
  assert.match(authFailureHint('antigravity', 'quota exceeded'), /agy/)
})

test('authFailureHint handles context overflow and poisoned body sentinels', () => {
  assert.match(authFailureHint('gemini', 'context window overflowed max tokens'), /context window/)
  assert.match(authFailureHint('qwen', 'lone surrogate split emoji poisoned'), /poisoned/)
  assert.match(authFailureHint('gemini', 'unrelated socket reset error'), /daemon terminal for details/)
})
