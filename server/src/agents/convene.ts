import { getTrackedLlmClient } from './llm-ledger.js'
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { env } from '../env.js'
import { enforceModelPolicy, realTaskModel } from './model-policy.js'
import { CH_CONVENE, publish } from '../redis.js'
import { getPersona, buildSystemPrompt } from './personas.js'
import { setStatus } from '../status.js'
import { companyIdForConveneSession } from '../tenant.js'

interface SessionRow {
  id: string
  conversation_id: string
  title: string
  flair: string | null
  started_by: string
  started_at: string
  ended_at: string | null
  state: string
}

async function appendTranscript(args: {
  sessionId: string
  authorId: string
  kind: 'text' | 'thought' | 'tool' | 'decision'
  body: string
  decision?: { headline: string; body: string } | null
}): Promise<{ id: string; sequence: number } | null> {
  const id = `ct-${randomUUID()}`
  const scope = await pool.query<{ conversation_id: string; company_id: string }>(
    `SELECT conversation_id, company_id FROM convene_sessions WHERE id = $1`,
    [args.sessionId],
  )
  const initial = scope.rows[0]
  if (!initial) return null
  let sequence = 0
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (args.authorId !== 'system') {
      const participant = await client.query(
        `SELECT id FROM participants
          WHERE id = $1 AND company_id = $2
            AND kind = 'agent' AND departed_at IS NULL
          FOR SHARE`,
        [args.authorId, initial.company_id],
      )
      if (!participant.rowCount) {
        await client.query('ROLLBACK')
        return null
      }
    }
    const conversation = await client.query(
      `SELECT c.id FROM conversations c
        WHERE c.id = $1 AND c.company_id = $2
          AND ($3::text = 'system' OR EXISTS (
            SELECT 1 FROM conversation_members cm
             WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
               AND cm.participant_id = $3
          ))
        FOR SHARE OF c`,
      [initial.conversation_id, initial.company_id, args.authorId],
    )
    if (!conversation.rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    const session = await client.query(
      `SELECT id FROM convene_sessions
        WHERE id = $1 AND conversation_id = $2 AND company_id = $3 AND state = 'live'
        FOR UPDATE`,
      [args.sessionId, initial.conversation_id, initial.company_id],
    )
    if (!session.rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    const seq = await client.query<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), 0)::int + 1 AS sequence
         FROM convene_transcript WHERE session_id = $1`,
      [args.sessionId],
    )
    sequence = seq.rows[0]?.sequence ?? 1
    await client.query(
      `INSERT INTO convene_transcript
        (id, session_id, author_id, kind, body, sequence, decision, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [id, args.sessionId, args.authorId, args.kind, args.body, sequence,
        args.decision ? JSON.stringify(args.decision) : null, initial.company_id],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  await publish(CH_CONVENE, {
    type: 'convene',
    sessionId: args.sessionId,
    conversationId: initial.conversation_id,
    companyId: initial.company_id,
    kind: 'transcript',
    data: { id, sessionId: args.sessionId, authorId: args.authorId, kind: args.kind, body: args.body, sequence, decision: args.decision ?? null, createdAt: new Date().toISOString() },
  }).catch((error) => {
    console.warn(`[convene] durable transcript ${id} committed but publish failed`, error)
  })
  return { id, sequence }
}

export async function getActiveConvene(conversationId: string): Promise<SessionRow | null> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, conversation_id, title, flair, started_by, started_at, ended_at, state
       FROM convene_sessions
      WHERE conversation_id = $1 AND state = 'live'
      ORDER BY started_at DESC LIMIT 1`,
    [conversationId],
  )
  return rows[0] ?? null
}

export async function startConvene(args: {
  conversationId: string
  companyId: string
  startedBy: string
  topic: string
}): Promise<SessionRow> {
  const id = `cs-${randomUUID()}`
  let session: SessionRow
  let created = false
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const actor = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        FOR SHARE`,
      [args.startedBy, args.companyId],
    )
    if (!actor.rowCount) throw new Error('convene starter is no longer an active tenant participant')
    const { rows } = await client.query<{ title: string }>(
      `SELECT c.title FROM conversations c
        WHERE c.id = $1 AND c.company_id = $2
          AND EXISTS (
            SELECT 1 FROM conversation_members cm
             WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
               AND cm.participant_id = $3
          )
        FOR UPDATE OF c`,
      [args.conversationId, args.companyId, args.startedBy],
    )
    if (!rows[0]) throw new Error(`conversation ${args.conversationId} not found or not authorized`)
    const existing = await client.query<SessionRow>(
      `SELECT id, conversation_id, title, flair, started_by, started_at, ended_at, state
         FROM convene_sessions
        WHERE conversation_id = $1 AND company_id = $2 AND state = 'live'
        ORDER BY started_at DESC LIMIT 1
        FOR UPDATE`,
      [args.conversationId, args.companyId],
    )
    if (existing.rows[0]) {
      await client.query('COMMIT')
      return existing.rows[0]
    }
    session = {
      id,
      conversation_id: args.conversationId,
      title: `${rows[0].title} · live`,
      flair: args.topic.slice(0, 80),
      started_by: args.startedBy,
      started_at: new Date().toISOString(),
      ended_at: null,
      state: 'live',
    }
    await client.query(
      `INSERT INTO convene_sessions
        (id, conversation_id, title, flair, started_by, started_at, state, company_id)
       VALUES ($1,$2,$3,$4,$5,NOW(),'live',$6)`,
      [id, session.conversation_id, session.title, session.flair, session.started_by, args.companyId],
    )
    created = true
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  if (!created) return session
  await publish(CH_CONVENE, {
    type: 'convene',
    sessionId: id,
    conversationId: args.conversationId,
    companyId: args.companyId,
    kind: 'started',
    data: session,
  }).catch((error) => {
    console.warn(`[convene] durable session ${id} committed but started publish failed`, error)
  })

  orchestrate({ session, companyId: args.companyId, topic: args.topic }).catch((e) => {
    console.error('[convene] orchestration error', e)
  })

  return session
}

