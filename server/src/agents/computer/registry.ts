/**
 * Computer registry — server-side state + auth for BYOA "Computers".
 *
 * A Computer is the host an agent runs on (see docs/BYOA.md). Cumora Cloud
 * is the built-in managed computer; the user pairs their own machines (a
 * Mac, a VPS) which run the `cumora agent computer` daemon and a local
 * engine (Claude Code / Codex / Grok Build / Cursor Agent / OpenCode).
 *
 * This module owns the data-access + credential plumbing so the route
 * layer (api/router.ts) stays thin and this logic stays unit-testable:
 *   - pairing tokens (persistent, DB-backed, company-scoped or computer-scoped)
 *   - device tokens (opaque, hashed at rest in computers.credential_hash;
 *     revocable by setting computers.revoked_at)
 *   - per-agent runtime JWTs minted for a paired device (reuses
 *     runtime/jwt.ts — the same token a pod gets)
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pool } from '../../db/pool.js'
import { CH_STATUS, publish } from '../../redis.js'
import { signAgentToken } from '../runtime/jwt.js'

export type ComputerKind = 'cloud' | 'local' | 'vps'
export type EngineId = 'managed' | 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'pi' | 'gemini' | 'qwen' | 'antigravity'
export type ComputerStatus = 'online' | 'offline' | 'busy'

/** How long a paired computer can go without a heartbeat before the sweep
 *  marks it offline. The daemon heartbeats every ~30s. */
export const COMPUTER_STALE_MS = 90_000

/** Broadcast a computer's status to its company's WS clients. Mirrors
 *  status.ts's participant-status broadcast: same channel, companyId-tagged
 *  so the WS bridge fans it only to that tenant. */
async function broadcastComputerStatus(
  computerId: string, companyId: string, status: ComputerStatus,
): Promise<void> {
  await publish(CH_STATUS, { type: 'computers.status', computerId, status, companyId }).catch((error) => {
    console.warn(
      `[computer] durable ${computerId}=${status} update committed but publish failed`,
      error,
    )
  })
}

/** Announce a just-paired computer as online. Split out from {@link pairComputer}
 *  so the /pair route can defer it until AFTER the starter team is seeded — the
 *  desktop flips its onboarding gate on this event and immediately reloads its
 *  roster, so the agents + "Everyone" group must already exist when it fires. */
export async function announceComputerOnline(computerId: string, companyId: string): Promise<void> {
  await broadcastComputerStatus(computerId, companyId, 'online')
}

/** Engines a paired (non-cloud) computer is allowed to advertise.
 *
 *  Spelled as a Record over the engine union rather than a Set literal so the
 *  COMPILER is what notices a new engine, not a reviewer: adding an id to
 *  EngineId makes this fail to compile until the id is classified here. A
 *  plain `new Set([...])` accepted an incomplete list silently, and the engine
 *  left out of it could be detected and shown but never actually paired. */
const PAIRABLE: Record<Exclude<EngineId, 'managed'>, true> = {
  claude: true, codex: true, grok: true, cursor: true, opencode: true, pi: true, gemini: true,
  qwen: true,
  antigravity: true,
}
const PAIRABLE_ENGINES: ReadonlySet<string> = new Set<string>(Object.keys(PAIRABLE))

type Queryable = {
  query<T extends object = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

/** Merge a fresh PATH detection into a computer's advertised engine list.
 *
 *  `available_engines[0]` is the computer's DEFAULT — pairComputer's comment
 *  puts it plainly: "first = default", and it decides the engine for the starter
 *  team and for any agent assigned without an explicit override. So a re-detect
 *  must never reorder silently: if the current default is still installed it
 *  stays first, and the rest follow detection order. Installing a new CLI adds
 *  it to the tail; uninstalling one drops it.
 *
 *  Returns null when there is nothing to write — a fully-unknown detection or a
 *  list identical to what is stored. An explicitly empty detection is valid:
 *  the daemon only reports it after a successful scan, so it means the final
 *  supported CLI was uninstalled and the stale inventory must be cleared.
 *
 *  Exported for tests. */
export function mergeDetectedEngines(current: string[], detected: string[]): string[] | null {
  const fresh = detected.filter((e) => PAIRABLE_ENGINES.has(e))
  // Non-empty but entirely unknown means a newer daemon is naming only engines
  // this server cannot run yet. Do not let that compatibility case wipe known
  // state; [] itself remains a trustworthy, successful empty PATH scan.
  if (detected.length > 0 && fresh.length === 0) return null
  const seen = new Set<string>()
  const next: string[] = []
  const currentDefault = current[0]
  // Keep the default pinned to the front while it is still installed.
  if (currentDefault && fresh.includes(currentDefault)) { next.push(currentDefault); seen.add(currentDefault) }
  for (const e of fresh) { if (!seen.has(e)) { next.push(e); seen.add(e) } }
  const same = next.length === current.length && next.every((e, i) => e === current[i])
  return same ? null : next
}

const ENGINE_BINS: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  grok: 'grok',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  pi: 'pi',
  gemini: 'gemini',
  qwen: 'qwen',
  antigravity: 'agy',
}

