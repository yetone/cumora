/**
 * Server-side tool executor — used by cli.ts (`cumora react / dm /
 * pull-group / palette`) and by the legacy in-process agent loop
 * (inproc / subprocess scheduler modes). Browser-driven actions now
 * run via the in-pod `opencli` binary (Chromium under Xvfb), not
 * through here.
 *
 * Pod-mode agents DO NOT use this file. The bundle imports
 * `runtime/pod-tools.ts` instead, which dispatches only the four
 * pod-local tool kinds (bash + native FS) and skips DB logging. All
 * "actions in the world" the LLM wants to take go through bash +
 * the `cumora` CLI shim, which HTTPs back to /runtime/cli and lands
 * here on the server.
 *
 * Pod-safe types + the LLM tool schema + bash / web tools live in
 * `tools-shared.ts` so they can be imported by both code paths
 * without dragging pg into the bundle.
 */

import { randomUUID } from 'node:crypto'
import { env } from '../env.js'
import { getTrackedLlmClient } from './llm-ledger.js'
import { pool } from '../db/pool.js'
import { enqueueBroadcast, nudgeRealtimeOutbox } from '../realtime-outbox.js'
import { CH_REACTIONS } from '../redis.js'
import { tReadFile, tWriteFile, tEditFile } from './runtime/native-tools.js'
import type { FsNamespace } from './runtime/fs-namespace.js'
import {
  tBash, tSetTurnStatus,
  type ToolResult,
} from './tools-shared.js'

export type { ToolResult } from './tools-shared.js'
export { TOOL_DEFS_RESPONSES } from './tools-shared.js'

/**
 * Tool definitions for the OpenAI Responses API.
 *
 * Single tool: `bash`. All other capabilities (web search, dm with another agent, pull-group,
 * react, palette, image generation, plus private state mgmt) are subcommands
 * of the `cumora` CLI on PATH. Adding a new
 * capability = adding a CLI subcommand; no LLM tool definition update needed.
 */

/** Dispatch a single tool call. Logs to tool_calls table. */
export async function executeTool(args: {
  agentId: string
  name: string
  argsJson: string
  messageId?: string | null
  runId?: string | null
  companyId?: string | null
  /** Per-turn FS namespace. When provided, bash runs with cwd
   *  = ns.rootDir and the three native FS tools operate on it.
   *  Optional so other call sites (rehire, manual replay) can keep
   *  running without a namespace. */
  ns?: FsNamespace | null
}): Promise<ToolResult> {
  const t0 = Date.now()
  const id = `t-${randomUUID()}`
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(args.argsJson || '{}')
  } catch {
    parsed = {}
  }

  await pool.query(
    `INSERT INTO tool_calls (id, message_id, agent_id, name, args, status, run_id, company_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,'pending',$6,$7)`,
    [id, args.messageId ?? null, args.agentId, args.name, JSON.stringify(parsed), args.runId ?? null, args.companyId ?? null],
  )

  let result: ToolResult
  try {
    switch (args.name) {
      case 'palette':            result = await tPalette(parsed, args.companyId ?? null, args.agentId); break
      case 'dm_with':            result = await tDmWith(parsed, args.agentId); break
      case 'pull_group':         result = await tPullGroup(parsed, args.agentId); break
      case 'set_turn_status':    result = tSetTurnStatus(parsed); break
      case 'shell':
      case 'bash':               result = await tBash(parsed, args.agentId, args.ns ?? null); break
      case 'react':              result = await tReact(parsed, args.agentId); break
      // Native FS tools — require an active per-turn namespace. Reject
      // gracefully if called outside a turn (shouldn't happen via the
      // normal LLM path; defensive).
      case 'read_file':
        result = args.ns ? await tReadFile(parsed, args.ns) : noNamespace('read_file', args.name)
        break
      case 'write_file':
        result = args.ns ? await tWriteFile(parsed, args.ns) : noNamespace('write_file', args.name)
        break
      case 'edit_file':
        result = args.ns ? await tEditFile(parsed, args.ns) : noNamespace('edit_file', args.name)
        break
      default:
        result = {
          ok: false, output: null, error: 'unknown tool',
          durationMs: Date.now() - t0,
          display: { name: args.name, arg: '', status: 'unknown tool', detail: `tool not implemented: ${args.name}` },
        }
    }
  } catch (err) {
    result = {
      ok: false, output: null, error: String(err), durationMs: Date.now() - t0,
      display: { name: args.name, arg: JSON.stringify(parsed).slice(0, 80), status: 'error', detail: String(err) },
    }
  }

  await pool.query(
    `UPDATE tool_calls
        SET result = $2::jsonb, status = $3, error = $4, duration_ms = $5
      WHERE id = $1`,
    [id, JSON.stringify(result.output ?? null), result.ok ? 'ok' : 'error', result.error ?? null, result.durationMs],
  )

  return result
}

