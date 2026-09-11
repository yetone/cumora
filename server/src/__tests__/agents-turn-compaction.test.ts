/**
 * Unit tests for `compactHistory`. Same shape as
 * `agents-turn-stream.test.ts` — pure-function exercises, no DB / no
 * LLM / no live stream.
 *
 * Coverage focuses on the invariants that, if broken, would either:
 *   (a) make upstream reject the next hop with "No tool call found for
 *       function call output with call_id X" — i.e. a function_call ↔
 *       function_call_output pair gets split during compaction
 *   (b) lose the original user/inbox messages — i.e. the question the
 *       agent is supposed to be answering disappears
 *   (c) over-compact and drop the most-recent context the model needs
 *       to keep working
 *
 * Run: node --import tsx --test server/src/__tests__/agents-turn-compaction.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import {
  COMPACTED_OUTPUT_BYTES,
  KEEP_RECENT_PAIRS,
  compactHistory,
  compactHistoryWithSummary,
  estimateHistoryTokens,
  estimateTokens,
} from '../agents/turn-compaction.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

const userMsg = (text: string): ResponseInputItem => ({
  type: 'message',
  role: 'user',
  content: text,
}) as unknown as ResponseInputItem

const fnCall = (callId: string, name = 'bash', args = '{}'): ResponseInputItem => ({
  type: 'function_call',
  call_id: callId,
  name,
  arguments: args,
}) as unknown as ResponseInputItem

const fnOutput = (callId: string, output: string): ResponseInputItem => ({
  type: 'function_call_output',
  call_id: callId,
  output,
}) as unknown as ResponseInputItem

const itemRef = (callId: string): ResponseInputItem => ({
  type: 'item_reference',
  id: callId,
}) as unknown as ResponseInputItem

/** "Never let it stop" stillOverThreshold — forces the algorithm to
 *  shed everything it's willing to shed. Useful for "did stage 2 drop
 *  the right items" tests where we don't care about the exact byte
 *  threshold. */
const ALWAYS_OVER = () => true

/** "Stage 1 is plenty" — used to assert that the truncate stage alone
 *  was enough to satisfy the caller and stage 2 never runs. */
const NEVER_OVER = () => false

// ── Stage 1: in-place truncation ────────────────────────────────────────────

test('truncate-only: a single oversized function_call_output is shortened, structure preserved', () => {
  const huge = 'X'.repeat(COMPACTED_OUTPUT_BYTES * 10)
  const history: ResponseInputItem[] = [
    userMsg('list boards'),
    fnCall('call_1', 'bash', '{"command":"cumora kanban ls"}'),
    fnOutput('call_1', huge),
  ]
  const result = compactHistory(history, NEVER_OVER)
  assert.equal(result.truncatedOutputCount, 1)
  assert.ok(result.truncatedOutputBytes > 0)
  assert.equal(result.droppedPairCount, 0, 'stage 2 must not run when NEVER_OVER')
  assert.equal(result.newHistory.length, 3, 'no items dropped')
  const out = (result.newHistory[2] as unknown as { output: string }).output
  assert.ok(out.length < huge.length, 'output shrunk')
  assert.match(out, /\[truncated by auto-compaction: original \d+ bytes\]/)
})

test('truncate-only: outputs at or below COMPACTED_OUTPUT_BYTES are left alone', () => {
  const exactly = 'A'.repeat(COMPACTED_OUTPUT_BYTES)
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'),
    fnOutput('call_1', exactly),
  ]
  const result = compactHistory(history, NEVER_OVER)
  assert.equal(result.truncatedOutputCount, 0, 'no truncation at the boundary')
  assert.equal((result.newHistory[2] as unknown as { output: string }).output, exactly)
})

test('truncate-only: function_call args are NOT truncated by stage 1', () => {
  // Only function_call_output payloads get the stage-1 treatment.
  // function_call.arguments stays intact (they're usually small JSON
  // that the next hop needs to parse).
  const bigArgs = JSON.stringify({ command: 'X'.repeat(COMPACTED_OUTPUT_BYTES * 5) })
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1', 'bash', bigArgs),
    fnOutput('call_1', 'ok'),
  ]
  const result = compactHistory(history, NEVER_OVER)
  assert.equal(result.truncatedOutputCount, 0)
  assert.equal((result.newHistory[1] as unknown as { arguments: string }).arguments, bigArgs)
})

