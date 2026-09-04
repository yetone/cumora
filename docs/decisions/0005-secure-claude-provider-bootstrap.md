# ADR 0005: Bootstrap custom Claude providers without widening Agent tools

- Status: Accepted
- Date: 2026-09-05

## Context

Secure Claude BYOA turns use Claude Code's `--restricted` mode. It correctly
ignores user/project settings so an Agent cannot acquire the operator's hooks,
MCP servers, permissions, or tool configuration. It also ignores the `env`
section of `~/.claude/settings.json`, where tools such as CC Switch commonly
store `ANTHROPIC_BASE_URL` and an authentication value.

That produced a split-brain result: `claude auth status` and an ordinary
terminal turn worked, while the same account under Cumora reported `Not logged
in`. If authentication was bypassed, an unpinned Agent could still receive the
server's Anthropic deployment model even though the custom endpoint owned a
different model namespace.

## Decision

- In secure mode, the daemon reads only a fixed allowlist from Claude's user
  settings: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, and `ANTHROPIC_SMALL_FAST_MODEL`.
- Those values enter only the trusted Claude core process environment. The
  inline restricted policy denies every imported name to model-spawned
  subprocesses. Cumora never serializes the values into argv, its logs, the
  Agent home, model-catalog reports, or its server.
- Explicit daemon environment values take precedence over the settings file.
  Missing, malformed, relative-config-root, or oversized settings fail soft and
  preserve Claude's native first-party OAuth/keychain behavior.
- Claude model discovery reports the configured defaults and whether a custom
  endpoint owns an unnamed default. For an Agent without an explicit model pin,
  that custom-provider default wins over a deployment-level vendor pin. The
  same applies to its fast model; if either default is unnamed, no model flag is
  injected. Explicit `participants.model` / `fast_model` values remain highest
  priority, and older daemons without this signal retain the deployment
  fallback.

## Consequences

- A custom Claude endpoint configured through the ordinary Claude settings file
  works without enabling `CUMORA_BYOA_ALLOW_UNSANDBOXED`.
- The operator's complete Claude settings remain outside the Agent boundary;
  executable configuration such as hooks, MCP servers, permissions, and
  arbitrary environment entries is still ignored.
- The daemon is now trusted to read four provider bootstrap values from a
  user-owned file. It already owns the Claude process and inherited equivalent
  values when exported by the operator; this changes their source, not the
  process trust boundary.
- A custom provider that needs additional environment variables remains
  unsupported in secure mode until each variable receives an explicit security
  review and is added to the allowlist.

## Alternatives considered

- **Enable unsandboxed compatibility mode:** rejected because authentication
  availability must not grant model-generated tools host file, credential, and
  network authority.
- **Pass the complete user settings file to restricted Claude:** rejected
  because it restores the hooks, permissions, MCP, and tool configuration that
  restricted mode intentionally excludes.
- **Embed provider values in `--settings` JSON:** rejected because secrets would
  become visible in the process command line and diagnostic captures.
- **Always remove deployment model pins:** rejected because first-party BYOA
  fleets use them to keep behavior stable across CLI upgrades. Only observed
  custom-provider ownership takes precedence.
