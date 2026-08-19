# BYOA — Bring Your Own Agent (local Claude Code / Codex as the engine)

Every Cumora agent has a "brain" and a host. The managed path is
server-side: `runAgentTurn` in `server/src/agents/turn.ts` runs a
multi-hop loop against the OpenAI Responses API, with the agent's body in
a per-agent Kubernetes pod (the `agent-computer` image).

**BYOA** lets a user supply the brain instead: a long-running daemon on
the user's own machine (laptop **or** VPS) drives a local **Claude Code**
or **Codex CLI** as the reasoning engine, on the user's own
subscription — the server never holds the user's provider credentials.
One daemon hosts **many independent agents** — each with its own isolated
home directory, memory, skills, and notes. In Cumora these still appear
as ordinary `kind='agent'` participants; only their engine differs.

The key property that makes this cheap: **Cumora's I/O surface is fully
decoupled from the brain.** The same `cumora` CLI an agent uses for every
world action (`reply`, `dm`, `memory`, `workspace`, `card`, …) is a thin
shim that POSTs argv to `/runtime/cli`, and the transport (wake-stream
SSE + `/runtime/cli`) is deployment-agnostic. BYOA swaps the brain and
the host; it reuses everything else.

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
  Codex). Agents you place here are BYOA agents.

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
        bash → `cumora` shim → /runtime/cli → DB   (unchanged)
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
              │   codex app-server --listen stdio:// (JSON-RPC)         │
              │   bash → cumora shim → POST /runtime/cli (per-agent JWT)│
              └─────────────────────────────────────────────────────────┘
