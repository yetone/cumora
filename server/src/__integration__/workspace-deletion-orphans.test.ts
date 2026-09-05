/**
 * Deleting a workspace has to take the agents' data with it.
 *
 * The purge sweeps a list of soft-scoped tables with
 * `DELETE FROM <t> WHERE company_id = $1`. That is only as good as the
 * company_id the writers put there, and two of them do not put one:
 *
 *   agent_workspace  the agent's own filesystem endpoint (fs-endpoints.ts)
 *                    wrote (agent_id, path, body, meta) and no tenant, so the
 *                    column stayed NULL — while every other writer of that
 *                    table (skills.ts, cli.ts, router.ts) supplies it.
 *   agent_climate    the column carries DEFAULT 'personal' and NEITHER of its
 *                    two INSERT sites names it, so every climate row in every
 *                    workspace is labelled 'personal'.
 *
 * Both survive a `company_id = $1` sweep. What is left behind is an agent's
 * memory files and its written notes about the people it worked with, for a
 * workspace the owner deleted.
 *
 * The existing purge test does not catch this because it seeds its rows with a
 * correct company_id — the shape the broken writers never produce. These seed
 * rows the way the real writers do.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { pool } from '../db/pool.js'
import { drainWorkspaceCleanupJobs } from '../workspace-cleanup.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

const OWNER_ID = 'u-orphan-owner'
const COMPANY_ID = 'co-orphan'
const AGENT_ID = 'agent-orphan'
let ownerServer: Server
let ownerBase = ''

before(async () => {
  await ensureSchemaOnce()
  const app = await buildApiTestApp(OWNER_ID)
  await new Promise<void>((resolve) => {
    ownerServer = createServer(app).listen(0, () => {
      const address = ownerServer.address()
      assert.ok(address && typeof address === 'object')
      ownerBase = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })

})

beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll(ownerServer) })

/** A workspace the owner can actually delete: they must have another one, or
 *  the route refuses ("cannot delete your only workspace"). */
async function seedDeletableWorkspace(): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier) VALUES ($1, $2, $1, 'pro')`,
    [OWNER_ID, `${OWNER_ID}@test.local`],
  )
  for (const [id, slug] of [[COMPANY_ID, COMPANY_ID], ['co-orphan-other', 'co-orphan-other']]) {
    await pool.query(
      `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
      [id, `Workspace ${id}`, slug, OWNER_ID],
    )
    await pool.query(
      `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, OWNER_ID],
    )
  }
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
     VALUES ($1, $2, 'agent', 'Orphan agent', 'ops', 'O', '#abcdef', 'avail', 'test')`,
    [AGENT_ID, COMPANY_ID],
  )
}

/** Exactly what fs-endpoints.ts wrote: no company_id column at all. */
async function writeFuseStyleMemory(): Promise<void> {
  await pool.query(
    `INSERT INTO agent_workspace (agent_id, path, body, meta, updated_at)
     VALUES ($1, 'memory/MEMORY.md', 'what I learned about the team', '{}'::jsonb, NOW())`,
    [AGENT_ID],
  )
}

/** Exactly what climate.ts and cli.ts write: no company_id, so DEFAULT 'personal'. */
async function writeClimateNote(): Promise<void> {
  await pool.query(
    `INSERT INTO agent_climate (agent_id, about_id, affinity, trust, last_note, updated_at)
     VALUES ($1, $2, 0.5, 0.5, 'finds review feedback blunt', NOW())`,
    [AGENT_ID, OWNER_ID],
  )
}

async function deleteWorkspace(): Promise<Response> {
  const response = await fetch(`${ownerBase}/api/companies/${COMPANY_ID}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'x-company-id': COMPANY_ID },
    body: JSON.stringify({ confirmation: `Workspace ${COMPANY_ID}` }),
  })
  await drainWorkspaceCleanupJobs()
  return response
}

async function countFor(table: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE agent_id = $1`, [AGENT_ID],
  )
  return Number(rows[0].count)
}

// ── the two writers whose rows the company_id sweep cannot see ──────────────

test('[integration] deletion takes memory written through the agent filesystem', async () => {
  await seedDeletableWorkspace()
  await writeFuseStyleMemory()
  assert.equal(await countFor('agent_workspace'), 1, 'precondition: the row exists')

  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())
  assert.equal(await countFor('agent_workspace'), 0, 'agent memory outlived the workspace')
})

