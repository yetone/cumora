/**
 * OpenAI client factory — every server-side LLM call goes through here.
 *
 * Routing rules (tenant-aware):
 *
 *   1. If sub2api is configured AND we can resolve the tenant's owner
 *      → that owner's sub2api_api_key → OpenAI client pointed at the
 *      sub2api OpenAI-compatible base. Per-user quotas enforced.
 *
 *   2. Else (sub2api unconfigured, or new tenant without a provisioned
 *      key yet) → legacy single `env.OPENAI_API_KEY` client pointed at
 *      OpenAI directly. No quotas — same behavior as pre-sub2api.
 *
 * Callers pass `tenant` (= company_id). When `tenant` is null (e.g.
 * platform-wide tasks like the avatar regen of a seeded agent before
 * any workspace exists) we always use the legacy path.
 *
 * Per-tenant client cache: OpenAI client construction is cheap but we
 * call this on every LLM hop. Cache by tenant; invalidate explicitly
 * (e.g. tier change handler) via `invalidateLlmClient(tenant)`.
 *
 * Critical: failures resolving the sub2api key are NEVER fatal — we
 * fall back to the legacy client. A wedged sub2api lookup must not
 * take down agent turns.
 *
 * Provider routing (model-based, on top of the above): whichever client is
 * chosen by the tenant rules is wrapped by `withProviderRouting` before it's
 * returned. That wrapper inspects the `model` on each individual
 * `responses.create()` call — not the tenant — and reroutes calls whose
 * model carries a recognized provider prefix:
 *   - `novita/<model>`       → Novita's real Chat Completions API via
 *                              server/src/novita.ts's translation shim, since
 *                              Novita has no Responses API to swap a base URL
 *                              onto.
 *   - `orcarouter/<model>`   → OrcaRouter (https://www.orcarouter.ai) via a
 *                              pure base-URL swap (server/src/orcarouter.ts),
 *                              since OrcaRouter speaks the Responses API
 *                              natively — no translation needed.
 * Everything else about the returned client (chat.completions, images,
 * embeddings, non-prefixed responses.create calls) is the same object
 * callers already know.
 */
import OpenAI from 'openai'
import { pool } from './db/pool.js'
import { env } from './env.js'
import { isNovitaModel, novitaResponsesShim } from './novita.js'
import { isOrcaRouterModel, orcarouterResponsesCreate } from './orcarouter.js'
import { sub2apiConfigured, sub2apiOpenAIBaseURL } from './sub2api.js'

interface CachedClient {
  client: OpenAI
  /** What we built the client from — used for cheap invalidation. */
  key: string
  /** unix-ms when the cache entry was minted; expire after 5 min so a
   *  silent tier change / key rotation doesn't strand the cache forever
   *  even when the explicit invalidate path is missed. */
  mintedAt: number
}

const CACHE_TTL_MS = 5 * 60_000
const cache = new Map<string, CachedClient>()

/** Tolerance settings for both the sub2api-routed client AND the legacy
 *  fallback. Production has surfaced "all four agents 502'd at once →
 *  every run failed → fingerprint locks them out" sequences caused by
 *  brief upstream flakiness on sub2api / the model provider. The OpenAI
 *  SDK retries on 5xx + 408 + 429 + network errors out of the box, but
 *  its default ceiling (2) is too thin for the bursty 502 windows we
 *  see; 5 absorbs short outages without making the wall-clock pathological.
 *  Timeout is 5 min — model responses (especially with reasoning) can
 *  legitimately take a couple minutes; the SDK aborts and retries within
 *  this budget. */
const SDK_MAX_RETRIES = 5
const SDK_TIMEOUT_MS = 5 * 60_000

/** Test-only override. When set, every {@link getLlmClient} call returns
 *  whatever this function produces. Production code never sets this; it
 *  exists so integration tests can inject a fake OpenAI client whose
 *  `responses.create` returns crafted Responses-API event streams instead
 *  of round-tripping through sub2api / OpenAI. */
let testLlmOverride: ((tenant: string | null) => OpenAI | Promise<OpenAI>) | null = null
export function __setLlmClientOverrideForTesting(fn: typeof testLlmOverride): void {
  testLlmOverride = fn
}

/** Wrap a client so any call whose `model` carries a recognized provider
 *  prefix is routed to that provider instead of this client's own
 *  `responses.create`:
 *    - `novita/<model>`     → Novita (server/src/novita.ts), translated
 *                             through `novitaResponsesShim` so the caller sees
 *                             an ordinary Responses-API stream/return.
 *    - `orcarouter/<model>` → OrcaRouter (server/src/orcarouter.ts), a pure
 *                             base-URL swap — OrcaRouter speaks the Responses
 *                             API natively.
 *
 *  Model, not tenant, decides the provider: `getLlmClient` is resolved
 *  once per tenant/hop before the model for that specific call is even
 *  read off `args.model`, so routing has to happen at `.responses.create()`
 *  call time, not here. Every caller in this codebase reads only
 *  `client.responses.create(...)`, so wrapping just that property is a
 *  complete, minimal interception — everything else (chat.completions,
 *  images, embeddings) passes through to the real client untouched. */
