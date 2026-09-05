/**
 * Inbound email webhook — fronted by the Cloudflare Email Worker
 * (workers/email-gate). The worker parses raw MIME (postal-mime in the
 * worker bundle), and POSTs the parsed JSON body here, signed with
 * EMAIL_INBOUND_HMAC_SECRET.
 *
 * This handler:
 *   1. Verifies the HMAC over the raw request body (constant-time).
 *   2. Parses recipients → resolves each to an in-tenant agent. Fans out
 *      the same delivery to every recognized recipient (so a To: with two
 *      agents creates messages in two threads, one per recipient).
 *   3. Resolves the sender — known agent, known human (by users.email),
 *      else synthetic `external:<addr>` so the conversation has someone
 *      to be "from".
 *   4. Threading: in-reply-to / references → existing email_messages row
 *      → existing conversation; else new one with subject as title.
 *   5. Persists messages + email_messages rows via the shared write path
 *      and publishes CH_MESSAGE_NEW so the recipient agent's pod wakes.
 *
 * Mount at /webhooks/email/inbound (NOT /api/...) so the user-auth
 * middleware doesn't intercept and 401 the worker.
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express'
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { storage } from '../storage.js'
import { inc } from '../metrics.js'
import { alertDiscord } from '../alert.js'
import { publicBodyParserError } from '../body-parser-errors.js'
import {
  parseAddress,
  formatAddress,
  normalizeMessageId,
  ensureParticipantAddress,
  findParticipantByAddress,
  findUserInCompanyByAuthEmail,
  findOrCreateEmailConversation,
  persistEmailMessage,
  recordExternalContact,
} from '../email.js'

export const inboundEmailRouter = Router()

// Reject disabled, missing, or malformed authentication before reading a
// potentially large request body. A well-formed signature still requires the
// raw bytes for HMAC, but JSON parsing and object allocation happen only after
// the constant-time comparison succeeds.
inboundEmailRouter.use((req, res, next) => {
  if (!env.EMAIL_INBOUND_HMAC_SECRET) {
    res.status(503).json({ error: 'inbound email disabled (EMAIL_INBOUND_HMAC_SECRET unset)' })
    return
  }
  const signature = String(req.headers['x-cumora-signature'] ?? '')
  if (!signature) {
    res.status(400).json({ error: 'missing signature' })
    return
  }
  if (!normalizeSignature(signature)) {
    inc('email.inbound.bad_signature')
    res.status(401).json({ error: 'bad signature' })
    return
  }
  next()
})

// 25mb mirrors the upload ceiling. `raw` bounds bytes without JSON.parse;
// the following middleware authenticates those exact bytes first.
inboundEmailRouter.use(express.raw({ type: 'application/json', limit: '25mb' }))
inboundEmailRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const parserError = publicBodyParserError(err)
  if (parserError) {
    res.status(parserError.status).json({ error: parserError.message })
    return
  }
  next(err)
})
inboundEmailRouter.use((req, res, next) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : null
  if (!raw) {
    res.status(400).json({ error: 'missing JSON body' })
    return
  }
  const signature = String(req.headers['x-cumora-signature'] ?? '')
  if (!verifySignature(raw, signature)) {
    inc('email.inbound.bad_signature')
    res.status(401).json({ error: 'bad signature' })
    return
  }
  try {
    req.body = JSON.parse(raw.toString('utf8')) as unknown
  } catch {
    res.status(400).json({ error: 'invalid JSON body' })
    return
  }
  next()
})

interface InboundPayload {
  /** The full RFC 5322 Message-ID, with or without angle brackets. */
  messageId: string
  inReplyTo?: string | null
  references?: string[] | null
  /** Each address is a "Name <addr@host>" or just "addr@host" string. */
  from: string
  to?: string[]
  cc?: string[]
  subject?: string
  /** Plain-text body. The worker is responsible for choosing text over
   *  html (or stripping html down) when both are present. */
  text: string
  html?: string | null
  rawSizeBytes?: number | null
  /** Lowercased Auto-Submitted header value, or null when absent / "no".
   *  Heartbeat uses this to skip auto-replying to automation. */
  autoSubmitted?: string | null
  /** Optional attachment list forwarded from the worker. Each entry's
   *  contentBase64 is the raw bytes; truncated=true means the worker
   *  refused to forward the body (oversize) and we should record metadata
   *  only. */
  attachments?: Array<{
    filename: string
    mimeType: string
    sizeBytes: number
    contentBase64: string
    truncated?: boolean
  }>
}

