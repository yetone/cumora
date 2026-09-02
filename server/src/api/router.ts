import { Router, json, type Request, type Response, type NextFunction } from 'express'
import type { PoolClient } from 'pg'
import {
  storage, UPLOAD_DIR, freshenAttachmentUrl, normalizeStorageKey,
  storageKeyFromPublicUrl, messageAttachmentStorageKey,
} from '../storage.js'
import { pool } from '../db/pool.js'
import { CH_MESSAGE_NEW, CH_REACTIONS, CH_CONVO_UPDATED, CH_DOCS, CH_TYPING, CH_CALENDAR_EVENTS, CH_BOARDS, CH_STATUS, publish } from '../redis.js'
import { enqueueBroadcast, nudgeRealtimeOutbox, withOutboxTransaction } from '../realtime-outbox.js'
import { createPoll, castVote, closePoll, PollError } from '../polls.js'
import { env } from '../env.js'
import { publicBodyParserError } from '../body-parser-errors.js'
import { startConvene } from '../agents/convene.js'
import { ensureDirectConversation } from '../agents/private_chat.js'
import { fetchImageBytes } from '../agents/image-fetcher.js'
import { getTriageEconomics, getWakeEconomics } from '../agents/observability.js'
import { resolveKanbanAssigneeChange, wakeKanbanAgents } from '../agents/kanban-wake.js'
import { AgentCreationError, createAgentRecord } from '../agents/create.js'
import { BUSY_STATUS_LEASE_MS } from '../status.js'
import { notifyMessage, computeMessageRecipients } from '../push.js'
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import {
  deleteSession, authMiddleware, type AuthedRequest,
  audit, createWsTicket, gravatarUrlForEmail,
} from '../auth.js'
import { joinAllHands, onboardStarterAgents, seedMemberDms } from '../onboardCompany.js'
import {
  type Provider, providerEnabled, createState, consumeState, isWebOAuthProvider, WEB_OAUTH_PROVIDERS,
  authorizeUrl, handleCallback, errorUrl, publicSignInError, returnUrlAllowed,
} from '../oauth.js'
import { adminRouter } from './admin-router.js'
import { isWaitlistEnabled } from '../admin.js'
import { ogPreview, OgError } from '../og.js'
import { sendInvitationEmail, type InvitationEmailDelivery } from '../invitation-email.js'
import { getUserQuota, sub2apiConfigured } from '../sub2api.js'
import {
  ensureCloudComputer, issuePairingCode, pairComputer, announceComputerOnline,
  resolveDevice, mintAgentRuntimeToken, listAgentsForComputer,
  listComputers, revokeComputer, assignAgentToComputer, heartbeatComputer,
  cloudComputerId, issueRepairCode, requestEngineDetect, reportDetectedEngines,
  setComputerDefaultEngine,
} from '../agents/computer/registry.js'
import { attachComputerControlStream, deliverEngineDetect } from '../agents/computer/control-bus.js'
import { companyTier } from '../tier.js'
import { createShippingRouter } from './shipping-router.js'
import {
  findIdempotentCreate, IdempotencyConflictError,
  parseRequestId, requestHash,
} from '../idempotent-create.js'

/** Re-export so older imports (server/index.ts, agents/cli.ts) keep working
 *  after the storage abstraction moved this constant. */
export { UPLOAD_DIR }

/** Per-mime upload policy.
 *
 *  - `kind` decides how the message bubble renders the attachment.
 *  - `ext` becomes the file extension on disk (used for nice download names).
 *
 *  The whitelist is conservative: images for inline preview, common docs +
 *  archives for "send file", and the text-ish family so agents can read the
 *  content into context. Anything outside this map gets rejected at the
 *  upload edge.
 */
const MIME_POLICY: Record<string, { kind: 'img' | 'file'; ext: string }> = {
  // Images — inline preview + vision
  'image/png':  { kind: 'img',  ext: 'png'  },
  'image/jpeg': { kind: 'img',  ext: 'jpg'  },
  'image/webp': { kind: 'img',  ext: 'webp' },
  'image/gif':  { kind: 'img',  ext: 'gif'  },
  // Documents
  'application/pdf': { kind: 'file', ext: 'pdf' },
  'application/msword': { kind: 'file', ext: 'doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'file', ext: 'docx' },
  'application/vnd.ms-excel': { kind: 'file', ext: 'xls' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { kind: 'file', ext: 'xlsx' },
  'application/vnd.ms-powerpoint': { kind: 'file', ext: 'ppt' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { kind: 'file', ext: 'pptx' },
  // Archives
  'application/zip': { kind: 'file', ext: 'zip' },
  'application/x-tar': { kind: 'file', ext: 'tar' },
  'application/gzip': { kind: 'file', ext: 'gz' },
  // Text & code (extractable into agent context)
  'text/plain': { kind: 'file', ext: 'txt' },
  'text/markdown': { kind: 'file', ext: 'md' },
  'text/csv': { kind: 'file', ext: 'csv' },
  // NOTE: text/html is intentionally NOT accepted. An uploaded .html served
  // from the app origin (local-storage mode) would run as the app and could
  // read the localStorage session token — stored XSS → account takeover. The
  // /uploads static handler also forces nosniff + attachment disposition as
  // defense in depth, but the durable fix is never storing active content.
  'application/json': { kind: 'file', ext: 'json' },
  'application/x-yaml': { kind: 'file', ext: 'yml' },
  'application/x-toml': { kind: 'file', ext: 'toml' },
  // Audio / video — light support
  'audio/mpeg': { kind: 'file', ext: 'mp3' },
  'audio/wav': { kind: 'file', ext: 'wav' },
  'video/mp4': { kind: 'file', ext: 'mp4' },
  'video/quicktime': { kind: 'file', ext: 'mov' },
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024  // 25 MB (Skype-like ceiling)

interface AttachmentPayload {
  name: string
  kind: 'img' | 'pdf' | 'file' | 'fig'
  url: string
  mime?: string
  size?: number
  /** Storage key — present when the file lives in object storage; lets us
   *  resolve a fresh URL later without re-uploading. */
  key?: string
}

export const api = Router()

// Every request goes through the auth middleware first; handlers that need
// a logged-in user call `requireAuth(req)` which throws 401 otherwise.
api.use(authMiddleware as never)

// Ordinary API payloads do not contain file bytes. Keep their ceiling small
// even for anonymous/public endpoints so an unauthenticated caller can never
// make the server parse the former global 34MB JSON allowance. The one route
// that legitimately carries base64 file data is excluded here and installs
// its larger parser only after a valid user session has been established.
const defaultJsonParser = json({ limit: '256kb' })
const uploadJsonParser = json({ limit: '34mb' })
api.use((req, res, next) => {
  if (req.method === 'POST' && /^\/uploads\/?$/.test(req.path)) {
    next()
    return
  }
  defaultJsonParser(req, res, next)
})

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function createRequestId(value: unknown): string | null {
  try {
    return parseRequestId(value)
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'invalid requestId')
  }
}

async function createReplay(
  client: PoolClient,
  args: Parameters<typeof findIdempotentCreate>[1],
): Promise<{ id: string } | null> {
  try {
    return await findIdempotentCreate(client, args)
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      throw new HttpError(error.status, error.message)
    }
    throw error
  }
}

/** Throw 401 if the request has no valid session. Returns the user_id. */
function requireAuth(req: Request & AuthedRequest): string {
  const id = req.authUserId
  if (!id) throw new HttpError(401, 'authentication required')
  return id
}

/** Reject the only large JSON route before its parser consumes any bytes. */
function requireAuthBeforeLargeBody(
  req: Request & AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!req.authUserId) {
    res.status(401).json({ error: 'authentication required' })
    return
  }
  next()
}

/** Backwards-compat alias for older handlers. Same semantics as requireAuth.
 *  Auth is now enforced everywhere — no more dev-mode header spoofing. */
function userId(req: Request & AuthedRequest): string {
  return requireAuth(req)
}

function deviceBearerToken(req: Request): string {
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

/** Resolve the calling Computer daemon from its device-token Bearer header,
 *  or throw 401. Used by daemon-facing endpoints that carry no user session —
 *  the device token (issued at pairing) is the credential. */
async function requireDevice(req: Request & AuthedRequest): Promise<{ computerId: string; companyId: string }> {
  const dev = await resolveDevice(deviceBearerToken(req))
  if (!dev) throw new HttpError(401, 'invalid or revoked device token')
  return dev
}

const TIER_LIMITS = {
  free: { companiesPerUser: 3,  agentsPerCompany: 10, humansPerCompany: 5  },
  pro:  { companiesPerUser: 10, agentsPerCompany: 20, humansPerCompany: 10 },
  max:  { companiesPerUser: 25, agentsPerCompany: 50, humansPerCompany: 25 },
} as const

type Tier = keyof typeof TIER_LIMITS

type Queryable = {
  query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>
}

function normalizeTier(tier: string | null | undefined): Tier {
  return tier === 'pro' || tier === 'max' ? tier : 'free'
}

async function assertUserCompanyLimit(userId: string, db: Queryable = pool): Promise<void> {
  const { rows } = await db.query<{ tier: string | null; companyCount: number }>(
    `SELECT u.tier,
            COUNT(cm.company_id)::int AS "companyCount"
       FROM users u
       LEFT JOIN company_members cm ON cm.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.tier`,
    [userId],
  )
  const row = rows[0]
  if (!row) throw new HttpError(401, 'session points to missing user')
  const tier = normalizeTier(row.tier)
  const limit = TIER_LIMITS[tier].companiesPerUser
  if (row.companyCount >= limit) {
    throw new HttpError(403, `${tier} tier users can belong to at most ${limit} companies`)
  }
}

async function companyPlanTier(companyId: string, db: Queryable = pool): Promise<Tier> {
  const { rows } = await db.query<{ tier: string | null }>(
    `SELECT COALESCE(owner_user.tier, owner_member.tier, 'free') AS tier
       FROM companies c
       LEFT JOIN users owner_user ON owner_user.id = c.owner_user_id
       LEFT JOIN LATERAL (
         SELECT u.tier
           FROM company_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.company_id = c.id AND cm.role = 'owner'
          ORDER BY cm.joined_at ASC
          LIMIT 1
       ) owner_member ON TRUE
      WHERE c.id = $1`,
    [companyId],
  )
  return normalizeTier(rows[0]?.tier)
}

async function companyHumanSeatInfo(companyId: string, db: Queryable = pool): Promise<{
  tier: Tier
  used: number
  limit: number
}> {
  const tier = await companyPlanTier(companyId, db)
  const { rows } = await db.query<{ used: number }>(
    `SELECT COUNT(*)::int AS used
       FROM company_members
      WHERE company_id = $1`,
    [companyId],
  )
  return { tier, used: rows[0]?.used ?? 0, limit: TIER_LIMITS[tier].humansPerCompany }
}

async function assertCompanyHumanLimit(companyId: string, db: Queryable = pool): Promise<void> {
  const seats = await companyHumanSeatInfo(companyId, db)
  if (seats.used >= seats.limit) {
    throw new HttpError(403, `${seats.tier} tier workspaces can have at most ${seats.limit} human members`)
  }
}

async function assertCompanyAgentLimit(companyId: string, db: Queryable = pool): Promise<void> {
  const tier = await companyPlanTier(companyId, db)
  const limit = TIER_LIMITS[tier].agentsPerCompany
  const { rows } = await db.query<{ agentCount: number }>(
    `SELECT COUNT(*)::int AS "agentCount"
       FROM participants
      WHERE company_id = $1
        AND kind = 'agent'
        AND departed_at IS NULL`,
    [companyId],
  )
  if ((rows[0]?.agentCount ?? 0) >= limit) {
    throw new HttpError(403, `${tier} tier workspaces can have at most ${limit} active agents`)
  }
}

/**
 * Resolve the active company for an authenticated request.
 *  - Reads `x-company-id` header for the requested tenant
 *  - Verifies the authed user is a member of it (company_members)
 *  - Falls back to the user's earliest-joined company when no header is set
 *  - Throws 403 on any membership mismatch — never trusts the header alone
 *
 * Async + DB-validated by design: there's no scenario where a header alone
 * grants access to a company.
 */
async function requireCompany(req: Request & AuthedRequest): Promise<{ userId: string; companyId: string }> {
  const userId = requireAuth(req)
  const requested = (() => {
    const h = req.headers['x-company-id']
    return typeof h === 'string' && h ? h.trim() : null
  })()
  if (requested) {
    const { rows } = await pool.query(
      `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
      [requested, userId],
    )
    if (rows.length === 0) throw new HttpError(403, 'not a member of this company')
    return { userId, companyId: requested }
  }
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM company_members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1`,
    [userId],
  )
  if (!rows[0]) throw new HttpError(404, 'no company memberships — create or join one')
  return { userId, companyId: rows[0].company_id }
}

const DEVTOOLS_HEADER = 'x-cumora-dev-mode'
const DEVTOOLS_ROLES = new Set(['owner', 'admin'])
/** Privileged role set used for owner/admin gates on agent + project mutations
 *  and any other "shared workspace resource" write paths. Kept as a Set so
 *  call sites read as a single predicate. */
const PRIVILEGED_ROLES = DEVTOOLS_ROLES
/** Strictly the company owner — used for the most sensitive surfaces (e.g. the
 *  whisper / agent-chat observer view, which exposes EVERY agent-to-agent
 *  conversation in the workspace). Not even admins; owner only. */
const OWNER_ONLY = new Set(['owner'])

function requestedDevMode(req: Request): boolean {
  const h = req.headers[DEVTOOLS_HEADER]
  return h === '1' || h === 'true'
}

/**
 * Tenant + role gate in one round-trip. Resolves the active company (same
 * header/membership rules as `requireCompany`), then verifies the caller's
 * role is in `allowedRoles`. Used for owner/admin-only mutations (agent
 * CRUD, project edit/archive) — by default `PRIVILEGED_ROLES` = owner+admin.
 *
 * Throws 403 with a stable message string; the frontend matches on it to
 * surface the "ask an owner" affordance.
 */
async function requireCompanyRole(
  req: Request & AuthedRequest,
  allowedRoles: ReadonlySet<string> = PRIVILEGED_ROLES,
): Promise<{ userId: string; companyId: string; role: string }> {
  const { userId, companyId } = await requireCompany(req)
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
    [companyId, userId],
  )
  const role = rows[0]?.role ?? 'member'
  if (!allowedRoles.has(role)) {
    throw new HttpError(403, 'this action requires an owner or admin of the workspace')
  }
  return { userId, companyId, role }
}

/**
 * Tenant + conversation membership gate in one round-trip.
 *
 * Verifies (a) the caller belongs to the active tenant and (b) the
 * conversation lives in that tenant AND (c) the caller is in the
 * conversation's `members` array. This is the missing check that used to
 * allow any tenant member to read or react in conversations they weren't
 * part of (private DMs etc.).
 *
 * Returns the resolved tenant + the conversation's members + kind so call
 * sites that already had to re-query for those don't double-fetch.
 *
 * Throws 404 (not 403) on missing-or-unauthorized so we don't leak the
 * existence of a conversation the caller can't see — same posture the
 * tenant-only gate already had.
 */
async function requireConversationMember(
  req: Request & AuthedRequest,
  conversationId: string,
): Promise<{ userId: string; companyId: string; members: string[]; kind: string }> {
  const { userId, companyId } = await requireCompany(req)
  const { rows } = await pool.query<{ members: string[]; kind: string }>(
    `SELECT members, kind FROM conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [conversationId, companyId],
  )
  if (!rows[0]) throw new HttpError(404, 'not found')
  if (!rows[0].members.includes(userId)) {
    // Stay opaque: same 404 a non-existent / cross-tenant convo returns,
    // so a probing client can't tell "doesn't exist" from "I'm not in it".
    throw new HttpError(404, 'not found')
  }
  return { userId, companyId, members: rows[0].members, kind: rows[0].kind }
}

/** Execute a conversation mutation at a linearizable authorization point.
 * Lock order is always participant -> conversation, matching membership
 * helpers. The conversation row is exclusive because every current caller
 * mutates either it or state whose authorization derives from its members. */
async function withLockedConversationMember<T>(args: {
  userId: string
  companyId: string
  conversationId: string
  work: (
    client: PoolClient,
    conversation: { members: string[]; kind: string; pinned: boolean },
  ) => Promise<T>
}): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const actor = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        FOR SHARE`,
      [args.userId, args.companyId],
    )
    if (!actor.rowCount) throw new HttpError(404, 'not found')
    const { rows } = await client.query<{ members: string[]; kind: string; pinned: boolean }>(
      `SELECT members, kind, pinned FROM conversations
        WHERE id = $1 AND company_id = $2
          AND members @> to_jsonb(ARRAY[$3::text])
        FOR UPDATE`,
      [args.conversationId, args.companyId, args.userId],
    )
    if (!rows[0]) throw new HttpError(404, 'not found')
    const result = await args.work(client, rows[0])
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function getDevtoolsState(req: Request & AuthedRequest): Promise<{
  userId: string
  companyId: string
  role: string
  localDev: boolean
  requested: boolean
  canEnable: boolean
  enabled: boolean
}> {
  const { userId, companyId } = await requireCompany(req)
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
    [companyId, userId],
  )
  const role = rows[0]?.role ?? 'member'
  const localDev = env.NODE_ENV !== 'production'
  const requested = requestedDevMode(req)
  const privileged = DEVTOOLS_ROLES.has(role)
  const canEnable = localDev || privileged
  const enabled = localDev || (requested && privileged)
  return { userId, companyId, role, localDev, requested, canEnable, enabled }
}

async function requireDevtools(req: Request & AuthedRequest): Promise<{ userId: string; companyId: string; role: string }> {
  const state = await getDevtoolsState(req)
  if (!state.enabled) throw new HttpError(403, 'developer tools are not enabled')
  return { userId: state.userId, companyId: state.companyId, role: state.role }
}

/** Wrap an async handler so thrown HttpErrors become real status codes.
 *  Used for the new auth endpoints which need to short-circuit; the global
 *  errorHandler at the bottom of this router catches HttpErrors from any
 *  other handler too thanks to Express 5's async-rejection forwarding. */
function safe(handler: (req: Request & AuthedRequest, res: Response) => Promise<void> | void) {
  return async (req: Request & AuthedRequest, res: Response, next: NextFunction) => {
    try {
      await handler(req, res)
    } catch (e) {
      if (e instanceof HttpError) {
        res.status(e.status).json({ error: e.message })
        return
      }
      console.error('[api] unhandled', e)
      next(e)
    }
  }
}

/** Mounted at the bottom of this router as a global error handler — every
 *  async route's rejection bubbles here in Express 5. HttpError → its status
 *  code; anything else → 500 with a generic message (real cause logged). */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  const parserError = publicBodyParserError(err)
  if (parserError) {
    res.status(parserError.status).json({ error: parserError.message })
    return
  }
  console.error('[api] 500', err)
  // Dev mode: surface the actual message + stack to the client so failures
  // can be debugged without log-diving. Production hides the cause.
  if (env.NODE_ENV !== 'production') {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    res.status(500).json({ error: message, stack })
    return
  }
  res.status(500).json({ error: 'internal server error' })
}

/** Build a stable storage key from policy + a random UUID. Files land
 *  under `attachments/` so they don't collide with avatar keys. */
function attachmentKey(mime: string): { key: string; ext: string } | null {
  const policy = MIME_POLICY[mime]
  if (!policy) return null
  const id = randomUUID().replace(/-/g, '')
  return { key: `attachments/${id}.${policy.ext}`, ext: policy.ext }
}

/**
 * Tell the client which upload path is available. Frontend uses this to
 * decide between presign (R2) and base64 (local fallback) — saves a round
 * trip per attachment vs. probing the presign endpoint and handling 501.
 */
api.get('/uploads/capabilities', (_req, res) => {
  res.json({
    mode: storage.mode,
    presignSupported: storage.mode === 'r2',
    maxBytes: MAX_UPLOAD_BYTES,
    // Echo the allowed mimes so the frontend can render the right `accept`
    // attribute on the file input (and reject early before round-tripping).
    allowedMimes: Object.keys(MIME_POLICY),
  })
})

/**
 * Presign a direct browser→R2 PUT. Returns the URL the browser PUTs the
 * file to, plus the public URL it'll be available at after the upload.
 * Only works when storage is in R2 mode — local mode advertises this via
 * `/uploads/capabilities` so the client knows to use the base64 fallback.
 *
 * Body: { name, mime, size }
 * Returns: { uploadUrl, publicUrl, key, name, mime, size, kind }
 */
api.post('/uploads/presign', async (req, res) => {
  // Auth + tenant gate. Without this, anyone on the open internet could mint
  // signed R2 PUT URLs and burn through our storage quota / host arbitrary
  // content under our domain. Membership-only is enough — we don't restrict
  // uploads by role since attachments are a basic chat affordance.
  await requireCompany(req)
  if (storage.mode !== 'r2') {
    res.status(501).json({ error: 'presign not available in local mode — POST /uploads instead' })
    return
  }
  const name = String(req.body?.name ?? '').trim().slice(0, 200)
  const mime = String(req.body?.mime ?? '').trim().toLowerCase()
  const size = Number(req.body?.size ?? 0)
  if (!name || !mime) { res.status(400).json({ error: 'name + mime required' }); return }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `size out of range (got ${size}, max ${MAX_UPLOAD_BYTES})` })
    return
  }
  const policy = MIME_POLICY[mime]
  const k = attachmentKey(mime)
  if (!policy || !k) { res.status(415).json({ error: `mime not allowed: ${mime}` }); return }
  const signed = await storage.presignPut(k.key, mime)
  res.json({
    uploadUrl: signed.uploadUrl,
    publicUrl: signed.publicUrl,
    key: k.key,
    name,
    mime,
    size,
    kind: policy.kind,
  })
})

/**
 * Base64 upload — works in both storage modes. The browser sends a
 * `{name, mime, dataBase64}` body; the server decodes, validates, and
 * writes via the storage abstraction. This is the local-mode primary
 * path AND the R2-mode fallback for tiny files where the round-trip cost
 * of presign isn't worth it.
 */
api.post('/uploads', requireAuthBeforeLargeBody, uploadJsonParser, async (req, res) => {
  // Auth + tenant gate. Without this, anyone on the open internet could push
  // 25MB blobs into our storage — a DoS + cost vector. Membership-only is
  // sufficient since attachments are a baseline chat feature.
  await requireCompany(req)
  const name = String(req.body?.name ?? '').trim().slice(0, 200)
  const mime = String(req.body?.mime ?? '').trim().toLowerCase()
  const dataBase64 = String(req.body?.dataBase64 ?? '')
  if (!name || !mime || !dataBase64) {
    res.status(400).json({ error: 'name, mime, dataBase64 are required' })
    return
  }
  const policy = MIME_POLICY[mime]
  if (!policy) {
    res.status(415).json({ error: `mime not allowed: ${mime}` })
    return
  }
  let buf: Buffer
  try {
    buf = Buffer.from(dataBase64, 'base64')
  } catch {
    res.status(400).json({ error: 'invalid base64' })
    return
  }
  if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
    res.status(413).json({ error: `size out of range (got ${buf.length}, max ${MAX_UPLOAD_BYTES})` })
    return
  }
  const k = attachmentKey(mime)
  if (!k) { res.status(415).json({ error: `mime not allowed: ${mime}` }); return }
  const url = await storage.put(k.key, buf, mime)
  res.json({
    url,
    key: k.key,
    name,
    mime,
    size: buf.length,
    kind: policy.kind,
  })
})

api.post('/uploads/refresh-url', safe(async (req, res) => {
  await requireCompany(req)
  const url = String(req.body?.url ?? '').trim()
  const requestedKey = String(req.body?.key ?? '').trim()
  const key = normalizeStorageKey(requestedKey) ?? (url ? storageKeyFromPublicUrl(url) : null)
  if (!key) throw new HttpError(400, 'not a Cumora storage URL')
  res.json({ key, url: await storage.publicUrl(key) })
}))

// Liveness: "is this process alive?" — MUST NOT touch the DB. A slow or
// overloaded DB must never cause Kubernetes to KILL the pod: that's how a
// transient DB hiccup snowballed into the 502 outage — the liveness probe hit
// the same exhausted pool, timed out, and pods were SIGTERM-killed (exit 143),
// shedding capacity exactly when it was needed. Point the livenessProbe here.
api.get('/livez', (_req, res) => { res.json({ ok: true, ts: Date.now() }) })

// Readiness: "can this pod serve?" — checks DB reachability, but FAILS FAST.
// Capped at 1s so the probe gets a deterministic 200/503 instead of hanging on
// a busy pool until its own 2s deadline (which read as a flaky timeout and could
// trip both replicas at once under load). A NotReady pod is only pulled from
// rotation — never killed — so it rejoins as soon as the DB frees up.
api.get('/health', async (_req, res) => {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('health db check timed out')), 1000)),
    ])
    res.json({ ok: true, ts: Date.now() })
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e) })
  }
})

/* GET /api/og?url=<encoded url> — Open-Graph / link-preview proxy.
 *
 * The chat renderer calls this when it autodetects a URL in a message body
 * so it can draw a card with the page's title / description / image. We
 * proxy the fetch server-side because:
 *   - Browsers can't read cross-origin HTML to extract og:* themselves.
 *   - One Redis cache here serves every client (and every replay of the
 *     same message), so the upstream site sees one hit instead of N.
 *   - Centralizing the fetch lets us enforce size / time / SSRF safety.
 *
 * Cached responses are returned at sub-ms latency; misses can take up to
 * FETCH_TIMEOUT_MS in og.ts (~6s). Errors that come from the user input
 * (bad URL, blocked private host) return 4xx so the frontend can silently
 * skip rendering the card; transient upstream / network failures map to
 * 502 / 504 the same way. */
api.get('/og', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : ''
  if (!url) {
    res.status(400).json({ error: 'url required' })
    return
  }
  try {
    const og = await ogPreview(url)
    // 5min CDN/browser cache so identical requests from sibling clients in
    // a conversation don't all hit our Redis. Redis itself still owns the
    // longer 7-day server-side cache.
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.json(og ?? { url, empty: true })
  } catch (e) {
    if (e instanceof OgError) {
      res.status(e.status).json({ error: e.message })
      return
    }
    res.status(500).json({ error: 'og fetch failed' })
  }
})

/* GET /api/public/signup-config — unauthenticated read of the bits of
 * app_settings that govern what the marketing page (cumora.ai) should
 * offer brand-new visitors. Today that's just `waitlist_enabled`: when
 * true, the landing page hides the desktop download buttons and shows
 * a "Join Waitlist" CTA instead, so visitors don't install an app they
 * can't yet sign into.
 *
 * Always sends `Access-Control-Allow-Origin: *` because the consumer is
 * a static site on a different host than this API, and the response
 * contains no per-user data. */
api.get('/public/signup-config', async (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=30')
  try {
    const waitlistEnabled = await isWaitlistEnabled()
    res.json({ waitlist_enabled: waitlistEnabled })
  } catch {
    res.json({ waitlist_enabled: false })
  }
})

/* GET /api/metrics — Prometheus text exposition for the email + agent
 * counters. Token-gated via METRICS_BEARER_TOKEN env var; the endpoint
 * is 404 when the token is unset so a deploy that hasn't set up
 * Prometheus doesn't accidentally leak internal counts to anyone who
 * stumbles on the URL. Accepts the token as `?token=` query OR
 * `Authorization: Bearer <token>` header — Prometheus scrapers can
 * configure either way. */
api.get('/metrics', async (req, res) => {
  // Read process.env directly (not env.*) so an operator can rotate the
  // token without restarting the server, and so integration tests can
  // toggle the gated/ungated paths without a fresh module graph.
  const expected = process.env.METRICS_BEARER_TOKEN ?? ''
  if (!expected) { res.status(404).send('not found'); return }
  const fromQuery = typeof req.query.token === 'string' ? req.query.token : ''
  const fromHeader = (() => {
    const h = req.headers.authorization
    if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim()
    return ''
  })()
  const got = fromQuery || fromHeader
  // Constant-time compare to defend against timing oracles.
  const a = Buffer.from(expected)
  const b = Buffer.from(got)
  let ok = a.length === b.length
  if (ok) {
    try { ok = timingSafeEqual(a, b) }
    catch { ok = false }
  }
  if (!ok) { res.status(401).send('bad token'); return }
  const { renderProm } = await import('../metrics.js')
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  res.send(renderProm())
})

/* ============== Auth — OAuth only (Google + GitHub) ============== */

/** 302 to the provider's consent screen. State is opaque to the client —
 *  we mint it server-side, save to Redis (5min TTL), and verify on the
 *  callback to defend against CSRF + cross-provider mixups.
 *
 *  `?return=<url>` is the post-callback redirect target. Must startsWith
 *  one of CUMORA_AUTH_RETURN_ALLOWLIST entries; otherwise rejected so we
 *  can't be turned into an open redirect. Omit to use AUTH_DONE_URL. */
/** Which browser sign-in providers this deployment actually has credentials
 *  for. The sign-in screens use it to avoid offering a button that can only
 *  503 — GitLab is opt-in (and points at whichever instance the operator
 *  configured), so most deployments will not have it. */
api.get('/auth/providers', safe(async (_req, res) => {
  res.json({ providers: [...WEB_OAUTH_PROVIDERS].filter((p) => providerEnabled(p as Provider)) })
}))

api.get('/auth/start/:provider', safe(async (req, res) => {
  const provider = req.params.provider as Provider
  if (!isWebOAuthProvider(provider)) {
    res.status(404).json({ error: 'unknown provider' }); return
  }
  if (!providerEnabled(provider)) {
    res.status(503).json({ error: `${provider} oauth not configured` }); return
  }
  const returnUrlRaw = typeof req.query.return === 'string' ? req.query.return : ''
  let returnUrl: string | null = null
  if (returnUrlRaw) {
    if (!returnUrlAllowed(returnUrlRaw)) {
      res.status(400).json({ error: 'return URL not allowed' }); return
    }
    returnUrl = returnUrlRaw
  }
  // The invite-onboarding flow sends `?invite=<token>` when sign-in
  // started from /invite/<token>. completeFlow uses this to skip
  // auto-creating a personal workspace for net-new users.
  const inviteRaw = typeof req.query.invite === 'string' ? req.query.invite : ''
  const inviteToken = inviteRaw && inviteRaw.length >= 8 && inviteRaw.length <= 200 ? inviteRaw : null
  const state = await createState(provider, returnUrl, inviteToken)
  res.redirect(authorizeUrl(provider, state))
}))

/** Provider redirects here after consent. We trade the auth code for a
 *  session and 302 to the saved return URL (or AUTH_DONE_URL default) with
 *  `#token=...&companyId=...` on the fragment (never in the query / log).
 *  On failure we 302 to the same target with `#error=...`. */
