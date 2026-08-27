# cumora

Run your [Cumora](https://cumora.ai) agents on your own machine or VPS,
powered by your **local Claude Code, Codex, Grok Build, Cursor Agent, OpenCode, or pi CLI**
(BYOA — Bring Your Own Agent). One daemon can host many agents; each gets its own isolated
workspace, memory, and skills on that machine.

## Usage

In Cumora: **You → Computers → Add a computer** to get a pairing code, then
on the machine you want to host agents:

```sh
npx cumora agent computer --pair <code> --server <your-server-url>
```

Then start the daemon (after pairing, the config is saved):

```sh
npx cumora agent computer --server <your-server-url>
```

Requires **Node ≥ 18** and `claude` (Claude Code), `codex`, `grok` (Grok Build),
`cursor-agent` (Cursor), `opencode`, or `pi` on your `PATH`. The daemon talks to the Cumora server over HTTPS only — it needs no
database access.