async function orchestrate(args: {
  session: SessionRow
  companyId: string
  topic: string
}): Promise<void> {
  const { session, companyId, topic } = args
  try {
    const { rows: agentMembers } = await pool.query<{ id: string }>(
      `SELECT p.id
         FROM conversations c
         JOIN conversation_members cm
           ON cm.conversation_id = c.id AND cm.company_id = c.company_id
         JOIN participants p
           ON p.id = cm.participant_id AND p.company_id = cm.company_id
          AND p.kind = 'agent' AND p.departed_at IS NULL
        WHERE c.id = $1 AND c.company_id = $2
        ORDER BY p.id`,
      [session.conversation_id, companyId],
    )
    for (const { id: agentId } of agentMembers) {
      await runAgentTurn({ session, companyId, agentId, topic })
    }

    const summary = await classifyDecision({ sessionId: session.id, topic })
    if (summary) {
      await appendTranscript({
        sessionId: session.id,
        authorId: 'system',
        kind: 'decision',
        body: summary.body,
        decision: { headline: summary.headline, body: summary.body },
      })
    }
  } finally {
    await pool.query(
      `UPDATE convene_sessions SET state = 'ended', ended_at = NOW()
        WHERE id = $1 AND company_id = $2 AND state = 'live'`,
      [session.id, companyId],
    )
    await publish(CH_CONVENE, {
      type: 'convene',
      sessionId: session.id,
      conversationId: session.conversation_id,
      companyId,
      kind: 'ended',
    }).catch((error) => {
      console.warn(`[convene] session ${session.id} ended but publish failed`, error)
    })
  }
}

async function runAgentTurn(args: {
  session: SessionRow
  companyId: string
  agentId: string
  topic: string
}): Promise<void> {
  const snapshot = await loadAuthorizedTurnSnapshot(args)
  if (!snapshot) return
  const persona = await getPersona(args.agentId)
  if (!persona) return
  await setStatus(args.agentId, 'thinking')

  const baseSystem = await buildSystemPrompt(args.agentId)
  const sys = `${baseSystem ?? persona.style}

You're in a LIVE CONVENE — a real-time work session. Other team members will speak too. Be brief (1-3 sentences). Bring your own angle on the topic; don't repeat what's been said.

Topic of this convene: ${args.topic}`

  const client = await getTrackedLlmClient({
    purpose: 'convene-speech',
    companyId: args.companyId,
    agentId: args.agentId,
    conversationId: args.session.conversation_id,
    extras: { sessionId: args.session.id, topic: args.topic.slice(0, 120) },
  })
  const r = await client.responses.create({
    // A convene speech is the agent's real spoken contribution that humans
    // read — a real task, so the big model is sanctioned here too.
    model: enforceModelPolicy(realTaskModel(persona.model), 'convene-speech'),
    instructions: sys,
    input: [
      ...snapshot.groundingHistory,
      ...snapshot.transcriptHistory,
      { role: 'user', content: `[Convene moderator]: ${persona.name}, your turn.` },
    ],
    max_output_tokens: 3000,
    reasoning: { effort: 'low' },
  })
  const body = sanitizeToolCallMarkup(r.output_text ?? '').trim()
  if (body) {
    await appendTranscript({ sessionId: args.session.id, authorId: args.agentId, kind: 'text', body })
  }
  await setStatus(args.agentId, 'avail')
}