/** Cached PATH snapshot from the daemon. The app reads this; it never probes. */
export interface DetectedEngine {
  id: string
  bin: string
  path: string | null
  /** Version of this engine as installed on the reporting computer, the newest
   *  one upstream, and how to update it there. Absent when reported by a daemon
   *  older than the version probe, or when the probe could not read a version —
   *  the app renders the path alone rather than guessing. */
  version?: string | null
  latest?: string | null
  outdated?: boolean
  updateCommand?: string | null
  /** Why Cumora will not drive this engine even though it is installed here —
   *  "version 2.0.9 is older than the secure minimum 2.1.248", "missing sandbox
   *  dependency: bubblewrap (bwrap)". Absent when the engine is runnable.
   *
   *  This travels because the person reading the card is usually not sitting at
   *  the machine it describes — the same reason the version fields do. The
   *  daemon knew the reason all along and only wrote it to its own stdout, so
   *  an engine could vanish from a computer with no explanation anywhere the
   *  operator was looking. */
  blockedReason?: string | null
}

/** Trim a daemon-reported display string, or drop it. Control characters are
 *  stripped so a version line can never smuggle newlines into the update
 *  command the Me page offers the user to copy and run. */
function displayString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean ? clean.slice(0, max) : null
}

function sanitizeVersionFields(rec: Record<string, unknown>): Partial<DetectedEngine> {
  const version = displayString(rec.version, 64)
  const latest = displayString(rec.latest, 64)
  const updateCommand = displayString(rec.updateCommand, 200)
  return {
    version,
    latest,
    // Never take the daemon's word for it over data we can check ourselves: a
    // stale `outdated: true` with both versions equal would nag forever.
    outdated: rec.outdated === true && !!version && !!latest && version !== latest,
    updateCommand,
  }
}

/** An engine we know is advertised but have no PATH/version report for. */
function unreportedEngine(id: string): DetectedEngine {
  return {
    id, bin: ENGINE_BINS[id] ?? id, path: null,
    version: null, latest: null, outdated: false, updateCommand: null, blockedReason: null,
  }
}

/**
 * Shape the daemon's PATH report for storage and display.
 *
 * `runnableIds` are the engines the daemon will actually wake; `blockedIds` are
 * installed but refused, and appear ONLY here. That separation is the safety
 * property of this function: `available_engines` is what picks an agent's
 * adapter, so a blocked engine reaching it would run the very thing the
 * sandbox gate declined. Blocked ids are therefore never returned to the
 * caller as runnable and never influence `ordered` — they ride along as extra
 * display rows carrying the reason they were refused.
 */
export function sanitizeDetectedEngines(
  raw: unknown,
  engineIds: string[],
  blockedIds: string[] = [],
): DetectedEngine[] {
  const runnable = engineIds.filter((id) => PAIRABLE_ENGINES.has(id))
  const blocked = blockedIds.filter((id) => PAIRABLE_ENGINES.has(id) && !runnable.includes(id))
  const allowed = [...runnable, ...blocked]
  if (!Array.isArray(raw)) return allowed.map(unreportedEngine)
  const byId = new Map<string, DetectedEngine>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const id = typeof rec.id === 'string' ? rec.id : ''
    if (!PAIRABLE_ENGINES.has(id) || !allowed.includes(id)) continue
    const bin = typeof rec.bin === 'string' && rec.bin.trim() ? rec.bin.trim() : (ENGINE_BINS[id] ?? id)
    const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path.trim() : null
    // A reason is only meaningful on an engine we actually refused. Accepting
    // one on a runnable engine would let a daemon mark a working engine broken.
    const blockedReason = blocked.includes(id) ? displayString(rec.blockedReason, 200) : null
    byId.set(id, { id, bin, path, ...sanitizeVersionFields(rec), blockedReason })
  }
  // Every row carries the same keys, reported or not, so the app never has to
  // distinguish "field absent" from "nothing installed to report".
  return allowed.map((id) => byId.get(id) ?? unreportedEngine(id))
}

export interface ComputerRow {
  id: string
  company_id: string
  owner_user_id: string | null
  name: string
  kind: ComputerKind
  available_engines: string[]
  status: 'online' | 'offline' | 'busy'
  last_seen_at: string | null
  paired_at: string | null
  revoked_at: string | null
  created_at: string
  /** The cumora daemon's reported version; NULL for cloud or a pre-version daemon. */
  daemon_version: string | null
  /** TRUE = runs under the --install-service supervisor (launchd/systemd),
   *  FALSE = a manually-run foreground command, NULL = cloud / an old daemon
   *  that doesn't report it. Drives run-mode-specific update instructions. */
  daemon_supervised: boolean | null
  detected_engines: DetectedEngine[]
  engines_detected_at: string | null
  detect_requested_at: string | null
}

