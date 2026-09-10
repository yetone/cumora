/**
 * Integration tests for the two server-side backstops that stop
 * agents from monologuing or doing duplicate work:
 *
 *   1. Anti-monologue gate in cmdReply — same agent can't post twice
 *      in a row in a multi-party convo until someone else speaks.
 *   2. Worklog claims (claimWork / releaseWork / peekWorklog) — same
 *      (taskType, subject) within a tenant scope blocks duplicate
 *      heavy work until released or TTL expires.
 *
 * Both are agent-judgment backstops that exist because the LLM-side
 * "should I keep talking / should I do this thing" prompt rules
 * repeatedly fail in practice. The tests pin the contract.
 */
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { redis } from '../redis.js'
import {
  ensureSchemaOnce, resetAllTables, seedCompanyWithAgent, teardownAll,
} from './_helpers.js'
import { runCli } from '../agents/cli.js'
import { inprocClient } from '../agents/runtime/inproc-client.js'

before(async () => {
  await ensureSchemaOnce()
})

beforeEach(async () => {
  await resetAllTables()
  // Wipe any worklog state from the previous test so claims don't
  // leak across test boundaries. SCAN+DEL because we use HASH keys
  // that FLUSHDB at the schema level doesn't touch.
  for await (const keys of redis.scanStream({ match: 'cumora:worklog:*', count: 100 })) {
    if (keys.length > 0) await redis.del(...keys)
  }
})

after(async () => {
  await teardownAll()
})

async function seedGroupWithTwoAgents(): Promise<{
  companyId: string; agentA: string; agentB: string; humanId: string; convoId: string;
}> {
  const { companyId, agentId: agentA } = await seedCompanyWithAgent()
  const agentB = `a-${randomUUID().slice(0, 8)}`
  const humanId = `h-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', $4, '#abcdef', 'avail')`,
    [agentB, companyId, `Agent ${agentB}`, 'B'],
  )
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')`,
    [humanId, companyId, humanId, 'H'],
  )
  const convoId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'group', $2, $3::jsonb, 'group', $4)`,
    [convoId, 'Anti-monologue test', JSON.stringify([agentA, agentB, humanId]), companyId],
  )
  return { companyId, agentA, agentB, humanId, convoId }
}

test('[integration] cmdReply blocks consecutive posts from the same agent in a group', async () => {
  const { agentA, agentB, convoId } = await seedGroupWithTwoAgents()

  // First post: succeeds, no prior history.
  const first = await runCli(['--as', agentA, 'reply', convoId, 'first message from A'])
  assert.equal(first.ok, true, `first reply should succeed: ${first.text}`)

  // Second post from same agent without anyone else speaking: blocked.
  const second = await runCli(['--as', agentA, 'reply', convoId, 'second from A — adding to my point'])
  assert.equal(second.ok, false, 'second consecutive reply should be blocked')
  assert.match(second.text, /you already posted/i)
  assert.match(second.text, /until someone else speaks/i)

  // After agent B breaks the chain, agent A may post again — but the
  // seen-cursor freshness gate runs FIRST: A has not SEEN B's
  // message yet, so A's first attempt is HELD (the hold shows the message and
  // advances A's cursor past it), and a plain resend then goes through with
  // no flag. This two-step IS the coordination contract (reply from real
  // posted state, never from a stale snapshot) — pin it.
  const fromB = await runCli(['--as', agentB, 'reply', convoId, 'B chimes in'])
  assert.equal(fromB.ok, true, `B's reply should succeed: ${fromB.text}`)

  const heldFromA = await runCli(['--as', agentA, 'reply', convoId, 'A again after B spoke'])
  assert.equal(heldFromA.ok, false, 'A\'s first attempt after B spoke is HELD (unseen peer message)')
  assert.match(heldFromA.text, /HELD/, 'the hold names itself')
  assert.match(heldFromA.text, /B chimes in/, 'the hold SHOWS the unseen message')

  const thirdFromA = await runCli(['--as', agentA, 'reply', convoId, 'A again after B spoke'])
  assert.equal(thirdFromA.ok, true, `plain resend after the hold should go through: ${thirdFromA.text}`)
})

