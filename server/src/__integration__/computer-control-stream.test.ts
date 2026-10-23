/** Real Redis wire tests for the paired Computer daemon control stream. */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import {
  attachComputerControlStream,
  deliverEngineDetect,
  deliverEngineUpdate,
} from '../agents/computer/control-bus.js'
import { parseComputerControlEvent } from '../agents/computer/control-event.js'
import { getEngineUpdate, reportEngineUpdate, startEngineUpdate } from '../agents/computer/engine-update.js'
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

/** The `data:` line of the first `event: <kind>` block written to the stream. */
function controlFrame(writes: string[], kind: string): string | null {
  const block = writes.join('').split('\n\n').find((value) => value.startsWith(`event: ${kind}\n`))
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

  const raw = controlFrame(response.written, 'engine.detect')
  assert.ok(raw, 'the daemon stream should receive an engine.detect frame')
  assert.equal(parseComputerControlEvent(raw)?.kind, 'engine.detect')
  response.triggerClose()
})

test('[integration] an engine update reaches the daemon with only the engine id', async () => {
  const computerId = `computer-${randomUUID()}`
  const response = makeFakeSseResponse()
  await attachComputerControlStream(computerId, response)

  const requestId = randomUUID()
  assert.ok((await deliverEngineUpdate(computerId, 'codex', requestId)) >= 1)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const raw = controlFrame(response.written, 'engine.update')
  assert.ok(raw, 'the daemon stream should receive an engine.update frame')
  const event = parseComputerControlEvent(raw)
  assert.equal(event?.kind, 'engine.update')
  // The command is the daemon's to pick: only the id travels.
  assert.deepEqual(Object.keys(event ?? {}).sort(), ['at', 'engine', 'id', 'kind'])
  assert.equal(event?.kind === 'engine.update' ? event.engine : null, 'codex')
  assert.equal(event?.id, requestId)
  response.triggerClose()
})

test('[integration] an update is claimed once, scoped to its computer, and released on completion', async () => {
  const computerId = `computer-${randomUUID()}`
  const job = await startEngineUpdate(computerId, 'company', 'codex')
  assert.ok(job)
  assert.equal(await startEngineUpdate(computerId, 'company', 'claude'), null)
  assert.equal(await reportEngineUpdate('other-computer', job.id, 'running'), false)
  const claims = await Promise.all([
    reportEngineUpdate(computerId, job.id, 'running'),
    reportEngineUpdate(computerId, job.id, 'running'),
  ])
  assert.equal(claims.filter(Boolean).length, 1)
  assert.equal((await getEngineUpdate(job.id))?.status, 'running')
  assert.equal(await reportEngineUpdate(computerId, job.id, 'succeeded'), true)
  assert.equal((await getEngineUpdate(job.id))?.status, 'succeeded')
  assert.equal(await reportEngineUpdate(computerId, job.id, 'running'), false)
  const next = await startEngineUpdate(computerId, 'company', 'claude')
  assert.ok(next)
  assert.equal(await reportEngineUpdate(computerId, next.id, 'failed', 'fixture failure'), true)
  assert.equal((await getEngineUpdate(next.id))?.error, 'fixture failure')
  assert.ok(await startEngineUpdate(computerId, 'company', 'codex'))
})

test('[integration] revoked device streams close before receiving a refresh', async () => {
  const computerId = `computer-${randomUUID()}`
  const response = makeFakeSseResponse()
  await attachComputerControlStream(computerId, response, { authorize: async () => false })

  await deliverEngineDetect(computerId)
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(response.closed, true)
  assert.equal(controlFrame(response.written, 'engine.detect'), null)
})

test('[integration] a disconnected stream reports no immediate receiver', async () => {
  const computerId = `computer-${randomUUID()}`
  const response = makeFakeSseResponse()
  await attachComputerControlStream(computerId, response)
  response.triggerClose()
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(await deliverEngineDetect(computerId), 0)
})