/** A computer plus the computed upgrade signal the app uses to show the banner. */
export interface ComputerWithUpgrade extends ComputerRow {
  /** The newest published cumora version (npm 'latest'), or null if unknown. */
  latest_daemon_version: string | null
  /** True iff this is a BYOA daemon running behind the latest version (or one so
   *  old it never reported a version). Cloud computers are never outdated. */
  daemon_outdated: boolean
}

/** semver-ish "a > b" over dotted numbers. Pre-release/build tags are ignored
 *  (we only ship plain x.y.z), so a bare numeric compare is enough. */
function versionGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}

// Newest published cumora version, cached so listComputers doesn't hit npm on
// every call. Refreshes hourly; fail-safe (keeps the last good value, or null
// when never fetched — and null means we never flag anyone outdated).
let latestCache: { version: string | null; at: number } = { version: null, at: 0 }
const LATEST_TTL_MS = 60 * 60 * 1000
async function getLatestDaemonVersion(): Promise<string | null> {
  const now = Date.now()
  if (latestCache.version && now - latestCache.at < LATEST_TTL_MS) return latestCache.version
  try {
    const res = await fetch('https://registry.npmjs.org/cumora/latest', { headers: { Accept: 'application/json' } })
    if (res.ok) {
      const v = (await res.json() as { version?: string })?.version
      if (typeof v === 'string' && v) latestCache = { version: v, at: now }
    }
  } catch { /* offline — keep the last good value */ }
  return latestCache.version
}

const AGENT_TOKEN_TTL_SECONDS = 2 * 60 * 60 // 2h; daemon refreshes before expiry

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** Deterministic id for a company's managed Cumora Cloud computer, so it can
 *  be resolved without a lookup and stays idempotent across migrations. */
export function cloudComputerId(companyId: string): string {
  return `cloud-${companyId}`
}

/** Idempotently create the managed Cumora Cloud computer for a company.
 *  Called at company-creation time (the migration back-fills existing ones). */
export async function ensureCloudComputer(companyId: string): Promise<void> {
  await pool.query(
    `INSERT INTO computers (id, company_id, name, kind, available_engines, status)
     VALUES ($1, $2, 'Cumora Cloud', 'cloud', '["managed"]'::jsonb, 'online')
     ON CONFLICT (id) DO NOTHING`,
    [cloudComputerId(companyId), companyId],
  )
}

/** Return the company's persistent add-computer token, minting it once on first
 *  request. Unlike the old short-lived Redis code, this never expires, so a
 *  historical "add a computer" command (`--pair <token>`) stays usable. The
 *  token maps to exactly one company; a computer paired with it can only join
 *  that company. No computer row is created here. */
export async function issuePairingCode(args: {
  companyId: string
  ownerUserId: string
  computerId?: string | null
}): Promise<{ code: string; expiresInSeconds: number | null }> {
  const { rows } = await pool.query<{ pair_token: string | null }>(
    `SELECT pair_token FROM companies WHERE id = $1`, [args.companyId],
  )
  let token = rows[0]?.pair_token ?? null
  if (!token) {
    const fresh = randomBytes(24).toString('base64url') // ~32 chars, long for safety
    // Set only if still null so concurrent issuers converge on one token.
    await pool.query(`UPDATE companies SET pair_token = $1 WHERE id = $2 AND pair_token IS NULL`, [fresh, args.companyId])
    const r2 = await pool.query<{ pair_token: string | null }>(`SELECT pair_token FROM companies WHERE id = $1`, [args.companyId])
    token = r2.rows[0]?.pair_token ?? fresh
  }
  return { code: token, expiresInSeconds: null }
}

/** Return a persistent reconnect token for one existing non-cloud computer.
 *  Unlike the company add token, this token is bound to the computer row itself,
 *  so running the command from the Computer detail view re-attaches that exact
 *  Computer and keeps its agents. */
export async function issueRepairCode(args: {
  companyId: string
  ownerUserId: string
  computerId: string
}): Promise<{ code: string; expiresInSeconds: number | null } | null> {
  const { rows } = await pool.query<{ pair_token: string | null }>(
    `SELECT pair_token FROM computers WHERE id = $1 AND company_id = $2 AND kind <> 'cloud' AND revoked_at IS NULL LIMIT 1`,
    [args.computerId, args.companyId],
  )
  if (!rows[0]) return null
  let token = rows[0].pair_token
  if (!token) {
    const fresh = randomBytes(24).toString('base64url')
    await pool.query(
      `UPDATE computers SET pair_token = $1 WHERE id = $2 AND company_id = $3 AND pair_token IS NULL`,
      [fresh, args.computerId, args.companyId],
    )
    const r2 = await pool.query<{ pair_token: string | null }>(
      `SELECT pair_token FROM computers WHERE id = $1 AND company_id = $2`,
      [args.computerId, args.companyId],
    )
    token = r2.rows[0]?.pair_token ?? fresh
  }
  return { code: token, expiresInSeconds: null }
}

