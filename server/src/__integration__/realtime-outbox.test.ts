import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { drainRealtimeOutbox, enqueueBroadcast } from '../realtime-outbox.js'
import type { BroadcastEvent } from '../redis.js'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables,
  seedUserMembership, teardownAll,
} from './_helpers.js'

const COMPANY_ID = 'co-outbox'
const USER_ID = 'u-outbox'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(USER_ID)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('test server did not bind')
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Outbox Co', 'outbox-co', $2)`,
    [COMPANY_ID, USER_ID],
  )
  await seedUserMembership(USER_ID, COMPANY_ID)
})

after(async () => { await teardownAll(server) })

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('[integration] a Redis outage cannot make a committed board create ambiguous', async () => {
  const startedAt = Date.now()
  const response = await post('/boards', {
    title: 'Outbox board',
    requestId: 'outbox-board-request-1',
  })
  assert.equal(response.status, 201)
  assert.ok(Date.now() - startedAt < 2_000, 'request should not wait on Redis')
  const created = await response.json() as { id: string; replayed: boolean }
  assert.equal(created.replayed, false)

  const failed = await drainRealtimeOutbox({
    publishFn: async () => { throw new Error('redis unavailable') },
  })
  assert.deepEqual(failed, { claimed: 1, published: 0, failed: 1, discarded: 0 })

  const durable = await pool.query<{ boards: number; pending: number; attempts: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM boards WHERE id = $1) AS boards,
       (SELECT COUNT(*)::int FROM realtime_outbox WHERE published_at IS NULL AND discarded_at IS NULL) AS pending,
       (SELECT attempts FROM realtime_outbox LIMIT 1) AS attempts`,
    [created.id],
  )
  assert.deepEqual(durable.rows[0], { boards: 1, pending: 1, attempts: 1 })

  await pool.query(`UPDATE realtime_outbox SET available_at = NOW()`)
  const delivered: Array<{ channel: string; event: BroadcastEvent }> = []
  const recovered = await drainRealtimeOutbox({
    publishFn: async (channel, event) => { delivered.push({ channel, event }) },
  })
  assert.deepEqual(recovered, { claimed: 1, published: 1, failed: 0, discarded: 0 })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].event.type, 'board.changed')
  assert.ok(delivered[0].event.deliveryId)

  const done = await pool.query<{ published: boolean }>(
    `SELECT published_at IS NOT NULL AS published FROM realtime_outbox`,
  )
  assert.equal(done.rows[0]?.published, true)
})

test('[integration] concurrent board retries create one entity and one outbox event', async () => {
  const send = () => post('/boards', {
    title: 'Exactly once board',
    description: 'same normalized input',
    requestId: 'outbox-board-request-2',
  })
  const [a, b] = await Promise.all([send(), send()])
  assert.deepEqual([a.status, b.status].sort(), [200, 201])
  const [first, second] = await Promise.all([
    a.json() as Promise<{ id: string; replayed: boolean }>,
    b.json() as Promise<{ id: string; replayed: boolean }>,
  ])
  assert.equal(first.id, second.id)
  assert.deepEqual([first.replayed, second.replayed].sort(), [false, true])

  const counts = await pool.query<{ entities: number; events: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM boards WHERE creation_request_id = $1) AS entities,
       (SELECT COUNT(*)::int FROM realtime_outbox) AS events`,
    ['outbox-board-request-2'],
  )
  assert.deepEqual(counts.rows[0], { entities: 1, events: 1 })

  const conflict = await post('/boards', {
    title: 'Different input',
    requestId: 'outbox-board-request-2',
  })
  assert.equal(conflict.status, 409)
  assert.match((await conflict.json() as { error: string }).error, /different input/)
})

