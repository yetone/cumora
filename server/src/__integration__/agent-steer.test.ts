/**
 * Integration tests for mid-turn steering. With real Postgres + Redis,
 * exercise the end-to-end path:
 *
 *  1. A turn is running.
 *  2. While the model is mid-hop (slow tool call), pushSteer queues a
 *     new user message.
 *  3. The hop loop's drain at the next boundary injects the steered
 *     items into history.
 *  4. The model's NEXT LLM call sees them in the input items.
 *  5. At turn end, conversation_reads is advanced past the steered
 *     messageIds so the next wake's loadInbox doesn't surface them
 *     again.
 *
 * We don't exercise the wake-bus → SSE path here (that's plumbing
 * covered by Phase 2 + the unit tests in agents-steer.test.ts).
 * pushSteer is called directly from within a tool stub to simulate
 * the "steer arrived mid-turn" condition deterministically.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Response } from 'express'
import type { ResponseStreamEvent, ResponseInputItem } from 'openai/resources/responses/responses'
import { pool } from '../db/pool.js'
import { redis } from '../redis.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'
import { __setPodToolOverrideForTesting } from '../agents/runtime/pod-tools.js'
import type { ToolResult } from '../agents/tools-shared.js'
import { runAgentTurn } from '../agents/turn.js'
import { pushSteer, DEBOUNCE_MS, _resetAllSteerForTests } from '../agents/steer.js'
import {
  attachWakeStream,
  deliver as deliverWake,
  deliverSteer,
} from '../agents/runtime/wake-bus.js'
import { busyKey, isAgentBusy } from '../agents/runtime/inproc-client.js'
import { wakeAgent, _resetSteerRateForTests } from '../agents/scheduler.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
  __setLlmClientOverrideForTesting(null)
  __setPodToolOverrideForTesting(null)
  _resetAllSteerForTests()
})

after(async () => {
  __setLlmClientOverrideForTesting(null)
  __setPodToolOverrideForTesting(null)
  await teardownAll()
})

// ── shared helpers (kept local to keep file self-contained) ────────────

/** LLM stub that captures the input items of each `responses.create`
 *  call. Tests assert on `capturedInputs[hop]` to verify what the
 *  model saw — that's how we prove the steer landed in history. */
function makeLlmStub(streams: ResponseStreamEvent[][]): {
  install: () => void
  callCount: () => number
  capturedInputs: ResponseInputItem[][]
} {
  let calls = 0
  const capturedInputs: ResponseInputItem[][] = []
  return {
    install: () => {
      __setLlmClientOverrideForTesting(async () => {
        return {
          responses: {
            create: async (req: unknown) => {
              const r = req as { input?: ResponseInputItem[] }
              capturedInputs.push(Array.isArray(r.input) ? [...r.input] : [])
              const idx = calls++
              if (idx >= streams.length) {
                throw new Error(`stub LLM exhausted at call ${idx + 1}, only ${streams.length} streams scripted`)
              }
              const events = streams[idx]
              return (async function *() {
                for (const ev of events) yield ev
              })()
            },
          },
        } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
      })
    },
    callCount: () => calls,
    capturedInputs,
  }
}

function makeToolStub(handlers: Record<string, (parsed: Record<string, unknown>, raw: { agentId: string; argsJson: string }) => ToolResult | Promise<ToolResult>>): {
  install: () => void
  calls: Array<{ name: string; parsed: Record<string, unknown> }>
} {
  const calls: Array<{ name: string; parsed: Record<string, unknown> }> = []
  return {
    install: () => {
      __setPodToolOverrideForTesting(async (args) => {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(args.argsJson || '{}') } catch { /* keep empty */ }
        calls.push({ name: args.name, parsed })
        const handler = handlers[args.name]
        if (!handler) {
          if (args.name === 'set_turn_status') {
            return {
              ok: true,
              output: {
                status: String(parsed.status ?? 'done'),
                reason: String(parsed.reason ?? ''),
                nextStep: String(parsed.next_step ?? ''),
                assistantTextAction: String(parsed.assistant_text ?? 'none'),
                replyConversationId: parsed.reply_conversation_id ? String(parsed.reply_conversation_id) : null,
              },
              durationMs: 1,
              display: { name: 'set_turn_status', arg: String(parsed.status ?? 'done'), status: 'done', detail: String(parsed.reason ?? '') },
            }
          }
          return { ok: false, output: null, error: 'unknown tool', durationMs: 0,
                   display: { name: args.name, arg: '', status: 'unknown', detail: 'not stubbed' } }
        }
        return handler(parsed, { agentId: args.agentId, argsJson: args.argsJson })
      })
    },
    calls,
  }
}

async function seedConvo(): Promise<{ companyId: string; agentId: string; humanId: string; conversationId: string }> {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const humanId = `u-${randomUUID().slice(0, 8)}`
  const conversationId = `direct-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [companyId, `Test ${companyId}`, companyId, humanId],
  )
  await pool.query(
    `INSERT INTO users (id, email, display_name, tier) VALUES ($1, $2, $3, 'free')`,
    [humanId, `${humanId}@test.local`, humanId],
  )
  await pool.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, humanId],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail')`,
    [agentId, companyId, `Agent ${agentId}`, agentId.slice(6, 7).toUpperCase()],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')`,
    [humanId, companyId, humanId, 'Y'],
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'direct', $2, $3::jsonb, 'human', $4)`,
    [conversationId, humanId, JSON.stringify([agentId, humanId]), companyId],
  )
  return { companyId, agentId, humanId, conversationId }
}

async function postHumanMessage(opts: {
  conversationId: string; companyId: string; humanId: string; body: string; sequence?: number
}): Promise<string> {
  const messageId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
    [messageId, opts.conversationId, opts.humanId, opts.body, opts.sequence ?? 1, opts.companyId],
  )
  return messageId
}

function streamWithToolCall(opts: { fcId: string; callId: string; name: string; argsJson: string }): ResponseStreamEvent[] {
  return [
    { type: 'response.created', response: { id: `resp_${randomUUID().slice(0, 8)}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
    { type: 'response.output_item.added', item: { id: opts.fcId, type: 'function_call', call_id: opts.callId, name: opts.name, arguments: '' } } as unknown as ResponseStreamEvent,
    { type: 'response.function_call_arguments.done', item_id: opts.fcId, arguments: opts.argsJson } as unknown as ResponseStreamEvent,
    { type: 'response.completed', response: { status: 'completed', output: [{ id: opts.fcId, type: 'function_call', call_id: opts.callId, name: opts.name, arguments: opts.argsJson }], usage: { input_tokens: 200, output_tokens: 40 } } } as unknown as ResponseStreamEvent,
  ]
}

