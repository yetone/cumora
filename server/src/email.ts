/**
 * Email — outbound (Resend) + address resolution + threading helpers.
 *
 * Agents get a real address shaped `<participantId>.<companySlug>@<EMAIL_DOMAIN>`
 * (apex on purpose — see computeAgentAddress for the why).
 * Addresses are minted lazily the first time something asks for one, so old
 * agents don't need a backfill migration — they get an address on their next
 * email-related action.
 *
 * Inbound is in api/inbound-email.ts (it's a webhook, not an outbound flow).
 *
 * Mock mode: when RESEND_API_KEY is empty, `sendViaProvider` returns a fake
 * smtp_message_id and logs. The rest of the flow (DB writes, threading,
 * agent wakes) runs identically — useful for local dev where you don't
 * want to burn Resend quota.
 */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from './db/pool.js'
import { env } from './env.js'

/** Lowercased domain for an address-construction call. Returns '' when
 *  EMAIL_DOMAIN isn't configured — callers should treat that as "email
 *  feature disabled". */
function rootDomain(): string { return env.EMAIL_DOMAIN }

/** Slug-safe form of companies.slug. Already lowercased + hyphenated per
 *  onboardCompany.ts, but defend against legacy rows that predate that
 *  rule. We strip `.` so the apex address `<id>.<slug>@<dom>` parses
 *  unambiguously by splitting the local-part on its LAST `.`. */
function safeSlugPart(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)
}

/** Local-part sanitizer for an agent id. Same DNS-1123-ish constraints as
 *  the orchestrator pod-name slug — they're related concepts. We strip
 *  `.` so the slug separator in `<id>.<slug>@<dom>` is the only `.` in
 *  the local-part, making reverse parsing unambiguous. */
function safeLocalPart(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64)
}

/** Compute an agent's email address from id + companySlug.
 *  Format: `<sanitized id>.<sanitized slug>@<EMAIL_DOMAIN>`, e.g.
 *  `aurora.acme@cumora.ai`. Apex domain on purpose — keeps Resend's
 *  per-domain DKIM/verification at one-time-setup cost no matter how many
 *  tenants the system grows to. (Earlier iterations used a per-tenant
 *  subdomain; we moved off it because each new company would have needed
 *  its own Resend domain verified.)
 *
 *  Returns null when the email feature isn't configured. */
export function computeAgentAddress(agentId: string, companySlug: string): string | null {
  const dom = rootDomain()
  if (!dom) return null
  const local = safeLocalPart(agentId)
  const slug = safeSlugPart(companySlug)
  if (!local || !slug) return null
  return `${local}.${slug}@${dom}`
}

interface ParticipantAddrRow {
  participant_id: string
  email: string | null
  company_slug: string
  display_name: string
  kind: string
}

/** Read or mint a participant's cumora email address (works for both
 *  agents AND humans — the address scheme is the same:
 *  `<participantId>.<companySlug>@<EMAIL_DOMAIN>`). Idempotent — once
 *  written to participants.email we just return what's there. Returns
 *  null when:
 *    - the participant doesn't exist OR has no company slug, OR
 *    - EMAIL_DOMAIN isn't set (feature disabled).
 *
 *  Why humans need a cumora address (and not their auth gmail / outlook):
 *  Resend will refuse outbound from any domain we haven't verified, so a
 *  human "send via cumora" can't put their personal gmail in the From
 *  line. The cumora address solves both directions — Resend accepts it
 *  (we own cumora.ai), and replies route back through the inbound webhook
 *  so the conversation lives in cumora. The user's auth email becomes a
 *  secondary identifier (still used for /participants display + the
 *  inbound resolver's "is this incoming sender a known workspace
 *  member?" check). */
export async function ensureParticipantAddress(participantId: string, companyId: string): Promise<{
  participantId: string
  email: string
  displayName: string
  kind: string
} | null> {
  const { rows } = await pool.query<ParticipantAddrRow>(
    `SELECT p.id AS participant_id, p.email, p.name AS display_name,
            p.kind, c.slug AS company_slug
       FROM participants p
       JOIN companies c ON c.id = p.company_id
      WHERE p.id = $1 AND p.company_id = $2 AND p.departed_at IS NULL
      LIMIT 1`,
    [participantId, companyId],
  )
  const row = rows[0]
  if (!row) return null
  if (row.email) return { participantId: row.participant_id, email: row.email, displayName: row.display_name, kind: row.kind }
  const minted = computeAgentAddress(row.participant_id, row.company_slug)
  if (!minted) return null
  // Race-safe: the unique index on lower(email) means concurrent mints for
  // the same participant collapse to one row.
  await pool.query(
    `UPDATE participants SET email = $2
      WHERE id = $1 AND company_id = $3 AND email IS NULL`,
    [participantId, minted, companyId],
  )
  return { participantId: row.participant_id, email: minted, displayName: row.display_name, kind: row.kind }
}

/** Backwards-compat shim — older callers that knew the agent id but not
 *  the company id. Looks up the company implicitly. Prefer
 *  ensureParticipantAddress() at new call sites. */
