import { createHash, randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { redis } from '../redis.js'
import { wakeAgent } from './scheduler.js'
import type { AgentTurnOptions } from './turn.js'

interface ScanRecentMessage {
  message_id: string
  conversation_id: string
  conversation_title: string
  author_name: string
  body: string
}

interface BackgroundScanAgent {
  id: string
  name: string
  role: string | null
  bio: string | null
  company_id: string
}

/**
 * Only one replica scans per tick.
 *
 * Every replica used to run the full pass every 90s: the agent roster query,
 * an unread probe and a recent-activity query per agent, plus a roster load
 * for each one that qualified — all of it duplicated R times for a result only
 * one of them needed to produce. The dedup set below is per-process, so it
 * could not stop the duplicate LLM wakes either.
 *
 * `pg_try_advisory_lock` is the same shape `llm-rollup.ts` uses for the same
 * reason: no lease table, no leader election protocol, and a replica that dies
 * mid-pass releases the lock with its session rather than blocking the next
 * tick. Distinct from migrate's SCHEMA_LOCK_KEY (7_643_178_926_104n) and the
 * rollup's ROLLUP_LOCK_KEY (7_643_178_926_211n).
 */
const SCANNER_LOCK_KEY = 7_643_178_926_318n

const SCANNER_MIN_MESSAGES = 8
const SCANNER_WINDOW_HOURS = 24

/**
 * Cross-replica dedup claim TTL. Matched to SCANNER_WINDOW_HOURS: a
 * fingerprint names a specific set of recent messages, and once those age out
 * of the window they can never be re-proposed, so the claim has nothing left
 * to protect.
 */
const SCAN_CLAIM_TTL_SECONDS = SCANNER_WINDOW_HOURS * 3600

/**
 * Local accelerator only — Redis holds the truth.
 *
 * This was an unbounded `Set` of raw fingerprints, and a fingerprint carries up
 * to 80 message ids (~3KB). At roughly 960 eligible passes per agent per day
 * with nothing ever evicted, it grew for the lifetime of the process. Now it
 * stores 64-char digests under a fixed cap, so the memory ceiling is ~32KB
 * regardless of tenant count or uptime.
 */
const PRECEDENT_SCAN_CACHE_LIMIT = 512
const PRECEDENT_SCANS = new Map<string, true>()

/** Fingerprints are up to ~3KB of message ids; the digest is what we keep and
 *  what becomes the Redis key, so neither store scales with activity volume. */
function scanDigest(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex')
}

function precedentHas(digest: string): boolean {
  if (!PRECEDENT_SCANS.has(digest)) return false
  // Touch: Map preserves insertion order, so re-inserting moves this entry to
  // the young end and the eviction below stays true LRU rather than FIFO.
  PRECEDENT_SCANS.delete(digest)
  PRECEDENT_SCANS.set(digest, true)
  return true
}

function precedentRemember(digest: string): void {
  PRECEDENT_SCANS.delete(digest)
  PRECEDENT_SCANS.set(digest, true)
  while (PRECEDENT_SCANS.size > PRECEDENT_SCAN_CACHE_LIMIT) {
    const oldest = PRECEDENT_SCANS.keys().next()
    if (oldest.done) break
    PRECEDENT_SCANS.delete(oldest.value)
  }
}

/**
 * Has any replica already woken an agent for this exact activity?
 *
 * Fails OPEN: a Redis outage degrades dedup to the local cache, which the
 * leader lock keeps meaningful — one scanner at a time means the worst case is
 * a repeat after the lock moves to a different replica, not R simultaneous
 * wakes. Refusing to scan instead would silently disable the feature for the
 * duration of the outage.
 */
async function scanAlreadyClaimed(digest: string): Promise<boolean> {
  try {
    return (await redis.exists(`cumora:scan:${digest}`)) === 1
  } catch (e) {
    console.warn('[scanner] claim lookup failed — falling back to local cache',
      e instanceof Error ? e.message : e)
    return false
  }
}

/** Recorded only after a wake is accepted, mirroring how the local cache and
 *  the audit row are spent — a dropped wake must stay retryable. */
async function claimScan(digest: string): Promise<void> {
  try {
    await redis.set(`cumora:scan:${digest}`, '1', 'EX', SCAN_CLAIM_TTL_SECONDS)
  } catch (e) {
    console.warn('[scanner] claim write failed — other replicas may repeat this scan',
      e instanceof Error ? e.message : e)
  }
}

type WakeScannerAgentFn = typeof wakeAgent

let wakeScannerAgent: WakeScannerAgentFn = wakeAgent
let scannerRunning = false

export function __setBackgroundScannerWakeForTesting(fn: WakeScannerAgentFn | null): void {
  wakeScannerAgent = fn ?? wakeAgent
}
const BACKGROUND_SCAN_CAPABILITIES = ['background.scan']

/** Async because the cross-replica claims outlive the process: a leftover
 *  24h key from a previous run would otherwise make the next run's first pass
 *  silently skip the agent it is trying to assert on. */
export async function _resetBackgroundScannerForTests(): Promise<void> {
  PRECEDENT_SCANS.clear()
  wakeScannerAgent = wakeAgent
  scannerRunning = false
  try {
    const stale = await redis.keys('cumora:scan:*')
    if (stale.length > 0) await redis.del(...stale)
  } catch { /* no Redis in this test env — the local cache clear is enough */ }
}

/** Exported so a test can drive the eviction boundary without 512 real scans. */
export const __scannerCacheInternals = {
  limit: PRECEDENT_SCAN_CACHE_LIMIT,
  digest: scanDigest,
  has: precedentHas,
  remember: precedentRemember,
  clear: (): void => PRECEDENT_SCANS.clear(),
  size: (): number => PRECEDENT_SCANS.size,
}

async function loadBackgroundScanAgents(): Promise<BackgroundScanAgent[]> {
  const { rows } = await pool.query<BackgroundScanAgent>(
    `SELECT id, name, role, bio, company_id
       FROM participants p
      WHERE p.kind = 'agent'
        AND p.departed_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(COALESCE(p.tools, '[]'::jsonb)) AS tool(value)
           WHERE tool.value = ANY($1::text[])
        )
      ORDER BY p.company_id, p.name`,
    [BACKGROUND_SCAN_CAPABILITIES],
  )
  return rows
}

async function agentHasUnreadInbox(agentId: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE EXISTS (
                SELECT 1 FROM conversation_members cm
                 WHERE cm.conversation_id = c.id
                   AND cm.company_id = c.company_id
                   AND cm.participant_id = $1
              )
          AND m.author_id <> $1
          AND ROW(m.created_at, m.id) > (
            SELECT
              COALESCE(cr.last_read_at, '1970-01-01T00:00:00Z'::timestamptz),
              COALESCE(cr.last_read_message_id, '')
              FROM (SELECT 1) AS _
              LEFT JOIN conversation_reads cr
                ON cr.user_id = $1 AND cr.conversation_id = c.id
          )
        LIMIT 1
     ) AS exists`,
    [agentId],
  )
  return Boolean(rows[0]?.exists)
}

async function loadRecentActivity(companyId: string): Promise<ScanRecentMessage[]> {
  const { rows } = await pool.query<ScanRecentMessage>(
    `SELECT
        m.id AS message_id,
        m.conversation_id,
        c.title AS conversation_title,
        COALESCE(p.name, m.author_id) AS author_name,
        m.body
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = c.company_id
      WHERE c.kind = 'group'
        AND m.kind = 'text'
        AND c.company_id = $1
        AND m.created_at > NOW() - ($2 || ' hours')::interval
      ORDER BY m.created_at DESC
      LIMIT 80`,
    [companyId, String(SCANNER_WINDOW_HOURS)],
  )
  return rows
}

async function loadRoster(companyId: string): Promise<Array<{ id: string; name: string; role: string | null; kind: string }>> {
  const { rows } = await pool.query<{ id: string; name: string; role: string | null; kind: string }>(
    `SELECT id, name, role, kind
       FROM participants
      WHERE company_id = $1 AND departed_at IS NULL
      ORDER BY kind DESC, name ASC`,
    [companyId],
  )
  return rows
}

function renderActivitySummary(rows: ScanRecentMessage[]): string {
  const byConvo: Record<string, { title: string; lines: string[] }> = {}
  for (const r of rows) {
    if (!byConvo[r.conversation_id]) byConvo[r.conversation_id] = { title: r.conversation_title, lines: [] }
    byConvo[r.conversation_id].lines.push(`[${r.message_id}] ${r.author_name}: ${r.body.slice(0, 240)}`)
  }
  return Object.entries(byConvo)
    .map(([id, v]) => `# ${v.title} (${id})\n${v.lines.slice(0, 12).reverse().join('\n')}`)
    .join('\n\n')
}

