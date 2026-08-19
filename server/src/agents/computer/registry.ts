/**
 * Computer registry — server-side state + auth for BYOA "Computers".
 *
 * A Computer is the host an agent runs on (see docs/BYOA.md). Cumora Cloud
 * is the built-in managed computer; the user pairs their own machines (a
 * Mac, a VPS) which run the `cumora agent computer` daemon and a local
 * engine (Claude Code / Codex).
 *
 * This module owns the data-access + credential plumbing so the route
 * layer (api/router.ts) stays thin and this logic stays unit-testable:
 *   - pairing tokens (persistent, DB-backed, company-scoped or computer-scoped)
 *   - device tokens (opaque, hashed at rest in computers.credential_hash;
 *     revocable by setting computers.revoked_at)
 *   - per-agent runtime JWTs minted for a paired device (reuses
 *     runtime/jwt.ts — the same token a pod gets)
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { pool } from '../../db/pool.js'
import { publish, CH_STATUS } from '../../redis.js'
import { signAgentToken } from '../runtime/jwt.js'

export type ComputerKind = 'cloud' | 'local' | 'vps'
export type EngineId = 'managed' | 'claude' | 'codex'
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
  await publish(CH_STATUS, { type: 'computers.status', computerId, status, companyId })
}

/** Announce a just-paired computer as online. Split out from {@link pairComputer}
 *  so the /pair route can defer it until AFTER the starter team is seeded — the
 *  desktop flips its onboarding gate on this event and immediately reloads its
 *  roster, so the agents + "Everyone" group must already exist when it fires. */
export async function announceComputerOnline(computerId: string, companyId: string): Promise<void> {
  await broadcastComputerStatus(computerId, companyId, 'online')
}