api.get('/auth/callback/:provider', safe(async (req, res) => {
  const provider = req.params.provider as Provider
  if (!isWebOAuthProvider(provider)) {
    res.status(404).json({ error: 'unknown provider' }); return
  }
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  if (!code || !state) {
    res.redirect(errorUrl(null, 'missing_code_or_state')); return
  }
  const ip = req.socket.remoteAddress ?? null
  const ua = (req.headers['user-agent'] as string | undefined) ?? null
  // `claimed` is read in the catch block below, so it has to be declared
  // outside the try — consumeState() itself can throw (e.g. a Redis
  // hiccup) and previously did so *before* this try started, escaping to
  // the router's generic unhandled-error page instead of the same
  // graceful #error= redirect every other failure in this flow gets.
  let claimed: Awaited<ReturnType<typeof consumeState>> = null
  try {
    claimed = await consumeState(state)
    if (!claimed || claimed.provider !== provider) {
      res.redirect(errorUrl(null, 'bad_state')); return
    }
    const url = await handleCallback({
      provider, code, returnUrl: claimed.returnUrl, ip, userAgent: ua,
      inviteToken: claimed.inviteToken,
    })
    res.redirect(url)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[auth] ${provider} callback failed:`, msg)
    await audit({ kind: 'login_failed', ip, userAgent: ua, detail: { provider, error: msg } })
    // The redirect carries only what we WROTE for the user to read. Everything
    // else — a Postgres transaction error, a provider's raw token-endpoint
    // body, a DNS failure — becomes a fixed code. The full text is already on
    // the line above and in the audit row, so nothing is lost for diagnosis;
    // what changes is that it stops being rendered on the sign-in screen and
    // parked in the browser's address bar and history (#102).
    res.redirect(errorUrl(claimed?.returnUrl ?? null, publicSignInError(e).slice(0, 120)))
  }
}))

/** Native Sign in with Apple — the iOS app finished the
 *  ASAuthorization flow on-device and POSTs the resulting
 *  `identity_token` here. We verify the JWT, find-or-create, and
 *  return the session token as JSON (no browser redirect). */
api.post('/auth/apple/native', safe(async (req, res) => {
  const { handleAppleNativeSignIn, WaitlistedError, SuspendedError } = await import('../oauth.js')
  const body = (req.body ?? {}) as {
    identityToken?: unknown; name?: unknown; inviteToken?: unknown
  }
  const identityToken = typeof body.identityToken === 'string' ? body.identityToken : ''
  if (!identityToken) { res.status(400).json({ error: 'identityToken required' }); return }
  const fallbackName = typeof body.name === 'string' ? body.name : null
  const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : null
  const ip = req.socket.remoteAddress ?? null
  const ua = (req.headers['user-agent'] as string | undefined) ?? null
  try {
    const r = await handleAppleNativeSignIn({
      identityToken,
      fallbackName,
      // Only our bundle id is accepted. If we later ship an Android
      // app or web SIWA fallback they'll get distinct audiences.
      audiences: ['io.cumora.app'],
      inviteToken,
      ip, userAgent: ua,
    })
    res.json({
      token: r.token,
      user: { id: r.userId, email: r.email, displayName: r.displayName },
      companyId: r.companyId,
    })
  } catch (e) {
    if (e instanceof WaitlistedError) { res.status(403).json({ error: 'waitlisted', email: e.email }); return }
    if (e instanceof SuspendedError) { res.status(403).json({ error: 'suspended', email: e.email, reason: e.reason }); return }
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[auth] apple native sign-in failed:', msg)
    // Same rule as the browser callback: the app shows this string to the
    // user, so it must be one we wrote.
    res.status(400).json({ error: publicSignInError(e) })
  }
}))

api.post('/auth/logout', safe(async (req, res) => {
  const auth = req.headers.authorization
  let token: string | undefined
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) token = auth.slice(7).trim()
  if (token) await deleteSession(token)
  const ip = req.socket.remoteAddress ?? null
  await audit({ kind: 'logout', userId: req.authUserId ?? null, ip })
  res.json({ ok: true })
}))

/** Self-service account deletion. Required by Apple App Store
 *  Guideline 5.1.1(v): any app that supports account creation must
 *  offer in-app deletion that removes the account and its personal
 *  data. Soft-delete model — stamp `users.deleted_at`, clear PII,
 *  CASCADE the bound rows (sessions, ws_tickets, user_identities,
 *  email_verification_tokens). Audit content (messages, etc.) stays
 *  because those are co-owned with other workspace members.
 *
 *  Idempotent: hitting DELETE /me/account on an already-deleted
 *  account returns 401 (the session was wiped on the first call).
 */
api.delete('/me/account', safe(async (req, res) => {
  const userId = requireAuth(req)
  const ip = req.socket.remoteAddress ?? null
  const ua = (req.headers['user-agent'] as string | undefined) ?? null

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Read the user's email up-front for the audit log — once
    // we clear it below it's gone.
    const { rows: pre } = await client.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    )
    if (pre.length === 0) {
      await client.query('ROLLBACK').catch(() => { /* ignore */ })
      res.status(404).json({ error: 'account already deleted or not found' })
      return
    }
    const email = pre[0].email

    // 1. Stamp deleted_at + scrub PII fields. We move email to a
    //    sentinel `deleted+<userid>@cumora.invalid` so the UNIQUE
    //    constraint stays satisfied (NULL would too, but a sentinel
    //    keeps the audit trail showing "an account existed here").
    await client.query(
      `UPDATE users
          SET deleted_at = NOW(),
              email = $2,
              display_name = $3,
              password_hash = NULL,
              avatar_url = NULL,
              email_verified_at = NULL
        WHERE id = $1`,
      [userId, `deleted+${userId}@cumora.invalid`, 'Deleted user'],
    )

    // 2. Burn all sessions immediately. CASCADE would handle this on
    //    a hard-DELETE, but we soft-delete so do it explicitly.
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId])
    await client.query(`DELETE FROM ws_tickets WHERE user_id = $1`, [userId])

    // 3. Drop the OAuth linkages so the user can re-sign-up later
    //    with the same Google/GitHub/Apple account (otherwise the
    //    cross-provider auto-link path would re-attach them to the
    //    deleted-user row by email or by sub).
    await client.query(`DELETE FROM user_identities WHERE user_id = $1`, [userId])

    // 4. Mark all participant rows (humans = same id) as departed
    //    so the user disappears from every workspace's member list
    //    without breaking historical message authorship.
    await client.query(
      `UPDATE participants SET departed_at = NOW()
        WHERE id = $1 AND kind = 'human' AND departed_at IS NULL`,
      [userId],
    )

    await client.query('COMMIT')

    await audit({
      kind: 'account_deleted',
      userId,
      ip, userAgent: ua,
      detail: { email },
    })

    res.json({ ok: true })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* ignore */ })
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[auth] account delete failed', msg)
    res.status(500).json({ error: msg })
  } finally {
    client.release()
  }
}))

/** Mint a one-shot WS-handshake ticket. The frontend posts this with its
 *  Bearer token (in the Authorization header), then opens the WebSocket
 *  with the returned ticket on the URL — so the session token itself is
 *  never put on the WS URL (which would leak it to logs / referrer). */
api.post('/auth/ws-ticket', safe(async (req, res) => {
  const userId = requireAuth(req)
  const { ticket, expiresAt } = await createWsTicket(userId)
  res.json({ ticket, expiresAt: expiresAt.toISOString() })
}))

api.get('/auth/me', safe(async (req, res) => {
  const userId = requireAuth(req)
  const { rows } = await pool.query<{ id: string; email: string; display_name: string; email_verified_at: string | null; is_admin: boolean }>(
    `SELECT id, email, display_name, email_verified_at, is_admin FROM users WHERE id = $1`, [userId],
  )
  if (!rows[0]) { res.status(401).json({ error: 'session points to missing user' }); return }
  const { rows: companies } = await pool.query<{ id: string; name: string; slug: string; role: string; tier: string }>(
    `SELECT c.id, c.name, c.slug, cm.role, COALESCE(owner.tier, 'free') AS tier
       FROM company_members cm
       JOIN companies c ON c.id = cm.company_id
       LEFT JOIN users owner ON owner.id = c.owner_user_id
      WHERE cm.user_id = $1 ORDER BY cm.joined_at ASC`,
    [userId],
  )
  // Surface which providers the user has linked. Useful in the settings UI
  // for "add another login" affordance, and for the client to know whether
  // it should offer disconnect on a single linked provider (no — that would
  // strand the account).
  const { rows: idents } = await pool.query<{ provider: string }>(
    `SELECT provider FROM user_identities WHERE user_id = $1`, [userId],
  )
  res.json({
    user: {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].display_name,
      emailVerified: rows[0].email_verified_at !== null,
      isAdmin: rows[0].is_admin,
      providers: idents.map((r) => r.provider),
    },
    companies,
    activeCompanyId: companies[0]?.id ?? null,
    // Server-side feature flags the SPA needs at boot. Today there's only
    // one: whether the server can actually send invite/welcome emails.
    // EMAIL_DOMAIN unset → no outbound mail → the invite modal hides the
    // "Email this invite" checkbox rather than letting the user tick a
    // box that will always fail. Add other capabilities here as needed.
    serverCapabilities: {
      invitationEmail: !!env.EMAIL_DOMAIN,
    },
  })
}))

// Admin panel. The sub-router enforces requireAdmin on every route; we
// mount it here so the shared authMiddleware runs first.
api.use('/admin', adminRouter)


/* ============== /me/quota — sub2api subscription snapshot ===========
 * Surfaces the same daily/weekly/monthly used + limit numbers that
 * sub2api enforces at the gateway. Returns `{ configured: false }` when
 * the deployment doesn't talk to sub2api, and `{ configured: true,
 * snapshot: null }` when the user exists in cumora but was never
 * provisioned (or sub2api lost their subscription). Either case is fine
 * — the client shows an "unavailable" affordance rather than erroring. */
api.get('/me/quota', safe(async (req, res) => {
  const me = requireAuth(req)
  if (!sub2apiConfigured()) { res.json({ configured: false, snapshot: null }); return }
  const { rows } = await pool.query<{ sub2api_user_id: number | null }>(
    `SELECT sub2api_user_id FROM users WHERE id = $1`, [me],
  )
  const subId = rows[0]?.sub2api_user_id ?? null
  if (subId == null) { res.json({ configured: true, snapshot: null }); return }
  try {
    const snapshot = await getUserQuota(subId)
    res.json({ configured: true, snapshot })
  } catch (e) {
    // Network / sub2api glitches mustn't 500 the settings tab — the user
    // can retry by reopening it.
    console.warn('[me/quota] sub2api fetch failed', e)
    res.json({ configured: true, snapshot: null, error: 'sub2api unreachable' })
  }
}))

/* ============== /me legacy stub — now session-derived ============== */
api.get('/me', safe(async (req, res) => {
  const userId = requireAuth(req)
  const { rows } = await pool.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM users WHERE id = $1`, [userId],
  )
  if (!rows[0]) { res.status(401).json({ error: 'session points to missing user' }); return }
  res.json({ id: rows[0].id, name: rows[0].display_name, kind: 'human' })
}))

/* ============== Companies (multi-tenant root) ============== */

api.get('/companies', async (req, res) => {
  const me = userId(req)
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.slug, c.created_at AS "createdAt", cm.role
       FROM companies c
       JOIN company_members cm ON cm.company_id = c.id AND cm.user_id = $1
      ORDER BY cm.joined_at ASC`,
    [me],
  )
  res.json(rows)
})

api.post('/companies', async (req, res) => {
  const me = userId(req)
  const name = String(req.body?.name ?? '').trim().slice(0, 80)
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  await assertUserCompanyLimit(me)
  // Generate a slug from the name. Falls back to a random suffix on collision.
  const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'company'
  let slug = baseSlug
  let id = `co-${randomUUID().slice(0, 10)}`
  // Try inserting; on slug conflict, suffix with a short random tail and retry once.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query(
        `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
        [id, name, slug, me],
      )
      await pool.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [id, me],
      )
      // Mirror the human-as-participant + starter-agents from signup, so a
      // brand-new workspace has the same teammates regardless of how it was
      // created. The participant insert is idempotent on (id) collision —
      // when the same user creates multiple companies, the second insert is
      // a no-op (their participant row stays attached to the first company).
      const { rows: meRow } = await pool.query<{ display_name: string; email: string }>(
        `SELECT display_name, email FROM users WHERE id = $1`, [me],
      )
      const displayName = meRow[0]?.display_name ?? me
      const gravatarUrl = meRow[0]?.email ? gravatarUrlForEmail(meRow[0].email) : null
      await pool.query(
        `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, avatar_url, status, company_id)
         VALUES ($1, 'human', $2, NULL, $3, '#FF8870', $4, 'avail', $5)
         ON CONFLICT (id, company_id) DO NOTHING`,
        [me, displayName, displayName.charAt(0).toUpperCase(), gravatarUrl, id],
      )
      // Paid companies get a built-in managed "Cumora Cloud" computer their
      // starters run on. Free tier is BYOA-only: NO managed cloud computer
      // (the UI shows a locked "Cumora Cloud (Pro)" upsell instead) and its
      // starters are deferred until the first computer is paired
      // (POST /api/computers/pair). Best-effort.
      try {
        if ((await companyTier(id)) !== 'free') {
          await ensureCloudComputer(id)
          await onboardStarterAgents(id, { computerId: cloudComputerId(id), engine: 'managed' })
        }
      } catch (e) { console.warn('[companies] cloud/starter setup failed', e) }

      try { await joinAllHands({ companyId: id, participantId: me }) }
      catch (e) { console.warn('[companies] join all-hands failed', e) }

      const ip = req.socket.remoteAddress ?? null
      const ua = (req.headers['user-agent'] as string | undefined) ?? null
      await audit({ kind: 'company_create', userId: me, companyId: id, ip, userAgent: ua, detail: { name, slug } })
      res.status(201).json({ id, name, slug, role: 'owner' })
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/duplicate key/.test(msg)) { res.status(500).json({ error: msg }); return }
      slug = `${baseSlug}-${randomUUID().slice(0, 4)}`
      id = `co-${randomUUID().slice(0, 10)}`
    }
  }
  res.status(500).json({ error: 'failed to create company after retries' })
})

/* ============== Computers (agent hosts: Cumora Cloud + BYOA) ============== */

// List computers visible in the active company (Cumora Cloud + paired ones).
api.get('/computers', safe(async (req, res) => {
  const { companyId } = await requireCompany(req)
  res.json(await listComputers(companyId))
}))

// Start pairing a new BYOA computer: returns a persistent token (owner/admin).
// No computer row is created here — pairComputer creates it once the daemon
// pairs and reports the machine's real hostname.
api.post('/computers', safe(async (req, res) => {
  const { userId: uid, companyId } = await requireCompanyRole(req)
  res.status(201).json(await issuePairingCode({ companyId, ownerUserId: uid }))
}))

// Issue a persistent re-pair token for an existing computer — reconnect it (and its
// agents) by running the daemon again with this code (owner/admin).
api.post('/computers/:id/repair', safe(async (req, res) => {
  const { userId: uid, companyId } = await requireCompanyRole(req)
  const out = await issueRepairCode({ companyId, ownerUserId: uid, computerId: String(req.params.id) })
  if (!out) throw new HttpError(404, 'computer not found or not re-pairable')
  res.json(out)
}))

// Revoke a paired computer (owner/admin) — kills its device token + agent JWTs.
api.delete('/computers/:id', safe(async (req, res) => {
  const { companyId } = await requireCompanyRole(req)
  const ok = await revokeComputer({ computerId: String(req.params.id), companyId })
  if (!ok) throw new HttpError(404, 'computer not found or not revocable')
  res.json({ ok: true })
}))

// Assign an agent to a computer (move between Cumora Cloud and a paired
// machine), choosing its engine (owner/admin).
api.post('/agents/:id/computer', safe(async (req, res) => {
  const { companyId } = await requireCompanyRole(req)
  const computerId = String(req.body?.computerId ?? '').trim()
  if (!computerId) throw new HttpError(400, 'computerId required')
  // Free tier is BYOA-only — it can't put agents on the managed Cumora Cloud.
  if (computerId === cloudComputerId(companyId) && (await companyTier(companyId)) === 'free') {
    throw new HttpError(403, 'Free tier agents run on your own computer. Upgrade to Pro to use Cumora Cloud.')
  }
  const engine = typeof req.body?.engine === 'string' ? req.body.engine : undefined
  const inherit = req.body?.inherit === true
  const out = await assignAgentToComputer({
    agentId: String(req.params.id), companyId, computerId, engine, inherit: inherit || !engine,
  })
  if (!out) throw new HttpError(400, 'invalid computer, agent, or engine for this company')
  res.json({ ok: true, ...out })
}))

// --- daemon-facing endpoints (device-token authed, no user session) ---

// Redeem a pairing token → device token. The token itself is the credential.
api.post('/computers/pair', safe(async (req, res) => {
  const code = String(req.body?.code ?? '').trim()
  if (!code) throw new HttpError(400, 'code required')
  const engines = Array.isArray(req.body?.engines)
    ? (req.body.engines as unknown[]).filter((e): e is string => typeof e === 'string')
    : []
  const detected = req.body?.detected
  // Same separation as /computers/me/engines: display-only, never merged into
  // the engines list that picks an adapter.
  const blockedAtPair = Array.isArray(req.body?.blocked)
    ? (req.body.blocked as unknown[]).filter((e): e is string => typeof e === 'string')
    : []
  const hostName = typeof req.body?.hostName === 'string' ? req.body.hostName : undefined
  const version = typeof req.body?.version === 'string' ? req.body.version : undefined
  const supervised = typeof req.body?.supervised === 'boolean' ? req.body.supervised : undefined
  // Defer the "online" broadcast until AFTER seeding (below): the desktop flips
  // its onboarding gate on that event and immediately reloads its roster, so the
  // starter team + "Everyone" group must already exist when it fires — otherwise
  // the user lands on an empty Conversations list that fills in a beat later.
  const paired = await pairComputer({ code, hostName, engines, detected, blocked: blockedAtPair, version, supervised, deferBroadcast: true })
  if (!paired) throw new HttpError(400, 'invalid pairing token')
  // Free-tier BYOA onboarding on pair. The daemon sends the engines list with
  // the user's CHOSEN engine first (`cumora agent computer --pair … --engine X`),
  // so engines[0] is this computer's default engine — it's what the starter team
  // and any adopted agent are created with. Fall back to Claude if unreported.
  try {
    if ((await companyTier(paired.companyId)) === 'free') {
      const engine = (
        engines[0] === 'claude' || engines[0] === 'codex' || engines[0] === 'grok' ||
        engines[0] === 'cursor' || engines[0] === 'opencode' || engines[0] === 'pi' ||
        engines[0] === 'gemini' || engines[0] === 'qwen'
      ) ? engines[0] : 'claude'
      // Adopt only agents that are stranded on the managed Cumora Cloud (or
      // unassigned) onto the just-paired machine — earlier builds' boot backfill
      // wrongly seeded free starters on cloud, where free can't run them. Agents
      // already living on a real (non-cloud) computer are left ALONE: re-running
      // the pair command must NOT clobber a per-agent engine the user picked
      // (e.g. a Claude→Codex switch). Preserve whatever engine the agent already
      // has; the auto-pick only fills in the stranded ones (engine 'managed'/null).
      await pool.query(
        `UPDATE participants p
            SET computer_id = $1, engine = COALESCE(NULLIF(p.engine, 'managed'), $2)
          WHERE p.company_id = $3 AND p.kind = 'agent'
            AND NOT EXISTS (
              SELECT 1 FROM computers c
               WHERE c.id = p.computer_id AND c.kind <> 'cloud' AND c.revoked_at IS NULL
            )`,
        [paired.computerId, engine, paired.companyId],
      )
      // Seed starters for free companies that have none yet (idempotent — a
      // company that already has the team is marked seeded and this no-ops).
      await onboardStarterAgents(paired.companyId, { computerId: paired.computerId, engine })
      // NOTE: we deliberately do NOT delete the company's managed cloud computer
      // row here. It's now unused (its agents moved to the paired machine) and
      // already hidden from free users by the editor's tier filter; leaving it
      // avoids any churn/edge cases from removing a referenced row mid-flow.
    }
  } catch (e) { console.warn('[computers] free-tier pair onboarding failed', e) }
  // Now the roster is ready — announce the computer online so the desktop's
  // post-onboarding reload sees a fully-seeded workspace.
  await announceComputerOnline(paired.computerId, paired.companyId)
  res.json(paired)
}))

api.post('/computers/:id/detect', safe(async (req, res) => {
  const { companyId } = await requireCompanyRole(req)
  const computerId = String(req.params.id)
  // Persist first: Redis/SSE is the fast path, while the existing heartbeat flag
  // guarantees eventual delivery across deploys, disconnects and Redis outages.
  const ok = await requestEngineDetect({ computerId, companyId })
  if (!ok) throw new HttpError(404, 'computer not found')
  let delivered = false
  try {
    delivered = (await deliverEngineDetect(computerId)) > 0
  } catch (error) {
    console.warn('[computers] immediate engine detection signal failed:', error instanceof Error ? error.message : String(error))
  }
  res.json({ ok: true, delivered })
}))

api.post('/computers/:id/default-engine', safe(async (req, res) => {
  const { companyId } = await requireCompanyRole(req)
  const engine = typeof req.body?.engine === 'string' ? req.body.engine : ''
  const out = await setComputerDefaultEngine({ computerId: String(req.params.id), companyId, engine })
  if (!out) throw new HttpError(400, 'engine is not installed on this computer')
  res.json({ ok: true, ...out })
}))

api.post('/computers/me/engines', safe(async (req, res) => {
  const { computerId } = await requireDevice(req)
  const engines = Array.isArray(req.body?.engines)
    ? (req.body.engines as unknown[]).filter((e): e is string => typeof e === 'string')
    : []
  // Installed-but-refused engines. Kept apart from `engines` on purpose: that
  // list becomes available_engines and picks an agent's adapter, so a blocked
  // id arriving there would run what the sandbox gate declined.
  const blocked = Array.isArray(req.body?.blocked)
    ? (req.body.blocked as unknown[]).filter((e): e is string => typeof e === 'string')
    : []
  const ok = await reportDetectedEngines({ computerId, engines, detected: req.body?.detected, blocked })
  if (!ok) throw new HttpError(404, 'computer not found')
  res.json({ ok: true })
}))

// One device-level control stream per daemon. Unlike per-agent wake streams,
// this also works when the computer currently hosts zero agents.
api.get('/computers/me/control-stream', safe(async (req, res) => {
  const token = deviceBearerToken(req)
  const { computerId } = await requireDevice(req)
  await attachComputerControlStream(computerId, res, {
    authorize: async () => (await resolveDevice(token))?.computerId === computerId,
  })
}))

// Agents assigned to the calling computer (daemon discovery on boot).
api.get('/computers/me/agents', safe(async (req, res) => {
  const { computerId } = await requireDevice(req)
  res.json(await listAgentsForComputer(computerId))
}))

// Daemon liveness heartbeat — keeps the computer 'online' (an offline sweep
// flips it once heartbeats go stale).
api.post('/computers/heartbeat', safe(async (req, res) => {
  const { computerId } = await requireDevice(req)
  const version = typeof req.body?.version === 'string' ? req.body.version : undefined
  const supervised = typeof req.body?.supervised === 'boolean' ? req.body.supervised : undefined
  // Engines the daemon can currently see on PATH. Optional: an older daemon
  // sends none and its stored list is left exactly as it was.
  const engines = Array.isArray(req.body?.engines)
    ? (req.body.engines as unknown[]).filter((e): e is string => typeof e === 'string')
    : undefined
  const detectRequested = await heartbeatComputer(computerId, version, supervised, engines)
  res.json({ ok: true, detectRequested })
}))

// Mint a per-agent runtime JWT for the calling computer (daemon refresh loop).
api.post('/agents/:id/runtime-token', safe(async (req, res) => {
  const { computerId } = await requireDevice(req)
  const minted = await mintAgentRuntimeToken({ computerId, agentId: String(req.params.id) })
  if (!minted) throw new HttpError(403, 'agent not assigned to this computer')
  res.json(minted)
}))

/* ============== Company invitations ============== */

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7    // 7 days
const INVITE_ALLOWED_ROLES = new Set(['member', 'admin'])
const INVITE_MAX_LINK_USES = 100                  // hard ceiling on shareable links
const INVITE_TOKEN_BYTES = 32

function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

function generateInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url')
}

interface InvitationRow {
  token_hash: string
  company_id: string
  invited_by: string
  email: string | null
  role: string
  note: string | null
  max_uses: number
  use_count: number
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_accepted_at: string | null
  last_accepted_by: string | null
}

interface InvitationPreview {
  status: 'valid' | 'revoked' | 'expired' | 'consumed' | 'wrong_email' | 'already_member' | 'not_found'
  invitation?: {
    role: string
    email: string | null
    note: string | null
    expiresAt: string
    createdAt: string
    inviterName: string | null
    company: { id: string; name: string; slug: string }
    multiUse: boolean
  }
}

/** Resolve raw token → invite row + computed status. Does NOT require auth so
 *  the accept page can show the company name + inviter to logged-out users.
 *  Pass `viewerUserId` and `viewerEmailLower` for richer status (wrong_email,
 *  already_member). */