test('truncate-only: input mutation safety — original history items are not modified', () => {
  const huge = 'Z'.repeat(COMPACTED_OUTPUT_BYTES * 3)
  const original: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'),
    fnOutput('call_1', huge),
  ]
  const originalOutput = (original[2] as unknown as { output: string }).output
  compactHistory(original, NEVER_OVER)
  assert.equal((original[2] as unknown as { output: string }).output, originalOutput,
    'caller-supplied history must not be mutated')
})

// ── Stage 2: pair-aware drop ────────────────────────────────────────────────

test('stage 2: oldest function_call ↔ function_call_output pair gets dropped as a unit', () => {
  const history: ResponseInputItem[] = [
    userMsg('original question'),
    fnCall('call_1'), fnOutput('call_1', 'first answer'),
    fnCall('call_2'), fnOutput('call_2', 'second answer'),
    fnCall('call_3'), fnOutput('call_3', 'third answer'),
    fnCall('call_4'), fnOutput('call_4', 'fourth answer'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  assert.ok(result.droppedPairCount >= 1, 'at least one pair dropped')
  // Verify NO orphan function_call_output (would 400 upstream).
  const callIdsRemaining = new Set<string>()
  const outputCallIdsRemaining = new Set<string>()
  for (const item of result.newHistory) {
    const r = item as unknown as { type?: string; call_id?: string }
    if (r.type === 'function_call' && r.call_id) callIdsRemaining.add(r.call_id)
    if (r.type === 'function_call_output' && r.call_id) outputCallIdsRemaining.add(r.call_id)
  }
  for (const cid of outputCallIdsRemaining) {
    assert.ok(callIdsRemaining.has(cid), `orphan function_call_output for ${cid}`)
  }
})

test('stage 2: the most recent KEEP_RECENT_PAIRS pairs are NEVER dropped', () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
    fnCall('call_5'), fnOutput('call_5', 'e'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  // call_4 + call_5 are the recent KEEP_RECENT_PAIRS=2; both must
  // survive even though we asked the algorithm to drop everything it
  // could.
  const surviving = new Set<string>()
  for (const item of result.newHistory) {
    const r = item as unknown as { call_id?: string }
    if (r.call_id) surviving.add(r.call_id)
  }
  assert.ok(surviving.has('call_4'), 'second-most-recent pair preserved')
  assert.ok(surviving.has('call_5'), 'most-recent pair preserved')
  // KEEP_RECENT_PAIRS is exported so the test still pins the value if
  // it's ever bumped.
  assert.equal(KEEP_RECENT_PAIRS, 2, 'KEEP_RECENT_PAIRS expected to be 2')
})

test('stage 2: leading non-tool messages (original user input) are NEVER dropped', () => {
  const history: ResponseInputItem[] = [
    userMsg('the original question'),
    userMsg('a second piece of inbox context'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  const first = result.newHistory[0] as unknown as { type: string; content: string }
  const second = result.newHistory[1] as unknown as { type: string; content: string }
  assert.equal(first.type, 'message')
  assert.equal(first.content, 'the original question')
  assert.equal(second.type, 'message')
  assert.equal(second.content, 'a second piece of inbox context')
})

test('stage 2: a synthetic [auto-compaction] marker is inserted to replace dropped items', () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  assert.ok(result.droppedPairCount >= 1)
  // The marker is a 'message' role:'user' item with the compaction
  // tag. It lands right after the leading non-tool items.
  const marker = result.newHistory[1] as unknown as { type: string; content: string }
  assert.equal(marker.type, 'message')
  assert.match(marker.content, /\[auto-compaction\]/)
  assert.match(marker.content, /dropped from history/)
})

test('stage 2: stops dropping as soon as `stillOverThreshold` reports under budget', () => {
  // Drop one pair, then "we're fine". The algorithm should bail without
  // touching the second-oldest pair.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'aaaaaaaaaaaaaaaaaa'),
    fnCall('call_2'), fnOutput('call_2', 'bbbbbbbbbbbbbbbbbb'),
    fnCall('call_3'), fnOutput('call_3', 'cccccccccccccccccc'),
    fnCall('call_4'), fnOutput('call_4', 'dddddddddddddddddd'),
    fnCall('call_5'), fnOutput('call_5', 'eeeeeeeeeeeeeeeeee'),
  ]
  let calls = 0
  const result = compactHistory(history, () => {
    calls += 1
    // First check (after stage 1) returns true — force stage 2 to
    // start. Subsequent checks (after each drop) return false — stop
    // immediately.
    return calls <= 1
  })
  assert.equal(result.droppedPairCount, 1, 'exactly one pair dropped (then under budget)')
})

test('stage 2: item_reference items are dropped together with their matched call_id pair', () => {
  // Legacy histories may contain one item_reference per tool call from
  // the old sub2api compatibility path. They shared the call_id
  // (item_reference.id == function_call.call_id). Compaction must still
  // drop all three together, never leave an orphaned reference.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), itemRef('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), itemRef('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), itemRef('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), itemRef('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  assert.ok(result.droppedPairCount >= 1)
  // Verify no orphaned item_reference whose id has no matching function_call.
  const fcCallIds = new Set<string>()
  const refIds = new Set<string>()
  for (const item of result.newHistory) {
    const r = item as unknown as { type?: string; call_id?: string; id?: string }
    if (r.type === 'function_call' && r.call_id) fcCallIds.add(r.call_id)
    if (r.type === 'item_reference' && r.id) refIds.add(r.id)
  }
  for (const id of refIds) {
    assert.ok(fcCallIds.has(id), `orphan item_reference for ${id}`)
  }
})

// ── No-op cases ─────────────────────────────────────────────────────────────

test('no-op: history with no oversized outputs and under budget returns unchanged shape', () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'small ok'),
  ]
  const result = compactHistory(history, NEVER_OVER)
  assert.equal(result.truncatedOutputCount, 0)
  assert.equal(result.droppedPairCount, 0)
  assert.equal(result.newHistory.length, 3)
})

