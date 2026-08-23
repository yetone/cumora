/**
 * OAuth — Google + GitHub. Server-side authorization-code flow.
 *
 * Flow per provider:
 *   1. GET /api/auth/start/<provider> — server saves a random `state` to
 *      Redis (5min TTL) keyed by sha256(state), 302s to the provider's
 *      consent URL with that state.
 *   2. Provider redirects user back to /api/auth/callback/<provider>?code=…&state=…
 *   3. Server consumes the state (single-use), exchanges code → tokens,
 *      fetches the user profile, finds-or-creates the local user via
 *      user_identities (auto-bind by verified email), creates a session,
 *      302s to AUTH_DONE_URL#token=…&companyId=….
 *
 * State protection (CSRF + replay):
 *   - state is base64url(randomBytes(32)).
 *   - We store only its sha256 hash in Redis under `oauth:state:<sha>`.
 *     The plaintext lives only in the user's browser (URL) and the
 *     provider's redirect — DB read alone can't replay.
 *   - 5min TTL is plenty for a user-driven OAuth handshake.
 *
 * Auto-linking policy (locked in by user choice 2026-05-12):
 *   - If a user_identities row already exists for (provider, provider_id):
 *     log them in as that user.
 *   - Else if the provider returned a verified email AND we have a user
 *     with that email_lower (whether via another provider or a legacy
 *     password account), link the new identity to that user.
 *   - Else create a fresh user + their personal company.
 *
 * For GitHub specifically: `email` from /user is often null because users
 * keep it private. We instead hit /user/emails and pick `primary + verified`.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { redis } from './redis.js'
import { env } from './env.js'
import { audit, createSession, gravatarUrlForEmail } from './auth.js'
import { onboardStarterAgents, joinAllHands } from './onboardCompany.js'
import { companyTier } from './tier.js'
import { ensureCloudComputer, cloudComputerId } from './agents/computer/registry.js'
import { storage } from './storage.js'
import { provisionUser as provisionSub2apiUser, sub2apiConfigured } from './sub2api.js'
import { isWaitlistEnabled, enqueueWaitlist, isAllowlistedAdmin } from './admin.js'

export type Provider = 'google' | 'github' | 'apple'

interface ProviderConfig {
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  scope: string
  clientId: string
  clientSecret: string
}

function providerConfig(p: Provider): ProviderConfig {
  if (p === 'google') return {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:     'https://oauth2.googleapis.com/token',
    userInfoUrl:  'https://openidconnect.googleapis.com/v1/userinfo',
    scope:        'openid email profile',
    clientId:     env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  }
  return {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl:     'https://github.com/login/oauth/access_token',
    userInfoUrl:  'https://api.github.com/user',
    scope:        'read:user user:email',
    clientId:     env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
  }
}

export function providerEnabled(p: Provider): boolean {
  const cfg = providerConfig(p)
  return Boolean(cfg.clientId && cfg.clientSecret)
}

function redirectUri(p: Provider): string {
  return `${env.PUBLIC_ORIGIN}/api/auth/callback/${p}`
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('base64url')
}

interface StateData {
  provider: Provider
  /** Where to 302 after a successful callback. null = use server default. */
  returnUrl: string | null
  /** Pending invite token, when the sign-in started from /invite/<token>.
   *  Carried through OAuth so the callback can SKIP the auto-create-workspace
   *  step for net-new users (they don't want their own workspace — they want
   *  to land in the inviter's). */
  inviteToken: string | null
}

/** Validate a client-supplied return URL against the configured allow-list.
 *  Without this we'd have an open redirect: an attacker could craft a
 *  provider-callback chain that delivers the user's token to any origin
 *  via the fragment. The check is a strict-prefix match so subpaths are
 *  fine (`http://localhost:5180/anything`) but origin spoofs aren't
 *  (`http://evil.com?https://app.cumora.ai/`). */
export function returnUrlAllowed(url: string): boolean {
  if (!url) return false
  return env.AUTH_RETURN_ALLOWLIST.some((prefix) => url.startsWith(prefix))
}

/** Mint a state token, save it + the requested return URL + optional invite
 *  token to Redis, return the plaintext state. */
