/**
 * Unit tests for the Cloudflare Email Worker's pure helpers.
 *
 * The worker itself runs on Workers Runtime, but the helpers exercised
 * here only depend on Web Platform APIs (TextEncoder, btoa, crypto) that
 * Node 24 implements natively — no special test harness needed. The
 * `email()` handler itself isn't covered here (it'd need a fake
 * ForwardableEmailMessage + a network stub for the inbound POST) — those
 * paths are best validated end-to-end with `wrangler dev`.
 *
 * Run: npm test (from repo root)
 */
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import worker, {
  recipientAccepted,
  synthesizeMessageId,
  SYNTH_ID_BUCKET_MS,
  readArrayHeader,
  toBase64,
  getHeader,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from './index.js'

/* ============================ recipientAccepted ============================ */

const envSingleDomain = { EMAIL_ROOT_DOMAINS: 'cumora.ai' } as never as Parameters<typeof recipientAccepted>[1]
const envMultiDomain = { EMAIL_ROOT_DOMAINS: 'cumora.ai, cumora.dev , example.com' } as never as Parameters<typeof recipientAccepted>[1]

test('recipientAccepted matches exact apex', () => {
  assert.equal(recipientAccepted('alice@cumora.ai', envSingleDomain), true)
})

test('recipientAccepted matches subdomain', () => {
  assert.equal(recipientAccepted('alice@acme.cumora.ai', envSingleDomain), true)
})

test('recipientAccepted rejects unknown domain', () => {
  assert.equal(recipientAccepted('alice@evil.com', envSingleDomain), false)
})

test('recipientAccepted handles multi-domain allowlist', () => {
  assert.equal(recipientAccepted('alice@cumora.dev', envMultiDomain), true)
  assert.equal(recipientAccepted('alice@example.com', envMultiDomain), true)
  assert.equal(recipientAccepted('alice@other.org', envMultiDomain), false)
})

test('recipientAccepted is case-insensitive', () => {
  assert.equal(recipientAccepted('ALICE@CUMORA.AI', envSingleDomain), true)
})

test('recipientAccepted rejects malformed', () => {
  assert.equal(recipientAccepted('no-at-sign', envSingleDomain), false)
})

test('recipientAccepted does NOT match suffix-of-other-domain (apple.com vs evilapple.com)', () => {
  // Guards against the classic mistake of `endsWith('apple.com')` matching
  // `evilapple.com`. The check requires either an exact match OR `.<root>`.
  const env = { EMAIL_ROOT_DOMAINS: 'apple.com' } as never as Parameters<typeof recipientAccepted>[1]
  assert.equal(recipientAccepted('x@evilapple.com', env), false)
  assert.equal(recipientAccepted('x@apple.com', env), true)
})

/* ============================== readArrayHeader =========================== */

test('readArrayHeader returns [] for empty/missing', () => {
  assert.deepEqual(readArrayHeader(undefined), [])
  assert.deepEqual(readArrayHeader(''), [])
  assert.deepEqual(readArrayHeader('   '), [])
})

test('readArrayHeader splits angle-bracketed References on whitespace', () => {
  const r = readArrayHeader('<a@x> <b@y>\n<c@z>')
  assert.deepEqual(r, ['a@x', 'b@y', 'c@z'])
})

test('readArrayHeader strips repeated angle brackets', () => {
  assert.deepEqual(readArrayHeader('<<a@x>>'), ['a@x'])
})

/* =================================== toBase64 ============================== */

test('toBase64 round-trips ASCII', () => {
  const bytes = new TextEncoder().encode('Hello, world')
  const b64 = toBase64(bytes)
  assert.equal(b64, 'SGVsbG8sIHdvcmxk')
})

test('toBase64 handles binary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 255, 254])
  const b64 = toBase64(bytes)
  // Decode back via Buffer to verify symmetry without trusting our own impl.
  const back = Buffer.from(b64, 'base64')
  assert.deepEqual(Array.from(back), [0, 1, 2, 3, 255, 254])
})

test('toBase64 handles multi-chunk inputs (>32KB)', () => {
  // Chunk size in the impl is 0x8000 (32768). Build something larger so we
  // know the chunk-loop path runs.
  const big = new Uint8Array(70_000).fill(0x41)  // 70KB of 'A'
  const b64 = toBase64(big)
  const back = Buffer.from(b64, 'base64')
  assert.equal(back.length, 70_000)
  assert.equal(back[0], 0x41)
  assert.equal(back[69_999], 0x41)
})