test('[integration] --continue bypass overrides the anti-monologue gate', async () => {
  const { agentA, convoId } = await seedGroupWithTwoAgents()

  await runCli(['--as', agentA, 'reply', convoId, 'first'])
  const blocked = await runCli(['--as', agentA, 'reply', convoId, 'second'])
  assert.equal(blocked.ok, false)

  const bypassed = await runCli(['--as', agentA, 'reply', convoId, 'urgent correction', '--continue'])
  assert.equal(bypassed.ok, true, `--continue should bypass the gate: ${bypassed.text}`)
})

test('[integration] a human can post immediately after inviting an agent', async () => {
  const { companyId, humanId, convoId } = await seedGroupWithTwoAgents()
  const invitedId = `a-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'agent', $3, 'tester', 'C', '#abcdef', 'avail')`,
    [invitedId, companyId, `Agent ${invitedId}`],
  )

  const invited = await runCli(['--as', humanId, 'invite', convoId, invitedId])
  assert.equal(invited.ok, true, `invite should succeed: ${invited.text}`)

  const followUp = await runCli([
    '--as', humanId, 'reply', convoId, `@${invitedId} please review the synthetic task`,
  ])
  assert.equal(
    followUp.ok,
    true,
    `the agent-only anti-monologue gate must not block a human follow-up: ${followUp.text}`,
  )
})

test('[integration] DM (2-member convo) is exempt from the anti-monologue gate', async () => {
  const { companyId, agentId: agentA } = await seedCompanyWithAgent()
  const humanId = `h-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO participants (id, company_id, kind, name, role, initial, avatar_bg, status)
       VALUES ($1, $2, 'human', $3, 'owner', $4, '#abcdef', 'avail')`,
    [humanId, companyId, humanId, 'H'],
  )
  const convoId = `c-${randomUUID().slice(0, 8)}`
  await pool.query(
    `INSERT INTO conversations (id, kind, title, members, tag, company_id)
       VALUES ($1, 'direct', $2, $3::jsonb, 'human', $4)`,
    [convoId, humanId, JSON.stringify([agentA, humanId]), companyId],
  )

  // Even two posts in a row in a DM should succeed — DMs are explicitly
  // exempt because real-world follow-ups happen.
  const first = await runCli(['--as', agentA, 'reply', convoId, 'hi'])
  assert.equal(first.ok, true)
  const second = await runCli(['--as', agentA, 'reply', convoId, 'one more thing'])
  assert.equal(second.ok, true, `DM follow-up should not be blocked: ${second.text}`)
})

test('[unit] claimWork is atomic: first caller wins, second sees the existing entry', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  const first = await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'web-search', subject: 'warm pastels',
  })
  assert.equal(first.accepted, true)

  const second = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'web-search', subject: 'warm pastels',
  })
  assert.equal(second.accepted, false)
  if (second.accepted === false) {
    assert.equal(second.existing.agentId, 'iris')
    assert.equal(second.existing.taskType, 'web-search')
    assert.equal(second.existing.subject, 'warm pastels')
    assert.equal(typeof second.existing.startedAt, 'number')
  }
})

test('[unit] claimWork normalizes subjects so trivial rephrasing still collides', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  const first = await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'web-search', subject: 'Warm  Pastels',
  })
  assert.equal(first.accepted, true)

  // Different capitalization + extra whitespace should normalize to the
  // same dedup key and collide.
  const second = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'web-search', subject: 'warm pastels',
  })
  assert.equal(second.accepted, false)
})

test('[unit] releaseWork frees the slot only for the holder', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'doc-create', subject: 'Q3 plan',
  })

  // Bram tries to release Iris's claim — must be a no-op.
  await inprocClient.releaseWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'Q3 plan',
  })
  const stillHeld = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'Q3 plan',
  })
  assert.equal(stillHeld.accepted, false, 'Bram should NOT be able to release-then-grab')

  // Iris releases her own claim — now Bram can take it.
  await inprocClient.releaseWork({
    scopeKey, agentId: 'iris', taskType: 'doc-create', subject: 'Q3 plan',
  })
  const bramTakesIt = await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'Q3 plan',
  })
  assert.equal(bramTakesIt.accepted, true, 'After Iris releases, Bram should get the claim')
})