export async function createState(
  p: Provider,
  returnUrl: string | null,
  inviteToken: string | null = null,
): Promise<string> {
  const state = randomBytes(32).toString('base64url')
  const key = `oauth:state:${hashState(state)}`
  const data: StateData = { provider: p, returnUrl, inviteToken }
  await redis.set(key, JSON.stringify(data), 'EX', 300)
  return state
}

/** Single-use consume — returns the saved StateData, or null if the
 *  state is unknown / expired / already consumed. */
export async function consumeState(state: string): Promise<StateData | null> {
  const key = `oauth:state:${hashState(state)}`
  const v = await redis.getdel(key)
  if (!v) return null
  try {
    const parsed = JSON.parse(v) as StateData
    if (parsed.provider !== 'google' && parsed.provider !== 'github') return null
    return parsed
  } catch {
    return null
  }
}

/** Build the provider's authorize URL the browser is 302'd to in step 1. */
export function authorizeUrl(p: Provider, state: string): string {
  const cfg = providerConfig(p)
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(p),
    response_type: 'code',
    scope: cfg.scope,
    state,
  })
  if (p === 'google') {
    // Always prompt = consent so we don't get a silent re-auth that bypasses
    // account selection (helps when the user has multiple Google accounts).
    params.set('prompt', 'select_account')
    params.set('access_type', 'online')
  }
  return `${cfg.authorizeUrl}?${params.toString()}`
}

interface NormalizedProfile {
  providerId: string
  email: string         // lowercased; throws if provider didn't yield a verified email
  displayName: string
  avatarUrl: string | null
}

/** Step 2: trade the auth code for an access token. */
async function exchangeCode(p: Provider, code: string): Promise<string> {
  const cfg = providerConfig(p)
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: redirectUri(p),
    grant_type: 'authorization_code',
  })
  const r = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  })
  if (!r.ok) throw new Error(`${p} token exchange ${r.status}: ${await r.text()}`)
  const j = await r.json() as { access_token?: string; error?: string; error_description?: string }
  if (!j.access_token) throw new Error(`${p} token response missing access_token: ${j.error_description ?? j.error ?? 'unknown'}`)
  return j.access_token
}

interface GoogleProfile { sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }
interface GitHubProfile { id: number; login: string; name?: string | null; email?: string | null; avatar_url?: string }
interface GitHubEmail   { email: string; primary: boolean; verified: boolean }

export async function fetchProfile(p: Provider, accessToken: string): Promise<NormalizedProfile> {
  const cfg = providerConfig(p)
  if (p === 'google') {
    const r = await fetch(cfg.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!r.ok) throw new Error(`google userinfo ${r.status}`)
    const g = await r.json() as GoogleProfile
    if (!g.email || !g.email_verified) throw new Error('google account has no verified email')
    return {
      providerId: g.sub,
      email: g.email.toLowerCase(),
      displayName: (g.name && g.name.trim()) || g.email.split('@')[0]!,
      avatarUrl: g.picture ?? null,
    }
  }
  // GitHub: /user doesn't expose email when the user hides it. Hit /user/emails
  // and prefer `primary && verified`. A GitHub account can have its primary
  // email unverified while a secondary address is verified (e.g. mid-way
  // through changing their primary) — "verified" is what attests ownership
  // for auto-linking, "primary" is just GitHub's own default-address pick,
  // so fall back to any verified email rather than refusing outright.
  const [userR, emailsR] = await Promise.all([
    fetch(cfg.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'cumora' } }),
    fetch('https://api.github.com/user/emails', { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'cumora' } }),
  ])
  if (!userR.ok) throw new Error(`github user ${userR.status}`)
  if (!emailsR.ok) throw new Error(`github emails ${emailsR.status}`)
  const u = await userR.json() as GitHubProfile
  const emails = await emailsR.json() as GitHubEmail[]
  const verified = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)
  if (!verified) throw new Error('github account has no verified email')
  return {
    providerId: String(u.id),
    email: verified.email.toLowerCase(),
    displayName: (u.name && u.name.trim()) || u.login,
    avatarUrl: u.avatar_url ?? null,
  }
}

/** Common image content types we accept. The Google/GitHub avatar URLs
 *  both serve JPEG today; we still inspect Content-Type so a provider
 *  surprise PNG or WebP doesn't get mis-labeled. Anything outside this
 *  set falls back to the provider URL unchanged. */
