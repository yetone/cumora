/**
 * Regression tests for agent image egress.
 *
 * Run: node --import tsx --test server/src/__tests__/image-fetcher.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { _fetchImageBytesForTest } from '../agents/image-fetcher.js'

type Dependencies = Parameters<typeof _fetchImageBytesForTest>[2]
type RequestTarget = Parameters<Dependencies['request']>[0]
type ImageResponse = Awaited<ReturnType<Dependencies['request']>>

function response(
  status: number,
  headers: Record<string, string> = {},
  chunks: Array<string | Buffer> = [],
  onCancel?: () => void,
): ImageResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk)
    })(),
    cancel: () => onCancel?.(),
  }
}

test('blocks private, metadata, alternate IPv4, and IPv6 literals before connecting', async () => {
  for (const url of [
    'http://127.0.0.1/image.png',
    'http://100.64.0.1/image.png',
    'http://169.254.169.254/latest/meta-data',
    'http://198.18.0.1/image.png',
    'http://2130706433/image.png',
    'http://[::1]/image.png',
    'http://[::ffff:7f00:1]/image.png',
    'http://[64:ff9b::7f00:1]/image.png',
  ]) {
    let lookups = 0
    let requests = 0
    const result = await _fetchImageBytesForTest(url, {}, {
      lookup: async () => { lookups += 1; return [] },
      request: async () => { requests += 1; return response(500) },
    })
    assert.deepEqual(result, { ok: false, reason: 'blocked' }, url)
    assert.equal(lookups, 0, `literal ${url} must not use DNS`)
    assert.equal(requests, 0, `literal ${url} must be rejected before connect`)
  }
})

test('blocks hostnames when any DNS answer is private', async () => {
  for (const answers of [
    [{ address: '10.0.0.8', family: 4 as const }],
    [
      { address: '93.184.216.34', family: 4 as const },
      { address: '192.168.1.20', family: 4 as const },
    ],
    [{ address: 'fc00::1234', family: 6 as const }],
  ]) {
    let requests = 0
    const result = await _fetchImageBytesForTest('https://images.example/avatar.png', {}, {
      lookup: async hostname => {
        assert.equal(hostname, 'images.example')
        return answers
      },
      request: async () => { requests += 1; return response(500) },
    })
    assert.deepEqual(result, { ok: false, reason: 'blocked' })
    assert.equal(requests, 0, 'a mixed/private answer set must be rejected before connect')
  }
})

test('revalidates redirects and never connects to a private redirect target', async () => {
  const connected: string[] = []
  let cancelled = 0
  const result = await _fetchImageBytesForTest('https://images.example/start', {}, {
    lookup: async hostname => hostname === 'images.example'
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }],
    request: async target => {
      connected.push(target.address)
      return response(302, { location: 'http://metadata.internal/latest' }, [], () => { cancelled += 1 })
    },
  })

  assert.deepEqual(result, { ok: false, reason: 'blocked' })
  assert.deepEqual(connected, ['93.184.216.34'])
  assert.equal(cancelled, 1, 'redirect response must be closed before validating the next hop')
})

test('pins each public redirect hop to the address that was validated', async () => {
  const connected: Array<Pick<RequestTarget, 'hostname' | 'address' | 'family'>> = []
  const lookedUp: string[] = []
  const result = await _fetchImageBytesForTest('https://images.example/start', {}, {
    lookup: async hostname => {
      lookedUp.push(hostname)
      return hostname === 'images.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '1.1.1.1', family: 4 }]
    },
    request: async target => {
      connected.push({ hostname: target.hostname, address: target.address, family: target.family })
      if (target.hostname === 'images.example') {
        return response(302, { location: 'https://cdn.example/final.png' })
      }
      return response(200, { 'content-type': 'image/png' }, ['safe-image'])
    },
  })

  assert.deepEqual(lookedUp, ['images.example', 'cdn.example'])
  assert.deepEqual(connected, [
    { hostname: 'images.example', address: '93.184.216.34', family: 4 },
    { hostname: 'cdn.example', address: '1.1.1.1', family: 4 },
  ])
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.buffer.toString(), 'safe-image')
    assert.equal(result.mime, 'image/png')
    assert.equal(result.finalUrl, 'https://cdn.example/final.png')
  }
})

test('blocks redirects to unsupported schemes and redirect loops', async () => {
  const publicLookup: Dependencies['lookup'] = async () => [
    { address: '93.184.216.34', family: 4 },
  ]

  const badScheme = await _fetchImageBytesForTest('https://images.example/start', {}, {
    lookup: publicLookup,
    request: async () => response(302, { location: 'file:///etc/passwd' }),
  })
  assert.deepEqual(badScheme, { ok: false, reason: 'blocked' })

  let requests = 0
  const redirectLoop = await _fetchImageBytesForTest('https://images.example/start', {
    maxRedirects: 1,
  }, {
    lookup: publicLookup,
    request: async () => {
      requests += 1
      return response(302, { location: '/again' })
    },
  })
  assert.deepEqual(redirectLoop, { ok: false, reason: 'blocked' })
  assert.equal(requests, 2)
})

test('enforces content type, declared size, streamed size, and timeout centrally', async () => {
  const lookup: Dependencies['lookup'] = async () => [
    { address: '93.184.216.34', family: 4 },
  ]

  const badType = await _fetchImageBytesForTest('https://images.example/file', {}, {
    lookup,
    request: async () => response(200, { 'content-type': 'text/plain' }, ['not-image']),
  })
  assert.deepEqual(badType, { ok: false, reason: 'bad-type' })

  const declaredTooLarge = await _fetchImageBytesForTest('https://images.example/file', {
    maxBytes: 4,
  }, {
    lookup,
    request: async () => response(200, {
      'content-type': 'image/png',
      'content-length': '5',
    }, ['small']),
  })
  assert.deepEqual(declaredTooLarge, { ok: false, reason: 'too-large' })

  const streamedTooLarge = await _fetchImageBytesForTest('https://images.example/file', {
    maxBytes: 4,
  }, {
    lookup,
    request: async () => response(200, { 'content-type': 'image/png' }, ['12', '345']),
  })
  assert.deepEqual(streamedTooLarge, { ok: false, reason: 'too-large' })

  const timedOut = await _fetchImageBytesForTest('https://images.example/file', {
    timeoutMs: 20,
  }, {
    lookup: async () => await new Promise<never>(() => {}),
    request: async () => response(500),
  })
  assert.deepEqual(timedOut, { ok: false, reason: 'timeout' })
})