async function loadInvitation(args: {
  token: string
  viewerUserId?: string | null
  viewerEmailLower?: string | null
}): Promise<InvitationPreview> {
  const hash = hashInviteToken(args.token)
  const { rows } = await pool.query<InvitationRow & {
    company_name: string; company_slug: string; inviter_name: string | null
  }>(
    `SELECT i.token_hash, i.company_id, i.invited_by, i.email, i.role, i.note,
            i.max_uses, i.use_count, i.created_at, i.expires_at, i.revoked_at,
            i.last_accepted_at, i.last_accepted_by,
            c.name AS company_name, c.slug AS company_slug,
            u.display_name AS inviter_name
       FROM company_invitations i
       JOIN companies c ON c.id = i.company_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1`,
    [hash],
  )
  if (rows.length === 0) return { status: 'not_found' }
  const r = rows[0]
  const baseInvite = {
    role: r.role,
    email: r.email,
    note: r.note,
    expiresAt: new Date(r.expires_at).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    inviterName: r.inviter_name,
    company: { id: r.company_id, name: r.company_name, slug: r.company_slug },
    multiUse: r.max_uses > 1,
  }
  if (r.revoked_at) return { status: 'revoked', invitation: baseInvite }
  if (new Date(r.expires_at).getTime() < Date.now()) return { status: 'expired', invitation: baseInvite }
  if (r.use_count >= r.max_uses) return { status: 'consumed', invitation: baseInvite }
  if (args.viewerUserId) {
    const { rows: mem } = await pool.query(
      `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
      [r.company_id, args.viewerUserId],
    )
    if (mem[0]) return { status: 'already_member', invitation: baseInvite }
  }
  if (r.email && args.viewerEmailLower && r.email.toLowerCase() !== args.viewerEmailLower) {
    return { status: 'wrong_email', invitation: baseInvite }
  }
  return { status: 'valid', invitation: baseInvite }
}

/** Require that the caller is owner / admin of the company in question. */
async function requireCompanyAdmin(req: Request & AuthedRequest, companyId: string): Promise<{ userId: string; role: string }> {
  const me = requireAuth(req)
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
    [companyId, me],
  )
  if (rows.length === 0) throw new HttpError(403, 'not a member of this company')
  if (!DEVTOOLS_ROLES.has(rows[0].role)) {
    throw new HttpError(403, 'only owners and admins can manage invitations')
  }
  return { userId: me, role: rows[0].role }
}

/** Build the public-facing accept URL for an invite — always an https web
 *  origin (e.g. https://app.cumora.ai/invite/<token>). The web bundle hosted
 *  there has its API origin baked in at build time (VITE_CUMORA_API_BASE), so
 *  the link is self-routing: any recipient who opens it lands on the right
 *  API automatically, even from Electron (the OS hands https URLs to the
 *  default browser). We deliberately do NOT mint cumora:// deep links — each
 *  API server is tied to exactly one web origin, so an `?api=` query param
 *  would be redundant. */
function buildInviteUrl(token: string): string {
  const base = (env.INVITE_BASE_URL || env.AUTH_DONE_URL).replace(/\/+$/, '')
  return `${base}/invite/${encodeURIComponent(token)}`
}

/** List invitations for a company. Owners / admins only. Returns the
 *  most-recent first; includes both active and historical (revoked / expired
 *  / consumed) so the UI can show "X people redeemed this link". The raw
 *  token is never re-returned after creation — only the URL once at create
 *  time. */
api.get('/companies/:id/invitations', safe(async (req, res) => {
  const companyId = String(req.params.id)
  await requireCompanyAdmin(req, companyId)
  const { rows } = await pool.query<{
    token_hash: string; email: string | null; role: string; note: string | null
    max_uses: number; use_count: number; created_at: string; expires_at: string
    revoked_at: string | null; last_accepted_at: string | null
    last_accepted_by: string | null; invited_by: string
    inviter_name: string | null
  }>(
    `SELECT i.token_hash, i.email, i.role, i.note, i.max_uses, i.use_count,
            i.created_at, i.expires_at, i.revoked_at,
            i.last_accepted_at, i.last_accepted_by, i.invited_by,
            u.display_name AS inviter_name
       FROM company_invitations i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.company_id = $1
      ORDER BY i.created_at DESC
      LIMIT 200`,
    [companyId],
  )
  const now = Date.now()
  res.json(rows.map((r) => {
    const expired = new Date(r.expires_at).getTime() < now
    const consumed = r.use_count >= r.max_uses
    const status = r.revoked_at ? 'revoked'
      : expired ? 'expired'
      : consumed ? 'consumed'
      : 'active'
    return {
      // Stable, non-secret identifier the UI uses to revoke. Truncated hash
      // is fine here — we look invites up by the full hash, which the
      // revoke endpoint accepts.
      id: r.token_hash,
      email: r.email,
      role: r.role,
      note: r.note,
      maxUses: r.max_uses,
      useCount: r.use_count,
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
      revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
      lastAcceptedAt: r.last_accepted_at ? new Date(r.last_accepted_at).toISOString() : null,
      lastAcceptedBy: r.last_accepted_by,
      invitedBy: r.invited_by,
      inviterName: r.inviter_name,
      status,
    }
  }))
}))

/** Create a new invitation. Body: { email?, role?, note?, multiUse? }.
 *  When `email` is provided the invite is single-use and locked to that
 *  email (case-insensitive). When omitted (or `multiUse: true`), a
 *  shareable link is minted with max_uses = 100 by default.
 *  Returns the RAW token + URL exactly ONCE — the server stores only the
 *  hash, so this is the only chance to copy the link. */
api.post('/companies/:id/invitations', safe(async (req, res) => {
  const companyId = String(req.params.id)
  const { userId: me } = await requireCompanyAdmin(req, companyId)
  const body = req.body ?? {}
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
  const email = rawEmail ? rawEmail.toLowerCase() : null
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'invalid email' }); return
  }
  const role = typeof body.role === 'string' && INVITE_ALLOWED_ROLES.has(body.role)
    ? body.role : 'member'
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 280) || null : null
  const multiUse = body.multiUse === true || (!email && body.maxUses !== 1)
  const requestedMaxUses = Number(body.maxUses ?? (email ? 1 : INVITE_MAX_LINK_USES))
  let maxUses = email
    ? 1
    : Math.max(1, Math.min(INVITE_MAX_LINK_USES, Number.isFinite(requestedMaxUses) ? requestedMaxUses : INVITE_MAX_LINK_USES))
  void multiUse  // referenced for clarity; maxUses already encodes the semantic

  // Email-targeted invites: refuse if the email already belongs to a
  // member (avoid spamming/revoke-loop in the UI). We don't refuse for
  // link invites — link reuse is the whole point.
  if (email) {
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM company_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.company_id = $1 AND LOWER(u.email) = $2
        LIMIT 1`,
      [companyId, email],
    )
    if (existing[0]) {
      res.status(409).json({ error: 'that email is already a member of this workspace' })
      return
    }
    // Also collapse duplicate ACTIVE invites — re-issuing for the same email
    // revokes the prior one so the recipient only ever has one live link.
    await pool.query(
      `UPDATE company_invitations
          SET revoked_at = NOW()
        WHERE company_id = $1 AND email = $2
          AND revoked_at IS NULL AND expires_at > NOW()
          AND use_count < max_uses`,
      [companyId, email],
    )
  }

  const humanSeats = await companyHumanSeatInfo(companyId)
  const remaining = humanSeats.limit - humanSeats.used
  if (remaining <= 0) {
    throw new HttpError(403, `${humanSeats.tier} tier workspaces can have at most ${humanSeats.limit} human members`)
  }
  maxUses = Math.min(maxUses, remaining)

  const token = generateInviteToken()
  const tokenHash = hashInviteToken(token)
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  await pool.query(
    `INSERT INTO company_invitations
       (token_hash, company_id, invited_by, email, role, note, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tokenHash, companyId, me, email, role, note, maxUses, expiresAt],
  )
  const ip = req.socket.remoteAddress ?? null
  const ua = (req.headers['user-agent'] as string | undefined) ?? null
  await audit({
    kind: 'invitation_create',
    userId: me, companyId, ip, userAgent: ua,
    detail: { email, role, maxUses, note: note ?? undefined },
  })

  // Optional: send the invitation email on the inviter's behalf. Only
  // valid when the invite is email-locked (no recipient to send to for
  // shareable link invites). Failures are reported back via emailDelivery
  // but do NOT fail the create — the invite row is already persisted and
  // the inviter has the URL on screen to share manually.
  let emailDelivery: InvitationEmailDelivery | null = null
  if (body.sendEmail === true && email) {
    const inviteUrl = buildInviteUrl(token)
    const { rows: meRows } = await pool.query<{ email: string; display_name: string }>(
      `SELECT email, display_name FROM users WHERE id = $1`, [me],
    )
    const { rows: coRows } = await pool.query<{ name: string }>(
      `SELECT name FROM companies WHERE id = $1`, [companyId],
    )
    const inviter = meRows[0]
    const company = coRows[0]
    if (inviter && company) {
      emailDelivery = await sendInvitationEmail({
        to: email,
        inviterName: inviter.display_name || inviter.email,
        inviterEmail: inviter.email,
        companyName: company.name,
        role,
        note,
        inviteUrl,
      })
    } else {
      emailDelivery = { attempted: false, ok: false, error: 'inviter or company row missing', skipped: null }
    }
  }

  res.status(201).json({
    id: tokenHash,
    token,
    url: buildInviteUrl(token),
    email,
    role,
    note,
    maxUses,
    useCount: 0,
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    status: 'active',
    emailDelivery,
  })
}))

/** Revoke an invitation. The id IS the token hash returned in the list /
 *  create responses. Idempotent — revoking a non-existent / already-revoked
 *  invite still returns 200 (so the UI doesn't have to dance around races). */
api.delete('/companies/:id/invitations/:inviteId', safe(async (req, res) => {
  const companyId = String(req.params.id)
  const inviteId = String(req.params.inviteId)
  const { userId: me } = await requireCompanyAdmin(req, companyId)
  const { rowCount } = await pool.query(
    `UPDATE company_invitations
        SET revoked_at = NOW()
      WHERE token_hash = $1 AND company_id = $2 AND revoked_at IS NULL`,
    [inviteId, companyId],
  )
  if ((rowCount ?? 0) > 0) {
    const ip = req.socket.remoteAddress ?? null
    const ua = (req.headers['user-agent'] as string | undefined) ?? null
    await audit({
      kind: 'invitation_revoke',
      userId: me, companyId, ip, userAgent: ua,
      detail: { inviteId },
    })
  }
  res.json({ ok: true, revoked: (rowCount ?? 0) > 0 })
}))

/** Public preview — no auth required. The accept screen calls this on mount
 *  to show "<inviter> invited you to <company>" before sign-in. If the
 *  caller IS signed in, we also surface `already_member` / `wrong_email`
 *  so the UI can show the right CTA. */
api.get('/invitations/:token', safe(async (req, res) => {
  const token = String(req.params.token)
  if (!token || token.length < 8) { res.status(400).json({ error: 'bad token' }); return }
  let viewerEmail: string | null = null
  if (req.authUserId) {
    const { rows } = await pool.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [req.authUserId],
    )
    viewerEmail = rows[0]?.email?.toLowerCase() ?? null
  }
  const preview = await loadInvitation({
    token,
    viewerUserId: req.authUserId ?? null,
    viewerEmailLower: viewerEmail,
  })
  res.json(preview)
}))

/** Accept an invitation. Auth required — the joiner must already have a
 *  Cumora account (sign in / sign up via OAuth first). Atomically:
 *    1. Re-checks the invite state under FOR UPDATE so two simultaneous
 *       redemptions on a single-use invite can't both win.
 *    2. Inserts a company_members row (idempotent on conflict).
 *    3. Mirrors the human as a participant in the target company.
 *    4. Bumps use_count + last_accepted_at/by.
 *  Then (post-commit, best-effort) joins #all-hands so the new member
 *  gets the visible "X joined" event. Returns the company summary the
 *  client adds to the switcher list. */
api.post('/invitations/:token/accept', safe(async (req, res) => {
  const me = requireAuth(req)
  const token = String(req.params.token)
  if (!token || token.length < 8) { res.status(400).json({ error: 'bad token' }); return }
  const tokenHash = hashInviteToken(token)
  const { rows: userRow } = await pool.query<{ email: string; display_name: string; avatar_url: string | null }>(
    `SELECT email, display_name, avatar_url FROM users WHERE id = $1`, [me],
  )
  if (!userRow[0]) { res.status(401).json({ error: 'session points to missing user' }); return }
  const viewerEmail = userRow[0].email.toLowerCase()
  const displayName = userRow[0].display_name
  // Reuse the user's OAuth-mirrored avatar (stamped on users.avatar_url at
  // signup) so they show up in the inviter's workspace with the same face
  // they have everywhere else. Fall back to gravatar for users who pre-date
  // the avatar_url column (NULL after migration backfill).
  const userAvatar = userRow[0].avatar_url ?? gravatarUrlForEmail(userRow[0].email)

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query<InvitationRow>(
      `SELECT token_hash, company_id, invited_by, email, role, note,
              max_uses, use_count, created_at, expires_at, revoked_at,
              last_accepted_at, last_accepted_by
         FROM company_invitations
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    )
    if (rows.length === 0) {
      await client.query('ROLLBACK')
      res.status(404).json({ error: 'invitation not found' }); return
    }
    const inv = rows[0]
    if (inv.revoked_at) {
      await client.query('ROLLBACK')
      res.status(410).json({ error: 'invitation revoked' }); return
    }
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      await client.query('ROLLBACK')
      res.status(410).json({ error: 'invitation expired' }); return
    }
    if (inv.use_count >= inv.max_uses) {
      await client.query('ROLLBACK')
      res.status(410).json({ error: 'invitation already used' }); return
    }
    if (inv.email && inv.email.toLowerCase() !== viewerEmail) {
      await client.query('ROLLBACK')
      res.status(403).json({
        error: `this invitation is reserved for ${inv.email} — sign in with that email to accept`,
      }); return
    }

    // Idempotent membership upsert — if already a member, decline to
    // double-bump usage but still return success so the client can route
    // them into the workspace.
    const { rows: existingMembership } = await client.query(
      `SELECT 1 FROM company_members WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
      [inv.company_id, me],
    )
    if (existingMembership[0]) {
      await client.query('ROLLBACK')
      const { rows: meta } = await pool.query<{ name: string; slug: string; role: string }>(
        `SELECT c.name, c.slug, cm.role
           FROM companies c JOIN company_members cm
             ON cm.company_id = c.id AND cm.user_id = $2
          WHERE c.id = $1`,
        [inv.company_id, me],
      )
      res.json({
        ok: true,
        alreadyMember: true,
        company: {
          id: inv.company_id,
          name: meta[0]?.name ?? '',
          slug: meta[0]?.slug ?? '',
          role: meta[0]?.role ?? 'member',
        },
      })
      return
    }

    await assertUserCompanyLimit(me, client)
    await assertCompanyHumanLimit(inv.company_id, client)

    await client.query(
      `INSERT INTO company_members (company_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, user_id) DO NOTHING`,
      [inv.company_id, me, inv.role],
    )

    // Mirror the human as a participant in the target company so they
    // appear in conversation member lists and avatar grids. Idempotent
    // on the (id, company_id) composite PK.
    await client.query(
      `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, avatar_url, status, company_id)
       VALUES ($1, 'human', $2, NULL, $3, '#FF8870', $4, 'avail', $5)
       ON CONFLICT (id, company_id) DO NOTHING`,
      [me, displayName, displayName.charAt(0).toUpperCase(),
       userAvatar, inv.company_id],
    )

    await client.query(
      `UPDATE company_invitations
          SET use_count = use_count + 1,
              last_accepted_at = NOW(),
              last_accepted_by = $2
        WHERE token_hash = $1`,
      [tokenHash, me],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => { /* swallow */ })
    throw e
  } finally {
    client.release()
  }

  // Post-commit fan-out. joinAllHands creates the "X joined" system
  // message + WS broadcast so existing members see the newcomer arrive
  // in real time.
  const { rows: invRow } = await pool.query<{ company_id: string; role: string; invited_by: string }>(
    `SELECT company_id, role, invited_by FROM company_invitations WHERE token_hash = $1`,
    [tokenHash],
  )
  const inv = invRow[0]
  if (inv) {
    try { await joinAllHands({ companyId: inv.company_id, participantId: me }) }
    catch (e) { console.warn('[invite] join all-hands failed', e) }
    // Seed 1:1 DMs with every existing teammate (agents + humans) so the
    // invitee's sidebar matches the owner's experience — they can click any
    // colleague directly instead of having to dig through #all-hands.
    try { await seedMemberDms({ companyId: inv.company_id, memberId: me }) }
    catch (e) { console.warn('[invite] seed member DMs failed', e) }
  }

  const { rows: companyRow } = await pool.query<{ name: string; slug: string; role: string }>(
    `SELECT c.name, c.slug, cm.role
       FROM companies c JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
      WHERE c.id = $1`,
    [inv?.company_id ?? '', me],
  )
  const ip = req.socket.remoteAddress ?? null
  const ua = (req.headers['user-agent'] as string | undefined) ?? null
  await audit({
    kind: 'invitation_accept',
    userId: me, companyId: inv?.company_id ?? null, ip, userAgent: ua,
    detail: { invitedBy: inv?.invited_by, role: inv?.role },
  })
  res.json({
    ok: true,
    alreadyMember: false,
    company: {
      id: inv?.company_id ?? '',
      name: companyRow[0]?.name ?? '',
      slug: companyRow[0]?.slug ?? '',
      role: companyRow[0]?.role ?? 'member',
    },
  })
}))

/* ============== Projects ============== */

api.get('/projects', async (req, res) => {
  const { companyId: tenant } = await requireCompany(req)
  const { rows } = await pool.query(
    `SELECT id, name, description, color, status,
            created_at AS "createdAt", archived_at AS "archivedAt",
            (SELECT COUNT(*)::int FROM conversations WHERE project_id = projects.id) AS "conversationCount"
       FROM projects
      WHERE company_id = $1
      ORDER BY status ASC, created_at DESC`,
    [tenant],
  )
  res.json(rows)
})

api.post('/projects', async (req, res) => {
  const { companyId: tenant } = await requireCompany(req)
  const name = String(req.body?.name ?? '').trim().slice(0, 80)
  const description = String(req.body?.description ?? '').slice(0, 1000)
  const color = req.body?.color ? String(req.body.color).slice(0, 200) : null
  if (!name) { res.status(400).json({ error: 'name required' }); return }
  const id = `p-${randomUUID().slice(0, 10)}`
  await pool.query(
    `INSERT INTO projects (id, company_id, name, description, color)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tenant, name, description, color],
  )
  res.status(201).json({ id, name, description, color, status: 'active' })
})

api.put('/projects/:id', async (req, res) => {
  // Renaming or recoloring a shared project ripples through every member's
  // sidebar — gate to owner/admin so a single member can't unilaterally
  // re-brand the team's work.
  const { companyId: tenant } = await requireCompanyRole(req)
  const { id } = req.params
  const { rows: gate } = await pool.query(
    `SELECT 1 FROM projects WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [id, tenant],
  )
  if (!gate[0]) { res.status(404).json({ error: 'not found' }); return }
  const sets: string[] = []
  const params: unknown[] = []
  if (typeof req.body?.name === 'string') { params.push(req.body.name.trim().slice(0, 80)); sets.push(`name = $${params.length}`) }
  if (typeof req.body?.description === 'string') { params.push(req.body.description.slice(0, 1000)); sets.push(`description = $${params.length}`) }
  if (typeof req.body?.color === 'string') { params.push(req.body.color.slice(0, 200)); sets.push(`color = $${params.length}`) }
  if (req.body?.color === null) { params.push(null); sets.push(`color = $${params.length}`) }
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  params.push(id, tenant)
  await pool.query(
    `UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND company_id = $${params.length}`,
    params,
  )
  res.json({ ok: true })
})

api.post('/projects/:id/archive', async (req, res) => {
  // Archive/unarchive is destructive (hides every linked conversation from
  // the active list); owner/admin only.
  const { companyId: tenant } = await requireCompanyRole(req)
  const { id } = req.params
  const archive = req.body?.archive !== false
  await pool.query(
    archive
      ? `UPDATE projects SET status = 'archived', archived_at = NOW() WHERE id = $1 AND company_id = $2`
      : `UPDATE projects SET status = 'active', archived_at = NULL WHERE id = $1 AND company_id = $2`,
    [id, tenant],
  )
  res.json({ ok: true, status: archive ? 'archived' : 'active' })
})

/** Attach (or detach when projectId=null) a conversation to a project. */
api.post('/conversations/:id/project', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const projectId = req.body?.projectId === null ? null
                  : (typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : undefined)
  if (projectId === undefined) { res.status(400).json({ error: 'projectId required (string or null to detach)' }); return }
  await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId: id,
    work: async (client) => {
      if (projectId !== null) {
        const { rows: project } = await client.query(
          `SELECT 1 FROM projects WHERE id = $1 AND company_id = $2 LIMIT 1`,
          [projectId, tenant],
        )
        if (!project[0]) throw new HttpError(400, 'unknown project')
      }
      await client.query(
        `UPDATE conversations SET project_id = $2, updated_at = NOW()
          WHERE id = $1 AND company_id = $3`,
        [id, projectId, tenant],
      )
    },
  })
  res.json({ ok: true, projectId })
})

api.get('/participants', async (req, res) => {
  const { companyId: tenant } = await requireCompany(req)
  await pool.query(
    `UPDATE participants
        SET status = 'avail',
            status_updated_at = NOW()
      WHERE company_id = $1
        AND kind = 'agent'
        AND departed_at IS NULL
        AND status IN ('thinking', 'working', 'waiting')
        AND status_updated_at < NOW() - ($2::int * INTERVAL '1 millisecond')`,
    [tenant, BUSY_STATUS_LEASE_MS],
  )
  const { rows } = await pool.query<{
    id: string; kind: 'agent' | 'human'; name: string; role: string | null
    initial: string; avatarBg: string; avatarUrl: string | null
    status: string; statusUpdatedAt: string | null
    bio: string | null; tools: string[] | null
    systemPrompt: string | null; model: string | null
    email: string | null; companySlug: string | null
    departedAt: string | null
    computerId: string | null; engine: string | null; fastModel: string | null
    engineInherit: boolean | null
  }>(
    `SELECT p.id, p.kind, p.name, p.role, p.initial,
            p.avatar_bg AS "avatarBg", p.avatar_url AS "avatarUrl",
            p.status, p.status_updated_at AS "statusUpdatedAt",
            p.bio, p.tools, p.system_prompt AS "systemPrompt", p.model,
            p.computer_id AS "computerId", p.engine, p.fast_model AS "fastModel",
            p.engine_inherit AS "engineInherit",
            -- Email resolution differs by kind:
            --  - agents carry their own minted address on participants.email
            --  - humans don't have one there; surface their real auth email
            --    (users.email) ONLY for humans who are actually members of
            --    THIS company. The cm JOIN is the safety check — without it,
            --    a participant with kind='human' and an id that happens to
            --    match a user.id elsewhere would leak that user's email,
            --    which is wrong even if rare. Demo-seed humans (wei / maya
            --    with no user row) just get null email — fine, they're not
            --    real and can't receive mail anyway.
            COALESCE(
              p.email,
              CASE WHEN p.kind = 'human' AND cm.user_id IS NOT NULL THEN u.email END
            ) AS email,
            comp.slug AS "companySlug",
            p.departed_at AS "departedAt"
       FROM participants p
       JOIN companies comp ON comp.id = p.company_id
       LEFT JOIN company_members cm
              ON cm.user_id = p.id AND cm.company_id = p.company_id
       LEFT JOIN users u ON u.id = cm.user_id
      WHERE p.company_id = $1
      ORDER BY p.kind DESC, p.name ASC`,
    [tenant],
  )
  // Compute deterministic addresses for agents who haven't been
  // lazy-minted yet — without this, the renderer's recipient picker hides
  // every fresh agent (their email column is NULL until first send/recv),
  // which is exactly wrong for "compose new email to an agent". The mint
  // itself stays lazy on the write path; this is just surfacing the
  // address that WILL be used.
  const { computeAgentAddress } = await import('../email.js')
  const finalRows = rows.map((r) => {
    if (r.email || r.kind !== 'agent' || !r.companySlug) {
      const { companySlug: _drop, ...rest } = r
      return rest
    }
    const computed = computeAgentAddress(r.id, r.companySlug)
    const { companySlug: _drop, ...rest } = r
    return { ...rest, email: computed }
  })
  res.json(finalRows)
})

/* ============== Agent CRUD ============== */

/* ============== Deterministic visual signature per agent ============== */

// FNV-1a hash — stable across runs, no deps.
function hashStr(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ s.charCodeAt(i)) >>> 0)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

// Dimensions restored to the FIRST-VERSION register the user liked:
// "real human with their own bones, skin, and history" — character-driven,
// lived-in, with a wide range of media and moods. NOT a fashion-editorial
// or single-national-style framing.
//
// What's kept from the iterations since:
//   1. Gender stratification on `presentation` — the LLM classifier picks
//      the bucket (otherwise outputs drift mono-gender).
//   2. Anti-oily guardrails in the main prompt body (matte natural skin,
//      no glass-skin, no highlighter) — applied as a wrapper, not by
//      stripping the dimension pools.
const VISUAL_DIMENSIONS = {
  // Young — 21–32 sweet spot for "striking young person with personality".
  // Avoid 35+ because the user explicitly said the previous round felt 老气
  // (old-feeling). Also drop the youngest 19-20 — they read as students,
  // not as confident creative adults.
  age: ['21', '22', '22', '23', '23', '24', '24', '25', '25', '26', '26', '27', '28', '29', '31', '32'],
  // Gender-stratified. For FEMININE: emphasize clearly feminine, pretty,
  // youthful — softly girlish features. Earlier pools mixed in cues like
  // "fox-eyed" / "sharp refined" that, combined with short hair and
  // menswear, were drifting the output away from the intended pretty-girl
  // register. The new pool keeps everything unambiguously feminine.
  presentationFeminine: [
    'feminine, softly pretty face with large clear eyes and a small refined nose',
    'feminine, soft heart-shaped face with full pink lips and bright doe eyes',
    'feminine, delicate youthful features with rounded soft cheeks',
    'feminine, doll-like proportions with large expressive eyes and a small chin',
    'feminine, gently pretty face with high cheekbones and a graceful neck',
    'feminine, sweet feminine features with full soft lips and clear bright eyes',
    'feminine, classically pretty youthful face, soft jaw and big warm eyes',
  ],
  presentationMasculine: [
    'masculine, striking refined features with deep clear eyes',
    'masculine, soft handsome face with a strong nose and full lashes',
    'masculine, sharp jaw and high cheekbones, a face with quiet intensity',
    'masculine, refined gentle features with a clear thoughtful gaze',
    'masculine, model-grade proportions with a defined brow',
    'masculine, slim refined face with expressive dark eyes',
    'masculine, soft features with full lips and a kind direct gaze',
  ],
  presentationAndrogynous: [
    'gentle androgynous beauty, soft refined features with a warm clear gaze',
    'softly androgynous, delicate features with deep expressive eyes',
    'softly androgynous, balanced symmetrical features and a kind direct gaze',
    'softly androgynous, refined youthful face with full lashes and a small nose',
    'softly androgynous, pretty refined features with a gentle calm expression',
  ],
  // Skin pool — skewed toward light and light-medium. Duplicated entries are
  // intentional, used as weights against the deterministic hash. Deep-brown /
  // umber / sepia were removed to match the project's preferred register.
  skin: [
    'fair porcelain with a faint pink undertone',
    'fair porcelain with a faint pink undertone',
    'cool ivory',
    'cool ivory',
    'warm cream',
    'warm cream',
    'soft beige',
    'soft beige',
    'golden olive',
    'warm tan',
    'sun-warmed honey',
    'rich olive',
  ],
  // Removed salt-and-pepper / silver-gray — those aged everyone. Kept the
  // statement colors (bleached streak, copper red, dyed tints) for personality.
  hairColor: [
    'raven black with a blue undertone',
    'soft espresso brown',
    'warm chestnut with copper highlights',
    'deep auburn',
    'honey blonde',
    'icy platinum',
    'cool ash brown',
    'fiery copper red',
    'jet black with one bleached blonde streak in front',
    'mossy dark green dyed tint',
    'warm caramel blonde',
    'inky black with bluntly chopped fringe',
    'soft pastel-pink ends fading into natural brown',
  ],
  // Feminine hair — LONGER / SOFTER / PRETTIER. Pixie cuts / undercuts /
  // close-cropped coils were moved to the masculine and androgynous pools
  // because, combined with other elements here, they drifted the output
  // away from the intended pretty-girl register. Kept diversity (curls,
  // braids, ponytail) but every entry here is unambiguously feminine.
  hairStyleFeminine: [
    'long soft waves falling over one shoulder',
    'a chin-length soft bob with a gentle inward curl',
    'shoulder-length and softly tousled, parted in the middle',
    'long, almost-waist-length and gathered loosely over the shoulder',
    'a single low ponytail with face-framing strands',
    'a wide halo of natural curls, framing the face softly',
    'long box braids gathered into a low feminine bun',
    'wavy hair tucked behind one ear, falling past the shoulder',
    'a soft half-up topknot with the rest falling in waves',
    'long straight hair with a soft curtain fringe',
    'a sweet bob with side-swept fringe just brushing the chin',
    'a low chignon with delicate face-framing wisps',
  ],
  // No "shaved head with stubble line" or "grown-out side-part" — those read
  // older. Lean into on-trend young creative-class cuts.
  hairStyleMasculine: [
    'soft tousled hair brushed casually forward',
    'an undercut with a long textured top swept to one side',
    'tight coils cropped close to the scalp, sharp hairline',
    'a clean tapered fade with a coiled crown',
    'medium-length hair tucked loosely behind the ears',
    'short waves with natural volume on top',
    'a soft fringe sweeping across the forehead',
    'a chin-length mullet, soft and modern',
    'shoulder-length wavy hair, free and loose',
    'a sharp shape-up with refined natural texture on top',
  ],
  // Androgynous hair — softened. Buzz cuts / razor temples / undercuts were
  // pulling outputs toward a butch register; replaced with medium-length and
  // soft styles that still read gender-neutral.
  hairStyleAndrogynous: [
    'shoulder-length and tucked loosely behind the ears',
    'a soft chin-length bob with a center part',
    'medium-length tousled hair with a gentle curtain fringe',
    'shoulder-length wavy hair, free and loose',
    'a soft mid-length cut brushed casually back',
    'collarbone-length straight hair with a blunt soft fringe',
  ],
  // SINGLE memorable feature — photogenic and charming. Removed septum
  // ring, stick-and-poke tattoo, white-eyeliner makeup accent, multi-pierced
  // ear stack, "fox-eyed outer lift" — combined with other entries those
  // were drifting toward an art-school / alt-fashion register that didn't
  // match the intended young-pretty-person aesthetic.
  signature: [
    'a small beauty mark just under the left eye',
    'a constellation of light freckles across the nose and cheekbones',
    'a single dimple on the left cheek that shows when smiling',
    'long curling eyelashes that catch light',
    'a soft cupid\'s-bow on the upper lip',
    'an asymmetric raised eyebrow at rest, full of personality',
    'a small mole at the corner of the mouth',
    'a faint natural blush at the apples of the cheeks',
    'plush soft lips with a gentle natural shape',
    'a small delicate gold stud earring',
    'a soft pink flush across the cheeks and nose bridge',
    'a sweet softly rounded chin',
  ],
  glasses: ['no glasses', 'thin gold wire-frames worn low on the bridge', 'small round John-Lennon-style wire-frames', 'narrow rectangular tortoiseshell frames', 'no glasses', 'oversized rounded clear-acetate frames', 'no glasses', 'thin matte-black wire-frames', 'reading glasses pushed up into the hair', 'no glasses'],
  // Lived-in, character-driven accessories from the first version.
  accessory: [
    'a single small gold stud earring on one ear',
    'a delicate silver chain holding a small charm',
    'a thin silk scarf knotted loosely at the neck',
    'no notable accessory',
    'a knit beanie pushed back from the forehead',
    'a graphite pencil tucked behind one ear',
    'no notable accessory',
    'a slim leather watch peeking from a sleeve',
    'an asymmetric pair of small hoop earrings',
    'a tiny enamel pin shaped like a pear on the collar',
    'a piece of red yarn wrapped twice around the wrist',
    'a single oversized ring on the index finger',
  ],
  // FEMININE wardrobe — clearly feminine, pretty, youthful. Earlier
  // entries (leather jacket / structured blazer over camisole / chambray
  // shirt-dress / Breton stripe / silk slip) were drifting the output
  // away from the intended pretty-girl register. Lean into pastel knits,
  // puff sleeves, soft blouses with feminine details (bows, ribbons,
  // lace trim), pretty dresses, distinctly girlish pieces.
  wardrobeFeminine: [
    'a soft pastel-pink cardigan with pearl buttons over a fine white tee',
    'a butter-yellow puff-sleeve blouse, fresh and playful',
    'a sweet cream knit with a delicate scalloped neckline',
    'a soft lavender blouse with a small ribbon bow at the collar',
    'a pretty floral-print summer dress with a soft round neckline',
    'a fitted ribbed sage-green knit top with cap sleeves',
    'a delicate white blouse with lace trim at the collar',
    'a soft baby-blue cardigan over a pretty camisole',
    'a fresh peach-pink puff-sleeve top, sweet and youthful',
    'a clean white blouse with a pussy-bow tie at the neck',
    'a soft cream off-shoulder knit, gently feminine',
    'a pretty pleated lavender dress with a fitted bodice',
    'a soft yellow sundress with thin straps and a sweetheart neckline',
    'a pretty pastel-pink ribbed knit with a delicate scoop neck',
  ],
  wardrobeMasculine: [
    'a soft cream knit sweater over a clean white tee, fashion-student feel',
    'a vintage band tee under an unbuttoned plaid overshirt',
    'a clean white oxford with the sleeves rolled up to the elbow',
    'a soft cropped vintage leather jacket over a clean tee',
    'a structured navy blazer over a fine white tee, sharp and modern',
    'a sage linen shirt with the top buttons casually open',
    'a cropped corduroy jacket over a black turtleneck',
    'a fitted black turtleneck, minimalist and clean',
    'a relaxed-fit white t-shirt under a soft denim chore jacket',
    'a soft camel cashmere cardigan over a fine ribbed tee',
    'a vintage Breton stripe top, classic and cool',
    'a fresh light-blue oxford with the collar relaxed',
  ],
  // Androgynous wardrobe — softened. Cropped leather jacket / black turtleneck
  // / structured blazer were combining with short hair to read butch; replaced
  // with softer knits, linens, and oversized shirts that still feel neutral.
  wardrobeAndrogynous: [
    'a soft oversized cream knit, minimalist and modern',
    'a soft camel cashmere cardigan over a fine ribbed tee',
    'a clean white oxford with the collar slightly relaxed',
    'a sage linen shirt with the top buttons casually open',
    'a soft beige sweatshirt with a relaxed neckline',
    'an oversized chambray shirt worn loose, effortlessly cool',
    'a fine fawn merino crewneck over a thin white tee',
  ],
  // 10 different illustrators / media — the strongest lever for visual
  // distinctness. This pool stays exactly as first-version.
  artStyle: [
    'soft watercolor portrait on heavy cotton paper, visible grain, gentle pencil under-drawing showing through, restrained brushwork',
    'crisp ink-line illustration with translucent gouache washes, magazine-cover feel, hand-lettered sensibility',
    'mid-century editorial illustration, geometric and graphic, flat shading with two or three accent colors, vintage Saul Bass / Paul Rand energy',
    'risograph-style portrait, two-color halftone (terracotta and slate), slight registration offset, pulpy paper texture',
    'oil painting feel with visible brush direction, soft impasto on the cheekbones, refined classical portrait sensibility',
    'pencil drawing with subtle digital color washes, photorealistic linework, almost monochrome with one warm color accent',
    'modern digital editorial portrait, flat color shapes with one rim-light, very pared-back, contemporary brand-illustration style',
    'soft chalk pastel on tinted paper, smudgy edges, gentle warmth, slightly impressionistic',
    'pen-and-ink line drawing with NO color, fine cross-hatching, archival-portrait sensibility',
    'gentle gouache with deliberate visible brush strokes, slightly naive proportions, contemporary picture-book sensibility',
  ],
  // Moody, saturated, tactile — first-version backgrounds. NOT pastel-heavy.
  background: [
    'warm beige paper with subtle grain',
    'soft sage with a hint of paper texture',
    'pale terracotta gradient',
    'cool slate with paper grain',
    'cream with subtle warm texture',
    'soft peach wash',
    'muted lavender mist',
    'matte off-white',
    'warm cinnamon haze',
    'pale ochre with grain',
    'dusty teal flat color',
    'deep plum behind a soft halo of light',
  ],
  // LIVELY + PLAYFUL — no more "introspective" / "guarded" / "patient
  // listening" (those read 老气 + stiff). Each vibe entry now has motion,
  // charm, or a flicker of personality. Mix of joyful, mischievous,
  // confident, and a few quieter ones for variety.
  vibe: [
    'mid-laugh, eyes crinkling into a real smile',
    'a playful smirk just starting at the corner of the mouth',
    'quietly amused, eyes nearly closing into a smile',
    'bright open joy, head tilted with delight',
    'a knowing grin, eyes alive with mischief',
    'caught mid-thought with a small private smile',
    'warm and engaged, eyes catching the viewer',
    'cool confidence with a slight raised eyebrow, charming and direct',
    'a delighted laugh frozen mid-moment, teeth showing',
    'sweet shy smile, eyes meeting the camera then glancing away',
    'about-to-say-something energy, lips just parting',
    'a soft chic smile with sparkle in the eyes',
  ],
  // ACTIVE candid poses — feels caught mid-moment, NOT a stiff portrait
  // shot. Mix angles, tilts, glances. No "chin tucked low eyes up" (that
  // reads sultry / "model gaze"). All read playful / candid / alive.
  headAngle: [
    'three-quarter angle to the left, head tilted with curiosity, gaze meeting the camera',
    'three-quarter angle to the right, mid-turn as if just noticed something',
    'nearly frontal with a playful head tilt and a soft smile',
    'looking back over the shoulder with a quick warm glance',
    'leaning forward a little, elbows implied, fresh open gaze',
    'head tipped slightly back in mid-laugh, eyes crinkled',
    'almost-frontal, head cocked to the side with a small smile',
    'caught looking up from below with a bright surprised expression',
    'three-quarter angle, hand-near-chin pose, thinking-but-amused',
    'profile turning toward the camera with a soft natural smile',
  ],
} as const

function pickFromHash<T>(arr: readonly T[], h: number, salt: number): T {
  return arr[((h ^ salt) >>> 0) % arr.length]
}

type Gender = 'feminine' | 'masculine' | 'androgynous'

/**
 * Infer an agent's gender presentation from their name + role + style. Calls
 * a cheap LLM classifier so the choice respects the agent's actual identity
 * rather than defaulting everyone to one bucket. On classifier error falls
 * back to a deterministic feminine/masculine pick from the agent's name hash
 * — never defaults to androgynous, since the androgynous visual branch is
 * intentionally rare in this project.
 */
async function inferAgentGender(args: {
  name: string; role: string; systemPrompt: string
  /** Tenant for sub2api routing — falls back to legacy global key
   *  when null. */
  tenant: string | null
}): Promise<Gender> {
  const { name, role, systemPrompt } = args
  const hashFallback: Gender = (hashStr(name) & 1) === 0 ? 'feminine' : 'masculine'
  try {
    const { getTrackedLlmClient } = await import('../agents/llm-ledger.js')
    const client = await getTrackedLlmClient({
      purpose: 'gender', companyId: args.tenant,
      extras: { agentName: name, role: role.slice(0, 60) },
    })
    const r = await client.responses.create({
      model: env.OPENAI_MODEL_SUPPORT,
      // Lean STRONGLY COMMITTAL toward feminine/masculine. The androgynous
      // branch's pools (short hair + menswear) drift the output toward a
      // butch register the project doesn't want, so reserve androgynous for
      // the rare case where the name is an abstract brand codename with no
      // human gender lean at all (e.g. "Nimbus", "Helix"). For any name with
      // even a faint feminine OR masculine cultural lean, pick that.
      instructions: `Reply with strict JSON only: {"gender": "feminine" | "masculine"}, or "androgynous" only in the rare case below.

Strongly prefer feminine or masculine. Decide primarily by the NAME's cultural convention (e.g. "Atlas" / "Bram" → masculine; "Iris" / "Maya" → feminine). If the name is unisex (e.g. "Quinn", "Sky", "Riley"), use the persona / role text to break the tie. If it still leans either way at all, pick that side.

Only return "androgynous" when the name is an abstract / brand-style codename with no human gender association (e.g. "Nimbus", "Helix", "Vector") AND the persona text gives no human gender cue. This should be rare.

No prose, no explanation.`,
      input: `Classify the agent below and reply as JSON.

Name: ${name}
Role: ${role || '(none)'}
Persona / style:
${systemPrompt.slice(0, 500) || '(none)'}`,
      text: { format: { type: 'json_object' } },
      max_output_tokens: 200,
      reasoning: { effort: 'low' },
    })
    const parsed = JSON.parse(r.output_text ?? '{}') as { gender?: string }
    if (parsed.gender === 'feminine' || parsed.gender === 'masculine' || parsed.gender === 'androgynous') {
      return parsed.gender
    }
  } catch (e) {
    console.warn('[avatar] gender inference failed, falling back to name-hash pick', e)
  }
  return hashFallback
}

function visualSignatureFor(agentId: string, gender: Gender): {
  age: string; presentation: string; skin: string
  hairColor: string; hairStyle: string
  signature: string
  glasses: string; accessory: string
  wardrobe: string; artStyle: string
  background: string; vibe: string; headAngle: string
  gender: Gender
} {
  const h = hashStr(agentId)
  const presentationPool = gender === 'feminine' ? VISUAL_DIMENSIONS.presentationFeminine
    : gender === 'masculine' ? VISUAL_DIMENSIONS.presentationMasculine
    : VISUAL_DIMENSIONS.presentationAndrogynous
  const hairStylePool = gender === 'feminine' ? VISUAL_DIMENSIONS.hairStyleFeminine
    : gender === 'masculine' ? VISUAL_DIMENSIONS.hairStyleMasculine
    : VISUAL_DIMENSIONS.hairStyleAndrogynous
  const wardrobePool = gender === 'feminine' ? VISUAL_DIMENSIONS.wardrobeFeminine
    : gender === 'masculine' ? VISUAL_DIMENSIONS.wardrobeMasculine
    : VISUAL_DIMENSIONS.wardrobeAndrogynous
  return {
    age:          pickFromHash(VISUAL_DIMENSIONS.age,          h, 0x9E3779B9),
    presentation: pickFromHash(presentationPool,               h, 0x85EBCA6B),
    skin:         pickFromHash(VISUAL_DIMENSIONS.skin,         h, 0xC2B2AE35),
    hairColor:    pickFromHash(VISUAL_DIMENSIONS.hairColor,    h, 0x27D4EB2F),
    hairStyle:    pickFromHash(hairStylePool,                  h, 0x165667B1),
    signature:    pickFromHash(VISUAL_DIMENSIONS.signature,    h, 0x3A4F1B7D),
    glasses:      pickFromHash(VISUAL_DIMENSIONS.glasses,      h, 0xD8163841),
    accessory:    pickFromHash(VISUAL_DIMENSIONS.accessory,    h, 0xA1B5E5A7),
    wardrobe:     pickFromHash(wardrobePool,                   h, 0x53C5DA4D),
    artStyle:     pickFromHash(VISUAL_DIMENSIONS.artStyle,     h, 0xB7E15162),
    background:   pickFromHash(VISUAL_DIMENSIONS.background,   h, 0x6F4A7E13),
    vibe:         pickFromHash(VISUAL_DIMENSIONS.vibe,         h, 0xE9B5DBE1),
    headAngle:    pickFromHash(VISUAL_DIMENSIONS.headAngle,    h, 0xCB1AB31F),
    gender,
  }
}

interface AgentBody {
  id?: unknown; name?: unknown; role?: unknown
  systemPrompt?: unknown; bio?: unknown
  initial?: unknown; avatarBg?: unknown; avatarUrl?: unknown
  model?: unknown; fastModel?: unknown
  tools?: unknown
}
function readAgentBody(b: AgentBody): {
  id?: string; name?: string; role?: string
  systemPrompt?: string; bio?: string
  initial?: string; avatarBg?: string
  /** undefined = leave alone, null = explicit clear, string = set */
  avatarUrl?: string | null
  /** undefined = leave alone, null = explicit clear → use system default, string = override */
  model?: string | null
  /** small-brain model override; same semantics as `model` */
  fastModel?: string | null
  tools?: string[] | null
} {
  const out: Record<string, unknown> = {}
  if (typeof b.id === 'string')           out.id = b.id.trim()
  if (typeof b.name === 'string')         out.name = b.name.trim()
  if (typeof b.role === 'string')         out.role = b.role.trim()
  if (typeof b.systemPrompt === 'string') out.systemPrompt = b.systemPrompt
  if (typeof b.bio === 'string')          out.bio = b.bio
  if (typeof b.initial === 'string')      out.initial = b.initial.trim().slice(0, 2)
  if (typeof b.avatarBg === 'string')     out.avatarBg = b.avatarBg.trim()
  if (b.avatarUrl === null)               out.avatarUrl = null
  else if (typeof b.avatarUrl === 'string') out.avatarUrl = b.avatarUrl.trim()
  if (b.model === null)                   out.model = null
  else if (typeof b.model === 'string')   out.model = b.model.trim() || null
  if (b.fastModel === null)               out.fastModel = null
  else if (typeof b.fastModel === 'string') out.fastModel = b.fastModel.trim() || null
  if (Array.isArray(b.tools))             out.tools = b.tools.map((x) => String(x))
  return out as ReturnType<typeof readAgentBody>
}

api.post('/agents', async (req, res) => {
  // Agents are shared workspace identities — they speak on behalf of the
  // company, hold their own LLM budget, and can email out. Restricting
  // create to owners/admins matches every other "shared workspace
  // configuration" path (invites, project archive).
  const { userId: me, companyId: tenant } = await requireCompanyRole(req)
  const data = readAgentBody(req.body ?? {})
  if (!data.name || !data.name.trim()) { res.status(400).json({ error: 'name required' }); return }
  if (!data.systemPrompt || data.systemPrompt.trim().length < 10) {
    res.status(400).json({ error: 'systemPrompt required (at least 10 chars — describe the agent\'s style)' }); return
  }
  if (req.body?.requestId !== undefined && typeof req.body.requestId !== 'string') {
    res.status(400).json({ error: 'requestId must be a string' }); return
  }
  if (req.body?.computerId !== undefined && typeof req.body.computerId !== 'string') {
    res.status(400).json({ error: 'computerId must be a string' }); return
  }
  const tier = await companyPlanTier(tenant)
  const computerId = typeof req.body?.computerId === 'string' ? req.body.computerId.trim() || null : null
  const engine = typeof req.body?.engine === 'string' ? req.body.engine : undefined
  const inherit = req.body?.inherit === true
  let creation: Awaited<ReturnType<typeof createAgentRecord>>
  try {
    creation = await createAgentRecord({
      companyId: tenant,
      tier,
      maxActiveAgents: TIER_LIMITS[tier].agentsPerCompany,
      requestId: typeof req.body?.requestId === 'string' ? req.body.requestId : null,
      name: data.name,
      role: data.role,
      systemPrompt: data.systemPrompt,
      bio: data.bio,
      initial: data.initial,
      avatarBg: data.avatarBg,
      model: data.model,
      fastModel: data.fastModel,
      tools: data.tools ?? undefined,
      computerId,
      engine,
      inherit,
    })
  } catch (e) {
    const status = e instanceof AgentCreationError ? e.status : 500
    const msg = e instanceof Error ? e.message : String(e)
    res.status(status).json({ error: msg })
    return
  }
  const agentId = creation.id
  // Re-bind data.id for the rest of the handler so subsequent code
  // (workspace seeding, all-hands join, response payload) sees it.
  data.id = agentId
  const { invalidatePersonaCache } = await import('../agents/personas.js')
  invalidatePersonaCache()

  // Auto-join the new agent into the company's #all-hands group + post a
  // join system message. Best-effort — agent create still succeeds even
  // if the group hasn't been seeded yet.
  try { await joinAllHands({ companyId: tenant, participantId: data.id }) }
  catch (e) { console.warn('[agents] join all-hands failed', e) }

  // Seed IDENTITY.md + SOUL.md at the workspace root. These are the
  // agent's self-definition — the system prompt loads them every turn
  // (see personas.ts:buildSystemPrompt). Agents can rewrite them via
  // `edit_file` / `write_file` as they evolve. We seed them with a
  // template based on the persona fields so the first wake-up isn't
  // identity-less.
  try {
    const identityBody = `# ${data.name}\n\n` +
      `**Role:** ${data.role ?? 'agent'}\n\n` +
      (data.bio ? `**Bio:**\n${data.bio}\n\n` : '') +
      `_This file is your identity. Edit it as you grow — what you write here_\n` +
      `_loads into your system prompt on every wake._\n`
    const soulBody = `# Soul of ${data.name}\n\n` +
      `## Voice\n\n` +
      `${data.systemPrompt}\n\n` +
      `## Principles\n\n` +
      `- Speak like a real person, not like a tech blog.\n` +
      `- Match the user's language.\n` +
      `- Save things worth remembering — they outlive any single conversation.\n\n` +
      `_This file is your voice + values. Edit it freely to evolve who you are._\n`
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, company_id, updated_at)
       VALUES ($1, 'IDENTITY.md', $2, $3, NOW()),
              ($1, 'SOUL.md',    $4, $3, NOW())
       ON CONFLICT (agent_id, path) DO NOTHING`,
      [data.id, identityBody, tenant, soulBody],
    )
  } catch (e) {
    console.warn('[agents] seed IDENTITY/SOUL failed', e)
  }

  // Auto-create a 1:1 direct conversation between the creator and the
  // new agent. Without this, the agent never appears in the user's
  // conversations list until they manually click "Chat" — and the Chat
  // button on the agent card stays disabled because no direct exists.
  // Same idempotent shape as `POST /conversations/direct`.
  try {
    await ensureDirectConversation({
      companyId: tenant,
      firstId: me,
      secondId: data.id,
    })
  } catch (e) {
    console.warn('[agents] auto-create direct convo failed', e)
  }

  // Fire-and-forget portrait generation. The agent appears immediately
  // with their initial-letter avatar; the real portrait shows up on the
  // next /participants poll once the image is ready. We deliberately
  // don't block the 201 response since image gen can take several seconds.
  if (creation.created) {
    const newAgentId = data.id
    void generateAndPersistAvatar({ agentId: newAgentId, tenant })
      .then(() => console.log(`[agents] auto-portrait ready for ${newAgentId}`))
      .catch((e) => console.warn(`[agents] auto-portrait failed for ${newAgentId}`, e))
  }

  res.status(creation.created ? 201 : 200).json({
    id: data.id,
    replayed: !creation.created,
    ...(creation.placement ?? {}),
  })
})

api.put('/agents/:id', async (req, res) => {
  // Editing agent system_prompt / model / tools changes a shared resource
  // every member talks to. Gate to owner/admin — same bar as creation.
  const { companyId: tenant } = await requireCompanyRole(req)
  const id = req.params.id
  const { rows: existing } = await pool.query<{ kind: string }>(
    `SELECT kind FROM participants WHERE id = $1 AND company_id = $2`, [id, tenant],
  )
  if (!existing[0]) { res.status(404).json({ error: 'not found' }); return }
  if (existing[0].kind !== 'agent') { res.status(400).json({ error: 'cannot edit non-agent participant' }); return }

  const data = readAgentBody(req.body ?? {})
  const sets: string[] = []
  const params: unknown[] = []
  const push = (col: string, val: unknown) => {
    params.push(val); sets.push(`${col} = $${params.length}`)
  }
  if (data.name !== undefined)         push('name', data.name)
  if (data.role !== undefined)         push('role', data.role)
  if (data.systemPrompt !== undefined) push('system_prompt', data.systemPrompt)
  if (data.bio !== undefined)          push('bio', data.bio)
  if (data.initial !== undefined)      push('initial', data.initial)
  if (data.avatarBg !== undefined)     push('avatar_bg', data.avatarBg)
  if (data.avatarUrl !== undefined)    push('avatar_url', data.avatarUrl)   // null clears it
  if (data.model !== undefined)        push('model', data.model)             // null clears it (use default)
  if (data.fastModel !== undefined)    push('fast_model', data.fastModel)    // small-brain model; null clears
  if (data.tools !== undefined)        push('tools', JSON.stringify(data.tools))
  if (sets.length === 0) { res.status(400).json({ error: 'nothing to update' }); return }
  params.push(id, tenant)
  await pool.query(
    `UPDATE participants SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND company_id = $${params.length}`,
    params,
  )
  const { invalidatePersonaCache } = await import('../agents/personas.js')
  invalidatePersonaCache(id)
  res.json({ ok: true })
})

/**
 * Off-board an agent (soft delete). Their memory / log / workspace / tasks are
 * preserved, their messages stay in conversation history. They stop being woken
 * by the scheduler and disappear from other agents' rosters. Use POST
 * /agents/:id/rehire to bring them back.
 */
api.delete('/agents/:id', async (req, res) => {
  // Off-boarding an agent silences it for the whole workspace and removes
  // it from every conversation's wake roster — destructive, owner/admin only.
  const { companyId: tenant } = await requireCompanyRole(req)
  const id = req.params.id
  const { rows: existing } = await pool.query<{ kind: string; departed_at: string | null }>(
    `SELECT kind, departed_at FROM participants WHERE id = $1 AND company_id = $2`, [id, tenant],
  )
  if (!existing[0]) { res.status(404).json({ error: 'not found' }); return }
  if (existing[0].kind !== 'agent') { res.status(400).json({ error: 'cannot off-board non-agent participant' }); return }
  if (existing[0].departed_at) { res.status(409).json({ error: 'already off-boarded' }); return }
  await pool.query(
    `UPDATE participants
        SET departed_at = NOW(),
            status = 'resting',
            status_updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [id, tenant],
  )
  const { invalidatePersonaCache } = await import('../agents/personas.js')
  invalidatePersonaCache(id)
  // Reclaim the agent's chrome-profile PVC. Off-board is the agent's
  // terminal state — its pod is silenced for good and any future
  // re-spawn (via /rehire) gets a fresh profile anyway, since 30+
  // days of cookies / login state are usually stale by then. Fire-
  // and-forget so a slow kubectl call doesn't stall the response;
  // the helper is idempotent so a re-off-board (race) is harmless.
  void import('../agents/runtime/orchestrator.js').then(({ deleteChromeProfilePvc }) =>
    deleteChromeProfilePvc(id),
  ).catch((e) => console.warn(`[off-board] chrome-PVC delete failed for ${id}:`, e instanceof Error ? e.message : String(e)))
  res.json({ ok: true, departedAt: new Date().toISOString() })
})