const AVATAR_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
}
const AVATAR_MAX_BYTES = 2 * 1024 * 1024  // 2MB — way more than any real avatar
const AVATAR_FETCH_TIMEOUT_MS = 5000

/** Pull the provider's avatar URL down and re-host on Cumora storage so
 *  the renderer fetches from our CDN, not lh3.googleusercontent.com /
 *  avatars.githubusercontent.com. Three wins:
 *    - Provider URL rotation (Google changes the ACg8oc... path when the
 *      user updates their photo) doesn't break us
 *    - Same-origin in the renderer → no third-party CORS / Referer / CSP
 *      surprises, no broken-image races
 *    - One stable URL per user → avatar-cache invalidation is meaningful
 *
 *  Best-effort: any failure (slow fetch, non-image response, oversized
 *  body) returns the original URL so sign-in is never blocked. */
export async function mirrorAvatar(userId: string, providerUrl: string | null): Promise<string | null> {
  if (!providerUrl) return null
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), AVATAR_FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(providerUrl, {
      signal: ctl.signal,
      headers: { 'user-agent': 'cumora' },
    })
    if (!r.ok) return providerUrl
    const mime = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const ext = AVATAR_MIME_TO_EXT[mime]
    if (!ext) return providerUrl
    const ab = await r.arrayBuffer()
    if (ab.byteLength > AVATAR_MAX_BYTES) return providerUrl
    const buf = Buffer.from(ab)
    const key = `avatars/${userId}.${ext}`
    return await storage.put(key, buf, mime)
  } catch (e) {
    console.warn(`[oauth] avatar mirror failed for ${userId}; falling back to provider URL`, e instanceof Error ? e.message : e)
    return providerUrl
  } finally {
    clearTimeout(timer)
  }
}

export interface CompletionResult {
  userId: string
  email: string
  displayName: string
  companyId: string | null
}

/** Signals that the OAuth flow landed on a brand-new user while the
 *  waitlist gate is on. No user row, no session — the callback handler
 *  redirects to a "you're on the waitlist" page instead. */
export class WaitlistedError extends Error {
  constructor(public email: string, public displayName: string) {
    super(`waitlisted: ${email}`)
  }
}

/** Signals that the OAuth flow resolved to an existing user whose account
 *  is currently suspended. No new session is minted — the handler turns
 *  this into a `#suspended=1` redirect so the renderer can show the
 *  "your account has been suspended" screen. The `reason` is the freeform
 *  note the admin attached, surfaced to the user verbatim so they know
 *  what to dispute. May be null when no reason was given. */
export class SuspendedError extends Error {
  constructor(public email: string, public reason: string | null) {
    super(`suspended: ${email}`)
  }
}

/** Step 3 — the meat. Exchange code, fetch profile, find-or-create user,
 *  link the identity, return the session-ready summary. The caller mints
 *  the actual session token + builds the redirect. */
export async function completeFlow(
  p: Provider,
  code: string,
  /** When this OAuth flow started from an invite link, the token is threaded
   *  through state. We use it ONLY to decide whether to auto-create a
   *  personal workspace for net-new users — invited users shouldn't end up
   *  with a stray "Their Name's workspace" they'll never use. The accept
   *  endpoint redeems the actual invite separately. */
  inviteToken: string | null = null,
): Promise<CompletionResult> {
  const accessToken = await exchangeCode(p, code)
  const profile = await fetchProfile(p, accessToken)
  return await findOrCreateUserByProfile(p, profile, inviteToken)
}

/** The find-or-create transaction. Provider-agnostic — works for
 *  Google / GitHub (OAuth2 code exchange path) AND Apple (native
 *  identity_token path). The caller is responsible for getting the
 *  `profile` populated however it can (REST userinfo, JWT claims,
 *  etc.) before invoking this. */
/** Length of the Pro trial granted to net-new users signing up with
 *  Sign in with Apple (the native iOS path — the ONLY signup that gets a
 *  trial). Exists so the App Store review experience (and every fresh
 *  SIWA user) lands in a LIVE workspace — cloud starter agents that
 *  actually respond — instead of free-tier BYOA-only onboarding that asks
 *  them to pair a computer first. The trial-sweep worker downgrades the
 *  tier back to 'free' after expiry. */