function streamSetTurnStatus(opts: {
  status?: string
  reason?: string
  assistantText?: 'none' | 'reply' | 'drop'
  replyConversationId?: string | null
} = {}): ResponseStreamEvent[] {
  const argsJson = JSON.stringify({
    status: opts.status ?? 'done',
    reason: opts.reason ?? 'test complete',
    next_step: '',
    assistant_text: opts.assistantText ?? 'none',
    reply_conversation_id: opts.replyConversationId ?? null,
  })
  return streamWithToolCall({
    fcId: `fc_status_${randomUUID().slice(0, 6)}`,
    callId: `call_status_${randomUUID().slice(0, 6)}`,
    name: 'set_turn_status',
    argsJson,
  })
}

async function eventsForAgent(agentId: string): Promise<Array<{ kind: string; data: unknown }>> {
  const { rows } = await pool.query<{ kind: string; data: unknown }>(
    `SELECT kind, data FROM agent_events WHERE agent_id = $1 ORDER BY created_at, kind`,
    [agentId],
  )
  return rows
}

/** Flatten a captured LLM input array into one big string we can grep
 *  for the steer prompt. Walks every input_text block we recognize. */
function flattenInput(input: ResponseInputItem[]): string {
  const parts: string[] = []
  for (const it of input) {
    const r = it as unknown as { role?: string; content?: Array<{ type?: string; text?: string }>; output?: string }
    if (Array.isArray(r.content)) {
      for (const c of r.content) {
        if (typeof c.text === 'string') parts.push(c.text)
      }
    }
    if (typeof r.output === 'string') parts.push(r.output)
  }
  return parts.join('\n---\n')
}

// ── tests ──────────────────────────────────────────────────────────────

