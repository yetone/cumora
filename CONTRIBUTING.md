# Contributing to Cumora

Thanks for your interest in Cumora. This guide covers how to get set up, the
checks your change needs to pass, and a couple of architecture invariants that
are enforced in CI so you don't get surprised.

By contributing you agree that your contributions are licensed under the
project's [MIT License](LICENSE).

## Getting set up

You need **Node ≥ 18** (CI runs on Node 24), plus **Postgres** and **Redis**
running locally.

```bash
createdb -h localhost cumora
export OPENAI_API_KEY=sk-...        # the only hard-required env var

npm run setup                     # root + Email Worker dependencies
npm run dev:all                     # Vite renderer on :5180 + API server on :5181
```

Use `npm run setup` rather than a root-only `npm install`: the root test
command also runs `workers/email-gate` tests, whose dependencies live in the
Worker's separate `package.json`.

Open http://localhost:5180 for the web app, or `npm run electron:dev` for the
desktop shell. Database migrations are applied via `npm run migrate` (run
automatically by `dev:all` and `electron:dev`), and seeded on boot with a starter team. Everything else (OAuth login, email, storage, push, the
sub2api LLM gateway) soft-disables when its env vars are unset — see
[`.env.example`](.env.example).

Component-specific setup lives in [`docs/`](docs/): `BYOA.md` (the local-engine
daemon), `MOBILE_IOS.md`, `PUSH_NOTIFICATIONS.md`, `email.md`.

## Before you open a PR

Run the same gates CI runs. All of these must pass:

```bash
npm run lint               # Biome lint (autofix with `npm run lint:fix`)
npm run typecheck          # frontend types
npm run server:typecheck   # server types
npm test                   # unit tests (node:test) for server + workers
npm run test:integration   # integration suite (needs local Postgres + Redis)
npm run guard:big-brain    # architecture guard, see below
npm run guard:llm-tracked  # architecture guard, see below
```

Biome is configured (`biome.json`) as a **linter only** — it is not a
formatter here, so it won't reflow existing code. The rule set is a
pragmatic subset of Biome's recommended rules: correctness and real-bug
rules are on; noisy or intentional-pattern style rules are off, while the a11y
rules are enforced incrementally (useButtonType, ARIA roles/props, and core
accessibility rules are active).

Both TypeScript projects are `strict`. There are no frontend unit tests yet;
server and worker logic is covered by `server/src/__tests__` and
`server/src/__integration__`.

## Two architecture invariants (enforced in CI)

These aren't style preferences — they're the product's core cost model, and a
guard script will fail your build if you break them:

1. **Only agent turns may use the big model.** The cheap "cerebellum" model
   handles triage, classification, summaries, and every other utility call;
   the expensive model is reserved for the actual agent reasoning turn. If you
   add an LLM call, route it through the right tier. `npm run guard:big-brain`
   checks this.
2. **Every LLM call must be tracked** in the cost ledger. Untracked spend is a
   correctness bug here, not just an oversight. `npm run guard:llm-tracked`
   checks this.

The multi-agent coordination model (how N agents share a room without
colliding, and why the prompt is kept deliberately minimal) is documented in
[`docs/COORDINATION.md`](docs/COORDINATION.md) — read it before touching the
agent turn loop, the triage gate, or the daemon.

## Coding conventions

- Match the style of the file you're editing. The codebase leans on comments
  that explain *why* — constraints, trade-offs, and the history behind a
  non-obvious choice — not what the next line does. If your change reverses a
  decision a comment documents, update the comment.
- Keep the coordination prompts (`glance-protocol.ts`, the daemon standing
  prompt) shape-level and minimal. Adding per-scenario examples to fix one
  observed bug is the most expensive class of change here — see the
  anti-patterns in `docs/COORDINATION.md`.
- Prefer `any`-free, well-typed code; both tsconfigs are strict for a reason.

## Reporting bugs and security issues

- **Security vulnerabilities**: do **not** file a public issue — follow
  [`SECURITY.md`](SECURITY.md).
- **Bugs and features**: open a GitHub issue with clear reproduction steps and
  what you expected to happen.

## Commit and PR hygiene

- Write focused commits with a clear message explaining *why*, not just what.
- Keep a PR to one logical change; smaller PRs get reviewed faster.
- Make sure the full check list above is green before requesting review.
