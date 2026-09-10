/**
 * Pod-safe slice of the tool surface — types, the LLM tool-schema, and
 * implementations that touch only the local filesystem / external HTTP, plus
 * protocol-only state signals (no Postgres, no Redis).
 *
 * Imported by both:
 *   - tools.ts        (full server-side executor, adds tool_calls logging
 *                      and the DB-touching tools tDmWith / tPullGroup /
 *                      tReact / tPalette)
 *   - runtime/pod-tools.ts (lean pod-side executor — only what runs in
 *                      an agent-computer pod)
 *
 * Splitting these apart keeps esbuild from dragging pg + the server-
 * side tool implementations into the bundle. The pod doesn't have DB
 * credentials and shouldn't bundle the code that needs them.
 */
import type { FunctionTool } from 'openai/resources/responses/responses'
import { NATIVE_TOOL_DEFS } from './runtime/native-tools.js'
import type { FsNamespace } from './runtime/fs-namespace.js'
import {
  cliResultHasReplySideEffect,
  cliResultSideEffects,
  cliResultSideEffectChannelUnreliable,
  parseCliSideEffectsJsonlDetailed,
  parseCliSideEffectsWriteFailureMarker,
  type CliSideEffect,
} from './cli-result.js'

export type { CliSideEffect } from './cli-result.js'

export interface ToolResult {
  ok: boolean
  output: unknown
  display: { name: string; arg: string; status: string; detail: string; icon?: string }
  error?: string
  durationMs: number
  /** Set to `true` when the tool was cancelled mid-run by an external
   *  abort signal — currently only fired when a user steer arrives
   *  during a long-running tool call. turn.ts's hop loop branches on
   *  this to drain the steer immediately and skip the usual
   *  retry-loop nudges (the tool wasn't broken, the user just changed
   *  topic). Partial stdout captured before the kill is preserved in
   *  `output.stdout` so the model can see how far the tool got. */
  aborted?: boolean
}

export const TURN_STATUS_VALUES = ['done', 'continue', 'needs_clarification', 'blocked', 'waiting'] as const
export type TurnStatusValue = typeof TURN_STATUS_VALUES[number]
export const ASSISTANT_TEXT_ACTIONS = ['none', 'reply', 'drop'] as const
export type AssistantTextAction = typeof ASSISTANT_TEXT_ACTIONS[number]

export interface TurnStatusOutput {
  status: TurnStatusValue
  reason: string
  nextStep: string
  assistantTextAction: AssistantTextAction
  replyConversationId: string | null
}

function isTurnStatusValue(value: unknown): value is TurnStatusValue {
  return typeof value === 'string' && (TURN_STATUS_VALUES as readonly string[]).includes(value)
}

function isAssistantTextAction(value: unknown): value is AssistantTextAction {
  return typeof value === 'string' && (ASSISTANT_TEXT_ACTIONS as readonly string[]).includes(value)
}

/**
 * Tool definitions for the OpenAI Responses API.
 *
 * World-changing capabilities (reply, react, image generation, docs,
 * kanban, email, private memory, etc.) remain subcommands of the `cumora`
 * CLI on PATH via bash. `set_turn_status` is the one protocol tool: it
 * declares the model's own completion state so the runtime does not have
 * to infer task state from silence.
 */
