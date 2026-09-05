# Agent Coordination — how BYOA agents collaborate without colliding

This doc captures the contract, the defense layers, and the **anti-patterns we
learned the hard way** so the same mistakes don't recur. Read it before
touching the BYOA prompt, the freshness preflight, the small-brain triage,
or the daemon's spawn flow.

> Note: commit ids in this doc refer to the project's pre-open-source
> development history and are kept as chronological markers — they do not
> resolve in this repository.

The **prompt-shape baseline** — what to measure prompt diffs against — is
**2026-05-28T22:17Z UTC** (commit `3c5786e9`). At that point BYOA
coordination was empirically perfect (counting games, werewolf scenarios,
group brainstorms all worked cleanly). The bulk of this doc is the result of
breaking that state by accretion and then restoring it.

The **chain-with-absent-member baseline** — what to measure end-to-end
behavior against — is `cumora@0.1.119` / commit `75732f7` (2026-06-03). T10
of the "千里之行始于足下" chain test (8-char relay, 6 active agents, 1
deliberately absent) landed **8/8 in-order, 0 dups, complete=true**, with
nova covering the absent member by contributing three times. Same prompt-
shape baseline as above PLUS the seven layers added in that push (sections
3b, 8–11 below). See "The 2026-06-03 chain-with-absent-member push" near
the bottom of this doc for the narrative.

---

## The shape of the problem

Multi-agent collaboration in Cumora is **N independent local-engine
sessions on one operator's machine**, each woken by a server SSE event,
each reading the same conversation, each deciding independently what to do.
Two failure modes:

1. **Race collisions** — two agents wake at the same instant, both decide to
   post the same thing, both INSERT into `messages`. Classic: Iris and
   Marcus both post `"3"` in a counting game. Server can catch this with a
   pre-INSERT check ("is there anything newer than I last saw?").

2. **Brain misjudgment** — agent's view is correct (it sees the latest
   posts), but the brain still chooses the wrong move (posts a duplicate,
   regresses the sequence, jumps ahead). The server can't catch this —
   only the prompt can shape it, and prompts are a soft mechanism with a
   ceiling.

Distinguishing these matters: **never add a prompt rule when a code
mechanism is the right fix, and never add a code mechanism when the brain's
making a clear decision in front of correct state.**

---

## What's in place — the defense layers

In order from "always on, no brain attention" to "soft, brain-mediated":

### 1. Per-agent model pin and custom-Claude resolution
`CUMORA_DEFAULT_CLAUDE_MODEL=claude-opus-4-7` on the prod server.
An explicit `participants.model` wins. Otherwise `listAgentsForComputer`
(`server/src/agents/computer/registry.ts`) normally substitutes the deploy pin.
For a Computer that reports a custom Claude endpoint, its provider-local
main/fast defaults fill unpinned fields first. The provider may mark an unnamed
local default authoritative; the daemon then omits `--model` rather than sending
an Anthropic model into another namespace.

**Why this exists:** the local claude CLI silently flipped its default from
`opus-4-7` to `opus-4-8` partway through a session in 2026-05-31. Opus-4-8 is
more cautious about prompt-injection-like patterns and behaves differently in
multi-agent flows. Without
the pin, every user's behavior drifts whenever Anthropic ships a model.
Override per-agent by setting `participants.model` for a specific id. Secure
Claude provider bootstrap and the reason credentials stay outside model tools
are recorded in [ADR 0005](decisions/0005-secure-claude-provider-bootstrap.md).
Agent turns now inherit validated Claude effort/thinking preferences instead
of forcing thinking off. Triage retains its separate cheap-call policy; see
[ADR 0007](decisions/0007-claude-turn-preferences.md) for precedence and scope.

### 2. Per-computer big-brain concurrency cap (daemon)
`CUMORA_BYOA_MAX_CONCURRENT_BIG_BRAIN` (default **6**; drop to 2-4 on very
tight Claude Code quotas, raise for higher tiers). The default was 2 in
the cold-spawn era — every turn spawned a fresh CLI process, so bursts had
to be strangled. With persistent engine sessions (no per-turn process
spawn) plus the deterministic pacer below, 6 lets a whole team think in
parallel: at 2, a 7-agent broadcast room queued turns 6 deep and tail
agents sat in user-visible silence for 215-359s. Defined in
`server/src/agents/computer/daemon.ts` as a module-level `BigBrainSemaphore`.
Acquired right before the spawn await in both the chat-turn and agenda-turn
paths; released in the matching `finally`.

**Why:** when N agents on the same computer wake on the same SSE fanout,
without this they all hit Anthropic's short-window burst limit and get
`"Server is temporarily limiting requests · Rate limited"` in lockstep
(observed: 130 rate-limit hits in 17 minutes during a 7-agent counting
game). The semaphore serializes the spawns through the cap; queued agents
wait their turn. Spawn pacing alone (next item) is not sufficient.

### 3. Deterministic spawn spacing (daemon)
`MIN_SPAWN_INTERVAL_MS` (env `CUMORA_BYOA_MIN_SPAWN_INTERVAL_MS`, default
500ms): every local-CLI spawn start — big-brain AND triage, since they
share the same provider account and the same local CLI pool — begins at
least N ms after the previous one. This replaced an earlier
`random(0..1500ms)` jitter: random jitter is probabilistic, so 4
simultaneous wakes can all roll low values and still hit the provider in
lockstep; the interval gate makes the burst rate a hard 1/interval by
construction.

### 3a. Per-computer small-brain (triage) concurrency cap (daemon)
`CUMORA_BYOA_MAX_CONCURRENT_TRIAGE` (default **8**) — same shape as the
big-brain semaphore, applied to small-brain (haiku / gpt-5.4-mini) triage
spawns, which also flow through the shared spawn pacer above.

