import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { pool } from '../db/pool.js'
import { runCli } from '../agents/cli.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, seedUserMembership, teardownAll } from './_helpers.js'

const USER_ID = 'u-due-owner'
let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(USER_ID)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })
})
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll(server) })

async function request(companyId: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'x-company-id': companyId, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

test('API and CLI share a date-only value; overdue query distinguishes done and unclassified columns', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  await seedUserMembership(USER_ID, companyId, { email: 'due-owner@test.local', displayName: 'Due Owner' })
  const boardCreated = await request(companyId, '/boards', 'POST', { title: 'Deadlines' })
  assert.equal(boardCreated.status, 201)
  const { id: boardId } = await boardCreated.json() as { id: string }
  const board = await (await request(companyId, `/boards/${boardId}`)).json() as {
    columns: Array<{ id: string; kind: string | null }>
  }
  const todo = board.columns.find((column) => column.kind === 'todo')!.id
  const done = board.columns.find((column) => column.kind === 'done')!.id
  const invalidCreate = await request(companyId, `/boards/${boardId}/cards`, 'POST', {
    title: 'Bad deadline', columnId: todo, dueOn: '2026-04-31',
  })
  assert.equal(invalidCreate.status, 400)
  const created = await request(companyId, `/boards/${boardId}/cards`, 'POST', {
    title: 'Send proposal', columnId: todo, dueOn: '2026-09-23',
  })
  assert.equal(created.status, 200)
  const { id: cardId } = await created.json() as { id: string }
  const lookup = await (await request(companyId, `/cards/${cardId}`)).json() as {
    card: { dueOn: string | null }; column: { kind: string | null }
  }
  assert.equal(lookup.card.dueOn, '2026-09-23')
  assert.equal(lookup.column.kind, 'todo')

  const invalid = await request(companyId, `/boards/${boardId}/cards/${cardId}`, 'PATCH', { dueOn: '2026-02-29' })
  assert.equal(invalid.status, 400)
  assert.equal((await request(companyId, `/boards/${boardId}/cards/${cardId}`, 'PATCH', { title: 'Proposal' })).status, 200)
  const unchanged = await (await request(companyId, `/boards/${boardId}`)).json() as { cards: Array<{ dueOn: string | null }> }
  assert.equal(unchanged.cards[0].dueOn, '2026-09-23')

  const overdue = await runCli(['--as', agentId, 'card', 'ls', boardId, '--overdue-as-of', '2026-09-24', '--json'])
  assert.equal(overdue.ok, true, overdue.text)
  assert.deepEqual((JSON.parse(overdue.text) as Array<{ id: string }>).map((card) => card.id), [cardId])
  const moved = await request(companyId, `/boards/${boardId}/cards/${cardId}`, 'PATCH', { columnId: done })
  assert.equal(moved.status, 200)
  const completed = await runCli(['--as', agentId, 'card', 'ls', boardId, '--overdue-as-of', '2026-09-24', '--json'])
  assert.equal(completed.ok, true, completed.text)
  assert.deepEqual(JSON.parse(completed.text), [])

  const otherColumn = await runCli(['--as', agentId, 'kanban', 'add-column', boardId, 'Review'])
  assert.equal(otherColumn.ok, true, otherColumn.text)
  const reviewColumn = (await pool.query<{ id: string }>(
    `SELECT id FROM board_columns WHERE board_id = $1 AND title = 'Review'`, [boardId],
  )).rows[0].id
  const added = await runCli(['--as', agentId, 'card', 'add', boardId, 'Review draft', '--column', reviewColumn, '--due', '2026-09-22'])
  assert.equal(added.ok, true, added.text)
  const reviewCardId = (await pool.query<{ id: string }>(
    `SELECT id FROM board_cards WHERE board_id = $1 AND column_id = $2`, [boardId, reviewColumn],
  )).rows[0].id
  const reviewLookup = await (await request(companyId, `/cards/${reviewCardId}`)).json() as {
    card: { dueOn: string | null }; column: { kind: string | null }
  }
  assert.equal(reviewLookup.card.dueOn, '2026-09-22')
  assert.equal(reviewLookup.column.kind, null)
  const unknownColumn = await runCli(['--as', agentId, 'card', 'ls', boardId, '--overdue-as-of', '2026-09-24', '--json'])
  assert.equal(unknownColumn.ok, true, unknownColumn.text)
  assert.deepEqual(
    (JSON.parse(unknownColumn.text) as Array<{ id: string; column_kind: string | null; due_status: string }>).map((card) => [card.id, card.column_kind, card.due_status]),
    [[reviewCardId, null, 'status_unknown']],
  )
  const unknownText = await runCli(['--as', agentId, 'card', 'ls', boardId, '--overdue-as-of', '2026-09-24'])
  assert.match(unknownText.text, /column status unknown/)
  assert.equal((await request(companyId, `/boards/${boardId}/columns/${reviewColumn}`, 'PATCH', { kind: 'done' })).status, 200)
  const classifiedDone = await runCli(['--as', agentId, 'card', 'ls', boardId, '--overdue-as-of', '2026-09-24', '--json'])
  assert.deepEqual(JSON.parse(classifiedDone.text), [])
  assert.equal((await request(companyId, `/boards/${boardId}/columns/${reviewColumn}`, 'PATCH', { kind: 'doing' })).status, 200)
  const classifiedDoing = await runCli(['--as', agentId, 'card', 'ls', boardId, '--overdue-as-of', '2026-09-24', '--json'])
  assert.deepEqual(
    (JSON.parse(classifiedDoing.text) as Array<{ id: string; due_status: string }>).map((card) => [card.id, card.due_status]),
    [[reviewCardId, 'overdue']],
  )

  const apiClear = await request(companyId, `/boards/${boardId}/cards/${cardId}`, 'PATCH', { dueOn: null })
  assert.equal(apiClear.status, 200)
  const clearedByApi = await (await request(companyId, `/cards/${cardId}`)).json() as { card: { dueOn: string | null } }
  assert.equal(clearedByApi.card.dueOn, null)

  const set = await runCli(['--as', agentId, 'card', 'due', cardId, '2026-09-25'])
  assert.equal(set.ok, true, set.text)
  assert.deepEqual(set.sideEffects, [{
    event: 'kanban.card_updated', command: 'card due', boardId, cardId,
    actorId: agentId, companyId, dueOn: '2026-09-25', visibleToUser: true,
  }])
  assert.equal((await pool.query<{ due_on: string | null }>(`SELECT due_on::text AS due_on FROM board_cards WHERE id = $1`, [cardId])).rows[0].due_on, '2026-09-25')
  const clear = await runCli(['--as', agentId, 'card', 'due', cardId, 'clear'])
  assert.equal(clear.ok, true, clear.text)
  assert.equal(clear.sideEffects?.[0]?.event, 'kanban.card_updated')
  assert.equal((await pool.query<{ due_on: string | null }>(`SELECT due_on::text AS due_on FROM board_cards WHERE id = $1`, [cardId])).rows[0].due_on, null)
})
