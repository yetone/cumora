/**
 * Versioned schema migrator.
 *
 * Only the standalone migration command calls this module in production.
 * Application replicas use the read-only compatibility gate in
 * schema-version.ts and never execute DDL while starting.
 */
import { createHash } from 'node:crypto'
import { pool } from './pool.js'
import {
  type AppliedMigration,
  type MigrationMetadata,
  SCHEMA_MIGRATIONS,
  validateMigrationHistory,
} from './migrations/manifest.js'
import {
  NORMALIZED_CONVERSATION_MEMBERS_SQL,
  normalizedConversationMembersChecksum,
} from './migrations/0002-normalized-conversation-members.js'

/** Frozen data backfill embedded in migration 0001. Exported so its behavior
 * can be exercised against PostgreSQL without replaying the whole migration. */
export const BASELINE_BOARD_COLUMN_KIND_BACKFILL_SQL = `UPDATE board_columns SET kind = 'todo'
 WHERE kind IS NULL AND lower(btrim(title)) IN ('todo', 'to do');
UPDATE board_columns SET kind = 'doing'
 WHERE kind IS NULL AND lower(btrim(title)) = 'doing';
UPDATE board_columns SET kind = 'done'
 WHERE kind IS NULL AND lower(btrim(title)) = 'done';`

