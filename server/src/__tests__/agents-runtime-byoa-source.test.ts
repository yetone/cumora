import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BYOA_SOURCES, normalizeByoaSource } from '../agents/runtime/byoa-source.js'

test('runtime ledger accepts every supported BYOA source', () => {
  for (const source of BYOA_SOURCES) assert.equal(normalizeByoaSource(source), source)
})

test('runtime ledger rejects arbitrary and non-string source values', () => {
  for (const source of ['cloud', 'byoa-forged', '', null, undefined, 7, {}]) {
    assert.equal(normalizeByoaSource(source), 'byoa-claude')
  }
})