test('[integration] steer (verbatim path): mid-turn message lands in next hop input + cursor advances', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo()
  await postHumanMessage({ conversationId, companyId, humanId, body: 'original task: list files', sequence: 1 })

  // The "steered" message we'll push mid-turn. Insert it into the DB
  // too (Phase 4 always writes to DB first, then publishes the steer
  // event — we mirror that ordering here for the cursor-advancement
  // assertion to be meaningful).
  const steeredMessageId = await postHumanMessage({
    conversationId, companyId, humanId, body: 'wait, also include hidden files', sequence: 2,
  })

  const llm = makeLlmStub([
    // Hop 1: bash to list files (slow).
    streamWithToolCall({ fcId: 'fc_ls', callId: 'call_ls', name: 'bash', argsJson: JSON.stringify({ command: 'ls' }) }),
    // Hop 2: model has now seen the steered message; reply incorporating it.
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} 'here are the files, including hidden ones'` }),
    }),
    // Hop 3: no further work → explicit protocol termination.
    streamSetTurnStatus(),
  ])
  llm.install()

  let injected = false
  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (!injected && cmd === 'ls') {
        injected = true
        // Mid-flight: push a steer for the message we just inserted.
        pushSteer(agentId, {
          messageId: steeredMessageId,
          conversationId,
          authorName: 'alice',
          body: 'wait, also include hidden files',
          arrivedAt: Date.now(),
        })
        // Wait past the debounce window so the next hop's drain check
        // returns true.
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200))
        return { ok: true, output: { stdout: 'file1\nfile2\n', stderr: '', exitCode: 0 }, durationMs: DEBOUNCE_MS + 200,
                 display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
      }
      // cumora reply path — write the actual reply row so we can assert it.
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
             VALUES ($1, $2, $3, 'text', $4, 3, $5)`,
          [messageId, convoId, agentId, body, companyId],
        )
        return { ok: true, output: { stdout: 'sent', stderr: '', exitCode: 0 }, durationMs: 1,
                 display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
      }
      return { ok: true, output: { stdout: '', stderr: '', exitCode: 0 }, durationMs: 1,
               display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
    },
  })
  tools.install()

  await runAgentTurn(agentId)

  // ── assertion 1: the second LLM call's input contains the steered text ──
  assert.ok(llm.capturedInputs.length >= 2, 'at least 2 LLM calls expected')
  const secondInput = flattenInput(llm.capturedInputs[1])
  assert.match(secondInput, /Mid-turn update/, 'second hop input should carry the steer banner')
  assert.match(secondInput, /also include hidden files/, 'second hop input should carry the steered body verbatim (small batch)')
  assert.match(secondInput, /@alice/, 'verbatim render uses @authorName prefix')

  // ── assertion 2: a turn.steered event was recorded ──
  const ev = await eventsForAgent(agentId)
  const steered = ev.find((e) => e.kind === 'turn.steered')
  assert.ok(steered, 'turn.steered event must be recorded')
  const stData = steered!.data as { batchSize?: number; usedSummary?: boolean; messageIds?: string[] }
  assert.equal(stData.batchSize, 1)
  assert.equal(stData.usedSummary, false, 'a 1-message batch is rendered verbatim, not summarized')
  assert.deepEqual(stData.messageIds, [steeredMessageId])

  // ── assertion 3: conversation_reads cursor advanced past the steered message ──
  const { rows: readRows } = await pool.query<{ last_read_at: Date }>(
    `SELECT last_read_at FROM conversation_reads
       WHERE user_id = $1 AND conversation_id = $2`,
    [agentId, conversationId],
  )
  assert.equal(readRows.length, 1, 'conversation_reads row should exist for the agent')
  const { rows: msgRows } = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM messages WHERE id = $1`, [steeredMessageId],
  )
  assert.ok(msgRows[0])
  assert.ok(
    readRows[0].last_read_at.getTime() >= msgRows[0].created_at.getTime(),
    'last_read_at must be at or past the steered message\'s created_at',
  )
})

// ── Fix #1/#1b: end-to-end wire — deliverSteer → SSE delivery ─────────

/** Minimal Express-Response stub for attachWakeStream. Captures every
 *  `write()` call so the test can assert on the SSE frames the
 *  pod would have received. Mixes in EventEmitter so the close/error
 *  events the wake-bus listens for still work. */
function makeFakeSseResponse(): Response & {
  written: string[]
  closed: boolean
  triggerClose: () => void
} {
  const ee = new EventEmitter()
  const written: string[] = []
  const headers: Record<string, string> = {}
  const fake = Object.assign(ee, {
    written,
    closed: false,
    setHeader: (k: string, v: string) => { headers[k] = v },
    flushHeaders: () => { /* noop */ },
    write: (s: string) => { if (!fake.closed) written.push(s); return true },
    end: () => { if (!fake.closed) { fake.closed = true; ee.emit('close') } },
    triggerClose: () => { fake.closed = true; ee.emit('close') },
  }) as unknown as Response & { written: string[]; closed: boolean; triggerClose: () => void }
  return fake
}

/** Parse SSE blocks from a sequence of `write()` payloads. Mirrors
 *  the parseSseStream in pod-agent.ts; kept simpler here since the
 *  test controls the input format. */
function parseSseFrames(writes: string[]): Array<{ event?: string; data?: string; id?: string }> {
  const joined = writes.join('')
  const blocks = joined.split(/\n\n/).filter((b) => b.length > 0 && !b.startsWith(':'))
  return blocks.map((block) => {
    const out: { event?: string; data?: string; id?: string } = {}
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const field = line.slice(0, colon)
      const value = line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') out.event = value
      else if (field === 'data') out.data = value
      else if (field === 'id') out.id = value
    }
    return out
  })
}

test('[integration] wire: deliverSteer publishes via Redis pubsub → wake-bus SSE → fake subscriber', async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const res = makeFakeSseResponse()
  await attachWakeStream(agentId, res)

  // Small wait so the Redis SUBSCRIBE round-trip completes before we
  // publish; otherwise the publish reaches no subscriber and the test
  // is racy. The wake-bus does `await redisSub.subscribe(...)` first
  // before logging "+sub", so the await above SHOULD be enough — but
  // give an extra tick for the message dispatcher.
  await new Promise((r) => setTimeout(r, 100))

  const delivered = await deliverSteer(agentId, {
    conversationId: 'c-123',
    messageId: 'm-abc',
    authorName: 'alice',
    body: 'hey @nova check the auth module',
  })
  assert.ok(delivered >= 1, 'at least one subscriber should receive (the fake)')

  // Give Redis pub/sub a moment to fan out — the broker is local, so
  // this is ~ms in practice, but node:test exits eagerly without a
  // small await.
  await new Promise((r) => setTimeout(r, 100))

  const frames = parseSseFrames(res.written)
  const steerFrame = frames.find((f) => f.event === 'steer')
  assert.ok(steerFrame, 'a steer SSE frame must have been delivered')
  assert.ok(steerFrame!.id?.startsWith('steer-'), 'event id should be prefixed steer-<uuid>')
  const payload = JSON.parse(steerFrame!.data ?? '{}')
  assert.equal(payload.kind, 'steer')
  assert.equal(payload.messageId, 'm-abc')
  assert.equal(payload.conversationId, 'c-123')
  assert.equal(payload.authorName, 'alice')
  assert.equal(payload.body, 'hey @nova check the auth module')

  res.triggerClose()
})

test('[integration] wake stream revalidates authorization before delivering an event', async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const res = makeFakeSseResponse()
  let checks = 0
  await attachWakeStream(agentId, res, {
    authorize: async () => { checks += 1; return false },
  })
  await new Promise((r) => setTimeout(r, 100))

  await deliverWake(agentId, {
    kind: 'wake',
    reason: 'message.new',
    conversationId: 'new-tenant-conversation',
  })
  await new Promise((r) => setTimeout(r, 100))

  const frames = parseSseFrames(res.written)
  assert.equal(checks, 1)
  assert.equal(res.closed, true)
  assert.equal(frames.some((frame) => frame.event === 'wake'), false)
})

test('[integration] wire: scheduler.wakeAgent routes BOTH wake AND steer when agent is busy', async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const res = makeFakeSseResponse()
  await attachWakeStream(agentId, res)
  await new Promise((r) => setTimeout(r, 100))

  // Set the busy lease the scheduler checks. 30s is plenty for the
  // test to complete.
  await redis.set(busyKey(agentId), String(Date.now()), 'EX', 30)
  assert.equal(await isAgentBusy(agentId), true, 'busy lease should read true')

  await wakeAgent(agentId, 'message.new', 'c-456', {
    messageId: 'm-xyz',
    conversationId: 'c-456',
    authorName: 'bob',
    body: 'wait, change the plan',
  })
  await new Promise((r) => setTimeout(r, 200))

  const frames = parseSseFrames(res.written)
  const wakeFrame = frames.find((f) => f.event === 'wake')
  const steerFrame = frames.find((f) => f.event === 'steer')
  assert.ok(wakeFrame, 'wake event must be delivered (always — steer is additive)')
  assert.ok(steerFrame, 'steer event must ALSO be delivered when agent is busy')
  const stPayload = JSON.parse(steerFrame!.data ?? '{}')
  assert.equal(stPayload.body, 'wait, change the plan')

  await redis.del(busyKey(agentId))
  res.triggerClose()
})

test('[integration] wire: scheduler.wakeAgent does NOT deliver steer when agent is idle', async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const res = makeFakeSseResponse()
  await attachWakeStream(agentId, res)
  await new Promise((r) => setTimeout(r, 100))

  // No busy lease set → agent reads as idle.
  assert.equal(await isAgentBusy(agentId), false)

  await wakeAgent(agentId, 'message.new', 'c-789', {
    messageId: 'm-quiet',
    conversationId: 'c-789',
    authorName: 'carol',
    body: 'normal message — should not steer',
  })
  await new Promise((r) => setTimeout(r, 200))

  const frames = parseSseFrames(res.written)
  assert.ok(frames.some((f) => f.event === 'wake'), 'wake fires regardless')
  assert.equal(
    frames.filter((f) => f.event === 'steer').length,
    0,
    'NO steer event when agent is idle — message reaches via normal inbox',
  )

  res.triggerClose()
})

// ── Fix #3: summarizer path (batch > SUMMARIZE_THRESHOLD) ─────────────

test('[integration] steer (summary path): >3 batched messages → cheap-model summarizer call', async () => {
  // Phase 5 only tested the verbatim path (1 message). Here we
  // exercise the >3 case so summarizeSteerBatch and its prompt are
  // actually proven to run end-to-end.
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const humanId = `u-${randomUUID().slice(0, 8)}`
  const conversationId = `direct-${randomUUID().slice(0, 8)}`
  await pool.query(`INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
    [companyId, `T ${companyId}`, companyId, humanId])
  await pool.query(`INSERT INTO users (id, email, display_name, tier) VALUES ($1, $2, $3, 'free')`,
    [humanId, `${humanId}@test.local`, humanId])
  await pool.query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [companyId, humanId])
  await pool.query(`INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', 'N', '#abcdef', 'avail')`, [agentId, companyId, `Agent ${agentId}`])
  await pool.query(`INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', 'Y', '#abcdef', 'avail')`, [humanId, companyId, humanId])
  await pool.query(`INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'direct', $2, $3::jsonb, 'human', $4)`,
    [conversationId, humanId, JSON.stringify([agentId, humanId]), companyId])

  // Initial wake message
  const initId = `m-${randomUUID()}`
  await pool.query(`INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', 'start task', 1, $4)`, [initId, conversationId, humanId, companyId])

  // Pre-seed 5 steer-target messages in the DB so loadInbox-style
  // dedup at turn end has real rows to advance the cursor against.
  const steerIds: string[] = []
  for (let i = 0; i < 5; i++) {
    const id = `m-steer-${i}-${randomUUID().slice(0, 6)}`
    await pool.query(`INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
         VALUES ($1, $2, $3, 'text', $4, $5, $6)`,
      [id, conversationId, humanId, `mid-turn correction #${i}`, 2 + i, companyId])
    steerIds.push(id)
  }

  // LLM stub scripted for the 3-call sequence:
  //   #0 = hop 1 main response (bash call)
  //   #1 = summarizer call (because batch.length=5 > threshold=3)
  //   #2 = hop 2 main response (cumora reply)
  const SUMMARY_TEXT = 'User reversed direction five times; latest instruction wins: do X.'
  let callIdx = 0
  const capturedInputs: ResponseInputItem[][] = []
  const capturedModels: string[] = []
  const capturedInstructions: string[] = []
  __setLlmClientOverrideForTesting(async () => ({
    responses: {
      create: async (req: unknown) => {
        const r = req as { input?: ResponseInputItem[]; model?: string; instructions?: string }
        capturedInputs.push(Array.isArray(r.input) ? [...r.input] : [])
        capturedModels.push(String(r.model ?? ''))
        capturedInstructions.push(String(r.instructions ?? ''))
        const idx = callIdx++
        if (idx === 0) {
          // hop 1: bash tool call
          return (async function *() {
            yield { type: 'response.created', response: { id: 'r1', status: 'in_progress' } } as unknown as ResponseStreamEvent
            yield { type: 'response.output_item.added', item: { id: 'fc_b', type: 'function_call', call_id: 'cb', name: 'bash', arguments: '' } } as unknown as ResponseStreamEvent
            yield { type: 'response.function_call_arguments.done', item_id: 'fc_b', arguments: JSON.stringify({ command: 'work' }) } as unknown as ResponseStreamEvent
            yield { type: 'response.completed', response: { status: 'completed', output: [{ id: 'fc_b', type: 'function_call', call_id: 'cb', name: 'bash', arguments: JSON.stringify({ command: 'work' }) }], usage: { input_tokens: 100, output_tokens: 10 } } } as unknown as ResponseStreamEvent
          })()
        }
        if (idx === 1) {
          // summarizer call — returns the summary text
          return (async function *() {
            yield { type: 'response.created', response: { id: 'r-sum', status: 'in_progress' } } as unknown as ResponseStreamEvent
            yield { type: 'response.output_text.delta', item_id: 'msg', content_index: 0, delta: SUMMARY_TEXT } as unknown as ResponseStreamEvent
            yield { type: 'response.output_text.done', item_id: 'msg', content_index: 0, text: SUMMARY_TEXT } as unknown as ResponseStreamEvent
            yield { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 200, output_tokens: 40 } } } as unknown as ResponseStreamEvent
          })()
        }
        if (idx === 2) {
          // hop 2: cumora reply
          return (async function *() {
            yield { type: 'response.created', response: { id: 'r2', status: 'in_progress' } } as unknown as ResponseStreamEvent
            yield { type: 'response.output_item.added', item: { id: 'fc_r', type: 'function_call', call_id: 'cr', name: 'bash', arguments: '' } } as unknown as ResponseStreamEvent
            yield { type: 'response.function_call_arguments.done', item_id: 'fc_r', arguments: JSON.stringify({ command: `cumora reply ${conversationId} 'done X'` }) } as unknown as ResponseStreamEvent
            yield { type: 'response.completed', response: { status: 'completed', output: [{ id: 'fc_r', type: 'function_call', call_id: 'cr', name: 'bash', arguments: JSON.stringify({ command: `cumora reply ${conversationId} 'done X'` }) }], usage: { input_tokens: 250, output_tokens: 20 } } } as unknown as ResponseStreamEvent
          })()
        }
        if (idx === 3) {
          return (async function *() {
            for (const ev of streamSetTurnStatus()) yield ev
          })()
        }
        throw new Error(`unexpected LLM call #${idx + 1}`)
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)

  // Tool stub: bash 'work' pushes 5 steers + sleeps past DEBOUNCE; reply writes a row.
  let injected = false
  __setPodToolOverrideForTesting(async (args): Promise<ToolResult> => {
    const parsed = JSON.parse(args.argsJson || '{}') as { command?: string }
    if (args.name === 'set_turn_status') {
      return {
        ok: true,
        output: {
          status: String((parsed as Record<string, unknown>).status ?? 'done'),
          reason: String((parsed as Record<string, unknown>).reason ?? ''),
          nextStep: String((parsed as Record<string, unknown>).next_step ?? ''),
          assistantTextAction: String((parsed as Record<string, unknown>).assistant_text ?? 'none'),
          replyConversationId: (parsed as Record<string, unknown>).reply_conversation_id
            ? String((parsed as Record<string, unknown>).reply_conversation_id)
            : null,
        },
        durationMs: 1,
        display: { name: 'set_turn_status', arg: 'done', status: 'done', detail: '' },
      }
    }
    const cmd = String(parsed.command ?? '')
    if (cmd === 'work' && !injected) {
      injected = true
      for (let i = 0; i < 5; i++) {
        pushSteer(agentId, {
          messageId: steerIds[i],
          conversationId,
          authorName: 'alice',
          body: `mid-turn correction #${i}`,
          arrivedAt: Date.now(),
        })
      }
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200))
      return { ok: true, output: { stdout: 'ok', stderr: '', exitCode: 0 }, durationMs: DEBOUNCE_MS + 200,
               display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
    }
    const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
    if (matched) {
      const messageId = `m-${randomUUID()}`
      await pool.query(`INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
           VALUES ($1, $2, $3, 'text', $4, 10, $5)`,
        [messageId, matched[1], agentId, matched[2], companyId])
      return { ok: true, output: { stdout: 'sent', stderr: '', exitCode: 0 }, durationMs: 1,
               display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
    }
    return { ok: true, output: null, durationMs: 0,
             display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
  })

  await runAgentTurn(agentId)

  // ── assertion 1: the summarizer was invoked.
  // Call sequence: idx=0 hop1 (bash) → idx=1 summarizer →
  // idx=2 hop2 (cumora reply) → idx=3 terminator (no-tools text exit).
  assert.equal(callIdx, 4, 'should have made 4 LLM calls: hop1, summarizer, hop2, terminator')

  // ── assertion 2: the summarizer instructions match our prompt
  // (the agent-steering summarizer, not the auto-compaction one)
  assert.match(capturedInstructions[1], /summarizing a batch of \d+ messages/)
  assert.match(capturedInstructions[1], /mid-turn/i)

  // ── assertion 3: hop2's input contains the summary banner + text,
  // NOT all 5 verbatim bodies
  const hop2Text = capturedInputs[2]
    .flatMap((it) => {
      const r = it as { content?: Array<{ text?: string }> }
      return Array.isArray(r.content) ? r.content.map((c) => c.text ?? '') : []
    })
    .join('\n---\n')
  assert.match(hop2Text, /\[Mid-turn update — summary of 5/,
    'hop2 input must show the summary banner, not the verbatim banner')
  assert.match(hop2Text, new RegExp(SUMMARY_TEXT.slice(0, 30)),
    'hop2 input must contain the summarizer\'s actual output')

  // ── assertion 4: turn.steered event records usedSummary=true
  const { rows: ev } = await pool.query<{ data: { usedSummary?: boolean; batchSize?: number } }>(
    `SELECT data FROM agent_events WHERE agent_id = $1 AND kind = 'turn.steered'`, [agentId])
  assert.equal(ev.length, 1)
  assert.equal(ev[0].data.batchSize, 5)
  assert.equal(ev[0].data.usedSummary, true, 'turn.steered.usedSummary must be true for >3-item batches')
})

test('[integration] steer force-continuation: text-only hop + pending steer → loop continues with draft+steer in user item', async () => {
  // The fragile branch that previously synthesized a fake assistant
  // output_text. This test pins the new behavior: when the model
  // exits with text-only output AND a steer is pending, we drain
  // the steer (passing the draft text), continue the loop, and the
  // NEXT hop sees BOTH the model's would-be answer AND the new
  // user input in a single well-formed user item.
  const { companyId, agentId, humanId, conversationId } = await seedConvo()
  const initId = await postHumanMessage({ conversationId, companyId, humanId, body: 'what is 2+2?', sequence: 1 })
  void initId

  // The steered message must be in the DB so dedup at turn-end works.
  const steeredId = await postHumanMessage({
    conversationId, companyId, humanId, body: 'actually never mind, what is 3+3 instead', sequence: 2,
  })

  const DRAFT = 'The answer is 4.'
  let llmCallIdx = 0
  const capturedInputs: ResponseInputItem[][] = []
  __setLlmClientOverrideForTesting(async () => ({
    responses: {
      create: async (req: unknown) => {
        const r = req as { input?: ResponseInputItem[] }
        capturedInputs.push(Array.isArray(r.input) ? [...r.input] : [])
        const idx = llmCallIdx++
        if (idx === 0) {
          // Hop 1: text-only response — about to exit no-tools.
          // The pre-LLM-call code path doesn't pre-drain steers, so
          // the steer must be enqueued BEFORE this call returns. We
          // do that from the test side by pushing the steer right
          // BEFORE this stub is invoked. But there's no hook —
          // we'll use the trick that __setLlmClientOverrideForTesting
          // is called once per hop, and inside the FIRST hop's
          // stream we push the steer synchronously.
          return (async function *() {
            // Push the steer NOW (just before yielding text events
            // — the model "is thinking" and the user "is typing").
            pushSteer(agentId, {
              messageId: steeredId,
              conversationId,
              authorName: 'alice',
              body: 'actually never mind, what is 3+3 instead',
              arrivedAt: Date.now(),
            })
            yield { type: 'response.created', response: { id: 'r1', status: 'in_progress' } } as unknown as ResponseStreamEvent
            yield { type: 'response.output_text.delta', item_id: 'msg', content_index: 0, delta: DRAFT } as unknown as ResponseStreamEvent
            yield { type: 'response.output_text.done', item_id: 'msg', content_index: 0, text: DRAFT } as unknown as ResponseStreamEvent
            // Buy time for the debounce window so the next hop's
            // drain check returns true. Stream events are async so
            // we can sleep here without crashing the harness.
            await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200))
            yield { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 50, output_tokens: 10 } } } as unknown as ResponseStreamEvent
          })()
        }
        if (idx === 1) {
          // Hop 2: continuation triggered by steer drain. Model
          // sees the original prompt + draft answer + the new
          // user input. Respond with cumora reply to "3+3".
          return (async function *() {
            yield { type: 'response.created', response: { id: 'r2', status: 'in_progress' } } as unknown as ResponseStreamEvent
            yield { type: 'response.output_item.added', item: { id: 'fc_r', type: 'function_call', call_id: 'cr', name: 'bash', arguments: '' } } as unknown as ResponseStreamEvent
            yield { type: 'response.function_call_arguments.done', item_id: 'fc_r', arguments: JSON.stringify({ command: `cumora reply ${conversationId} 'The answer to 3+3 is 6.'` }) } as unknown as ResponseStreamEvent
            yield { type: 'response.completed', response: { status: 'completed', output: [{ id: 'fc_r', type: 'function_call', call_id: 'cr', name: 'bash', arguments: JSON.stringify({ command: `cumora reply ${conversationId} 'The answer to 3+3 is 6.'` }) }], usage: { input_tokens: 200, output_tokens: 15 } } } as unknown as ResponseStreamEvent
          })()
        }
        // Hop 3+: terminator
        return (async function *() {
          yield { type: 'response.created', response: { id: 'r-end', status: 'in_progress' } } as unknown as ResponseStreamEvent
          yield { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 50, output_tokens: 0 } } } as unknown as ResponseStreamEvent
        })()
      },
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)

  __setPodToolOverrideForTesting(async (args): Promise<ToolResult> => {
    const parsed = JSON.parse(args.argsJson || '{}') as { command?: string }
    const cmd = String(parsed.command ?? '')
    const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
    if (matched) {
      const id = `m-${randomUUID()}`
      await pool.query(`INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
        VALUES ($1, $2, $3, 'text', $4, 10, $5)`, [id, matched[1], agentId, matched[2], companyId])
      return { ok: true, output: { stdout: 'sent', stderr: '', exitCode: 0 }, durationMs: 1,
               display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
    }
    return { ok: true, output: null, durationMs: 0,
             display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
  })

  await runAgentTurn(agentId)

  // The 2nd LLM input (hop 2's request) MUST contain:
  //   - The "you were about to send" framing
  //   - The draft text verbatim
  //   - The steered message body
  // It MUST NOT contain a free-floating assistant output_text item
  // (that was the bug we fixed in #2).
  assert.ok(llmCallIdx >= 2, 'a 2nd hop must have run (steer forced continuation)')
  const hop2Text = capturedInputs[1]
    .flatMap((it) => {
      const r = it as { content?: Array<{ text?: string }> }
      return Array.isArray(r.content) ? r.content.map((c) => c.text ?? '') : []
    })
    .join('\n---\n')
  assert.match(hop2Text, /you were about to send/i,
    'rendered user item must frame the draft as "you were about to send X"')
  assert.match(hop2Text, /answer is 4/, 'draft text must be embedded verbatim')
  assert.match(hop2Text, /3\+3/, 'steered message body must be embedded')

  // Critical: no synthetic role='assistant' input item in hop2 — we
  // killed that code path in fix #2.
  const assistantItems = capturedInputs[1].filter((it) => {
    const r = it as { role?: string }
    return r.role === 'assistant'
  })
  assert.equal(assistantItems.length, 0,
    'NO synthetic role=assistant items — they were the structural lie in history')

  // turn.steered event recorded with carriedDraft=true
  const { rows: ev } = await pool.query<{ data: { carriedDraft?: boolean } }>(
    `SELECT data FROM agent_events WHERE agent_id = $1 AND kind = 'turn.steered'`, [agentId])
  assert.equal(ev.length, 1)
  assert.equal(ev[0].data.carriedDraft, true, 'turn.steered.carriedDraft pins the force-continuation case')
})

test('[integration] real HTTP wire: parseSseStream consumes attachWakeStream output (deliverSteer end-to-end)', async () => {
  // The most-complete wire test we have: spin up a real HTTP server
  // mounting attachWakeStream, open a real fetch SSE consumer, feed
  // its body to the production parseSseStream, then publish events
  // and assert the parser emits them correctly. No fakes — this
  // exercises every layer between Redis pub/sub and the pod's queue.
  const expressMod = await import('express')
  const { createServer } = await import('node:http')
  const { parseSseStream } = await import('../agents/runtime/sse-parse.js')

  const app = expressMod.default()
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  app.get('/wake-stream', (req, res) => { void attachWakeStream(agentId, res as unknown as Response) })

  const server = createServer(app)
  await new Promise<void>((r) => server.listen(0, () => r()))
  const port = (server.address() as { port: number }).port

  try {
    // Open a real fetch streaming-response. AbortController lets us
    // shut down the SSE consumer cleanly when the test is done.
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/wake-stream`, {
      signal: ctrl.signal,
      headers: { 'Accept': 'text/event-stream' },
    })
    assert.equal(res.status, 200)
    assert.ok(res.body, 'SSE response body must be readable')

    // Collect parsed events in the background.
    const events: Array<{ event?: string; data?: string; id?: string }> = []
    const collectDone = (async () => {
      try {
        for await (const e of parseSseStream(res.body as unknown as AsyncIterable<unknown>)) {
          events.push(e)
          if (events.length >= 3) return // ready + steer + wake
        }
      } catch { /* aborted */ }
    })()

    // The first event is `ready` — wait for the subscriber registration
    // to settle before publishing.
    await new Promise((r) => setTimeout(r, 200))

    // Publish a wake AND a steer via the real wake-bus.
    await deliverWake(agentId, { kind: 'wake', reason: 'message.new', conversationId: 'c-1' })
    await deliverSteer(agentId, {
      conversationId: 'c-1',
      messageId: 'm-real',
      authorName: 'alice',
      body: 'steered via real HTTP roundtrip',
    })
    await Promise.race([collectDone, new Promise((r) => setTimeout(r, 1500))])
    ctrl.abort()

    // The parser must have surfaced at least: ready, wake, steer
    // (order may vary slightly due to the 200ms settle wait).
    const eventKinds = events.map((e) => e.event)
    assert.ok(eventKinds.includes('ready'), `expected ready event, got ${JSON.stringify(eventKinds)}`)
    assert.ok(eventKinds.includes('wake'), `expected wake event, got ${JSON.stringify(eventKinds)}`)
    assert.ok(eventKinds.includes('steer'), `expected steer event, got ${JSON.stringify(eventKinds)}`)

    const steer = events.find((e) => e.event === 'steer')!
    const steerData = JSON.parse(steer.data ?? '{}')
    assert.equal(steerData.body, 'steered via real HTTP roundtrip')
    assert.equal(steerData.authorName, 'alice')
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('[integration] rate limit: scheduler drops steers past 30/min — wake still fires', async () => {
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  await _resetSteerRateForTests(agentId)
  const res = makeFakeSseResponse()
  await attachWakeStream(agentId, res)
  await new Promise((r) => setTimeout(r, 100))
  await redis.set(busyKey(agentId), String(Date.now()), 'EX', 30)

  // Fire 35 wake+steer combos quickly — only the first 30 should
  // publish a steer event; the wake should fire for ALL 35.
  for (let i = 0; i < 35; i++) {
    await wakeAgent(agentId, 'message.new', 'c-spam', {
      messageId: `m-${i}-${randomUUID().slice(0, 6)}`,
      conversationId: 'c-spam',
      authorName: 'spammer',
      body: `msg ${i}`,
    })
  }
  await new Promise((r) => setTimeout(r, 250))

  const frames = parseSseFrames(res.written)
  const wakes = frames.filter((f) => f.event === 'wake').length
  const steers = frames.filter((f) => f.event === 'steer').length
  assert.equal(wakes, 35, 'wakes fire regardless of rate limit')
  assert.equal(steers, 30, 'steers capped at 30 per rolling 60s window')

  await redis.del(busyKey(agentId))
  await _resetSteerRateForTests(agentId)
  res.triggerClose()
})

test('[integration] cursor tiebreaker: two messages at same created_at — only the steered one is marked read', async () => {
  // The microsecond-collision case from the self-audit: two messages
  // inserted at exactly the same created_at. The timestamp-only
  // cursor would advance past BOTH (or neither); the new
  // (last_read_at, last_read_message_id) ROW cursor distinguishes
  // them. This test pins the fix.
  const { companyId, agentId, humanId, conversationId } = await seedConvo()

  // Force same created_at on two messages by inserting both in a
  // single statement (NOW() evaluates once per query). They'll have
  // identical timestamps but distinct ids.
  const idA = `m-a-${randomUUID()}`
  const idB = `m-b-${randomUUID()}`
  const sameTs = new Date()
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id, created_at)
       VALUES ($1, $2, $3, 'text', 'msg A', 1, $4, $5),
              ($6, $2, $3, 'text', 'msg B', 2, $4, $5)`,
    [idA, conversationId, humanId, companyId, sameTs, idB],
  )

  // Mark only A as read via the same method steering uses.
  const { inprocClient } = await import('../agents/runtime/inproc-client.js')
  await inprocClient.markConversationRead({ agentId, conversationId, upToMessageId: idA })

  // Now loadInbox should return EXACTLY msg B (A is marked,
  // B is NOT — same timestamp but lex-greater id wins iff
  // idB > idA OR same — let's verify with the actual ids).
  const inbox = await inprocClient.loadInbox(agentId)
  const inboxIds = inbox.map((m) => m.id)
  // The lex-ordering of UUIDs is unpredictable, so we instead assert
  // by which of the two we marked: whichever has the LARGER id
  // remains unread after marking the smaller one.
  const [smaller, larger] = idA < idB ? [idA, idB] : [idB, idA]
  // Re-mark with the SMALLER id.
  await inprocClient.markConversationRead({ agentId, conversationId, upToMessageId: smaller })
  const inbox2 = await inprocClient.loadInbox(agentId)
  const inbox2Ids = inbox2.map((m) => m.id)
  assert.ok(inbox2Ids.includes(larger),
    `marking the smaller-id message should leave the larger one unread (timestamp collision tiebreaker). Got: ${inbox2Ids.join(',')}`)
  assert.equal(inbox2Ids.includes(smaller), false,
    'the smaller-id message we just marked must be excluded')

  void inboxIds // silence unused
})

test('[integration] steer queue resets at turn boundaries (no leak across turns)', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo()
  await postHumanMessage({ conversationId, companyId, humanId, body: 'first wake', sequence: 1 })

  // Pre-load a stale steer BEFORE the turn starts (e.g. the previous
  // turn was interrupted before drain). runAgentTurn must clear this
  // at start so the new turn doesn't pick it up.
  pushSteer(agentId, {
    messageId: 'stale-from-previous-turn',
    conversationId,
    authorName: 'alice',
    body: 'STALE STEER — should not appear in this turn',
    arrivedAt: Date.now() - 999_999, // way past the debounce window
  })

  const llm = makeLlmStub([
    // Hop 1: text-only response → no tools, no steer pending → loop
    // gets returned to the model as an unsent draft.
    [
      { type: 'response.created', response: { id: 'resp_x', status: 'in_progress' } } as unknown as ResponseStreamEvent,
      { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: 'ack' } as unknown as ResponseStreamEvent,
      { type: 'response.output_text.done', item_id: 'msg_1', content_index: 0, text: 'ack' } as unknown as ResponseStreamEvent,
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 50, output_tokens: 5 } } } as unknown as ResponseStreamEvent,
    ],
    streamSetTurnStatus({
      assistantText: 'reply',
      replyConversationId: conversationId,
      reason: 'relay the ack draft',
    }),
  ])
  llm.install()

  // Single bash stub: handle the auto-relay's `cumora reply` call.
  makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
          [messageId, convoId, agentId, body, companyId],
        )
        return { ok: true, output: { stdout: 'sent', stderr: '', exitCode: 0 }, durationMs: 1,
                 display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
      }
      return { ok: true, output: null, durationMs: 0,
               display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
    },
  }).install()

  await runAgentTurn(agentId)

  // The first hop's input must NOT contain the stale steer text — the
  // turn start cleared the queue.
  const firstInput = flattenInput(llm.capturedInputs[0])
  assert.equal(firstInput.includes('STALE STEER'), false,
    'stale queue from a prior turn must be cleared at turn start')

  // No turn.steered event should have fired.
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.steered').length, 0)
})