const DDL = `
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  members      JSONB NOT NULL,
  pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  tag          TEXT,
  pulled_by    JSONB,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  author_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  body            TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  reactions       JSONB,
  tool            JSONB,
  attachment      JSONB,
  client_id       TEXT,
  -- A membership departure message remains in the removed participant's
  -- runtime inbox even though the conversation membership update has already
  -- committed. Null for ordinary messages.
  delivery_recipient_id TEXT,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_convo_seq ON messages(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_messages_convo_created ON messages(conversation_id, created_at);

-- Transactional realtime outbox. Durable mutations write their invalidation
-- here in the SAME PostgreSQL transaction; a bounded worker publishes to Redis
-- after commit. Redis is therefore never part of command completion.
CREATE TABLE IF NOT EXISTS realtime_outbox (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  payload       JSONB NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  available_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  locked_by     TEXT,
  locked_until  TIMESTAMP WITH TIME ZONE,
  published_at  TIMESTAMP WITH TIME ZONE,
  discarded_at  TIMESTAMP WITH TIME ZONE,
  last_error    TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT realtime_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_realtime_outbox_pending
  ON realtime_outbox(available_at, created_at)
  WHERE published_at IS NULL AND discarded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_realtime_outbox_published
  ON realtime_outbox(published_at)
  WHERE published_at IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_recipient_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_delivery_recipient
  ON messages(delivery_recipient_id, created_at, id)
  WHERE delivery_recipient_id IS NOT NULL;

-- Reply-to / quote target. Soft self-FK (no ON DELETE CASCADE) so deleting
-- the original leaves replies as orphans rendered as "[deleted]" stubs
-- rather than wiping the reply thread. Idx supports the thread-fetch
-- endpoint (all messages quoting a given root).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS quoted_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_quoted ON messages(quoted_message_id);

CREATE TABLE IF NOT EXISTS participants (
  id             TEXT NOT NULL,
  -- Composite PK with company_id below — the same id (e.g. a user's id, or
  -- "atlas") can exist as a participant in multiple companies independently.
  -- See the migration block further down that drops a legacy single-column
  -- PK if one exists.
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  role           TEXT,
  initial        TEXT NOT NULL,
  avatar_bg      TEXT NOT NULL,
  status         TEXT NOT NULL,
  bio            TEXT,
  tools          JSONB,
  system_prompt  TEXT
);

CREATE TABLE IF NOT EXISTS conversation_counters (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  next_sequence   INTEGER NOT NULL DEFAULT 1
);

-- ============== Convening info for agent-pulled groups ==============
CREATE TABLE IF NOT EXISTS convening_info (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  pulled_by_id     TEXT NOT NULL,
  pulled_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  headline_lead    TEXT NOT NULL,
  headline_tail    TEXT NOT NULL,
  subhead          TEXT NOT NULL,
  who_and_why      JSONB NOT NULL,
  evidence         JSONB NOT NULL,
  asks             JSONB NOT NULL,
  trigger          JSONB NOT NULL,
  reasoning        JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open'  -- 'open' | 'proceeding' | 'reframed' | 'dissolved'
);

-- ============== Convene live sessions ==============
CREATE TABLE IF NOT EXISTS convene_sessions (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  flair            TEXT,
  started_by       TEXT NOT NULL,
  started_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMP WITH TIME ZONE,
  state            TEXT NOT NULL DEFAULT 'live'  -- 'live' | 'ended'
);

CREATE TABLE IF NOT EXISTS convene_transcript (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES convene_sessions(id) ON DELETE CASCADE,
  author_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,  -- 'text' | 'thought' | 'tool' | 'decision'
  body        TEXT NOT NULL,
  sequence    INTEGER NOT NULL,
  decision    JSONB,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_convene_transcript_session_seq ON convene_transcript(session_id, sequence);

-- ============== User preferences ==============
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     TEXT PRIMARY KEY,
  prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_autonomy (
  user_id    TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  threshold  REAL NOT NULL DEFAULT 0.6,
  pulled     INTEGER NOT NULL DEFAULT 0,
  led        INTEGER NOT NULL DEFAULT 0,
  dissolved  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_id)
);

-- ============== Reactions (per user, per message) ==============
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

-- ============== Tool execution log ==============
CREATE TABLE IF NOT EXISTS tool_calls (
  id          TEXT PRIMARY KEY,
  message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  args        JSONB NOT NULL,
  result      JSONB,
  status      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'ok' | 'error'
  error       TEXT,
  duration_ms INTEGER,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_id, created_at DESC);
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);

-- ============== Agent observability =======================================
-- One row per scheduler-triggered agent turn, plus a durable timeline of
-- backend-recorded events. The UI only renders this data; the backend owns the
-- trace so stalled model streams / tool calls still leave evidence.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  company_id        TEXT,
  trigger           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed | skipped
  stage             TEXT,
  summary           TEXT,
  error             TEXT,
  input_message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  inbox_count       INTEGER NOT NULL DEFAULT 0,
  tool_call_count   INTEGER NOT NULL DEFAULT 0,
  token_count       INTEGER NOT NULL DEFAULT 0,
  fingerprint       TEXT,
  started_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_started ON agent_runs(agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_company_started ON agent_runs(company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_updated ON agent_runs(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at);  -- db-gc sweep
-- Cache-aware cost accounting (token_count stays as the legacy input+output sum).
-- input_tokens = UNCACHED input; cached_input_tokens = cache-READ; cache_creation
-- = cache-WRITE. cost_usd is the cache-aware effective cost (see agents/cost.ts);
-- cost_estimated flags a seeded/fallback price vs an operator-supplied rate.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS input_tokens          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cached_input_tokens   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS output_tokens         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cost_estimated        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model                 TEXT;  -- big-brain model id, for showing the rate the cost used

CREATE TABLE IF NOT EXISTS agent_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  company_id  TEXT,
  kind        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',  -- debug | info | warn | error
  title       TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_events_agent ON agent_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_created ON agent_events(created_at);  -- db-gc sweep

-- One row per inbox-triage call (the small-brain gate). The whole point is to
-- measure HONESTLY whether the gate saves money: each triage is a cold session
-- (0 cache hits → full-price input), so it can cost more than the cached big-
-- brain turn it shields. We record every triage's cache-aware cost + verdict so
-- the ledger can compare triage spend vs the turns it skips. run_id links to the
-- big-brain run a triage WOKE (actionable=true), null when it skipped.
CREATE TABLE IF NOT EXISTS agent_triages (
  id                    TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL,
  company_id            TEXT,
  source                TEXT NOT NULL,                 -- cloud | byoa-claude | byoa-codex | byoa-grok | byoa-cursor | byoa-opencode | byoa-pi | byoa-gemini | byoa-qwen
  model                 TEXT,
  actionable            BOOLEAN NOT NULL DEFAULT FALSE, -- verdict: woke the big brain?
  reason                TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,    -- uncached input (triage is always cold)
  cached_input_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_estimated        BOOLEAN NOT NULL DEFAULT TRUE,
  measured              BOOLEAN NOT NULL DEFAULT TRUE,  -- false = usage unavailable (e.g. codex)
  run_id                TEXT,                          -- the big-brain run this woke, if any
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_triages_company_created ON agent_triages(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_triages_agent_created ON agent_triages(agent_id, created_at DESC);

-- One row per OUTBOUND cloud-LLM call (sub2api). The universal ledger so every
-- sub2api token can be attributed back to the business purpose that spent it:
-- inbox triage, synthetic-wake gate, agenda classifier, auto-compaction,
-- completion-verify, steer-summary, convene speech, convene decision, palette,
-- gender inference, avatar image-gen, and the main agent turn (one row per
-- model hop). agent_runs stays the per-turn aggregate; agent_triages stays
-- the per-triage denormalized view; this is the universal, per-call truth.
--
-- Recorded for every call:
--   - WHO: company_id (tenant), agent_id (when applicable), run_id (when part
--          of a turn), conversation_id (when applicable, e.g. convene).
--   - WHAT: purpose (the business reason), model, source (cloud|byoa-claude|
--           byoa-codex|byoa-grok|byoa-cursor|byoa-opencode — almost always 'cloud' here; BYOA local triages still
--           write to agent_triages with their own source).
--   - HOW MUCH: cache-aware token breakdown + cost_usd (computed at insert
--               via cost.ts → priceFor; cost_estimated flags seeded vs operator-
--               supplied rate). reasoning_tokens captured separately when the
--               provider surfaces it.
--   - RESULT: status ('ok' | 'rate_limited' | 'timeout' | 'failed') + error
--             (truncated). latency_ms wall-clock from create() to settle.
--   - WHY: extras JSONB for purpose-specific labels (triage actionable verdict,
--          compaction history_tokens_before, steer batch size, ...).
CREATE TABLE IF NOT EXISTS llm_calls (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT,
  agent_id              TEXT,
  run_id                TEXT,
  conversation_id       TEXT,
  purpose               TEXT NOT NULL,
  source                TEXT NOT NULL DEFAULT 'cloud',
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_estimated        BOOLEAN NOT NULL DEFAULT TRUE,
  measured              BOOLEAN NOT NULL DEFAULT TRUE,
  latency_ms            INTEGER,
  status                TEXT NOT NULL DEFAULT 'ok',
  error                 TEXT,
  extras                JSONB,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
-- Spend rollup by tenant × purpose (the primary query: "which business burned
-- the most mini for this company last month?"). created_at DESC last so a
-- range scan within the (company, purpose) bucket is index-ordered.
CREATE INDEX IF NOT EXISTS idx_llm_calls_company_purpose_created ON llm_calls(company_id, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at);  -- db-gc sweep
-- Per-run trace: every model hop of one turn, in order.
CREATE INDEX IF NOT EXISTS idx_llm_calls_run_created ON llm_calls(run_id, created_at ASC) WHERE run_id IS NOT NULL;
-- Per-agent spend over time.
CREATE INDEX IF NOT EXISTS idx_llm_calls_agent_created ON llm_calls(agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
-- Model-level rollup ("of all my gpt-5.4-mini spend, which purposes?").
CREATE INDEX IF NOT EXISTS idx_llm_calls_model_purpose_created ON llm_calls(model, purpose, created_at DESC);
-- Daemon version on BYOA rows so the operator can correlate spend / cache
-- behaviour with the agent-cli release that produced them. Idempotent ALTER
-- so existing rows stay (their version is unknown → NULL). NULL on cloud
-- agent-turn rows is fine; only BYOA paths populate it.
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS daemon_version TEXT;
CREATE INDEX IF NOT EXISTS idx_llm_calls_daemon_version_created ON llm_calls(daemon_version, created_at DESC) WHERE daemon_version IS NOT NULL;

-- ── Pre-aggregated rollup of llm_calls for the Observability dashboard ──────
-- Measured root cause of the slow Observability API: the whole llm_calls table
-- (~470k rows, growing ~70k/day) lives inside the 30d window, so every one of
-- the page's 6 aggregations is a full seq scan, and they run concurrently and
-- contend (5-25s wall). No index prunes a "last N days" filter when N days IS
-- the whole table.
--
-- Fix: maintain an hourly-bucketed rollup at the FINEST grain every dashboard
-- query needs — (bucket_hour × company × agent × purpose × model × source ×
-- daemon_version). Measured ~30k rows for 30d (15× smaller than raw); the full
-- 6-query fan-out off this table is ~230ms vs 5-25s. The page reads THIS; only
-- the drill-down (raw call rows) still touches llm_calls (already indexed by
-- run/agent). Refreshed incrementally by the llm-rollup worker (server boot).
--
-- nullable company/agent/daemon are part of the identity, so the upsert key is
-- a NULLS NOT DISTINCT unique index (PG15+) — two NULL-company rows for the
-- same (hour,purpose,model,…) collapse to one bucket instead of duplicating.
CREATE TABLE IF NOT EXISTS llm_calls_rollup (
  bucket_hour           TIMESTAMP WITH TIME ZONE NOT NULL,
  company_id            TEXT,
  agent_id              TEXT,
  purpose               TEXT NOT NULL,
  model                 TEXT NOT NULL,
  source                TEXT NOT NULL,
  daemon_version        TEXT,
  calls                 BIGINT NOT NULL DEFAULT 0,
  ok_calls              BIGINT NOT NULL DEFAULT 0,
  failed_calls          BIGINT NOT NULL DEFAULT 0,
  rate_limited_calls    BIGINT NOT NULL DEFAULT 0,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  cached_input_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  reasoning_tokens      BIGINT NOT NULL DEFAULT 0,
  cost_usd              DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_estimated        BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_rollup_key
  ON llm_calls_rollup (bucket_hour, company_id, agent_id, purpose, model, source, daemon_version)
  NULLS NOT DISTINCT;
-- Read path: every dashboard query filters bucket_hour > now() - N days.
CREATE INDEX IF NOT EXISTS idx_llm_rollup_bucket ON llm_calls_rollup (bucket_hour DESC);

-- Legacy mocked side-effect tools were removed from the CLI surface.
DROP TABLE IF EXISTS notion_pages;
DROP TABLE IF EXISTS github_branches;

CREATE TABLE IF NOT EXISTS conversation_reads (
  user_id          TEXT NOT NULL,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  last_read_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Tiebreaker for messages with the same created_at (possible under
  -- burst INSERT load — Postgres NOW() resolution is microsecond, but
  -- two inserts can land in the same microsecond). Pair with
  -- last_read_at as ROW(last_read_at, last_read_message_id) for
  -- strict lex comparison in loadInbox; ROW comparison is
  -- well-defined even when one side is NULL (uses NULL-FIRST
  -- semantics, which is fine here since '' < any real message id).
  last_read_message_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, conversation_id)
);
-- Idempotent column add for existing dbs (table CREATE TABLE IF NOT
-- EXISTS skips when the table already exists, so the new column needs
-- a separate ALTER TABLE wrapped in a DO block to be no-op safe).
DO $$ BEGIN
  ALTER TABLE conversation_reads
    ADD COLUMN IF NOT EXISTS last_read_message_id TEXT NOT NULL DEFAULT '';
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

-- Per-user mute. Presence of a row = mute is configured. The mute is
-- ACTIVE iff muted_until IS NULL (forever) OR muted_until > NOW().
-- Mute suppresses notifications + excludes from the global unread total,
-- but does NOT mark messages as read — the per-row unread badge still
-- shows (just visually subdued so the user knows it's silent).
CREATE TABLE IF NOT EXISTS conversation_mutes (
  user_id          TEXT NOT NULL,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  muted_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  muted_until      TIMESTAMP WITH TIME ZONE,  -- NULL = forever
  PRIMARY KEY (user_id, conversation_id)
);
-- Idempotent backfill: an earlier dev build of this table didn't have
-- muted_until, so CREATE TABLE IF NOT EXISTS skips re-creation and we
-- have to ALTER the existing row in.
ALTER TABLE conversation_mutes ADD COLUMN IF NOT EXISTS muted_until TIMESTAMP WITH TIME ZONE;

-- ============== Per-agent workspace (virtual filesystem) ==============
CREATE TABLE IF NOT EXISTS agent_workspace (
  agent_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  meta       JSONB,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, path)
);
CREATE INDEX IF NOT EXISTS idx_agent_workspace_agent ON agent_workspace(agent_id, updated_at DESC);

-- ============== Per-agent memory (distilled notes / observations) ==============
CREATE TABLE IF NOT EXISTS agent_memory (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- observation | preference | fact | decision | note
  about      TEXT,                  -- subject id: yetone | iris | aurora | …
  body       TEXT NOT NULL,
  source     JSONB,                 -- {conversationId?, messageId?}
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_about ON agent_memory(agent_id, about);

-- ============== Per-agent activity log ==============
CREATE TABLE IF NOT EXISTS agent_log (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- reply | tool | status | dm | pull_group | note
  body       TEXT NOT NULL,
  ref        JSONB,                 -- linked ids
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_log_agent ON agent_log(agent_id, created_at DESC);
-- Bare time index: the db-gc retention sweep probes "rows older than N days"
-- with no agent filter; without this it seq-scans the (multi-GB) heap and
-- times out. Same reasoning for the other high-volume tables below.
CREATE INDEX IF NOT EXISTS idx_agent_log_created ON agent_log(created_at);

-- ============== Per-agent tasks ==============
CREATE TABLE IF NOT EXISTS agent_tasks (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',  -- open | doing | done | dropped
  due_at     TIMESTAMP WITH TIME ZONE,
  ref        JSONB,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent ON agent_tasks(agent_id, status, updated_at DESC);

-- Soft-delete: agents are off-boarded (departed_at set) rather than hard-deleted,
-- so their memory / log / workspace / tasks survive and they can be re-hired.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS departed_at TIMESTAMP WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS idx_participants_active ON participants(kind) WHERE departed_at IS NULL;

-- Busy statuses are leases, not permanent truth. Agent turns refresh this
-- timestamp while they are thinking / working; readers expire stale busy
-- states back to "avail" when the lease has not been renewed.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE;
UPDATE participants SET status_updated_at = NOW() WHERE status_updated_at IS NULL;
ALTER TABLE participants ALTER COLUMN status_updated_at SET DEFAULT NOW();
ALTER TABLE participants ALTER COLUMN status_updated_at SET NOT NULL;

-- AI-generated portrait URL. When set, the UI renders this in place of the
-- color-block + initial fallback. The colored avatar_bg stays as the fallback.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Per-agent model override (NULL = use the system default). Stored on the
-- agent row so it's editable from the UI like any other field — no env-var
-- gymnastics keyed off user-defined agent ids.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS model TEXT;

-- A free-form topic/purpose line per conversation — the answer to "what's
-- this group for?". Editable by any member (incl. agents via the cumora CLI),
-- surfaced in the chat header and inlined in agents' wake prompts so they
-- always know what the room is about.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS topic TEXT;

-- ============== Multi-tenancy: companies =================================
-- Every piece of data ultimately belongs to ONE company; data NEVER crosses
-- the company boundary. The companies row is the tenant record; every
-- other table gets a company_id column + index.
--
-- For the migration of an existing single-tenant DB, we:
--   1. Create the table.
--   2. Insert a default 'personal' company if it doesn't exist.
--   3. Add company_id columns to every data table (nullable).
--   4. Backfill all existing rows to the default company.
--   5. The application layer (router middleware) resolves "current company"
--      per request and filters every query by it (Pass 2).
CREATE TABLE IF NOT EXISTS companies (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  owner_user_id TEXT,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
-- Idempotency marker for starter-agent onboarding. Set ONCE after the
-- initial seed runs; thereafter the user is free to off-board / delete /
-- ignore those agents and we never re-seed. Without this flag a
-- "company has 0 agents" backfill would resurrect agents the user
-- deliberately removed every server restart.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS starter_seeded_at TIMESTAMP WITH TIME ZONE;
-- Separate flag for the per-agent direct-chat seeding step. Decoupled from
-- starter_seeded_at because we added DM creation AFTER initial agent
-- seeding shipped — workspaces that got agents-but-no-DMs need this
-- one-shot to create their DMs without re-seeding agents.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS starter_dms_seeded_at TIMESTAMP WITH TIME ZONE;
-- Every company has ONE persistent #all-hands group that every member
-- (humans + agents) is auto-joined to on creation. The conversation id is
-- stored here; we never recreate it once set. ON DELETE SET NULL guards
-- against orphaning the column if the conversation is somehow purged.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS all_hands_conversation_id TEXT
  REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS all_hands_seeded_at TIMESTAMP WITH TIME ZONE;

INSERT INTO companies (id, name, slug)
VALUES ('personal', 'Personal', 'personal')
ON CONFLICT (id) DO NOTHING;

-- User → Company membership (a user can be in multiple companies).
CREATE TABLE IF NOT EXISTS company_members (
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member
  joined_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, user_id)
);

-- Dev seed membership (yetone ↔ 'personal' company) lives in seed.ts, not
-- here. Keeping it in DDL meant every prod boot tried to insert a row
-- referencing a user id that only exists in dev seed data.

-- Add company_id to every tenant-bound table.
ALTER TABLE participants        ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE conversations       ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE messages            ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE convening_info      ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE convene_sessions    ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE convene_transcript  ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE user_preferences    ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_autonomy      ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE message_reactions   ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE tool_calls          ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE conversation_reads  ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_workspace     ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_memory        ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_log           ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_tasks         ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_runs          ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE agent_events        ADD COLUMN IF NOT EXISTS company_id TEXT;

-- Backfill: any pre-existing data lives in the 'personal' company.
UPDATE participants        SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE conversations       SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE messages            SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE convening_info      SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE convene_sessions    SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE convene_transcript  SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE user_preferences    SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_autonomy      SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE message_reactions   SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE tool_calls          SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE conversation_reads  SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_workspace     SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_memory        SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_log           SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_tasks         SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_runs          SET company_id = 'personal' WHERE company_id IS NULL;
UPDATE agent_events        SET company_id = 'personal' WHERE company_id IS NULL;

-- Backfill per-agent data with the agent's REAL company instead of the
-- 'personal' placeholder above. The original null-backfill predates the
-- multi-tenant migration and set every agent-scoped row to 'personal',
-- which doesnt match any real co-... id, so the Observability panel
-- (filters by users active tenant) couldnt see any of the agent
-- workspace files / memory / log / tasks. Idempotent — only fires on
-- rows still tagged 'personal' that have a real agent owner.
UPDATE agent_workspace aw SET company_id = p.company_id
  FROM participants p
 WHERE aw.agent_id = p.id AND aw.company_id = 'personal' AND p.company_id IS NOT NULL;
UPDATE agent_memory am SET company_id = p.company_id
  FROM participants p
 WHERE am.agent_id = p.id AND am.company_id = 'personal' AND p.company_id IS NOT NULL;
UPDATE agent_log al SET company_id = p.company_id
  FROM participants p
 WHERE al.agent_id = p.id AND al.company_id = 'personal' AND p.company_id IS NOT NULL;
UPDATE agent_tasks at SET company_id = p.company_id
  FROM participants p
 WHERE at.agent_id = p.id AND at.company_id = 'personal' AND p.company_id IS NOT NULL;
UPDATE agent_runs ar SET company_id = p.company_id
  FROM participants p
 WHERE ar.agent_id = p.id AND ar.company_id = 'personal' AND p.company_id IS NOT NULL;
UPDATE agent_events ae SET company_id = p.company_id
  FROM participants p
 WHERE ae.agent_id = p.id AND ae.company_id = 'personal' AND p.company_id IS NOT NULL;

-- Memory becomes files in the agents workspace. One-shot copy each
-- agent_memory row into agent_workspace at memory/<kind>/<id>.md with
-- the kind / about / pinned / source metadata preserved in meta JSONB.
-- Idempotent via ON CONFLICT — re-running this migration after the
-- table is partially copied just skips already-present paths.
INSERT INTO agent_workspace (agent_id, path, body, meta, company_id, updated_at)
SELECT
  m.agent_id,
  'memory/' || m.kind || '/' || m.id || '.md',
  m.body,
  jsonb_build_object(
    'type', 'memory',
    'kind', m.kind,
    'about', m.about,
    'pinned', m.pinned,
    'source', m.source,
    'createdAt', m.created_at
  ),
  m.company_id,
  m.created_at
FROM agent_memory m
ON CONFLICT (agent_id, path) DO NOTHING;

-- Partial JSONB index so memory-list filters by about stay fast even
-- when the agent has thousands of files in their workspace.
CREATE INDEX IF NOT EXISTS idx_workspace_memory_about
  ON agent_workspace ((meta->>'about'))
  WHERE path LIKE 'memory/%';

-- Promote participants PK from (id) to (id, company_id) so the same id can
-- exist in multiple tenants. Existing single-column PK comes from earlier
-- schema versions where participants were single-tenant; drop it before
-- adding the composite. participants.company_id was nullable above; force
-- it NOT NULL after backfill so the composite key is well-defined.
ALTER TABLE participants ALTER COLUMN company_id SET NOT NULL;
DO $$
DECLARE pk_name TEXT;
BEGIN
  SELECT tc.constraint_name INTO pk_name
    FROM information_schema.table_constraints tc
   WHERE tc.table_name = 'participants'
     AND tc.constraint_type = 'PRIMARY KEY';
  IF pk_name IS NOT NULL THEN
    -- Check if the current PK is already (id, company_id) — skip if so.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.key_column_usage
       WHERE table_name = 'participants' AND constraint_name = pk_name
         AND column_name = 'company_id'
    ) THEN
      EXECUTE 'ALTER TABLE participants DROP CONSTRAINT ' || quote_ident(pk_name);
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'participants' AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE participants ADD PRIMARY KEY (id, company_id);
  END IF;
END$$;

-- Indexes for the company_id filter on the hot tables.
CREATE INDEX IF NOT EXISTS idx_participants_company  ON participants(company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_company ON conversations(company_id, updated_at DESC);
-- NOTE: the GIN index for members-array containment (members @> [agentId]) is
-- NOT built here. A plain CREATE INDEX on this hot table holds a build-long lock
-- that blocks live member-writes and deadlocks (40P01) under traffic — and since
-- the build then never commits, every pod retried it forever and none could
-- boot. The dedicated migration owner builds it CONCURRENTLY outside this
-- transaction and treats readiness as a promotion requirement. See
-- buildConcurrentIndexes() below.
CREATE INDEX IF NOT EXISTS idx_messages_company      ON messages(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memory_company  ON agent_memory(company_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_log_company     ON agent_log(company_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_company    ON agent_runs(company_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_company  ON agent_events(company_id, created_at DESC);

-- ============== Auth: users + sessions ==============
-- Real auth foundation. Passwords are hashed with crypto.scrypt (Node built-in,
-- no native dep). Sessions live in DB so they can be revoked. Tokens are
-- 256-bit random base64url.
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  -- "scrypt:<salt-base64>:<derived-base64>" — single-column scheme,
  -- self-describing for future hash-algo upgrades.
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email));

-- Email verification — email_verified_at is set when the user clicks the
-- verification link. NULL means "unverified".
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP WITH TIME ZONE;

-- User-scoped avatar URL, mirrored from OAuth provider at first sign-in
-- and reused when the user is mirrored as a participants row in every
-- company they belong to. Pre-invite-fix, each per-company participants
-- row stored its own avatar independently (gravatar fallback in invited
-- workspaces gave blank silhouettes); centralizing on the user row keeps
-- one face per user across every workspace.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Email-verification tokens. Same shape + hashing as password-reset tokens.
-- 7-day TTL — verification isn't time-sensitive the way password reset is.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at     TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_email_verify_user ON email_verification_tokens(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  -- Stored hash (sha256 b64url) of the raw token. The raw token is never
  -- written to disk — DB read alone cannot mint a usable session.
  token_hash      TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
  last_used_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  ip              TEXT,
  user_agent      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- One-shot migration off the old plaintext-token schema. Old rows can't be
-- back-hashed (we'd need the raw token, which we no longer have), so we
-- drop them — every existing session re-logs-in once. Cheap.
--
-- This block also handles "table existed before token_hash was added": on
-- pre-feature DBs, CREATE TABLE IF NOT EXISTS above is a no-op (table is
-- already there), so token_hash column would be missing. Add it here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sessions' AND column_name = 'token'
  ) THEN
    DELETE FROM sessions;
    ALTER TABLE sessions DROP COLUMN token;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sessions' AND column_name = 'token_hash'
  ) THEN
    ALTER TABLE sessions ADD COLUMN token_hash TEXT;
    -- empty-table case: token_hash NOT NULL + PK ok; otherwise force re-login.
    DELETE FROM sessions;
    ALTER TABLE sessions ALTER COLUMN token_hash SET NOT NULL;
    -- Make it the PK if no PK exists (replaces the old "token" PK we just dropped).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
       WHERE table_name = 'sessions' AND constraint_type = 'PRIMARY KEY'
    ) THEN
      ALTER TABLE sessions ADD PRIMARY KEY (token_hash);
    END IF;
  END IF;
END$$;

-- ============== Climate: per-agent emotional snapshot of the people they know
-- An agent's evolving impression of someone — affinity, trust, and a freeform
-- "last note" that captures the most recent emotional flavor of the
-- relationship. Surfaced in the wake prompt as "Climate around you" so an
-- agent isn't every-conversation-from-scratch about how they feel toward
-- their teammates.
--
--   affinity ∈ [-1, 1]    -1 = hostile / 0 = neutral / 1 = warm
--   trust    ∈ [-1, 1]    -1 = unreliable / 0 = unknown / 1 = trusted
--
-- Updated by the agent themselves via "cumora climate note" (when something
-- noteworthy happens) or implicitly when they read someone's recent
-- behavior. Read via "cumora climate read".
CREATE TABLE IF NOT EXISTS agent_climate (
  agent_id    TEXT NOT NULL,
  about_id    TEXT NOT NULL,
  company_id  TEXT NOT NULL DEFAULT 'personal',
  affinity    REAL NOT NULL DEFAULT 0,
  trust       REAL NOT NULL DEFAULT 0,
  last_note   TEXT NOT NULL DEFAULT '',
  history     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- list of {at, affinity, trust, note}
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, about_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_climate_agent   ON agent_climate(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_climate_company ON agent_climate(company_id);

-- ============== Login throttle: per-(email, ip) recent failure log ==========
-- Used by /auth/login to enforce a sliding-window rate limit and an account
-- lockout after N consecutive failures on the same email. Cleaned up
-- opportunistically — old rows just stop counting once they fall outside
-- the window.
CREATE TABLE IF NOT EXISTS auth_attempts (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT,                  -- lowercased; null for non-email events
  ip          TEXT,
  success     BOOLEAN NOT NULL,
  reason      TEXT,                  -- 'bad_password' | 'unknown_email' | 'locked' | 'ok' | ...
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_email  ON auth_attempts(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip     ON auth_attempts(ip, created_at DESC);

-- ============== Audit log: forensics record of auth-relevant events ========
CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT,
  company_id  TEXT,
  ip          TEXT,
  user_agent  TEXT,
  kind        TEXT NOT NULL,         -- signup | login | login_failed | logout | password_reset | company_create | ...
  detail      JSONB,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_user    ON audit_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_kind    ON audit_events(kind, created_at DESC);

-- ============== OAuth identities (Google / GitHub) ========================
-- One row per (provider, provider_id) pair. A user_id may have multiple rows
-- (auto-linking by verified email lets the same person log in via either
-- provider and land on the same account). email_lower captures the email the
-- provider gave us at link time — used for cross-provider lookup AND so we
-- can audit changes if a provider later returns a different email.
CREATE TABLE IF NOT EXISTS user_identities (
  provider     TEXT NOT NULL,           -- 'google' | 'github' | 'gitlab' | 'apple'
  provider_id  TEXT NOT NULL,           -- sub (Google) / numeric id (GitHub)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_lower  TEXT NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user   ON user_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_email  ON user_identities(email_lower);

-- Migration: password auth is gone. Make password_hash nullable so OAuth-only
-- users can be created without a password, then drop the verification + reset
-- token tables (no more email-verification or password-reset flows).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS email_verification_tokens;

-- ============== sub2api quota gateway link =================================
-- Each cumora user is mirrored as a sub2api user so their LLM calls go
-- through that user's quota group (free / pro / max). We store:
--   tier             — soft label for the renderer (free|pro|max)
--   sub2api_user_id  — numeric id from sub2api's admin API, for tier swaps
--                       via POST /api/v1/admin/users/:id/replace-group
--   sub2api_api_key  — the user-scoped key cumora-server uses when calling
--                       the OpenAI-compatible base on sub2api. NEVER show
--                       to the renderer — it'd grant LLM access to anyone
--                       who steals it for the lifetime of the key.
-- All three are nullable for backwards-compat: pre-sub2api users have NULLs
-- and the LLM client falls back to the legacy single OPENAI_API_KEY path.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tier            TEXT    NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS sub2api_user_id BIGINT,
  ADD COLUMN IF NOT EXISTS sub2api_api_key TEXT;

-- Apple-signup Pro trial. New users who sign up with Sign in with Apple
-- (native iOS route — the only signup that grants a trial) get
-- tier='pro' with this expiry stamped; the trial-sweep worker downgrades
-- them back to 'free' (mirroring sub2api) once it passes. NULL = not on a
-- trial. Any manual tier change (admin changeUserTier) clears it so a
-- genuinely-upgraded user can never be auto-downgraded by the sweep.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_trial_expires_at TIMESTAMP WITH TIME ZONE;

-- Self-service account deletion. Apple App Store Guideline 5.1.1(v)
-- mandates that any app supporting account creation must also offer
-- in-app deletion that removes the account and its personal data.
-- Soft-delete model: stamp deleted_at, clear PII fields, CASCADE
-- the FK-bound rows. Audit trail (messages posted, etc.) stays
-- because those are co-owned with workspace members; the user identity
-- is shown as "Deleted user" at render time. A future hard-purge job
-- can sweep rows past a 30-day grace if a true GDPR right-to-be-
-- forgotten request comes in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ============== WebSocket short-lived tickets ==============================
-- Session tokens are NEVER put in the WS connect URL (would leak to access
-- logs / referrer). Instead the client posts /auth/ws-ticket with their
-- Bearer token, receives a short-lived single-use ticket, and uses that
-- as ?t=<ticket>. Hashed at rest. 60s TTL is plenty for connect handshake.
CREATE TABLE IF NOT EXISTS ws_tickets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at     TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_ws_tickets_user    ON ws_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_ws_tickets_expires ON ws_tickets(expires_at);

-- ============== Projects: a real first-class entity ======================
-- A project bundles related conversations + a small body of intent (name,
-- description, color). Conversations attach to a project via
-- conversations.project_id (nullable — direct chats stay project-less). Surfaced to agents in the wake prompt as "this group is
-- part of <project>" so they reason about scope correctly.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT,                 -- arbitrary CSS color/gradient for UI
  status       TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  archived_at  TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_id, status);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id TEXT
  REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id);

-- ============== Company invitations =====================================
-- Owners / admins mint short URL-safe tokens that anyone can redeem to
-- join the company. The raw token is hashed at rest (same sha256 b64url
-- shape as sessions / ws_tickets) — a DB leak doesn't yield usable invite
-- URLs. Each invite has:
--   • role               — role the joiner gets ('member' | 'admin')
--   • email              — optional lowercased email. When set, only that
--                          authenticated email can redeem; when NULL the
--                          invite acts as a shareable link for anyone.
--   • max_uses           — usage cap. 1 by default for email invites;
--                          higher for "invite link" shareable invites.
--   • use_count          — bumps on each accept (clamped at max_uses).
--   • expires_at         — TTL. 7 days by default.
--   • revoked_at         — soft-delete; revoked tokens stop working.
-- One row per minted token. Accepted invites are KEPT (audit trail);
-- callers check accepted_at + use_count + revoked_at + expires_at to
-- decide whether the token is still redeemable.
CREATE TABLE IF NOT EXISTS company_invitations (
  token_hash    TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invited_by    TEXT NOT NULL,                -- user id of the issuer
  email         TEXT,                          -- lowercased; NULL = link invite
  role          TEXT NOT NULL DEFAULT 'member', -- 'member' | 'admin'
  note          TEXT,                          -- optional human-visible message
  max_uses      INTEGER NOT NULL DEFAULT 1,
  use_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMP WITH TIME ZONE NOT NULL,
  revoked_at    TIMESTAMP WITH TIME ZONE,
  -- Last redemption — for at-a-glance "used by X on date" in the UI.
  last_accepted_at TIMESTAMP WITH TIME ZONE,
  last_accepted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_company_invitations_company
  ON company_invitations(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_invitations_email
  ON company_invitations(email) WHERE email IS NOT NULL;

-- ============== Admin panel: is_admin + settings + waitlist ===============
-- Admin is a per-user flag, not a separate role table — there are only ever a
-- handful of admins and we want to flip the bit from the panel itself. The
-- bootstrap allow-list (CUMORA_ADMIN_EMAILS) is reconciled on each boot in
-- admin.ts so new env additions take effect without manual SQL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin) WHERE is_admin = TRUE;

-- ============== User suspension =========================================
-- Soft-disable for an existing user. When suspended_at IS NOT NULL the
-- account is denied at the session-resolve layer (resolveSession returns
-- null) AND at OAuth completion (suspended users get a #suspended=1
-- redirect instead of a fresh session). We KEEP the user row + their
-- workspaces + audit history — suspension is reversible. Hard-deletion
-- isn't (and never will be) a feature here; if you need to wipe a user
-- you do it with a deliberate SQL session.
--
-- Why three columns instead of one boolean:
--   * suspended_at gives us an ordering / point-in-time for audit grep
--     ("when did we lose them") without crossing into audit_events
--   * suspension_reason is freeform admin note (shows in the admin row +
--     surfaced to the user on the "your account has been suspended"
--     screen so they know what to dispute)
--   * suspended_by records WHICH admin pulled the trigger, for the
--     internal who-did-what trail when there are multiple admins
--
-- All three are nullable for the unsuspended state — admin.ts uses
-- "suspended_at IS NULL" as the source-of-truth predicate everywhere.
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_by      TEXT;
-- Partial index: the suspend-aware queries always filter on
-- "suspended_at IS NULL" (allow login) or "IS NOT NULL" (admin listing
-- "show me everyone I've suspended"). A partial index on the rare
-- IS NOT NULL side keeps the index tiny and lets the planner scan it
-- when an admin pulls up the suspended list.
CREATE INDEX IF NOT EXISTS idx_users_suspended ON users(suspended_at) WHERE suspended_at IS NOT NULL;

-- Global key/value settings, persisted across pod restarts. Currently used
-- for the waitlist toggle and the "signups paused" kill-switch. JSONB so we
-- can grow the shape (object values, lists) without another schema change.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);
INSERT INTO app_settings (key, value) VALUES
  ('waitlist_enabled', 'false'::jsonb),
  ('signups_paused',   'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Waitlist queue. When waitlist_enabled is true, an OAuth signup for an
-- unknown email lands HERE instead of users (the table) — the user sees
-- a "you're on the waitlist" screen and waits for an admin to approve.
-- On approve, admin.ts hand-rolls the same create-user flow Path C
-- runs (user + identity + company + sub2api), then deletes this row.
--
-- One row per (provider, provider_id). Email is captured too for the
-- admin UI, but the (provider, provider_id) pair is what blocks
-- duplicate sign-ins from re-creating waitlist rows.
CREATE TABLE IF NOT EXISTS waitlist (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  note          TEXT,
  requested_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMP WITH TIME ZONE,
  decided_by    TEXT,
  UNIQUE (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(LOWER(email));

-- ============== Email: real external mail per agent ========================
-- Each agent gets a real address (<participantId>.<companySlug>@cumora.ai by
-- default). Outbound goes through Resend; inbound is fronted by a Cloudflare
-- Email Worker that POSTs parsed JSON to /webhooks/email/inbound.
--
-- Storage model (mirrors the design doc): we REUSE conversations + messages
-- so the renderer / RLS / FUSE / inbox / search code paths all "just work".
-- An email thread is a conversations row with kind='email'; each individual
-- message is a messages row with kind='email'. The transport-layer details
-- (RFC 5322 message-id, in-reply-to, references chain, from/to/cc lists,
-- delivery status) live in a parallel email_messages row keyed by message_id.
--
-- Address column on participants: nullable so non-email participants stay
-- unaffected. Uniqueness is global across the cluster — two different
-- companies can't both claim aurora.acme@cumora.ai. lower(email) so case
-- doesn't matter.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_participants_email
  ON participants(LOWER(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_participants_email_lower
  ON participants(LOWER(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_messages (
  -- Same id as messages.id — one-to-one. Cascade so message deletion
  -- cleans up the email-side row automatically.
  message_id        TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  company_id        TEXT NOT NULL,
  -- direction: 'in' (received via Cloudflare Email Worker)
  --          | 'out' (sent through Resend / mock)
  direction         TEXT NOT NULL,
  -- transport_status: 'queued' (created, not yet sent)
  --                 | 'sent'   (provider accepted, smtp_message_id set)
  --                 | 'failed' (provider rejected, see transport_error)
  --                 | 'received' (came in via webhook)
  transport_status  TEXT NOT NULL,
  transport_error   TEXT,
  -- The RFC 5322 Message-ID header value WITHOUT the angle brackets.
  -- Set on outbound after the provider returns it; set on inbound from
  -- the parsed header. Used as the dedup key for inbound deliveries
  -- and the threading anchor for In-Reply-To / References.
  smtp_message_id   TEXT,
  in_reply_to       TEXT,             -- single message-id (no brackets)
  references_chain  JSONB NOT NULL DEFAULT '[]'::jsonb,  -- []TEXT, oldest→newest
  subject           TEXT NOT NULL DEFAULT '',
  from_addr         TEXT NOT NULL,    -- "Name <addr@host>" or just addr@host
  to_addrs          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- []TEXT
  cc_addrs          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- []TEXT
  bcc_addrs         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- []TEXT (only set on out)
  html              TEXT,             -- raw HTML part if present (in only)
  raw_size_bytes    INTEGER,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
-- RFC 3834 Auto-Submitted bit: outbound rows that originated from agent
-- automation (heartbeat / agent CLI) set this true. Inbound rows set it
-- true when the upstream sender's headers included Auto-Submitted. The
-- heartbeat's "what could I reply to" snapshot filters these out so two
-- automated systems can't infinite-loop. Default false keeps every
-- existing row's behavior unchanged.
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS auto_submitted BOOLEAN NOT NULL DEFAULT FALSE;
-- Outbound retry bookkeeping. A failed send used to sit in the DB as
-- transport_status='failed' forever. retry_attempts counts how many tries
-- the background retry loop has burned; next_retry_at is when the loop
-- should pick the row up next (NULL = no retry pending, terminal state).
-- Existing failed rows get retry_attempts=0 + next_retry_at=NULL so the
-- loop ignores them — we don't want to spontaneously try to ship months-
-- old failures the moment this migration lands.
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS retry_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMP WITH TIME ZONE;
-- Partial index for the retry picker: only "failed AND due to retry" rows.
-- Tiny because successful + terminal rows aren't included.
CREATE INDEX IF NOT EXISTS idx_email_messages_retry_due
  ON email_messages(next_retry_at)
  WHERE direction = 'out' AND transport_status = 'failed' AND next_retry_at IS NOT NULL;
-- Inbound dedup: a single delivery from the CF worker MUST be idempotent
-- across retries. Partial unique index because outbound rows briefly exist
-- with smtp_message_id = NULL between insert and provider acceptance.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_email_messages_smtp_id
  ON email_messages(LOWER(smtp_message_id))
  WHERE smtp_message_id IS NOT NULL;
-- Threading lookup: given an in-reply-to or one element of a references chain,
-- find the email_messages row whose smtp_message_id matches. Already covered
-- by the unique index above.
CREATE INDEX IF NOT EXISTS idx_email_messages_conv
  ON email_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_messages_company
  ON email_messages(company_id, created_at DESC);

-- Per-message attachment list. We store every part as one row keyed by
-- message_id so a thread query can JOIN and emit them in a typed array
-- alongside the email headers. storage_key is the object-storage path
-- (R2 attachments/ prefix when configured, local uploads/ otherwise);
-- truncated=TRUE means the worker saw a part too big to forward and we
-- record the filename so the UI can show "(skipped — too large)" instead
-- of silently dropping it.
CREATE TABLE IF NOT EXISTS email_attachments (
  id              TEXT PRIMARY KEY,
  message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  storage_key     TEXT,                                -- NULL when truncated
  truncated       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_attachments_msg
  ON email_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_email_attachments_conv
  ON email_attachments(conversation_id, created_at DESC);

-- Optional inbox table: external sender addresses we've seen for which there's
-- no matching cumora user — used to rate-limit unknown senders and for the
-- "contacts you've corresponded with" hint in the agent's heartbeat prompt.
-- Gets upserted on every inbound delivery.
CREATE TABLE IF NOT EXISTS email_contacts (
  company_id    TEXT NOT NULL,
  address       TEXT NOT NULL,                      -- lowercased
  display_name  TEXT,                               -- last "Name" we saw
  message_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, address)
);
CREATE INDEX IF NOT EXISTS idx_email_contacts_seen
  ON email_contacts(company_id, last_seen_at DESC);

-- ============== Calendar ===================================================
-- AI-native shared calendar. Humans schedule events from the Calendar view;
-- 'agent_task' events fire on their occurrence times, posting a typed Calendar
-- system dispatch into the target conversation that wakes the assignee via the normal
-- mailbox / wake-bus path. Agents can also (eventually) read + create events
-- via the cumora CLI — same table, same rules.
--
-- Recurrence is stored as a small JSON rule (freq + interval + byweekday +
-- until + count) rather than an external RRULE string to keep the tick logic
-- in pure TS without pulling in a parser dep. One-shot events have recurrence
-- = NULL.
CREATE TABLE IF NOT EXISTS calendar_events (
  id                     TEXT PRIMARY KEY,
  company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Author: either a user id (humans) or a participant id (agents). We do
  -- not FK either column so the row survives off-boarding / user purge —
  -- the calendar is a record of intent, not a live relationship.
  created_by             TEXT NOT NULL,
  -- 'personal'   = pure time marker, no dispatch
  -- 'agent_task' = at start_at (+ each recurrence) post the prompt to
  --                target_conversation_id and wake assignee_id.
  kind                   TEXT NOT NULL DEFAULT 'personal',
  title                  TEXT NOT NULL,
  description            TEXT,
  -- Assignment target: which agent should run when this fires. Stored as a
  -- participants.id; nullable for personal events.
  assignee_id            TEXT,
  -- Where the agent prompt gets posted on dispatch. Must be a conversation
  -- the assignee is a member of; UI enforces that on save. Null = scheduler
  -- will fall back to the assignee's DM with the creator.
  target_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  -- The actual instruction handed to the agent on each fire. Null for
  -- personal events. Treat this as the message body posted on dispatch.
  agent_prompt           TEXT,
  start_at               TIMESTAMP WITH TIME ZONE NOT NULL,
  end_at                 TIMESTAMP WITH TIME ZONE,
  all_day                BOOLEAN NOT NULL DEFAULT FALSE,
  -- Recurrence rule (NULL = one-shot). Shape:
  --   { freq: 'daily'|'weekly'|'monthly'|'yearly',
  --     interval: number (>=1),
  --     byweekday?: number[] (0-6, Sun=0; weekly only),
  --     until?: ISO timestamp (inclusive end),
  --     count?: number (max occurrences) }
  recurrence             JSONB,
  -- 'active' | 'paused' | 'done' | 'cancelled'
  status                 TEXT NOT NULL DEFAULT 'active',
  -- Cache of the most recent dispatch tick — set by the scheduler. We use
  -- this + recurrence to compute the next firing without a separate
  -- "next_fire_at" column we'd have to keep in sync.
  last_fired_at          TIMESTAMP WITH TIME ZONE,
  created_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
-- Tick scan: pull due 'active' events in a company. We do a full table scan
-- bounded by company + status; with idx_calendar_events_status the planner
-- can stay on a single index for the cross-company tick loop.
CREATE INDEX IF NOT EXISTS idx_calendar_events_company_start
  ON calendar_events(company_id, start_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_status
  ON calendar_events(status, start_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_calendar_events_assignee
  ON calendar_events(assignee_id, start_at)
  WHERE assignee_id IS NOT NULL;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS creation_request_id TEXT;
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS creation_request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_event_creation_request
  ON calendar_events(company_id, created_by, creation_request_id)
  WHERE creation_request_id IS NOT NULL;

-- One row per actual firing of a calendar event. Lets the scheduler dedup
-- on (event_id, scheduled_for) so a tick that runs twice (replica race or
-- crash-resume) cannot post the same prompt twice. Also drives the
-- "history" tab on an event's edit screen.
CREATE TABLE IF NOT EXISTS calendar_dispatches (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL,
  scheduled_for   TIMESTAMP WITH TIME ZONE NOT NULL,
  dispatched_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- 'dispatched' = system message posted + assignee woken
  -- 'skipped'    = event paused / no assignee resolvable
  -- 'failed'     = exception during dispatch (see error)
  status          TEXT NOT NULL DEFAULT 'dispatched',
  conversation_id TEXT,            -- where the prompt landed
  message_id      TEXT,            -- the dispatch message
  error           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_dispatch_slot
  ON calendar_dispatches(event_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_calendar_dispatches_event
  ON calendar_dispatches(event_id, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS idx_calendar_dispatches_company
  ON calendar_dispatches(company_id, dispatched_at DESC);

-- Pre-event reminders. NULL on either column = no reminder. We keep the
-- channel + lead-time on the row itself (rather than on a side table) so
-- the scheduler can scan in a single pass; per-occurrence dedup lives in
-- calendar_reminders below.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS reminder_minutes_before INTEGER;
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS reminder_channel TEXT;  -- 'toast' | 'email' | 'both'

-- Privacy flag. When true, the row is only visible (and only writable) to
-- its created_by OR assignee_id. Default false = current behavior, i.e.
-- every member of the company sees + can edit the row (matches how
-- conversations work). Lets an agent self-schedule internal reminders
-- without polluting the shared calendar. Visibility is enforced at the
-- API + CLI layer; the WS calendar.changed broadcast is still tenant-wide
-- (clients receive the id, then the GET-by-id is rejected so the row
-- never lands in their store).
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per "reminder we've sent" — same idempotency pattern as
-- calendar_dispatches. scheduled_for is the OCCURRENCE start time (not
-- the moment the reminder fired); that's what makes the unique constraint
-- collapse retries / multi-replica races.
CREATE TABLE IF NOT EXISTS calendar_reminders (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL,
  scheduled_for   TIMESTAMP WITH TIME ZONE NOT NULL,
  fired_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  channel         TEXT NOT NULL,
  recipients      JSONB NOT NULL DEFAULT '[]'::jsonb,    -- user_ids notified
  status          TEXT NOT NULL DEFAULT 'sent',          -- 'sent' | 'failed'
  error           TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_reminders_slot
  ON calendar_reminders(event_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_calendar_reminders_event
  ON calendar_reminders(event_id, scheduled_for DESC);

-- ============== Kanban boards ==============
-- A workspace-scoped Trello-style board. AI-native: agents and humans
-- alike create/move/mention via the cumora CLI, the REST API, or the
-- Boards view in the desktop client. Every mutation broadcasts on the
-- boards channel so every connected member sees moves in real time.
CREATE TABLE IF NOT EXISTS boards (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_boards_company ON boards(company_id, updated_at DESC);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS creation_request_id TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS creation_request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_board_creation_request
  ON boards(company_id, created_by, creation_request_id)
  WHERE creation_request_id IS NOT NULL;

-- Columns within a board. position is a DOUBLE so reorders can insert
-- between two cards without renumbering every sibling.
CREATE TABLE IF NOT EXISTS board_columns (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  position        DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_board_columns_board ON board_columns(board_id, position ASC);

-- What a column MEANS, as opposed to what it is called. 'todo' | 'doing' |
-- 'done', or NULL for a column whose meaning we do not know.
--
-- Both board-creation paths already seed the conventional "Todo / Doing / Done",
-- so the convention existed — it just was not machine-readable, and an agent
-- asked to "move it to Doing" had to guess which column that was from its title.
-- That is why card claim could set an assignee but never advance the card, and
-- why a board could read Todo 2 / Doing 1 / Done 0 while the work was finished
-- and delivered in chat.
ALTER TABLE board_columns ADD COLUMN IF NOT EXISTS kind TEXT;

-- Backfill EXACT matches on the seeded defaults only, case-insensitively.
-- Deliberately not a fuzzy match: a board whose columns are "Backlog / In
-- flight / Shipped" is better left NULL (nothing moves automatically) than
-- guessed at, and a wrong guess would silently move a user's cards. Runs once;
-- already-classified columns are left alone so a later manual choice sticks.
${BASELINE_BOARD_COLUMN_KIND_BACKFILL_SQL}

-- Cards live in a column. The "mentions" column is the deduped list of
-- @-targets parsed from title+description on every write — clients can
-- fan out notifications / "assigned to me" filters off it without
-- re-parsing the prose.
CREATE TABLE IF NOT EXISTS board_cards (
  id              TEXT PRIMARY KEY,
  board_id        TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  column_id       TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  position        DOUBLE PRECISION NOT NULL DEFAULT 0,
  assignee_id     TEXT,
  mentions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_board_cards_column ON board_cards(column_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_board_cards_board ON board_cards(board_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_board_cards_assignee ON board_cards(assignee_id) WHERE assignee_id IS NOT NULL;

-- Threaded comments on a card. Mentions parsed at write time, same as
-- on the card itself — lets the renderer chip them without re-parsing.
CREATE TABLE IF NOT EXISTS board_card_comments (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  author_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  mentions        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_board_card_comments_card
  ON board_card_comments(card_id, created_at ASC);

-- Per-participant read cursor for kanban @-mentions. Same shape as
-- conversation_reads: lets the cumora-kanban-mentions CLI list only
-- "what is new" since the last time this id checked. Default 1970
-- so a brand-new agent sees every still-current mention on first run.
CREATE TABLE IF NOT EXISTS board_mention_reads (
  user_id        TEXT PRIMARY KEY,
  last_read_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT '1970-01-01 00:00:00+00'
);

-- ============== Collaborative documents (CRDT-backed) ===================
-- AI-Native shared canvases. Humans and agents both subscribe to a Y.Doc
-- room over the existing /ws channel; every edit travels as a Yjs binary
-- update. The server is a thin relay + persistence layer:
--   - documents is the metadata index.
--   - document_updates is the append-only log of binary Yjs updates.
--   - document_snapshots is a periodically refreshed full encoded state
--     so cold loads don't have to replay millions of micro-updates.
CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT 'Untitled',
  created_by      TEXT NOT NULL,
  -- Optional anchor to a conversation — lets a chat thread "pin" a doc so
  -- the channel side-rail surfaces it without a separate library lookup.
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_company_updated
  ON documents(company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_conversation
  ON documents(conversation_id) WHERE conversation_id IS NOT NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS creation_request_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS creation_request_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_document_creation_request
  ON documents(company_id, created_by, creation_request_id)
  WHERE creation_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_updates (
  id            BIGSERIAL PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The author of the local Yjs transaction. Free-form id — humans use
  -- their user id, agents use the agent id. Used only for awareness /
  -- audit, not authorization (that's enforced by the WS gate).
  author_id     TEXT NOT NULL,
  update_bytes  BYTEA NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_updates_doc
  ON document_updates(document_id, id ASC);

-- Periodic compaction: the room manager merges the update log into a
-- single Y.encodeStateAsUpdate snapshot and stores it here. On cold
-- load it reads the latest snapshot + any updates with id > snapshot_at_update_id.
CREATE TABLE IF NOT EXISTS document_snapshots (
  document_id          TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state_bytes          BYTEA NOT NULL,
  -- The id of the most recent document_updates row that was rolled into
  -- this snapshot. Updates with id > this value still need replaying.
  snapshot_at_update_id BIGINT NOT NULL DEFAULT 0,
  updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Append-only log of @-mentions inside a doc. One row per fire —
-- in-process dedup keeps a noisily editing user from spamming the
-- recipient. Doubles as an audit trail + future "@mentions for me" feed.
CREATE TABLE IF NOT EXISTS document_mentions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL,
  mentioner_id  TEXT NOT NULL,
  mentioned_id  TEXT NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_mentions_recipient
  ON document_mentions(mentioned_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_mentions_doc
  ON document_mentions(document_id, created_at DESC);

-- ============== Polls ====================================================
-- A poll is just a messages row with kind='poll'. The structured payload
-- (question, options, mode, expires_at, closed_at, closed_reason) lives in
-- the messages.poll JSONB so renderers and agent tooling can read it the
-- same way they read messages.tool / messages.attachment.
--
-- Votes live in poll_votes (one row per chosen option) so multi-choice
-- polls work naturally and a vote-change is a clean DELETE/INSERT inside a
-- transaction. Composite PK keeps the same voter from double-stuffing the
-- same option.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll JSONB;

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id            TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  voter_participant_id  TEXT NOT NULL,
  voter_kind            TEXT NOT NULL,  -- 'human' | 'agent' — denormalized for cheap UI grouping
  option_id             TEXT NOT NULL,
  company_id            TEXT NOT NULL,
  created_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, voter_participant_id, option_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_voter ON poll_votes(voter_participant_id);

-- Push-notification device registry. One row per (platform, token) — APNs
-- and FCM both surface tokens that can rotate across reinstalls, so we
-- key on (platform, token) globally and let user_id carry the binding.
-- A token can attach to at most one user at a time; if the same device
-- signs into a different account we steal the row and rebind user_id.
-- disabled_at is set when the provider tells us the token is dead
-- (APNs status=410, FCM unregistered) so we stop retrying without
-- losing the audit trail.
CREATE TABLE IF NOT EXISTS push_devices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,    -- 'ios' | 'android' | 'web'
  token         TEXT NOT NULL,
  app_version   TEXT,
  device_model  TEXT,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  disabled_at   TIMESTAMP WITH TIME ZONE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_devices_platform_token
  ON push_devices(platform, token);
CREATE INDEX IF NOT EXISTS idx_push_devices_user
  ON push_devices(user_id)
  WHERE disabled_at IS NULL;

-- ============================== Computers ==============================
-- A "Computer" is the host an agent runs on. Cumora Cloud is a built-in,
-- managed computer (engine = the server-side turn.ts loop); BYOA agents
-- run on computers the user pairs (their Mac, a VPS) via the
-- "cumora agent computer" daemon. Every agent references exactly one
-- computer; the scheduler branches on kind to decide pod vs. local
-- wake. company_id / owner_user_id are soft references (TEXT, no FK),
-- matching the rest of the schema.
CREATE TABLE IF NOT EXISTS computers (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  owner_user_id     TEXT,                                  -- NULL for the managed Cumora Cloud row
  name              TEXT NOT NULL,                         -- "Cumora Cloud", "MacBook Pro", "prod-vps-01"
  kind              TEXT NOT NULL,                         -- 'cloud' | 'local' | 'vps'
  available_engines JSONB NOT NULL DEFAULT '[]'::jsonb,    -- ['claude','codex','grok','cursor','opencode','pi','gemini','qwen']; ['managed'] for cloud
  status            TEXT NOT NULL DEFAULT 'offline',       -- 'online' | 'offline' | 'busy'
  last_seen_at      TIMESTAMP WITH TIME ZONE,
  credential_hash   TEXT,                                  -- SHA256 of the device token; NULL for cloud
  paired_at         TIMESTAMP WITH TIME ZONE,
  revoked_at        TIMESTAMP WITH TIME ZONE,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_computers_company ON computers(company_id);
-- The cumora daemon's running version (semver string), reported on pair +
-- heartbeat. NULL = a pre-version-reporting (old) daemon → treated as outdated.
ALTER TABLE computers ADD COLUMN IF NOT EXISTS daemon_version TEXT;
-- HOW the daemon runs: TRUE = under the --install-service supervisor
-- (launchd / systemd, CUMORA_SUPERVISED=1), FALSE = a manually-run foreground
-- command, NULL = an old daemon that doesn't report it. Reported on pair +
-- heartbeat; lets the app show run-mode-specific update instructions.
ALTER TABLE computers ADD COLUMN IF NOT EXISTS daemon_supervised BOOLEAN;

-- An agent's host + engine choice. A NULL computer_id, or one pointing at
-- a 'cloud' computer, means managed (current pod behavior). A 'local' /
-- 'vps' computer means BYOA: wakes go to the paired daemon, no pod.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS computer_id TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS engine      TEXT;  -- 'managed' | 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'pi' | 'gemini' | 'qwen'
-- Per-agent model overrides. "model" (added earlier) is the big-brain / main
-- reasoning model; "fast_model" is the small-brain model for cheap auxiliary
-- work. For BYOA agents these pass through to the engine as --model (big) and,
-- for Claude, ANTHROPIC_SMALL_FAST_MODEL (small).
ALTER TABLE participants ADD COLUMN IF NOT EXISTS fast_model  TEXT;

-- Persistent per-company pairing token. Replaces the old short-lived Redis
-- pairing code so a historical "add a computer" command (--pair <token>)
-- stays valid forever. Long + high-entropy in lieu of expiry; maps to exactly
-- one company, so a computer paired with it can only ever join that company.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pair_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS companies_pair_token_idx ON companies(pair_token) WHERE pair_token IS NOT NULL;

-- Persistent per-computer reconnect token. This keeps the Computer detail
-- "reconnect" command bound to that exact row, preserving its assigned agents.
ALTER TABLE computers ADD COLUMN IF NOT EXISTS pair_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS computers_pair_token_idx ON computers(pair_token) WHERE pair_token IS NOT NULL;

-- Cached local-engine detection for the Agents tab / character editor.
-- available_engines[0] remains the computer default; detected_engines holds
-- bin + resolved path from the last pair/refresh. detect_requested_at is a
-- one-shot flag the online daemon consumes on its next heartbeat.
ALTER TABLE computers ADD COLUMN IF NOT EXISTS detected_engines JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS engines_detected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE computers ADD COLUMN IF NOT EXISTS detect_requested_at TIMESTAMP WITH TIME ZONE;
-- true = follow computers.available_engines[0]; false = pin participants.engine.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS engine_inherit BOOLEAN NOT NULL DEFAULT TRUE;
-- Stable browser-generated key for idempotent Agent creation. The hash binds
-- the key to the sanitized create payload so accidental key reuse cannot
-- silently return a differently configured Agent.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS creation_request_id TEXT;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS creation_request_hash TEXT;

-- ============== Evidence-backed feature shipping =======================
-- A shipping feature is deliberately distinct from a generic board card.
-- Cards answer "what are we doing?"; a feature contract answers "what must
-- remain true, who independently proved it, and what happened in production?"
CREATE TABLE IF NOT EXISTS shipping_features (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  board_card_id     TEXT REFERENCES board_cards(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  problem           TEXT NOT NULL DEFAULT '',
  desired_outcome   TEXT NOT NULL DEFAULT '',
  contract_summary  TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'draft',
  priority          TEXT NOT NULL DEFAULT 'medium',
  risk_level        TEXT NOT NULL DEFAULT 'medium',
  release_target    TEXT,
  builder_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  archived_at       TIMESTAMP WITH TIME ZONE,
  CONSTRAINT shipping_features_status_check CHECK
    (status IN ('draft','contract','building','verifying','ready','releasing','watching','learned','paused','archived')),
  CONSTRAINT shipping_features_priority_check CHECK
    (priority IN ('critical','high','medium','low')),
  CONSTRAINT shipping_features_risk_check CHECK
    (risk_level IN ('critical','high','medium','low'))
);
CREATE INDEX IF NOT EXISTS idx_shipping_features_company_status
  ON shipping_features(company_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipping_features_project
  ON shipping_features(project_id, updated_at DESC) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipping_invariants (
  id                TEXT PRIMARY KEY,
  feature_id        TEXT NOT NULL REFERENCES shipping_features(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  kind              TEXT NOT NULL DEFAULT 'behavior',
  required          BOOLEAN NOT NULL DEFAULT TRUE,
  position          DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_invariants_kind_check CHECK
    (kind IN ('behavior','architecture','data','security','performance','ux','operability'))
);
CREATE INDEX IF NOT EXISTS idx_shipping_invariants_feature
  ON shipping_invariants(feature_id, position ASC);

CREATE TABLE IF NOT EXISTS shipping_verifications (
  id                TEXT PRIMARY KEY,
  feature_id        TEXT NOT NULL REFERENCES shipping_features(id) ON DELETE CASCADE,
  invariant_id      TEXT REFERENCES shipping_invariants(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  method            TEXT NOT NULL DEFAULT 'user_path',
  required          BOOLEAN NOT NULL DEFAULT TRUE,
  status            TEXT NOT NULL DEFAULT 'pending',
  owner_id          TEXT,
  verified_by_id    TEXT,
  builder_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes             TEXT NOT NULL DEFAULT '',
  position          DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_at            TIMESTAMP WITH TIME ZONE,
  completed_at      TIMESTAMP WITH TIME ZONE,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_verifications_method_check CHECK
    (method IN ('user_path','property','trace','data_reconciliation','design_qa','security','performance','release_note')),
  CONSTRAINT shipping_verifications_status_check CHECK
    (status IN ('pending','running','passed','failed','waived')),
  CONSTRAINT shipping_verifier_not_builder CHECK
    (verified_by_id IS NULL OR NOT (builder_ids ? verified_by_id))
);
CREATE INDEX IF NOT EXISTS idx_shipping_verifications_feature
  ON shipping_verifications(feature_id, position ASC);
CREATE INDEX IF NOT EXISTS idx_shipping_verifications_owner
  ON shipping_verifications(owner_id, status, updated_at DESC) WHERE owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipping_releases (
  id                TEXT PRIMARY KEY,
  feature_id        TEXT NOT NULL REFERENCES shipping_features(id) ON DELETE CASCADE,
  environment       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'planned',
  version           TEXT,
  commit_sha        TEXT,
  started_by        TEXT,
  approved_by       TEXT,
  release_notes     TEXT NOT NULL DEFAULT '',
  rollback_plan     TEXT NOT NULL DEFAULT '',
  known_gaps        JSONB NOT NULL DEFAULT '[]'::jsonb,
  baseline          JSONB NOT NULL DEFAULT '[]'::jsonb,
  smoke_evidence    JSONB NOT NULL DEFAULT '[]'::jsonb,
  readback_due_at   TIMESTAMP WITH TIME ZONE,
  readback_status   TEXT NOT NULL DEFAULT 'pending',
  readback_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at        TIMESTAMP WITH TIME ZONE,
  completed_at      TIMESTAMP WITH TIME ZONE,
  rolled_back_at    TIMESTAMP WITH TIME ZONE,
  rollback_reason   TEXT,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_releases_environment_check CHECK
    (environment IN ('development','staging','canary','production')),
  CONSTRAINT shipping_releases_status_check CHECK
    (status IN ('planned','approved','running','succeeded','failed','rolled_back')),
  CONSTRAINT shipping_releases_readback_check CHECK
    (readback_status IN ('pending','passed','failed','overdue'))
);
CREATE INDEX IF NOT EXISTS idx_shipping_releases_feature
  ON shipping_releases(feature_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shipping_releases_readback
  ON shipping_releases(readback_status, readback_due_at)
  WHERE status = 'succeeded' AND environment = 'production';

CREATE TABLE IF NOT EXISTS shipping_friction_reports (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_id        TEXT REFERENCES shipping_features(id) ON DELETE SET NULL,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id        TEXT,
  reporter_id       TEXT,
  source            TEXT NOT NULL DEFAULT 'manual',
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  severity          TEXT NOT NULL DEFAULT 'medium',
  frequency         TEXT NOT NULL DEFAULT 'once',
  status            TEXT NOT NULL DEFAULT 'open',
  evidence          JSONB NOT NULL DEFAULT '[]'::jsonb,
  occurrence_count  INTEGER NOT NULL DEFAULT 1,
  first_seen_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_friction_severity_check CHECK
    (severity IN ('critical','high','medium','low')),
  CONSTRAINT shipping_friction_frequency_check CHECK
    (frequency IN ('once','occasional','frequent','constant')),
  CONSTRAINT shipping_friction_status_check CHECK
    (status IN ('open','triaged','planned','resolved','dismissed'))
);
ALTER TABLE shipping_friction_reports ADD COLUMN IF NOT EXISTS source_key TEXT;
CREATE INDEX IF NOT EXISTS idx_shipping_friction_company
  ON shipping_friction_reports(company_id, status, severity, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipping_friction_source_key
  ON shipping_friction_reports(company_id, source_key)
  WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipping_regressions (
  id                TEXT PRIMARY KEY,
  feature_id        TEXT NOT NULL REFERENCES shipping_features(id) ON DELETE CASCADE,
  invariant_id      TEXT REFERENCES shipping_invariants(id) ON DELETE SET NULL,
  source_verification_id TEXT REFERENCES shipping_verifications(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'automated',
  command           TEXT,
  expected          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',
  last_result       TEXT,
  last_evidence     JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_run_at       TIMESTAMP WITH TIME ZONE,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT shipping_regressions_kind_check CHECK
    (kind IN ('automated','benchmark','manual_replay','monitor')),
  CONSTRAINT shipping_regressions_status_check CHECK
    (status IN ('active','passing','failing','disabled'))
);
CREATE INDEX IF NOT EXISTS idx_shipping_regressions_feature
  ON shipping_regressions(feature_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipping_regressions_source_verification
  ON shipping_regressions(source_verification_id)
  WHERE source_verification_id IS NOT NULL;

-- Append-only audit/evidence trail. Mutating routes insert events; they never
-- update or delete prior rows, so the feature's history remains replayable.
CREATE TABLE IF NOT EXISTS shipping_events (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_id        TEXT REFERENCES shipping_features(id) ON DELETE CASCADE,
  actor_id          TEXT,
  kind              TEXT NOT NULL,
  data              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shipping_events_feature
  ON shipping_events(feature_id, created_at ASC);

-- Back-fill: one managed Cumora Cloud computer per existing PAID company. The
-- id is deterministic ('cloud-' || company_id) so this is idempotent and
-- so other code can resolve it without a lookup. New companies get theirs
-- created at company-creation time (see api/router.ts).
-- Free tier is BYOA-only: it must NOT get a managed cloud computer (the UI
-- shows a locked "Cumora Cloud (Pro)" upsell instead, with no real row).
-- Gated on owner tier so this doesn't re-create cloud rows for free companies
-- on every boot — that was leaking a cloud computer into every free workspace.
INSERT INTO computers (id, company_id, name, kind, available_engines, status)
SELECT 'cloud-' || c.id, c.id, 'Cumora Cloud', 'cloud', '["managed"]'::jsonb, 'online'
  FROM companies c
  JOIN users o ON o.id = c.owner_user_id
 WHERE COALESCE(o.tier, 'free') <> 'free'
   AND NOT EXISTS (
   SELECT 1 FROM computers x WHERE x.company_id = c.id AND x.kind = 'cloud'
 );

-- ...and point every existing PAID-company agent at its company's cloud
-- computer with the managed engine. Only touches un-migrated rows, so re-runs
-- are no-ops. Free agents are left alone (they run on a paired BYOA computer).
UPDATE participants p
   SET computer_id = 'cloud-' || p.company_id,
       engine = 'managed'
  FROM companies c
  JOIN users o ON o.id = c.owner_user_id
 WHERE p.company_id = c.id
   AND p.kind = 'agent'
   AND p.computer_id IS NULL
   AND p.company_id IS NOT NULL
   AND COALESCE(o.tier, 'free') <> 'free';
`

