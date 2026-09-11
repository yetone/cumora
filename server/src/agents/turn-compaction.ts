/**
 * History compaction for the agent turn loop — extracted out of turn.ts so
 * the algorithm can be unit-tested without dragging the runtime / DB /
 * Redis / OpenAI SDK boot graph along for the ride.
 *
 * Compaction fires at the top of a hop iteration when the previous hop's
 * token usage crossed a soft threshold (75% of the model's context
 * window). The goal is to keep the turn alive — the model continues from
 * a smaller, semantically-equivalent history — rather than break the
 * loop the way the old hard `CONTEXT_BUDGET_TOKENS` guard did.
 *
 * Two strategies, chosen by the caller:
 *
 *   - {@link compactHistoryWithSummary} (preferred): take the oldest
 *     to-be-dropped tool-call pairs, send them through an LLM to
 *     produce a concise summary paragraph, and INJECT THAT SUMMARY in
 *     place of the dropped items. The agent retains semantic
 *     continuity ("I downloaded the video to /tmp/x.mp4, ran ffprobe
 *     and saw H264 1080p, 47s") instead of a generic "[earlier work
 *     dropped]" placeholder. One LLM round-trip per compaction pass.
 *
 *   - {@link compactHistory} (fallback): pure synchronous drop-and-
 *     marker. Used when the summarization LLM is unavailable, when
 *     the caller wants zero added latency, or in tests.
 *
 * Three invariants both strategies hold:
 *
 *   1. function_call ↔ function_call_output ↔ item_reference items
 *      sharing a call_id are dropped as a UNIT. Upstream's input
 *      validator 400s with "No tool call found for function call output
 *      with call_id X" the moment a function_call_output sits without
 *      its matching function_call.
 *
 *   2. Leading non-tool items (the original user/inbox messages that
 *      seeded the turn) are NEVER dropped — losing them would erase
 *      the question the agent is supposed to be answering.
 *
 *   3. The most recent {@link KEEP_RECENT_PAIRS} pairs are NEVER
 *      dropped either — they're the immediate conversational context
 *      the model needs to continue from.
 *
 *   4. Everything that SURVIVES keeps its original relative POSITION.
 *      Compaction only deletes; it never reorders. This one is not
 *      cosmetic — it is the fix for the duplicate-reply bug below.
 *
 *      Stage 2 used to partition by item TYPE: every non-tool item
 *      sitting after the first tool item went into a `tailNonTool`
 *      bucket that both rebuilds re-appended AFTER all surviving
 *      pairs. The only non-tool items that ever appear mid-history
 *      are `role:'user'` items we inject ourselves — the mid-turn
 *      steer render (turn.ts `tryDrainSteer`), the status-required
 *      nudge, and the completion-rejection nudge. And there is no
 *      assistant message in `history` for the model to see its own
 *      reply in: assistant text is deliberately never added as a
 *      history item (turn.ts: synthesizing one with no item_id /
 *      part_id / responseId corrupts history shape — see the earlier
 *      bug noted there). So the ONLY in-context evidence that a
 *      steer was already handled is that the function_call /
 *      function_call_output pairs answering it sit AFTER it.
 *
 *      The tail-move inverted exactly that: a steer answered in hop 5
 *      came back as the LAST item of the hop-20 input — the
 *      fresh-input slot — with its answer now ordered before the
 *      question, while its own text reads as an imperative fresh
 *      arrival ("[Mid-turn update — 1 new message received while you
 *      were working] … Re-assess your current plan … respond to the
 *      new message in its own conversation"). The agent did the work
 *      a second time and posted a second reply, and turn.ts persists
 *      the compacted array for every remaining hop, so it re-asked on
 *      every hop after that. Same shape for the two nudges: a
 *      satisfied nudge re-presented last is a live instruction again.
 *
 *      Rebuilding in order also stops compaction from re-grouping
 *      interleaved items. One hop pushes all of its function_calls
 *      and then all of its outputs (fc1, fc2, out1, out2); that is
 *      the shape every UNCOMPACTED hop already puts on the wire, so
 *      handing it back unchanged is strictly closer to known-good
 *      than the fc1,out1,fc2,out2 the old bucket rebuild produced.
 */