test('no-op: empty history is handled without crashing', () => {
  const result = compactHistory([], ALWAYS_OVER)
  assert.deepEqual(result.newHistory, [])
  assert.equal(result.droppedPairCount, 0)
  assert.equal(result.truncatedOutputCount, 0)
})

test('no-op: fewer than KEEP_RECENT_PAIRS pairs total — nothing gets dropped', () => {
  // Only one pair, even though stillOverThreshold says we're way over.
  // The "always keep most recent N" guarantee means there's nothing
  // eligible to drop.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  assert.equal(result.droppedPairCount, 0)
  assert.equal(result.newHistory.length, 3, 'nothing dropped — single pair is "recent"')
})

// ── Edge cases ──────────────────────────────────────────────────────────────

test('edge: function_call without a call_id is treated as un-pair-able and stays where it is', () => {
  // Real production paths always emit call_id, but a malformed event
  // (or a future SDK change) could omit it. Compaction must not crash
  // and must not group these items with each other under a falsy key.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    { type: 'function_call', name: 'bash', arguments: '{}' } as unknown as ResponseInputItem,
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
  ]
  // Should not throw and should not group the unkeyed function_call
  // with the next valid pair.
  const result = compactHistory(history, ALWAYS_OVER)
  // KEEP_RECENT_PAIRS preserves the two valid pairs; the unkeyed item
  // is not in callIdsInOrder so it's neither dropped nor counted.
  assert.ok(result.newHistory.length >= 3, 'recent pairs preserved')
})

test('edge: returned newHistory is a fresh array — mutating it does not touch caller input', () => {
  const huge = 'Y'.repeat(COMPACTED_OUTPUT_BYTES * 4)
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', huge),
  ]
  const result = compactHistory(history, NEVER_OVER)
  // Mutate the result.
  ;(result.newHistory[2] as unknown as { output: string }).output = 'TAMPERED'
  // Caller's history unchanged.
  assert.equal((history[2] as unknown as { output: string }).output, huge)
})

test('edge: compaction-marker text scales with the number of pairs dropped', () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
    fnCall('call_5'), fnOutput('call_5', 'e'),
    fnCall('call_6'), fnOutput('call_6', 'f'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  // With KEEP_RECENT_PAIRS=2 and 6 total pairs, we drop up to 4. The
  // marker reports the actual count.
  assert.equal(result.droppedPairCount, 4)
  const marker = result.newHistory[1] as unknown as { content: string }
  assert.match(marker.content, /4 earlier tool call\/output pairs were dropped/)
})

test('edge: usedLlmSummary is false on the sync fallback path', () => {
  // The sync `compactHistory` never invokes an LLM; the result flag
  // must reflect that. compactHistoryWithSummary sets it to true on
  // its happy path (see tests below).
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  assert.equal(result.usedLlmSummary, false)
})

// ── compactHistoryWithSummary — LLM-summarized stage 2 ──────────────────

