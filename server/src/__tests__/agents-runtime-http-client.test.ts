/**
 * Unit tests pinning the "fire-and-forget" semantics of the HTTP
 * runtime client's observability + UX methods.
 *
 * Real production failure mode this guards (seen TWICE on Iris already):
 *
 *     TypeError: fetch failed
 *       at HttpRuntimeClient.call    (recordEvent's underlying call)
 *       at HttpRuntimeClient.recordEvent
 *       at runAgentTurn
 *       at drain  ← whole turn died because an observability event
 *                   couldn't be posted to cumora-server (mid-restart,
 *                   NEG cutover, DNS blip, whatever)
 *
 * After this fix, recordEvent / finishRun / setStatus / heartbeatStatus
 * / publishTyping all swallow their own fetch failures and log a warn
 * instead. The turn is allowed to keep running. Read-side methods
 * (loadInbox, loadPersona, etc.) MUST still throw — we can't run a
 * turn without those — so they're explicitly NOT swallowed and not
 * covered here.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-runtime-http-client.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { HttpRuntimeClient } from '../agents/runtime/http-client.js'

let warnLog: string[] = []
const realWarn = console.warn

beforeEach(() => {
  warnLog = []
  // Capture the warn lines the swallow path emits so we can assert
  // the operator gets a usable signal (warn level, name of method).
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  }
})

afterEach(() => {
  console.warn = realWarn
})

/** Build a client whose underlying fetch always rejects with the
 *  given error — simulates the "cumora-server unreachable" failure
 *  mode we keep hitting in production. */
function makeClientThatAlwaysFails(reason = 'fetch failed (simulated)'): HttpRuntimeClient {
  const stubFetch = ((async () => {
    throw new TypeError(reason)
  }) as unknown) as typeof fetch
  return new HttpRuntimeClient({
    baseUrl: 'http://stub-runtime.invalid',
    token: 'stub-token',
    fetchImpl: stubFetch,
    timeoutMs: 1_000,
  })
}

// ── recordEvent ─────────────────────────────────────────────────────────

test('recordEvent: swallows a fetch failure and logs a warn', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.doesNotReject(
    client.recordEvent({
      runId: 'r1', agentId: 'a1', kind: 'turn.completed',
      title: 'Turn completed', data: { ok: true },
    }),
    'recordEvent must NOT propagate fetch errors — the turn depends on continuing past observability hiccups',
  )
  assert.ok(
    warnLog.some((l) => l.includes('recordEvent(turn.completed) failed')),
    `expected warn line for the failed event; got:\n${warnLog.join('\n')}`,
  )
})

test('recordEvent: works with a 5xx server response too (call() throws on non-2xx)', async () => {
  const stubFetch = ((async () => new Response('boom', { status: 503 })) as unknown) as typeof fetch
  const client = new HttpRuntimeClient({ baseUrl: 'http://stub.invalid', token: 't', fetchImpl: stubFetch, timeoutMs: 1_000 })
  await assert.doesNotReject(
    client.recordEvent({ runId: 'r1', agentId: 'a1', kind: 'tool.finished', title: 'ok' }),
  )
})

// ── finishRun ──────────────────────────────────────────────────────────

test('finishRun: swallows fetch failure (called from turn.ts finally — must not crash cleanup)', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.doesNotReject(
    client.finishRun({ runId: 'r1', status: 'failed', error: 'underlying turn failed' }),
  )
  assert.ok(warnLog.some((l) => l.includes('finishRun(r1, failed)')))
})

// ── setStatus / heartbeatStatus ────────────────────────────────────────

test('setStatus: a fetch failure does NOT kill the turn', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.doesNotReject(client.setStatus('agent-foo', 'thinking'))
  assert.ok(warnLog.some((l) => l.includes('setStatus(thinking)')))
})

test('heartbeatStatus: a fetch failure does NOT kill the heartbeat tick (or the turn)', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.doesNotReject(client.heartbeatStatus('agent-foo', 'working'))
  assert.ok(warnLog.some((l) => l.includes('heartbeatStatus(working)')))
})

// ── publishTyping ──────────────────────────────────────────────────────

test('publishTyping: failure to post the typing indicator does not break the turn', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.doesNotReject(
    client.publishTyping({ conversationId: 'convo-1', agentId: 'a1', done: false }),
  )
  await assert.doesNotReject(
    client.publishTyping({ conversationId: 'convo-1', agentId: 'a1', done: true }),
  )
  assert.equal(warnLog.filter((l) => l.includes('publishTyping')).length, 2)
})

// ── Read-side methods MUST still throw ────────────────────────────────

test('loadContext: sends only conversation selectors because the JWT pins the tenant', async () => {
  let requestBody: unknown
  const stubFetch = ((async (_input: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? 'null'))
    return new Response(JSON.stringify({ rows: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown) as typeof fetch
  const client = new HttpRuntimeClient({
    baseUrl: 'http://stub.invalid',
    token: 'tenant-pinned-token',
    fetchImpl: stubFetch,
    timeoutMs: 1_000,
  })

  await client.loadContext('agent-foo', 'company-from-call-site', ['convo-1'])

  assert.deepEqual(requestBody, { conversationIds: ['convo-1'] })
})

test('regression guard: loadInbox MUST still throw on fetch failure — turn cannot run without an inbox', async () => {
  // Symmetric defence — if someone "fixes" loadInbox to also swallow,
  // the turn would silently run with no inbox and the agent would
  // appear to ignore every message. We DO want it to throw so the
  // outer drain loop knows to retry / surface the failure.
  const client = makeClientThatAlwaysFails()
  await assert.rejects(
    client.loadInbox('agent-foo'),
    /fetch failed/,
    'loadInbox must propagate — the turn cannot proceed without inbox data',
  )
})

test('regression guard: loadPersona MUST still throw on fetch failure', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.rejects(client.loadPersona('agent-foo'), /fetch failed/)
})

test('regression guard: buildSystemPrompt MUST still throw on fetch failure', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.rejects(client.buildSystemPrompt('agent-foo'), /fetch failed/)
})

test('regression guard: createRun MUST still throw on fetch failure (no runId → no point continuing)', async () => {
  const client = makeClientThatAlwaysFails()
  await assert.rejects(
    client.createRun({ agentId: 'agent-foo' }),
    /fetch failed/,
  )
})
