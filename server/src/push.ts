/**
 * APNs (Apple Push Notification service) sender.
 *
 * Talks HTTP/2 directly to Apple — no third-party APNs library. JWT auth
 * with an ES256-signed token derived from a `.p8` private key minted in
 * the Apple Developer Portal. The token is cached and rotated every 50
 * minutes (Apple enforces a hard 1-hour ceiling).
 *
 * Soft-disabled when credentials are absent: every public function turns
 * into a no-op that logs once. This lets a dev environment boot without
 * a .p8 dropped in, and lets the WS bridge call `notifyMessage(…)`
 * unconditionally.
 *
 * Token housekeeping: when APNs returns 410 (or the JSON `reason` is
 * `BadDeviceToken` / `Unregistered`) we soft-disable the device row so
 * future sends skip it. Active tokens get their `last_seen_at` bumped
 * on every successful send so we can later purge truly idle devices.
 */
import { readFile } from 'node:fs/promises'
import { createSign } from 'node:crypto'
import { connect, type ClientHttp2Session } from 'node:http2'
import { pool } from './db/pool.js'
import { env } from './env.js'
import { fcmConfigured, fcmSendOne } from './fcm.js'

/** Push payload — narrowed to the fields Cumora actually populates today.
 *  Keep it shaped like APNs `aps` so the future Android port maps cleanly. */
export interface PushPayload {
  title: string
  body: string
  /** Logical grouping — iOS stacks notifications by thread-id. We pass
   *  conversationId here so a noisy convo collapses into one stack on
   *  the lock screen instead of fanning across the whole list. */
  threadId?: string
  /** Optional badge count. iOS clears it via UNUserNotificationCenter
   *  on tap; we just set the most recent total. */
  badge?: number
  /** Custom keys delivered alongside `aps`. Used by the client to deep
   *  link into the convo (or whichever surface) on tap. */
  data?: Record<string, string | number | boolean | null>
}

interface ActiveDeviceRow {
  id: string
  user_id: string
  token: string
  platform: string
}

let credsLogged = false
function credsAreConfigured(): boolean {
  const ok = Boolean(env.APNS_KEY_PATH && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC)
  if (!ok && !credsLogged) {
    console.warn('[push] APNs credentials not configured (APNS_KEY_PATH/APNS_KEY_ID/APNS_TEAM_ID) — push send path is a no-op.')
    credsLogged = true
  }
  return ok
}

// ---------------------------------------------------------------------------
// JWT — Apple wants ES256 over a header { alg, kid, typ } + claims
// { iss: teamId, iat: <unix seconds> }. Signature is in IEEE P1363 format
// (raw r||s, 64 bytes), NOT the default DER that node-crypto emits.
// ---------------------------------------------------------------------------

let cachedKeyPem: string | null = null
let cachedToken: { jwt: string; mintedAt: number } | null = null
const TOKEN_TTL_MS = 50 * 60 * 1000  // refresh well under Apple's 60-min cap

async function loadPrivateKey(): Promise<string> {
  if (cachedKeyPem) return cachedKeyPem
  const raw = await readFile(env.APNS_KEY_PATH, 'utf8')
  cachedKeyPem = raw
  return raw
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function mintJwt(): Promise<string> {
  const now = Date.now()
  if (cachedToken && now - cachedToken.mintedAt < TOKEN_TTL_MS) return cachedToken.jwt
  const pem = await loadPrivateKey()
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID, typ: 'JWT' })))
  const claims = b64url(Buffer.from(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) })))
  const signingInput = `${header}.${claims}`
  const signer = createSign('SHA256')
  signer.update(signingInput)
  signer.end()
  const sig = signer.sign({ key: pem, dsaEncoding: 'ieee-p1363' })
  const jwt = `${signingInput}.${b64url(sig)}`
  cachedToken = { jwt, mintedAt: now }
  return jwt
}

// ---------------------------------------------------------------------------
// HTTP/2 session — Apple recommends keeping one open and reusing it. We hold
// a singleton, reconnect lazily on error / GOAWAY, and bound concurrent
// streams to a sane number so a fan-out doesn't blow past whatever Apple's
// SETTINGS_MAX_CONCURRENT_STREAMS is.
// ---------------------------------------------------------------------------

function apnsHost(): string {
  return env.APNS_ENV === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com'
}

let session: ClientHttp2Session | null = null
function getSession(): ClientHttp2Session {
  if (session && !session.closed && !session.destroyed) return session
  const s = connect(apnsHost())
  s.on('error', (e) => {
    console.warn('[push] APNs http2 session error', e)
  })
  s.on('close', () => {
    if (session === s) session = null
  })
  s.on('goaway', () => {
    if (session === s) session = null
  })
  session = s
  return s
}

interface ApnsResult {
  ok: boolean
  status: number
  reason?: string
}

