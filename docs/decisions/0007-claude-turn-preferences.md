# ADR 0007: Inherit Claude model preferences inside the restricted boundary

- Status: Accepted
- Date: 2026-09-05
- Amends: [ADR 0005](0005-secure-claude-provider-bootstrap.md), its bootstrap-only allowlist

## Context

The provider bootstrap fix restored authentication and model routing but did
not restore `effortLevel`. Restricted Claude ignores user settings, and Cumora
also defaulted every agent turn to `MAX_THINKING_TOKENS=0`. This silently
discarded the operator's reasoning preferences even for substantial agent work.
New Claude versions also save effort in `modelSettings`, so inheriting only the
global field would miss settings written by the native effort picker.

## Decision

- Import validated `effortLevel`, per-model effort entries,
  `alwaysThinkingEnabled`, and `language` into Cumora's inline turn settings.
  Rebuild nested model entries from allowed fields; never merge arbitrary
  user settings into permissions, hooks, tools, or the sandbox.
- Import a fixed turn-only environment allowlist for effort, thinking budget,
  output limit, and thinking/adaptive compatibility switches. Explicit daemon
  environment values win. Every imported environment name remains denied to
  model-spawned subprocesses. Provider credentials remain outside argv.
- Stop forcing thinking off for agent turns. Preserve an explicit disabled
  setting, and otherwise let Claude choose its native default and apply its
  model-specific and managed-policy rules. Inherit preferences, not an
  assertion that the provider will honor a particular reasoning level.
- Preserve Opus/Sonnet/Haiku provider model aliases in the core environment.
  The current Haiku alias is also used for catalog/triage fast-model defaults,
  with the legacy small-fast setting as fallback; Agent pins still win.
- Keep triage and doctor thinking off and separate from turn preferences.
  Read preferences when a process is spawned, for both one-shot and persistent
  sessions; an existing persistent session requires a daemon restart to pick
  up local edits.

## Consequences

Explicit high-effort or thinking preferences can increase turn latency and
cost; that is the operator's choice. Missing preferences no longer imply an
unadvertised Cumora thinking-off policy. `xhigh` plus thinking disabled can
still become `high` for Opus 5 under Claude's native compatibility handling.
The public server model catalog never receives these personal turn preferences.

## Alternatives considered

- **Load the complete settings file:** rejected; restores executable settings
  and tool authority excluded by restricted mode.
- **Hard-code `--effort xhigh` or turn thinking on:** rejected; overrides
  per-model, environment, and explicitly disabled preferences.
- **Forward output styles, fast mode, or ultracode:** deferred; styles can load
  user-authored role prompts, and speed/workflow modes change billing or
  orchestration beyond reasoning preference inheritance.

## References

- [Claude effort and thinking](https://code.claude.com/docs/en/model-config#adjust-effort-level)
- [Claude settings reference](https://code.claude.com/docs/en/settings-reference)
- [Claude environment variables](https://code.claude.com/docs/en/env-vars)
