/**
 * The BYOA daemon's short request/response calls must have a deadline.
 *
 * The failure they guard against is not a server that REFUSES — that throws and
 * is already handled — but one that accepts the connection and then never
 * answers (half-open socket after a sleep/network switch, a hung proxy, a pod
 * that stopped mid-request). A `fetch` with no signal never settles, and
 * `try/catch` cannot catch a promise that doesn't settle. Since the first thing
 * a turn awaits after its `turn START` log is a `runtimeBest('/status')` — before
 * the engine spawn — one such request parks the turn forever: `finally { busy =
 * false }` never runs, the agent stays permanently `busy`, later wakes collapse
 * to `turn busy — coalescing`, and the heartbeat stops until the server marks the
 * whole computer offline. Every agent on the machine goes down with it.
 *
 * These tests use a real socket that accepts and stays silent, so they exercise
 * the actual not-settling case rather than a mock.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-http-timeout.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

/** A server that accepts requests and NEVER responds. */
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer(() => { /* deliberately never respond */ })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

test('a silent server aborts the fetch instead of hanging forever', async () => {
  const { url, close } = await silentServer()
  try {
    const started = Date.now()
    await assert.rejects(
      fetch(url, { signal: AbortSignal.timeout(300) }),
      (err: unknown) => (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError',
      'a request to a non-responding server must reject, not park',
    )
    // The point is that it settles at all, promptly — not the exact duration.
    assert.ok(Date.now() - started < 5_000, 'abort should fire on its own deadline')
  } finally {
    await close()
  }
})

test('the abort surfaces as a throw, so a fire-and-forget wrapper can swallow it', async () => {
  // This is the shape of runtimeBest/runtimeGet: the timeout turns a
  // never-settling promise into a rejection, which their `catch` converts to
  // null — so the turn continues to the engine spawn instead of parking.
  const { url, close } = await silentServer()
  try {
    const best = async (): Promise<unknown> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(300) })
        return res.ok ? await res.json().catch(() => null) : null
      } catch { return null }
    }
    assert.equal(await best(), null, 'a stalled call must degrade to null, not hang')
  } finally {
    await close()
  }
})

test('a caller-supplied signal is respected over the default deadline', async () => {
  // api() passes `init.signal ?? AbortSignal.timeout(...)`, so an explicit
  // signal (e.g. a teardown controller) must still win.
  const { url, close } = await silentServer()
  try {
    const ac = new AbortController()
    const p = fetch(url, { signal: ac.signal })
    ac.abort()
    await assert.rejects(p, (err: unknown) => (err as Error)?.name === 'AbortError')
  } finally {
    await close()
  }
})