/**
 * Generate an AI portrait for an agent and save it as their avatar.
 * Uses the configured OPENAI_IMAGE_MODEL (default: gpt-image-2). The prompt
 * combines the agent's name + role + style with a deterministic visual
 * signature derived from their id, so every agent gets a *distinct* look
 * (different age, skin tone, hair, wardrobe, etc.) but the same person
 * keeps the same look across regenerations.
 */
/**
 * Generate a portrait for an agent and persist it as their avatar_url.
 * Used by both the explicit /agents/:id/avatar/generate endpoint AND the
 * fire-and-forget auto-trigger after POST /agents. Throws on any failure
 * — caller decides whether to surface as 502 or just log.
 */
export async function generateAndPersistAvatar(args: {
  agentId: string
  tenant: string
}): Promise<{ url: string }> {
  const { agentId: id, tenant } = args
  const { rows } = await pool.query<{
    name: string; role: string | null; system_prompt: string | null; kind: string
  }>(
    `SELECT name, role, system_prompt, kind FROM participants WHERE id = $1 AND company_id = $2`,
    [id, tenant],
  )
  const a = rows[0]
  if (!a) throw new HttpError(404, 'not found')
  if (a.kind !== 'agent') throw new HttpError(400, 'avatar generation is only for agents')

  const styleHint = (a.system_prompt ?? '').slice(0, 500)
  // Gender inference is async — call before the visual signature so we pick
  // from the right bucket. Falls back to androgynous if the classifier fails.
  const gender = await inferAgentGender({
    name: a.name, role: a.role ?? '', systemPrompt: styleHint, tenant,
  })
  const visual = visualSignatureFor(id, gender)
  const genderClause = gender === 'feminine'
    ? `${a.name} is a young woman with softly feminine features and styling — a pretty face, gentle expression, distinctly girlish attire (a dress, soft blouse, pastel knit, or similarly feminine piece). Long or shoulder-length soft hair.`
    : gender === 'masculine'
      ? `${a.name} is a young man with clearly masculine features and presentation.`
      : `${a.name}'s gender presentation is intentionally androgynous and refined.`
  const prompt = [
    // Leading framing: SPECIFIC + YOUNG + STRIKING + ALIVE. Image models
    // latch onto the leading adjectives, so we set "young / characterful /
    // beautiful / lively" up front, then add anti-oily as wrapper rules.
    `Draw ${a.name} — a young, striking, characterful individual. Beautiful in a distinctive, interesting way (not a generic "model type", not a "professional headshot"). The kind of person you'd notice in a coffee shop because their face has personality. Caught in a candid, playful moment — alive and engaged with the world, not posing stiffly. ${genderClause}`,
    '',
    `Who ${a.name} is, physically and personality-wise. EVERY detail below is required and must be visible in the portrait:`,
    `• Apparent age: ${visual.age} years old (look this age, no younger, no older)`,
    `• Build / presentation: ${visual.presentation}`,
    `• Skin: ${visual.skin}`,
    `• Hair: ${visual.hairStyle} — colored ${visual.hairColor}`,
    `• A distinctive feature: ${visual.signature}  ← include this clearly`,
    `• Eyewear: ${visual.glasses}`,
    `• Wearing: ${visual.wardrobe}`,
    `• Accessory: ${visual.accessory}`,
    '',
    `Pose & emotional tone (matters as much as the face):`,
    `• Framing: ${visual.headAngle}`,
    `• Vibe right now: ${visual.vibe}`,
    a.role ? `• Their role: ${a.role}` : '',
    styleHint ? `• Inner essence the face should hint at: ${styleHint.slice(0, 240)}` : '',
    '',
    `RENDER STYLE — important, this is what gives the portrait its distinct artistic identity (do NOT default to a "minimalist editorial" baseline):`,
    `${visual.artStyle}.`,
    `Background: ${visual.background}.`,
    '',
    // Wrapper rules — applied as constraints on top of the first-version
    // framing. These two were learned from the rounds in between:
    `Skin finish — NATURAL, not oily:`,
    `- Skin should look like real human skin in honest light. Not shiny, not wet, not "glass-skin", not airbrushed. A real complexion with subtle texture.`,
    `- No makeup highlighter, no glossy lip highlights, no contouring. Brows and lashes natural, eyes alive on their own.`,
    `- Hair has a normal soft texture — no gel, no wet-look, no shellac.`,
    `- Tactile texture of the medium (paper grain, brushwork) belongs in the BACKGROUND and clothing, not as bright highlights on the face.`,
    '',
    'Hard rules:',
    '- Single subject, head-and-shoulders, square frame, head centered so a circular crop works.',
    `- This is ${a.name}, not a stand-in. Lean hard into the specific features above; do not soften them toward an average.`,
    `- The portrait MUST read as YOUNG (early 20s to early 30s) — never 35+, never "weathered", never "lived-in". If the face looks middle-aged, you have failed.`,
    `- The pose must feel ALIVE and CANDID — caught mid-moment, with motion or personality. Never stiff, never "official headshot", never "model gaze".`,
    `- Beautiful but DISTINCTIVE — striking features, real personality. Avoid generic "average attractive face".`,
    `- Respect the gender presentation above; do not contradict it.`,
    '- No text. No logos. No background figures. No stock-photo realism. No anime / chibi / exaggerated cartoon. No sultry / smoldering / "Tom Ford" glamour.',
    '- The portrait should feel like it was drawn for a profile in a magazine that cares deeply about who this person is — Refinery29 / Vice / Kinfolk / Cereal magazine youth-feature energy.',
  ].filter(Boolean).join('\n')

  const { getTrackedLlmClient } = await import('../agents/llm-ledger.js')
  const client = await getTrackedLlmClient({
    purpose: 'avatar-image', companyId: tenant, agentId: id,
    extras: { gender, kind: a.kind },
  })
  const r = await client.images.generate({
    model: env.OPENAI_IMAGE_MODEL,
    prompt,
    size: '1024x1024',
    n: 1,
  })
  const first = r.data?.[0]
  const b64 = first?.b64_json
  const remoteUrl = first?.url
  let imageBuf: Buffer
  if (b64) {
    imageBuf = Buffer.from(b64, 'base64')
  } else if (remoteUrl) {
    const fetched = await fetchImageBytes(remoteUrl, {
      maxBytes: 20 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    if (!fetched.ok) throw new HttpError(502, `image API download failed (${fetched.reason})`)
    imageBuf = fetched.buffer
  } else {
    throw new HttpError(502, 'image API returned no image')
  }

  const key = `avatars/avatar-${id}-${randomUUID().slice(0, 8)}.png`
  const url = await storage.put(key, imageBuf, 'image/png')
  await withOutboxTransaction(async (client) => {
    await client.query(
      `UPDATE participants SET avatar_url = $2 WHERE id = $1 AND company_id = $3`,
      [id, url, tenant],
    )
    await enqueueBroadcast(client, CH_STATUS, {
      type: 'participants.avatar',
      participantId: id,
      avatarUrl: url,
      companyId: tenant,
    })
  })
  const { invalidatePersonaCache } = await import('../agents/personas.js')
  invalidatePersonaCache(id)
  return { url }
}

api.post('/agents/:id/avatar/generate', async (req, res) => {
  // Hits the image API — burns real money. Owner/admin only, otherwise any
  // member could re-roll every agent's portrait in a loop and run up the
  // bill / consume the per-tenant image quota.
  const { companyId: tenant } = await requireCompanyRole(req)
  try {
    const { url } = await generateAndPersistAvatar({ agentId: req.params.id, tenant })
    res.json({ url })
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    const msg = e instanceof Error ? e.message : String(e)
    res.status(502).json({ error: `image generation failed: ${msg}` })
  }
})

/** Re-hire an off-boarded agent — their memory and log come right back. */
api.post('/agents/:id/rehire', async (req, res) => {
  // Same gate as off-boarding (DELETE /agents/:id) — owner/admin only.
  const { companyId: tenant } = await requireCompanyRole(req)
  const id = req.params.id
  const { rows: existing } = await pool.query<{ kind: string; departed_at: string | null }>(
    `SELECT kind, departed_at FROM participants WHERE id = $1 AND company_id = $2`, [id, tenant],
  )
  if (!existing[0]) { res.status(404).json({ error: 'not found' }); return }
  if (existing[0].kind !== 'agent') { res.status(400).json({ error: 'cannot rehire non-agent participant' }); return }
  if (!existing[0].departed_at) { res.status(409).json({ error: 'agent is not off-boarded' }); return }
  await assertCompanyAgentLimit(tenant)
  await pool.query(
    `UPDATE participants
        SET departed_at = NULL,
            status = 'avail',
            status_updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [id, tenant],
  )
  const { invalidatePersonaCache } = await import('../agents/personas.js')
  invalidatePersonaCache(id)
  res.json({ ok: true })
})

api.get('/conversations', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { rows } = await pool.query(
    `SELECT
        c.id, c.kind,
        CASE
          WHEN c.kind = 'direct' THEN COALESCE(other_participant.name, c.title)
          ELSE c.title
        END AS title,
        c.subtitle, c.topic, c.members, c.pinned, c.tag, c.pulled_by AS "pulledBy",
        c.project_id AS "projectId", p.name AS "projectName", p.color AS "projectColor",
        c.created_at AS "createdAt", c.updated_at AS "updatedAt",
        -- Per-user mute. Expired mutes naturally evaluate to false so an
        -- "until tomorrow" silence wears off without needing a sweeper job.
        (mu.user_id IS NOT NULL AND (mu.muted_until IS NULL OR mu.muted_until > NOW())) AS muted,
        mu.muted_until AS "mutedUntil",
        (
          SELECT json_build_object(
            'id', m.id,
            'authorId', m.author_id,
            'kind', m.kind,
            'body', m.body,
            'tool', m.tool,
            'attachment', m.attachment,
            'createdAt', m.created_at,
            -- For email messages, surface the subject + direction so the
            -- sidebar preview can show "Re: contract draft" instead of a
            -- raw body excerpt. NULL for non-email messages — the client
            -- branches on last.kind === 'email'.
            'email', (
              SELECT jsonb_build_object(
                'subject', em.subject,
                'direction', em.direction,
                'from', em.from_addr
              )
                FROM email_messages em
               WHERE em.message_id = m.id
            )
          )
          FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY m.sequence DESC
          LIMIT 1
        ) AS "lastMessage",
        COALESCE((
          SELECT COUNT(*)::int
            FROM messages m
           WHERE m.conversation_id = c.id
             AND m.author_id <> $1
             AND m.created_at > COALESCE(
               (SELECT last_read_at FROM conversation_reads WHERE user_id = $1 AND conversation_id = c.id),
               '1970-01-01T00:00:00Z'::timestamptz
             )
        ), 0) AS "unreadCount"
      FROM conversations c
      LEFT JOIN projects p ON p.id = c.project_id
      LEFT JOIN conversation_mutes mu ON mu.conversation_id = c.id AND mu.user_id = $1
      LEFT JOIN LATERAL (
        SELECT p_other.name
          FROM jsonb_array_elements_text(c.members) WITH ORDINALITY AS member(id, ord)
          JOIN participants p_other
            ON p_other.id = member.id
           AND p_other.company_id = c.company_id
         WHERE member.id <> $1
         ORDER BY member.ord
         LIMIT 1
      ) other_participant ON c.kind = 'direct'
      WHERE c.company_id = $2
        -- Only conversations the caller is actually in. Without this,
        -- agent-to-agent direct chats (members=[agentA, agentB]) leak
        -- into the user's list even though they're not a participant
        -- — those are private to the agents and surfaced only via the
        -- "Whispers" peek tab.
        AND c.members @> to_jsonb(ARRAY[$1::text])
      ORDER BY c.pinned DESC, c.updated_at DESC`,
    [me, tenant],
  )
  res.json(rows)
})

/**
 * Create a new group conversation. Body: { title, members[], subtitle? }.
 * The caller is auto-included; at least one other member is required.
 */
api.post('/conversations', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const title = String(req.body?.title ?? '').trim().slice(0, 80)
  const topic = req.body?.topic ? String(req.body.topic).trim().slice(0, 200) || null : null
  const projectId = req.body?.projectId ? String(req.body.projectId).trim() : null
  const rawMembers = Array.isArray(req.body?.members) ? req.body.members : []
  const memberSet = new Set<string>()
  for (const m of rawMembers) if (typeof m === 'string') memberSet.add(m.trim())
  memberSet.add(me)
  const members = [...memberSet].filter(Boolean)
  if (!title) { res.status(400).json({ error: 'title required' }); return }
  if (members.length < 2) { res.status(400).json({ error: 'pick at least one teammate' }); return }

  const id = `g-${randomUUID().slice(0, 8)}`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participantIds = [...members].sort()
    const { rows: active } = await client.query<{ id: string }>(
      `SELECT id FROM participants
        WHERE company_id = $1 AND id = ANY($2::text[])
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        ORDER BY id FOR SHARE`,
      [tenant, participantIds],
    )
    if (active.length !== participantIds.length) {
      throw new HttpError(400, 'every member must be an active participant in this workspace')
    }
    if (projectId) {
      const { rows: project } = await client.query(
        `SELECT 1 FROM projects WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [projectId, tenant],
      )
      if (!project[0]) throw new HttpError(400, 'unknown project')
    }
    await client.query(
      `INSERT INTO conversations (id, kind, title, topic, members, pinned, tag, pulled_by, company_id, project_id)
       VALUES ($1, 'group', $2, $3, $4::jsonb, FALSE, NULL, NULL, $5, $6)`,
      [id, title, topic, JSON.stringify(members), tenant, projectId],
    )
    await client.query(
      `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 1)`,
      [id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  res.status(201).json({ id, members, projectId })
})

/** Set or clear a conversation's topic. Any member can change it. */
api.post('/conversations/:id/topic', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const raw = req.body?.topic
  const topic = raw === null || raw === '' ? null : (typeof raw === 'string' ? raw.trim().slice(0, 200) : null)
  await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId: id,
    work: async (client) => {
      await client.query(
        `UPDATE conversations SET topic = $2, updated_at = NOW()
          WHERE id = $1 AND company_id = $3`,
        [id, topic, tenant],
      )
      await enqueueBroadcast(client, CH_CONVO_UPDATED, {
        type: 'conversation.updated',
        conversationId: id,
        companyId: tenant,
        patch: { topic },
      })
    },
  })
  res.json({ ok: true, topic })
})

/** Rename a group conversation. Members only; groups only — a DM's title is the
 *  other person's name (derived), so renaming it doesn't apply. */
api.post('/conversations/:id/title', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const title = String(req.body?.title ?? '').trim().slice(0, 80)
  if (!title) { res.status(400).json({ error: 'title required' }); return }
  await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId: id,
    work: async (client, conversation) => {
      if (conversation.kind !== 'group') throw new HttpError(400, 'only group chats can be renamed')
      await client.query(
        `UPDATE conversations SET title = $2, updated_at = NOW()
          WHERE id = $1 AND company_id = $3`,
        [id, title, tenant],
      )
      await enqueueBroadcast(client, CH_CONVO_UPDATED, {
        type: 'conversation.updated',
        conversationId: id,
        companyId: tenant,
        patch: { title },
      })
    },
  })
  res.json({ ok: true, title })
})

/** Find or create a 1-on-1 direct conversation between the caller and the
 *  given participant. Idempotent — clicking the DM button repeatedly always
 *  resolves to the same conversation. */
