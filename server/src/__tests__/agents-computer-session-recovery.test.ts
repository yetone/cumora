import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runWithSessionRecovery } from '../agents/computer/session-recovery.js'

test('a missing resume target is cleared and retried fresh exactly once', async () => {
  const attempts: Array<string | null> = []
  let resets = 0
  const result = await runWithSessionRecovery({
    resumeSessionId: 'stale-id',
    run: async (resume) => {
      attempts.push(resume)
      return resume
        ? { exitCode: 1, error: 'No conversation found with session ID: stale-id' }
        : { exitCode: 0, sessionId: 'fresh-id' }
    },
    reset: async () => { resets += 1 },
  })

  assert.deepEqual(attempts, ['stale-id', null])
  assert.equal(resets, 1)
  assert.equal(result.sessionId, 'fresh-id')
})

test('a failed fresh retry is returned without a third attempt', async () => {
  const attempts: Array<string | null> = []
  const result = await runWithSessionRecovery({
    resumeSessionId: 'stale-id',
    run: async (resume) => {
      attempts.push(resume)
      return resume
        ? { exitCode: 1, error: 'session not found' }
        : { exitCode: 1, error: 'fresh start also failed' }
    },
    reset: async () => {},
  })

  assert.deepEqual(attempts, ['stale-id', null])
  assert.equal(result.failure?.kind, 'unknown')
})

test('ambiguous failures are never replayed', async () => {
  for (const error of [
    'process exited with code 137',
    'engine turn exceeded timeout',
    'read ECONNRESET',
    'unknown provider error',
  ]) {
    let attempts = 0
    let resets = 0
    const result = await runWithSessionRecovery({
      resumeSessionId: 'existing-id',
      run: async () => { attempts += 1; return { exitCode: 1, error } },
      reset: async () => { resets += 1 },
    })
    assert.equal(attempts, 1, error)
    assert.equal(resets, 0, error)
    assert.notEqual(result.failure?.kind, 'resume-not-found', error)
  }
})

test('a fresh turn never enters resume recovery', async () => {
  let attempts = 0
  const result = await runWithSessionRecovery({
    resumeSessionId: null,
    run: async () => { attempts += 1; return { exitCode: 1, error: 'session not found' } },
    reset: async () => assert.fail('fresh turn must not reset a session'),
  })
  assert.equal(attempts, 1)
  assert.equal(result.failure?.kind, 'unknown')
})