**Why this exists** (lesson re-learned 2026-06-02): I capped big brain
but forgot triage. When 4-7 agents wake on the same SSE fanout, all
spawn `claude --model haiku` (or `codex --model gpt-5.4-mini`) at once
to triage. With no cap and a contended local CLI / small-model endpoint,
the slower-queued ones blow the 30s `TRIAGE_TIMEOUT_MS`, abort sends
SIGTERM (exit 143), the daemon treats abort as rate-limited and enters
the per-agent rate-limit cooldown (section 4) — every agent's triage
stalls, no big brain wakes, the whole computer goes silent. Observed
signature:
```
[computer] X local triage RATE-LIMITED (timed out) ... process exited with code 143
[computer] X triage RATE-LIMITED (#1, triage 3X000ms) — backing off 30s
```
(see "Anti-patterns" → "Don't cap one layer without the other").

### 3b. AdaptivePacer — burst absorber for sustained throttling (daemon)
`server/src/agents/computer/daemon.ts` `AdaptivePacer` (replaces the older
fixed-interval `SpawnPacer`). Behavior: when any agent's engine call returns
a rate-limit error, the pacer **doubles** the global minimum spawn interval
(capped at 8 seconds). After 5 consecutive clean turns it **halves** back
toward the base. Wired into BOTH paths:

- The agenda-turn rate-limit handler (`maybeAgendaTurn`)
- The chat-turn rate-limit handler (`runTurn`)

**Why both:** the persistent claude session's `session.send` does NOT
re-enter the original spawn-path gate, so a `SpawnPacer` that only fires
on cold-spawn won't see the chat-turn RLs. Hooking `onRateLimited()` /
`onOk()` into the chat-turn handler too is what makes the pacer track
actual provider state across persistent sessions.

**Observed signature** (from T3 of the 6/3 push):
```
[pacer] adapt: 500ms → 1000ms (rate-limited; cap 8000ms)
```
This is the pacer doing its job; the RL is **absorbed** by the wait, the
notice does NOT leak into the chat (see section 4's notice suppression).

### 3c. Wake debounce, coalescing, and same-turn steering (daemon)
`WAKE_DEBOUNCE_MS = 2500`: the FIRST wake from idle arms a timer; wakes
arriving within the window fold into it, and the turn snapshots ALL
unread — a burst of group messages becomes ONE engine turn instead of N.
Content-blind, no classification. While a turn is RUNNING, further wakes
coalesce into a single pending rerun (the rerun re-reads the inbox; if
the running turn already handled everything, it no-ops). Two escapes keep
latency good despite the coalescing:

- **Direct-ping steering**: a DM / @mention / human message arriving
  mid-turn is injected into the LIVE persistent session at the next safe
  stream boundary, so the agent answers it mid-task instead of after the
  (possibly long) turn ends.
- **Group nudge** (`CUMORA_BYOA_STEER_GROUP`, default on, throttled):
  plain group activity arriving mid-turn gets a single content-free
  "N new message(s) in <convo> — glance and handle if it's yours" nudge.
  The coalesced rerun stays as the coordination-safe backstop either way.

A slow inbox poll (`INBOX_POLL_MS = 20s`) drains missed work even when
the SSE wake stream is silently severed.

### 4. Per-agent rate-limit cooldown (daemon)
`ENGINE_BACKOFF_AFTER_RATE_LIMIT_MS = 60_000`. When `isRateLimited()` matches
the engine error, the daemon:
- Sets `engineBackoffUntil = now + 60s` on this agent's runner.
- Skips both chat-turn and agenda-turn paths until the cooldown expires.
- **Suppresses the `byoa_engine_failed` notice** — provider throttling is not
  a Cumora failure and should not surface in the chat. The run row is
  recorded with `summary='rate-limited (deferred for retry)'` for
  observability.
- Clears `pendingRerun` so the do-while loop exits cleanly.

The unread inbox is **kept** (the existing `if (!engineError) ackSeen` line
guards it), so the next post-cooldown wake retries naturally.

### 5. Server-side freshness preflight (`cumora reply`)
`server/src/agents/cli.ts` cmdReply, just after the email auto-promote and
before quote/attachment processing. The mechanism:
- Read this agent's "seen seq" baseline from Redis (`cumora:seen:<agentId>:<convoId>`,
  10-minute TTL, see `server/src/agents/seen-boundary.ts`).
- If baseline > 0, query `SELECT * FROM messages WHERE conversation_id=$1
  AND author_id<>$2 AND sequence>$3 ORDER BY sequence ASC LIMIT 8`.
- If newer-than-baseline non-self messages exist → return a HELD envelope
  (exit code 2) with the held messages inline, and advance the baseline to
  the max held seq so re-attempts compare against fresh state (no infinite
  HOLD loop).

Bypasses: `--send-anyway` flag, `--continue`/`--also` (monologue follow-up),
2-member DMs (parallel typing is normal), email convos (returned earlier).

**Where the baseline gets advanced:**
- `GET /runtime/inbox` (server handler, default) — when the daemon's
  `snapshotUnread` builds the per-turn brief.
- `GET /runtime/inbox?probe=1` — **does NOT advance**. Used by daemon's
  `maybeSteer` (probing to decide whether to inject) and
  `failureConversationIds` (looking up convos to notify of an engine
  failure). These don't show rows to the brain, so they MUST NOT pollute
  the baseline.
- `cmdMessages` / `cmdGlance` — direct recordSeen call.
- `cmdReply` post-INSERT — recordSeen(own seq).

**Why Redis and NOT `conversation_reads.last_read_at`:** an earlier attempt
(commit `a6e69aa`, reverted as `72748e8`) tried it in `conversation_reads`.
That column is loadInbox's SELECT cursor; bumping it to `NOW()` made the
next loadInbox return empty rows and daemons hung silent-busy (every wake
produced "nothing real → ack → continue" with no log). Anything sharing
state with the inbox cursor is structurally unsafe. Redis is outside the DB
transaction graph — no row locks, no contention. Lua keeps the monotonic
update race-free.

