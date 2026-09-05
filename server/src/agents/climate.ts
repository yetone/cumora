/**
 * Climate auto-update — server-side hooks that nudge an agent's
 * `agent_climate` row in response to ambient events (reactions, mentions,
 * etc.). Without these, climate is only ever written by an agent's own
 * `cumora climate note` call, which means it goes stale fast.
 *
 * Design notes:
 * - Climate is FROM the agent's perspective: row keyed `(agent_id, about_id)`
 *   means "what agent_id feels about about_id". So when X reacts to Y's
 *   message, we bump Y.climate[X], not the other way around.
 * - Only AGENTS have climate. If `about_id` is a human, we still record
 *   (an agent's feelings about a teammate, human or otherwise, are valid).
 *   But the "agent_id" side MUST be an agent — humans don't have feelings
 *   stored in this system.
 * - Self-climate is meaningless and would clutter — skip when from === about.
 * - Increments are SMALL (0.02–0.08 typical). Even a barrage of reactions
 *   takes dozens to grind affinity to ±1, so it stays meaningful.
 */
import { pool } from '../db/pool.js'

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

interface BumpArgs {
  /** Whose feelings are being adjusted (must be an agent). */
  agentId: string
  /** Subject of those feelings — can be human or agent. */
  aboutId: string
  /** Signed deltas. Caller passes raw deltas; we clamp the resulting state. */
  affinity?: number
  trust?: number
  /** Optional short rationale appended to `last_note`. */
  note?: string
}

/**
 * Atomic upsert + clamp. Cheap — single SQL roundtrip + a guard SELECT
 * to skip when the agent_id isn't actually an agent (humans don't get
 * climate rows). Never throws on caller; logs and swallows on failure.
 */
export async function bumpClimate(args: BumpArgs): Promise<void> {
  const { agentId, aboutId, affinity = 0, trust = 0, note } = args
  if (!agentId || !aboutId) return
  if (agentId === aboutId) return  // self-climate is noise
  if (affinity === 0 && trust === 0) return

  try {
    // Guard: only insert/update climate WHEN agent_id refers to an agent.
    // (Reaction events fire for human authors too; skip those.)
    const { rows: part } = await pool.query<{ kind: string; company_id: string | null }>(
      `SELECT kind, company_id FROM participants WHERE id = $1 LIMIT 1`, [agentId],
    )
    if (!part[0] || part[0].kind !== 'agent') return
    const tenant = part[0].company_id ?? 'personal'

    await pool.query(
      `INSERT INTO agent_climate (agent_id, about_id, company_id, affinity, trust, last_note, updated_at)
       VALUES ($1, $2, $3,
               GREATEST(-1, LEAST(1, $4::real)),
               GREATEST(-1, LEAST(1, $5::real)),
               $6, NOW())
       ON CONFLICT (agent_id, about_id) DO UPDATE
          SET company_id = EXCLUDED.company_id,
              affinity = GREATEST(-1, LEAST(1, agent_climate.affinity + $4::real)),
              trust    = GREATEST(-1, LEAST(1, agent_climate.trust    + $5::real)),
              last_note = COALESCE($6, agent_climate.last_note),
              updated_at = NOW()`,
      [agentId, aboutId, tenant, clamp(affinity), clamp(trust), note ?? null],
    )
  } catch (e) {
    console.warn('[climate] bump failed', e)
  }
}

/** Pull every agent_id mentioned in a body and bump their climate toward
 *  the speaker. Used by the message-create path. Returns the matched ids
 *  (so the caller can also surface them in audit logs / diagnostics). */
export async function bumpClimateFromMentions(args: {
  body: string
  speakerId: string
  companyId: string
}): Promise<string[]> {
  const { body, speakerId, companyId } = args
  // Parse `@<id>` mentions. Same regex shape as the client-side parseBody().
  const re = /@([A-Za-z][\w-]*)/g
  const ids = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) ids.add(m[1])
  if (ids.size === 0) return []

  const list = [...ids]
  const { rows } = await pool.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM participants
      WHERE id = ANY($1::text[]) AND company_id = $2`,
    [list, companyId],
  )
  const matched = rows.filter((r) => r.kind === 'agent' && r.id !== speakerId)
  for (const r of matched) {
    // Being @-mentioned by someone is mild positive engagement.
    await bumpClimate({
      agentId: r.id,
      aboutId: speakerId,
      affinity: 0.04,
      trust: 0.02,
      note: `@-mentioned by ${speakerId}`,
    })
  }
  return matched.map((r) => r.id)
}
