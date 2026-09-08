/**
 * The reason a turn failed has to survive the caps between the engine and the
 * operator's chat — and for two of the eight engines it did not.
 *
 * gemini and qwen print their ENTIRE --help to stderr and put the cause on the
 * last line. Every cap downstream cuts from the end: failurePreview keeps the
 * first MAX_FAILURE_CHARS, then the daemon's conciseError keeps the first 900.
 * Measured on the binaries installed here, each given one flag it does not know:
 *
 *   gemini 0.1.15   2,819 chars of output, cause at offset 2,765
 *   qwen   0.0.14   3,798 chars of output, cause at offset 3,744
 *
 * So the notice the operator received was 900 characters of option
 * documentation, truncated mid-word, with no reason in it at all — for a
 * failure whose fix is one CLI upgrade.
 *
 * salientError() has led with the rejection line since #100, and its comment
 * gives this exact argument, but only the probe and handshake paths reach it.
 * An ordinary turn goes spawnEngine -> failurePreview -> conciseError, and
 * nothing in that chain promoted anything.
 *
 * The fixtures below are the real bytes, captured by running each binary with
 * an unknown flag.
 *
 * Run: node --import tsx --test server/src/__tests__/engine-failure-preview.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { failurePreview } = await import('../agents/computer/engine.js')

/** What daemon.ts does to the string next: conciseError()'s 900-char cap. */
const VISIBLE_CAP = 900
const visible = (preview: string): string =>
  preview.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trim().slice(0, VISIBLE_CAP)

const GEMINI_0_1_15 = [
  'gemini [options]',
  '',
  'Gemini CLI - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
  '',
  'Options:',
  '  -m, --model                     Model  [string] [default: "gemini-2.5-pro"]',
  '  -p, --prompt                    Prompt. Appended to input on stdin (if any).  [string]',
  '  -i, --prompt-interactive        Execute the provided prompt and continue in interactive mode  [string]',
  '  -s, --sandbox                   Run in sandbox?  [boolean]',
  '      --sandbox-image             Sandbox image URI.  [string]',
  '  -d, --debug                     Run in debug mode?  [boolean] [default: false]',
  '  -a, --all-files                 Include ALL files in context?  [boolean] [default: false]',
  '      --all_files                 Include ALL files in context?  [deprecated: Use --all-files instead. We will be removing --all_files in the coming weeks.] [boolean] [default: false]',
  '      --show-memory-usage         Show memory usage in status bar  [boolean] [default: false]',
  '      --show_memory_usage         Show memory usage in status bar  [deprecated: Use --show-memory-usage instead. We will be removing --show_memory_usage in the coming weeks.] [boolean] [default: false]',
  '  -y, --yolo                      Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]',
  '      --telemetry                 Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.  [boolean]',
  '      --telemetry-target          Set the telemetry target (local or gcp). Overrides settings files.  [string] [choices: "local", "gcp"]',
  '      --telemetry-otlp-endpoint   Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.  [string]',
  '      --telemetry-log-prompts     Enable or disable logging of user prompts for telemetry. Overrides settings files.  [boolean]',
  '      --telemetry-outfile         Redirect all telemetry output to the specified file.  [string]',
  '  -c, --checkpointing             Enables checkpointing of file edits  [boolean] [default: false]',
  '      --experimental-acp          Starts the agent in ACP mode  [boolean]',
  '      --allowed-mcp-server-names  Allowed MCP server names  [array]',
  '  -e, --extensions                A list of extensions to use. If not provided, all extensions are used.  [array]',
  '  -l, --list-extensions           List all available extensions and exit.  [boolean]',
  '      --ide-mode                  Run in IDE mode?  [boolean]',
  '      --proxy                     Proxy for gemini client, like schema://user:password@host:port  [string]',
  '  -v, --version                   Show version number  [boolean]',
  '  -h, --help                      Show help  [boolean]',
  '',
  'Unknown arguments: cumora-bogus-flag, cumoraBogusFlag',
  '',
].join('\n')