// ─── a failed turn must not bury its own inbox ─────────────────────
//
// The cursor advance above lives in a `finally`, so it used to run whatever
// the turn's outcome was. A steer arrives DURING the turn, so its
// (created_at, id) is later than every message the turn was answering, and
// loadInbox compares ONE cursor per conversation:
//
//   AND ROW(mm.created_at, mm.id) > ROW(co.lr_at, co.lr_id)
//
// Advancing to the steer therefore buries the original question too. Ask
// something, add a follow-up while the agent is working, let the turn die:
// the room gets "Agent run failed … No result was produced" and BOTH messages
// are gone from every future inbox.
//
// It also contradicted the fingerprint contract in the same file: "Failed
// turns do not update the fingerprint, so they remain retryable instead of
// disappearing into a silent skip." Retryable work needs its rows to survive.

async function readCursor(agentId: string, conversationId: string): Promise<string | null> {
  const { rows } = await pool.query<{ last_read_message_id: string | null }>(
    `SELECT last_read_message_id FROM conversation_reads WHERE user_id = $1 AND conversation_id = $2`,
    [agentId, conversationId],
  )
  return rows[0]?.last_read_message_id ?? null
}

/** Drive one turn that drains a steer and then dies on the next LLM call.
 *  `makeLlmStub` throws once its scripted streams run out, which is a faithful
 *  stand-in for the provider errors and MAX_HOPS exits that fail a real turn
 *  after work has already happened. */