test('summary: stage 1 alone suffices → summarizer is NEVER invoked', async () => {
  // If output-truncation gets us under the threshold, we must NOT
  // spend a round-trip on the LLM. The summarize callback should not
  // be called at all.
  const huge = 'X'.repeat(COMPACTED_OUTPUT_BYTES * 20)
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', huge),
  ]
  let summarizeCalls = 0
  const result = await compactHistoryWithSummary(
    history,
    (b) => b > 5_000,    // small enough that stage 1 alone clears it
    async () => { summarizeCalls += 1; return 'NEVER' },
  )
  assert.equal(summarizeCalls, 0, 'summarize() must not be called when stage 1 is enough')
  assert.equal(result.usedLlmSummary, false)
  assert.ok(result.truncatedOutputCount >= 1)
})

test('summary: stage 1 not enough → summarize() invoked with the items to be dropped', async () => {
  const history: ResponseInputItem[] = [
    userMsg('original question'),
    fnCall('call_1', 'bash', '{"command":"step-1"}'), fnOutput('call_1', 'result-1'),
    fnCall('call_2', 'bash', '{"command":"step-2"}'), fnOutput('call_2', 'result-2'),
    fnCall('call_3', 'bash', '{"command":"step-3"}'), fnOutput('call_3', 'result-3'),
    fnCall('call_4', 'bash', '{"command":"step-4"}'), fnOutput('call_4', 'result-4'),
  ]
  let receivedItems: ResponseInputItem[] = []
  const result = await compactHistoryWithSummary(
    history,
    () => true,    // force stage 2
    async (items) => {
      receivedItems = items
      return 'AGENT_SUMMARY: ran 2 bash commands; key outputs were result-1 and result-2.'
    },
  )
  assert.equal(result.usedLlmSummary, true)
  // KEEP_RECENT_PAIRS = 2, so we keep call_3 + call_4. The dropped
  // set is call_1 + call_2 — TWO pairs == FOUR items (call + output
  // for each).
  assert.equal(result.droppedPairCount, 2)
  assert.equal(receivedItems.length, 4, 'summarize() received both fnCall and fnOutput for both dropped pairs')
  // The summary text is spliced into the new history right after the
  // leading user message.
  const summaryItem = result.newHistory[1] as unknown as { type: string; role: string; content: string }
  assert.equal(summaryItem.type, 'message')
  assert.equal(summaryItem.role, 'user')
  assert.match(summaryItem.content, /auto-compaction · 2 earlier tool call\/output pairs summarized below/)
  assert.match(summaryItem.content, /AGENT_SUMMARY: ran 2 bash commands/)
})

test('summary: most-recent KEEP_RECENT_PAIRS pairs survive intact alongside the summary', async () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_old1'), fnOutput('call_old1', 'old-1'),
    fnCall('call_old2'), fnOutput('call_old2', 'old-2'),
    fnCall('call_recent_a'), fnOutput('call_recent_a', 'recent-a'),
    fnCall('call_recent_b'), fnOutput('call_recent_b', 'recent-b'),
  ]
  const result = await compactHistoryWithSummary(
    history, () => true,
    async () => '[summarized two old pairs]',
  )
  // recent_a and recent_b survive in their original form.
  const surviving = result.newHistory.filter((it) => {
    const r = it as unknown as { call_id?: string }
    return typeof r.call_id === 'string'
  }).map((it) => (it as unknown as { call_id: string }).call_id)
  assert.deepEqual(
    surviving.sort(),
    ['call_recent_a', 'call_recent_a', 'call_recent_b', 'call_recent_b'].sort(),
    'each of the 2 recent pairs contributes 2 items (fnCall + fnOutput)',
  )
})

test('summary: summarize() throwing falls back to the drop-and-marker path (no crash)', async () => {
  // If the summarizer LLM call rejects (network blip / quota), we MUST
  // still produce a valid compaction result — falling all the way back
  // to the sync drop-with-marker path. The turn keeps running.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  // Silence the expected console.warn
  const realWarn = console.warn
  console.warn = () => { /* suppressed */ }
  try {
    const result = await compactHistoryWithSummary(
      history, () => true,
      async () => { throw new Error('LLM rate-limited') },
    )
    assert.equal(result.usedLlmSummary, false, 'fallback path is taken')
    assert.ok(result.droppedPairCount >= 1, 'fallback drop did happen')
    // The synthetic marker uses the generic wording, not LLM text.
    const marker = result.newHistory[1] as unknown as { content: string }
    assert.match(marker.content, /\[auto-compaction\]/)
    assert.doesNotMatch(marker.content, /summarized below/)
  } finally {
    console.warn = realWarn
  }
})

