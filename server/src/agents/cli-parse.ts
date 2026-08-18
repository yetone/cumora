/**
 * argv parsing for the `cumora` agent CLI. Extracted into its own
 * import-side-effect-free module so unit tests can pin the behaviour
 * without booting cli.ts's DB / storage / OpenAI dependency graph.
 *
 * The CLI runs in three modes:
 *   - inside an agent pod, called through the JWT-pinned /runtime/cli path
 *   - inside local agent bash, normally called through a PATH wrapper
 *     that supplies ambient identity for developer ergonomics
 *   - from a dev shell with CUMORA_DEFAULT_AS in .env
 *   - from tests, calling runCli(argv) directly with `--as` baked in
 *
 * All modes share these two pure functions.
 */

export interface ParsedArgs {
  positional: string[]
  flags: Record<string, string | boolean>
  /** Index into `positional` at which LITERAL args begin — everything the
   *  caller placed after a POSIX `--` end-of-flags marker. The BYOA shim puts
   *  `--file` / `--stdin` content there, so those args must be taken exactly as
   *  they arrived: not re-read as flags, and not escape-expanded. Absent when
   *  no `--` was present. */
  literalFrom?: number
}

/**
 * Parse a flags-and-positionals argv array.
 *
 * Recognises two flag forms:
 *   `--key value`  → flags[key] = 'value'
 *   `--key=value`  → flags[key] = 'value'
 *
 * A `--key` followed by another `--flag` (or EOL) sets the boolean
 * `true` — the next `--`-prefixed token is treated as a separate
 * flag, not a value. This matches POSIX-ish flag conventions and is
 * what the bash tool / CLI shim assumes.
 *
 * Anything not starting with `--` lands in `positional`.
 *
 * A bare `--` is the POSIX end-of-flags marker: every remaining token is a
 * positional even if it starts with `--`. The BYOA shim uses it to hand over
 * `--file` / `--stdin` content, which routinely begins with `---` (a markdown
 * rule, a YAML front-matter fence, a `--- a/file.ts` diff header).
 */
export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  let literalFrom: number | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      literalFrom = positional.length
      for (let j = i + 1; j < args.length; j++) positional.push(args[j])
      break
    }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const eq = key.indexOf('=')
      if (eq >= 0) {
        flags[key.slice(0, eq)] = key.slice(eq + 1)
      } else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next
          i++
        } else {
          flags[key] = true
        }
      }
    } else {
      positional.push(a)
    }
  }
  // Only carry `literalFrom` when a `--` was actually seen, so the parsed shape
  // is byte-for-byte what it always was for every existing call.
  return literalFrom === undefined ? { positional, flags } : { positional, flags, literalFrom }
}

/**
 * Join the positional args from `start` onward into one body string.
 *
 * Args that came through a shell get `unescapeChat` (the bash tool wraps a
 * body in single quotes, so `\n` arrives as two literal characters). Args
 * after a POSIX `--` do NOT: the shim reads `--file` / `--stdin` content
 * locally and it travels as JSON, never touched by a shell — that is the whole
 * point of those flags. Re-expanding escapes there would corrupt exactly the
 * code snippets the file path exists to carry verbatim, turning a `\n` inside
 * a string literal into a real line break.
 */
export function joinBodyArgs(parsed: ParsedArgs, start: number): string {
  const literalFrom = parsed.literalFrom ?? parsed.positional.length
  return parsed.positional
    .slice(start)
    .map((part, i) => (start + i >= literalFrom ? part : unescapeChat(part)))
    .join(' ')
}

/**
 * Tokenize a single command-line string into argv. Used in places
 * where we receive ONE string from the LLM (e.g. early CLI test
 * fixtures, certain tool-replay paths) and need to split it the way
 * bash would.
 *
 * Rules:
 *   - whitespace splits tokens (space + tab; newline is treated as
 *     whitespace too)
 *   - `"..."` and `'...'` quote spans — whitespace inside is part of
 *     the surrounding token
 *   - no escape handling inside quotes (bash single-quotes don't
 *     escape; we match that)
 *
 * Symmetric with how the agent bash tool would forward a body to
 * `cumora reply <convo> '<body>'` — the outer single quotes wrap any
 * body content (including spaces) into one token.
 */
export function tokenize(line: string): string[] {
  const out: string[] = []
  let buf = ''
  let q: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === q) { q = null }
      else { buf += c }
    } else if (c === '"' || c === "'") {
      q = c
    } else if (c === ' ' || c === '\t') {
      if (buf) { out.push(buf); buf = '' }
    } else {
      buf += c
    }
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Convert literal escape sequences (`\n`, `\t`, `\r`, `\\`, `\'`, `\"`)
 * into the real characters. Necessary because the bash tool wraps body
 * args in single quotes — and bash single-quoted strings don't expand
 * escapes — so by the time the CLI sees them, `\n` arrives as a
 * literal two-char sequence rather than a newline.
 *
 * Applied to body / opening_message / note fields where the LLM writes
 * prose intended to carry newlines or punctuation. Unknown escape
 * sequences (e.g. `\z`) are left as-is so we don't silently mangle
 * Windows-style paths a model might quote inside a body.
 */
export function unescapeChat(s: string): string {
  return s.replace(/\\(.)/g, (_, ch: string) => {
    switch (ch) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '\\': return '\\'
      case "'": return "'"
      case '"': return '"'
      default: return '\\' + ch
    }
  })
}