export async function ensureAgentAddress(agentId: string): Promise<{
  agentId: string
  email: string
  displayName: string
} | null> {
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM participants
      WHERE id = $1 AND kind = 'agent' AND departed_at IS NULL LIMIT 1`,
    [agentId],
  )
  if (!rows[0]) return null
  const r = await ensureParticipantAddress(agentId, rows[0].company_id)
  if (!r) return null
  return { agentId: r.participantId, email: r.email, displayName: r.displayName }
}

/** Backfill addresses for every agent in a tenant that doesn't have one.
 *  Used by the boot path when the email feature is freshly enabled, AND
 *  by onboardCompany when a new company is created. */
export async function backfillCompanyAgentAddresses(companyId: string): Promise<number> {
  if (!env.EMAIL_DOMAIN) return 0
  const { rows } = await pool.query<{ id: string; slug: string }>(
    `SELECT p.id, c.slug
       FROM participants p
       JOIN companies c ON c.id = p.company_id
      WHERE p.company_id = $1
        AND p.kind = 'agent' AND p.departed_at IS NULL
        AND p.email IS NULL`,
    [companyId],
  )
  let n = 0
  for (const r of rows) {
    const addr = computeAgentAddress(r.id, r.slug)
    if (!addr) continue
    const u = await pool.query(
      `UPDATE participants SET email = $2
        WHERE id = $1 AND company_id = $3 AND email IS NULL`,
      [r.id, addr, companyId],
    )
    n += u.rowCount ?? 0
  }
  return n
}

/** Parse one address from "Name <addr@host>" or "addr@host". Returns the
 *  lowercased address. Returns null on garbage input — caller handles the
 *  rejection. */
export function parseAddress(raw: string): { addr: string; name: string | null } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(trimmed)
  if (m) {
    const addr = m[2].trim().toLowerCase()
    const name = (m[1] ?? '').trim() || null
    return /^[^@\s]+@[^@\s]+$/.test(addr) ? { addr, name } : null
  }
  const addr = trimmed.toLowerCase()
  return /^[^@\s]+@[^@\s]+$/.test(addr) ? { addr, name: null } : null
}

/** Render "Name <addr>" if a name is given, otherwise just "addr". */
export function formatAddress(addr: string, name: string | null): string {
  if (!name) return addr
  // Quote if the name contains anything that'd confuse a parser.
  const needsQuote = /["<>,;:@()[\]\\]/.test(name)
  const safeName = name.replace(/"/g, '\\"')
  return needsQuote ? `"${safeName}" <${addr}>` : `${safeName} <${addr}>`
}

/** Clean an outbound Subject line: collapse whitespace, strip control chars
 *  and stray BOMs that LLMs occasionally emit, cap length so we never blow
 *  past what MTAs accept (RFC 5322 soft-limit is 998 octets per line; 200
 *  is plenty for a human-readable subject and well under what every webmail
 *  preview pane shows). Returns an empty string only when the input had no
 *  printable characters — callers gate on that. */
export function sanitizeSubject(raw: string): string {
  if (!raw) return ''
  // eslint-disable-next-line no-control-regex
  const stripped = raw
    // ASCII C0 controls + DEL -> space.
    // eslint-disable-next-line no-control-regex
    .replace(/[ -]+/g, ' ')
    // Zero-width / direction marks / BOM -> drop entirely (replacing with
    // a space would create a visible word break where none was intended).
    .replace(/[​-‏‪-‮⁠﻿]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.slice(0, 200)
}

/** Sanitize an inbound HTML email body for safe rendering inside a
 *  sandboxed iframe. Defense in depth: the iframe sandbox (no
 *  `allow-scripts`, no `allow-top-navigation`) is the primary barrier, but
 *  we still strip every obvious vector so the rendered surface stays small
 *  and predictable across mail clients' quirky markup.
 *
 *  Conservative: tags / attributes get dropped, not transformed. Real
 *  mailers ship a lot of inline CSS; we leave style="..." alone because
 *  blocking it would break almost every newsletter, and a sandboxed
 *  iframe can't be navigated or scripted by inline CSS anyway. */
export function sanitizeEmailHtml(raw: string): string {
  if (!raw) return ''
  let out = raw
  // Strip whole tag bodies for anything that can execute or load remote code.
  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'applet', 'svg', 'math']) {
    const re = new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'gi')
    out = out.replace(re, '')
    // Self-closing / unclosed variants.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '')
  }
  // Strip <link> + <meta> entirely — they're load-side-effect or
  // refresh vectors and bring nothing to a rendered email body.
  out = out.replace(/<(?:link|meta|base)\b[^>]*\/?>/gi, '')
  // <!-- comments --> often hide MS Office conditional comments that
  // contain real markup. Drop them — they're never load-bearing in modern
  // mail rendering, and they confuse the regex passes below.
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // Strip event-handler attributes (on*=...) regardless of quoting style.
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
  // Neutralize dangerous URL schemes in href / src / action / formaction /
  // background / poster / xlink:href. We rewrite to "#" rather than dropping
  // the attribute so anchor structure (and the renderer's link icon) stays.
  const urlAttr = /\b(href|src|action|formaction|background|poster|xlink:href|data)\s*=\s*("|'|)\s*(javascript:|vbscript:|data:(?!image\/(?:png|jpeg|gif|webp|svg\+xml);)|file:)/gi
  out = out.replace(urlAttr, (_m, attr, q) => `${attr}=${q || '"'}#${q || '"'}`)
  // Strip srcdoc on any remaining tag (iframe already gone; defense in depth).
  out = out.replace(/\bsrcdoc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  return out
}

/** Reply-all address split. RFC 5322 / typical webmail semantics:
 *    TO  = original From (the person we're answering)
 *    CC  = original To + original Cc, with self / duplicates removed
 *  Earlier iterations collapsed everything into TO, which read fine to
 *  humans but broke any client that uses the CC list to decide whose
 *  attention is required vs. who's merely informed.
 *
 *  selfAddresses are lowercased addresses that identify the replier (their
 *  cumora address AND, for humans, their auth email — both can appear in
 *  the original headers, and either marks "this is me, drop me"). */
export function splitReplyAddresses(args: {
  originalFrom: string
  originalTo: string[]
  originalCc: string[]
  selfAddresses: string[]
}): { to: string[]; cc: string[] } {
  const seen = new Set<string>(args.selfAddresses.map((s) => s.toLowerCase()))
  const fromParsed = parseAddress(args.originalFrom)
  const to: string[] = []
  if (fromParsed && !seen.has(fromParsed.addr)) {
    seen.add(fromParsed.addr)
    to.push(formatAddress(fromParsed.addr, fromParsed.name))
  }
  const cc: string[] = []
  for (const raw of [...(args.originalTo ?? []), ...(args.originalCc ?? [])]) {
    const p = parseAddress(raw)
    if (!p || seen.has(p.addr)) continue
    seen.add(p.addr)
    cc.push(formatAddress(p.addr, p.name))
  }
  return { to, cc }
}

/** Mint an RFC 5322 Message-ID local-half. Domain half is added by the
 *  caller using EMAIL_DOMAIN so the id is recognizable as ours. */
function mintLocalMessageId(): string {
  return `${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 22)}`
}

/** Mint a complete Message-ID (no surrounding angle brackets — we store
 *  bracket-less throughout). Resend assigns its own message-id but for
 *  outbound rows we want a stable id we know up-front so threading writes
 *  can land before the provider call returns. The provider's id (if
 *  different) overwrites this on success. */
export function mintMessageId(): string {
  const dom = env.EMAIL_DOMAIN || 'cumora.local'
  return `${mintLocalMessageId()}@${dom}`
}

/** Strip <…> wrappers and lowercase. Used everywhere we compare a
 *  Message-ID — RFC 5322 says they're case-sensitive, but in practice
 *  every MTA and webmail normalizes; doing the same lets in-reply-to
 *  match references chains across mixed-case providers. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = String(raw).trim().replace(/^<+|>+$/g, '').trim()
  if (!trimmed) return null
  return trimmed.toLowerCase()
}

/** Outcome of a provider send. We always return one — failures don't
 *  throw — so the caller can decide whether to mark transport_status
 *  failed (and what error to record) without try/catch boilerplate. */
export interface ProviderSendResult {
  ok: boolean
  smtpMessageId: string | null
  error: string | null
  /** True when we ran in mock mode (RESEND_API_KEY empty). */
  mock: boolean
}

interface SendArgs {
  /** Full From line: e.g. "Aurora <aurora.acme@cumora.ai>" */
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  html?: string
  /** Bracket-less message-ids to thread under. Resend honors these. */
  inReplyTo?: string | null
  references?: string[]
  /** When set, the provider should accept this id as the Message-ID rather
   *  than minting its own. The same stable value also derives Resend's
   *  Idempotency-Key, making crash recovery safe within its 24-hour window. */
  messageId?: string | null
  /** True when this send is automation (heartbeat decision or agent CLI
   *  shelling out). Adds an RFC 3834 Auto-Submitted header so receiving
   *  MTAs / vacation responders don't bounce-loop with us, and the inbound
   *  side has a signal to refuse auto-replying back. False / omitted for
   *  human-driven sends (compose drawer). */
  autoSubmitted?: 'auto-replied' | 'auto-generated'
  /** Reply-To address (a single mailbox, with or without a display name —
   *  same format as `from`). Used when the From address is a no-inbox
   *  sender (e.g. invites@) but we want replies to land somewhere real
   *  (e.g. the human inviter's mailbox). Resend supports this as a
   *  top-level `reply_to` field; omitting it lets replies default to
   *  From, which for no-inbox addresses means /dev/null. */
  replyTo?: string
  /** Outbound attachments. Each entry MUST supply either base64-encoded
   *  bytes (small inline files, e.g. agent CLI's `--attach`) OR a public
   *  `path` URL Resend can fetch (preferred for already-uploaded files).
   *  Bare metadata-only entries are skipped at provider time — the
   *  message still persists with an email_attachments row marked
   *  truncated, useful when the caller wants the audit trail without
   *  actually attaching bytes. */
  attachments?: Array<{
    filename: string
    mimeType?: string
    /** Base64 body. Wins if both `path` and `base64` are present. */
    base64?: string
    /** Public URL Resend (or curious MTAs) can GET. Used by the human
     *  compose path: file already lives in object storage with a signed
     *  URL, no need to download + re-encode it. */
    path?: string
  }>
}

/** Talk to Resend's HTTP API (or mock). Returns the provider's
 *  message-id. NEVER throws — failures populate `error`. */
export async function sendViaProvider(args: SendArgs): Promise<ProviderSendResult> {
  // Read from process.env directly (not env.*) so:
  //   1. an operator can rotate the Resend key without restarting,
  //   2. the retry integration tests can flip live ↔ mock between cases
  //      by toggling the env var.
  const apiKey = process.env.RESEND_API_KEY ?? ''
  if (!apiKey) {
    // Mock-mode failure injection. EMAIL_MOCK_FAIL_RATE in (0..1] lets local
    // dev exercise the failed-transport branch without burning Resend quota
    // or actually misconfiguring credentials. 0 / unset = always succeed.
    // Read from process.env directly (not env.*) so integration tests can
    // toggle the rate per-call between successful + failing retry attempts
    // without restarting the process.
    const failRate = Math.max(0, Math.min(1, Number(process.env.EMAIL_MOCK_FAIL_RATE ?? 0) || 0))
    if (failRate > 0 && Math.random() < failRate) {
      console.log(`[email/mock] ${args.from} → ${args.to.join(',')} · subj="${args.subject.slice(0, 80)}" · INJECTED FAILURE`)
      const { inc } = await import('./metrics.js')
      inc('email.send.fail', { mock: true })
      return { ok: false, smtpMessageId: null, error: `mock_injected_failure (rate=${failRate})`, mock: true }
    }
    const mockedId = args.messageId ?? mintMessageId()
    const attTag = args.attachments?.length
      ? ` · attach=[${args.attachments.map((a) => a.filename).join(',').slice(0, 200)}]`
      : ''
    console.log(`[email/mock] ${args.from} → ${args.to.join(',')} · subj="${args.subject.slice(0, 80)}"${attTag} · id=${mockedId}`)
    const { inc } = await import('./metrics.js')
    inc('email.send.ok', { mock: true })
    return { ok: true, smtpMessageId: mockedId, error: null, mock: true }
  }
  // Build Resend's payload. Headers field is how we attach In-Reply-To /
  // References — Resend doesn't have first-class fields for those.
  const headers: Record<string, string> = {}
  // Wire Message-ID: hand Resend our minted id and trust SES to honor it.
  // Without this header, SES generates its own Message-ID
  // (`0106xxx@*.amazonses.com`), recipients reply with
  // `In-Reply-To: <SES-id>`, and our threading lookup against
  // email_messages.smtp_message_id (which we set to OUR id) misses —
  // every reply spawns a new conversation. Setting Message-ID
  // explicitly keeps the id we persist matching what's on the wire.
  if (args.messageId) headers['Message-ID'] = `<${args.messageId}>`
  if (args.inReplyTo) headers['In-Reply-To'] = `<${args.inReplyTo}>`
  if (args.references && args.references.length) {
    headers['References'] = args.references.map((r) => `<${r}>`).join(' ')
  }
  if (args.autoSubmitted) {
    headers['Auto-Submitted'] = args.autoSubmitted
  }
  const body: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    subject: args.subject,
    text: args.text,
  }
  if (args.html) body.html = args.html
  if (args.cc?.length) body.cc = args.cc
  if (args.bcc?.length) body.bcc = args.bcc
  if (args.replyTo) body.reply_to = args.replyTo
  if (Object.keys(headers).length) body.headers = headers
  // Resend accepts attachments as [{filename, content}] (base64) OR
  // [{filename, path}] (URL fetched server-side by Resend). We forward
  // whichever the caller supplied; entries with NEITHER are dropped at
  // this layer (no bytes to send) but the persistence layer still records
  // the row as truncated so the recipient sees what was supposed to be
  // there.
  if (args.attachments?.length) {
    const resendAttachments: Array<Record<string, string>> = []
    for (const a of args.attachments) {
      if (a.base64) {
        resendAttachments.push({ filename: a.filename, content: a.base64 })
      } else if (a.path) {
        resendAttachments.push({ filename: a.filename, path: a.path })
      }
    }
    if (resendAttachments.length) body.attachments = resendAttachments
  }

  const t0 = Date.now()
  let res: Response
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(args.messageId
          ? { 'idempotency-key': `cumora-email/${normalizeMessageId(args.messageId) ?? args.messageId}` }
          : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(JSON.stringify({
      evt: 'email.send.network_error', error: msg,
      to_count: args.to.length, cc_count: args.cc?.length ?? 0,
    }))
    const { inc } = await import('./metrics.js')
    inc('email.send.fail', { mock: false })
    return { ok: false, smtpMessageId: null, error: `network: ${msg}`, mock: false }
  }
  const ms = Date.now() - t0
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.warn(JSON.stringify({
      evt: 'email.send.provider_reject', status: res.status,
      detail: text.slice(0, 200), latency_ms: ms,
      to_count: args.to.length, cc_count: args.cc?.length ?? 0,
    }))
    const { inc } = await import('./metrics.js')
    inc('email.send.fail', { mock: false })
    return {
      ok: false,
      smtpMessageId: null,
      error: `resend ${res.status}: ${text.slice(0, 400)}`,
      mock: false,
    }
  }
  // Resend returns { id, ... } where `id` is its INTERNAL provider id
  // (not the wire Message-ID). We pass our minted id via the
  // `Message-ID` header above, so SES emits it on the wire and every
  // downstream MTA references THAT when threading. The provider id is
  // useful for cross-referencing in the Resend dashboard but not for
  // threading lookups.
  let payload: { id?: string } = {}
  try { payload = await res.json() as { id?: string } } catch { /* ignore */ }
  console.log(JSON.stringify({
    evt: 'email.send.ok', provider_id: payload.id ?? null,
    latency_ms: ms, to_count: args.to.length, cc_count: args.cc?.length ?? 0,
    attachment_count: args.attachments?.length ?? 0,
    auto_submitted: args.autoSubmitted ?? null,
  }))
  const { inc } = await import('./metrics.js')
  inc('email.send.ok', { mock: false })
  return {
    ok: true,
    smtpMessageId: args.messageId ?? mintMessageId(),
    error: null,
    mock: false,
  }
}

