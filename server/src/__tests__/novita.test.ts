/**
 * Unit tests for the Novita Chat-Completions ↔ Responses-API translation
 * adapter (server/src/novita.ts). No network access: `chat.completions.create`
 * is stubbed via `__setNovitaClientOverrideForTesting` so these tests assert
 * only the translation logic, not live Novita behavior (that's QA's job with
 * a real NOVITA_API_KEY).
 *
 * Run: node --import tsx --test server/src/__tests__/novita.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type OpenAI from 'openai'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses'
import { applyResponseStreamEvent, consumeResponseStream, newResponseStreamState } from '../agents/turn-stream.js'
import {
  __setNovitaClientOverrideForTesting,
  isNovitaModel,
  novitaResponsesShim,
  stripNovitaPrefix,
} from '../novita.js'

function fakeClient(create: (...args: unknown[]) => unknown): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI
}

async function* asAsync<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

test('isNovitaModel / stripNovitaPrefix', () => {
  assert.equal(isNovitaModel('novita/deepseek/deepseek-v3.2'), true)
  assert.equal(isNovitaModel('gpt-5.5'), false)
  assert.equal(isNovitaModel(null), false)
  assert.equal(isNovitaModel(undefined), false)
  assert.equal(stripNovitaPrefix('novita/deepseek/deepseek-v3.2'), 'deepseek/deepseek-v3.2')
})

test('non-streaming: translates instructions+input to system+user messages, tools to nested function shape, drops tool_choice/reasoning', async () => {
  let capturedBody: Record<string, unknown> = {}
  __setNovitaClientOverrideForTesting(fakeClient(async (args: unknown) => {
    const body = args as Record<string, unknown>
    capturedBody = body
    return {
      id: 'chatcmpl-1',
      choices: [{ message: { role: 'assistant', content: 'hello there', tool_calls: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
  }))
  try {
    const r = await novitaResponsesShim.create({
      model: 'novita/deepseek/deepseek-v3.2',
      instructions: 'be terse',
      input: 'hi',
      tools: [{ type: 'function', name: 'bash', parameters: { type: 'object' }, strict: true, description: 'run a shell command' }],
      tool_choice: 'auto',
      reasoning: { effort: 'low' },
      max_output_tokens: 500,
    } as never) as { output_text: string; usage: unknown }
    assert.equal(r.output_text, 'hello there')
    assert.deepEqual(r.usage, {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    })
    // Model prefix stripped before hitting Novita.
    assert.equal(capturedBody.model, 'deepseek/deepseek-v3.2')
    assert.deepEqual(capturedBody.messages, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ])
    assert.deepEqual(capturedBody.tools, [
      { type: 'function', function: { name: 'bash', description: 'run a shell command', parameters: { type: 'object' } } },
    ])
    assert.equal(capturedBody.max_tokens, 500)
    // Explicitly NOT forwarded — undocumented on Novita's Chat Completions.
    assert.equal('tool_choice' in capturedBody, false)
    assert.equal('reasoning' in capturedBody, false)
  } finally {
    __setNovitaClientOverrideForTesting(null)
  }
})

test('non-streaming: a tool-call response maps to Responses-shaped function_call output items', async () => {
  __setNovitaClientOverrideForTesting(fakeClient(async () => ({
    id: 'chatcmpl-2',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })))
  try {
    const r = await novitaResponsesShim.create({
      model: 'novita/glm/glm-4.6',
      input: [{ role: 'user', content: 'list files' } as unknown as ResponseInputItem],
    } as never) as { output: Array<{ type: string; call_id: string; name: string; arguments: string }> }
    assert.equal(r.output.length, 1)
    assert.equal(r.output[0].type, 'function_call')
    assert.equal(r.output[0].call_id, 'call_abc')
    assert.equal(r.output[0].name, 'bash')
    assert.equal(r.output[0].arguments, '{"cmd":"ls"}')
  } finally {
    __setNovitaClientOverrideForTesting(null)
  }
})

test('input translation: consecutive function_call items bundle into ONE assistant message with tool_calls; function_call_output becomes role=tool', async () => {
  let capturedMessages: unknown[] = []
  __setNovitaClientOverrideForTesting(fakeClient(async (args: unknown) => {
    const body = args as Record<string, unknown>
    capturedMessages = body.messages as unknown[]
    return { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }], usage: null }
  }))
  try {
    await novitaResponsesShim.create({
      model: 'novita/foo/bar',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'do two things' }] } as unknown as ResponseInputItem,
        { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"cmd":"a"}' } as unknown as ResponseInputItem,
        { type: 'function_call', call_id: 'call_2', name: 'bash', arguments: '{"cmd":"b"}' } as unknown as ResponseInputItem,
        { type: 'function_call_output', call_id: 'call_1', output: 'out-a' } as unknown as ResponseInputItem,
        { type: 'function_call_output', call_id: 'call_2', output: 'out-b' } as unknown as ResponseInputItem,
      ],
    } as never)
    assert.equal(capturedMessages.length, 4)
    assert.deepEqual(capturedMessages[0], { role: 'user', content: [{ type: 'text', text: 'do two things' }] })
    const assistantMsg = capturedMessages[1] as { role: string; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
    assert.equal(assistantMsg.role, 'assistant')
    assert.equal(assistantMsg.tool_calls.length, 2)
    assert.equal(assistantMsg.tool_calls[0].id, 'call_1')
    assert.equal(assistantMsg.tool_calls[0].function.arguments, '{"cmd":"a"}')
    assert.equal(assistantMsg.tool_calls[1].id, 'call_2')
    assert.deepEqual(capturedMessages[2], { role: 'tool', tool_call_id: 'call_1', content: 'out-a' })
    assert.deepEqual(capturedMessages[3], { role: 'tool', tool_call_id: 'call_2', content: 'out-b' })
  } finally {
    __setNovitaClientOverrideForTesting(null)
  }
})

test('streaming: text-only reply produces created → output_text.delta* → completed, consumable by the real turn-stream reducer', async () => {
  const chunks: ChatCompletionChunk[] = [
    { id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] } as unknown as ChatCompletionChunk,
    { id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] } as unknown as ChatCompletionChunk,
    { id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } as unknown as ChatCompletionChunk,
  ]
  __setNovitaClientOverrideForTesting(fakeClient(async () => asAsync(chunks)))
  try {
    const stream = await novitaResponsesShim.create({
      model: 'novita/deepseek/deepseek-v3.2',
      input: 'hi',
      stream: true,
    } as never) as AsyncIterable<ResponseStreamEvent>

    const events: ResponseStreamEvent[] = []
    for await (const ev of stream) events.push(ev)
    assert.equal(events[0].type, 'response.created')
    assert.equal(events.filter((e) => e.type === 'response.output_text.delta').length, 2)
    const last = events[events.length - 1]
    assert.equal(last.type, 'response.completed')

    // Feed straight through the PRODUCTION reducer — proves turn.ts's real
    // consumption path (no code changes there) understands these events.
    const state = newResponseStreamState()
    for (const ev of events) applyResponseStreamEvent(state, ev)
    assert.equal(Array.from(state.responseTextByPart.values()).join(''), 'Hello')
    assert.equal(state.responseStatus, 'completed')
    assert.equal(state.totalTokens, 5)
    assert.deepEqual(state.pendingTools, {})
  } finally {
    __setNovitaClientOverrideForTesting(null)
  }
})

test('streaming: tool-call reply produces output_item.added + function_call_arguments.delta/done, reducible to pendingTools', async () => {
  const chunks: ChatCompletionChunk[] = [
    {
      id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_xyz', function: { name: 'bash', arguments: '' } }] }, finish_reason: null }],
    } as unknown as ChatCompletionChunk,
    {
      id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }, finish_reason: null }],
    } as unknown as ChatCompletionChunk,
    {
      id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }],
    } as unknown as ChatCompletionChunk,
    {
      id: 'c1', created: 0, model: 'x', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
    } as unknown as ChatCompletionChunk,
  ]
  __setNovitaClientOverrideForTesting(fakeClient(async () => asAsync(chunks)))
  try {
    const stream = await novitaResponsesShim.create({
      model: 'novita/qwen/qwen3-max',
      input: 'list files',
      tools: [{ type: 'function', name: 'bash', parameters: {}, strict: true }],
      stream: true,
    } as never) as AsyncIterable<ResponseStreamEvent>

    const state = newResponseStreamState()
    await consumeResponseStream(stream, (ev) => applyResponseStreamEvent(state, ev))

    const tools = Object.values(state.pendingTools)
    assert.equal(tools.length, 1)
    assert.equal(tools[0].call_id, 'call_xyz')
    assert.equal(tools[0].name, 'bash')
    assert.equal(tools[0].arguments, '{"cmd":"ls"}')
    assert.equal(state.responseStatus, 'completed')
    assert.equal(state.totalTokens, 10)
  } finally {
    __setNovitaClientOverrideForTesting(null)
  }
})
