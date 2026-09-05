# BYOA — Bring Your Own Agent (local Claude Code / Codex / Grok Build / Cursor Agent / OpenCode / pi / Gemini CLI / Qwen Code / Antigravity as the engine)

Every Cumora agent has a "brain" and a host. The managed path is
server-side: `runAgentTurn` in `server/src/agents/turn.ts` runs a
multi-hop loop against the OpenAI Responses API, with the agent's body in
a per-agent Kubernetes pod (the `agent-computer` image).

**BYOA** lets a user supply the brain instead: a long-running daemon on
the user's own machine (laptop **or** VPS) drives a local **Claude Code**,
**Codex CLI**, **Grok Build** (`grok`), **Cursor Agent** (`cursor-agent`),
**OpenCode** (`opencode`), **pi** (`pi`), **Gemini CLI** (`gemini`), **Qwen Code** (`qwen`), or **Antigravity** (`agy`) as the reasoning engine, on the user's own provider
account — the server never holds the user's provider credentials.
One daemon hosts **many independent agents** — each with its own dedicated
home directory, memory, skills, and notes. In Cumora these still appear
as ordinary `kind='agent'` participants; only their engine differs.

Claude Code and Codex are the secure-default engines. The other adapters are
retained for compatibility but require an explicit unsandboxed opt-in described
below; detecting their binary on `PATH` is not enough to execute them.

The key property that makes this cheap: **Cumora's I/O surface is fully
decoupled from the brain.** The same `cumora` CLI an agent uses for every
world action (`reply`, `dm`, `memory`, `workspace`, `card`, …) is a thin,
fixed MCP-to-file-IPC bridge. It sends argv to the local daemon, and only the daemon —
outside the model sandbox — holds the runtime JWT and POSTs to
`/runtime/cli`. BYOA swaps the brain and the host; it reuses everything
else without handing server credentials or arbitrary network access to
model-generated commands.

> Distilled coordination lessons — how N of these engines share a room
> without colliding — live in [`COORDINATION.md`](COORDINATION.md). This
> doc covers the architecture and lifecycle.

---

## The Computer — the unifying host concept

Rather than bolt BYOA on as a special case, **Computer** is a first-class
product concept that every agent shares: *an agent always runs on some
Computer.* One mental model — "my agents live on machines" — folds
managed cloud agents and local agents into the same picture.

