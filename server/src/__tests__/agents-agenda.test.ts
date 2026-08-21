/**
 * Unit tests for the pure-logic pieces of agents/agenda.ts. The DB
 * loaders and the LLM classifier are tested via integration; here we
 * cover the done-column regex and the two render helpers, which are
 * the only places a mistake silently degrades the heartbeat path.
 */
import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  renderAgendaBrief,
  classifyAgendaActionable,
  parseAgendaVerdict,
  AGENDA_CLASSIFIER_ERROR,
  __test,
  type AgentAgenda,
} from '../agents/agenda.js'
import { __setLlmClientOverrideForTesting } from '../llm.js'
import { pool } from '../db/pool.js'

const { DONE_COLUMN_PATTERNS, renderAgendaForClassifier } = __test

afterEach(() => {
  __setLlmClientOverrideForTesting(null)
})

after(async () => {
  // agenda.ts imports both the DB pool and Redis. Close those module-level
  // clients so this file's isolated node:test child can exit and the runner
  // can advance to the rest of the suite.
  try { await pool.end() } catch { /* ignore */ }
  try {
    const { redis, sub } = await import('../redis.js')
    redis.disconnect()
    sub.disconnect()
  } catch { /* ignore */ }
})

/** Build a minimal stubbed OpenAI client that returns the supplied
 *  output_text on responses.create. Keeps the JSON-robustness tests
 *  hermetic — no real network, no env.OPENAI_API_KEY needed. */
function stubLlm(outputText: string): void {
  __setLlmClientOverrideForTesting((async () => {
    return {
      responses: {
        create: async () => ({ output_text: outputText }),
      },
    }
  }) as unknown as Parameters<typeof __setLlmClientOverrideForTesting>[0])
}

/** Same as stubLlm but the create() function throws — simulates an
 *  upstream LLM outage (network error, 5xx, etc.). */
function stubLlmThrow(): void {
  __setLlmClientOverrideForTesting((async () => {
    return {
      responses: {
        create: async () => { throw new Error('simulated upstream failure') },
      },
    }
  }) as unknown as Parameters<typeof __setLlmClientOverrideForTesting>[0])
}

const SINGLE_CARD_AGENDA: AgentAgenda = {
  cards: [
    {
      id: 'c-1',
      board_id: 'b1',
      board_title: 'Ops',
      column_id: 'col1',
      column_title: 'To Do',
      title: 'Ship migration',
      description: null,
      assignee_id: 'agent-1',
      mentions: [],
      updated_at: '2026-05-20T10:00:00Z',
    },
  ],
  events: [],
  stalls: [],
}

const STUB_PERSONA = {
  name: 'Atlas',
  role: 'Operator',
  style: 'You move ops work forward.',
  model: null,
}

test('DONE_COLUMN_PATTERNS catches finished-work column titles', () => {
  for (const title of [
    'Done',
    'DONE',
    'done',
    'Done ✅',
    'Completed',
    'Shipped',
    'Archive',
    'Archived',
    'Closed',
    'Cancelled',
    'Canceled',
  ]) {
    assert.ok(
      DONE_COLUMN_PATTERNS.test(title),
      `expected "${title}" to be treated as a done-style column`,
    )
  }
})

test('DONE_COLUMN_PATTERNS leaves active column titles alone', () => {
  for (const title of [
    'To Do',
    'Todo',
    'Doing',
    'In Progress',
    'In Review',
    'Backlog',
    'Up Next',
    'Blocked',
  ]) {
    assert.equal(
      DONE_COLUMN_PATTERNS.test(title),
      false,
      `expected "${title}" NOT to be flagged as done`,
    )
  }
})

test('renderAgendaForClassifier returns "(empty)" for an empty agenda', () => {
  const empty: AgentAgenda = { cards: [], events: [], stalls: [] }
  assert.equal(renderAgendaForClassifier(empty), '(empty)')
})

