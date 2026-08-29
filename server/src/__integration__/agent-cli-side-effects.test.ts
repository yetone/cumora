import { test, before, beforeEach, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import {
  ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll,
} from './_helpers.js'
import { runCli } from '../agents/cli.js'
import { __setKanbanWakeAgentForTesting } from '../agents/kanban-wake.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
})

afterEach(() => {
  __setKanbanWakeAgentForTesting(null)
})

after(async () => {
  await teardownAll()
})

test('[integration] tasks add/set emit typed CLI side effects', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()

  const add = await runCli(['--as', agentId, 'tasks', 'add', 'Ship typed side effects'])
  assert.equal(add.ok, true, `tasks add failed: ${add.text}`)
  assert.equal(add.sideEffects?.length, 1)
  const taskId = String(add.sideEffects?.[0]?.taskId ?? '')
  assert.match(taskId, /^task-/)
  assert.deepEqual(add.sideEffects, [{
    event: 'task.created',
    command: 'tasks add',
    taskId,
    agentId,
    companyId,
    title: 'Ship typed side effects',
    status: 'open',
    visibleToUser: true,
  }])

  const set = await runCli(['--as', agentId, 'tasks', 'set', taskId, 'done'])
  assert.equal(set.ok, true, `tasks set failed: ${set.text}`)
  assert.deepEqual(set.sideEffects, [{
    event: 'task.status_changed',
    command: 'tasks set',
    taskId,
    agentId,
    companyId,
    status: 'done',
    visibleToUser: true,
  }])
})

test('[integration] calendar create/cancel/delete emit typed CLI side effects', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const startAt = '2026-06-01T10:00:00.000Z'

  const create = await runCli([
    '--as', agentId,
    'calendar', 'create', 'Review harness',
    '--at', startAt,
    '--assignee', agentId,
    '--prompt', 'Run the review',
    '--kind', 'agent_task',
    '--remind', '10',
    '--remind-channel', 'toast',
  ])
  assert.equal(create.ok, true, `calendar create failed: ${create.text}`)
  assert.equal(create.sideEffects?.length, 1)
  const calendarEventId = String(create.sideEffects?.[0]?.calendarEventId ?? '')
  assert.match(calendarEventId, /^ce-/)
  assert.deepEqual(create.sideEffects, [{
    event: 'calendar.event_created',
    command: 'calendar create',
    calendarEventId,
    actorId: agentId,
    companyId,
    title: 'Review harness',
    kind: 'agent_task',
    assigneeId: agentId,
    targetConversationId: null,
    startAt,
    recurrence: null,
    reminderMinutesBefore: 10,
    reminderChannel: 'toast',
    visibleToUser: true,
  }])

  const updatedAt = '2026-06-01T11:30:00.000Z'
  const update = await runCli([
    '--as', agentId,
    'calendar', 'update', calendarEventId,
    '--title', 'Review harness deeply',
    '--at', updatedAt,
    '--status', 'active',
  ])
  assert.equal(update.ok, true, `calendar update failed: ${update.text}`)
  assert.deepEqual(update.sideEffects, [{
    event: 'calendar.event_updated',
    command: 'calendar update',
    calendarEventId,
    actorId: agentId,
    companyId,
    title: 'Review harness deeply',
    kind: 'agent_task',
    status: 'active',
    assigneeId: agentId,
    targetConversationId: null,
    startAt: updatedAt,
    visibleToUser: true,
  }])

  const cancel = await runCli(['--as', agentId, 'calendar', 'cancel', calendarEventId])
  assert.equal(cancel.ok, true, `calendar cancel failed: ${cancel.text}`)
  assert.deepEqual(cancel.sideEffects, [{
    event: 'calendar.event_cancelled',
    command: 'calendar cancel',
    calendarEventId,
    actorId: agentId,
    companyId,
    visibleToUser: true,
  }])

  const del = await runCli(['--as', agentId, 'calendar', 'delete', calendarEventId])
  assert.equal(del.ok, true, `calendar delete failed: ${del.text}`)
  assert.deepEqual(del.sideEffects, [{
    event: 'calendar.event_deleted',
    command: 'calendar delete',
    calendarEventId,
    actorId: agentId,
    companyId,
    visibleToUser: true,
  }])
})