async function sendOne(token: string, payload: PushPayload): Promise<ApnsResult> {
  const jwt = await mintJwt()
  const s = getSession()
  const aps: Record<string, unknown> = {
    alert: { title: payload.title, body: payload.body },
    sound: 'default',
    'mutable-content': 1,
  }
  if (payload.badge !== undefined) aps.badge = payload.badge
  if (payload.threadId) aps['thread-id'] = payload.threadId
  const body = Buffer.from(JSON.stringify({ aps, ...(payload.data ?? {}) }))
  return await new Promise<ApnsResult>((resolve) => {
    const headers: Record<string, string | number> = {
      ':method': 'POST',
      ':scheme': 'https',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': env.APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      'content-length': body.length,
    }
    let req
    try {
      req = s.request(headers)
    } catch (e) {
      console.warn('[push] APNs request setup failed', e)
      resolve({ ok: false, status: 0, reason: 'session-error' })
      return
    }
    let status = 0
    let respBody = ''
    req.on('response', (h) => {
      const s = h[':status']
      status = typeof s === 'number' ? s : Number.parseInt(String(s ?? 0), 10) || 0
    })
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { respBody += chunk })
    req.on('end', () => {
      if (status >= 200 && status < 300) { resolve({ ok: true, status }); return }
      let reason: string | undefined
      try { reason = (JSON.parse(respBody || '{}') as { reason?: string }).reason } catch { /* ignore */ }
      resolve({ ok: false, status, reason })
    })
    req.on('error', (e) => {
      console.warn('[push] APNs stream error', e)
      resolve({ ok: false, status: 0, reason: 'stream-error' })
    })
    req.write(body)
    req.end()
  })
}

/** Tokens APNs declared dead. These rows get disabled_at=NOW() and stay in
 *  the table so the audit trail survives. Re-registering the same token
 *  from a fresh client clears disabled_at via the upsert. */
const DEAD_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'ExpiredToken', 'DeviceTokenNotForTopic'])

async function disableDeviceById(id: string): Promise<void> {
  try {
    await pool.query(`UPDATE push_devices SET disabled_at = NOW() WHERE id = $1`, [id])
  } catch (e) {
    console.warn(`[push] failed to disable device ${id}`, e)
  }
}

async function touchDeviceById(id: string): Promise<void> {
  try {
    await pool.query(`UPDATE push_devices SET last_seen_at = NOW() WHERE id = $1`, [id])
  } catch { /* non-fatal */ }
}

/** Send a payload to every active iOS + Android device for the given users.
 *  Returns the count of successful deliveries across both platforms. iOS goes
 *  via APNs (sendOne, this file), Android via FCM (fcmSendOne, fcm.ts); web
 *  rows are skipped. A platform whose credentials are absent is skipped
 *  silently so a single-platform dev setup still delivers to the other. */
export async function sendToUsers(userIds: string[], payload: PushPayload): Promise<number> {
  if (userIds.length === 0) return 0
  const apnsOn = credsAreConfigured()
  const fcmOn = fcmConfigured()
  if (!apnsOn && !fcmOn) return 0
  const { rows } = await pool.query<ActiveDeviceRow>(
    `SELECT id, user_id, token, platform
       FROM push_devices
      WHERE user_id = ANY($1::text[])
        AND platform IN ('ios', 'android')
        AND disabled_at IS NULL`,
    [userIds],
  )
  if (rows.length === 0) return 0
  let delivered = 0
  await Promise.all(rows.map(async (row) => {
    try {
      if (row.platform === 'android') {
        if (!fcmOn) return
        const res = await fcmSendOne(row.token, payload)
        if (res.ok) { delivered++; void touchDeviceById(row.id); return }
        if (res.dead) { void disableDeviceById(row.id); return }
        console.warn(`[push] FCM send failed user=${row.user_id} status=${res.status} reason=${res.reason ?? '?'}`)
        return
      }
      // iOS — APNs.
      if (!apnsOn) return
      const res = await sendOne(row.token, payload)
      if (res.ok) { delivered++; void touchDeviceById(row.id); return }
      if (res.status === 410 || (res.reason && DEAD_REASONS.has(res.reason))) {
        void disableDeviceById(row.id)
        return
      }
      // Any other failure: warn but leave the row alone — could be a
      // transient Apple-side blip.
      console.warn(`[push] APNs send failed user=${row.user_id} status=${res.status} reason=${res.reason ?? '?'}`)
    } catch (e) {
      console.warn(`[push] send threw for user=${row.user_id}`, e)
    }
  }))
  return delivered
}

// ---------------------------------------------------------------------------
// High-level: notify recipients of a new chat message.
// ---------------------------------------------------------------------------

interface NotifyMessageArgs {
  conversationId: string
  /** Human-readable convo title. Falls back to "New message". */
  conversationTitle: string | null
  authorId: string
  authorName: string
  messageId: string
  /** Raw message body. Truncated client-side; we ship up to ~240 chars. */
  body: string
  /** Tenants are not used for filtering recipients (already done before
   *  this is called) — we propagate it on the custom payload so the
   *  client can route the deep link without an extra round trip. */
  companyId: string
  /** Pre-computed eligible user ids — convo members minus the author,
   *  minus users muted on this convo, minus users currently connected
   *  to a WS (those get the in-app NotificationToasts treatment and
   *  don't need a system banner). */
  recipientUserIds: string[]
}

