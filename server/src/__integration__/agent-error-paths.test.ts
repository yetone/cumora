/**
 * Error-path coverage for the agent turn loop — failure modes that
 * `agent-turn.test.ts` and `agent-tools.test.ts` don't already pin:
 *
 *   - 429 / quota-exhausted: turn ends as `status='skipped'`, a
 *     `turn.skipped` event lands, and a system notice ("AI quota
 *     exhausted …") is posted to every conversation in the inbox.
 *   - non-quota LLM/runtime failures: the run still fails, but a
 *     user-visible system notice lands so the agent does not disappear.
 *   - image-strip retry: when the LLM call's first attempt fails because
 *     OpenAI couldn't fetch an `image_url`, we retry once with all
 *     `input_image` blocks stripped, and the second attempt's tool call
 *     drives the rest of the turn.
 *   - image generation via `r.data[0].url` (the upstream returned a URL
 *     instead of inline b64): `generateAndUploadImage` fetches the URL
 *     and uploads the buffer; we inject a known PNG at the safe image-fetch
 *     boundary so the test stays hermetic.
 *
 * Run via:
 *   INTEGRATION_DATABASE_URL=postgres://$USER@localhost:5432/cumora_test \
 *     npm run test:integration
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { pool } from '../db/pool.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'
import { __setPodToolOverrideForTesting } from '../agents/runtime/pod-tools.js'
import { runAgentTurn } from '../agents/turn.js'
import { runCli } from '../agents/cli.js'
import { __setImageFetchOverrideForTesting } from '../agents/image-fetcher.js'
import type { ToolResult } from '../agents/tools-shared.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
  __setLlmClientOverrideForTesting(null)
  __setPodToolOverrideForTesting(null)
  __setImageFetchOverrideForTesting(null)
})

after(async () => {
  __setLlmClientOverrideForTesting(null)
  __setPodToolOverrideForTesting(null)
  __setImageFetchOverrideForTesting(null)
  await teardownAll()
})

// ────────────────────────────────────────────────────────────────────────────
// Fixtures (kept local — same shape as the other two test files)
// ────────────────────────────────────────────────────────────────────────────

async function seedDirect(): Promise<{
  companyId: string; agentId: string; humanId: string; conversationId: string
}> {
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
    [agentId, companyId, `Agent ${agentId}`, 'A'],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')`,
    [humanId, companyId, humanId, 'H'],
  )
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'direct', $2, $3::jsonb, 'human', $4)`,
    [conversationId, humanId, JSON.stringify([agentId, humanId]), companyId],
  )
  return { companyId, agentId, humanId, conversationId }
}

async function postHuman(opts: { conversationId: string; companyId: string; humanId: string; body: string }): Promise<string> {
  const messageId = `m-${randomUUID()}`
  await pool.query(
    `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'text', $4, 1, $5)`,
    [messageId, opts.conversationId, opts.humanId, opts.body, opts.companyId],
  )
  return messageId
}

/** A 1x1 transparent PNG — kept tiny so the test is fast and the fixed
 *  byte length is easy to assert on. */
const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

