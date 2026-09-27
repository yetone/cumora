import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pool } from '../db/pool.js'
import {
  issuePairingCode, issueRepairCode, pairComputer, resolveDevice,
  revokeComputer, rotateCompanyPairingCode,
} from '../agents/computer/registry.js'
import {
  buildApiTestApp, ensureSchemaOnce, resetAllTables, seedUserMembership, teardownAll,
} from './_helpers.js'

const OWNER_ID = 'pair-rotation-owner'
const ADMIN_ID = 'pair-rotation-admin'
const MEMBER_ID = 'pair-rotation-member'
const OTHER_OWNER_ID = 'pair-rotation-other-owner'
const servers: Server[] = []
const bases = new Map<string, string>()
let anonymousBase = ''

async function listen(app: import('express').Express): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(app).listen(0, () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      servers.push(server)
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

async function listenFor(userId: string): Promise<string> {
  return listen(await buildApiTestApp(userId))
}

function headers(companyId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-company-id': companyId,
    'user-agent': 'pairing-rotation-integration-test',
  }
}

async function seedWorkspace(): Promise<{ companyId: string; otherCompanyId: string }> {
  const companyId = `co-${randomUUID().slice(0, 8)}`
  const otherCompanyId = `co-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [companyId, `Test ${companyId}`, companyId, OWNER_ID],
  )
  await seedUserMembership(OWNER_ID, companyId)
  await seedUserMembership(ADMIN_ID, companyId)
  await pool.query(`UPDATE company_members SET role = 'admin' WHERE company_id = $1 AND user_id = $2`, [companyId, ADMIN_ID])
  await seedUserMembership(MEMBER_ID, companyId)
  await pool.query(`UPDATE company_members SET role = 'member' WHERE company_id = $1 AND user_id = $2`, [companyId, MEMBER_ID])

  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [otherCompanyId, `Test ${otherCompanyId}`, otherCompanyId, OTHER_OWNER_ID],
  )
  await seedUserMembership(OTHER_OWNER_ID, otherCompanyId)
  return { companyId, otherCompanyId }
}

async function waitForBlockedQuery(pattern: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1`,
      [pattern],
    )
    if ((rows[0]?.count ?? 0) > 0) return
    await delay(10)
  }
  throw new Error(`query never reached the expected row lock: ${pattern}`)
}

before(async () => {
  await ensureSchemaOnce()
  bases.set(OWNER_ID, await listenFor(OWNER_ID))
  bases.set(ADMIN_ID, await listenFor(ADMIN_ID))
  bases.set(MEMBER_ID, await listenFor(MEMBER_ID))
  bases.set(OTHER_OWNER_ID, await listenFor(OTHER_OWNER_ID))
  const express = (await import('express')).default
  const { api } = await import('../api/router.js')
  const app = express()
  app.use('/api', api)
  anonymousBase = await listen(app)
})

beforeEach(async () => { await resetAllTables() })

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await teardownAll()
})