function buildBackgroundScanBrief(args: {
  agent: BackgroundScanAgent
  roster: Array<{ id: string; name: string; role: string | null; kind: string }>
  recent: ScanRecentMessage[]
}): string {
  const agentIds = args.roster
    .filter((r) => r.kind === 'agent')
    .map((r) => `${r.id}${r.role ? ` (${r.role})` : ''}`)
    .join(', ') || '(none)'
  const humanIds = args.roster
    .filter((r) => r.kind === 'human')
    .map((r) => `${r.id}${r.role ? ` (${r.role})` : ''}`)
    .join(', ') || '(none)'

  return `You are ${args.agent.name}${args.agent.role ? `, ${args.agent.role}` : ''}. You have the background.scan capability, so the runtime is giving you recent company activity to inspect.

This is not a direct user request. Default to no action. Only interrupt people when your own persona and judgment say there is a concrete, timely reason.

If you pull a group, use the normal tool yourself:
  bash("cumora pull-group '<title>' --members id1,id2,id3 --reason '<why now>' --say '<opening message with concrete evidence>'")

For brand / voice / cross-project collision scans, require specific evidence:
- quote at least two concrete message snippets or message ids from different parts of the activity
- explain the collision in plain language
- include only the people who can actually resolve it

Available agents: ${agentIds}
Available humans: ${humanIds}

Recent group activity from the last ${SCANNER_WINDOW_HOURS} hours:

${renderActivitySummary(args.recent)}`
}