/** Look up an existing email conversation that any of these message-ids
 *  belong to. Returns the conversation_id of the first match, or null.
 *  Used by the inbound webhook (in-reply-to / references → existing
 *  thread) and by the CLI reply path. */
export async function findEmailConversationByMessageIds(
  messageIds: string[],
  companyId: string,
  client?: PoolClient,
): Promise<string | null> {
  if (messageIds.length === 0) return null
  const norm = messageIds.map(normalizeMessageId).filter((x): x is string => Boolean(x))
  if (norm.length === 0) return null
  const { rows } = await (client ?? pool).query<{ conversation_id: string }>(
    `SELECT conversation_id FROM email_messages
      WHERE company_id = $1
        AND LOWER(smtp_message_id) = ANY($2::text[])
      ORDER BY created_at DESC
      LIMIT 1`,
    [companyId, norm],
  )
  return rows[0]?.conversation_id ?? null
}

/** Resolve a recipient address to a participant in the same company.
 *  Returns null if not found / not in this company. Case-insensitive. */
export async function findParticipantByAddress(
  addr: string,
  companyId: string,
): Promise<{ id: string; name: string; kind: string } | null> {
  const lc = addr.trim().toLowerCase()
  if (!lc) return null
  const { rows } = await pool.query<{ id: string; name: string; kind: string }>(
    `SELECT id, name, kind FROM participants
      WHERE company_id = $1 AND LOWER(email) = $2 AND departed_at IS NULL
      LIMIT 1`,
    [companyId, lc],
  )
  return rows[0] ?? null
}