test('summary: leading non-tool items are preserved through the summarized path', async () => {
  // Same invariant as compactHistory — the original user question must
  // never be lost, no matter which stage-2 strategy is used.
  const history: ResponseInputItem[] = [
    userMsg('What is the kanban board id?'),
    userMsg('please be quick'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = await compactHistoryWithSummary(
    history, () => true,
    async () => 'summary text',
  )
  const first = result.newHistory[0] as unknown as { type: string; content: string }
  const second = result.newHistory[1] as unknown as { type: string; content: string }
  assert.equal(first.type, 'message')
  assert.equal(first.content, 'What is the kanban board id?')
  assert.equal(second.type, 'message')
  assert.equal(second.content, 'please be quick')
})

test('summary: empty summary text from LLM is gracefully replaced with a placeholder', async () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = await compactHistoryWithSummary(
    history, () => true,
    async () => '   ',     // whitespace-only — useless
  )
  assert.equal(result.usedLlmSummary, true)
  const marker = result.newHistory[1] as unknown as { content: string }
  assert.match(marker.content, /no summary returned/)
})

test('summary: when there are fewer than KEEP_RECENT_PAIRS pairs total, summarize() is NOT called', async () => {
  // Nothing to drop → no need to summarize → no LLM round-trip cost.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ]
  let summarizeCalls = 0
  const result = await compactHistoryWithSummary(
    history, () => true,
    async () => { summarizeCalls += 1; return 'unused' },
  )
  assert.equal(summarizeCalls, 0)
  assert.equal(result.droppedPairCount, 0)
})

test('summary: input mutation safety — caller history not modified', async () => {
  const original: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'X'.repeat(COMPACTED_OUTPUT_BYTES * 3)),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const originalOutput = (original[2] as unknown as { output: string }).output
  await compactHistoryWithSummary(original, () => true, async () => 'summary')
  // Caller-supplied items still intact.
  assert.equal((original[2] as unknown as { output: string }).output, originalOutput)
})

test('summary: every dropped pair appears in summarize() input — caller can verify nothing was silently skipped', async () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_aa', 'bash', '{"command":"step-aa"}'), fnOutput('call_aa', 'out-aa'),
    fnCall('call_bb', 'web_search', '{"query":"q-bb"}'), fnOutput('call_bb', 'out-bb'),
    fnCall('call_cc', 'bash', '{"command":"step-cc"}'), fnOutput('call_cc', 'out-cc'),
    fnCall('call_recent_1'), fnOutput('call_recent_1', 'recent-1'),
    fnCall('call_recent_2'), fnOutput('call_recent_2', 'recent-2'),
  ]
  let received: ResponseInputItem[] = []
  await compactHistoryWithSummary(history, () => true, async (items) => {
    received = items
    return 'sum'
  })
  // 3 drop-eligible pairs × 2 items = 6 items passed to summarize.
  assert.equal(received.length, 6)
  const receivedCallIds = received.map((it) => (it as unknown as { call_id: string }).call_id).sort()
  assert.deepEqual(
    [...new Set(receivedCallIds)].sort(),
    ['call_aa', 'call_bb', 'call_cc'],
    'summarize() receives only drop-eligible call_ids',
  )
})

test('summary: pairs are dropped in OLDEST-FIRST order — newest pairs always survive', async () => {
  // 5 pairs total. KEEP_RECENT_PAIRS = 2 → drop the oldest 3.
  // Verify the summarizer sees the OLDEST three (in original insertion
  // order) and the newest TWO survive in the output history.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_old1'), fnOutput('call_old1', 'a'),
    fnCall('call_old2'), fnOutput('call_old2', 'b'),
    fnCall('call_old3'), fnOutput('call_old3', 'c'),
    fnCall('call_new4'), fnOutput('call_new4', 'd'),
    fnCall('call_new5'), fnOutput('call_new5', 'e'),
  ]
  let dropped: string[] = []
  const result = await compactHistoryWithSummary(history, () => true, async (items) => {
    dropped = items
      .map((it) => (it as unknown as { call_id: string }).call_id)
      .filter((c, i, arr) => arr.indexOf(c) === i)    // unique
    return 'sum'
  })
  assert.deepEqual(dropped, ['call_old1', 'call_old2', 'call_old3'],
    'OLDEST 3 pairs are dropped (in original order); newest 2 survive')
  // Verify survivors are present in output.
  const surviving = result.newHistory.filter((it) => {
    const r = it as unknown as { call_id?: string }
    return typeof r.call_id === 'string'
  }).map((it) => (it as unknown as { call_id: string }).call_id)
  assert.deepEqual(
    [...new Set(surviving)].sort(),
    ['call_new4', 'call_new5'].sort(),
  )
})