import type { ResponseInputItem } from 'openai/resources/responses/responses'

/**
 * Cheap token estimator tuned for mixed Latin + CJK + code text. Used
 * INSIDE the compaction loop to decide when stage-2 dropping has shed
 * enough; the authoritative token count for "are we over the threshold"
 * still comes from the LLM's `usage.input_tokens` field.
 *
 * The old `length / 3` heuristic worked OK for English but
 * underestimated CJK by ~3x — a Chinese character is roughly one token,
 * not one-third. That meant CJK-heavy turns under-triggered compaction
 * and hit the hard-limit branch instead of getting summarized. Net
 * effect: agents working in Chinese never got the benefits of the
 * LLM-summarized path because the budget guard thought they were fine.
 *
 * Heuristic:
 *   - ASCII chars (0x00–0x7F): ~3.5 chars per token (consistent with
 *     tiktoken's BPE on English / code / JSON)
 *   - Non-ASCII (CJK, emoji, accented Latin, etc.): ~1 char per token
 *     (the BPE has very few merges for those ranges, so most chars
 *     become their own token; emoji often expand to 2+ tokens but 1
 *     is the safe lower bound for an estimate driving compaction)
 *
 * Implementation walks the string once counting both buckets, so cost
 * is O(n) and allocates nothing. */
export function estimateTokens(text: string): number {
  let ascii = 0
  let nonAscii = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 3.5) + nonAscii
}

/** Sum token estimates across a history list. Serializes each item to
 *  JSON once — the same shape the wire bytes will take when sent to
 *  the upstream — so the estimate matches what the upstream tokenizer
 *  will actually see. */
export function estimateHistoryTokens(history: ResponseInputItem[]): number {
  let total = 0
  for (const item of history) {
    total += estimateTokens(JSON.stringify(item))
  }
  return total
}

/** Maximum byte length of a function_call_output's `output` field after
 *  stage-1 in-place truncation. Tuned so that a bash tool output (the
 *  largest source of bloat in practice — `cumora web read`, `kanban ls`
 *  on a big board, etc.) shrinks an order of magnitude without losing
 *  the first slice of stdout that usually carries the answer. */
export const COMPACTED_OUTPUT_BYTES = 600

/** How many of the MOST RECENT call_id-pair groups stage-2 will always
 *  keep, no matter what. Two is enough to retain the immediately-prior
 *  exchange that the model needs to reason about its next move. */
export const KEEP_RECENT_PAIRS = 2

/** Result of one compaction pass over `history`. The caller emits a
 *  single `turn.compacted` observability event populated with these
 *  numbers so post-hoc investigations can see exactly when (and how
 *  aggressively) compaction kicked in. */
export interface CompactionResult {
  newHistory: ResponseInputItem[]
  truncatedOutputBytes: number
  truncatedOutputCount: number
  droppedPairCount: number
  /** Total chars of dropped items (function_call args + function_call_output
   *  content + item_reference shells), measured BEFORE any truncation —
   *  useful for spotting whether the truncate stage alone would have
   *  been enough. */
  droppedItemBytes: number
  /** True iff stage 2 replaced the dropped items with a real LLM-
   *  generated summary (i.e. compactHistoryWithSummary's summarize
   *  callback was used and didn't throw). False on the drop-and-marker
   *  fallback path. */
  usedLlmSummary: boolean
}

/** Compact `history` in two stages — pure synchronous fallback path.
 *  `stillOverThreshold` is invoked with an estimated TOKEN COUNT (not
 *  bytes) after each shrinking step. The estimator
 *  ({@link estimateHistoryTokens}) is CJK-aware so Chinese / Japanese
 *  histories don't silently sail past the budget the way a byte-count
 *  heuristic would. */
export function compactHistory(
  history: ResponseInputItem[],
  stillOverThreshold: (estimateTokens: number) => boolean,
): CompactionResult {
  return compactHistoryInternal(history, stillOverThreshold, null)
}

