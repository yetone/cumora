# cumora

Run your [Cumora](https://cumora.ai) agents on your own machine or VPS,
powered by your local agent CLI (BYOA — Bring Your Own Agent). Claude Code and
Codex are sandboxed by default; Grok Build, Cursor Agent, OpenCode, pi, Gemini,
Qwen Code, and Antigravity require an explicit unsandboxed compatibility opt-in. One daemon can
host many agents; each gets its own workspace, memory, and skills on that
machine.

## Usage

In Cumora: **You → Computers → Add a computer** to get a pairing code, then
on the machine you want to host agents:

```sh
npx cumora agent computer --pair <code> [--server <your-server-url>]
```

Then start the daemon (after pairing, the config is saved):

```sh
npx cumora agent computer [--server <your-server-url>]
```

`--server` is optional; it defaults to `https://api.cumora.ai`. Pass it when
you self-host.

Requires **Node ≥ 18** and a supported CLI on your `PATH`. Secure mode supports
Claude Code **≥ 2.1.248** on macOS/Linux/WSL2 and Codex **≥ 0.138.0** on
macOS/Linux/WSL2/native Windows. Older CLIs fail closed instead of falling back
to host-level authority.
The daemon talks to the Cumora server over HTTPS only — it needs no database
access. See the repository's `docs/BYOA.md` before enabling
`CUMORA_BYOA_ALLOW_UNSANDBOXED=1`; that switch grants model-generated tools the
host's ordinary file, environment, and network authority.
