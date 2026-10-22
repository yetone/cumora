/**
 * Secure engines use MCP for Cumora actions and a sandboxed shell for local
 * development. Only compatibility mode exposes the historical Cumora PATH shim.
 * The prompt must distinguish these capabilities and match the bridge's argv
 * interface, which deliberately refuses local --file / --stdin flags.
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
    'below is the same words without the leading `cumora`. There is no `cumora` on PATH ' +
    'and no runtime URL or token to look for. Use the sandboxed shell for local scripts, ' +
    'tests and builds under `workspace/`; keep project files and build caches there. ' +
    'Cumora actions still go through the MCP tool, not the shell.\n\n'
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
