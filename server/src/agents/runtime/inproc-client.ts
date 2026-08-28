/**
 * InProcRuntimeClient — `AgentRuntimeClient` impl that runs in the same
 * Node process as the cumora server. Talks directly to Postgres + Redis
 * via the existing helpers; no HTTP hop.
 *
 * This is the transitional implementation. The pod-based runtime
 * (Phase 2b/3) will use HttpRuntimeClient instead, but both speak the
 * same interface so the agent loop code itself doesn't care which
 * one's underneath.
 *
 * Migration status: every `AgentRuntimeClient` method is now backed by
 * a real impl. turn.ts uses this client exclusively for runtime IO; no
 * direct Postgres / Redis access remains in the agent-loop subtree.
 * The pod-side HttpRuntimeClient (Phase 3) will speak the same shapes
 * over HTTP.
 */
import { randomUUID } from 'node:crypto'
import { pool } from '../../db/pool.js'
import { CH_MESSAGE_NEW, CH_TYPING, publish, redis } from '../../redis.js'
import { notifyAlert } from '../../alerting.js'
import { freshenAttachmentUrl, type StoredAttachment } from '../../storage.js'

/** Re-sign attachment download URLs just-in-time when loading messages for an
 *  agent turn. The url stored in `messages.attachment` is signed with a TTL
 *  (R2_URL_TTL_SECONDS, default 1h) and goes stale; by the time an agent uses
 *  it — cloud vision fetch, the text-context link, or a BYOA engine opening the
 *  link — the HMAC has expired → 403 → "can't see the image". Re-sign each row's
 *  attachment so every consumer gets a URL valid for a fresh TTL. Best-effort:
 *  freshenAttachmentUrl keeps the stored url on any failure. */
async function refreshAttachmentUrls(rows: ReadonlyArray<{ attachment?: unknown }>): Promise<void> {
  await Promise.all(rows.map(async (r) => {
    const a = r.attachment as StoredAttachment | null | undefined
    if (!a || typeof a !== 'object' || !a.url) return
    try {
      ;(r as { attachment?: unknown }).attachment = await freshenAttachmentUrl(a)
    } catch { /* keep the stored (possibly stale) url */ }
  }))
}

/** Per-agent consecutive failure tracker for the busy heartbeat in
 *  this process. Capped at INPROC_BUSY_HEARTBEAT_ALERT_THRESHOLD;
 *  reset on a successful heartbeat. A persistent failure (Redis
 *  outage, etc.) means steer routing has silently degraded to wake-
 *  only for the affected agent. */
const inprocBusyHeartbeatFailures = new Map<string, number>()
const INPROC_BUSY_HEARTBEAT_ALERT_THRESHOLD = 5
import { companyIdForConversation } from '../../tenant.js'
import { nextConversationSequence } from '../membership.js'
import { getPersona } from '../personas.js'
import {
  setStatus as setStatusImpl,
  heartbeatStatus as heartbeatStatusImpl,
} from '../../status.js'
import {
  createAgentRun,
  recordAgentEvent,
  finishAgentRun,
} from '../observability.js'
import { buildSystemPrompt as buildSystemPromptImpl } from '../personas.js'
import { loadSkillsIndex as loadSkillsIndexImpl } from '../skills.js'
import { asMemorySource, memoryVisibleInScope, type MemorySource } from '../memory-scope.js'
import { projectIdsForConversations } from '../memory-write.js'
import {
  clearThinkingConversations,
  recordThinkingConversations,
} from '../thinking-convos.js'
import type {
  AgentRuntimeClient,
  ClimateRow,
  ContextRow,
  FaceRow,
  InboxRow,
  MemoryRow,
  PersonaRow,
  RuntimeTokenUsage,
  SkillIndexEntry,
  WorklogEntry,
  WorkTaskType,
} from './client.js'

interface MemoryQueryRow {
  path: string
  body: string
  meta: {
    kind?: string
    about?: string | null
    pinned?: boolean
    source?: MemorySource | null
  } | null
  updated_at: string
}

/** Spec: memoryVisibleInScope. Pinned OR no project OR project in $n. */
function memoryScopeSql(metaExpr: string, pathExpr: string, param: string): string {
  const pid = `COALESCE(NULLIF(${metaExpr}#>>'{source,projectId}', ''), substring(${pathExpr} from '^memory/projects/([^/]+)/'))`
  return `(
    COALESCE((${metaExpr}->>'pinned')::boolean, false) = true
    OR ${pid} IS NULL
    OR ${pid} = ANY(${param}::text[])
  )`
}

async function resolveMemoryScope(scope: {
  projectIds?: readonly string[]
  conversationIds?: readonly string[]
} = {}): Promise<string[]> {
  if (scope.projectIds && scope.projectIds.length > 0) return [...scope.projectIds]
  if (scope.conversationIds && scope.conversationIds.length > 0) {
    return projectIdsForConversations([...scope.conversationIds])
  }
  return []
}

function toMemoryRow(r: MemoryQueryRow): MemoryRow {
  const segs = r.path.split('/')
  return {
    id: (segs[2] ?? '').replace(/\.md$/, ''),
    kind: r.meta?.kind ?? segs[1] ?? 'note',
    about: r.meta?.about ?? null,
    body: r.body,
    pinned: Boolean(r.meta?.pinned),
    created_at: r.updated_at,
  }
}

export class InProcRuntimeClient implements AgentRuntimeClient {
  /** Persona row (delegates to the cached personas.ts helper).
   *  Returns null when the id isn't an active agent. */
  async loadPersona(agentId: string): Promise<PersonaRow | null> {
    return getPersona(agentId)
  }

  async getConversationCompanyId(conversationId: string): Promise<string | null> {
    return companyIdForConversation(conversationId)
  }

