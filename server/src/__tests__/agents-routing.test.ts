/**
 * Message-level routing (#70).
 *
 * Narrowing a wake is the one mistake that is SILENT: an agent that should have
 * answered and was never woken leaves no reply, no typing indicator, and no
 * agent_runs row. So these tests spend most of their weight on the paths that
 * must NOT narrow, not on the happy one.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-routing.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRouteRequest, parseRoute, recipientsForRoute } from '../agents/routing.js'

const ROOM = ['nova-12', 'iris-9', 'atlas-7']

// ── when the model is not even asked ─────────────────────────────────────────

test('@all is never narrowed', () => {
  const r = buildRouteRequest({ body: '@all standup in 5 @nova-12', conversationKind: 'group', candidates: ROOM, targets: ['nova-12'] })
  assert.equal(r.mode, 'each')
  assert.equal(r.instructions, undefined, 'a broadcast must not cost a model call')
})

test('a message that names nobody is never narrowed', () => {
  // The important one: narrowing with no targets would wake no one at all.
  const r = buildRouteRequest({ body: 'can someone take the Q3 deck?', conversationKind: 'group', candidates: ROOM, targets: [] })
  assert.equal(r.mode, 'each')
  assert.equal(r.instructions, undefined)
})

test('a DM is never narrowed', () => {
  const r = buildRouteRequest({ body: 'hey @nova-12', conversationKind: 'direct', candidates: ['nova-12'], targets: ['nova-12'] })
  assert.equal(r.mode, 'each')
})

test('naming the whole room costs no model call', () => {
  const r = buildRouteRequest({ body: '@nova-12 @iris-9 @atlas-7 thoughts?', conversationKind: 'group', candidates: ROOM, targets: ROOM })
  assert.equal(r.mode, 'each')
  assert.equal(r.instructions, undefined, 'there is nothing to save')
})

test('a named subset is the only case that asks the model', () => {
  const r = buildRouteRequest({ body: '@nova-12 draft the launch email', conversationKind: 'group', candidates: ROOM, targets: ['nova-12'] })
  assert.equal(r.mode, undefined)
  assert.match(r.instructions ?? '', /responseMode/)
  assert.match(r.input ?? '', /nova-12/)
  assert.match(r.input ?? '', /iris-9, atlas-7/, 'the model should see who else would be woken')
})

// ── parsing: anything unexpected means "change nothing" ───────────────────────

test('an explicit me is honoured', () => {
  assert.equal(parseRoute('{"responseMode": "me"}'), 'me')
})

test('each, unknown modes, junk and empty all read as each', () => {
  for (const raw of [
    '{"responseMode": "each"}',
    '{"responseMode": "nonsense"}',
    'the model wrote prose instead',
    '',
  ]) {
    assert.equal(parseRoute(raw), 'each', `should not narrow on: ${JSON.stringify(raw)}`)
  }
})

test('one-of-us parses as itself but never narrows the ADDRESSED route', () => {
  // Step two is wired now (#70): parseRoute recognizes it. The addressed
  // router is still instructed to answer me|each only, and even if a rogue
  // model answers one-of-us, recipientsForRoute treats it like each — full
  // fan-out. The unaddressed election parses through parseUnaddressedRoute.
  assert.equal(parseRoute('{"responseMode": "one-of-us"}'), 'one-of-us')
  assert.deepEqual(recipientsForRoute('one-of-us', ['a', 'b'], ['a']), ['a', 'b'])
})

test('me is found inside a fenced or chatty completion', () => {
  assert.equal(parseRoute('```json\n{"responseMode": "me", "why": "direct request"}\n```'), 'me')
})

// ── the narrowing rule itself ────────────────────────────────────────────────

test('me narrows to the named agents', () => {
  assert.deepEqual(recipientsForRoute('me', ROOM, ['nova-12']), ['nova-12'])
})

test('each leaves the room untouched', () => {
  assert.deepEqual(recipientsForRoute('each', ROOM, ['nova-12']), ROOM)
})

test('a target who is not a candidate never shrinks the room to nothing', () => {
  // Named someone who is muted out, departed, or is the author themselves.
  assert.deepEqual(recipientsForRoute('me', ROOM, ['someone-else']), ROOM)
})

test('only the candidate targets survive when some are not in the room', () => {
  assert.deepEqual(recipientsForRoute('me', ROOM, ['nova-12', 'ghost-1']), ['nova-12'])
})

test('one-of-us does not narrow yet', () => {
  // Step two in the issue; wiring it needs a lease, so it must be inert here.
  assert.deepEqual(recipientsForRoute('one-of-us', ROOM, ['nova-12']), ROOM)
})