/* =================================== getHeader ============================ */

test('getHeader does case-insensitive lookup', () => {
  const headers = [
    { key: 'X-Custom', value: 'one' },
    { key: 'auto-submitted', value: 'auto-replied' },
  ]
  assert.equal(getHeader(headers, 'Auto-Submitted'), 'auto-replied')
  assert.equal(getHeader(headers, 'x-custom'), 'one')
  assert.equal(getHeader(headers, 'missing'), undefined)
})

test('getHeader returns first match', () => {
  const headers = [
    { key: 'X-Foo', value: 'first' },
    { key: 'x-foo', value: 'second' },
  ]
  assert.equal(getHeader(headers, 'X-Foo'), 'first')
})

/* ============================== attachment caps =========================== */

test('attachment byte limits are sensibly ordered', () => {
  // Sanity guards on the constants: per-attachment cap must be < total cap,
  // and total cap must leave headroom under the server's 25MB JSON limit
  // after base64 expansion (~33% overhead).
  assert.ok(MAX_ATTACHMENT_BYTES < MAX_TOTAL_ATTACHMENT_BYTES)
  assert.ok(MAX_TOTAL_ATTACHMENT_BYTES * 1.34 < 25 * 1024 * 1024)
})

/* ==================== email() handler error handling ======================= */

function createFakeMessage() {
  const rejected: string[] = []
  const rawStream = new Response(
    'From: alice@example.com\r\nTo: agent@cumora.ai\r\nSubject: Test\r\nMessage-ID: <msg-1@example.com>\r\n\r\nHello',
  ).body!
  const message = {
    to: 'agent@cumora.ai',
    from: 'alice@example.com',
    raw: rawStream,
    setReject: (reason: string) => { rejected.push(reason) },
  } as unknown as Parameters<typeof worker.email>[0]
  return { message, rejected }
}

const fakeEnv = {
  EMAIL_ROOT_DOMAINS: 'cumora.ai',
  EMAIL_INBOUND_HMAC_SECRET: 'test-secret-value-12345',
  CUMORA_INBOUND_URL: 'http://upstream.local/inbound',
} as unknown as Parameters<typeof worker.email>[1]

const fakeCtx = {
  waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}) },
  passThroughOnException: () => {},
} as unknown as Parameters<typeof worker.email>[2]