/** Postgres advisory-lock key for serializing concurrent
 *  `ensureSchema()` runs. Value is arbitrary but must be stable
 *  across all server instances. Pick something memorable that's
 *  unlikely to collide with any other code that might
 *  pg_advisory_lock the same database. */
const SCHEMA_LOCK_KEY = 7_643_178_926_104n

/** Tables that store an agent id by value. Each entry carries a SQL
 *  fragment (`scopeSql`) bound to `$2` = loser company_id, used as
 *  the WHERE condition that limits the rename to that one tenant's
 *  rows. Most tables have their own `company_id` column; a few must
 *  reach it via a JOIN through a parent table (board_cards →
 *  boards.company_id, board_card_comments → boards via card → board,
 *  document_updates → documents.company_id). */
interface CascadeSpec {
  table: string
  column: string
  /** WHERE-fragment scoping rows to the loser's tenant. `$3` is
   *  the loser company id placeholder (because $1 = newId and
   *  $2 = oldId in our UPDATE statements). */
  scopeSql: string
}
const AGENT_ID_CASCADE_TABLES: CascadeSpec[] = [
  { table: 'messages',             column: 'author_id',   scopeSql: 'company_id = $3' },
  { table: 'documents',            column: 'created_by',  scopeSql: 'company_id = $3' },
  { table: 'boards',               column: 'created_by',  scopeSql: 'company_id = $3' },
  { table: 'calendar_events',      column: 'assignee_id', scopeSql: 'company_id = $3' },
  { table: 'calendar_events',      column: 'created_by',  scopeSql: 'company_id = $3' },
  { table: 'convene_transcript',   column: 'author_id',   scopeSql: 'company_id = $3' },
  { table: 'agent_workspace',      column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_memory',         column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_log',            column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_tasks',          column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_runs',           column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_events',         column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_autonomy',       column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'agent_climate',        column: 'agent_id',    scopeSql: 'company_id = $3' },
  { table: 'tool_calls',           column: 'agent_id',    scopeSql: 'company_id = $3' },
  // No own company_id — reach via parent.
  { table: 'board_cards',          column: 'assignee_id', scopeSql: 'board_id IN (SELECT id FROM boards WHERE company_id = $3)' },
  { table: 'board_cards',          column: 'created_by',  scopeSql: 'board_id IN (SELECT id FROM boards WHERE company_id = $3)' },
  { table: 'board_card_comments',  column: 'author_id',   scopeSql: 'card_id IN (SELECT bc.id FROM board_cards bc JOIN boards b ON b.id = bc.board_id WHERE b.company_id = $3)' },
  { table: 'document_updates',     column: 'author_id',   scopeSql: 'document_id IN (SELECT id FROM documents WHERE company_id = $3)' },
]

