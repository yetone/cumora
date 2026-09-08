import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
  _resetPendingCreateRequestIdsForTests,
  clearPendingCreateRequestId,
  pendingCreateRequestId,
} from '../src/lib/create-idempotency'

describe('create idempotency key management', () => {
  beforeEach(() => {
    _resetPendingCreateRequestIdsForTests()
  })

  it('reuses the same requestId for ambiguous retries within TTL', () => {
    const input = { title: 'Untitled board', description: null }
    const first = pendingCreateRequestId('board', input, { now: 10_000 })
    const second = pendingCreateRequestId('board', input, { now: 15_000 })
    assert.equal(first.requestId, second.requestId)
  })

  it('generates a fresh requestId after complete() is called', () => {
    const input = { title: 'Untitled board', description: null }
    const first = pendingCreateRequestId('board', input, { now: 10_000 })
    first.complete()
    const second = pendingCreateRequestId('board', input, { now: 10_001 })
    assert.notEqual(first.requestId, second.requestId)
  })

  it('generates a fresh requestId when TTL expires', () => {
    const input = { title: 'Untitled board', description: null }
    const first = pendingCreateRequestId('board', input, { ttlMs: 1000, now: 1000 })
    const second = pendingCreateRequestId('board', input, { ttlMs: 1000, now: 2001 })
    assert.notEqual(first.requestId, second.requestId)
  })

  it('evicts pending requestId on 4xx client errors via fail()', () => {
    const input = { title: 'Bad input' }
    const first = pendingCreateRequestId('board', input)
    first.fail({ status: 400 })
    const second = pendingCreateRequestId('board', input)
    assert.notEqual(first.requestId, second.requestId)
  })

  it('preserves pending requestId on 5xx upstream errors via fail() within TTL', () => {
    const input = { title: 'Retryable board' }
    const first = pendingCreateRequestId('board', input, { now: 10_000 })
    first.fail({ status: 502 })
    const second = pendingCreateRequestId('board', input, { now: 11_000 })
    assert.equal(first.requestId, second.requestId)
  })

  it('evicts pending requestId when fail() is called with no arguments', () => {
    const input = { title: 'Aborted board' }
    const first = pendingCreateRequestId('board', input)
    first.fail()
    const second = pendingCreateRequestId('board', input)
    assert.notEqual(first.requestId, second.requestId)
  })

  it('allows explicit clearance via clearPendingCreateRequestId', () => {
    const input = { title: 'Document 1' }
    const first = pendingCreateRequestId('document', input)
    clearPendingCreateRequestId('document', input)
    const second = pendingCreateRequestId('document', input)
    assert.notEqual(first.requestId, second.requestId)
  })

  it('separates scopes and distinct inputs', () => {
    const r1 = pendingCreateRequestId('board', { title: 'A' })
    const r2 = pendingCreateRequestId('document', { title: 'A' })
    const r3 = pendingCreateRequestId('board', { title: 'B' })
    assert.notEqual(r1.requestId, r2.requestId)
    assert.notEqual(r1.requestId, r3.requestId)
  })
})