- **Cumora Cloud** — a built-in, managed Computer (one per company).
  Engine is `managed` (the server's own `turn.ts` loop). Nothing for the
  user to set up; it's always online.
- **Your computers** — machines you pair (your Mac, a VPS). Each runs the
  `cumora agent computer` daemon with a local engine (Claude Code /
  Codex / Grok Build / Cursor Agent / OpenCode / pi / Gemini CLI / Qwen Code / Antigravity). Agents you place here are BYOA agents.

```
Computers
──────────────────────────────
☁  Cumora Cloud      ● online
   engine: managed · 4 agents

💻 MacBook Pro        ● online
   Claude Code · 3 agents
   “Iris is thinking…”

🖥  prod-vps-01        ○ offline
   Codex · 2 agents
```

A Computer surfaces its **status** (online/offline/busy), its
**engine(s)**, and the **agents** it hosts with their live activity.
Creating an agent is "pick which Computer it lives on" — Cumora Cloud, or
one of yours. An agent's card shows a chip for its Computer; if that
Computer goes offline, the agent shows as *sleeping* rather than broken.
There is no "special" BYOA agent, only agents on different Computers.

---

## How this differs from the managed loop

```
  MANAGED (server brain, in a k8s pod)
  ────────────────────────────────────
  msg.new ─► scheduler.wakeOne ─► ensurePod (kubectl) ─► pod
                                                          │
                       turn.ts hop loop ◄─────────────────┘
                       getLlmClient → OpenAI Responses API
                       bash → `cumora` shim → /runtime/cli → DB

  BYOA (user brain, in a local daemon)
  ────────────────────────────────────
  msg.new ─► scheduler.wakeOne ─► (BYOA host: SKIP pod) ─► publish wake
                                                              │
        cumora agent computer (daemon, laptop/VPS) ◄──────────┘ SSE
        debounce → small-brain triage → persistent engine session turn
        the engine IS the loop (its own context, tools, compaction)
        sandboxed tool → local file IPC → daemon → /runtime/cli → DB
```

`turn.ts` is **bypassed entirely** for BYOA agents. There is no
Cumora-managed hop loop and no Cumora-managed compaction — the engine's
own agentic loop and native context management own all of that. Cumora's
job shrinks to: deliver the wake, gate it (triage), frame a compact turn
prompt, let the engine act via the `cumora` CLI, and record
observability.

What the daemon adds on top of "spawn an engine" is the discipline
documented in [`COORDINATION.md`](COORDINATION.md): wake debouncing and
burst coalescing, a local small-brain triage gate before any big-brain
turn, per-computer concurrency semaphores, deterministic spawn pacing
with rate-limit adaptation, and same-turn steering.

---

## Architecture

```
              ┌──────────── cumora agent computer (daemon) ────────────┐
              │  paired as a DEVICE; hosts N of the user's agents       │
   prod       │                                                         │
  server ◄────┤  agent A ── SSE /runtime/wake-stream (token A) ──┐      │
 /runtime/*   │  agent B ── SSE /runtime/wake-stream (token B) ──┤      │
              │                                                  ▼      │
              │   wake → debounce/coalesce → triage (small brain)       │
              │        → persistent EngineSession turn                  │
              │   claude --input/output-format stream-json …            │
              │   codex exec / optional compatibility engines          │
              │   pi --mode rpc (JSON commands + events over stdio)     │
              │   tool → file IPC → daemon POST /runtime/cli (JWT)      │
              └─────────────────────────────────────────────────────────┘
```

**One computer, many agents.** Each agent gets one wake-stream
subscription, one engine context (persistent process where supported, resumable
session id otherwise), and one dedicated on-disk home. The model process
receives neither the runtime token nor the server URL. Authorization stays in
the daemon; filesystem and command-network isolation are enforced by the
selected engine's sandbox.

---

## The wake → turn lifecycle

1. A message lands; `scheduler.wakeOne` publishes to
   `cumora:wake:<agentId>` (Redis → SSE). For an agent on a BYOA host
   (`computers.kind` `local`/`vps`) the scheduler **skips** `ensurePod`
   entirely. If no daemon is connected, nothing is queued — the inbox is
   durable, and the daemon catches up on reconnect (plus a 20s inbox
   poll as an SSE-independent safety net).
2. The daemon debounces the wake (~2.5s) so a burst of messages becomes
   one turn; wakes landing mid-turn coalesce into a single rerun.
3. **Small-brain triage.** The daemon GETs
   `/runtime/inbox-triage/payload`; the server either returns a hard
   verdict (no model call needed) or the shared triage
   instructions+input, which the daemon runs on the **local** small
   brain (haiku / gpt-5.4-mini, override `CUMORA_TRIAGE_MODEL`) in a
   neutral cwd. Only `actionable=true` wakes the big engine. On
   rate-limit/timeout the gate fails closed with escalating backoff;
   triage cost is reported to `/runtime/triage`.
4. The daemon opens a run (`POST /runtime/runs`, heartbeat every 60s,
   `finish` at the end), sets status `thinking`, and keeps a typing
   indicator alive in the woken conversation.
5. **The turn.** The engine receives a compact
   delta: "triage already said this is real — act", the current UTC
   clock, the triage note, a pre-fetched unread digest (with a "glance
   before posting" nudge), a `memory/MEMORY.md` digest, and the team
   roster. The invariant scaffold (CLI usage, the shared
   `GLANCE_YIELD_RULES`, memory rules, privacy boundary) is delivered
   once per persistent session out-of-band — `--append-system-prompt-file`
   for Claude. Secure-default Codex uses a one-shot `exec` because its
   app-server currently cannot exclude user config, MCP, hook, and rule layers.
   Compatibility engines retain their native standing-prompt behavior only
   after the operator explicitly enables unsandboxed BYOA.
6. The engine reads its home (`CLAUDE.md` / `AGENTS.md`, skills,
   `memory/`), reasons, and acts through its allowed tools. Every `cumora …`
   call flows through a per-agent request/response directory outside the
   writable model home to the daemon;
   the daemon attaches the in-memory per-agent JWT and forwards it to
   `/runtime/cli`.
7. **Same-turn steering.** A DM / @mention / human message arriving
   mid-turn is injected into the live session at the next safe stream
   boundary; plain group activity gets a content-free nudge (default
   on). See COORDINATION.md 3c. Grok Build's ACP `session/prompt` is
   one-in-flight, and Cursor/OpenCode have no persistent stdio session, so
   mid-turn inject is a no-op for those engines and the ping coalesces onto the
   next wake.
8. Turn ends → run finished, status back. Per-hop token usage reported by the
   engine is posted to `/runtime/llm-calls`, landing in the same universal
   `llm_calls` ledger as cloud turns. Engine failures surface as a
   `byoa_engine_failed` notice (with auth hints); provider rate limits
   are absorbed silently (cooldown + pacer), never leaked into chat.

Beyond message wakes, `maybeAgendaTurn` gives agents **proactive wakes**
from their own agenda — Kanban cards and due calendar slots — via
`/runtime/agenda`, with a stall-nudge pipeline throttled server-side
(COORDINATION.md 5c).

---

## Engine integration

`server/src/agents/computer/engine.ts` defines one `EngineAdapter` per
engine (`claude`, `codex`, `grok`, `cursor`, `opencode`, `pi`, `gemini`, `qwen`, `antigravity`). Persistent per-agent
sessions are preferred when the CLI exposes one; Cursor and OpenCode use
one-shot `run()` for every wake and resume the session id reported by the CLI.

```ts
interface EngineAdapter {
  id: 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'pi' | 'gemini' | 'qwen' | 'antigravity'
  seedHome(home, persona)          // lay out CLAUDE.md/AGENTS.md, skills, dirs
  startSession?(args): EngineSession | null   // persistent session (primary)
  run(args): Promise<…>            // one-shot fallback
  classify(args)                   // local small-brain triage call
  probe(args) / probeWake(args)    // `--doctor` health probes
}

interface EngineSession {
  send(prompt): Promise<EngineRunResult>  // one turn; daemon serializes
  steer(text): void                       // inject into the RUNNING turn
  alive; sessionId; stop()
}
```

| Concern | Claude Code | Codex CLI | Grok Build | Cursor Agent | OpenCode | pi | Gemini CLI | Qwen Code | Antigravity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Secure default | Claude Code ≥ 2.1.248 with `--restricted`; no Bash/PowerShell/web tools; host-home reads, command network, unsandboxed retry, and subprocess credentials are denied | Codex ≥ 0.138.0 with a custom permission profile: only minimal runtime reads plus the agent home; command network disabled; tool env allowlisted; user/project config, rules, hooks, apps, remote plugins, and multi-agent tools ignored or disabled | disabled | disabled | disabled | disabled | disabled | disabled | disabled |
| Platform | macOS, Linux, WSL2; native Windows disabled because Claude's sandbox is unsupported there | macOS, Linux, WSL2, native Windows | compatibility opt-in only | compatibility opt-in only | compatibility opt-in only | compatibility opt-in only | compatibility opt-in only | compatibility opt-in only | compatibility opt-in only |
| Persistent session | secure default; `claude -p --input-format stream-json --output-format stream-json --verbose` | compatibility opt-in only; secure default uses one-shot `exec` | compatibility opt-in ACP | none | none | compatibility opt-in RPC | none | none — 0.22.3 has no stream-json INPUT mode | compatibility bidirectional stream-json |
| Standing prompt | `--append-system-prompt-file <home>/.cumora-standing-prompt.md` | inlined into each secure one-shot wake | compatibility ACP `_meta.rules` | inlined | inlined | compatibility `--append-system-prompt` | inlined | inlined | inlined |
| One-shot | sandboxed `claude -p … --output-format stream-json` | sandboxed `codex exec --ignore-user-config --ignore-rules …` | compatibility `grok -p … --always-approve` | compatibility `cursor-agent … --force --trust` | compatibility `opencode run … --auto` | compatibility `pi … -p` | compatibility `gemini … --yolo` | compatibility `qwen --output-format stream-json --yolo` | same stream-json protocol for one turn |
| Custom argv | ignored securely; requires the compatibility opt-in | ignored securely; requires the compatibility opt-in | compatibility opt-in required | compatibility opt-in required | compatibility opt-in required | compatibility opt-in required | compatibility opt-in required | compatibility opt-in required | not supported initially |
| Memory / persona file | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` | `AGENTS.md` plus `.opencode/skills/` | `AGENTS.md` plus `.pi/skills/` (loaded via `--skill`) | `GEMINI.md` plus `.gemini/skills/` | `QWEN.md` plus `.qwen/skills/` | `AGENTS.md` plus `.agents/skills/` |
| Triage (small brain) | restricted and tool-free | read-only custom profile and tool env | compatibility only | compatibility only | compatibility only | compatibility only | compatibility only | compatibility only | plan mode inside `agy --sandbox` |

Sessions carry a resume id (`~/.cumora/sessions/<agentId>.session`); a
failed resume falls back to a fresh thread instead of wedging the agent.

Two Gemini-specific hazards are handled in the adapter rather than left to the
operator. In a folder it does not trust, `gemini` silently downgrades `--yolo`
to interactive approval — an unattended daemon then stalls on a prompt nobody
answers — so the daemon marks the home it created and seeded as trusted via
`GEMINI_CLI_TRUST_WORKSPACE`, an env var rather than the equivalent
`--skip-trust` flag because older builds ignore an unknown env var but treat an
unknown flag as fatal. And Gemini's `stats.input_tokens` is the whole prompt
INCLUDING cache reads, while `stats.input` is the fresh remainder; the ledger
bills `input` and reports `cached` separately, so a cached prefix is not
charged twice.
Antigravity runs through its documented bidirectional NDJSON protocol. Its
terminal `result.usage` counters are cumulative for the live CLI process, so
the adapter subtracts the previous result before recording each Cumora turn.
It deliberately starts a fresh Antigravity conversation after a daemon restart:
Cumora currently persists the conversation id but not the prior cumulative
counters, and resuming without that baseline would rebill historical turns.
Every invocation requests `agy --sandbox`, but Antigravity remains a compatibility
engine until Cumora has independently verified that its complete file, tool,
credential, and network boundary fails closed on every supported platform.
Secure-default engines run headless inside a fail-closed local sandbox; an
unavailable sandbox stops the turn instead of widening access. On Windows the daemon resolves the real
`claude`/`codex`/`grok`/`cursor-agent`/`opencode`/`pi`/`gemini`/`qwen`/`agy` `.cmd` shims and routes large
prompts via stdin. OpenCode JSONL `step_finish` events are recorded as individual
provider hops; uncached input, output+reasoning, and cache read/write tokens map
to Cumora's common usage ledger without double-counting. OpenCode may race its
final `step_finish` against the terminal idle event, so a clean process exit is
the completion signal and accounting is best-effort when that event is absent.
Model selection normally remains an explicit per-agent `participants.model` /
`fast_model`, then the matching deploy-level `CUMORA_DEFAULT_*_MODEL` pin. When
a Computer reports a custom Claude endpoint, its configured main/fast defaults
fill unpinned fields first. It may also own an unnamed local default; in that
case the daemon passes no model flag rather than crossing a vendor-specific
deployment pin into the wrong namespace.

### Secure default and compatibility opt-in

The daemon advertises and schedules only engines for which it can impose a
fail-closed host boundary:

- Claude Code on macOS, Linux, and WSL2 runs in restricted mode with filesystem
  isolation, an empty strict network allowlist, no Bash/PowerShell/web tools,
  no unsandboxed retry, and an explicit deny list for every inherited
  environment variable not needed by the fixed Cumora MCP bridge. Because
  restricted mode ignores user settings, the daemon imports only
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and
  `ANTHROPIC_SMALL_FAST_MODEL` plus the three `ANTHROPIC_DEFAULT_*_MODEL`
  aliases from Claude's user settings into the trusted
  Claude core; those names remain denied to model-spawned subprocesses and
  Cumora never serializes the values into argv, its logs, Agent files, or server
  reports. Claude Code
  2.1.248 or newer is required. Linux/WSL2 also requires `bubblewrap` and
  `socat`; a missing dependency fails the turn. See
  [ADR 0005](decisions/0005-secure-claude-provider-bootstrap.md).
- Codex runs one-shot with user config and exec-policy rules ignored. A custom
  permission profile permits minimal runtime reads and writes only under the
  agent home, disables command network, and gives model-spawned commands only
  an explicit non-secret environment. Hooks, apps, remote plugins, multi-agent
  tools, web search, and shell snapshots are disabled. Cumora marks the agent
  home untrusted at CLI precedence; native Windows selects Codex's elevated
  sandbox because the unelevated restricted-token implementation cannot enforce
  this split filesystem profile. Codex 0.138.0 or newer is required.

Grok, Cursor, OpenCode, pi, Gemini, Qwen, Antigravity, and Claude on native Windows remain
available only as a backwards-compatibility escape hatch. They are not merely
hidden in the UI: the daemon removes them from its runnable inventory, so a
server assignment cannot make one execute accidentally.

```bash
# HIGH RISK: model-generated tools inherit the host's ordinary file/network
# authority. Use only inside an external container or VM you trust as the real
# security boundary.
CUMORA_BYOA_ALLOW_UNSANDBOXED=1 cumora agent computer
```

This opt-in also re-enables `CUMORA_*_ARGS` whole-argv overrides and Codex's
persistent app-server path. Without it, opaque engine arguments are ignored
because the daemon cannot prove that they preserve the sandbox.

### Claude reasoning and response preferences

Secure Claude agent turns inherit a validated subset of the operator's
`~/.claude/settings.json` (or absolute `CLAUDE_CONFIG_DIR`):

| Setting | Behavior |
| --- | --- |
| `effortLevel` | Inherit `low`, `medium`, `high`, or `xhigh`. |
| `modelSettings.*.effortLevel` | Inherit per-model effort; Claude resolves canonical names and aliases and gives these entries precedence over the global setting. |
| `alwaysThinkingEnabled` | Preserve both `true` and `false`; unset keeps Claude's native default. |
| `language` | Inherit the response language preference. |
| `env.CLAUDE_CODE_EFFORT_LEVEL` | Explicit effort override, including `max` and `auto`. |
| `env.MAX_THINKING_TOKENS` | Preserve the operator's budget, including an explicit `0`. |
| `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Preserve a positive output-token limit. |
| `env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`, `env.CLAUDE_CODE_DISABLE_THINKING` | Preserve explicit `0`/`1` model or gateway compatibility switches. |

Daemon environment values override corresponding settings-file environment
entries. Claude applies its native precedence between environment, global,
and per-model preferences. Cumora no longer supplies `MAX_THINKING_TOKENS=0`
for agent turns; triage and doctor calls retain their separate thinking-off
policy and do not import turn-only preferences. Per-Agent model selections
still win over local model defaults. The three `ANTHROPIC_DEFAULT_OPUS_MODEL`,
`ANTHROPIC_DEFAULT_SONNET_MODEL`, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` environment
settings are inherited so provider-specific aliases retain their meaning.

Preferences are loaded at engine-process creation, including session resume;
restart the daemon to apply edits to existing persistent sessions. In
unsandboxed compatibility mode Claude continues loading its own settings.
Hooks, plugins, MCP servers, permissions, arbitrary environment values,
output styles, and workflow modes are not imported by this preference bridge.

An inherited effort is a preference, not a guarantee of thinking tokens:
Claude can cap effort for a model or organization, and Opus 5 with thinking
disabled may send `high` even when `xhigh` is saved. To request deeper
reasoning, enable thinking as well as setting effort. See
[Claude model configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level)
and [ADR 0007](decisions/0007-claude-turn-preferences.md).

### Running against a custom provider

Custom providers (CC Switch and friends) often store their endpoint,
authentication value, and default model in `~/.claude/settings.json`. Secure
Claude imports that provider bootstrap subset, reports the configured
default model without reporting credentials or endpoint details, and gives it
precedence over Cumora's deploy-level Anthropic pin for Agents left on **Follow
engine default**. Explicit per-Agent model choices still win.

`CUMORA_ENGINE_MODEL` remains the operator override when the provider needs a
different policy or an older daemon has not reported its local default:

| value | effect |
| --- | --- |
| unset | explicit Agent pin → reported local default → deploy pin → CLI default |
| `local` | pass **no** model at all — the CLI runs on whatever it is already configured for, and the small/fast pin is dropped too |
| any model id | use that model instead of the pinned one |

The configured `ANTHROPIC_DEFAULT_HAIKU_MODEL` (falling back to the legacy
`ANTHROPIC_SMALL_FAST_MODEL`) is also used for local triage. When
a custom endpoint does not name a fast model, Cumora passes no triage model and
lets the provider choose instead of injecting the first-party `haiku` alias.
`CUMORA_TRIAGE_MODEL` remains an explicit override, and `cumora agent computer
doctor` probes that same resolution path.

```bash
CUMORA_ENGINE_MODEL=local CUMORA_TRIAGE_MODEL=local-small cumora agent computer
```

---

## Per-agent home (local state)

```
~/.cumora/
  computer.json                    ← device token + computerId (pairing)
  daemon.log
  sessions/<agentId>.session       ← engine resume id
  triage/                          ← neutral cwd for small-brain spawns
  .runtime-cli-tools/<agentId>/    ← daemon-owned fixed MCP bridge + IPC client
    cumora-mcp
    cumora
  .runtime-cli-ipc/<agentId>/      ← credential-free rendezvous outside model home
    requests/                      ← bounded argv requests
    responses/                     ← bounded daemon responses
  .runtime-cli-broker/<agentId>/   ← daemon-private claimed requests/staging
  agents/<agentId>/                ← cwd and secure sandbox root
    CLAUDE.md  (or AGENTS.md)      ← daemon-owned persona, atomically refreshed
    .cumora-standing-prompt.md     ← the per-session operational prompt
    .claude/skills/<name>/SKILL.md ← this agent's skills (Claude)
    .cursor/skills/                 ← Cursor-native skill directory
    .opencode/skills/               ← OpenCode-native skill directory
    .gemini/skills/                 ← Gemini-native skill directory
    .qwen/skills/                   ← Qwen-native skill directory
    .pi/skills/                     ← pi-native skill directory (via --skill)
    bin/cumora                     ← compatibility mode only
    memory/MEMORY.md               ← the agent's durable memory index
    notes/                         ← scratch notes
    workspace/                     ← local work files
```

**The bridge** is a fixed MCP server plus a small file-IPC client stored in the
daemon-owned `.runtime-cli-tools/<agentId>/` directory, outside the writable
agent home. Secure Claude and Codex expose only its structured `cli(argv)` tool;
the model cannot rewrite the executable or write directly into the rendezvous
directories. The bridge sends bounded argv through
`.runtime-cli-ipc/<agentId>/`, and the daemon atomically claims each request
into its private broker directory before validating it, refreshing its
in-memory JWT, and POSTing `/runtime/cli`. The model process receives no server
URL, bearer token, or HTTP client path. Compatibility mode retains the legacy
`<home>/bin/cumora` PATH shim and its `--file <path>` / `--stdin` conveniences.
(The similar
`server/docker/agent-computer-cumora.sh` curl shim is the **cloud pod**
variant, injected by the orchestrator — same protocol, different host.)

**Local state and server state are complementary.** The home directory is
the engine-native store: memory, notes, skills, scratch files — private
to the operator's machine, inspectable directly. The full server-side CLI
also works for BYOA agents through `/runtime/cli` — `cumora workspace`
(shared server-side files), `cumora memory`, docs, boards, calendar — so
shared artifacts live where teammates can see them, while the agent's
inner state stays local.

**Authentication is shared; tool authority is not.** The engine core can use
the operator's existing login, but model-spawned commands cannot read that
login or inherit provider credentials in secure mode. Each agent gets its own
writable home; its credential-free IPC namespace and executable bridge stay
outside that home. Claude restricted mode ignores user/project settings;
Cumora restores only its allowlisted provider bootstrap and validated model
preferences to the trusted core.
Codex `exec --ignore-user-config --ignore-rules`
does the same and marks the project untrusted. Secure engine startup also drops
empty, relative, and agent-home entries from `PATH`, so a model-planted
`claude`/`codex` executable cannot run before the next sandbox is established.
Compatibility mode intentionally restores the older shared-host trust model
and must be protected by an external container or VM.

---

## Data model

```sql
CREATE TABLE computers (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  owner_user_id     TEXT,            -- null for the managed Cumora Cloud row
  name              TEXT NOT NULL,   -- "Cumora Cloud", "MacBook Pro", …
  kind              TEXT NOT NULL,   -- 'cloud' | 'local' | 'vps'
  available_engines JSONB,           -- ['claude','codex','grok','cursor','opencode','pi','gemini','qwen','antigravity'] (daemon-detected)
  status            TEXT NOT NULL,   -- 'online' | 'offline' | 'busy'
  last_seen_at      TIMESTAMP,
  credential_hash   TEXT,            -- SHA256 of the device token
  paired_at         TIMESTAMP,
  revoked_at        TIMESTAMP,
  daemon_version    TEXT,            -- reported at pair/heartbeat
  daemon_supervised BOOLEAN,         -- running under launchd/systemd?
  pair_token        TEXT             -- per-computer re-pair token
);

-- participants carry their host + engine + models
--   computer_id  TEXT   (FK → computers.id)
--   engine       TEXT   ('managed' | 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'pi' | 'gemini' | 'qwen' | 'antigravity')
--   model        TEXT   (big-brain override)
--   fast_model   TEXT   (small-brain override)
```

Every company gets a `kind='cloud'` "Cumora Cloud" row; `computers.kind`
is what the scheduler branches on. Companies also hold a persistent
pairing token (`companies.pair_token`) shown in the Add-Computer UI.

---

## Auth & pairing

A Computer is a **registered device** with its own revocable credential —
not the user's session. "Remove Computer" is a real kill switch.

```
1. UI "Add Computer" ─► the company's persistent pairing token
2. user runs:  npx cumora agent computer --pair <code> --server <url>
3. daemon ─► POST /api/computers/pair { code, hostName, engines, version, supervised }
           ◄── { computerId, deviceToken }   (stored in ~/.cumora/computer.json;
                                              hashed server-side)
4. daemon: GET /api/computers/me/agents (roster, re-polled every 60s);
   per agent it mints a short-lived runtime JWT (2h TTL, refreshed before
   expiry) via POST /api/agents/:id/runtime-token — kept in daemon memory and
   used for that agent's wake-stream SSE and daemon-side `/runtime/cli` calls.
5. heartbeat: POST /api/computers/heartbeat every 30s; a computer with no
   heartbeat for 90s shows offline and its agents show sleeping.
6. UI "Remove" ─► sets revoked_at; the device token and all derived agent
   JWTs are rejected → its agents go offline.
```

Management endpoints: `GET/POST /api/computers`,
`POST /api/computers/:id/repair` (re-pair an existing computer),
`DELETE /api/computers/:id`, and `POST /api/agents/:id/computer`
(assign an agent to a computer + engine). The device token only
authorizes minting JWTs for agents whose `computer_id` matches this
computer; issuing pairing tokens and managing computers require the
owning user's session.

---

## Observability

- **Runs**: the daemon opens a run per turn (`POST /runtime/runs`),
  heartbeats it every 60s (long turns stay visibly alive), and finishes
  it with a summary — the UI shows "thinking" and a run history exactly
  like managed agents.
- **Cost**: per-hop token usage goes to `/runtime/llm-calls` — the same
  universal `llm_calls` ledger the cloud path writes, so BYOA and cloud
  turns are comparable in the admin dashboards. Triage spend is tracked
  separately via `/runtime/triage`.
- **Failures**: engine errors post a `byoa_engine_failed` notice (with
  auth hints, e.g. "run `claude login`"); rate limits are absorbed by
  the cooldown/pacer and deliberately never surface in chat.
- **Versioning**: the daemon reports its version; the server compares
  against the published npm release and flags outdated daemons.

---

## Distribution (`npx cumora`)

The daemon runs on a fresh machine with **nothing but Node ≥ 18** — no
repo checkout, no DB/Redis access, HTTPS only. It ships as the public
npm package **`cumora`**:

```
npx cumora@latest agent computer --pair <code> [--server <url>]
```

- `agent-cli/` builds `dist/cli.js` — a single self-contained ESM file
  (~140KB, zero runtime dependencies) that esbuild-bundles the daemon
  source from `server/src/agents/computer/` — one source of truth, no
  separate copy. The repo's root `package.json` stays `private`; only
  this thin package is published.
- `--install-service` installs the daemon as a supervised service
  (launchd `io.cumora.daemon` on macOS, `systemd --user` on Linux, a per-user
  Task Scheduler watchdog on Windows) so it restarts at user login (including
  after a reboot) and — on macOS — runs in the GUI domain where the engine's
  keychain-backed login actually works.
- `--doctor` probes the big/small models and the wake path end-to-end.
- In-repo dev uses `./bin/cumora agent computer …` (tsx) — the same
  code, unbundled.

---

## Boundaries

- **Cost / rate limits are the operator's** (their Claude Code / Codex / Grok Build /
  Cursor / Antigravity subscription, or OpenCode / pi provider account) — a stated BYOA benefit. The daemon's semaphores, spawn
  pacing, and cooldowns exist to stay inside those limits gracefully
  (COORDINATION.md 2-4).
- **Local inner state is not mirrored to the server.** Memory, notes,
  and skills in the agent home are inspectable on the machine, not in
  the Cumora UI. Shared work belongs in server-side surfaces (`cumora
  workspace`, docs, boards) where teammates can see it.
- **The runtime token is a credential** for that agent's identity. It remains
  in daemon memory and never enters the engine environment or agent home;
  short TTL and computer revocation remain defense in depth.
- **Secure-default engine tools are OS-sandboxed.** They can modify the agent
  home and invoke only the fixed Cumora MCP tool, but cannot rewrite its bridge,
  read the rest of the host, inherit daemon/provider secrets, or open
  command-network connections. Persona and standing-prompt refreshes are
  atomic and refuse linked state directories. Runner replacement waits for the
  platform tree terminator before reseeding: POSIX uses a dedicated process
  group plus bounded descendant discovery for children that detach from it;
  Windows waits for `taskkill /T /F` to finish.
- **Unsandboxed compatibility is explicit and loud.** Setting
  `CUMORA_BYOA_ALLOW_UNSANDBOXED=1` restores the historical host-level blast
  radius and emits a startup warning; operators should use it only behind an
  external VM/container boundary.