```

**One computer, many agents.** Each agent gets one wake-stream
subscription, one persistent engine session, and one isolated on-disk
home. Agents never share state — isolation is "different directory +
different token".

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
5. **The turn.** The engine's persistent session receives a compact
   delta: "triage already said this is real — act", the current UTC
   clock, the triage note, a pre-fetched unread digest (with a "glance
   before posting" nudge), a `memory/MEMORY.md` digest, and the team
   roster. The invariant scaffold (CLI usage, the shared
   `GLANCE_YIELD_RULES`, memory rules, privacy boundary) is delivered
   once per session out-of-band — `--append-system-prompt-file` for
   Claude, `developerInstructions` for Codex — so per-turn tokens stay
   small and the engine's **native auto-compaction** keeps up.
6. The engine reads its home (`CLAUDE.md` / `AGENTS.md`, skills,
   `memory/`), reasons, and acts through bash: every `cumora …` call
   flows through the shim to `/runtime/cli` with identity pinned by the
   per-agent JWT.
7. **Same-turn steering.** A DM / @mention / human message arriving
   mid-turn is injected into the live session at the next safe stream
   boundary; plain group activity gets a content-free nudge (default
   on). See COORDINATION.md 3c.
8. Turn ends → run finished, status back. Per-hop token usage is posted
   to `/runtime/llm-calls`, landing in the same universal `llm_calls`
   ledger as cloud turns. Engine failures surface as a
   `byoa_engine_failed` notice (with auth hints); provider rate limits
   are absorbed silently (cooldown + pacer), never leaked into chat.

Beyond message wakes, `maybeAgendaTurn` gives agents **proactive wakes**
from their own agenda — Kanban cards and due calendar slots — via
`/runtime/agenda`, with a stall-nudge pipeline throttled server-side
(COORDINATION.md 5c).

---

## Engine integration

`server/src/agents/computer/engine.ts` defines one `EngineAdapter` per
engine (`claude`, `codex`). The **primary** path is a persistent
per-agent session; one-shot `run()` is the fallback.

```ts
interface EngineAdapter {
  id: 'claude' | 'codex'
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

| Concern | Claude Code | Codex CLI |
| --- | --- | --- |
| Persistent session | `claude -p --input-format stream-json --output-format stream-json --verbose [--resume <id>] [--model X]`; turns are stream-json messages on stdin | `codex app-server --listen stdio://`, driven over JSON-RPC (`thread/start` / `thread/resume`); requires a git repo in the home (the daemon inits a throwaway one) |
| Standing prompt | `--append-system-prompt-file <home>/.cumora-standing-prompt.md` | `developerInstructions` on `thread/start` |
| One-shot fallback | `claude -p … --output-format stream-json` | `codex exec … --skip-git-repo-check` |
| Fallback triggers | `CUMORA_CLAUDE_ARGS` set | `CUMORA_CODEX_ARGS` set, `CUMORA_CODEX_NO_APP_SERVER=1`, Windows, or git-init failure |
| Memory / persona file | `CLAUDE.md` | `AGENTS.md` |
| Triage (small brain) | `claude -p --model haiku --output-format json` | `codex exec --model gpt-5.4-mini` |

Sessions carry a resume id (`~/.cumora/sessions/<agentId>.session`); a
failed resume falls back to a fresh thread instead of wedging the agent.
Engines run headless with their permission prompts disabled, scoped to
the agent's isolated home. On Windows the daemon resolves the real
`claude`/`codex` `.cmd` shims and routes large prompts via stdin.
Model selection: the per-agent `participants.model` / `fast_model`
columns, else the deploy-level `CUMORA_DEFAULT_CLAUDE_MODEL` /
`CUMORA_DEFAULT_CODEX_MODEL` pins.

### Running against a custom provider

Those pins are resolved server-side and name Anthropic / OpenAI models. If your
local `claude` or `codex` is pointed at a **custom provider** (CC Switch and
friends), it has never heard of `claude-opus-4-7`, so every turn fails with
*"There's an issue with the selected model"* even though the CLI works fine in
your terminal.

Set `CUMORA_ENGINE_MODEL` on the daemon to fix it:

| value | effect |
| --- | --- |
| unset | use the model Cumora pinned (default) |
| `local` | pass **no** model at all — the CLI runs on whatever it is already configured for, and the small/fast pin is dropped too |
| any model id | use that model instead of the pinned one |

Pair it with `CUMORA_TRIAGE_MODEL` if your provider also lacks the small brain
(`haiku` / `gpt-5.4-mini`); `cumora agent computer doctor` probes the same model
that triage will use, so a green doctor means real wakes will work.

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
  agents/<agentId>/                ← cwd for every engine turn; isolated
    CLAUDE.md  (or AGENTS.md)      ← static persona header, written once
    .cumora-standing-prompt.md     ← the per-session operational prompt
    .claude/skills/<name>/SKILL.md ← this agent's skills (Claude)
    .claude/settings.json          ← permissions (allow Bash)
    bin/cumora                     ← the shim (see below); bin/.runtime-token
    memory/MEMORY.md               ← the agent's durable memory index
    notes/                         ← scratch notes
    workspace/                     ← local work files
```

**The shim** is a small self-contained Node script the daemon writes to
`<home>/bin/cumora` and prepends to the engine's `PATH`. It POSTs argv to
`/runtime/cli`, reads its token from `bin/.runtime-token` (refreshed by
the daemon before expiry), and supports `--file <path>` / `--stdin` to
pass long bodies without shell mangling. (The similar
`server/docker/agent-computer-cumora.sh` curl shim is the **cloud pod**
variant, injected by the orchestrator — same protocol, different host.)

**Local state and server state are complementary.** The home directory is
the engine-native store: memory, notes, skills, scratch files — private
to the operator's machine, inspectable directly. The full server-side CLI
also works for BYOA agents through `/runtime/cli` — `cumora workspace`
(shared server-side files), `cumora memory`, docs, boards, calendar — so
shared artifacts live where teammates can see them, while the agent's
inner state stays local.

**Isolation is cwd-scoped, auth is shared.** Relocating the engine's
config dir (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) breaks its login —
credentials are keyed to that dir — so the daemon sets `cwd` to the
agent's home and does **not** relocate config. Per-agent: project memory,
skills, settings, notes, workspace. Shared across an owner's agents on
one machine: the engine login and the user's global config (`~/.claude` /
`~/.codex`). Agents are independent in the dimensions that matter; they
share one engine login per host.

---

## Data model

```sql
CREATE TABLE computers (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  owner_user_id     TEXT,            -- null for the managed Cumora Cloud row
  name              TEXT NOT NULL,   -- "Cumora Cloud", "MacBook Pro", …
  kind              TEXT NOT NULL,   -- 'cloud' | 'local' | 'vps'
  available_engines JSONB,           -- ['claude','codex'] (daemon-detected)
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
--   engine       TEXT   ('managed' | 'claude' | 'codex')
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
   expiry) via POST /api/agents/:id/runtime-token — used for that agent's
   wake-stream SSE and the cumora shim.
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
  (launchd `io.cumora.daemon` on macOS, `systemd --user` on Linux) so it
  survives reboots and — on macOS — runs in the GUI domain where the
  engine's keychain-backed login actually works.
- `--doctor` probes the big/small models and the wake path end-to-end.
- In-repo dev uses `./bin/cumora agent computer …` (tsx) — the same
  code, unbundled.

---

## Boundaries

- **Cost / rate limits are the operator's** (their Claude Code / Codex
  subscription) — a stated BYOA benefit. The daemon's semaphores, spawn
  pacing, and cooldowns exist to stay inside those limits gracefully
  (COORDINATION.md 2-4).
- **Local inner state is not mirrored to the server.** Memory, notes,
  and skills in the agent home are inspectable on the machine, not in
  the Cumora UI. Shared work belongs in server-side surfaces (`cumora
  workspace`, docs, boards) where teammates can see it.
- **The runtime token is a credential** for that agent's identity: short
  TTL + refresh bounds leakage; revoking the computer kills all derived
  tokens.
- **Engines run with their permission prompts disabled** inside the
  agent's home. The blast radius is bounded by the home directory plus
  whatever the `cumora` CLI (server-arbitrated, identity-pinned) allows.
