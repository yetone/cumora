/**
 * End-to-end coverage for `runAgentTurn` — the turn loop that drives one
 * agent through one wake. Real Postgres + Redis (via the integration
 * harness in `_helpers.ts`), with the OpenAI client and the per-pod tool
 * dispatcher swapped for stubs so we control exactly which event stream
 * the model "emits" and what each tool call "returns".
 *
 * Cases here cover every failure mode this loop has produced in
 * production plus the obvious boundaries:
 *  - normal: model calls `cumora reply` → message lands in conversation
 *  - multi-hop: bash → reply → message lands, history accumulates
 *    function_call ↔ function_call_output pairs correctly
 *  - unsent assistant text: model must continue and explicitly send/drop it
 *  - declared auto-relay: model can explicitly relay an exact draft target
 *  - declared auto-relay rejects out-of-inbox targets
 *  - structured turn status: model-declared continue/done steers the loop
 *  - tool failure: output carries error, next hop sees it
 *  - empty inbox: skip, no run created
 *  - response.completed with `output: []` even though tool calls streamed:
 *    pendingTools back-fill keeps the turn alive
 *  - unknown tool: function_call_output carries error, agent recovers
 *  - MAX_HOPS: loop caps out gracefully
 *
 * Run via:
 *   INTEGRATION_DATABASE_URL=postgres://$USER@localhost:5432/cumora_test \
 *     npm run test:integration
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'
import { __setPodToolOverrideForTesting } from '../agents/runtime/pod-tools.js'
import type { ToolResult } from '../agents/tools-shared.js'
import { runAgentTurn } from '../agents/turn.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
  __setLlmClientOverrideForTesting(null)
  __setPodToolOverrideForTesting(null)
})

after(async () => {
  __setLlmClientOverrideForTesting(null)
  __setPodToolOverrideForTesting(null)
  await teardownAll()
})

/** Build a stub LLM client whose `responses.create` returns a hop-N event
 *  stream from the supplied array. The Nth call yields the Nth element.
 *  Exhausting the array throws — every test should script exactly as many
 *  hops as the turn loop will run. */
function makeLlmStub(streams: ResponseStreamEvent[][]): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
              const r = req as { input?: ResponseInputItem[]; stream?: boolean; text?: unknown }
              // Synthetic wakes first pass through the non-streaming support-
              // model gate. Keep this helper's scripted streams for the main
              // turn while still exercising that production gate. Dedicated
              // triage tests cover its fail-closed and error paths.
              if (r.stream !== true && r.text) {
                return {
                  output_text: JSON.stringify({
                    act: true,
                    reason: 'integration test explicitly exercises the synthetic turn',
                    note: 'Run the scripted synthetic turn.',
                  }),
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }
              }
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

/** Build a stub tool dispatcher that returns canned `ToolResult`s keyed
 *  by tool name, plus optional per-call inspection. Unrecognized tools
 *  fall through to the "unknown tool" error shape — matches production
 *  semantics for the default case in `executePodTool`. */
function makeToolStub(handlers: Record<string, (parsed: Record<string, unknown>, raw: { agentId: string; argsJson: string }) => ToolResult | Promise<ToolResult>>): {
  install: () => void
  calls: Array<{ name: string; argsJson: string; parsed: Record<string, unknown> }>
} {
  const calls: Array<{ name: string; argsJson: string; parsed: Record<string, unknown> }> = []
  return {
    install: () => {
      __setPodToolOverrideForTesting(async (args) => {
        let parsed: Record<string, unknown> = {}
        try { parsed = JSON.parse(args.argsJson || '{}') } catch { /* keep empty */ }
        calls.push({ name: args.name, argsJson: args.argsJson, parsed })
        const handler = handlers[args.name]
        if (!handler) {
          return {
            ok: false,
            output: null,
            error: 'unknown tool',
            durationMs: 0,
            display: { name: args.name, arg: '', status: 'unknown tool', detail: `not stubbed: ${args.name}` },
          }
        }
        return handler(parsed, { agentId: args.agentId, argsJson: args.argsJson })
      })
    },
    calls,
  }
}

/** Seed a tenant + one agent + one human user + a conversation of the
 *  requested kind with both members. Returns the ids the test will use. */
async function seedConvo(opts: { kind: 'direct' | 'group'; extraMembers?: string[] } = { kind: 'direct' }): Promise<{
  companyId: string; agentId: string; humanId: string; conversationId: string
}> {
  const companyId = `c-${randomUUID().slice(0, 8)}`
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const humanId = `u-${randomUUID().slice(0, 8)}`
  const conversationId = opts.kind === 'direct'
    ? `direct-${randomUUID().slice(0, 8)}`
    : `allhands-${randomUUID().slice(0, 8)}`

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
  const members = [agentId, humanId, ...(opts.extraMembers ?? [])]
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [conversationId, opts.kind, opts.kind === 'direct' ? humanId : 'Everyone', JSON.stringify(members), 'human', companyId],
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

/** Convenience: build a no-tool-call, text-only response event stream. */
function streamWithJustText(text: string): ResponseStreamEvent[] {
  return [
    { type: 'response.created', response: { id: `resp_${randomUUID().slice(0, 8)}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
    { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: text } as unknown as ResponseStreamEvent,
    { type: 'response.output_text.done', item_id: 'msg_1', content_index: 0, text } as unknown as ResponseStreamEvent,
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 30 } } } as unknown as ResponseStreamEvent,
  ]
}

function streamNoTools(): ResponseStreamEvent[] {
  return [
    { type: 'response.created', response: { id: `resp_${randomUUID().slice(0, 8)}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 10 } } } as unknown as ResponseStreamEvent,
  ]
}