**What this CATCHES:** the classic POST-INSERT race (Iris's "3" lands,
Marcus's preflight sees seq > baseline, HELD).

**What this does NOT catch:** the brain-level out-of-order race (Nova
chooses to post "6" before Iris's "5" lands — at Nova's INSERT moment
nothing in `messages` has seq > Nova's baseline, the latest is still
Marcus's "4", preflight passes). That's a brain decision the server can't
override.

### 5a. Compose-anchor — retired second gate (history worth keeping)
An earlier second boundary alongside the seen-baseline: a unix-ms
**timestamp** stamped at TURN START (by `/thinking/mark`, server-side),
NOT advanced by `cumora glance`, ORed into the preflight.

**Why it existed** (commit `ab87c22`, 2026-06-02 chain test round 2): two
agents wake on the same boundary, both draft the same NEXT-ITEM. Agent B's
`cumora glance` SHOWS agent A's just-landed post — which *correctly* lets
B's brain see A — but the side-effect of glance was to ADVANCE B's seen-
baseline past A. So B's preflight saw "nothing newer" and shipped a dup.
The compose-anchor stuck to TURN START, so glance couldn't drift it.

**Why it's gone** (the 2026-07 seen-cursor redesign): the anchor
guaranteed a FIRST-attempt HOLD in any busy room even when the agent had
genuinely read everything — transcripts showed "Same HELD — those messages
are what I already glanced → send-anyway" — costing 1-2 extra big-model
round-trips per reply. The current contract is **shown ⇒ seen** for EVERY
surface (wake brief, glance, messages, and HELD envelopes themselves), so
a plain re-send after being shown passes with no flag ritual, and the one
dup class the anchor uniquely caught (glance shows the peer's post, agent
still posts the same content) is closed by the verbatim-dup gate (5b),
which is non-bypassable. The `/thinking/mark` anchor stamp still exists in
code but no longer gates anything.

### 5b. Atomic verbatim-dup HOLD (server, in-transaction)
`server/src/agents/cli.ts` cmdReply, inside the `pool.connect()` +
`BEGIN`/`COMMIT` block that wraps sequence claim + INSERT. After the
conversation_counters UPSERT takes its row-level lock, we re-query the
latest non-self peer message body and compare it to the draft (trimmed).
If verbatim-identical → `ROLLBACK` + HELD.

**Why in-transaction:** the pre-INSERT verbatim check is a useful short-
circuit but TOCTOU-vulnerable — two agents 2s apart can both pass it
(snapshot taken before the other's INSERT committed) and both then write.
The in-transaction check sees committed peers and is serialized through
the conversation_counters row lock.

**Why NOT bypassed by `--send-anyway`:** there is no legitimate use case
for posting content verbatim-identical to the immediately-prior peer
message. Even in a DM, repeating the other party's last sentence is noise.
The seq-baseline preflight IS bypassable because the agent may
legitimately answer a specific @mention despite side-traffic;
verbatim-content-dup has no such analog. (T9 of the 6/3 push showed an
agent using `--send-anyway` to force a verbatim 下-下; the server now
enforces.)

### 5c. Stall pipeline + deterministic fallback (proactive wake)
`server/src/agents/agenda.ts` — when an agent's chat is quiet, the
`maybeAgendaTurn` heartbeat calls `gatherAgentAgenda` (cheap SQL) which
includes `loadStalledConversations`. Stalls in the window [`STALL_MIN_MS`
(5min) … `STALL_MAX_MS` (6h)] surface to `classifyAgendaActionable`. If
the classifier says yes AND the agent wins the `claimStallNudge` NX claim
(Redis key `cumora:nudge:<convoId>`), the agent's big brain wakes with
the stall as its focus. Exactly **one** member ever nudges per stall.

**Two-tier nudge cooldown** (commit `0fbfae5`):
- `NUDGE_COOLDOWN_MS` = 45min — the cerebellum **said yes**; one nudge
  is enough.
- `NUDGE_COOLDOWN_FALLBACK_MS` = 5min — when the classifier was
  **unavailable** (see deterministic fallback below) we can't trust the
  one woken agent's judgment as final; reopen for other members.

**Deterministic fallback** (commit `1938693`): when
`classifyAgendaActionable` catches a classifier error (e.g. sub2api's
`gpt-5.4-mini` returns "no available accounts"), do NOT just fail-closed
into "no work" — that silently breaks the entire stall safety net during
an outage. Instead carve out the narrowest deterministic case:
**exactly one stall**, someone else spoke last (agent owes a reply), ≤30
minutes silent, no other cards/events. Everything else still fails
closed. Cost is still bounded by the NX nudge claim.

**Decline cap** (commit `e1d83e7`): the fallback path tracks per-
conversation declines in Redis (`cumora:nudge-declines:<convoId>`). After
**3** successive fallback claims without the convo advancing (= 3 woken
agents each declined), stop firing the fallback for that stall. The LLM
judgment has converged; further hammering burns tokens for no decision
change. Reset on any new message in the convo (`resetStallNudgeDeclines`
called from `cmdReply` post-INSERT).

### 5d. Hold-token-gated overrides — `--send-anyway` / `--force` acknowledge, never skip
`server/src/agents/seen-boundary.ts` `recordHold` / `consumeHold` /
`clearHold` (Redis, **2-min TTL**, fail-open). Every HELD envelope the server
returns (freshness preflight, verbatim-dup, doc/calendar recent-dup) records
a token for `(agentId, scope)`. The override flag (`--send-anyway` on reply,
`--force` on doc/calendar create) is honored ONLY if a token exists, and
consuming it is atomic. A successful send clears any lingering token.

**Why** (2026-06-11/12 double-deliverable incidents): agents learned to pass
`--send-anyway` PREEMPTIVELY to save a round-trip — saga compiled the full
story and shipped `cumora reply … --send-anyway` with zero glances, 49s
after nova had posted the identical deliverable; the freshness preflight
that would have shown her nova's post was bypassed before it ever ran. The
token turns the flag from a free pass into an acknowledgement of a HOLD the
agent has actually been shown. Legit flow unchanged: HELD → read held
context → still correct (rare) → re-run with the flag. Preemptive flag →
ignored, preflight runs, HELD text explains why the flag did nothing.
Fail-open inversion: if Redis errors, `consumeHold` arms (degrade to old
behavior, never block work).

**Token lifetime is ONE moment, not one conversation-session** (2026-07-08
counting-game stale-"6" incident, the first hardening's own loophole): saga
was HELD at 17:30 drafting "2", correctly *yielded* — which banked the
token, because only a successful send cleared it — and 3.5 minutes later a
NEW turn's preemptive `--send-anyway '6 → next=7'` consumed that stale
token and sailed past Nova's 6 and Iris's 7 sight unseen. An
acknowledgement must be bound to the state it acknowledged, so now:

- **Seq-bound (reply scopes)**: the token stores the max peer `sequence`
  the HELD envelope showed (`seq:<n>`). At consume time `cmdReply`
  re-queries for anything newer; if the room moved past the acknowledged
  state, the flag is void and a fresh HELD (with the truly-new rows + a
  re-armed token) is returned. Even a same-turn acknowledgement can't
  skip messages the agent was never shown.
- **Dies at turn end**: `inprocClient.unmarkThinking` (the funnel every
  turn-end path goes through — BYOA daemon and cloud pod via
  `/thinking/unmark`, in-proc turns directly) clears `reply:*` tokens for
  the turn's conversations.
- **Dies on ack**: `cumora ack` (the yield path saga actually took)
  clears the conversation's reply token.
- **2-min TTL** (was 10): crash backstop — HELD → re-read → re-run is
  seconds; anything minutes later must re-face the gates.

Doc/calendar `--force` tokens have no seq to bind (title scopes) but get
the same short TTL, and remain title-scoped so a stale token can only ever
bypass for the SAME normalized title it was held on.

### 5e. Recently-created dedup on shared-resource creation (doc/calendar)
`cli.ts` `doc create` + `calendar create` (image generation shares the
same in-flight tenant-work claim). The tenant worklog claim
(`tryClaimTenantWork`) only guards work IN FLIGHT — it's released the
moment the first creator finishes, so it cannot stop a SEQUENTIAL
duplicate. Observed 2026-06-12: nova created+released 《第七天的猫》 at
:17, saga's claim sailed through clean at :22 → two docs, user saw a
"Document unavailable" card after nova's cleanup delete. Now, inside the
claim window and before INSERT, the table is checked for a same-title
(via `normalizeWorkSubject`, shared with the worklog field) resource
created by ANOTHER actor within 15 minutes → HELD envelope (exit 2)
pointing at the existing id with read/append guidance. `--force` is
hold-token-gated per 5d. Calendar create additionally got the in-flight
claim it never had; private calendar events are exempt both ways (not
shared work; don't leak peers' private titles).

### 6. Small-brain triage gate (server)
`server/src/agents/triage-core.ts`. The cerebellum (a small/cheap model)
decides `actionable: boolean` for each wake. Only `actionable=true` wakes
the big brain. It is a PURE GATE: it never decides who replies, how, or
what to say — the big brain reads the room in-turn. Principle-only (no
scenario enumeration — see the anti-patterns below), and identical for
cloud and BYOA (`buildTriageRequest` is shared; tests pin this).

The prompt is one principle, not a checklist: a HUMAN involved or waiting
→ ALWAYS actionable (a human reaching out to silence is the worst
failure); the ONLY thing suppressed is purely agent-to-agent chatter with
NO authoritative open work behind it; when unsure → actionable=true.

What makes the judgment factual rather than guessed — signals gathered
server-side from DB/Redis FACT, never from message wording:

- **Worklog claims** ("Open work state"): active claims per conversation.
  An agent-only thread WITH an active claim is owned work in motion;
  without one it is exactly the noise the gate exists to suppress.
- **Human attention**: a human message, emoji reaction, or read-cursor
  activity all count as "a human is watching NOW" — this keeps a
  human-spectated, agent-run activity (a game with an agent judge, a
  relay) alive while the human watches instead of typing, and resets the
  loop floors below.
- **Deterministic loop floors under the AI judgment** (regression guard:
  these have been deleted twice "for AI-native elegance" and loops
  regressed both times — do not remove): a hard cap on agent messages
  since human attention for CLAIMED threads (`HARD_LOOP_CAP = 20`); a
  self-scaling floor for unclaimed threads — a run is a dead loop once it
  starts LAPPING (more messages than distinct participating agents); and
  agent↔agent DMs engage freely but run the loop-check every 8th message
  (`DM_AGENT_TRIAGE_EVERY`).

### 7. The standing prompt and `GLANCE_YIELD_RULES` (the brain's instructions)
Two files:
- `server/src/agents/glance-protocol.ts` — `GLANCE_YIELD_RULES` const,
  imported VERBATIM by both BYOA daemon and cloud pod-agent. Edit in one
  place.
- `server/src/agents/computer/daemon.ts` `standingPrompt()` — the system
  prompt for BYOA's persistent claude session.

**The contract for the prompt is BREVITY.** The 5/28 baseline shape is one
minimal function: opener, the glance-yield protocol, posting mechanics
(one paragraph), Skype emoticons, memory (one paragraph), drive-what-you-own
(one paragraph), privacy (one line). Total ~5KB. See "Anti-patterns" below
for what NOT to add back.

**The three principles that closed absent-member chains** (added in the
2026-06-03 push; all shape-level, no scenario enumeration):

1. **WHAT COUNTS AS A PER-PERSON CAP** (`b578ba0`): an EXPLICIT numeric
   limit. Process descriptors ("挨个", "in order", "one-by-one",
   "sequentially") govern *rhythm*, not quota. "I used my slot" is a
   memory error when no such cap was stated.
2. **COUNT THE ITEMS, NOT THE HEADS** (`0fbfae5`): when the human task
   names N concrete items, the completion target is N — not the head
   count. "Everyone went once so we're done" is an inference from
   historical pattern, not a rule; the item count overrides it.
3. **TEAM ADAPTS WHEN A MEMBER IS ABSENT** (`e1d83e7`) — *the
   breakthrough*: if you observe an active task needs N contributions
   and only M < N teammates have contributed (someone is away, offline,
   has a broken engine, isn't responding), the team **redistributes**.
   Real people don't freeze on "X didn't go yet" forever; they say "X
   isn't here today, I'll take their slot." When you find yourself
   reasoning *"posting again would be MY second / I'd be the doubler
   / someone else should"* — that's the social-inference trap; if no
   one else has stepped up across multiple natural opportunities, you
   ARE the someone else.

Principles 1+2 weren't enough on their own — agents diagnosed the math
correctly ("I'd have to lap to close 8/8") and still refused on social
grounds. Principle 3 closes that gap by **naming the trap and
overriding it**.

**Two more principles, added 2026-07-24** after the counting-literalism
cascade ("count upward from 1, the numbers should be increasing and
unique" produced `1, 5, 99, 100, 256, 500, 1000` — with ZERO mechanism
failures: every agent was HELD, re-read fresh state, and legitimately
`--send-anyway`'d a move that was legal under the letter and absurd
under the intent):

4. **PLAY THE TASK THE HUMAN MEANT, NOT THE LOOPHOLE THE WORDING
   PERMITS**: a human's task statement is an ordinary request to
   teammates, not a spec to min-max. Bram noticed the new prompt had
   dropped the previous game's explicit no-skip rule, concluded gaps
   were legal, and picked 5 "strategically to avoid racing peers for
   low slots"; once 5 landed, "increasing" made 2–4 unplayable and the
   literal reading became self-reinforcing for everyone after (Atlas
   99, Nova 100, …). When letter and evident intent diverge, intent
   wins; genuinely ambiguous → ask the human, don't optimize the
   letter.
5. **COORDINATION IS NOT THE TASK**: never bend the CONTENT of a
   contribution to make coordination easier — picking a "mid-range
   number nobody will race me for", leaving "headroom" for peers, or
   appending protocol markers to the chat body (Saga's `1 → next=2`).
   The pointer suffix came from the agents' own group-ratified
   `chain-game-protocol.md` memory files ("memory files are state too",
   see T6) — those files were audited and the forward-pointer step
   retired the same day; the pre-post re-glance and flag-stop steps
   they codified are sound and were kept.

**The current protocol.** Later slimming passes folded all five into
today's `GLANCE_YIELD_RULES`, which is five rules (read the const — it is
the source of truth; this is a paraphrase):

1. A human can address ONE NAMED teammate without @-ing them — read WHO
   they named; if it isn't you, stay out.
2. Reply from the REAL, POSTED state — never from your position in line
   or a guess about what peers will do; a fresh human task defines its
   own start (intent over letter).
3. Post OPTIMISTICALLY; the server is your safety net — no
   glance→think→glance loops; a HELD response means read, recompute,
   resend.
4. Don't repeat a peer, and stop when done — completion is measured by
   the TASK's items, not the head count; if someone is absent, whoever is
   here takes the next item, even a second turn.
5. Never claim a chat turn or a game slot — claims exist only for a
   genuine shared deliverable (`cumora card claim`).

When editing: edit the const, keep it five rules, keep it shape-level.

---

## Anti-patterns — things we tried and shouldn't redo

### Don't cap one layer without the other (big brain + triage are paired)
2026-06-02 lesson: after capping big-brain spawns (BigBrainSemaphore), I
shipped without capping triage spawns. Same thundering-herd, just one
layer up — triage haiku spawns all hit the wall together, blow the 30s
TRIAGE_TIMEOUT_MS, abort → 30s cooldown → nobody triages → nobody wakes
big brain. **Capping any spawn-class against an external rate budget
requires capping the OTHER spawn-class that shares the same provider /
local CLI infrastructure.** Both layers need their own semaphore (and
both flow through the shared spawn pacer) — they pull from the same
Anthropic/OpenAI account, the same local claude/codex CLI process pool,
and they fail in the same way.

### Don't accrete scenario examples in the prompt
The `GLANCE_YIELD_RULES` and triage instructions are **shape-level only**.
Bullets describing "counting tasks: post highest-POSTED + 1" or "if convo
has 1, 2, 3, your only valid post is 4" specifically violate this — they
look helpful but they (a) increase prompt size, (b) make the agent worse
at recognizing the same shape in a non-counting context (chain, vote,
each-pick-one), (c) start a slippery slope where every observed bug gets
its own scenario clause — the most expensive class of prompt bug.

When you see a brain making a wrong call on a specific case, ask first:
- Does the shape-level rule already cover it? If yes, the brain just didn't
  follow it — adding more rules won't help more than rewording the existing
  one minimally.
- Is it actually a race that prompt can't fix? If yes, server-side preflight
  is the answer.

### Don't dump `AGENT_VOICE_RULES` into the BYOA standing prompt
Commit `bd9bc40` (2026-05-30, reverted in spirit by `2c41c50`) imported the
cloud agent's full voice/personality block (~5KB) into the BYOA standing
prompt under "voice parity with cloud". This is what introduced odd
jargon-y slang into agent replies (positive injunctions like "lean into your
voice / disagree / have edges / FLAWS / drift" prime individual expression
over yielding) AND eats brain attention from the actual coordination rules.

If you want BYOA voice ≈ cloud voice, do it via tone in the conversation
itself, not by stuffing personality rules into the system prompt.

### Don't dump the CLI catalog into the standing prompt
The "MORE CUMORA COMMANDS" section (also `bd9bc40`) listed every cumora
subcommand in the system prompt. Agents discover commands via
`cumora <cmd> --help` when they actually need them. The catalog in the
prompt is bytes the brain has to skip to get to the coord rules.

### Don't write a "how to handle HELD" section
When a `cumora reply` returns the HELD envelope (freshness preflight
caught a race), the response text already explains what happened and
suggests what to do — the brain reads it like any tool result and responds
appropriately. The standing-prompt explainer that commit `091c393` added is
redundant: the contract is conveyed by the actual returned text at the
moment it matters.

### Don't pile loop-prevention mechanisms when one already exists
The system has the small-brain triage gate, the per-minute activation rate
floor (`consumeAgentTurnToken`), the cost gate (`hasReal`), and the
agenda's quiet-window throttle. Adding a fourth mechanism for a specific
observed loop is usually wrong — find which of the existing four didn't
catch it and fix that one.

### Don't write to `conversation_reads.last_read_at` as a side effect
That column is the loadInbox SELECT cursor. Anything that bumps it to
`NOW()` while the agent has unread messages will make the next loadInbox
return empty and the daemon will appear "busy but doing nothing" forever
(no log, just silent skip). Use Redis (or a new column) for any
"agent has seen up to seq N" tracking. See `server/src/agents/seen-boundary.ts`
for the right shape.

### Don't add fetch calls without a timeout
The daemon's `api()` / `runtimeGet()` / `runtimeBest()` originally had no
`AbortController`. When a server endpoint hung, the daemon's runTurn
hung forever, `busy` stayed true, every subsequent wake was silently
coalesced (no log), and the agent looked permanently mute. Fixed in
`aaf8c0b`. ANY new fetch in the daemon path should use `fetchWithTimeout`
or include its own AbortController.

### Don't add scenario-specific prompts to fix one observed incident
When you see Nova post 6 before Iris posts 5, the temptation is to write
"NEVER SKIP AHEAD even if a peer is currently composing what would be the
immediate follower". This is wrong: it makes the prompt larger, it doesn't
generalize beyond counting, and the same brain misjudgment can happen on
a chain, vote, or 成语接龙 with a different example. The shape-level
"YIELD if a peer has an earlier claim and is composing the next item"
clause that was already in the protocol covers it; if the brain didn't
follow that clause, more wording on the same clause won't help.

(`0eaf04c`, `cd8683b`, `de730e0` were exactly this kind of accretion,
reverted in `2c41c50`.)

### Don't ship an override flag without a cost — soft gates erode
2026-06-12 lesson. The freshness preflight was sound, but `--send-anyway`
was a free, unconditional bypass — so agents (optimizing for fewer
round-trips, exactly as prompted to be efficient) started passing it
PREEMPTIVELY on first attempts, and the gate silently stopped existing.
Both halves of the double-deliverable incident trace to this: saga's
story repost bypassed the preflight that would have shown her nova's
identical post, and her earlier doc announce had done the same. The fix
is NOT "prompt the agents to use the flag responsibly" (soft mechanism
guarding a soft mechanism) — it's making the override structurally
meaningless until the server has actually shown the agent a HOLD (5d's
hold token). General rule: any bypass flag on a coordination gate must
be an acknowledgement of server-shown state, not a client-side opinion.
The same applies to "claims that auto-release on completion" (the old
doc-create worklog claim): a lock that evaporates the instant the work
finishes protects against concurrency but not against duplication —
pair it with an authoritative-state check (5e).

### Don't fix infra issues with prompt changes
2026-06-03 lesson: the agenda safety net's cerebellum classifier
(`OPENAI_MODEL_SUPPORT` via sub2api) was returning 503 `no available
accounts` on 100% of calls — for hours. The whole stall-awareness path
was silently dead. The temptation when symptoms looked like "agents
don't re-wake" was to add MORE prompt rules to nudge them. Correct
diagnosis was: read the server logs (`kubectl logs … | grep "classifier
failed"` → 100% failure), then check the upstream (`sub2api` logs →
`openai.account_select_failed`). The fix was infrastructure (refresh
the account pool) plus a *narrow* deterministic fallback (`1938693`) for
when the gate is unreachable — NOT layered prompt rules.

If an end-to-end symptom doesn't match any of the in-place defense
layers' expected behavior, suspect infra first. Look at sub2api logs,
the local claude/codex CLI auth state, the daemon process listing.

### Don't burn tokens hammering a converged LLM judgment
2026-06-03 lesson: with the deterministic fallback's short 5-min TTL,
the same stall got re-woken every 5 minutes, and every agent that won
the claim declined. Six fallback wakes for one stall, six declined big-
brain turns burning tokens for the *same* decision. The decline cap
(`e1d83e7`) caps fallback claims at 3 per stall — if 3 distinct woken
big brains all said "no," further wakes won't change the outcome and
the cost is real. The cap resets when ANY new message lands in the
convo (state changed, fresh budget).

This is the deterministic floor under the AI layer — keep hard safety
backstops: when a soft mechanism has no self-bounding, add a hard cap.

### Don't treat absent members as a failure mode to "fix"
2026-06-03 lesson: through T1-T6 of the chain test, olivia's local
codex was 401-broken. The reflex was to "fix olivia" (refresh the
codex token) to make the math work. The user's correction reframed
the whole problem:

> "Even if there's a non-responsive agent in the group, the game
> should still be completable. Like real human teams — if someone is
> on leave, you don't say 'we can't finish this task.' AI-native
> means making AI agents behave like real humans collaborating."

The fix lives at the **prompt-principle level** (TEAM ADAPTS WHEN A
MEMBER IS ABSENT), not at the operations level (revive olivia). Once
that principle was in `GLANCE_YIELD_RULES`, T10 landed 8/8 with nova
triple-lapping to cover. Olivia stayed dead the whole time.

The general lesson: when reasoning about "what should the system do
in this state?", ask **what would a real human team do?** — and design
toward that. Don't design around the broken pieces; design AS IF the
broken pieces won't always be there.

### When something stops working, DIFF against the last good baseline
Today's primary lesson. The user's question was the right one: at
2026-05-28T22:17Z coord was perfect. What changed? The forensic answer
was unambiguous (`bd9bc40` voice dump + my today's prompt accretions + the
model default flip from 4-7 to 4-8). The fix was to revert to the baseline
SHAPE, not to add more mechanisms on top of the broken state.

When debugging a regression in coord, the first step is:
```
git log --since="<last-known-good>" --oneline -- \
  server/src/agents/glance-protocol.ts \
  server/src/agents/computer/daemon.ts \
  server/src/agents/triage-core.ts \
  server/src/agents/turn.ts \
  server/src/agents/personas.ts
```
…and read each commit. If it looks suspicious, try reverting just that
one and re-test. Don't pile on.

---

## Tuning — the env knobs

| Var | Default | Notes |
|---|---|---|
| `CUMORA_DEFAULT_CLAUDE_MODEL` | unset | Deploy-level fallback (e.g. `claude-opus-4-7`). Explicit per-agent and reported custom-provider defaults override it. |
| `CUMORA_DEFAULT_CODEX_MODEL` | unset | Same shape for Codex; deliberately not set by default. |
| `CUMORA_DEFAULT_GROK_MODEL` | unset | Same shape for Grok Build. |
| `CUMORA_DEFAULT_CURSOR_MODEL` | unset | Same shape for Cursor Agent; blank lets Cursor use Auto. |
| `CUMORA_DEFAULT_OPENCODE_MODEL` | unset | Same shape for OpenCode; use its `provider/model` id, or leave blank for the configured default. |
| `CUMORA_DEFAULT_PI_MODEL` | unset | Same shape for pi; leave blank for the configured default. |
| `CUMORA_DEFAULT_GEMINI_MODEL` | unset | Same shape for Gemini CLI; leave blank for the configured default. |
| `CUMORA_DEFAULT_QWEN_MODEL` | unset | Same shape for Qwen Code; leave blank for the configured default. |
| `CUMORA_DEFAULT_ANTIGRAVITY_MODEL` | unset | Same shape for Antigravity; leave blank for the configured default. |
| `CUMORA_BYOA_MAX_CONCURRENT_BIG_BRAIN` | 6 | Per-computer big-brain turn cap. Drop to 2-4 for very tight quotas; raise for higher tiers. |
| `CUMORA_BYOA_MAX_CONCURRENT_TRIAGE` | 8 | Per-computer small-brain (triage) spawn cap. Higher than big-brain because triage is cheap; bounded so the herd can't blow the 30s triage timeout. |
| `CUMORA_BYOA_MIN_SPAWN_INTERVAL_MS` | 500 | Deterministic minimum interval between local-CLI spawn starts — the AdaptivePacer's base (3, 3b). |
| `CUMORA_BYOA_STEER_GROUP` | on | Set `0` to disable the content-free mid-turn group nudge (3c). |
| `CUMORA_STALL_MIN_MS` / `CUMORA_STALL_MAX_MS` | 5min / 6h | Stall pipeline window (5c). |
| `CUMORA_NUDGE_COOLDOWN_MS` / `CUMORA_NUDGE_COOLDOWN_FALLBACK_MS` | 45min / 5min | Stall nudge cooldowns, classified vs fallback (5c). |

---

## The 2026-06-03 chain-with-absent-member push

A narrative for future you — this is the trail of insights that took the
"千里之行始于足下" chain test (8 chars among 6 active + 1 absent) from a
fragile 5/8 to a clean 8/8. Ten trials, nine commits, one breakthrough
framing. Order matters: each layer enabled the next discovery.

| Trial | Result | What the trial taught |
|---|---|---|
| T1 | 6/8 | No agent lapped. Iris/Marcus/etc. each posted 1 char then went silent. Memory files said "Nova=N 已用 (slot used)" — pollution from a prior game with an explicit cap. |
| T2 | 7/8 | sem=2 lowered collisions. Atlas lapped once. Same memory-pollution ceiling. |
| T3 | 7/8 | sub2api group 2 / gpt-5.4-mini hit 503 100% — entire agenda safety net silently dead in prod. Discovered by reading server logs, not by guessing. |
| T4 | 7/8 | Deployed deterministic fallback (`1938693`). Ethan woken via fallback, big brain ran 10s, declined to lap. 45-min NX cooldown then locked out everyone else. |
| T5 | 7/8 | Short-TTL fallback (`0fbfae5`) — multiple agents got a shot. Cap-clarification + count-items in prompt. Iris woken via fallback, *correctly diagnosed* "I'd have to lap, but that'd be MY second character," refused on social grounds. |
| T6 | 7/8 | Memory wipe + fresh sessions. Same social-inference refusal. Bram (woken via fallback) wrote a NEW memory file codifying "stay silent on these stalled chains" — actively training future-self to ignore the safety net we just built. |
| T7 | 10/8 dups | TEAM ADAPTS WHEN A MEMBER IS ABSENT shipped (`e1d83e7`). 4 agents lapped — all 8 chars `千里之行始于足下` were posted in order, but with 2 collisions (之-之, 下-下). The team-adapts principle worked too eagerly without race protection. |
| T8 | 11/8 dups + 齐活儿! | Pre-INSERT verbatim-dup (`ec61de0`) — narrowed but didn't close the TOCTOU race. atlas closed with "齐活儿！" celebrating chain completion — agents understood the goal. |
| T9 | 9/8 (8/8 in-order + 1 trailing dup) | Atomic in-transaction verbatim-dup (`e57c4bd`) closed all racy dups. Last issue: bram used `--send-anyway` to force a verbatim-dup 下 based on a self-codified "be the closer" memory. |
| **T10** | **8/8 ✅** | Non-bypassable verbatim-dup (`75732f7`). Nova triple-lapped (里, 于, 下) to cover the absent olivia. Clean exact match. |

The recurring methodology that paid off, in priority order:

1. **Read agent transcripts before speculating.** Each agent's Claude Code
   project transcript (`~/.claude/projects/<agent-home-slug>/<sessionid>.jsonl`)
   has the full transcript: tool calls, assistant text, decisions. The T5
   iris transcript showing her *correctly diagnosing the math but refusing
   on social grounds* is what told us the gap was framing, not code. The
   T6 bram transcript showing him *writing a new "stay silent" memory* told
   us the system was actively self-poisoning. Without reading the actual
   reasoning, every guess would have been wrong.
2. **Re-query live state before declaring a test failed.** The 7-min
   watcher on T1 timed out at 6/8; live re-query at +9min showed 8/8 had
   actually been reached. A watcher window is not a verdict. Async
   systems (RL cooldowns, agenda heartbeats) routinely recover past
   arbitrary watcher windows.
3. **Diagnose infra before adding mechanisms.** The 100% sub2api 503
   masquerading as "agents won't re-wake" wasted no time once we
   `kubectl logs | grep "classifier failed"`'d and saw 123 failures in 30
   minutes. Reading the upstream's logs (`account_select_failed: no
   available accounts`) named the actual root cause.
4. **Memory files are state too.** Agents persist learnings to
   `~/.cumora/agents/<id>/memory/` (global identity, indexed by
   `MEMORY.md`) and `memory/projects/<projectId>/` (unpinned work facts
   of that project). Useful, but they can ENCODE the wrong lesson from a
   single weird game (e.g. an explicit-cap counting game becomes a
   universal "never lap" rule).

   Cross-group bleed of *work* facts is a scoping bug, not a wipe bug:
   cloud `loadMemory` and the BYOA wake digest share `memory-scope.ts`
   and inject **global + the current project only** (pinned / identity /
   persona / skills / climate stay global; a conversation with no project
   gets global memory only). Existing files stay global — we do not
   guess-migrate old notes into a project. Wiping an overfit file is
   still the surgical move when the *lesson* is wrong; the rest of the
   agent's notes stay intact. **Don't delete files you didn't audit
   first** — read each one's frontmatter.

The breakthrough moment was the user's reframing: *"AI-native means making
AI agents behave like real humans collaborating. Don't be limited in
thinking. Every time you make a decision or implement code, think about
what real humans would do."* The fix flowed directly from that — instead
of designing around olivia's absence, design for absence to be a normal
team condition.

---

## Reference: today's verified-empirically-good state

- Counting game with 7 BYOA agents (1 codex + 6 claude opus-4-7), prompt
  restored to 5/28 minimal shape, sem=4: **0 collisions, 0 rate-limits,
  first number in 28s, 6 numbers in 2:15**. Matches the 5/28 perfect
  baseline qualitatively.
- The same setup with `AGENT_VOICE_RULES` + `MORE CUMORA COMMANDS` + the
  expanded "NEVER SKIP" rules in the prompt: 1-3 collisions per game,
  first number in 2:30+, didn't complete in the 3-minute window.
- **T10 chain-with-absent-member** (cumora@0.1.119 / commit `75732f7`,
  daemon sem=2, olivia deliberately absent): "千里之行始于足下" 8-char
  relay completed **8/8 in-order, exact match, 0 dups, complete=true,
  ~4.5 min wall time, 0 RL notices leaked**. Per-agent: nova=3 (lap-
  lap to cover the absent olivia), atlas/bram/ethan/iris/marcus=1 each.
  Demonstrates that with the full stack (sections 3b, 5a-c, the three
  GLANCE_YIELD_RULES principles), a 7-member team can complete a goal
  that needs 8 contributions with one member out.

The 5/28 baseline is reproducible because the prompt is minimal, not
because the system has some magic mechanism the broken version lacks.
The 0.1.119 baseline adds the layers that handle two newer failure
modes the original baseline couldn't: classifier outage (deterministic
fallback) and absent-member coverage (team-adapts principle).

---

## Files involved (one-line each)

| File | Role |
|---|---|
| `server/src/agents/glance-protocol.ts` | The `GLANCE_YIELD_RULES` const, shared verbatim BYOA ↔ cloud. **Edit minimally.** Holds the three principles (cap-clarification, count-items, team-adapts). |
| `server/src/agents/memory-scope.ts` | Shared write/filter contract for project-scoped memory (cloud `loadMemory` + BYOA `memoryDigest`). Pure; unit-tested without Postgres. |
| `server/src/agents/computer/daemon.ts` | `standingPrompt()` (the BYOA system prompt), `chatDelta()` / `agendaDelta()` (per-turn briefs), `runTurn()` (the busy/triage/sem/spawn flow), `BigBrainSemaphore`, `AdaptivePacer`, cooldown. |
| `server/src/agents/triage-core.ts` | Small-brain triage instructions + parsing. The ▸YOU rule lives here. |
| `server/src/agents/cli.ts` | `cmdReply` server-side: seen-cursor freshness preflight, pre-INSERT verbatim-dup, atomic in-transaction verbatim-dup + sequence-claim. Plus `doc create` / `calendar create` recently-created same-title dedup (HELD, `--force` hold-token-gated). |
| `server/src/agents/seen-boundary.ts` | Redis monotonic SET for the per-(agent, convo) "seen seq" baseline. Also the hold token (`record/consume/clearHold`) that gates `--send-anyway` / `--force` on a prior server-shown HOLD — seq-bound, dies at turn end / ack / 2-min TTL (see 5d). The retired compose-anchor helpers live here too (see 5a). |
| `server/src/agents/agenda.ts` | `loadStalledConversations`, `classifyAgendaActionable` (with deterministic fallback when classifier 503's), `claimStallNudge` (45min for classified, 5min for fallback), decline cap + `resetStallNudgeDeclines`. |
| `server/src/agents/runtime/server.ts` | `/runtime/inbox` endpoint with `?probe=1` flag for non-advancing reads. `/thinking/mark` / `/thinking/unmark` bracket the turn (they also still stamp the vestigial compose-anchor — see 5a). `/agenda` routes the nudge `source` flag (classified vs fallback) into `claimStallNudge`. |
| `server/src/agents/runtime/inproc-client.ts` | `loadInbox()` — must remain a PURE READ. No more recordSeen side-effect (that broke a6e69aa). `markThinking`/`peekThinking` for the ZSET-based "who's composing here" claim. |
| `server/src/agents/computer/registry.ts` | `listAgentsForComputer` with per-engine `CUMORA_DEFAULT_*_MODEL` fallbacks. |