/** Find every agent id that exists in 2+ companies and rename the
 *  less-active copies so all agent ids become globally unique.
 *
 *  Algorithm per collision group:
 *   1. Sort rows by message count desc, ties broken by oldest
 *      participant insert (proxy via agent_log earliest created_at).
 *   2. The top row keeps the original id (it's the most entrenched).
 *   3. Each remaining row gets renamed to `${id}-${random4}` and
 *      cascaded through every (column, company_id) tuple in
 *      AGENT_ID_CASCADE_TABLES, plus the conversations.members JSONB
 *      array and message bodies' `@oldid` mentions (boundary-aware).
 *
 *  Idempotent: after the first run there are no collisions, so the
 *  initial SELECT returns 0 rows and the function exits immediately. */
async function renameAgentIdCollisions(client: import('pg').PoolClient): Promise<void> {
  const { rows: groups } = await client.query<{ id: string; companies: string[] }>(`
    SELECT id, array_agg(company_id ORDER BY company_id) AS companies
      FROM participants
     WHERE kind = 'agent'
     GROUP BY id
    HAVING COUNT(*) > 1
  `)
  if (groups.length === 0) return
  console.log(`[db] agent-id migration: ${groups.length} collision group(s) to resolve`)

  for (const g of groups) {
    // Rank rows in this collision group. Most messages wins; ties
    // resolved by the agent that's been around longest (smallest
    // earliest agent_log timestamp). The winner keeps `g.id`.
    const { rows: ranked } = await client.query<{ company_id: string; msg_count: number; earliest: Date | null }>(`
      SELECT
        p.company_id,
        (SELECT COUNT(*)::int FROM messages m WHERE m.author_id = $1 AND m.company_id = p.company_id) AS msg_count,
        (SELECT MIN(created_at) FROM agent_log l WHERE l.agent_id = $1 AND l.company_id = p.company_id) AS earliest
        FROM participants p
       WHERE p.id = $1 AND p.kind = 'agent'
       ORDER BY msg_count DESC NULLS LAST, earliest ASC NULLS LAST
    `, [g.id])
    if (ranked.length < 2) continue
    const losers = ranked.slice(1)

    for (const loser of losers) {
      // 4-char hex suffix, retry a handful of times on the wildly
      // unlikely event of a collision with an already-renamed id.
      let newId = ''
      for (let attempt = 0; attempt < 8; attempt++) {
        const suffix = Math.random().toString(36).slice(2, 6)
        const candidate = `${g.id}-${suffix}`
        const { rows: clash } = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM participants WHERE id = $1) AS exists`,
          [candidate],
        )
        if (!clash[0].exists) { newId = candidate; break }
      }
      if (!newId) {
        console.warn(`[db] agent-id migration: could not pick a free suffix for ${g.id} in ${loser.company_id} after 8 tries — skipping`)
        continue
      }
      console.log(`[db] agent-id migration: ${g.id} in ${loser.company_id} → ${newId}`)

      // Per-loser transaction so a partial cascade can't leave the
      // DB half-renamed (e.g. participants updated but messages not).
      await client.query('BEGIN')
      try {
        // 1. Rename the participants row itself.
        await client.query(
          `UPDATE participants SET id = $1 WHERE id = $2 AND company_id = $3`,
          [newId, g.id, loser.company_id],
        )

        // 2. Cascade through every table that stores the id by value.
        for (const t of AGENT_ID_CASCADE_TABLES) {
          await client.query(
            `UPDATE ${t.table} SET ${t.column} = $1 WHERE ${t.column} = $2 AND ${t.scopeSql}`,
            [newId, g.id, loser.company_id],
          )
        }

        // 3. conversations.members is a JSONB array of participant
        //    ids — `- $::text` removes the old id, then we append
        //    the new one. Only touch rows in the loser's workspace.
        await client.query(
          `UPDATE conversations
              SET members = (members - $2::text) || to_jsonb(ARRAY[$1::text])
            WHERE company_id = $3
              AND members @> to_jsonb(ARRAY[$2::text])`,
          [newId, g.id, loser.company_id],
        )

        // 4. Rewrite `@oldid` mentions in message bodies for the
        //    loser's workspace so users / agents who re-read the
        //    history still see a resolvable mention chip. `\M` is
        //    PG's POSIX-ERE end-of-word anchor — guards against
        //    accidentally clobbering `@sagacharacter`.
        await client.query(
          `UPDATE messages
              SET body = regexp_replace(body, '@' || $2 || '\\M', '@' || $1, 'g')
            WHERE company_id = $3
              AND body LIKE '%@' || $2 || '%'`,
          [newId, g.id, loser.company_id],
        )

        // 5. board_cards: pre-parsed `mentions` JSONB array + free-
        //    text title / description. Same pattern as conversations
        //    + messages, scoped via boards.company_id.
        await client.query(
          `UPDATE board_cards
              SET mentions = (mentions - $2::text) || to_jsonb(ARRAY[$1::text])
            WHERE mentions @> to_jsonb(ARRAY[$2::text])
              AND board_id IN (SELECT id FROM boards WHERE company_id = $3)`,
          [newId, g.id, loser.company_id],
        )
        await client.query(
          `UPDATE board_cards
              SET title       = regexp_replace(title,                  '@' || $2 || '\\M', '@' || $1, 'g'),
                  description = regexp_replace(COALESCE(description,''), '@' || $2 || '\\M', '@' || $1, 'g')
            WHERE board_id IN (SELECT id FROM boards WHERE company_id = $3)
              AND (title LIKE '%@' || $2 || '%' OR COALESCE(description,'') LIKE '%@' || $2 || '%')`,
          [newId, g.id, loser.company_id],
        )

        // 6. board_card_comments: same treatment, reached via card.
        await client.query(
          `UPDATE board_card_comments
              SET mentions = (mentions - $2::text) || to_jsonb(ARRAY[$1::text])
            WHERE mentions @> to_jsonb(ARRAY[$2::text])
              AND card_id IN (SELECT bc.id FROM board_cards bc JOIN boards b ON b.id = bc.board_id WHERE b.company_id = $3)`,
          [newId, g.id, loser.company_id],
        )
        await client.query(
          `UPDATE board_card_comments
              SET body = regexp_replace(body, '@' || $2 || '\\M', '@' || $1, 'g')
            WHERE body LIKE '%@' || $2 || '%'
              AND card_id IN (SELECT bc.id FROM board_cards bc JOIN boards b ON b.id = bc.board_id WHERE b.company_id = $3)`,
          [newId, g.id, loser.company_id],
        )

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* swallow */ })
        throw err
      }
    }
  }
}

export function computedBaselineMigrationChecksum(): string {
  return createHash('sha256').update(DDL).digest('hex')
}

interface VersionedMigration extends MigrationMetadata {
  sourceChecksum: string
  up(client: import('pg').PoolClient): Promise<void>
}

async function applyLegacyBaseline(client: import('pg').PoolClient): Promise<void> {
  // pgvector remains optional: deployments without the extension retain the
  // recency-only memory path. All other baseline objects are mandatory.
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
  } catch (err) {
    console.warn(
      '[db] pgvector unavailable — semantic memory disabled:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // This is the frozen baseline for databases that predate versioned
  // migrations. It runs once, from the dedicated migration owner, and is never
  // re-applied by application replicas.
  await client.query(DDL)
  await client.query(`
    DO $migrate$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        EXECUTE 'ALTER TABLE agent_workspace ADD COLUMN IF NOT EXISTS embedding vector(1536)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_workspace_embed_hnsw
                   ON agent_workspace
                USING hnsw (embedding vector_cosine_ops)
                WHERE path LIKE ''memory/%''';
      END IF;
    END
    $migrate$;
  `)

  await renameAgentIdCollisions(client)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS participants_agent_id_unique
      ON participants(id) WHERE kind = 'agent'
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_participants_agent_creation_request
      ON participants(company_id, creation_request_id)
      WHERE kind = 'agent' AND creation_request_id IS NOT NULL
  `)
  await ensureMessageClientIdIndex(client)
  await buildConcurrentIndexes(client)
  await verifyRequiredIndexes(client, BASELINE_REQUIRED_SCHEMA_INDEXES)
}

async function applyNormalizedConversationMembers(client: import('pg').PoolClient): Promise<void> {
  await client.query(NORMALIZED_CONVERSATION_MEMBERS_SQL)
}

const VERSIONED_MIGRATIONS: readonly VersionedMigration[] = [
  {
    ...SCHEMA_MIGRATIONS[0],
    sourceChecksum: computedBaselineMigrationChecksum(),
    up: applyLegacyBaseline,
  },
  {
    ...SCHEMA_MIGRATIONS[1],
    sourceChecksum: normalizedConversationMembersChecksum(),
    up: applyNormalizedConversationMembers,
  },
]

function validateMigrationDefinitions(): void {
  if (VERSIONED_MIGRATIONS.length !== SCHEMA_MIGRATIONS.length) {
    throw new Error('migration definitions and immutable manifest have different lengths')
  }
  for (let i = 0; i < VERSIONED_MIGRATIONS.length; i++) {
    const definition = VERSIONED_MIGRATIONS[i]
    const metadata = SCHEMA_MIGRATIONS[i]
    if (
      definition.version !== metadata.version ||
      definition.name !== metadata.name ||
      definition.sourceChecksum !== metadata.checksum
    ) {
      throw new Error(
        `migration ${metadata.version} source checksum changed; append a new migration instead of editing applied history`,
      )
    }
  }
}

/**
 * Apply the immutable migration suffix exactly once.
 *
 * The advisory lock is defense in depth for an accidentally duplicated
 * pre-deploy job. Normal server startup never calls this function.
 */
export async function ensureSchema(): Promise<void> {
  validateMigrationDefinitions()
  const client = await pool.connect()
  try {
    await client.query('SET statement_timeout = 0')
    await client.query('SET idle_in_transaction_session_timeout = 0')
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY])
    await client.query("SET lock_timeout = '5s'")
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version      INTEGER PRIMARY KEY,
          name         TEXT NOT NULL UNIQUE,
          checksum     TEXT NOT NULL,
          execution_ms INTEGER NOT NULL CHECK (execution_ms >= 0),
          applied_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `)

      const readHistory = async (): Promise<AppliedMigration[]> => (
        await client.query<AppliedMigration>(
          `SELECT version, name, checksum, applied_at
             FROM schema_migrations
            ORDER BY version ASC`,
        )
      ).rows

      const history = validateMigrationHistory(await readHistory(), { allowPending: true })
      for (const metadata of history.pending) {
        const migration = VERSIONED_MIGRATIONS.find((candidate) => candidate.version === metadata.version)
        if (!migration) throw new Error(`migration ${metadata.version} has metadata but no implementation`)

        const started = Date.now()
        console.log(`[db] applying migration ${migration.version} ${migration.name}`)
        await migration.up(client)
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, Date.now() - started],
        )
        console.log(`[db] applied migration ${migration.version} in ${Date.now() - started}ms`)
      }

      const finalHistory = validateMigrationHistory(await readHistory())
      await verifyRequiredIndexes(client)
      console.log(`[db] schema is current at version ${finalHistory.currentVersion}`)
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => { /* swallow */ })
    }
  } finally {
    await releaseMigrationClient(client)
  }
}

/** The subset of a pooled client this helper needs — structural so a test can
 *  hand it a fake without a live Postgres. */
type MigrationClient = { query(sql: string): Promise<unknown>; release(): void }

/**
 * Hand the migration client back to the shared pool with its SESSION state wiped.
 *
 * ensureSchema deliberately turns OFF this session's `statement_timeout` and
 * `idle_in_transaction_session_timeout` and sets `lock_timeout = '5s'`. All three
 * are SESSION-scoped, and this client is an ordinary member of the 20-slot pool:
 * `pg-pool`'s `release()` does not reset session state, and node-postgres sends
 * the pool's timeouts only in the connection's STARTUP PACKET, so they are never
 * re-applied on checkout. Without this reset, one pooled connection spends the
 * rest of the process's life with the pool's runaway-query guards disabled — the
 * very protection whose absence once let a single un-indexed query hold all 20
 * slots and 503 the API (see db/pool.ts) — and with a 5s `lock_timeout` that
 * aborts ordinary writes with `55P03` instead of waiting. Same "re-enter the pool
 * with no leftover state" reasoning as the advisory unlock above.
 *
 * A failed RESET must never strand the slot, so we release either way; a
 * genuinely broken connection is discarded by the pool on its own.
 */
export async function releaseMigrationClient(client: MigrationClient): Promise<void> {
  try { await client.query('RESET ALL') }
  catch { /* connection already unusable — releasing still returns the slot */ }
  client.release()
}

/** Correctness index for message idempotency. Build it concurrently so adding
 *  the feature cannot block writes to the hot messages table. */
async function ensureMessageClientIdIndex(client: import('pg').PoolClient): Promise<void> {
  const { rows } = await client.query<{ indisvalid: boolean; indisready: boolean; indislive: boolean }>(
    `SELECT i.indisvalid, i.indisready, i.indislive FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = 'uniq_messages_client_id'`,
  )
  if (rows[0]?.indisvalid && rows[0].indisready && rows[0].indislive) return
  await client.query("SET lock_timeout = '0'")
  try {
    if (rows[0]) await client.query('DROP INDEX CONCURRENTLY IF EXISTS uniq_messages_client_id')
    await client.query(`CREATE UNIQUE INDEX CONCURRENTLY uniq_messages_client_id
      ON messages(conversation_id, author_id, client_id)
      WHERE client_id IS NOT NULL`)
  } finally {
    await client.query("SET lock_timeout = '5s'")
  }
}

/**
 * Build indexes that are unsafe inside the main migration transaction.
 *
 * A plain `CREATE INDEX` takes a lock that blocks writes to the target table
 * for the entire build. On a hot table under live traffic that wait deadlocks
 * (`40P01`) against concurrent writes — and because the build then never
 * commits, EVERY pod retries it on boot and none can start. That is exactly
 * what wedged production (the conversations.members GIN build).
 *
 * `CREATE INDEX CONCURRENTLY` lets writes proceed during the build, so there is
 * no blocking lock and no deadlock. It MUST run outside any transaction — hence
 * its own statements here, after the DDL batch committed.
 *
 * These are now promotion requirements. A previously interrupted concurrent
 * build leaves an INVALID index behind; `IF NOT EXISTS` would then skip it
 * forever, so the migration owner drops the dead entry and rebuilds it. Failure
 * stops promotion but cannot crash-loop application replicas because replicas
 * never run this code.
 */
async function buildConcurrentIndexes(client: import('pg').PoolClient): Promise<void> {
  const indexes: Array<{ name: string; create: string }> = [
    {
      name: 'idx_conversations_members_gin',
      // members @> [agentId] containment — the hottest read path (loadInbox /
      // loadContext / inbox-triage, called per wake + poll). Without it each
      // call seq-scans every conversation and saturates the pool.
      create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_members_gin
                 ON conversations USING gin (members jsonb_path_ops)`,
    },
    {
      name: 'idx_messages_author_created',
      // MAX(created_at) WHERE author_id = $1 — the idle scheduler's "when did
      // this agent last speak?" probe (idle.ts). Without it that subquery
      // SEQ-SCANNED the whole messages table per agent (~8s, 20+ concurrent),
      // saturating the connection pool and 503-ing the whole API.
      create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_author_created
                 ON messages(author_id, created_at DESC)`,
    },
    {
      name: 'idx_llm_calls_created_brin',
      // Every Observability aggregation filters `created_at > NOW() - Ndays`,
      // and the DEFAULT admin view passes no companyId — so NONE of the other
      // llm_calls indexes (all led by company_id / run_id / agent_id / model /
      // daemon_version) can serve it. Without a created_at-led index the global
      // summary/rollup/trend/topAgents/daemonVersion queries each SEQ-SCAN the
      // whole ledger on every page load → the slow Observability API.
      //
      // BRIN, not btree: llm_calls is append-only and physically time-ordered,
      // so block-range pruning matches the window range scan exactly, the index
      // is kilobytes regardless of table size, and it adds ~zero write cost to
      // this hot insert path (every LLM call inserts a row). When the window is
      // most of the table the planner still (correctly) seq-scans; this only
      // pays off — and pays off big — as history grows past the window.
      create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_llm_calls_created_brin
                 ON llm_calls USING brin (created_at)`,
    },
  ]
  for (const ix of indexes) {
    const { rows } = await client.query<{ indisvalid: boolean; indisready: boolean; indislive: boolean }>(
      `SELECT i.indisvalid, i.indisready, i.indislive FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [ix.name],
    )
    if (rows[0] && (!rows[0].indisvalid || !rows[0].indisready || !rows[0].indislive)) {
      console.warn(`[db] dropping invalid leftover index ${ix.name} before rebuild`)
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${ix.name}`)
    } else if (rows[0]) {
      continue
    }
    await client.query(ix.create)
    console.log(`[db] concurrent index ready: ${ix.name}`)
  }
}

const BASELINE_REQUIRED_SCHEMA_INDEXES = [
  'participants_agent_id_unique',
  'uniq_participants_agent_creation_request',
  'uniq_messages_client_id',
  'uniq_board_creation_request',
  'uniq_document_creation_request',
  'uniq_calendar_event_creation_request',
  'idx_realtime_outbox_pending',
  'idx_conversations_members_gin',
  'idx_messages_author_created',
  'idx_llm_calls_created_brin',
] as const

export const REQUIRED_SCHEMA_INDEXES = [
  ...BASELINE_REQUIRED_SCHEMA_INDEXES,
  'conversation_members_conversation_ordinal_key',
  'idx_conversation_members_participant',
] as const

/** Promotion gate: every required index must exist and be valid, ready, and
 * live. An interrupted CREATE INDEX CONCURRENTLY must never look healthy. */
async function verifyRequiredIndexes(
  client: import('pg').PoolClient,
  requiredIndexes: readonly string[] = REQUIRED_SCHEMA_INDEXES,
): Promise<void> {
  const { rows } = await client.query<{
    name: string
    indisvalid: boolean
    indisready: boolean
    indislive: boolean
  }>(
    `SELECT c.relname AS name, i.indisvalid, i.indisready, i.indislive
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = ANY($1::text[])`,
    [[...requiredIndexes]],
  )
  const byName = new Map(rows.map((row) => [row.name, row]))
  const invalid = requiredIndexes.filter((name) => {
    const row = byName.get(name)
    return !row || !row.indisvalid || !row.indisready || !row.indislive
  })
  if (invalid.length > 0) {
    throw new Error(`required schema indexes missing or invalid: ${invalid.join(', ')}`)
  }
}
