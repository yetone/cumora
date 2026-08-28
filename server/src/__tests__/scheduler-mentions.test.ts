/**
 * `mentionedAgentIds` — the deterministic "this message names you" signal.
 *
 * It reuses the exact-token rule `shouldDeliverToMutedAgent` already uses, so
 * "addressed to" means one thing everywhere. It is a PROMPT signal only: the
 * recipient set is unchanged, deliberately. Narrowing the fan-out to mentioned
 * agents is unsafe — a mentioned BYOA agent with a closed laptop has its wake
 * deferred while the peers who would have covered were never woken, and an
 * excluded peer who posts anything else auto-acks its read cursor to NOW
 * (`cumora reply`), putting the human's message permanently behind the cursor.
 *
 * Run: node --import tsx --test server/src/__tests__/scheduler-mentions.test.ts
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mentionedAgentIds, shouldDeliverToMutedAgent } from '../agents/scheduler.js'
import { pool } from '../db/pool.js'

after(async () => {
  // scheduler.ts transitively imports redis.ts which opens connections — without
  // this the runner never exits and CI cancels the job rather than failing it.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

const MEMBERS = ['nova-12', 'iris-9', 'atlas-7']

test('an exact mention selects that agent', () => {
  assert.deepEqual(mentionedAgentIds('please check this @nova-12', MEMBERS), ['nova-12'])
})

test('mentions are case-insensitive', () => {
  assert.deepEqual(mentionedAgentIds('ping @NOVA-12, please', MEMBERS), ['nova-12'])
})

test('several mentions all come back, in member order', () => {
  assert.deepEqual(mentionedAgentIds('@atlas-7 and @nova-12 pair on this', MEMBERS), ['nova-12', 'atlas-7'])
})

test('an unmentioned room yields nobody', () => {
  assert.deepEqual(mentionedAgentIds('ordinary room chatter', MEMBERS), [])
})

test('a longer id is not matched by a shorter one', () => {
  // The trap `shouldDeliverToMutedAgent` already guards: @nova-123 must not
  // read as a mention of nova-12.
  assert.deepEqual(mentionedAgentIds('this is for @nova-123', MEMBERS), [])
})

test('an email address is not a mention', () => {
  assert.deepEqual(mentionedAgentIds('mail nova@nova-12 about it', MEMBERS), [])
})

test('@all is not an individual mention', () => {
  // @all is a broadcast, handled separately in the prompt; it must not read as
  // naming any particular agent.
  assert.deepEqual(mentionedAgentIds('@all standup in 5', MEMBERS), [])
})

test('an empty body mentions nobody', () => {
  assert.deepEqual(mentionedAgentIds('', MEMBERS), [])
})

test('it agrees with the muted-delivery rule on the same inputs', () => {
  // One definition of "addressed to me" across delivery and prompting — if
  // these ever disagree, an agent could be told a message is theirs by one rule
  // and denied it by the other.
  for (const body of [
    'please check this @nova-12',
    'ping @NOVA-12, please',
    'this is for @nova-123',
    'mail nova@nova-12 about it',
    'ordinary room chatter',
  ]) {
    assert.equal(
      mentionedAgentIds(body, ['nova-12']).length > 0,
      shouldDeliverToMutedAgent({ agentId: 'nova-12', conversationKind: 'group', body, quotedAuthorId: null }),
      `disagreement on: ${body}`,
    )
  }
})