api.post('/conversations/direct', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const otherId = String(req.body?.otherId ?? '').trim()
  if (!otherId) { res.status(400).json({ error: 'otherId required' }); return }
  if (otherId === me) { res.status(400).json({ error: 'cannot DM yourself' }); return }
  const participantIds = [me, otherId].sort()
  const pairKey = JSON.stringify(participantIds)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: participants } = await client.query<{ id: string; kind: string; name: string }>(
      `SELECT id, kind, name FROM participants
        WHERE company_id = $1 AND id = ANY($2::text[])
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        ORDER BY id FOR SHARE`,
      [tenant, participantIds],
    )
    if (participants.length !== 2) throw new HttpError(404, 'unknown or inactive participant')
    // JSON member pairs have no native unique constraint. A transaction-level
    // advisory lock makes HTTP and agent direct-chat creation idempotent under
    // concurrent first messages.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [tenant, pairKey],
    )
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE kind = 'direct' AND company_id = $3
          AND members @> to_jsonb(ARRAY[$1::text]) AND members @> to_jsonb(ARRAY[$2::text])
          AND jsonb_array_length(members) = 2
        ORDER BY updated_at DESC LIMIT 1
        FOR UPDATE`,
      [me, otherId, tenant],
    )
    if (existing[0]) {
      await client.query('COMMIT')
      res.json({ id: existing[0].id, created: false })
      return
    }

    const id = `direct-${otherId}-${randomUUID().slice(0, 6)}`
    const other = participants.find((participant) => participant.id === otherId)!
    await client.query(
      `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, company_id)
       VALUES ($1, 'direct', $2, NULL, $3::jsonb, FALSE, $4, $5)`,
      [id, other.name, JSON.stringify([me, otherId]), other.kind === 'human' ? 'human' : null, tenant],
    )
    await client.query(
      `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 1)`,
      [id],
    )
    await client.query('COMMIT')
    res.status(201).json({ id, created: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
})

/** Toggle (or set) the pinned state of a conversation. */
api.post('/conversations/:id/pin', async (req, res) => {
  const { id } = req.params
  // Pin state is column-level on conversations (shared across all viewers).
  // Without a membership gate, any tenant member could pin/unpin a private
  // DM they're not part of, mutating UI state for the real members.
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const requested = req.body?.pinned
  const next = await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId: id,
    work: async (client, conversation) => {
      const value = typeof requested === 'boolean' ? requested : !conversation.pinned
      await client.query(
        `UPDATE conversations SET pinned = $2, updated_at = NOW()
          WHERE id = $1 AND company_id = $3`,
        [id, value, tenant],
      )
      return value
    },
  })
  res.json({ ok: true, pinned: next })
})

/**
 * Mute (or unmute) a conversation for the caller. Per-user, never shared.
 *
 * Body shape:
 *   { mute: false }                         → unmute (delete row)
 *   { mute: true }                          → mute forever
 *   { mute: true, until: '<ISO timestamp>'} → mute until that wall-clock time
 *
 * `until` is parsed/validated server-side — any unparseable value is
 * rejected with 400 rather than silently falling back to "forever", which
 * would surprise the user. The client computes the wall-clock from the
 * picked duration (so "15 min" works regardless of clock skew between
 * the user's device and the server).
 */
api.post('/conversations/:id/mute', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const mute = req.body?.mute !== false  // default to mute=true if omitted
  if (!mute) {
    await withLockedConversationMember({
      userId: me,
      companyId: tenant,
      conversationId: id,
      work: async (client) => {
        await client.query(
          `DELETE FROM conversation_mutes WHERE user_id = $1 AND conversation_id = $2`,
          [me, id],
        )
      },
    })
    res.json({ ok: true, muted: false, mutedUntil: null })
    return
  }
  let until: Date | null = null
  if (req.body?.until !== undefined && req.body?.until !== null) {
    const parsed = new Date(String(req.body.until))
    if (Number.isNaN(parsed.getTime())) {
      res.status(400).json({ error: 'invalid until timestamp' }); return
    }
    // Reject already-in-the-past timestamps — those would be a no-op
    // silently dropped by the read-side filter, which is confusing.
    if (parsed.getTime() <= Date.now()) {
      res.status(400).json({ error: 'until must be in the future' }); return
    }
    until = parsed
  }
  await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId: id,
    work: async (client) => {
      await client.query(
        `INSERT INTO conversation_mutes (user_id, conversation_id, muted_at, muted_until)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (user_id, conversation_id)
         DO UPDATE SET muted_at = NOW(), muted_until = EXCLUDED.muted_until`,
        [me, id, until],
      )
    },
  })
  res.json({ ok: true, muted: true, mutedUntil: until ? until.toISOString() : null })
})

/** Add a participant to an existing group. The caller must be a member.
 *  Posts a `joined` system row AFTER the members update — that order
 *  ensures the new member is in `members` when CH_MESSAGE_NEW fires,
 *  so the mailbox scheduler wakes them and they perceive the join. */
api.post('/conversations/:id/members', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const newMember = String(req.body?.id ?? '').trim()
  if (!newMember) { res.status(400).json({ error: 'id required' }); return }
  const { rows } = await pool.query<{ kind: string; members: string[] }>(
    `SELECT kind, members FROM conversations WHERE id = $1 AND company_id = $2`, [id, tenant],
  )
  const c = rows[0]
  if (!c) { res.status(404).json({ error: 'not found' }); return }
  if (c.kind !== 'group') { res.status(400).json({ error: `cannot add to a ${c.kind} conversation` }); return }
  if (!c.members.includes(me)) { res.status(403).json({ error: 'only members can add others' }); return }
  if (c.members.includes(newMember)) { res.json({ ok: true, members: c.members, alreadyIn: true }); return }
  // Validate participant exists in this tenant.
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM participants WHERE id = $1 AND company_id = $2`, [newMember, tenant],
  )
  if (!existing[0]) { res.status(400).json({ error: `unknown participant: ${newMember}` }); return }
  const { addConversationMember } = await import('../agents/membership.js')
  // Postgres edits the array. Splicing it here and writing the whole thing
  // back loses a concurrent membership change, and the `joined` row below is
  // posted either way — so the transcript would record a join that the
  // members column does not agree with.
  const mutation = await addConversationMember({
    conversationId: id, memberId: newMember, actorId: me, companyId: tenant,
  })
  if (!mutation) { res.status(403).json({ error: 'membership changed; add cancelled' }); return }
  res.json({ ok: true, members: mutation.members })
})

/** Leave a group conversation — removes the caller from members.
 *  The authorization predicate is repeated in the mutation itself so a
 *  concurrent revocation cannot leave this stale request authorized. */
api.post('/conversations/:id/leave', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const { rows } = await pool.query<{ kind: string; members: string[] }>(
    `SELECT kind, members FROM conversations WHERE id = $1 AND company_id = $2`, [id, tenant],
  )
  const c = rows[0]
  if (!c) { res.status(404).json({ error: 'not found' }); return }
  if (c.kind === 'direct') {
    res.status(400).json({ error: 'cannot leave a direct conversation' }); return
  }
  if (!c.members.includes(me)) { res.status(409).json({ error: 'not a member' }); return }
  const { removeConversationMember } = await import('../agents/membership.js')
  const mutation = await removeConversationMember({
    conversationId: id, memberId: me, actorId: me, companyId: tenant,
    allowSoleMember: true,
    kind: 'left',
  })
  if (!mutation) { res.status(409).json({ error: 'membership changed; leave cancelled' }); return }
  res.json({ ok: true, members: mutation.members })
})

/** Human typing indicator. The client throttles emission to roughly one
 *  POST per few seconds while typing continues, and sends a final
 *  `done:true` when the composer goes idle / blurs / sends. Membership-
 *  gated to match the broader privacy posture — non-members can't
 *  fingerprint who's typing in a private DM. */
api.post('/conversations/:id/typing', async (req, res) => {
  const { id } = req.params
  try {
    const { userId: me, companyId } = await requireConversationMember(req, id)
    const done = Boolean((req.body ?? {}).done)
    // Reuses the existing typing channel + payload shape. The `agentId`
    // field name is a legacy from when only agents emitted typing — the
    // client treats it as an opaque participant id and doesn't care
    // whether the typer is human or agent.
    await publish(CH_TYPING, {
      type: 'typing',
      conversationId: id,
      agentId: me,
      done,
      companyId,
    })
    res.json({ ok: true })
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    const msg = e instanceof Error ? e.message : 'internal'
    res.status(status).json({ error: msg })
  }
})

api.post('/conversations/:id/read', async (req, res) => {
  const { id } = req.params
  // Membership-gated: only members can record a read receipt on a convo.
  // Without this, a tenant peer could write conversation_reads rows pointing
  // at conversations they're not in (low impact, but the same audit-trail
  // concern as marking phantom reads).
  const { userId: me } = await requireConversationMember(req, id)
  await pool.query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
    [me, id],
  )
  res.json({ ok: true })
})

api.get('/conversations/:id/messages', async (req, res) => {
  const { id } = req.params
  try {
    // Membership-gated read. Tenant-gate alone used to let any peer in the
    // same workspace pull the full transcript of someone else's DM as long
    // as they knew (or guessed) the conversation id; requireConversationMember
    // closes that path. The /peek/agent-chats surface intentionally bypasses
    // membership for fully-agent rooms — see that handler.
    const { companyId: tenant } = await requireConversationMember(req, id)
    // Cursor pagination. No params → most recent `limit` messages, sorted
    // ASC (the historical contract). `before=<sequence>` returns the page
    // strictly older than that cursor — clients pass the smallest sequence
    // they already hold to fetch the next batch upward. Clamp to keep a
    // single request from pulling the whole transcript by accident.
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10)
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 80
    const rawBefore = Number.parseInt(String(req.query.before ?? ''), 10)
    const before = Number.isFinite(rawBefore) ? rawBefore : null
    const params: unknown[] = [id, tenant]
    let beforeClause = ''
    if (before !== null) {
      params.push(before)
      beforeClause = ` AND m.sequence < $${params.length}`
    }
    params.push(limit)
    const limitParam = `$${params.length}`
    const { rows } = await pool.query(
      `SELECT
          m.id, m.conversation_id AS "conversationId",
          m.author_id AS "authorId", m.kind, m.body, m.sequence,
          m.client_id AS "clientId",
          m.tool, m.attachment, m.poll,
          -- Per-option vote tallies for polls. Empty array for non-poll
          -- rows. voterIds is sorted so the client can diff cheaply across
          -- successive WS poll.updated events.
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'optionId', pv.option_id,
              'count', pv.cnt,
              'voterIds', pv.voter_ids
            ) ORDER BY pv.cnt DESC, pv.option_id ASC)
              FROM (
                SELECT option_id,
                       COUNT(*)::int AS cnt,
                       array_agg(voter_participant_id ORDER BY voter_participant_id) AS voter_ids
                  FROM poll_votes
                 WHERE message_id = m.id
                 GROUP BY option_id
              ) pv
          ), '[]'::jsonb) AS "pollTallies",
          m.quoted_message_id AS "quotedMessageId",
          m.created_at AS "createdAt",
          -- Email-specific fields, only populated for kind='email'. We
          -- LEFT JOIN here instead of stashing the headers on messages
          -- itself so the renderer gets a typed "email" payload (subject,
          -- from, to[], cc[], direction, transport_status, in_reply_to)
          -- with no JSONB-shape guessing in the client.
          (
            SELECT jsonb_build_object(
              'subject', em.subject,
              'from', em.from_addr,
              'to', em.to_addrs,
              'cc', em.cc_addrs,
              'direction', em.direction,
              'transportStatus', em.transport_status,
              'transportError', em.transport_error,
              'smtpMessageId', em.smtp_message_id,
              'inReplyTo', em.in_reply_to,
              'hasHtml', em.html IS NOT NULL,
              'autoSubmitted', em.auto_submitted,
              'attachments', COALESCE(
                (SELECT jsonb_agg(jsonb_build_object(
                    'id', ea.id,
                    'filename', ea.filename,
                    'mimeType', ea.mime_type,
                    'sizeBytes', ea.size_bytes,
                    'storageKey', ea.storage_key,
                    'truncated', ea.truncated
                  ) ORDER BY ea.created_at)
                   FROM email_attachments ea
                  WHERE ea.message_id = m.id),
                '[]'::jsonb)
            )
              FROM email_messages em
             WHERE em.message_id = m.id
          ) AS "email",
          -- mine (did I react?) is deliberately NOT computed here. The
          -- same reactions array is reused over WS broadcast where "I"
          -- varies per recipient; renderer derives it from users.
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'emoji', emoji,
                'count', count,
                'users', users
              ))
              FROM (
                SELECT
                  emoji,
                  COUNT(*)::int AS count,
                  array_agg(user_id ORDER BY user_id) AS users
                FROM message_reactions
                WHERE message_id = m.id
                GROUP BY emoji
                ORDER BY count DESC, emoji ASC
              ) r
            ),
            '[]'::jsonb
          ) AS "reactions",
          -- Resolve the quoted message inline so the client doesn't need a
          -- second roundtrip per reply. Trimmed body (240 chars) keeps the
          -- payload small; if the quoted row is gone (soft-FK left it NULL
          -- on delete) the whole field is NULL — renderer shows "[deleted]".
          (
            SELECT jsonb_build_object(
              'id', qm.id,
              'authorId', qm.author_id,
              -- Author can be a participant (agent/human) OR a human keyed by
              -- user id; COALESCE both so the quote shows a NAME, not a raw id.
              'authorName', COALESCE(qp.name, qu.display_name, qm.author_id),
              'kind', qm.kind,
              'body', LEFT(qm.body, 240),
              'sequence', qm.sequence
            )
              FROM messages qm
              LEFT JOIN participants qp ON qp.id = qm.author_id AND qp.company_id = $2
              LEFT JOIN users qu ON qu.id = qm.author_id
             WHERE qm.id = m.quoted_message_id
               AND qm.conversation_id = m.conversation_id
          ) AS "quoted",
          -- Reply count — number of OTHER messages quoting this one. Lets
          -- the bubble render a "N 条回复" affordance to open the thread
          -- drawer without a separate request per message.
          (
            SELECT COUNT(*)::int
              FROM messages rm
             WHERE rm.quoted_message_id = m.id
          ) AS "replyCount"
        FROM messages m
        WHERE m.conversation_id = $1${beforeClause}
        ORDER BY m.sequence DESC
        LIMIT ${limitParam}`,
      params,
    )
    // Pulled DESC for the LIMIT to land on the *newest* `limit` rows; flip
    // back to ASC so the renderer's append-only assumptions still hold.
    rows.reverse()
    // Re-sign every persisted attachment URL with a fresh expiry so
    // historical messages don't break after the original signature's TTL.
    // No-op for attachments without a stored `key` (legacy local mode).
    //
    // A storage-backend hiccup on ONE row used to 500 the whole list —
    // wrap each refresh so a single bad attachment falls back to its
    // stored (possibly stale) URL instead of bringing down the response.
    for (const row of rows) {
      if (!row.attachment) continue
      try {
        row.attachment = await freshenAttachmentUrl(row.attachment)
      } catch (e) {
        console.warn(
          `[messages] freshenAttachmentUrl failed for message ${row.id} in ${id}; ` +
          `falling back to stored URL`, e,
        )
      }
    }
    // Email attachments: same idea, different shape. The SQL JOIN returns
    // each attachment with its storage_key; resolve a fresh public URL so
    // the client can <a href=…> straight away. Truncated entries (worker
    // refused to forward bytes) keep url=null — the UI shows "(too large)".
    for (const row of rows) {
      const r = row as Record<string, unknown> & { email?: { attachments?: Array<{ storageKey: string | null; url?: string | null; truncated?: boolean }> } | null }
      const atts = r.email?.attachments
      if (!atts || atts.length === 0) continue
      for (const a of atts) {
        if (!a.storageKey || a.truncated) { a.url = null; continue }
        try { a.url = await storage.publicUrl(a.storageKey) }
        catch (e) {
          console.warn(`[messages] email attachment URL resolve failed for ${a.storageKey} in ${id}`, e)
          a.url = null
        }
      }
    }
    res.json(rows)
  } catch (e) {
    // Don't bury HttpError under 500 — those carry real status codes
    // (401/403/404 from the auth helpers) the client needs to branch on.
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error(`[messages] GET /conversations/${id}/messages failed`, e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

api.post('/conversations/:id/messages', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { id } = req.params
  const body = String(req.body?.body ?? '').trim()
  const rawAttachment = req.body?.attachment
  let attachment: AttachmentPayload | null = null
  if (rawAttachment && typeof rawAttachment === 'object') {
    const a = rawAttachment as Record<string, unknown>
    if (typeof a.url === 'string' && typeof a.name === 'string') {
      // URLs are display data and may be client-controlled or expired. Resolve
      // the server-generated object key, then mint the URL ourselves so a chat
      // attachment can never turn an agent wake into an arbitrary server fetch.
      const key = messageAttachmentStorageKey(a)
      if (!key) {
        res.status(400).json({ error: 'attachment must reference Cumora storage' })
        return
      }
      let url: string
      try {
        url = await storage.publicUrl(key)
      } catch {
        res.status(400).json({ error: 'attachment storage reference is invalid' })
        return
      }
      attachment = {
        url,
        name: a.name.trim().slice(0, 200),
        kind: (a.kind === 'pdf' || a.kind === 'file' || a.kind === 'fig' ? a.kind : 'img') as AttachmentPayload['kind'],
        mime: typeof a.mime === 'string' ? a.mime : undefined,
        size: typeof a.size === 'number' ? a.size : undefined,
        key,
      }
    }
  }
  // Allow empty body when an attachment is present (e.g. user just shares an image)
  if (!body && !attachment) {
    res.status(400).json({ error: 'empty message' })
    return
  }

  const rawQuotedId = req.body?.quotedMessageId
  const quotedMessageId = typeof rawQuotedId === 'string' && rawQuotedId.length > 0
    ? rawQuotedId
    : null

  // Optional client-supplied idempotency key. Persisted so retries and
  // reconnect fetches can reconcile the original optimistic bubble.
  const rawClientId = req.body?.clientId
  if (rawClientId != null && (typeof rawClientId !== 'string' || rawClientId.length === 0 || rawClientId.length > 80)) {
    res.status(400).json({ error: 'invalid clientId' })
    return
  }
  const clientId = typeof rawClientId === 'string' ? rawClientId : null

  let deliveryMessageId: string | undefined
  let responseFinished = false
  const logDelivery = (phase: string, extra?: Record<string, unknown>) => {
    console.log('[message-delivery]', JSON.stringify({
      phase,
      conversationId: id,
      authorId: me,
      clientId: clientId ?? undefined,
      messageId: deliveryMessageId,
      ...extra,
    }))
  }
  logDelivery('request.received')
  res.once('finish', () => {
    responseFinished = true
    logDelivery('response.finished', { status: res.statusCode })
  })
  res.once('close', () => {
    if (!responseFinished) {
      logDelivery('response.closed', {
        status: res.headersSent ? res.statusCode : undefined,
        headersSent: res.headersSent,
        writableFinished: res.writableFinished,
      })
    }
  })

  const { rows: convoRows } = await pool.query<{ members: string[]; kind: string }>(
    `SELECT members, kind FROM conversations WHERE id = $1 AND company_id = $2`,
    [id, tenant],
  )
  const convo = convoRows[0]
  if (!convo) {
    res.status(404).json({ error: 'conversation not found' })
    return
  }
  if (!convo.members.includes(me)) {
    res.status(403).json({ error: 'not a member of this conversation' })
    return
  }

  // Email conversations: auto-promote a "chat-style" reply into a real
  // email reply. Without this, typing in the chat input of an email
  // thread (or an agent calling `cumora reply` from its CLI) would just
  // write a kind='text' row that the external recipient never sees.
  if (convo.kind === 'email') {
    if (!body) {
      res.status(400).json({ error: 'email replies require a body (attachments-only sends not supported here yet)' })
      return
    }
    try {
      const { replyInEmailConversation } = await import('../email.js')
      const result = await replyInEmailConversation({
        conversationId: id, companyId: tenant, authorId: me, body,
        // Human user — leave autoSubmitted false. Agent path uses cmdReply
        // in the CLI which sets it true.
      })
      res.status(result.transportStatus === 'sent' ? 202 : 502).json({
        id: result.messageId,
        sequence: result.sequence,
        transportStatus: result.transportStatus,
        mock: result.mock,
        error: result.error,
      })
      return
    } catch (e) {
      console.error('[messages] email auto-promote failed', e)
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
      return
    }
  }

  let quotedSummary: {
    id: string; authorId: string; authorName: string; kind: string;
    body: string; sequence: number
  } | null = null
  let resolvedQuotedId: string | null = null
  const proposedMessageId = `m-${randomUUID()}`
  let persisted: { id: string; sequence: number } | undefined
  let insertedNew = false
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Final write authorization is transactional. Locking the actor before
    // the conversation matches membership mutation lock order, so a kick,
    // offboard, or tenant move either happens before this write (and rejects
    // it) or after the committed message — never between check and INSERT.
    const actor = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        FOR SHARE`,
      [me, tenant],
    )
    if (!actor.rowCount) throw new HttpError(403, 'participant is no longer active in this workspace')
    const currentConversation = await client.query<{ kind: string }>(
      `SELECT kind FROM conversations
        WHERE id = $1 AND company_id = $2
          AND members @> to_jsonb(ARRAY[$3::text])
        FOR UPDATE`,
      [id, tenant, me],
    )
    if (!currentConversation.rowCount) throw new HttpError(403, 'not a member of this conversation')
    if (currentConversation.rows[0].kind === 'email') {
      throw new HttpError(409, 'conversation changed; retry the email reply')
    }

    // Prove a quoted target belongs to this same authorized conversation.
    // Unknown/deleted ids are dropped so the body can still be delivered.
    if (quotedMessageId) {
      const { rows: qr } = await client.query<{
        id: string; author_id: string; author_name: string; kind: string;
        body: string; sequence: number
      }>(
        `SELECT m.id, m.author_id,
                COALESCE(p.name, u.display_name, m.author_id) AS author_name,
                m.kind, m.body, m.sequence
           FROM messages m
           LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = $3
           LEFT JOIN users u ON u.id = m.author_id
          WHERE m.id = $1 AND m.conversation_id = $2`,
        [quotedMessageId, id, tenant],
      )
      if (qr[0]) {
        resolvedQuotedId = qr[0].id
        quotedSummary = {
          id: qr[0].id,
          authorId: qr[0].author_id,
          authorName: qr[0].author_name,
          kind: qr[0].kind,
          body: qr[0].body.slice(0, 240),
          sequence: qr[0].sequence,
        }
      }
    }

    // Retrying a message, or sending it twice at the same time, can leave a
    // sequence gap. Gaps are safe because sequence is ordering-only.
    const seqResult = await client.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS seq`,
      [id],
    )
    const sequence = seqResult.rows[0]?.seq ?? 1
    const inserted = await client.query<{ id: string; sequence: number }>(
      `INSERT INTO messages
         (id, conversation_id, author_id, kind, body, sequence, attachment, quoted_message_id, company_id, client_id)
       VALUES ($1,$2,$3,'text',$4,$5,$6::jsonb,$7,$8,$9)
       ON CONFLICT (conversation_id, author_id, client_id) WHERE client_id IS NOT NULL
       DO NOTHING
       RETURNING id, sequence`,
      [proposedMessageId, id, me, body, sequence, attachment ? JSON.stringify(attachment) : null, resolvedQuotedId, tenant, clientId],
    )
    persisted = inserted.rows[0] ?? (clientId
      ? (await client.query<{ id: string; sequence: number }>(
          `SELECT id, sequence FROM messages
            WHERE conversation_id = $1 AND author_id = $2 AND client_id = $3`,
          [id, me, clientId],
        )).rows[0]
      : undefined)
    if (!persisted) throw new Error('message insert returned no row')
    insertedNew = Boolean(inserted.rows[0])
    if (insertedNew) {
      await client.query(
        `UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND company_id = $2`,
        [id, tenant],
      )
      await enqueueBroadcast(client, CH_MESSAGE_NEW, {
        type: 'message.new',
        conversationId: id,
        companyId: tenant,
        message: {
          id: persisted.id, conversationId: id, authorId: me,
          kind: 'text', body, sequence: persisted.sequence, at: new Date().toISOString(),
          attachment: attachment ?? undefined,
          quotedMessageId: resolvedQuotedId ?? undefined,
          quoted: quotedSummary ?? undefined,
          clientId: clientId ?? undefined,
        },
      })
    }
    await client.query('COMMIT')
    if (insertedNew) nudgeRealtimeOutbox()
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (!persisted) throw new Error('message insert returned no row')
  const messageId = persisted.id
  const persistedSequence = persisted.sequence
  deliveryMessageId = messageId
  if (!insertedNew) {
    logDelivery('message.reused', { sequence: persistedSequence })
    res.status(202).json({ id: messageId, sequence: persistedSequence })
    return
  }
  logDelivery('message.committed', { sequence: persistedSequence })

  // Test-only fault injection: reproduce a connection disappearing after
  // persistence but before either HTTP or WebSocket acknowledgement.
  if (
    env.NODE_ENV !== 'production'
    && process.env.CUMORA_TEST_MESSAGE_FAULTS === '1'
    && req.get('x-cumora-test-message-fault') === 'after-commit-drop-ack'
  ) {
    logDelivery('fault.after_commit_drop_ack')
    res.destroy()
    return
  }

  // Redis delivery is handled by the transactional outbox worker. The mailbox
  // scheduler and WS bridge receive the same payload without participating in
  // HTTP command completion.
  logDelivery('ws.enqueued')

  // Fan out APNs to recipients who aren't currently looking at the app
  // (NotificationToasts handles those). Fire-and-forget — push delivery
  // must never block the HTTP response. The push module soft-disables
  // when APNs creds aren't configured, so this is safe even in dev.
  void (async () => {
    try {
      const [recipients, convoRow, authorRow] = await Promise.all([
        computeMessageRecipients({ conversationId: id, authorId: me }),
        pool.query<{ title: string }>(`SELECT title FROM conversations WHERE id = $1`, [id]).then((r) => r.rows[0]),
        pool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [me]).then((r) => r.rows[0]),
      ])
      if (recipients.length === 0) return
      await notifyMessage({
        conversationId: id,
        conversationTitle: convoRow?.title ?? null,
        authorId: me,
        authorName: authorRow?.display_name ?? me,
        messageId,
        body,
        companyId: tenant,
        recipientUserIds: recipients,
      })
    } catch (e) {
      console.warn('[push] notifyMessage post-/messages failed', e)
    }
  })()

  // Climate signal: @-mentioned agents feel mildly more affinity / trust
  // toward the speaker (engagement is positive). Fire-and-forget so we
  // don't block the response on small writes.
  void import('../agents/climate.js').then(({ bumpClimateFromMentions }) =>
    bumpClimateFromMentions({ body, speakerId: me, companyId: tenant }),
  )

  res.status(202).json({
    id: messageId,
    sequence: persistedSequence,
    quotedMessageId: resolvedQuotedId ?? undefined,
    quoted: quotedSummary ?? undefined,
  })
})

/* ============== Polls ====================================================
 * A poll is a kind='poll' messages row with a structured payload + a
 * separate poll_votes table for tallies. Both humans (via this HTTP API)
 * and agents (via `cumora poll …` in agents/cli.ts) share the same core
 * in ../polls.ts so the WS broadcast + validation stay in lockstep. */

function pollHttpError(res: Response, e: unknown): void {
  if (e instanceof PollError) {
    res.status(e.status).json({ error: e.message })
    return
  }
  if (e instanceof HttpError) {
    res.status(e.status).json({ error: e.message })
    return
  }
  console.error('[polls] unhandled', e)
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
}

api.post('/polls', async (req, res) => {
  try {
    const { userId: me, companyId: tenant } = await requireCompany(req)
    const body = req.body ?? {}
    const conversationId = String(body.conversationId ?? '')
    if (!conversationId) { res.status(400).json({ error: 'conversationId required' }); return }
    // Conversation membership is re-checked inside createPoll, but going
    // through requireConversationMember here gives a uniform 404 for
    // cross-tenant / missing rows like the rest of the API.
    await requireConversationMember(req, conversationId)

    const optionsRaw = Array.isArray(body.options) ? body.options : []
    const created = await createPoll({
      conversationId,
      companyId: tenant,
      authorId: me,
      question: String(body.question ?? ''),
      mode: body.mode === 'multi' ? 'multi' : 'single',
      options: optionsRaw.map((o: unknown) => String(o ?? '')),
      expiresInMinutes: typeof body.expiresInMinutes === 'number'
        ? body.expiresInMinutes
        : null,
    })
    res.status(201).json(created)
  } catch (e) { pollHttpError(res, e) }
})

api.post('/polls/:messageId/vote', async (req, res) => {
  try {
    const { userId: me, companyId: tenant } = await requireCompany(req)
    const messageId = req.params.messageId
    const rawOptionIds = Array.isArray(req.body?.optionIds) ? req.body.optionIds : []
    const optionIds = rawOptionIds.map((x: unknown) => String(x ?? '')).filter(Boolean)
    const event = await castVote({
      messageId,
      companyId: tenant,
      voterParticipantId: me,
      voterKind: 'human',
      optionIds,
    })
    res.json({ tallies: event.tallies, poll: event.poll })
  } catch (e) { pollHttpError(res, e) }
})

api.post('/polls/:messageId/close', async (req, res) => {
  try {
    const { userId: me, companyId: tenant } = await requireCompany(req)
    const messageId = req.params.messageId
    const event = await closePoll({
      messageId,
      companyId: tenant,
      actorId: me,
      reason: 'manual',
    })
    res.json({ closed: !!event, poll: event?.poll ?? null })
  } catch (e) { pollHttpError(res, e) }
})

/* ============== Email send / reply (human → external & in-tenant) ============
 * Mirror of the agent CLI's `cumora email send/reply` so a human in the
 * UI's compose drawer can write real email. The server-side flow is the
 * same shared pipeline (resolve recipient → mintMessageId → sendViaProvider
 * → persistEmailMessage) — the only difference is `authorId = caller user`
 * and `from = caller's auth email + display name`.
 *
 * Both endpoints are gated on company membership (requireCompany). On
 * provider failure we still persist the row (transport_status='failed')
 * so the user can see + retry from the thread instead of losing the
 * draft on the wire. */

/** Validate + resolve attachment metadata for outbound email. Caller has
 *  already uploaded the bytes (via the standard /uploads path) and hands
 *  us each entry's storage key + filename + mime + size. We:
 *    1. Reject pathological inputs (missing fields, too many, too big)
 *    2. Resolve each key to a fresh signed URL so Resend can fetch it
 *  Returns an Error (not throws) so callers stay flat. */
async function resolveHttpAttachments(raw: unknown[]): Promise<Array<{
  filename: string; mimeType: string; sizeBytes: number;
  storageKey: string; publicUrl: string;
}> | Error> {
  const MAX_ATTACHMENTS = 16
  const MAX_ATTACH_TOTAL = 25 * 1024 * 1024
  if (raw.length > MAX_ATTACHMENTS) {
    return new Error(`too many attachments (${raw.length} > ${MAX_ATTACHMENTS})`)
  }
  const out: Array<{
    filename: string; mimeType: string; sizeBytes: number;
    storageKey: string; publicUrl: string;
  }> = []
  let totalBytes = 0
  for (const entry of raw) {
    const a = entry as Record<string, unknown>
    const key = typeof a.key === 'string' ? a.key : ''
    const filename = typeof a.filename === 'string' ? a.filename.slice(0, 200) : ''
    const mimeType = typeof a.mimeType === 'string' ? a.mimeType.slice(0, 120) : 'application/octet-stream'
    const sizeBytes = Math.max(0, Number(a.sizeBytes ?? 0))
    if (!key || !filename) return new Error('each attachment needs key + filename')
    totalBytes += sizeBytes
    if (totalBytes > MAX_ATTACH_TOTAL) return new Error(`attachments exceed ${MAX_ATTACH_TOTAL} bytes total`)
    const publicUrl = await storage.publicUrl(key)
    out.push({ filename, mimeType, sizeBytes, storageKey: key, publicUrl })
  }
  return out
}

interface EmailRecipientResolveCtx { companyId: string }
async function resolveHttpRecipient(raw: string, ctx: EmailRecipientResolveCtx): Promise<{ addr: string; name: string | null } | null> {
  // Synthetic external:<addr> ids are inbound-author markers, not real
  // recipients — refuse them up front so we surface a clean 400 instead
  // of silently mailing nowhere.
  if (raw.startsWith('external:')) return null
  const { parseAddress, ensureParticipantAddress } = await import('../email.js')
  const direct = parseAddress(raw)
  if (direct) return direct
  // Treat raw as a participant id. Two delivery targets depending on kind:
  //   - agent  → their cumora address (only place an agent exists)
  //   - human  → their personal auth email (so the message lands in their
  //              real inbox; they ALSO see it in cumora because they're
  //              already a conversation member, so the SSE wake covers
  //              the in-app notification)
  const { rows: pa } = await pool.query<{ name: string; email: string | null; kind: string }>(
    `SELECT name, email, kind FROM participants
      WHERE id = $1 AND company_id = $2 AND departed_at IS NULL LIMIT 1`,
    [raw, ctx.companyId],
  )
  if (pa[0]) {
    if (pa[0].kind === 'agent') {
      if (pa[0].email) return { addr: pa[0].email, name: pa[0].name }
      // Lazy-mint at resolve time — same path /participants takes when
      // surfacing the deterministic address.
      const ensured = await ensureParticipantAddress(raw, ctx.companyId)
      if (ensured) return { addr: ensured.email, name: ensured.displayName }
    }
    if (pa[0].kind === 'human') {
      // Human participant id == users.id; pull their auth email.
      const { rows: u } = await pool.query<{ email: string | null }>(
        `SELECT email FROM users WHERE id = $1 LIMIT 1`, [raw],
      )
      if (u[0]?.email) return { addr: u[0].email, name: pa[0].name }
    }
  }
  // Fallback: caller passed a user id directly (not the participant id).
  const { rows: us } = await pool.query<{ display_name: string; email: string }>(
    `SELECT u.display_name, u.email
       FROM users u JOIN company_members cm ON cm.user_id = u.id
      WHERE u.id = $1 AND cm.company_id = $2 LIMIT 1`,
    [raw, ctx.companyId],
  )
  if (us[0]) return { addr: us[0].email, name: us[0].display_name }
  return null
}

