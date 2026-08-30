/**
 * Novita LLM API provider — translation adapter, NOT a base-URL swap.
 *
 * Novita's public LLM surface is OpenAI-compatible ONLY at the Chat
 * Completions layer (`POST /openai/v1/chat/completions`). It has no
 * Responses API (`/v1/responses`) equivalent. Every call site in this
 * codebase (turn.ts's streaming hops, convene.ts, agenda.ts, inbox-triage.ts,
 * ...) is written against `client.responses.create(...)` — Responses-shaped
 * request params, Responses-shaped streaming events (`response.created`,
 * `response.output_text.delta`, `response.function_call_arguments.delta/done`,
 * `response.completed`), and `Response.output_text` / `.output` on the
 * synchronous return. Pointing an `OpenAI` SDK client's `baseURL` at Novita
 * would NOT make any of that work — the SDK would call `POST /responses`
 * against a host that doesn't implement it.
 *
 * This module bridges the gap: it accepts Responses-API-shaped request
 * params, translates them into Chat Completions params, calls Novita's real
 * `chat.completions.create`, and translates the result (streaming or not)
 * back into the exact Responses-API shapes every existing call site already
 * expects. Nothing outside `llm.ts` needs to change — see `withProviderRouting`
 * there for how a per-call `model` id opts into this path.
 *
 * Model selection convention: an agent (or an env default) opts into Novita
 * by prefixing its `model` with `novita/`, e.g. `novita/deepseek/deepseek-v3.2`.
 * The prefix is stripped before the model id is sent to Novita.
 */
import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions'
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses'
import { env } from './env.js'

export const NOVITA_MODEL_PREFIX = 'novita/'

export function isNovitaModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith(NOVITA_MODEL_PREFIX)
}

export function stripNovitaPrefix(model: string): string {
  return model.slice(NOVITA_MODEL_PREFIX.length)
}

let _novitaClient: OpenAI | null = null
/** Test-only override for the underlying Novita client — lets unit tests
 *  exercise the translation logic (toChatMessages / streaming / usage
 *  mapping) against a fake `chat.completions.create` without a real
 *  NOVITA_API_KEY or network access. Production code never sets this. */
let testNovitaClientOverride: OpenAI | null = null
export function __setNovitaClientOverrideForTesting(client: OpenAI | null): void {
  testNovitaClientOverride = client
}
function novitaClient(): OpenAI {
  if (testNovitaClientOverride) return testNovitaClientOverride
  if (!_novitaClient) {
    _novitaClient = new OpenAI({
      apiKey: env.NOVITA_API_KEY,
      baseURL: env.NOVITA_BASE_URL,
    })
  }
  return _novitaClient
}

/** Loose shape covering every field the existing call sites actually pass
 *  to `client.responses.create(...)`. We don't import the SDK's own params
 *  types here because several call sites (e.g. `verifyTerminalCompletion`)
 *  smuggle `signal` into the body via an `as unknown as` cast, which the
 *  real SDK types don't model — so a loose shape is the honest contract. */
interface ResponsesCreateArgs {
  model: string
  instructions?: string | null
  input?: string | ResponseInputItem[]
  tools?: FunctionTool[]
  tool_choice?: unknown
  reasoning?: { effort?: string | null } | null
  max_output_tokens?: number | null
  stream?: boolean
  text?: { format?: { type?: string } }
  signal?: AbortSignal | null
}

interface RequestOpts {
  signal?: AbortSignal | null
  maxRetries?: number
  timeout?: number
  [key: string]: unknown
}

/** Build the per-call request options object passed to the underlying SDK's
 *  `chat.completions.create(body, options)`. Every failed live smoke against
 *  this shim (QA's `APIConnectionTimeoutError`) traced back to this line:
 *  the SDK's `buildRequest` guards `timeout` with `if ('timeout' in options)`
 *  — not a nullish check — so `{ timeout: opts?.timeout }` with `opts`
 *  omitted still puts a `timeout: undefined` KEY on the object, which trips
 *  `validatePositiveInteger('timeout', undefined)` and throws `OpenAIError:
 *  timeout must be an integer` before any request is ever sent. That thrown
 *  error then classifies as a connection failure upstream in turn.ts, which
 *  is why it surfaced as a timeout instead of a type error. Only set a key
 *  when its value is actually present. */
