/**
 * Open Graph redirect SSRF regression tests.
 *
 * Run: node --import tsx --test server/src/__tests__/og-redirects.test.ts
 */
import { after, afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

// Keep Redis lazy during this focused unit test. ogPreview's cache methods are
// stubbed below, so no external service is required.
process.env.CUMORA_RUNTIME_CLIENT = 'http'

const { OgError, ogPreview } = await import('../og.js')
const { redis, sub } = await import('../redis.js')

const savedFetch = globalThis.fetch
const savedWarn = console.warn
const savedRedisGet = redis.get.bind(redis)
const savedRedisSet = redis.set.bind(redis)

type FetchCall = { url: string; redirect: RequestInit['redirect'] }

function href(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function htmlResponse(url: string, html: string): Response {
  const response = new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

beforeEach(() => {
  ;(redis as unknown as { get: (key: string) => Promise<string | null> }).get = async () => null
  ;(redis as unknown as { set: (key: string, value: string) => Promise<'OK'> }).set =
    async () => 'OK'
  console.warn = () => { /* expected fetch failures stay quiet in tests */ }
})

afterEach(() => {
  globalThis.fetch = savedFetch
  console.warn = savedWarn
  ;(redis as unknown as { get: typeof savedRedisGet }).get = savedRedisGet
  ;(redis as unknown as { set: typeof savedRedisSet }).set = savedRedisSet
})

after(() => {
  redis.disconnect()
  sub.disconnect()
})

test('ogPreview follows a validated public redirect manually', async () => {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = href(input)
    calls.push({ url, redirect: init?.redirect })
    if (url === 'https://8.8.8.8/start') {
      return new Response(null, {
        status: 302,
        headers: { location: '/article' },
      })
    }
    if (url === 'https://8.8.8.8/article') {
      return htmlResponse(url, '<html><head><title>Public article</title></head></html>')
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const result = await ogPreview('https://8.8.8.8/start')

  assert.equal(result?.title, 'Public article')
  assert.equal(result?.finalUrl, 'https://8.8.8.8/article')
  assert.deepEqual(calls, [
    { url: 'https://8.8.8.8/start', redirect: 'manual' },
    { url: 'https://8.8.8.8/article', redirect: 'manual' },
  ])
})

test('ogPreview rejects a redirect to cloud metadata before the second request', async () => {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = href(input)
    calls.push({ url, redirect: init?.redirect })
    if (url === 'https://8.8.8.8/redirect-private') {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    }
    throw new Error(`private redirect target was fetched: ${url}`)
  }) as typeof fetch

  await assert.rejects(
    () => ogPreview('https://8.8.8.8/redirect-private'),
    (error: unknown) => error instanceof OgError && error.status === 403,
  )

  assert.deepEqual(calls, [
    { url: 'https://8.8.8.8/redirect-private', redirect: 'manual' },
  ])
})

test('ogPreview rejects a redirect to an RFC1918 host before the second request', async () => {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = href(input)
    calls.push({ url, redirect: init?.redirect })
    if (url === 'https://8.8.8.8/redirect-rfc1918') {
      return new Response(null, {
        status: 307,
        headers: { location: 'http://10.0.0.1/internal' },
      })
    }
    throw new Error(`private redirect target was fetched: ${url}`)
  }) as typeof fetch

  await assert.rejects(
    () => ogPreview('https://8.8.8.8/redirect-rfc1918'),
    (error: unknown) => error instanceof OgError && error.status === 403,
  )

  assert.deepEqual(calls, [
    { url: 'https://8.8.8.8/redirect-rfc1918', redirect: 'manual' },
  ])
})

test('ogPreview rejects a redirect to a non-http protocol', async () => {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = href(input)
    calls.push({ url, redirect: init?.redirect })
    if (url === 'https://8.8.8.8/redirect-file') {
      return new Response(null, {
        status: 302,
        headers: { location: 'file:///etc/passwd' },
      })
    }
    throw new Error(`non-http redirect target was fetched: ${url}`)
  }) as typeof fetch

  await assert.rejects(
    () => ogPreview('https://8.8.8.8/redirect-file'),
    (error: unknown) => error instanceof OgError && error.status === 400,
  )

  assert.deepEqual(calls, [
    { url: 'https://8.8.8.8/redirect-file', redirect: 'manual' },
  ])
})

test('ogPreview stops after the bounded redirect limit', async () => {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = href(input)
    calls.push({ url, redirect: init?.redirect })
    return new Response(null, {
      status: 302,
      headers: { location: `/loop/${calls.length}` },
    })
  }) as typeof fetch

  const result = await ogPreview('https://8.8.8.8/loop/0')

  assert.equal(result, null)
  assert.equal(calls.length, 6)
  assert.ok(calls.every(({ redirect }) => redirect === 'manual'))
})