test('[integration] document and calendar creates replay without duplicate rows or events', async () => {
  const cases = [
    {
      path: '/documents',
      requestId: 'outbox-document-request-1',
      body: { title: 'Retry-safe doc' },
      table: 'documents',
    },
    {
      path: '/calendar/events',
      requestId: 'outbox-calendar-request-1',
      body: { title: 'Retry-safe event', startAt: '2030-01-02T03:04:05.000Z' },
      table: 'calendar_events',
    },
  ] as const

  for (const item of cases) {
    const first = await post(item.path, { ...item.body, requestId: item.requestId })
    const replay = await post(item.path, { ...item.body, requestId: item.requestId })
    assert.equal(first.status, 201)
    assert.equal(replay.status, 200)
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true)

    const rows = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${item.table} WHERE creation_request_id = $1`,
      [item.requestId],
    )
    assert.equal(rows.rows[0]?.count, 1)
  }

  const events = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM realtime_outbox`,
  )
  assert.equal(events.rows[0]?.count, 2)
})

// ── a body cut mid-emoji must not roll the transaction back ─────────────────
//
// The quote path truncates by UTF-16 code unit (`qr[0].body.slice(0, 240)`), so
// a message with a non-BMP character straddling that index yields a lone
// surrogate. JSON.stringify emits it as the ASCII escape `\ud83d`, which reaches
// Postgres intact and is refused by the jsonb cast:
//
//   ERROR:  invalid input syntax for type json
//   DETAIL: Unicode low surrogate must follow a high surrogate.
//
// Because the enqueue is inside the caller's transaction, that took the message
// with it. `messages.body` is TEXT and accepts the same bytes, so only the
// outbox half died — which is what made one emoji-bearing message permanently
// un-quotable rather than merely ugly.

/** Exactly what the quote path produces: 239 ASCII chars then an emoji, cut at 240. */
const CUT_MID_EMOJI = `${'a'.repeat(239)}\u{1F600}`.slice(0, 240)

test('[integration] a payload truncated mid-emoji still enqueues', async () => {
  assert.equal(CUT_MID_EMOJI.charCodeAt(239), 0xd83d, 'fixture no longer ends in a lone surrogate')

  const id = await enqueueBroadcast(pool, 'message:new', {
    type: 'message.new',
    conversationId: 'c-outbox',
    quoted: { body: CUT_MID_EMOJI },
  } as unknown as BroadcastEvent)

  const { rows } = await pool.query<{ body: string }>(
    `SELECT payload->'quoted'->>'body' AS body FROM realtime_outbox WHERE id = $1`,
    [id],
  )
  assert.equal(rows.length, 1, 'the row was not written')
  // The broken half is dropped, not the message: 239 readable characters survive.
  assert.equal(rows[0].body, 'a'.repeat(239))
})

test('[integration] a lone surrogate anywhere in the tree is scrubbed, not just at the top', async () => {
  // Payload fields grow over time; scrubbing lives at the single cast so a new
  // nested field cannot reintroduce this.
  const id = await enqueueBroadcast(pool, 'message:new', {
    type: 'message.new',
    conversationId: 'c-outbox',
    quoted: { body: '\ud83d', authorName: 'tail \ud83d' },
    tags: ['\ud83d', 'ok'],
  } as unknown as BroadcastEvent)

  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM realtime_outbox WHERE id = $1`, [id],
  )
  const payload = rows[0].payload as {
    quoted: { body: string; authorName: string }; tags: string[]
  }
  assert.equal(payload.quoted.body, '')
  assert.equal(payload.quoted.authorName, 'tail ')
  assert.deepEqual(payload.tags, ['', 'ok'])
})

test('[integration] a well-formed emoji is untouched', async () => {
  // The scrub must only remove UNPAIRED halves — a real emoji has to survive
  // intact or every message carrying one arrives mangled.
  const id = await enqueueBroadcast(pool, 'message:new', {
    type: 'message.new',
    conversationId: 'c-outbox',
    quoted: { body: 'ship it \u{1F680} done' },
  } as unknown as BroadcastEvent)
  const { rows } = await pool.query<{ body: string }>(
    `SELECT payload->'quoted'->>'body' AS body FROM realtime_outbox WHERE id = $1`,
    [id],
  )
  assert.equal(rows[0].body, 'ship it \u{1F680} done')
})