function streamNoToolsWithoutUsage(): ResponseStreamEvent[] {
  return [
    { type: 'response.created', response: { id: `resp_${randomUUID().slice(0, 8)}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
    { type: 'response.completed', response: { status: 'completed', output: [] } } as unknown as ResponseStreamEvent,
  ]
}

/** Convenience: build a one-tool-call response event stream. */
function streamWithToolCall(opts: { fcId: string; callId: string; name: string; argsJson: string; precedingText?: string }): ResponseStreamEvent[] {
  const evs: ResponseStreamEvent[] = [
    { type: 'response.created', response: { id: `resp_${randomUUID().slice(0, 8)}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
  ]
  if (opts.precedingText) {
    evs.push(
      { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: opts.precedingText } as unknown as ResponseStreamEvent,
      { type: 'response.output_text.done', item_id: 'msg_1', content_index: 0, text: opts.precedingText } as unknown as ResponseStreamEvent,
    )
  }
  evs.push(
    { type: 'response.output_item.added', item: { id: opts.fcId, type: 'function_call', call_id: opts.callId, name: opts.name, arguments: '' } } as unknown as ResponseStreamEvent,
    { type: 'response.function_call_arguments.done', item_id: opts.fcId, arguments: opts.argsJson } as unknown as ResponseStreamEvent,
    { type: 'response.completed', response: { status: 'completed', output: [{ id: opts.fcId, type: 'function_call', call_id: opts.callId, name: opts.name, arguments: opts.argsJson }], usage: { input_tokens: 200, output_tokens: 40 } } } as unknown as ResponseStreamEvent,
  )
  return evs
}

function turnStatusToolResult(parsed: Record<string, unknown>): ToolResult {
  const status = String(parsed.status ?? '')
  const reason = String(parsed.reason ?? '')
  const nextStep = String(parsed.next_step ?? parsed.nextStep ?? '')
  const assistantTextAction = String(parsed.assistant_text ?? parsed.assistantText ?? 'none')
  const replyConversationId = String(parsed.reply_conversation_id ?? parsed.replyConversationId ?? '') || null
  return {
    ok: true,
    output: { status, reason, nextStep, assistantTextAction, replyConversationId },
    durationMs: 1,
    display: { name: 'set_turn_status', arg: status, status, detail: nextStep ? `${reason}\nnext: ${nextStep}` : reason },
  }
}

/** Fetch the agent_events rows for a given agentId, ordered. */
async function eventsForAgent(agentId: string): Promise<Array<{ kind: string; level: string | null; title: string; data: unknown }>> {
  const { rows } = await pool.query<{ kind: string; level: string | null; title: string; data: unknown }>(
    `SELECT kind, level, title, data FROM agent_events
       WHERE agent_id = $1 ORDER BY created_at, kind`,
    [agentId],
  )
  return rows
}

/** Fetch messages a given agent posted to a conversation. */
async function messagesFromAgent(conversationId: string, agentId: string): Promise<Array<{ id: string; body: string; sequence: number }>> {
  const { rows } = await pool.query<{ id: string; body: string; sequence: number }>(
    `SELECT id, body, sequence FROM messages
       WHERE conversation_id = $1 AND author_id = $2 AND kind = 'text' ORDER BY sequence`,
    [conversationId, agentId],
  )
  return rows
}

function bashReplyOutput(opts: {
  stdout: string
  conversationId: string
  messageId: string
  sequence?: number
  attachment?: boolean
}): Record<string, unknown> {
  return {
    stdout: opts.stdout,
    stderr: '',
    exitCode: 0,
    sideEffects: [{
      event: 'message.posted',
      command: 'reply',
      medium: 'chat',
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      sequence: opts.sequence ?? 2,
      visibleToUser: true,
      attachment: Boolean(opts.attachment),
    }],
  }
}

function flattenInput(input: ResponseInputItem[]): string {
  const parts: string[] = []
  for (const it of input) {
    const r = it as unknown as { content?: Array<{ text?: string }>; output?: string }
    if (Array.isArray(r.content)) {
      for (const c of r.content) {
        if (typeof c.text === 'string') parts.push(c.text)
      }
    }
    if (typeof r.output === 'string') parts.push(r.output)
  }
  return parts.join('\n---\n')
}

// ────────────────────────────────────────────────────────────────────────────
// T2 cases
// ────────────────────────────────────────────────────────────────────────────

test('[integration] empty inbox → turn short-circuits, no run created', async () => {
  const { agentId } = await seedConvo({ kind: 'direct' })
  // Note: no message inserted — inbox is empty.

  makeLlmStub([]).install()
  makeToolStub({}).install()

  await runAgentTurn(agentId)

  const { rowCount } = await pool.query(`SELECT 1 FROM agent_runs WHERE agent_id = $1`, [agentId])
  assert.equal(rowCount, 0, 'no agent_runs row should be created for empty inbox')
})

test('[integration] idle wake with empty inbox runs the normal turn protocol', async () => {
  const { agentId, conversationId } = await seedConvo({ kind: 'direct' })
  // Note: no message inserted — normal wakes would short-circuit.

  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_idle_status',
      callId: 'call_idle_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({
        status: 'done',
        reason: 'nothing worth initiating from idle',
        next_step: '',
      }),
    }),
  ])
  llm.install()
  const tools = makeToolStub({
    set_turn_status: (parsed) => turnStatusToolResult(parsed),
  })
  tools.install()

  await runAgentTurn(agentId, { trigger: 'idle', idleReason: 'test idle heartbeat' })

  assert.equal(llm.callCount(), 1, 'idle wake should call the main turn model')
  assert.equal(tools.calls.length, 1)
  assert.equal(tools.calls[0].name, 'set_turn_status')

  const prompt = flattenInput(llm.capturedInputs[0] ?? [])
  assert.match(prompt, /idle heartbeat/, 'model sees idle wake context')
  assert.match(prompt, /There is no new chat message demanding a reply/, 'idle wake is not disguised as inbox activity')
  assert.match(prompt, /cumora inbox/, 'model gets normal inspection tools instead of an idle-only action grammar')

  const { rows: runs } = await pool.query<{ status: string; trigger: Record<string, unknown>; inbox_count: number }>(
    `SELECT status, trigger, inbox_count FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'completed')
  assert.equal(runs[0].inbox_count, 0)
  assert.equal(runs[0].trigger?.source, 'idle')

  const ev = await eventsForAgent(agentId)
  assert.ok(ev.some((e) => e.kind === 'turn.started' && (e.data as { trigger?: string }).trigger === 'idle'))
  assert.equal(ev.some((e) => e.kind === 'typing.started'), false, 'idle turn has no conversation to show typing in')

  const { rowCount: messageCount } = await pool.query(
    `SELECT 1 FROM messages WHERE conversation_id = $1`,
    [conversationId],
  )
  assert.equal(messageCount, 0, 'idle status declaration alone should not create chat messages')
})

test('[integration] normal direct reply: bash → cumora reply → message lands in conversation', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'hi nova' })

  const replyBody = 'hello! how can I help?'
  const llm = makeLlmStub([
    // Hop 1: model fires `cumora reply <convo> '<body>'`.
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} '${replyBody}'` }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the reply has been posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: (parsed) => {
      // Stub treats every `cumora reply` call as if it really posted (the
      // real CLI does this via inproc DB write) and returns the typed CLI
      // side effect the turn loop uses for double-post suppression.
      const cmd = String(parsed.command ?? '')
      // For "explicit reply" tests we want production semantics: when
      // `cumora reply` is invoked, simulate a successful post so the next
      // assertion (no auto-relay) holds. We still post a real DB row from
      // within the stub so the conversation-state assertion below passes.
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'/)
      if (matched) {
        const [, convoId, body] = matched
        return (async () => {
          const messageId = `m-${randomUUID()}`
          // Sequence: any > 1 works for the test convo (humanId already posted seq 1).
          await pool.query(
            `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
               VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
            [messageId, convoId, agentId, body, companyId],
          )
          return {
            ok: true,
            output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }),
            durationMs: 1,
            display: { name: 'bash', arg: cmd, status: 'ok · 1ms' , detail: '' },
          }
        })()
      }
      return { ok: true, output: { stdout: '', stderr: '', exitCode: 0 }, durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1, 'agent should have posted exactly one message')
  assert.equal(posted[0].body, replyBody)
  // No auto_relay event — the model called the tool itself.
  const ev = await eventsForAgent(agentId)
  const autoRelay = ev.filter((e) => e.kind.startsWith('turn.auto_relay'))
  assert.equal(autoRelay.length, 0, 'auto_relay must not fire when model already called cumora reply')
})

test('[integration] unsent assistant text is returned to the model instead of auto-routed', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'list the kanban ids' })

  const answer = '功能测试看板 = board-75f7df5a; Something = board-d20d7ac6'
  const llm = makeLlmStub([
    streamWithJustText(answer),
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} '${answer}'` }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the answer was posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
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
        return { ok: true, output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }), durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      return { ok: false, output: null, error: `unexpected bash invocation: ${cmd}`, durationMs: 0, display: { name: 'bash', arg: cmd, status: 'fail' , detail: '' } }
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 3, 'plain assistant text should trigger a continuation hop')
  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body, answer)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay').length, 0, 'runtime should not infer a relay target')
})

