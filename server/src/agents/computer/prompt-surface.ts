/**
 * How a BYOA agent is told to reach Cumora — which is not the same in the two
 * modes, and used to be described as if it were.
 *
 * Secure mode deliberately makes the shell CLI unreachable: `<home>/bin` is
 * never written, it is not on PATH, `node` is absent from the permitted tool
 * environment, and no runtime URL or bearer token crosses into the model
 * process. Both secure engines are shaped that way — Codex gets
 * `mcp_servers.cumora` with `enabled_tools=["cli"]`, Claude gets
 * `--tools …,mcp__cumora__cli` with Bash disallowed outright.
 *
 * The standing prompt nevertheless told every agent to run `cumora` on its
 * PATH, so a secure agent spent its turn hunting for a binary, for `node`, and
 * for a runtime URL that had all been removed on purpose. It could read and
 * reason; it could not act (#145).
 *
 * Its posting advice was wrong in a second, sharper way: it said to write long
 * bodies to a file and post them with `--file`, and the MCP bridge REFUSES that
 * flag ("local file/stdin flags are unavailable; pass body text directly in
 * argv"). An agent that found the tool and followed the prompt still hit a
 * guaranteed error.
 *
 * Extracted here as pure functions so the wording of both modes can be pinned
 * without booting the daemon — the same reason cli-parse.ts is split out.
 */

/** Whether the legacy shell CLI is on the model's PATH for this run. Compat
 *  mode writes the shim into `<home>/bin`; secure mode never does. */
export type ActionSurface = 'cli' | 'mcp'

export function actionSurfaceFor(unsandboxed: boolean): ActionSurface {
  return unsandboxed ? 'cli' : 'mcp'
}

/** The opening "how you act" sentence. */
export function actionSurfaceText(surface: ActionSurface): string {
  if (surface === 'cli') {
    return 'You act on Cumora through the `cumora` CLI on your PATH.\n\n'
  }
  return (
    'You act on Cumora through the `mcp__cumora__cli` tool. Pass the command words as `argv` — ' +
    '`{"argv":["reply","<conversationId>","your text"]}` is the shape; every `cumora <cmd> …` ' +
    'below is the same words without the leading `cumora`. There is NO shell, no `cumora` on ' +
    'PATH, no `node`, and no runtime URL or token — those are withheld deliberately, so do not ' +
    'go looking for them or try to run a command line. The tool is the whole surface.\n\n'
  )
}

/** How to post a message, which fails differently on each surface.
 *
 *  Through a shell, inline backticks and `$(…)` are mangled, so the answer is a
 *  file plus `--file`. Through the bridge there is no shell to mangle anything
 *  — argv is literal — and `--file` / `--stdin` are refused outright. */
export function postingMechanicsText(surface: ActionSurface): string {
  if (surface === 'cli') {
    return (
      'Posting a message: For ANY message with backticks, code, $, quotes, or multiple lines, ' +
      'write it to a file (e.g. `notes/reply.md`) and post with `cumora reply <conversationId> --file notes/reply.md` — ' +
      'the shell mangles inline `backtick` / `$(...)` content. For short plain text, ' +
      "`cumora reply <conversationId> 'text'` (SINGLE quotes) is fine. "
    )
  }
  return (
    'Posting a message: put the body directly in argv, exactly as you want it to appear — ' +
    '`{"argv":["reply","<conversationId>","line one\\nline two"]}`. Nothing is shell-interpreted, ' +
    'so backticks, `$`, quotes and newlines are safe as-is and need no escaping. Do NOT use ' +
    '`--file` or `--stdin`: the bridge refuses them, because it has no access to your files. '
  )
}

/** The self-check-back example. The shell form's single quotes are load-bearing
 *  there and would arrive as literal characters in a title through the bridge. */
export function calendarExampleText(surface: ActionSurface, agentId: string): string {
  if (surface === 'cli') {
    return `\`cumora calendar create '<chase>' --at <iso> --assignee ${agentId} --prompt '<what future-you does>'\`. `
  }
  return (
    `\`{"argv":["calendar","create","<chase>","--at","<iso>","--assignee","${agentId}",` +
    `"--prompt","<what future-you does>"]}\` — each word its own argv entry, no quoting. `
  )
}
