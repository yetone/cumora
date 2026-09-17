/**
 * The wake-retry drain has to be backpressured by the same semaphore as live
 * fan-out.
 *
 * `_drainWakeRetries` is the recovery path for wakes that failed on host
 * resolution. Any database error in `resolveAgentHost` maps to `lookup_failed`,
 * and `_shouldRetryWakeFailure` treats that as retryable for every wake reason,
 * so a short database blip during a busy hour enqueues a retry for every
 * recipient of every message sent during it. The burst that comes back is
 * therefore the *most* correlated traffic the scheduler ever sees, and it
 * arrives while the database is still recovering.
 *
 * It used to call `wakeOne(...)` without awaiting, up to `WAKE_RETRY_BATCH_SIZE`
 * (25) per 5s tick, bypassing `wakeFanoutSem` entirely — each wake costing a
 * host-resolution query plus, for a managed agent, persona + inbox + context
 * loads and a model call. That is the triage fail-open amplification loop the
 * semaphore was built for after the 2026-05-27 connection-exhaustion outage.
 *
 * Run: node --import tsx --test server/src/__tests__/scheduler-wake-retry.test.ts
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import {
  _drainWakeRetries,
  _wakeFanoutSem,
  type WakeRetryQueue,
} from '../agents/scheduler.js'

after(async () => {
  // scheduler.ts transitively imports redis.ts which opens connections.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface Recorder {
  queue: WakeRetryQueue
  started: string[]
  finished: string[]
  rescheduled: Array<{ id: string; attempt: number; failure: string }>
  peakConcurrency: number
  release: () => void
}

/** A queue of `count` due jobs whose wakes block until `release()` is called,
 *  so the test can observe how many the drain lets run at once. */
function recorder(count: number, opts: { fail?: Set<string>; hold?: boolean } = {}): Recorder {
  const ids = Array.from({ length: count }, (_, i) => `agent-${i}:message.new:c-${i}`)
  const started: string[] = []
  const finished: string[] = []
  const rescheduled: Array<{ id: string; attempt: number; failure: string }> = []
  const gate: Array<() => void> = []
  let inFlight = 0
  // Latched: the batch is larger than the semaphore, so jobs keep arriving
  // after release() — they must not re-block on a gate nobody will open again.
  let released = false
  const rec: Recorder = {
    started, finished, rescheduled,
    peakConcurrency: 0,
    release: () => {
      released = true
      for (const open of gate.splice(0)) open()
    },
    queue: {
      due: async () => ids,
      claim: async (id) => ({
        id,
        agentId: id.split(':')[0],
        reason: 'message.new',
        conversationId: id.split(':')[2],
        steerPayload: null,
        options: {},
        attempt: 7,
        lastFailure: 'host lookup failed',
      }),
      run: async (job) => {
        started.push(job.id)
        inFlight += 1
        rec.peakConcurrency = Math.max(rec.peakConcurrency, inFlight)
        try {
          if (opts.hold && !released) await new Promise<void>((resolve) => gate.push(resolve))
          else await tick()
          if (opts.fail?.has(job.id)) throw new Error(`pod apply failed for ${job.agentId}`)
          finished.push(job.id)
        } finally {
          inFlight -= 1
        }
      },
      reschedule: async (job, failure) => {
        rescheduled.push({ id: job.id, attempt: job.attempt + 1, failure })
      },
    },
  }
  return rec
}

test('a full retry batch never exceeds the live fan-out concurrency', async () => {
  const rec = recorder(25)

  await _drainWakeRetries(rec.queue)

  assert.equal(rec.started.length, 25, 'every due job must still run')
  assert.equal(rec.finished.length, 25)
  assert.ok(
    rec.peakConcurrency <= env.WAKE_FANOUT_CONCURRENCY,
    `peak concurrency ${rec.peakConcurrency} exceeded the fan-out bound ${env.WAKE_FANOUT_CONCURRENCY}`,
  )
  assert.ok(rec.peakConcurrency > 1, 'the drain should still overlap work, not serialize it')
})

test('the drain awaits its batch instead of firing and forgetting', async () => {
  const rec = recorder(8, { hold: true })

  let settled = false
  const drained = _drainWakeRetries(rec.queue).then(() => { settled = true })

  await tick()
  assert.equal(settled, false, 'the drain resolved while wakes were still in flight')
  assert.ok(rec.started.length > 0)

  rec.release()
  await drained
  assert.equal(settled, true)
  assert.equal(rec.finished.length, 8)
})

test('retry wakes queue behind the same permits as live fan-out', async () => {
  // Hold every permit, the way a reply-storm fan-out would. Nothing in the
  // retry batch may start until they come back — a private bound of its own
  // would let 25 wakes run straight through a saturated pool.
  const held: Array<Promise<void>> = []
  const openGates: Array<() => void> = []
  for (let i = 0; i < env.WAKE_FANOUT_CONCURRENCY; i++) {
    held.push(_wakeFanoutSem.run(() => new Promise<void>((resolve) => openGates.push(resolve))))
  }
  await tick()

  const rec = recorder(5)
  const drained = _drainWakeRetries(rec.queue)
  await tick()
  await tick()
  assert.equal(rec.started.length, 0, 'a retry wake started while live fan-out held every permit')

  for (const open of openGates) open()
  await Promise.all(held)
  await drained
  assert.equal(rec.finished.length, 5)
})

test('a wake that throws is rescheduled at the next attempt and does not sink the batch', async () => {
  const rec = recorder(4, { fail: new Set(['agent-1:message.new:c-1']) })

  await _drainWakeRetries(rec.queue)

  assert.equal(rec.finished.length, 3, 'the three healthy wakes must still complete')
  assert.deepEqual(rec.rescheduled.map((r) => r.id), ['agent-1:message.new:c-1'])
  assert.equal(rec.rescheduled[0].attempt, 8, 'a retry has to advance the attempt counter')
  assert.match(rec.rescheduled[0].failure, /pod apply failed/)
})

test('a job another replica already claimed is skipped', async () => {
  const rec = recorder(3)
  const queue: WakeRetryQueue = { ...rec.queue, claim: async () => null }

  await _drainWakeRetries(queue)

  assert.deepEqual(rec.started, [])
  assert.deepEqual(rec.rescheduled, [])
})