test('renderAgendaForClassifier includes assigned/mentioned tags + ids', () => {
  const agenda: AgentAgenda = {
    cards: [
      {
        id: 'c-assigned',
        board_id: 'b1',
        board_title: 'Ops',
        column_id: 'col1',
        column_title: 'To Do',
        title: 'Ship the migration',
        description: null,
        assignee_id: 'agent-1',
        mentions: [],
        updated_at: '2026-05-20T10:00:00Z',
      },
      {
        id: 'c-mentioned',
        board_id: 'b1',
        board_title: 'Ops',
        column_id: 'col1',
        column_title: 'To Do',
        title: 'Review handoff doc',
        description: null,
        assignee_id: null,
        mentions: ['agent-1'],
        updated_at: '2026-05-20T11:00:00Z',
      },
    ],
    events: [
      {
        id: 'evt-1',
        title: 'Weekly cross-team sync',
        description: null,
        start_at: '2026-05-20T15:00:00Z',
        agent_prompt: 'Bring the migration status update',
        target_conversation_id: 'conv-1',
      },
    ],
    stalls: [],
  }
  const out = renderAgendaForClassifier(agenda)
  // Cards include both the assigned/mentioned tag and the card id so the
  // classifier can disambiguate when several titles are similar.
  assert.match(out, /\[assigned\]/)
  assert.match(out, /\[mentioned\]/)
  assert.match(out, /c-assigned/)
  assert.match(out, /c-mentioned/)
  // Events deliberately omit the event id from the classifier view (the
  // verdict is go/no-go + a focus string, not an event reference), but
  // the title + agent_prompt must surface so the classifier can decide.
  assert.match(out, /Weekly cross-team sync/)
  assert.match(out, /Bring the migration status update/)
})

test('renderAgendaForClassifier keeps a stable prefix while preserving silence minutes', () => {
  const stall = {
    conversationId: 'direct-1',
    kind: 'direct',
    title: 'Lumi ↔ boss',
    lastMessageId: 'm-1',
    lastAuthorId: 'storyicon',
    lastAuthorName: 'storyicon',
    lastAuthorIsSelf: false,
    lastBody: 'need a build',
    minutesSilent: 47,
    recentTail: 'storyicon: need a build\nLumi@Secretary: looking',
  }
  const base: AgentAgenda = {
    cards: [{
      id: 'c-1', board_id: 'b1', board_title: 'Ops', column_id: 'col1',
      column_title: 'Doing', title: 'Ship', description: null,
      assignee_id: 'agent-1', mentions: [], updated_at: '2026-05-20T10:00:00Z',
    }],
    events: [{
      id: 'evt-1', title: 'Standup', description: null,
      start_at: '2026-05-20T15:00:00Z', agent_prompt: null,
      target_conversation_id: null,
    }],
    stalls: [stall],
  }
  const a = renderAgendaForClassifier(base)
  const b = renderAgendaForClassifier({
    ...base,
    stalls: [{ ...stall, minutesSilent: 48 }],
  })
  const timingMarker = '\n\nCurrent stall timing:\n'
  assert.equal(a.slice(0, a.indexOf(timingMarker)), b.slice(0, b.indexOf(timingMarker)))
  assert.match(a, /direct-1: 47m silent/)
  assert.match(b, /direct-1: 48m silent/)
  assert.match(a, /need a build/)
  assert.ok(a.indexOf('need a build') < a.indexOf('Standup'), 'stall messages precede calendar')
  assert.ok(a.indexOf('Standup') < a.indexOf('47m silent'), 'dynamic timing follows stable agenda data')
})

test('renderAgendaForClassifier sorts cards and stalls by id, not recency', () => {
  const stall = (id: string) => ({
    conversationId: id,
    kind: 'direct',
    title: id,
    lastMessageId: 'm',
    lastAuthorId: 'x',
    lastAuthorName: 'x',
    lastAuthorIsSelf: false,
    lastBody: 'hi',
    minutesSilent: 10,
    recentTail: 'x: hi',
  })
  const card = (id: string) => ({
    id, board_id: 'b1', board_title: 'Ops', column_id: 'col1',
    column_title: 'Doing', title: id, description: null,
    assignee_id: 'agent-1', mentions: [], updated_at: '2026-05-20T10:00:00Z',
  })
  const out = renderAgendaForClassifier({
    cards: [card('c-z'), card('c-a')],
    events: [],
    stalls: [stall('direct-z'), stall('direct-a')],
  })
  assert.ok(out.indexOf('c-a') < out.indexOf('c-z'), 'cards sorted by id')
  assert.ok(out.indexOf('direct-a') < out.indexOf('direct-z'), 'stalls sorted by conversationId')
})