const APPLE_SIGNUP_TRIAL_DAYS = 7

export async function findOrCreateUserByProfile(
  p: Provider,
  profile: NormalizedProfile,
  inviteToken: string | null = null,
  /** Grant the Apple-signup Pro trial when this is a brand-new user.
   *  Only the native SIWA route passes true; existing users (Paths A/B)
   *  are never re-granted. */
  appleSignupTrial = false,
): Promise<CompletionResult> {
  // Find-or-create. Race-safe by leaning on (provider, provider_id) PK and
  // (email_lower) lookup inside a single transaction.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Path A: identity already linked → just look up the user.
    {
      const r = await client.query<{ user_id: string }>(
        `SELECT user_id FROM user_identities WHERE provider = $1 AND provider_id = $2`,
        [p, profile.providerId],
      )
      const linked = r.rows[0]?.user_id
      if (linked) {
        await client.query('COMMIT')
        return await finalize(linked, profile)
      }
    }

    // Path B: cross-provider auto-link. We just verified the provider attests
    // to the email's ownership (Google: email_verified=true; GitHub: primary
    // && verified). If we already have a user with that email, link.
    {
      const r = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [profile.email],
      )
      const existing = r.rows[0]?.id
      if (existing) {
        await client.query(
          `INSERT INTO user_identities (provider, provider_id, user_id, email_lower)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (provider, provider_id) DO NOTHING`,
          [p, profile.providerId, existing, profile.email],
        )
        await client.query('COMMIT')
        return await finalize(existing, profile)
      }
    }

    // Path C: brand new user. If the waitlist gate is on AND this email
    // isn't on the bootstrap admin allow-list, enqueue them instead of
    // creating a real account. Admins on the env allow-list bypass the
    // gate so the first deploy can onboard without a chicken-and-egg.
    if (await isWaitlistEnabled() && !isAllowlistedAdmin(profile.email)) {
      await client.query('ROLLBACK').catch(() => {})
      await enqueueWaitlist({
        provider: p,
        providerId: profile.providerId,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
      })
      throw new WaitlistedError(profile.email, profile.displayName)
    }

    // Mint user. Personal-workspace creation is GATED on `inviteToken`:
    // if the OAuth flow started from /invite/<token>, the user is here to
    // join someone *else's* workspace — auto-creating their own would
    // leave a stray "Their Name's workspace" they never wanted (the
    // invite-onboarding bug, pre-fix).
    const userId = `u-${randomUUID().slice(0, 12)}`
    // Apple signups start on a Pro trial (see APPLE_SIGNUP_TRIAL_DAYS) so
    // their first session has working cloud starter agents. Committed with
    // the user row, so the post-commit companyTier() check below sees 'pro'
    // and seeds the cloud starters immediately.
    const trialTier = appleSignupTrial ? 'pro' : 'free'
    await client.query(
      `INSERT INTO users (id, email, display_name, password_hash, email_verified_at, is_admin, tier, pro_trial_expires_at)
         VALUES ($1, $2, $3, NULL, NOW(), $4, $5,
                 CASE WHEN $5 = 'pro' THEN NOW() + make_interval(days => $6) END)`,
      [userId, profile.email, profile.displayName, isAllowlistedAdmin(profile.email), trialTier, APPLE_SIGNUP_TRIAL_DAYS],
    )
    await client.query(
      `INSERT INTO user_identities (provider, provider_id, user_id, email_lower)
         VALUES ($1, $2, $3, $4)`,
      [p, profile.providerId, userId, profile.email],
    )

    // Mirror the provider's avatar to our storage so the renderer fetches
    // from cumora's CDN, not third-party hosts. Falls back to provider
    // URL on failure, then to Gravatar — never empty on first login.
    // Stamp onto users.avatar_url so every workspace this user later joins
    // (via invite or self-created) re-uses ONE face, not per-tenant
    // gravatar fallbacks.
    const mirroredAvatar = await mirrorAvatar(userId, profile.avatarUrl)
    const avatar = mirroredAvatar ?? gravatarUrlForEmail(profile.email)
    await client.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatar, userId])

    let companyId: string | null = null
    if (!inviteToken) {
      companyId = `co-${randomUUID().slice(0, 10)}`
      const slugSeed = (profile.email.split('@')[0] || 'workspace').replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'workspace'
      let finalSlug = slugSeed
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.query(
            `INSERT INTO companies (id, name, slug, owner_user_id) VALUES ($1, $2, $3, $4)`,
            [companyId, `${profile.displayName}'s workspace`, finalSlug, userId],
          )
          break
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (!/duplicate key/.test(msg)) throw e
          finalSlug = `${slugSeed}-${randomUUID().slice(0, 4)}`
        }
      }
      await client.query(
        `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [companyId, userId],
      )
      await client.query(
        `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, avatar_url, status, company_id)
           VALUES ($1, 'human', $2, NULL, $3, '#FF8870', $4, 'avail', $5)
           ON CONFLICT (id, company_id) DO NOTHING`,
        [userId, profile.displayName, profile.displayName.charAt(0).toUpperCase(), avatar, companyId],
      )
    }
    await client.query('COMMIT')

    // Starter agents + all-hands are best-effort — never block first login.
    // Skipped on the invite path: the user is about to land in the inviter's
    // workspace, which already has its own agents + #all-hands.
    if (companyId) {
      // Starter agents are always created ONTO a Computer. Paid tier's
      // Computer is the managed Cumora Cloud (set up now), so seed there
      // immediately. Free tier is BYOA-only — its starters are deferred until
      // the user pairs their own computer (POST /api/computers/pair).
      try {
        if ((await companyTier(companyId)) !== 'free') {
          await ensureCloudComputer(companyId)
          await onboardStarterAgents(companyId, { computerId: cloudComputerId(companyId), engine: 'managed' })
        }
      } catch (e) { console.warn('[oauth] starter onboarding failed', e) }
      try { await joinAllHands({ companyId, participantId: userId }) } catch (e) { console.warn('[oauth] join all-hands failed', e) }
    }

    // Mirror the user into sub2api so their LLM calls land on a
    // per-user quota counter from now on. Pool query is outside the
    // create transaction so a sub2api hiccup never rolls back signup.
    // A future backfill can pick up users whose sub2api_user_id stays
    // NULL (sub2api was down at signup time).
    if (sub2apiConfigured()) {
      try {
        const r = await provisionSub2apiUser({
          cumoraUserId: userId,
          email: profile.email,
          displayName: profile.displayName,
          tier: trialTier,
        })
        await pool.query(
          `UPDATE users SET sub2api_user_id = $1, sub2api_api_key = $2 WHERE id = $3`,
          [r.sub2apiUserId, r.apiKey, userId],
        )
      } catch (e) {
        console.warn(`[oauth] sub2api provisioning failed for ${userId}; legacy fallback`, e instanceof Error ? e.message : e)
      }
    }

    return { userId, email: profile.email, displayName: profile.displayName, companyId }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Shared finalization: bump last_login + return the company summary so the
 *  callback handler can mint a session + 302 to AUTH_DONE_URL.
 *
 *  Suspension gate lives here — both Path A (existing identity) and Path B
 *  (cross-provider auto-link) funnel through this function, so one check
 *  blocks every returning-user path without us having to repeat it. We
 *  read suspended_at + suspension_reason in the same UPDATE round-trip:
 *  UPDATE on a suspended user is harmless (last_login_at on a suspended
 *  account is fine to bump — it shows the admin "they tried"), and the
 *  RETURNING clause hands us the suspension status atomically with no
 *  TOCTOU window between two SELECTs. */
async function finalize(userId: string, profile: NormalizedProfile): Promise<CompletionResult> {
  const { rows: bump } = await pool.query<{
    suspended_at: string | null; suspension_reason: string | null
  }>(
    `UPDATE users SET last_login_at = NOW()
      WHERE id = $1
      RETURNING suspended_at, suspension_reason`,
    [userId],
  )
  if (bump[0]?.suspended_at) {
    throw new SuspendedError(profile.email, bump[0].suspension_reason)
  }
  const { rows } = await pool.query<{ company_id: string }>(
    `SELECT company_id FROM company_members WHERE user_id = $1 ORDER BY joined_at ASC LIMIT 1`,
    [userId],
  )
  return {
    userId,
    email: profile.email,
    displayName: profile.displayName,
    companyId: rows[0]?.company_id ?? null,
  }
}

/** Construct the final redirect URL the browser is sent to after a
 *  successful callback. Token + companyId go in the URL fragment so they
 *  never reach server access logs / Referer headers. `base` is the
 *  client-supplied return URL (already validated) or the server default. */
export function doneUrl(base: string, token: string, companyId: string | null): string {
  const frag = new URLSearchParams({ token })
  if (companyId) frag.set('companyId', companyId)
  return `${base}#${frag.toString()}`
}

