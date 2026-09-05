/**
 * A memory id the model supplies must match literally, and the id the tool
 * prints must be the id the tool accepts.
 *
 * Two defects in the same command family:
 *
 * 1. `memory pin` / `memory delete` interpolate the positional argument into a
 *    LIKE pattern — `memory/%/${id}.md`. `%` and `_` are wildcards there, so
 *    `cumora memory delete %` became `path LIKE 'memory/%/%.md'` and removed
 *    every memory the agent had, reporting "deleted %". Verified against
 *    Postgres 16 before the fix: three memories in, `DELETE 3`, none left.
 *    `skills delete` is the same shape one command over.
 *
 * 2. `memory list` printed `m.id.slice(0, 10)` while ids are minted 16 wide
 *    (`mem-` + 12 characters of a UUID). So the token the listing showed could
 *    never resolve: `path LIKE 'memory/%/mem-c2ad15.md'` does not match
 *    `memory/observation/mem-c2ad155a-56a.md`. `cumora help` documents
 *    list → pin/delete as the workflow, and it could not round-trip for any
 *    memory ever written.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'
import { runCli } from '../agents/cli.js'

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await resetAllTables() })
after(async () => { await teardownAll() })

async function seedMemories(agentId: string, companyId: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, meta, company_id, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, NOW())`,
      [agentId, `memory/observation/${id}.md`, `body of ${id}`, companyId],
    )
  }
}

async function memoryCount(agentId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agent_workspace
      WHERE agent_id = $1 AND path LIKE 'memory/%'`,
    [agentId],
  )
  return Number(rows[0].count)
}

// ── the wildcard ───────────────────────────────────────────────────────────

test('[integration] `memory delete %` deletes nothing', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent()
  await seedMemories(agentId, companyId, ['mem-aaaaaaaa-111', 'mem-bbbbbbbb-222', 'mem-cccccccc-333'])
  assert.equal(await memoryCount(agentId), 3)

  const res = await runCli(['--as', agentId, 'memory', 'delete', '%'])
  assert.equal(res.ok, false, `expected a refusal, got: ${res.text}`)
  assert.equal(await memoryCount(agentId), 3, 'a wildcard wiped the agent memory')
})

test('[integration] an underscore is a literal too', async () => {
  // `_` matches exactly one character, so `mem-aaaaaaaa-11_` would have hit a
  // real id — a subtler wipe than `%` and just as unintended.
  const { agentId, companyId } = await seedCompanyWithAgent()
  await seedMemories(agentId, companyId, ['mem-aaaaaaaa-111'])

  const res = await runCli(['--as', agentId, 'memory', 'delete', 'mem-aaaaaaaa-11_'])
  assert.equal(res.ok, false, `expected a refusal, got: ${res.text}`)
  assert.equal(await memoryCount(agentId), 1)
})

test('[integration] `skills delete %` deletes nothing', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent()
  for (const path of ['skills/alpha/SKILL.md', 'skills/alpha/run.md', 'skills/beta/SKILL.md']) {
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, company_id, updated_at)
       VALUES ($1, $2, 'x', $3, NOW())`,
      [agentId, path, companyId],
    )
  }
  const res = await runCli(['--as', agentId, 'skills', 'delete', '%'])
  assert.equal(res.ok, false, `expected a refusal, got: ${res.text}`)
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agent_workspace WHERE agent_id = $1 AND path LIKE 'skills/%'`,
    [agentId],
  )
  assert.equal(Number(rows[0].count), 3, 'a wildcard wiped the agent skills')
})

// ── and the ordinary path still works ──────────────────────────────────────

test('[integration] an exact id still pins and deletes', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent()
  await seedMemories(agentId, companyId, ['mem-aaaaaaaa-111', 'mem-bbbbbbbb-222'])

  const pin = await runCli(['--as', agentId, 'memory', 'pin', 'mem-aaaaaaaa-111'])
  assert.equal(pin.ok, true, pin.text)

  const del = await runCli(['--as', agentId, 'memory', 'delete', 'mem-bbbbbbbb-222'])
  assert.equal(del.ok, true, del.text)
  assert.equal(await memoryCount(agentId), 1)
})

test('[integration] a name containing a percent matches only itself', async () => {
  // Escaping must not make a legitimate literal unreachable.
  const { agentId, companyId } = await seedCompanyWithAgent()
  for (const path of ['skills/100%/SKILL.md', 'skills/other/SKILL.md']) {
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, company_id, updated_at)
       VALUES ($1, $2, 'x', $3, NOW())`,
      [agentId, path, companyId],
    )
  }
  const res = await runCli(['--as', agentId, 'skills', 'delete', '100%'])
  assert.equal(res.ok, true, res.text)
  const { rows } = await pool.query<{ path: string }>(
    `SELECT path FROM agent_workspace WHERE agent_id = $1 AND path LIKE 'skills/%' ORDER BY path`,
    [agentId],
  )
  assert.deepEqual(rows.map((r) => r.path), ['skills/other/SKILL.md'])
})

// ── the id the listing prints is the id the commands take ──────────────────

test('[integration] the id shown by `memory list` round-trips into `memory pin`', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent()
  await seedMemories(agentId, companyId, ['mem-c2ad155a-56a'])

  const list = await runCli(['--as', agentId, 'memory', 'list'])
  assert.equal(list.ok, true, list.text)
  const printed = list.text.match(/\[(mem-[^\]]+)\]/)?.[1]
  assert.ok(printed, `no memory id in the listing:\n${list.text}`)

  const pin = await runCli(['--as', agentId, 'memory', 'pin', printed])
  assert.equal(pin.ok, true, `the id the listing printed does not resolve: ${pin.text}`)
})