/** Find a human user by their auth email AND verify they belong to a
 *  given company (so a stranger guessing emails can't post to a tenant
 *  they have no membership in). Returns the user's id, used as the
 *  participant id for human authors. */
export async function findUserInCompanyByAuthEmail(
  authEmail: string,
  companyId: string,
): Promise<{ id: string; displayName: string } | null> {
  const lc = authEmail.trim().toLowerCase()
  if (!lc) return null
  const { rows } = await pool.query<{ id: string; display_name: string }>(
    `SELECT u.id, u.display_name
       FROM users u
       JOIN company_members cm ON cm.user_id = u.id
      WHERE LOWER(u.email) = $1 AND cm.company_id = $2
      LIMIT 1`,
    [lc, companyId],
  )
  return rows[0] ? { id: rows[0].id, displayName: rows[0].display_name } : null
}

/** Insert one row into the messages + email_messages pair, atomically
 *  bumping the conversation sequence and publishing the wake event so
 *  every recipient agent's pod gets a chance to react.
 *
 *  This is the SHARED write path for both directions — outbound (CLI:
 *  `cumora email send/reply`) and inbound (webhook). Centralizing it
 *  keeps the threading invariants in one spot:
 *    - one messages.id per email message; same id is the email_messages PK
 *    - the conversation already exists; caller decides which one
 *    - smtp_message_id is unique within a company (set per direction)
 *    - in_reply_to / references_chain are bracket-less, lowercased
 *    - the sender (authorId) is a participant in the same company
 *    - publish so other agents in the conversation wake naturally
 *
 *  Returns the new messageId. Throws on DB error — caller's catch
 *  surfaces it as a 4xx / CLI error.
 */