function toRequestOptions(args: ResponsesCreateArgs, opts?: RequestOpts): RequestOpts {
  const options: RequestOpts = {}
  const signal = opts?.signal ?? args.signal
  if (signal != null) options.signal = signal
  if (opts?.maxRetries != null) options.maxRetries = opts.maxRetries
  if (opts?.timeout != null) options.timeout = opts.timeout
  return options
}

function toChatTools(tools: FunctionTool[] | undefined): ChatCompletionFunctionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? undefined,
      parameters: t.parameters ?? undefined,
    },
  }))
}

/** Translate Responses-API `input` items into Chat Completions messages.
 *
 *  The two API shapes disagree on where a tool call lives: Responses spreads
 *  the assistant's text and each function call across separate flat items;
 *  Chat Completions bundles every tool call from one turn into the SAME
 *  assistant message's `tool_calls` array, with `role:'tool'` messages
 *  following for each output. `turn.ts` always pushes a hop's function_call
 *  items back-to-back, then its function_call_output items back-to-back
 *  (`history.push(...assistantOutputItems, ...outs)`), so buffering
 *  consecutive function_call items into one assistant message and flushing
 *  on the next non-function_call item reconstructs the Chat Completions
 *  shape losslessly for every input this codebase actually produces. */
function toChatMessages(
  instructions: string | null | undefined,
  input: string | ResponseInputItem[] | undefined,
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = []
  if (instructions) messages.push({ role: 'system', content: instructions })
  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input })
    return messages
  }
  if (!input) return messages

  let pendingCalls: Array<{ id: string; name: string; arguments: string }> = []
  const flushPendingCalls = (): void => {
    if (pendingCalls.length === 0) return
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    })
    pendingCalls = []
  }

  for (const raw of input) {
    const item = raw as unknown as Record<string, unknown>
    const type = String(item.type ?? 'message')
    if (type === 'function_call') {
      pendingCalls.push({
        id: String(item.call_id ?? item.id ?? ''),
        name: String(item.name ?? ''),
        arguments: String(item.arguments ?? ''),
      })
      continue
    }
    flushPendingCalls()
    if (type === 'function_call_output') {
      const output = item.output
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      } as ChatCompletionToolMessageParam)
      continue
    }
    // A message item: role + string or content-part-array content.
    const role = String(item.role ?? 'user')
    const chatRole = role === 'assistant' ? 'assistant' : role === 'system' || role === 'developer' ? 'system' : 'user'
    const content = item.content
    if (typeof content === 'string') {
      messages.push({ role: chatRole, content } as ChatCompletionMessageParam)
      continue
    }
    if (Array.isArray(content)) {
      const parts = content
        .map((c) => c as Record<string, unknown>)
        .map((c) => {
          const cType = String(c.type ?? '')
          if (cType === 'input_image') {
            return {
              type: 'image_url' as const,
              image_url: { url: String(c.image_url ?? ''), detail: (c.detail as 'auto' | 'low' | 'high' | undefined) ?? 'auto' },
            }
          }
          // input_text / output_text / anything else text-shaped.
          return { type: 'text' as const, text: String(c.text ?? '') }
        })
      messages.push({ role: chatRole, content: parts } as ChatCompletionMessageParam)
      continue
    }
  }
  flushPendingCalls()
  return messages
}

/** Chat Completions `usage` (prompt_tokens/completion_tokens) → the Responses
 *  API's `ResponseUsage` shape (input_tokens/output_tokens), so downstream
 *  readers (`usageFromOpenAI`, `readStreamReasoningTokens`, `turn-stream.ts`)
 *  work unchanged. */
