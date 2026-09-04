/**
 * Security regressions for the auxiliary `/runtime/*` write surfaces.
 *
 * These tests deliberately use the real Express router, PostgreSQL locks, and
 * Redis. In particular, the kick/notices race is ordered with a row-lock
 * holder: the real CLI kick queues first, the notice request queues behind the
 * kick's participant lock, and only then is the holder released. A passing
 * test therefore proves the authorization check and notice insert share one
 * serialization boundary; timing luck cannot make the race disappear.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { after, before, beforeEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'
import { runCli } from '../agents/cli.js'
import {
  thinkingKey, worklogField, worklogKey,
} from '../agents/runtime/inproc-client.js'
import { signAgentToken } from '../agents/runtime/jwt.js'
import { pool } from '../db/pool.js'
import { readDocumentText, subscribe } from '../documents/rooms.js'
import { env } from '../env.js'
import { CH_DOCS, redis } from '../redis.js'
import { startRealtimeOutboxWorker, stopRealtimeOutboxWorker } from '../realtime-outbox.js'
import {
  ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll,
} from './_helpers.js'

let server: Server
let baseUrl = ''

before(async () => {
  await ensureSchemaOnce()
  const expressMod = await import('express')
  const express = expressMod.default
  const { runtimeRouter } = await import('../agents/runtime/server.js')
  const app = express()
  app.use('/runtime', runtimeRouter)
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        baseUrl = `http://127.0.0.1:${address.port}`
      }
      resolve()
    })
  })
})

beforeEach(async () => {
  await resetAllTables()
})

after(async () => {
  await teardownAll(server)
})

async function call(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await response.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: response.status, body }
}

async function seedAgent(companyId?: string, agentId?: string): Promise<{
  companyId: string
  agentId: string
  token: string
}> {
  const seeded = await seedCompanyWithAgent({ companyId, agentId })
  const { rows } = await pool.query<{
    computer_id: string | null
    runtime_assignment_id: string
  }>(
    `SELECT computer_id, runtime_assignment_id
       FROM participants
      WHERE id = $1 AND company_id = $2 AND kind = 'agent'`,
    [seeded.agentId, seeded.companyId],
  )
  assert.ok(rows[0], 'runtime token fixture requires a live Agent placement')
  return {
    companyId: seeded.companyId,
    agentId: seeded.agentId,
    token: signAgentToken({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      computerId: rows[0].computer_id,
      assignmentId: rows[0].runtime_assignment_id,
    }),
  }
}

async function seedGroup(companyId: string, members: string[]): Promise<string> {
  const conversationId = `conv-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, company_id, kind, title, members)
     VALUES ($1, $2, 'group', $3, $4::jsonb)`,
    [conversationId, companyId, `Runtime auth ${conversationId}`, JSON.stringify(members)],
  )
  return conversationId
}

async function seedMessage(args: {
  conversationId: string
  companyId: string
  authorId: string
  body: string
  kind?: 'text' | 'system'
  deliveryRecipientId?: string | null
}): Promise<string> {
  const id = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages
       (id, conversation_id, author_id, kind, body, sequence, company_id, delivery_recipient_id)
     VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
    [
      id, args.conversationId, args.authorId, args.kind ?? 'text', args.body,
      args.companyId, args.deliveryRecipientId ?? null,
    ],
  )
  await pool.query(
    `INSERT INTO conversation_counters (conversation_id, next_sequence)
     VALUES ($1, 2)
     ON CONFLICT (conversation_id) DO UPDATE
       SET next_sequence = GREATEST(conversation_counters.next_sequence, 2)`,
    [args.conversationId],
  )
  return id
}

async function waitForBlockedQuery(pattern: string, minimum = 1): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1`,
      [pattern],
    )
    if ((rows[0]?.count ?? 0) >= minimum) return
    await delay(10)
  }
  throw new Error(`query never reached the expected row lock: ${pattern}`)
}

async function waitForExternalBlockedQuery(
  observer: Client,
  pattern: string,
  minimum = 1,
): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const { rows } = await observer.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1`,
      [pattern],
    )
    if ((rows[0]?.count ?? 0) >= minimum) return
    await delay(10)
  }
  throw new Error(`query never reached ${minimum} blocked sessions: ${pattern}`)
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('[integration] runtime notices: a queued kick wins before notice authorization and leaves no notice row', async () => {
  const actor = await seedAgent(undefined, `agent-actor-${randomUUID().slice(0, 6)}`)
  const target = await seedAgent(actor.companyId, `agent-target-${randomUUID().slice(0, 6)}`)
  const peer = await seedAgent(actor.companyId, `agent-peer-${randomUUID().slice(0, 6)}`)
  const conversationId = await seedGroup(actor.companyId, [actor.agentId, target.agentId, peer.agentId])
  const noticeText = `must-not-land-${randomUUID()}`
  const holder = await pool.connect()
  let holderFinished = false
  let kickPromise: ReturnType<typeof runCli> | undefined
  let noticePromise: ReturnType<typeof call> | undefined

  try {
    await holder.query('BEGIN')
    await holder.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId])

    // Queue the real membership mutation first. It holds both participant rows
    // while waiting for our conversation lock.
    kickPromise = runCli(['--as', actor.agentId, 'kick', conversationId, target.agentId])
    await waitForBlockedQuery('%SELECT c.id%FROM conversations c%FOR UPDATE OF c%')

    // The notice request passes JWT validation, then blocks on the target's
    // participant row behind the already-queued kick transaction.
    noticePromise = call('/runtime/notices', {
      token: target.token,
      body: {
        conversationId,
        noticeKind: 'race-probe',
        text: noticeText,
        dedupeKey: `race-${randomUUID()}`,
        dedupeTtlSec: 60,
      },
    })
    await waitForBlockedQuery('%SELECT id FROM participants%FOR SHARE%')

    await holder.query('COMMIT')
    holderFinished = true
    const [kick, notice] = await Promise.all([kickPromise, noticePromise])
    assert.equal(kick.ok, true, kick.text)
    assert.equal(notice.status, 403, JSON.stringify(notice.body))
    assert.match(String(notice.body?.error ?? ''), /not a member/i)

    const { rows } = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM messages
        WHERE conversation_id = $1
          AND kind = 'system'
          AND body::jsonb ->> 'noticeKind' = 'race-probe'`,
      [conversationId],
    )
    assert.equal(rows[0]?.count, 0, 'the rejected request inserted a runtime notice')
  } finally {
    if (!holderFinished) await holder.query('ROLLBACK').catch(() => {})
    holder.release()
    await Promise.allSettled([kickPromise, noticePromise].filter(Boolean) as Promise<unknown>[])
  }
})

test('[integration] runtime CLI: 20 cold document reads do not self-exhaust the pool and offboarding advances', async () => {
  const agent = await seedAgent()
  const documentId = `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ($1, $2, 'Cold pool probe', $3)`,
    [documentId, agent.companyId, agent.agentId],
  )

  // These clients intentionally sit outside the application's max=20 pool.
  // ACCESS EXCLUSIVE pauses each command only after cmdDoc has taken its
  // participant lock and checked out a pool slot, making the exhaustion
  // schedule deterministic instead of depending on local query timing.
  const locker = new Client({ connectionString: env.DATABASE_URL })
  const observer = new Client({ connectionString: env.DATABASE_URL })
  const offboarder = new Client({ connectionString: env.DATABASE_URL })
  const commandPromises: Array<ReturnType<typeof call>> = []
  let offboardPromise: Promise<{ rowCount: number | null }> | undefined
  let lockerFinished = false

  await Promise.all([locker.connect(), observer.connect(), offboarder.connect()])
  try {
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE documents IN ACCESS EXCLUSIVE MODE')

    for (let i = 0; i < 20; i++) {
      commandPromises.push(call('/runtime/cli', {
        token: agent.token,
        body: { argv: ['doc', 'read', documentId, '--json'] },
      }))
    }
    await waitForExternalBlockedQuery(observer, '%FROM documents WHERE id = $1 LIMIT 1%', 20)

    offboardPromise = offboarder.query(
      `UPDATE participants SET departed_at = NOW()
        WHERE id = $1 AND company_id = $2 AND departed_at IS NULL`,
      [agent.agentId, agent.companyId],
    )
    await waitForExternalBlockedQuery(observer, '%UPDATE participants SET departed_at = NOW()%')

    await locker.query('COMMIT')
    lockerFinished = true
    const responses = await withTimeout(
      Promise.all(commandPromises),
      '20 runtime document reads',
    )
    const offboard = await withTimeout(offboardPromise, 'offboarding after document reads')

    assert.equal(offboard.rowCount, 1)
    assert.equal(responses.length, 20)
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200, `request ${index}: ${JSON.stringify(response.body)}`)
      assert.equal(response.body?.ok, true, `request ${index}: ${JSON.stringify(response.body)}`)
      assert.match(String(response.body?.text ?? ''), /Cold pool probe/)
    }

    const stale = await call('/runtime/cli', {
      token: agent.token,
      body: { argv: ['doc', 'read', documentId] },
    })
    assert.equal(stale.status, 403, 'offboarded runtime token remained usable')
  } finally {
    if (!lockerFinished) await locker.query('ROLLBACK').catch(() => {})
    await Promise.allSettled(commandPromises)
    if (offboardPromise) await Promise.allSettled([offboardPromise])
    await Promise.all([
      locker.end().catch(() => {}),
      observer.end().catch(() => {}),
      offboarder.end().catch(() => {}),
    ])
  }
})

test('[integration] document rooms reserve one connection across snapshot and tail hydration', async () => {
  const agent = await seedAgent()
  const documentIds = Array.from({ length: 20 }, () => `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
  for (const [index, documentId] of documentIds.entries()) {
    await pool.query(
      `INSERT INTO documents (id, company_id, title, created_by)
       VALUES ($1, $2, $3, $4)`,
      [documentId, agent.companyId, `Hydration lease ${index}`, agent.agentId],
    )
  }

  const snapshotLocker = new Client({ connectionString: env.DATABASE_URL })
  const participantLocker = new Client({ connectionString: env.DATABASE_URL })
  const observer = new Client({ connectionString: env.DATABASE_URL })
  const hydrationPromises: Array<ReturnType<typeof subscribe>> = []
  const cliPromises: Array<ReturnType<typeof call>> = []
  let snapshotReleased = false
  let participantsReleased = false

  await Promise.all([snapshotLocker.connect(), participantLocker.connect(), observer.connect()])
  try {
    await snapshotLocker.query('BEGIN')
    await snapshotLocker.query('LOCK TABLE document_snapshots IN ACCESS EXCLUSIVE MODE')
    await participantLocker.query('BEGIN')
    await participantLocker.query('LOCK TABLE participants IN ACCESS EXCLUSIVE MODE')

    for (const [index, documentId] of documentIds.entries()) {
      hydrationPromises.push(subscribe(documentId, agent.companyId, {
        originId: `lease-probe-${index}`,
        onUpdate: () => {},
        onAwareness: () => {},
      }))
    }
    await waitForExternalBlockedQuery(observer, '%FROM document_snapshots%', 20)

    // These requests queue behind the 20 hydration leases. Once they receive
    // a slot they intentionally block on `participants`; a buggy hydration
    // that releases its client after the snapshot would let these requests
    // consume every slot before the tail queries can run.
    for (const documentId of documentIds) {
      cliPromises.push(call('/runtime/cli', {
        token: agent.token,
        body: { argv: ['doc', 'read', documentId, '--json'] },
      }))
    }
    for (let attempt = 0; attempt < 500 && pool.waitingCount < 20; attempt++) await delay(10)
    assert.ok(pool.waitingCount >= 20, `expected queued CLI requests, got ${pool.waitingCount}`)

    await snapshotLocker.query('COMMIT')
    snapshotReleased = true
    const hydrated = await withTimeout(
      Promise.all(hydrationPromises),
      '20 snapshot+tail hydrations while CLI requests are queued',
      5_000,
    )
    assert.equal(hydrated.length, 20)
    await waitForExternalBlockedQuery(observer, '%FROM participants%', 20)

    await participantLocker.query('COMMIT')
    participantsReleased = true
    const responses = await withTimeout(Promise.all(cliPromises), 'queued document reads')
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200, `request ${index}: ${JSON.stringify(response.body)}`)
      assert.equal(response.body?.ok, true, `request ${index}: ${JSON.stringify(response.body)}`)
    }
  } finally {
    if (!snapshotReleased) await snapshotLocker.query('ROLLBACK').catch(() => {})
    if (!participantsReleased) await participantLocker.query('ROLLBACK').catch(() => {})
    await Promise.allSettled([...hydrationPromises, ...cliPromises])
    await Promise.all([
      snapshotLocker.end().catch(() => {}),
      participantLocker.end().catch(() => {}),
      observer.end().catch(() => {}),
    ])
  }
})

test('[integration] a failed document hydration is evicted so a corrected row can retry', async () => {
  const agent = await seedAgent()
  const documentId = `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  await pool.query(
    `INSERT INTO documents (id, company_id, title, created_by)
     VALUES ($1, $2, 'Retry hydration', $3)`,
    [documentId, agent.companyId, agent.agentId],
  )
  await pool.query(
    `INSERT INTO document_snapshots
       (document_id, state_bytes, snapshot_at_update_id, updated_at)
     VALUES ($1, $2, 0, NOW())`,
    [documentId, Buffer.from([0xff, 0xff, 0xff])],
  )

  await assert.rejects(readDocumentText(documentId, agent.companyId))
  await pool.query(`DELETE FROM document_snapshots WHERE document_id = $1`, [documentId])
  assert.equal(await readDocumentText(documentId, agent.companyId), '')
})

test('[integration] CLI document change events are published only after commit', async () => {
  const agent = await seedAgent()
  const observer = new Client({ connectionString: env.DATABASE_URL })
  const subscriber = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null })
  await observer.connect()
  await subscriber.subscribe(CH_DOCS)
  startRealtimeOutboxWorker()

  type ChangedEvent = {
    type: 'doc.changed'
    kind: 'document.created' | 'document.updated' | 'document.deleted'
    companyId: string
    documentId: string
    actorId: string
  }
  const observeNext = (
    kind: ChangedEvent['kind'],
    inspect: (event: ChangedEvent) => Promise<void>,
  ): Promise<ChangedEvent> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscriber.off('message', onMessage)
      reject(new Error(`timed out waiting for ${kind}`))
    }, 5_000)
    const onMessage = (channel: string, payload: string) => {
      if (channel !== CH_DOCS) return
      let event: ChangedEvent
      try { event = JSON.parse(payload) as ChangedEvent } catch { return }
      if (
        event.type !== 'doc.changed'
        || event.kind !== kind
        || event.companyId !== agent.companyId
        || event.actorId !== agent.agentId
      ) return
      clearTimeout(timer)
      subscriber.off('message', onMessage)
      void inspect(event).then(() => resolve(event), reject)
    }
    subscriber.on('message', onMessage)
  })

  try {
    const createObserved = observeNext('document.created', async (event) => {
      const { rows } = await observer.query<{ title: string }>(
        `SELECT title FROM documents WHERE id = $1`,
        [event.documentId],
      )
      assert.deepEqual(rows, [{ title: 'Committed document' }])
    })
    const created = await runCli(['--as', agent.agentId, 'doc', 'create', 'Committed document'])
    assert.equal(created.ok, true, created.text)
    const createEvent = await createObserved

    const renameObserved = observeNext('document.updated', async (event) => {
      assert.equal(event.documentId, createEvent.documentId)
      const { rows } = await observer.query<{ title: string }>(
        `SELECT title FROM documents WHERE id = $1`,
        [event.documentId],
      )
      assert.deepEqual(rows, [{ title: 'Committed rename' }])
    })
    const renamed = await runCli([
      '--as', agent.agentId, 'doc', 'rename', createEvent.documentId, 'Committed rename',
    ])
    assert.equal(renamed.ok, true, renamed.text)
    await renameObserved

    const deleteObserved = observeNext('document.deleted', async (event) => {
      assert.equal(event.documentId, createEvent.documentId)
      const { rows } = await observer.query(`SELECT 1 FROM documents WHERE id = $1`, [event.documentId])
      assert.equal(rows.length, 0)
    })
    const deleted = await runCli(['--as', agent.agentId, 'doc', 'delete', createEvent.documentId])
    assert.equal(deleted.ok, true, deleted.text)
    await deleteObserved
  } finally {
    stopRealtimeOutboxWorker()
    await subscriber.unsubscribe(CH_DOCS).catch(() => {})
    await subscriber.quit().catch(() => {})
    await observer.end().catch(() => {})
  }
})

test('[integration] runtime notices: concurrent same-key requests commit exactly one durable notice', async () => {
  const agent = await seedAgent()
  const conversationId = await seedGroup(agent.companyId, [agent.agentId])
  const dedupeKey = `same-${randomUUID()}`
  const body = {
    conversationId,
    noticeKind: 'same-key',
    text: 'post once',
    dedupeKey,
    dedupeTtlSec: 60,
  }

  const responses = await Promise.all([
    call('/runtime/notices', { token: agent.token, body }),
    call('/runtime/notices', { token: agent.token, body }),
  ])
  assert.deepEqual(responses.map((response) => response.status), [200, 200])
  assert.deepEqual(
    responses.map((response) => response.body?.posted).sort(),
    [false, true],
  )

  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM messages
      WHERE conversation_id = $1
        AND kind = 'system'
        AND body::jsonb ->> 'noticeKind' = 'same-key'`,
    [conversationId],
  )
  assert.equal(rows[0]?.count, 1)
})

test('[integration] runtime notices: the same dedupe key is independent across tenants', async () => {
  const tenantA = await seedAgent()
  const tenantB = await seedAgent()
  const conversationA = await seedGroup(tenantA.companyId, [tenantA.agentId])
  const conversationB = await seedGroup(tenantB.companyId, [tenantB.agentId])
  const dedupeKey = `shared-${randomUUID()}`

  const [responseA, responseB] = await Promise.all([
    call('/runtime/notices', {
      token: tenantA.token,
      body: {
        conversationId: conversationA,
        noticeKind: 'cross-tenant-key',
        text: 'tenant A',
        dedupeKey,
        dedupeTtlSec: 60,
      },
    }),
    call('/runtime/notices', {
      token: tenantB.token,
      body: {
        conversationId: conversationB,
        noticeKind: 'cross-tenant-key',
        text: 'tenant B',
        dedupeKey,
        dedupeTtlSec: 60,
      },
    }),
  ])
  assert.equal(responseA.status, 200, JSON.stringify(responseA.body))
  assert.equal(responseB.status, 200, JSON.stringify(responseB.body))
  assert.equal(responseA.body?.posted, true)
  assert.equal(responseB.body?.posted, true)

  const { rows } = await pool.query<{ company_id: string; count: number }>(
    `SELECT company_id, COUNT(*)::int AS count
       FROM messages
      WHERE conversation_id = ANY($1::text[])
        AND body::jsonb ->> 'noticeKind' = 'cross-tenant-key'
      GROUP BY company_id
      ORDER BY company_id`,
    [[conversationA, conversationB]],
  )
  const expected: Array<[string, number]> = [
    [tenantA.companyId, 1],
    [tenantB.companyId, 1],
  ]
  expected.sort(([a], [b]) => a.localeCompare(b))
  assert.deepEqual(rows.map((row): [string, number] => [row.company_id, row.count]), expected)
})

test('[integration] runtime auxiliary routes reject a same-tenant conversation non-member before side effects', async () => {
  const outsider = await seedAgent()
  const member = await seedAgent(outsider.companyId)
  const conversationId = await seedGroup(outsider.companyId, [member.agentId])
  const messageId = await seedMessage({
    conversationId,
    companyId: outsider.companyId,
    authorId: member.agentId,
    body: 'private',
  })
  const typingThrottleKey = `cumora:typ:${outsider.agentId}:${conversationId}`
  const reverseThinkingKey = `cumora:agent-thinking-convos:${outsider.agentId}`
  const claimKey = worklogKey(conversationId)
  const claimField = worklogField('web-search', 'private subject')
  const existingClaim = JSON.stringify({
    agentId: outsider.agentId,
    taskType: 'web-search',
    subject: 'private subject',
    startedAt: Date.now(),
  })
  await redis.zadd(thinkingKey(conversationId), 123, outsider.agentId)
  await redis.expire(thinkingKey(conversationId), 60)
  await redis.hset(claimKey, claimField, existingClaim)
  await redis.expire(claimKey, 60)

  try {
    const probes = [
      ['typing', '/runtime/typing', 'POST', { conversationId, done: false }],
      ['thinking mark', '/runtime/thinking/mark', 'POST', { conversationIds: [conversationId], ttlSec: 60 }],
      ['thinking unmark', '/runtime/thinking/unmark', 'POST', { conversationIds: [conversationId] }],
      ['thinking peek', `/runtime/thinking/peek?conversationId=${encodeURIComponent(conversationId)}`, 'GET', undefined],
      ['worklog claim', '/runtime/worklog/claim', 'POST', {
        scopeKey: conversationId, taskType: 'web-search', subject: 'private subject', ttlSec: 60,
      }],
      ['worklog release', '/runtime/worklog/release', 'POST', {
        scopeKey: conversationId, taskType: 'web-search', subject: 'private subject',
      }],
      ['worklog peek', `/runtime/worklog/peek?scopeKey=${encodeURIComponent(conversationId)}`, 'GET', undefined],
      ['mark read', '/runtime/conversation/mark-read', 'POST', {
        conversationId, upToMessageId: messageId,
      }],
    ] as const

    for (const [label, path, method, body] of probes) {
      const response = await call(path, { token: outsider.token, method, body })
      assert.equal(response.status, 403, `${label}: ${JSON.stringify(response.body)}`)
    }

    assert.equal(await redis.get(typingThrottleKey), null, 'rejected typing request wrote its throttle key')
    assert.equal(await redis.get(reverseThinkingKey), null, 'rejected thinking request wrote its reverse index')
    assert.equal(await redis.zscore(thinkingKey(conversationId), outsider.agentId), '123', 'rejected unmark changed the claim')
    assert.equal(await redis.hget(claimKey, claimField), existingClaim, 'rejected release changed the worklog')
    const { rows } = await pool.query(
      `SELECT 1 FROM conversation_reads WHERE user_id = $1 AND conversation_id = $2`,
      [outsider.agentId, conversationId],
    )
    assert.equal(rows.length, 0, 'rejected mark-read advanced a cursor')
  } finally {
    await redis.del(typingThrottleKey, reverseThinkingKey, thinkingKey(conversationId), claimKey)
  }
})

test('[integration] runtime mark-read binds the message to the requested conversation', async () => {
  const agent = await seedAgent()
  const peer = await seedAgent(agent.companyId)
  const readableConversation = await seedGroup(agent.companyId, [agent.agentId, peer.agentId])
  const otherConversation = await seedGroup(agent.companyId, [peer.agentId])
  const otherMessage = await seedMessage({
    conversationId: otherConversation,
    companyId: agent.companyId,
    authorId: peer.agentId,
    body: 'belongs elsewhere',
  })

  const response = await call('/runtime/conversation/mark-read', {
    token: agent.token,
    body: { conversationId: readableConversation, upToMessageId: otherMessage },
  })
  assert.equal(response.status, 403, JSON.stringify(response.body))
  const { rows } = await pool.query(
    `SELECT 1 FROM conversation_reads WHERE user_id = $1`,
    [agent.agentId],
  )
  assert.equal(rows.length, 0)
})

test('[integration] runtime mark-read accepts only the kicked agent\'s durable departure row', async () => {
  const actor = await seedAgent()
  const target = await seedAgent(actor.companyId)
  const peer = await seedAgent(actor.companyId)
  const conversationId = await seedGroup(actor.companyId, [actor.agentId, target.agentId, peer.agentId])
  const ordinaryMessage = await seedMessage({
    conversationId,
    companyId: actor.companyId,
    authorId: peer.agentId,
    body: 'ordinary history',
  })

  const kick = await runCli(['--as', actor.agentId, 'kick', conversationId, target.agentId])
  assert.equal(kick.ok, true, kick.text)
  const { rows: departures } = await pool.query<{ id: string }>(
    `SELECT id FROM messages
      WHERE conversation_id = $1
        AND kind = 'system'
        AND delivery_recipient_id = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [conversationId, target.agentId],
  )
  const departureMessage = departures[0]?.id
  assert.ok(departureMessage, 'kick did not persist a durable departure recipient')

  const ordinary = await call('/runtime/conversation/mark-read', {
    token: target.token,
    body: { conversationId, upToMessageId: ordinaryMessage },
  })
  assert.equal(ordinary.status, 403, 'departure exception leaked to an ordinary message')

  const departure = await call('/runtime/conversation/mark-read', {
    token: target.token,
    body: { conversationId, upToMessageId: departureMessage },
  })
  assert.equal(departure.status, 200, JSON.stringify(departure.body))

  // A retry is harmless and does not create a second cursor row.
  const retry = await call('/runtime/conversation/mark-read', {
    token: target.token,
    body: { conversationId, upToMessageId: departureMessage },
  })
  assert.equal(retry.status, 200, JSON.stringify(retry.body))
  const { rows } = await pool.query<{ last_read_message_id: string }>(
    `SELECT last_read_message_id FROM conversation_reads
      WHERE user_id = $1 AND conversation_id = $2`,
    [target.agentId, conversationId],
  )
  assert.deepEqual(rows, [{ last_read_message_id: departureMessage }])
})
