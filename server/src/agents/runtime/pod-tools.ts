/**
 * Pod-side tool dispatcher — what `runAgentTurn` calls when the LLM
 * returns a tool call.
 *
 * The LLM's tool surface (`TOOL_DEFS_RESPONSES` in tools.ts) only
 * exposes pod-local tools:
 *   - bash / shell     — runs in the pod's filesystem
 *   - set_turn_status  — declares the model's completion state
 *   - read_file        — pod FS namespace
 *   - write_file       — pod FS namespace
 *   - edit_file        — pod FS namespace
 *
 * Every "agent acting in the world" capability (react / dm_with /
 * pull_group / palette / send_message …) the LLM invokes via bash +
 * the `cumora` shim. Browser work goes through the in-pod `opencli`
 * binary (Chromium + Xvfb live in the agent-computer image), so it
 * runs via bash too. So this dispatcher only needs the four pod-local
 * cases.
 *
 * No DB calls. Observability for these tool invocations is captured
 * by the agent_events trail (which flows through /runtime/cli too).
 * Skipping the legacy `tool_calls` row per-invocation is intentional:
 * it had a pool.query that leaked the DB into the pod bundle, and
 * server-side actions (via cumora CLI) still log their own tool_calls
 * row through the existing executeTool path in tools.ts.
 */
import { tBash, tSetTurnStatus } from '../tools-shared.js'
import {
  NATIVE_TOOL_DEFS,
  tReadFile,
  tWriteFile,
  tEditFile,
} from './native-tools.js'
import type { FsNamespace } from './fs-namespace.js'
import type { ToolResult } from '../tools-shared.js'

export { NATIVE_TOOL_DEFS }
export type { ToolResult }

/** Re-export the LLM tool schema. Pod-bundle only references this,
 *  so the rest of tools.ts (server-side cases, tool_calls logging,
 *  OpenAI Responses client wiring) never makes it into the bundle. */
export { TOOL_DEFS_RESPONSES } from '../tools-shared.js'

interface DispatchArgs {
  agentId: string
  name: string
  argsJson: string
  ns?: FsNamespace | null
  /** Optional cancellation signal. Only `bash` honors it today —
   *  fast tools (set_turn_status / read_file / write_file / edit_file)
   *  finish in microseconds, so wiring an abort into them adds noise
   *  with no payoff. turn.ts uses this to interrupt a long-running
   *  bash when a user steer arrives mid-tool. */
  signal?: AbortSignal
  /** The run this tool call belongs to. Only `bash` uses it, to reach
   *  `cumora reply` as CUMORA_RUN_ID — see the anti-monologue gate. */
  runId?: string
}

function noNamespace(name: string, _wanted: string): ToolResult {
  return {
    ok: false,
    output: null,
    error: 'native FS tool requires a per-turn namespace',
    durationMs: 0,
    display: { name, arg: '', status: 'no-namespace', detail: 'this should only happen in CLI replay paths' },
  }
}

/** Test-only override. When set, every {@link executePodTool} call goes
 *  through this fake instead of the real dispatch (which shells out via
 *  bash → `cumora` CLI / reads the FS namespace / hits Tavily). Production
 *  code never sets this; integration tests use it to make tool execution
 *  deterministic without spinning up the per-agent FS / bash subprocess. */
let testToolOverride: ((args: DispatchArgs) => ToolResult | Promise<ToolResult>) | null = null
export function __setPodToolOverrideForTesting(fn: typeof testToolOverride): void {
  testToolOverride = fn
}

export async function executePodTool(args: DispatchArgs): Promise<ToolResult> {
  if (testToolOverride) return testToolOverride(args)
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(args.argsJson || '{}') } catch { parsed = {} }

  switch (args.name) {
    case 'shell':
    case 'bash':
      return tBash(parsed, args.agentId, args.ns ?? null, args.signal, args.runId)
    case 'set_turn_status':
      return tSetTurnStatus(parsed)
    case 'read_file':
      return args.ns ? tReadFile(parsed, args.ns) : noNamespace(args.name, 'read_file')
    case 'write_file':
      return args.ns ? tWriteFile(parsed, args.ns) : noNamespace(args.name, 'write_file')
    case 'edit_file':
      return args.ns ? tEditFile(parsed, args.ns) : noNamespace(args.name, 'edit_file')
    default:
      return {
        ok: false,
        output: null,
        error: 'unknown tool',
        durationMs: 0,
        display: { name: args.name, arg: '', status: 'unknown tool', detail: `tool not implemented in pod runtime: ${args.name}` },
      }
  }
}
