/**
 * Idle / heartbeat scheduler.
 *
 * The scheduler does not decide what an agent should say. It only picks one
 * quiet agent per tenant and gives the normal turn loop a synthetic idle wake.
 * The agent then uses the same tools and `set_turn_status` protocol as every
 * message-driven turn.
 *
 * Agenda-aware wakes: before waking the brain, we ask a cheap classifier
 * whether this agent has actionable Kanban cards or current-slot Calendar
 * events. If yes, we wake with a focused brief (the brain spends its turn
 * doing the work, not deciding whether to do it). If the classifier says no,
 * or the agent has no agenda at all, we fall back to the generic "is there
 * anything worth doing?" idle wake.
 */
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { wakeAgent } from './scheduler.js'
import { getPersona } from './personas.js'
import {
  gatherAgentAgenda,
  classifyAgendaActionable,
  renderAgendaBrief,
  AGENDA_CLASSIFIER_ERROR,
  type AgentAgenda,
} from './agenda.js'

// Test injection points — mirror scanner.ts. Production never sets these;
// integration tests use them to capture wake calls without actually
// spinning up a pod, and to make the agenda classifier deterministic
// without burning real LLM credits.
type WakeFn = (...args: Parameters<typeof wakeAgent>) => Promise<unknown>
let wakeIdleAgent: WakeFn = wakeAgent
export function __setIdleWakeForTesting(fn: WakeFn | null): void {
  wakeIdleAgent = fn ?? wakeAgent
}
type ClassifyFn = typeof classifyAgendaActionable
let classifyAgenda: ClassifyFn = classifyAgendaActionable
export function __setIdleClassifierForTesting(fn: ClassifyFn | null): void {
  classifyAgenda = fn ?? classifyAgendaActionable
}
export function _resetIdleForTests(): void {
  wakeIdleAgent = wakeAgent
  classifyAgenda = classifyAgendaActionable
}

interface IdleCandidate {
  id: string
  name: string
  role: string | null
  status: string
  company_id: string
  last_spoke: string | null
}

async function pickAgent(companyId: string): Promise<IdleCandidate | null> {
  const minQuietMin = env.IDLE_MIN_QUIET_MIN
  // Pick the 5 random candidates FIRST, then compute last_spoke only for those
  // 5 — not for every avail/resting agent. The old shape ran the correlated
  // `MAX(created_at) WHERE author_id = p.id` subquery for ALL matching agents
  // (ORDER BY random() forces the whole SELECT list to be evaluated before the
  // LIMIT), and with no messages(author_id) index each was a full table scan.
  // Across companies that pinned ~20 connections at ~8s and 503-ed the API.
  // Now it's 5 index lookups (idx_messages_author_created). See migrate.ts.
  const { rows } = await pool.query<IdleCandidate>(
    `WITH picked AS (
       SELECT p.id, p.name, p.role, p.status, p.company_id
         FROM participants p
        WHERE p.kind = 'agent'
          AND p.departed_at IS NULL
          AND p.company_id = $1
          AND p.status IN ('avail', 'resting')
        ORDER BY random()
        LIMIT 5
     )
     SELECT picked.id, picked.name, picked.role, picked.status, picked.company_id,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.author_id = picked.id)::text AS last_spoke
       FROM picked`,
    [companyId],
  )

  const cutoff = Date.now() - minQuietMin * 60_000
  return rows.find((r) => {
    if (!r.last_spoke) return true
    return new Date(r.last_spoke).getTime() < cutoff
  }) ?? null
}

interface IdleLogRef {
  source: 'idle_scheduler'
  companyId: string
  status: string
  lastSpoke: string | null
  agendaCards: number
  agendaEvents: number
  agendaVerdict: 'actionable' | 'skip' | 'empty' | 'classifier_error'
  agendaFocus?: string
}