  async loadInbox(agentId: string): Promise<InboxRow[]> {
    // Resolve the agent's conversations via the members GIN, then pull each one's
    // unread tail with a LATERAL over idx_messages_convo_created — instead of the
    // old form that joined ALL messages of every member conversation with a PER-ROW
    // cursor subquery (an 8s query that, with loadContext, starved the pool).
    //
    // Force the members GIN: the planner mis-costs `members @>` and SEQ-SCANS all
    // conversations (~2s), which starves the pool under load. enable_seqscan=off
    // makes it use the GIN (~100ms). It is set at SESSION level on a dedicated
    // client with NO transaction — a single autocommit SELECT only takes ACCESS
    // SHARE, so (unlike the earlier BEGIN…COMMIT version) it can't deadlock with
    // DML or a rolling-deploy ALTER TABLE. RESET on the success path; on any error
    // the connection is DESTROYED (release(true)) so a stray GUC never leaks back
    // into the pool. Every access in the query is index-backed.
    const client = await pool.connect()
    let rows: InboxRow[] = []
    try {
      await client.query('SET enable_seqscan = off')
      const res = await client.query<InboxRow>(
      `WITH convos AS (
         SELECT c.id, c.company_id,
                c.title AS conversation_title, c.kind AS conversation_kind, c.topic AS conversation_topic,
                c.project_id, pr.name AS project_name,
                COALESCE(cr.last_read_at, '1970-01-01T00:00:00Z'::timestamptz) AS lr_at,
                COALESCE(cr.last_read_message_id, '') AS lr_id,
                EXISTS (
                  SELECT 1 FROM conversation_mutes mu
                   WHERE mu.user_id = $1 AND mu.conversation_id = c.id
                     AND (mu.muted_until IS NULL OR mu.muted_until > NOW())
                ) AS muted
           FROM conversations c
           LEFT JOIN conversation_reads cr ON cr.user_id = $1 AND cr.conversation_id = c.id
           LEFT JOIN projects pr ON pr.id = c.project_id
          WHERE c.members @> to_jsonb(ARRAY[$1::text])
       )
       SELECT
          m.id, m.conversation_id, co.company_id,
          co.conversation_title, co.conversation_kind, co.conversation_topic,
          co.project_id, co.project_name,
          m.author_id, p.kind AS author_kind, COALESCE(p.name, m.author_id) AS author_name,
          m.body, m.kind, m.sequence, m.created_at, m.attachment, m.quoted_message_id,
          (
            SELECT jsonb_build_object(
              'id', qm.id, 'authorId', qm.author_id,
              'authorName', COALESCE(qp.name, qm.author_id),
              'kind', qm.kind, 'body', LEFT(qm.body, 240), 'sequence', qm.sequence
            )
              FROM messages qm
              LEFT JOIN participants qp ON qp.id = qm.author_id AND qp.company_id = co.company_id
             WHERE qm.id = m.quoted_message_id AND qm.conversation_id = m.conversation_id
          ) AS quoted
         FROM convos co
         JOIN LATERAL (
           -- Unread tail of THIS conversation. ROW(created_at,id) > cursor uses
           -- last_read_message_id as a tiebreaker for same-instant messages.
           SELECT * FROM messages mm
            WHERE mm.conversation_id = co.id
              AND mm.author_id <> $1
              AND ROW(mm.created_at, mm.id) > ROW(co.lr_at, co.lr_id)
              AND (
                NOT co.muted
                OR co.conversation_kind = 'direct'
                OR EXISTS (
                  SELECT 1 FROM regexp_matches(mm.body, '@([[:alnum:]_-]+)', 'g') mention
                   WHERE LOWER(mention[1]) = LOWER($1)
                )
                OR EXISTS (
                  SELECT 1 FROM messages quoted
                   WHERE quoted.id = mm.quoted_message_id
                     AND quoted.conversation_id = mm.conversation_id
                     AND quoted.author_id = $1
                )
              )
            ORDER BY mm.created_at ASC, mm.id ASC
            LIMIT 200
         ) m ON true
         LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = co.company_id
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 200`,
        [agentId],
      )
      await client.query('RESET enable_seqscan')
      rows = res.rows
    } catch (err) {
      client.release(true) // destroy — never return a connection in unknown GUC state
      throw err
    }
    client.release()
    await refreshAttachmentUrls(rows)
    // NOTE: This used to call recordSeen() here to advance the freshness-
    // preflight boundary, but that fired for EVERY caller of loadInbox —
    // including `maybeSteer`'s "probe to decide whether to steer" path
    // which usually does NOT inject the rows into the agent's session
    // (only direct DM / human / @-mention triggers an actual steer). The
    // baseline got polluted past what the brain had actually been shown,
    // and the preflight let duplicate-collisions through (observed:
    // bram-a520 saw Iris's "1" via maybeSteer's loadInbox call, baseline
    // advanced to seq=2, Bram's cumora reply "1" preflight then saw
    // nothing > 2 and let the duplicate post). Advance is now done by
    // the SERVER endpoint handler that actually shows to brain, see
    // runtime/server.ts /inbox (handler chooses advance vs probe).
    return rows
  }