let novitaUnconfiguredWarned = false
let orcarouterUnconfiguredWarned = false
/** One log line per provider, not one per call — this fires on every hop of
 *  every turn of an agent whose model names an unconfigured provider. */
function warnProviderUnconfiguredOnce(provider: 'Novita' | 'OrcaRouter', model: string | undefined): void {
  if (provider === 'Novita') {
    if (novitaUnconfiguredWarned) return
    novitaUnconfiguredWarned = true
    console.warn(`[llm] model "${model}" requests Novita but NOVITA_API_KEY is unset — using the tenant's normal client instead`)
    return
  }
  if (orcarouterUnconfiguredWarned) return
  orcarouterUnconfiguredWarned = true
  console.warn(`[llm] model "${model}" requests OrcaRouter but ORCAROUTER_API_KEY is unset — using the tenant's normal client instead`)
}

function withProviderRouting(client: OpenAI): OpenAI {
  return new Proxy(client, {
    get(target, prop, receiver): unknown {
      if (prop !== 'responses') return Reflect.get(target, prop, receiver)
      const real = target.responses
      return new Proxy(real, {
        get(rt, p, rr): unknown {
          if (p !== 'create') return Reflect.get(rt, p, rr)
          return (args: { model?: string } & Record<string, unknown>, opts?: unknown) => {
            if (isNovitaModel(args.model)) {
              // Route to Novita only when this deployment actually configured
              // a key — otherwise fall through to the tenant's normal client,
              // exactly as env.ts documents. Without this guard an unset key
              // sent the call to api.novita.ai with an empty bearer and the
              // agent died on an unexplained 401 instead of degrading.
              if (env.NOVITA_API_KEY) {
                return novitaResponsesShim.create(args as never, opts as never)
              }
              warnProviderUnconfiguredOnce('Novita', args.model)
            } else if (isOrcaRouterModel(args.model)) {
              // Same degrade-not-die guard for OrcaRouter: an unset key must
              // fall through to the tenant's normal client, not send a bare
              // bearer to api.orcarouter.ai.
              if (env.ORCAROUTER_API_KEY) {
                return orcarouterResponsesCreate(args, opts)
              }
              warnProviderUnconfiguredOnce('OrcaRouter', args.model)
            }
            return (real.create as (a: unknown, o?: unknown) => unknown)(args, opts)
          }
        },
      })
    },
  })
}

/** Build (and cache) the OpenAI client for this tenant. Async because
 *  resolving the tenant's owner_user_id + sub2api_api_key is a DB hop.
 *  Always returns a working client — never throws on lookup failure. */
export async function getLlmClient(tenant: string | null): Promise<OpenAI> {
  if (testLlmOverride) return testLlmOverride(tenant)
  // No tenant context → legacy.
  if (!tenant || !sub2apiConfigured()) return withProviderRouting(legacyClient())

  const cached = cache.get(tenant)
  if (cached && Date.now() - cached.mintedAt < CACHE_TTL_MS) {
    return withProviderRouting(cached.client)
  }

  try {
    const { rows } = await pool.query<{ sub2api_api_key: string | null }>(
      `SELECT u.sub2api_api_key
         FROM companies c
         JOIN users u ON u.id = c.owner_user_id
        WHERE c.id = $1`,
      [tenant],
    )
    const apiKey = rows[0]?.sub2api_api_key
    if (!apiKey) {
      // Tenant exists but owner hasn't been provisioned in sub2api yet.
      // Cache the legacy fallback briefly so we don't re-query on every
      // hop, but with a short TTL so the next backfill picks up quickly.
      const c = legacyClient()
      cache.set(tenant, { client: c, key: 'legacy', mintedAt: Date.now() })
      return withProviderRouting(c)
    }
    const c = new OpenAI({
      apiKey,
      baseURL: sub2apiOpenAIBaseURL(),
      maxRetries: SDK_MAX_RETRIES,
      timeout: SDK_TIMEOUT_MS,
    })
    cache.set(tenant, { client: c, key: apiKey, mintedAt: Date.now() })
    return withProviderRouting(c)
  } catch (e) {
    console.warn(`[llm] tenant ${tenant} client lookup failed; legacy fallback`, e instanceof Error ? e.message : e)
    return withProviderRouting(legacyClient())
  }
}

/** Drop a tenant's cached client. Call from tier-change handlers so the
 *  next LLM hop picks up the swapped key / group. */
export function invalidateLlmClient(tenant: string): void {
  cache.delete(tenant)
}

let _legacy: OpenAI | null = null
function legacyClient(): OpenAI {
  if (!_legacy) _legacy = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    maxRetries: SDK_MAX_RETRIES,
    timeout: SDK_TIMEOUT_MS,
  })
  return _legacy
}