function toResponseUsage(raw: unknown): Record<string, unknown> | null {
  const u = raw as {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null | undefined
  if (!u) return null
  return {
    input_tokens: u.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? 0,
  }
}

/** Build the Chat Completions request body from Responses-API args.
 *
 *  Known gap, called out explicitly per the task ask ("don't assume base-URL
 *  swap = compatible"): Novita's documented Chat Completions params do not
 *  include `tool_choice` — only `tools` ("currently, only functions are
 *  supported as a tool"). Chat Completions itself defaults `tool_choice` to
 *  `'auto'` whenever `tools` is non-empty, matching the ONLY value every
 *  call site in this repo ever passes (`tool_choice: 'auto'`), so we
 *  deliberately drop the field rather than forward a param Novita doesn't
 *  document — sending an unsupported field risks a hard 4xx instead of a
 *  silent default. `reasoning.effort` has no Chat Completions equivalent
 *  either (Novita's reasoning knobs — `separate_reasoning`, `enable_thinking`
 *  — are model-specific and orthogonal); we drop it rather than guess. */
function buildChatBody(args: ResponsesCreateArgs, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: stripNovitaPrefix(args.model),
    messages: toChatMessages(args.instructions, args.input),
    stream,
  }
  const tools = toChatTools(args.tools)
  if (tools) body.tools = tools
  if (args.max_output_tokens != null) body.max_tokens = args.max_output_tokens
  if (args.text?.format?.type === 'json_object') body.response_format = { type: 'json_object' }
  if (stream) body.stream_options = { include_usage: true }
  return body
}

/** Non-streaming call. Every non-streaming Responses-shaped call site reads
 *  `r.output_text` (and nothing else off the return besides `.usage` via
 *  `getTrackedLlmClient`'s wrapper) — so translating just that + `.usage`
 *  covers convene.ts / agenda.ts / inbox-triage.ts / router.ts / etc. in
 *  full. */