/** Convenience for the callback handler: trade the code, mint a session,
 *  audit, return the done URL. The `returnUrl` came from the state row
 *  (already validated against the allow-list at /auth/start time); when
 *  absent we fall back to env.AUTH_DONE_URL.
 *
 *  Three terminal states besides "success":
 *   - WaitlistedError: brand-new user while the waitlist gate is on —
 *     enqueued, no session minted; redirect `#waitlist=1`.
 *   - SuspendedError: returning user whose account is currently suspended
 *     — no session minted; redirect `#suspended=1&reason=<admin note>`.
 *   - any other throw bubbles up; the caller surfaces `#error=…`. */
export async function handleCallback(args: {
  provider: Provider; code: string; returnUrl: string | null
  ip: string | null; userAgent: string | null
  /** Signed-in user has a pending invite. When set, completeFlow skips
   *  the auto-create-workspace step for net-new users — the accept
   *  endpoint plants them straight into the inviter's company instead. */
  inviteToken?: string | null
}): Promise<string> {
  let result: CompletionResult
  try {
    result = await completeFlow(args.provider, args.code, args.inviteToken ?? null)
  } catch (e) {
    if (e instanceof WaitlistedError) {
      await audit({
        kind: 'signup_waitlisted',
        ip: args.ip,
        userAgent: args.userAgent,
        detail: { provider: args.provider, email: e.email },
      })
      return waitlistUrl(args.returnUrl ?? env.AUTH_DONE_URL, e.email)
    }
    if (e instanceof SuspendedError) {
      // Suspended-user login attempt is interesting to track — it tells the
      // admin "they tried to come back" and is the audit trail of forced
      // logouts being meaningful. No session is minted; the renderer shows
      // the suspension screen with the admin's reason.
      await audit({
        kind: 'login_suspended',
        ip: args.ip,
        userAgent: args.userAgent,
        detail: { provider: args.provider, email: e.email, reason: e.reason },
      })
      return suspendedUrl(args.returnUrl ?? env.AUTH_DONE_URL, e.email, e.reason)
    }
    throw e
  }
  const { token } = await createSession(result.userId, {
    ip: args.ip ?? undefined, ua: args.userAgent ?? undefined,
  })
  await audit({
    kind: 'login',
    userId: result.userId,
    companyId: result.companyId,
    ip: args.ip,
    userAgent: args.userAgent,
    detail: { provider: args.provider, email: result.email },
  })
  return doneUrl(args.returnUrl ?? env.AUTH_DONE_URL, token, result.companyId)
}