test('[unit] peekWorklog returns all live entries sorted by start time', async () => {
  const scopeKey = `tenant:test-${randomUUID().slice(0, 8)}`

  await inprocClient.claimWork({
    scopeKey, agentId: 'iris', taskType: 'web-search', subject: 'first',
  })
  // Small delay so timestamps differ.
  await new Promise((r) => setTimeout(r, 5))
  await inprocClient.claimWork({
    scopeKey, agentId: 'bram', taskType: 'doc-create', subject: 'second',
  })

  const entries = await inprocClient.peekWorklog(scopeKey)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].subject, 'first')
  assert.equal(entries[1].subject, 'second')
  assert.ok(entries[0].startedAt <= entries[1].startedAt)
})

test('[integration] worklog blocks a duplicate heavy-tool claim from a peer', async () => {
  const { companyId, agentA, agentB } = await seedGroupWithTwoAgents()
  const scopeKey = `tenant:${companyId}`

  // Pre-claim as if agentA had just started searching. We avoid
  // actually calling web_search (which would hit the live tool) by
  // pre-seeding the worklog directly, then checking that agentB's
  // attempt at the same subject is blocked.
  const seeded = await inprocClient.claimWork({
    scopeKey, agentId: agentA, taskType: 'web-search', subject: 'audio editor competitive analysis',
  })
  assert.equal(seeded.accepted, true)

  // A peer sees the live claim and yields before attempting the same
  // expensive operation. Browser research now lives in the agent runtime,
  // so pin the shared worklog contract instead of a deleted CLI command.
  const duplicate = await inprocClient.claimWork({
    scopeKey, agentId: agentB, taskType: 'web-search', subject: 'audio editor competitive analysis',
  })
  assert.equal(duplicate.accepted, false, 'duplicate heavy work should be blocked')
  if (duplicate.accepted === false) {
    assert.equal(duplicate.existing.agentId, agentA)
    assert.equal(duplicate.existing.taskType, 'web-search')
  }

  // Cleanup.
  await inprocClient.releaseWork({
    scopeKey, agentId: agentA, taskType: 'web-search', subject: 'audio editor competitive analysis',
  })
})

// ─── announce-then-deliver ─────────────────────────────────────────
//
// The operating rules in turn.ts REQUIRE an intent message before any work
// that keeps the asker waiting: "POST A SHORT INTENT MESSAGE first via
// `cumora reply` … THEN do the work. THEN reply with the actual result. The
// intent message must be a SEPARATE `cumora reply` call."
//
// In a group of three or more, that intent message is then the room's last
// message and seconds old — exactly what the anti-monologue gate refuses. So
// the product mandated a flow its own backstop rejected, and the deliverable
// that came back was the failure notice rather than the answer.

test('[integration] the gate refuses the result that the mandated intent message asked for', async () => {
  const { agentA, convoId } = await seedGroupWithTwoAgents()

  const intent = await runCli(['--as', agentA, 'reply', convoId, 'Drafting the email now — ~30s'])
  assert.equal(intent.ok, true, `the intent message the rules require must post: ${intent.text}`)

  // …30 seconds of work later, the actual answer, exactly as the relay used to
  // send it: no flag.
  const answer = await runCli(['--as', agentA, 'reply', convoId, 'Here is the draft: ...'])
  assert.equal(answer.ok, false, 'this is the state being fixed — the gate refuses the deliverable')
  assert.match(answer.text, /you already posted in/)
})

test('[integration] the relay delivers that result, body intact', async () => {
  const { agentA, convoId } = await seedGroupWithTwoAgents()
  await runCli(['--as', agentA, 'reply', convoId, 'Drafting the email now — ~30s'])

  // The shape turn.ts's declared relay now sends: flag LAST.
  const body = 'Here is the draft: subject line, three paragraphs, CTA.'
  const relayed = await runCli(['--as', agentA, 'reply', convoId, body, '--continue'])
  assert.equal(relayed.ok, true, `the relay must deliver the answer: ${relayed.text}`)

  const { rows } = await pool.query<{ body: string }>(
    `SELECT body FROM messages WHERE conversation_id = $1 ORDER BY sequence DESC LIMIT 1`,
    [convoId],
  )
  assert.equal(rows[0].body, body, 'the answer must arrive whole, not empty')
})

