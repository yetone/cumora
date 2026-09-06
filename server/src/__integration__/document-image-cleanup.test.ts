import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { drainWorkspaceCleanupJobs, findReferencedStorageKeys } from '../workspace-cleanup.js'
import { markdownToYXml } from '../documents/markdown.js'
import { runCli } from '../agents/cli.js'
import { buildApiTestApp, ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll } from './_helpers.js'

const OWNER_ID = 'u-cleanup-owner'
let ownerServer: Server
let ownerBase = ''

async function listenFor(userId: string): Promise<{ server: Server; base: string }> {
  const app = await buildApiTestApp(userId)
  return new Promise((resolve) => {
    const server = createServer(app).listen(0, () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve({ server, base: `http://127.0.0.1:${address.port}` })
    })
  })
}

before(async () => {
  await ensureSchemaOnce()
  const owner = await listenFor(OWNER_ID)
  ownerServer = owner.server
  ownerBase = owner.base
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll(ownerServer)
})

async function seedUser(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier)
     VALUES ($1, $2, $3, 'pro')
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@test.local`, userId],
  )
}

async function seedCompany(companyId: string, ownerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id)
     VALUES ($1, $2, $3, $4)`,
    [companyId, `Workspace ${companyId}`, companyId, ownerId],
  )
}

async function seedMember(
  companyId: string,
  userId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  await seedUser(userId)
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3)`,
    [companyId, userId, role],
  )
  await pool.query(
    `INSERT INTO participants
       (id, company_id, kind, name, role, initial, avatar_bg, status)
     VALUES ($1, $2, 'human', $3, NULL, $4, '#abcdef', 'avail')`,
    [userId, companyId, userId, userId.charAt(0).toUpperCase()],
  )
}

async function seedWorkspace(companyId: string, ownerId = OWNER_ID): Promise<void> {
  await seedUser(ownerId)
  await seedCompany(companyId, ownerId)
  await seedMember(companyId, ownerId, 'owner')
}

async function createDocWithImage(
  companyId: string,
  docId: string,
  creatorId: string,
  imageKey: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ($1, $2, 'Test Doc', $3)`,
    [docId, companyId, creatorId],
  )
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')
  const nodes = markdownToYXml(`Here is an image:\n\n![embedded](/${imageKey})`)
  fragment.push(nodes)
  const update = Y.encodeStateAsUpdate(doc)
  await pool.query(
    `INSERT INTO document_updates (document_id, author_id, update_bytes)
     VALUES ($1, $2, $3)`,
    [docId, creatorId, Buffer.from(update)],
  )
}

function companyHeaders(companyId: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-company-id': companyId }
}

test('[integration] workspace deletion collects document image keys and purges them on cleanup', async () => {
  const companyId = 'co-doc-cleanup'
  const altCompanyId = 'co-doc-alt'
  await seedWorkspace(companyId, OWNER_ID)
  await seedWorkspace(altCompanyId, OWNER_ID) // needed so deleting companyId is not the user's only workspace

  const docId = 'doc-with-image'
  const imageKey = 'attachments/ws-embedded.png'
  await createDocWithImage(companyId, docId, OWNER_ID, imageKey)

  const deletedObjects: string[] = []
  const res = await fetch(`${ownerBase}/api/companies/${companyId}`, {
    method: 'DELETE',
    headers: companyHeaders(companyId),
    body: JSON.stringify({ confirmation: `Workspace ${companyId}` }),
  })
  assert.equal(res.status, 200, await res.text())

  const jobs = await pool.query<{ storage_keys: string[] }>(
    `SELECT storage_keys FROM workspace_cleanup_jobs WHERE company_id = $1`,
    [companyId],
  )
  assert.equal(jobs.rowCount, 1)
  assert.ok(jobs.rows[0].storage_keys.includes(imageKey), `storage_keys should include ${imageKey}`)

  const drainResult = await drainWorkspaceCleanupJobs({
    dependencies: {
      deleteStorageObject: async (key) => {
        deletedObjects.push(key)
        return true
      },
    },
  })
  assert.equal(drainResult.completed, 1)
  assert.ok(deletedObjects.includes(imageKey), `storage object ${imageKey} should be deleted`)
})