/** Native Sign in with Apple — the iOS app already drove the
 *  ASAuthorization flow, got an `identity_token` JWT from Apple, and
 *  POSTs it here. We verify the JWT, find-or-create the user, and
 *  return a freshly-minted session token + companyId as JSON. No
 *  browser redirect involved (this is a fetch from the native app).
 *
 *  Apple-specific subtleties handled here:
 *   - Apple's standalone credential metadata is first-authorization-only;
 *     the signed JWT normally keeps carrying email while name remains
 *     client metadata. Returning users resolve solely through the persisted
 *     `sub` identity; an unlinked user must present a verified email claim in
 *     the signed token. Client-provided names never participate in identity
 *     matching. */
export async function handleAppleNativeSignIn(args: {
  identityToken: string
  /** Name passed from the JS layer on FIRST sign-in only. Used only
   *  when creating a brand-new user row. */
  fallbackName?: string | null
  /** Bundle id(s) the JWT's `aud` must match — usually just our app's
   *  bundle id. Passed in so the test/dev shell can override. */
  audiences: string[]
  /** Pending invite token, if the sign-in started from an /invite/...
   *  link. Same semantics as the Google/GitHub callback. */
  inviteToken?: string | null
  ip: string | null
  userAgent: string | null
}): Promise<{ token: string; userId: string; email: string; displayName: string; companyId: string | null }> {
  const { resolveTrustedAppleEmail, verifyAppleIdentityToken } = await import('./apple.js')
  const claims = await verifyAppleIdentityToken(args.identityToken, args.audiences)
  // Resolve the stable identity first. Returning users do not need an email
  // claim; first sign-ins may create/cross-link an account only from Apple's
  // signed, verified claim — never from request-body metadata.
  const linked = await pool.query<{ email_lower: string }>(
    `SELECT email_lower FROM user_identities
      WHERE provider = $1 AND provider_id = $2`,
    ['apple', claims.sub],
  )
  const knownEmail = linked.rows[0]?.email_lower ?? null
  const email = resolveTrustedAppleEmail({
    linkedEmail: knownEmail,
    tokenEmail: claims.email,
    tokenEmailVerified: claims.emailVerified,
  })
  const displayName = (args.fallbackName ?? email.split('@')[0] ?? 'You').trim() || 'You'

  let result: CompletionResult
  try {
    // Native SIWA route — the only signup path that grants the Pro trial.
    result = await findOrCreateUserByProfile('apple', {
      providerId: claims.sub,
      email,
      displayName,
      avatarUrl: null,
    }, args.inviteToken ?? null, true)
  } catch (e) {
    if (e instanceof WaitlistedError) {
      await audit({
        kind: 'signup_waitlisted',
        ip: args.ip, userAgent: args.userAgent,
        detail: { provider: 'apple', email: e.email },
      })
      throw e
    }
    if (e instanceof SuspendedError) {
      await audit({
        kind: 'login_suspended',
        ip: args.ip, userAgent: args.userAgent,
        detail: { provider: 'apple', email: e.email, reason: e.reason },
      })
      throw e
    }
    throw e
  }
  const { token } = await createSession(result.userId, {
    ip: args.ip ?? undefined, ua: args.userAgent ?? undefined,
  })
  await audit({
    kind: 'login',
    userId: result.userId,
    companyId: result.companyId,
    ip: args.ip, userAgent: args.userAgent,
    detail: { provider: 'apple', email: result.email },
  })
  return {
    token,
    userId: result.userId,
    email: result.email,
    displayName: result.displayName,
    companyId: result.companyId,
  }
}

