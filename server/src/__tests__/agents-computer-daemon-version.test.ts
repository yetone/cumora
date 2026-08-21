import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveCurrentVersion } from '../agents/computer/daemon.js'

test('bundled version wins in packaged CLI builds', () => {
  assert.equal(resolveCurrentVersion('1.2.3', '9.9.9'), '1.2.3')
})

test('source-mode daemon accepts the version supplied by its launcher', () => {
  assert.equal(resolveCurrentVersion(undefined, ' 1.2.3 '), '1.2.3')
})

test('missing or blank version retains the development fallback', () => {
  assert.equal(resolveCurrentVersion(undefined, undefined), '0.0.0')
  assert.equal(resolveCurrentVersion(undefined, '   '), '0.0.0')
})