test('[integration] single document deletion enqueues embedded images for cleanup', async () => {
  const companyId = 'co-single-doc'
  await seedWorkspace(companyId, OWNER_ID)

  const docId = 'doc-single'
  const imageKey = 'attachments/single-embedded.png'
  await createDocWithImage(companyId, docId, OWNER_ID, imageKey)

  const deletedObjects: string[] = []
  const res = await fetch(`${ownerBase}/api/documents/${docId}`, {
    method: 'DELETE',
    headers: companyHeaders(companyId),
  })
  assert.equal(res.status, 200, await res.text())

  const jobs = await pool.query<{ storage_keys: string[] }>(
    `SELECT storage_keys FROM workspace_cleanup_jobs WHERE company_id = $1`,
    [companyId],
  )
  assert.equal(jobs.rowCount, 1)
  assert.ok(jobs.rows[0].storage_keys.includes(imageKey), `storage_keys should include ${imageKey}`)

  const drainResult = await drainWorkspaceCleanupJobs({
    dependencies: {
      deleteStorageObject: async (key) => {
        deletedObjects.push(key)
        return true
      },
    },
  })
  assert.equal(drainResult.completed, 1)
  assert.ok(deletedObjects.includes(imageKey), `storage object ${imageKey} should be deleted`)
})

test('[integration] findReferencedStorageKeys protects shared images until last document is deleted', async () => {
  const companyId = 'co-shared-doc'
  await seedWorkspace(companyId, OWNER_ID)

  const docA = 'doc-shared-a'
  const docB = 'doc-shared-b'
  const sharedKey = 'attachments/shared-between-docs.png'
  await createDocWithImage(companyId, docA, OWNER_ID, sharedKey)
  await createDocWithImage(companyId, docB, OWNER_ID, sharedKey)

  // Both docs reference sharedKey
  const initialRef = await findReferencedStorageKeys([sharedKey])
  assert.ok(initialRef.has(sharedKey), 'should be referenced by docs')

  // Delete Doc A
  const resA = await fetch(`${ownerBase}/api/documents/${docA}`, {
    method: 'DELETE',
    headers: companyHeaders(companyId),
  })
  assert.equal(resA.status, 200)

  // Doc B is still alive, so sharedKey should be protected from deletion
  const deletedObjects: string[] = []
  const drain1 = await drainWorkspaceCleanupJobs({
    dependencies: {
      deleteStorageObject: async (key) => {
        deletedObjects.push(key)
        return true
      },
    },
  })
  assert.equal(drain1.completed, 1)
  assert.equal(deletedObjects.includes(sharedKey), false, 'sharedKey must NOT be deleted while docB exists')

  // Now delete Doc B
  const resB = await fetch(`${ownerBase}/api/documents/${docB}`, {
    method: 'DELETE',
    headers: companyHeaders(companyId),
  })
  assert.equal(resB.status, 200)

  // Now no surviving docs reference sharedKey, so it should be deleted
  const drain2 = await drainWorkspaceCleanupJobs({
    dependencies: {
      deleteStorageObject: async (key) => {
        deletedObjects.push(key)
        return true
      },
    },
  })
  assert.equal(drain2.completed, 1)
  assert.ok(deletedObjects.includes(sharedKey), 'sharedKey should be deleted after docB is deleted')
})

test('[integration] CLI doc delete cleans up embedded document images', async () => {
  const { companyId, agentId } = await seedCompanyWithAgent()
  const docId = 'doc-cli-delete'
  const imageKey = 'attachments/cli-deleted-doc.png'
  await createDocWithImage(companyId, docId, agentId, imageKey)

  const del = await runCli(['--as', agentId, 'doc', 'delete', docId])
  assert.equal(del.ok, true, `doc delete failed: ${del.text}`)

  const jobs = await pool.query<{ storage_keys: string[] }>(
    `SELECT storage_keys FROM workspace_cleanup_jobs WHERE company_id = $1`,
    [companyId],
  )
  assert.equal(jobs.rowCount, 1)
  assert.ok(jobs.rows[0].storage_keys.includes(imageKey), `storage_keys should include ${imageKey}`)

  const deletedObjects: string[] = []
  const drainResult = await drainWorkspaceCleanupJobs({
    dependencies: {
      deleteStorageObject: async (key) => {
        deletedObjects.push(key)
        return true
      },
    },
  })
  assert.equal(drainResult.completed, 1)
  assert.ok(deletedObjects.includes(imageKey), `storage object ${imageKey} should be deleted`)
})