async function recordIdleWake(agent: IdleCandidate, ref: IdleLogRef): Promise<void> {
  // Include company_id so tenant-scoped queries (idx_agent_log_company)
  // pick up these rows without the post-hoc backfill in migrate.ts. The
  // pre-agenda version of this file omitted it; matched scanner.ts here.
  await pool.query(
    `INSERT INTO agent_log (id, agent_id, company_id, kind, body, ref)
       VALUES ($1, $2, $3, 'note', $4, $5::jsonb)`,
    [
      `log-${randomUUID().slice(0, 12)}`,
      agent.id,
      agent.company_id,
      `idle wake queued for ${agent.name}`,
      JSON.stringify(ref),
    ],
  )
}

function agendaHasItems(agenda: AgentAgenda): boolean {
  return agenda.cards.length > 0 || agenda.events.length > 0
}

export async function runIdleTick(): Promise<void> {
  const { rows: tenants } = await pool.query<{ id: string }>(
    `SELECT id FROM companies`,
  )
  for (const { id: companyId } of tenants) {
    try {
      const agent = await pickAgent(companyId)
      if (!agent) continue

      const agenda = await gatherAgentAgenda(agent.id, agent.company_id)

      if (!agendaHasItems(agenda)) {
        // No assigned cards, no current-slot events — preserve the original
        // heartbeat behavior (spontaneous nudge) so agents without an agenda
        // still get their normal idle ticks.
        await recordIdleWake(agent, {
          source: 'idle_scheduler',
          companyId: agent.company_id,
          status: agent.status,
          lastSpoke: agent.last_spoke,
          agendaCards: 0,
          agendaEvents: 0,
          agendaVerdict: 'empty',
        })
        await wakeIdleAgent(agent.id, 'idle', null, null, {
          idleReason: `idle heartbeat after at least ${env.IDLE_MIN_QUIET_MIN} quiet minute(s)`,
        })
        continue
      }

      const persona = await getPersona(agent.id)
      if (!persona) continue
      const verdict = await classifyAgenda({
        persona,
        companyId: agent.company_id,
        agenda,
        agentId: agent.id,
      })

      if (!verdict.actionable) {
        const classifierFailed = verdict.reason === AGENDA_CLASSIFIER_ERROR
        await recordIdleWake(agent, {
          source: 'idle_scheduler',
          companyId: agent.company_id,
          status: agent.status,
          lastSpoke: agent.last_spoke,
          agendaCards: agenda.cards.length,
          agendaEvents: agenda.events.length,
          agendaVerdict: classifierFailed ? 'classifier_error' : 'skip',
        })
        // Healthy classifier said "skip" — that's the cost-saving path:
        // we spent only the cerebellum call this tick, the brain stays
        // resting. But on classifier ERROR (network blip / quota) we
        // must NOT silence the agent — fall back to the generic idle
        // wake so a sustained outage doesn't quietly turn every agent
        // with assigned cards into a no-op.
        if (classifierFailed) {
          await wakeIdleAgent(agent.id, 'idle', null, null, {
            idleReason: `idle heartbeat after at least ${env.IDLE_MIN_QUIET_MIN} quiet minute(s) (agenda triage unavailable)`,
          })
        }
        continue
      }

      // Agenda-driven wake: hand the brain a focused brief so it executes
      // rather than spending a turn deciding whether to.
      const briefBody = renderAgendaBrief(agenda, verdict.focus)
      await recordIdleWake(agent, {
        source: 'idle_scheduler',
        companyId: agent.company_id,
        status: agent.status,
        lastSpoke: agent.last_spoke,
        agendaCards: agenda.cards.length,
        agendaEvents: agenda.events.length,
        agendaVerdict: 'actionable',
        agendaFocus: verdict.focus,
      })
      await wakeIdleAgent(agent.id, 'background_scan', null, null, {
        backgroundBrief: {
          source: 'agenda_scheduler',
          title: verdict.focus || 'Heartbeat agenda',
          body: briefBody,
        },
      })
    } catch (e) {
      console.warn(`[idle] tenant ${companyId} failed`, e)
    }
  }
}

export function startIdleScheduler(intervalMs: number): NodeJS.Timeout | null {
  if (intervalMs <= 0) return null
  return setInterval(() => {
    runIdleTick().catch((e) => console.error('[idle]', e))
  }, intervalMs)
}