function streamTurnStatusDone(): ResponseStreamEvent[] {
  const argsJson = JSON.stringify({ status: 'done', reason: 'test complete', next_step: '' })
  return [
    { type: 'response.created', response: { id: `resp_${randomUUID().slice(0, 8)}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
    { type: 'response.output_item.added', item: { id: 'fc_status', type: 'function_call', call_id: 'call_status', name: 'set_turn_status', arguments: '' } } as unknown as ResponseStreamEvent,
    { type: 'response.function_call_arguments.done', item_id: 'fc_status', arguments: argsJson } as unknown as ResponseStreamEvent,
    { type: 'response.completed', response: { status: 'completed', output: [{ id: 'fc_status', type: 'function_call', call_id: 'call_status', name: 'set_turn_status', arguments: argsJson }], usage: { input_tokens: 100, output_tokens: 5 } } } as unknown as ResponseStreamEvent,
  ]
}

function turnStatusResult(): ToolResult {
  return {
    ok: true,
    output: { status: 'done', reason: 'test complete', nextStep: '', assistantTextAction: 'none', replyConversationId: null },
    durationMs: 1,
    display: { name: 'set_turn_status', arg: 'done', status: 'done', detail: 'test complete' },
  }
}

// ────────────────────────────────────────────────────────────────────────────
// F. 429 / quota-exhausted
// ────────────────────────────────────────────────────────────────────────────

test('[integration] 429 quota exhausted: run is `skipped`, system notice lands in inbox conversations', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'hi' })

  // Stub LLM responses.create to throw a 429-shaped error. turn.ts'
  // `isQuotaExhaustedError` checks `err.status === 429` first, so this
  // mirrors the exact path the production OpenAI SDK takes.
  __setLlmClientOverrideForTesting(async () => {
    return {
      responses: {
        create: async () => {
          const err = new Error('Rate limit exceeded for requests') as Error & { status?: number }
          err.status = 429
          throw err
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })

  await runAgentTurn(agentId)

  // Run row should be skipped, NOT failed (red). The model error feeds
  // into a graceful-skip branch.
  const { rows: runs } = await pool.query<{ status: string; summary: string; error: string | null }>(
    `SELECT status, summary, error FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'skipped')
  assert.match(runs[0].summary, /quota|429/i)

  // turn.skipped event recorded for observability.
  const { rows: ev } = await pool.query<{ kind: string; data: Record<string, unknown> }>(
    `SELECT kind, data FROM agent_events WHERE agent_id = $1 AND kind = 'turn.skipped'`,
    [agentId],
  )
  assert.equal(ev.length, 1)
  assert.equal((ev[0].data as { reason?: string })?.reason, 'quota_exhausted')

  // System notice posted to the inbox conversation, kind='system',
  // noticeKind='quota_exhausted'.
  const { rows: notices } = await pool.query<{ kind: string; body: string; author_id: string }>(
    `SELECT kind, body, author_id FROM messages
       WHERE conversation_id = $1 AND kind = 'system'`,
    [conversationId],
  )
  assert.equal(notices.length, 1, 'one system notice in the conversation')
  assert.equal(notices[0].author_id, agentId)
  const parsedBody = JSON.parse(notices[0].body) as { kind: string; noticeKind?: string; text?: string }
  assert.equal(parsedBody.kind, 'notice')
  assert.equal(parsedBody.noticeKind, 'quota_exhausted')
  assert.match(String(parsedBody.text ?? ''), /AI quota exhausted/i)
})

test('[integration] 429 quota: dedupe key suppresses duplicate notices across rapid wakes', async () => {
  // postSystemNotice uses Redis SETNX with key `notice:quota_exhausted:<convoId>`
  // and a 1h TTL. Two wakes that both hit 429 on the same convo must
  // NOT post two notices.
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'first message' })

  __setLlmClientOverrideForTesting(async () => {
    return {
      responses: {
        create: async () => {
          const err = new Error('429: rate_limit_exceeded') as Error & { status?: number }
          err.status = 429
          throw err
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })

  await runAgentTurn(agentId)
  // Insert a SECOND message so the inbox fingerprint changes and the
  // dedup-by-fingerprint guard doesn't short-circuit the second wake.
  await postHuman({ conversationId, companyId, humanId, body: 'second message' })
  await runAgentTurn(agentId)

  const { rowCount } = await pool.query(
    `SELECT 1 FROM messages WHERE conversation_id = $1 AND kind = 'system'`,
    [conversationId],
  )
  assert.equal(rowCount, 1, 'exactly one system notice — Redis dedupe held')
})

test('[integration] non-quota LLM failure: run fails and posts one user-visible failure notice', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'please do a long task' })

  let attempt = 0
  __setLlmClientOverrideForTesting(async () => {
    return {
      responses: {
        create: async () => {
          attempt += 1
          throw new Error('Connection error.')
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })

  await assert.rejects(runAgentTurn(agentId), /Connection error/i)
  assert.equal(attempt, 3, 'initial request plus two provider-connection retries')

  const { rows: runs } = await pool.query<{ status: string; summary: string; error: string | null }>(
    `SELECT status, summary, error FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.match(runs[0].summary, /Agent turn failed/)
  assert.match(runs[0].error ?? '', /Connection error/i)

  const { rows: notices } = await pool.query<{ kind: string; body: string; author_id: string }>(
    `SELECT kind, body, author_id FROM messages
       WHERE conversation_id = $1 AND kind = 'system'`,
    [conversationId],
  )
  assert.equal(notices.length, 1, 'one failure notice in the conversation')
  assert.equal(notices[0].author_id, agentId)
  const parsedBody = JSON.parse(notices[0].body) as { kind: string; noticeKind?: string; text?: string }
  assert.equal(parsedBody.kind, 'notice')
  assert.equal(parsedBody.noticeKind, 'agent_turn_failed')
  assert.match(String(parsedBody.text ?? ''), /failed before it could finish/i)
  assert.match(String(parsedBody.text ?? ''), /provider connection/i)

  const { rows: retryEvents } = await pool.query<{ kind: string }>(
    `SELECT kind FROM agent_events WHERE agent_id = $1 AND kind = 'model.retry_provider_connection'`,
    [agentId],
  )
  assert.equal(retryEvents.length, 2, 'two provider-connection retry events are recorded before failing')
})

test('[integration] non-quota LLM failure: duplicate wakes on same input dedupe failure notices', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'please do a long task' })

  __setLlmClientOverrideForTesting(async () => {
    return {
      responses: {
        create: async () => {
          throw new Error('tool executor exploded')
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })

  await assert.rejects(runAgentTurn(agentId), /tool executor exploded/i)
  await assert.rejects(runAgentTurn(agentId), /tool executor exploded/i)

  const { rowCount } = await pool.query(
    `SELECT 1 FROM messages WHERE conversation_id = $1 AND kind = 'system'`,
    [conversationId],
  )
  assert.equal(rowCount, 1, 'exactly one failure notice for the same unread input')
})

test('[integration] provider connection failure: short retry can recover the turn without a failure notice', async () => {
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'please retry the provider once' })

  let attempt = 0
  __setLlmClientOverrideForTesting(async () => {
    return {
      responses: {
        create: async () => {
          attempt += 1
          if (attempt === 1) throw new Error('Connection error.')
          const events = streamTurnStatusDone()
          return (async function *() {
            for (const ev of events) yield ev
          })()
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })
  __setPodToolOverrideForTesting(async () => turnStatusResult())

  await runAgentTurn(agentId)
  assert.equal(attempt, 2, 'second attempt succeeded after a provider connection retry')

  const { rows: runs } = await pool.query<{ status: string }>(
    `SELECT status FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs[0]?.status, 'completed')

  const { rows: retryEvents } = await pool.query<{ kind: string }>(
    `SELECT kind FROM agent_events WHERE agent_id = $1 AND kind = 'model.retry_provider_connection'`,
    [agentId],
  )
  assert.equal(retryEvents.length, 1, 'one provider retry event is recorded')

  const { rowCount } = await pool.query(
    `SELECT 1 FROM messages WHERE conversation_id = $1 AND kind = 'system'`,
    [conversationId],
  )
  assert.equal(rowCount, 0, 'successful retry does not post a red failure notice')
})

// ────────────────────────────────────────────────────────────────────────────
// G. Image-strip retry on image_url fetch failure
// ────────────────────────────────────────────────────────────────────────────

test('[integration] image_url fetch fail on attempt 0 → retry with images stripped → succeeds', async () => {
  // turn.ts has a strip-and-retry inner loop: if the LLM call's first
  // attempt throws an error matching `isImageFetchFailure`, we re-send
  // with all input_image blocks stripped. The model on the retry hop
  // wraps up with no tool calls; we just need to confirm a single run
  // completes (status='completed', not 'failed') and the
  // `model.retry_no_images` observability event is recorded.
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'look at this image' })

  let attempt = 0
  __setLlmClientOverrideForTesting(async () => {
    return {
      responses: {
        create: async () => {
          attempt += 1
          if (attempt === 1) {
            // First attempt: fail with image-fetch shape so the retry
            // branch fires. Match `isImageFetchFailure` regex.
            throw new Error('Error while downloading https://example.invalid/x.png: invalid_image_url')
          }
          // Retry attempt: terminate with the explicit turn-status protocol.
          const events = streamTurnStatusDone()
          return (async function *() {
            for (const ev of events) yield ev
          })()
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })
  __setPodToolOverrideForTesting(async () => turnStatusResult())

  await runAgentTurn(agentId)
  assert.equal(attempt, 2, 'second attempt fired after the first threw')

  // Observability event for the strip retry.
  const { rows: ev } = await pool.query<{ kind: string; data: Record<string, unknown> }>(
    `SELECT kind, data FROM agent_events WHERE agent_id = $1 AND kind = 'model.retry_no_images'`,
    [agentId],
  )
  assert.equal(ev.length, 1, 'one model.retry_no_images event')

  // Run row is completed (graceful — not surfaced as failure).
  const { rows: runs } = await pool.query<{ status: string }>(
    `SELECT status FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'completed')
})

// ────────────────────────────────────────────────────────────────────────────
// H. Image generation via remote URL (not b64_json)
// ────────────────────────────────────────────────────────────────────────────

test('[integration] generateAndUploadImage: r.data[0].url fallback — fetches remote bytes and persists attachment', async () => {
  // When the image API returns a URL instead of inline b64, cumora's
  // `generateAndUploadImage` fetches the URL and uploads the resulting
  // buffer. Inject at the safe-fetch boundary so this call-site test stays
  // hermetic while image-fetcher.test.ts owns DNS/redirect policy coverage.
  const { agentId, conversationId } = await seedDirect()

  let fetchedUrl: string | null = null
  __setImageFetchOverrideForTesting(async input => {
    fetchedUrl = input
    return {
      ok: true,
      buffer: TINY_PNG_BYTES,
      mime: 'image/png',
      bytes: TINY_PNG_BYTES.length,
      finalUrl: input,
    }
  })

  __setLlmClientOverrideForTesting(async () => {
    return {
      images: {
        generate: async () => ({ data: [{ url: 'https://stub.image-api.example/generated/abc.png' }] }),
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })

  const res = await runCli([
    '--as', agentId,
    'reply', conversationId, 'rendered',
    '--generate-image', 'a tiny test pixel via url',
  ])
  assert.equal(res.ok, true, `runCli failed: ${res.text}`)
  assert.equal(fetchedUrl, 'https://stub.image-api.example/generated/abc.png',
    'cumora must have fetched the URL returned by the image API')

  const { rows } = await pool.query<{ attachment: Record<string, unknown> | null }>(
    `SELECT attachment FROM messages WHERE conversation_id = $1 AND author_id = $2`,
    [conversationId, agentId],
  )
  assert.equal(rows.length, 1)
  const att = rows[0].attachment
  assert.ok(att, 'attachment row not null')
  assert.equal(att?.kind, 'img')
  assert.equal(att?.mime, 'image/png')
  assert.equal(att?.size, TINY_PNG_BYTES.length, 'attachment size matches the fetched bytes exactly')
})

// ────────────────────────────────────────────────────────────────────────────
// I. MAX_HOPS cap-out emits turn.cap_reached
// ────────────────────────────────────────────────────────────────────────────

test('[integration] MAX_HOPS cap-out: emit turn.cap_reached event when model is still requesting tools at the cap', async () => {
  // The Iris-doesn't-finish bug: model promises "我来下载…" in hop 1
  // (the tool call IS posted), then spends hops 2–4 doing the work,
  // and the loop runs out of headroom before the final hop where the
  // model would have called cumora reply with the result. Pre-fix,
  // the run row said "Completed with N tool calls" with no observable
  // signal that we cut the model off mid-task.
  //
  // turn.ts currently has MAX_HOPS = 200 (bumped from 4 → 8 → 100 → 200 as
  // the auto-compaction path took over the cost-containment job from
  // the hop counter). To exercise the cap we script MAX_HOPS+1
  // tool-call streams; the +1 acts as a tripwire — if the loop ever
  // ran past the cap, the stub would yield it and the test would see
  // tool_call_count == 201 instead of 200.
  const { companyId, agentId, humanId, conversationId } = await seedDirect()
  await postHuman({ conversationId, companyId, humanId, body: 'do many steps' })

  const tooManyHops: ResponseStreamEvent[][] = []
  for (let i = 1; i <= 201; i++) {
    tooManyHops.push([
      { type: 'response.created', response: { id: `resp_${i}`, status: 'in_progress' } } as unknown as ResponseStreamEvent,
      { type: 'response.output_item.added', item: { id: `fc_${i}`, type: 'function_call', call_id: `call_${i}`, name: 'bash', arguments: '' } } as unknown as ResponseStreamEvent,
      { type: 'response.function_call_arguments.done', item_id: `fc_${i}`, arguments: JSON.stringify({ command: `echo step-${i}` }) } as unknown as ResponseStreamEvent,
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ id: `fc_${i}`, type: 'function_call', call_id: `call_${i}`, name: 'bash', arguments: JSON.stringify({ command: `echo step-${i}` }) }],
          usage: { input_tokens: 500, output_tokens: 50 },
        },
      } as unknown as ResponseStreamEvent,
    ])
  }
  __setLlmClientOverrideForTesting(async () => {
    let i = 0
    return {
      responses: {
        create: async () => {
          const events = tooManyHops[i++]
          if (!events) throw new Error('LLM called more times than MAX_HOPS')
          return (async function *() {
            for (const ev of events) yield ev
          })()
        },
      },
    } as unknown as Awaited<ReturnType<typeof import('../llm.js').getLlmClient>>
  })
  __setPodToolOverrideForTesting(async () => ({
    ok: true,
    output: { stdout: 'ok', stderr: '', exitCode: 0 },
    durationMs: 1,
    display: { name: 'bash', arg: 'echo', status: 'ok', detail: '' },
  }))

  await runAgentTurn(agentId)

  // The new event we just added.
  const { rows: capEv } = await pool.query<{ data: Record<string, unknown> }>(
    `SELECT data FROM agent_events WHERE agent_id = $1 AND kind = 'turn.cap_reached'`,
    [agentId],
  )
  assert.equal(capEv.length, 1, 'exactly one turn.cap_reached event')
  assert.equal(capEv[0].data.toolCallCount, 200, 'tool_call_count reflects the full MAX_HOPS budget')
  assert.equal(capEv[0].data.maxHops, 200, 'cap_reached carries the MAX_HOPS constant')
  assert.equal(capEv[0].data.postedReplyViaTool, false, 'no cumora reply in this scenario')

  // Run row reflects the cap-out in its summary.
  const { rows: runs } = await pool.query<{ status: string; summary: string; tool_call_count: number }>(
    `SELECT status, summary, tool_call_count FROM agent_runs WHERE agent_id = $1`,
    [agentId],
  )
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.equal(runs[0].tool_call_count, 200)
  assert.match(runs[0].summary, /MAX_HOPS|still requesting tools/i)
})