/** Verify a hex-encoded HMAC-SHA256 against the raw body bytes. Constant-
 *  time compare so no timing oracle. */
function normalizeSignature(signature: string): string | null {
  let normalized = signature.trim().toLowerCase()
  if (normalized.startsWith('sha256=')) normalized = normalized.slice(7)
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function verifySignature(rawBody: Buffer, signature: string): boolean {
  const secret = env.EMAIL_INBOUND_HMAC_SECRET
  if (!secret) return false
  const want = createHmac('sha256', secret).update(rawBody).digest('hex')
  const got = normalizeSignature(signature)
  if (!got) return false
  try {
    return timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(got, 'hex'))
  } catch {
    return false
  }
}

/** Resolve a single recipient address to (companyId, participant).
 *  Works for BOTH agents and humans — both have cumora addresses on
 *  the same scheme (`<id>.<slug>@<EMAIL_DOMAIN>`), so an external
 *  reply to a human's cumora address (sent via the compose drawer)
 *  routes back into their workspace inbox same as an agent's.
 *
 *  Returns null when the address doesn't belong to any tenant — the
 *  caller drops it from the fan-out (we don't want to silently route
 *  stray mail to nowhere). */
async function resolveRecipient(addr: string): Promise<{
  companyId: string
  participantId: string
  participantName: string
  participantKind: string
} | null> {
  const lc = addr.trim().toLowerCase()
  if (!lc) return null
  // Try direct address match first — covers the common case + lets
  // participants whose addresses don't fit the standard pattern still
  // work (e.g. an admin-overridden address).
  const { rows } = await pool.query<{ id: string; name: string; kind: string; company_id: string }>(
    `SELECT id, name, kind, company_id FROM participants
      WHERE LOWER(email) = $1 AND departed_at IS NULL
      LIMIT 1`,
    [lc],
  )
  if (rows[0]) return {
    companyId: rows[0].company_id,
    participantId: rows[0].id,
    participantName: rows[0].name,
    participantKind: rows[0].kind,
  }
  // Fallback: pattern-decode `<id>.<companySlug>@<EMAIL_DOMAIN>` for
  // participants whose email column hasn't been lazy-minted yet.
  // Domain must match EMAIL_DOMAIN exactly; local-part splits on the LAST
  // `.` (id portion never contains `.` per safeLocalPart, so this is
  // unambiguous even for ids that contain dashes / underscores).
  const dom = env.EMAIL_DOMAIN
  if (!dom) return null
  const at = lc.indexOf('@')
  if (at < 0) return null
  const localPart = lc.slice(0, at)
  const domPart = lc.slice(at + 1)
  if (domPart !== dom) return null
  const lastDot = localPart.lastIndexOf('.')
  if (lastDot <= 0 || lastDot >= localPart.length - 1) return null
  const localId = localPart.slice(0, lastDot)
  const slug = localPart.slice(lastDot + 1)
  const r2 = await pool.query<{ id: string; name: string; kind: string; company_id: string }>(
    `SELECT p.id, p.name, p.kind, p.company_id
       FROM participants p
       JOIN companies c ON c.id = p.company_id
      WHERE p.departed_at IS NULL
        AND LOWER(c.slug) = $2
        AND (LOWER(p.id) = $1 OR LOWER(REPLACE(p.id, '_', '-')) = $1)
      LIMIT 1`,
    [localId, slug],
  )
  const a = r2.rows[0]
  if (!a) return null
  // Mint the address now so future inbound resolutions hit the fast path.
  await ensureParticipantAddress(a.id, a.company_id).catch(() => { /* swallow */ })
  return {
    companyId: a.company_id,
    participantId: a.id,
    participantName: a.name,
    participantKind: a.kind,
  }
}

interface ResolvedSender {
  /** Author id stored on the messages row. */
  participantId: string
  displayName: string | null
}

/** Resolve "From:" to a participant in the recipient's company.
 *  Hierarchy: known agent → known human user → synthetic external. */
