/**
 * OrcaRouter LLM provider — model-prefix routing, like Novita but simpler.
 *
 * OrcaRouter (https://www.orcarouter.ai) is an OpenAI-compatible AI gateway
 * that also natively implements the Responses API (POST /v1/responses,
 * streaming included — verified live). That means opting a model in is a pure
 * base-URL swap, not a translation: an agent prefixes its `model` id with
 * `orcarouter/`, e.g. `orcarouter/openai/gpt-4o-mini`, and the prefix is
 * stripped before the id is sent to OrcaRouter. Nothing needs translating
 * between the Responses API and Chat Completions the way Novita does
 * (server/src/novita.ts) — OrcaRouter speaks Responses natively, so the call
 * is forwarded straight to the OrcaRouter client.
 *
 * Mirrors the Novita convention: `isOrcaRouterModel` gates the route in
 * llm.ts's `withProviderRouting`, and an unset key degrades to the tenant's
 * normal client instead of failing the run.
 */
import OpenAI from 'openai'
import { env } from './env.js'

export const ORCAROUTER_MODEL_PREFIX = 'orcarouter/'

export function isOrcaRouterModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(ORCAROUTER_MODEL_PREFIX)
}

export function stripOrcaRouterPrefix(model: string): string {
  return model.slice(ORCAROUTER_MODEL_PREFIX.length)
}

let _orcarouterClient: OpenAI | null = null
/** Test-only override for the underlying OrcaRouter client — lets unit tests
 *  assert the prefix-strip + forward logic without a real ORCAROUTER_API_KEY or
 *  network access. Production code never sets this. */
let testOrcaRouterClientOverride: OpenAI | null = null
export function __setOrcaRouterClientOverrideForTesting(client: OpenAI | null): void {
  testOrcaRouterClientOverride = client
}
export function orcarouterClient(): OpenAI {
  if (testOrcaRouterClientOverride) return testOrcaRouterClientOverride
  if (!_orcarouterClient) {
    _orcarouterClient = new OpenAI({
      apiKey: env.ORCAROUTER_API_KEY,
      baseURL: env.ORCAROUTER_BASE_URL,
    })
  }
  return _orcarouterClient
}

/** Route a single `responses.create` call to OrcaRouter. The model prefix is
 *  stripped before the id is forwarded; everything else passes through
 *  untouched because OrcaRouter speaks the Responses API natively. */
export function orcarouterResponsesCreate(
  args: { model?: string } & Record<string, unknown>,
  opts?: unknown,
): unknown {
  const { model, ...rest } = args
  return orcarouterClient().responses.create(
    { ...rest, model: stripOrcaRouterPrefix(model ?? '') } as never,
    opts as never,
  )
}