test('[unit] the bypass flag has to come after the body', async () => {
  // parseArgs reads `--continue <token>` as a VALUE flag, so putting the flag
  // before the body consumes the body and posts an EMPTY message. Pin the
  // ordering, because moving the flag to the front reads like a tidy-up.
  //
  // Asserted on parseArgs directly and unconditionally. The first version of
  // this test wrapped its assertion in `if (wrongOrder.ok)`, which meant it
  // could pass without checking anything — thanks to @yetone for catching it.
  const { parseArgs } = await import('../agents/cli-parse.js')

  const wrong = parseArgs(['reply', 'g-1', '--continue', 'the actual answer'])
  assert.equal(wrong.flags.continue, 'the actual answer',
    'parseArgs takes the next token as the flag VALUE')
  assert.deepEqual(wrong.positional, ['reply', 'g-1'],
    'so the body is gone entirely — flag-before-body posts an empty message')

  const right = parseArgs(['reply', 'g-1', 'the actual answer', '--continue'])
  assert.equal(right.flags.continue, true, 'trailing flag parses as a boolean')
  assert.deepEqual(right.positional, ['reply', 'g-1', 'the actual answer'],
    'and the body survives')
})

test('[integration] flag-before-body does not post the body', async () => {
  // The same trap through the real CLI, asserted unconditionally this time.
  const { agentA, convoId } = await seedGroupWithTwoAgents()
  await runCli(['--as', agentA, 'reply', convoId, 'Drafting the email now — ~30s'])

  await runCli(['--as', agentA, 'reply', convoId, '--continue', 'the actual answer'])
  const { rows } = await pool.query<{ body: string }>(
    `SELECT body FROM messages WHERE conversation_id = $1 ORDER BY sequence DESC LIMIT 1`,
    [convoId],
  )
  assert.notEqual(
    rows[0].body, 'the actual answer',
    'flag-before-body must never be adopted: parseArgs eats the body as the flag value',
  )
})

test('[integration] a plain second post is still refused', async () => {
  // The guard rail: this fix must not turn the gate off. Only the relay, which
  // carries the flag, gets through.
  const { agentA, convoId } = await seedGroupWithTwoAgents()
  await runCli(['--as', agentA, 'reply', convoId, 'first'])
  const second = await runCli(['--as', agentA, 'reply', convoId, 'monologuing on'])
  assert.equal(second.ok, false, 'the anti-monologue gate must still hold for ordinary replies')
})

test('[unit] the declared relay carries the bypass, last', async () => {
  // Every test above passes just as well against a relay that sends no flag —
  // they exercise cmdReply, not the caller. Read turn.ts, because the defect
  // was in what the relay sends.
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../agents/turn.ts', import.meta.url), 'utf8')
  const relay = source.slice(source.indexOf('Auto-relayed assistant text as reply'))
  const block = relay.slice(0, relay.indexOf('if (!relay.ok)'))

  assert.match(
    block, /command: `cumora reply \$\{target\.conversationId\} \$\{escaped\} --continue`/,
    'the declared relay no longer bypasses the anti-monologue gate — after the intent message the rules require, the agent\'s answer is refused and the room gets a failure notice instead',
  )
})

// ─── announce, then deliver, in the same turn ──────────────────────
//
// The operating rules require an intent message before long work, posted as a
// SEPARATE `cumora reply`, then the result "in this SAME turn". In a group of
// three or more that intent message is the room's last message and seconds
// old, which is exactly what the gate refuses — so the flow the product
// mandates was the flow it rejected, and the answer was lost.
//
// #263 fixed the runtime's own auto-relay by giving it --continue. It could
// not fix this one: `postedReplyViaTool` is set the moment the intent message
// lands and never reset within a turn, and the relay branch is guarded on
// `!postedReplyViaTool`, so once the agent announces, the relay is switched
// off for the rest of that turn. The second post is the model calling
// `cumora reply` itself, and it reached the gate with nothing to distinguish
// it from a monologue.
//
// The run id is that distinction, and it now reaches the CLI as CUMORA_RUN_ID.

async function withRunId<T>(runId: string | null, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CUMORA_RUN_ID
  if (runId === null) delete process.env.CUMORA_RUN_ID
  else process.env.CUMORA_RUN_ID = runId
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.CUMORA_RUN_ID
    else process.env.CUMORA_RUN_ID = previous
  }
}

