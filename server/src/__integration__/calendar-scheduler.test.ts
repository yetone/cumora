import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { tickCalendar } from '../calendar.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll()
})

const COMPANY_ID = 'co-calendar-test'
const USER_ID = 'u-calendar-test'

async function seedFixture() {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, 'Calendar Co', $1, $2)`,
    [COMPANY_ID, USER_ID],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', 'Tester', 'T', '#abcdef', 'avail')`,
    [USER_ID, COMPANY_ID],
  )
}

test('[integration] calendar: fast-forwards stale recurring event in a single step to due slot', async () => {
  await seedFixture()
  const eventId = 'ev-stale-daily'
  // Event started 10 days ago at 10:00:00Z, recurs daily
  const startAt = new Date('2026-06-05T10:00:00.000Z')
  const now = new Date('2026-06-15T10:05:00.000Z') // 10 days later, 5 min past slot

  await pool.query(
    `INSERT INTO calendar_events (
       id, company_id, created_by, kind, title, start_at, recurrence, status
     ) VALUES ($1, $2, $3, 'personal', 'Daily Sync', $4, $5::jsonb, 'active')`,
    [eventId, COMPANY_ID, USER_ID, startAt, JSON.stringify({ freq: 'daily', interval: 1 })],
  )

  // Single tick must fast-forward directly to today (2026-06-15) instead of slow-crawling
  const res = await tickCalendar(now)
  assert.equal(res.scanned, 1)

  const { rows } = await pool.query<{ last_fired_at: Date; status: string }>(
    `SELECT last_fired_at, status FROM calendar_events WHERE id = $1`, [eventId],
  )
  assert.equal(rows[0]?.status, 'active')
  assert.equal(rows[0]?.last_fired_at?.toISOString(), '2026-06-15T10:00:00.000Z')
})

test('[integration] calendar: fast-forwards stale recurring event to future slot without firing', async () => {
  await seedFixture()
  const eventId = 'ev-stale-future'
  // Event started 10 days ago at 10:00:00Z, recurs daily
  const startAt = new Date('2026-06-05T10:00:00.000Z')
  const now = new Date('2026-06-15T15:00:00.000Z') // 5 hours past today's slot (> 1 hour)

  await pool.query(
    `INSERT INTO calendar_events (
       id, company_id, created_by, kind, title, start_at, recurrence, status
     ) VALUES ($1, $2, $3, 'personal', 'Daily Sync', $4, $5::jsonb, 'active')`,
    [eventId, COMPANY_ID, USER_ID, startAt, JSON.stringify({ freq: 'daily', interval: 1 })],
  )

  // Single tick must fast-forward last_fired_at to now without slow-crawling
  const res = await tickCalendar(now)
  assert.equal(res.scanned, 1)

  const { rows } = await pool.query<{ last_fired_at: Date; status: string }>(
    `SELECT last_fired_at, status FROM calendar_events WHERE id = $1`, [eventId],
  )
  assert.equal(rows[0]?.status, 'active')
  assert.equal(rows[0]?.last_fired_at?.toISOString(), '2026-06-15T15:00:00.000Z')

  // Next tick at 15:01: waits for tomorrow's slot without firing
  const resNext = await tickCalendar(new Date('2026-06-15T15:01:00.000Z'))
  assert.equal(resNext.scanned, 1)
  assert.equal(resNext.fired, 0)
})

test('[integration] calendar: expired one-shot event is marked done in a single step', async () => {
  await seedFixture()
  const eventId = 'ev-expired-oneshot'
  // One-shot event scheduled 3 hours ago (> 1 hour)
  const startAt = new Date('2026-06-15T07:00:00.000Z')
  const now = new Date('2026-06-15T10:00:00.000Z')

  await pool.query(
    `INSERT INTO calendar_events (
       id, company_id, created_by, kind, title, start_at, recurrence, status
     ) VALUES ($1, $2, $3, 'personal', 'One-Shot Meeting', $4, NULL, 'active')`,
    [eventId, COMPANY_ID, USER_ID, startAt],
  )

  const res = await tickCalendar(now)
  assert.equal(res.scanned, 1)
  assert.equal(res.fired, 0)

  const { rows } = await pool.query<{ last_fired_at: Date; status: string }>(
    `SELECT last_fired_at, status FROM calendar_events WHERE id = $1`, [eventId],
  )
  assert.equal(rows[0]?.status, 'done')
})

test('[integration] calendar: recurring event with past until date is marked done in a single step', async () => {
  await seedFixture()
  const eventId = 'ev-expired-until'
  // Recurring event whose until date passed 5 days ago
  const startAt = new Date('2026-06-01T10:00:00.000Z')
  const now = new Date('2026-06-15T10:00:00.000Z')

  await pool.query(
    `INSERT INTO calendar_events (
       id, company_id, created_by, kind, title, start_at, recurrence, status
     ) VALUES ($1, $2, $3, 'personal', 'Temporary Sync', $4, $5::jsonb, 'active')`,
    [eventId, COMPANY_ID, USER_ID, startAt, JSON.stringify({ freq: 'daily', interval: 1, until: '2026-06-05T10:00:00.000Z' })],
  )

  const res = await tickCalendar(now)
  assert.equal(res.scanned, 1)
  assert.equal(res.fired, 0)

  const { rows } = await pool.query<{ last_fired_at: Date; status: string }>(
    `SELECT last_fired_at, status FROM calendar_events WHERE id = $1`, [eventId],
  )
  assert.equal(rows[0]?.status, 'done')
})