/* ============== individual tools ============== */

// tBash lives in tools-shared.ts (pod-safe — no DB). Imported above and
// dispatched in the switch in executeTool.

async function tDmWith(args: Record<string, unknown>, instigatorId: string): Promise<ToolResult> {
  const t0 = Date.now()
  const partnerId = String(args.partner_id ?? '').trim()
  const topic = String(args.topic ?? '').trim()
  const opening = String(args.opening_message ?? '').trim()
  if (!partnerId || partnerId === instigatorId) {
    return { ok: false, output: null, error: 'invalid partner', durationMs: Date.now() - t0,
      display: { name: 'dm_with', arg: partnerId, status: 'error', detail: 'Pick a different agent', icon: 'web' } }
  }
  const { startPrivateChat } = await import('./private_chat.js')
  const result = await startPrivateChat({ instigatorId, partnerId, topic, opening })
  return {
    ok: true,
    output: { conversationId: result.conversationId, partnerId, topic },
    durationMs: Date.now() - t0,
    display: {
      name: 'dm_with', arg: `${partnerId} · ${topic.slice(0, 40)}`,
      status: `opened · ${result.conversationId.slice(0, 12)}`,
      detail: `→ "${opening.slice(0, 200)}"\n\nDirect conversation opened with ${partnerId}. Same shape as any 1-on-1 chat — your partner will see it in their mailbox and reply naturally.`,
      icon: 'web',
    },
  }
}

async function tPullGroup(args: Record<string, unknown>, instigatorId: string): Promise<ToolResult> {
  const t0 = Date.now()
  const title = String(args.title ?? '').trim().slice(0, 80) || 'untitled'
  const reason = String(args.reason ?? '').trim()
  const opening = String(args.opening_message ?? '').trim()
  const members = Array.isArray(args.members) ? (args.members as unknown[]).map((m) => String(m)).filter(Boolean) : []
  // Always include the instigator. Do NOT auto-add a human — agents are
  // first-class and can pull true agent-only groups (which surface in
  // the Whispers peek tab). The agent picks who belongs based on the
  // members[] list it supplied.
  if (!members.includes(instigatorId)) members.push(instigatorId)
  const { startPulledGroup } = await import('./scanner_helper.js')
  const result = await startPulledGroup({ instigatorId, title, members, reason, opening })
  return {
    ok: true, output: { conversationId: result.conversationId, members },
    durationMs: Date.now() - t0,
    display: {
      name: 'pull_group', arg: title,
      status: `created · ${result.conversationId.slice(0, 12)}`,
      detail: `members: ${members.join(', ')}\nreason: ${reason}\n\n→ "${opening.slice(0, 200)}"`,
      icon: 'web',
    },
  }
}

function noNamespace(toolName: string, displayName: string): ToolResult {
  const detail = `${toolName} requires an active per-turn FS namespace; called outside of a turn (or namespace failed to hydrate).`
  return {
    ok: false, output: null, error: detail, durationMs: 0,
    display: { name: displayName, arg: '', status: 'no namespace', detail, icon: 'github' },
  }
}