api.post('/email/send', async (req, res) => {
  try {
    const { userId: me, companyId: tenant } = await requireCompany(req)
    const toRaw = Array.isArray(req.body?.to) ? req.body.to as unknown[] : []
    const ccRaw = Array.isArray(req.body?.cc) ? req.body.cc as unknown[] : []
    const attachRaw = Array.isArray(req.body?.attachments) ? req.body.attachments as unknown[] : []
    const {
      formatAddress, sendViaProvider, findOrCreateEmailConversation,
      persistEmailMessage, mintMessageId, ensureParticipantAddress,
      sanitizeSubject,
    } = await import('../email.js')
    const subject = sanitizeSubject(String(req.body?.subject ?? ''))
    const body = String(req.body?.body ?? '').trim().slice(0, 50_000)
    if (toRaw.length === 0 || !subject || !body) {
      res.status(400).json({ error: 'to, subject, body required' })
      return
    }
    const resolvedAttachments = await resolveHttpAttachments(attachRaw)
    if (resolvedAttachments instanceof Error) {
      res.status(400).json({ error: resolvedAttachments.message })
      return
    }

    // Sender = the calling human as a participant of THIS company.
    // We need a cumora-domain address (Resend won't accept From: yourgmail
    // because we don't own gmail.com). ensureParticipantAddress mints
    // <userId>.<slug>@<EMAIL_DOMAIN> if the column was still null.
    const sender = await ensureParticipantAddress(me, tenant)
    if (!sender) { res.status(400).json({ error: 'no email address available for your account in this workspace' }); return }

    const toResolved: { addr: string; name: string | null }[] = []
    const ccResolved: { addr: string; name: string | null }[] = []
    for (const raw of toRaw) {
      const r = await resolveHttpRecipient(String(raw), { companyId: tenant })
      if (!r) { res.status(400).json({ error: `unresolved recipient: ${raw}` }); return }
      toResolved.push(r)
    }
    for (const raw of ccRaw) {
      const r = await resolveHttpRecipient(String(raw), { companyId: tenant })
      if (!r) { res.status(400).json({ error: `unresolved cc: ${raw}` }); return }
      ccResolved.push(r)
    }

    // Conversation members = sender + every same-tenant recipient (agents
    // we know, humans we know). External addresses don't get a participant
    // row — they're reachable only through email_messages.from_addr.
    const memberIds = new Set<string>([me])
    for (const r of [...toResolved, ...ccResolved]) {
      const inHouse = await pool.query<{ id: string }>(
        `SELECT id FROM participants
          WHERE LOWER(email) = $1 AND company_id = $2 AND departed_at IS NULL LIMIT 1`,
        [r.addr, tenant],
      )
      if (inHouse.rows[0]) { memberIds.add(inHouse.rows[0].id); continue }
      // Workspace humans by their auth email.
      const human = await pool.query<{ id: string }>(
        `SELECT u.id FROM users u
           JOIN company_members cm ON cm.user_id = u.id
          WHERE LOWER(u.email) = $1 AND cm.company_id = $2 LIMIT 1`,
        [r.addr, tenant],
      )
      if (human.rows[0]) memberIds.add(human.rows[0].id)
    }

    const messageId = mintMessageId()
    const conv = await findOrCreateEmailConversation({
      companyId: tenant, inReplyTo: null, references: [],
      subject, memberIds: [...memberIds],
    })
    const fromLine = formatAddress(sender.email, sender.displayName)
    // Authorize and commit the durable outbound row before the network hop.
    // persistEmailMessage pins the active participant and conversation
    // membership, so a concurrent removal wins before any provider call.
    const persisted = await persistEmailMessage({
      conversationId: conv.conversationId,
      companyId: tenant,
      authorId: me,
      direction: 'out',
      transportStatus: 'sending',
      transportError: null,
      smtpMessageId: messageId,
      inReplyTo: null, references: [],
      subject,
      fromAddr: fromLine,
      toAddrs: toResolved.map((r) => formatAddress(r.addr, r.name)),
      ccAddrs: ccResolved.map((r) => formatAddress(r.addr, r.name)),
      body,
      attachments: resolvedAttachments.map((a) => ({
        filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
        storageKey: a.storageKey,
      })),
    })
    const sendRes = await sendViaProvider({
      from: fromLine,
      to: toResolved.map((r) => formatAddress(r.addr, r.name)),
      cc: ccResolved.length ? ccResolved.map((r) => formatAddress(r.addr, r.name)) : undefined,
      subject, text: body, messageId,
      attachments: resolvedAttachments.map((a) => ({
        filename: a.filename, mimeType: a.mimeType, path: a.publicUrl,
      })),
    })
    const finalStatus = sendRes.ok ? 'sent' : 'failed'
    await pool.query(
      `UPDATE email_messages
          SET transport_status = $1, transport_error = $2,
              smtp_message_id = $3, next_retry_at = $4
        WHERE message_id = $5 AND company_id = $6`,
      [
        finalStatus, sendRes.error, sendRes.smtpMessageId ?? messageId,
        finalStatus === 'failed' ? new Date(Date.now() + 60_000) : null,
        persisted.messageId, tenant,
      ],
    ).catch((error) => {
      // The provider result is already irreversible. Preserve that response
      // so a client does not retry and send a duplicate merely because the
      // local status update had a transient failure.
      console.warn(`[email/send] post-send status update failed for ${persisted.messageId}`, error)
    })
    res.status(sendRes.ok ? 200 : 502).json({
      messageId: persisted.messageId,
      conversationId: conv.conversationId,
      transportStatus: sendRes.ok ? 'sent' : 'failed',
      mock: sendRes.mock,
      error: sendRes.error,
    })
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[email/send] failed', e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

/* GET /email/:messageId/html — lazy-fetched, sanitized HTML body for a
 * single email row. Kept off the /messages JOIN to avoid bloating every
 * thread render with multi-KB HTML bodies that the user may never open.
 * Membership-gated (same rule as /email/reply) so cross-tenant peeks are
 * impossible. The response is `text/html` and goes straight into a
 * sandboxed iframe srcdoc on the client — the sanitizer is defense in
 * depth around that sandbox. */
api.get('/email/:messageId/html', async (req, res) => {
  try {
    const { userId: me, companyId: tenant } = await requireCompany(req)
    const messageId = req.params.messageId
    const { rows } = await pool.query<{
      conversation_id: string; html: string | null; subject: string
    }>(
      `SELECT em.conversation_id, em.html, em.subject
         FROM email_messages em
        WHERE em.message_id = $1 AND em.company_id = $2 LIMIT 1`,
      [messageId, tenant],
    )
    const row = rows[0]
    if (!row) { res.status(404).json({ error: 'unknown email message' }); return }
    if (!row.html) { res.status(204).end(); return }
    const { rows: cv } = await pool.query<{ members: string[] }>(
      `SELECT members FROM conversations WHERE id = $1`, [row.conversation_id],
    )
    if (!cv[0] || !cv[0].members.includes(me)) {
      res.status(403).json({ error: 'not a member of this thread' }); return
    }
    const { sanitizeEmailHtml } = await import('../email.js')
    const safe = sanitizeEmailHtml(row.html)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    // Belt-and-braces: even if the client forgets the sandbox, these
    // headers neuter scripts at the browser level.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(safe)
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[email/html] failed', e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

api.post('/email/reply/:messageId', async (req, res) => {
  try {
    const { userId: me, companyId: tenant } = await requireCompany(req)
    const { messageId: replyTarget } = req.params
    const body = String(req.body?.body ?? '').trim().slice(0, 50_000)
    const ccRaw = Array.isArray(req.body?.cc) ? req.body.cc as unknown[] : []
    const attachRaw = Array.isArray(req.body?.attachments) ? req.body.attachments as unknown[] : []
    if (!body) { res.status(400).json({ error: 'body required' }); return }
    const resolvedAttachments = await resolveHttpAttachments(attachRaw)
    if (resolvedAttachments instanceof Error) {
      res.status(400).json({ error: resolvedAttachments.message }); return
    }

    const { rows: orig } = await pool.query<{
      conversation_id: string
      smtp_message_id: string | null
      references_chain: string[]
      subject: string
      from_addr: string
      to_addrs: string[]
      cc_addrs: string[]
    }>(
      `SELECT conversation_id, smtp_message_id, references_chain,
              subject, from_addr, to_addrs, cc_addrs
         FROM email_messages WHERE message_id = $1 AND company_id = $2`,
      [replyTarget, tenant],
    )
    const o = orig[0]
    if (!o) { res.status(404).json({ error: 'unknown email message' }); return }
    const { rows: cv } = await pool.query<{ members: string[] }>(
      `SELECT members FROM conversations WHERE id = $1`, [o.conversation_id],
    )
    if (!cv[0] || !cv[0].members.includes(me)) {
      res.status(403).json({ error: 'not a member of this thread' }); return
    }

    const {
      formatAddress, sendViaProvider,
      persistEmailMessage, mintMessageId, normalizeMessageId,
      ensureParticipantAddress, sanitizeSubject, splitReplyAddresses,
    } = await import('../email.js')
    // Sender must use a cumora-domain From line (Resend won't accept
    // user's gmail/outlook). Same scheme as agents.
    const sender = await ensureParticipantAddress(me, tenant)
    if (!sender) { res.status(400).json({ error: 'no email address available for your account in this workspace' }); return }
    // Pull the user's auth email too — used to dedupe self out of the
    // reply-to list (the original may have CC'd me at my real address).
    const { rows: ue } = await pool.query<{ email: string | null }>(
      `SELECT email FROM users WHERE id = $1`, [me],
    )
    const userAuthEmail = ue[0]?.email ?? null

    // Reply-all split: TO = original From, CC = original To+Cc minus self.
    // Self is identified by EITHER the cumora address OR the auth email —
    // the original may list me under either (or both, if I CC'd myself
    // externally).
    const selfAddrs = [sender.email.toLowerCase()]
    if (userAuthEmail) selfAddrs.push(userAuthEmail.toLowerCase())
    const { to: replyTo, cc: replyCc } = splitReplyAddresses({
      originalFrom: o.from_addr,
      originalTo: o.to_addrs ?? [],
      originalCc: o.cc_addrs ?? [],
      selfAddresses: selfAddrs,
    })
    if (replyTo.length === 0) { res.status(400).json({ error: 'no other recipients to reply to' }); return }

    const ccResolved: { addr: string; name: string | null }[] = []
    for (const raw of ccRaw) {
      const r = await resolveHttpRecipient(String(raw), { companyId: tenant })
      if (!r) { res.status(400).json({ error: `unresolved cc: ${raw}` }); return }
      ccResolved.push(r)
    }
    // Append user-supplied CCs to the original CC list, de-duping against
    // self and the new TO so the same address never appears twice.
    const ccSeen = new Set<string>([
      ...selfAddrs,
      ...replyTo.map((t) => { const m = /<([^>]+)>/.exec(t); return (m ? m[1] : t).toLowerCase() }),
      ...replyCc.map((c) => { const m = /<([^>]+)>/.exec(c); return (m ? m[1] : c).toLowerCase() }),
    ])
    const ccCombined = [...replyCc]
    for (const r of ccResolved) {
      if (ccSeen.has(r.addr)) continue
      ccSeen.add(r.addr)
      ccCombined.push(formatAddress(r.addr, r.name))
    }

    const subject = /^(re|fwd|fw)\s*:/i.test(o.subject) ? sanitizeSubject(o.subject) : sanitizeSubject(`Re: ${o.subject}`)
    const newReferences = [...(o.references_chain ?? []), ...(o.smtp_message_id ? [o.smtp_message_id] : [])]
      .filter((x): x is string => Boolean(x))
    const inReplyTo = o.smtp_message_id ? normalizeMessageId(o.smtp_message_id) : null
    const messageId = mintMessageId()
    const fromLine = formatAddress(sender.email, sender.displayName)
    // WRITE-FIRST: this transaction is the final authorization boundary.
    // A participant removed while this request is in flight cannot reach the
    // external mail provider with stale conversation access.
    const persisted = await persistEmailMessage({
      conversationId: o.conversation_id,
      companyId: tenant,
      authorId: me,
      direction: 'out',
      transportStatus: 'sending',
      transportError: null,
      smtpMessageId: messageId,
      inReplyTo, references: newReferences,
      subject, fromAddr: fromLine,
      toAddrs: replyTo, ccAddrs: ccCombined,
      body,
      attachments: resolvedAttachments.map((a) => ({
        filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
        storageKey: a.storageKey,
      })),
    })
    const sendRes = await sendViaProvider({
      from: fromLine, to: replyTo,
      cc: ccCombined.length ? ccCombined : undefined,
      subject, text: body,
      inReplyTo: inReplyTo ?? undefined,
      references: newReferences,
      messageId,
      attachments: resolvedAttachments.map((a) => ({
        filename: a.filename, mimeType: a.mimeType, path: a.publicUrl,
      })),
    })
    const finalStatus = sendRes.ok ? 'sent' : 'failed'
    await pool.query(
      `UPDATE email_messages
          SET transport_status = $1, transport_error = $2,
              smtp_message_id = $3, next_retry_at = $4
        WHERE message_id = $5 AND company_id = $6`,
      [
        finalStatus, sendRes.error, sendRes.smtpMessageId ?? messageId,
        finalStatus === 'failed' ? new Date(Date.now() + 60_000) : null,
        persisted.messageId, tenant,
      ],
    ).catch((error) => {
      console.warn(`[email/reply] post-send status update failed for ${persisted.messageId}`, error)
    })
    // Auto-ack — replying definitionally means I read the original.
    await pool.query(
      `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
      [me, o.conversation_id],
    )
    res.status(sendRes.ok ? 200 : 502).json({
      messageId: persisted.messageId,
      conversationId: o.conversation_id,
      transportStatus: sendRes.ok ? 'sent' : 'failed',
      mock: sendRes.mock,
      error: sendRes.error,
    })
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[email/reply] failed', e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

/** Thread fetch: every message in `id` whose quoted_message_id == rootId.
 *  Used by the reply drawer / thread sidebar. Returns the SAME shape as
 *  GET /conversations/:id/messages so the renderer can reuse its bubble
 *  component. Direct children only — we don't recurse, mirroring how
 *  Telegram / Slack present a single flat thread under one root. */
api.get('/conversations/:id/messages/:rootId/replies', async (req, res) => {
  const { id, rootId } = req.params
  try {
    // Same membership rule as the parent /messages handler — replies live in
    // the same thread, so the same access bar applies.
    const { companyId: tenant } = await requireConversationMember(req, id)
    const { rows } = await pool.query(
      `SELECT
          m.id, m.conversation_id AS "conversationId",
          m.author_id AS "authorId", m.kind, m.body, m.sequence,
          m.tool, m.attachment, m.poll,
          -- Per-option vote tallies for polls. Empty array for non-poll
          -- rows. voterIds is sorted so the client can diff cheaply across
          -- successive WS poll.updated events.
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'optionId', pv.option_id,
              'count', pv.cnt,
              'voterIds', pv.voter_ids
            ) ORDER BY pv.cnt DESC, pv.option_id ASC)
              FROM (
                SELECT option_id,
                       COUNT(*)::int AS cnt,
                       array_agg(voter_participant_id ORDER BY voter_participant_id) AS voter_ids
                  FROM poll_votes
                 WHERE message_id = m.id
                 GROUP BY option_id
              ) pv
          ), '[]'::jsonb) AS "pollTallies",
          m.quoted_message_id AS "quotedMessageId",
          m.created_at AS "createdAt",
          -- mine is derived on the renderer from users; see the main
          -- /messages handler for the rationale.
          COALESCE(
            (
              SELECT jsonb_agg(jsonb_build_object(
                'emoji', emoji,
                'count', count,
                'users', users
              ))
              FROM (
                SELECT
                  emoji,
                  COUNT(*)::int AS count,
                  array_agg(user_id ORDER BY user_id) AS users
                FROM message_reactions
                WHERE message_id = m.id
                GROUP BY emoji
                ORDER BY count DESC, emoji ASC
              ) r
            ),
            '[]'::jsonb
          ) AS "reactions",
          (
            SELECT jsonb_build_object(
              'id', qm.id,
              'authorId', qm.author_id,
              'authorName', COALESCE(qp.name, qm.author_id),
              'kind', qm.kind,
              'body', LEFT(qm.body, 240),
              'sequence', qm.sequence
            )
              FROM messages qm
              LEFT JOIN participants qp ON qp.id = qm.author_id AND qp.company_id = $3
             WHERE qm.id = m.quoted_message_id
               AND qm.conversation_id = m.conversation_id
          ) AS "quoted"
        FROM messages m
        WHERE m.conversation_id = $1
          AND m.quoted_message_id = $2
        ORDER BY m.sequence ASC`,
      [id, rootId, tenant],
    )
    for (const row of rows) {
      if (!row.attachment) continue
      try { row.attachment = await freshenAttachmentUrl(row.attachment) }
      catch (e) {
        console.warn(
          `[replies] freshenAttachmentUrl failed for message ${row.id}; ` +
          `falling back to stored URL`, e,
        )
      }
    }
    res.json(rows)
  } catch (e) {
    // Don't bury HttpError under 500 — those carry real status codes
    // (401/403/404 from the auth helpers) the client needs to branch on.
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error(`[replies] GET /conversations/${id}/messages/${rootId}/replies failed`, e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

/* ============== Reactions ============== */

api.post('/messages/:id/reactions', async (req, res) => {
  const { id } = req.params
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const emoji = String(req.body?.emoji ?? '').trim()
  if (!emoji) { res.status(400).json({ error: 'emoji required' }); return }

  const { rows: cv } = await pool.query<{ conversation_id: string }>(
    `SELECT m.conversation_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.company_id = $2 LIMIT 1`,
    [id, tenant],
  )
  if (!cv[0]) { res.status(404).json({ error: 'message not found' }); return }
  const conversationId = cv[0].conversation_id
  const mutation = await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId,
    work: async (client) => {
      const { rows: message } = await client.query<{ author_id: string }>(
        `SELECT author_id FROM messages
          WHERE id = $1 AND conversation_id = $2 AND company_id = $3`,
        [id, conversationId, tenant],
      )
      if (!message[0]) throw new HttpError(404, 'message not found')
      const existing = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM message_reactions
          WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [id, me, emoji],
      )
      const wasRemoval = Number(existing.rows[0]?.count ?? '0') > 0
      if (wasRemoval) {
        await client.query(
          `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
          [id, me, emoji],
        )
      } else {
        await client.query(
          `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [id, me, emoji],
        )
      }
      const { rows: reactions } = await client.query<{ emoji: string; count: number; users: string[] }>(
        `SELECT emoji,
                COUNT(*)::int AS count,
                array_agg(user_id ORDER BY user_id) AS users
           FROM message_reactions WHERE message_id = $1
           GROUP BY emoji ORDER BY count DESC, emoji ASC`,
        [id],
      )
      await enqueueBroadcast(client, CH_REACTIONS, {
        type: 'message.reactions',
        conversationId,
        companyId: tenant,
        messageId: id,
        reactions,
      })
      return { wasRemoval, messageAuthorId: message[0].author_id, reactions }
    },
  })

  // Climate signal: a new reaction TO an agent's message bumps that
  // agent's affinity toward the reactor (they feel valued). Un-reacting
  // doesn't dock — the "I didn't mean it" path shouldn't be punitive.
  if (!mutation.wasRemoval) {
    const { bumpClimate } = await import('../agents/climate.js')
    void bumpClimate({
      agentId: mutation.messageAuthorId, aboutId: me,
      affinity: 0.05, trust: 0.02,
      note: `received ${emoji} from ${me}`,
    })
  }

  res.json({ reactions: mutation.reactions })
})

/* ============== Peek (agent-only conversations) ==============
 *
 * Backs the frontend's "Whispers" tab — a read-only window into
 * conversations where every participant is an agent. Covers both 1-on-1
 * direct chats AND multi-agent groups that an agent has pulled. The
 * user is NOT a member, so these don't show up under /conversations
 * and don't count toward unread — but the frontend lets them
 * eavesdrop.
 *
 * Selection rule: any conversation in the company where every member is
 * an agent (no humans). Messages live in the unified `messages` table.
 */

/**
 * Universal search across the workspace.
 *
 * Returns four ranked buckets in this order of importance:
 *  1. `participants` — agents + humans (matched on name/role/id)
 *  2. `rooms`        — direct chats + whispers (1-on-1 by title or member name)
 *  3. `groups`       — group chats (by title)
 *  4. `messages`     — text-message body matches, newest first, with a snippet
 *
 * Frontend is responsible for grouping/labeling — server just hands back the
 * shape. Per-bucket LIMITs keep payload bounded; refine with a longer query
 * if you don't see what you want.
 *
 * Scoping: requireCompany() pins to the active company. Conversation/message
 * results additionally filter on `members @> [userId]` so we never leak
 * rooms the caller isn't actually in (same guard `/conversations` uses).
 */
api.get('/search', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const raw = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (!raw) {
    res.json({ participants: [], rooms: [], groups: [], messages: [] })
    return
  }
  if (raw.length > 200) throw new HttpError(400, 'query too long (max 200 chars)')

  // Escape LIKE metacharacters in the user's query so a literal "%" doesn't
  // wildcard the whole table. `\` is the default escape; we add it back
  // before any `%`/`_`/`\` in the needle.
  const esc = raw.replace(/[\\%_]/g, (m) => '\\' + m)
  const contains = `%${esc}%`
  const exact = esc
  const prefix = `${esc}%`

  // Bucket LIMITs — small enough that the dropdown stays scannable, large
  // enough that "the obvious match" is rarely off-screen.
  const P_LIMIT = 8
  const R_LIMIT = 8
  const G_LIMIT = 8
  const M_LIMIT = 15

  const participantsP = pool.query(
    `SELECT id, kind, name, role, initial, avatar_bg AS "avatarBg", avatar_url AS "avatarUrl",
            status, bio
       FROM participants
      WHERE company_id = $1
        AND departed_at IS NULL
        AND (name ILIKE $2 ESCAPE '\\' OR role ILIKE $2 ESCAPE '\\' OR id ILIKE $2 ESCAPE '\\')
      ORDER BY
        CASE WHEN lower(name) = lower($3) THEN 0
             WHEN name ILIKE $4 ESCAPE '\\' THEN 1
             ELSE 2 END,
        -- Agents before humans within the same tier — they're typically what
        -- the user is hunting for in this product.
        CASE kind WHEN 'agent' THEN 0 ELSE 1 END,
        name
      LIMIT ${P_LIMIT}`,
    [tenant, contains, exact, prefix],
  )

  // 1-on-1 rooms (direct + whisper): direct titles are perspective-specific,
  // so compute the display title from the member that is not the caller.
  // Match on that display title OR on the other participant's name.
  const roomsP = pool.query(
    `WITH my_rooms AS (
       SELECT c.id, c.kind,
              CASE
                WHEN c.kind = 'direct' THEN COALESCE(other_participant.name, c.title)
                ELSE c.title
              END AS title,
              c.members,
              p.name AS "projectName", c.updated_at
         FROM conversations c
         LEFT JOIN projects p ON p.id = c.project_id
         LEFT JOIN LATERAL (
           SELECT p_other.name
             FROM jsonb_array_elements_text(c.members) WITH ORDINALITY AS member(id, ord)
             JOIN participants p_other
               ON p_other.id = member.id
              AND p_other.company_id = c.company_id
            WHERE member.id <> $2
            ORDER BY member.ord
            LIMIT 1
         ) other_participant ON c.kind = 'direct'
        WHERE c.company_id = $1
          AND c.kind IN ('direct', 'whisper')
          AND c.members @> to_jsonb(ARRAY[$2::text])
     )
     SELECT r.id, r.kind, r.title, r.members, r."projectName"
       FROM my_rooms r
      WHERE r.title ILIKE $3 ESCAPE '\\'
         OR EXISTS (
              SELECT 1 FROM participants p
               WHERE p.company_id = $1
                 AND p.name ILIKE $3 ESCAPE '\\'
                 AND p.id <> $2
                 AND r.members @> to_jsonb(ARRAY[p.id::text])
            )
      ORDER BY
        CASE WHEN lower(r.title) = lower($4) THEN 0
             WHEN r.title ILIKE $5 ESCAPE '\\' THEN 1
             ELSE 2 END,
        r.updated_at DESC
      LIMIT ${R_LIMIT}`,
    [tenant, me, contains, exact, prefix],
  )

  const groupsP = pool.query(
    `SELECT c.id, c.kind, c.title, c.members, p.name AS "projectName"
       FROM conversations c
       LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.company_id = $1
        AND c.kind = 'group'
        AND c.members @> to_jsonb(ARRAY[$2::text])
        AND (c.title ILIKE $3 ESCAPE '\\' OR (c.topic IS NOT NULL AND c.topic ILIKE $3 ESCAPE '\\'))
      ORDER BY
        CASE WHEN lower(c.title) = lower($4) THEN 0
             WHEN c.title ILIKE $5 ESCAPE '\\' THEN 1
             ELSE 2 END,
        c.updated_at DESC
      LIMIT ${G_LIMIT}`,
    [tenant, me, contains, exact, prefix],
  )

  // Skip `tool` / `system` rows — those bodies are machine output, not
  // human-written content, and they'd flood the list with JSON snippets.
  const messagesP = pool.query(
    `SELECT m.id,
            m.conversation_id AS "conversationId",
            CASE
              WHEN c.kind = 'direct' THEN COALESCE(other_participant.name, c.title)
              ELSE c.title
            END               AS "conversationTitle",
            c.kind            AS "conversationKind",
            m.author_id       AS "authorId",
            p.name            AS "authorName",
            m.body,
            m.created_at      AS "createdAt"
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN participants p
         ON p.id = m.author_id AND p.company_id = c.company_id
       LEFT JOIN LATERAL (
         SELECT p_other.name
           FROM jsonb_array_elements_text(c.members) WITH ORDINALITY AS member(id, ord)
           JOIN participants p_other
             ON p_other.id = member.id
            AND p_other.company_id = c.company_id
          WHERE member.id <> $2
          ORDER BY member.ord
          LIMIT 1
       ) other_participant ON c.kind = 'direct'
      WHERE c.company_id = $1
        AND c.members @> to_jsonb(ARRAY[$2::text])
        AND m.kind = 'text'
        AND m.body ILIKE $3 ESCAPE '\\'
      ORDER BY m.created_at DESC
      LIMIT ${M_LIMIT}`,
    [tenant, me, contains],
  )

  const [participants, rooms, groups, messages] = await Promise.all([
    participantsP, roomsP, groupsP, messagesP,
  ])

  // Server-side snippet so the client doesn't ship full message bodies in
  // search results. We pick a ±60-char window around the first match.
  const needle = raw.toLowerCase()
  const SNIPPET_BEFORE = 40
  const SNIPPET_AFTER = 80
  const snippetOf = (body: string): string => {
    const idx = body.toLowerCase().indexOf(needle)
    if (idx < 0) return body.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER)
    const start = Math.max(0, idx - SNIPPET_BEFORE)
    const end = Math.min(body.length, idx + needle.length + SNIPPET_AFTER)
    return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
  }

  res.json({
    participants: participants.rows,
    rooms: rooms.rows,
    groups: groups.rows,
    messages: messages.rows.map((m: { body: string } & Record<string, unknown>) => ({
      ...m,
      body: undefined,
      snippet: snippetOf(m.body ?? ''),
    })),
  })
})

api.get('/peek/agent-chats', async (req, res) => {
  // Owner-only: the whisper observer view exposes every agent-to-agent
  // conversation in the workspace, so it's gated to the company owner (not
  // admins, not regular members). requireCompanyRole throws 403 otherwise.
  const { companyId: tenant } = await requireCompanyRole(req, OWNER_ONLY)
  const { rows } = await pool.query(
    `SELECT c.id,
            c.kind,
            c.title,
            c.members,
            (c.members->>0) AS "agentA",
            (c.members->>1) AS "agentB",
            c.topic AS about,
            c.created_at AS "createdAt",
            c.updated_at AS "updatedAt",
            (SELECT COUNT(*)::int FROM messages WHERE conversation_id = c.id) AS "msgCount"
       FROM conversations c
       WHERE c.company_id = $1
         AND jsonb_array_length(c.members) >= 2
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(c.members) m
             LEFT JOIN participants p ON p.id = m AND p.company_id = c.company_id
            WHERE p.kind IS DISTINCT FROM 'agent'
         )
       ORDER BY c.updated_at DESC
       LIMIT 50`,
    [tenant],
  )
  res.json(rows)
})

api.get('/peek/agent-chats/:id/messages', async (req, res) => {
  // Owner-only, same as the list endpoint above.
  const { companyId: tenant } = await requireCompanyRole(req, OWNER_ONLY)
  const { id } = req.params
  // Peek deliberately bypasses the "must be a member" rule — the whole
  // point is to let humans eavesdrop on agent-only rooms. BUT we must verify
  // the conversation IS fully agent-only, otherwise this endpoint becomes a
  // backdoor that reads any conversation in the tenant (private DMs etc.).
  // Same predicate as /peek/agent-chats: every member must be a participant
  // of kind='agent' in this company.
  const { rows: w } = await pool.query<{ ok: boolean }>(
    `SELECT (
        jsonb_array_length(c.members) >= 1
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(c.members) m
            LEFT JOIN participants p ON p.id = m AND p.company_id = c.company_id
           WHERE p.kind IS DISTINCT FROM 'agent'
        )
     ) AS ok
       FROM conversations c
      WHERE c.id = $1 AND c.company_id = $2
      LIMIT 1`,
    [id, tenant],
  )
  if (!w[0] || !w[0].ok) { res.status(404).json({ error: 'not found' }); return }
  const { rows } = await pool.query(
    `SELECT id, conversation_id AS "conversationId", author_id AS "authorId",
            kind, body, sequence, tool, created_at AS "createdAt"
       FROM messages
       WHERE conversation_id = $1
       ORDER BY sequence ASC`,
    [id],
  )
  res.json(rows)
})

/* ============== Convene ============== */

api.post('/conversations/:id/convene', async (req, res) => {
  const { id } = req.params
  // Convene starts a live session ON a conversation — only members get to
  // initiate. Without membership-gating, a peer could spin up convene
  // sessions on private DMs, both leaking the topic and triggering agent
  // activity in rooms they don't belong to.
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const topic = String(req.body?.topic ?? 'live work session')
  const session = await startConvene({ conversationId: id, companyId: tenant, startedBy: me, topic })
  res.json(session)
})

api.get('/conversations/:id/convene', async (req, res) => {
  const { userId, companyId } = await requireCompany(req)
  const session = await withLockedConversationMember({
    userId,
    companyId,
    conversationId: req.params.id,
    work: async (client) => {
      const { rows } = await client.query(
        `SELECT id, conversation_id, title, flair, started_by, started_at, ended_at, state
           FROM convene_sessions
          WHERE conversation_id = $1 AND company_id = $2 AND state = 'live'
          ORDER BY started_at DESC LIMIT 1`,
        [req.params.id, companyId],
      )
      return rows[0] ?? null
    },
  })
  res.json(session)
})

api.get('/convene/:sessionId/transcript', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { rows: scope } = await pool.query<{ conversation_id: string }>(
    `SELECT s.conversation_id
       FROM convene_sessions s
       JOIN conversations c ON c.id = s.conversation_id
      WHERE s.id = $1 AND c.company_id = $2 LIMIT 1`,
    [req.params.sessionId, tenant],
  )
  if (!scope[0]) throw new HttpError(404, 'not found')
  const rows = await withLockedConversationMember({
    userId: me,
    companyId: tenant,
    conversationId: scope[0].conversation_id,
    work: async (client) => {
      const currentSession = await client.query(
        `SELECT 1 FROM convene_sessions
          WHERE id = $1 AND conversation_id = $2 AND company_id = $3`,
        [req.params.sessionId, scope[0].conversation_id, tenant],
      )
      if (!currentSession.rowCount) throw new HttpError(404, 'not found')
      const transcript = await client.query(
        `SELECT id, session_id AS "sessionId", author_id AS "authorId", kind, body, sequence,
                decision, created_at AS "createdAt"
           FROM convene_transcript
          WHERE session_id = $1 AND company_id = $2
          ORDER BY sequence ASC`,
        [req.params.sessionId, tenant],
      )
      return transcript.rows
    },
  })
  res.json(rows)
})

/* ============== Developer tools ============== */

api.get('/devtools/capabilities', safe(async (req, res) => {
  const state = await getDevtoolsState(req)
  res.json({
    enabled: state.enabled,
    canEnable: state.canEnable,
    localDev: state.localDev,
    productionDevMode: !state.localDev && state.requested && state.enabled,
    role: state.role,
  })
}))

api.get('/devtools/agent-workspace', safe(async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const agentId = String(req.query.agentId ?? '').trim()
  if (!agentId) throw new HttpError(400, 'agentId required')
  const { rows: agent } = await pool.query(
    `SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'agent' LIMIT 1`,
    [agentId, tenant],
  )
  if (!agent[0]) throw new HttpError(404, 'agent not found')
  const { rows } = await pool.query(
    `SELECT
        path,
        LENGTH(body)::int AS size,
        (LENGTH(body) - LENGTH(REPLACE(body, E'\n', '')) + 1)::int AS "lineCount",
        updated_at AS "updatedAt"
       FROM agent_workspace
      WHERE agent_id = $1 AND company_id = $2
      ORDER BY path ASC`,
    [agentId, tenant],
  )
  res.json(rows)
}))

api.get('/devtools/agent-workspace/file', safe(async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const agentId = String(req.query.agentId ?? '').trim()
  const path = String(req.query.path ?? '').trim()
  if (!agentId || !path) throw new HttpError(400, 'agentId and path required')
  const { rows } = await pool.query(
    `SELECT
        path,
        body,
        LENGTH(body)::int AS size,
        (LENGTH(body) - LENGTH(REPLACE(body, E'\n', '')) + 1)::int AS "lineCount",
        updated_at AS "updatedAt"
       FROM agent_workspace
      WHERE agent_id = $1 AND path = $2 AND company_id = $3
      LIMIT 1`,
    [agentId, path, tenant],
  )
  if (!rows[0]) throw new HttpError(404, 'file not found')
  res.json(rows[0])
}))

/* ============== Agent observability ============== */

const AGENT_RUN_STATUSES = new Set(['running', 'completed', 'failed', 'skipped', 'stalled'])

/** Window after which a `running` row is rendered as `stalled` in the UI.
 *  Postgres INTERVAL literal so we can inject it straight into the SQL.
 *
 *  Sizing rationale: `agent_runs.updated_at` only bumps when the agent
 *  emits an observability event (tool start / end, message send, etc.).
 *  A single tool call — `yt-dlp` downloading a long video, `ffmpeg`
 *  transcoding, `opencli browser` rendering a JS-heavy page, a slow
 *  LLM stream on a rate-limited account — can legitimately run for
 *  several minutes between events. The earlier 90-second window was
 *  flagging healthy long-running calls as stalled.
 *
 *  5 minutes gives the UI an honest "this is taking unusually long"
 *  signal while still firing well before the 10-minute stale-run
 *  reaper (`markStaleAgentRuns`, agents/observability.ts) flips the
 *  row to `failed`. */
const STALLED_INTERVAL = `5 minutes`

api.get('/agents/observability/runs', async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const clauses = ['r.company_id = $1']
  const params: unknown[] = [tenant]

  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : ''
  if (agentId) {
    params.push(agentId)
    clauses.push(`r.agent_id = $${params.length}`)
  }

  const status = typeof req.query.status === 'string' ? req.query.status.trim() : ''
  if (status && AGENT_RUN_STATUSES.has(status)) {
    if (status === 'stalled') {
      clauses.push(`r.status = 'running' AND r.updated_at < NOW() - INTERVAL '${STALLED_INTERVAL}'`)
    } else if (status === 'running') {
      clauses.push(`r.status = 'running' AND r.updated_at >= NOW() - INTERVAL '${STALLED_INTERVAL}'`)
    } else {
      params.push(status)
      clauses.push(`r.status = $${params.length}`)
    }
  }

  const rawLimit = Number(req.query.limit ?? 50)
  const limit = Math.max(10, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 50))
  params.push(limit)

  const { rows } = await pool.query(
    `SELECT
        r.id,
        r.agent_id AS "agentId",
        COALESCE(p.name, r.agent_id) AS "agentName",
        p.role AS "agentRole",
        p.avatar_url AS "agentAvatarUrl",
        r.company_id AS "companyId",
        CASE
          WHEN r.status = 'running' AND r.updated_at < NOW() - INTERVAL '${STALLED_INTERVAL}' THEN 'stalled'
          ELSE r.status
        END AS status,
        r.stage,
        r.summary,
        r.error,
        r.trigger,
        r.input_message_ids AS "inputMessageIds",
        r.inbox_count AS "inboxCount",
        r.tool_call_count AS "toolCallCount",
        r.token_count AS "tokenCount",
        r.fingerprint,
        r.started_at AS "startedAt",
        r.updated_at AS "updatedAt",
        r.finished_at AS "finishedAt",
        ROUND(EXTRACT(EPOCH FROM (COALESCE(r.finished_at, NOW()) - r.started_at)) * 1000)::int AS "durationMs"
       FROM agent_runs r
       LEFT JOIN participants p ON p.id = r.agent_id AND p.company_id = r.company_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY r.started_at DESC
      LIMIT $${params.length}`,
    params,
  )
  res.json(rows)
})

api.get('/agents/observability/runs/:id/events', async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const { rows: gate } = await pool.query(
    `SELECT 1 FROM agent_runs WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [req.params.id, tenant],
  )
  if (!gate[0]) { res.status(404).json({ error: 'not found' }); return }

  const { rows } = await pool.query(
    `SELECT
        id,
        run_id AS "runId",
        agent_id AS "agentId",
        kind,
        level,
        title,
        data,
        created_at AS "createdAt"
       FROM agent_events
      WHERE run_id = $1 AND company_id = $2
      ORDER BY created_at ASC, id ASC`,
    [req.params.id, tenant],
  )
  res.json(rows)
})

// Triage cost-effectiveness ledger: is the small-brain gate actually saving money
// (vs the cache-warm big-brain turns it shields)? Cache-aware, $ + tokens.
api.get('/agents/observability/triage', async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const agentId = typeof req.query.agentId === 'string' && req.query.agentId.trim() ? req.query.agentId.trim() : null
  const rawHours = Number(req.query.sinceHours ?? 24)
  const sinceHours = Math.max(1, Math.min(720, Number.isFinite(rawHours) ? rawHours : 24))
  res.json(await getTriageEconomics({ companyId: tenant, agentId, sinceHours }))
})

