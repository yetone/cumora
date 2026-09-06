/**
 * Integration tests for index-backed global message search (migration 0005).
 *
 * The contract under test is not "an index exists" — `schema-migrations.test.ts`
 * already asserts every promotion-required index is valid/ready/live. It is
 * that the planner can actually USE `idx_messages_body_trgm` for the predicate
 * the search route issues, and that making the query index-backed did not
 * change a single result.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'
import { pool } from '../db/pool.js'

const ME_USER_ID = 'u-searcher'
const COMPANY_ID = 'c-search-trgm'
const CONVERSATION_ID = 'g-search-trgm'
let server: Server
let baseUrl = ''

interface SearchResponse {
  messages: Array<{ id: string; snippet: string }>
  participants: Array<{ id: string }>
}

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(ME_USER_ID)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, 'Search Co', 'search-co', $2)`,
    [COMPANY_ID, ME_USER_ID],
  )
  await seedUserMembership(ME_USER_ID, COMPANY_ID, { displayName: 'Searcher' })
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, company_id)
     VALUES ($1, 'group', 'Search room', $2::jsonb, $3)`,
    [CONVERSATION_ID, JSON.stringify([ME_USER_ID]), COMPANY_ID],
  )
})

after(async () => { await teardownAll(server) })

async function seedMessages(bodies: string[]): Promise<void> {
  let sequence = 1
  for (const body of bodies) {
    await pool.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [`m-${sequence}`, CONVERSATION_ID, ME_USER_ID, body, sequence, COMPANY_ID],
    )
    sequence += 1
  }
}

async function search(q: string): Promise<SearchResponse> {
  const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(q)}`, {
    headers: { 'x-company-id': COMPANY_ID },
  })
  assert.equal(res.status, 200)
  return await res.json() as SearchResponse
}

test('[integration] the planner can serve a body ILIKE from the trigram index', async () => {
  await seedMessages(['the quarterly contract is attached', 'unrelated chatter'])
  // A handful of rows fits in one page, so a seq scan is genuinely the cheaper
  // plan and the planner will (correctly) pick it. Disabling seq scans asks the
  // question we actually care about: is this index a *usable* path for
  // `body ILIKE '%…%'` at all? Before pg_trgm the answer was no at any size,
  // and the query degraded to O(messages) on production-sized tables.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // TRUNCATE in resetAllTables() leaves stale reltuples behind; give the
    // planner real numbers so the choice below is about path availability.
    await client.query('ANALYZE messages')
    await client.query('SET LOCAL enable_seqscan = off')
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM messages
        WHERE kind = 'text' AND body ILIKE $1 ESCAPE '\\'`,
      ['%contract%'],
    )
    await client.query('COMMIT')
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    assert.match(plan, /idx_messages_body_trgm/,
      `body ILIKE must be answerable from the trigram index. Plan was:\n${plan}`)
  } finally {
    client.release()
  }
})

test('[integration] search results are unchanged by the index, including CJK and escapes', async () => {
  await seedMessages([
    'the quarterly contract is attached',
    '这是第一季度的合同草案',
    'literal 100% match rate',
    'unrelated chatter',
  ])

  const ascii = await search('contract')
  assert.deepEqual(ascii.messages.map((m) => m.id), ['m-1'])

  // A CJK term is three characters, so it has a complete trigram and rides the
  // same index path as ASCII.
  const cjk = await search('合同草案')
  assert.deepEqual(cjk.messages.map((m) => m.id), ['m-2'])

  // `%` is escaped, not treated as a wildcard: it must match the literal only.
  const literalPercent = await search('100%')
  assert.deepEqual(literalPercent.messages.map((m) => m.id), ['m-3'])

  // A term nobody used returns nothing rather than everything.
  const miss = await search('zzzznotpresent')
  assert.deepEqual(miss.messages, [])
})

test('[integration] a single-character query skips the message bucket, not the whole search', async () => {
  await seedMessages(['the quarterly contract is attached'])

  const single = await search('S')
  // One character yields no complete trigram, so the bucket would be a full
  // scan whose top rows are just "the newest messages" — no answer to anything.
  assert.deepEqual(single.messages, [], 'one character must not scan message bodies')
  // The other buckets are small, indexed tables and stay useful.
  assert.deepEqual(single.participants.map((p) => p.id), [ME_USER_ID])

  // Two characters is the floor, because CJK terms are commonly that short.
  const pair = await search('co')
  assert.deepEqual(pair.messages.map((m) => m.id), ['m-1'])
})