/** Compact `history` with REAL LLM-summarized dropped content. The
 *  `summarize` callback is invoked once if stage 1 (output truncation)
 *  isn't enough; if it returns a string, that string replaces the
 *  to-be-dropped items as a synthetic message. If it throws, falls back
 *  to the {@link compactHistory} drop-and-marker behaviour.
 *
 *  Summarization is deliberately opt-in via this separate entry point
 *  so call sites that can't / don't want to spend an LLM round-trip
 *  (tests, dev-mode, observability) stay synchronous. */
export async function compactHistoryWithSummary(
  history: ResponseInputItem[],
  stillOverThreshold: (estimateTokens: number) => boolean,
  summarize: (itemsToDrop: ResponseInputItem[]) => Promise<string>,
): Promise<CompactionResult> {
  // Stage 1 runs synchronously — truncating oversized outputs is free +
  // idempotent + saves tokens BEFORE we feed the dropped portion to the
  // summarizer LLM. CRITICALLY: we do NOT run the stage-2 fallback drop
  // here; that would shed context unnecessarily before we even tried to
  // summarize. compactHistoryInternal's contract is "stage 1 + stage 2
  // drop fallback", so we go through truncateOversizedOutputs directly
  // and decide between summarize / drop ourselves.
  const stage1 = truncateOversizedOutputs(deepishCopy(history))
  const working = stage1.newHistory
  const stage1Out = {
    truncatedOutputBytes: stage1.truncatedOutputBytes,
    truncatedOutputCount: stage1.truncatedOutputCount,
  }

  // If stage 1 alone is enough, return.
  if (!stillOverThreshold(estimateHistoryTokens(working))) {
    return {
      newHistory: working,
      truncatedOutputBytes: stage1Out.truncatedOutputBytes,
      truncatedOutputCount: stage1Out.truncatedOutputCount,
      droppedPairCount: 0, droppedItemBytes: 0, usedLlmSummary: false,
    }
  }

  // Stage 2 with summarization: identify the items we'd drop, ask the
  // LLM to summarize them, then splice the summary into the history.
  // On any failure, gracefully fall back to the drop-and-marker path
  // on the ORIGINAL caller-supplied history (so we don't re-truncate
  // outputs twice; compactHistoryInternal redoes stage 1 anyway).
  try {
    const result = await summarizeAndSplice(working, stage1Out, summarize)
    if (result !== null) return result
    // No pairs to drop after all — fall through.
    return {
      newHistory: working,
      truncatedOutputBytes: stage1Out.truncatedOutputBytes,
      truncatedOutputCount: stage1Out.truncatedOutputCount,
      droppedPairCount: 0, droppedItemBytes: 0, usedLlmSummary: false,
    }
  } catch (err) {
    console.warn('[compaction] summarize failed, falling back to drop-and-marker:',
      err instanceof Error ? err.message : err)
    return compactHistoryInternal(history, stillOverThreshold, null)
  }
}

// ── shared internal helpers ─────────────────────────────────────────────

/** True iff the item is one of the tool-shaped items that participate
 *  in call_id pairing. */
function groupKeyOf(item: ResponseInputItem): string | null {
  const r = item as unknown as Record<string, unknown>
  if (!r || typeof r !== 'object') return null
  if (r.type === 'function_call' || r.type === 'function_call_output') {
    const cid = typeof r.call_id === 'string' ? r.call_id : ''
    return cid.length > 0 ? cid : null
  }
  if (r.type === 'item_reference') {
    const id = typeof r.id === 'string' ? r.id : ''
    return id.length > 0 ? id : null
  }
  return null
}

/** Partition `history` into [leadingNonTool, pairGroups]. pairGroups is
 *  keyed by call_id and ordered by first appearance — it exists purely to
 *  decide WHICH call_ids get dropped (and to measure them). It is not a
 *  rebuild order: the rebuild walks the original array (see
 *  {@link tailWithoutDroppedGroups}) so invariant 4 holds. */
interface PartitionedHistory {
  leadingNonToolEnd: number
  callIdsInOrder: string[]
  pairItems: Map<string, ResponseInputItem[]>
}

