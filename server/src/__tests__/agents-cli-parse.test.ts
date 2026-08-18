/**
 * Unit tests for the agent CLI's argv parser + body-escape helper.
 * Both are pure functions, both sit in the hottest path the agent
 * bash tool exercises every turn, and both have subtle edge cases
 * worth pinning so a future tweak doesn't silently change semantics:
 *
 *   - parseArgs handles three flag forms (`--k v`, `--k=v`, `--k`) plus
 *     positionals interleaved with flags
 *   - unescapeChat converts `\n`/`\t`/`\r`/`\\`/`\'`/`\"` into the real
 *     characters and leaves unknown escapes alone
 *
 * Run: node --import tsx --test server/src/__tests__/agents-cli-parse.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinBodyArgs, parseArgs, tokenize, unescapeChat } from '../agents/cli-parse.js'

// ── parseArgs — happy paths ──────────────────────────────────────────────

test('parseArgs: only positionals', () => {
  const r = parseArgs(['reply', 'conv-1', 'hello'])
  assert.deepEqual(r.positional, ['reply', 'conv-1', 'hello'])
  assert.deepEqual(r.flags, {})
})

test('parseArgs: `--key value` consumes the next token as the value', () => {
  const r = parseArgs(['--as', 'iris-0c97', 'kanban', 'ls'])
  assert.deepEqual(r.positional, ['kanban', 'ls'])
  assert.deepEqual(r.flags, { as: 'iris-0c97' })
})

test('parseArgs: `--key=value` form', () => {
  const r = parseArgs(['--as=iris-0c97', 'kanban', 'ls'])
  assert.deepEqual(r.positional, ['kanban', 'ls'])
  assert.deepEqual(r.flags, { as: 'iris-0c97' })
})

test('parseArgs: boolean flag at end of argv', () => {
  // `--json` with no following non-flag token → boolean true.
  const r = parseArgs(['kanban', 'ls', '--json'])
  assert.deepEqual(r.positional, ['kanban', 'ls'])
  assert.deepEqual(r.flags, { json: true })
})

test('parseArgs: boolean flag followed by another flag', () => {
  // `--json` is followed by another `--something`, so it must be
  // boolean (not consume the next flag's name as its value).
  const r = parseArgs(['--json', '--as', 'iris', 'kanban'])
  assert.deepEqual(r.positional, ['kanban'])
  assert.deepEqual(r.flags, { json: true, as: 'iris' })
})

test('parseArgs: interleaved positionals and flags', () => {
  // Real production shape: `cumora reply <convo> '<body>' --quote <id>`
  const r = parseArgs(['reply', 'convo-1', 'hello world', '--quote', 'm-abc'])
  assert.deepEqual(r.positional, ['reply', 'convo-1', 'hello world'])
  assert.deepEqual(r.flags, { quote: 'm-abc' })
})

test('parseArgs: last write wins for repeated flag', () => {
  const r = parseArgs(['--as', 'A', '--as', 'B', 'kanban'])
  assert.equal(r.flags.as, 'B', 'last value of a repeated flag wins')
})

// ── parseArgs — edge cases ───────────────────────────────────────────────

test('parseArgs: empty argv', () => {
  const r = parseArgs([])
  assert.deepEqual(r, { positional: [], flags: {} })
})

test('parseArgs: only flags, no positionals', () => {
  const r = parseArgs(['--as', 'iris', '--json'])
  assert.deepEqual(r.positional, [])
  assert.deepEqual(r.flags, { as: 'iris', json: true })
})

test('parseArgs: flag value can be an empty string when using --key=', () => {
  // `--text=` is "set the text flag to empty string". Different from
  // `--text` (which would be boolean true). cmdReply uses this when
  // the LLM intentionally sends an empty body.
  const r = parseArgs(['reply', 'convo-1', '--text='])
  assert.equal(r.flags.text, '')
})

test('parseArgs: positional value that LOOKS like a flag value is consumed by the preceding flag', () => {
  // Subtle: `--quote m-abc` consumes `m-abc` as the value. `m-abc`
  // isn't `--`-prefixed so it's not a flag itself.
  const r = parseArgs(['--quote', 'm-abc', '--as', 'iris'])
  assert.deepEqual(r.flags, { quote: 'm-abc', as: 'iris' })
  assert.deepEqual(r.positional, [])
})

test('parseArgs: single dash stays positional; triple dash IS parsed as a flag (-weird)', () => {
  // The dispatcher uses `args[0].startsWith('--')`:
  //   `-as`     → positional (starts with single `-`)
  //   `---weird` → flag with key=`-weird` (startsWith `--` is true; key
  //                strips the leading `--` and keeps the third `-`)
  // Pinning this behaviour so a future refactor either preserves it
  // or removes the test deliberately.
  const r = parseArgs(['-as', 'foo', '---weird'])
  assert.deepEqual(r.positional, ['-as', 'foo'])
  assert.deepEqual(r.flags, { '-weird': true })
})

test('parseArgs: bare `--` ends flag parsing (POSIX end-of-flags)', () => {
  // This used to parse as a zero-length-key flag (`flags[''] = <next token>`),
  // which swallowed the token after it. The BYOA shim now uses `--` to hand
  // over --file/--stdin content, so the POSIX meaning is the one that counts.
  const r = parseArgs(['--', 'positional-arg'])
  assert.equal(r.flags[''], undefined)
  assert.deepEqual(r.positional, ['positional-arg'])
})

test('parseArgs: --key value where value contains spaces is fine — argv is already split', () => {
  // argv tokens are already split by the shell. A "value with spaces"
  // arrives as ONE element in the argv array because the shell handled
  // the quoting. So we just consume it.
  const r = parseArgs(['--body', 'hello world with spaces', '--as', 'iris'])
  assert.equal(r.flags.body, 'hello world with spaces')
  assert.equal(r.flags.as, 'iris')
})

test('parseArgs: number-looking positional stays a string', () => {
  // No type coercion. Everything is string-or-boolean.
  const r = parseArgs(['kanban', 'card', '42'])
  assert.deepEqual(r.positional, ['kanban', 'card', '42'])
})

// ── unescapeChat ─────────────────────────────────────────────────────────

test('unescapeChat: \\n becomes a real newline', () => {
  assert.equal(unescapeChat('hello\\nworld'), 'hello\nworld')
})

test('unescapeChat: \\t becomes a real tab', () => {
  assert.equal(unescapeChat('a\\tb'), 'a\tb')
})

test('unescapeChat: \\r becomes a real CR', () => {
  assert.equal(unescapeChat('a\\rb'), 'a\rb')
})

test('unescapeChat: \\\\ becomes a single backslash', () => {
  // Important for path-bearing bodies — `C:\\Users` (literal) →
  // `C:\Users` (rendered).
  assert.equal(unescapeChat('C:\\\\Users'), 'C:\\Users')
})

test("unescapeChat: \\' becomes a real apostrophe", () => {
  assert.equal(unescapeChat("it\\'s done"), "it's done")
})

test('unescapeChat: \\" becomes a real double quote', () => {
  assert.equal(unescapeChat('say \\"hi\\"'), 'say "hi"')
})

test('unescapeChat: unknown escape sequences are LEFT ALONE (not silently mangled)', () => {
  // `\z` is meaningless; we keep the backslash so the body doesn't
  // mysteriously drop characters the model emitted intentionally.
  assert.equal(unescapeChat('weird\\zcase'), 'weird\\zcase')
  // Windows path \Users still survives as-is.
  assert.equal(unescapeChat('C:\\Users\\foo'), 'C:\\Users\\foo')
})

test('unescapeChat: empty string', () => {
  assert.equal(unescapeChat(''), '')
})

test('unescapeChat: a string with no escapes is returned unchanged', () => {
  const s = 'just plain prose with 中文 and emoji 🌟'
  assert.equal(unescapeChat(s), s)
})

test('unescapeChat: multiple consecutive escapes', () => {
  // `\n\n` → two newlines. The replace is non-greedy per pair.
  assert.equal(unescapeChat('a\\n\\nb'), 'a\n\nb')
})

test('unescapeChat: a lone trailing backslash stays as-is', () => {
  // No following char to escape — the regex won't match, so the
  // backslash survives. This is fine.
  assert.equal(unescapeChat('foo\\'), 'foo\\')
})

// ── tokenize ─────────────────────────────────────────────────────────────

test('tokenize: simple whitespace-separated tokens', () => {
  assert.deepEqual(tokenize('cumora kanban ls'), ['cumora', 'kanban', 'ls'])
})

test('tokenize: collapses runs of whitespace', () => {
  assert.deepEqual(tokenize('cumora   kanban\t ls'), ['cumora', 'kanban', 'ls'])
})

test('tokenize: single-quoted body keeps its spaces as ONE token', () => {
  // Production shape: `cumora reply <convo> '<body with spaces>'`.
  // The body is one token, not three.
  assert.deepEqual(
    tokenize(`cumora reply convo-1 'hello world from iris'`),
    ['cumora', 'reply', 'convo-1', 'hello world from iris'],
  )
})

test('tokenize: double-quoted token keeps its spaces', () => {
  assert.deepEqual(
    tokenize(`cumora reply convo-1 "hello world"`),
    ['cumora', 'reply', 'convo-1', 'hello world'],
  )
})

test('tokenize: nested single quotes inside double-quoted body are preserved literally', () => {
  // `"it's done"` → `it's done`. The inner `'` does NOT close a quote
  // context because we're inside `"…"`. Matches bash semantics.
  assert.deepEqual(
    tokenize(`cumora reply convo-1 "it's done"`),
    ['cumora', 'reply', 'convo-1', "it's done"],
  )
})

test('tokenize: empty input returns empty array', () => {
  assert.deepEqual(tokenize(''), [])
})

test('tokenize: whitespace-only input returns empty array', () => {
  assert.deepEqual(tokenize('   \t  '), [])
})

test('tokenize: a single bare token at the end of the line', () => {
  assert.deepEqual(tokenize('cumora'), ['cumora'])
})

test('tokenize: quote characters themselves are stripped (not included in token)', () => {
  // The opening `'` doesn't add to the buffer; only the contents do.
  assert.deepEqual(tokenize(`'abc'`), ['abc'])
  assert.deepEqual(tokenize(`"def"`), ['def'])
})

test('tokenize: unterminated quote consumes everything to EOL into one token', () => {
  // Bash would error; we silently treat the trailing chars as part
  // of the quoted token. Pinning current behaviour so a future fix
  // (e.g. surface a parse error) can land deliberately.
  assert.deepEqual(tokenize(`cumora reply 'unterminated body`), ['cumora', 'reply', 'unterminated body'])
})

test('tokenize: tab separator behaves like a space', () => {
  assert.deepEqual(tokenize('a\tb\tc'), ['a', 'b', 'c'])
})

// ── `--` end-of-flags (the BYOA --file / --stdin body path) ──────────────────
// The shim reads --file/--stdin content locally and appends it after a POSIX
// `--`. Before that marker existed the content was spliced in as a plain
// positional, so a body starting with `---` parsed as a flag and the reply was
// silently never posted.

test('parseArgs: `--` ends flag parsing; a `--`-leading body stays positional', () => {
  const r = parseArgs(['convo-1', '--', '--- a/src/foo.ts\n+++ b/src/foo.ts'])
  assert.deepEqual(r.positional, ['convo-1', '--- a/src/foo.ts\n+++ b/src/foo.ts'])
  assert.deepEqual(r.flags, {})
  assert.equal(r.literalFrom, 1)
})

test('parseArgs: flags BEFORE `--` are still parsed', () => {
  // Real shape: cumora reply <convo> --quote <id> -- <file body>
  const r = parseArgs(['convo-1', '--quote', 'm-abc', '--', '---\ntitle: Status\n---'])
  assert.deepEqual(r.positional, ['convo-1', '---\ntitle: Status\n---'])
  assert.deepEqual(r.flags, { quote: 'm-abc' })
  assert.equal(r.literalFrom, 1)
})

test('parseArgs: a flag-looking token AFTER `--` is not a flag', () => {
  const r = parseArgs(['convo-1', '--', '--json'])
  assert.deepEqual(r.positional, ['convo-1', '--json'])
  assert.deepEqual(r.flags, {})
})

test('parseArgs: no `--` leaves literalFrom undefined', () => {
  const r = parseArgs(['convo-1', 'hello'])
  assert.equal(r.literalFrom, undefined)
})

// ── joinBodyArgs ─────────────────────────────────────────────────────────────

test('joinBodyArgs: a shell-quoted body still gets escapes expanded', () => {
  // The bash tool wraps the body in single quotes, so `\n` arrives literal.
  const r = parseArgs(['convo-1', 'line one\\nline two'])
  assert.equal(joinBodyArgs(r, 1), 'line one\nline two')
})

test('joinBodyArgs: a body after `--` is taken verbatim, escapes intact', () => {
  // --file content never passed through a shell; expanding `\n` here would
  // break the code snippets that flag exists to carry.
  const src = 'console.log("a\\nb");'
  const r = parseArgs(['convo-1', '--', src])
  assert.equal(joinBodyArgs(r, 1), src)
})

test('joinBodyArgs: a verbatim body keeps Windows-style backslashes', () => {
  const src = 'see C:\\\\Users\\\\dev for the build'
  const r = parseArgs(['convo-1', '--', src])
  assert.equal(joinBodyArgs(r, 1), src)
})

test('joinBodyArgs: joins multiple shell positionals with a space', () => {
  const r = parseArgs(['convo-1', 'hello', 'world'])
  assert.equal(joinBodyArgs(r, 1), 'hello world')
})
