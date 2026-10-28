import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AgentAttachmentCache, renderCachedAttachments } from '../agents/computer/attachment-cache.js'

test('each attachment is downloaded through the runtime endpoint into agent home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  const requests: Array<{ url: string; authorization: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    assert.match(url, /\/runtime\/attachment\?key=attachments%2F.*messageId=message-1/)
    return new Response('hello from attachment', {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '21' },
    })
  }) as typeof fetch
  try {
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'runtime-token', fetchImpl)
    const result = await cache.materialize('message-1', [
      { name: '../secret.txt', kind: 'file', key: 'attachments/a.txt', mime: 'text/plain', size: 21 },
      { name: 'image.png', kind: 'img', key: 'attachments/b.png', mime: 'image/png', size: 21 },
    ])
    assert.equal(result.files.length, 2)
    assert.equal(requests.length, 2)
    assert.ok(requests.every((request) => request.authorization === 'Bearer runtime-token'))
    assert.equal(result.files[0].text, 'hello from attachment')
    assert.ok(result.files.every((file) => file.path.startsWith(join(home, 'attachments', 'message-1'))))
    assert.equal(await readFile(result.files[0].path, 'utf8'), 'hello from attachment')
    if (process.platform !== 'win32') assert.equal((await stat(result.files[0].path)).mode & 0o777, 0o600)
    const rendered = renderCachedAttachments(result, 'unsupported')
    assert.match(rendered, /File excerpt/)
    assert.match(rendered, /does not support image input/)
    assert.match(rendered, /Do not claim to have seen/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('non-Cumora keys and download failures are reported without escaping agent home', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  const fetchImpl = (async () => new Response('too large?', { status: 500 })) as typeof fetch
  try {
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'token', fetchImpl)
    const result = await cache.materialize('../../outside', [
      { name: 'external.txt', kind: 'file', url: 'https://example.com/a.txt' },
      { name: 'failed.txt', kind: 'file', key: 'attachments/failed.txt' },
    ])
    assert.equal(result.files.length, 0)
    assert.equal(result.failures.length, 2)
    assert.match(result.failures[0].reason, /trusted Cumora attachment key/)
    assert.match(result.failures[1].reason, /HTTP 500/)
    assert.match(renderCachedAttachments(result, 'unknown'), /could not be downloaded/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('text excerpts stop at 50 KiB and remain available as local files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  const body = Buffer.alloc(50 * 1024 + 7, 'a')
  const fetchImpl = (async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain', 'content-length': String(body.length) },
  })) as typeof fetch
  try {
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'token', fetchImpl)
    const result = await cache.materialize('message-large', [
      { name: 'large.txt', kind: 'file', key: 'attachments/large.txt', mime: 'text/plain', size: body.length },
    ])
    assert.equal(result.files.length, 1)
    assert.equal(Buffer.byteLength(result.files[0].text ?? ''), 50 * 1024)
    assert.equal(result.files[0].textTruncated, true)
    assert.equal((await readFile(result.files[0].path)).length, body.length)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('cache directories cannot be redirected through a pre-existing file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  await writeFile(join(home, 'attachments'), 'not a directory')
  try {
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'token')
    await assert.rejects(
      cache.materialize('message-1', [{ name: 'a.txt', kind: 'file', key: 'attachments/a.txt' }]),
      /not a private directory/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('declared oversized downloads fail before the response body is stored', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  const fetchImpl = (async () => new Response('small', {
    status: 200,
    headers: { 'content-length': String(25 * 1024 * 1024 + 1) },
  })) as typeof fetch
  try {
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'token', fetchImpl)
    const result = await cache.materialize('message-1', [
      { name: 'too-large.bin', kind: 'file', key: 'attachments/too-large.bin' },
    ])
    assert.equal(result.files.length, 0)
    assert.match(result.failures[0].reason, /25 MiB/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('cleanup expires old files and protects paths used by the current turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  try {
    const fetchImpl = (async () => new Response('live', {
      status: 200,
      headers: { 'content-length': '4', 'content-type': 'text/plain' },
    })) as typeof fetch
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'token', fetchImpl, {
      maxAgeMs: 60_000,
      maxBytes: 1024,
      now: () => 120_000,
    })
    cache.beginTurn()
    const liveResult = await cache.materialize('live-message', [{
      name: 'live.txt', kind: 'file', key: 'attachments/live.txt', mime: 'text/plain',
    }])
    const liveFile = liveResult.files[0]?.path
    assert.ok(liveFile)
    const oldDir = join(home, 'attachments', 'old-message')
    await mkdir(oldDir, { recursive: true })
    const oldFile = join(oldDir, 'old.txt')
    await writeFile(oldFile, 'old')
    await utimes(oldFile, new Date(0), new Date(0))
    const result = await cache.cleanup()
    assert.equal(result.removedFiles, 1)
    await assert.rejects(stat(oldFile))
    assert.equal(await readFile(liveFile, 'utf8'), 'live')
    await cache.endTurn()
    await cache.dispose()
    assert.equal(await readFile(liveFile, 'utf8'), 'live')
    await cache.dispose({ purge: true })
    await assert.rejects(stat(liveFile))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('cleanup evicts least recently used files over the per-agent byte cap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cumora-attachment-cache-'))
  try {
    const cache = new AgentAttachmentCache(home, 'https://cumora.example', async () => 'token', fetch, {
      maxAgeMs: 24 * 60 * 60 * 1000,
      maxBytes: 5,
      now: () => 10_000,
    })
    const { mkdir } = await import('node:fs/promises')
    const dir = join(home, 'attachments', 'message')
    await mkdir(dir, { recursive: true })
    const leastRecent = join(dir, 'least.txt')
    const recent = join(dir, 'recent.txt')
    await writeFile(leastRecent, '1234')
    await writeFile(recent, '5678')
    await utimes(leastRecent, new Date(1_000), new Date(1_000))
    await utimes(recent, new Date(9_000), new Date(9_000))
    const result = await cache.cleanup()
    assert.equal(result.removedFiles, 1)
    await assert.rejects(stat(leastRecent))
    assert.equal(await readFile(recent, 'utf8'), '5678')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
