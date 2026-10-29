/**
 * Atlas Cloud LLM provider — model-prefix routing, like OrcaRouter.
 *
 * Atlas Cloud (https://www.atlascloud.ai) is an OpenAI-compatible AI gateway
 * that also implements the Responses API (POST /v1/responses; checked live
 * with qwen/qwen3.7-plus and openai/gpt-5.4-mini).
 * That means opting a model in is a pure base-URL swap, not a translation: an
 * agent prefixes its `model` id with `atlascloud/`, e.g.
 * `atlascloud/qwen/qwen3.7-plus`, and the prefix is stripped before
 * the id is sent to Atlas Cloud. Nothing needs translating
 * between the Responses API and Chat Completions the way Novita does
 * (server/src/novita.ts) — the call is forwarded straight to the Atlas Cloud
 * client.
 *
 * Mirrors the Novita/OrcaRouter convention: `isAtlasCloudModel` gates the route in
 * llm.ts's `withProviderRouting`, and an unset key degrades to the tenant's
 * normal client instead of failing the run.
 */
import OpenAI from 'openai'
import { env } from './env.js'

export const ATLASCLOUD_MODEL_PREFIX = 'atlascloud/'

export function isAtlasCloudModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(ATLASCLOUD_MODEL_PREFIX)
}

export function stripAtlasCloudPrefix(model: string): string {
  return model.slice(ATLASCLOUD_MODEL_PREFIX.length)
}

let _atlascloudClient: OpenAI | null = null
/** Test-only override for the underlying AtlasCloud client — lets unit tests
 *  assert the prefix-strip + forward logic without a real ATLASCLOUD_API_KEY or
 *  network access. Production code never sets this. */
let testAtlasCloudClientOverride: OpenAI | null = null
export function __setAtlasCloudClientOverrideForTesting(client: OpenAI | null): void {
  testAtlasCloudClientOverride = client
}
export function atlascloudClient(): OpenAI {
  if (testAtlasCloudClientOverride) return testAtlasCloudClientOverride
  if (!_atlascloudClient) {
    _atlascloudClient = new OpenAI({
      apiKey: env.ATLASCLOUD_API_KEY,
      baseURL: env.ATLASCLOUD_BASE_URL,
    })
  }
  return _atlascloudClient
}

/** Route a single `responses.create` call to AtlasCloud. The model prefix is
 *  stripped before the id is forwarded; everything else passes through
 *  untouched because Atlas Cloud serves the Responses API. */
export function atlascloudResponsesCreate(
  args: { model?: string } & Record<string, unknown>,
  opts?: unknown,
): unknown {
  const { model, ...rest } = args
  return atlascloudClient().responses.create(
    { ...rest, model: stripAtlasCloudPrefix(model ?? '') } as never,
    opts as never,
  )
}
