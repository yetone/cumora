/**
 * cumora-email-gate — Cloudflare Email Worker.
 *
 * For every inbound email Cloudflare Email Routing routes to this worker:
 *   1. Reject (550) if the recipient domain isn't in EMAIL_ROOT_DOMAINS.
 *   2. Stream the raw MIME, parse with postal-mime.
 *   3. Build a JSON payload (message-id, in-reply-to, references, from,
 *      to, cc, subject, text, html, raw size, autoSubmitted, and
 *      attachments[] as base64 — see MAX_ATTACHMENT_BYTES / the total cap).
 *   4. Sign with HMAC-SHA256(EMAIL_INBOUND_HMAC_SECRET, body) and POST
 *      to CUMORA_INBOUND_URL.
 *   5. Reject (550) if the server says "no recipient resolved" so the
 *      sending MTA gets a real bounce instead of a silent black hole.
 *
 * NOTE: Cloudflare Email Workers can't *send* mail — only receive. Outbound
 * goes through Resend on the server side.
 */
import PostalMime from 'postal-mime'

interface Env {
  EMAIL_INBOUND_HMAC_SECRET: string
  CUMORA_INBOUND_URL: string
  /** Comma-separated. e.g. "cumora.ai,cumora.dev". The recipient must
   *  end with `.<root>` (subdomain) OR equal `<root>` (apex). */
  EMAIL_ROOT_DOMAINS: string
}

interface InboundAttachment {
  filename: string
  mimeType: string
  /** Decoded byte count (we send `content` base64-encoded; this is the
   *  pre-encode size so the server can pre-check totals without decoding). */
  sizeBytes: number
  /** Base64-encoded body. Capped per-attachment so a single rogue 50MB
   *  PDF doesn't blow the 25MB JSON limit. The server uploads from here
   *  into object storage and clears it before persisting. */
  contentBase64: string
  /** True when the source attachment was rejected — present only as
   *  metadata so the user still sees "[filename] (skipped — too large)". */
  truncated?: boolean
}

interface InboundPayload {
  messageId: string
  inReplyTo: string | null
  references: string[]
  from: string
  to: string[]
  cc: string[]
  subject: string
  text: string
  html: string | null
  rawSizeBytes: number
  /** RFC 3834 Auto-Submitted header value (lowercased). Forwarded so the
   *  server can flag the row + refuse heartbeat auto-reply on it. null
   *  when the header was absent or set to "no". */
  autoSubmitted: string | null
  attachments: InboundAttachment[]
}

