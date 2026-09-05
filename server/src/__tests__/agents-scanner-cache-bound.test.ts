/**
 * The scanner's dedup cache must not grow with uptime.
 *
 * It was an unbounded `Set` of raw fingerprints, and a fingerprint carries up
 * to 80 message ids (~3KB) — one entry per eligible pass per agent, retained
 * for the lifetime of the process. Redis now holds the durable claim; this
 * cache exists only to keep the common case off the network, so it stores
 * fixed-width digests under a hard cap.
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'mock-key'

const { __scannerCacheInternals: cache } = await import('../agents/scanner.js')
const { redis, sub } = await import('../redis.js')

beforeEach(() => { cache.clear() })

test.after(() => {
  redis.disconnect()
  sub.disconnect()
})

test('a fingerprint of any size is stored as a fixed-width digest', () => {
  const short = cache.digest('co-1|agent-1|m1')
  const long = cache.digest(`co-1|agent-1|${Array.from({ length: 80 }, (_, i) => `m-${'x'.repeat(34)}${i}`).join('|')}`)
  assert.match(short, /^[a-f0-9]{64}$/)
  assert.equal(long.length, short.length,
    'an 80-message fingerprint must cost exactly as much cache as a one-message fingerprint')
  assert.notEqual(short, long)
})

test('the cache evicts at its limit instead of growing without bound', () => {
  const { limit } = cache
  for (let i = 0; i < limit + 50; i++) cache.remember(cache.digest(`fp-${i}`))

  assert.equal(cache.size(), limit, 'the cache must never exceed its cap')
  // The 50 oldest are gone; the newest survive.
  assert.equal(cache.has(cache.digest('fp-0')), false)
  assert.equal(cache.has(cache.digest('fp-49')), false)
  assert.equal(cache.has(cache.digest(`fp-${limit + 49}`)), true)
})

test('a hit renews an entry, so a steadily-rescanned agent is not evicted by newcomers', () => {
  const { limit } = cache
  for (let i = 0; i < limit; i++) cache.remember(cache.digest(`lru-${i}`))
  assert.equal(cache.size(), limit)

  // Touch the oldest entry, then push one newcomer in.
  assert.equal(cache.has(cache.digest('lru-0')), true)
  cache.remember(cache.digest('lru-new'))

  assert.equal(cache.size(), limit)
  assert.equal(cache.has(cache.digest('lru-0')), true,
    'the renewed entry must survive — FIFO would have dropped it')
  assert.equal(cache.has(cache.digest('lru-1')), false,
    'the genuinely-oldest entry is the one evicted')
})
