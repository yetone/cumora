/** Validated environment variables — fail fast on boot.
 *
 *  `dotenv/config` is imported eagerly so that running `tsx server/src/...`
 *  or `node` directly picks up `.env` at the repo root without needing
 *  `node --env-file` or `dotenv-cli` wrappers. Values in the real
 *  environment win over those in `.env` (dotenv default), so deployment
 *  doesn't need a file. */
import 'dotenv/config'

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (!v) {
    console.error(`[env] Missing required environment variable: ${name}`)
    process.exit(1)
  }
  return v
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.5'
// Cerebellum default — small/fast model used by JSON classifiers and one-shot
// utilities that don't drive the agent's perceived intelligence (gender infer,
// palette, completion verifier, agenda pre-check, decision summarizer, etc.).
// Kept as a *named* default so all cerebellum knobs land on the same model
// when an operator doesn't override individually.
const DEFAULT_SUPPORT_MODEL = process.env.OPENAI_MODEL_SUPPORT ?? 'gpt-5.4-mini'

// Public-source dev default for the runtime-JWT secret. Safe for a single
// dev machine; a production deploy left on it lets anyone who read the
// (open-source) code forge runtime tokens, so boot refuses it below.
const DEV_AGENT_RUNTIME_SECRET = 'dev-agent-runtime-secret-do-not-use-in-prod'

