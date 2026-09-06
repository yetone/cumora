/**
 * Tests for Issue #209:
 * BYOA engine hot-switch reuses Codex session IDs in Claude, causing an infinite resume failure loop.
 *
 * Verifies:
 * 1. Session files are strictly scoped per engine: `<agentId>.<engine>.session`
 * 2. AgentRunner methods loadSessionId/persistSessionId isolate session state across engine switches
 * 3. AgentRunner.loadSessionId safely purges legacy unscoped session files (`<agentId>.session`)
 * 4. isStaleResumeError accurately detects unmasked Claude resume errors
 * 5. AgentRunner.mustResetSession distinguishes stale resumes from fresh runs and context overflows
 * 6. AgentRunner.runEngineTurn retries once with resumeSessionId: null on stale-resume error and succeeds
 * 7. AgentRunner.runEngineTurn never retries a turn that reported model usage (preventing duplicate side effects)
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-session-isolation.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentRunner,
  type AgentInfo,
  type DaemonConfig,
  hasNonZeroUsage,
  isStaleResumeError,
  sessionFileFor,
  SESSIONS_DIR,
} from '../agents/computer/daemon.js'
import type { EngineRunResult } from '../agents/computer/engine.js'

function makeConfig(): DaemonConfig {
  return {
    serverUrl: 'http://127.0.0.1:8787',
    computerId: 'test-comp',
    deviceToken: 'test-device-token',
  }
}

function makeAgent(id: string): AgentInfo {
  return {
    id,
    name: `Agent ${id}`,
    role: 'tester',
    systemPrompt: 'Standing instructions',
    engine: 'claude',
    model: null,
    fastModel: null,
  }
}

function uniqueAgentId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

test('sessionFileFor scopes the session path to the specific engine', () => {
  const agentId = 'atlas-a745'
  const claudeFile = sessionFileFor(agentId, 'claude')
  const codexFile = sessionFileFor(agentId, 'codex')
  const geminiFile = sessionFileFor(agentId, 'gemini')

  assert.equal(claudeFile, join(SESSIONS_DIR, 'atlas-a745.claude.session'))
  assert.equal(codexFile, join(SESSIONS_DIR, 'atlas-a745.codex.session'))
  assert.equal(geminiFile, join(SESSIONS_DIR, 'atlas-a745.gemini.session'))
  assert.notEqual(claudeFile, codexFile)
  assert.notEqual(claudeFile, geminiFile)
})

test('switching engines isolates session state on disk via AgentRunner', async () => {
  const agentId = uniqueAgentId('agent-switch')
  const cfg = makeConfig()
  const agent = makeAgent(agentId)

  const claudeRunner = new AgentRunner(cfg, agent, 'claude')
  const codexRunner = new AgentRunner(cfg, agent, 'codex')

  try {
    assert.equal(claudeRunner.sessionFile, join(SESSIONS_DIR, `${agentId}.claude.session`))
    assert.equal(codexRunner.sessionFile, join(SESSIONS_DIR, `${agentId}.codex.session`))

    // Agent starts on Claude and persists a session ID
    claudeRunner.setSessionId('claude-uuid-1234')
    await claudeRunner.persistSessionId()
    assert.equal(claudeRunner.currentSessionId, 'claude-uuid-1234')
    assert.equal(await readFile(claudeRunner.sessionFile, 'utf8'), 'claude-uuid-1234')

    // Hot-switch to Codex: Codex loads its session file and sees nothing
    assert.equal(codexRunner.currentSessionId, null)
    await codexRunner.loadSessionId()
    assert.equal(codexRunner.currentSessionId, null, 'Codex must start fresh, not inherit Claude session')

    // Codex persists its own thread session
    codexRunner.setSessionId('codex-thread-5678')
    await codexRunner.persistSessionId()
    assert.equal(codexRunner.currentSessionId, 'codex-thread-5678')
    assert.equal(await readFile(codexRunner.sessionFile, 'utf8'), 'codex-thread-5678')

    // Hot-switch back to Claude: a new Claude runner restores its own session untouched
    const restoredClaude = new AgentRunner(cfg, agent, 'claude')
    await restoredClaude.loadSessionId()
    assert.equal(restoredClaude.currentSessionId, 'claude-uuid-1234', 'Claude restored its own prior session')
    assert.notEqual(restoredClaude.currentSessionId, codexRunner.currentSessionId)
  } finally {
    await rm(claudeRunner.sessionFile, { force: true })
    await rm(codexRunner.sessionFile, { force: true })
  }
})

test('legacy unscoped session files are purged by AgentRunner.loadSessionId', async () => {
  const agentId = uniqueAgentId('agent-legacy')
  const cfg = makeConfig()
  const agent = makeAgent(agentId)
  const legacyFile = join(SESSIONS_DIR, `${agentId}.session`)
  const runner = new AgentRunner(cfg, agent, 'claude')

  try {
    await mkdir(SESSIONS_DIR, { recursive: true })
    // Legacy unversioned session written before session isolation (could be from any engine)
    await writeFile(legacyFile, 'unverified-session-id', 'utf8')

    // AgentRunner loads its engine-scoped session:
    // It must purge the legacy file and start fresh
    await runner.loadSessionId()

    assert.equal(runner.currentSessionId, null, 'No session adopted from legacy unscoped file')

    let legacyExists = true
    try {
      await readFile(legacyFile, 'utf8')
    } catch {
      legacyExists = false
    }
    assert.equal(legacyExists, false, 'Legacy unversioned session file was purged by loadSessionId')
  } finally {
    await rm(legacyFile, { force: true })
    await rm(runner.sessionFile, { force: true })
  }
})

test('isStaleResumeError accurately detects unmasked Claude resume errors', () => {
  // When ClaudeSession extracts the actual error from ev.error / stderr:
  const err1 = 'local claude failed (exit 1): engine turn error (error_during_execution): No conversation found with session ID: 01a06f71-2b77-4a3f-9d51-4c0a1b2e3f44'
  assert.equal(isStaleResumeError(err1), true)

  const err2 = 'local claude failed (exit 1): engine turn error: process exited with code 1\nNo conversation found with session ID: 01a06f71'
  assert.equal(isStaleResumeError(err2), true)

  const err3 = 'local claude failed (exit 1): engine turn error: Session not found'
  assert.equal(isStaleResumeError(err3), true)

  // Verify that an unrelated turn error without stale wording is NOT treated as stale
  const unrelated = 'local claude failed (exit 1): engine turn error (network_error): connection reset by peer'
  assert.equal(isStaleResumeError(unrelated), false)
})

test('AgentRunner.mustResetSession behavior on stale resume vs fresh runs and overflows', () => {
  const agentId = uniqueAgentId('agent-reset-rules')
  const runner = new AgentRunner(makeConfig(), makeAgent(agentId), 'claude')

  const staleErr = 'local claude failed (exit 1): engine turn error: No conversation found with session ID: 01a06f71'
  // When hadResume is true, stale resume target must reset
  assert.equal(runner.mustResetSession(staleErr, true), true)
  // When hadResume is false, stale resume wording does not reset a fresh session
  assert.equal(runner.mustResetSession(staleErr, false), false)

  // Context overflow must reset regardless of hadResume
  const overflowErr = 'local claude failed (exit 1): prompt is too long'
  assert.equal(runner.mustResetSession(overflowErr, true), true)
  assert.equal(runner.mustResetSession(overflowErr, false), true)

  // Poisoned transcript must reset regardless of hadResume
  const poisonedErr = 'local claude failed (exit 1): lone surrogate in input body'
  assert.equal(runner.mustResetSession(poisonedErr, false), true)

  // Transient / network errors do not reset
  const normalErr = 'local claude failed (exit 1): engine turn error: connection timeout'
  assert.equal(runner.mustResetSession(normalErr, true), false)
  assert.equal(runner.mustResetSession(normalErr, false), false)
})

test('AgentRunner.runEngineTurn retries once with resumeSessionId: null on stale-resume error and succeeds', async () => {
  const agentId = uniqueAgentId('agent-stale-retry')
  const cfg = makeConfig()
  const agent = makeAgent(agentId)
  const runner = new AgentRunner(cfg, agent, 'claude')

  try {
    const staleId = 'stale-uuid-9999'
    runner.setSessionId(staleId)
    await runner.persistSessionId()
    assert.equal(runner.currentSessionId, staleId)

    const attempts: { delta: string; resumeSessionId: string | null; purpose: string }[] = []

    runner.runEngineAttempt = async (delta, resumeSessionId, purpose): Promise<EngineRunResult> => {
      attempts.push({ delta, resumeSessionId, purpose })
      if (attempts.length === 1) {
        // First attempt with stale session fails with missing session error (no usage)
        return {
          exitCode: 1,
          error: `local claude failed (exit 1): engine turn error: No conversation found with session ID: ${resumeSessionId}`,
        }
      }
      // Second attempt (retry fresh with null session) succeeds
      return {
        exitCode: 0,
        sessionId: 'fresh-uuid-1111',
        usage: { input_tokens: 42, output_tokens: 10 },
        model: 'claude-3-7-sonnet',
      }
    }

    const result = await runner.runEngineTurn('proactive scan', runner.currentSessionId, 'agent-turn')

    // Verifications:
    // 1. Exactly two attempts were made
    assert.equal(attempts.length, 2, 'Must retry exactly once on stale resume error')
    // 2. First attempt passed the stale session ID
    assert.equal(attempts[0].resumeSessionId, staleId)
    // 3. Second attempt passed resumeSessionId = null (fresh cold start)
    assert.equal(attempts[1].resumeSessionId, null)
    // 4. Stale session on runner was reset during the retry
    assert.equal(runner.currentSessionId, null)
    // 5. Final outcome is the successful fresh run
    assert.equal(result.exitCode, 0)
    assert.equal(result.sessionId, 'fresh-uuid-1111')
    assert.deepEqual(result.usage, { input_tokens: 42, output_tokens: 10 })
  } finally {
    await rm(runner.sessionFile, { force: true })
  }
})

test('AgentRunner.runEngineTurn never retries a turn that reported usage (e.g. context overflow)', async () => {
  const agentId = uniqueAgentId('agent-no-retry-usage')
  const cfg = makeConfig()
  const agent = makeAgent(agentId)
  const runner = new AgentRunner(cfg, agent, 'claude')

  try {
    const resumeId = 'resumed-session-3333'
    runner.setSessionId(resumeId)
    await runner.persistSessionId()

    const attempts: { delta: string; resumeSessionId: string | null }[] = []

    runner.runEngineAttempt = async (delta, resumeSessionId): Promise<EngineRunResult> => {
      attempts.push({ delta, resumeSessionId })
      // Failure that occurred mid-turn after model execution (has usage)
      return {
        exitCode: 1,
        error: 'local claude failed (exit 1): prompt is too long',
        usage: { input_tokens: 200000, output_tokens: 150 },
      }
    }

    const result = await runner.runEngineTurn('run task', runner.currentSessionId, 'agent-turn')

    // Invariant: Because usage > 0, the turn must NEVER be retried in-turn!
    // Retrying would duplicate hops 1..N-1 side effects (posts, edits) and double-charge tokens.
    assert.equal(attempts.length, 1, 'Turn with reported usage must NOT be retried')
    assert.equal(result.exitCode, 1)
    assert.match(result.error ?? '', /prompt is too long/)
    assert.deepEqual(result.usage, { input_tokens: 200000, output_tokens: 150 })
  } finally {
    await rm(runner.sessionFile, { force: true })
  }
})

test('AgentRunner.runEngineTurn does not retry non-stale errors or errors with usage even if stale text appears', async () => {
  const agentId = uniqueAgentId('agent-edge-safety')
  const runner = new AgentRunner(makeConfig(), makeAgent(agentId), 'claude')

  // Case A: Unrelated error without usage (e.g. network timeout)
  let attempts = 0
  runner.runEngineAttempt = async (): Promise<EngineRunResult> => {
    attempts++
    return {
      exitCode: 1,
      error: 'local claude failed (exit 1): connection timed out',
    }
  }
  const resA = await runner.runEngineTurn('test delta', 'some-session', 'agent-turn')
  assert.equal(attempts, 1, 'Network timeout must not be retried')
  assert.equal(resA.exitCode, 1)

  // Case B: Stale resume text appears, BUT usage is reported (model did execute work)
  attempts = 0
  runner.runEngineAttempt = async (): Promise<EngineRunResult> => {
    attempts++
    return {
      exitCode: 1,
      error: 'local claude failed (exit 1): No conversation found with session ID: some-session',
      usage: { input_tokens: 100, output_tokens: 10 },
    }
  }
  const resB = await runner.runEngineTurn('test delta', 'some-session', 'agent-turn')
  assert.equal(attempts, 1, 'Error with usage must not be retried even if text matches stale resume')
  assert.equal(resB.exitCode, 1)
})

test('hasNonZeroUsage distinguishes zero tokens from actual model execution', () => {
  assert.equal(hasNonZeroUsage(undefined), false)
  assert.equal(hasNonZeroUsage({}), false)
  assert.equal(hasNonZeroUsage({ input_tokens: 0, output_tokens: 0 }), false)
  assert.equal(hasNonZeroUsage({ input_tokens: 0, output_tokens: undefined }), false)
  assert.equal(hasNonZeroUsage({ input_tokens: 10, output_tokens: 0 }), true)
  assert.equal(hasNonZeroUsage({ input_tokens: 0, output_tokens: 5 }), true)
  assert.equal(hasNonZeroUsage({ input_tokens: 12, output_tokens: 34 }), true)
})

test('Claude 2.1.207 empirical error shape: errors array and zero usage retries successfully', async () => {
  const agentId = uniqueAgentId('agent-claude-2-1-207')
  const cfg = makeConfig()
  const agent = makeAgent(agentId)
  const runner = new AgentRunner(cfg, agent, 'claude')

  try {
    const staleId = 'stale-claude-session-207'
    runner.setSessionId(staleId)
    await runner.persistSessionId()

    const attempts: { delta: string; resumeSessionId: string | null; purpose: string }[] = []

    runner.runEngineAttempt = async (delta, resumeSessionId, purpose): Promise<EngineRunResult> => {
      attempts.push({ delta, resumeSessionId, purpose })
      if (attempts.length === 1) {
        // Exact shape captured from Claude 2.1.207:
        // Result is undefined, error extracted from errors array, usage is 0 tokens
        return {
          exitCode: 1,
          error: `engine turn error (error_during_execution): No conversation found with session ID: ${resumeSessionId}`,
          usage: { input_tokens: 0, output_tokens: 0 },
        }
      }
      return {
        exitCode: 0,
        sessionId: 'fresh-claude-session-207',
        usage: { input_tokens: 150, output_tokens: 30 },
        model: 'claude-3-7-sonnet',
      }
    }

    const result = await runner.runEngineTurn('audit code', runner.currentSessionId, 'agent-turn')

    assert.equal(attempts.length, 2, 'Must retry turn fresh when zero usage is reported')
    assert.equal(attempts[0].resumeSessionId, staleId)
    assert.equal(attempts[1].resumeSessionId, null)
    assert.equal(result.exitCode, 0)
    assert.equal(result.sessionId, 'fresh-claude-session-207')
    assert.deepEqual(result.usage, { input_tokens: 150, output_tokens: 30 })
  } finally {
    await rm(runner.sessionFile, { force: true })
  }
})

