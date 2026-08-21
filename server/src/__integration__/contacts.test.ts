/**
 * Integration test: `cumora contacts [<query>]` lookup.
 *
 * Surfaces the bug the user hit: Nova was asked to email "Wey Gu" and
 * silently produced empty output because Wey Gu wasn't in
 * participants OR email_contacts. The lookup tool gives the agent a
 * way to confirm "not in the contact list" so its LLM can ask the
 * user for the address instead of silently skipping.
 *
 * We exercise via runCli rather than HTTP because the contacts surface
 * is agent-CLI-only; the helpers under the hood are the same.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'
import { pool } from '../db/pool.js'
import { env } from '../env.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll()
})

async function runCliText(argv: string[]): Promise<string> {
  const { runCli } = await import('../agents/cli.js')
  const r = await runCli(argv)
  return r.text
}

test('[integration] contacts lists same-tenant agents (no query)', async () => {
  const { agentId } = await seedCompanyWithAgent({ agentId: 'aurora' })
  // Seed a second agent so the list has multiple rows.
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ('bram', $1, 'agent', 'Bram', 'engineer', 'B', '#abcdef', 'avail', $2)
     ON CONFLICT DO NOTHING`,
    [(await pool.query('SELECT company_id FROM participants WHERE id = $1', [agentId])).rows[0].company_id, 'bram.test@cumora.local'],
  )
  const text = await runCliText(['contacts', '--as', agentId])
  assert.match(text, /bram/i, `expected the other agent in the list; got:\n${text}`)
})

test('[integration] contacts keeps chat-only agents visible when email is disabled', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent({ agentId: 'aurora' })
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ('local-agent', $1, 'agent', 'Local Agent', 'operator', 'L', '#abcdef', 'avail', NULL)
     ON CONFLICT DO NOTHING`,
    [companyId],
  )

  const previousDomain = env.EMAIL_DOMAIN
  env.EMAIL_DOMAIN = ''
  try {
    const text = await runCliText(['contacts', '--as', agentId])
    assert.match(text, /Local Agent/, `expected the chat-only agent in the list; got:\n${text}`)
    assert.match(text, /chat only/i, `expected a truthful non-email marker; got:\n${text}`)
  } finally {
    env.EMAIL_DOMAIN = previousDomain
  }
})

test('[integration] contacts shows each agent\'s role/function (the directory bug)', async () => {
  // The reported bug: an agent could see teammates' names but not WHAT they
  // do — the contacts query never selected participants.role. After the fix
  // the role/function must appear so the agent can map name → function.
  const { agentId, companyId } = await seedCompanyWithAgent({ agentId: 'aurora' })
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ('iris', $1, 'agent', 'Iris', 'Designer', 'I', '#abcdef', 'avail', $2)
     ON CONFLICT DO NOTHING`,
    [companyId, 'iris.test@cumora.local'],
  )
  const text = await runCliText(['contacts', '--as', agentId])
  assert.match(text, /Iris/, `expected Iris in the list; got:\n${text}`)
  assert.match(text, /Designer/, `expected Iris's role/function to be shown; got:\n${text}`)
  // And the role is searchable, so "find me the designer" works.
  const byRole = await runCliText(['contacts', 'designer', '--as', agentId])
  assert.match(byRole, /Iris/, `role query "designer" must find Iris; got:\n${byRole}`)
})

test('[integration] contacts <query> filters by name substring', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent({ agentId: 'aurora' })
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ('weygu', $1, 'agent', 'Wey Gu', 'analyst', 'W', '#abcdef', 'avail', $2)
     ON CONFLICT DO NOTHING`,
    [companyId, 'weygu.test@cumora.local'],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ('atlas', $1, 'agent', 'Atlas', 'engineer', 'A', '#abcdef', 'avail', $2)
     ON CONFLICT DO NOTHING`,
    [companyId, 'atlas.test@cumora.local'],
  )
  const hit = await runCliText(['contacts', 'wey', '--as', agentId])
  assert.match(hit, /Wey Gu/, `wey query must find Wey Gu; got:\n${hit}`)
  assert.doesNotMatch(hit, /Atlas/, `wey query must NOT pull in Atlas; got:\n${hit}`)
})

test('[integration] contacts <query> filters email_contacts addresses too', async () => {
  const { agentId, companyId } = await seedCompanyWithAgent()
  await pool.query(
    `INSERT INTO email_contacts (company_id, address, display_name, message_count, last_seen_at)
     VALUES ($1, 'someone@external.org', 'External Person', 3, NOW())
     ON CONFLICT DO NOTHING`,
    [companyId],
  )
  const hit = await runCliText(['contacts', 'external.org', '--as', agentId])
  assert.match(hit, /someone@external\.org/, `external email query must hit; got:\n${hit}`)
})

test('[integration] contacts <query> with no match returns the "ask the user" hint', async () => {
  // Critical for the user-reported bug: Nova was asked to email Wey Gu,
  // Wey Gu wasn't anywhere in the workspace, Nova silently gave up.
  // After this fix, the lookup returns a clear hint telling the LLM
  // to ASK rather than skip.
  const { agentId } = await seedCompanyWithAgent({ agentId: 'aurora' })
  const text = await runCliText(['contacts', 'wey gu', '--as', agentId])
  assert.match(text, /no contacts match/i,
    `unmatched query must explicitly say so; got:\n${text}`)
  assert.match(text, /\bASK\b/,
    `unmatched query should nudge the LLM to ASK the user; got:\n${text}`)
})

test('[integration] email contacts <query> works the same way (alias)', async () => {
  // Back-compat: `cumora email contacts <query>` should behave identically
  // to the new top-level `cumora contacts <query>`.
  const { agentId, companyId } = await seedCompanyWithAgent({ agentId: 'aurora' })
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ('weygu', $1, 'agent', 'Wey Gu', 'analyst', 'W', '#abcdef', 'avail', $2)
     ON CONFLICT DO NOTHING`,
    [companyId, 'weygu.test@cumora.local'],
  )
  const direct = await runCliText(['contacts', 'wey', '--as', agentId])
  const aliased = await runCliText(['email', 'contacts', 'wey', '--as', agentId])
  // Both should contain Wey Gu.
  assert.match(direct, /Wey Gu/)
  assert.match(aliased, /Wey Gu/)
})
