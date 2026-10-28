/**
 * Cheaper Inference LLM provider — model-prefix routing, like OrcaRouter.
 *
 * Cheaper Inference (https://cheaperinference.com) is an OpenAI-compatible
 * LLM gateway that also natively implements the Responses API (POST
 * /v1/responses, streaming included — verified live). That means opting a
 * model in is a pure base-URL swap, not a translation: an agent prefixes its
 * `model` id with `cheaperinference/`, e.g. `cheaperinference/gpt-5.4-mini`,
 * and the prefix is stripped before the id is sent to Cheaper Inference.
 * Its model ids are bare (`gpt-5.4-mini`, `claude-sonnet-5`), so what is left
 * after the prefix is the id the gateway expects.
 *
 * Mirrors the OrcaRouter convention (server/src/orcarouter.ts):
 * `isCheaperInferenceModel` gates the route in llm.ts's
 * `withProviderRouting`, and an unset key degrades to the tenant's normal
 * client instead of failing the run.
 */
import OpenAI from 'openai'
import { env } from './env.js'

export const CHEAPERINFERENCE_MODEL_PREFIX = 'cheaperinference/'

export function isCheaperInferenceModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(CHEAPERINFERENCE_MODEL_PREFIX)
}

export function stripCheaperInferencePrefix(model: string): string {
  return model.slice(CHEAPERINFERENCE_MODEL_PREFIX.length)
}

let _cheaperinferenceClient: OpenAI | null = null
/** Test-only override for the underlying Cheaper Inference client — lets unit
 *  tests assert the prefix-strip + forward logic without a real
 *  CHEAPER_INFERENCE_API_KEY or network access. Production code never sets
 *  this. */
let testCheaperInferenceClientOverride: OpenAI | null = null
export function __setCheaperInferenceClientOverrideForTesting(client: OpenAI | null): void {
  testCheaperInferenceClientOverride = client
}
export function cheaperinferenceClient(): OpenAI {
  if (testCheaperInferenceClientOverride) return testCheaperInferenceClientOverride
  if (!_cheaperinferenceClient) {
    _cheaperinferenceClient = new OpenAI({
      apiKey: env.CHEAPER_INFERENCE_API_KEY,
      baseURL: env.CHEAPER_INFERENCE_BASE_URL,
    })
  }
  return _cheaperinferenceClient
}

/** Route a single `responses.create` call to Cheaper Inference. The model
 *  prefix is stripped before the id is forwarded; everything else passes
 *  through untouched because Cheaper Inference speaks the Responses API
 *  natively. */
export function cheaperinferenceResponsesCreate(
  args: { model?: string } & Record<string, unknown>,
  opts?: unknown,
): unknown {
  const { model, ...rest } = args
  return cheaperinferenceClient().responses.create(
    { ...rest, model: stripCheaperInferencePrefix(model ?? '') } as never,
    opts as never,
  )
}