export const TOOL_DEFS_RESPONSES: FunctionTool[] = [
  {
    type: 'function',
    name: 'bash',
    description: `Run a real bash command (\`bash -c\`). Use this for world actions and private workspace operations; every capability is a subcommand of the \`cumora\` CLI which is on PATH and runs as you (auto --as).

  # introspect the world
  cumora whoami
  cumora groups | cumora conversations | cumora directs
  cumora members <convo_id>
  cumora messages <convo_id> --tail 20
  cumora search "<query>"
  cumora participants

  # your private state (persists across all conversations)
  cumora memory list
  cumora memory note "Yetone prefers warm palettes" --about yetone --kind preference
  cumora workspace ls
  cumora workspace read drafts/v3.md
  cumora workspace write drafts/v3.md "# Hero v3 ..."
  cumora workspace edit drafts/v3.md "old text" "new text"
  cumora workspace grep "warm" -i
  cumora tasks list --status open
  cumora tasks add "Send hero v4 tokens"
  cumora log

  # ACTIONS — these write to the world, not just your private state
  cumora dm <partner_id> <topic> <opening>
  cumora pull-group "<title>" --members a,b,c --reason "..." --say "..."
  cumora react <message_id> <emoji>             # toggle

  # KANBAN — the same boards humans see in the Boards view. Cards can
  # be assigned to humans OR to other agents (you're a first-class
  # assignee). @-mention any id in title/description/comments and that
  # participant gets pinged.
  cumora kanban ls
  cumora kanban show <board_id>
  cumora kanban create "<title>" [--description "..."]
  cumora kanban rename <board_id> --title "..." [--description "..."]
  cumora kanban columns <board_id>
  cumora kanban add-column <board_id> "<title>"
  cumora kanban edit-column <board_id> <column_id> [--title "..."] [--position N]
  cumora kanban delete-column <board_id> <column_id>
  cumora kanban mentions                       # NEW kanban @-mentions of YOU since last check
  cumora card ls <board_id>
  cumora card show <card_id>
  cumora card add <board_id> "<title>" --column <col_id> [--description "..."] [--assign <id>]
  cumora card move <card_id> --to <column_id>
  cumora card assign <card_id> <participant_id|null>
  cumora card rename <card_id> --title "..." [--description "..."]
  cumora card comment <card_id> "<body>"
  cumora card delete-comment <card_id> <comment_id>
  cumora card delete <card_id>

  # COLLABORATIVE DOCS — humans + agents share the same live canvas. Edits
  # propagate via CRDT, so a human watching the doc sees your insertions
  # appear character-by-character (with your name on the awareness chip).
  # Use these when you want to draft long-form prose, a spec, a plan, or
  # any artifact a teammate is going to read or co-edit. Cheaper than
  # spamming chat with a 40-line message.
  cumora doc ls                                       # every doc in the workspace
  cumora doc create "<title>" [--body "..."]          # new doc, optionally pre-filled
  cumora doc read <doc_id>                            # current text body (plain)
  cumora doc append <doc_id> "<text>"                 # append paragraph(s) at end
  cumora doc prepend <doc_id> "<text>"                # paragraph(s) at the top
  cumora doc image <doc_id> <url> [--alt "..."]
    [--at end|start | --replace "<snippet>" | --after "<snippet>" | --before "<snippet>"]
                                                       # insert an illustration. USE THIS instead of
                                                       # appending an ![alt](url) markdown block —
                                                       # presigned attachment URLs wrap mid-emit
                                                       # and the markdown form silently degrades.
                                                       # --replace swaps a block containing the
                                                       # snippet (use it to fix already-broken
                                                       # markdown image lines); --after/--before
                                                       # position the image relative to that block.
                                                       # An anchored mode that misses is a HARD
                                                       # error — no fallback insertion.
  cumora doc image-delete <doc_id> [--src "<url>" | --src-contains "<substr>" | --alt "<text>"]
                                                       # delete image blocks from a doc by src or
                                                       # alt match. Use to clean up duplicate or
                                                       # unwanted illustrations.
  cumora doc replace <doc_id> --find "..." --replace "..."   # first match
  cumora doc rename <doc_id> "<title>"

  cumora palette "<brief>"

  # WEB — drive a real Chromium running INSIDE your pod, with login
  # state that persists across your pod restarts (cookies / IndexedDB
  # live on a per-agent PVC). Two layers:
  #
  # Layer 1 — quick ergonomics for the common cases:
  #   cumora-web search "<query>" [--limit N]   # DuckDuckGo, no captcha
  #   cumora-web read <url>                      # render + extract main text
  #
  # Layer 2 — full OpenCLI surface for anything else (click, fill, multi-
  # step flows, scraping specific elements, sites that need your login).
  # The session id is always your agent id; the browser stays around
  # across calls in the same pod lifetime.
  #
  #   opencli browser "$CUMORA_AGENT_ID" open <url>
  #   opencli browser "$CUMORA_AGENT_ID" state                    # current URL + title
  #   opencli browser "$CUMORA_AGENT_ID" get text --selector 'main'
  #   opencli browser "$CUMORA_AGENT_ID" click --selector '#submit'
  #   opencli browser "$CUMORA_AGENT_ID" type --selector 'input[name=q]' --text "..."
  #   opencli browser "$CUMORA_AGENT_ID" fill --selector 'form' --data '{"q":"..."}'
  #   opencli browser "$CUMORA_AGENT_ID" wait --selector '.result'
  #   opencli browser "$CUMORA_AGENT_ID" screenshot --output /tmp/page.png
  #
  # 100+ built-in adapters also work without writing selectors:
  #   opencli hackernews top --limit 5
  #   opencli bilibili hot --limit 5
  #   opencli twitter trending      # only if you're logged in to twitter
  #   opencli list                  # see every adapter the image ships with
  #
  # Login: when a site requires sign-in, the agent's Chromium DOES NOT
  # have a way for you to type credentials. Tell the user; they can drive
  # the agent's browser once via a remote-control surface (when that
  # ships). For now, public / token-based sites only.

  # POLLS — lightweight votes anyone (you OR a human) can run inside a
  # conversation. You can both create polls AND cast votes on them.
  #
  # A poll arriving in your inbox is BINARY: either vote, or stay silent.
  # There are exactly two acceptable outcomes — never anything in between.
  #
  # Default expectation: VOTE. You have a persona — a designer prefers
  # certain colors; a PM has opinions on roadmap trade-offs; an engineer
  # has gut calls on architecture choices. Even on light social polls
  # ("favorite pet / color / food"), pick what's consistent with who you
  # are. Participating IS being a teammate. Silence is the exception,
  # not the default — reserve it for cases where you genuinely have no
  # in-character answer.
  #
  # Acceptable outcome A — VOTE (the default).
  #   Conditions: one of the LISTED options is plausibly your answer in
  #   character. Light polls count — your persona can have favorite
  #   pets even if it doesn't have a body to keep them in.
  #   Action: run "cumora poll vote <message_id> <option_id>" and DONE.
  #   The vote IS your response. Do NOT also send a "cumora reply".
  #
  # Acceptable outcome B — SILENT.
  #   Conditions: none of the listed options fits your persona at all
  #   (e.g. a poll about a meeting time when you have no calendar), or
  #   the question is genuinely outside your scope.
  #   Action: do NOTHING for this message. No reply, no vote, no react.
  #   Just "cumora ack" and move on.
  #
  # Hard prohibitions — these are judged as failures, no exceptions:
  #   - Replying with prose without voting. If you're engaged enough to
  #     type, you're engaged enough to commit. Reply-without-vote means
  #     you've made noise without contributing to the actual signal the
  #     author asked for.
  #   - Voting AND replying with reasoning on top. The tally already
  #     captures who picked what. Prose on top is noise, and if the
  #     reasoning contradicts your pick it's actively confusing.
  #   - Replying with an option that isn't listed ("how about turtles?").
  #     The author scoped the question deliberately. Drive-by suggestions
  #     belong in a fresh message AFTER the poll closes, not on top of
  #     someone else's vote.
  #
  # Picking when uncertain:
  #   - First option is NOT the safe default — pick the one your persona
  #     actually leans toward, however slightly.
  #   - Agree with peers when you genuinely agree. Don't disagree just
  #     for variety, and don't agree just to fit in either. Read the
  #     option, ask what your character would pick, vote that.
  #
  # Commands:
  cumora poll create <convo_id> "<question>" "<opt1>" "<opt2>" [...] [--mode single|multi] [--expires-in <minutes>]
  cumora poll vote <message_id> <option_id>[,<option_id>...]   # multi-choice: comma-separated. --clear retracts.
  cumora poll show <message_id>                                # current tallies + your vote
  cumora poll close <message_id>                               # only the original author

  # CONTACTS — workspace + email roster (use BEFORE assuming you know a name)
  cumora contacts [<query>]                        # every agent / human / external mail correspondent
                                                   # in this workspace. With a query, substring-
                                                   # matches name/id/email. If no match: REPLY to
                                                   # the user asking for the address — do NOT
                                                   # silently skip their request.

  # EMAIL — real external mail (you have your own address)
  cumora email whoami                              # your address
  cumora email contacts [<query>]                  # alias for the above (email-namespaced)
  cumora email inbox [--unread] [--limit N]        # your email threads
  cumora email show <conversation_id>              # full thread
  cumora email send --to <addr|id>[,...] [--cc ...] --subject "..." --body "..."
  cumora email reply <message_id> --body "..." [--cc ...]

  cumora help                                    # full reference

You can pipe, grep, redirect — it's a real shell. Output is captured (stdout+stderr, exit code).`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'shell command line, e.g. "cumora groups" or "cumora messages aurora-launch --tail 5 | grep bundle". cwd is your /workspace/ — use relative paths (e.g. `cat memory/preference/abc.md`).' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'set_turn_status',
    description: `Declare your current turn state. You must call this before you intentionally stop a turn, and after important milestones. This is a protocol signal to the runtime, not a chat message.

Use:
- status="continue" when you have only acknowledged, started work, or still need another tool/action.
- status="done" only after the user's request has been meaningfully handled, or after you correctly chose silence because there is nothing to do.
- status="needs_clarification" when the next step is to ask the user a concrete question; then continue and actually ask it with cumora reply.
- status="blocked" when you cannot complete the task; then continue and report the clear failure with cumora reply unless the user-visible failure was already sent.
- status="waiting" only when you have taken an action and are genuinely waiting for an external response/event.

If you previously emitted plain assistant text in this turn, users did not see it. Prefer sending it yourself with cumora reply. Only use assistant_text="reply" when you intentionally want the runtime to relay that exact draft to reply_conversation_id; use assistant_text="drop" when the draft should not be user-visible.`,
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: [...TURN_STATUS_VALUES] },
        reason: { type: 'string', description: 'Concise factual reason for this status.' },
        next_step: { type: 'string', description: 'The concrete next action, or empty when status is done.' },
        assistant_text: {
          type: 'string',
          enum: [...ASSISTANT_TEXT_ACTIONS],
          description: 'What to do with any plain assistant text draft from this turn: none, reply, or drop.',
        },
        reply_conversation_id: {
          type: 'string',
          description: 'Conversation id for assistant_text="reply". Leave empty otherwise.',
        },
      },
      required: ['status', 'reason', 'next_step'],
      additionalProperties: false,
    },
    strict: false,
  },
  ...NATIVE_TOOL_DEFS,
]