  /**
   * Load this agent's persistent memory — hybrid retrieval:
   *   1. All pinned memories (always there — agent's "core identity").
   *   2. Top-N semantically relevant to the current inbox context, via
   *      pgvector cosine distance over `text-embedding-3-small` (1536-d).
   *   3. Top-M most recent (fallback for when embeddings haven't caught
   *      up yet; brand-new context is never lost regardless of scoring).
   *
   * Storage: `agent_workspace` rows at `memory/<kind>/<id>.md`. Structured
   * fields live in the `meta` JSONB column; the dense vector lives in
   * `embedding vector(1536)`. The partial HNSW index
   * `idx_workspace_embed_hnsw` keeps top-K lookups fast even at tens of
   * thousands of memories per agent.
   *
   * If pgvector isn't installed OR the query embedding call fails we
   * fall back to recency-only retrieval. Agents never lose access to
   * their memory just because OpenAI burped.
   */
  async loadMemory(
    agentId: string,
    queryText: string,
    limits: { semantic?: number; recent?: number; total?: number } = {},
    scope: { projectIds?: readonly string[]; conversationIds?: readonly string[] } = {},
  ): Promise<MemoryRow[]> {
    const semanticLimit = limits.semantic ?? 20
    const recentLimit = limits.recent ?? 10
    const totalLimit = limits.total ?? 40
    const projectIds = await resolveMemoryScope(scope)
    const readScope = { projectIds }
    const scopePred = memoryScopeSql('meta', 'path', '$SCOPE')

    const { hasPgVector, embedText } = await import('../embeddings.js')
    const useSemantic = queryText.trim().length > 0 && (await hasPgVector())
    const queryVec = useSemantic ? await embedText(queryText) : null

    const toVisible = (rows: MemoryQueryRow[]): MemoryRow[] =>
      rows.filter((r) => memoryVisibleInScope(
        { pinned: r.meta?.pinned, source: asMemorySource(r.meta?.source) },
        r.path,
        readScope,
      )).map(toMemoryRow)

    if (!queryVec) {
      const { rows } = await pool.query<MemoryQueryRow>(
        `SELECT path, body, meta, updated_at
           FROM agent_workspace
          WHERE agent_id = $1 AND path LIKE 'memory/%'
            AND ${scopePred.replace('$SCOPE', '$3')}
          ORDER BY COALESCE((meta->>'pinned')::boolean, false) DESC, updated_at DESC
          LIMIT $2`,
        [agentId, totalLimit, projectIds],
      )
      return toVisible(rows)
    }

    // Hybrid retrieval: three CTEs unioned, ROW_NUMBER dedupes by path
    // keeping the lowest-rank source (pinned > semantic > recent). Final
    // ORDER preserves that rank so the prompt reads natural: identity-
    // defining stuff first, then "what's relevant now", then recency.
    const { rows } = await pool.query<MemoryQueryRow & { source_rank: number }>(
      `WITH
         pinned AS (
           SELECT path, body, meta, updated_at, 0 AS source_rank
             FROM agent_workspace
            WHERE agent_id = $1 AND path LIKE 'memory/%'
              AND COALESCE((meta->>'pinned')::boolean, false) = true
         ),
         relevant AS (
           SELECT path, body, meta, updated_at, 1 AS source_rank
             FROM agent_workspace
            WHERE agent_id = $1 AND path LIKE 'memory/%'
              AND embedding IS NOT NULL
              AND COALESCE((meta->>'pinned')::boolean, false) = false
              AND ${scopePred.replace('$SCOPE', '$6')}
            ORDER BY embedding <=> $2::vector ASC
            LIMIT $3
         ),
         recent AS (
           SELECT path, body, meta, updated_at, 2 AS source_rank
             FROM agent_workspace
            WHERE agent_id = $1 AND path LIKE 'memory/%'
              AND COALESCE((meta->>'pinned')::boolean, false) = false
              AND ${scopePred.replace('$SCOPE', '$6')}
            ORDER BY updated_at DESC
            LIMIT $4
         ),
         unioned AS (
           SELECT * FROM pinned
           UNION ALL SELECT * FROM relevant
           UNION ALL SELECT * FROM recent
         ),
         deduped AS (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY path ORDER BY source_rank ASC
           ) AS rn FROM unioned
         )
       SELECT path, body, meta, updated_at, source_rank
         FROM deduped
        WHERE rn = 1
        ORDER BY source_rank ASC, updated_at DESC
        LIMIT $5`,
      [agentId, queryVec, semanticLimit, recentLimit, totalLimit, projectIds],
    )
    return toVisible(rows)
  }

  // ─── reads (cont.) ────────────────────────────────────────────────