/** Cap per-attachment + cumulative to keep the JSON POST under the
 *  server's 25MB body limit with comfortable headroom for base64 expansion
 *  (~33% overhead). 10MB raw per attachment, 18MB raw across all of them. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024

export function toBase64(bytes: Uint8Array): string {
  // CF Workers have no Buffer; build base64 from a binary string. Chunk the
  // String.fromCharCode call so we don't blow the argument-count limit on
  // multi-megabyte buffers.
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function recipientAccepted(rcpt: string, env: Env): boolean {
  const lc = rcpt.toLowerCase()
  const at = lc.indexOf('@')
  if (at < 0) return false
  const dom = lc.slice(at + 1)
  for (const root of env.EMAIL_ROOT_DOMAINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (dom === root || dom.endsWith('.' + root)) return true
  }
  return false
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function fmtAddress(a: { address?: string; name?: string }): string {
  const addr = (a.address ?? '').trim()
  const name = (a.name ?? '').trim()
  if (!addr) return ''
  return name ? `${name.replace(/"/g, '\\"')} <${addr}>` : addr
}

export function readArrayHeader(raw: string | undefined): string[] {
  if (!raw) return []
  // References / In-Reply-To headers are <id1> <id2> ... — split on
  // whitespace, drop the angle brackets. postal-mime's parsed headers
  // return raw strings here.
  return raw
    .split(/\s+/)
    .map((s) => s.replace(/^<+|>+$/g, '').trim())
    .filter(Boolean)
}

export function getHeader(headers: { key: string; value: string }[] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lc = name.toLowerCase()
  for (const h of headers) {
    if (h.key.toLowerCase() === lc) return h.value
  }
  return undefined
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!recipientAccepted(message.to, env)) {
      message.setReject('Recipient domain not served')
      return
    }
    if (!env.EMAIL_INBOUND_HMAC_SECRET || !env.CUMORA_INBOUND_URL) {
      message.setReject('Email gate misconfigured')
      console.error('[email-gate] missing EMAIL_INBOUND_HMAC_SECRET or CUMORA_INBOUND_URL')
      return
    }
    // Read the raw RFC 5322 message into a Buffer-equivalent we can both
    // measure and parse. Cloudflare's `message.raw` is a ReadableStream.
    let rawBytes: Uint8Array
    try {
      rawBytes = await new Response(message.raw).bytes()
    } catch (e) {
      message.setReject('Failed to read message')
      console.error('[email-gate] read raw failed:', e instanceof Error ? e.message : String(e))
      return
    }
    let parsed: Awaited<ReturnType<InstanceType<typeof PostalMime>['parse']>>
    try {
      parsed = await new PostalMime().parse(rawBytes)
    } catch (e) {
      message.setReject('Unparseable MIME')
      console.error('[email-gate] parse failed:', e instanceof Error ? e.message : String(e))
      return
    }
    // postal-mime exposes structured headers as parsed.headers (array of
    // {key, value}). messageId / inReplyTo come pre-parsed at top-level
    // but References doesn't, so dig the header manually.
    // Attachments — pull every file part out, encode within budget, drop
    // anything beyond the per-message ceiling with a truncated marker so
    // the recipient at least sees the filename.
    const attachments: InboundAttachment[] = []
    let totalAttachmentBytes = 0
    for (const a of parsed.attachments ?? []) {
      // postal-mime's `content` is Uint8Array. `disposition` distinguishes
      // inline vs attachment but we forward both — inline images that the
      // HTML view references via cid: become user-visible files too.
      const raw = a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content as ArrayBuffer)
      const filename = (a.filename ?? 'attachment').slice(0, 200)
      const mimeType = (a.mimeType ?? 'application/octet-stream').slice(0, 120)
      if (raw.byteLength > MAX_ATTACHMENT_BYTES || totalAttachmentBytes + raw.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
        attachments.push({ filename, mimeType, sizeBytes: raw.byteLength, contentBase64: '', truncated: true })
        continue
      }
      attachments.push({
        filename, mimeType, sizeBytes: raw.byteLength,
        contentBase64: toBase64(raw),
      })
      totalAttachmentBytes += raw.byteLength
    }

    const referencesHeader = getHeader(parsed.headers, 'References')
    // RFC 3834: "no" or missing → human, anything else (auto-replied /
    // auto-generated / auto-notified) → automation. Vacation responders,
    // ticket-system bots, AND other cumora installations all set this.
    const autoSubmittedRaw = (getHeader(parsed.headers, 'Auto-Submitted') ?? '').trim().toLowerCase()
    const autoSubmitted = autoSubmittedRaw && autoSubmittedRaw !== 'no' ? autoSubmittedRaw : null
    const payload: InboundPayload = {
      messageId: (parsed.messageId ?? '').replace(/^<+|>+$/g, ''),
      inReplyTo: parsed.inReplyTo ? parsed.inReplyTo.replace(/^<+|>+$/g, '') : null,
      references: readArrayHeader(referencesHeader),
      from: parsed.from ? fmtAddress(parsed.from) : message.from,
      // To / Cc — postal-mime returns Address[]. Fall back to the envelope
      // recipient if the header is missing (rare but happens).
      to: (parsed.to ?? []).map(fmtAddress).filter(Boolean),
      cc: (parsed.cc ?? []).map(fmtAddress).filter(Boolean),
      subject: parsed.subject ?? '',
      text: (parsed.text ?? '').trim(),
      html: parsed.html ?? null,
      rawSizeBytes: rawBytes.byteLength,
      autoSubmitted,
      attachments,
    }
    if (payload.to.length === 0) payload.to = [message.to]
    if (!payload.messageId) {
      // Fabricate one — server's dedup index requires a non-null id.
      // Including the recipient + a coarse timestamp keeps re-deliveries
      // of the same physical message from creating duplicates per agent.
      payload.messageId = `synth-${Date.now().toString(36)}.${crypto.randomUUID()}@cumora-email-gate`
    }

    const body = JSON.stringify(payload)
    const sig = await hmacHex(env.EMAIL_INBOUND_HMAC_SECRET, body)

    let res: Response
    try {
      res = await fetch(env.CUMORA_INBOUND_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cumora-signature': `sha256=${sig}`,
        },
        body,
      })
    } catch (e) {
      message.setReject('Upstream unreachable')
      console.error('[email-gate] POST failed:', e instanceof Error ? e.message : String(e))
      return
    }
    if (res.status === 404) {
      // Server says no agent matches this recipient — bounce.
      message.setReject('No such recipient')
      return
    }
    if (!res.ok) {
      // 4xx other than 404, or 5xx.
      //
      // KNOWN GAP: this *should* tempfail on 5xx so the sender's MTA retries,
      // but setReject() is a PERMANENT rejection — a single upstream blip
      // loses the mail for good. Cloudflare issues a temporary failure when
      // the handler throws, so the fix is to throw here on 5xx and keep
      // setReject for 4xx. Not changed yet because it flips real delivery
      // behaviour and wants its own test + rollout.
      //
      // Reading the body keeps the response from leaking; ctx.waitUntil so
      // we don't block the email return.
      ctx.waitUntil(res.text().then((t) => console.error(`[email-gate] upstream ${res.status}: ${t.slice(0, 400)}`)))
      message.setReject(`Upstream ${res.status}`)
      return
    }
    // 2xx — accepted. Email Worker has no `accept()`, just returning
    // without setReject is acceptance.
    ctx.waitUntil(res.text().then((t) => console.log(`[email-gate] delivered: ${t.slice(0, 200)}`)))
  },
}