export const env = {
  PORT: Number(process.env.PORT ?? 5181),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  DATABASE_URL: required('DATABASE_URL', `postgres://${process.env.USER ?? 'postgres'}@localhost:5432/cumora`),
  REDIS_URL: required('REDIS_URL', 'redis://localhost:6379'),
  OPENAI_API_KEY: required('OPENAI_API_KEY'),
  /**
   * "Brain" model — the agent's main reasoning loop and convene speech.
   * Default model used when an agent's `participants.model` is NULL.
   * Per-agent overrides live on the agent row in DB and are edited from
   * the UI — no env vars are keyed by agent id.
   */
  OPENAI_MODEL: DEFAULT_MODEL,
  /**
   * "Cerebellum" model — JSON classifiers, palette, gender inference,
   * heartbeat agenda pre-check. Cheap/fast; quality matters less than
   * latency + cost. Default is a small model (not DEFAULT_MODEL) so
   * unconfigured deployments still split brain/cerebellum.
   */
  OPENAI_MODEL_SUPPORT: DEFAULT_SUPPORT_MODEL,
  /**
   * "Cerebellum" summarizer — used by auto-compaction summarizer,
   * verifyTerminalCompletion, and the mid-turn steer-batch summarizer.
   * One-shot text reductions, never the main reasoning. Defaults to the
   * support model so it ships on the small tier by default; can be
   * pointed at a separate model if operators want a different size
   * (e.g. nano) for these calls specifically.
   */
  OPENAI_COMPACTION_MODEL: process.env.OPENAI_COMPACTION_MODEL ?? DEFAULT_SUPPORT_MODEL,
  /**
   * Novita LLM API key. Optional — when unset, agents configured with a
   * `novita/<model>` model id (see server/src/novita.ts) fall back to the
   * legacy/sub2api client instead, so an unconfigured deployment doesn't
   * break the run; the model just won't resolve to Novita as intended.
   */
  NOVITA_API_KEY: process.env.NOVITA_API_KEY ?? '',
  /** Novita's OpenAI-compatible Chat Completions base. Override for a
   *  self-hosted proxy or a pinned API version. */
  NOVITA_BASE_URL: (process.env.NOVITA_BASE_URL ?? 'https://api.novita.ai/openai').replace(/\/+$/, ''),
  /**
   * OrcaRouter LLM API key. Optional — when unset, agents configured with a
   * `orcarouter/<model>` model id (see server/src/orcarouter.ts) fall back to
   * the legacy/sub2api client instead, so an unconfigured deployment doesn't
   * break the run; the model just won't resolve to OrcaRouter as intended.
   */
  ORCAROUTER_API_KEY: process.env.ORCAROUTER_API_KEY ?? '',
  /** OrcaRouter's OpenAI-compatible Responses base. OrcaRouter speaks the
   *  Responses API natively, so the `orcarouter/<model>` route is a pure
   *  base-URL swap (no Chat-Completions translation, unlike Novita). */
  ORCAROUTER_BASE_URL: (process.env.ORCAROUTER_BASE_URL ?? 'https://api.orcarouter.ai/v1').replace(/\/+$/, ''),
  /**
   * Webhook URL for process-level alerts (unhandledRejection /
   * uncaughtException). Currently expects a Discord-compatible
   * `{ content: "..." }` JSON payload. When unset, alerts are still
   * logged but no network call is made.
   */
  ALERT_WEBHOOK_URL: process.env.ALERT_WEBHOOK_URL ?? '',
  /**
   * Mid-turn steering kill-switch. When set to 'false' / '0' / 'no':
   *   - scheduler.wake() skips deliverSteer entirely (only wake fires)
   *   - pushSteer is a no-op on the pod side
   *   - existing in-flight queues are left alone (they'll drain or
   *     reset normally)
   * Default 'on' — set this if steering causes an incident in prod
   * and you need to disable it without a redeploy.
   */
  STEER_ENABLED: !/^(false|0|no|off)$/i.test(process.env.STEER_ENABLED ?? ''),
  /**
   * The `one-of-us` half of agent routing (#70): when a human group message
   * names NO agent, the small-model router may elect ONE candidate to take the
   * turn instead of waking the whole room. Election + lease + fallback live in
   * agents/routing-election.ts / agents/routing-claims.ts.
   * Default 'off' (opt-in) — set ROUTING_ONE_OF_US=true to enable.
   */
  ROUTING_ONE_OF_US: /^(true|1|yes|on)$/i.test(process.env.ROUTING_ONE_OF_US ?? ''),
  /**
   * Minimum interval (ms) between alerts that share the same
   * (label, error-fingerprint). Defaults to 60s — protects the webhook
   * from a tight loop of identical crashes hammering it.
   */
  ALERT_DEDUPE_MS: Number(process.env.ALERT_DEDUPE_MS ?? 60_000),
  /** Image model for avatar generation. Override with OPENAI_IMAGE_MODEL. */
  OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
  /** Background scanner cadence */
  SCANNER_INTERVAL_MS: Number(process.env.SCANNER_INTERVAL_MS ?? 90_000),
  /**
   * Idle scheduler cadence — how often we wake one available agent and let
   * them decide whether to spontaneously DM a teammate or post a
   * standalone thought (instead of only reacting to incoming messages).
   * Set to 0 to disable.
   */
  IDLE_INTERVAL_MS: Number(process.env.IDLE_INTERVAL_MS ?? 15 * 60_000),
  /** Min minutes since an agent last spoke before they're eligible for an idle tick. */
  IDLE_MIN_QUIET_MIN: Number(process.env.IDLE_MIN_QUIET_MIN ?? 25),
  /** for distributed deploys, identify this instance in logs / pubsub */
  INSTANCE_ID: process.env.INSTANCE_ID ?? `app-${Math.random().toString(36).slice(2, 7)}`,
  /**
   * Publicly reachable origin for /uploads URLs. OpenAI's input_image needs
   * a URL it can actually fetch — \`http://localhost:5181\` won't work in prod
   * but does work for local dev IF the server is on the same host as the
   * browser (it isn't, OpenAI fetches from its side). For real vision in dev,
   * point this at an ngrok / cloudflared tunnel to your :5181.
   */
  PUBLIC_HOST: process.env.PUBLIC_HOST ?? '',
  /**
   * Cloudflare R2 (or S3-compatible) object storage. When ALL four core vars
   * below are set, the storage layer flips to R2 mode: the browser uploads
   * directly via a presigned PUT URL, avatar generation persists to R2, and
   * /uploads static-serve is disabled. If any are missing, we fall back to
   * local disk (server/uploads/) — useful for local dev without a bucket.
   *
   * `R2_ENDPOINT` — the bucket endpoint, e.g. https://<accountid>.r2.cloudflarestorage.com
   * `R2_BUCKET`   — bucket name
   * `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` — API token credentials
   * `R2_PUBLIC_BASE` — public CDN/custom-domain base for read URLs, e.g.
   *   https://cdn.cumora.app (no trailing slash). When unset we'll generate
   *   short-lived presigned GET URLs instead — works but not cacheable.
   */
  R2_ENDPOINT: process.env.R2_ENDPOINT ?? '',
  R2_BUCKET: process.env.R2_BUCKET ?? '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? '',
  R2_PUBLIC_BASE: (process.env.R2_PUBLIC_BASE ?? '').replace(/\/+$/, ''),
  /**
   * HMAC secret shared between this server (URL signer) and the Cloudflare
   * Worker fronting `cdn.cumora.ai`. When set, R2 public URLs are emitted
   * with `?exp=<unix>&sig=<hex>` and the Worker validates both before
   * proxying R2 reads. Leave blank to skip signing (URLs served unsigned —
   * fine in local dev, NOT for prod).
   */
  R2_URL_SIGNING_SECRET: process.env.R2_URL_SIGNING_SECRET ?? '',
  /** TTL (seconds) baked into each signed URL. Keep short — message
   *  attachments are re-signed on every read, so users never see expired
   *  links during normal browsing. Default 1 hour. */
  R2_URL_TTL_SECONDS: Number(process.env.R2_URL_TTL_SECONDS ?? 3600),
  /**
   * Base URL of an Agent Skills hub — any HTTP service that implements
   * the contract below. Agents use it via `cumora skills search/install`.
   * Leave blank to disable the hub commands; agents can still create
   * their own skills via `cumora skills create`.
   *
   *   GET  <hub>/search?q=<query>
   *     → [{ name, description, version?, author?, install_url }]
   *
   *   GET  <hub>/skills/<name>
   *     → { name, description, version?, author?, files: [
   *           { path: 'SKILL.md', body: '...' },
   *           { path: 'scripts/foo.py', body: '...' },
   *           ...
   *         ] }
   */
  SKILLHUB_URL: (process.env.SKILLHUB_URL ?? '').replace(/\/+$/, ''),
  /**
   * HMAC secret used to sign per-agent JWTs handed to runtime pods.
   * The server signs at pod-spawn time; the pod presents the token on
   * every `/runtime/*` request. Token shape:
   *   { sub: agentId, companyId, scope: 'agent-runner', iat, exp }
   *
   * Dev default = deterministic-but-random-looking string so single-
   * machine dev "just works". In prod set a real high-entropy secret —
   * boot refuses to start on this default when NODE_ENV=production
   * (see the production-secret gate below). The default is public
   * source, so a prod deploy left on it would let anyone forge runtime
   * JWTs and impersonate any agent/tenant.
   */
  AGENT_RUNTIME_SECRET: process.env.AGENT_RUNTIME_SECRET ?? DEV_AGENT_RUNTIME_SECRET,
  /**
   * Full URL the agent-runner pod uses to reach the cumora server's
   * `/runtime` API (note the trailing path). From OrbStack K8s a pod
   * talks to the host via `host.docker.internal`. Override in prod
   * with the in-cluster service URL — typically something like
   * `http://cumora-server.default.svc.cluster.local:5181/runtime`.
   */
  AGENT_RUNTIME_SERVER_URL: process.env.AGENT_RUNTIME_SERVER_URL ?? `http://host.docker.internal:${process.env.PORT ?? 5181}/runtime`,
  /**
   * Per-agent pod idle timeout. After this many ms with no wake
   * events, the Pod sets the agent's status to `resting`, gracefully
   * shuts down, and the K8s Pod is gone. The PVC stays so the next
   * wake re-uses the same workspace.
   *
   * Default 3 minutes — was 10 min before the FUSE-cap incident on
   * 2026-05-20, when post-crashloop-recovery thundering-herd spawned
   * hundreds of idle pods that each held a /dev/fuse slot for 10 min
   * each, blowing past the cluster's 50-slot cap. 3 min still
   * absorbs bouncy conversation cold-starts (each pod cold-start is
   * ~5s with PVC bound) and lets fuse slots recycle 3× faster.
   */
  AGENT_IDLE_MS: Number(process.env.AGENT_IDLE_MS ?? 3 * 60_000),
  /**
   * Pod no-work-detected fast-exit timeout (ms). If a pod boots,
   * runs its bootstrap inbox-drain, and then receives NO further
   * SSE wake/steer event within this window, it self-exits to free
   * the /dev/fuse slot. Distinct from AGENT_IDLE_MS, which is the
   * "I've done work, now I've been quiet for a while" timer.
   *
   * Default 90s — covers crashloop-recovery scenarios where a wake
   * fired against a resting agent, ensurePod spawned a pod, the
   * pod's bootstrap drain handled the queued message, and then no
   * follow-up wake arrives. Without this, the pod would sit on the
   * FUSE slot until AGENT_IDLE_MS elapsed even though it had no
   * pending work.
   */
  AGENT_NO_WORK_MS: Number(process.env.AGENT_NO_WORK_MS ?? 90_000),
  /**
   * App-level ceiling for concurrently active agent pods. This is
   * intentionally separate from the generic-device-plugin's advertised
   * /dev/fuse count: GKE can expose hundreds of logical FUSE slots per
   * node, but CPU, memory, API-server churn, and provider concurrency
   * are the real production ceiling. The orchestrator admits new pods
   * against min(cluster fuse capacity, this value). Set <=0 to rely on
   * the cluster resource only.
   */
  AGENT_POD_ADMISSION_MAX: Number(process.env.AGENT_POD_ADMISSION_MAX ?? 40),
  /**
   * Max concurrent recipients the scheduler triages + wakes at once,
   * PER server replica. The wake fan-out for a group message used to be
   * an unbounded `Promise.all` over every recipient — each running a
   * 3-query triage (loadPersona/loadInbox/loadContext) + a support-model
   * call + ensurePod. Under a swarm reply-storm that stampeded the pg
   * pool (max 20): triage timed out acquiring a connection, fell open,
   * woke the agent anyway, which generated more messages → more wakes →
   * a self-amplifying loop that survived restarts (the 2026-05-27
   * connection-exhaustion outage). Bounding the fan-out turns the
   * stampede into backpressure; excess wakes queue and drain. Keep
   * comfortably below the pool size so request handlers and other paths
   * still get connections. Set <=0 to fall back to 1 (never unbounded).
   */
  WAKE_FANOUT_CONCURRENCY: Number(process.env.WAKE_FANOUT_CONCURRENCY ?? 6),
  /**
   * Max concurrent `kubectl` child processes the orchestrator spawns,
   * PER server replica. Each kubectl is a ~50–100MB Go binary that
   * counts against the pod's memory/CPU cgroup; an unbounded burst of
   * them (one+ per wake during a storm) can OOM-kill or CPU-throttle the
   * server pod itself. This cap also closes the pod-admission race —
   * with bounded concurrency the admit check (used < cap) no longer
   * fires hundreds of times before any pod actually starts. Set <=0 to
   * fall back to 1.
   */
  KUBECTL_MAX_CONCURRENCY: Number(process.env.KUBECTL_MAX_CONCURRENCY ?? 8),
  /**
   * Comma-separated allow-list of origins for CORS. The browser only
   * sends an Origin header for cross-origin requests, so leaving this
   * blank preserves same-origin / Vite-proxy behavior in dev. Set to
   * the renderer's origin when you ship a build that talks directly
   * to this server from a different host (e.g. a packaged Electron
   * app pointing at https://api.cumora.ai). Use `*` to allow any
   * origin (no credentials).
   */
  CORS_ORIGINS: (process.env.CUMORA_CORS_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  /**
   * OAuth providers (Google + GitHub). Set the four creds below + the two
   * URLs to enable. The callback URL must match the redirect registered with
   * the provider; the done URL is where we 302 the browser after creating
   * the session, with `#token=<bearer>&companyId=<id>` on the fragment so the
   * renderer can pick it up without it landing in server access logs.
   */
  GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  GITHUB_CLIENT_ID:     process.env.GITHUB_CLIENT_ID     ?? '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET ?? '',
  GITLAB_CLIENT_ID:     process.env.GITLAB_CLIENT_ID     ?? '',
  GITLAB_CLIENT_SECRET: process.env.GITLAB_CLIENT_SECRET ?? '',
  /** Which GitLab to talk to. Defaults to gitlab.com; point it at a
   *  self-managed instance (https://gitlab.example.com) to sign in against
   *  that one instead. Whatever you set here is TRUSTED to attest its users'
   *  email ownership — the same trust Google and GitHub get — because a
   *  verified email is what lets sign-in link to an existing account. */
  GITLAB_BASE_URL: (process.env.GITLAB_BASE_URL ?? 'https://gitlab.com').replace(/\/+$/, ''),
  /** Public origin this server is reachable at. Used to construct the
   *  per-provider redirect_uri that we hand to Google / GitHub at flow
   *  start. Defaults to http://localhost:5181 for local dev. In prod
   *  set CUMORA_PUBLIC_ORIGIN=https://api.cumora.ai. */
  PUBLIC_ORIGIN: (process.env.CUMORA_PUBLIC_ORIGIN ?? 'http://localhost:5181').replace(/\/+$/, ''),
  /** Default URL the server 302s to after a successful OAuth callback,
   *  with `#token=...&companyId=...` appended. Used when the client
   *  didn't pass `?return=` at flow start. For dev (Vite) point at
   *  http://localhost:5173/; for packaged Electron the client passes
   *  cumora://auth at start time and the server picks that. */
  AUTH_DONE_URL: process.env.CUMORA_AUTH_DONE_URL ?? 'http://localhost:5173/',
  /** Allow-list of return URLs the client may pass via /auth/start
   *  `?return=...`. Without this we'd have an open-redirect: any
   *  attacker could craft a malicious provider-callback chain that
   *  delivers the user's token to a foreign origin. A return URL is
   *  accepted iff it startsWith one of these prefixes. Comma-separated.
   *  Common values:
   *    cumora://auth                       (packaged Electron deep link)
   *    http://localhost:5173/              (Vite dev renderer)
   *    http://localhost:5180/              (Electron dev renderer)
   *    https://app.cumora.ai/              (future web client)
   */
  AUTH_RETURN_ALLOWLIST: (process.env.CUMORA_AUTH_RETURN_ALLOWLIST ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),
  /** Base URL used to build the public face of company invitation links
   *  (`<base>/invite/<token>`). When unset we fall back to AUTH_DONE_URL —
   *  already prod-correct for the OAuth flow (https://app.cumora.ai on the
   *  web, cumora://auth in packaged Electron which gets rewritten to
   *  cumora://invite/<token>). Set this only if the invite-acceptance flow
   *  lives on a different origin than the OAuth redirect. */
  INVITE_BASE_URL: process.env.CUMORA_INVITE_BASE_URL ?? '',
  /**
   * sub2api LLM quota gateway. When SUB2API_ADMIN_KEY is set, OAuth
   * signup provisions a per-user sub2api account + API key, and every
   * LLM client uses that user's key + the sub2api OpenAI-compatible
   * endpoint. Without the admin key we fall back to the legacy single
   * OPENAI_API_KEY path (no per-user quotas).
   *
   * Three knobs:
   *   SUB2API_INTERNAL_URL — where THIS server reaches sub2api for
   *                          admin calls (user create, login-as-user,
   *                          mint key, replace-group). In-cluster:
   *                          http://sub2api:8080.
   *   SUB2API_PUBLIC_URL   — public domain for browser/operator access
   *                          (https://sub2api.cumora.ai). Backend LLM
   *                          traffic should prefer SUB2API_INTERNAL_URL
   *                          to avoid ingress request timeouts.
   *   SUB2API_ADMIN_KEY    — `x-api-key` header value for admin
   *                          endpoints. Generated once in the sub2api
   *                          dashboard at https://sub2api.cumora.ai/.
   *
   * Tier → sub2api group_id mapping. Numeric ids come from the
   * dashboard after you create the three quota groups. 0 means "tier
   * unmapped, leave user without group" — useful for staged rollout
   * (the user has a sub2api account but can't call upstream yet).
   */
  SUB2API_INTERNAL_URL: (process.env.SUB2API_INTERNAL_URL ?? '').replace(/\/+$/, ''),
  SUB2API_PUBLIC_URL:   (process.env.SUB2API_PUBLIC_URL ?? '').replace(/\/+$/, ''),
  SUB2API_ADMIN_KEY:    process.env.SUB2API_ADMIN_KEY ?? '',
  SUB2API_TIER_FREE_GROUP_ID: Number(process.env.SUB2API_TIER_FREE_GROUP_ID ?? 0),
  SUB2API_TIER_PRO_GROUP_ID:  Number(process.env.SUB2API_TIER_PRO_GROUP_ID  ?? 0),
  SUB2API_TIER_MAX_GROUP_ID:  Number(process.env.SUB2API_TIER_MAX_GROUP_ID  ?? 0),
  /**
   * Comma-separated allow-list of emails that are forced to `is_admin =
   * true` on every server boot. The bootstrap path so that adding a new
   * admin doesn't require a SQL session — just add their email here +
   * redeploy. Removing an email from the env does NOT demote the user
   * (we never write FALSE from this path); demotion goes through the
   * admin panel.
   */
  ADMIN_EMAILS: (process.env.CUMORA_ADMIN_EMAILS ?? '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /**
   * Real-email feature. When all three core vars are set, agents can send
   * mail (Resend) and receive mail (Cloudflare Email Worker → /webhooks/
   * email/inbound). When unset we still register the CLI subcommands but
   * sends short-circuit to a mock that returns a fake message-id and logs
   * — useful for local dev so the agent can rehearse the flow without
   * burning Resend quota.
   *
   *   RESEND_API_KEY            — Resend API key (re_… token)
   *   EMAIL_DOMAIN              — root domain that hosts agent addresses,
   *                               e.g. "cumora.ai". Per-agent address is
   *                               <participantId>.<companySlug>@<EMAIL_DOMAIN>.
   *   EMAIL_INBOUND_HMAC_SECRET — shared secret with the CF Email Worker.
   *                               Worker signs the JSON body; server verifies
   *                               with timing-safe HMAC-SHA256 compare.
   */
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  EMAIL_DOMAIN: (process.env.EMAIL_DOMAIN ?? '').toLowerCase().replace(/^\.+|\.+$/g, ''),
  EMAIL_INBOUND_HMAC_SECRET: process.env.EMAIL_INBOUND_HMAC_SECRET ?? '',
  /** Mock-mode failure injection rate, 0..1. Only honored when
   *  RESEND_API_KEY is empty (i.e. already in mock mode). Lets local dev
   *  exercise the transport_status='failed' branch without misconfiguring
   *  real credentials. 0 / unset = always succeed. */
  EMAIL_MOCK_FAIL_RATE: Math.max(0, Math.min(1, Number(process.env.EMAIL_MOCK_FAIL_RATE ?? 0) || 0)),
  /** Interval between outbound retry-loop ticks. Defaults to 60s; set to
   *  0 to disable retry entirely (failed sends stay failed forever). The
   *  loop uses SKIP LOCKED so multiple replicas can run it concurrently. */
  EMAIL_RETRY_INTERVAL_MS: Number(process.env.EMAIL_RETRY_INTERVAL_MS ?? 60_000),
  /** Interval between email-attachment GC sweeps. Defaults to 24h. The
   *  sweep enumerates the storage prefix, compares against DB-referenced
   *  keys, and deletes orphans older than the safety threshold. Setting
   *  to 0 disables — useful when running on a backend whose enumeration
   *  is expensive or when you'd rather invoke `runGcTick()` ad-hoc. */
  EMAIL_GC_INTERVAL_MS: Number(process.env.EMAIL_GC_INTERVAL_MS ?? 24 * 60 * 60_000),
  /** Interval between DB row-retention sweeps (db-gc.ts). Each tick
   *  deletes up to 10 batches of DB_GC_BATCH rows per table, so the
   *  default 5min cadence burns a large backlog gradually without
   *  starving vacuum. 0 disables the worker entirely. */
  DB_GC_INTERVAL_MS: Number(process.env.DB_GC_INTERVAL_MS ?? 5 * 60_000),
  /** Rows per delete batch. Small batches = short locks. */
  DB_GC_BATCH: Number(process.env.DB_GC_BATCH ?? 10_000),
  /** Per-table retention windows in days; 0 disables that table's sweep.
   *  Readers only touch recent rows (see db-gc.ts header) — bump these
   *  if a new feature ever needs deeper history. */
  DB_GC_AGENT_LOG_DAYS: Number(process.env.DB_GC_AGENT_LOG_DAYS ?? 30),
  DB_GC_AGENT_EVENTS_DAYS: Number(process.env.DB_GC_AGENT_EVENTS_DAYS ?? 30),
  DB_GC_AGENT_RUNS_DAYS: Number(process.env.DB_GC_AGENT_RUNS_DAYS ?? 30),
  DB_GC_LLM_CALLS_DAYS: Number(process.env.DB_GC_LLM_CALLS_DAYS ?? 90),
  /** Days past expires_at before a ws_ticket row is reaped. */
  DB_GC_WS_TICKETS_DAYS: Number(process.env.DB_GC_WS_TICKETS_DAYS ?? 1),
  /** Durable external-resource cleanup after workspace deletion. Set the
   * interval to 0 to leave jobs queued for a separately invoked worker. */
  WORKSPACE_CLEANUP_INTERVAL_MS: Number(process.env.WORKSPACE_CLEANUP_INTERVAL_MS ?? 60_000),
  /** Explicitly enable Kubernetes Pod/PVC cleanup. Local and integration
   * environments default off without relying on database-name heuristics. */
  WORKSPACE_RUNTIME_CLEANUP_ENABLED: ['1', 'true', 'yes', 'on'].includes(
    (process.env.WORKSPACE_RUNTIME_CLEANUP_ENABLED ?? '').toLowerCase(),
  ),
  /** Interval between poll-expiration sweeps. Defaults to 60s. The sweep
   *  flips polls past their expiresAt to closed and broadcasts the close
   *  event. Set to 0 to disable (polls then stay open forever even after
   *  their declared expiration — manual close still works). */
  POLL_SWEEP_INTERVAL_MS: Number(process.env.POLL_SWEEP_INTERVAL_MS ?? 60_000),
  /** Interval between chrome-profile PVC garbage-collection passes.
   *  Each pass lists all `app=cumora-agent` PVCs, joins against
   *  participants + agent_runs, and drops PVCs whose agent has been
   *  off-boarded OR hasn't run in CHROME_PVC_GC_IDLE_DAYS. Default
   *  hourly cadence — the work is sized for off-the-clock cleanup,
   *  not real-time. Set to 0 to disable. */
  CHROME_PVC_GC_INTERVAL_MS: Number(process.env.CHROME_PVC_GC_INTERVAL_MS ?? 60 * 60_000),
  /** How many days an agent must be inactive before its
   *  chrome-profile PVC is reclaimed. 30d is the sweet spot: long
   *  enough that idle but in-use agents (weekend / vacation) don't
   *  lose login state, short enough that abandoned agents don't
   *  accumulate $0.10/month forever. */
  CHROME_PVC_GC_IDLE_DAYS: Number(process.env.CHROME_PVC_GC_IDLE_DAYS ?? 30),
  /** Bearer token gating GET /api/metrics. Unset → endpoint returns 404
   *  (don't leak internal counts to unauthenticated callers in deploys
   *  that haven't set up Prometheus yet). When set, scrapers pass it as
   *  ?token=<value> OR Authorization: Bearer <value>. */
  METRICS_BEARER_TOKEN: process.env.METRICS_BEARER_TOKEN ?? '',
  /** Discord webhook for operational alerts (terminal retry failure,
   *  attachment upload error). Separate from the release webhook so
   *  release announcements don't drown out paging-level signals.
   *  Unset → alerts are no-ops + log only. */
  DISCORD_ALERT_WEBHOOK_URL: process.env.DISCORD_ALERT_WEBHOOK_URL ?? '',
  /** APNs (Apple Push Notification) credentials. All four must be set or
   *  push is soft-disabled (registration endpoints still accept tokens,
   *  but the sender is a no-op). See docs/PUSH_NOTIFICATIONS.md for how
   *  to mint the .p8 in the Apple Developer Portal. */
  APNS_KEY_PATH: process.env.APNS_KEY_PATH ?? '',
  APNS_KEY_ID: process.env.APNS_KEY_ID ?? '',
  APNS_TEAM_ID: process.env.APNS_TEAM_ID ?? '',
  /** APNs topic — must match the iOS bundle id (io.cumora.app). */
  APNS_TOPIC: process.env.APNS_TOPIC ?? 'io.cumora.app',
  /** 'development' uses api.sandbox.push.apple.com (TestFlight + dev builds),
   *  'production' uses api.push.apple.com (App Store). Mismatching env vs.
   *  build will silently 400 every push — get it right. */
  APNS_ENV: (process.env.APNS_ENV === 'production' ? 'production' : 'development') as 'development' | 'production',
  /** FCM (Firebase Cloud Messaging, HTTP v1) credentials for Android push.
   *  Supply the Firebase service-account JSON either inline (raw or base64)
   *  via FCM_SERVICE_ACCOUNT_JSON, or as a file path via
   *  FCM_SERVICE_ACCOUNT_PATH. Absent → Android push is soft-disabled
   *  (the /push/register endpoint still accepts android tokens; the sender
   *  is a no-op). The JSON's `project_id`, `client_email`, and `private_key`
   *  are read at send time. Generated in Firebase Console → Project settings
   *  → Service accounts → "Generate new private key".
   *  Keep it OUT of git — configure it as a server secret only. */
  FCM_SERVICE_ACCOUNT_JSON: process.env.FCM_SERVICE_ACCOUNT_JSON ?? '',
  FCM_SERVICE_ACCOUNT_PATH: process.env.FCM_SERVICE_ACCOUNT_PATH ?? '',
}

// Production-secret gate: refuse to boot in production while any security
// secret is still on its public-source dev default. Without this, a deploy
// that forgot to set AGENT_RUNTIME_SECRET would sign/verify every runtime
// JWT with a value anyone can read in the repo — a full agent/tenant
// impersonation bypass. Fail closed, loudly, at startup rather than serve
// forgeable tokens.
if (env.NODE_ENV === 'production') {
  if (env.AGENT_RUNTIME_SECRET === DEV_AGENT_RUNTIME_SECRET) {
    console.error(
      '[env] AGENT_RUNTIME_SECRET is still the dev default in production. ' +
      'Set it to a high-entropy secret (e.g. `openssl rand -hex 32`) — refusing to start.',
    )
    process.exit(1)
  }
}