const QWEN_0_0_14 = [
  'Usage: qwen [options] [command]',
  '',
  'Qwen Code - Launch an interactive CLI, use -p/--prompt for non-interactive mode',
  '',
  'Commands:',
  '  qwen      Launch Qwen Code  [default]',
  '  qwen mcp  Manage MCP servers',
  '',
  'Options:',
  '  -m, --model                     Model  [string]',
  '  -p, --prompt                    Prompt. Appended to input on stdin (if any).  [string]',
  '  -i, --prompt-interactive        Execute the provided prompt and continue in interactive mode  [string]',
  '  -s, --sandbox                   Run in sandbox?  [boolean]',
  '      --sandbox-image             Sandbox image URI.  [string]',
  '  -d, --debug                     Run in debug mode?  [boolean] [default: false]',
  '  -a, --all-files                 Include ALL files in context?  [boolean] [default: false]',
  '      --show-memory-usage         Show memory usage in status bar  [boolean] [default: false]',
  '  -y, --yolo                      Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]',
  '      --approval-mode             Set the approval mode: plan (plan only), default (prompt for approval), auto-edit (auto-approve edit tools), yolo (auto-approve all tools)  [string] [choices: "plan", "default", "auto-edit", "yolo"]',
  '      --telemetry                 Enable telemetry? This flag specifically controls if telemetry is sent. Other --telemetry-* flags set specific values but do not enable telemetry on their own.  [boolean]',
  '      --telemetry-target          Set the telemetry target (local or gcp). Overrides settings files.  [string] [choices: "local", "gcp"]',
  '      --telemetry-otlp-endpoint   Set the OTLP endpoint for telemetry. Overrides environment variables and settings files.  [string]',
  '      --telemetry-otlp-protocol   Set the OTLP protocol for telemetry (grpc or http). Overrides settings files.  [string] [choices: "grpc", "http"]',
  '      --telemetry-log-prompts     Enable or disable logging of user prompts for telemetry. Overrides settings files.  [boolean]',
  '      --telemetry-outfile         Redirect all telemetry output to the specified file.  [string]',
  '  -c, --checkpointing             Enables checkpointing of file edits  [boolean] [default: false]',
  '      --experimental-acp          Starts the agent in ACP mode  [boolean]',
  '      --allowed-mcp-server-names  Allowed MCP server names  [array]',
  '      --allowed-tools             Tools that are allowed to run without confirmation  [array]',
  '  -e, --extensions                A list of extensions to use. If not provided, all extensions are used.  [array]',
  '  -l, --list-extensions           List all available extensions and exit.  [boolean]',
  '      --proxy                     Proxy for qwen client, like schema://user:password@host:port  [string]',
  '      --include-directories       Additional directories to include in the workspace (comma-separated or multiple --include-directories)  [array]',
  '      --openai-logging            Enable logging of OpenAI API calls for debugging and analysis  [boolean]',
  '      --openai-api-key            OpenAI API key to use for authentication  [string]',
  '      --openai-base-url           OpenAI base URL (for custom endpoints)  [string]',
  '      --tavily-api-key            Tavily API key for web search functionality  [string]',
  '      --screen-reader             Enable screen reader mode for accessibility.  [boolean] [default: false]',
  '      --vlm-switch-mode           Default behavior when images are detected in input. Values: once (one-time switch), session (switch for entire session), persist (continue with current model). Overrides settings files.  [string] [choices: "once", "session", "persist"]',
  '  -v, --version                   Show version number  [boolean]',
  '  -h, --help                      Show help  [boolean]',
  '',
  'Unknown arguments: cumora-bogus-flag, cumoraBogusFlag',
  '',
].join('\n')

const reject = (stderr: string): string =>
  failurePreview({ exitCode: 1, signalName: null, stderr: [stderr], stdout: [] })

// ── the two engines that hid the cause ─────────────────────────────────────

test('gemini: the cause survives the cap the operator actually sees', () => {
  const seen = visible(reject(GEMINI_0_1_15))
  assert.ok(seen.length <= VISIBLE_CAP)
  assert.match(seen, /Unknown arguments: cumora-bogus-flag/)
})

test('qwen: same, from 3,744 characters in', () => {
  const seen = visible(reject(QWEN_0_0_14))
  assert.ok(seen.length <= VISIBLE_CAP)
  assert.match(seen, /Unknown arguments: cumora-bogus-flag/)
})

test('the offsets that make this necessary are real', () => {
  // If a future CLI moves its cause up front, these drop and the promotion
  // becomes a no-op rather than silently doing nothing useful.
  assert.ok(GEMINI_0_1_15.indexOf('Unknown arguments') > VISIBLE_CAP,
    'gemini fixture no longer buries the cause')
  assert.ok(QWEN_0_0_14.indexOf('Unknown arguments') > VISIBLE_CAP,
    'qwen fixture no longer buries the cause')
})

// ── and nothing else changes ───────────────────────────────────────────────

test('the full output is still there behind the promoted line', () => {
  // The banner is not discarded — whoever reads the daemon log still gets it.
  const preview = reject(GEMINI_0_1_15)
  assert.match(preview, /^process exited with code 1\nUnknown arguments: /)
  assert.match(preview, /Gemini CLI - Launch an interactive CLI/)
})

test('an ordinary failure is untouched', () => {
  // No argv rejection in it, so the promotion is a no-op and the message is
  // byte-for-byte what it was before.
  assert.equal(
    reject('Error: not logged in. Please run /login'),
    'process exited with code 1\nError: not logged in. Please run /login',
  )
})

test('an engine whose cause already fits keeps the message it had', () => {
  const seen = visible(reject("error: unknown option '--output-format'"))
  assert.equal(seen, "process exited with code 1\nunknown option '--output-format'\nerror: unknown option '--output-format'")
})

test('no output at all still reports only the exit', () => {
  assert.equal(reject(''), 'process exited with code 1')
  assert.equal(
    failurePreview({ exitCode: 0, signalName: 'SIGKILL', stderr: [], stdout: [] }),
    'process terminated by SIGKILL',
  )
})