test('[integration] declared assistant-text relay posts the exact draft to the declared target', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'answer plainly' })

  const answer = 'The answer is 42.'
  const llm = makeLlmStub([
    streamWithJustText(answer),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({
        status: 'done',
        reason: 'relay the exact draft to the asking conversation',
        next_step: '',
        assistant_text: 'reply',
        reply_conversation_id: conversationId,
      }),
    }),
  ])
  llm.install()
  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      // The declared relay carries `--continue` so the anti-monologue gate
      // cannot refuse the turn's deliverable after the intent message the
      // operating rules require. Requiring it here keeps that shape pinned.
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'\s+--continue$/)
      if (!matched) throw new Error(`unexpected bash invocation: ${cmd}`)
      const [, convoId, body] = matched
      const messageId = `m-${randomUUID()}`
      await pool.query(
        `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
           VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
        [messageId, convoId, agentId, body, companyId],
      )
      return { ok: true, output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }), durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok', detail: '' } }
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body, answer)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay').length, 1)
})

test('[integration] declared assistant-text relay rejects a target outside the current inbox', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'answer plainly' })

  const answer = 'The answer is 42.'
  const llm = makeLlmStub([
    streamWithJustText(answer),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({
        status: 'done',
        reason: 'try to relay to a conversation that did not wake the turn',
        next_step: '',
        assistant_text: 'reply',
        reply_conversation_id: 'not-in-inbox',
      }),
    }),
  ])
  llm.install()
  const tools = makeToolStub({
    bash: () => {
      throw new Error('bash should not be invoked for an invalid declared relay target')
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 0)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay_rejected').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay').length, 0)
  const { rows: runs } = await pool.query<{ status: string; error: string | null }>(
    `SELECT status, error FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs[0].status, 'failed', 'invalid declared relay target is not a completed turn')
  assert.match(runs[0].error ?? '', /Rejected declared assistant-text relay target/)
})