// How often does a wake produce nothing? A group message wakes every member and
// most conclude it was not theirs — after the big brain has already been paid.
// Split group vs direct, because a DM legitimately answers far more often and
// averaging the two hides the number that matters.
api.get('/agents/observability/wakes', async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const agentId = typeof req.query.agentId === 'string' && req.query.agentId.trim() ? req.query.agentId.trim() : null
  const rawHours = Number(req.query.sinceHours ?? 24)
  const sinceHours = Math.max(1, Math.min(720, Number.isFinite(rawHours) ? rawHours : 24))
  res.json(await getWakeEconomics({ companyId: tenant, agentId, sinceHours }))
})

// Universal LLM-spend ledger rollup by purpose × model × source. Answers the
// question "which business logic burned the most sub2api tokens?" — bucketed
// per purpose so the operator can target optimization at the actual hot spot
// (e.g. inbox-triage vs compaction vs convene-decision) instead of guessing.
api.get('/agents/observability/llm-spend', async (req, res) => {
  const { companyId: tenant } = await requireDevtools(req)
  const rawDays = Number(req.query.sinceDays ?? 30)
  const sinceDays = Math.max(1, Math.min(365, Number.isFinite(rawDays) ? rawDays : 30))
  const modelFilter = typeof req.query.model === 'string' && req.query.model.trim() ? req.query.model.trim() : null
  // Use lazy import to avoid pulling the ledger into every router boot path.
  const { getLlmSpendRollup } = await import('../agents/llm-ledger.js')
  res.json(await getLlmSpendRollup({ companyId: tenant, sinceDays, model: modelFilter }))
})

/* ============== Preferences + autonomy ============== */

api.get('/me/preferences', async (req, res) => {
  const me = userId(req)
  const { rows } = await pool.query<{ prefs: Record<string, unknown> }>(
    `SELECT prefs FROM user_preferences WHERE user_id = $1`,
    [me],
  )
  res.json(rows[0]?.prefs ?? {})
})

api.put('/me/preferences', async (req, res) => {
  const me = userId(req)
  const prefs = req.body ?? {}
  await pool.query(
    `INSERT INTO user_preferences (user_id, prefs, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE
        SET prefs = EXCLUDED.prefs, updated_at = NOW()`,
    [me, JSON.stringify(prefs)],
  )
  res.json({ ok: true })
})

api.get('/agents/:id/autonomy', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { rows: gate } = await pool.query(
    `SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [req.params.id, tenant],
  )
  if (!gate[0]) { res.status(404).json({ error: 'not found' }); return }
  const { rows } = await pool.query(
    `SELECT user_id AS "userId", agent_id AS "agentId", threshold, pulled, led, dissolved
       FROM agent_autonomy WHERE user_id = $1 AND agent_id = $2`,
    [me, req.params.id],
  )
  res.json(rows[0] ?? { userId: me, agentId: req.params.id, threshold: 0.6, pulled: 0, led: 0, dissolved: 0 })
})

api.put('/agents/:id/autonomy', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { rows: gate } = await pool.query(
    `SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [req.params.id, tenant],
  )
  if (!gate[0]) { res.status(404).json({ error: 'not found' }); return }
  const threshold = Math.max(0, Math.min(1, Number(req.body?.threshold ?? 0.6)))
  await pool.query(
    `INSERT INTO agent_autonomy (user_id, agent_id, threshold)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, agent_id) DO UPDATE SET threshold = EXCLUDED.threshold`,
    [me, req.params.id, threshold],
  )
  res.json({ ok: true, threshold })
})

api.get('/agents/autonomy', async (req, res) => {
  const { userId: me, companyId: tenant } = await requireCompany(req)
  const { rows } = await pool.query(
    `SELECT a.user_id AS "userId", a.agent_id AS "agentId",
            a.threshold, a.pulled, a.led, a.dissolved
       FROM agent_autonomy a
       JOIN participants p ON p.id = a.agent_id
      WHERE a.user_id = $1 AND p.company_id = $2`,
    [me, tenant],
  )
  res.json(rows)
})

/* ============== Kanban boards ==============
 *
 * AI-native: every endpoint here is just as useful from the desktop
 * client as it is from an agent's `cumora board` / `cumora card` CLI
 * subcommand. Auth + tenant scoping is the same shape as the rest of
 * this file — `requireCompany(req)` gates the caller into a single
 * workspace, and every row already carries `company_id` (boards) or is
 * reachable only through one (columns/cards/comments).
 *
 * Mentions: `@<participant_id>` or `@<display name>` tokens in card
 * title/description and comment bodies are parsed at write-time. The
 * deduped id list is stored on the row + echoed onto the broadcast event
 * so toasters can chime for the named recipients without re-parsing prose.
 * Both human ids and agent ids resolve identically — first-class for both.
 */

type MentionTarget = { id: string; name: string }

function mentionStartBoundary(text: string, index: number): boolean {
  if (index <= 0) return true
  return !/[\w@]/.test(text[index - 1])
}

function mentionEndBoundary(text: string, index: number): boolean {
  const next = text[index]
  return !next || !/[a-z0-9_-]/i.test(next)
}

function parseMentionTargets(text: string, targets: MentionTarget[]): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const candidates = targets
    .flatMap((p) => [
      { id: p.id, token: p.id },
      { id: p.id, token: p.name.trim() },
    ])
    .filter((candidate) => candidate.token.length > 0)
    .sort((a, b) => b.token.length - a.token.length)
  const lower = text.toLowerCase()

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || !mentionStartBoundary(text, i)) continue
    const rest = lower.slice(i + 1)
    const match = candidates.find((candidate) =>
      rest.startsWith(candidate.token.toLowerCase()) &&
      mentionEndBoundary(text, i + 1 + candidate.token.length)
    )
    const fallback = match ? null : /^@([a-z0-9][a-z0-9_-]{0,63})/i.exec(text.slice(i))
    const id = match?.id ?? fallback?.[1]?.toLowerCase()
    if (!id) continue
    if (id === 'all') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    i += (match ? match.token.length : fallback![0].length - 1)
  }
  return out
}

/** Extract mention ids from prose. Display-name mentions are resolved against
 *  active participants in the current company so the stored payload remains
 *  stable even though users see friendly names in the editor. */
async function parseMentions(companyId: string, text: string): Promise<string[]> {
  const { rows } = await pool.query<MentionTarget>(
    `SELECT id, name
       FROM participants
      WHERE company_id = $1
        AND departed_at IS NULL`,
    [companyId],
  )
  return parseMentionTargets(text, rows)
}

/** Resolve a board id → companyId after verifying the caller is in that
 *  company. Throws 404 if the board doesn't exist OR lives in another
 *  tenant — kept opaque so a probing client can't enumerate cross-tenant
 *  board ids. */
async function requireBoardAccess(req: Request & AuthedRequest, boardId: string): Promise<{ userId: string; companyId: string }> {
  const { userId, companyId } = await requireCompany(req)
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`,
    [boardId],
  )
  if (!rows[0] || rows[0].company_id !== companyId) throw new HttpError(404, 'not found')
  return { userId, companyId }
}

async function enqueueBoardEvent(db: PoolClient, args: {
  companyId: string
  kind: import('../redis.js').BoardEvent['kind']
  boardId: string
  cardId?: string
  columnId?: string
  commentId?: string
  mentions?: string[]
  actorId?: string
}): Promise<void> {
  await enqueueBroadcast(db, CH_BOARDS, {
    type: 'board.changed',
    companyId: args.companyId,
    kind: args.kind,
    boardId: args.boardId,
    cardId: args.cardId,
    columnId: args.columnId,
    commentId: args.commentId,
    mentions: args.mentions,
    actorId: args.actorId,
  })
}

/** GET /boards — list every board in the active workspace. */
api.get('/boards', async (req, res) => {
  const { companyId } = await requireCompany(req)
  const { rows } = await pool.query<{
    id: string; title: string; description: string | null
    created_by: string; created_at: string; updated_at: string
  }>(
    `SELECT id, title, description, created_by, created_at, updated_at
       FROM boards WHERE company_id = $1 ORDER BY updated_at DESC`,
    [companyId],
  )
  res.json(rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })))
})

/** GET /cards/:id — resolve a card id back to its board + column. Agents
 *  often mention the card they just created, and the chat renderer needs
 *  this lookup to open the right board peek without forcing agents to also
 *  spell out the board id in prose. */
api.get('/cards/:id', async (req, res) => {
  const { companyId } = await requireCompany(req)
  const cardId = req.params.id
  const { rows } = await pool.query<{
    id: string
    board_id: string
    column_id: string
    title: string
    description: string | null
    position: number
    assignee_id: string | null
    mentions: string[]
    created_by: string
    created_at: string
    updated_at: string
    board_title: string
    board_description: string | null
    board_created_by: string
    board_created_at: string
    board_updated_at: string
    column_title: string
    column_position: number
    column_created_at: string
    comment_count: number
  }>(
    `SELECT c.id, c.board_id, c.column_id, c.title, c.description, c.position,
            c.assignee_id, c.mentions, c.created_by, c.created_at, c.updated_at,
            b.title AS board_title, b.description AS board_description,
            b.created_by AS board_created_by, b.created_at AS board_created_at,
            b.updated_at AS board_updated_at,
            col.title AS column_title, col.position AS column_position,
            col.created_at AS column_created_at,
            (SELECT COUNT(*)::int FROM board_card_comments cc WHERE cc.card_id = c.id) AS comment_count
       FROM board_cards c
       JOIN boards b ON b.id = c.board_id
       JOIN board_columns col ON col.id = c.column_id
      WHERE c.id = $1 AND b.company_id = $2
      LIMIT 1`,
    [cardId, companyId],
  )
  const r = rows[0]
  if (!r) throw new HttpError(404, 'not found')
  res.json({
    board: {
      id: r.board_id,
      title: r.board_title,
      description: r.board_description,
      createdBy: r.board_created_by,
      createdAt: r.board_created_at,
      updatedAt: r.board_updated_at,
    },
    column: {
      id: r.column_id,
      title: r.column_title,
      position: Number(r.column_position),
      createdAt: r.column_created_at,
    },
    card: {
      id: r.id,
      boardId: r.board_id,
      columnId: r.column_id,
      title: r.title,
      description: r.description,
      position: Number(r.position),
      assigneeId: r.assignee_id,
      mentions: Array.isArray(r.mentions) ? r.mentions : [],
      commentCount: r.comment_count,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  })
})

/** POST /boards — create a board. Auto-seeds the conventional "Todo /
 *  Doing / Done" columns so the new board is immediately usable. */
api.post('/boards', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const title = String(req.body?.title ?? '').trim().slice(0, 200)
  const description = String(req.body?.description ?? '').trim().slice(0, 4000) || null
  if (!title) throw new HttpError(400, 'title required')
  const requestId = createRequestId(req.body?.requestId)
  const hash = requestHash({ title, description })
  const created = await withOutboxTransaction(async (client) => {
    const replay = await createReplay(client, {
      domain: 'board', companyId, actorId: me, requestId, requestHash: hash,
    })
    if (replay) return { id: replay.id, replayed: true }
    const id = `board-${randomUUID().slice(0, 12)}`
    await client.query(
      `INSERT INTO boards
         (id, company_id, title, description, created_by, creation_request_id, creation_request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, companyId, title, description, me, requestId, requestId ? hash : null],
    )
    // Seed the MEANING alongside the title — see board-columns.ts. Without it an
    // agent asked to advance a card has to infer which column is "Doing" from
    // its name, which is why claim could never move anything.
    const seeds: Array<[string, string]> = [['Todo', 'todo'], ['Doing', 'doing'], ['Done', 'done']]
    for (let i = 0; i < seeds.length; i++) {
      await client.query(
        `INSERT INTO board_columns (id, board_id, title, position, kind) VALUES ($1, $2, $3, $4, $5)`,
        [`col-${randomUUID().slice(0, 12)}`, id, seeds[i][0], (i + 1) * 1000, seeds[i][1]],
      )
    }
    await enqueueBoardEvent(client, { companyId, kind: 'board.created', boardId: id, actorId: me })
    return { id, replayed: false }
  })
  res.status(created.replayed ? 200 : 201).json(created)
})

/** GET /boards/:id — full snapshot: board + columns (ordered) + cards
 *  (ordered within each column) + per-card recent comments count. The
 *  Boards view hydrates off this single call. */
api.get('/boards/:id', async (req, res) => {
  const boardId = req.params.id
  await requireBoardAccess(req, boardId)
  const board = await pool.query<{
    id: string; title: string; description: string | null
    created_by: string; created_at: string; updated_at: string
  }>(
    `SELECT id, title, description, created_by, created_at, updated_at
       FROM boards WHERE id = $1 LIMIT 1`,
    [boardId],
  )
  if (board.rows.length === 0) throw new HttpError(404, 'not found')
  const cols = await pool.query<{
    id: string; title: string; position: number; kind: string | null; created_at: string
  }>(
    `SELECT id, title, position, kind, created_at
       FROM board_columns WHERE board_id = $1 ORDER BY position ASC`,
    [boardId],
  )
  const cards = await pool.query<{
    id: string; column_id: string; title: string; description: string | null
    position: number; assignee_id: string | null; mentions: string[]
    created_by: string; created_at: string; updated_at: string
    comment_count: number
  }>(
    `SELECT c.id, c.column_id, c.title, c.description, c.position,
            c.assignee_id, c.mentions, c.created_by, c.created_at, c.updated_at,
            (SELECT COUNT(*)::int FROM board_card_comments cc WHERE cc.card_id = c.id) AS comment_count
       FROM board_cards c
      WHERE c.board_id = $1
      ORDER BY c.column_id, c.position ASC`,
    [boardId],
  )
  const b = board.rows[0]
  res.json({
    id: b.id,
    title: b.title,
    description: b.description,
    createdBy: b.created_by,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
    columns: cols.rows.map((c) => ({
      id: c.id,
      title: c.title,
      position: Number(c.position),
      createdAt: c.created_at,
    })),
    cards: cards.rows.map((c) => ({
      id: c.id,
      boardId,
      columnId: c.column_id,
      title: c.title,
      description: c.description,
      position: Number(c.position),
      assigneeId: c.assignee_id,
      mentions: Array.isArray(c.mentions) ? c.mentions : [],
      commentCount: c.comment_count,
      createdBy: c.created_by,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    })),
  })
})

/** PATCH /boards/:id — rename / re-describe. */
api.patch('/boards/:id', async (req, res) => {
  const boardId = req.params.id
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  const patch: Record<string, unknown> = {}
  if (typeof req.body?.title === 'string') patch.title = req.body.title.trim().slice(0, 200)
  if (typeof req.body?.description === 'string') patch.description = req.body.description.trim().slice(0, 4000) || null
  if (Object.keys(patch).length === 0) { res.json({ ok: true }); return }
  const sets: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    params.push(v); sets.push(`${k} = $${params.length}`)
  }
  params.push(boardId)
  await withOutboxTransaction(async (client) => {
    await client.query(
      `UPDATE boards SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params,
    )
    await enqueueBoardEvent(client, { companyId, kind: 'board.updated', boardId, actorId: me })
  })
  res.json({ ok: true })
})

/** DELETE /boards/:id — full drop, columns + cards + comments cascade. */
api.delete('/boards/:id', async (req, res) => {
  const boardId = req.params.id
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  await withOutboxTransaction(async (client) => {
    await client.query(`DELETE FROM boards WHERE id = $1`, [boardId])
    await enqueueBoardEvent(client, { companyId, kind: 'board.deleted', boardId, actorId: me })
  })
  res.json({ ok: true })
})

/** POST /boards/:id/columns — add a new column at the end. */
api.post('/boards/:id/columns', async (req, res) => {
  const boardId = req.params.id
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  const title = String(req.body?.title ?? '').trim().slice(0, 100)
  if (!title) throw new HttpError(400, 'title required')
  const { rows: posRows } = await pool.query<{ max: number | null }>(
    `SELECT MAX(position) AS max FROM board_columns WHERE board_id = $1`, [boardId],
  )
  const position = (Number(posRows[0]?.max ?? 0)) + 1000
  const id = `col-${randomUUID().slice(0, 12)}`
  await withOutboxTransaction(async (client) => {
    await client.query(
      `INSERT INTO board_columns (id, board_id, title, position) VALUES ($1, $2, $3, $4)`,
      [id, boardId, title, position],
    )
    await enqueueBoardEvent(client, { companyId, kind: 'column.created', boardId, columnId: id, actorId: me })
  })
  res.json({ id, position })
})

/** PATCH /boards/:bid/columns/:cid — rename, or reorder via `position`. */
api.patch('/boards/:bid/columns/:cid', async (req, res) => {
  const boardId = req.params.bid
  const columnId = req.params.cid
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  const sets: string[] = []
  const params: unknown[] = []
  if (typeof req.body?.title === 'string') {
    params.push(req.body.title.trim().slice(0, 100)); sets.push(`title = $${params.length}`)
  }
  if (typeof req.body?.position === 'number') {
    params.push(req.body.position); sets.push(`position = $${params.length}`)
  }
  if (sets.length === 0) { res.json({ ok: true }); return }
  params.push(columnId); params.push(boardId)
  await withOutboxTransaction(async (client) => {
    const r = await client.query(
      `UPDATE board_columns SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND board_id = $${params.length}`,
      params,
    )
    if ((r.rowCount ?? 0) === 0) throw new HttpError(404, 'not found')
    await enqueueBoardEvent(client, { companyId, kind: 'column.updated', boardId, columnId, actorId: me })
  })
  res.json({ ok: true })
})

/** DELETE /boards/:bid/columns/:cid — drops the column AND all its cards. */
api.delete('/boards/:bid/columns/:cid', async (req, res) => {
  const boardId = req.params.bid
  const columnId = req.params.cid
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  await withOutboxTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM board_columns WHERE id = $1 AND board_id = $2`,
      [columnId, boardId],
    )
    if ((r.rowCount ?? 0) === 0) throw new HttpError(404, 'not found')
    await enqueueBoardEvent(client, { companyId, kind: 'column.deleted', boardId, columnId, actorId: me })
  })
  res.json({ ok: true })
})

/** POST /boards/:id/cards — create a card. Position defaults to end of
 *  the destination column. Title/description parsed for @-mentions. */
api.post('/boards/:id/cards', async (req, res) => {
  const boardId = req.params.id
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  const title = String(req.body?.title ?? '').trim().slice(0, 200)
  const description = String(req.body?.description ?? '').trim().slice(0, 8000) || null
  const columnId = String(req.body?.columnId ?? '').trim()
  const assigneeId = req.body?.assigneeId ? String(req.body.assigneeId).trim() : null
  if (!title) throw new HttpError(400, 'title required')
  if (!columnId) throw new HttpError(400, 'columnId required')
  // Confirm column lives in the board we're touching — otherwise a client
  // could slot a card into a column they shouldn't be able to reach.
  const colCheck = await pool.query(
    `SELECT 1 FROM board_columns WHERE id = $1 AND board_id = $2 LIMIT 1`,
    [columnId, boardId],
  )
  if (colCheck.rows.length === 0) throw new HttpError(404, 'column not found')
  const { rows: posRows } = await pool.query<{ max: number | null }>(
    `SELECT MAX(position) AS max FROM board_cards WHERE column_id = $1`, [columnId],
  )
  const position = (Number(posRows[0]?.max ?? 0)) + 1000
  const mentions = await parseMentions(companyId, `${title}\n${description ?? ''}`)
  const id = `card-${randomUUID().slice(0, 12)}`
  await withOutboxTransaction(async (client) => {
    await client.query(
      `INSERT INTO board_cards
         (id, board_id, column_id, title, description, position, assignee_id, mentions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [id, boardId, columnId, title, description, position, assigneeId, JSON.stringify(mentions), me],
    )
    await client.query(`UPDATE boards SET updated_at = NOW() WHERE id = $1`, [boardId])
    await enqueueBoardEvent(client, {
      companyId, kind: 'card.created', boardId, cardId: id, columnId, mentions, actorId: me,
    })
  })
  void wakeKanbanAgents({
    companyId, mentions, actorId: me,
    card: { boardId, cardId: id, columnId, title, what: 'You were mentioned on a new board card' },
  })
  // Assignment counts as a mention even without an @-token in prose:
  // when you `assignee_id = someone`, that someone should know about it.
  if (assigneeId && assigneeId !== me) {
    void wakeKanbanAgents({
      companyId, mentions: [assigneeId], actorId: me,
      card: { boardId, cardId: id, columnId, title, what: 'A board card was assigned to you' },
    })
  }
  res.json({ id, position, mentions })
})

/** PATCH /boards/:bid/cards/:cid — rename / re-describe / reassign /
 *  move to a different column / reorder. Any subset of fields is fine. */
api.patch('/boards/:bid/cards/:cid', async (req, res) => {
  const boardId = req.params.bid
  const cardId = req.params.cid
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  // Load current row so we can parse mentions off (possibly partial) input
  // against the existing title/description and decide which broadcast kind
  // to publish (card.moved vs card.updated).
  const { rows: cur } = await pool.query<{
    title: string; description: string | null; column_id: string; assignee_id: string | null
  }>(
    `SELECT title, description, column_id, assignee_id FROM board_cards
      WHERE id = $1 AND board_id = $2 LIMIT 1`,
    [cardId, boardId],
  )
  if (cur.length === 0) throw new HttpError(404, 'not found')
  const sets: string[] = []
  const params: unknown[] = []
  let nextTitle = cur[0].title
  let nextDesc = cur[0].description
  let nextColumnId = cur[0].column_id
  let columnChanged = false
  const assigneeChange = resolveKanbanAssigneeChange(cur[0].assignee_id, req.body?.assigneeId)
  if (typeof req.body?.title === 'string') {
    nextTitle = req.body.title.trim().slice(0, 200)
    params.push(nextTitle); sets.push(`title = $${params.length}`)
  }
  if (typeof req.body?.description === 'string') {
    nextDesc = req.body.description.trim().slice(0, 8000) || null
    params.push(nextDesc); sets.push(`description = $${params.length}`)
  }
  if (typeof req.body?.position === 'number') {
    params.push(req.body.position); sets.push(`position = $${params.length}`)
  }
  if (assigneeChange.changed) {
    params.push(assigneeChange.nextAssigneeId); sets.push(`assignee_id = $${params.length}`)
  }
  if (typeof req.body?.columnId === 'string') {
    const newCol = req.body.columnId.trim()
    if (newCol !== cur[0].column_id) {
      const colCheck = await pool.query(
        `SELECT 1 FROM board_columns WHERE id = $1 AND board_id = $2 LIMIT 1`,
        [newCol, boardId],
      )
      if (colCheck.rows.length === 0) throw new HttpError(404, 'column not found')
      params.push(newCol); sets.push(`column_id = $${params.length}`)
      nextColumnId = newCol
      columnChanged = true
    }
  }
  // Mentions need re-parsing whenever prose was touched.
  const proseChanged = typeof req.body?.title === 'string' || typeof req.body?.description === 'string'
  let mentions: string[] | undefined
  if (proseChanged) {
    mentions = await parseMentions(companyId, `${nextTitle}\n${nextDesc ?? ''}`)
    params.push(JSON.stringify(mentions)); sets.push(`mentions = $${params.length}::jsonb`)
  }
  if (sets.length === 0) { res.json({ ok: true }); return }
  params.push(cardId); params.push(boardId)
  await withOutboxTransaction(async (client) => {
    await client.query(
      `UPDATE board_cards SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND board_id = $${params.length}`,
      params,
    )
    await client.query(`UPDATE boards SET updated_at = NOW() WHERE id = $1`, [boardId])
    await enqueueBoardEvent(client, {
      companyId,
      kind: columnChanged ? 'card.moved' : 'card.updated',
      boardId, cardId, mentions, actorId: me,
    })
  })
  void wakeKanbanAgents({
    companyId, mentions, actorId: me,
    card: {
      boardId, cardId, columnId: nextColumnId, title: nextTitle,
      what: 'You were mentioned on a board card',
    },
  })
  // A re-assignment also wakes the new assignee.
  if (assigneeChange.changed) {
    const newAssignee = assigneeChange.nextAssigneeId
    if (newAssignee && newAssignee !== me) {
      void wakeKanbanAgents({
        companyId, mentions: [newAssignee], actorId: me,
        card: {
          boardId, cardId, columnId: nextColumnId, title: nextTitle,
          what: 'A board card was assigned to you',
        },
      })
    }
  }
  res.json({ ok: true, mentions })
})

/** DELETE /boards/:bid/cards/:cid — drops the card + cascades its comments. */
api.delete('/boards/:bid/cards/:cid', async (req, res) => {
  const boardId = req.params.bid
  const cardId = req.params.cid
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  await withOutboxTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM board_cards WHERE id = $1 AND board_id = $2`,
      [cardId, boardId],
    )
    if ((r.rowCount ?? 0) === 0) throw new HttpError(404, 'not found')
    await enqueueBoardEvent(client, { companyId, kind: 'card.deleted', boardId, cardId, actorId: me })
  })
  res.json({ ok: true })
})

/** GET /boards/:bid/cards/:cid/comments — full ordered comment list. */
api.get('/boards/:bid/cards/:cid/comments', async (req, res) => {
  const boardId = req.params.bid
  const cardId = req.params.cid
  await requireBoardAccess(req, boardId)
  const card = await pool.query(
    `SELECT 1 FROM board_cards WHERE id = $1 AND board_id = $2 LIMIT 1`,
    [cardId, boardId],
  )
  if (card.rows.length === 0) throw new HttpError(404, 'not found')
  const { rows } = await pool.query<{
    id: string; author_id: string; body: string; mentions: string[]; created_at: string
  }>(
    `SELECT id, author_id, body, mentions, created_at
       FROM board_card_comments WHERE card_id = $1 ORDER BY created_at ASC`,
    [cardId],
  )
  res.json(rows.map((r) => ({
    id: r.id,
    authorId: r.author_id,
    body: r.body,
    mentions: Array.isArray(r.mentions) ? r.mentions : [],
    createdAt: r.created_at,
  })))
})