async function resolveSender(args: {
  fromAddr: string
  fromName: string | null
  companyId: string
}): Promise<ResolvedSender> {
  // Same-tenant agent is the most common cross-agent case.
  const agent = await findParticipantByAddress(args.fromAddr, args.companyId)
  if (agent) return { participantId: agent.id, displayName: agent.name }
  // A human in this workspace replied from their real email (e.g. yetone
  // hits "reply" in Gmail to a thread an agent started).
  const user = await findUserInCompanyByAuthEmail(args.fromAddr, args.companyId)
  if (user) return { participantId: user.id, displayName: user.displayName }
  // Stranger / external collaborator. Synthetic id keeps the foreign-key
  // shape happy without us inventing a participants row for every random
  // address that might never email us again. The "external:" prefix is
  // the renderer's signal to draw an "external sender" badge.
  await recordExternalContact({
    companyId: args.companyId,
    address: args.fromAddr,
    displayName: args.fromName,
  })
  return {
    participantId: `external:${args.fromAddr.toLowerCase()}`,
    displayName: args.fromName,
  }
}

inboundEmailRouter.post('/inbound', async (req: Request, res: Response) => {
  const payload = req.body as InboundPayload
  if (!payload || typeof payload.messageId !== 'string' || typeof payload.from !== 'string') {
    res.status(400).json({ error: 'bad payload — need messageId + from' })
    return
  }

  const fromParsed = parseAddress(payload.from)
  if (!fromParsed) {
    res.status(400).json({ error: `unparseable from: ${payload.from}` })
    return
  }
  const rawRecipients = [...(payload.to ?? []), ...(payload.cc ?? [])]
    .map((s) => parseAddress(s))
    .filter((x): x is { addr: string; name: string | null } => Boolean(x))
  if (rawRecipients.length === 0) {
    res.status(400).json({ error: 'no recipients' })
    return
  }

  // De-duplicate recipients by address (e.g. same recipient appearing in both To and Cc).
  const seenAddrs = new Set<string>()
  const recipients: Array<{ addr: string; name: string | null }> = []
  for (const r of rawRecipients) {
    const key = r.addr.toLowerCase()
    if (seenAddrs.has(key)) continue
    seenAddrs.add(key)
    recipients.push(r)
  }

  const subject = (payload.subject ?? '').trim()
  const body = (payload.text ?? '').trim() || stripHtml(payload.html ?? '')
  const html = payload.html ?? null
  const messageIdNorm = normalizeMessageId(payload.messageId)
  if (!messageIdNorm) {
    res.status(400).json({ error: 'invalid messageId' })
    return
  }

  // Group resolved recipients by company up-front.
  // Cumora is strictly tenant-isolated; recipients across different tenants
  // receive separate deliveries, while all recipients in the SAME tenant
  // are grouped onto the same conversation.
  type ResolvedRecipientInfo = NonNullable<Awaited<ReturnType<typeof resolveRecipient>>> & {
    addr: string
    name: string | null
  }
  const byCompany = new Map<string, ResolvedRecipientInfo[]>()
  for (const rcpt of recipients) {
    const resolved = await resolveRecipient(rcpt.addr)
    if (!resolved) continue
    const list = byCompany.get(resolved.companyId) ?? []
    list.push({ ...resolved, addr: rcpt.addr, name: rcpt.name })
    byCompany.set(resolved.companyId, list)
  }

  if (byCompany.size === 0) {
    // No recognized recipient in any tenant. Reject so the worker can
    // bounce upstream — better signal than silently dropping.
    console.log(JSON.stringify({
      evt: 'email.inbound.no_recipient', smtp_message_id: messageIdNorm,
      attempted_recipients: recipients.map((r) => r.addr),
    }))
    inc('email.inbound.no_recipient')
    res.status(404).json({ error: 'no recipient resolved to a known agent' })
    return
  }

  // Idempotency: same Message-ID arriving twice (worker retried, MTA
  // duplicate, etc.) must not create duplicate threads.
  // Pre-check whether this Message-ID already exists across all target companies.
  const targetCompanyIds = Array.from(byCompany.keys())
  const existingRows = await pool.query<{ company_id: string; message_id: string; conversation_id: string }>(
    `SELECT company_id, message_id, conversation_id FROM email_messages
      WHERE LOWER(smtp_message_id) = $1 AND company_id = ANY($2::text[])`,
    [messageIdNorm, targetCompanyIds],
  )
  const existingCompanyMap = new Map(existingRows.rows.map((r) => [r.company_id, r]))
  const allAlreadyDelivered = targetCompanyIds.every((cid) => existingCompanyMap.has(cid))
  if (allAlreadyDelivered) {
    console.log(JSON.stringify({
      evt: 'email.inbound.dedup', smtp_message_id: messageIdNorm,
      existing_message_id: existingRows.rows[0]?.message_id,
    }))
    inc('email.inbound.dedup')
    res.json({ ok: true, deduplicated: true, messageId: existingRows.rows[0]?.message_id })
    return
  }

  // Echo dedup: SES rewrites Message-ID, so when we send to a cumora-domain
  // recipient (e.g. agent-in-same-workspace), the email boomerangs back
  // through our own CF email worker → /webhooks/email/inbound carrying
  // SES's id, not the id we minted + stored on the outbound row. The
  // messageId-based dedup above misses, and the recipient sees a fresh
  // conversation with their own message in it.
  //
  // Heuristic second pass: look for an outbound row with the SAME
  // (from, to, subject) sent within the last 10 minutes. A legitimate
  // human-driven reply will carry In-Reply-To (handled by
  // findOrCreateEmailConversation), so this only fires on the "received
  // a copy of what we just sent" case, not on real replies.
  const fromAddrFull = formatAddress(fromParsed.addr, fromParsed.name)
  const inboundToJson = JSON.stringify((payload.to ?? []).map((s) => s))
  const echo = await pool.query<{ message_id: string; conversation_id: string }>(
    `SELECT message_id, conversation_id FROM email_messages
      WHERE direction = 'out'
        AND created_at > NOW() - INTERVAL '10 minutes'
        AND LOWER(subject) = LOWER($1)
        AND LOWER(from_addr) = LOWER($2)
        AND LOWER(to_addrs::text) = LOWER($3)
      ORDER BY created_at DESC
      LIMIT 1`,
    [subject || '(no subject)', fromAddrFull, inboundToJson],
  )
  if (echo.rows[0]) {
    console.log(JSON.stringify({
      evt: 'email.inbound.echo_dedup', smtp_message_id: messageIdNorm,
      outbound_message_id: echo.rows[0].message_id,
    }))
    inc('email.inbound.dedup')
    res.json({ ok: true, deduplicated: true, echo: true, messageId: echo.rows[0].message_id })
    return
  }

  // Upload attachments once up-front. Each recipient's delivery creates a
  // distinct messages row, so we duplicate the email_attachments metadata
  // rows per-recipient (cheap) but reuse the same storage object — those
  // bytes are identical and live under a stable storage key. Truncated
  // entries skip the upload and persist filename-only so the UI still
  // surfaces "this attachment was too big".
  interface UploadedAttachment {
    filename: string; mimeType: string; sizeBytes: number;
    storageKey: string | null; truncated: boolean
  }
  const uploaded: UploadedAttachment[] = []
  for (const a of payload.attachments ?? []) {
    const filename = (a.filename ?? 'attachment').slice(0, 200)
    const mimeType = (a.mimeType ?? 'application/octet-stream').slice(0, 120)
    const sizeBytes = Math.max(0, Number(a.sizeBytes ?? 0))
    if (a.truncated || !a.contentBase64) {
      uploaded.push({ filename, mimeType, sizeBytes, storageKey: null, truncated: true })
      continue
    }
    try {
      const bytes = Buffer.from(a.contentBase64, 'base64')
      // Suffix from filename if present, else a coarse guess from mime.
      const dotIdx = filename.lastIndexOf('.')
      const ext = dotIdx > 0 ? filename.slice(dotIdx + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : ''
      const key = `email-attachments/${randomUUID()}${ext ? '.' + ext : ''}`
      await storage.put(key, bytes, mimeType)
      uploaded.push({ filename, mimeType, sizeBytes, storageKey: key, truncated: false })
    } catch (e) {
      console.error(JSON.stringify({
        evt: 'email.inbound.attachment_upload_fail', filename,
        size_bytes: sizeBytes, error: e instanceof Error ? e.message : String(e),
      }))
      inc('email.inbound.attachment_upload_fail')
      // Fire-and-forget Discord alert — repeated upload failures usually
      // mean storage creds drifted or the bucket filled up.
      void alertDiscord({
        title: 'email inbound: attachment upload failed',
        detail: `filename=\`${filename}\` size=${sizeBytes} bytes\nerror: ${e instanceof Error ? e.message : String(e)}`,
        level: 'warn',
      })
      uploaded.push({ filename, mimeType, sizeBytes, storageKey: null, truncated: true })
    }
  }

  // Fan out to each company that contains recognized recipients.
  // Cross-tenant deliveries land in each tenant separately.
  const inserts: Array<{ companyId: string; conversationId: string; messageId: string }> = []
  for (const [companyId, companyRecipients] of byCompany.entries()) {
    const existingDelivery = existingCompanyMap.get(companyId)
    if (existingDelivery) {
      inserts.push({
        companyId,
        conversationId: existingDelivery.conversation_id,
        messageId: existingDelivery.message_id,
      })
      continue
    }

    const sender = await resolveSender({
      fromAddr: fromParsed.addr,
      fromName: fromParsed.name,
      companyId,
    })
    const allRecipientParticipantIds = companyRecipients.map((r) => r.participantId)
    const memberIds = Array.from(new Set([sender.participantId, ...allRecipientParticipantIds]))

    const conv = await findOrCreateEmailConversation({
      companyId,
      inReplyTo: payload.inReplyTo ?? null,
      references: payload.references ?? [],
      subject: subject || '(no subject)',
      memberIds,
    })

    try {
      const persisted = await persistEmailMessage({
        conversationId: conv.conversationId,
        companyId,
        authorId: sender.participantId,
        direction: 'in',
        transportStatus: 'received',
        smtpMessageId: messageIdNorm,
        inReplyTo: payload.inReplyTo ?? null,
        references: payload.references ?? [],
        subject: subject || '(no subject)',
        fromAddr: formatAddress(fromParsed.addr, fromParsed.name),
        toAddrs: (payload.to ?? []).map((s) => s),
        ccAddrs: (payload.cc ?? []).map((s) => s),
        body,
        html,
        rawSizeBytes: payload.rawSizeBytes ?? null,
        autoSubmitted: Boolean(payload.autoSubmitted),
        // Pass attachments INTO persistEmailMessage so they're written to
        // email_attachments BEFORE the wake event publishes — otherwise
        // the freshly-arrived bubble in the open chat pane shows up
        // without attachments until the next /messages refetch.
        attachments: uploaded,
      })
      inserts.push({ companyId, conversationId: conv.conversationId, messageId: persisted.messageId })
    } catch (e) {
      // If we just created this conversation and persisting the message failed,
      // clean up the empty conversation so we don't leave a ghost thread behind.
      if (conv.created) {
        await pool.query(
          `DELETE FROM conversations
            WHERE id = $1 AND company_id = $2
              AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1)`,
          [conv.conversationId, companyId],
        ).catch((delErr) => {
          console.warn(`[email] failed to clean up ghost conversation ${conv.conversationId}`, delErr)
        })
      }

      // The unique index on (company_id, LOWER(smtp_message_id)) can race-trip if two
      // workers delivered the same message in parallel. Treat as dedup, not error.
      const msg = e instanceof Error ? e.message : String(e)
      if (/uniq_email_messages_company_smtp_id|uniq_email_messages_smtp_id|duplicate key/i.test(msg)) {
        console.log(JSON.stringify({
          evt: 'email.inbound.race_dedup', smtp_message_id: messageIdNorm,
          company_id: companyId,
        }))
        const raceWinner = await pool.query<{ message_id: string; conversation_id: string }>(
          `SELECT message_id, conversation_id FROM email_messages
            WHERE company_id = $1 AND LOWER(smtp_message_id) = $2
            LIMIT 1`,
          [companyId, messageIdNorm],
        )
        if (raceWinner.rows[0]) {
          inserts.push({
            companyId,
            conversationId: raceWinner.rows[0].conversation_id,
            messageId: raceWinner.rows[0].message_id,
          })
        }
        continue
      }
      console.error(JSON.stringify({
        evt: 'email.inbound.persist_error', company_id: companyId,
        smtp_message_id: messageIdNorm, error: msg,
      }))
    }
  }

  if (inserts.length === 0) {
    console.error(JSON.stringify({
      evt: 'email.inbound.persist_failed_all', smtp_message_id: messageIdNorm,
      attempted_recipients: recipients.map((r) => r.addr),
    }))
    res.status(500).json({ error: 'failed to persist email message' })
    return
  }

  console.log(JSON.stringify({
    evt: 'email.inbound.delivered', smtp_message_id: messageIdNorm,
    delivery_count: inserts.length, auto_submitted: Boolean(payload.autoSubmitted),
    attachment_count: payload.attachments?.length ?? 0,
  }))
  inc('email.inbound.delivered', { auto_submitted: Boolean(payload.autoSubmitted) })
  res.json({ ok: true, deliveries: inserts })
})

/** Coarse HTML→text fallback for inbound mail that arrives html-only.
 *  Real-world MIME parsing happens in the CF worker; this is just the
 *  "we got given an html field, get me something readable" path. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