test('email handler throws on upstream network error (triggering SMTP tempfail)', async () => {
  const { message, rejected } = createFakeMessage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('connection reset by peer')
  }
  try {
    await assert.rejects(
      () => worker.email(message, fakeEnv, fakeCtx),
      /Upstream unreachable: connection reset by peer/,
    )
    assert.deepEqual(rejected, [], 'setReject must NOT be called on transient network error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('email handler throws on upstream 5xx error (triggering SMTP tempfail)', async () => {
  const { message, rejected } = createFakeMessage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Internal Server Error', { status: 502 })
  try {
    await assert.rejects(
      () => worker.email(message, fakeEnv, fakeCtx),
      /Upstream temporary failure \(502\)/,
    )
    assert.deepEqual(rejected, [], 'setReject must NOT be called on 5xx error')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/* ===================== the envelope recipient is forwarded ================= */

test('email handler forwards the envelope recipient it admitted the message on', async () => {
  // The handler gates on recipientAccepted(message.to) — the ENVELOPE
  // recipient — and then forwarded every field except that one. Whenever the
  // agent is Bcc'd or reached via an alias, a list expansion or a forwarding
  // rule, its address is in no header, so the server resolved nobody and
  // answered 404, which this handler turns into a permanent SMTP 550.
  const rejected: string[] = []
  const message = {
    // Delivered to the agent; the visible header names someone else.
    to: 'agent@cumora.ai',
    from: 'alice@example.com',
    raw: new Response(
      'From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test\r\nMessage-ID: <msg-2@example.com>\r\n\r\nHello',
    ).body!,
    setReject: (reason: string) => { rejected.push(reason) },
  } as unknown as Parameters<typeof worker.email>[0]

  let posted: Record<string, unknown> | null = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    posted = JSON.parse(String((init as RequestInit).body))
    return new Response('ok', { status: 200 })
  }
  try {
    await worker.email(message, fakeEnv, fakeCtx)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(rejected, [])
  assert.ok(posted, 'nothing was posted upstream')
  assert.equal(
    (posted as { envelopeTo?: string }).envelopeTo, 'agent@cumora.ai',
    'the address the handler admitted this message on was not forwarded — a Bcc\'d agent resolves to nobody and gets a 550',
  )
  // The visible header is still reported as-is; envelopeTo is additive.
  assert.deepEqual((posted as { to?: string[] }).to, ['bob@example.com'])
})

test('email handler rejects with 550 bounce on 404 no recipient', async () => {
  const { message, rejected } = createFakeMessage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Not Found', { status: 404 })
  try {
    await worker.email(message, fakeEnv, fakeCtx)
    assert.deepEqual(rejected, ['No such recipient'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('email handler rejects with 550 bounce on 4xx client errors', async () => {
  const { message, rejected } = createFakeMessage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('Bad Request', { status: 400 })
  try {
    await worker.email(message, fakeEnv, fakeCtx)
    assert.deepEqual(rejected, ['Upstream 400'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('email handler accepts email on 200 response without setReject', async () => {
  const { message, rejected } = createFakeMessage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('OK', { status: 200 })
  try {
    await worker.email(message, fakeEnv, fakeCtx)
    assert.deepEqual(rejected, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})


/* ========================= synthesizeMessageId ========================= */
//
// A message with no `Message-Id:` gets one fabricated here. It has to be
// DERIVED, not random: the worker throws on an upstream 5xx or a network
// failure so the sending MTA tempfails and retries, and that retry runs this
// worker again on the same physical message. The server dedups on
// smtp_message_id, so a random id per attempt is a fresh delivery per attempt.

const sameMessage = {
  envelopeFrom: 'alerts@sensor.example.com',
  envelopeTo: 'ops.acme@cumora.ai',
  date: 'Mon, 08 Sep 2026 09:14:02 +0000',
  subject: 'disk 91% on db-2',
  body: 'threshold crossed at 09:14',
}

test('synthesizeMessageId is stable across a retry of the same message', async () => {
  // The retry arrives as a new SMTP transaction with its own Received: headers,
  // so only the parsed fields can be hashed — and they must give the same id.
  assert.equal(await synthesizeMessageId(sameMessage), await synthesizeMessageId({ ...sameMessage }))
})

test('synthesizeMessageId separates two genuinely different messages', async () => {
  const base = await synthesizeMessageId(sameMessage)
  for (const variant of [
    { ...sameMessage, envelopeFrom: 'other@sensor.example.com' },
    { ...sameMessage, envelopeTo: 'ops.other@cumora.ai' },
    { ...sameMessage, date: 'Mon, 08 Sep 2026 09:15:02 +0000' },
    { ...sameMessage, subject: 'disk 92% on db-2' },
    { ...sameMessage, body: 'threshold crossed at 09:15' },
  ]) {
    assert.notEqual(await synthesizeMessageId(variant), base)
  }
})

test('synthesizeMessageId cannot have a field boundary forged by content', async () => {
  // Fields are NUL-joined, so moving text across a boundary must change the id.
  assert.notEqual(
    await synthesizeMessageId({ ...sameMessage, subject: 'a', body: 'bc' }),
    await synthesizeMessageId({ ...sameMessage, subject: 'ab', body: 'c' }),
  )
})

test('synthesizeMessageId falls back to a coarse bucket when Date is missing', async () => {
  // A sender that omitted Message-Id may have omitted Date too. Within one
  // bucket a retry still dedups; that is the original intent of this fallback.
  const undated = { ...sameMessage, date: undefined }
  assert.equal(await synthesizeMessageId(undated), await synthesizeMessageId({ ...undated }))
  assert.ok(SYNTH_ID_BUCKET_MS >= 60 * 60 * 1000, 'the bucket must outlast an MTA first retry')
})

test('synthesizeMessageId produces a shape the server will accept', async () => {
  const id = await synthesizeMessageId(sameMessage)
  assert.match(id, /^synth-[0-9a-f]{64}@cumora-email-gate$/)
  assert.doesNotMatch(id, /[<>\s]/)
})

test('the email handler synthesizes its id instead of drawing a random one', async () => {
  // Every test above passes just as well against a handler that went back to
  // `randomUUID()` — they exercise the helper, not the call site. Read the
  // source so the call site cannot quietly stop using it.
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('export default {'))

  assert.match(handler, /synthesizeMessageId\(/, 'the handler no longer derives the fallback id')
  assert.doesNotMatch(
    handler, /randomUUID/,
    'the fallback Message-Id is random again — every MTA retry of the same message will deliver a duplicate',
  )
})