/** Trim a message body to a length that fits in an APNs alert without
 *  pushing past the 4 KB payload cap once JSON-encoded. 240 chars is
 *  comfortably under and matches the in-app toast preview length. */
function trimBody(body: string): string {
  const trimmed = body.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= 240) return trimmed
  return `${trimmed.slice(0, 237)}…`
}

/** Observe what notifyMessage was asked to send. Tests only — APNs
 *  soft-disables without credentials, so the send itself is unobservable and
 *  the interesting assertion is the payload the caller built. */
let notifyHookForTesting: ((args: NotifyMessageArgs) => void) | null = null
export function __setNotifyHookForTesting(fn: ((args: NotifyMessageArgs) => void) | null): void {
  notifyHookForTesting = fn
}

export async function notifyMessage(args: NotifyMessageArgs): Promise<void> {
  notifyHookForTesting?.(args)
  if (args.recipientUserIds.length === 0) return
  const title = args.conversationTitle
    ? `${args.authorName} · ${args.conversationTitle}`
    : args.authorName
  await sendToUsers(args.recipientUserIds, {
    title,
    body: trimBody(args.body) || '(empty)',
    threadId: args.conversationId,
    data: {
      conversationId: args.conversationId,
      messageId: args.messageId,
      companyId: args.companyId,
      kind: 'message',
    },
  })
}

/** Recipient calculation: convo members minus author, minus muted users,
 *  minus users currently 'avail' (status flips to avail iff a WS is
 *  connected — see ws.ts:onHumanConnect). Returns the user ids to APNs.
 *
 *  Kept in this file rather than in router.ts so the SQL stays next to
 *  the send path; the publish call in router.ts is a one-liner.
 */
/** Fire-and-forget push for one newly-posted message.
 *
 *  Shared by the human HTTP route and the agent CLI's reply path. A teammate
 *  replying is a teammate replying whichever kind they are, and the in-app
 *  surface has never distinguished them: NotificationToasts fires on any
 *  `message.new` that is not yours and not a system row, and resolves the
 *  author out of the participants roster, which holds agents too. Push was
 *  wired only into POST /conversations/:id/messages — a human-session route
 *  agents never traverse — so a phone stayed silent for exactly the replies
 *  its owner had just asked for.
 *
 *  Recipients are unchanged: computeMessageRecipients joins `users`, so only
 *  humans are ever notified, and the mute and "currently looking at the app"
 *  filters still apply.
 *
 *  Author name resolves through participants first. An agent has no `users`
 *  row, so a users-only lookup would push with a raw agent id as the title. */
export async function dispatchMessagePush(args: {
  conversationId: string
  authorId: string
  messageId: string
  body: string
  companyId: string
}): Promise<void> {
  try {
    const [recipients, convoRow, authorRow] = await Promise.all([
      computeMessageRecipients({ conversationId: args.conversationId, authorId: args.authorId }),
      pool.query<{ title: string }>(
        `SELECT title FROM conversations WHERE id = $1`, [args.conversationId],
      ).then((r) => r.rows[0]),
      pool.query<{ name: string | null }>(
        `SELECT COALESCE(
                  (SELECT name FROM participants WHERE id = $1 AND company_id = $2),
                  (SELECT display_name FROM users WHERE id = $1)
                ) AS name`,
        [args.authorId, args.companyId],
      ).then((r) => r.rows[0]),
    ])
    if (recipients.length === 0) return
    await notifyMessage({
      conversationId: args.conversationId,
      conversationTitle: convoRow?.title ?? null,
      authorId: args.authorId,
      authorName: authorRow?.name ?? args.authorId,
      messageId: args.messageId,
      body: args.body,
      companyId: args.companyId,
      recipientUserIds: recipients,
    })
  } catch (e) {
    console.warn('[push] dispatchMessagePush failed', e)
  }
}

export async function computeMessageRecipients(args: {
  conversationId: string
  authorId: string
}): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT u.id AS user_id
       FROM conversation_members cm
       JOIN users u ON u.id = cm.participant_id
      WHERE cm.conversation_id = $1
        AND u.id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM conversation_mutes m
           WHERE m.conversation_id = $1
             AND m.user_id = u.id
             AND (m.muted_until IS NULL OR m.muted_until > NOW())
        )
        -- Skip humans currently looking at the app. The 'avail' status is
        -- our cross-replica online marker (WS connect flips it; the last
        -- close flips back to 'resting'). NotificationToasts handles them.
        AND NOT EXISTS (
          SELECT 1 FROM participants p
           WHERE p.id = u.id
             AND p.status = 'avail'
        )`,
    [args.conversationId, args.authorId],
  )
  return rows.map((r) => r.user_id)
}