function partitionHistory(history: ResponseInputItem[]): PartitionedHistory {
  let leadingNonToolEnd = 0
  while (leadingNonToolEnd < history.length && groupKeyOf(history[leadingNonToolEnd]) === null) {
    leadingNonToolEnd += 1
  }
  const callIdsInOrder: string[] = []
  const pairItems = new Map<string, ResponseInputItem[]>()
  for (let i = leadingNonToolEnd; i < history.length; i++) {
    const item = history[i]
    const key = groupKeyOf(item)
    if (key !== null) {
      if (!pairItems.has(key)) {
        pairItems.set(key, [])
        callIdsInOrder.push(key)
      }
      pairItems.get(key)!.push(item)
    }
    // Non-tool items are NOT collected here. They are rebuilt from their
    // original index — hoisting them to the tail is the duplicate-reply
    // bug documented as invariant 4 in the module header.
  }
  return { leadingNonToolEnd, callIdsInOrder, pairItems }
}

/** Rebuild everything after the leading seed messages IN ORIGINAL ORDER,
 *  skipping only the items whose call_id group was dropped. Non-tool
 *  items (steer renders, protocol nudges) and un-pair-able items (a
 *  malformed function_call with no call_id — `groupKeyOf` returns null,
 *  so it is never drop-eligible) simply keep their slot.
 *
 *  Invariant 1 still holds by construction: membership is decided per
 *  call_id group, so a function_call_output is kept iff its matching
 *  function_call is kept. Nothing can be split, so upstream never sees
 *  "No tool call found for function call output with call_id X". */
function tailWithoutDroppedGroups(
  history: ResponseInputItem[],
  leadingNonToolEnd: number,
  droppedCallIds: Set<string>,
): ResponseInputItem[] {
  const kept: ResponseInputItem[] = []
  for (let i = leadingNonToolEnd; i < history.length; i++) {
    const item = history[i]
    const key = groupKeyOf(item)
    if (key !== null && droppedCallIds.has(key)) continue
    kept.push(item)
  }
  return kept
}

/** Build a defensive deep-ish copy of every item so callers' arrays are
 *  never mutated by the truncate pass. */
function deepishCopy(history: ResponseInputItem[]): ResponseInputItem[] {
  return history.map((item) => {
    if (item && typeof item === 'object') {
      return { ...(item as unknown as Record<string, unknown>) } as unknown as ResponseInputItem
    }
    return item
  })
}

/** Stage 1: truncate oversized function_call_output payloads in place.
 *  Returns mutation counters so the caller can roll them into the
 *  observability event. */
function truncateOversizedOutputs(history: ResponseInputItem[]): {
  newHistory: ResponseInputItem[]
  truncatedOutputBytes: number
  truncatedOutputCount: number
} {
  let truncatedOutputBytes = 0
  let truncatedOutputCount = 0
  const newHistory = history.map((item) => {
    const raw = item as unknown as Record<string, unknown>
    if (raw && raw.type === 'function_call_output' && typeof raw.output === 'string') {
      const out = raw.output as string
      if (out.length > COMPACTED_OUTPUT_BYTES) {
        const head = out.slice(0, COMPACTED_OUTPUT_BYTES)
        truncatedOutputBytes += out.length - head.length
        truncatedOutputCount += 1
        return { ...raw, output: `${head}… [truncated by auto-compaction: original ${out.length} bytes]` } as unknown as ResponseInputItem
      }
    }
    return item
  })
  return { newHistory, truncatedOutputBytes, truncatedOutputCount }
}