test('summary: history length AFTER compaction is shorter than before (sanity check on actual shrink)', async () => {
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'aaaaaaaaaaaaaaaaaaaaaaaaa'),
    fnCall('call_2'), fnOutput('call_2', 'bbbbbbbbbbbbbbbbbbbbbbbbb'),
    fnCall('call_3'), fnOutput('call_3', 'ccccccccccccccccccccccccc'),
    fnCall('call_4'), fnOutput('call_4', 'ddddddddddddddddddddddddd'),
    fnCall('call_5'), fnOutput('call_5', 'eeeeeeeeeeeeeeeeeeeeeeeeee'),
  ]
  const before = history.length
  const result = await compactHistoryWithSummary(history, () => true, async () => 'short summary')
  // 5 pairs × 2 items + 1 user msg = 11 before.
  // 1 user msg + 1 summary + 2 surviving pairs × 2 items = 6 after.
  assert.equal(before, 11)
  assert.ok(result.newHistory.length < before, `compaction must shrink history; got ${result.newHistory.length} vs ${before}`)
  assert.equal(result.newHistory.length, 6)
})

test('summary: summarize() called EXACTLY once per compaction pass (no accidental fan-out)', async () => {
  // Defensive: confirm we don't call the summarizer once per dropped
  // pair. One pass = one LLM round-trip, no matter how many pairs
  // are summarized.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
    fnCall('call_5'), fnOutput('call_5', 'e'),
  ]
  let calls = 0
  await compactHistoryWithSummary(history, () => true, async () => {
    calls += 1
    return 'sum'
  })
  assert.equal(calls, 1, 'summarize() invoked exactly once per pass')
})

test('summary: marker text is hidden inside a message item — model sees the summary as user-role text', async () => {
  // The summary lands as `{ type: 'message', role: 'user', content }`
  // so the agent reads it as "context I'm being given," not as a
  // function call. Pin that the role is 'user' (not 'system' or
  // 'assistant') — keeping it user-role aligns with how cumora's
  // wake prompt feeds inbox items into the model.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const result = await compactHistoryWithSummary(history, () => true, async () => 'CUSTOM_SUMMARY_TEXT')
  const summary = result.newHistory[1] as unknown as { type: string; role: string; content: string }
  assert.equal(summary.type, 'message')
  assert.equal(summary.role, 'user')
  assert.match(summary.content, /CUSTOM_SUMMARY_TEXT/)
})

test('summary: oversize summary text is hard-capped at 4000 chars in the spliced marker', async () => {
  // A misbehaving summarizer could return a giant blob. We cap the
  // spliced content to keep the compaction itself from blowing up
  // the budget we just spent compacting under.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
  ]
  const huge = 'Z'.repeat(20_000)
  const result = await compactHistoryWithSummary(history, () => true, async () => huge)
  const marker = result.newHistory[1] as unknown as { content: string }
  // marker content = header (~120 chars) + body (≤ 4000 chars)
  assert.ok(marker.content.length < 5000, `marker should be capped; got ${marker.content.length} chars`)
  assert.match(marker.content, /Z/, 'some of the summary made it in')
})

// ── estimateTokens / estimateHistoryTokens ──────────────────────────────

test('estimateTokens: pure ASCII text — ~3.5 chars per token', () => {
  // English text averages around 3.5 chars/token in BPE. Confirm the
  // estimator stays in that ballpark for plain ASCII.
  // "hello world this is plain ascii text" = 36 chars → ~11 tokens
  const t = estimateTokens('hello world this is plain ascii text')
  assert.ok(t >= 9 && t <= 12, `expected ~10 tokens, got ${t}`)
})

test('estimateTokens: pure CJK text — 1 char per token (the key fix)', () => {
  // The whole reason for this estimator existing. The old byte-count
  // heuristic under-estimated CJK by ~3x. Verify each Chinese char
  // counts as roughly one token.
  const t = estimateTokens('你好世界这是一段中文文本')   // 12 chars
  // Every char is non-ASCII → 12 tokens.
  assert.equal(t, 12)
})

test('estimateTokens: mixed Latin + CJK splits the count correctly', () => {
  // "hello 世界" → 6 ASCII + 1 space + 2 CJK = 7 ascii (cost ~2) + 2 CJK (cost 2) = ~4
  const t = estimateTokens('hello 世界')
  assert.ok(t >= 4 && t <= 5, `expected 4-5 tokens, got ${t}`)
})

