/**
 * Cluster-wide control channel for one paired Computer daemon.
 *
 * The database remains the durable source of truth for requested work; this bus
 * is only the low-latency nudge that lets an online daemon react immediately
 * instead of waiting for its next heartbeat.
 */
import { randomUUID } from 'node:crypto'
import type { Response } from 'express'
import { redis, sub as redisSub } from '../../redis.js'
import { parseComputerControlEvent, type ComputerControlEvent } from './control-event.js'

const CH_COMPUTER_CONTROL_PREFIX = 'cumora:computer-control:'
const SSE_MAX_BUFFERED_BYTES = 1 * 1024 * 1024

interface Subscriber {
  res: Response
  closed: boolean
  authorize?: () => Promise<boolean>
  delivery: Promise<void>
  revoke(): void
}

const subscribers = new Map<string, Set<Subscriber>>()
let redisSubscriberInstalled = false

async function deliverTo(subscriber: Subscriber, event: ComputerControlEvent): Promise<void> {
  if (subscriber.closed) return
  if (subscriber.authorize) {
    try {
      if (!(await subscriber.authorize())) { subscriber.revoke(); return }
    } catch {
      subscriber.revoke()
      return
    }
  }
  if (subscriber.closed) return
  if (subscriber.res.socket && subscriber.res.socket.writableLength > SSE_MAX_BUFFERED_BYTES) {
    subscriber.revoke()
    return
  }
  try {
    subscriber.res.write(`event: ${event.kind}\n`)
    subscriber.res.write(`id: ${event.id}\n`)
    subscriber.res.write(`data: ${JSON.stringify(event)}\n\n`)
  } catch {
    subscriber.revoke()
  }
}

function installRedisSubscriber(): void {
  if (redisSubscriberInstalled) return
  redisSubscriberInstalled = true
  redisSub.on('message', (channel, raw) => {
    if (!channel.startsWith(CH_COMPUTER_CONTROL_PREFIX)) return
    const computerId = channel.slice(CH_COMPUTER_CONTROL_PREFIX.length)
    const set = subscribers.get(computerId)
    if (!set || set.size === 0) return
    const event = parseComputerControlEvent(raw)
    if (!event) return
    for (const subscriber of set) {
      subscriber.delivery = subscriber.delivery
        .then(() => deliverTo(subscriber, event))
        .catch(() => subscriber.revoke())
    }
  })
}

/** Publish an immediate engine-detection nudge. A zero return means no daemon
 * stream is connected; the persisted heartbeat request remains the fallback. */
export async function deliverEngineDetect(computerId: string): Promise<number> {
  const event: ComputerControlEvent = {
    kind: 'engine.detect',
    id: `engine.detect-${randomUUID()}`,
    at: Date.now(),
  }
  return redis.publish(CH_COMPUTER_CONTROL_PREFIX + computerId, JSON.stringify(event))
}

/** Attach the authenticated daemon's long-lived SSE control stream. */
export async function attachComputerControlStream(
  computerId: string,
  res: Response,
  options: { authorize?: () => Promise<boolean> } = {},
): Promise<void> {
  installRedisSubscriber()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  let set = subscribers.get(computerId)
  if (!set) { set = new Set(); subscribers.set(computerId, set) }
  const isFirst = set.size === 0
  let ping: ReturnType<typeof setInterval> | null = null
  const subscriber: Subscriber = {
    res,
    closed: false,
    authorize: options.authorize,
    delivery: Promise.resolve(),
    revoke: () => { /* assigned after cleanup is defined */ },
  }
  set.add(subscriber)

  const cleanup = (): void => {
    if (subscriber.closed && !set!.has(subscriber)) return
    subscriber.closed = true
    if (ping) clearInterval(ping)
    set!.delete(subscriber)
    const last = set!.size === 0
    if (last) subscribers.delete(computerId)
    if (last) {
      void redisSub.unsubscribe(CH_COMPUTER_CONTROL_PREFIX + computerId).catch((error) => {
        console.warn('[computer-control] Redis unsubscribe failed:', error instanceof Error ? error.message : String(error))
      })
    }
  }
  subscriber.revoke = () => {
    if (subscriber.closed) return
    try { res.end() } catch { /* ignore */ }
    cleanup()
  }
  res.on('close', cleanup)
  res.on('error', cleanup)

  // Subscribe before announcing readiness so a request cannot fall into a gap.
  if (isFirst) await redisSub.subscribe(CH_COMPUTER_CONTROL_PREFIX + computerId)
  if (subscriber.closed) return
  res.write(`event: ready\ndata: {"computerId":${JSON.stringify(computerId)},"at":${Date.now()}}\n\n`)

  ping = setInterval(() => {
    if (subscriber.closed) return
    void (async () => {
      if (subscriber.authorize) {
        try {
          if (!(await subscriber.authorize())) { subscriber.revoke(); return }
        } catch {
          subscriber.revoke()
          return
        }
      }
      try { res.write(`: ping ${Date.now()}\n\n`) } catch { subscriber.revoke() }
    })()
  }, 25_000)
  ping.unref?.()
}