test('[integration] deletion takes the notes an agent wrote about people', async () => {
  await seedDeletableWorkspace()
  await writeClimateNote()
  assert.equal(await countFor('agent_climate'), 1, 'precondition: the row exists')

  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())
  assert.equal(await countFor('agent_climate'), 0, 'climate notes outlived the workspace')
})

test('[integration] a row the sweep already reached is still removed', async () => {
  // The company_id path has to keep working — the fix adds a second sweep, it
  // does not replace the first.
  await seedDeletableWorkspace()
  await pool.query(
    `INSERT INTO agent_workspace (agent_id, path, body, company_id, updated_at)
     VALUES ($1, 'skills/x/SKILL.md', 'ok', $2, NOW())`,
    [AGENT_ID, COMPANY_ID],
  )
  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())
  assert.equal(await countFor('agent_workspace'), 0)
})

test('[integration] another workspace keeps its own agents data', async () => {
  // Deleting by owner must not reach past the workspace being deleted.
  await seedDeletableWorkspace()
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
     VALUES ('agent-bystander', 'co-orphan-other', 'agent', 'Bystander', 'ops', 'B', '#123456', 'avail', 'test')`,
  )
  await pool.query(
    `INSERT INTO agent_workspace (agent_id, path, body, meta, updated_at)
     VALUES ('agent-bystander', 'memory/MEMORY.md', 'untouched', '{}'::jsonb, NOW())`,
  )
  await writeFuseStyleMemory()

  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())

  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agent_workspace WHERE agent_id = 'agent-bystander'`,
  )
  assert.equal(Number(rows[0].count), 1, 'the other workspace lost data')
})

// ── the run history, which is where a survivor turns into a billing line ───

/** Seed the three tables the tenant sweep alone is responsible for, with the
 *  shape a writer that forgot the tenant produces. Their writers all pass a
 *  company_id today — the point is that #207's five did too, until they
 *  didn't, and the sweep should not have to depend on that. */
async function seedRunHistory(agentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO agent_runs (id, agent_id, status, cost_usd) VALUES ($1, $2, 'completed', 4.20)`,
    ['run-orphan', agentId],
  )
  await pool.query(
    `INSERT INTO agent_events (id, run_id, agent_id, kind, title)
     VALUES ($1, $2, $3, 'turn.finished', 'finished')`,
    ['ev-orphan', 'run-orphan', agentId],
  )
  await pool.query(
    `INSERT INTO agent_triages (id, agent_id, source, actionable) VALUES ($1, $2, 'cloud', true)`,
    ['tri-orphan', agentId],
  )
}

test('[integration] deletion takes the run history and its cost with it', async () => {
  await seedDeletableWorkspace()
  await seedRunHistory(AGENT_ID)
  for (const table of ['agent_runs', 'agent_events', 'agent_triages']) {
    assert.equal(await countFor(table), 1, `precondition: ${table} row exists`)
  }

  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())

  for (const table of ['agent_runs', 'agent_events', 'agent_triages']) {
    assert.equal(await countFor(table), 0, `${table} outlived the workspace`)
  }
})

test('[integration] correctly-tenanted run history is removed too', async () => {
  // The company_id sweep already reached these; widening must not replace it.
  await seedDeletableWorkspace()
  await pool.query(
    `INSERT INTO agent_runs (id, agent_id, company_id, status) VALUES ($1, $2, $3, 'completed')`,
    ['run-tenanted', AGENT_ID, COMPANY_ID],
  )
  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())
  assert.equal(await countFor('agent_runs'), 0)
})

test('[integration] another workspace keeps its own run history', async () => {
  // Deleting by owner must not reach past the workspace being deleted.
  await seedDeletableWorkspace()
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status, system_prompt)
     VALUES ('agent-bystander-runs', 'co-orphan-other', 'agent', 'Bystander', 'ops', 'B', '#123456', 'avail', 'test')`,
  )
  await pool.query(
    `INSERT INTO agent_runs (id, agent_id, status) VALUES ('run-bystander', 'agent-bystander-runs', 'completed')`,
  )
  await seedRunHistory(AGENT_ID)

  const response = await deleteWorkspace()
  assert.equal(response.status, 200, await response.text())

  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agent_runs WHERE agent_id = 'agent-bystander-runs'`,
  )
  assert.equal(Number(rows[0].count), 1, 'the other workspace lost its run history')
})
