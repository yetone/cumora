/**
 * A confirmed wake delivery has to retire the retry that was covering for it.
 *
 * `wakeOne` does two things after spinning up a pod: it queues a "post-spawn
 * health check" retry, and it runs an inline replay loop that re-delivers until
 * a subscriber answers. Both exist for the same reason — kubelet can reject the
 * allocation right after scheduling, so the pod may never reach the wake
 * stream. Only the loop can CONFIRM the pod attached.
 *
 * The queued job was never retired when it did, so the same wake went out
 * twice. The comment above the schedule call says why that was believed to be
 * harmless: "if the pod is healthy, the retry just delivers a wake and the
 * inbox fingerprint makes the turn no-op."
 *
 * That premise holds for `message.new` — and `message.new` is the one wake
 * class that never enters this queue. `_shouldRetryEnsurePodFailure` admits
 * `manual` and nothing else; the only producer of `manual` in the product is a
 * board card wake (kanban-wake.ts), which always carries a `backgroundBrief`;
 * and the briefed-manual fingerprint in turn.ts embeds `new Date()`, so it can
 * never match the previous turn's. So the only wake class that reaches the
 * queue is exactly the one the premise fails for: every board action on a
 * resting agent ran the whole turn twice — re-claiming the card, re-commenting,
 * and billing a second model call.
 *
 * Run: node --import tsx --test server/src/__tests__/scheduler-post-spawn-retry.test.ts
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pool } from '../db/pool.js'
import { _cancelWakeRetry } from '../agents/scheduler.js'
import { redis } from '../redis.js'

// The keys scheduleWakeRetry writes. Pinned literally on purpose: if they are
// renamed, _cancelWakeRetry deletes from the new names while these seeds sit in
// the old ones, and these tests fail rather than quietly passing.
const DUE_KEY = 'cumora:wake-retry:due'
const JOB_KEY = 'cumora:wake-retry:jobs'

before(async () => {
  // The shared client connects lazily and runs with enableOfflineQueue: false,
  // so a command issued before it is ready throws rather than queueing.
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => reject(new Error('redis did not become ready')), 10_000)
      redis.once('ready', done)
      if (redis.status === 'ready') done()
    })
  }
})

after(async () => {
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

async function seedJob(id: string): Promise<void> {
  await redis.hset(JOB_KEY, id, JSON.stringify({ id, attempt: 1 }))
  await redis.zadd(DUE_KEY, Date.now() + 10_000, id)
}

async function queued(id: string): Promise<boolean> {
  const [job, score] = await Promise.all([redis.hget(JOB_KEY, id), redis.zscore(DUE_KEY, id)])
  return job !== null || score !== null
}

test('a confirmed delivery retires the queued post-spawn retry', async () => {
  const id = 'a-board:manual:-'
  await seedJob(id)
  assert.equal(await queued(id), true, 'seed failed')

  await _cancelWakeRetry('a-board', 'manual', null)

  assert.equal(
    await queued(id), false,
    'the health-check retry outlived the delivery it was covering for — the board brief goes out twice',
  )
})

test('it retires only the job for that agent, reason and conversation', async () => {
  // The guard rail: this must not become "clear the queue".
  const mine = 'a-one:manual:-'
  const peer = 'a-two:manual:-'
  const otherConvo = 'a-one:manual:c-42'
  for (const id of [mine, peer, otherConvo]) await seedJob(id)

  await _cancelWakeRetry('a-one', 'manual', null)

  assert.equal(await queued(mine), false)
  assert.equal(await queued(peer), true, 'another agent\'s retry was dropped')
  assert.equal(await queued(otherConvo), true, 'a retry for a different conversation was dropped')

  for (const id of [peer, otherConvo]) {
    await redis.hdel(JOB_KEY, id)
    await redis.zrem(DUE_KEY, id)
  }
})

test('cancelling a job that is not queued is a no-op, not an error', async () => {
  await _cancelWakeRetry('a-never-queued', 'manual', null)
})

test('wakeOne retires the retry where the replay loop confirms delivery', async () => {
  // The tests above exercise the helper. They would all still pass against a
  // wakeOne that never calls it — which is the state being fixed. Read the
  // source: the cancel has to sit on the confirmed-delivery branch of the
  // replay loop, not somewhere it fires regardless.
  const source = await readFile(new URL('../agents/scheduler.ts', import.meta.url), 'utf8')
  const loop = source.slice(source.indexOf('const replayed = await deliverWake'))
  const branch = loop.slice(0, loop.indexOf('return true') + 'return true'.length)

  assert.match(
    branch, /_cancelWakeRetry\(agentId, reason, conversationId\)/,
    'a confirmed replay no longer retires the health-check retry — the same wake will be delivered twice',
  )
})