test('renderAgendaBrief opens with the action override + includes ids', () => {
  const agenda: AgentAgenda = {
    cards: [
      {
        id: 'c-1',
        board_id: 'b1',
        board_title: 'Ops',
        column_id: 'col1',
        column_title: 'To Do',
        title: 'Ship migration',
        description: 'Pre-flight the prod cutover for Tuesday',
        assignee_id: 'agent-1',
        mentions: [],
        updated_at: '2026-05-20T10:00:00Z',
      },
    ],
    events: [],
    stalls: [],
  }
  const body = renderAgendaBrief(agenda, 'Ship migration before EOD')
  // The first line must explicitly override the brain's "default to doing
  // nothing" stance — otherwise the cerebellum's positive triage gets
  // second-guessed by the generic background_scan framing.
  assert.match(body, /agenda/i)
  assert.match(body, /pick the most timely item/i)
  assert.match(body, /Ship migration before EOD/)
  assert.match(body, /c-1/)
  assert.match(body, /\[Ops \/ To Do\]/)
})

test('renderAgendaBrief works with only calendar events', () => {
  const agenda: AgentAgenda = {
    cards: [],
    events: [
      {
        id: 'evt-1',
        title: 'Weekly sync',
        description: null,
        start_at: '2026-05-20T15:00:00Z',
        agent_prompt: 'Lead the status update',
        target_conversation_id: null,
      },
    ],
    stalls: [],
  }
  const body = renderAgendaBrief(agenda, '')
  assert.match(body, /Calendar events in your current slot/)
  assert.match(body, /evt-1/)
  assert.match(body, /Lead the status update/)
  // No Kanban-cards SECTION header should be rendered when there are no
  // cards (the opening action-override line does mention "Kanban cards"
  // in prose — that's expected, so check for the section header text).
  assert.equal(/Your active Kanban cards/.test(body), false)
})

// ────────────────────────────────────────────────────────────────────────────
// Agenda verdict parsing — fail closed while recovering provider formatting
// drift that still carries an explicit decision.
// ────────────────────────────────────────────────────────────────────────────

test('parseAgendaVerdict accepts fenced strict JSON', () => {
  const parsed = parseAgendaVerdict('```json\n{"actionable":false,"focus":"","reason":"done"}\n```')
  assert.deepEqual(parsed, { actionable: false, focus: '', reason: 'done' })
})

test('parseAgendaVerdict salvages unquoted keys and single-quoted strings', () => {
  const parsed = parseAgendaVerdict("{ actionable: false, focus: '', reason: 'already concluded' }")
  assert.deepEqual(parsed, { actionable: false, focus: '', reason: 'already concluded' })
})

test('parseAgendaVerdict salvages a truncated explicit negative', () => {
  const parsed = parseAgendaVerdict('{"actionable":false,"focus":"","reason":"already done"')
  assert.deepEqual(parsed, { actionable: false, focus: '', reason: 'already done' })
})

test('parseAgendaVerdict never salvages an unfocused malformed positive as actionable', () => {
  const parsed = parseAgendaVerdict('{ actionable: true, reason: "maybe" }')
  assert.deepEqual(parsed, {
    actionable: false, focus: '', reason: 'malformed positive verdict without focus',
  })
})

// ────────────────────────────────────────────────────────────────────────────
// classifyAgendaActionable JSON-robustness — the production classifier is a
// boundary between us and a non-deterministic LLM. Every branch in the
// parse path needs explicit coverage so a single malformed reply can't
// silently fail-open into "actionable: true" or fail-closed into a brain-
// silencing loop.
// ────────────────────────────────────────────────────────────────────────────

test('classifyAgendaActionable: empty agenda short-circuits before the LLM call', async () => {
  let called = false
  __setLlmClientOverrideForTesting((async () => {
    return { responses: { create: async () => { called = true; return { output_text: '{}' } } } }
  }) as unknown as Parameters<typeof __setLlmClientOverrideForTesting>[0])

  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA,
    companyId: 'c1',
    agenda: { cards: [], events: [], stalls: [] },
  })
  assert.equal(v.actionable, false)
  assert.equal(v.reason, 'empty agenda')
  assert.equal(called, false, 'must not call the LLM when there is nothing to triage')
})

test('classifyAgendaActionable leaves output headroom beyond reasoning tokens', async () => {
  let maxOutputTokens = 0
  __setLlmClientOverrideForTesting((async () => ({
    responses: {
      create: async (request: { max_output_tokens?: number }) => {
        maxOutputTokens = request.max_output_tokens ?? 0
        return { output_text: JSON.stringify({ actionable: false, focus: '', reason: 'done' }) }
      },
    },
  })) as unknown as Parameters<typeof __setLlmClientOverrideForTesting>[0])
  await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.ok(maxOutputTokens >= 2_000, 'live support-model reasoning exceeded 800 tokens before emitting JSON')
})