async function loadAuthorizedTurnSnapshot(args: {
  session: SessionRow
  companyId: string
  agentId: string
}): Promise<{
  groundingHistory: ResponseInputItem[]
  transcriptHistory: ResponseInputItem[]
} | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind = 'agent' AND departed_at IS NULL
        FOR SHARE`,
      [args.agentId, args.companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    const conversation = await client.query(
      `SELECT c.id FROM conversations c
        WHERE c.id = $1 AND c.company_id = $2
          AND EXISTS (
            SELECT 1 FROM conversation_members cm
             WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
               AND cm.participant_id = $3
          )
        FOR SHARE OF c`,
      [args.session.conversation_id, args.companyId, args.agentId],
    )
    if (!conversation.rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    const liveSession = await client.query(
      `SELECT id FROM convene_sessions
        WHERE id = $1 AND conversation_id = $2 AND company_id = $3 AND state = 'live'
        FOR SHARE`,
      [args.session.id, args.session.conversation_id, args.companyId],
    )
    if (!liveSession.rowCount) {
      await client.query('ROLLBACK')
      return null
    }
    const { rows: contextRows } = await client.query<{
      author_id: string; author_name: string; body: string
    }>(
      `SELECT m.author_id, COALESCE(p.name, m.author_id) AS author_name, m.body
         FROM messages m
         LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = m.company_id
        WHERE m.conversation_id = $1 AND m.company_id = $2
          AND m.kind IN ('text','thought')
        ORDER BY m.sequence DESC LIMIT 12`,
      [args.session.conversation_id, args.companyId],
    )
    const { rows: transcriptRows } = await client.query<{
      author_id: string; author_name: string; body: string
    }>(
      `SELECT t.author_id, COALESCE(p.name, t.author_id) AS author_name, t.body
         FROM convene_transcript t
         LEFT JOIN participants p ON p.id = t.author_id AND p.company_id = $2
        WHERE t.session_id = $1
        ORDER BY t.sequence ASC`,
      [args.session.id, args.companyId],
    )
    await client.query('COMMIT')
    return {
      groundingHistory: contextRows.reverse().map((row): ResponseInputItem => ({
        role: 'user',
        content: `[${row.author_name}]: ${row.body}`,
      })),
      transcriptHistory: transcriptRows.map((row): ResponseInputItem => ({
        role: row.author_id === args.agentId ? 'assistant' : 'user',
        content: `[${row.author_name}]: ${row.body}`,
      })),
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Strip hallucinated tool-call XML when the LLM has no real tools. */
function sanitizeToolCallMarkup(s: string): string {
  return s
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, '')
    .replace(/<\|?tool[_-]?(?:call|name|args)[^>]*\|?>[\s\S]*?<\/\|?tool[_-]?(?:call|name|args)[^>]*\|?>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
}

async function classifyDecision(args: { sessionId: string; topic: string }): Promise<{ headline: string; body: string } | null> {
  const { rows } = await pool.query<{ author_id: string; body: string }>(
    `SELECT author_id, body FROM convene_transcript
      WHERE session_id = $1 AND kind IN ('text','thought')
      ORDER BY sequence ASC`,
    [args.sessionId],
  )
  if (rows.length === 0) return null
  // Pre-fetch names for distinct authors so we don't hammer the cache.
  const distinctAuthors = [...new Set(rows.map((r) => r.author_id))]
  const nameByAuthor = new Map<string, string>()
  for (const a of distinctAuthors) {
    const p = await getPersona(a)
    if (p) nameByAuthor.set(a, p.name)
  }
  const transcript = rows.map((r) => `${nameByAuthor.get(r.author_id) ?? r.author_id}: ${r.body}`).join('\n')

  try {
    const tenant = (await companyIdForConveneSession(args.sessionId)) ?? null
    const client = await getTrackedLlmClient({
      purpose: 'convene-decision',
      companyId: tenant,
      extras: { sessionId: args.sessionId, topic: args.topic.slice(0, 120) },
    })
    const r = await client.responses.create({
      model: env.OPENAI_MODEL_SUPPORT,
      instructions: 'Reply ONLY with strict JSON: {"reached": boolean, "headline": "string", "body": "string"}. headline ≤ 12 words. body ≤ 40 words.',
      input: `Convene topic: ${args.topic}\n\nTranscript:\n${transcript}\n\nDid the team reach a decision? If yes summarize it. Reply as strict JSON.`,
      text: { format: { type: 'json_object' } },
      max_output_tokens: 1200,
      reasoning: { effort: 'low' },
    })
    const parsed = JSON.parse(r.output_text ?? '{}') as { reached?: boolean; headline?: string; body?: string }
    if (parsed.reached && parsed.headline && parsed.body) {
      return { headline: parsed.headline, body: parsed.body }
    }
  } catch (err) {
    console.warn('[convene] decision classifier failed', err)
  }
  return null
}