/** Stage 2 fallback: drop oldest pairs with a generic marker. */
function compactHistoryInternal(
  history: ResponseInputItem[],
  stillOverThreshold: (estimateTokens: number) => boolean,
  _placeholder: null,
): CompactionResult {
  const stage1 = truncateOversizedOutputs(deepishCopy(history))
  let newHistory = stage1.newHistory
  const truncatedOutputBytes = stage1.truncatedOutputBytes
  const truncatedOutputCount = stage1.truncatedOutputCount

  let estimateTokensCount = estimateHistoryTokens(newHistory)
  if (!stillOverThreshold(estimateTokensCount)) {
    return { newHistory, truncatedOutputBytes, truncatedOutputCount, droppedPairCount: 0, droppedItemBytes: 0, usedLlmSummary: false }
  }

  const { leadingNonToolEnd, callIdsInOrder, pairItems } = partitionHistory(newHistory)
  // Pin the stage-1 array: every iteration rebuilds from THIS one, so the
  // surviving items are always read at their original indices (invariant 4).
  // `newHistory` is reassigned below and must not become the rebuild source.
  const stage1History = newHistory
  const dropEligible = callIdsInOrder.slice(0, Math.max(0, callIdsInOrder.length - KEEP_RECENT_PAIRS))
  const droppedCallIds = new Set<string>()
  let droppedPairCount = 0
  let droppedItemBytes = 0
  for (let idx = 0; idx < dropEligible.length; idx++) {
    const cid = dropEligible[idx]
    const items = pairItems.get(cid) ?? []
    for (const it of items) droppedItemBytes += JSON.stringify(it).length
    droppedCallIds.add(cid)
    droppedPairCount += 1
    const marker: ResponseInputItem = {
      type: 'message',
      role: 'user',
      content: `[auto-compaction] ${droppedPairCount} earlier tool ${droppedPairCount === 1 ? 'call/output pair was' : 'call/output pairs were'} dropped from history to fit the context budget (~${droppedItemBytes} bytes). Continue from where you left off.`,
    } as unknown as ResponseInputItem
    newHistory = [
      ...stage1History.slice(0, leadingNonToolEnd),
      marker,
      ...tailWithoutDroppedGroups(stage1History, leadingNonToolEnd, droppedCallIds),
    ]
    estimateTokensCount = estimateHistoryTokens(newHistory)
    if (!stillOverThreshold(estimateTokensCount)) break
  }
  return { newHistory, truncatedOutputBytes, truncatedOutputCount, droppedPairCount, droppedItemBytes, usedLlmSummary: false }
}

/** Stage 2 LLM-summarized splice. Returns null when there are no
 *  drop-eligible pairs (so the caller can pass through unchanged).
 *  May reject — caller falls back to {@link compactHistoryInternal}. */
async function summarizeAndSplice(
  stage1History: ResponseInputItem[],
  stage1Counters: { truncatedOutputBytes: number; truncatedOutputCount: number },
  summarize: (itemsToDrop: ResponseInputItem[]) => Promise<string>,
): Promise<CompactionResult | null> {
  const { leadingNonToolEnd, callIdsInOrder, pairItems } = partitionHistory(stage1History)
  const dropEligible = callIdsInOrder.slice(0, Math.max(0, callIdsInOrder.length - KEEP_RECENT_PAIRS))
  if (dropEligible.length === 0) return null

  const itemsToDrop: ResponseInputItem[] = []
  let droppedItemBytes = 0
  for (const cid of dropEligible) {
    const items = pairItems.get(cid) ?? []
    for (const it of items) droppedItemBytes += JSON.stringify(it).length
    itemsToDrop.push(...items)
  }
  const summaryText = await summarize(itemsToDrop)
  const cleaned = summaryText.trim().slice(0, 4000) || '(no summary returned)'
  const summaryMarker: ResponseInputItem = {
    type: 'message',
    role: 'user',
    content: `[auto-compaction · ${dropEligible.length} earlier tool call/output ${dropEligible.length === 1 ? 'pair' : 'pairs'} summarized below — continue from where you left off]\n\n${cleaned}`,
  } as unknown as ResponseInputItem

  const newHistory = [
    ...stage1History.slice(0, leadingNonToolEnd),
    summaryMarker,
    ...tailWithoutDroppedGroups(stage1History, leadingNonToolEnd, new Set(dropEligible)),
  ]
  return {
    newHistory,
    truncatedOutputBytes: stage1Counters.truncatedOutputBytes,
    truncatedOutputCount: stage1Counters.truncatedOutputCount,
    droppedPairCount: dropEligible.length,
    droppedItemBytes,
    usedLlmSummary: true,
  }
}
