/**
 * Wake-stream reconnect throttling.
 *
 * A wake-stream can end CLEANLY: wake-bus's backpressure guard calls `res.end()`
 * on a backed-up subscriber, and any edge in front of the API can terminate a
 * chunked 200 the same way. Both reconnect loops (the BYOA daemon's streamLoop
 * and pod-agent's connect loop) kept their only sleep inside `catch`, so a clean
 * end reconnected with zero delay — measured at ~15,000 connects/second against
 * the API from the operator's own machine, each one also re-firing a catch-up
 * turn.
 *
 * The second half is this predicate: resetting the ladder on a mere connect
 * meant that even with a sleep in place, a 200-then-EOF endpoint would reset the
 * delay every pass and it could never grow.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-wake-reconnect.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STREAM_STABLE_MS, wakeStreamWasStable } from '../agents/runtime/sse-parse.js'

test('a connection that never opened does not reset the ladder', () => {
  assert.equal(wakeStreamWasStable(null), false)
})

test('a connection that closed immediately does not reset the ladder', () => {
  // The 200-then-EOF case. If this returned true the backoff would be pinned at
  // its base forever and the loop would hammer the server.
  assert.equal(wakeStreamWasStable(0), false)
  assert.equal(wakeStreamWasStable(5), false)
})

test('a short-lived connection does not reset the ladder', () => {
  assert.equal(wakeStreamWasStable(STREAM_STABLE_MS - 1), false)
})

test('a connection that stayed up resets the ladder', () => {
  assert.equal(wakeStreamWasStable(STREAM_STABLE_MS), true)
  assert.equal(wakeStreamWasStable(STREAM_STABLE_MS * 10), true)
})

test('the backoff ladder actually grows across repeated instant closes', () => {
  // Mirrors both loops' shared tail: reset only if stable, then sleep, then
  // double. With a pathological endpoint the delay must climb to the ceiling.
  const MAX = 30_000
  let backoff = 1000
  const slept: number[] = []
  for (let i = 0; i < 8; i++) {
    if (wakeStreamWasStable(0)) backoff = 1000
    slept.push(backoff)
    backoff = Math.min(backoff * 2, MAX)
  }
  assert.deepEqual(slept, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000])
})

test('a healthy connection returns the ladder to its base', () => {
  let backoff = 30_000
  if (wakeStreamWasStable(STREAM_STABLE_MS + 1)) backoff = 1000
  assert.equal(backoff, 1000, 'a stream that stayed up must reconnect promptly')
})