test('estimateTokens: empty string returns 0', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens: emoji and accented latin counted as non-ASCII', () => {
  // Emoji are 1 char per token in our estimator (real BPE often
  // gives them 2+, but 1 is the safe lower bound for triggering
  // compaction earlier rather than too late).
  assert.equal(estimateTokens('🌟'), 2)    // surrogate pair = 2 UTF-16 code units, both > 0x7F
  assert.equal(estimateTokens('café'), Math.ceil(3 / 3.5) + 1)
})

test('estimateHistoryTokens: sums estimates across all items', () => {
  const history: ResponseInputItem[] = [
    userMsg('hi'),
    fnCall('call_1', 'bash', '{"command":"echo hi"}'),
    fnOutput('call_1', 'output'),
  ]
  const total = estimateHistoryTokens(history)
  // Reasonable lower bound — JSON serialization adds a few extra
  // tokens per item (type, role, etc.).
  assert.ok(total > 0)
  assert.ok(total < 200, `expected < 200 tokens for trivial 3-item history, got ${total}`)
})

test('estimateHistoryTokens: CJK content gets the right token count, not byte-count/3', () => {
  // Build a history with a chunky Chinese function_call_output. With
  // the old byte-count heuristic, a 1000-char Chinese output would
  // count as ~333 "tokens" — under any 150K threshold. Real tokens:
  // closer to 1000.
  const cjkOutput = '中文'.repeat(500)    // 1000 CJK chars
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'),
    fnOutput('call_1', cjkOutput),
  ]
  const total = estimateHistoryTokens(history)
  // Should be at least ~1000 (just the CJK chars), plus envelope
  // tokens for the JSON shape. NOT ~333.
  assert.ok(total >= 1000, `CJK output should count as ~1000 tokens, got ${total}`)
})

test('estimateTokens used by compactHistory predicate: CJK content triggers compaction at the right point', () => {
  // The behavioural pin: a history that's 800 estimated tokens
  // should NOT compact when the predicate threshold is 1000, but
  // should compact when the threshold is 500.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', '中文'.repeat(200)),
    fnCall('call_2'), fnOutput('call_2', '中文'.repeat(200)),
    fnCall('call_3'), fnOutput('call_3', '中文'.repeat(200)),
    fnCall('call_4'), fnOutput('call_4', '中文'.repeat(200)),
  ]
  const tokens = estimateHistoryTokens(history)
  assert.ok(tokens > 1500, `expected ≥1500 tokens for 4 CJK pairs, got ${tokens}`)

  // Predicate: still over when token count exceeds 1000.
  const result = compactHistory(history, (t) => t > 1000)
  // Either dropped pairs or truncated outputs — something shrunk.
  assert.ok(result.droppedPairCount > 0 || result.truncatedOutputCount > 0,
    'CJK history should trigger compaction when threshold is 1000 tokens')
})

test('summary: items with no call_id (legacy / bare function_call) do NOT confuse the partitioner', async () => {
  // We've seen bare function_call items without a call_id slip into
  // history (a stream event arrived without the call_id field). Those
  // should NOT be grouped under a fake empty-string key — verify the
  // grouping helper rejects them, and they end up in tailNonTool.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_1'), fnOutput('call_1', 'a'),
    fnCall('call_2'), fnOutput('call_2', 'b'),
    fnCall('call_3'), fnOutput('call_3', 'c'),
    fnCall('call_4'), fnOutput('call_4', 'd'),
    // Bare function_call with no call_id — partitioner ignores it.
    { type: 'function_call', name: 'orphan' } as unknown as ResponseInputItem,
  ]
  let summarizeCalls = 0
  const result = await compactHistoryWithSummary(history, () => true, async () => { summarizeCalls += 1; return 'sum' })
  assert.equal(summarizeCalls, 1)
  // The orphan item with no call_id should be in tailNonTool — and
  // those re-attach AFTER the surviving pairs.
  const last = result.newHistory[result.newHistory.length - 1] as unknown as { type: string; name?: string }
  assert.equal(last.type, 'function_call')
  assert.equal(last.name, 'orphan')
})