/** POST /boards/:bid/cards/:cid/comments — append a comment. Mentions in
 *  the body are parsed at write time. */
api.post('/boards/:bid/cards/:cid/comments', async (req, res) => {
  const boardId = req.params.bid
  const cardId = req.params.cid
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  const body = String(req.body?.body ?? '').trim().slice(0, 8000)
  if (!body) throw new HttpError(400, 'body required')
  const card = await pool.query<{ title: string; column_id: string }>(
    `SELECT title, column_id FROM board_cards WHERE id = $1 AND board_id = $2 LIMIT 1`,
    [cardId, boardId],
  )
  if (card.rows.length === 0) throw new HttpError(404, 'not found')
  const mentions = await parseMentions(companyId, body)
  const id = `cmt-${randomUUID().slice(0, 12)}`
  await withOutboxTransaction(async (client) => {
    await client.query(
      `INSERT INTO board_card_comments (id, card_id, author_id, body, mentions)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, cardId, me, body, JSON.stringify(mentions)],
    )
    await client.query(`UPDATE board_cards SET updated_at = NOW() WHERE id = $1`, [cardId])
    await client.query(`UPDATE boards SET updated_at = NOW() WHERE id = $1`, [boardId])
    await enqueueBoardEvent(client, {
      companyId, kind: 'comment.created', boardId, cardId, commentId: id, mentions, actorId: me,
    })
  })
  void wakeKanbanAgents({
    companyId, mentions, actorId: me,
    card: {
      boardId, cardId, columnId: card.rows[0].column_id, title: card.rows[0].title,
      what: 'You were mentioned in a board card comment',
    },
  })
  res.json({ id, mentions })
})

/** DELETE /boards/:bid/cards/:cid/comments/:mid — author can delete
 *  their own comment. */
api.delete('/boards/:bid/cards/:cid/comments/:mid', async (req, res) => {
  const boardId = req.params.bid
  const cardId = req.params.cid
  const mid = req.params.mid
  const { userId: me, companyId } = await requireBoardAccess(req, boardId)
  await withOutboxTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM board_card_comments
         WHERE id = $1 AND card_id = $2 AND author_id = $3`,
      [mid, cardId, me],
    )
    if ((r.rowCount ?? 0) === 0) throw new HttpError(404, 'not found')
    await enqueueBoardEvent(client, {
      companyId, kind: 'comment.deleted', boardId, cardId, commentId: mid, actorId: me,
    })
  })
  res.json({ ok: true })
})

/* ================================ Calendar =================================
 * AI-native shared calendar. Humans schedule events from the Calendar view;
 * 'agent_task' events fire at their start time (plus recurrence) and the
 * server-side scheduler posts a typed Calendar system dispatch into the target
 * conversation, waking the assignee agent. Agents can also create / list events here —
 * same shape, same gating — so cron-style "every Monday 9am, draft the
 * standup" works whether the schedule was set up by a human or an agent.
 *
 * Scope rules: every row lives in exactly one company. The caller must be a
 * member of that company (requireCompany). We do NOT require the caller to
 * be the creator — anyone in the workspace can see + edit shared events,
 * matching how conversations work. Tightening this later (e.g. "creator
 * only edits") is a one-line ownership check; intentionally permissive
 * during v1 so a teammate can adjust a colleague's recurring agent task.
 */

type CalendarEventKind = 'personal' | 'agent_task'
type CalendarStatus = 'active' | 'paused' | 'done' | 'cancelled'

type ReminderChannel = 'toast' | 'email' | 'both'

interface CalendarEventPayload {
  id: string
  companyId: string
  createdBy: string
  kind: CalendarEventKind
  title: string
  description: string | null
  assigneeId: string | null
  targetConversationId: string | null
  agentPrompt: string | null
  startAt: string
  endAt: string | null
  allDay: boolean
  recurrence: import('../calendar.js').RecurrenceRule | null
  status: CalendarStatus
  lastFiredAt: string | null
  reminderMinutesBefore: number | null
  reminderChannel: ReminderChannel | null
  /** When true, only the row's creator and assignee may read or write it.
   *  Visibility is enforced at the API + CLI layer. Default false = the
   *  row is shared with everyone in the company. */
  isPrivate: boolean
  createdAt: string
  updatedAt: string
}

function isReminderChannel(v: unknown): v is ReminderChannel {
  return v === 'toast' || v === 'email' || v === 'both'
}

interface CalendarDispatchPayload {
  id: string
  eventId: string
  scheduledFor: string
  dispatchedAt: string
  status: string
  conversationId: string | null
  messageId: string | null
  error: string | null
}

function isCalendarKind(v: unknown): v is CalendarEventKind {
  return v === 'personal' || v === 'agent_task'
}

function isCalendarStatus(v: unknown): v is CalendarStatus {
  return v === 'active' || v === 'paused' || v === 'done' || v === 'cancelled'
}

/** Coerce + validate a recurrence rule from request JSON. Returns null when
 *  the field is absent / explicitly null; throws on malformed shape. */
function parseRecurrence(raw: unknown): import('../calendar.js').RecurrenceRule | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') throw new HttpError(400, 'recurrence must be an object')
  const r = raw as Record<string, unknown>
  const freq = r.freq
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly' && freq !== 'yearly') {
    throw new HttpError(400, 'recurrence.freq must be daily|weekly|monthly|yearly')
  }
  const interval = Math.max(1, Math.floor(Number(r.interval ?? 1)))
  let byweekday: number[] | undefined
  if (Array.isArray(r.byweekday)) {
    byweekday = r.byweekday
      .map((d) => Number(d))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    if (byweekday.length === 0) byweekday = undefined
  }
  let until: string | null = null
  if (typeof r.until === 'string' && r.until.trim()) {
    const d = new Date(r.until)
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'recurrence.until must be a valid ISO timestamp')
    until = d.toISOString()
  }
  let count: number | null = null
  if (r.count !== null && r.count !== undefined) {
    const n = Math.floor(Number(r.count))
    if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'recurrence.count must be a positive integer')
    count = n
  }
  return { freq, interval, byweekday, until, count }
}

function rowToCalendarEvent(row: Record<string, unknown>): CalendarEventPayload {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    createdBy: String(row.created_by),
    kind: row.kind as CalendarEventKind,
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    assigneeId: row.assignee_id == null ? null : String(row.assignee_id),
    targetConversationId: row.target_conversation_id == null ? null : String(row.target_conversation_id),
    agentPrompt: row.agent_prompt == null ? null : String(row.agent_prompt),
    startAt: (row.start_at as Date).toISOString(),
    endAt: row.end_at ? (row.end_at as Date).toISOString() : null,
    allDay: Boolean(row.all_day),
    recurrence: (row.recurrence as import('../calendar.js').RecurrenceRule | null) ?? null,
    status: row.status as CalendarStatus,
    lastFiredAt: row.last_fired_at ? (row.last_fired_at as Date).toISOString() : null,
    reminderMinutesBefore: row.reminder_minutes_before == null ? null : Number(row.reminder_minutes_before),
    reminderChannel: (row.reminder_channel as ReminderChannel | null) ?? null,
    isPrivate: Boolean(row.is_private),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

const CALENDAR_SELECT = `id, company_id, created_by, kind, title, description,
  assignee_id, target_conversation_id, agent_prompt, start_at, end_at, all_day,
  recurrence, status, last_fired_at,
  reminder_minutes_before, reminder_channel,
  is_private,
  created_at, updated_at`

/** SQL fragment that filters out private rows the caller can't see.
 *  Used by GET (list + single) and as a guard in the write paths.
 *
 *  Visibility rules:
 *    - public row → everyone in the company sees it
 *    - private row → only `created_by` or `assignee_id` see it
 *    - private row WITH an agent on either side → the company owner ALSO
 *      sees it. This gives the workspace owner supervisorial visibility
 *      into what agents are scheduling for themselves, without leaking
 *      human-to-human private events to the owner.
 *
 *  The caller binds its userId at `meIdx` and the tenant id at `companyIdx`.
 *  The owner check is a cheap EXISTS subquery against `companies`; the
 *  agent check uses `participants(kind='agent')` scoped to the same tenant. */
function calendarVisibilityClause(meIdx: number, companyIdx: number): string {
  return `(
    is_private = false
    OR created_by = $${meIdx}
    OR assignee_id = $${meIdx}
    OR (
      EXISTS (SELECT 1 FROM companies WHERE id = $${companyIdx} AND owner_user_id = $${meIdx})
      AND (
        created_by IN (SELECT id FROM participants WHERE company_id = $${companyIdx} AND kind = 'agent')
        OR assignee_id IN (SELECT id FROM participants WHERE company_id = $${companyIdx} AND kind = 'agent')
      )
    )
  )`
}

/** Queue a thin calendar invalidation in the mutation transaction. */
async function enqueueCalendarChange(db: PoolClient, args: {
  kind: 'event.created' | 'event.updated' | 'event.deleted' | 'event.dispatched'
  eventId: string
  companyId: string
  actorId: string | null
}): Promise<void> {
  await enqueueBroadcast(db, CH_CALENDAR_EVENTS, {
    type: 'calendar.changed',
    kind: args.kind,
    eventId: args.eventId,
    companyId: args.companyId,
    actorId: args.actorId,
  })
}

api.get('/calendar/events', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  // Optional range window — keeps the list bounded for the agenda / month
  // view. Without a window we return everything in the company, capped at
  // 1000 rows. The list page will paginate when that becomes a real cap.
  const from = typeof req.query.from === 'string' ? new Date(req.query.from) : null
  const to = typeof req.query.to === 'string' ? new Date(req.query.to) : null
  // Privacy filter: `is_private` rows are only visible to their creator
  // or assignee. The clause uses $2 for the caller id; range filters
  // bind after.
  const params: unknown[] = [companyId, me]
  let sql = `SELECT ${CALENDAR_SELECT} FROM calendar_events
             WHERE company_id = $1 AND ${calendarVisibilityClause(2, 1)}`
  if (from && !Number.isNaN(from.getTime())) {
    params.push(from)
    // We want recurring 'active' events to show up regardless of their seed
    // start_at — they keep firing into the future. So range filtering is
    // "start in window OR recurring + active".
    sql += ` AND (start_at >= $${params.length} OR (recurrence IS NOT NULL AND status = 'active'))`
  }
  if (to && !Number.isNaN(to.getTime())) {
    params.push(to)
    sql += ` AND start_at <= $${params.length}`
  }
  sql += ` ORDER BY start_at ASC LIMIT 1000`
  const { rows } = await pool.query(sql, params)
  res.json({ events: rows.map(rowToCalendarEvent) })
})

api.post('/calendar/events', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const body = req.body as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body required')

  const title = String(body.title ?? '').trim().slice(0, 200)
  if (!title) throw new HttpError(400, 'title required')
  const kind: CalendarEventKind = isCalendarKind(body.kind) ? body.kind : 'personal'
  const description = body.description == null ? null : String(body.description).slice(0, 4000)
  const assigneeId = body.assigneeId == null ? null : String(body.assigneeId).trim() || null
  const targetConversationId = body.targetConversationId == null
    ? null : String(body.targetConversationId).trim() || null
  const agentPrompt = body.agentPrompt == null ? null : String(body.agentPrompt).slice(0, 8000)
  const startAtStr = String(body.startAt ?? '').trim()
  const startAt = new Date(startAtStr)
  if (!startAtStr || Number.isNaN(startAt.getTime())) throw new HttpError(400, 'startAt must be a valid ISO timestamp')
  const endAt = (() => {
    if (body.endAt == null) return null
    const d = new Date(String(body.endAt))
    return Number.isNaN(d.getTime()) ? null : d
  })()
  const allDay = Boolean(body.allDay)
  const recurrence = parseRecurrence(body.recurrence)
  const status: CalendarStatus = isCalendarStatus(body.status) ? body.status : 'active'
  // Reminders are co-validated: a non-null channel requires a positive
  // lead time, and vice versa. Either both null = no reminder, or both
  // set = reminder armed.
  let reminderMinutesBefore: number | null = null
  let reminderChannel: ReminderChannel | null = null
  if (body.reminderMinutesBefore != null) {
    const n = Math.floor(Number(body.reminderMinutesBefore))
    if (!Number.isFinite(n) || n < 0 || n > 14 * 24 * 60) {
      throw new HttpError(400, 'reminderMinutesBefore must be a non-negative integer (≤ 2 weeks)')
    }
    reminderMinutesBefore = n
  }
  if (body.reminderChannel != null) {
    if (!isReminderChannel(body.reminderChannel)) {
      throw new HttpError(400, 'reminderChannel must be toast|email|both')
    }
    reminderChannel = body.reminderChannel
  }
  if ((reminderMinutesBefore !== null) !== (reminderChannel !== null)) {
    throw new HttpError(400, 'reminderMinutesBefore and reminderChannel must both be set or both null')
  }
  const isPrivate = Boolean(body.isPrivate)

  // For agent_task events, an assignee is required up front — there's
  // nothing to do without one. We still let humans save targetConversationId
  // empty: the scheduler will fall back to the creator↔assignee DM.
  if (kind === 'agent_task' && !assigneeId) {
    throw new HttpError(400, 'agent_task events require an assigneeId')
  }
  // Membership sanity-check for cross-tenant safety: the assignee + target
  // conversation must live in this company. Cheap pre-write check that
  // catches typo'd ids early.
  if (assigneeId) {
    const { rows: p } = await pool.query(
      `SELECT 1 FROM participants WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [assigneeId, companyId],
    )
    if (!p[0]) throw new HttpError(400, 'assigneeId not found in this workspace')
  }
  if (targetConversationId) {
    const { rows: c } = await pool.query(
      `SELECT 1 FROM conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [targetConversationId, companyId],
    )
    if (!c[0]) throw new HttpError(400, 'targetConversationId not found in this workspace')
  }

  const requestId = createRequestId(body.requestId)
  const hash = requestHash({
    title, kind, description, assigneeId, targetConversationId, agentPrompt,
    startAt: startAt.toISOString(), endAt: endAt?.toISOString() ?? null,
    allDay, recurrence, status, reminderMinutesBefore, reminderChannel, isPrivate,
  })
  const created = await withOutboxTransaction(async (client) => {
    const replay = await createReplay(client, {
      domain: 'calendar-event', companyId, actorId: me, requestId, requestHash: hash,
    })
    if (replay) {
      const existing = await client.query(
        `SELECT ${CALENDAR_SELECT} FROM calendar_events WHERE id = $1`,
        [replay.id],
      )
      return { rows: existing.rows, replayed: true }
    }
    const id = `ce-${randomUUID()}`
    const inserted = await client.query(
      `INSERT INTO calendar_events
         (id, company_id, created_by, kind, title, description, assignee_id,
          target_conversation_id, agent_prompt, start_at, end_at, all_day,
          recurrence, status, reminder_minutes_before, reminder_channel,
          is_private, creation_request_id, creation_request_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)
       RETURNING ${CALENDAR_SELECT}`,
      [
        id, companyId, me, kind, title, description, assigneeId,
        targetConversationId, agentPrompt, startAt, endAt, allDay,
        recurrence ? JSON.stringify(recurrence) : null, status,
        reminderMinutesBefore, reminderChannel,
        isPrivate, requestId, requestId ? hash : null,
      ],
    )
    await enqueueCalendarChange(client, { kind: 'event.created', eventId: id, companyId, actorId: me })
    return { rows: inserted.rows, replayed: false }
  })
  res.status(created.replayed ? 200 : 201).json({
    event: rowToCalendarEvent(created.rows[0]),
    replayed: created.replayed,
  })
})

api.get('/calendar/events/:id', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  // Tenant filter + privacy filter are both 404 (not 403) — we don't want
  // to leak "this id exists but you can't see it" vs "no such id."
  const { rows } = await pool.query(
    `SELECT ${CALENDAR_SELECT} FROM calendar_events
      WHERE id = $1 AND company_id = $2 AND ${calendarVisibilityClause(3, 2)}
      LIMIT 1`,
    [id, companyId, me],
  )
  if (!rows[0]) throw new HttpError(404, 'event not found')
  res.json({ event: rowToCalendarEvent(rows[0]) })
})

api.patch('/calendar/events/:id', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  const body = req.body as Record<string, unknown> | undefined
  if (!body || typeof body !== 'object') throw new HttpError(400, 'body required')

  // Privacy guard: callers who can't *see* the row also can't *modify*
  // it. We use the same visibility clause as GET so PATCH on a private
  // row by a non-author / non-assignee / non-owner returns 404 (same
  // shape as "no such id," so we don't leak existence).
  {
    const { rows } = await pool.query(
      `SELECT 1 FROM calendar_events
        WHERE id = $1 AND company_id = $2 AND ${calendarVisibilityClause(3, 2)}
        LIMIT 1`,
      [id, companyId, me],
    )
    if (!rows[0]) throw new HttpError(404, 'event not found')
  }

  // Build a SET clause from whichever fields are present. Each field is
  // validated independently so partial updates are safe.
  const sets: string[] = []
  const params: unknown[] = []
  const push = (sql: string, value: unknown) => {
    params.push(value)
    sets.push(`${sql} = $${params.length}`)
  }
  if (body.title !== undefined) {
    const t = String(body.title).trim().slice(0, 200)
    if (!t) throw new HttpError(400, 'title cannot be empty')
    push('title', t)
  }
  if (body.kind !== undefined) {
    if (!isCalendarKind(body.kind)) throw new HttpError(400, 'invalid kind')
    push('kind', body.kind)
  }
  if (body.description !== undefined) {
    push('description', body.description == null ? null : String(body.description).slice(0, 4000))
  }
  if (body.assigneeId !== undefined) {
    push('assignee_id', body.assigneeId == null ? null : String(body.assigneeId))
  }
  if (body.targetConversationId !== undefined) {
    push('target_conversation_id', body.targetConversationId == null ? null : String(body.targetConversationId))
  }
  if (body.agentPrompt !== undefined) {
    push('agent_prompt', body.agentPrompt == null ? null : String(body.agentPrompt).slice(0, 8000))
  }
  if (body.startAt !== undefined) {
    const d = new Date(String(body.startAt))
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid startAt')
    push('start_at', d)
  }
  if (body.endAt !== undefined) {
    if (body.endAt == null) push('end_at', null)
    else {
      const d = new Date(String(body.endAt))
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'invalid endAt')
      push('end_at', d)
    }
  }
  if (body.allDay !== undefined) push('all_day', Boolean(body.allDay))
  if (body.recurrence !== undefined) {
    const r = parseRecurrence(body.recurrence)
    params.push(r ? JSON.stringify(r) : null)
    sets.push(`recurrence = $${params.length}::jsonb`)
  }
  if (body.status !== undefined) {
    if (!isCalendarStatus(body.status)) throw new HttpError(400, 'invalid status')
    push('status', body.status)
  }
  if (body.reminderMinutesBefore !== undefined) {
    if (body.reminderMinutesBefore == null) push('reminder_minutes_before', null)
    else {
      const n = Math.floor(Number(body.reminderMinutesBefore))
      if (!Number.isFinite(n) || n < 0 || n > 14 * 24 * 60) {
        throw new HttpError(400, 'reminderMinutesBefore must be a non-negative integer (≤ 2 weeks)')
      }
      push('reminder_minutes_before', n)
    }
  }
  if (body.reminderChannel !== undefined) {
    if (body.reminderChannel == null) push('reminder_channel', null)
    else {
      if (!isReminderChannel(body.reminderChannel)) {
        throw new HttpError(400, 'reminderChannel must be toast|email|both')
      }
      push('reminder_channel', body.reminderChannel)
    }
  }
  if (body.isPrivate !== undefined) {
    push('is_private', Boolean(body.isPrivate))
  }
  if (sets.length === 0) throw new HttpError(400, 'no updatable fields')
  sets.push('updated_at = NOW()')
  params.push(id, companyId)
  const sql = `UPDATE calendar_events SET ${sets.join(', ')}
                WHERE id = $${params.length - 1} AND company_id = $${params.length}
            RETURNING ${CALENDAR_SELECT}`
  const rows = await withOutboxTransaction(async (client) => {
    const updated = await client.query(sql, params)
    if (!updated.rows[0]) throw new HttpError(404, 'event not found')
    await enqueueCalendarChange(client, { kind: 'event.updated', eventId: id, companyId, actorId: me })
    return updated.rows
  })
  res.json({ event: rowToCalendarEvent(rows[0]) })
})

api.delete('/calendar/events/:id', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  // The visibility clause is folded into the DELETE so the same caller
  // who can't read the row can't delete it either. rowCount === 0 covers
  // both "no such id" and "privacy filtered" — same 404 on the wire.
  await withOutboxTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM calendar_events
        WHERE id = $1 AND company_id = $2 AND ${calendarVisibilityClause(3, 2)}`,
      [id, companyId, me],
    )
    if (r.rowCount === 0) throw new HttpError(404, 'event not found')
    await enqueueCalendarChange(client, { kind: 'event.deleted', eventId: id, companyId, actorId: me })
  })
  res.json({ ok: true })
})

api.post('/calendar/events/:id/run-now', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  const { rows } = await pool.query(
    `SELECT ${CALENDAR_SELECT} FROM calendar_events
      WHERE id = $1 AND company_id = $2 AND ${calendarVisibilityClause(3, 2)}`,
    [id, companyId, me],
  )
  if (!rows[0]) throw new HttpError(404, 'event not found')
  const { dispatchEvent } = await import('../calendar.js')
  // Use NOW() as the slot; uniqueness against (event_id, scheduled_for) is
  // wide enough to absorb concurrent button-mashing within the same minute.
  const result = await dispatchEvent(rows[0] as import('../calendar.js').CalendarEventRow, new Date())
  // last_fired_at moved + dispatch happened → renderers want to refetch.
  // dispatchEvent owns the durable dispatch transaction. This thin UI
  // invalidation is queued independently only after dispatch succeeds; the
  // dispatcher itself also reconciles from PostgreSQL on every tick.
  await withOutboxTransaction((client) => enqueueCalendarChange(
    client,
    { kind: 'event.dispatched', eventId: id, companyId, actorId: me },
  ))
  res.json(result)
})

api.get('/calendar/events/:id/dispatches', async (req, res) => {
  const { userId: me, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  // Visibility gate: if the caller can't see the underlying event, they
  // can't see its dispatch history either. Cheap pre-check keeps the
  // main query free of an extra join.
  {
    const { rows } = await pool.query(
      `SELECT 1 FROM calendar_events
        WHERE id = $1 AND company_id = $2 AND ${calendarVisibilityClause(3, 2)}
        LIMIT 1`,
      [id, companyId, me],
    )
    if (!rows[0]) throw new HttpError(404, 'event not found')
  }
  const { rows } = await pool.query(
    `SELECT cd.id, cd.event_id, cd.scheduled_for, cd.dispatched_at, cd.status,
            cd.conversation_id, cd.message_id, cd.error
       FROM calendar_dispatches cd
       JOIN calendar_events ce ON ce.id = cd.event_id
      WHERE cd.event_id = $1 AND ce.company_id = $2
      ORDER BY cd.scheduled_for DESC LIMIT 200`,
    [id, companyId],
  )
  const dispatches: CalendarDispatchPayload[] = rows.map((r) => ({
    id: String(r.id),
    eventId: String(r.event_id),
    scheduledFor: (r.scheduled_for as Date).toISOString(),
    dispatchedAt: (r.dispatched_at as Date).toISOString(),
    status: String(r.status),
    conversationId: r.conversation_id == null ? null : String(r.conversation_id),
    messageId: r.message_id == null ? null : String(r.message_id),
    error: r.error == null ? null : String(r.error),
  }))
  res.json({ dispatches })
})

/* =================== Collaborative documents (CRDT) =================== */
//
// REST is just the metadata + bootstrap path. The actual content sync
// happens over the WS doc subprotocol (doc.subscribe/update/awareness)
// — see server/src/documents/rooms.ts + ws.ts.

interface DocumentRow {
  id: string
  company_id: string
  title: string
  created_by: string
  conversation_id: string | null
  created_at: Date
  updated_at: Date
}

interface DocumentPayload {
  id: string
  title: string
  createdBy: string
  conversationId: string | null
  createdAt: string
  updatedAt: string
}

function toDocPayload(row: DocumentRow): DocumentPayload {
  return {
    id: row.id,
    title: row.title,
    createdBy: row.created_by,
    conversationId: row.conversation_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function enqueueDocumentChanged(
  db: PoolClient,
  companyId: string,
  documentId: string,
  kind: 'document.created' | 'document.updated' | 'document.deleted',
  actorId: string,
): Promise<void> {
  await enqueueBroadcast(db, CH_DOCS, {
    type: 'doc.changed',
    kind,
    companyId,
    documentId,
    actorId,
  })
}

api.get('/documents', safe(async (req, res) => {
  const { companyId } = await requireCompany(req)
  const { rows } = await pool.query<DocumentRow>(
    `SELECT id, company_id, title, created_by, conversation_id, created_at, updated_at
       FROM documents
      WHERE company_id = $1
      ORDER BY updated_at DESC
      LIMIT 200`,
    [companyId],
  )
  res.json({ documents: rows.map(toDocPayload) })
}))

api.post('/documents', safe(async (req, res) => {
  const { userId, companyId } = await requireCompany(req)
  const body = (req.body ?? {}) as {
    title?: unknown
    conversationId?: unknown
    requestId?: unknown
  }
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : 'Untitled'
  // Optional pin to a conversation. Verified to belong to this tenant.
  let conversationId: string | null = null
  if (typeof body.conversationId === 'string' && body.conversationId) {
    const { rows: convRows } = await pool.query(
      `SELECT 1 FROM conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [body.conversationId, companyId],
    )
    if (convRows.length === 0) throw new HttpError(404, 'conversation not found')
    conversationId = body.conversationId
  }
  const requestId = createRequestId(body.requestId)
  const hash = requestHash({ title, conversationId })
  const created = await withOutboxTransaction(async (client) => {
    const replay = await createReplay(client, {
      domain: 'document', companyId, actorId: userId, requestId, requestHash: hash,
    })
    const id = replay?.id ?? `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    if (!replay) {
      await client.query(
        `INSERT INTO documents
           (id, company_id, title, created_by, conversation_id, creation_request_id, creation_request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, companyId, title, userId, conversationId, requestId, requestId ? hash : null],
      )
    }
    const selected = await client.query<DocumentRow>(
      `SELECT id, company_id, title, created_by, conversation_id, created_at, updated_at
         FROM documents WHERE id = $1`, [id],
    )
    if (!replay) await enqueueDocumentChanged(client, companyId, id, 'document.created', userId)
    return { rows: selected.rows, replayed: Boolean(replay) }
  })
  const doc = toDocPayload(created.rows[0])
  res.status(created.replayed ? 200 : 201).json({ ...doc, replayed: created.replayed })
}))

api.get('/documents/:id', safe(async (req, res) => {
  const { companyId } = await requireCompany(req)
  const id = String(req.params.id)
  const { rows } = await pool.query<DocumentRow>(
    `SELECT id, company_id, title, created_by, conversation_id, created_at, updated_at
       FROM documents WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  )
  if (!rows[0]) throw new HttpError(404, 'not found')
  res.json(toDocPayload(rows[0]))
}))

api.put('/documents/:id', safe(async (req, res) => {
  const { userId, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  const body = (req.body ?? {}) as { title?: unknown }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    throw new HttpError(400, 'title required')
  }
  const title = body.title.trim().slice(0, 200)
  await withOutboxTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE documents SET title = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3`,
      [title, id, companyId],
    )
    if (!rowCount) throw new HttpError(404, 'not found')
    await enqueueDocumentChanged(client, companyId, id, 'document.updated', userId)
  })
  res.json({ ok: true, title })
}))

api.delete('/documents/:id', safe(async (req, res) => {
  const { userId, companyId } = await requireCompany(req)
  const id = String(req.params.id)
  // Only the creator (or an owner/admin) can delete. Mirrors the
  // delete-your-own-agent pattern elsewhere in this router.
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT created_by FROM documents WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  )
  if (!rows[0]) throw new HttpError(404, 'not found')
  if (rows[0].created_by !== userId) {
    const { rows: roleRows } = await pool.query<{ role: string }>(
      `SELECT role FROM company_members WHERE company_id = $1 AND user_id = $2`,
      [companyId, userId],
    )
    const role = roleRows[0]?.role ?? 'member'
    if (!PRIVILEGED_ROLES.has(role)) throw new HttpError(403, 'only the creator or an owner can delete')
  }
  await withOutboxTransaction(async (client) => {
    await client.query(`DELETE FROM documents WHERE id = $1`, [id])
    await enqueueDocumentChanged(client, companyId, id, 'document.deleted', userId)
  })
  res.json({ ok: true })
}))

/* ============== Push notification device registry =====================
 * Mobile clients (iOS via APNs today; Android/web later) register their
 * platform-issued push token here after the user grants permission. The
 * server stores at most one row per (platform, token) globally; if the
 * same device signs into a different account we steal the token row and
 * rebind user_id rather than letting it dangle on the old account and
 * deliver messages to the wrong person.
 *
 * No tenant scoping: a single human can be in multiple companies and
 * expects pushes from all of them on the same device. We do the
 * convo/company gating at SEND time (server/src/push.ts) instead.
 */
const VALID_PUSH_PLATFORMS = new Set(['ios', 'android', 'web'])

api.post('/push/register', async (req, res) => {
  try {
    const userId = requireAuth(req)
    const body = (req.body ?? {}) as {
      platform?: unknown
      token?: unknown
      appVersion?: unknown
      deviceModel?: unknown
    }
    const platform = typeof body.platform === 'string' ? body.platform : ''
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!VALID_PUSH_PLATFORMS.has(platform)) {
      throw new HttpError(400, 'platform must be ios | android | web')
    }
    if (!token) throw new HttpError(400, 'token required')
    if (token.length > 1024) throw new HttpError(400, 'token too long')
    const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, 64) : null
    const deviceModel = typeof body.deviceModel === 'string' ? body.deviceModel.slice(0, 128) : null
    const id = `pd-${randomUUID()}`
    // Upsert keyed on (platform, token). The DO UPDATE block:
    //   - rebinds user_id (handles device-handoff between accounts)
    //   - refreshes last_seen_at so we know the token is live
    //   - clears disabled_at because the client just sent it again — must
    //     not still be dead from the provider's standpoint
    //   - takes the freshest app/model strings (don't overwrite with null)
    await pool.query(
      `INSERT INTO push_devices (id, user_id, platform, token, app_version, device_model)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform, token) DO UPDATE SET
         user_id      = EXCLUDED.user_id,
         last_seen_at = NOW(),
         disabled_at  = NULL,
         app_version  = COALESCE(EXCLUDED.app_version, push_devices.app_version),
         device_model = COALESCE(EXCLUDED.device_model, push_devices.device_model)`,
      [id, userId, platform, token, appVersion, deviceModel],
    )
    res.json({ ok: true })
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[push] /push/register failed', e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

api.post('/push/unregister', async (req, res) => {
  try {
    const userId = requireAuth(req)
    const body = (req.body ?? {}) as { token?: unknown; platform?: unknown }
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    if (!token) throw new HttpError(400, 'token required')
    // Soft-disable rather than DELETE. Keeps the audit trail and avoids
    // churning the UNIQUE index when a sign-out is immediately followed
    // by a re-sign-in on the same device. Scope by user_id so a stolen
    // session can't unregister another user's devices.
    await pool.query(
      `UPDATE push_devices
          SET disabled_at = NOW()
        WHERE token = $1
          AND user_id = $2
          AND disabled_at IS NULL`,
      [token, userId],
    )
    res.json({ ok: true })
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return }
    console.error('[push] /push/unregister failed', e)
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

// Evidence-backed feature delivery. Mounted late so its compact `/shipping/*`
// namespace cannot shadow any legacy API route. The router receives the same
// tenant/role gates as the rest of this file; it never trusts company ids from
// request bodies or URLs.
api.use('/shipping', createShippingRouter({ pool, requireCompany, requireCompanyRole }))

// Global error handler — must come after all routes. HttpError → status code.
api.use(errorHandler)
