import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripLoneSurrogates } from '../agents/text-safety.js'

test('stripLoneSurrogates preserves ordinary ASCII, CJK, and valid surrogate pairs (emojis)', () => {
  assert.equal(stripLoneSurrogates('Hello world! 123'), 'Hello world! 123')
  assert.equal(stripLoneSurrogates('你好，世界！这是一段中文测试。'), '你好，世界！这是一段中文测试。')
  assert.equal(stripLoneSurrogates('👋 🤖 🚀 🔥 ✨'), '👋 🤖 🚀 🔥 ✨')
  assert.equal(stripLoneSurrogates('Compound emoji: 👨‍👩‍👧‍👦'), 'Compound emoji: 👨‍👩‍👧‍👦')
})

test('stripLoneSurrogates removes lone high surrogates without low surrogates', () => {
  // \uD83D alone (high surrogate for emoji like 🤖 or 👋)
  const loneHigh = 'broken: \uD83D test'
  assert.equal(stripLoneSurrogates(loneHigh), 'broken:  test')

  // Multiple consecutive lone high surrogates
  const multiHigh = '\uD83D\uD83D\uD83D'
  assert.equal(stripLoneSurrogates(multiHigh), '')
})

test('stripLoneSurrogates removes lone low surrogates without high surrogates', () => {
  // \uDE00 alone (low surrogate)
  const loneLow = 'broken: \uDE00 test'
  assert.equal(stripLoneSurrogates(loneLow), 'broken:  test')

  // Multiple consecutive lone low surrogates
  const multiLow = '\uDE00\uDE00'
  assert.equal(stripLoneSurrogates(multiLow), '')
})

test('stripLoneSurrogates handles mid-slice truncation of emojis safely', () => {
  const text = 'prefix 🤖 suffix'
  // Slicing right after the high surrogate of 🤖 (length of "prefix " is 7, high surrogate at 7, low surrogate at 8)
  const slicedMidEmoji = text.slice(0, 8) // includes "prefix " + \uD83E (high surrogate of 🤖)
  const scrubbed = stripLoneSurrogates(slicedMidEmoji)
  assert.equal(scrubbed, 'prefix ')

  // JSON stringification of scrubbed text produces valid UTF-8 JSON without JSON.stringify/JSON.parse throwing or corrupting
  const json = JSON.stringify({ prompt: scrubbed })
  assert.doesNotThrow(() => JSON.parse(json))
})