test('[integration] auto-relay suppressed when model already called cumora reply this turn', async () => {
  // The "double-reply" guard: model fires `cumora reply` in hop 1, then emits
  // assistant text. Even if it asks to relay that draft, the typed CLI reply
  // side effect from hop 1 keeps the runtime from double-posting.
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'do the thing' })

  const replyBody = 'done!'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_1', callId: 'call_1', name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} '${replyBody}'` }),
    }),
    // Hop 2: model babbles more text but doesn't call any tool.
    streamWithJustText('also — checking back in soon'),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({
        status: 'done',
        reason: 'the real reply was already sent; the draft is stale',
        next_step: '',
        assistant_text: 'reply',
        reply_conversation_id: conversationId,
      }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
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
        return { ok: true, output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }), durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      throw new Error(`unexpected bash invocation: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1, 'exactly one message — the explicit reply, NOT also the auto-relay')
  assert.equal(posted[0].body, replyBody)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay').length, 0)
})

test('[integration] unreliable CLI side-effect channel suppresses assistant-text auto-relay', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'do the thing once' })

  const replyBody = 'already posted'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_1', callId: 'call_1', name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} '${replyBody}'` }),
    }),
    streamWithJustText('also relay this stale draft'),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({
        status: 'done',
        reason: 'attempted auto relay after a reply with broken metadata',
        next_step: '',
        assistant_text: 'reply',
        reply_conversation_id: conversationId,
      }),
    }),
  ])
  llm.install()

  makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (!matched) throw new Error(`unexpected bash invocation: ${cmd}`)
      const [, convoId, body] = matched
      const messageId = `m-${randomUUID()}`
      await pool.query(
        `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
           VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
        [messageId, convoId, agentId, body, companyId],
      )
      return {
        ok: true,
        output: {
          stdout: `sent (${messageId}, seq 2)`,
          stderr: '',
          exitCode: 0,
          sideEffectsParseFailed: true,
          sideEffectsMalformedLineCount: 1,
        },
        durationMs: 1,
        display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
      }
    },
    set_turn_status: turnStatusToolResult,
  }).install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1, 'metadata uncertainty must not create a second auto-relayed reply')
  assert.equal(posted[0].body, replyBody)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay').length, 0)
  assert.equal(ev.filter((e) => e.kind === 'turn.auto_relay_suppressed').length, 1)
  const { rows: runs } = await pool.query<{ status: string; error: string | null }>(
    `SELECT status, error FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs[0].status, 'failed')
  assert.match(runs[0].error ?? '', /side-effect channel was unreliable/)
})

test('[integration] missing status after acknowledgement is handled by main-model protocol nudge', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  const askingMessageId = await postHumanMessage({
    conversationId, companyId, humanId, body: '想要生成一个熊猫的照片',
  })

  const replyBody = '来了。'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_react',
      callId: 'call_react',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora react ${askingMessageId} 👀` }),
    }),
    streamWithJustText(''),
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({
        command: `cumora reply ${conversationId} '${replyBody}' --generate-image '一张可爱的熊猫照片，柔和自然光，真实摄影风格'`,
      }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the panda image reply has been posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (/^cumora\s+react\s+\S+\s+👀$/.test(cmd)) {
        return {
          ok: true,
          output: { stdout: 'react → added\n\n👀 is only an acknowledgement for long work.', stderr: '', exitCode: 0 },
          durationMs: 1,
          display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
        }
      }
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*?)'\s+--generate-image\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, attachment, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5::jsonb, $6)`,
          [messageId, convoId, agentId, body, JSON.stringify({ url: '/uploads/panda.png', name: 'panda.png', kind: 'img', mime: 'image/png' }), companyId],
        )
        return {
          ok: true,
          output: bashReplyOutput({
            stdout: `sent (${messageId}, seq 2) · attached img "panda.png"`,
            conversationId: convoId,
            messageId,
            attachment: true,
          }),
          durationMs: 1,
          display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
        }
      }
      throw new Error(`unexpected bash invocation: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 4, 'the empty post-reaction hop should be continued by protocol nudge')
  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1, 'the agent should complete the image request after the nudge')
  assert.equal(posted[0].body, replyBody)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_declared').length, 1)
})

test('[integration] repeated missing turn status fails the run and does not fingerprint-dedupe the inbox', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'please do not silently disappear' })

  const first = makeLlmStub([streamNoTools(), streamNoTools(), streamNoTools()])
  first.install()
  makeToolStub({ set_turn_status: turnStatusToolResult }).install()

  await runAgentTurn(agentId)

  assert.equal(first.callCount(), 3, 'two protocol nudges, then protocol violation')
  let { rows: runs } = await pool.query<{ status: string; summary: string; error: string | null }>(
    `SELECT status, summary, error FROM agent_runs WHERE agent_id = $1 ORDER BY started_at`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.match(runs[0].summary, /missing turn-status/)
  assert.match(runs[0].error ?? '', /missing turn-status/)
  let ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.protocol_violation').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.failure_notice').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.completed').length, 0)
  const { rows: notices } = await pool.query<{ body: string }>(
    `SELECT body FROM messages WHERE conversation_id = $1 AND kind = 'system'`,
    [conversationId],
  )
  assert.equal(notices.length, 1, 'protocol failures must be visible to the user')
  const noticeBody = JSON.parse(notices[0].body) as { noticeKind?: string; text?: string }
  assert.equal(noticeBody.noticeKind, 'agent_turn_failed')
  assert.match(String(noticeBody.text ?? ''), /turn-status protocol violation/i)

  const second = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_status_retry',
      callId: 'call_status_retry',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'retry still reached the model', next_step: '' }),
    }),
  ])
  second.install()

  await runAgentTurn(agentId)

  assert.equal(second.callCount(), 1, 'failed protocol runs must not poison the inbox fingerprint')
  ;({ rows: runs } = await pool.query<{ status: string; summary: string; error: string | null }>(
    `SELECT status, summary, error FROM agent_runs WHERE agent_id = $1 ORDER BY started_at`,
    [agentId],
  ))
  assert.equal(runs.length, 2)
  assert.equal(runs[1].status, 'completed')
  ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.completed').length, 1)
})

test('[integration] idle wake missing turn status is skipped instead of failed', async () => {
  const { agentId } = await seedConvo({ kind: 'direct' })

  const llm = makeLlmStub([
    streamWithJustText('No unread messages. I will stay available.'),
    streamWithJustText('Still nothing to do.'),
    streamWithJustText('No user-visible action is needed.'),
  ])
  llm.install()
  makeToolStub({ set_turn_status: turnStatusToolResult }).install()

  await runAgentTurn(agentId, {
    trigger: 'idle',
    idleReason: 'test idle heartbeat',
  })

  assert.equal(llm.callCount(), 3, 'two protocol nudges, then synthetic noop')
  const { rows: runs } = await pool.query<{ status: string; summary: string; error: string | null }>(
    `SELECT status, summary, error FROM agent_runs WHERE agent_id = $1 ORDER BY started_at`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'skipped')
  assert.match(runs[0].summary, /Synthetic idle wake/)
  assert.equal(runs[0].error, null)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 2)
  assert.equal(ev.filter((e) => e.kind === 'turn.synthetic_noop').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.protocol_violation').length, 0)
})

test('[integration] user-visible reply without final turn status is inferred complete', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'send me a short reply' })

  const replyBody = 'done'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} '${replyBody}'` }),
    }),
    streamNoTools(),
    streamNoTools(),
    streamNoTools(),
  ])
  llm.install()
  makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (!matched) throw new Error(`unexpected bash invocation: ${cmd}`)
      const [, convoId, body] = matched
      const messageId = `m-${randomUUID()}`
      await pool.query(
        `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
           VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
        [messageId, convoId, agentId, body, companyId],
      )
      return {
        ok: true,
        output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }),
        durationMs: 1,
        display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
      }
    },
    set_turn_status: turnStatusToolResult,
  }).install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 4, 'two status nudges, then infer from visible reply')
  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body, replyBody)
  const { rows: runs } = await pool.query<{ status: string; summary: string; error: string | null }>(
    `SELECT status, summary, error FROM agent_runs WHERE agent_id = $1 ORDER BY started_at`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'completed')
  assert.match(runs[0].summary, /Turn status inferred: done/)
  assert.equal(runs[0].error, null)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 2)
  assert.equal(ev.filter((e) => e.kind === 'turn.status_inferred').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.protocol_violation').length, 0)
})

test('[integration] missing model usage is observable and uses local token estimate', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'usage may be missing upstream' })

  const llm = makeLlmStub([
    streamNoToolsWithoutUsage(),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'usage fallback is visible', next_step: '' }),
    }),
  ])
  llm.install()
  makeToolStub({ set_turn_status: turnStatusToolResult }).install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 2)
  const ev = await eventsForAgent(agentId)
  const usageMissing = ev.filter((e) => e.kind === 'turn.usage_missing')
  assert.equal(usageMissing.length, 1)
  assert.match(usageMissing[0].title, /without usage/)
  const { rows: runs } = await pool.query<{ status: string; token_count: number }>(
    `SELECT status, token_count FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs[0].status, 'completed')
  assert.ok(runs[0].token_count > 0, 'run records a fallback token estimate instead of zero')
})

