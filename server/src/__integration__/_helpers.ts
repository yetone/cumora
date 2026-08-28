/**
 * Helpers shared by integration tests. Imported by every *.test.ts in
 * this directory.
 *
 * Lifecycle: each test file is a separate `node:test` invocation, so the
 * module-load side effects in env.ts / pool.ts / redis.ts run once per
 * file. The runner (server/run-integration-tests.mjs) has already
 * swapped DATABASE_URL to INTEGRATION_DATABASE_URL before spawning, so
 * the pool here lands on the test DB.
 *
 * Isolation strategy: TRUNCATE between tests rather than transaction
 * rollback. Rollback would break SKIP LOCKED tests (the retry worker
 * uses its own connection / transaction lifecycle that we must not
 * subsume).
 */
import { createHmac, randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { ensureSchema } from '../db/migrate.js'
import { env } from '../env.js'

let schemaReady: Promise<void> | null = null

/** Run the schema migrator exactly once per test process. Idempotent —
 *  ensureSchema is itself `IF NOT EXISTS` throughout. */
export function ensureSchemaOnce(): Promise<void> {
  if (!schemaReady) schemaReady = ensureSchema()
  return schemaReady
}

/** Tables we wipe between tests. Order matters when there are FK
 *  constraints; CASCADE on the parents handles it but listing explicitly
 *  keeps the intent visible + lets us spot-check leakage. */
const TABLES_TO_WIPE: readonly string[] = [
  'shipping_events',
  'shipping_regressions',
  'shipping_friction_reports',
  'shipping_releases',
  'shipping_verifications',
  'shipping_invariants',
  'shipping_features',
  'document_mentions',
  'document_snapshots',
  'document_updates',
  'documents',
  'board_mention_reads',
  'board_card_comments',
  'board_cards',
  'board_columns',
  'boards',
  'calendar_reminders',
  'calendar_dispatches',
  'calendar_events',
  'email_attachments',
  'email_messages',
  'email_contacts',
  'message_reactions',
  'conversation_reads',
  'conversation_counters',
  'messages',
  'conversations',
  'agent_climate',
  'agent_workspace',
  'agent_runs',
  'agent_events',
  'agent_tasks',
  'agent_log',
  'company_members',
  'participants',
  'computers',
  'users',
  'companies',
]

/** Wipe every test table. Call from beforeEach. The check at the top
 *  refuses to run if DATABASE_URL doesn't include the substring "test"
 *  — last line of defense against a misconfigured runner pointing at a
 *  real DB. */
export async function resetAllTables(): Promise<void> {
  if (!/test/i.test(env.DATABASE_URL)) {
    throw new Error(`refusing to TRUNCATE — DATABASE_URL doesn't look like a test DB: ${env.DATABASE_URL}`)
  }
  await ensureSchemaOnce()
  for (const t of TABLES_TO_WIPE) {
    await pool.query(`TRUNCATE TABLE ${t} CASCADE`).catch(() => { /* table may not exist on partial schemas */ })
  }
}

/** Compute the HMAC signature the inbound webhook expects. Mirrors the
 *  cloudflare worker's `hmacHex` exactly so a test payload looks like
 *  it came off the wire. */
export function signInboundPayload(body: string): string {
  const secret = env.EMAIL_INBOUND_HMAC_SECRET
  if (!secret) throw new Error('EMAIL_INBOUND_HMAC_SECRET not set in test env')
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** Insert the minimum scaffolding an email row needs: one company + one
 *  agent participant whose participants.email is pre-minted. Returns the
 *  ids the caller will use as recipient / sender. */
export async function seedCompanyWithAgent(opts?: {
  companyId?: string; agentId?: string; agentEmail?: string
}): Promise<{ companyId: string; agentId: string; agentEmail: string }> {
  const companyId = opts?.companyId ?? `c-${randomUUID().slice(0, 8)}`
  const agentId = opts?.agentId ?? `a-${randomUUID().slice(0, 8)}`
  const dom = env.EMAIL_DOMAIN || 'cumora.local'
  const agentEmail = opts?.agentEmail ?? `${agentId}.${companyId}@${dom}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [companyId, `Test ${companyId}`, companyId, 'test-owner'],
  )
  // participants composite PK is (id, company_id) — see migrate.ts.
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status, email)
     VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail', $5)
     ON CONFLICT DO NOTHING`,
    [agentId, companyId, `Agent ${agentId}`, agentId.slice(0, 1).toUpperCase(), agentEmail],
  )
  return { companyId, agentId, agentEmail }
}

/** Build a minimum-viable Express app that mounts only the routes under
 *  test. Avoids booting the full server (auth middleware, schedulers,
 *  etc.) — slow, more failure modes. */
export async function buildTestApp(): Promise<import('express').Express> {
  const expressMod = await import('express')
  const express = expressMod.default
  const app = express()
  const { inboundEmailRouter } = await import('../api/inbound-email.js')
  // Match the production mount path: index.ts mounts inboundEmailRouter
  // at /webhooks/email — see server/src/index.ts.
  app.use('/webhooks/email', inboundEmailRouter)
  return app
}

/** Build a test app with the full /api router mounted + a stubbed auth
 *  middleware that stamps every request as the given userId. Used for
 *  exercising auth-gated endpoints (HTML viewer, send/reply) without
 *  having to mint real sessions. The caller is responsible for seeding
 *  the user + company_members rows so requireCompany() succeeds. */
export async function buildApiTestApp(userId: string): Promise<import('express').Express> {
  const expressMod = await import('express')
  const express = expressMod.default
  const app = express()
  app.use(express.json({ limit: '34mb' }))
  // Fake auth middleware: stamp authUserId from the test's choice. Real
  // requireAuth() just reads this field, so handlers can't distinguish.
  app.use((req, _res, next) => {
    (req as unknown as { authUserId: string }).authUserId = userId
    next()
  })
  const { api } = await import('../api/router.js')
  app.use('/api', api)
  return app
}

/** Insert a user + company_members row so requireCompany resolves to the
 *  given tenant. ALSO inserts a corresponding participants row, matching
 *  what production onboarding does — human users get a participants
 *  entry so they can have a minted cumora email, climate signals,
 *  /participants visibility, etc. Without this, ensureParticipantAddress
 *  returns null and email-reply paths 500. */
export async function seedUserMembership(userId: string, companyId: string, opts?: {
  email?: string; displayName?: string;
}): Promise<void> {
  const displayName = opts?.displayName ?? userId
  const authEmail = opts?.email ?? `${userId}@test.local`
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier)
     VALUES ($1, $2, $3, 'free')
     ON CONFLICT (id) DO NOTHING`,
    [userId, authEmail, displayName],
  )
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT DO NOTHING`,
    [companyId, userId],
  )
  // Mirror what production onboarding does: a human is also a participant
  // in the company. We leave participants.email NULL so ensureParticipantAddress
  // lazy-mints `<userId>.<slug>@<EMAIL_DOMAIN>` on first access (matches
  // the production code path).
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')
     ON CONFLICT DO NOTHING`,
    [userId, companyId, displayName, displayName.slice(0, 1).toUpperCase()],
  )
}

/** Tear down every resource the test harness opened: HTTP server, pg
 *  pool, redis (and the separate sub connection). Call from `after()` in
 *  each test file. Without this, node:test waits 60s+ on dangling event-
 *  loop handles before timing out the whole file. */
export async function teardownAll(server?: import('node:http').Server): Promise<void> {
  if (server && server.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  // Pool + redis are module-level singletons; ending them is fine because
  // the process is about to exit anyway. Catch swallows reentrant-end
  // errors when multiple test files share the singleton.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
}