/** Sibling to doneUrl/errorUrl. `?waitlist=1&email=...` tells the
 *  renderer to show the "you're on the waitlist" screen.
 *
 *  Why query string AND fragment: email isn't a secret (the user just
 *  signed in with it; it's already in the server's audit log), and
 *  fragments are quietly dropped by some browsers/proxies on cross-origin
 *  302s — when that happened the loopback HTML's JS saw neither token nor
 *  waitlist and rendered the wildly misleading "No session token" screen.
 *  Query strings survive redirects unconditionally, so the new shape puts
 *  the signal in the query. We keep the hash fragment as a transitional
 *  duplicate so older client builds (that still only parse `location.hash`)
 *  don't regress against a server that's been upgraded first. */
export function waitlistUrl(base: string, email: string): string {
  const params = new URLSearchParams({ waitlist: '1', email })
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${params.toString()}#${params.toString()}`
}

/** `#suspended=1&email=...&reason=...` — the renderer shows a
 *  "your account has been suspended" screen with the admin's reason.
 *  Reason is optional; we only set it on the fragment when present so the
 *  URL stays clean when it's null. */
export function suspendedUrl(base: string, email: string, reason: string | null): string {
  const frag = new URLSearchParams({ suspended: '1', email })
  if (reason) frag.set('reason', reason)
  return `${base}#${frag.toString()}`
}

/** Used by the callback's failure path. Same shape as doneUrl but with
 *  `&error=...` so the renderer can surface a message. */
export function errorUrl(base: string | null, error: string): string {
  const target = base ?? env.AUTH_DONE_URL
  const frag = new URLSearchParams({ error })
  return `${target}#${frag.toString()}`
}