test('[integration] doc delete emits typed CLI side effect and removes the document', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()

  const create = await runCli(['--as', agentId, 'doc', 'create', 'Harness Notes'])
  assert.equal(create.ok, true, `doc create failed: ${create.text}`)
  const documentId = String(create.sideEffects?.[0]?.documentId ?? '')
  assert.match(documentId, /^doc_/)

  const del = await runCli(['--as', agentId, 'doc', 'delete', documentId])
  assert.equal(del.ok, true, `doc delete failed: ${del.text}`)
  assert.deepEqual(del.sideEffects, [{
    event: 'document.deleted',
    command: 'doc delete',
    documentId,
    actorId: agentId,
    companyId,
    visibleToUser: true,
  }])

  const { rowCount } = await pool.query(`SELECT 1 FROM documents WHERE id = $1`, [documentId])
  assert.equal(rowCount, 0)
})

test('[integration] kanban board/column/comment parity emits typed CLI side effects', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()

  const create = await runCli(['--as', agentId, 'kanban', 'create', 'Ops Board', '--description', 'Initial'])
  assert.equal(create.ok, true, `kanban create failed: ${create.text}`)
  const boardId = String(create.sideEffects?.[0]?.boardId ?? '')
  assert.match(boardId, /^board-/)

  const rename = await runCli([
    '--as', agentId,
    'kanban', 'rename', boardId,
    '--title', 'Ops Board v2',
    '--description', 'Updated',
  ])
  assert.equal(rename.ok, true, `kanban rename failed: ${rename.text}`)
  assert.deepEqual(rename.sideEffects, [{
    event: 'kanban.board_updated',
    command: 'kanban rename',
    boardId,
    actorId: agentId,
    companyId,
    title: 'Ops Board v2',
    description: 'Updated',
    visibleToUser: true,
  }])

  const addColumn = await runCli(['--as', agentId, 'kanban', 'add-column', boardId, 'Review'])
  assert.equal(addColumn.ok, true, `kanban add-column failed: ${addColumn.text}`)
  const columnId = String(addColumn.sideEffects?.[0]?.columnId ?? '')
  assert.match(columnId, /^col-/)

  const editColumn = await runCli([
    '--as', agentId,
    'kanban', 'edit-column', boardId, columnId,
    '--title', 'QA',
    '--position', '2500',
  ])
  assert.equal(editColumn.ok, true, `kanban edit-column failed: ${editColumn.text}`)
  assert.deepEqual(editColumn.sideEffects, [{
    event: 'kanban.column_updated',
    command: 'kanban edit-column',
    boardId,
    columnId,
    actorId: agentId,
    companyId,
    title: 'QA',
    position: 2500,
    visibleToUser: true,
  }])

  const addCard = await runCli(['--as', agentId, 'card', 'add', boardId, 'Check harness', '--column', columnId])
  assert.equal(addCard.ok, true, `card add failed: ${addCard.text}`)
  const cardId = String(addCard.sideEffects?.[0]?.cardId ?? '')
  assert.match(cardId, /^card-/)

  const comment = await runCli(['--as', agentId, 'card', 'comment', cardId, 'Looks good'])
  assert.equal(comment.ok, true, `card comment failed: ${comment.text}`)
  const commentId = String(comment.sideEffects?.[0]?.commentId ?? '')
  assert.match(commentId, /^cmt-/)

  const deleteComment = await runCli(['--as', agentId, 'card', 'delete-comment', cardId, commentId])
  assert.equal(deleteComment.ok, true, `card delete-comment failed: ${deleteComment.text}`)
  assert.deepEqual(deleteComment.sideEffects, [{
    event: 'kanban.comment_deleted',
    command: 'card delete-comment',
    boardId,
    cardId,
    commentId,
    actorId: agentId,
    companyId,
    visibleToUser: true,
  }])

  const deleteColumn = await runCli(['--as', agentId, 'kanban', 'delete-column', boardId, columnId])
  assert.equal(deleteColumn.ok, true, `kanban delete-column failed: ${deleteColumn.text}`)
  assert.deepEqual(deleteColumn.sideEffects, [{
    event: 'kanban.column_deleted',
    command: 'kanban delete-column',
    boardId,
    columnId,
    actorId: agentId,
    companyId,
    visibleToUser: true,
  }])
})