test('[integration] the mandated announce-then-deliver flow goes through', async () => {
  const { agentA, convoId } = await seedGroupWithTwoAgents()
  const runId = `run-${randomUUID().slice(0, 8)}`

  await withRunId(runId, async () => {
    const intent = await runCli(['--as', agentA, 'reply', convoId, 'Drafting the email now — ~30s'])
    assert.equal(intent.ok, true, `the intent message the rules require must post: ${intent.text}`)

    // …30 seconds of work later, the result. Same turn, so same run.
    const answer = await runCli(['--as', agentA, 'reply', convoId, 'Here is the draft: subject, three paragraphs, CTA.'])
    assert.equal(answer.ok, true, `the answer the intent message promised must post: ${answer.text}`)
  })

  const { rows } = await pool.query<{ body: string }>(
    `SELECT body FROM messages WHERE conversation_id = $1 AND author_id = $2 ORDER BY sequence`,
    [convoId, agentA],
  )
  assert.equal(rows.length, 2, 'the room should have the intent message and the answer')
  assert.match(rows[1].body, /Here is the draft/)
})

test('[integration] a later run is still refused — that is the gate doing its job', async () => {
  // The whole point of the gate: "each wake-up is a fresh 'should I respond?'
  // decision with no global stop-signal". A different run is a different
  // decision, however recently the last message landed.
  const { agentA, convoId } = await seedGroupWithTwoAgents()

  await withRunId(`run-${randomUUID().slice(0, 8)}`, async () => {
    const first = await runCli(['--as', agentA, 'reply', convoId, 'first'])
    assert.equal(first.ok, true)
  })
  await withRunId(`run-${randomUUID().slice(0, 8)}`, async () => {
    const second = await runCli(['--as', agentA, 'reply', convoId, 'a fresh decision to talk again'])
    assert.equal(second.ok, false, 'a new wake-up must not inherit the previous turn\'s exemption')
    assert.match(second.text, /you already posted in/)
  })
})

test('[integration] a third post in one turn is monologuing again', async () => {
  // Announce + deliver is two. The exemption is capped there on purpose.
  const { agentA, convoId } = await seedGroupWithTwoAgents()
  const runId = `run-${randomUUID().slice(0, 8)}`

  await withRunId(runId, async () => {
    assert.equal((await runCli(['--as', agentA, 'reply', convoId, 'on it'])).ok, true)
    assert.equal((await runCli(['--as', agentA, 'reply', convoId, 'here it is'])).ok, true)
    const third = await runCli(['--as', agentA, 'reply', convoId, 'and one more thought'])
    assert.equal(third.ok, false, 'the exemption must not become an unlimited licence')
    assert.match(third.text, /you already posted in/)
  })
})

test('[integration] a continuation is still checked against a room that moved', async () => {
  // The guard rail that separates this from --continue. That flag also
  // disables the freshness preflight; this exemption must not, or an agent
  // could deliver a stale answer a peer already gave while it was working.
  const { agentA, agentB, convoId } = await seedGroupWithTwoAgents()
  const runId = `run-${randomUUID().slice(0, 8)}`

  await withRunId(runId, async () => {
    assert.equal((await runCli(['--as', agentA, 'reply', convoId, 'on it — ~30s'])).ok, true)
  })
  // A peer delivers the same thing while A works.
  assert.equal((await runCli(['--as', agentB, 'reply', convoId, 'The answer is 42.'])).ok, true)

  await withRunId(runId, async () => {
    const late = await runCli(['--as', agentA, 'reply', convoId, 'The answer is 42.'])
    assert.equal(late.ok, false, 'the freshness preflight must still apply to a same-turn delivery')
    assert.match(late.text, /HELD/)
  })
})

test('[integration] with no run id the gate behaves exactly as before', async () => {
  // The CLI, replay and boot paths carry no CUMORA_RUN_ID. They must not get
  // an exemption they cannot justify.
  const { agentA, convoId } = await seedGroupWithTwoAgents()
  await withRunId(null, async () => {
    assert.equal((await runCli(['--as', agentA, 'reply', convoId, 'first'])).ok, true)
    const second = await runCli(['--as', agentA, 'reply', convoId, 'second'])
    assert.equal(second.ok, false, 'no run id means no exemption')
    assert.match(second.text, /you already posted in/)
  })
})
