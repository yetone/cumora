/**
 * Server-Sent Events parser. Lifted out of pod-agent.ts so the
 * test suite can pin its contract (partial-UTF-8 split mid-codepoint,
 * CRLF line endings, multi-line `data:` fields, `:` comment pings,
 * etc.) without booting pod-agent.ts's auto-running main().
 *
 * Accepts either a Web ReadableStream (what fetch returns in Node 20+)
 * or a Node stream — chunks come through as Uint8Array either way and
 * TextDecoder handles both.
 *
 * Yields `{event?, data?, id?}` as soon as each `\n\n`-terminated
 * block is fully buffered. Incomplete trailing data stays in the
 * internal buffer until the next chunk or stream-end.
 */

export interface SseEvent { event?: string; data?: string; id?: string }

/** Streaming SSE block parser. Each yielded event represents one
 *  `event: ...\ndata: ...\n\n` block. `data:` lines accumulate
 *  across continuation lines per the spec. */
export async function* parseSseStream(body: AsyncIterable<unknown>): AsyncGenerator<SseEvent> {
  // TextDecoder with `stream: true` preserves partial UTF-8
  // sequences across chunk boundaries — critical when a multi-byte
  // codepoint splits across two read() calls.
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  for await (const chunk of body) {
    if (typeof chunk === 'string') buf += chunk
    else if (chunk instanceof Uint8Array) buf += decoder.decode(chunk, { stream: true })
    else continue
    let nl: number
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, nl)
      buf = buf.slice(nl + 2)
      const out: SseEvent = {}
      for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line.startsWith(':')) continue              // SSE comment / ping
        const colon = line.indexOf(':')
        if (colon < 0) continue
        const field = line.slice(0, colon)
        const value = line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') out.event = value
        else if (field === 'data') out.data = (out.data ?? '') + value
        else if (field === 'id') out.id = value
      }
      if (out.event || out.data) yield out
    }
  }
}

/** How long a wake-stream must stay up before its reconnect ladder resets.
 *
 *  Merely CONNECTING must not reset the ladder. A wake-stream can end CLEANLY —
 *  wake-bus's backpressure guard calls `res.end()` on a backed-up subscriber,
 *  and any edge in front of the API can terminate a chunked 200 the same way —
 *  so an endpoint that accepts and immediately closes would reset the delay on
 *  every pass and the backoff could never grow. */
export const STREAM_STABLE_MS = 60_000

/** True when the wake-stream connection that just ended had been up long enough
 *  to count as healthy, so the caller may reset its reconnect delay.
 *  `upForMs` is null when the connection never opened at all. */
export function wakeStreamWasStable(upForMs: number | null): boolean {
  return upForMs !== null && upForMs >= STREAM_STABLE_MS
}