async function createNonStreaming(args: ResponsesCreateArgs, opts?: RequestOpts): Promise<Record<string, unknown>> {
  const body = buildChatBody(args, false)
  const completion = await novitaClient().chat.completions.create(
    body as unknown as Parameters<OpenAI['chat']['completions']['create']>[0] & { stream?: false },
    toRequestOptions(args, opts),
  )
  const choice = completion.choices[0]
  const outputText = choice?.message?.content ?? ''
  const toolCalls = (choice?.message?.tool_calls ?? []).filter(
    (tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === 'function',
  )
  const output = toolCalls.length > 0
    ? toolCalls.map((tc) => ({
        type: 'function_call' as const,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
    : outputText
      ? [{ type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text: outputText }] }]
      : []
  return {
    id: completion.id,
    output_text: outputText,
    output,
    usage: toResponseUsage(completion.usage),
    status: 'completed',
  }
}

/** Streaming call — translates `ChatCompletionChunk`s into the exact
 *  `ResponseStreamEvent` sequence `turn-stream.ts`'s reducer expects:
 *  `response.created` → `response.output_text.delta`* →
 *  `response.output_item.added` + `response.function_call_arguments.delta`*
 *  (one per tool call) → `response.completed`. This is the ONLY event
 *  sequence turn.ts's hop loop and `applyResponseStreamEvent` consume; every
 *  other Responses event type is unused by this codebase (confirmed by
 *  reading turn-stream.ts's reducer), so it's the full translation surface
 *  needed, not a partial shim. */
async function* createStreaming(
  args: ResponsesCreateArgs,
  opts?: RequestOpts,
): AsyncGenerator<ResponseStreamEvent> {
  const body = buildChatBody(args, true)
  const stream = await novitaClient().chat.completions.create(
    body as unknown as Parameters<OpenAI['chat']['completions']['create']>[0] & { stream: true },
    toRequestOptions(args, opts),
  )

  const responseId = `novita-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  yield {
    type: 'response.created',
    sequence_number: 0,
    response: { id: responseId, status: 'in_progress' },
  } as unknown as ResponseStreamEvent

  const itemId = `${responseId}-msg`
  let textEmitted = false
  // Keyed by tool_call index — Chat Completions streams tool-call argument
  // deltas by array index, not a stable id (the id itself may only appear
  // on the first delta for that index).
  const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>()
  let usage: unknown = null
  let seq = 1

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    if (chunk.usage) usage = chunk.usage
    const delta = chunk.choices?.[0]?.delta
    if (!delta) continue
    if (delta.content) {
      textEmitted = true
      yield {
        type: 'response.output_text.delta',
        item_id: itemId,
        content_index: 0,
        delta: delta.content,
        sequence_number: seq++,
      } as unknown as ResponseStreamEvent
    }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index
      let entry = toolCallsByIndex.get(idx)
      if (!entry) {
        entry = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', arguments: '' }
        toolCallsByIndex.set(idx, entry)
        yield {
          type: 'response.output_item.added',
          output_index: idx,
          sequence_number: seq++,
          item: {
            type: 'function_call',
            id: `${responseId}-fc-${idx}`,
            call_id: entry.id,
            name: entry.name,
            arguments: '',
          },
        } as unknown as ResponseStreamEvent
      }
      if (tc.function?.arguments) {
        entry.arguments += tc.function.arguments
        yield {
          type: 'response.function_call_arguments.delta',
          item_id: `${responseId}-fc-${idx}`,
          output_index: idx,
          delta: tc.function.arguments,
          sequence_number: seq++,
        } as unknown as ResponseStreamEvent
      }
    }
  }

  for (const [idx, entry] of toolCallsByIndex) {
    yield {
      type: 'response.function_call_arguments.done',
      item_id: `${responseId}-fc-${idx}`,
      output_index: idx,
      name: entry.name,
      arguments: entry.arguments,
      sequence_number: seq++,
    } as unknown as ResponseStreamEvent
  }

  const output: unknown[] = []
  if (textEmitted) {
    output.push({ type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [] })
  }
  for (const [idx, entry] of toolCallsByIndex) {
    output.push({
      type: 'function_call',
      id: `${responseId}-fc-${idx}`,
      call_id: entry.id,
      name: entry.name,
      arguments: entry.arguments,
    })
  }

  yield {
    type: 'response.completed',
    sequence_number: seq++,
    response: {
      id: responseId,
      status: 'completed',
      output,
      usage: toResponseUsage(usage),
    },
  } as unknown as ResponseStreamEvent
}

/** A `Stream<ResponseStreamEvent>`-shaped async iterable. Every consumer in
 *  this codebase only uses `for await` / `consumeResponseStream`'s
 *  `stream[Symbol.asyncIterator]()` — never `Stream`'s other methods
 *  (`.tee()`, `.toReadableStream()`) — so a bare async-iterable object
 *  satisfies every real usage without depending on the SDK's internal
 *  `Stream` class. `controller.abort()` is wired so `turn-stream.ts`'s
 *  idle/wall timeout abort path (`abortStream`) has something to call. */
function wrapAsyncIterable(gen: AsyncGenerator<ResponseStreamEvent>): AsyncIterable<ResponseStreamEvent> & { controller: AbortController } {
  const controller = new AbortController()
  return {
    controller,
    [Symbol.asyncIterator]() {
      return gen
    },
  }
}

/** The Responses-API-shaped surface every call site actually uses off a
 *  client: `client.responses.create(...)`. Assigning this object as
 *  `client.responses` (see `withProviderRouting` in llm.ts) is sufficient —
 *  nothing in this codebase touches any other `client.responses.*` method. */
export const novitaResponsesShim = {
  create(args: ResponsesCreateArgs, opts?: RequestOpts): unknown {
    if (args.stream) {
      return Promise.resolve(wrapAsyncIterable(createStreaming(args, opts)))
    }
    return createNonStreaming(args, opts)
  },
}