/** Redeem a persistent pairing token. Computer-specific reconnect tokens update
 *  that exact row. Company add-computer tokens create a row or re-attach by
 *  hostname to avoid duplicates when the same machine runs the command again. */
export async function pairComputer(args: {
  code: string
  hostName?: string
  engines?: string[]
  /** Optional PATH snapshot from the daemon (bin + resolved path). */
  detected?: unknown
  /** Installed engines the daemon refused to run, so the card can say why from
   *  the very first pairing rather than only after the next PATH rescan — which
   *  is minutes later, and right after pairing is exactly when "why is only
   *  codex here?" gets asked. Display-only; never joins available_engines. */
  blocked?: string[]
  /** The daemon's running version, stored so the app can flag outdated daemons. */
  version?: string
  /** Whether the daemon runs supervised (service) vs. as a foreground command. */
  supervised?: boolean
  /** Skip the online WS broadcast so the caller can fire it later (e.g. after
   *  seeding the starter team). The DB row is still marked online; only the
   *  client-facing notification is deferred. Caller must then call
   *  {@link announceComputerOnline}. */
  deferBroadcast?: boolean
}): Promise<{ computerId: string; companyId: string; deviceToken: string } | null> {
  const engines = (args.engines ?? []).filter((e) => PAIRABLE_ENGINES.has(e))
  const blocked = args.blocked ?? []
  const detected = sanitizeDetectedEngines(args.detected, engines, blocked)
  const detectedJson = JSON.stringify(detected)
  const version = typeof args.version === 'string' && args.version ? args.version.slice(0, 32) : null
  const supervised = typeof args.supervised === 'boolean' ? args.supervised : null
  const deviceToken = randomBytes(32).toString('base64url')
  const reportedName = (args.hostName ?? '').slice(0, 80)
  const name = reportedName || 'My computer'

  const exact = await pool.query<{ id: string; company_id: string; available_engines: string[] }>(
    `SELECT id, company_id, available_engines FROM computers
      WHERE pair_token = $1 AND kind <> 'cloud' AND revoked_at IS NULL
      LIMIT 1`,
    [args.code],
  )
  if (exact.rows[0]) {
    const { id, company_id: companyId, available_engines: currentEngines } = exact.rows[0]
    // A reconnect is an inventory refresh, not a default-engine change. Keep
    // the existing default first while it is still installed; if it vanished,
    // mergeDetectedEngines naturally falls back to the daemon's scan order.
    const orderedEngines = mergeDetectedEngines(currentEngines ?? [], engines) ?? (currentEngines ?? [])
    const reconnectDetectedJson = JSON.stringify(sanitizeDetectedEngines(args.detected, orderedEngines, blocked))
    await pool.query(
      `UPDATE computers
          SET credential_hash = $1, available_engines = $2::jsonb,
              name = COALESCE(NULLIF($3, ''), name),
              daemon_version = COALESCE($5, daemon_version),
              daemon_supervised = COALESCE($6, daemon_supervised),
              detected_engines = $7::jsonb, engines_detected_at = NOW(), detect_requested_at = NULL,
              status = 'online', last_seen_at = NOW(), paired_at = NOW()
        WHERE id = $4`,
      [hashToken(deviceToken), JSON.stringify(orderedEngines), reportedName, id, version, supervised, reconnectDetectedJson],
    )
    if (!args.deferBroadcast) await broadcastComputerStatus(id, companyId, 'online')
    return { computerId: id, companyId, deviceToken }
  }

  const { rows } = await pool.query<{ company_id: string; owner_user_id: string | null }>(
    `SELECT id AS company_id, owner_user_id FROM companies WHERE pair_token = $1 LIMIT 1`,
    [args.code],
  )
  if (!rows[0]) return null
  const companyId = rows[0].company_id
  const ownerUserId = rows[0].owner_user_id

  // Re-attach if a non-cloud computer with this hostname already exists in the
  // company — a re-run of the (now persistent) command from the same machine.
  // Re-mint the device token + refresh engines/status; never create a duplicate.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM computers
       WHERE company_id = $1 AND kind <> 'cloud' AND revoked_at IS NULL AND name = $2
       ORDER BY paired_at DESC NULLS LAST LIMIT 1`,
    [companyId, name],
  )
  if (existing.rows[0]) {
    const id = existing.rows[0].id
    await pool.query(
      `UPDATE computers
          SET credential_hash = $1, available_engines = $2::jsonb,
              daemon_version = COALESCE($4, daemon_version),
              daemon_supervised = COALESCE($5, daemon_supervised),
              detected_engines = $6::jsonb, engines_detected_at = NOW(), detect_requested_at = NULL,
              status = 'online', last_seen_at = NOW(), paired_at = NOW(), revoked_at = NULL
        WHERE id = $3`,
      [hashToken(deviceToken), JSON.stringify(engines), id, version, supervised, detectedJson],
    )
    if (!args.deferBroadcast) await broadcastComputerStatus(id, companyId, 'online')
    return { computerId: id, companyId, deviceToken }
  }

  const computerId = `comp-${randomUUID().slice(0, 12)}`
  await pool.query(
    `INSERT INTO computers
       (id, company_id, owner_user_id, name, kind, available_engines, status, credential_hash, paired_at, last_seen_at, daemon_version, daemon_supervised, detected_engines, engines_detected_at)
     VALUES ($1, $2, $3, $4, 'local', $5::jsonb, 'online', $6, NOW(), NOW(), $7, $8, $9::jsonb, NOW())`,
    [computerId, companyId, ownerUserId, name, JSON.stringify(engines), hashToken(deviceToken), version, supervised, detectedJson],
  )
  if (!args.deferBroadcast) await broadcastComputerStatus(computerId, companyId, 'online')
  return { computerId, companyId, deviceToken }
}

/** Daemon liveness ping. Bumps last_seen_at + the reported version; flips
 *  offline→online and broadcasts only on the transition (so a steady heartbeat
 *  is quiet). The version lets the app flag outdated daemons. */
export async function heartbeatComputer(
  computerId: string,
  version?: string,
  supervised?: boolean,
  detectedEngines?: string[],
): Promise<boolean> {
  const v = typeof version === 'string' && version ? version.slice(0, 32) : null
  const sup = typeof supervised === 'boolean' ? supervised : null
  // Liveness is the primary heartbeat contract. Refreshing the optional PATH
  // inventory must not run first: one transient read failure used to reject the
  // whole request, so a healthy daemon could be swept offline even though its
  // heartbeat reached the server.
  const bumped = await pool.query<{ detect_requested_at: string | null }>(
    `UPDATE computers SET last_seen_at = NOW(), daemon_version = COALESCE($2, daemon_version),
            daemon_supervised = COALESCE($3, daemon_supervised)
      WHERE id = $1 AND revoked_at IS NULL AND status = 'online' RETURNING detect_requested_at`,
    [computerId, v, sup],
  )
  let detectRequested = Boolean(bumped.rows[0]?.detect_requested_at)
  if (!bumped.rowCount) {
    const { rows } = await pool.query<{ company_id: string; detect_requested_at: string | null }>(
      `UPDATE computers SET status = 'online', last_seen_at = NOW(), daemon_version = COALESCE($2, daemon_version),
              daemon_supervised = COALESCE($3, daemon_supervised)
        WHERE id = $1 AND revoked_at IS NULL RETURNING company_id, detect_requested_at`,
      [computerId, v, sup],
    )
    detectRequested = Boolean(rows[0]?.detect_requested_at)
    if (rows[0]) await broadcastComputerStatus(computerId, rows[0].company_id, 'online')
  }

  // Keep the advertised engine list current WITHOUT a re-pair. This secondary
  // refresh is best-effort: a database hiccup here must not turn a successful
  // liveness update into an HTTP 500. Only paired computers participate; a
  // cloud computer advertises 'managed' and has no PATH inventory.
  if (detectedEngines) {
    try {
      const { rows } = await pool.query<{ available_engines: string[]; kind: ComputerKind }>(
        `SELECT available_engines, kind FROM computers WHERE id = $1 AND revoked_at IS NULL`,
        [computerId],
      )
      const row = rows[0]
      if (row && row.kind !== 'cloud') {
        const next = mergeDetectedEngines(row.available_engines ?? [], detectedEngines)
        if (next) {
          await pool.query(
            `UPDATE computers SET available_engines = $2::jsonb WHERE id = $1 AND revoked_at IS NULL`,
            [computerId, JSON.stringify(next)],
          )
        }
      }
    } catch (err) {
      console.warn('[computers] heartbeat engine refresh failed:', err instanceof Error ? err.message : err)
    }
  }
  return detectRequested
}

/** Mark paired computers offline once their heartbeat goes stale, and
 *  broadcast each transition. Cloud computers are always-on (skipped).
 *  Runs on a server interval. */
export async function sweepOfflineComputers(staleMs = COMPUTER_STALE_MS): Promise<void> {
  const { rows } = await pool.query<{ id: string; company_id: string }>(
    `UPDATE computers SET status = 'offline'
      WHERE kind <> 'cloud' AND status = 'online'
        AND (last_seen_at IS NULL OR last_seen_at < NOW() - ($1::int * interval '1 millisecond'))
      RETURNING id, company_id`,
    [staleMs],
  )
  for (const r of rows) await broadcastComputerStatus(r.id, r.company_id, 'offline')
}

/** Resolve a device token (Bearer) to its computer. Rejects revoked devices.
 *  Bumps last_seen_at as a cheap liveness heartbeat. */
export async function resolveDevice(token: string): Promise<{ computerId: string; companyId: string } | null> {
  if (!token) return null
  const { rows } = await pool.query<{ id: string; company_id: string }>(
    `UPDATE computers SET last_seen_at = NOW()
      WHERE credential_hash = $1 AND revoked_at IS NULL
      RETURNING id, company_id`,
    [hashToken(token)],
  )
  if (!rows[0]) return null
  return { computerId: rows[0].id, companyId: rows[0].company_id }
}

/** Mint a short-lived per-agent runtime JWT for a paired device — but only if
 *  the agent is actually assigned to that device's computer (same company).
 *  This is the credential the daemon uses for the agent's wake-stream SSE and
 *  daemon-side runtime calls. It never enters the model process or agent home. */
export async function mintAgentRuntimeToken(args: {
  computerId: string
  agentId: string
}): Promise<{ token: string; expiresInSeconds: number } | null> {
  const { rows } = await pool.query<{ company_id: string | null }>(
    `SELECT company_id FROM participants
      WHERE id = $1 AND kind = 'agent' AND computer_id = $2 LIMIT 1`,
    [args.agentId, args.computerId],
  )
  if (!rows[0]) return null
  const token = signAgentToken({
    agentId: args.agentId,
    companyId: rows[0].company_id,
    ttlSeconds: AGENT_TOKEN_TTL_SECONDS,
  })
  return { token, expiresInSeconds: AGENT_TOKEN_TTL_SECONDS }
}

/** Agents assigned to a computer — the daemon's discovery list on boot.
 *  Includes the per-agent big-brain (`model`) + small-brain (`fastModel`)
 *  overrides so the daemon can pass them to the engine.
 *
 *  When a row has no explicit model, fall back to the deploy-level default
 *  (CUMORA_DEFAULT_CLAUDE_MODEL / CUMORA_DEFAULT_CODEX_MODEL /
 *  CUMORA_DEFAULT_GROK_MODEL / CUMORA_DEFAULT_CURSOR_MODEL /
 *  CUMORA_DEFAULT_OPENCODE_MODEL / CUMORA_DEFAULT_PI_MODEL /
 *  CUMORA_DEFAULT_ANTIGRAVITY_MODEL) so every BYOA
 *  daemon gets a consistent pin — independent of whatever model the local
 *  engine CLI happens to default to today. Critical: a model
 *  upgrade in the underlying CLI (e.g. claude 4.7 → 4.8) silently changes
 *  agent behavior on every user's machine unless we pin here. */
export async function listAgentsForComputer(computerId: string): Promise<
  Array<{ id: string; name: string; role: string | null; systemPrompt: string | null; engine: EngineId | null; model: string | null; fastModel: string | null }>
> {
  const { rows } = await pool.query<{ id: string; name: string; role: string | null; systemPrompt: string | null; engine: EngineId | null; model: string | null; fastModel: string | null }>(
    `SELECT id, name, role, system_prompt AS "systemPrompt", engine, model, fast_model AS "fastModel" FROM participants
      WHERE computer_id = $1 AND kind = 'agent' AND departed_at IS NULL
      ORDER BY name ASC`,
    [computerId],
  )
  const claudeDefault = process.env.CUMORA_DEFAULT_CLAUDE_MODEL?.trim() || null
  const codexDefault = process.env.CUMORA_DEFAULT_CODEX_MODEL?.trim() || null
  const grokDefault = process.env.CUMORA_DEFAULT_GROK_MODEL?.trim() || null
  const cursorDefault = process.env.CUMORA_DEFAULT_CURSOR_MODEL?.trim() || null
  const openCodeDefault = process.env.CUMORA_DEFAULT_OPENCODE_MODEL?.trim() || null
  const piDefault = process.env.CUMORA_DEFAULT_PI_MODEL?.trim() || null
  const antigravityDefault = process.env.CUMORA_DEFAULT_ANTIGRAVITY_MODEL?.trim() || null
  return rows.map((r) => {
    if (r.model) return r
    const dflt = r.engine === 'codex'
      ? codexDefault
      : r.engine === 'claude'
        ? claudeDefault
        : r.engine === 'grok'
          ? grokDefault
          : r.engine === 'cursor'
            ? cursorDefault
            : r.engine === 'opencode'
              ? openCodeDefault
              : r.engine === 'pi'
                ? piDefault
                : r.engine === 'antigravity'
                  ? antigravityDefault
                : null
    return dflt ? { ...r, model: dflt } : r
  })
}

/** All computers visible to a company (Cumora Cloud + the user's paired ones),
 *  each annotated with whether its daemon is outdated vs the latest published
 *  cumora version — so the app can surface an upgrade banner. */
export async function listComputers(companyId: string): Promise<ComputerWithUpgrade[]> {
  const { rows } = await pool.query<ComputerRow>(
    `SELECT id, company_id, owner_user_id, name, kind, available_engines, status,
            last_seen_at, paired_at, revoked_at, created_at, daemon_version, daemon_supervised,
            COALESCE(detected_engines, '[]'::jsonb) AS detected_engines,
            engines_detected_at, detect_requested_at
       FROM computers
      WHERE company_id = $1 AND revoked_at IS NULL
      ORDER BY (kind = 'cloud') DESC, created_at ASC`,
    [companyId],
  )
  const latest = await getLatestDaemonVersion()
  return rows.map((r) => ({
    ...r,
    latest_daemon_version: latest,
    // Only BYOA daemons can be outdated, and only when we actually know the
    // latest. A daemon that never reported a version (NULL) is pre-feature →
    // definitionally old → outdated.
    daemon_outdated:
      r.kind !== 'cloud' && latest != null &&
      (r.daemon_version == null || versionGt(latest, r.daemon_version)),
  }))
}

export interface AgentHost {
  /** kind of computer the agent runs on, or null if unassigned (treat as cloud). */
  kind: ComputerKind | null
  /** the agent's company — lets the scheduler check the company's tier. */
  companyId: string | null
}

/** Resolve where an agent runs + its company. Not cached: this sits on the
 *  scheduler's cold path (wakeOne only calls it for a resting agent with no
 *  live subscriber), and it's a single indexed lookup — a PK probe on
 *  participants + a PK LEFT JOIN on computers. An in-process cache here would
 *  be both pointless (cold path) and unsafe (each replica caches independently,
 *  so reassignments/tier changes go stale per-pod). LEFT JOIN so an unassigned
 *  agent (computer_id NULL) still returns its companyId with a null kind. */
export async function resolveAgentHost(agentId: string): Promise<AgentHost> {
  const { rows } = await pool.query<{ kind: ComputerKind | null; company_id: string | null }>(
    `SELECT c.kind, p.company_id FROM participants p
       LEFT JOIN computers c ON c.id = p.computer_id
      WHERE p.id = $1 AND p.kind = 'agent' LIMIT 1`,
    [agentId],
  )
  return { kind: rows[0]?.kind ?? null, companyId: rows[0]?.company_id ?? null }
}

/** A BYOA host (user-paired) runs a daemon, not a server-managed pod. */
export function isByoaKind(kind: ComputerKind | null): boolean {
  return kind === 'local' || kind === 'vps'
}

/** Resolve and lock a valid Computer placement without mutating an Agent.
 *
 * Creation uses this inside the participant INSERT transaction so a rejected
 * or revoked Computer can never leave behind an unassigned Agent. Existing
 * assignment callers retain their historical fallback behavior; creation sets
 * `strictEngine` so an unavailable explicit pin fails instead of silently
 * selecting the Computer default. */
export async function resolveComputerAssignment(args: {
  companyId: string
  computerId: string
  engine?: string
  /** When true (or when no engine is named), follow the computer default. */
  inherit?: boolean
  strictEngine?: boolean
}, db: Queryable = pool): Promise<{ kind: ComputerKind; engine: EngineId; inherit: boolean } | null> {
  const { rows } = await db.query<{ kind: ComputerKind; available_engines: string[] }>(
    `SELECT kind, available_engines FROM computers
      WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
      LIMIT 1 FOR SHARE`,
    [args.computerId, args.companyId],
  )
  const computer = rows[0]
  if (!computer) return null

  let engine: EngineId
  let inherit = false
  if (computer.kind === 'cloud') {
    engine = 'managed'
    inherit = false
  } else {
    const advertised = computer.available_engines ?? []
    const wantInherit = args.inherit === true || !args.engine
    const requested = args.engine && PAIRABLE_ENGINES.has(args.engine) ? (args.engine as EngineId) : null
    if (!wantInherit && args.strictEngine && (!requested || !advertised.includes(requested))) {
      return null
    }
    const pick = (
      wantInherit
        ? advertised[0]
        : (requested && advertised.includes(requested) ? requested : advertised[0])
    ) as EngineId | undefined
    if (!pick) return null // a paired computer with no usable engine
    engine = pick
    inherit = wantInherit
  }

  return { kind: computer.kind, engine, inherit }
}

/** Assign an agent to a computer (move it between Cumora Cloud and a paired
 *  machine). Resolves the engine: 'managed' for cloud, else the requested
 *  engine if the computer advertises it, else the computer's first engine.
 *  Returns the resolved { kind, engine } or null if the computer/agent is
 *  invalid for this company. */
export async function assignAgentToComputer(args: {
  agentId: string
  companyId: string
  computerId: string
  engine?: string
  /** When true (or when no engine is named), follow the computer default. */
  inherit?: boolean
}): Promise<{ kind: ComputerKind; engine: EngineId; inherit: boolean } | null> {
  const placement = await resolveComputerAssignment(args)
  if (!placement) return null

  const { rowCount } = await pool.query(
    `UPDATE participants SET computer_id = $1, engine = $2, engine_inherit = $3
      WHERE id = $4 AND company_id = $5 AND kind = 'agent'`,
    [args.computerId, placement.engine, placement.inherit, args.agentId, args.companyId],
  )
  if (!rowCount) return null
  return placement
}

/** Ask the online daemon to re-probe PATH on its next heartbeat. */
export async function requestEngineDetect(args: {
  computerId: string
  companyId: string
}): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE computers SET detect_requested_at = NOW()
      WHERE id = $1 AND company_id = $2 AND kind <> 'cloud' AND revoked_at IS NULL`,
    [args.computerId, args.companyId],
  )
  return Boolean(rowCount)
}