export async function persistEmailMessage(args: {
  conversationId: string
  companyId: string
  /** Participant id authoring this message — agent for outbound, agent or
   *  human for inbound from a recognized sender, or a synthetic
   *  `external:<addr>` id for unknown senders. */
  authorId: string
  direction: 'in' | 'out'
  transportStatus: 'queued' | 'sending' | 'sent' | 'failed' | 'received'
  transportError?: string | null
  smtpMessageId: string | null
  inReplyTo: string | null
  references: string[]
  subject: string
  fromAddr: string
  toAddrs: string[]
  ccAddrs?: string[]
  bccAddrs?: string[]
  /** Body the agent / renderer reads. Plain text always, even when the
   *  source was HTML — caller strips tags before passing in. */
  body: string
  html?: string | null
  rawSizeBytes?: number | null
  /** RFC 3834: true means automation generated this. Outbound from the
   *  heartbeat / agent CLI sets this; human-composed sends and inbound
   *  from real humans don't. Used by loadEmailSnapshot to keep the LLM
   *  from auto-replying to other automation (loop protection). */
  autoSubmitted?: boolean
  /** Optional attachment metadata, already-uploaded form. Each entry
   *  becomes one email_attachments row so the renderer's JOIN sees the
   *  same shape it does for inbound mail. `storageKey` is the object-
   *  storage path; pass null when only metadata is being recorded (e.g.
   *  a file that failed to upload — we still want the audit row with
   *  truncated=true). */
  attachments?: Array<{
    filename: string
    mimeType: string
    sizeBytes: number
    storageKey: string | null
    truncated?: boolean
  }>
}): Promise<{ messageId: string; sequence: number }> {
  // Need this lazily to avoid a circular import (redis pulls in env, etc).
  const { CH_MESSAGE_NEW, publish } = await import('./redis.js')
  const messageId = `m-${randomUUID()}`
  interface PersistedAttachment {
    id: string; filename: string; mimeType: string; sizeBytes: number;
    storageKey: string | null; truncated: boolean;
  }
  const persistedAttachments: PersistedAttachment[] = []
  let sequence = 0
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (args.direction === 'out') {
      // Outbound mail is a privileged conversation write. Pin the current
      // participant row before checking membership so a concurrent kick,
      // offboarding, or tenant reassignment serializes at this boundary.
      const actor = await client.query(
        `SELECT id FROM participants
          WHERE id = $1 AND company_id = $2
            AND kind IN ('agent', 'human') AND departed_at IS NULL
          FOR SHARE`,
        [args.authorId, args.companyId],
      )
      if (!actor.rowCount) throw new Error('email author is no longer an active tenant participant')
    }
    const conversation = await client.query(
      `SELECT id FROM conversations
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [args.conversationId, args.companyId],
    )
    if (!conversation.rowCount) throw new Error('email conversation not found or no longer authorized')
    if (args.direction === 'out') {
      const membership = await client.query(
        `SELECT 1 FROM conversation_members
          WHERE conversation_id = $1
            AND company_id = $2
            AND participant_id = $3`,
        [args.conversationId, args.companyId, args.authorId],
      )
      if (!membership.rowCount) throw new Error('email conversation not found or no longer authorized')
    }

    const seqResult = await client.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS seq`,
      [args.conversationId],
    )
    sequence = seqResult.rows[0]?.seq ?? 1
    await client.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'email', $4, $5, $6)`,
      [messageId, args.conversationId, args.authorId, args.body, sequence, args.companyId],
    )
    const initialRetryAt = args.direction === 'out'
      ? (args.transportStatus === 'failed'
          ? new Date(Date.now() + 60_000)
          : args.transportStatus === 'sending'
            ? new Date(Date.now() + 5 * 60_000)
            : null)
      : null
    await client.query(
      `INSERT INTO email_messages (
        message_id, conversation_id, company_id, direction, transport_status,
        transport_error, smtp_message_id, in_reply_to, references_chain,
        subject, from_addr, to_addrs, cc_addrs, bcc_addrs, html, raw_size_bytes,
        auto_submitted, next_retry_at
     ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9::jsonb,
        $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16,
        $17, $18
     )`,
    [
      messageId, args.conversationId, args.companyId, args.direction, args.transportStatus,
      args.transportError ?? null,
      normalizeMessageId(args.smtpMessageId),
      normalizeMessageId(args.inReplyTo),
      JSON.stringify(args.references.map((r) => normalizeMessageId(r)).filter(Boolean)),
      args.subject.slice(0, 1000),
      args.fromAddr.slice(0, 320),
      JSON.stringify(args.toAddrs.slice(0, 64)),
      JSON.stringify((args.ccAddrs ?? []).slice(0, 64)),
      JSON.stringify((args.bccAddrs ?? []).slice(0, 64)),
      args.html ?? null,
      args.rawSizeBytes ?? null,
      Boolean(args.autoSubmitted),
      initialRetryAt,
      ],
    )
    if (args.attachments?.length) {
      for (const a of args.attachments) {
        const attId = `eatt-${randomUUID().slice(0, 12)}`
        const filename = a.filename.slice(0, 200)
        const mimeType = (a.mimeType || 'application/octet-stream').slice(0, 120)
        const truncated = Boolean(a.truncated)
        await client.query(
          `INSERT INTO email_attachments
           (id, message_id, conversation_id, company_id, filename, mime_type, size_bytes, storage_key, truncated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            attId,
            messageId, args.conversationId, args.companyId,
            filename, mimeType, a.sizeBytes,
            a.storageKey, truncated,
          ],
        )
        persistedAttachments.push({
          id: attId, filename, mimeType, sizeBytes: a.sizeBytes,
          storageKey: a.storageKey, truncated,
        })
      }
    }
    await client.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [args.conversationId, args.companyId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  // Resolve a fresh public URL per attachment for the wake event, mirroring
  // what /conversations/:id/messages does on read. Truncated rows stay
  // url=null. Storage failures degrade to null too — the renderer
  // distinguishes that from a real URL.
  const { storage } = await import('./storage.js')
  const wakeAttachments = await Promise.all(persistedAttachments.map(async (a) => {
    let url: string | null = null
    if (a.storageKey && !a.truncated) {
      try { url = await storage.publicUrl(a.storageKey) } catch { url = null }
    }
    return {
      id: a.id, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
      url, truncated: a.truncated,
    }
  }))
  // Wake every member-agent of the conversation. The scheduler dedups
  // across replicas via the wake-claim Redis key.
  await publish(CH_MESSAGE_NEW, {
    type: 'message.new',
    conversationId: args.conversationId,
    companyId: args.companyId,
    message: {
      id: messageId,
      conversationId: args.conversationId,
      authorId: args.authorId,
      kind: 'email',
      body: args.body,
      sequence,
      at: new Date().toISOString(),
      // Mirror what the /messages endpoint emits via JOIN, so a freshly-
      // arrived email bubble in the open chat pane has all the headers
      // it needs without waiting for a /messages refetch on the next view.
      email: {
        subject: args.subject,
        from: args.fromAddr,
        to: args.toAddrs,
        cc: args.ccAddrs ?? [],
        direction: args.direction,
        transportStatus: args.transportStatus,
        transportError: args.transportError ?? null,
        smtpMessageId: normalizeMessageId(args.smtpMessageId),
        inReplyTo: normalizeMessageId(args.inReplyTo),
        hasHtml: Boolean(args.html),
        autoSubmitted: Boolean(args.autoSubmitted),
        attachments: wakeAttachments,
      },
    },
  }).catch((error) => {
    // Persistence is the outbox boundary. A transient Redis outage must not
    // prevent the caller from reaching the provider; clients will refetch the
    // committed row, and a stale `sending` deadline lets the retry worker
    // recover if the process dies before finalizing transport state.
    console.warn(`[email] message publish failed for ${messageId}`, error)
  })
  return { messageId, sequence }
}