test('[integration] structured turn status done terminates without an extra no-tool hop', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'please reply once' })

  const replyBody = 'done with explicit status'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} '${replyBody}'` }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the reply has been posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (!matched) throw new Error(`unexpected bash invocation: ${cmd}`)
      const [, convoId, body] = matched
      const messageId = `m-${randomUUID()}`
      await pool.query(
        `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
           VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
        [messageId, convoId, agentId, body, companyId],
      )
      return {
        ok: true,
        output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }),
        durationMs: 1,
        display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
      }
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 2, 'status=done should end the turn without a probing no-tool hop')
  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body, replyBody)
  const ev = await eventsForAgent(agentId)
  const statusEvents = ev.filter((e) => e.kind === 'turn.status_declared')
  assert.equal(statusEvents.length, 1)
  assert.equal(statusEvents[0].title, 'Turn status: done')
  const { rows: runs } = await pool.query<{ summary: string; tool_call_count: number }>(
    `SELECT summary, tool_call_count FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs[0].tool_call_count, 2)
  assert.match(runs[0].summary, /^Turn status: done/)
})

test('[integration] invalid set_turn_status payload is observable and does not terminate the loop', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'please make protocol failures visible' })

  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_invalid_status',
      callId: 'call_invalid_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'frobnicate', reason: 'bad enum', next_step: 'try again correctly' }),
    }),
    streamWithToolCall({
      fcId: 'fc_done',
      callId: 'call_done',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'corrected the protocol status', next_step: '' }),
    }),
  ])
  llm.install()
  makeToolStub({ set_turn_status: turnStatusToolResult }).install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 2, 'invalid status should be nudged, not accepted as terminal')
  const ev = await eventsForAgent(agentId)
  const invalid = ev.filter((e) => e.kind === 'turn.invalid_status')
  assert.equal(invalid.length, 1)
  assert.equal((invalid[0].data as { rawStatus?: unknown }).rawStatus, 'frobnicate')
  assert.equal(ev.filter((e) => e.kind === 'turn.status_declared').length, 1)
  const { rows: runs } = await pool.query<{ status: string; summary: string }>(
    `SELECT status, summary FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs[0].status, 'completed')
  assert.match(runs[0].summary, /^Turn status: done/)
})

