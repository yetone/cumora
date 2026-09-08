/** Real Redis wire tests for the paired Computer daemon control stream. */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import {
  attachComputerControlStream,
  deliverEngineDetect,
} from '../agents/computer/control-bus.js'
import { parseComputerControlEvent } from '../agents/computer/control-event.js'
import { teardownAll } from './_helpers.js'

function makeFakeSseResponse(): Response & {
  written: string[]
  closed: boolean
  triggerClose(): void
} {
  const events = new EventEmitter()
  const written: string[] = []
  const fake = Object.assign(events, {
    written,
    closed: false,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (value: string) => { if (!fake.closed) written.push(value); return true },
    end: () => { if (!fake.closed) { fake.closed = true; events.emit('close') } },
    triggerClose: () => { if (!fake.closed) { fake.closed = true; events.emit('close') } },
  }) as unknown as Response & { written: string[]; closed: boolean; triggerClose(): void }
  return fake
}

function engineDetectFrame(writes: string[]): string | null {
  const block = writes.join('').split('\n\n').find((value) => value.startsWith('event: engine.detect\n'))
  const data = block?.split('\n').find((line) => line.startsWith('data: '))?.slice(6)
  return data ?? null
}

after(async () => {
  await teardownAll()
})

test('[integration] engine refresh publishes through Redis to the device SSE stream', async () => {
  const computerId = `computer-${randomUUID()}`
  const response = makeFakeSseResponse()
  await attachComputerControlStream(computerId, response)

  assert.ok((await deliverEngineDetect(computerId)) >= 1)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const raw = engineDetectFrame(response.written)
  assert.ok(raw, 'the daemon stream should receive an engine.detect frame')
  assert.equal(parseComputerControlEvent(raw)?.kind, 'engine.detect')
  response.triggerClose()
})

test('[integration] revoked device streams close before receiving a refresh', async () => {
  const computerId = `computer-${randomUUID()}`
  const response = makeFakeSseResponse()
  await attachComputerControlStream(computerId, response, { authorize: async () => false })

  await deliverEngineDetect(computerId)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(response.closed, true)
  assert.equal(engineDetectFrame(response.written), null)
})

test('[integration] a disconnected stream reports no immediate receiver', async () => {
  const computerId = `computer-${randomUUID()}`
  const response = makeFakeSseResponse()
  await attachComputerControlStream(computerId, response)
  response.triggerClose()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(await deliverEngineDetect(computerId), 0)
})
