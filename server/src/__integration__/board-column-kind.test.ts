/**
 * Column semantics against a real Postgres (#69).
 *
 * Two things here can only be proven with a database: the migration's backfill
 * (does an existing board get classified, and does a CUSTOM board correctly
 * stay unclassified?) and `card claim` actually advancing a card.
 *
 * The backfill is the risky half. It writes to every existing board in every
 * deployment, and a wrong guess would silently reclassify someone's workflow —
 * so the case that matters most is the one that asserts it left a custom board
 * alone.
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { BASELINE_BOARD_COLUMN_KIND_BACKFILL_SQL } from '../db/migrate.js'
import { runCli } from '../agents/cli.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function seedBoard(companyId: string, columns: Array<[string, string | null]>): Promise<{
  boardId: string; columnIds: string[]
}> {
  const boardId = `board-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO boards (id, company_id, title, created_by) VALUES ($1, $2, 'kind test', 'tester')`,
    [boardId, companyId],
  )
  const columnIds: string[] = []
  for (let i = 0; i < columns.length; i++) {
    const id = `col-${randomUUID().slice(0, 8)}`
    columnIds.push(id)
    await pool.query(
      `INSERT INTO board_columns (id, board_id, title, position, kind) VALUES ($1, $2, $3, $4, $5)`,
      [id, boardId, columns[i][0], (i + 1) * 1000, columns[i][1]],
    )
  }
  return { boardId, columnIds }
}

async function seedCard(boardId: string, columnId: string): Promise<string> {
  const id = `card-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO board_cards (id, board_id, column_id, title, position, mentions, created_by)
       VALUES ($1, $2, $3, 'ship it', 1000, '[]'::jsonb, 'tester')`,
    [id, boardId, columnId],
  )
  return id
}

const columnOf = async (cardId: string): Promise<string> =>
  (await pool.query<{ column_id: string }>(`SELECT column_id FROM board_cards WHERE id = $1`, [cardId])).rows[0].column_id

test('a board created through the CLI has its columns classified', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  // The subcommand is `kanban`, not `board` — cli.ts dispatches 'kanban' to
  // cmdBoard. Asserting on r.ok alone would have hidden the typo behind a
  // generic failure, so the message is checked too.
  const r = await runCli(['--as', agentId, 'kanban', 'create', 'Launch'])
  assert.equal(r.ok, true, r.text)

  const { rows } = await pool.query<{ title: string; kind: string | null }>(
    `SELECT bc.title, bc.kind FROM board_columns bc
       JOIN boards b ON b.id = bc.board_id
      WHERE b.company_id = $1 ORDER BY bc.position ASC`,
    [companyId],
  )
  assert.deepEqual(rows.map((c) => [c.title, c.kind]), [['Todo', 'todo'], ['Doing', 'doing'], ['Done', 'done']])
})

test('claiming a card in Todo advances it to Doing', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const { boardId, columnIds } = await seedBoard(companyId, [['Todo', 'todo'], ['Doing', 'doing'], ['Done', 'done']])
  const card = await seedCard(boardId, columnIds[0])

  const r = await runCli(['--as', agentId, 'card', 'claim', card])
  assert.equal(r.ok, true, r.text)
  assert.equal(await columnOf(card), columnIds[1])
  assert.match(r.text, /moved to Doing/)
})

test('claiming a finished card leaves it in Done', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const { boardId, columnIds } = await seedBoard(companyId, [['Todo', 'todo'], ['Doing', 'doing'], ['Done', 'done']])
  const card = await seedCard(boardId, columnIds[2])

  const r = await runCli(['--as', agentId, 'card', 'claim', card])
  assert.equal(r.ok, true, r.text)
  assert.equal(await columnOf(card), columnIds[2], 'a claim must never drag a finished card backwards')
  assert.doesNotMatch(r.text, /moved to Doing/)
})

test('claiming on a custom board moves nothing', async () => {
  // Unclassified columns are the signal that we do not understand this
  // workflow — the card must stay exactly where the humans put it.
  const { companyId, agentId } = await seedCompanyWithAgent()
  const { boardId, columnIds } = await seedBoard(companyId, [['Backlog', null], ['In flight', null], ['Shipped', null]])
  const card = await seedCard(boardId, columnIds[0])

  const r = await runCli(['--as', agentId, 'card', 'claim', card])
  assert.equal(r.ok, true, r.text)
  assert.equal(await columnOf(card), columnIds[0])
})

test('the migration classifies conventional columns and leaves custom ones alone', async () => {
  // Simulates a board that predates the feature: kind is NULL everywhere.
  const { companyId } = await seedCompanyWithAgent()
  const conventional = await seedBoard(companyId, [['Todo', null], ['Doing', null], ['Done', null]])
  const custom = await seedBoard(companyId, [['Backlog', null], ['In flight', null], ['Shipped', null]])
  const spaced = await seedBoard(companyId, [['  To Do  ', null]])

  // Exercise the exact frozen migration-0001 backfill without replaying the
  // versioned migration ledger (applied migrations must never run again).
  await pool.query(BASELINE_BOARD_COLUMN_KIND_BACKFILL_SQL)

  const kinds = async (ids: string[]): Promise<Array<string | null>> => {
    const { rows } = await pool.query<{ id: string; kind: string | null }>(
      `SELECT id, kind FROM board_columns WHERE id = ANY($1::text[])`, [ids],
    )
    const byId = new Map(rows.map((r) => [r.id, r.kind]))
    return ids.map((i) => byId.get(i) ?? null)
  }

  assert.deepEqual(await kinds(conventional.columnIds), ['todo', 'doing', 'done'])
  assert.deepEqual(await kinds(custom.columnIds), [null, null, null], 'a custom workflow must not be guessed at')
  assert.deepEqual(await kinds(spaced.columnIds), ['todo'], 'padding and case must not defeat the match')
})

test('the backfill does not overwrite a column that already has a kind', async () => {
  // Someone classified "Done" as todo on purpose; a later migration run must
  // not undo that choice.
  const { companyId } = await seedCompanyWithAgent()
  const { columnIds } = await seedBoard(companyId, [['Done', 'todo']])

  await pool.query(BASELINE_BOARD_COLUMN_KIND_BACKFILL_SQL)

  const { rows } = await pool.query<{ kind: string | null }>(
    `SELECT kind FROM board_columns WHERE id = $1`, [columnIds[0]],
  )
  assert.equal(rows[0].kind, 'todo')
})