/** Find or create the email conversation for a thread. Threading rule:
 *    1. If any in-reply-to / references id matches an existing
 *       email_messages row in this company → reuse that conversation.
 *    2. Else: create a new conversations row (kind='email') with
 *       members = unique([sender, ...recipients]) — the same shape
 *       direct/group conversations use. Title = the subject line
 *       (collapses Re:/Fwd: prefixes for display sanity).
 *
 *  Normalized participant memberships power inbox authorization and wake
 *  fan-out. Synthetic `external:<addr>` author markers are deliberately not
 *  memberships; including the internal sender still makes their own outbox
 *  messages appear in their inbox (matching Gmail's behavior). */
export async function findOrCreateEmailConversation(args: {
  companyId: string
  inReplyTo: string | null
  references: string[]
  subject: string
  /** Participant ids that should be on the conversation. Includes the
   *  sender. Order is preserved for the title fallback ("A ↔ B"). */
  memberIds: string[]
}): Promise<{ conversationId: string; created: boolean }> {
  const concreteMembers = Array.from(new Set(args.memberIds))
    .filter((id) => !id.startsWith('external:'))
    .sort()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (concreteMembers.length > 0) {
      const active = await client.query<{ id: string }>(
        `SELECT id FROM participants
          WHERE company_id = $1 AND id = ANY($2::text[])
            AND kind IN ('agent', 'human') AND departed_at IS NULL
          ORDER BY id FOR SHARE`,
        [args.companyId, concreteMembers],
      )
      if (active.rows.length !== concreteMembers.length) {
        throw new Error('email conversation contains a foreign or departed participant')
      }
    }

    const candidates = [args.inReplyTo, ...args.references]
      .map((x) => normalizeMessageId(x))
      .filter((x): x is string => Boolean(x))
    const existing = await findEmailConversationByMessageIds(candidates, args.companyId, client)
    if (existing) {
      // Serialize thread repair before checking/inserting normalized rows.
      // The next statement gets a fresh snapshot after any lock wait.
      const locked = await client.query(
        `SELECT id FROM conversations
          WHERE id = $1 AND company_id = $2
          FOR UPDATE`,
        [existing, args.companyId],
      )
      if (!locked.rowCount) throw new Error('email conversation moved or disappeared')
      await client.query(
        `INSERT INTO conversation_members (
           conversation_id, company_id, participant_id, ordinal
         )
         SELECT $1, $3, incoming.participant_id,
                base.next_ordinal + incoming.input_ordinal - 1
           FROM UNNEST($2::text[]) WITH ORDINALITY
                  AS incoming(participant_id, input_ordinal)
           CROSS JOIN LATERAL (
             SELECT COALESCE(MAX(ordinal) + 1, 0)::integer AS next_ordinal
               FROM conversation_members
              WHERE conversation_id = $1 AND company_id = $3
           ) base
         ON CONFLICT (conversation_id, participant_id) DO NOTHING`,
        [existing, concreteMembers, args.companyId],
      )
      await client.query(`SELECT refresh_conversation_members_projection($1)`, [existing])
      await client.query('COMMIT')
      return { conversationId: existing, created: false }
    }

    const cleanSubject = args.subject.replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '').trim() || '(no subject)'
    const id = `email-${randomUUID().slice(0, 12)}`
    await client.query(
      `INSERT INTO conversations (id, kind, title, members, company_id, topic)
       VALUES ($1, 'email', $2, $3::jsonb, $4, $5)`,
      [id, cleanSubject.slice(0, 200), JSON.stringify(concreteMembers), args.companyId, cleanSubject.slice(0, 200)],
    )
    await client.query('COMMIT')
    return { conversationId: id, created: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Bump (or create) the email_contacts row for an external sender. We
 *  use this to bias the agent's heartbeat prompt toward people they've
 *  actually corresponded with. Cheap and append-only-ish. */
export async function recordExternalContact(args: {
  companyId: string
  address: string
  displayName: string | null
}): Promise<void> {
  const lc = args.address.trim().toLowerCase()
  if (!lc) return
  await pool.query(
    `INSERT INTO email_contacts (company_id, address, display_name, message_count, last_seen_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (company_id, address) DO UPDATE
       SET message_count = email_contacts.message_count + 1,
           last_seen_at = NOW(),
           display_name = COALESCE(EXCLUDED.display_name, email_contacts.display_name)`,
    [args.companyId, lc, args.displayName ?? null],
  )
}

/** Auto-promote a chat-style reply in an email conversation into a real
 *  email reply. Shared by the HTTP /conversations/:id/messages handler and
 *  the agent CLI's `cumora reply` — both need to detect kind='email'
 *  conversations and route the body through Resend instead of writing a
 *  plain text message that the external recipient never sees.
 *
 *  Builds the reply context from the latest email_messages row in the
 *  conversation: subject (with Re: prefix), In-Reply-To, References,
 *  recipient list (splitReplyAddresses minus self). Sender's From line
 *  uses the caller's cumora-domain address — lazy-minted if it wasn't
 *  there yet, matching the resolver used by /participants. */
export async function replyInEmailConversation(args: {
  conversationId: string
  companyId: string
  authorId: string
  body: string
  /** True when the reply is automation-driven (agent CLI). Stamps the
   *  RFC 3834 Auto-Submitted header so the recipient's vacation responders
   *  and our own loop protection know it's machine-generated. */
  autoSubmitted?: boolean
}): Promise<{ messageId: string; sequence: number; transportStatus: string; mock: boolean; error: string | null }> {
  // Latest email row anchors the reply. Email conversations always have
  // at least one email_messages row (otherwise they wouldn't be kind='email'),
  // so the "no parent" case is a programmer error, not a user-facing path.
  const { rows: parent } = await pool.query<{
    smtp_message_id: string | null
    references_chain: string[]
    subject: string
    from_addr: string
    to_addrs: string[]
    cc_addrs: string[]
  }>(
    `SELECT em.smtp_message_id, em.references_chain, em.subject,
            em.from_addr, em.to_addrs, em.cc_addrs
       FROM email_messages em
      WHERE em.conversation_id = $1
      ORDER BY em.created_at DESC
      LIMIT 1`,
    [args.conversationId],
  )
  const p = parent[0]
  if (!p) {
    throw new Error(`replyInEmailConversation: conversation ${args.conversationId} has no email_messages parent`)
  }

  const sender = await ensureParticipantAddress(args.authorId, args.companyId)
  if (!sender) {
    throw new Error(`replyInEmailConversation: no cumora address for participant ${args.authorId} in ${args.companyId}`)
  }
  // For human authors, ALSO consider their auth email as "self" — the
  // original may have me listed under either my cumora address or my
  // real Gmail. Agents don't have an auth email, query is a no-op.
  const { rows: authUser } = await pool.query<{ email: string | null }>(
    `SELECT email FROM users WHERE id = $1 LIMIT 1`,
    [args.authorId],
  )
  const selfAddrs = [sender.email.toLowerCase()]
  if (authUser[0]?.email) selfAddrs.push(authUser[0].email.toLowerCase())

  // Two cases for the parent row:
  //   (a) Parent is from someone ELSE — reply-all semantics: TO = original
  //       From, CC = original To+Cc minus self.
  //   (b) Parent is from US (we sent the last message; nobody has replied
  //       yet) — splitReplyAddresses would put US in TO and then strip
  //       us out, leaving TO empty. The intent here isn't "reply-all" —
  //       it's "continue the thread to the same people I just addressed".
  //       Use the parent's to_addrs / cc_addrs verbatim (minus self).
  const parentFromParsed = parseAddress(p.from_addr)
  const parentFromIsSelf = parentFromParsed
    ? selfAddrs.includes(parentFromParsed.addr.toLowerCase())
    : false
  let replyTo: string[]
  let replyCc: string[]
  if (parentFromIsSelf) {
    const filterSelf = (addrs: string[]) => addrs.filter((raw) => {
      const p2 = parseAddress(raw)
      return p2 ? !selfAddrs.includes(p2.addr.toLowerCase()) : true
    })
    replyTo = filterSelf(p.to_addrs ?? [])
    replyCc = filterSelf(p.cc_addrs ?? [])
  } else {
    const split = splitReplyAddresses({
      originalFrom: p.from_addr,
      originalTo: p.to_addrs ?? [],
      originalCc: p.cc_addrs ?? [],
      selfAddresses: selfAddrs,
    })
    replyTo = split.to
    replyCc = split.cc
  }
  if (replyTo.length === 0) {
    throw new Error(`replyInEmailConversation: no remaining recipients after self-removal for ${args.conversationId}`)
  }

  const subject = /^(re|fwd|fw)\s*:/i.test(p.subject) ? sanitizeSubject(p.subject) : sanitizeSubject(`Re: ${p.subject}`)
  const newReferences = [...(p.references_chain ?? []), ...(p.smtp_message_id ? [p.smtp_message_id] : [])]
    .filter((x): x is string => Boolean(x))
  const inReplyTo = p.smtp_message_id ? normalizeMessageId(p.smtp_message_id) : null
  const messageId = mintMessageId()
  const fromLine = formatAddress(sender.email, sender.displayName)

  // WRITE-FIRST, then SEND. Previously we sent via Resend FIRST and
  // persisted second — if persist failed after a successful send,
  // the email was delivered to the recipient but no DB row existed,
  // so the next wake would treat the convo as "still un-replied" and
  // send AGAIN. Users got duplicate emails.
  //
  // Now: persist the row as 'sending' BEFORE the network hop. The
  // Message-ID is committed first; if persist fails, no send happens.
  // If send fails after persist, the row stays 'sending' / 'failed'
  // and the email-retry worker picks it up (the existing retry path
  // already handles status='failed' + future next_retry_at). If send
  // succeeds but the post-send UPDATE fails, the retry worker will
  // see status='sending', retry-send with the SAME Message-ID, and
  // Resend dedupes server-side via that header — no duplicate hits
  // the user's inbox.
  const persisted = await persistEmailMessage({
    conversationId: args.conversationId,
    companyId: args.companyId,
    authorId: args.authorId,
    direction: 'out',
    transportStatus: 'sending',
    transportError: null,
    smtpMessageId: messageId,
    inReplyTo,
    references: newReferences,
    subject,
    fromAddr: fromLine,
    toAddrs: replyTo,
    ccAddrs: replyCc,
    body: args.body,
    autoSubmitted: Boolean(args.autoSubmitted),
  })

  const sendRes = await sendViaProvider({
    from: fromLine,
    to: replyTo,
    cc: replyCc.length ? replyCc : undefined,
    subject,
    text: args.body,
    inReplyTo: inReplyTo ?? undefined,
    references: newReferences,
    messageId,
    autoSubmitted: args.autoSubmitted ? 'auto-replied' : undefined,
  })

  // Update the row to its final state. We do NOT throw if this UPDATE
  // fails — the retry worker will fix it on the next tick by reading
  // status='sending' or 'failed' and re-attempting (Resend dedupes by
  // Message-ID). The caller still gets the correct transportStatus
  // returned below.
  const finalStatus = sendRes.ok ? 'sent' : 'failed'
  const finalSmtpId = sendRes.smtpMessageId ?? messageId
  await pool.query(
    `UPDATE email_messages
        SET transport_status = $1,
            transport_error  = $2,
            smtp_message_id  = $3,
            next_retry_at    = $4
      WHERE message_id = $5`,
    [
      finalStatus,
      sendRes.error,
      finalSmtpId,
      // Schedule a retry kick if the send failed; the retry worker
      // owns the rest of the backoff curve.
      finalStatus === 'failed' ? new Date(Date.now() + 60_000) : null,
      persisted.messageId,
    ],
  ).catch((err) => {
    // Row is now in a half-finished state. retry worker will reconcile.
    console.warn(`[email] post-send UPDATE failed for ${persisted.messageId} — leaving for retry worker:`,
      err instanceof Error ? err.message : err)
  })

  return {
    messageId: persisted.messageId,
    sequence: persisted.sequence,
    transportStatus: finalStatus,
    mock: sendRes.mock,
    error: sendRes.error,
  }
}