async function runTurnThatDrainsASteerThenFails(): Promise<{
  agentId: string; conversationId: string; originalId: string; steeredId: string
}> {
  const { companyId, agentId, humanId, conversationId } = await seedConvo()
  const originalId = await postHumanMessage({
    conversationId, companyId, humanId, body: 'original task: list files', sequence: 1,
  })
  const steeredId = await postHumanMessage({
    conversationId, companyId, humanId, body: 'wait, also include hidden files', sequence: 2,
  })

  // One scripted hop only: the drain happens inside it, then the next call
  // throws and the turn ends 'failed'.
  const llm = makeLlmStub([
    streamWithToolCall({ fcId: 'fc_ls', callId: 'call_ls', name: 'bash', argsJson: JSON.stringify({ command: 'ls' }) }),
  ])
  llm.install()
  makeToolStub({
    bash: async () => {
      pushSteer(agentId, {
        messageId: steeredId, conversationId, authorName: 'alice',
        body: 'wait, also include hidden files', arrivedAt: Date.now(),
      })
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200))
      return {
        ok: true, output: { stdout: 'file1\n', stderr: '', exitCode: 0 }, durationMs: DEBOUNCE_MS + 200,
        display: { name: 'bash', arg: 'ls', status: 'ok', detail: '' },
      }
    },
  }).install()

  await assert.rejects(runAgentTurn(agentId))
  return { agentId, conversationId, originalId, steeredId }
}