test('[integration] structured turn status continue keeps the loop alive until a terminal status', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  const askingMessageId = await postHumanMessage({
    conversationId, companyId, humanId, body: '想要生成一个熊猫的照片',
  })

  const replyBody = '熊猫照片好了。'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_react',
      callId: 'call_react',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora react ${askingMessageId} 👀` }),
    }),
    streamWithToolCall({
      fcId: 'fc_continue',
      callId: 'call_continue',
      name: 'set_turn_status',
      argsJson: JSON.stringify({
        status: 'continue',
        reason: 'only the acknowledgement has been sent',
        next_step: 'create the requested panda image and reply with the attachment',
      }),
    }),
    streamWithToolCall({
      fcId: 'fc_reply',
      callId: 'call_reply',
      name: 'bash',
      argsJson: JSON.stringify({
        command: `cumora reply ${conversationId} '${replyBody}' --generate-image '一张可爱的熊猫照片，柔和自然光，真实摄影风格'`,
      }),
    }),
    streamWithToolCall({
      fcId: 'fc_done',
      callId: 'call_done',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the panda image reply has been posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (cmd === `cumora react ${askingMessageId} 👀`) {
        return {
          ok: true,
          output: { stdout: 'react -> added', stderr: '', exitCode: 0 },
          durationMs: 1,
          display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
        }
      }
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*?)'\s+--generate-image\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, attachment, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5::jsonb, $6)`,
          [messageId, convoId, agentId, body, JSON.stringify({ url: '/uploads/panda.png', name: 'panda.png', kind: 'img', mime: 'image/png' }), companyId],
        )
        return {
          ok: true,
          output: bashReplyOutput({
            stdout: `sent (${messageId}, seq 2) · attached img "panda.png"`,
            conversationId: convoId,
            messageId,
            attachment: true,
          }),
          durationMs: 1,
          display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
        }
      }
      throw new Error(`unexpected bash invocation: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 4)
  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body, replyBody)
  const ev = await eventsForAgent(agentId)
  const statusTitles = ev.filter((e) => e.kind === 'turn.status_declared').map((e) => e.title)
  assert.ok(statusTitles.includes('Turn status: continue'))
  assert.ok(statusTitles.includes('Turn status: done'))
  assert.equal(ev.filter((e) => e.kind === 'turn.status_required').length, 0, 'structured status avoids protocol repair hops')
})

test('[integration] reaction-only terminal done is semantically rejected and the agent continues', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'group' })
  const askingMessageId = await postHumanMessage({
    conversationId,
    companyId,
    humanId,
    body: '给我一张你们团建的大合照吧，一定要是真实的照片，不要手绘感',
  })

  const replyBody = '合照来了。'
  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_react_only',
      callId: 'call_react_only',
      name: 'bash',
      argsJson: JSON.stringify({ command: `cumora react ${askingMessageId} 👀` }),
    }),
    streamWithToolCall({
      fcId: 'fc_wrong_done',
      callId: 'call_wrong_done',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'acknowledged with eyes', next_step: '' }),
    }),
    streamWithJustText(JSON.stringify({
      complete: false,
      reason: 'the human asked for a realistic group photo, but the only side effect was a reaction',
      next_step: 'generate and post the requested photo attachment, or report a clear failure',
    })),
    streamWithToolCall({
      fcId: 'fc_reply_photo',
      callId: 'call_reply_photo',
      name: 'bash',
      argsJson: JSON.stringify({
        command: `cumora reply ${conversationId} '${replyBody}' --generate-image '真实摄影风格的团队团建大合照，自然光，不要手绘感'`,
      }),
    }),
    streamWithToolCall({
      fcId: 'fc_final_done',
      callId: 'call_final_done',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the group photo reply has been posted', next_step: '' }),
    }),
  ])
  llm.install()

  makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (cmd === `cumora react ${askingMessageId} 👀`) {
        return {
          ok: true,
          output: {
            stdout: 'react -> added',
            stderr: '',
            exitCode: 0,
            sideEffects: [{
              event: 'reaction.updated',
              command: 'react',
              visibleToUser: true,
              actorId: agentId,
              messageId: askingMessageId,
              emoji: '👀',
              action: 'added',
            }],
          },
          durationMs: 1,
          display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
        }
      }
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*?)'\s+--generate-image\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, attachment, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5::jsonb, $6)`,
          [messageId, convoId, agentId, body, JSON.stringify({ url: '/uploads/team.png', name: 'team.png', kind: 'img', mime: 'image/png' }), companyId],
        )
        return {
          ok: true,
          output: bashReplyOutput({
            stdout: `sent (${messageId}, seq 2) · attached img "team.png"`,
            conversationId: convoId,
            messageId,
            attachment: true,
          }),
          durationMs: 1,
          display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
        }
      }
      throw new Error(`unexpected bash invocation: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  }).install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 5, 'semantic verifier adds one LLM check before continuation')
  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1, 'reaction-only completion must not end the turn')
  assert.equal(posted[0].body, replyBody)
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.completion_rejected').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.completed').length, 1)
  const replyHopInput = flattenInput(llm.capturedInputs[3] ?? [])
  assert.match(replyHopInput, /terminal turn status was rejected/)
  assert.match(replyHopInput, /realistic group photo|真实/)
})

test('[integration] action-only terminal done is semantically verified before the inbox cursor advances', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'group' })
  const askingMessageId = await postHumanMessage({
    conversationId,
    companyId,
    humanId,
    body: '把 launch 这张卡移到 Done',
  })

  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_move_card',
      callId: 'call_move_card',
      name: 'bash',
      argsJson: JSON.stringify({ command: 'cumora kanban card move launch Done' }),
    }),
    streamWithToolCall({
      fcId: 'fc_done',
      callId: 'call_done',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the requested kanban card was moved', next_step: '' }),
    }),
    streamWithJustText(JSON.stringify({
      complete: true,
      reason: 'the visible side effect moved the requested kanban card to Done',
      next_step: '',
    })),
  ])
  llm.install()

  makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      assert.equal(cmd, 'cumora kanban card move launch Done')
      return {
        ok: true,
        output: {
          stdout: 'moved card launch -> Done',
          stderr: '',
          exitCode: 0,
          sideEffects: [{
            event: 'kanban.card_moved',
            command: 'kanban.card.move',
            visibleToUser: true,
            companyId,
            cardId: 'launch',
            toColumn: 'Done',
          }],
        },
        durationMs: 1,
        display: { name: 'bash', arg: cmd, status: 'ok', detail: '' },
      }
    },
    set_turn_status: turnStatusToolResult,
  }).install()

  await runAgentTurn(agentId)

  assert.equal(llm.callCount(), 3, 'non-reply side effects are judged semantically before completion')
  const ev = await eventsForAgent(agentId)
  assert.equal(ev.filter((e) => e.kind === 'turn.completion_verified').length, 1)
  assert.equal(ev.filter((e) => e.kind === 'turn.completion_rejected').length, 0)
  const { rows: reads } = await pool.query<{ last_read_message_id: string | null }>(
    `SELECT last_read_message_id FROM conversation_reads WHERE user_id = $1 AND conversation_id = $2`,
    [agentId, conversationId],
  )
  assert.equal(reads.length, 1, 'verified action-only completion advances the inbox cursor')
  assert.equal(reads[0].last_read_message_id, askingMessageId)
})

test('[integration] multi-hop tool use: hop1 bash informational → hop2 cumora reply → message posted', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'list kanban ids' })

  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_1', callId: 'call_1', name: 'bash',
      argsJson: JSON.stringify({ command: 'cumora kanban ls' }),
    }),
    streamWithToolCall({
      fcId: 'fc_2', callId: 'call_2', name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} 'board-1, board-2'` }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the board ids have been posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (cmd.includes('kanban ls')) {
        return { ok: true, output: { stdout: 'board-1\nboard-2', stderr: '', exitCode: 0 }, durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
          [messageId, convoId, agentId, body, companyId],
        )
        return { ok: true, output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }), durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      throw new Error(`unexpected: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.equal(posted[0].body, 'board-1, board-2')
  assert.equal(tools.calls.filter((c) => c.name === 'bash').length, 2, 'exactly two bash calls')
})

test('[integration] tool failure: function_call_output carries error, agent recovers in next hop', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'do thing' })

  const llm = makeLlmStub([
    // Hop 1: model calls a tool that we'll have fail.
    streamWithToolCall({
      fcId: 'fc_1', callId: 'call_1', name: 'bash',
      argsJson: JSON.stringify({ command: 'cumora doesnotexist' }),
    }),
    // Hop 2: model sees the failure output and recovers by replying.
    streamWithToolCall({
      fcId: 'fc_2', callId: 'call_2', name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} 'sorry — that did not work'` }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the tool failure was reported', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (cmd.includes('doesnotexist')) {
        return { ok: false, output: { stdout: '', stderr: 'cumora: unknown subcommand', exitCode: 127 }, error: 'exit 127', durationMs: 1, display: { name: 'bash', arg: cmd, status: 'exit 127' , detail: '' } }
      }
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
          [messageId, convoId, agentId, body, companyId],
        )
        return { ok: true, output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }), durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      throw new Error(`unexpected: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1)
  assert.match(posted[0].body, /did not work/)
  const ev = await eventsForAgent(agentId)
  const toolFinished = ev.filter((e) => e.kind === 'tool.finished')
  assert.equal(toolFinished.length, 3, 'three tool.finished events including final status')
  const firstData = toolFinished[0].data as { ok: boolean }
  assert.equal(firstData.ok, false, 'first tool reported failure')
})

test('[integration] huge tool output is self-described before the next model hop', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'read the large output' })

  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_huge',
      callId: 'call_huge',
      name: 'bash',
      argsJson: JSON.stringify({ command: 'cumora kanban show huge-board' }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the huge output was inspected', next_step: '' }),
    }),
  ])
  llm.install()

  makeToolStub({
    bash: () => ({
      ok: true,
      output: { stdout: 'X'.repeat(50_000), stderr: '', exitCode: 0 },
      durationMs: 1,
      display: { name: 'bash', arg: 'show', status: 'ok', detail: '' },
    }),
    set_turn_status: turnStatusToolResult,
  }).install()

  await runAgentTurn(agentId)

  const secondHopInput = llm.capturedInputs[1] ?? []
  const itemRefs = secondHopInput.filter((item) => (item as unknown as Record<string, unknown>).type === 'item_reference')
  assert.equal(itemRefs.length, 0, 'tool continuation must not synthesize item_reference rows; sub2api/OpenAI 404s on id=call_id')
  const functionCall = secondHopInput.find((item) => {
    const raw = item as unknown as Record<string, unknown>
    return raw.type === 'function_call' && raw.call_id === 'call_huge'
  })
  assert.ok(functionCall, 'next model hop receives the matching function_call context')
  const toolOutput = secondHopInput.find((item) => {
    const raw = item as unknown as Record<string, unknown>
    return raw.type === 'function_call_output' && raw.call_id === 'call_huge'
  }) as unknown as { output?: string } | undefined
  assert.ok(toolOutput?.output, 'next model hop receives the huge tool output')
  const parsed = JSON.parse(toolOutput.output)
  assert.equal(parsed.truncated, true, 'large output is marked as runtime-truncated')
  assert.ok(parsed.originalBytes > 40_000, 'original size is preserved for model reasoning')
  assert.match(parsed.note, /shortened by the turn runtime/)
})

test('[integration] response.completed.output:[] with streamed tool call — pendingTools back-fill keeps the turn alive', async () => {
  // The exact event sequence that produced "No tool call found for
  // function call output with call_id fc_X" before we made
  // assistantOutputItems derive from pendingTools.
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'list ids' })

  const llm = makeLlmStub([
    // Hop 1: tool call streams via output_item.added, BUT response.completed
    // arrives with output:[] — the sub2api OAuth regression. The turn loop
    // must still record the call and continue.
    [
      { type: 'response.created', response: { id: 'resp_a', status: 'in_progress' } } as unknown as ResponseStreamEvent,
      { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '' } } as unknown as ResponseStreamEvent,
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: JSON.stringify({ command: 'cumora kanban ls' }) } as unknown as ResponseStreamEvent,
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 20 } } } as unknown as ResponseStreamEvent,
    ],
    // Hop 2: model replies normally.
    streamWithToolCall({
      fcId: 'fc_2', callId: 'call_2', name: 'bash',
      argsJson: JSON.stringify({ command: `cumora reply ${conversationId} 'two boards: A and B'` }),
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the recovered reply has been posted', next_step: '' }),
    }),
  ])
  llm.install()

  const tools = makeToolStub({
    bash: async (parsed) => {
      const cmd = String(parsed.command ?? '')
      if (cmd.includes('kanban ls')) {
        return { ok: true, output: { stdout: 'A\nB', stderr: '', exitCode: 0 }, durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      const matched = cmd.match(/^cumora\s+reply\s+(\S+)\s+'([\s\S]*)'$/)
      if (matched) {
        const [, convoId, body] = matched
        const messageId = `m-${randomUUID()}`
        await pool.query(
          `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
             VALUES ($1, $2, $3, 'text', $4, 2, $5)`,
          [messageId, convoId, agentId, body, companyId],
        )
        return { ok: true, output: bashReplyOutput({ stdout: `sent (${messageId}, seq 2)`, conversationId: convoId, messageId }), durationMs: 1, display: { name: 'bash', arg: cmd, status: 'ok' , detail: '' } }
      }
      throw new Error(`unexpected: ${cmd}`)
    },
    set_turn_status: turnStatusToolResult,
  })
  tools.install()

  await runAgentTurn(agentId)

  const posted = await messagesFromAgent(conversationId, agentId)
  assert.equal(posted.length, 1, 'agent recovered and replied even though hop1 response.completed.output was empty')
  // Hop1 bash should have run despite the empty output array.
  assert.equal(tools.calls.filter((c) => /kanban ls/.test(String(c.parsed.command ?? ''))).length, 1)
})

test('[integration] unknown tool name: agent gets an error in function_call_output and can react', async () => {
  // If the model hallucinates a tool name the dispatcher returns the
  // standard "unknown tool" error. The turn loop must not crash and the
  // next hop sees the error inline.
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'do' })

  const llm = makeLlmStub([
    streamWithToolCall({
      fcId: 'fc_1', callId: 'call_1', name: 'lookup_oracle', // not stubbed → unknown tool
      argsJson: '{}',
    }),
    streamWithToolCall({
      fcId: 'fc_status',
      callId: 'call_status',
      name: 'set_turn_status',
      argsJson: JSON.stringify({ status: 'done', reason: 'the unknown tool error was observed', next_step: '' }),
    }),
  ])
  llm.install()
  // No `bash` handler — every tool call falls through to "unknown tool".
  const tools = makeToolStub({ set_turn_status: turnStatusToolResult })
  tools.install()

  await runAgentTurn(agentId)

  const ev = await eventsForAgent(agentId)
  const finished = ev.filter((e) => e.kind === 'tool.finished')
  const unknown = finished.find((e) => e.title.startsWith('lookup_oracle '))
  assert.ok(unknown)
  const d = unknown!.data as { ok: boolean; error?: string }
  assert.equal(d.ok, false)
  assert.equal(d.error, 'unknown tool')
})

test('[integration] MAX_HOPS: model that keeps requesting tools is capped without crashing', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedConvo({ kind: 'direct' })
  await postHumanMessage({ conversationId, companyId, humanId, body: 'loop' })

  // turn.ts currently has MAX_HOPS = 200 (raised over time once
  // auto-compaction took over the cost-containment job). Script
  // MAX_HOPS + 1 streams; the +1 is a tripwire — if the loop ever
  // ran past the cap the stub would yield it and we'd see
  // tool_call_count == 201.
  const streams = []
  for (let i = 1; i <= 201; i++) {
    streams.push(streamWithToolCall({
      fcId: `fc_${i}`, callId: `call_${i}`, name: 'bash',
      argsJson: JSON.stringify({ command: 'cumora kanban ls' }),
    }))
  }
  const llm = makeLlmStub(streams)
  llm.install()
  const tools = makeToolStub({
    bash: () => ({ ok: true, output: { stdout: '', stderr: '', exitCode: 0 }, durationMs: 1, display: { name: 'bash', arg: 'ls', status: 'ok' , detail: '' } }),
  })
  tools.install()

  await runAgentTurn(agentId)

  const { rows: runs } = await pool.query<{ status: string; tool_call_count: number; summary: string }>(
    `SELECT status, tool_call_count, summary FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed', 'run must not be marked completed when capped mid-task')
  assert.match(runs[0].summary, /MAX_HOPS/)
  assert.equal(runs[0].tool_call_count, 200, 'tool_call_count caps at MAX_HOPS = 200')
  // We deliberately don't assert the LLM call count exactly — if there's
  // ever a budget guard tweak that breaks one hop earlier we want the
  // test to still mostly hold; the run-row assertion is the real signal.
  // Suppress unused warning on conversationId — verify the convo is the
  // direct one we seeded.
  assert.match(conversationId, /^direct-/)
})