test('classifyAgendaActionable: happy path with strict boolean true', async () => {
  stubLlm(JSON.stringify({ actionable: true, focus: 'Ship it', reason: 'one card' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, true)
  assert.equal(v.focus, 'Ship it')
})

test('classifyAgendaActionable: "true" string is accepted as actionable', async () => {
  // Some models stringify booleans even when asked for strict JSON. We
  // accept "true" so the agent doesn't silently no-op on a recoverable
  // formatting wobble.
  stubLlm(JSON.stringify({ actionable: 'true', focus: 'go', reason: 'r' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, true)
})

test('classifyAgendaActionable: actionable="no" must NOT wake the brain (regression)', async () => {
  // Boolean("no") === true in JS, so the old `Boolean(parsed.actionable)`
  // coercion would wake the brain on a literal "no" reply. Pin this so a
  // future refactor doesn't reintroduce the bug.
  stubLlm(JSON.stringify({ actionable: 'no', focus: '', reason: 'nothing actionable' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, false, '"no" string must coerce to false, not true')
})

test('classifyAgendaActionable: actionable="false" must NOT wake the brain', async () => {
  stubLlm(JSON.stringify({ actionable: 'false', focus: '', reason: 'no' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, false)
})

test('classifyAgendaActionable: missing actionable field defaults to false', async () => {
  stubLlm(JSON.stringify({ focus: 'whatever', reason: 'r' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, false)
})

test('classifyAgendaActionable: numeric 1 accepted as actionable', async () => {
  stubLlm(JSON.stringify({ actionable: 1, focus: 'go', reason: 'r' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, true)
})

test('classifyAgendaActionable: malformed JSON → classifier_error sentinel', async () => {
  stubLlm('not even close to JSON ::: }}}{{')
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, false)
  assert.equal(v.reason, AGENDA_CLASSIFIER_ERROR,
    'malformed JSON must surface as the error sentinel so callers can fall back to a generic wake')
})

test('classifyAgendaActionable: upstream throw → classifier_error sentinel', async () => {
  stubLlmThrow()
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, false)
  assert.equal(v.reason, AGENDA_CLASSIFIER_ERROR)
})

test('classifyAgendaActionable: focus longer than 240 chars is sliced', async () => {
  const huge = 'a'.repeat(1000)
  stubLlm(JSON.stringify({ actionable: true, focus: huge, reason: 'r' }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, true)
  assert.equal(v.focus.length, 240, 'focus must be clamped to 240 chars to bound the brief title')
})

test('classifyAgendaActionable: non-string focus is coerced to string', async () => {
  stubLlm(JSON.stringify({ actionable: true, focus: 42, reason: ['a', 'b'] }))
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, true)
  assert.equal(v.focus, '42')
  // Array stringifies to "a,b"; we accept that as "do not crash" rather
  // than pinning the exact rendering — the contract is just "string".
  assert.equal(typeof v.reason, 'string')
})

test('classifyAgendaActionable: empty output_text → classifier_error (model gave up)', async () => {
  // Empty string is NOT nullish, so the `?? '{}'` fallback doesn't fire
  // and `JSON.parse('')` throws. We treat this as a classifier outage
  // (the model returned nothing) — fall back to a generic wake on the
  // idle side rather than silently no-opping.
  stubLlm('')
  const v = await classifyAgendaActionable({
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA,
  })
  assert.equal(v.actionable, false)
  assert.equal(v.reason, AGENDA_CLASSIFIER_ERROR)
})

test('classifyAgendaActionable: identical content is re-evaluated on every heartbeat', async () => {
  let calls = 0
  __setLlmClientOverrideForTesting((async () => ({
    responses: {
      create: async () => {
        calls += 1
        return { output_text: JSON.stringify({ actionable: true, focus: `ship-${calls}`, reason: 'card' }) }
      },
    },
  })) as unknown as Parameters<typeof __setLlmClientOverrideForTesting>[0])
  const args = {
    persona: STUB_PERSONA, companyId: 'c1', agenda: SINGLE_CARD_AGENDA, agentId: 'agent-1',
  }
  const v1 = await classifyAgendaActionable(args)
  const v2 = await classifyAgendaActionable(args)
  assert.equal(v1.actionable, true)
  assert.equal(v1.focus, 'ship-1')
  assert.equal(v2.focus, 'ship-2')
  assert.equal(calls, 2, 'time-sensitive agenda decisions must not reuse an old verdict')
})