test('[integration] every agent CLI Kanban wake carries its card brief', async () => {
  const { companyId, agentId: actorId } = await seedCompanyWithAgent()
  const targetId = `target-${Date.now().toString(36)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'agent', 'Target Agent', 'tester', 'T', '#abcdef', 'avail')`,
    [targetId, companyId],
  )

  const wakes: Array<{
    agentId: string
    reason: string
    conversationId: string | null
    brief: { source?: string; title: string; body: string }
  }> = []
  __setKanbanWakeAgentForTesting(async (agentId, reason, conversationId, _steer, options) => {
    wakes.push({ agentId, reason, conversationId, brief: options.backgroundBrief })
  })
  const waitForWakes = async (count: number): Promise<void> => {
    for (let i = 0; i < 100 && wakes.length < count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(wakes.length, count, `expected ${count} Kanban wake(s), got ${wakes.length}`)
  }

  const board = await runCli(['--as', actorId, 'kanban', 'create', 'Wake Board'])
  assert.equal(board.ok, true, board.text)
  const boardId = String(board.sideEffects?.[0]?.boardId ?? '')
  const { rows: columns } = await pool.query<{ id: string }>(
    `SELECT id FROM board_columns WHERE board_id = $1 ORDER BY position ASC LIMIT 1`,
    [boardId],
  )
  const columnId = columns[0].id

  const mentioned = await runCli([
    '--as', actorId, 'card', 'add', boardId, `@${targetId} investigate`, '--column', columnId,
  ])
  assert.equal(mentioned.ok, true, mentioned.text)
  const cardId = String(mentioned.sideEffects?.[0]?.cardId ?? '')
  await waitForWakes(1)

  const assigned = await runCli(['--as', actorId, 'card', 'assign', cardId, targetId])
  assert.equal(assigned.ok, true, assigned.text)
  await waitForWakes(2)

  const edited = await runCli([
    '--as', actorId, 'card', 'edit', cardId, '--description', `@${targetId} please revisit`,
  ])
  assert.equal(edited.ok, true, edited.text)
  await waitForWakes(3)

  const commented = await runCli([
    '--as', actorId, 'card', 'comment', cardId, `@${targetId} new evidence`,
  ])
  assert.equal(commented.ok, true, commented.text)
  await waitForWakes(4)

  const createdAssigned = await runCli([
    '--as', actorId, 'card', 'add', boardId, 'Assigned directly', '--column', columnId,
    '--assign', targetId,
  ])
  assert.equal(createdAssigned.ok, true, createdAssigned.text)
  await waitForWakes(5)

  assert.deepEqual(wakes.map((wake) => ({
    agentId: wake.agentId,
    reason: wake.reason,
    conversationId: wake.conversationId,
    source: wake.brief.source,
  })), Array.from({ length: 5 }, () => ({
    agentId: targetId,
    reason: 'manual',
    conversationId: null,
    source: 'kanban',
  })))
  for (const wake of wakes) {
    assert.match(wake.brief.body, /card id: card-/)
    assert.match(wake.brief.body, /board id: board-/)
    assert.match(wake.brief.body, /cumora card claim card-/)
  }
})
