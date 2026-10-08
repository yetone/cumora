import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyEngineFailure, engineDiagnosticText, engineFailureOf, failurePreview } from '../agents/computer/engine.js'

test('engine failures are classified into stable machine-readable kinds', () => {
  assert.equal(classifyEngineFailure('No conversation found with session ID: abc', true), 'resume-not-found')
  assert.equal(classifyEngineFailure('maximum context window exceeded'), 'context-overflow')
  assert.equal(classifyEngineFailure('429 Too Many Requests: rate limit reached'), 'rate-limit')
  assert.equal(classifyEngineFailure('Not logged in · Please run /login'), 'authentication')
  assert.equal(classifyEngineFailure('read ECONNRESET: socket hang up'), 'transport')
  assert.equal(classifyEngineFailure('the engine disliked something novel'), 'unknown')
})

test('a missing-session phrase is stale only when resume was attempted', () => {
  assert.equal(classifyEngineFailure('session not found', false), 'unknown')
  assert.equal(classifyEngineFailure('session not found', true), 'resume-not-found')
})

test('local startup failures are distinct from provider and transport failures', () => {
  for (const diagnostic of [
    'bwrap: execvp /opt/codex: No such file or directory',
    'process terminated by SIGTERM\nbwrap: execvp /home/quota/token/codex: Permission denied',
    'spawn /opt/codex ENOENT',
    'spawn /opt/my tools/codex EACCES',
  ]) assert.equal(classifyEngineFailure(diagnostic), 'startup', diagnostic)

  assert.equal(classifyEngineFailure('No such file or directory: notes.txt'), 'unknown')
  assert.equal(classifyEngineFailure('process terminated by SIGTERM'), 'transport')
  assert.equal(classifyEngineFailure('connection timed out'), 'transport')
})

test('one-shot startup diagnostics survive the shorter operator notice', () => {
  const error = failurePreview({
    exitCode: 1,
    signalName: null,
    stderr: ['checking quota configuration\n'.repeat(100), 'bwrap: execvp /opt/codex: No such file or directory'],
    stdout: [],
  }).slice(0, 900)
  assert.match(error, /bwrap: execvp.*No such file or directory/)
  assert.equal(classifyEngineFailure(error), 'startup')
})

test('diagnostic extraction keeps engine errors but drops successful model prose', () => {
  const diagnostic = engineDiagnosticText([
    '{"type":"assistant","session_id":"abc","message":{"content":"session not found"}}',
    '{"type":"result","is_error":false,"result":"No conversation found"}',
    '{"type":"result","is_error":true,"result":"No conversation found with session ID: abc"}',
    '{"type":"error","error":{"message":"transport closed"}}',
    'plain stderr detail',
  ].join('\n'))

  assert.match(diagnostic, /No conversation found with session ID/)
  assert.match(diagnostic, /transport closed/)
  assert.match(diagnostic, /plain stderr detail/)
  assert.doesNotMatch(diagnostic, /session_id/)
})

test('adapter classifications win and legacy error strings receive a fallback', () => {
  const explicit = { kind: 'authentication', message: 'sign in', diagnostic: 'raw sign in' } as const
  assert.equal(engineFailureOf({ exitCode: 1, error: 'other', failure: explicit }, true), explicit)
  assert.equal(engineFailureOf({ exitCode: 1, error: 'No conversation found with session ID: abc' }, true)?.kind, 'resume-not-found')
  assert.equal(engineFailureOf({ exitCode: 0 }, true), null)
})
