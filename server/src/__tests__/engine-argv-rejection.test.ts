/**
 * An engine that rejects one of Cumora's own flags failed BEFORE doing any
 * work, and the fix is a CLI update — not signing in, not waiting out a rate
 * limit. The doctor has to say so, and the raw output actively hides it.
 *
 * Every fixture below is the real wording of the real binary, captured by
 * feeding each CLI a flag it does not have.
 *
 * Run: node --import tsx --test server/src/__tests__/engine-argv-rejection.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { argvRejection } from '../agents/computer/engine.js'

const ESC = '\u001b'

// `gemini -o stream-json` against 0.1.15: the whole help goes to stderr and the
// cause is the LAST line. This is why a first-N-characters preview is useless
// here — the banner fills the budget and the reason is cut off the end.
const OLD_GEMINI = [
  'gemini [options]',
  '',
  'Gemini CLI - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
  '',
  'Options:',
  '  -m, --model                     Model  [string] [default: "gemini-2.5-pro"]',
  '  -p, --prompt                    Prompt. Appended to input on stdin (if any).  [string]',
  '  -y, --yolo                      Automatically accept all actions?  [boolean] [default: false]',
  '      --proxy                     Proxy for gemini client, like schema://user:password@host:port  [string]',
  '  -v, --version                   Show version number  [boolean]',
  '  -h, --help                      Show help  [boolean]',
  '',
  'Unknown argument: o',
].join('\n')

test('the cause is found below a full help dump', () => {
  assert.equal(argvRejection(OLD_GEMINI), 'Unknown argument: o')
})

test('every engine Cumora drives is recognized in its own wording', () => {
  for (const [raw, expected] of [
    // claude and cursor-agent (commander)
    ["error: unknown option '--output-format'", "unknown option '--output-format'"],
    // codex (clap)
    ["error: unexpected argument '--output-format' found", "unexpected argument '--output-format' found"],
    // yargs, plural form
    ['Unknown arguments: o, output-format', 'Unknown arguments: o, output-format'],
  ] as const) {
    assert.equal(argvRejection(raw), expected, raw)
  }
})

test('the failures that are NOT a version problem stay unmatched', () => {
  // These have their own remedies, and mislabelling them sends the operator off
  // to reinstall a CLI that was fine.
  for (const raw of [
    "error: You've hit your usage limit. Try again in 3 hours.",
    'Error: not logged in. Run `claude login`.',
    'API key not valid. Please pass a valid API key.',
    'error: connection reset by peer',
    'process exited with code 137',
    '',
  ]) {
    assert.equal(argvRejection(raw), null, raw)
  }
})

test('ANSI colouring does not hide the line', () => {
  assert.equal(argvRejection(`${ESC}[31mUnknown argument: o${ESC}[0m`), 'Unknown argument: o')
})

test('a CRLF stream is handled', () => {
  assert.equal(argvRejection('banner\r\nUnknown argument: o\r\n'), 'Unknown argument: o')
})

test('the line is bounded so one long argv cannot flood the doctor', () => {
  const long = `Unknown argument: ${'x'.repeat(500)}`
  const got = argvRejection(long)
  assert.ok(got && got.length <= 120)
})