// ── Position preservation: an answered steer must not be re-asked ───────────
//
// Mid-turn steers (turn.ts `tryDrainSteer`) push the new user message into
// `history` as a role:'user' item, and the tool calls that ANSWER it land
// after it. That ordering is the only in-context evidence the steer was
// handled: assistant text is deliberately never added as a history item
// (turn.ts, "would corrupt history shape — see earlier bug"), so there is no
// assistant message for the model to see its own reply in.
//
// Stage 2 used to bucket every non-tool item sitting after the first tool item
// and re-append that bucket AFTER all surviving pairs. A steer answered in hop
// 5 therefore reappeared as the LAST item of the hop-20 input — the fresh-input
// slot — with its answer now ordered before the question, while its text reads
// as an imperative fresh arrival ("Re-assess your current plan … respond to the
// new message in its own conversation"). The agent replied to the user twice.

const steerMsg = (text: string): ResponseInputItem => ({
  type: 'message',
  role: 'user',
  content: text,
}) as unknown as ResponseInputItem

/** History shaped like a real steered turn: seed question, two old tool
 *  pairs, the steer, the pair that answered the steer, one later pair. */
const steeredHistory = (): ResponseInputItem[] => [
  userMsg('original question'),
  fnCall('call_old1'), fnOutput('call_old1', 'a'),
  fnCall('call_old2'), fnOutput('call_old2', 'b'),
  steerMsg('[Mid-turn update — 1 new message received while you were working]\n@ana (in conversation c9):\nalso check the logs\nRe-assess your current plan in light of these and continue.'),
  fnCall('call_answer'), fnOutput('call_answer', 'posted reply to c9'),
  fnCall('call_later'), fnOutput('call_later', 'd'),
]

const indexOfSteer = (history: ResponseInputItem[]): number =>
  history.findIndex((it) => {
    const r = it as unknown as { content?: unknown }
    return typeof r.content === 'string' && r.content.startsWith('[Mid-turn update')
  })

const indexOfCallId = (history: ResponseInputItem[], callId: string): number =>
  history.findIndex((it) => (it as unknown as { call_id?: string }).call_id === callId)

test('stage 2 (drop path): an ANSWERED mid-turn steer keeps its position — never hoisted to the newest-input slot', () => {
  const result = compactHistory(steeredHistory(), ALWAYS_OVER)
  assert.equal(result.droppedPairCount, 2, 'the two oldest pairs go; the steer and its answer survive')

  const steerAt = indexOfSteer(result.newHistory)
  assert.ok(steerAt >= 0, 'the steer itself must never be dropped')
  assert.notEqual(
    steerAt, result.newHistory.length - 1,
    'the answered steer was hoisted into the newest-input slot — the model reads it as a fresh message and answers it again',
  )
  assert.ok(
    steerAt < indexOfCallId(result.newHistory, 'call_answer'),
    'the tool call that answered the steer must still come AFTER it — that ordering is the only evidence it was handled',
  )
  assert.ok(
    steerAt < indexOfCallId(result.newHistory, 'call_later'),
    'later work must stay after the steer',
  )
})

test('stage 2 (summary path): an ANSWERED mid-turn steer keeps its position', async () => {
  const result = await compactHistoryWithSummary(steeredHistory(), () => true, async () => 'ran two lookups')
  assert.equal(result.usedLlmSummary, true)

  const steerAt = indexOfSteer(result.newHistory)
  assert.ok(steerAt >= 0, 'the steer itself must never be dropped')
  assert.notEqual(
    steerAt, result.newHistory.length - 1,
    'the answered steer was hoisted into the newest-input slot on the summarized path too',
  )
  assert.ok(
    steerAt < indexOfCallId(result.newHistory, 'call_answer'),
    'the tool call that answered the steer must still come AFTER it',
  )
})

test('stage 2: surviving tool items keep their original relative order (no regrouping by call_id)', () => {
  // One hop can emit two function_calls and then both outputs:
  // fc1, fc2, out1, out2 — that is the exact shape every UNCOMPACTED hop
  // already sends on the wire. Compaction must hand back the same order it
  // was given, not a re-grouped fc1,out1,fc2,out2.
  const history: ResponseInputItem[] = [
    userMsg('q'),
    fnCall('call_drop'), fnOutput('call_drop', 'x'),
    fnCall('call_a'), fnCall('call_b'), fnOutput('call_a', 'a'), fnOutput('call_b', 'b'),
  ]
  const result = compactHistory(history, ALWAYS_OVER)
  const shape = result.newHistory.map((it) => {
    const r = it as unknown as { type?: string; call_id?: string }
    return r.call_id ? `${r.type}:${r.call_id}` : `${r.type}`
  })
  assert.deepEqual(shape, [
    'message', 'message',
    'function_call:call_a', 'function_call:call_b',
    'function_call_output:call_a', 'function_call_output:call_b',
  ])
})
