import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { compileFunction } from 'node:vm'
import ts from 'typescript'
import { create } from 'zustand'
import type { ApiMessage } from '../src/api/client'
import { applyReplyCountDelta } from '../src/lib/replyCount'
import type { Message } from '../src/types'

// Execute the actual store with an in-memory API, without loading the browser
// client's Vite environment or auth persistence. Each test gets a fresh store.
const source = readFileSync(new URL('../src/stores/messages.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
})
const loadStore = compileFunction(outputText, ['require', 'exports', 'console'])

function messages(first: number, last: number): ApiMessage[] {
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const sequence = first + index
    return {
      id: `m-${sequence}`, conversationId: 'chat', authorId: 'user',
      kind: 'text', body: String(sequence), at: '12:00', sequence,
    }
  })
}

function setup(last: number, cache: Message[] = messages(1, 80)) {
  const requests: { before?: number; limit?: number }[] = []
  const serverMessages = messages(1, last)
  const api = {
    async getMessages(_id: string, options: { before?: number; limit?: number }) {
      requests.push(options)
      return serverMessages.filter((m) => options.before === undefined || m.sequence < options.before)
        .slice(-(options.limit ?? 80))
    },
  }
  const dependencies: Record<string, unknown> = {
    zustand: { create },
    '@/api/client': { api },
    '@/lib/replyCount': { applyReplyCountDelta },
    '@/stores/auth': { getMeId: () => 'user' },
    '@/stores/app': { useApp: { getState: () => ({ selectedConversationId: 'chat' }) } },
  }
  const exports = {} as typeof import('../src/stores/messages')
  loadStore((name: string) => {
    assert.ok(name in dependencies, `Unexpected store dependency: ${name}`)
    return dependencies[name]
  }, exports, { ...console, warn() {} })
  const store = exports.useMessages
  store.setState({
    byConvo: { chat: cache },
    hasMoreOlder: { chat: false },
    firstItemIndex: { chat: exports.VIRTUOSO_FIRST_INDEX_BASE },
  })
  const sequences = () => store.getState().byConvo.chat.map((m) => (m as ApiMessage).sequence)
  return { store, api, requests, sequences }
}

describe('message history after reconnect', () => {
  for (const method of ['reloadConversation', 'loadConversation'] as const) {
    describe(method, () => {
      for (const [last, cursors] of [
        [100, [undefined]],
        [160, [undefined, 81]],
        [200, [undefined, 121]],
        [400, [undefined, 321, 241, 161, 81]],
      ] as const) {
        it(`fills cached 1–80 through ${last} without gaps or duplicates`, async () => {
          const { store, requests, sequences } = setup(last)
          const anchor = store.getState().firstItemIndex.chat
          await store.getState()[method]('chat')

          assert.deepEqual(sequences(), messages(1, last).map((m) => m.sequence))
          assert.deepEqual(requests.map((r) => r.before), [...cursors])
          assert.ok(requests.every((r) => r.limit === 80))
          assert.equal(store.getState().firstItemIndex.chat, anchor)
          assert.equal(store.getState().loaded.has('chat'), true)
        })
      }

      it('fetches only the latest page for an empty cache', async () => {
        const { store, requests, sequences } = setup(200, [])
        await store.getState()[method]('chat')
        assert.deepEqual(sequences(), messages(121, 200).map((m) => m.sequence))
        assert.equal(requests.length, 1)
      })

      it('ignores optimistic sequences when choosing the backfill boundary', async () => {
        const optimistic = { ...messages(1, 1)[0], id: 'temp', sequence: Number.MAX_SAFE_INTEGER, pending: true }
        const { store, sequences } = setup(200, [...messages(1, 80), optimistic])
        await store.getState()[method]('chat')
        assert.deepEqual(sequences(), [...messages(1, 200).map((m) => m.sequence), Number.MAX_SAFE_INTEGER])
        assert.equal(store.getState().byConvo.chat.at(-1), optimistic)
      })

      it('keeps the cache intact on a failed backfill and fills the gap on retry', async () => {
        const { store, api, sequences } = setup(200)
        const originalCache = store.getState().byConvo.chat
        const getMessages = api.getMessages
        api.getMessages = async (id, options) => {
          if (options.before !== undefined) throw new Error('offline')
          return getMessages(id, options)
        }
        await store.getState()[method]('chat')
        assert.equal(store.getState().byConvo.chat, originalCache)
        assert.equal(store.getState().loading.has('chat'), false)

        api.getMessages = getMessages
        await store.getState()[method]('chat')
        assert.deepEqual(sequences(), messages(1, 200).map((m) => m.sequence))
      })
    })
  }

  it('preserves messages received while the backfill request is in flight', async () => {
    const { store, api, sequences } = setup(200)
    const getMessages = api.getMessages
    let finishPage!: (page: ApiMessage[]) => void
    let backfillStarted!: () => void
    const started = new Promise<void>((resolve) => { backfillStarted = resolve })
    api.getMessages = async (id, options) => {
      if (options.before === undefined) return getMessages(id, options)
      backfillStarted()
      return new Promise<ApiMessage[]>((resolve) => { finishPage = resolve })
    }
    const reload = store.getState().reloadConversation('chat')
    await Promise.race([
      started,
      reload.then(() => { throw new Error('Reload completed without fetching the missing page') }),
    ])
    assert.deepEqual(sequences(), messages(1, 80).map((m) => m.sequence))
    store.getState().applyEvent({ type: 'message.new', conversationId: 'chat', message: messages(201, 201)[0] })
    finishPage(messages(41, 120))
    await reload
    assert.deepEqual(sequences(), messages(1, 201).map((m) => m.sequence))
  })

  it('leaves older history and its scroll anchor to loadOlder', async () => {
    const { store, requests, sequences } = setup(280, messages(81, 160))
    store.setState({ hasMoreOlder: { chat: true } })
    const anchor = store.getState().firstItemIndex.chat
    await store.getState().reloadConversation('chat')
    assert.deepEqual(sequences(), messages(81, 280).map((m) => m.sequence))
    assert.equal(store.getState().firstItemIndex.chat, anchor)

    await store.getState().loadOlder('chat')
    assert.deepEqual(sequences(), messages(1, 280).map((m) => m.sequence))
    assert.equal(requests.at(-1)?.before, 81)
    assert.equal(store.getState().firstItemIndex.chat, anchor - 80)
  })
})