  /** Per-conversation recent history (last 25 msgs each) for every
   *  convo with unread items. Includes already-read messages and the
   *  agent's own past replies — real humans don't reason from a stripped
   *  slice, so neither should agents. Reactions get pre-aggregated as a
   *  JSON array so the prompt renderer doesn't need a second roundtrip. */
  async loadContext(agentId: string, companyId: string, conversationIds: string[]): Promise<ContextRow[]> {
    if (conversationIds.length === 0) return []
    // conversationIds can come directly from an authenticated runtime caller.
    // They narrow the read but do not authorize it: bind every conversation to
    // the active agent's tenant and require current conversation membership.
    // Drive from conversations (PK lookup on the given ids) + a LATERAL that pulls
    // each conversation's most-recent 25 messages via idx_messages_convo_created.
    // The old form scanned ALL messages of each conversation (big "allhands" rooms
    // have 9k+) and ROW_NUMBER'd them before keeping 25 — an 11s query that starved
    // the pool. This is ~1000× cheaper (verified). `quoted`/reactions now run only
    // for the ≤25 returned rows.
    const { rows } = await pool.query<ContextRow>(
      `WITH last_reads AS (
         SELECT conversation_id, last_read_at
           FROM conversation_reads
          WHERE user_id = $1
       ),
       recent AS (
         SELECT
            m.id, m.conversation_id, m.author_id, m.kind, m.body, m.sequence,
            m.created_at, m.attachment, m.quoted_message_id,
            c.company_id,
            c.title AS conversation_title, c.kind AS conversation_kind, c.topic AS conversation_topic,
            pr.name AS project_name,
            p.kind AS author_kind,
            COALESCE(p.name, m.author_id) AS author_name,
            COALESCE((SELECT last_read_at FROM last_reads lr WHERE lr.conversation_id = c.id),
                     '1970-01-01T00:00:00Z'::timestamptz) AS last_read_at,
            -- When did a HUMAN last READ this conversation (participants.kind, a
            -- DB fact)? A human with the room open advances their read cursor
            -- with every message — the strongest "a human is watching" signal
            -- there is, and unlike reactions it is not limited to the 25-message
            -- context window. The triage loop cap counts it as live human
            -- attention, so a spectated agent-run activity (game/relay the human
            -- is watching silently) keeps running; a room no human even reads
            -- still winds down at the same floors as before.
            (
              SELECT MAX(cr.last_read_at)
                FROM conversation_reads cr
                JOIN participants hp ON hp.id = cr.user_id AND hp.company_id = c.company_id
               WHERE cr.conversation_id = c.id AND hp.kind = 'human'
            ) AS human_last_read_at
           FROM conversations c
           JOIN participants requesting_agent
             ON requesting_agent.id = $1
            AND requesting_agent.company_id = $2
            AND requesting_agent.kind = 'agent'
            AND requesting_agent.departed_at IS NULL
           LEFT JOIN projects pr ON pr.id = c.project_id
           JOIN LATERAL (
             SELECT * FROM messages mm
              WHERE mm.conversation_id = c.id
              ORDER BY mm.created_at DESC
              LIMIT 25
           ) m ON true
           LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = c.company_id
          WHERE c.id = ANY($3::text[])
            AND c.company_id = $2
            AND c.members @> to_jsonb(ARRAY[$1::text])
       )
       SELECT id, conversation_id, company_id, conversation_title, conversation_kind, conversation_topic,
              project_name,
              author_id, author_kind, author_name, body, kind, sequence, created_at, attachment,
              quoted_message_id, human_last_read_at,
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
                  LEFT JOIN participants qp ON qp.id = qm.author_id AND qp.company_id = recent.company_id
                 WHERE qm.id = recent.quoted_message_id
                   AND qm.conversation_id = recent.conversation_id
              ) AS quoted,
              (created_at > last_read_at AND author_id <> $1) AS is_unread,
              (author_id = $1) AS is_self,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object('emoji', emoji, 'users', users) ORDER BY count DESC, emoji ASC)
                  FROM (
                    SELECT emoji, COUNT(*)::int AS count, array_agg(user_id ORDER BY user_id) AS users
                      FROM message_reactions
                     WHERE message_id = recent.id
                     GROUP BY emoji
                  ) r
              ), '[]'::jsonb) AS reactions,
              (
                -- Latest HUMAN reaction on this message (participants.kind, a DB
                -- fact — not content). The triage loop cap treats a human emoji
                -- reaction as live human attention: a spectating human (watching
                -- an agent-run game/relay, reacting instead of typing) must keep
                -- the thread alive exactly like a human message would.
                SELECT MAX(mr.created_at)
                  FROM message_reactions mr
                  JOIN participants pp ON pp.id = mr.user_id AND pp.company_id = recent.company_id
                 WHERE mr.message_id = recent.id AND pp.kind = 'human'
              ) AS human_reacted_at
         FROM recent
        ORDER BY conversation_id, created_at ASC`,
      [agentId, companyId, conversationIds],
    )
    await refreshAttachmentUrls(rows)
    return rows
  }

  /** Agent's feelings about people — top-24 most recently updated.
   *  Climate is GLOBAL on purpose (issue #45): it does not follow the
   *  project. Same agent identity across groups. */
  async loadClimate(agentId: string): Promise<ClimateRow[]> {
    const { rows } = await pool.query<ClimateRow>(
      `SELECT about_id, affinity, trust, last_note, updated_at
         FROM agent_climate
        WHERE agent_id = $1
        ORDER BY updated_at DESC LIMIT 24`,
      [agentId],
    )
    return rows
  }

  /** Progressive-disclosure index: only `name`+`description`+`path` per
   *  installed skill. Full SKILL.md bodies are fetched on-demand by the
   *  load_skill tool. Implementation lives in skills.ts since it's
   *  tightly coupled with the SKILL.md frontmatter parser. */
  async loadSkillsIndex(agentId: string): Promise<SkillIndexEntry[]> {
    return loadSkillsIndexImpl(agentId)
  }

  /** Avatar portraits for every participant id passed in. Returns rows
   *  in arbitrary order; caller filters out missing/local URLs before
   *  shipping them to the LLM. */
  async loadFaces(participantIds: string[]): Promise<FaceRow[]> {
    if (participantIds.length === 0) return []
    const { rows } = await pool.query<FaceRow>(
      `SELECT id, name, role, avatar_url FROM participants WHERE id = ANY($1::text[])`,
      [participantIds],
    )
    return rows
  }

  // ─── identity ─────────────────────────────────────────────────────

  /** Full system prompt incl. IDENTITY.md / SOUL.md, persona style,
   *  global rules, team roster. Returns null for non-persona ids.
   *  Heavy lifting lives in personas.ts since it joins participants +
   *  agent_workspace + the rendered team roster. */
  async buildSystemPrompt(agentId: string): Promise<string | null> {
    return buildSystemPromptImpl(agentId)
  }

  // ─── status + presence ────────────────────────────────────────────