/** Daemon reports a fresh PATH snapshot. Keeps the current default first when
 *  that engine is still installed. */
export async function reportDetectedEngines(args: {
  computerId: string
  engines?: string[]
  detected?: unknown
  /** Installed engines the daemon refused to run. Display-only — they are
   *  deliberately kept out of `available_engines`, which chooses adapters. */
  blocked?: string[]
}): Promise<boolean> {
  const { rows } = await pool.query<{ available_engines: string[]; company_id: string }>(
    `SELECT available_engines, company_id FROM computers
      WHERE id = $1 AND kind <> 'cloud' AND revoked_at IS NULL LIMIT 1`,
    [args.computerId],
  )
  const row = rows[0]
  if (!row) return false
  const incoming = (args.engines ?? []).filter((e) => PAIRABLE_ENGINES.has(e))
  const prevDefault = (row.available_engines ?? []).find((e) => PAIRABLE_ENGINES.has(e))
  const ordered = prevDefault && incoming.includes(prevDefault)
    ? [prevDefault, ...incoming.filter((e) => e !== prevDefault)]
    : incoming
  const detected = sanitizeDetectedEngines(args.detected, ordered, args.blocked ?? [])
  await pool.query(
    `UPDATE computers
        SET available_engines = $2::jsonb,
            detected_engines = $3::jsonb,
            engines_detected_at = NOW(),
            detect_requested_at = NULL
      WHERE id = $1`,
    [args.computerId, JSON.stringify(ordered), JSON.stringify(detected)],
  )
  await broadcastComputerStatus(args.computerId, row.company_id, 'online')
  return true
}