test('[integration] a failed turn leaves both the steer and the question it interrupted unread', async () => {
  const { agentId, conversationId, originalId, steeredId } = await runTurnThatDrainsASteerThenFails()

  const { rows: runs } = await pool.query<{ status: string }>(
    `SELECT status FROM agent_runs WHERE agent_id = $1`, [agentId],
  )
  assert.equal(runs[0].status, 'failed', 'the turn did fail — that is the premise, not the bug')

  const cursor = await readCursor(agentId, conversationId)
  assert.notEqual(
    cursor, steeredId,
    'the failed turn advanced the read cursor onto the steer, which buries the original question with it',
  )

  const { inprocClient } = await import('../agents/runtime/inproc-client.js')
  const inbox = await inprocClient.loadInbox(agentId)
  const ids = inbox.map((m) => m.id)
  assert.ok(ids.includes(steeredId), 'the follow-up must still be waiting to be answered')
  assert.ok(ids.includes(originalId), 'the question the follow-up interrupted must still be waiting too')
})

test('[integration] a completed turn still advances the cursor', async () => {
  // The guard rail. Without the advance a completed turn re-processes its own
  // steer on the next wake, which is exactly what that code was added for.
  const { companyId, agentId, humanId, conversationId } = await seedConvo()
  await postHumanMessage({ conversationId, companyId, humanId, body: 'original task', sequence: 1 })
  const steeredId = await postHumanMessage({
    conversationId, companyId, humanId, body: 'follow-up', sequence: 2,
  })

  const llm = makeLlmStub([
    streamWithToolCall({ fcId: 'fc_ls', callId: 'call_ls', name: 'bash', argsJson: JSON.stringify({ command: 'ls' }) }),
    streamSetTurnStatus(),
  ])
  llm.install()
  makeToolStub({
    bash: async () => {
      pushSteer(agentId, {
        messageId: steeredId, conversationId, authorName: 'alice',
        body: 'follow-up', arrivedAt: Date.now(),
      })
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 200))
      return {
        ok: true, output: { stdout: '', stderr: '', exitCode: 0 }, durationMs: DEBOUNCE_MS + 200,
        display: { name: 'bash', arg: 'ls', status: 'ok', detail: '' },
      }
    },
  }).install()

  await runAgentTurn(agentId)

  const { rows: runs } = await pool.query<{ status: string }>(
    `SELECT status FROM agent_runs WHERE agent_id = $1`, [agentId],
  )
  assert.equal(runs[0].status, 'completed')
  assert.equal(
    await readCursor(agentId, conversationId), steeredId,
    'a completed turn must still consume the steer it drained',
  )
})
