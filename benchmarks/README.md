# Cumora Multi-Agent Coordination Benchmarks

Real-LLM capability evaluation for the BYOA + cloud agent coordination
stack. Run periodically (weekly by default) against the production
daemon + server to catch coordination regressions that pure unit tests
can't see — race conditions, social-inference traps, classifier-outage
fallback, etc.

> ⚠️ **This costs real money.** Every trial wakes real claude/codex
> agents. See [Cost](#cost) below.

## What's in the suite

| Scenario | What it tests | Status |
|---|---|---|
| `chain` | N-char sequential relay with one member deliberately absent. Exercises the **TEAM ADAPTS WHEN A MEMBER IS ABSENT** principle, `compose-anchor`, atomic `verbatim-dup` HOLD, stall fallback. Reference: T10 / 2026-06-03. | ✅ implemented |
| `counting` | Each agent says exactly ONE number, sequence 1..K. **Shape-dual of chain** — explicit cap, NO lapping allowed. Exercises the ▸YOU triage rule and the cap-clarification principle. | ✅ implemented |
| `werewolf` | Multi-round role-playing with judge-driven state machine. Structural scoring: winner declared + ≥1 phase cycle + death announcements. No semantic quality judging. | ✅ implemented |
| `kanban` | Pull-group on a pre-created card; success = card moves to done-pattern column AND ≥2 distinct agent contributors. Requires `BENCH_KANBAN_BOARD_ID` pointing at an existing board with todo + done columns. | ✅ implemented |

The chain and counting scenarios are **shape-duals** on purpose:
chain proves the team adapts to absence (lap when needed);
counting proves the team respects an explicit cap (don't lap when
explicitly forbidden). A regression that breaks the principle in either
direction shows up in exactly one of them.

## How it works

The harness is INTENTIONALLY thin: it impersonates a human user posting
a message into a fresh group conversation, then polls the messages
table until the scenario's natural-termination condition holds or a
wall-clock timeout fires. It does NOT spawn or configure agents — those
are already running on the operator's machine (BYOA daemon) or in the
cloud (pod-agent infra).

```
[harness creates convo]
    ↓ posts seed message + publishes to CH_MESSAGE_NEW
[SSE fanout reaches the daemon / cloud pods]
    ↓ each agent wakes, triages, decides, posts (or not)
[harness polls messages table at 4s cadence]
    ↓ early-exits on scenario-defined natural completion
[harness computes per-trial metrics, repeats N trials]
    ↓ aggregates over trials → pass/fail verdict + score
```

Per-scenario metrics extend the standard set (in `lib/types.ts`):
`complete`, `durationMs`, `totalPosts`, `uniqueContributors`,
`verbatimCollisions`, plus a free-form `extra` object for game-specific
signal (e.g. chain's `lappers`, counting's `capViolators`).

Pass criteria are **statistical over the trial sample**, never
per-trial. LLM judgment is naturally variable; "≥67% of trials hit
exact-match completion AND median verbatim-collisions = 0" is the kind
of bar that flags real regressions without flapping on stochastic noise.

## Running locally

```bash
cd benchmarks
npm install
# Point at the cumora DB/Redis (same ones the daemon uses)
export DATABASE_URL=postgres://...
export REDIS_URL=redis://...
export BENCH_USER=u-<your-user-id>          # the participant ID you want to act as
export BENCH_COMPANY=co-<your-company-id>   # the company under which test convos are created
npx tsx run.ts chain                         # one scenario
npx tsx run.ts chain counting                # multiple
npx tsx run.ts --all                         # all four scenarios
```

The runner writes one JSON result file per scenario into
`benchmarks/results/`. Exit code is 0 iff all named scenarios passed.

## Cost

Per-trial cost depends entirely on your daemon's model pin
(`CUMORA_DEFAULT_CLAUDE_MODEL`) and roster size. Indicative figures for
Opus 4.7 on a 7-agent roster (the standard test rig as of 2026-06):

| Scenario | ~Wall time / trial | ~Cost / trial | Default trials | Per-cycle cost |
|---|---|---|---|---|
| `chain` | 5-8 min | $3-5 | 3 | $9-15 |
| `counting` | 3-5 min | $1-2 | 3 | $3-6 |
| `werewolf` | 15-25 min | $15-25 | 2 | $30-50 |
| `kanban` | 20-30 min | $8-15 | 2 | $16-30 |

**Weekly cycle running all four scenarios: ~$58-101.** Weekly chain
+ counting only: ~$12-21 (cheap regression watch). Daily all-four:
$240-400/month (aggressive). Tune `BENCH_*_TRIALS` env vars or
narrow scenarios on a given schedule to trade statistical confidence
for cost.

The default workflow runs `chain counting` only on schedule (the
cheap pair); use `workflow_dispatch` with an explicit scenario list
to fire the expensive games on demand.

The harness itself does **zero LLM calls** — all cost is in the agents
it wakes. If you need to dry-run the harness, point `DATABASE_URL` at
an empty test database; agents won't wake because they're not paired to
that environment.

## CI integration

See [`.github/workflows/benchmark.yml`](../.github/workflows/benchmark.yml).
The workflow runs on a `self-hosted` runner tagged `cumora-bench` because
GitHub-hosted runners can't host the claude/codex CLI auth state.

Self-hosted runner setup (one-time):
1. Provision a machine with `claude` and `codex` CLIs installed and
   logged in to working accounts.
2. Run `npx cumora agent computer` daemon in a long-lived tmux window
   so the daemon is up when the workflow fires.
3. Install the GH Actions self-hosted runner with labels `self-hosted`
   + `cumora-bench`.
4. Set the workflow secrets (`BENCH_DATABASE_URL`, `BENCH_REDIS_URL`,
   `BENCH_USER`, `BENCH_COMPANY`) under repo Settings.

Results land as a workflow artifact AND get committed to the
`benchmarks-history` branch (separate from main) for trend tracking.
Plot history with whatever dashboard you prefer; the per-result JSON
schema is in [`lib/types.ts`](lib/types.ts) `BenchmarkResult`.

## Adding a new scenario

1. Drop a new file in `games/<name>.ts` exporting a `Scenario` (see
   [`lib/types.ts`](lib/types.ts)).
2. Register it in [`run.ts`](run.ts) `REGISTRY`.
3. Write the `computeMetrics` purely from the message log (no
   side-effects, no LLM calls — the goal is reproducible scoring).
4. Write the `passCriterion` over the trial sample, not per-trial.
5. Update this README's "What's in the suite" table.

Be conservative with the timeout (it's a hard wall-clock cap, multiplied
by `trials` for total cost). Be specific with the pass bar — vague
"completion-ish" criteria lead to flapping verdicts.

## Anti-patterns

Same shape as the broader coord stack — see
[`docs/COORDINATION.md`](../docs/COORDINATION.md) Anti-patterns section.
Specific to benchmarks:

- **Don't make pass/fail per-trial.** LLM judgment is stochastic.
  Sample-level criteria with a documented floor is the right shape.
- **Don't enumerate game variants in `passCriterion`.** Each scenario
  tests ONE principle. If you find yourself adding scenario-specific
  carve-outs to a criterion, that's a new scenario, not an or-condition.
- **Don't gate PRs on this workflow.** Stochastic + expensive + 10-min
  minimum wall time = a terrible PR-gating signal. Schedule-driven
  trend monitoring is what this is for; quick PR signal comes from
  unit tests in `server/src/__tests__/`.
