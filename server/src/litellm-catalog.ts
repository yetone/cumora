/**
 * LiteLLM model catalog — per-model price and context window, as the proxy
 * reports them on `GET /model/info`.
 *
 * Cumora prices every LLM call into the cost ledger (`agents/cost.ts`) and
 * sizes compaction off the model's context window (`agents/turn.ts`). Both
 * work from a small seeded table keyed on OpenAI / Claude ids, so a gateway
 * model like `litellm/gemini-2.5-flash` or `litellm/llama-3.3-70b` would fall
 * through to the Sonnet fallback rate and an assumed 200K window. The proxy
 * already knows the real numbers for every model it serves (from its own
 * config or LiteLLM's maintained model map), so we read them from there.
 *
 * Pure on purpose: no env, no network. `server/src/litellm.ts` fetches
 * `/model/info` and feeds the result in through `setLiteLLMCatalog`; this
 * module only parses and answers lookups, so `cost.ts` can depend on it
 * without picking up side effects.
 */
import type { ModelPrice } from './agents/cost.js'

export const LITELLM_MODEL_PREFIX = 'litellm/'

export function isLiteLLMModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(LITELLM_MODEL_PREFIX)
}

export function stripLiteLLMPrefix(model: string): string {
  return model.slice(LITELLM_MODEL_PREFIX.length)
}

export interface LiteLLMModelEntry {
  /** Absent when the proxy has no cost data for this model — the caller
   *  then falls back to its usual pricing instead of recording $0. */
  price?: ModelPrice
  maxInputTokens?: number
}

/** The subset of a `/model/info` row we read. */
interface RawModelInfoRow {
  model_name?: unknown
  model_info?: {
    input_cost_per_token?: unknown
    output_cost_per_token?: unknown
    cache_read_input_token_cost?: unknown
    cache_creation_input_token_cost?: unknown
    max_input_tokens?: unknown
    max_tokens?: unknown
  } | null
}

function positiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Parse a `/model/info` body into a lookup keyed by the lowercased proxy
 *  model name (the id an agent writes after `litellm/`). Per-token costs are
 *  converted to cost.ts's per-1M convention. A cache read/write rate the
 *  proxy doesn't report is billed at the plain input rate — we never assume
 *  a discount we can't see. When one alias load-balances several
 *  deployments, the first row with data wins. */
export function parseLiteLLMModelInfo(body: unknown): Map<string, LiteLLMModelEntry> {
  const out = new Map<string, LiteLLMModelEntry>()
  const rows = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(rows)) return out
  for (const row of rows as RawModelInfoRow[]) {
    if (typeof row?.model_name !== 'string' || !row.model_name) continue
    const id = row.model_name.toLowerCase()
    if (out.has(id)) continue
    const info = row.model_info ?? {}
    const entry: LiteLLMModelEntry = {}
    const inTok = positiveNumber(info.input_cost_per_token)
    const outTok = positiveNumber(info.output_cost_per_token)
    if (inTok !== undefined && outTok !== undefined) {
      const cachedIn = positiveNumber(info.cache_read_input_token_cost) ?? inTok
      const cacheWrite = positiveNumber(info.cache_creation_input_token_cost) ?? inTok
      entry.price = {
        inPer1M: inTok * 1_000_000,
        cachedInPer1M: cachedIn * 1_000_000,
        cacheWritePer1M: cacheWrite * 1_000_000,
        outPer1M: outTok * 1_000_000,
        // Same rule as every other non-operator rate in cost.ts: only
        // CUMORA_MODEL_PRICES_JSON counts as verified.
        verified: false,
      }
    }
    const maxIn = positiveNumber(info.max_input_tokens) ?? positiveNumber(info.max_tokens)
    if (maxIn) entry.maxInputTokens = maxIn
    if (entry.price || entry.maxInputTokens) out.set(id, entry)
  }
  return out
}

let catalog = new Map<string, LiteLLMModelEntry>()

export function setLiteLLMCatalog(next: Map<string, LiteLLMModelEntry>): void {
  catalog = next
}

/** Look up a `litellm/<model>` id (prefix and case are normalized here).
 *  Returns undefined for non-LiteLLM ids and for models the proxy hasn't
 *  reported yet, so callers keep their existing behaviour. */
export function liteLLMModelEntry(model: string | null | undefined): LiteLLMModelEntry | undefined {
  const id = (model ?? '').trim().toLowerCase()
  if (!isLiteLLMModel(id)) return undefined
  return catalog.get(stripLiteLLMPrefix(id))
}