async function recordScanWake(agent: BackgroundScanAgent, fingerprint: string): Promise<void> {
  await pool.query(
    `INSERT INTO agent_log (id, agent_id, company_id, kind, body, ref)
     VALUES ($1, $2, $3, 'note', $4, $5::jsonb)`,
    [
      `log-${randomUUID().slice(0, 12)}`,
      agent.id,
      agent.company_id,
      `background scan wake queued for ${agent.name}`,
      JSON.stringify({
        source: 'background_scanner',
        capability: 'background.scan',
        fingerprint,
      }),
    ],
  )
}

/**
 * One scanning pass. Assumes the caller holds the leader lock — call
 * `runBackgroundScans()` unless you are a test driving the pass directly.
 */
export async function scanOnce(): Promise<void> {
  const agents = await loadBackgroundScanAgents()
  const inFlight = new Set<string>()
  for (const agent of agents) {
    try {
      if (await agentHasUnreadInbox(agent.id)) continue

      const recent = await loadRecentActivity(agent.company_id)
      if (recent.length < SCANNER_MIN_MESSAGES) continue

      const fingerprint = `${agent.company_id}|${agent.id}|${recent.map((r) => r.message_id).sort().join('|')}`
      const digest = scanDigest(fingerprint)
      if (precedentHas(digest) || inFlight.has(digest)) continue
      // The local cache is empty on every fresh process, so without this a
      // restart — or the lock simply moving to another replica — re-woke every
      // agent for activity that had already been scanned.
      if (await scanAlreadyClaimed(digest)) {
        precedentRemember(digest)
        continue
      }
      inFlight.add(digest)

      try {
        const roster = await loadRoster(agent.company_id)
        const brief = buildBackgroundScanBrief({ agent, roster, recent })
        const backgroundBrief: NonNullable<AgentTurnOptions['backgroundBrief']> = {
          source: 'background_scanner',
          title: 'Recent company activity scan',
          body: brief,
        }
        const woken = await wakeScannerAgent(agent.id, 'background_scan', null, null, {
          backgroundBrief,
        })
        if (woken === false) {
          // Budget exceeded or wake dropped — do not record or spend the fingerprint,
          // so the next pass can re-evaluate as intended.
          continue
        }
        precedentRemember(digest)
        await claimScan(digest)
        await recordScanWake(agent, fingerprint)
      } finally {
        inFlight.delete(digest)
      }
    } catch (e) {
      console.warn(`[scanner] background scan failed for ${agent.id}`, e)
    }
  }
}

/**
 * Claim the scanner role for this tick, then scan. A replica that loses the
 * race does nothing — the work is not sharded, so a second pass would only
 * repeat queries the holder is already running.
 */
export async function runBackgroundScans(): Promise<void> {
  const client = await pool.connect()
  try {
    const lock = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS ok', [SCANNER_LOCK_KEY],
    )
    if (lock.rows[0]?.ok !== true) return
    try {
      await scanOnce()
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCANNER_LOCK_KEY])
        .catch(() => { /* session teardown releases it anyway */ })
    }
  } finally {
    client.release()
  }
}

/** Periodic kick — call from server boot. */
export function startScanner(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    if (scannerRunning) {
      console.warn('[scanner] previous background scan pass still running — skipping tick')
      return
    }
    scannerRunning = true
    runBackgroundScans()
      .catch((e) => console.error('[scanner]', e))
      .finally(() => {
        scannerRunning = false
      })
  }, intervalMs)
}