  async setStatus(
    agentId: string,
    status: 'avail' | 'working' | 'thinking' | 'waiting' | 'resting',
  ): Promise<void> {
    try {
      await setStatusImpl(agentId, status)
    } catch (err) {
      console.warn(`[runtime] setStatus(${status}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async heartbeatStatus(
    agentId: string,
    status: 'working' | 'thinking' | 'waiting',
  ): Promise<void> {
    try {
      await heartbeatStatusImpl(agentId, status)
    } catch (err) {
      console.warn(`[runtime] heartbeatStatus(${status}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async publishTyping(args: {
    conversationId: string
    agentId: string
    done: boolean
    companyId?: string | null
  }): Promise<void> {
    // Throttle keep-alive pings. The renderer keeps "typing…" visible for 45s
    // (TYPING_STALE_MS) but the daemon re-pings every 6s, so each turn fans out
    // ~7 identical typing broadcasts to every client in the company. Collapse
    // keep-alives to ≤1 per 30s per (agent, conversation) — still refreshes well
    // before the 45s expiry — to cut that fan-out ~5x. A `done` (stop-typing)
    // event ALWAYS goes through so the indicator clears promptly.
    if (!args.done) {
      try {
        const fresh = await redis.set(`cumora:typ:${args.agentId}:${args.conversationId}`, '1', 'EX', 30, 'NX')
        if (fresh === null) return // throttled — indicator still alive from the last ping
      } catch { /* redis hiccup — fall through and publish */ }
    }
    try {
      await publish(CH_TYPING, {
        type: 'typing',
        conversationId: args.conversationId,
        agentId: args.agentId,
        done: args.done,
        companyId: args.companyId ?? undefined,
      })
    } catch (err) {
      console.warn(`[runtime] publishTyping(done=${args.done}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  // ─── observability ────────────────────────────────────────────────

  async createRun(args: {
    agentId: string
    companyId?: string | null
    trigger?: Record<string, unknown>
    inputMessageIds?: string[]
    inboxCount?: number
    fingerprint?: string
  }): Promise<string> {
    return createAgentRun(args)
  }

  async recordEvent(event: {
    runId: string
    agentId: string
    companyId?: string | null
    kind: string
    level?: 'debug' | 'info' | 'warn' | 'error'
    title: string
    data?: Record<string, unknown>
    stage?: string
  }): Promise<void> {
    // Symmetric with HttpRuntimeClient.recordEvent — observability
    // events are best-effort. A DB hiccup mustn't take down a turn.
    try {
      await recordAgentEvent(event)
    } catch (err) {
      console.warn(`[runtime] recordEvent(${event.kind}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  async finishRun(args: {
    runId: string
    status: 'running' | 'completed' | 'failed' | 'skipped'
    summary?: string
    error?: string | null
    toolCallCount?: number
    tokenCount?: number
    model?: string | null
    usage?: RuntimeTokenUsage | null
  }): Promise<void> {
    try {
      await finishAgentRun(args)
    } catch (err) {
      console.warn(`[runtime] finishRun(${args.runId}, ${args.status}) failed — dropping`, err instanceof Error ? err.message : err)
    }
  }

  /** Is `agentId` a member of `conversationId`, scoped to `companyId` when
   *  given? Used to keep JWT-pinned writes (e.g. postSystemNotice) from
   *  touching conversations the caller isn't in. */
  async isConversationMember(
    conversationId: string,
    agentId: string,
    companyId?: string | null,
  ): Promise<boolean> {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT 1 AS ok FROM conversations
        WHERE id = $1
          AND ($3::text IS NULL OR company_id = $3)
          AND members @> to_jsonb(ARRAY[$2::text])
        LIMIT 1`,
      [conversationId, agentId, companyId ?? null],
    )
    return rows.length > 0
  }

  async postSystemNotice(args: {
    conversationId: string
    companyId?: string | null
    agentId: string
    noticeKind: string
    text: string
    dedupeKey: string
    dedupeTtlSec: number
  }): Promise<{ posted: boolean }> {
    // NX/EX deduplication: first caller to set the key wins and posts the
    // notice; everyone else gets `posted: false`. The key namespace lives
    // entirely in Redis so it auto-expires and survives across pods.
    const lockKey = `notice:${args.dedupeKey}`
    const acquired = await redis.set(
      lockKey, args.agentId,
      'EX', args.dedupeTtlSec,
      'NX',
    )
    if (acquired !== 'OK') return { posted: false }

    const messageId = `m-${randomUUID()}`
    const sequence = await nextConversationSequence(args.conversationId)
    const body = JSON.stringify({
      kind: 'notice',
      noticeKind: args.noticeKind,
      text: args.text,
    })
    await pool.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1,$2,$3,'system',$4,$5,$6)`,
      [messageId, args.conversationId, args.agentId, body, sequence, args.companyId ?? null],
    )
    await publish(CH_MESSAGE_NEW, {
      type: 'message.new',
      conversationId: args.conversationId,
      companyId: args.companyId ?? undefined,
      message: {
        id: messageId, conversationId: args.conversationId, authorId: args.agentId,
        kind: 'system', body, sequence,
        at: new Date().toISOString(),
      },
    })
    return { posted: true }
  }

  // ─── Steering busy heartbeat ──────────────────────────────────────

  async recordBusyHeartbeat(agentId: string, ttlSec: number = 5): Promise<void> {
    try {
      // SET with EX (TTL) — overwrite on every call to push out the
      // expiry. Value is the timestamp so we can spot stuck heartbeats
      // in a redis-cli investigation.
      await redis.set(busyKey(agentId), String(Date.now()), 'EX', ttlSec)
      // Success: reset the per-agent failure streak.
      inprocBusyHeartbeatFailures.delete(agentId)
    } catch (err) {
      const streak = (inprocBusyHeartbeatFailures.get(agentId) ?? 0) + 1
      inprocBusyHeartbeatFailures.set(agentId, streak)
      console.warn(`[runtime] recordBusyHeartbeat(${agentId}) failed — dropping (consecutive=${streak})`,
        err instanceof Error ? err.message : err)
      if (streak === INPROC_BUSY_HEARTBEAT_ALERT_THRESHOLD) {
        // notifyAlert dedupes on (label, error-message-prefix), so a
        // Redis outage causing every agent's heartbeat to fail
        // doesn't fan out to N webhook calls — first alert per
        // unique error sticks.
        void notifyAlert({
          label: 'server.busy_heartbeat_degraded',
          error: err,
          extras: {
            agentId,
            consecutiveFailures: streak,
            consequence: 'steer routing has degraded to wake-only for this agent',
          },
        })
      }
    }
  }

  async clearBusyHeartbeat(agentId: string): Promise<void> {
    try {
      await redis.del(busyKey(agentId))
    } catch (err) {
      console.warn(`[runtime] clearBusyHeartbeat(${agentId}) failed — dropping`,
        err instanceof Error ? err.message : err)
    }
  }

  // ─── Thinking claim ─────────────────────────────────────────────
  //
  // Lightweight "I'm thinking about responding in this convo" signal,
  // visible to peer agents via peekThinking(). The point is NOT to
  // serialize anything — it's to give the agent a way to read the
  // room (cf. `cumora glance`) before committing a reply, the way a
  // person glances at a typing indicator before sending.
  //
  // Redis ZSET per convo, score = ms timestamp of the first claim,
  // TTL 60s. Score is preserved across heartbeats (ZADD NX) so peers
  // can tell WHO STARTED FIRST — the broadcast prompt teaches the
  // agent to yield to earlier claimants when their angle is redundant.

  async markThinking(agentId: string, conversationIds: string[], ttlSec: number = 60): Promise<void> {
    if (conversationIds.length === 0) return
    // Reverse index so memory writes can stamp the conversation/project this
    // turn is actually in — without the agent passing `--in` every time.
    await recordThinkingConversations(agentId, conversationIds, ttlSec)
    // Throttle refreshes: the claim TTL is 60s but the daemon re-marks every 6s.
    // Collapse to ≤1 per 30s per agent (still refreshes before the 60s TTL) to
    // cut the repeated Redis writes ~5x.
    try {
      const fresh = await redis.set(`cumora:thk:${agentId}`, '1', 'EX', 30, 'NX')
      if (fresh === null) return // throttled — existing claims still valid (60s TTL)
    } catch { /* fail-open — fall through and mark */ }
    try {
      const pipe = redis.multi()
      const now = Date.now()
      for (const cid of conversationIds) {
        // NX preserves the original claim timestamp on heartbeats so a
        // mid-turn refresh doesn't reset our place in line.
        pipe.zadd(thinkingKey(cid), 'NX', now, agentId)
        pipe.expire(thinkingKey(cid), ttlSec)
      }
      await pipe.exec()
    } catch (err) {
      // Fail-open: missing a thinking claim just means peers don't see
      // me "typing". Not a correctness issue.
      console.warn(`[runtime] markThinking(${agentId}) failed`,
        err instanceof Error ? err.message : err)
    }
  }

  async unmarkThinking(agentId: string, conversationIds: string[]): Promise<void> {
    if (conversationIds.length === 0) return
    await clearThinkingConversations(agentId)
    try {
      const pipe = redis.multi()
      for (const cid of conversationIds) pipe.zrem(thinkingKey(cid), agentId)
      await pipe.exec()
    } catch (err) {
      console.warn(`[runtime] unmarkThinking(${agentId}) failed`,
        err instanceof Error ? err.message : err)
    }
    // Turn ended — void any un-used HELD acknowledgement for these convos.
    // A hold token is "I have been shown this HOLD and may re-run NOW";
    // letting it survive into a later turn armed a preemptive --send-anyway
    // 3.5 minutes after the HOLD it acknowledged (the 2026-07-08 counting-
    // game stale-"6" dup). Every turn path funnels through here (BYOA
    // daemon and cloud pod via /thinking/unmark, in-proc turns directly).
    try {
      const { clearHold } = await import('../seen-boundary.js')
      await Promise.all(conversationIds.map((cid) => clearHold(agentId, `reply:${cid}`)))
    } catch { /* fail-open — the short TTL reclaims it */ }
  }

  async peekThinking(conversationId: string): Promise<Array<{ agentId: string; claimedAt: number }>> {
    try {
      // ZRANGE 0 -1 WITHSCORES returns [member, score, member, score, ...]
      // ordered by ascending score (claim time).
      const raw = await redis.zrange(thinkingKey(conversationId), 0, -1, 'WITHSCORES')
      const out: Array<{ agentId: string; claimedAt: number }> = []
      for (let i = 0; i + 1 < raw.length; i += 2) {
        out.push({ agentId: String(raw[i]), claimedAt: Number(raw[i + 1]) })
      }
      return out
    } catch (err) {
      console.warn(`[runtime] peekThinking(${conversationId}) failed`,
        err instanceof Error ? err.message : err)
      return []
    }
  }

  // ─── Worklog (anti-duplicate-work claims) ────────────────────────
  //
  // A second claim layer on top of thinking-claims. Where thinking-
  // claims signal "I'm composing a reply", worklog claims signal
  // "I'm doing a specific piece of work in this convo" — web-search,
  // doc draft, image gen. Two agents who independently decide to look
  // up the same thing both check the worklog first; whoever gets
  // there first holds the claim, the other yields with a clear
  // server-side error so it can react or step back instead of
  // burning tokens on a duplicate.
  //
  // Redis HASH per conversation:
  //   key:   cumora:worklog:<convoId>
  //   field: <taskType>::<normalized subject hash>
  //   value: JSON { agentId, taskType, subject, startedAt }
  // Whole-key TTL = ttlSec on every successful claim. Per-field TTL
  // isn't a primitive in Redis, but every claim refreshes the key
  // and entries are checked for staleness on read, so a 5-min cap
  // works fine in practice.
  //
  // Race safety: HSETNX is atomic, so two agents claiming the same
  // (taskType, subject) at the same moment have a clear winner. The
  // loser gets {accepted: false, existing}.

  async claimWork(args: {
    scopeKey: string
    agentId: string
    taskType: WorkTaskType
    subject: string
    ttlSec?: number
  }): Promise<
    | { accepted: true }
    | { accepted: false; existing: WorklogEntry }
  > {
    const ttl = args.ttlSec ?? 300
    const key = worklogKey(args.scopeKey)
    const field = worklogField(args.taskType, args.subject)
    const now = Date.now()
    const entry: WorklogEntry = {
      agentId: args.agentId,
      taskType: args.taskType,
      subject: args.subject,
      startedAt: now,
    }
    try {
      // HSETNX is the atomic acceptance gate; everyone else loses.
      const written = await redis.hsetnx(key, field, JSON.stringify(entry))
      if (written === 1) {
        // Fresh claim → refresh whole-key TTL so the worklog auto-
        // cleans even if release calls are missed.
        await redis.expire(key, ttl)
        return { accepted: true }
      }
      // HSETNX returned 0 — somebody else holds it. Read the existing
      // entry to tell the caller WHO and HOW LONG AGO. Could be a stale
      // entry past TTL though (HSETNX doesn't honor field-level TTL we
      // don't have): treat anything older than ttlSec as stale, kick
      // it, and try the claim again.
      const rawExisting = await redis.hget(key, field)
      if (!rawExisting) {
        // Race: someone released between HSETNX and HGET. Try once more.
        const retry = await redis.hsetnx(key, field, JSON.stringify(entry))
        if (retry === 1) {
          await redis.expire(key, ttl)
          return { accepted: true }
        }
        // Still couldn't get it; give up cleanly with a synthetic
        // "unknown peer" placeholder so the caller still yields rather
        // than crashing.
        return {
          accepted: false,
          existing: { agentId: '<unknown>', taskType: args.taskType, subject: args.subject, startedAt: now },
        }
      }
      const existing = parseWorklogEntry(rawExisting)
      if (!existing) {
        // Corrupt value — drop the field and let the next caller succeed.
        await redis.hdel(key, field)
        return {
          accepted: false,
          existing: { agentId: '<unknown>', taskType: args.taskType, subject: args.subject, startedAt: now },
        }
      }
      const ageMs = now - existing.startedAt
      if (ageMs > ttl * 1000) {
        // Stale claim — evict and take it over.
        await redis.hdel(key, field)
        const retake = await redis.hsetnx(key, field, JSON.stringify(entry))
        if (retake === 1) {
          await redis.expire(key, ttl)
          return { accepted: true }
        }
        // Lost the eviction race; fall through with the latest holder.
        const refreshed = await redis.hget(key, field)
        const refreshedEntry = refreshed ? parseWorklogEntry(refreshed) : null
        return { accepted: false, existing: refreshedEntry ?? existing }
      }
      return { accepted: false, existing }
    } catch (err) {
      console.warn(`[runtime] claimWork(${args.agentId}, ${args.taskType}) failed — fail-open`,
        err instanceof Error ? err.message : err)
      // Fail-open: a Redis outage shouldn't block real work. The
      // worst case is two agents do the same thing once, which is
      // exactly what we have today.
      return { accepted: true }
    }
  }

  async releaseWork(args: {
    scopeKey: string
    agentId: string
    taskType: WorkTaskType
    subject: string
  }): Promise<void> {
    const key = worklogKey(args.scopeKey)
    const field = worklogField(args.taskType, args.subject)
    try {
      // Only release if we're the holder. A different agent's claim
      // shouldn't be wiped out by our release call.
      const raw = await redis.hget(key, field)
      if (!raw) return
      const existing = parseWorklogEntry(raw)
      if (existing && existing.agentId === args.agentId) {
        await redis.hdel(key, field)
      }
    } catch (err) {
      console.warn(`[runtime] releaseWork(${args.agentId}, ${args.taskType}) failed — TTL will clean`,
        err instanceof Error ? err.message : err)
    }
  }

  /** Is a HUMAN actively watching this company right now? True when any human
   *  participant's read cursor advanced anywhere in the company within the
   *  window. This is the SUPERVISION signal for the triage loop cap: an
   *  activity can legitimately span side rooms the human is excluded from by
   *  the activity's own rules (a werewolf wolf-DM room, a hidden-role channel)
   *  — no message/reaction/read can ever appear there, yet the human IS
   *  overseeing the team from the rooms they can see. Presence elevates those
   *  side threads from the lap floor to the HIGH backstop; it never grants
   *  immunity. Pure DB facts (participants.kind + conversation_reads). */
  async humanRecentlyActive(companyId: string, windowMinutes = 10): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1
         FROM conversation_reads cr
         JOIN participants hp ON hp.id = cr.user_id AND hp.company_id = $1
        WHERE hp.kind = 'human'
          AND cr.last_read_at > NOW() - ($2 || ' minutes')::interval
        LIMIT 1`,
      [companyId, String(windowMinutes)],
    )
    return rows.length > 0
  }

  async peekWorklog(scopeKey: string): Promise<WorklogEntry[]> {
    const key = worklogKey(scopeKey)
    try {
      const raw = await redis.hgetall(key)
      const now = Date.now()
      const out: WorklogEntry[] = []
      for (const v of Object.values(raw)) {
        const entry = parseWorklogEntry(v)
        if (!entry) continue
        // Drop anything past 5 min — a defensive read-time filter that
        // matches the write-time TTL even if it slipped due to refresh
        // glitches.
        if (now - entry.startedAt > 5 * 60 * 1000) continue
        out.push(entry)
      }
      // Stable order by start time (oldest first) so peers see who got
      // there first.
      out.sort((a, b) => a.startedAt - b.startedAt)
      return out
    } catch (err) {
      console.warn(`[runtime] peekWorklog(${scopeKey}) failed`,
        err instanceof Error ? err.message : err)
      return []
    }
  }

  async markConversationRead(args: {
    agentId: string
    conversationId: string
    upToMessageId: string
  }): Promise<void> {
    // Monotonic advance via ROW comparison: only update the cursor
    // when the incoming (created_at, message_id) pair lexicographically
    // exceeds the existing pair. This makes the operation idempotent,
    // out-of-order safe, AND collision-safe — two messages with the
    // same created_at are distinguishable by id.
    try {
      await pool.query(
        `WITH msg AS (
           SELECT created_at, id AS message_id FROM messages WHERE id = $1
         )
         INSERT INTO conversation_reads (user_id, conversation_id, last_read_at, last_read_message_id)
         SELECT $2, $3, msg.created_at, msg.message_id FROM msg
         ON CONFLICT (user_id, conversation_id)
         DO UPDATE SET
           last_read_at = CASE
             WHEN ROW(EXCLUDED.last_read_at, EXCLUDED.last_read_message_id)
                > ROW(conversation_reads.last_read_at, conversation_reads.last_read_message_id)
             THEN EXCLUDED.last_read_at ELSE conversation_reads.last_read_at END,
           last_read_message_id = CASE
             WHEN ROW(EXCLUDED.last_read_at, EXCLUDED.last_read_message_id)
                > ROW(conversation_reads.last_read_at, conversation_reads.last_read_message_id)
             THEN EXCLUDED.last_read_message_id ELSE conversation_reads.last_read_message_id END`,
        [args.upToMessageId, args.agentId, args.conversationId],
      )
    } catch (err) {
      console.warn(`[runtime] markConversationRead(${args.agentId}, ${args.conversationId}, ${args.upToMessageId}) failed — dropping`,
        err instanceof Error ? err.message : err)
    }
  }
}

/** Redis key for the per-agent busy lease — exported so the server-
 *  side delivery routing (which doesn't go through the runtime client)
 *  can read it directly. Keep the prefix short — busy:* sorts cleanly
 *  with the other cumora:* keys when scanning. */
export function busyKey(agentId: string): string {
  return `cumora:busy:${agentId}`
}

/** Redis key for the per-conversation thinking set. Members are
 *  agentIds; peers read this via peekThinking() to know who else is
 *  currently composing a response. */
export function thinkingKey(conversationId: string): string {
  return `cumora:thinking:${conversationId}`
}

export { getThinkingConversations } from '../thinking-convos.js'

/** Redis key for the per-scope worklog HASH. `scopeKey` is whatever
 *  namespace the caller wants — `tenant:<companyId>` for tenant-wide
 *  claims, `convo:<conversationId>` for conversation-scoped ones.
 *  Fields are `<taskType>::<normalized subject>`; values are
 *  JSON-encoded WorklogEntry. Anti-duplicate-work claims live here. */
export function worklogKey(scopeKey: string): string {
  return `cumora:worklog:${scopeKey}`
}

/** Normalize a work subject (doc title, search query, …) so trivially-
 *  different phrasings ("Warm Pastels  " vs "warm pastels") collide.
 *  Shared by the worklog field id AND the recently-created-duplicate
 *  checks (doc/calendar create) so "same subject" means one thing. */
export function normalizeWorkSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** Build the HASH field id for a (taskType, subject) pair. Truncation
 *  to 80 chars bounds key size without throwing away enough specificity
 *  to cause false collisions. */
export function worklogField(taskType: string, subject: string): string {
  return `${taskType}::${normalizeWorkSubject(subject)}`
}

/** Parse a JSON-encoded WorklogEntry back into shape. Returns null on
 *  malformed input so callers can degrade gracefully instead of
 *  throwing. */
function parseWorklogEntry(raw: string): WorklogEntry | null {
  try {
    const v = JSON.parse(raw) as Partial<WorklogEntry>
    if (
      typeof v?.agentId === 'string' &&
      typeof v?.taskType === 'string' &&
      typeof v?.subject === 'string' &&
      typeof v?.startedAt === 'number'
    ) {
      return v as WorklogEntry
    }
    return null
  } catch {
    return null
  }
}

/** True iff the agent has a live busy heartbeat (a pod is currently
 *  running a turn for them). Used by the server's message-routing
 *  path to decide between deliverSteer (busy → inject mid-turn) and
 *  deliver-wake (idle → start a new turn). */
export async function isAgentBusy(agentId: string): Promise<boolean> {
  try {
    const v = await redis.get(busyKey(agentId))
    return v !== null && v !== ''
  } catch {
    // Redis unavailable → fail-open as "not busy" so the regular wake
    // path still works. Worst case: a busy agent waits one turn for
    // the new message — same as pre-steer behaviour.
    return false
  }
}

/** Singleton — there's only one server process, one DB, one Redis;
 *  keep one client instance for the whole runtime. */
// Concrete type (not the AgentRuntimeClient interface): the server-side
// runtime routes use in-proc-only helpers like isConversationMember that the
// HTTP client has no need to implement. It still satisfies AgentRuntimeClient.
export const inprocClient: InProcRuntimeClient = new InProcRuntimeClient()
