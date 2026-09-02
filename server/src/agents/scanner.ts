import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
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

const PRECEDENT_SCANS = new Set<string>()

let wakeScannerAgent: typeof wakeAgent = wakeAgent

export function __setBackgroundScannerWakeForTesting(fn: typeof wakeAgent | null): void {
  wakeScannerAgent = fn ?? wakeAgent
}
const SCANNER_MIN_MESSAGES = 8
const SCANNER_WINDOW_HOURS = 24
const BACKGROUND_SCAN_CAPABILITIES = ['background.scan']

export function _resetBackgroundScannerForTests(): void {
  PRECEDENT_SCANS.clear()
  wakeScannerAgent = wakeAgent
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

export async function runBackgroundScans(): Promise<void> {
  const agents = await loadBackgroundScanAgents()
  for (const agent of agents) {
    try {
      if (await agentHasUnreadInbox(agent.id)) continue

      const recent = await loadRecentActivity(agent.company_id)
      if (recent.length < SCANNER_MIN_MESSAGES) continue

      const fingerprint = `${agent.company_id}|${agent.id}|${recent.map((r) => r.message_id).sort().join('|')}`
      if (PRECEDENT_SCANS.has(fingerprint)) continue
      PRECEDENT_SCANS.add(fingerprint)

      const roster = await loadRoster(agent.company_id)
      const brief = buildBackgroundScanBrief({ agent, roster, recent })
      await recordScanWake(agent, fingerprint)
      const backgroundBrief: NonNullable<AgentTurnOptions['backgroundBrief']> = {
        source: 'background_scanner',
        title: 'Recent company activity scan',
        body: brief,
      }
      await wakeScannerAgent(agent.id, 'background_scan', null, null, {
        backgroundBrief,
      })
    } catch (e) {
      console.warn(`[scanner] background scan failed for ${agent.id}`, e)
    }
  }
}

/** Periodic kick — call from server boot. */
export function startScanner(intervalMs: number): NodeJS.Timeout {
  return setInterval(() => {
    runBackgroundScans().catch((e) => console.error('[scanner]', e))
  }, intervalMs)
}