export function tSetTurnStatus(args: Record<string, unknown>): ToolResult {
  const t0 = Date.now()
  const rawStatus = args.status
  if (!isTurnStatusValue(rawStatus)) {
    return {
      ok: false,
      output: null,
      error: `invalid turn status: ${String(rawStatus)}`,
      durationMs: Date.now() - t0,
      display: {
        name: 'set_turn_status',
        arg: String(rawStatus ?? ''),
        status: 'invalid',
        detail: `status must be one of: ${TURN_STATUS_VALUES.join(', ')}`,
      },
    }
  }
  const reason = String(args.reason ?? '').trim().slice(0, 800)
  const nextStep = String(args.next_step ?? args.nextStep ?? '').trim().slice(0, 1200)
  const rawAssistantTextAction = args.assistant_text ?? args.assistantText ?? 'none'
  const assistantTextAction = isAssistantTextAction(rawAssistantTextAction) ? rawAssistantTextAction : 'none'
  const replyConversationId = String(args.reply_conversation_id ?? args.replyConversationId ?? '').trim() || null
  if (!reason) {
    return {
      ok: false,
      output: null,
      error: 'reason required',
      durationMs: Date.now() - t0,
      display: {
        name: 'set_turn_status',
        arg: rawStatus,
        status: 'invalid',
        detail: 'reason is required so the runtime can audit why the turn stopped or continued',
      },
    }
  }
  if (assistantTextAction === 'reply' && !replyConversationId) {
    return {
      ok: false,
      output: null,
      error: 'reply_conversation_id required when assistant_text is reply',
      durationMs: Date.now() - t0,
      display: {
        name: 'set_turn_status',
        arg: rawStatus,
        status: 'invalid',
        detail: 'assistant_text="reply" requires reply_conversation_id',
      },
    }
  }
  const output: TurnStatusOutput = {
    status: rawStatus,
    reason,
    nextStep,
    assistantTextAction,
    replyConversationId,
  }
  return {
    ok: true,
    output,
    durationMs: Date.now() - t0,
    display: {
      name: 'set_turn_status',
      arg: rawStatus,
      status: rawStatus,
      detail: nextStep ? `${reason}\nnext: ${nextStep}` : reason,
      icon: 'github',
    },
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function tBash(
  args: Record<string, unknown>,
  agentId: string,
  ns: FsNamespace | null,
  /** When provided + aborted mid-run, the spawned bash process is
   *  killed (SIGTERM, then SIGKILL after a 2-second grace) and the
   *  ToolResult comes back with `aborted: true`. Caller is responsible
   *  for branching on `aborted` to handle the steer flow — see
   *  turn.ts's hop loop. Already-fired signals abort the spawn
   *  immediately so we never start a process the caller has cancelled. */
  signal?: AbortSignal,
  /** The run this bash call belongs to. Reaches `cumora reply` as
   *  CUMORA_RUN_ID so the anti-monologue gate can tell "I am delivering the
   *  work I announced this turn" from "I woke up and decided to talk again".
   *  Absent for the CLI/replay/boot paths, where the gate keeps its old
   *  behaviour. */
  runId?: string,
): Promise<ToolResult> {
  const t0 = Date.now()
  const command = String(args.command ?? '').trim()
  if (!command) {
    return { ok: false, output: null, error: 'empty command', durationMs: Date.now() - t0,
      display: { name: 'bash', arg: '', status: 'error', detail: 'empty command' } }
  }
  // If the caller cancelled before we even started, short-circuit so we
  // don't pay for the spawn + namespace prep work.
  if (signal?.aborted) {
    return {
      ok: false,
      aborted: true,
      output: { stdout: '', stderr: '', exitCode: null, aborted: true },
      error: 'tool cancelled by steer before start',
      durationMs: Date.now() - t0,
      display: { name: 'bash', arg: command.length > 70 ? command.slice(0, 70) + '…' : command, status: 'aborted', detail: 'cancelled by steer before launch' },
    }
  }

  const { spawn } = await import('node:child_process')
  const { delimiter, join } = await import('node:path')
  const { chmod, mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const repoRoot = process.cwd()
  const resultDir = await mkdtemp(join(tmpdir(), 'cumora-cli-'))
  const resultPath = join(resultDir, 'side-effects.jsonl')
  const podRuntime = process.env.CUMORA_RUNTIME_CLIENT === 'http'
  const localCumoraBin = join(repoRoot, 'bin', 'cumora')
  const localWrapperPath = join(resultDir, 'cumora')
  if (!podRuntime) {
    await writeFile(localWrapperPath, [
      '#!/bin/sh',
      'export CUMORA_CLI_IDENTITY_SOURCE=agent-bash',
      `export CUMORA_AGENT_ID=${shellSingleQuote(agentId)}`,
      'unset CUMORA_DEFAULT_AS',
      `exec ${shellSingleQuote(localCumoraBin)} "$@"`,
      '',
    ].join('\n'), 'utf8')
    await chmod(localWrapperPath, 0o755)
  }
  // Bash runs in the per-turn FS namespace (the agent's "persona
  // directory") when one's active — so the agent can `cat IDENTITY.md`,
  // `grep -r foo memory/`, etc. on real files instead of paying the
  // cost of `cumora workspace read`. When there's no namespace (CLI /
  // replay / boot path) we fall back to the repo root.
  const cwd = ns?.rootDir ?? repoRoot
  const repoBin = join(repoRoot, 'bin')
  const basePath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((p) => p && (!podRuntime ? p !== repoBin : true))
    .join(delimiter)
  const childEnv = {
    ...process.env,
    // Local agent bash gets a runtime-installed `cumora` wrapper first
    // on PATH so ordinary CLI calls run as the current agent. This is
    // a dev guard for the supported `cumora ...` path; the production
    // security boundary is the pod shim plus JWT-pinned /runtime/cli.
    PATH: `${podRuntime ? repoBin : resultDir}${delimiter}${basePath}`,
    CUMORA_AGENT: agentId,
    ...(!podRuntime
      ? {
          CUMORA_AGENT_ID: agentId,
          CUMORA_CLI_IDENTITY_SOURCE: 'agent-bash',
          CUMORA_DEFAULT_AS: '',
        }
      : {}),
    CUMORA_PERSONA_DIR: ns?.rootDir ?? '',
    CUMORA_CLI_RESULT_PATH: resultPath,
    ...(runId ? { CUMORA_RUN_ID: runId } : {}),
  }

  const heavyOp = /--generate-image|web-(search|read)|skills\s+(install|search)/i.test(command)
  const timeoutMs = heavyOp ? 180_000 : 60_000

  let abortedByCaller = false
  const result = await new Promise<{ stdout: string; stderr: string; code: number; signal: NodeJS.Signals | null }>((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, env: childEnv, timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('close', (code, signal) => resolve({ stdout, stderr, code: code ?? 0, signal: signal ?? null }))
    child.on('error', (err) => resolve({ stdout, stderr: stderr + String(err), code: 127, signal: null }))
    // Caller-supplied abort (steer interrupt). Two-phase kill mirrors
    // the docker/k8s shutdown pattern: SIGTERM first to let the shell
    // and any child of bash flush their buffers / clean up temp files,
    // then SIGKILL 2s later if it's still alive. We can't pass the
    // signal to spawn directly (it'd race with the spawn timeout
    // handling), so we hand-roll it.
    if (signal) {
      const onAbort = () => {
        abortedByCaller = true
        try {
          if (child.pid) child.kill('SIGTERM')
        } catch { /* race with close — ignore */ }
        // 2 second grace, then escalate. Tracked separately so we don't
        // leak a timer if the child closes cleanly after SIGTERM.
        const killer = setTimeout(() => {
          try {
            if (child.pid && !child.killed) child.kill('SIGKILL')
          } catch { /* ignore */ }
        }, 2000)
        child.on('close', () => clearTimeout(killer))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  let sideEffects: CliSideEffect[] = []
  let sideEffectsMalformedLineCount = 0
  let sideEffectsReadFailed = false
  let sideEffectsWriteFailed = false
  try {
    const parsed = parseCliSideEffectsJsonlDetailed(await readFile(resultPath, 'utf8'))
    sideEffects = parsed.sideEffects
    sideEffectsMalformedLineCount = parsed.malformedLineCount
  } catch (err) {
    if (!err || typeof err !== 'object' || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      sideEffectsReadFailed = true
    }
  } finally {
    await rm(resultDir, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
  const fallbackSideEffects = parseCliSideEffectsWriteFailureMarker(result.stderr)
  if (fallbackSideEffects.length > 0) {
    sideEffectsWriteFailed = true
    if (sideEffects.length === 0) sideEffects = fallbackSideEffects
  }

  if (result.signal === 'SIGTERM' && result.code !== 0 && !abortedByCaller) {
    result.stderr = (result.stderr || '') +
      `\n[bash] killed after ${Math.round(timeoutMs / 1000)}s — operation exceeded the per-command timeout.`
  }
  if (abortedByCaller) {
    return {
      ok: false,
      aborted: true,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        aborted: true,
        // Hint to the LLM: the abort came from a steer, so the user
        // probably wants attention before we re-try the same command.
        // Surface this as a stable marker the prompt can reference.
        abortReason: 'steer_interrupt',
      },
      durationMs: Date.now() - t0,
      display: {
        name: 'bash',
        arg: command.length > 70 ? command.slice(0, 70) + '…' : command,
        status: 'aborted · steer',
        detail: ((result.stdout || '') + (result.stderr ? '\n--- stderr ---\n' + result.stderr : '')).trim().slice(0, 1400) || '(killed before output)',
        icon: 'github',
      },
      error: 'bash cancelled by user steer mid-run',
    }
  }

  const ok = result.code === 0
  const combined = (result.stdout + (result.stderr ? '\n--- stderr ---\n' + result.stderr : '')).trim()
  const output: Record<string, unknown> = { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  if (sideEffects.length > 0) output.sideEffects = sideEffects
  if (sideEffectsMalformedLineCount > 0) {
    output.sideEffectsParseFailed = true
    output.sideEffectsMalformedLineCount = sideEffectsMalformedLineCount
  }
  if (sideEffectsReadFailed) output.sideEffectsReadFailed = true
  if (sideEffectsWriteFailed) output.sideEffectsWriteFailed = true
  return {
    ok,
    output,
    durationMs: Date.now() - t0,
    display: {
      name: 'bash',
      arg: command.length > 70 ? command.slice(0, 70) + '…' : command,
      status: ok ? `ok · ${Date.now() - t0}ms` : `exit ${result.code}`,
      detail: combined.length > 1400 ? combined.slice(0, 1400) + '\n…' : (combined || '(no output)'),
      icon: 'github',
    },
    error: ok ? undefined : combined.slice(0, 400),
  }
}

export function bashOutputHasReplySideEffect(output: unknown): boolean {
  return cliResultHasReplySideEffect(output)
}

export function bashOutputSideEffects(output: unknown): CliSideEffect[] {
  return cliResultSideEffects(output)
}

export function bashOutputSideEffectChannelUnreliable(output: unknown): boolean {
  return cliResultSideEffectChannelUnreliable(output)
}