/** Engines a paired (non-cloud) computer is allowed to advertise. */
const PAIRABLE_ENGINES: ReadonlySet<string> = new Set(['claude', 'codex'])

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
  const version = typeof args.version === 'string' && args.version ? args.version.slice(0, 32) : null
  const supervised = typeof args.supervised === 'boolean' ? args.supervised : null
  const deviceToken = randomBytes(32).toString('base64url')
  const reportedName = (args.hostName ?? '').slice(0, 80)
  const name = reportedName || 'My computer'

  const exact = await pool.query<{ id: string; company_id: string }>(
    `SELECT id, company_id FROM computers
      WHERE pair_token = $1 AND kind <> 'cloud' AND revoked_at IS NULL
      LIMIT 1`,
    [args.code],
  )
  if (exact.rows[0]) {
    const { id, company_id: companyId } = exact.rows[0]
    await pool.query(
      `UPDATE computers
          SET credential_hash = $1, available_engines = $2::jsonb,
              name = COALESCE(NULLIF($3, ''), name),
              daemon_version = COALESCE($5, daemon_version),
              daemon_supervised = COALESCE($6, daemon_supervised),
              status = 'online', last_seen_at = NOW(), paired_at = NOW()
        WHERE id = $4`,
      [hashToken(deviceToken), JSON.stringify(engines), reportedName, id, version, supervised],
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
              status = 'online', last_seen_at = NOW(), paired_at = NOW(), revoked_at = NULL
        WHERE id = $3`,
      [hashToken(deviceToken), JSON.stringify(engines), id, version, supervised],
    )
    if (!args.deferBroadcast) await broadcastComputerStatus(id, companyId, 'online')
    return { computerId: id, companyId, deviceToken }
  }

  const computerId = `comp-${randomUUID().slice(0, 12)}`
  await pool.query(
    `INSERT INTO computers
       (id, company_id, owner_user_id, name, kind, available_engines, status, credential_hash, paired_at, last_seen_at, daemon_version, daemon_supervised)
     VALUES ($1, $2, $3, $4, 'local', $5::jsonb, 'online', $6, NOW(), NOW(), $7, $8)`,
    [computerId, companyId, ownerUserId, name, JSON.stringify(engines), hashToken(deviceToken), version, supervised],
  )
  if (!args.deferBroadcast) await broadcastComputerStatus(computerId, companyId, 'online')
  return { computerId, companyId, deviceToken }
}

/** Daemon liveness ping. Bumps last_seen_at + the reported version; flips
 *  offline→online and broadcasts only on the transition (so a steady heartbeat
 *  is quiet). The version lets the app flag outdated daemons. */
export async function heartbeatComputer(computerId: string, version?: string, supervised?: boolean): Promise<void> {
  const v = typeof version === 'string' && version ? version.slice(0, 32) : null
  const sup = typeof supervised === 'boolean' ? supervised : null
  const bumped = await pool.query(
    `UPDATE computers SET last_seen_at = NOW(), daemon_version = COALESCE($2, daemon_version),
            daemon_supervised = COALESCE($3, daemon_supervised)
      WHERE id = $1 AND revoked_at IS NULL AND status = 'online' RETURNING 1`,
    [computerId, v, sup],
  )
  if (bumped.rowCount) return // already online — quiet bump
  const { rows } = await pool.query<{ company_id: string }>(
    `UPDATE computers SET status = 'online', last_seen_at = NOW(), daemon_version = COALESCE($2, daemon_version),
            daemon_supervised = COALESCE($3, daemon_supervised)
      WHERE id = $1 AND revoked_at IS NULL RETURNING company_id`,
    [computerId, v, sup],
  )
  if (rows[0]) await broadcastComputerStatus(computerId, rows[0].company_id, 'online')
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
 *  as CUMORA_AGENT_RUNTIME_TOKEN for the `cumora` shim. */
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
 *  (CUMORA_DEFAULT_CLAUDE_MODEL / CUMORA_DEFAULT_CODEX_MODEL) so every BYOA
 *  daemon gets a consistent pin — independent of whatever model the local
 *  `claude` / `codex` CLI happens to default to today. Critical: a model
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
  return rows.map((r) => {
    if (r.model) return r
    const dflt = r.engine === 'codex' ? codexDefault : r.engine === 'claude' ? claudeDefault : null
    return dflt ? { ...r, model: dflt } : r
  })
}

/** All computers visible to a company (Cumora Cloud + the user's paired ones),
 *  each annotated with whether its daemon is outdated vs the latest published
 *  cumora version — so the app can surface an upgrade banner. */
export async function listComputers(companyId: string): Promise<ComputerWithUpgrade[]> {
  const { rows } = await pool.query<ComputerRow>(
    `SELECT id, company_id, owner_user_id, name, kind, available_engines, status,
            last_seen_at, paired_at, revoked_at, created_at, daemon_version, daemon_supervised
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
}): Promise<{ kind: ComputerKind; engine: EngineId } | null> {
  const { rows } = await pool.query<{ kind: ComputerKind; available_engines: string[] }>(
    `SELECT kind, available_engines FROM computers
      WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL LIMIT 1`,
    [args.computerId, args.companyId],
  )
  const computer = rows[0]
  if (!computer) return null

  let engine: EngineId
  if (computer.kind === 'cloud') {
    engine = 'managed'
  } else {
    const advertised = computer.available_engines ?? []
    const requested = args.engine && PAIRABLE_ENGINES.has(args.engine) ? (args.engine as EngineId) : null
    const pick = (requested && advertised.includes(requested) ? requested : advertised[0]) as EngineId | undefined
    if (!pick) return null // a paired computer with no usable engine
    engine = pick
  }

  const { rowCount } = await pool.query(
    `UPDATE participants SET computer_id = $1, engine = $2
      WHERE id = $3 AND company_id = $4 AND kind = 'agent'`,
    [args.computerId, engine, args.agentId, args.companyId],
  )
  if (!rowCount) return null
  return { kind: computer.kind, engine }
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
