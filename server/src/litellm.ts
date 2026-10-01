/**
 * LiteLLM LLM provider — model-prefix routing to a LiteLLM proxy.
 *
 * LiteLLM (https://github.com/BerriAI/litellm) is an open-source, self-hosted
 * AI gateway: one OpenAI-compatible endpoint in front of 100+ providers
 * (Anthropic, Gemini, Bedrock, Vertex, Azure, Ollama, vLLM, …) with the
 * operator's own keys, budgets and fallbacks. The proxy implements the
 * Responses API (POST /v1/responses, streaming included), so like OrcaRouter
 * (server/src/orcarouter.ts) opting a model in is a base-URL swap: an agent
 * prefixes its `model` id with `litellm/`, e.g. `litellm/claude-sonnet-4-6`,
 * and the prefix is stripped before the id is sent to the proxy.
 *
 * Differences from the hosted gateways, because the proxy is self-hosted:
 *   - Opt-in is `LITELLM_BASE_URL`, not a key. A proxy started without a
 *     master key accepts any bearer, so `LITELLM_API_KEY` is optional.
 *   - The proxy reports each model's price and context window on
 *     `/model/info`; we load that into server/src/litellm-catalog.ts so the
 *     cost ledger and compaction thresholds use the real numbers.
 */
import OpenAI from 'openai'
import { env } from './env.js'
import { setLiteLLMCatalog, parseLiteLLMModelInfo, stripLiteLLMPrefix } from './litellm-catalog.js'
import { SDK_MAX_RETRIES, SDK_TIMEOUT_MS } from './llm-sdk-options.js'

export { isLiteLLMModel, stripLiteLLMPrefix } from './litellm-catalog.js'

/** Sent when LITELLM_API_KEY is unset. The OpenAI SDK reads OPENAI_API_KEY
 *  from the environment when `apiKey` is empty, which would hand the
 *  deployment's OpenAI key to the proxy — an explicit placeholder prevents
 *  that, and a proxy without a master key ignores the bearer anyway. */
const NO_KEY_PLACEHOLDER = 'no-key'

export function liteLLMConfigured(): boolean {
  return env.LITELLM_BASE_URL !== ''
}

/** `LITELLM_BASE_URL` accepts the proxy root with or without a trailing
 *  `/v1` (the LiteLLM docs show both). The SDK needs `/v1`; `/model/info`
 *  lives at the root. */
export function liteLLMRootURL(): string {
  return env.LITELLM_BASE_URL.replace(/\/+$/, '').replace(/\/v1$/, '')
}

let _litellmClient: OpenAI | null = null
/** Test-only override for the underlying LiteLLM client — lets unit tests
 *  assert the prefix-strip + forward logic without a running proxy.
 *  Production code never sets this. */
let testLiteLLMClientOverride: OpenAI | null = null
export function __setLiteLLMClientOverrideForTesting(client: OpenAI | null): void {
  testLiteLLMClientOverride = client
}
export function litellmClient(): OpenAI {
  if (testLiteLLMClientOverride) return testLiteLLMClientOverride
  if (!_litellmClient) {
    _litellmClient = new OpenAI({
      apiKey: env.LITELLM_API_KEY || NO_KEY_PLACEHOLDER,
      baseURL: `${liteLLMRootURL()}/v1`,
      maxRetries: SDK_MAX_RETRIES,
      timeout: SDK_TIMEOUT_MS,
    })
  }
  return _litellmClient
}

/** Route a single `responses.create` call to the LiteLLM proxy. The model
 *  prefix is stripped before the id is forwarded; everything else passes
 *  through untouched because the proxy speaks the Responses API natively.
 *  Also nudges a catalog refresh (no-op while the cached copy is fresh) so
 *  a model added to the proxy after boot gets priced without a restart. */
export function litellmResponsesCreate(
  args: { model?: string } & Record<string, unknown>,
  opts?: unknown,
): unknown {
  void refreshLiteLLMCatalog()
  const { model, ...rest } = args
  return litellmClient().responses.create(
    { ...rest, model: stripLiteLLMPrefix(model ?? '') } as never,
    opts as never,
  )
}

const CATALOG_TTL_MS = 10 * 60_000
const CATALOG_FETCH_TIMEOUT_MS = 10_000
let catalogFetchedAt = 0
let catalogInFlight: Promise<void> | null = null
let catalogFailureWarned = false

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
let fetchImpl: FetchLike = (url, init) => fetch(url, init)
/** Test-only: swap the HTTP layer and reset the refresh clock. */
export function __setLiteLLMCatalogFetchForTesting(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
  catalogFetchedAt = 0
  catalogInFlight = null
  catalogFailureWarned = false
}

/** Load `/model/info` into the catalog. Never throws: a proxy that's down or
 *  an older build without `/model/info` just leaves pricing on cost.ts's
 *  normal path. At most one request in flight, and a failed attempt waits
 *  out the same TTL so a dead proxy isn't hammered on every agent hop. */
export function refreshLiteLLMCatalog(): Promise<void> {
  if (!liteLLMConfigured()) return Promise.resolve()
  if (catalogInFlight) return catalogInFlight
  if (catalogFetchedAt && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) return Promise.resolve()
  catalogInFlight = (async () => {
    try {
      const headers: Record<string, string> = {}
      if (env.LITELLM_API_KEY) headers.Authorization = `Bearer ${env.LITELLM_API_KEY}`
      const res = await fetchImpl(`${liteLLMRootURL()}/model/info`, {
        headers,
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setLiteLLMCatalog(parseLiteLLMModelInfo(await res.json()))
      catalogFailureWarned = false
    } catch (err) {
      if (!catalogFailureWarned) {
        catalogFailureWarned = true
        console.warn('[litellm] could not load /model/info — litellm/* calls keep the default pricing and context window:', err instanceof Error ? err.message : err)
      }
    } finally {
      catalogFetchedAt = Date.now()
      catalogInFlight = null
    }
  })()
  return catalogInFlight
}