async function tReact(args: Record<string, unknown>, agentId: string): Promise<ToolResult> {
  const t0 = Date.now()
  const messageId = String(args.message_id ?? '').trim()
  const emoji = String(args.emoji ?? '').trim()
  if (!messageId || !emoji) {
    return { ok: false, output: null, error: 'message_id and emoji required', durationMs: Date.now() - t0,
      display: { name: 'react', arg: '', status: 'error', detail: 'missing args' } }
  }

  // Authorize and toggle in one transaction. Lock order matches membership
  // mutations (participant first, conversation second), so a concurrent kick,
  // offboarding, or tenant move either commits first and rejects this reaction,
  // or waits until this already-authorized write commits.
  const client = await pool.connect()
  let action: 'removed' | 'added'
  let agg: Array<{ emoji: string; count: number; users: string[] }>
  let conversationId: string
  let companyId: string
  try {
    await client.query('BEGIN')
    const { rows: authorized } = await client.query<{ conversation_id: string; company_id: string }>(
      `SELECT m.conversation_id, c.company_id
         FROM participants requester
         JOIN conversations c
           ON c.company_id = requester.company_id
          AND EXISTS (
            SELECT 1 FROM conversation_members cm
             WHERE cm.conversation_id = c.id
               AND cm.company_id = c.company_id
               AND cm.participant_id = $2
          )
         JOIN messages m
           ON m.conversation_id = c.id
          AND m.company_id = c.company_id
        WHERE m.id = $1
          AND requester.id = $2
          AND requester.kind = 'agent'
          AND requester.departed_at IS NULL
        FOR SHARE OF requester, c, m`,
      [messageId, agentId],
    )
    if (!authorized[0]) {
      await client.query('ROLLBACK')
      return {
        ok: false,
        output: null,
        error: 'message not found or no longer authorized',
        durationMs: Date.now() - t0,
        display: {
          name: 'react', arg: `${emoji} ${messageId.slice(0, 12)}`,
          status: 'forbidden', detail: 'message not found or no longer authorized', icon: 'web',
        },
      }
    }
    conversationId = authorized[0].conversation_id
    companyId = authorized[0].company_id

    const existing = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM message_reactions
        WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, agentId, emoji],
    )
    action = Number(existing.rows[0]?.count ?? '0') > 0 ? 'removed' : 'added'
    if (action === 'removed') {
      await client.query(
        `DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [messageId, agentId, emoji],
      )
    } else {
      await client.query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [messageId, agentId, emoji],
      )
    }

    // Aggregate while the authorization locks are still held. We DON'T
    // compute a `mine` flag server-side: that is recipient-specific.
    const aggregate = await client.query<{ emoji: string; count: number; users: string[] }>(
      `SELECT emoji,
              COUNT(*)::int AS count,
              array_agg(user_id ORDER BY user_id) AS users
         FROM message_reactions WHERE message_id = $1
         GROUP BY emoji ORDER BY count DESC, emoji ASC`,
      [messageId],
    )
    agg = aggregate.rows
    await enqueueBroadcast(client, CH_REACTIONS, {
      type: 'message.reactions',
      conversationId,
      companyId,
      messageId,
      reactions: agg,
    })
    await client.query('COMMIT')
    nudgeRealtimeOutbox()
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  // Do NOT advance conversation_reads here. A reaction can be a lightweight
  // acknowledgement for long work, and marking the request read before the
  // turn completes can erase unfinished tasks from the agent's inbox. The turn
  // runtime advances reads only after semantic completion is accepted.
  return {
    ok: true,
    output: { messageId, emoji, action, reactions: agg },
    durationMs: Date.now() - t0,
    display: {
      name: 'react',
      arg: `${emoji} ${messageId.slice(0, 12)}`,
      status: action,
      detail: emoji === '👀' && action === 'added'
        ? `${agentId} ${action} ${emoji}\n\n👀 is only an acknowledgement for long work. Continue in this same turn and choose the appropriate next step: complete the task, ask a concrete clarifying question, or report a clear failure. Only generate an image when the user clearly asked for one.`
        : `${agentId} ${action} ${emoji}`,
      icon: 'web',
    },
  }
}

async function tPalette(args: Record<string, unknown>, companyId: string | null, agentId: string): Promise<ToolResult> {
  const t0 = Date.now()
  const brief = String(args.brief ?? '').trim()
  const openai = await getTrackedLlmClient({
    purpose: 'palette', companyId, agentId,
    extras: { brief: brief.slice(0, 120) },
  })
  const r = await openai.responses.create({
    // Palette is a tiny JSON-only utility: 5 hex codes, no reasoning required.
    // Route through the cerebellum (support) model, not the agent's brain.
    model: env.OPENAI_MODEL_SUPPORT,
    instructions: 'You produce 5-color hex palettes. Reply ONLY with JSON: {"colors":["#RRGGBB", ...]}. No prose.',
    input: `Design brief: ${brief}\n\nReply with JSON only.`,
    text: { format: { type: 'json_object' } },
    max_output_tokens: 800,
    reasoning: { effort: 'low' },
  })
  const text = r.output_text ?? '{}'
  let colors: string[] = []
  try {
    const parsed = JSON.parse(text) as { colors?: string[] }
    colors = (parsed.colors ?? []).filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c)).slice(0, 5)
  } catch { /* ignore */ }
  return {
    ok: colors.length > 0,
    output: { colors, brief },
    durationMs: Date.now() - t0,
    display: {
      name: 'palette', arg: brief.slice(0, 60),
      status: `${colors.length} colors`,
      detail: colors.join('  '),
      icon: 'figma',
    },
  }
}
