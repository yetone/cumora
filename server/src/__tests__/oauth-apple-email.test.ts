/**
 * Regression tests for the Sign in with Apple account-linking boundary.
 *
 * Run: node --import tsx --test server/src/__tests__/oauth-apple-email.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTrustedAppleEmail } from '../apple.js'

test('unlinked Apple identity rejects an email-less token even when the client supplies a victim email', () => {
  const attackerInput = {
    linkedEmail: null,
    tokenEmail: null,
    tokenEmailVerified: false,
    // Extra request metadata must never enter the trusted selector.
    fallbackEmail: 'victim@example.com',
  }

  assert.throws(
    () => resolveTrustedAppleEmail(attackerInput),
    /verified email not available for unlinked identity/,
  )
})

test('unlinked Apple identity rejects an unverified token email', () => {
  assert.throws(
    () => resolveTrustedAppleEmail({
      linkedEmail: null,
      tokenEmail: 'victim@example.com',
      tokenEmailVerified: false,
    }),
    /verified email not available for unlinked identity/,
  )
})

test('unlinked Apple identity accepts and normalizes a verified token email', () => {
  assert.equal(resolveTrustedAppleEmail({
    linkedEmail: null,
    tokenEmail: '  New.User@Example.COM ',
    tokenEmailVerified: true,
  }), 'new.user@example.com')
})

test('linked Apple identity reauthenticates from its stored email without a token email', () => {
  assert.equal(resolveTrustedAppleEmail({
    linkedEmail: 'Existing.User@Example.COM',
    tokenEmail: null,
    tokenEmailVerified: false,
  }), 'existing.user@example.com')
})

test('linked Apple identity remains authoritative when a later token carries another email', () => {
  assert.equal(resolveTrustedAppleEmail({
    linkedEmail: 'owner@example.com',
    tokenEmail: 'other@example.com',
    tokenEmailVerified: true,
  }), 'owner@example.com')
})
