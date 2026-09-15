/**
 * `cumora doc create --body` has to reach the database.
 *
 * The CLI runs the whole command in one transaction, inserts the `documents`
 * row on that client, and then seeds the body through `applyAgentEdit`. The
 * room's update hook persisted that seed with the GLOBAL pool — a different
 * connection, which cannot see the still-uncommitted parent row. Postgres does
 * not wait for it either: there is no row to lock, so the FK check fails
 * immediately. The failure was swallowed by `console.warn('[docs]
 * persistUpdate failed')` while the CLI returned ok with `bodyLength` set.
 *
 * Nothing looked wrong afterwards. The in-memory room still held the body, and
 * agent paths never subscribe, so they are never evicted — `doc read` and every
 * browser on that instance served the body from RAM until the process died.
 *
 * And the damage was not limited to the body: the seed is the parent struct for
 * everything appended later, so subsequent edits persisted as rows that can
 * never integrate. Measured before the fix: 11 of 20 creates lost the body, and
 * on a lost one a later `doc append` wrote its row and the cold document still
 * rendered as "".
 *
 * These loop because the underlying defect is a race between the seed's INSERT
 * and the command's COMMIT. One run reproduces it only about half the time;
 * ten runs make both directions decisive.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'
import { runCli } from '../agents/cli.js'

const RUNS = 10

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

/** A live server always has idle pooled connections; a cold pool hides the race
 *  because the seed has to pay a fresh TCP + SCRAM handshake first. */
async function warmPool(): Promise<void> {
  await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 1'), pool.query('SELECT 1')])
}

function documentIdOf(text: string): string {
  const id = (text.match(/doc_[0-9a-f]+/) ?? [])[0]
  assert.ok(id, `no document id in CLI output: ${text}`)
  return id
}

/** What a restart does: drop the in-memory room and rebuild from the DB. */
async function coldRead(documentId: string): Promise<string> {
  const { evictDocumentRoom, readDocumentText } = await import('../documents/rooms.js')
  evictDocumentRoom(documentId)
  return String(await readDocumentText(documentId, 'x'))
}

test('[integration] doc create --body persists the body, every time', async () => {
  const { agentId } = await seedCompanyWithAgent()
  await warmPool()

  const missing: string[] = []
  for (let i = 0; i < RUNS; i++) {
    const res = await runCli(['--as', agentId, 'doc', 'create', `Doc ${i}`, '--body', `BODY-${i}`])
    assert.equal(res.ok, true, res.text)
    const id = documentIdOf(res.text)
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM document_updates WHERE document_id = $1`, [id],
    )
    if (rows[0].n === 0) missing.push(id)
  }

  assert.deepEqual(
    missing, [],
    `${missing.length}/${RUNS} bodies were reported as created and never written to document_updates`,
  )
})

test('[integration] the body is still there after a restart', async () => {
  const { agentId } = await seedCompanyWithAgent()
  await warmPool()

  for (let i = 0; i < RUNS; i++) {
    const res = await runCli(['--as', agentId, 'doc', 'create', `Doc ${i}`, '--body', `BODY-${i}`])
    const id = documentIdOf(res.text)
    assert.match(
      await coldRead(id), new RegExp(`BODY-${i}`),
      `the document is empty on a cold load although the CLI reported it created (run ${i})`,
    )
  }
})

test('[integration] work appended later survives too', async () => {
  // The severity multiplier: an unpersisted seed makes every later edit an
  // unintegratable Yjs struct, so a `doc append` that returns ok and writes its
  // own row still renders as nothing.
  const { agentId } = await seedCompanyWithAgent()
  await warmPool()

  for (let i = 0; i < RUNS; i++) {
    const res = await runCli(['--as', agentId, 'doc', 'create', `Doc ${i}`, '--body', `BODY-${i}`])
    const id = documentIdOf(res.text)
    const appended = await runCli(['--as', agentId, 'doc', 'append', id, 'LATER-WORK'])
    assert.equal(appended.ok, true, appended.text)

    const cold = await coldRead(id)
    assert.match(cold, /LATER-WORK/, `work appended after the create is gone on a cold load (run ${i})`)
    assert.match(cold, new RegExp(`BODY-${i}`), `the create body is gone on a cold load (run ${i})`)
  }
})

test('[integration] a doc created without --body still works', async () => {
  // The guard rail: the transactional path must not break the ordinary create,
  // which produces no seed update at all.
  const { agentId } = await seedCompanyWithAgent()
  await warmPool()

  const res = await runCli(['--as', agentId, 'doc', 'create', 'Empty One'])
  assert.equal(res.ok, true, res.text)
  const id = documentIdOf(res.text)

  const appended = await runCli(['--as', agentId, 'doc', 'append', id, 'FIRST-CONTENT'])
  assert.equal(appended.ok, true, appended.text)
  assert.match(await coldRead(id), /FIRST-CONTENT/)
})
