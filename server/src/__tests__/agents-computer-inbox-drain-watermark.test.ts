import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRunner, fallbackPollDue } from '../agents/computer/daemon.js'

const NOW = 1_000_000

type Runner = {
  lastInboxDrainAt: number
  token: string
  busy: boolean
  pendingBackgroundBrief: { title: string; body: string } | null
  snapshotUnread(token: string): Promise<unknown>
  runTurn(reason: string): Promise<void>
  ensureToken(): Promise<string>
  postStatus(token: string, status: 'avail' | 'thinking'): Promise<void>
  maybeAgendaTurn(token: string): Promise<void>
}

function createRunner(): Runner {
  return new AgentRunner(
    { serverUrl: 'https://server.example.test', computerId: 'fixture', deviceToken: 'fixture' },
    { id: 'fixture', name: 'Fixture', role: null, systemPrompt: null, engine: 'codex', model: null, fastModel: null },
    'codex',
  ) as unknown as Runner
}

const failures: Array<[string, () => Promise<Response>]> = [
  ['HTTP 503', async () => new Response('', { status: 503 })],
  ['network error', async () => { throw new TypeError('fetch failed') }],
  ['timeout', async () => { throw new DOMException('request timed out', 'TimeoutError') }],
  ['invalid JSON', async () => new Response('{')],
]

for (const [name, fail] of failures) {
  test(`${name} retries after a recent success and restores the slow interval on recovery`, async (t) => {
    let now = NOW
    let respond = fail
    t.mock.method(Date, 'now', () => now)
    t.mock.method(globalThis, 'fetch', () => respond())
    const runner = createRunner()
    runner.lastInboxDrainAt = now - 10_000
    const due = (at: number) => fallbackPollDue({
      now: at, streamLastSeenAt: at - 1_000, lastInboxDrainAt: runner.lastInboxDrainAt,
    })

    await assert.rejects(runner.snapshotUnread('fixture-token'), /inbox fetch failed/)
    assert.equal(runner.lastInboxDrainAt, 0)
    assert.equal(due(now + 20_000), true)

    now += 20_000
    respond = async () => Response.json({ rows: [] })
    await runner.snapshotUnread('fixture-token')
    assert.equal(runner.lastInboxDrainAt, now)
    assert.equal(due(now + 20_000), false)
  })
}

test('a failed inbox ends the turn and preserves the manual wake for retry', async (t) => {
  t.mock.method(Date, 'now', () => NOW)
  t.mock.method(globalThis, 'fetch', failures[0][1])
  const runner = createRunner()
  runner.lastInboxDrainAt = NOW - 10_000
  runner.token = 'fixture-token'
  const brief = { title: 'Review assigned card', body: 'Review the assigned change' }
  runner.pendingBackgroundBrief = brief
  t.mock.method(runner, 'ensureToken', async () => runner.token)
  const status = t.mock.method(runner, 'postStatus', async () => { throw new Error('unexpected status update') })
  const agenda = t.mock.method(runner, 'maybeAgendaTurn', async () => {})
  const error = t.mock.method(console, 'error', () => {})

  await runner.runTurn('sse-wake')
  assert.equal(runner.busy, false)
  assert.equal(runner.lastInboxDrainAt, 0)
  assert.deepEqual(runner.pendingBackgroundBrief, brief)
  assert.equal(status.mock.callCount(), 0)
  assert.equal(agenda.mock.callCount(), 0)
  assert.match(String(error.mock.calls[0]?.arguments[1]), /inbox fetch failed/)
})
