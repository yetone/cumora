import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as importedWorker from './index.js'

type WorkerLike = {
  fetch(request: Request, env: { BUCKET: unknown; R2_URL_SIGNING_SECRET: string }): Promise<Response>
}

// tsx loads this CommonJS-configured worker through a namespace whose default
// can itself contain the transpiled default export. Normalize both shapes so
// these tests exercise the actual fetch handler rather than a helper copy.
const namespaceValue = importedWorker as unknown as { default?: unknown }
const firstDefault = namespaceValue.default ?? namespaceValue
const worker = ((firstDefault as { default?: unknown }).default ?? firstDefault) as WorkerLike

const SECRET = 'r2-gate-test-secret'
const FIXTURE_KEY = 'email-attachments/fixture.txt'

type Fixture = {
  body: string
  etag: string
  contentType: string
}

class MemoryBucket {
  getCalls = 0
  headCalls = 0

  constructor(private readonly objects: Map<string, Fixture>) {}

  async get(key: string, options?: { onlyIf?: { etagDoesNotMatch?: string } }): Promise<Record<string, unknown> | null> {
    this.getCalls++
    const object = this.objects.get(key)
    if (!object) return null
    if (options?.onlyIf?.etagDoesNotMatch === object.etag) return this.metadata(object)
    return {
      ...this.metadata(object),
      body: new Response(object.body).body,
    }
  }

  async head(key: string): Promise<Record<string, unknown> | null> {
    this.headCalls++
    const object = this.objects.get(key)
    return object ? this.metadata(object) : null
  }

  private metadata(object: Fixture): Record<string, unknown> {
    return {
      httpEtag: object.etag,
      httpMetadata: { contentType: object.contentType },
    }
  }
}

function fixtureBucket(key = FIXTURE_KEY): MemoryBucket {
  return new MemoryBucket(new Map([
    [key, { body: 'fixture body', etag: '"fixture-etag"', contentType: 'text/plain' }],
  ]))
}

function signature(key: string, exp: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${key}:${exp}`).digest('hex')
}

function signedURL(key: string, exp: number, secret = SECRET): string {
  const sig = signature(key, exp, secret)
  return `https://gate.invalid/${key}?exp=${exp}&sig=${sig}`
}

async function request(
  method: 'GET' | 'HEAD',
  url: string,
  bucket: MemoryBucket,
  secret = SECRET,
  headers?: HeadersInit,
): Promise<Response> {
  return worker.fetch(new Request(url, { method, headers }), {
    BUCKET: bucket,
    R2_URL_SIGNING_SECRET: secret,
  })
}

test('signed email attachments require auth before any GET or HEAD bucket read', async () => {
  const now = Math.floor(Date.now() / 1000)
  const cases = [
    { name: 'missing signature', url: `https://gate.invalid/${FIXTURE_KEY}` },
    { name: 'tampered signature', url: signedURL(FIXTURE_KEY, now + 300).replace(/.$/, 'x') },
    { name: 'expired signature', url: signedURL(FIXTURE_KEY, now - 60) },
    { name: 'far-future signature', url: signedURL(FIXTURE_KEY, now + 90_000) },
    { name: 'legacy attachment prefix remains signed', url: 'https://gate.invalid/attachments/fixture.txt' },
  ]

  for (const method of ['GET', 'HEAD'] as const) {
    for (const testCase of cases) {
      const bucket = fixtureBucket()
      const response = await request(method, testCase.url, bucket)
      assert.equal(response.status, 403, `${method} ${testCase.name}`)
      assert.equal(bucket.getCalls + bucket.headCalls, 0, `${method} ${testCase.name} read before auth`)
    }
  }
})

test('valid signatures authorize email attachment GET and HEAD with private caching', async () => {
  const exp = Math.floor(Date.now() / 1000) + 300
  for (const method of ['GET', 'HEAD'] as const) {
    const bucket = fixtureBucket()
    const response = await request(method, signedURL(FIXTURE_KEY, exp), bucket)
    assert.equal(response.status, 200, method)
    assert.equal(response.headers.get('cache-control'), 'private, max-age=300', method)
    assert.equal(response.headers.get('content-type'), 'text/plain', method)
    assert.equal(bucket.getCalls, method === 'GET' ? 1 : 0, `${method} GET reads`)
    assert.equal(bucket.headCalls, method === 'HEAD' ? 1 : 0, `${method} HEAD reads`)
    assert.equal(await response.text(), method === 'GET' ? 'fixture body' : '')
  }
})

test('unconfigured signing secret rejects email attachments without a bucket read', async () => {
  const bucket = fixtureBucket()
  const response = await request('GET', signedURL(FIXTURE_KEY, Math.floor(Date.now() / 1000) + 300), bucket, '')
  assert.equal(response.status, 403)
  assert.equal(bucket.getCalls + bucket.headCalls, 0)
})

test('signed missing attachment returns 404 after authentication and one GET', async () => {
  const bucket = new MemoryBucket(new Map())
  const key = 'email-attachments/missing.txt'
  const response = await request('GET', signedURL(key, Math.floor(Date.now() / 1000) + 300), bucket)
  assert.equal(response.status, 404)
  assert.equal(bucket.getCalls, 1)
  assert.equal(bucket.headCalls, 0)
})

test('conditional signed GET returns 304 after an authenticated R2 revalidation', async () => {
  const bucket = fixtureBucket()
  const response = await request(
    'GET',
    signedURL(FIXTURE_KEY, Math.floor(Date.now() / 1000) + 300),
    bucket,
    SECRET,
    { 'if-none-match': '"fixture-etag"' },
  )
  assert.equal(response.status, 304)
  assert.equal(response.headers.get('cache-control'), 'private, max-age=300')
  assert.equal(await response.text(), '')
  assert.equal(bucket.getCalls, 1)
  assert.equal(bucket.headCalls, 0)
})

test('avatars remain unsigned and publicly cacheable', async () => {
  const key = 'avatars/alice.png'
  for (const method of ['GET', 'HEAD'] as const) {
    const bucket = fixtureBucket(key)
    const response = await request(method, `https://gate.invalid/${key}`, bucket)
    assert.equal(response.status, 200, method)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=86400, immutable', method)
    assert.equal(bucket.getCalls, method === 'GET' ? 1 : 0, `${method} GET reads`)
    assert.equal(bucket.headCalls, method === 'HEAD' ? 1 : 0, `${method} HEAD reads`)
  }
})