test('[integration] owner rotates the persisted workspace code; old code cannot create or rebind a computer', async () => {
  const { companyId } = await seedWorkspace()
  const base = bases.get(OWNER_ID)!
  const issuedResponse = await fetch(`${base}/api/computers`, { method: 'POST', headers: headers(companyId), body: '{}' })
  assert.equal(issuedResponse.status, 201)
  assert.match(issuedResponse.headers.get('cache-control') ?? '', /no-store/)
  const oldCode = (await issuedResponse.json() as { code: string }).code
  assert.match(oldCode, /^[A-Za-z0-9_-]{32}$/)

  const trustedPair = await pairComputer({
    code: oldCode, hostName: 'Trusted host', engines: ['claude'], deferBroadcast: true,
  })
  assert.ok(trustedPair)
  const reconnectCode = await issueRepairCode({
    companyId, ownerUserId: OWNER_ID, computerId: trustedPair.computerId,
  })
  assert.ok(reconnectCode)

  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind, available_engines, status, credential_hash)
     VALUES ($1, $2, 'Same host', 'local', '["claude"]'::jsonb, 'offline', 'existing-credential')`,
    [`existing-${randomUUID().slice(0, 8)}`, companyId],
  )
  const existingBefore = await pool.query<{ id: string; credential_hash: string }>(
    `SELECT id, credential_hash FROM computers WHERE company_id = $1 AND name = 'Same host'`, [companyId],
  )

  const rotateResponse = await fetch(`${base}/api/computers/pairing-code/rotate`, {
    method: 'POST', headers: headers(companyId),
  })
  assert.equal(rotateResponse.status, 200)
  assert.match(rotateResponse.headers.get('cache-control') ?? '', /no-store/)
  const rotated = await rotateResponse.json() as { code: string; expiresInSeconds: null }
  assert.deepEqual(Object.keys(rotated).sort(), ['code', 'expiresInSeconds'])
  assert.match(rotated.code, /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(rotated.code, oldCode)
  assert.equal(rotated.expiresInSeconds, null)
  assert.deepEqual(await resolveDevice(trustedPair.deviceToken), { computerId: trustedPair.computerId, companyId })
  assert.equal(
    (await issueRepairCode({ companyId, ownerUserId: OWNER_ID, computerId: trustedPair.computerId }))?.code,
    reconnectCode.code,
  )

  const currentResponse = await fetch(`${base}/api/computers`, { method: 'POST', headers: headers(companyId), body: '{}' })
  assert.equal(currentResponse.status, 201)
  const current = await currentResponse.json() as { code: string }
  assert.equal(current.code, rotated.code)

  assert.equal(await pairComputer({ code: oldCode, hostName: 'New host', engines: ['claude'], deferBroadcast: true }), null)
  assert.equal(await pairComputer({ code: oldCode, hostName: 'Same host', engines: ['claude'], deferBroadcast: true }), null)
  const existingAfter = await pool.query<{ id: string; credential_hash: string }>(
    `SELECT id, credential_hash FROM computers WHERE company_id = $1 AND name = 'Same host'`, [companyId],
  )
  assert.deepEqual(existingAfter.rows, existingBefore.rows)
  const paired = await pairComputer({ code: rotated.code, hostName: 'Same host', engines: ['claude'], deferBroadcast: true })
  assert.equal(paired?.computerId, existingBefore.rows[0].id)
  assert.ok(paired?.deviceToken)
  const sameHostReconnectCode = await issueRepairCode({
    companyId, ownerUserId: OWNER_ID, computerId: paired!.computerId,
  })
  assert.ok(sameHostReconnectCode)
  assert.equal(await revokeComputer({ computerId: paired!.computerId, companyId }), true)
  assert.equal(await resolveDevice(paired!.deviceToken), null)
  assert.equal(await pairComputer({
    code: sameHostReconnectCode.code, hostName: 'Same host', deferBroadcast: true,
  }), null)

  const { rows: events } = await pool.query<{
    user_id: string; company_id: string; ip: string | null; user_agent: string | null; kind: string; detail: unknown
  }>(
    `SELECT user_id, company_id, ip, user_agent, kind, detail
       FROM audit_events WHERE kind = 'company_pair_token_rotated'`,
  )
  assert.equal(events.length, 1)
  assert.equal(events[0].user_id, OWNER_ID)
  assert.equal(events[0].company_id, companyId)
  assert.ok(events[0].ip)
  assert.equal(events[0].user_agent, 'pairing-rotation-integration-test')
  const auditText = JSON.stringify(events[0])
  assert.ok(!auditText.includes(oldCode))
  assert.ok(!auditText.includes(rotated.code))
})

test('[integration] only an owner in the active workspace may rotate the code', async () => {
  const { companyId } = await seedWorkspace()
  const admin = await fetch(`${bases.get(ADMIN_ID)!}/api/computers/pairing-code/rotate`, {
    method: 'POST', headers: headers(companyId),
  })
  const member = await fetch(`${bases.get(MEMBER_ID)!}/api/computers/pairing-code/rotate`, {
    method: 'POST', headers: headers(companyId),
  })
  const otherWorkspace = await fetch(`${bases.get(OTHER_OWNER_ID)!}/api/computers/pairing-code/rotate`, {
    method: 'POST', headers: headers(companyId),
  })
  const anonymous = await fetch(`${anonymousBase}/api/computers/pairing-code/rotate`, {
    method: 'POST', headers: headers(companyId),
  })
  assert.equal(admin.status, 403)
  assert.equal(member.status, 403)
  assert.equal(otherWorkspace.status, 403)
  assert.equal(anonymous.status, 401)

  const { rows } = await pool.query<{ pair_token: string | null }>(
    `SELECT pair_token FROM companies WHERE id = $1`, [companyId],
  )
  assert.equal(rows[0].pair_token, null)
  const audit = await pool.query(`SELECT 1 FROM audit_events WHERE kind = 'company_pair_token_rotated'`)
  assert.equal(audit.rowCount, 0)
})

test('[integration] pair lookup waits behind rotation and rechecks the old code after rotation commits', async () => {
  const { companyId } = await seedWorkspace()
  const oldCode = await issuePairingCode({ companyId, ownerUserId: OWNER_ID })
  const blocker = await pool.connect()
  let committed = false
  let rotation: ReturnType<typeof rotateCompanyPairingCode> | undefined
  let pairing: ReturnType<typeof pairComputer> | undefined
  let testError: unknown = null
  try {
    await blocker.query('BEGIN')
    await blocker.query(`SELECT id FROM companies WHERE id = $1 FOR UPDATE`, [companyId])

    rotation = rotateCompanyPairingCode({ companyId, ownerUserId: OWNER_ID })
    void rotation.catch(() => {})
    await waitForBlockedQuery('%UPDATE companies SET pair_token = $1 WHERE id = $2 RETURNING id%')

    pairing = pairComputer({ code: oldCode.code, hostName: 'Racing host', engines: ['claude'], deferBroadcast: true })
    void pairing.catch(() => {})
    await waitForBlockedQuery('%SELECT id, owner_user_id%FROM companies%pair_token = $1%FOR SHARE%')

    await blocker.query('COMMIT')
    committed = true
  } catch (error) {
    testError = error
  } finally {
    if (!committed) await blocker.query('ROLLBACK').catch(() => {})
    blocker.release()
  }

  if (testError) {
    await Promise.allSettled([rotation, pairing].filter((task): task is NonNullable<typeof task> => Boolean(task)))
    throw testError
  }
  assert.ok(rotation && pairing)
  const [rotated, paired] = await Promise.all([rotation, pairing])
  assert.ok('code' in rotated)
  assert.notEqual(rotated.code, oldCode.code)
  assert.equal(paired, null)
  assert.equal(await pairComputer({ code: oldCode.code, hostName: 'After rotation', deferBroadcast: true }), null)
})