/** Make `engine` this computer's default and move every inheriting agent onto it. */
export async function setComputerDefaultEngine(args: {
  computerId: string
  companyId: string
  engine: string
}): Promise<{ engine: EngineId; updated: number } | null> {
  if (!PAIRABLE_ENGINES.has(args.engine)) return null
  const { rows } = await pool.query<{ available_engines: string[]; detected_engines: DetectedEngine[] }>(
    `SELECT available_engines, COALESCE(detected_engines, '[]'::jsonb) AS detected_engines
       FROM computers
      WHERE id = $1 AND company_id = $2 AND kind <> 'cloud' AND revoked_at IS NULL LIMIT 1`,
    [args.computerId, args.companyId],
  )
  const computer = rows[0]
  if (!computer) return null
  const advertised = computer.available_engines ?? []
  if (!advertised.includes(args.engine)) return null
  const engine = args.engine as EngineId
  const ordered = [engine, ...advertised.filter((e) => e !== engine)]
  const detected = sanitizeDetectedEngines(computer.detected_engines, ordered)
  await pool.query(
    `UPDATE computers
        SET available_engines = $2::jsonb, detected_engines = $3::jsonb
      WHERE id = $1`,
    [args.computerId, JSON.stringify(ordered), JSON.stringify(detected)],
  )
  const moved = await pool.query(
    `UPDATE participants SET engine = $1
      WHERE computer_id = $2 AND company_id = $3 AND kind = 'agent'
        AND departed_at IS NULL AND engine_inherit = TRUE`,
    [engine, args.computerId, args.companyId],
  )
  await broadcastComputerStatus(args.computerId, args.companyId, 'online')
  return { engine, updated: moved.rowCount ?? 0 }
}

/** Revoke a paired computer: the device token + every derived agent JWT stop
 *  working, and its agents go offline. Cloud computers cannot be revoked. */
export async function revokeComputer(args: { computerId: string; companyId: string }): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE computers SET revoked_at = NOW(), status = 'offline', credential_hash = NULL
      WHERE id = $1 AND company_id = $2 AND kind <> 'cloud' AND revoked_at IS NULL`,
    [args.computerId, args.companyId],
  )
  if (!rowCount) return false
  await broadcastComputerStatus(args.computerId, args.companyId, 'offline')
  return true
}
