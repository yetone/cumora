/**
 * EngineAdapter — the pluggable "brain" for a BYOA agent.
 *
 * A BYOA agent's reasoning loop is delegated to a local CLI engine running
 * on the user's machine: Claude Code, Codex, Grok Build, Cursor Agent,
 * OpenCode, pi, Gemini CLI, Qwen Code, or Antigravity. The daemon (daemon.ts) hands
 * each wake to an adapter, which spawns the engine headlessly in the agent's
 * dedicated home directory. The engine reads its persona + memory + skills
 * from that home natively (CLAUDE.md / AGENTS.md, .claude/skills, …) and acts
 * on Cumora through a fixed MCP bridge. The historical PATH shim remains only
 * in explicitly unsandboxed compatibility mode.
 *
 * This module is intentionally standalone — only Node builtins — so the
 * daemon can run on a machine with no Cumora DB/Redis access.
 *
 * NOTE on engine flags: the exact non-interactive / permission flags differ
 * across engine versions. Claude and Codex run with fail-closed host boundaries
 * by default. Engines without a verified boundary, and opaque argv overrides,
 * require the explicit CUMORA_BYOA_ALLOW_UNSANDBOXED=1 compatibility opt-in
 * (CUMORA_CLAUDE_ARGS / CUMORA_CODEX_ARGS / CUMORA_GROK_ARGS /
 *  CUMORA_CURSOR_ARGS / CUMORA_OPENCODE_ARGS / CUMORA_PI_ARGS, space-split). Correctness of the
 * loop does not depend on the structured output — the agent acts via the
 * `cumora` tool regardless of how we parse stdout.
 */
import { type ChildProcess, execFile, execFileSync, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, delimiter as PATH_DELIMITER } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { stripLoneSurrogates } from '../text-safety.js'
import { isCustomAnthropicEndpoint, readClaudeUserSettings, withClaudeUserSettingsEnv } from './claude-user-settings.js'
import { isCliVersionAtLeast, probeEngineVersion, probeLocalEngineVersion } from './cli-version.js'
import { discoverEngineModelCatalog, type EngineModelCatalog } from './model-catalog.js'

const IS_WIN = process.platform === 'win32'

/** Every engine runs headlessly behind the daemon. On Windows, leaving
 *  `windowsHide` at Node's default (`false`) lets a console executable (or the
 *  cmd.exe needed for an npm .cmd shim) create a visible terminal even when the
 *  PowerShell watchdog itself was launched with `-WindowStyle Hidden`.
 *
 *  Keep this in the module-local spawn wrapper so persistent sessions, one-shot
 *  turns, doctor probes, and PATH probes cannot drift apart. `windowsHide` is
 *  ignored on non-Windows platforms. */
export function headlessSpawnOptions(options: SpawnOptions = {}): SpawnOptions {
  return { ...options, windowsHide: true }
}

function spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return nodeSpawn(command, args, headlessSpawnOptions(options))
}

/** Model tools may spawn descendants that outlive the CLI parent. Put every
 * engine process in its own POSIX process group, and terminate the complete
 * tree on cancellation. Windows has no process-group signal equivalent, so
 * taskkill /T supplies the platform's tree semantics. */
function spawnEngineChild(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(command, args, { ...options, detached: !IS_WIN })
}

interface EngineTerminationState {
  forceRequested: boolean
  promise: Promise<void>
}

const engineTerminations = new WeakMap<ChildProcess, EngineTerminationState>()

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClose)
      child.off('error', onClose)
      resolve(exited)
    }
    const onClose = () => finish(true)
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs)
    timer.unref?.()
    child.once('close', onClose)
    child.once('error', onClose)
  })
}

function readProcessTable(): Promise<Map<number, number>> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const table = new Map<number, number>()
      if (!err) {
        for (const line of stdout.split('\n')) {
          const match = line.trim().match(/^(\d+)\s+(\d+)$/)
          if (match) table.set(Number(match[1]), Number(match[2]))
        }
      }
      resolve(table)
    })
  })
}

function expandDescendants(tracked: Set<number>, table: ReadonlyMap<number, number>): void {
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parent] of table) {
      if (!tracked.has(pid) && tracked.has(parent)) {
        tracked.add(pid)
        changed = true
      }
    }
  }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal) } catch { /* process already exited */ }
}

function anyPidAlive(pids: ReadonlySet<number>): boolean {
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      return true
    } catch { /* process is gone */ }
  }
  return false
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) {
    try { child.kill(signal) } catch { /* already gone */ }
    return
  }
  try { process.kill(-pid, signal) }
  catch { try { child.kill(signal) } catch { /* already gone */ } }
}

async function terminateWindowsTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (!pid) return
  await new Promise<void>((resolve) => {
    execFile(
      'taskkill.exe', ['/pid', String(pid), '/t', '/f'],
      headlessSpawnOptions({ windowsHide: true }),
      (err) => {
        if (err && !childHasExited(child)) {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }
        resolve()
      },
    )
  })
  await waitForChildExit(child, 1_500)
}

async function terminatePosixTree(
  child: ChildProcess,
  state: EngineTerminationState,
): Promise<void> {
  const rootPid = child.pid
  if (!rootPid) return
  const tracked = new Set<number>([rootPid])

  // Snapshot before signalling the group. A child may deliberately call
  // setsid()/setpgid() and escape the engine's PGID while retaining the engine
  // as its parent; explicit descendant signals cover that case.
  expandDescendants(tracked, await readProcessTable())
  const initialSignal: NodeJS.Signals = state.forceRequested ? 'SIGKILL' : 'SIGTERM'
  for (const pid of [...tracked].reverse()) signalPid(pid, initialSignal)
  signalProcessGroup(child, initialSignal)

  if (!state.forceRequested) {
    await waitForChildExit(child, 1_000)
    // The engine parent may exit promptly while a detached descendant ignores
    // SIGTERM. Do not mistake the parent's close event for completion of the
    // previously discovered tree.
    if (!anyPidAlive(tracked)) return
  }

  // Re-scan before escalating. Descendants recorded in `tracked` stay targets
  // even if their parent exits and init adopts them between scans.
  expandDescendants(tracked, await readProcessTable())
  for (const pid of [...tracked].reverse()) signalPid(pid, 'SIGKILL')
  signalProcessGroup(child, 'SIGKILL')

  // A terminating process can race one final fork with the first snapshot.
  // Bounded rescans catch descendants of every still-known PID without turning
  // shutdown into an unbounded wait or signalling unrelated processes later.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    expandDescendants(tracked, await readProcessTable())
    let survivor = false
    for (const pid of tracked) {
      try {
        process.kill(pid, 0)
        survivor = true
        signalPid(pid, 'SIGKILL')
      } catch { /* process is gone */ }
    }
    if (!survivor) break
  }
  // Wait for killed PIDs to disappear from the process table (including a
  // briefly reparented zombie). `stop()` must not resolve while a known old
  // descendant can still run beside the replacement runner.
  for (let attempt = 0; attempt < 40 && anyPidAlive(tracked); attempt += 1) {
    for (const pid of tracked) signalPid(pid, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  await waitForChildExit(child, 1_500)
}

/** Terminate an engine and wait for the platform's tree operation to finish.
 * Calls are idempotent; a later force request escalates an in-progress graceful
 * stop. Runner replacement awaits this promise before reseeding model-writable
 * state or launching the next engine. */
function terminateEngineTree(child: ChildProcess, force = false): Promise<void> {
  const current = engineTerminations.get(child)
  if (current) {
    if (force) current.forceRequested = true
    return current.promise
  }
  const state: EngineTerminationState = { forceRequested: force, promise: Promise.resolve() }
  state.promise = (IS_WIN ? terminateWindowsTree(child) : terminatePosixTree(child, state))
    .catch(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    })
  engineTerminations.set(child, state)
  return state.promise
}

/** Bind an AbortSignal to one engine child and retain the exact termination
 * promise. One-shot helpers must await `wait()` before resolving an aborted
 * operation; otherwise AgentRunner's active-run barrier can finish while the
 * platform tree terminator is still working. */
function bindAbortTermination(
  child: ChildProcess,
  signal: AbortSignal,
): { dispose: () => void; wait: () => Promise<void> } {
  let termination: Promise<void> | null = null
  const onAbort = (): void => {
    if (!termination) termination = terminateEngineTree(child, true)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return {
    dispose: () => signal.removeEventListener('abort', onAbort),
    wait: () => termination ?? Promise.resolve(),
  }
}

// Optional last-resort cap on a single persistent-engine turn. DEFAULT OFF (0):
// a wall-clock timeout CANNOT tell a genuinely-hung turn from a legitimately
// long-running one (e.g. an agent running a multi-hour Bash command blocks this
// turn with no output the whole time), so a default timeout would KILL real work.
// Responsiveness during a long turn is handled by same-turn STEERING, not by
// killing the turn. Set CUMORA_TURN_TIMEOUT_MS (milliseconds) to opt into a runaway
// backstop; 0/unset = no timeout (long tasks run to completion).
const TURN_TIMEOUT_MS = Number(process.env.CUMORA_TURN_TIMEOUT_MS) || 0

// By default the Codex app-server's raw event stream (text deltas, per-item token
// + rate-limit snapshots, full item JSON) is NOT echoed to the daemon log — it's a
// fire-hose the daemon doesn't need. Set CUMORA_CODEX_VERBOSE=1 to dump it raw.
const CODEX_LOG_RAW = process.env.CUMORA_CODEX_VERBOSE === '1'

/** How to spawn a CLI bin cross-platform.
 *  - POSIX: spawn the bare bin with shell:false — unchanged, zero-risk.
 *  - Windows: engine CLIs are usually `.cmd` shims that Node CANNOT run with
 *    shell:false (CreateProcess can't execute a batch file) → "process exited with
 *    code 1". Resolve the real file on PATH and run a `.cmd`/`.bat` via
 *    shell:true. When the shell is needed,
 *    a big multi-line prompt must travel via STDIN, not argv (the shell can't carry
 *    it) → `wantsStdinPrompt`.
 *
 *  Windows + nvm-windows gotcha: global npm CLIs are shipped as an extensionless
 *  POSIX shell-shim (`#!/bin/sh` wrapper) ALONGSIDE the real `.cmd`. The old loop
 *  iterated `['', ...PATHEXT]`, hit the shim first, classified it as non-batch,
 *  and returned `shell:false` → every engine turn died with ENOENT.
 *  Fix: prefer a real `.exe`/`.cmd`/`.bat` hit; only fall back to the shim with
 *  `shell:true` when nothing else is on PATH. */
// Exported for tests; the nvm-windows extensionless-shim regression (issue #5)
// needs a stable handle to the resolver without going through spawn().
export function resolveSpawn(bin: string): { command: string; shell: boolean; wantsStdinPrompt: boolean } {
  if (!IS_WIN) return { command: bin, shell: false, wantsStdinPrompt: false }
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter(Boolean)
  for (const dir of (process.env.PATH ?? '').split(PATH_DELIMITER)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, bin + ext)
      if (existsSync(candidate)) {
        const isBatch = /\.(cmd|bat)$/i.test(candidate)
        // When shell:true and the path contains spaces, cmd.exe will split the
        // command at the space unless we quote it (e.g. "C:\Program Files\codex").
        const command = isBatch && candidate.includes(' ') ? `"${candidate}"` : candidate
        return { command, shell: isBatch, wantsStdinPrompt: isBatch }
      }
    }
  }
  // Last resort: only an extensionless shim (nvm-windows) is on PATH. The shim
  // itself is a `#!/bin/sh` wrapper and cannot be exec'd without a shell → force
  // shell:true so Node routes the call through cmd.exe, which can find the
  // .cmd via PATHEXT after the shim.
  for (const dir of (process.env.PATH ?? '').split(PATH_DELIMITER)) {
    if (!dir) continue
    const shim = join(dir, bin)
    if (existsSync(shim)) {
      const command = shim.includes(' ') ? `"${shim}"` : shim
      return { command, shell: true, wantsStdinPrompt: true }
    }
  }
  // Not found on PATH at all — let the shell resolve it, and feed the prompt via stdin.
  return { command: bin, shell: true, wantsStdinPrompt: true }
}

type CodexSpawn = ReturnType<typeof resolveSpawn> & { argsPrefix: string[] }

/** npm's Windows `codex.cmd` forwards arguments through `%*`. Running that
 * shim with Node's `shell:true` lets cmd.exe consume the double quotes inside
 * structured `-c key=<toml>` values. A valid inline TOML table then reaches
 * Codex as a plain string and strict config loading fails before the turn can
 * start. Bypass cmd.exe by invoking the npm package's JS entry point with the
 * same Node installation whenever the standard npm layout is available. */
function resolveCodexSpawn(): CodexSpawn {
  const fallback = resolveSpawn('codex')
  if (!IS_WIN || !fallback.shell) return { ...fallback, argsPrefix: [] }

  const shim = fallback.command.startsWith('"') && fallback.command.endsWith('"')
    ? fallback.command.slice(1, -1)
    : fallback.command
  if (!/\.cmd$/i.test(shim)) return { ...fallback, argsPrefix: [] }

  const shimDir = dirname(shim)
  const script = join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  if (!existsSync(script)) return { ...fallback, argsPrefix: [] }

  const nodeCandidates = [
    join(shimDir, 'node.exe'),
    ...(process.env.PATH ?? '').split(PATH_DELIMITER).filter(Boolean).map((dir) => join(dir, 'node.exe')),
  ]
  const node = nodeCandidates.find((candidate) => existsSync(candidate))
    ?? (/^node(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : null)
  if (!node) return { ...fallback, argsPrefix: [] }

  return { command: node, argsPrefix: [script], shell: false, wantsStdinPrompt: false }
}

export type EngineId = 'claude' | 'codex' | 'grok' | 'cursor' | 'opencode' | 'pi' | 'gemini' | 'qwen' | 'antigravity'

/** The pairable engine ids, in the daemon's default detection order. */
export const ENGINE_IDS: EngineId[] = ['claude', 'codex', 'grok', 'cursor', 'opencode', 'pi', 'gemini', 'qwen', 'antigravity']

/** Engines for which Cumora can impose a fail-closed filesystem + tool-network
 * boundary non-interactively. The remaining adapters still work for operators
 * who explicitly accept host-level execution, but are never selected merely
 * because their binary happens to be on PATH. */
export const SANDBOXED_ENGINE_IDS: readonly EngineId[] = ['claude', 'codex']
export const ALLOW_UNSANDBOXED_BYOA_ENV = 'CUMORA_BYOA_ALLOW_UNSANDBOXED'
export const SECURE_ENGINE_MIN_VERSIONS: Readonly<Partial<Record<EngineId, string>>> = {
  // --restricted first shipped here; it is what ignores user/project settings
  // and confines built-in file tools to the Agent working directory.
  claude: '2.1.248',
  // Permission profiles (default_permissions / permissions.*) are supported
  // starting with this Codex release.
  codex: '0.138.0',
}

export function allowUnsandboxedByoa(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_UNSANDBOXED_BYOA_ENV] === '1'
}

export function runnableEngineIds(
  installed: readonly EngineId[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EngineId[] {
  if (allowUnsandboxedByoa(env)) return [...installed]
  const safe = new Set(SANDBOXED_ENGINE_IDS)
  return installed.filter((id) => safe.has(id) && !(platform === 'win32' && id === 'claude'))
}

export interface RunnableEngineEvaluation {
  runnable: EngineId[]
  blocked: Array<{ id: EngineId; reason: string }>
}

export function secureEngineCapabilityReason(
  id: EngineId,
  version: string | null,
  platform: NodeJS.Platform,
  linuxSandboxDeps: { bwrap: boolean; socat: boolean } = { bwrap: true, socat: true },
): string | null {
  const minimum = SECURE_ENGINE_MIN_VERSIONS[id]
  if (!minimum || !isCliVersionAtLeast(version, minimum)) {
    return version
      ? `version ${version} is older than the secure minimum ${minimum ?? 'unknown'}`
      : `could not verify the installed version (secure minimum ${minimum ?? 'unknown'})`
  }
  if (id === 'claude' && platform === 'linux' && (!linuxSandboxDeps.bwrap || !linuxSandboxDeps.socat)) {
    const missing = [!linuxSandboxDeps.bwrap && 'bubblewrap (bwrap)', !linuxSandboxDeps.socat && 'socat'].filter(Boolean).join(', ')
    return `missing sandbox dependency: ${missing}`
  }
  return null
}

/** Fail-closed capability check layered on top of the static engine allowlist.
 * Merely having a binary named `claude` or `codex` is insufficient: older
 * releases silently ignore the exact boundary controls Cumora depends on. */
export async function evaluateRunnableEngines(
  installed: readonly EngineId[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<RunnableEngineEvaluation> {
  const candidates = runnableEngineIds(installed, env, platform)
  if (allowUnsandboxedByoa(env)) return { runnable: candidates, blocked: [] }

  const snapshot = await snapshotDetectedEngines(candidates)
  const versions = new Map<EngineId, string | null>(await Promise.all(snapshot.map(async (entry) => [
    entry.id,
    await probeLocalEngineVersion(entry.id, entry.path),
  ] as const)))
  const linuxSandboxDeps = platform === 'linux'
    ? { bwrap: await binOnPath('bwrap'), socat: await binOnPath('socat') }
    : { bwrap: true, socat: true }
  const runnable: EngineId[] = []
  const blocked: RunnableEngineEvaluation['blocked'] = []
  for (const id of candidates) {
    const version = versions.get(id) ?? null
    const reason = secureEngineCapabilityReason(id, version, platform, linuxSandboxDeps)
    if (reason) { blocked.push({ id, reason }); continue }
    runnable.push(id)
  }
  return { runnable, blocked }
}

export interface EnginePersona {
  id: string
  name: string
  role: string | null
  systemPrompt: string | null
}

export interface EngineRunArgs {
  /** Agent's dedicated home dir; becomes the engine's cwd and secure sandbox root. */
  home: string
  /** The per-wake trigger prompt. */
  prompt: string
  /** Env for the engine subprocess (includes the `cumora` shim wiring). */
  env: NodeJS.ProcessEnv
  /** Big-brain (main reasoning) model — passed to the engine as --model. */
  model?: string | null
  /** Small-brain (cheap auxiliary) model. Claude: ANTHROPIC_SMALL_FAST_MODEL.
   *  Codex has no general fast-model knob, so it's ignored there for now. */
  fastModel?: string | null
  /** Resume a prior engine session so the agent keeps continuous context
   *  across wakes (Claude: `--resume <id>`). Null/undefined → fresh session.
   *  This is what lets a BYOA agent remember its place in a running task
   *  (e.g. a counting relay: it knows it already said "2") instead of
   *  re-deriving everything from a frozen inbox snapshot each wake. */
  resumeSessionId?: string | null
  /** Called for each stdout/stderr line — daemon logs / Phase-2 observability. */
  onLog: (line: string) => void
  /** Optional per-hop trajectory hook — same shape as EngineSessionArgs.onHopUsage.
   *  When the one-shot path runs the engine via a stream parser (Claude
   *  stream-json), each assistant message fires this; for engines that don't
   *  emit per-hop usage (Codex `exec`), the callback fires once at the
   *  terminating `result` event with the run's full usage. Daemon wires this
   *  into the same buffered ledger as the persistent-session path. */
  onHopUsage?: (report: EngineHopReport) => void
  /** Aborts the run (daemon shutdown / future mid-run steering). */
  signal: AbortSignal
}

/** Raw token usage as engines report it (Anthropic/Claude Code field names).
 *  Passed through verbatim — the daemon maps it to the cost ledger — so this
 *  module stays standalone (no pricing import). Undefined = engine gave none. */
export interface EngineUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface EngineRunResult {
  exitCode: number
  error?: string
  /** The engine session id parsed from this run's stream-json output, to be
   *  fed back as `resumeSessionId` on the next wake. Null if the engine emits
   *  no session id (e.g. Codex, or a non-stream-json flag override). */
  sessionId?: string | null
  /** Token usage from the turn's `result` event, for cache-aware cost. */
  usage?: EngineUsage
  /** The actual model id the engine used this turn (parsed from its events), so
   *  cost is priced on the REAL model rather than a fallback guess. */
  model?: string | null
}

/** A LOCAL small-brain (cerebellum) completion: feed a self-contained prompt,
 *  get raw text back. Used for inbox triage — judgment runs on the operator's
 *  OWN cheap local model (Claude Haiku), never the cloud, never the big brain. */
export interface EngineClassifyArgs {
  /** A NEUTRAL cwd with no persona CLAUDE.md / skills / MCP, so triage is a
   *  fast, clean, tool-free one-shot. */
  cwd: string
  /** The full triage prompt (instructions + input). */
  prompt: string
  env: NodeJS.ProcessEnv
  /** Small/fast model to run on (Claude: 'haiku'). */
  model?: string | null
  onLog?: (line: string) => void
  signal: AbortSignal
}

export interface EngineClassifyResult {
  text: string
  error?: string
  /** Token usage for this triage call (Claude json output). Undefined when the
   *  engine emits none (e.g. codex / text-only output). */
  usage?: EngineUsage
  /** The model id the engine actually ran, when its output reports one. */
  model?: string | null
}

/** A `doctor` liveness probe for ONE brain tier of an engine. Doctor has no
 *  agent/DB context, so its small tier checks only the computer-level fallback,
 *  not a member-specific fastModel pin. */
export interface EngineProbeArgs {
  /** 'big' → engine default model; 'small' → computer-level cheap/fast
   *  fallback. Member-specific pins are validated only during real triage. */
  tier: 'big' | 'small'
  /** Neutral temp cwd (no persona). */
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}

/** Args to a WAKE-PATH probe: validates the SPECIFIC protocol path the real
 *  wake would use on this machine (the app-server JSON-RPC handshake for codex,
 *  the persistent-session flag set for claude) — orthogonal to `probe()`, which
 *  only covers "binary runs + auth ok" via the one-shot subcommand. Same
 *  one-shot spawn discipline (neutral cwd, AbortSignal-driven timeout). */
export interface EngineWakeProbeArgs {
  /** Neutral temp cwd (no persona). Adapters that need a git repo (codex) may
   *  initialize one here themselves — the caller is responsible for cleanup. */
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}

export interface EngineWakeProbeResult {
  ok: boolean
  /** Concise detail on failure; empty on success. */
  detail: string
  /** Set when this machine WON'T use the distinct wake path (e.g. a
   *  custom-args override / opt-out env / Windows for codex) — the wake will
   *  collapse to the same one-shot path `probe()` already covers, so a wake
   *  probe would be redundant. Doctor hides the line in that case. */
  skipped?: boolean
}

/** One LLM round-trip the engine just made — fired by ClaudeSession /
 *  CodexSession (and the one-shot adapter.run paths) on every assistant /
 *  turn-completed event. This is the per-HOP granularity the daemon needs to
 *  build a trajectory ledger: one row per outbound model call, not just one
 *  row per turn total.
 *
 *  `usage` is the engine's raw usage shape so this module stays standalone
 *  (no pricing import); the daemon maps it to the cost ledger. */
export interface EngineHopReport {
  /** Model id the engine just hit for this hop (e.g. claude-sonnet-4-6,
   *  gpt-5.5). The model on this hop's own message — NOT the session default,
   *  since native auto-compaction etc. can switch models mid-turn. */
  model: string
  usage: EngineUsage
  /** Wall-clock ms since the engine emitted this hop's first event to the
   *  emission of its terminating event (so cache warming etc. are visible). */
  latencyMs?: number
  /** Optional ledger-enrichment hints — fed straight into `llm_calls.extras`
   *  via the daemon. These are the columns we want for "why was this hop
   *  expensive" without needing the prompt body. Each is optional because
   *  Codex's app-server doesn't surface them at this granularity (yet). */
  hopIndex?: number      // 1-based position within the current turn
  toolUses?: number      // tool_use entries in the assistant message
  textChars?: number     // total text length the model returned (chars, not tokens)
}

/** Args to start a PERSISTENT engine session (spawned ONCE per agent). */
export interface EngineSessionArgs {
  home: string
  env: NodeJS.ProcessEnv
  model?: string | null
  fastModel?: string | null
  /** Resume a prior session on the FIRST spawn / after a restart (Claude:
   *  `--resume <id>`). Within a live process the session continues on its own. */
  resumeSessionId?: string | null
  /** The agent's INVARIANT standing prompt (TEXT). Delivered to the engine ONCE at
   *  spawn via its native out-of-band channel — Claude: written to a file passed as
   *  `--append-system-prompt-file`; Codex: the app-server thread's
   *  `developerInstructions` — instead of being re-sent every turn, so the
   *  transcript stays small enough for native auto-compaction to keep up. Whether a
   *  session actually carried it is reported by EngineSession.carriesStandingPrompt. */
  standingPrompt?: string | null
  onLog: (line: string) => void
  /** Fire-and-forget per-hop trajectory report. Called once per assistant
   *  message (Claude) / per turn-completed event (Codex) with that hop's own
   *  model + usage breakdown. The daemon buffers these into batched llm_calls
   *  inserts upstream so the universal ledger sees BYOA trajectory at the same
   *  granularity it sees cloud trajectory. Omit to disable. */
  onHopUsage?: (report: EngineHopReport) => void
}

/** A long-lived engine process for ONE agent. Spawned once; each wake feeds a
 *  turn via `send()` (a stream-json user message on stdin) and resolves when the
 *  engine finishes that turn (its `result` event) — so wakes 2..N skip the cold
 *  start (process boot + MCP init + CLAUDE.md/skills load) the one-shot `run()`
 *  pays every time. */
export interface EngineSession {
  /** Feed ONE turn; resolves when the engine emits its turn `result`. The daemon
   *  serializes calls (one turn at a time). */
  send(prompt: string): Promise<EngineRunResult>
  /** Same-turn steering: inject a message into the RUNNING turn at the next safe
   *  stream-json boundary so the agent answers a direct ping mid-task, then
   *  continues. No-op if no turn is in flight. */
  steer(text: string): void
  /** Process is up and stdin is writable. */
  readonly alive: boolean
  /** The latest session id seen (to `--resume` if the process must be respawned). */
  readonly sessionId: string | null
  /** True when this session received the standing prompt out-of-band at spawn
   *  (Claude system-prompt file / Codex developerInstructions). When true the
   *  daemon sends ONLY the per-turn delta; when false it inlines the standing
   *  prompt each turn (a one-shot path, or delivery failed). */
  readonly carriesStandingPrompt: boolean
  /** Tear the process down (daemon shutdown / unrecoverable error). `force`
   *  skips any engine-specific graceful-exit delay when this daemon process is
   *  itself about to exit. */
  stop(options?: { force?: boolean }): Promise<void>
}

export interface EngineAdapter {
  readonly id: EngineId
  /** Binary name probed on PATH (e.g. 'claude'). */
  readonly bin: string
  /** Lay out the agent's home so the engine reads persona/memory natively.
   *  Idempotent and non-destructive: never clobbers an existing memory file. */
  seedHome(home: string, persona: EnginePersona): Promise<void>
  /** Run one headless turn. Resolves with the process exit code. */
  run(args: EngineRunArgs): Promise<EngineRunResult>
  /** Start a PERSISTENT process. Returns null if this engine has no persistent
   *  mode here (or a custom-args override) — the daemon then falls back to one-shot
   *  `run()` per wake. The session reports via carriesStandingPrompt whether the
   *  standing prompt was delivered out-of-band. */
  startSession?(args: EngineSessionArgs): EngineSession | null
  /** Run a LOCAL small-brain triage completion, returning raw text. */
  classify(args: EngineClassifyArgs): Promise<EngineClassifyResult>
  /** `doctor` liveness probe for one brain tier (big/small). Same one-shot spawn
   *  as classify, with a trivial prompt — used to diagnose whether each brain is
   *  reachable + authed on this machine. */
  probe(args: EngineProbeArgs): Promise<EngineClassifyResult>
  /** WAKE-PATH probe: exercises the protocol the REAL wake uses on this machine
   *  (codex → app-server JSON-RPC; claude → persistent-session flags). Returns
   *  `{ skipped: true }` when the wake path collapses to `probe()`'s shape on
   *  this machine (override env, opt-out, Windows for codex), so the doctor can
   *  hide a redundant line. Never throws. */
  probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult>
}

/** The trivial prompt a `doctor` probe sends — one token of real work. */
const DOCTOR_PROMPT = 'Connectivity check. Reply with exactly: OK'

type BinPathProbe = 'present' | 'absent' | 'error'

/** Probe a binary without conflating "not installed" with an inability to run
 *  the platform's PATH resolver at all. The distinction matters to the daemon's
 *  periodic refresh: a healthy scan that finds nothing should clear a stale
 *  inventory, while a missing/broken `which` or `where` should retain the last
 *  known-good result. */
async function probeBinOnPath(bin: string): Promise<BinPathProbe> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' })
    probe.on('error', () => resolve('error'))
    probe.on('close', (code) => resolve(code === 0 ? 'present' : code === 1 ? 'absent' : 'error'))
  })
}

/** True if a binary is resolvable on PATH. */
export async function binOnPath(bin: string): Promise<boolean> {
  return (await probeBinOnPath(bin)) === 'present'
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function ensureAgentDirectory(path: string, recursive = false): Promise<void> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`secure BYOA refuses non-directory or linked path: ${path}`)
    }
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(path, { recursive })
  const created = await lstat(path)
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`secure BYOA could not create a trusted directory: ${path}`)
  }
}

/** Replace a daemon-owned file without following an attacker-planted final
 * symlink. The random staging file and target share a verified parent, so the
 * final rename swaps the directory entry itself rather than opening its target. */
async function atomicAgentWrite(path: string, data: string): Promise<void> {
  const parent = dirname(path)
  const staged = join(parent, `.cumora-${process.pid}-${randomUUID()}.tmp`)
  await writeFile(staged, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    try { await rename(staged, path) }
    catch (err) {
      if (!IS_WIN || !['EEXIST', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      await rm(path, { force: true })
      await rename(staged, path)
    }
  } finally {
    await rm(staged, { force: true }).catch(() => {})
  }
}

function atomicAgentWriteSync(path: string, data: string): void {
  const parent = dirname(path)
  const staged = join(parent, `.cumora-${process.pid}-${randomUUID()}.tmp`)
  writeFileSync(staged, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  try {
    try { renameSync(staged, path) }
    catch (err) {
      if (!IS_WIN || !['EEXIST', 'EPERM'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
      rmSync(path, { force: true })
      renameSync(staged, path)
    }
  } finally {
    rmSync(staged, { force: true })
  }
}

async function ensureCommonHome(home: string): Promise<void> {
  await ensureAgentDirectory(home, true)
  await ensureAgentDirectory(join(home, 'memory'))
  await ensureAgentDirectory(join(home, 'notes'))
  await ensureAgentDirectory(join(home, 'workspace'))
  // Seed a memory index so "read memory/MEMORY.md to recall" always has a
  // target, and the agent has a concrete place to append pointers. Only when
  // absent — never clobber what the agent has written.
  const memoryIndex = join(home, 'memory', 'MEMORY.md')
  let seedMemoryIndex = false
  try {
    const info = await lstat(memoryIndex)
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`secure BYOA refuses non-file or linked memory index: ${memoryIndex}`)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    seedMemoryIndex = true
  }
  if (seedMemoryIndex) {
    await atomicAgentWrite(
      memoryIndex,
      '# Memory index\n\n' +
      'One line per durable fact, pointing at the file that holds it:\n' +
      '`- [Title](file.md) — one-line hook`\n\n' +
      'Write the fact itself in its own `memory/<topic>.md` file; keep this index short.\n',
    )
  }
}

/** Shared spawn helper: run `bin args…` in `home`, stream lines to onLog,
 *  abort on signal, resolve with the exit code. */
const MAX_FAILURE_LINES = 30
const MAX_FAILURE_CHARS = 4000
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g

function cleanLine(line: string): string {
  return line.replace(ANSI_RE, '').replace(/\r/g, '').trim()
}

function pushTail(lines: string[], line: string): void {
  if (!line) return
  lines.push(line)
  if (lines.length > MAX_FAILURE_LINES) lines.shift()
}

/** Inspect a Claude assistant message's `content` array to count tool_use
 *  entries and total text length. Used by the hop ledger so the operator can
 *  see at a glance whether a hop's spend went into prose or tool routing —
 *  the two have very different optimization targets. Robust to a malformed
 *  payload: returns zeros, never throws. */
function countAssistantContent(content: unknown): { toolUses: number; textChars: number } {
  if (!Array.isArray(content)) return { toolUses: 0, textChars: 0 }
  let toolUses = 0, textChars = 0
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const it = item as { type?: unknown; text?: unknown }
    if (it.type === 'tool_use') toolUses += 1
    else if (it.type === 'text' && typeof it.text === 'string') textChars += it.text.length
  }
  return { toolUses, textChars }
}

/** Exported for tests: pure, and the only way to pin what an operator actually
 *  reads after every cap downstream has taken its bite. */
export function failurePreview(args: {
  exitCode: number
  signalName: NodeJS.Signals | null
  stderr: string[]
  stdout: string[]
}): string {
  const parts: string[] = []
  if (args.stderr.length > 0) parts.push(args.stderr.join('\n'))
  if (args.stdout.length > 0) parts.push(args.stdout.join('\n'))
  const detail = parts.join('\n').trim()
  const prefix = args.signalName
    ? `process terminated by ${args.signalName}`
    : `process exited with code ${args.exitCode}`
  if (!detail) return prefix
  // Everything downstream cuts from the END — this cap, then the daemon's own
  // 900-character one — and two of the engines put the reason on the LAST line.
  // Measured on the installed binaries, each given one flag it does not know:
  // gemini 0.1.15 prints 2,819 characters of help with the cause at offset
  // 2,765; qwen 0.0.14, 3,798 with the cause at 3,744. Both dump their entire
  // --help to stderr. So the operator's notice was 900 characters of option
  // documentation, truncated mid-word, with no reason anywhere in it.
  //
  // salientError() already leads with this line, for exactly this reason, but
  // only the probe and handshake paths go through it — an ordinary turn lands
  // here instead. Lead with the cause and keep the full output behind it.
  const rejected = argvRejection(detail)
  const body = rejected ? `${rejected}\n${detail}` : detail
  return `${prefix}\n${body}`.slice(0, MAX_FAILURE_CHARS)
}

/** Write to an engine's stdin without letting a dead pipe crash the process.
 *
 *  Every stdin write in this file was wrapped in a try/catch whose comment said
 *  the child's own error/close path would report the failure. That is not what
 *  happens. A failed pipe write — EPIPE, when the engine died or was killed
 *  mid-write — is delivered ASYNCHRONOUSLY as an 'error' event on the stdin
 *  stream (`afterWriteDispatched`, a tick later), so the try/catch has already
 *  returned and cannot catch it. With no listener on the stream, Node turns it
 *  into an uncaught exception. It surfaced as a flaky `write EPIPE` failure in
 *  PiAdapter.probeWake on CI, but every adapter had the same hole.
 *
 *  A dead engine is ordinary: the operator quit the CLI, a turn was aborted,
 *  doctor tore its probe down. The child's own 'error'/'close' handlers already
 *  report it, so the stream error is noise — it just must not be UNHANDLED.
 *
 *  Returns false when the write could not even be attempted, so callers that
 *  care can bail; the ones that don't already fall through to their close path. */
function writeStdin(child: ChildProcess, text: string, opts: { end?: boolean } = {}): boolean {
  const stdin = child.stdin
  if (!stdin) return false
  // Attach once per stream — repeated writes must not stack listeners.
  if (stdin.listenerCount('error') === 0) {
    stdin.on('error', () => { /* reported by the child's own close/error path */ })
  }
  try {
    stdin.write(text)
    if (opts.end) stdin.end()
    return true
  } catch {
    return false
  }
}

function spawnEngine(
  bin: string,
  args: string[],
  { home, env, onLog, signal, onHopUsage }: EngineRunArgs,
  spawnOpts: { shell?: boolean; stdinText?: string; onStdoutLine?: (line: string) => void } = {},
): Promise<EngineRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawnEngineChild(bin, args, {
      cwd: home, env,
      stdio: [spawnOpts.stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: spawnOpts.shell ?? false,
    })
    if (spawnOpts.stdinText != null) {
      writeStdin(child, spawnOpts.stdinText, { end: true })
    }
    // Retain the platform tree-termination promise. A listener registered after
    // abort would never fire, so bindAbortTermination also closes that race.
    const abort = bindAbortTermination(child, signal)

    const stderrTail: string[] = []
    const stdoutTail: string[] = []
    let sessionId: string | null = null
    let usage: EngineUsage | undefined
    let model: string | null = null
    // Per-hop timing for the one-shot path. Mirrors ClaudeSession's
    // hopStartedAt — set on the first event of a hop, cleared once we've
    // emitted the hop, so latency_ms reflects actual time-on-the-wire.
    let hopStartedAt: number | null = null
    let hopIndex = 0
    // A pipe read chops stdout at an arbitrary byte offset (~8KB on macOS, up to
    // 64KB on Linux), so a long stream-json event — a Write/Edit tool_use carrying
    // file content, or a big final `result` — arrives split across two 'data'
    // events. Splitting each chunk on its own handed JSON.parse two halves, both
    // of which throw and are swallowed by the catch below: the hop never reached
    // the ledger and the turn's authoritative usage/model/session id were lost,
    // silently. Carry the trailing partial line into the next chunk, exactly like
    // ClaudeSession.onStdout already does for the persistent path. StringDecoder
    // does the same job one level down, holding back a multi-byte character split
    // across the boundary instead of emitting U+FFFD into the JSON.
    const decoder: Record<'stdout' | 'stderr', StringDecoder> =
      { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
    // `buf === null` means end-of-stream: flush whatever is held back, since the
    // engine's last line often has no trailing newline.
    const pump = (stream: 'stdout' | 'stderr', buf: Buffer | null): void => {
      const text = buf === null ? decoder[stream].end() : decoder[stream].write(buf)
      const lines = (carry[stream] + text).split('\n')
      carry[stream] = buf === null ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        const cleaned = cleanLine(line)
        if (!cleaned) continue
        pushTail(stream === 'stderr' ? stderrTail : stdoutTail, cleaned)
        // Sniff the engine's session id (to `--resume` next wake), the final
        // `result` event's usage (cache-aware cost), and the actual model id
        // (real pricing). Cheap: only parse stdout JSON objects carrying one.
        if (stream === 'stdout' && cleaned.startsWith('{') && (cleaned.includes('"session_id"') || cleaned.includes('"sessionID"') || cleaned.includes('"usage"') || cleaned.includes('"model"'))) {
          try {
            const obj = JSON.parse(cleaned) as { session_id?: unknown; sessionID?: unknown; type?: unknown; usage?: EngineUsage; model?: unknown; message?: { model?: unknown; usage?: EngineUsage; content?: unknown } }
            const sniffedSessionId = typeof obj.session_id === 'string' ? obj.session_id : obj.sessionID
            if (typeof sniffedSessionId === 'string' && sniffedSessionId) sessionId = sniffedSessionId
            // The terminal `result` event carries the authoritative turn total.
            if (obj.type === 'result' && obj.usage && typeof obj.usage === 'object') usage = obj.usage
            // assistant events carry message.model; some events carry top-level model.
            const m = typeof obj.message?.model === 'string' ? obj.message.model : (typeof obj.model === 'string' ? obj.model : null)
            if (m) model = m
            // Per-hop trajectory mirror of ClaudeSession.onStdout. Same shape,
            // same purpose: one row per outbound model call so even the
            // one-shot path (no persistent session) lands in the universal
            // ledger at the right granularity.
            if (obj.type === 'assistant' && obj.message?.usage && m && onHopUsage) {
              const startedAt = hopStartedAt
              hopStartedAt = null
              hopIndex += 1
              const { toolUses, textChars } = countAssistantContent(obj.message.content)
              try { onHopUsage({ model: m, usage: obj.message.usage, latencyMs: startedAt != null ? Date.now() - startedAt : undefined, hopIndex, toolUses, textChars }) }
              catch { /* never break the run on a ledger error */ }
            } else if (hopStartedAt == null && (obj.type === 'assistant' || obj.type === 'user' || obj.type === 'system')) {
              hopStartedAt = Date.now()
            }
            if (obj.type === 'result') { hopStartedAt = null; hopIndex = 0 }
          } catch { /* partial / non-json line — ignore */ }
        }
        if (stream === 'stdout') spawnOpts.onStdoutLine?.(cleaned)
        onLog(cleaned)
      }
    }
    let settled = false
    child.stdout?.on('data', (buf: Buffer) => pump('stdout', buf))
    child.stderr?.on('data', (buf: Buffer) => pump('stderr', buf))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => reject(err))
    })
    const settle = async (code: number | null, signalName: NodeJS.Signals | null): Promise<void> => {
      if (settled) return
      settled = true
      abort.dispose()
      await abort.wait()
      const exitCode = code ?? (signalName ? 128 : 1)
      resolve({
        exitCode,
        error: exitCode === 0 ? undefined : failurePreview({ exitCode, signalName, stderr: stderrTail, stdout: stdoutTail }),
        sessionId,
        usage,
        model,
      })
    }
    // Normal end: wait for 'close', so the last of stdout is parsed. Flush the
    // held-back tail BEFORE resolving: the terminating `result` event is
    // usually the last line, and it carries the turn's usage.
    child.on('close', (code, signalName) => {
      if (!settled) { pump('stdout', null); pump('stderr', null) }
      void settle(code, signalName)
    })
    // Torn-down end: 'close' waits for every inherited stdio pipe to reach EOF,
    // and the engine's OWN children (Bash tool commands) hold those pipes — a
    // grandchild that outlives the kill keeps them open, so 'close' may never
    // fire at all. Once we've aborted, the turn is being discarded and its
    // remaining output is moot, so settle on 'exit' instead. Without this the
    // daemon's shutdown drain waits forever on a turn it already killed, and
    // `busy` plus the big-brain slot are never released.
    child.on('exit', (code, signalName) => { if (signal.aborted) void settle(code, signalName) })
  })
}

/** Like spawnEngine, but for a one-shot completion: collect ALL stdout (the
 *  model's text) and resolve with it. No session sniffing, no run wiring. */
function spawnCapture(
  bin: string,
  args: string[],
  { cwd, env, signal, onLog, shell, stdinText }: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLog?: (line: string) => void; shell?: boolean; stdinText?: string },
): Promise<EngineClassifyResult> {
  return new Promise((resolve) => {
    const child = spawnEngineChild(bin, args, {
      cwd, env,
      stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: shell ?? false,
    })
    if (stdinText != null) {
      writeStdin(child, stdinText, { end: true })
    }
    const abort = bindAbortTermination(child, signal)
    let stdout = ''
    const stderrTail: string[] = []
    let settled = false
    child.stdout?.on('data', (buf: Buffer) => { stdout += buf.toString('utf8'); onLog?.(cleanLine(buf.toString('utf8'))) })
    child.stderr?.on('data', (buf: Buffer) => { for (const l of buf.toString('utf8').split('\n')) pushTail(stderrTail, cleanLine(l)) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => {
        resolve({ text: '', error: err instanceof Error ? err.message : String(err) })
      })
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => {
        const exitCode = code ?? (signalName ? 128 : 1)
        resolve({
          text: stdout.replace(ANSI_RE, '').trim(),
          error: exitCode === 0 ? undefined : failurePreview({ exitCode, signalName, stderr: stderrTail, stdout: [] }),
        })
      })
    })
  })
}

/** The computer-level small/fast model used by standalone probes. */
function triageModel(fallback: string): string {
  return process.env.CUMORA_TRIAGE_MODEL?.trim() || fallback
}

function extraArgs(envVar: string): string[] {
  const raw = process.env[envVar]
  return raw ? raw.split(/\s+/).filter(Boolean) : []
}

/** Whole-argv overrides are intentionally an unsafe escape hatch: Cumora
 * cannot prove that an opaque flag set preserves its sandbox. Ignore them in
 * the secure default mode; the daemon logs the opt-in requirement at startup. */
function unsafeEngineArgs(envVar: string): string[] {
  return allowUnsandboxedByoa() ? extraArgs(envVar) : []
}

const PERSONA_HEADER = (
  p: EnginePersona,
  opts: { personaFile?: string; skillsDir?: string } = {},
): string => {
  const personaFile = opts.personaFile ?? 'CLAUDE.md'
  const skillsDir = opts.skillsDir ?? '.claude/skills/'
  return `# ${p.name}${p.role ? ` — ${p.role}` : ''}\n\n` +
  `You are **${p.name}**, a member of a team that collaborates in Cumora (a team chat).\n` +
  (p.systemPrompt?.trim() ? `\n## Your style\n${p.systemPrompt.trim()}\n\n` : '\n') +
  `This directory is your private home and your working directory — it persists\n` +
  `across wakes and is yours alone. Its layout:\n` +
  `- \`${personaFile}\` (this file) — always loaded each wake; keep it short.\n` +
  `- \`memory/\` — your durable memory. There is NO hidden memory store: to remember\n` +
  `  something across wakes you MUST write it to a file here (e.g. \`memory/<topic>.md\`)\n` +
  `  and add a one-line pointer in \`memory/MEMORY.md\`. Saying "I'll remember" without\n` +
  `  writing a file means you will NOT remember. At the start of each wake, read\n` +
  `  \`memory/MEMORY.md\` (and the files it points to) to recall what you know.\n` +
  `- \`notes/\` — scratch notes and drafts.\n` +
  `- \`${skillsDir}\` — your skills.\n` +
  `- \`workspace/\` — **put all project files and scratch here**: git clones, builds,\n` +
  `  downloads, temp files. Always \`cd workspace\` (or use \`workspace/…\` paths) for\n` +
  `  that work — do NOT clutter your home root with project files.\n\n` +
  `## Privacy boundary — STRICT\n` +
  `You run on a machine that belongs to your operator. Everything OUTSIDE your home\n` +
  `directory (other projects, \`~/.ssh\`, credentials, browser data, personal files)\n` +
  `is private and not yours to touch.\n` +
  `- Stay inside your home directory. Do not read, open, list, or search files\n` +
  `  outside it unless the operator explicitly asks you to in this Cumora workspace.\n` +
  `- NEVER paste, quote, summarize, or send the contents — or even the paths — of\n` +
  `  any file outside your home into Cumora (replies, DMs, docs, kanban). Other\n` +
  `  people see what you post there.\n` +
  `- If a task seems to need something outside your home, ask in Cumora first;\n` +
  `  don't go fetch it on your own.\n\n` +
  `When you act in Cumora, use the \`cumora\` interface. Secure Claude and Codex\n` +
  `expose it as the structured \`mcp__cumora__cli\` tool (pass command words in its\n` +
  `\`argv\` array); compatibility engines expose the command-line tool on PATH.\n` +
  `Key commands:\n` +
  `- \`cumora inbox\` — unread messages across your conversations\n` +
  `- \`cumora messages <conversationId> --tail 30\` — read a conversation\n` +
  `- \`cumora reply <conversationId> '<text>'\` — post a message (SINGLE quotes;\n` +
  `  for anything with backticks, code, $, quotes, or newlines, write it to a file\n` +
  `  and use \`cumora reply <conversationId> --file <path>\` in command-line mode.\n` +
  `  In the structured MCP tool, put the complete text directly in one argv item;\n` +
  `  local \`--file\` and \`--stdin\` flags are intentionally unavailable.)\n` +
  `- \`cumora contacts [<query>]\` — your teammates + humans, each with their role/function\n` +
  `  (search by name or role, e.g. \`cumora contacts designer\`). Use it when someone asks\n` +
  `  about a person or role you don't already know.\n` +
  `- \`cumora whoami\` — your identity\n\n` +
  `Be a real teammate with your own voice — not a generic assistant.\n`
}

/** A persistent Claude Code process for ONE agent (see EngineSession). Spawned in
 *  stream-json I/O mode (`-p --input-format stream-json --output-format stream-json`):
 *  the process stays alive reading newline-delimited user messages from stdin and
 *  exits only when stdin closes. Each `send()` writes one user message and resolves
 *  on that turn's `result` event — so wakes 2..N skip the cold start the one-shot
 *  `run()` pays each time. The daemon calls `send()` serially (one turn at a time). */
class ClaudeSession implements EngineSession {
  private readonly child: ChildProcess
  private readonly onLog: (line: string) => void
  private readonly onHopUsage?: (r: EngineHopReport) => void
  private outBuf = ''
  private sid: string | null
  private curModel: string | null = null
  /** Wall-clock when the CURRENT hop started receiving its first event.
   *  Reset to null after a hop is reported; set the moment the next assistant
   *  event arrives. The wake's pending Promise drives turn-level latency. */
  private hopStartedAt: number | null = null
  /** 1-based hop counter for the current turn — incremented each time we emit
   *  an onHopUsage report, reset to 0 at the `result` event. The ledger uses
   *  this to answer "of the N hops in turn X, which one burned the tokens?"
   *  without having to JOIN siblings by created_at. */
  private hopIndex = 0
  private exited = false
  private exitCode = 0
  private pending: { resolve: (r: EngineRunResult) => void; stderr: string[]; stdout: string[] } | null = null
  private stderrTail: string[] = []
  private stdoutTail: string[] = []
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private steerQueue: string[] = []
  readonly carriesStandingPrompt: boolean

  constructor(bin: string, args: string[], opts: EngineSessionArgs, carriesStandingPrompt: boolean) {
    this.onLog = opts.onLog
    this.onHopUsage = opts.onHopUsage
    this.sid = opts.resumeSessionId ?? null
    this.carriesStandingPrompt = carriesStandingPrompt
    // Cross-platform spawn: on Windows resolve the real claude(.cmd) + shell so a
    // .cmd shim runs (Node can't spawn it with shell:false). The prompt already
    // travels via stdin (stream-json), so no arg-quoting concerns here.
    const { command, shell } = resolveSpawn(bin)
    this.child = spawnEngineChild(command, args, { cwd: opts.home, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], shell })
    this.child.stdout?.on('data', (b: Buffer) => this.onStdout(b))
    this.child.stderr?.on('data', (b: Buffer) => this.onStderr(b))
    this.child.on('error', (err) => this.die(1, err.message))
    this.child.on('close', (code, signalName) =>
      this.die(code ?? (signalName ? 128 : 1), signalName ? `terminated by ${signalName}` : `exited with code ${code}`))
  }

  get alive(): boolean { return !this.exited && this.child.stdin?.writable === true }
  get sessionId(): string | null { return this.sid }

  send(prompt: string): Promise<EngineRunResult> {
    if (this.pending) {
      return Promise.resolve({ exitCode: 1, error: 'engine session busy — a turn is already in flight', sessionId: this.sid })
    }
    if (!this.alive) {
      const exitCode = this.exitCode || 1
      const detail = failurePreview({ exitCode, signalName: null, stderr: this.stderrTail, stdout: this.stdoutTail })
      return Promise.resolve({ exitCode, error: detail || 'engine session is not alive (process gone)', sessionId: this.sid })
    }
    return new Promise<EngineRunResult>((resolve) => {
      this.pending = { resolve, stderr: [], stdout: [] }
      // Opt-in runaway backstop only (CUMORA_TURN_TIMEOUT_MS); OFF by default so a
      // legit long task (e.g. a multi-hour Bash) is never killed mid-work. When set,
      // abort + respawn past the cap.
      if (TURN_TIMEOUT_MS > 0) {
        this.pendingTimer = setTimeout(() => {
          this.settle({ exitCode: 124, error: `engine turn exceeded CUMORA_TURN_TIMEOUT_MS (${Math.round(TURN_TIMEOUT_MS / 1000)}s) — aborted; session will respawn`, sessionId: this.sid })
          this.stop() // kill the runaway process; the daemon respawns (--resume) on the next wake
        }, TURN_TIMEOUT_MS)
        this.pendingTimer.unref?.()
      }
      const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: stripLoneSurrogates(prompt) }] } }) + '\n'
      if (!writeStdin(this.child, msg)) {
        this.settle({ exitCode: 1, error: 'failed to write turn to engine (stdin closed)', sessionId: this.sid })
      }
    })
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    this.exited = true
    try { this.child.stdin?.end() } catch { /* ignore */ }
    return terminateEngineTree(this.child, options.force)
  }

  /** Same-turn STEERING: queue a message to inject into the
   *  RUNNING turn at the next safe stream-json boundary, so the agent can answer a
   *  direct ping mid-task — in the SAME session (full task context) — then continue.
   *  No-op when no turn is in flight (the daemon's normal turn handles it instead). */
  steer(text: string): void {
    if (this.pending && this.alive && text.trim()) this.steerQueue.push(text)
  }

  private flushSteer(): void {
    if (!this.pending || !this.alive) return
    while (this.steerQueue.length > 0) {
      const text = this.steerQueue.shift()!
      if (!writeStdin(this.child, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: stripLoneSurrogates(text) }] } }) + '\n')) break
    }
  }

  private onStdout(buf: Buffer): void {
    this.outBuf += buf.toString('utf8')
    let nl: number
    while ((nl = this.outBuf.indexOf('\n')) >= 0) {
      const line = cleanLine(this.outBuf.slice(0, nl))
      this.outBuf = this.outBuf.slice(nl + 1)
      if (!line) continue
      pushTail(this.stdoutTail, line)
      if (this.pending) pushTail(this.pending.stdout, line)
      this.onLog(line)
      if (!line.startsWith('{')) continue
      let ev: { type?: unknown; session_id?: unknown; is_error?: unknown; subtype?: unknown; status?: unknown; result?: unknown; usage?: EngineUsage; model?: unknown; message?: { model?: unknown; usage?: EngineUsage; content?: unknown } }
      try { ev = JSON.parse(line) } catch { continue }
      if (typeof ev.session_id === 'string' && ev.session_id) this.sid = ev.session_id
      // Capture the real model id (assistant events carry message.model) for pricing.
      const evModel = typeof ev.message?.model === 'string' ? ev.message.model : (typeof ev.model === 'string' ? ev.model : null)
      if (evModel) this.curModel = evModel
      // Per-hop trajectory: every `{type:'assistant', message:{model, usage}}` is
      // ONE outbound model call this turn. Fire onHopUsage so the daemon can
      // ledger it (see EngineHopReport). The terminating `type:'result'` event
      // carries the SUM across hops (already used for the turn's final cost), so
      // we deliberately do NOT also emit it as a hop — that'd double-count.
      if (ev.type === 'assistant' && ev.message?.usage && evModel) {
        const startedAt = this.hopStartedAt
        this.hopStartedAt = null
        this.hopIndex += 1
        // Inspect the assistant's content array to count tool calls + total
        // text length. These two numbers explain a lot of why a hop is
        // expensive — a 5000-char prose reply is a different optimization
        // target from a single tool_use that triggered 6 follow-up hops.
        const { toolUses, textChars } = countAssistantContent(ev.message.content)
        try {
          this.onHopUsage?.({
            model: evModel,
            usage: ev.message.usage,
            latencyMs: startedAt != null ? Date.now() - startedAt : undefined,
            hopIndex: this.hopIndex,
            toolUses,
            textChars,
          })
        } catch { /* ledger best-effort, never break the stream */ }
      } else if (this.hopStartedAt == null && (ev.type === 'assistant' || ev.type === 'user' || ev.type === 'system')) {
        // First event of a new hop (post-`result` or fresh turn). Start the timer.
        this.hopStartedAt = Date.now()
      }
      // Observe Claude's NATIVE auto-compaction (telemetry only) — confirms it
      // ran without our intervention; the small per-turn delta keeps it able to.
      if (ev.subtype === 'status' && ev.status === 'compacting') this.onLog('[claude] native context compaction started')
      else if (ev.subtype === 'compact_boundary') this.onLog('[claude] native context compaction finished')
      if (ev.type === 'result') {
        this.hopStartedAt = null // turn boundary — drop any half-set hop timer
        this.hopIndex = 0        // reset the per-turn hop counter
        this.steerQueue = [] // turn ending — any unflushed steer falls to the daemon's coalesced rerun
        const isErr = ev.is_error === true
        this.settle({
          exitCode: isErr ? 1 : 0,
          error: isErr
            ? `engine turn error${typeof ev.subtype === 'string' ? ` (${ev.subtype})` : ''}: ${typeof ev.result === 'string' ? ev.result.slice(0, MAX_FAILURE_CHARS) : 'see log'}`
            : undefined,
          sessionId: this.sid,
          usage: ev.usage && typeof ev.usage === 'object' ? ev.usage : undefined,
          model: this.curModel,
        })
      } else if (ev.type === 'user') {
        // A tool_result echo is a SAFE stream-json boundary (not mid signed-thinking
        // block) → inject any queued steering into THIS running turn so the agent can
        // answer a direct ping mid-task, then continue — same-turn steering
        // gated on stream-json boundaries.
        this.flushSteer()
      }
    }
  }

  private onStderr(buf: Buffer): void {
    for (const raw of buf.toString('utf8').split('\n')) {
      const line = cleanLine(raw)
      if (!line) continue
      pushTail(this.stderrTail, line)
      if (this.pending) pushTail(this.pending.stderr, line)
      this.onLog(line)
    }
  }

  private settle(r: EngineRunResult): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    const p = this.pending
    this.pending = null
    if (p) p.resolve(r)
  }

  /** Process died (error/close). Mark dead and fail any in-flight turn. */
  private die(code: number, why: string): void {
    const alreadyDown = this.exited
    this.exited = true
    this.exitCode = code
    // An IDLE death used to be SILENT: with no pending turn there was nothing to
    // settle, so a session could vanish (OOM kill, provider-side hangup, macOS
    // app-nap, a stray SIGTERM) and the only trace was a later "respawned" line
    // at the NEXT wake — a whole fleet's sessions once disappeared with zero
    // evidence of why. Always log the death and its cause; skip when `exited`
    // was already set (an intentional stop(), or the error+close double-fire).
    if (!alreadyDown) {
      this.onLog(`[session] engine process died ${this.pending ? 'MID-TURN' : 'while idle'}: ${why} (exit ${code})`)
    }
    if (this.pending) {
      const detail = failurePreview({ exitCode: code, signalName: null, stderr: this.pending.stderr, stdout: this.pending.stdout })
      this.settle({ exitCode: code, error: detail || why, sessionId: this.sid })
    }
  }
}

const TOOL_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'NO_COLOR',
  'CUMORA_AGENT_IPC_DIR', 'CUMORA_AGENT_ID',
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
])

function claudeSecureSettings(agentHome: string, env: NodeJS.ProcessEnv): string {
  const deniedEnv = Object.keys(env)
    .filter((name) => !TOOL_ENV_ALLOWLIST.has(name.toUpperCase()) && !name.toUpperCase().startsWith('LC_'))
    .sort()
    .map((name) => ({ name, mode: 'deny' }))
  // Claude's command sandbox is write-restricted but read-permissive by
  // default. Deny user/application data roots, then carve back only this
  // agent's workspace and executable lookup directories. System runtime paths
  // (/bin, /usr, /lib, /System) stay readable so the shim can launch.
  const denyRead = process.platform === 'darwin'
    ? ['~/', '/Users', '/Volumes']
    : ['~/', '/home', '/root', '/mnt', '/media', '/run', '/proc', '/sys', '/srv', '/var/lib', '/var/log']
  const pathDirs = (env.PATH ?? '')
    .split(PATH_DELIMITER)
    .filter(Boolean)
  pathDirs.push(dirname(process.execPath))
  const allowRead = [...new Set([agentHome, ...pathDirs])]
  return JSON.stringify({
    ...readClaudeUserSettings(env).turnSettings,
    permissions: {
      defaultMode: 'dontAsk',
      // Restricted mode confines file tools to the working directory. Keep the
      // permission rules scoped too, so this JSON remains fail-closed if a
      // future Claude release changes a restricted-mode default.
      allow: ['Read(/**)', 'Edit(/**)', 'mcp__cumora__cli'],
      // The MCP bridge runs as a trusted daemon helper outside the command
      // sandbox. The model must never rewrite either helper executable.
      deny: ['Read(/bin/**)', 'Edit(/bin/**)', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead,
        allowRead,
      },
      network: { allowedDomains: [], strictAllowlist: true },
      credentials: { envVars: deniedEnv },
    },
  })
}

function claudeSecureMcpConfig(env: NodeJS.ProcessEnv): string {
  const mcpShim = env.CUMORA_AGENT_MCP_SHIM
  if (!mcpShim) throw new Error('secure Cumora MCP bridge is not configured')
  return JSON.stringify({
    mcpServers: {
      cumora: {
        command: process.execPath,
        args: [mcpShim],
        env: {
          CUMORA_AGENT_IPC_DIR: env.CUMORA_AGENT_IPC_DIR ?? '',
        },
      },
    },
  })
}

function claudeSecureFlags(agentHome: string, env: NodeJS.ProcessEnv): string[] {
  return [
    '--restricted',
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Write,Edit,Glob,Grep,mcp__cumora__cli',
    '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch',
    '--settings', claudeSecureSettings(agentHome, env),
    '--mcp-config', claudeSecureMcpConfig(env),
    '--strict-mcp-config',
  ]
}

/** Restricted Claude ignores ~/.claude/settings.json wholesale. Recover only
 * the provider bootstrap variables its trusted core needs; claudeSecureSettings
 * denies those names to every model-spawned subprocess. Compatibility mode
 * keeps Claude's native settings loading and its already-explicit host risk. */
function claudeCoreEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return allowUnsandboxedByoa(env) ? { ...env } : withClaudeUserSettingsEnv(env)
}

/** Pick the small brain inside the local provider namespace. An explicit
 * per-agent/computer pin wins; next use the provider's configured fast model.
 * If a custom endpoint names no fast model, omit --model and let that endpoint
 * choose instead of injecting Anthropic's `haiku` alias. Anthropic's OWN base
 * URL is not a custom endpoint — Claude Code exports it into every child
 * process, so keying on "the variable is set" dropped Haiku for first-party
 * accounts. */
function claudeFastModelArgs(env: NodeJS.ProcessEnv, requested?: string | null): string[] {
  const model = requested?.trim()
    || env.CUMORA_TRIAGE_MODEL?.trim()
    || env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim()
    || env.ANTHROPIC_SMALL_FAST_MODEL?.trim()
  if (model) return ['--model', model]
  return isCustomAnthropicEndpoint(env.ANTHROPIC_BASE_URL) ? [] : ['--model', 'haiku']
}

function claudeTurnEnv(env: NodeJS.ProcessEnv, fastModel?: string | null): NodeJS.ProcessEnv {
  const core = claudeCoreEnv(env)
  if (!allowUnsandboxedByoa(core)) {
    for (const [key, value] of Object.entries(readClaudeUserSettings(env).turnEnv)) {
      if (core[key] === undefined) core[key] = value
    }
  }
  const turnEnv: NodeJS.ProcessEnv = {
    ...core,
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: allowUnsandboxedByoa(core)
      ? core.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB
      : '1',
  }
  if (fastModel) {
    turnEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = fastModel
    turnEnv.ANTHROPIC_SMALL_FAST_MODEL = fastModel
  }
  return turnEnv
}

class ClaudeAdapter implements EngineAdapter {
  readonly id = 'claude' as const
  readonly bin = 'claude'

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    // Plain headless completion on Claude Code's cheap fast model (Haiku for a
    // first-party account, or the custom provider's configured/default model).
    // NO tools, NO
    // MCP (--strict-mcp-config, no --mcp-config = zero MCP init, the slowest
    // part of a cold `claude` spawn), NO session, thinking off, neutral cwd (no
    // persona CLAUDE.md). Just text in → JSON out, locally. Never the cloud.
    // --output-format json wraps the reply in a result envelope that ALSO carries
    // token usage (incl. cache_read/cache_creation) → we unwrap `.result` as the
    // text and pass `.usage` up for the triage cost ledger.
    const flags = unsafeEngineArgs('CUMORA_TRIAGE_ARGS')
    const env = claudeCoreEnv(args.env)
    const model = claudeFastModelArgs(env, args.model)
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const usingJson = flags.length === 0
    // On Windows the .cmd shim runs via the shell, which can't carry the big
    // multi-line prompt as an argv element → feed it via stdin (`claude -p` reads
    // the prompt from stdin when no prompt arg is given). POSIX: prompt in argv as
    // before (unchanged).
    const base = flags.length
      ? [...flags, '-p']
      : allowUnsandboxedByoa(env)
        ? ['-p', ...model, '--output-format', 'json', '--dangerously-skip-permissions', '--strict-mcp-config']
        : ['-p', ...model, '--output-format', 'json', '--restricted', '--tools', '', '--strict-mcp-config']
    const argv = wantsStdinPrompt ? base : (flags.length ? [...base, args.prompt] : ['-p', args.prompt, ...base.slice(1)])
    const res = await spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...env, MAX_THINKING_TOKENS: '0' },
      signal: args.signal,
      onLog: args.onLog,
      shell,
      stdinText: wantsStdinPrompt ? args.prompt : undefined,
    })
    if (res.error || !usingJson) return res // failure, or a user flag override that isn't json
    try {
      const obj = JSON.parse(res.text) as { result?: unknown; usage?: EngineUsage }
      return {
        text: typeof obj.result === 'string' ? obj.result : res.text,
        usage: obj.usage && typeof obj.usage === 'object' ? obj.usage : undefined,
      }
    } catch {
      return res // not the envelope we expected — hand back raw text
    }
  }

  probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // Mirror classify's clean one-shot spawn, but pick the tier's model: 'small'
    // → the resolved provider-local cerebellum; 'big' → omit --model so Claude
    // uses its default main reasoning brain. One token in, "OK" out — proves the binary runs
    // and that tier is authed/has quota, with NO tools/MCP/persona.
    const env = claudeCoreEnv(args.env)
    const model = args.tier === 'small' ? claudeFastModelArgs(env) : []
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const base = allowUnsandboxedByoa(env)
      ? ['-p', ...model, '--output-format', 'text', '--dangerously-skip-permissions', '--strict-mcp-config']
      : ['-p', ...model, '--output-format', 'text', '--restricted', '--tools', '', '--strict-mcp-config']
    const argv = wantsStdinPrompt ? base : ['-p', DOCTOR_PROMPT, ...base.slice(1)]
    return spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...env, MAX_THINKING_TOKENS: '0' },
      signal: args.signal,
      shell,
      stdinText: wantsStdinPrompt ? DOCTOR_PROMPT : undefined,
    })
  }

  async probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // Skipped when a CUMORA_CLAUDE_ARGS override is set — startSession() returns
    // null then, so the wake collapses to run() / one-shot exec, which probe()
    // already covers. The honest signal here is just "redundant".
    if (unsafeEngineArgs('CUMORA_CLAUDE_ARGS').length) {
      return { ok: true, detail: '', skipped: true }
    }
    // The realistic break on the persistent-session path is `--append-system-prompt-file`
    // changing name/spelling across Claude CLI versions: when it disappears, every
    // wake fails before the first token. We don't need to drive a full stream-json
    // roundtrip to catch that — running `-p` WITH the flag pointed at an empty file
    // and asking for "OK" exercises flag acceptance against the same auth path. If
    // the flag is rejected the CLI exits non-zero with a parse error; if it's
    // accepted we get the one-token reply.
    const promptFile = join(args.cwd, '.cumora-doctor-standing.md')
    try { await writeFile(promptFile, '', 'utf8') }
    catch (err) { return { ok: false, detail: `could not write standing-prompt probe file: ${err instanceof Error ? err.message : String(err)}` } }
    const env = claudeCoreEnv(args.env)
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const base = allowUnsandboxedByoa(env)
      ? ['-p', '--output-format', 'text', '--append-system-prompt-file', promptFile, '--dangerously-skip-permissions']
      : [
          '-p', '--output-format', 'text', '--append-system-prompt-file', promptFile,
          '--restricted', '--tools', '', '--strict-mcp-config',
        ]
    const argv = wantsStdinPrompt ? base : ['-p', DOCTOR_PROMPT, ...base.slice(1)]
    const r = await spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...env, MAX_THINKING_TOKENS: '0' },
      signal: args.signal,
      shell,
      stdinText: wantsStdinPrompt ? DOCTOR_PROMPT : undefined,
    })
    if (r.error || !r.text.trim()) {
      return { ok: false, detail: salientError(`${r.error ?? ''}\n${r.text ?? ''}`) || 'no output' }
    }
    return { ok: true, detail: '' }
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await ensureAgentDirectory(join(home, '.claude'))
    await ensureAgentDirectory(join(home, '.claude', 'skills'))
    // Always (re)written from the DB's name/role/systemPrompt — this file is
    // system-owned, not agent-editable, so it's safe to overwrite on every
    // start()/restart (including the restart configMatches() triggers when
    // the operator edits the agent's persona in Cumora).
    await atomicAgentWrite(join(home, 'CLAUDE.md'), PERSONA_HEADER(persona))
    // Legacy settings for unsandboxed compatibility mode. Restricted mode
    // ignores project settings and receives its narrow inline policy instead.
    if (allowUnsandboxedByoa()) {
      const settings = join(home, '.claude', 'settings.json')
      if (!(await exists(settings))) {
        await atomicAgentWrite(settings, JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2))
      }
    }
  }

  run(args: EngineRunArgs): Promise<EngineRunResult> {
    // -p: headless print mode. stream-json + verbose gives line-delimited
    // events the daemon can log. Secure mode injects a fail-closed policy;
    // the dangerous bypass remains only for explicit compatibility mode.
    // Big-brain model → --model; small-brain → ANTHROPIC_SMALL_FAST_MODEL env.
    const flags = unsafeEngineArgs('CUMORA_CLAUDE_ARGS')
    const model = args.model ? ['--model', args.model] : []
    const env = claudeTurnEnv(args.env, args.fastModel)
    // Continuous context across wakes: resume the agent's prior session so it
    // remembers the running task (its place in a counting relay, what it already
    // said) instead of re-deriving from a frozen inbox snapshot each time.
    const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    // Windows: .cmd shim runs via the shell → prompt via stdin, not argv. POSIX
    // unchanged (prompt in argv).
    const base = flags.length
      ? [...flags, ...resume, '-p']
      : allowUnsandboxedByoa(env)
        ? ['-p', ...resume, ...model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions']
        : ['-p', ...resume, ...model, '--output-format', 'stream-json', '--verbose', ...claudeSecureFlags(args.home, env)]
    const argv = wantsStdinPrompt ? base : (flags.length ? [...base, args.prompt] : ['-p', args.prompt, ...base.slice(1)])
    // Agent turns can be substantial engineering/design work. Preserve the
    // operator's reasoning preferences; only triage/doctor force thinking off.
    return spawnEngine(command, argv, { ...args, env }, { shell, stdinText: wantsStdinPrompt ? args.prompt : undefined })
  }

  startSession(args: EngineSessionArgs): EngineSession | null {
    // Respect a user's custom flag override (CUMORA_CLAUDE_ARGS) by NOT using the
    // persistent path — those flags are tuned for the one-shot run; fall back to run().
    if (unsafeEngineArgs('CUMORA_CLAUDE_ARGS').length) return null
    const model = args.model ? ['--model', args.model] : []
    const env = claudeTurnEnv(args.env, args.fastModel)
    // --resume only on the FIRST spawn / after a restart, to continue a prior
    // session; inside a live process the session continues on its own.
    const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
    // The invariant standing prompt loads ONCE here (not re-sent every turn), so
    // the per-turn stdin messages stay small and native auto-compaction keeps up.
    // Write it to a file in the agent home and pass --append-system-prompt-file.
    let sys: string[] = []
    let carriesStanding = false
    if (args.standingPrompt) {
      const file = join(args.home, '.cumora-standing-prompt.md')
      try { atomicAgentWriteSync(file, args.standingPrompt); sys = ['--append-system-prompt-file', file]; carriesStanding = true }
      catch { /* couldn't write → leave it; the daemon inlines the standing prompt instead */ }
    }
    const argv = allowUnsandboxedByoa(env)
      ? [
          '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
          ...resume, ...sys, ...model, '--dangerously-skip-permissions',
        ]
      : [
          '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
          ...resume, ...sys, ...model, ...claudeSecureFlags(args.home, env),
        ]
    return new ClaudeSession(this.bin, argv, { ...args, env }, carriesStanding)
  }
}

/** Codex requires a git repo in its cwd. The one-shot `exec` path uses
 *  --skip-git-repo-check, but app-server has no such flag, so we
 *  make the agent home a throwaway repo. Init + ONE empty commit only — we do
 *  NOT `git add` anything, so the operator's tokens/files under the home are
 *  never staged. Best-effort: a failure just means app-server may refuse, and
 *  startSession falls back to one-shot exec. */
function ensureGitRepoForCodex(home: string): void {
  if (existsSync(join(home, '.git'))) return
  const g = ['-c', 'user.name=cumora', '-c', 'user.email=cumora@local', '-c', 'commit.gpgsign=false']
  execFileSync('git', ['init'], { cwd: home, stdio: 'ignore' })
  execFileSync('git', [...g, 'commit', '--allow-empty', '-m', 'cumora init'], { cwd: home, stdio: 'ignore' })
}

type CodexRpcMsg = {
  id?: number
  method?: string
  result?: { thread?: { id?: unknown }; turn?: { id?: unknown }; turnId?: unknown }
  error?: { message?: unknown }
  params?: Record<string, unknown>
}

const CODEX_SECURE_CONFIG_ARGS = [
  '--strict-config',
  // The unelevated restricted-token sandbox cannot enforce Cumora's split
  // filesystem profile. Native Windows uses Codex's elevated sandbox instead.
  ...(IS_WIN ? ['-c', 'windows.sandbox="elevated"'] : []),
  '-c', 'default_permissions="cumora"',
  '-c', 'permissions.cumora.network.enabled=false',
  '-c', 'shell_environment_policy.inherit="none"',
  '-c', 'shell_environment_policy.ignore_default_excludes=false',
]

function codexThreadSecurityParams(): Record<string, unknown> {
  return allowUnsandboxedByoa()
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'never', sandbox: 'workspace-write' }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** The Codex core keeps its auth environment, while every model-spawned
 * command receives only this explicit, non-secret environment. */
function codexToolEnvironmentArgs(args: { home: string; env: NodeJS.ProcessEnv }): string[] {
  const entries: string[] = []
  const add = (name: string, value: string | undefined) => {
    if (value !== undefined) entries.push(`${name}=${tomlString(value)}`)
  }
  add('PATH', args.env.PATH)
  add('HOME', args.home)
  add('USER', args.env.USER)
  add('LOGNAME', args.env.LOGNAME)
  add('SHELL', args.env.SHELL)
  add('LANG', args.env.LANG)
  add('TERM', args.env.TERM)
  add('CUMORA_AGENT_IPC_DIR', args.env.CUMORA_AGENT_IPC_DIR)
  add('CUMORA_AGENT_ID', args.env.CUMORA_AGENT_ID)
  return ['-c', `shell_environment_policy.set={${entries.join(',')}}`]
}

/** Codex rejects the whole invocation when any `-c` override fails to load, and
 *  the resulting error names `config.toml` without ever mentioning that Cumora
 *  authored that config — which is how 103 workspaces spent six hours looking at
 *  agents that would not answer, with no way to reach the cause.
 *
 *  Say it once per daemon: name Cumora as the author, quote what codex actually
 *  said so it can be reported upstream, and point at the documented escape
 *  hatch. Deliberately does NOT downgrade on its own — the only fallback
 *  available is the historical `--dangerously-bypass-approvals-and-sandbox`, and
 *  trading the sandbox for availability is a maintainer's decision. */
const CODEX_CONFIG_REJECTED_RE = /Error loading config\.toml|unknown configuration field|expected struct \w+PermissionsToml/i

let codexProfileRejected = false

export function codexProfileIsRejected(): boolean {
  return codexProfileRejected
}

/** Test seam. */
export function resetCodexProfileRejection(): void {
  codexProfileRejected = false
}

export function noteCodexConfigRejection(err: string | undefined, onLog?: (line: string) => void): boolean {
  if (!err || codexProfileRejected || !CODEX_CONFIG_REJECTED_RE.test(err)) return false
  codexProfileRejected = true
  const hint = `[codex] the installed codex rejected the sandbox profile Cumora passes via -c. Every turn on this machine fails until this is resolved. Set ${ALLOW_UNSANDBOXED_BYOA_ENV}=1 on the daemon to run with the historical unsandboxed flags, or report the codex version. Codex said: ${err.slice(0, 300)}`
  onLog?.(hint)
  console.warn(hint)
  return true
}

/** The `-c` sandbox profile without the `exec`-only tail, so the persistent
 *  app-server path is confined by exactly the same profile as the one-shot path.
 *  This is the set production has since run clean: zero config rejections across
 *  every turn on 0.11.1 daemons. */
function codexSecureConfigOverrides(args: { home: string; env: NodeJS.ProcessEnv }, readOnly = false): string[] {
  const full = codexSecureExecArgs(args, readOnly)
  const exec = full.indexOf('exec')
  // Everything before `-a never exec …` is the config profile.
  return exec === -1 ? full : full.slice(0, Math.max(0, exec - 2))
}

function codexSecureExecArgs(args: { home: string; env: NodeJS.ProcessEnv }, readOnly = false): string[] {
  const workspaceAccess = readOnly ? 'read' : 'write'
  const filesystemEntries = [
    '":minimal"="read"',
    `":workspace_roots"={"."="${workspaceAccess}"}`,
  ]
  const filesystem = `permissions.cumora.filesystem={${filesystemEntries.join(',')}}`
  const secureArgs = [
    ...CODEX_SECURE_CONFIG_ARGS,
    '-c', filesystem,
    '-c', 'web_search="disabled"',
    '-c', 'features.hooks=false',
    '-c', 'features.apps=false',
    '-c', 'features.remote_plugin=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.shell_snapshot=false',
    // Untrusted projects skip project-local config, hooks, and rules. This is a
    // CLI override (highest precedence), so a model cannot plant a more
    // privileged .codex layer for the next one-shot wake.
    //
    // Written as an inline table rather than the dotted `projects."<home>".…`
    // form, because Codex 0.150/0.151 rejects a quoted dynamic map key in a
    // dotted override under --strict-config and refuses to start at all:
    //   Error loading config.toml: unknown configuration field
    //     `projects."<agent-home>"` in -c/--config override
    // Every wake then failed before the model ran, and the undelivered message
    // stayed durable, so the daemon retried the same failure forever (#144).
    //
    // The inline form parses on every version anyone has checked — 0.134.0 and
    // 0.152.0 here, 0.150.1 and 0.151.0-alpha on the report — whereas the
    // dotted form does not, so this is the strictly better-supported spelling
    // rather than a trade.
    //
    // Production since corrected one guess above: the dotted form was NOT fixed
    // after 0.151. In 30 hours it was rejected 252,589 times on POSIX across 121
    // computers, including 35,721 on 0.151.0 (18 machines) and 13,153 on 0.152.0
    // (12 machines). POSIX has no shell in this path and so no quote-stripping,
    // which is what rules out the Windows cmd.exe cause and leaves the spelling
    // itself. Do not restore the dotted form on the strength of a local check.
    '-c', `projects={${tomlString(args.home)}={trust_level="untrusted"}}`,
    ...codexToolEnvironmentArgs(args),
  ]
  if (!readOnly) {
    const mcpShim = args.env.CUMORA_AGENT_MCP_SHIM
    const ipcDir = args.env.CUMORA_AGENT_IPC_DIR
    if (!mcpShim || !ipcDir) throw new Error('secure Cumora MCP bridge is not configured')
    const mcp = `mcp_servers.cumora={command=${tomlString(process.execPath)},args=[${tomlString(mcpShim)}],env={CUMORA_AGENT_IPC_DIR=${tomlString(ipcDir)}},required=true,enabled_tools=["cli"],default_tools_approval_mode="approve"}`
    secureArgs.push('-c', mcp)
  }
  return [...secureArgs, '-a', 'never', 'exec', '--ignore-user-config', '--ignore-rules']
}

/** A persistent Codex session over the app-server JSON-RPC protocol
 *  (`codex app-server --listen stdio://`) — the transport with Codex's NATIVE
 *  context management + auto-compaction (unlike one-shot
 *  `codex exec`, which re-pays cold start and keeps no persistent context).
 *  Handshake: initialize → initialized → thread/start|resume (carrying the standing
 *  prompt as developerInstructions) → turn/start per wake. The daemon calls send()
 *  serially; each resolves on that turn's `turn/completed`. */
class CodexSession implements EngineSession {
  private readonly child: ChildProcess
  private readonly onLog: (line: string) => void
  private readonly onHopUsage?: (r: EngineHopReport) => void
  /** Wall-clock when the CURRENT turn started (turn/start request sent), used to
   *  attach latency_ms to the hop report at turn/completed. */
  private turnStartedAt: number | null = null
  private outBuf = ''
  private threadId: string | null
  private exited = false
  private exitCode = 0
  private reqId = 0
  private initializeId: number | null = null
  private threadReq: { method: string; params: Record<string, unknown> } | null
  private threadReqId: number | null = null
  private threadWasResume = false
  // thread params WITHOUT threadId — reused to start a FRESH thread if a resume fails.
  private readonly baseThreadParams: Record<string, unknown>
  private ready = false
  // Why the handshake died, when it did — so a send() landing after the teardown
  // reports the real cause instead of a generic "process gone".
  private handshakeError: string | null = null
  private pending: { resolve: (r: EngineRunResult) => void } | null = null
  private queuedPrompt: string | null = null
  private activeTurnId: string | null = null
  private steerGate = false
  private readonly model: string | null
  readonly carriesStandingPrompt: boolean
  // Codex reports a RUNNING thread token total; per-turn usage is the delta.
  private cum = { input: 0, cached: 0, output: 0 }
  private turnStart = { input: 0, cached: 0, output: 0 }

  constructor(bin: string, spawnArgs: string[], home: string, env: NodeJS.ProcessEnv, opts: EngineSessionArgs) {
    this.onLog = opts.onLog
    this.onHopUsage = opts.onHopUsage
    this.threadId = opts.resumeSessionId ?? null
    this.model = opts.model ?? null
    this.carriesStandingPrompt = !!opts.standingPrompt
    // experimentalRawEvents → Codex emits payload-free `rawResponseItem/*` pings we
    // use as a liveness signal; we suppress them from the log below.
    const params: Record<string, unknown> = {
      cwd: home,
      ...codexThreadSecurityParams(),
      experimentalRawEvents: true,
    }
    if (opts.standingPrompt) params.developerInstructions = opts.standingPrompt
    if (opts.model) params.model = opts.model
    this.baseThreadParams = params
    this.threadWasResume = !!opts.resumeSessionId
    this.threadReq = opts.resumeSessionId
      ? { method: 'thread/resume', params: { threadId: opts.resumeSessionId, ...params } }
      : { method: 'thread/start', params }
    this.child = spawnEngineChild(bin, spawnArgs, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.child.stdout?.on('data', (b: Buffer) => this.onStdout(b))
    this.child.stderr?.on('data', (b: Buffer) => { for (const raw of b.toString('utf8').split('\n')) { const l = cleanLine(raw); if (l) this.onLog(l) } })
    this.child.on('error', (err) => this.die(1, err.message))
    this.child.on('close', (code, sig) => this.die(code ?? (sig ? 128 : 1), sig ? `terminated by ${sig}` : `exited with code ${code}`))
    // Begin the handshake once handlers are attached.
    queueMicrotask(() => { this.initializeId = this.req('initialize', { clientInfo: { name: 'cumora-daemon', version: '1.0.0' }, capabilities: { experimentalApi: true } }) })
  }

  get alive(): boolean { return !this.exited && this.child.stdin?.writable === true }
  get sessionId(): string | null { return this.threadId }

  send(prompt: string): Promise<EngineRunResult> {
    if (this.pending) return Promise.resolve({ exitCode: 1, error: 'engine session busy — a turn is already in flight', sessionId: this.threadId })
    if (!this.alive) return Promise.resolve({ exitCode: this.exitCode || 1, error: this.handshakeError ?? 'engine session is not alive (process gone)', sessionId: this.threadId })
    return new Promise<EngineRunResult>((resolve) => {
      this.pending = { resolve }
      this.turnStart = { ...this.cum }
      // Fire now if the thread handshake already completed; else queue until it does.
      if (this.ready && this.threadId) this.startTurn(prompt)
      else this.queuedPrompt = prompt
    })
  }

  steer(text: string): void {
    if (!this.alive || !text.trim() || !this.threadId || !this.activeTurnId || this.steerGate) return
    writeStdin(this.child, JSON.stringify({ jsonrpc: '2.0', id: this.nextId(), method: 'turn/steer',
      params: { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: [{ type: 'text', text: stripLoneSurrogates(text) }] } }) + '\n')
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    this.exited = true
    try { this.child.stdin?.end() } catch { /* ignore */ }
    return terminateEngineTree(this.child, options.force)
  }

  private nextId(): number { this.reqId += 1; return this.reqId }
  private req(method: string, params: Record<string, unknown>): number {
    const id = this.nextId()
    writeStdin(this.child, JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }
  private notify(method: string, params: Record<string, unknown>): void {
    writeStdin(this.child, JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  private startTurn(prompt: string): void {
    if (this.threadId) {
      this.turnStartedAt = Date.now()
      this.req('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: stripLoneSurrogates(prompt) }] })
    }
  }

  private onStdout(buf: Buffer): void {
    this.outBuf += buf.toString('utf8')
    let nl: number
    while ((nl = this.outBuf.indexOf('\n')) >= 0) {
      const line = this.outBuf.slice(0, nl)
      this.outBuf = this.outBuf.slice(nl + 1)
      const t = line.trim()
      if (!t.startsWith('{')) { const c = cleanLine(line); if (c) this.onLog(c); continue }
      let msg: CodexRpcMsg | null = null
      try { msg = JSON.parse(t) as CodexRpcMsg } catch { msg = null }
      if (!msg) { const c = cleanLine(line); if (c) this.onLog(c); continue }
      // The app-server fire-hoses raw events (text deltas, per-item token/rate-limit
      // snapshots, full item start/complete JSON). The daemon needs none of it — the
      // agent acts via the `cumora` shim — so by DEFAULT we don't echo raw events to
      // the log; handle() emits concise signal lines instead (commands run, final
      // answer, compaction, errors). CUMORA_CODEX_VERBOSE=1 dumps the raw stream.
      if (CODEX_LOG_RAW) { const c = cleanLine(line); if (c) this.onLog(c) }
      this.handle(msg)
    }
  }

  private handle(msg: CodexRpcMsg): void {
    // initialize response → initialized + open the thread (start or resume).
    if (msg.id !== undefined && msg.id === this.initializeId) {
      this.initializeId = null
      if (msg.error) { this.failPending(String(msg.error.message || 'codex initialize failed')); return }
      this.notify('initialized', {})
      if (this.threadReq) { this.threadReqId = this.req(this.threadReq.method, this.threadReq.params); this.threadReq = null }
      return
    }
    // resume_or_fresh: a failed thread/resume — e.g. a stale id, or
    // a session id left over from a DIFFERENT engine after an engine switch — falls
    // back to a brand-new thread instead of wedging the agent.
    if (msg.error && msg.id !== undefined && msg.id === this.threadReqId) {
      if (this.threadWasResume) {
        this.onLog(`[codex] thread/resume failed (${String(msg.error.message || '')}) — starting a fresh thread`)
        this.threadWasResume = false
        this.threadId = null
        this.threadReqId = this.req('thread/start', this.baseThreadParams)
        return
      }
      this.failPending(String(msg.error.message || 'codex thread start failed'))
      return
    }
    // thread ready: response to thread/start|resume, OR a thread/started notification.
    const threadId = msg.result?.thread?.id ?? (msg.method === 'thread/started' ? (msg.params?.thread as { id?: unknown } | undefined)?.id : undefined)
    if (typeof threadId === 'string') { this.onThreadReady(threadId); return }
    // turn id (for steering) — from the turn/start response or turn/started notif.
    const turnId = msg.result?.turn?.id ?? msg.result?.turnId ?? (msg.method === 'turn/started' ? (msg.params?.turn as { id?: unknown } | undefined)?.id : undefined)
    if (typeof turnId === 'string') { this.activeTurnId = turnId; this.steerGate = false }
    // running thread token total.
    if (msg.method === 'thread/tokenUsage/updated') { this.updateUsage((msg.params?.tokenUsage as { total?: unknown } | undefined)?.total); return }
    // surface the account rate limit ONLY when it's getting tight (would have flagged
    // a usage-limit before it hit). Quiet otherwise.
    if (msg.method === 'account/rateLimits/updated') {
      const pct = (msg.params?.rateLimits as { primary?: { usedPercent?: unknown } } | undefined)?.primary?.usedPercent
      if (typeof pct === 'number' && pct >= 90) this.onLog(`[codex] ⚠️ account rate limit at ${Math.round(pct)}% — turns will start failing when it reaches 100%`)
      return
    }
    // items: observe native compaction; log the commands the agent runs
    // + its final answer (concise signal); a completed item briefly gates steering.
    if (msg.method === 'item/started' || msg.method === 'item/completed') {
      const item = msg.params?.item as { type?: unknown; command?: unknown; text?: unknown } | undefined
      const ty = item?.type
      if (ty === 'contextCompaction') this.onLog(`[codex] native context compaction ${msg.method === 'item/started' ? 'started' : 'finished'}`)
      else if (ty === 'commandExecution' && msg.method === 'item/started' && typeof item?.command === 'string') this.onLog(`[codex] $ ${item.command.replace(/\s+/g, ' ').slice(0, 200)}`)
      else if (ty === 'agentMessage' && msg.method === 'item/completed' && typeof item?.text === 'string' && item.text.trim()) this.onLog(`[codex] » ${item.text.replace(/\s+/g, ' ').slice(0, 200)}`)
      if (msg.method === 'item/completed') this.steerGate = true
      return
    }
    if (msg.method === 'item/agentMessage/delta' || msg.method === 'item/reasoning/textDelta' || msg.method === 'item/reasoning/summaryTextDelta') { this.steerGate = false; return }
    // request-level error (e.g. thread/start failed) → fail the in-flight turn.
    if (msg.error && msg.id !== undefined) { this.failPending(String(msg.error.message || 'codex app-server request failed')); return }
    // turn finished → resolve the pending send.
    if (msg.method === 'turn/completed') {
      const turn = msg.params?.turn as { status?: unknown; error?: { message?: unknown } } | undefined
      const failed = turn?.status === 'failed' ? String(turn?.error?.message || 'codex turn failed') : undefined
      // Per-hop trajectory for Codex: app-server doesn't expose per-message
      // usage (only running thread totals via thread/tokenUsage/updated), so
      // the finest granularity we can honestly report is ONE row per turn
      // with that turn's delta — same shape as turnUsage(). When future
      // app-server versions expose per-item usage we can split this further;
      // the ledger schema doesn't change. We deliberately emit BEFORE settle()
      // so the daemon's flush window includes this hop's row reliably.
      if (!failed && this.onHopUsage && this.model) {
        try {
          this.onHopUsage({
            model: this.model,
            usage: this.turnUsage(),
            latencyMs: this.turnStartedAt != null ? Date.now() - this.turnStartedAt : undefined,
            // Codex only reports turn-level totals today, so every emission is
            // the 1st (and only) hop for that turn. When app-server starts
            // exposing per-item usage, this becomes a real running counter.
            hopIndex: 1,
          })
        } catch { /* never break the stream */ }
      }
      this.turnStartedAt = null
      this.activeTurnId = null; this.steerGate = false
      this.settle(failed)
      return
    }
    if (msg.method === 'error') {
      const p = msg.params as { message?: unknown; error?: { message?: unknown } } | undefined
      this.failPending(String(p?.message || p?.error?.message || 'codex app-server error'))
    }
  }

  private onThreadReady(threadId: string): void {
    this.threadId = threadId
    this.ready = true
    if (this.queuedPrompt && this.pending) { const p = this.queuedPrompt; this.queuedPrompt = null; this.startTurn(p) }
  }

  private updateUsage(total: unknown): void {
    if (!total || typeof total !== 'object') return
    const t = total as Record<string, unknown>
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const input = num(t.inputTokens), cached = num(t.cachedInputTokens)
    const output = num(t.outputTokens) + num(t.reasoningOutputTokens)
    // Keep the max so a late/partial update can't regress the running total.
    this.cum = { input: Math.max(this.cum.input, input), cached: Math.max(this.cum.cached, cached), output: Math.max(this.cum.output, output) }
  }

  private turnUsage(): EngineUsage {
    const inputTotal = Math.max(0, this.cum.input - this.turnStart.input)
    const cached = Math.max(0, this.cum.cached - this.turnStart.cached)
    return {
      input_tokens: Math.max(0, inputTotal - cached), // non-cached portion (Claude-style fields)
      cache_read_input_tokens: cached,
      output_tokens: Math.max(0, this.cum.output - this.turnStart.output),
    }
  }

  private settle(error?: string): void {
    const p = this.pending
    this.pending = null
    if (p) p.resolve({ exitCode: error ? 1 : 0, error, sessionId: this.threadId, usage: this.turnUsage(), model: this.model })
  }
  private failPending(error: string): void {
    if (this.pending) this.settle(error)
    else this.onLog(`[codex] ${error}`)
    // A failure BEFORE the thread ever opened kills the SESSION, not just this
    // turn. The handshake is one-shot — threadReq is consumed at the initialize
    // ack, and only a failed thread/resume re-issues a thread/start — so `ready`
    // can never flip afterwards, and every later send() would park its prompt in
    // queuedPrompt with nothing left able to drain it (the daemon awaits that
    // promise forever, so the agent goes silently and permanently dead and its
    // big-brain slot never comes back). The app-server SURVIVES rejecting the
    // handshake (a malformed ~/.codex/config.toml, a model this account can't
    // use, protocol drift), so `alive` would keep advertising a usable session
    // and the daemon would reuse the zombie on every wake. Tear it down instead:
    // a !alive session is dropped and the next wake spawns a clean one.
    if (!this.ready) { this.handshakeError = error; this.stop() }
  }
  private die(code: number, why: string): void {
    const alreadyDown = this.exited
    this.exited = true
    this.exitCode = code
    // Same idle-death visibility as ClaudeSession.die: a session dying with no
    // turn in flight must leave a trace, not silently vanish until the next wake.
    if (!alreadyDown) {
      this.onLog(`[session] engine process died ${this.pending ? 'MID-TURN' : 'while idle'}: ${why} (exit ${code})`)
    }
    const p = this.pending
    this.pending = null
    if (p) p.resolve({ exitCode: code, error: why, sessionId: this.threadId })
  }
}

class CodexAdapter implements EngineAdapter {
  readonly id = 'codex' as const
  readonly bin = 'codex'

  classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    // Codex on a ChatGPT account can't pick an arbitrary small model
    // (`gpt-5-mini` is rejected), but it DOES accept `gpt-5.4-mini` — Cumora's
    // support tier — so that's the local cerebellum here. Cheap model, no big
    // brain, no cloud. Override with CUMORA_TRIAGE_MODEL if your codex auth has
    // a different small model.
    const flags = allowUnsandboxedByoa() ? extraArgs('CUMORA_TRIAGE_ARGS') : []
    const model = ['--model', args.model || 'gpt-5.4-mini']
    const { command, shell, argsPrefix } = resolveCodexSpawn()
    const codexArgs = flags.length
      ? ['exec', ...flags, '-']
      : allowUnsandboxedByoa()
        ? ['exec', ...model, '--skip-git-repo-check', '-']
        : [...codexSecureExecArgs({ home: args.cwd, env: args.env }, true), ...model, '--skip-git-repo-check', '-']
    const argv = [...argsPrefix, ...codexArgs]
    return spawnCapture(command, argv, {
      cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell,
      stdinText: args.prompt,
    })
  }

  probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // 'small' → gpt-5.4-mini (the cerebellum); 'big' → omit --model so Codex uses
    // its default model. `exec` non-interactive, no bypass/sandbox flags needed
    // for a tool-free one-token reply.
    const model = args.tier === 'small' ? ['--model', triageModel('gpt-5.4-mini')] : []
    const { command, shell, argsPrefix } = resolveCodexSpawn()
    const codexArgs = allowUnsandboxedByoa()
      ? ['exec', ...model, '--skip-git-repo-check', '-']
      : [...codexSecureExecArgs({ home: args.cwd, env: args.env }, true), ...model, '--skip-git-repo-check', '-']
    const argv = [...argsPrefix, ...codexArgs]
    return spawnCapture(command, argv, {
      cwd: args.cwd, env: args.env, signal: args.signal, shell, stdinText: DOCTOR_PROMPT,
    })
  }

  probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // Same gates as startSession()'s "fall back to one-shot exec" decision: when
    // any of these is true, the wake path collapses to `codex exec ...` which
    // probe() already covers — running the JSON-RPC probe would just add a false
    // signal. Mark skipped and let doctor hide the line.
    if (!allowUnsandboxedByoa()
        || unsafeEngineArgs('CUMORA_CODEX_ARGS').length
        || process.env.CUMORA_CODEX_NO_APP_SERVER === '1'
        || IS_WIN) {
      return Promise.resolve({ ok: true, detail: '', skipped: true })
    }
    // The real wake spawns `codex app-server --listen stdio://` and drives a
    // JSON-RPC handshake (initialize → thread/start). The realistic breaks here
    // are: app-server subcommand removed/renamed; protocol field names changed
    // (approvalPolicy / sandbox / experimentalRawEvents); or git repo
    // bootstrapping failing in the cwd. Drive a minimal handshake against all
    // three, then tear the process down.
    try { ensureGitRepoForCodex(args.cwd) }
    catch (err) {
      return Promise.resolve({ ok: false, detail: `git init failed for app-server cwd: ${err instanceof Error ? err.message : String(err)}` })
    }
    const { command, shell, argsPrefix } = resolveCodexSpawn()
    return new Promise<EngineWakeProbeResult>((resolve) => {
      let settled = false
      const finish = (r: EngineWakeProbeResult) => {
        if (settled) return
        settled = true
        try { child.stdin?.end() } catch { /* ignore */ }
        void terminateEngineTree(child).then(() => resolve(r))
      }
      const appServerArgs = [...argsPrefix, 'app-server', '--listen', 'stdio://']
      const child = spawnEngineChild(command, appServerArgs, {
        cwd: args.cwd, env: args.env, stdio: ['pipe', 'pipe', 'pipe'], shell,
      })
      const onAbort = () => finish({ ok: false, detail: 'aborted (timeout)' })
      if (args.signal.aborted) { onAbort(); return }
      args.signal.addEventListener('abort', onAbort, { once: true })

      let buf = ''
      let stderrTail = ''
      const initId = 1
      const threadId = 2
      let initialized = false
      let threadAcked = false
      const writeRpc = (msg: object) => {
        writeStdin(child, JSON.stringify(msg) + '\n')
      }
      // Kick off the handshake once the process is up. spawn() emits stdout
      // 'data' lazily — that's the point at which we know the child is alive
      // enough to take input. Send `initialize` and wait for its id back.
      writeRpc({ jsonrpc: '2.0', id: initId, method: 'initialize',
        params: { clientInfo: { name: 'cumora-doctor', version: '1.0.0' },
                  capabilities: { experimentalApi: true } } })
      child.stdout?.on('data', (b: Buffer) => {
        buf += b.toString('utf8')
        for (;;) {
          const nl = buf.indexOf('\n')
          if (nl < 0) break
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let msg: CodexRpcMsg
          try { msg = JSON.parse(line) as CodexRpcMsg } catch { continue }
          if (msg.error?.message) {
            finish({ ok: false, detail: `app-server rejected handshake: ${String(msg.error.message).slice(0, 240)}` })
            return
          }
          if (!initialized && msg.id === initId && msg.result) {
            initialized = true
            // notify `initialized` (no id), then thread/start with the SAME
            // params shape CodexSession uses — so a field-name break shows up.
            writeRpc({ jsonrpc: '2.0', method: 'initialized', params: {} })
            writeRpc({ jsonrpc: '2.0', id: threadId, method: 'thread/start',
              params: { cwd: args.cwd, ...codexThreadSecurityParams(), experimentalRawEvents: true } })
            continue
          }
          if (initialized && !threadAcked && msg.id === threadId && msg.result) {
            threadAcked = true
            finish({ ok: true, detail: '' })
            return
          }
        }
      })
      child.stderr?.on('data', (b: Buffer) => {
        const tail = (stderrTail + b.toString('utf8'))
        stderrTail = tail.length > 2000 ? tail.slice(-2000) : tail
      })
      child.on('error', (err) => finish({ ok: false, detail: `spawn error: ${err.message}` }))
      child.on('close', (code, sig) => {
        if (settled) return
        const stage = !initialized ? 'before initialize ack' : !threadAcked ? 'before thread/start ack' : 'after handshake'
        const exit = sig ? `terminated by ${sig}` : `exit ${code}`
        finish({ ok: false, detail: `app-server died ${stage} (${exit}): ${salientError(stderrTail) || 'no stderr'}` })
      })
    })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    // See ClaudeAdapter.seedHome: system-owned, safe to overwrite every start.
    await atomicAgentWrite(join(home, 'AGENTS.md'), PERSONA_HEADER(persona))
  }

  run(args: EngineRunArgs): Promise<EngineRunResult> {
    // `codex exec` is the non-interactive mode. Secure mode applies a custom
    // filesystem/network/environment profile and reaches Cumora only through
    // local IPC. Historical full-access flags and argv overrides remain
    // available exclusively behind the explicit compatibility opt-in.
    const flags = unsafeEngineArgs('CUMORA_CODEX_ARGS')
    const base = flags.length
      ? ['exec', ...flags]
      : allowUnsandboxedByoa()
        ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
        : [...codexSecureExecArgs(args), '--skip-git-repo-check']
    const model = args.model ? ['--model', args.model] : []
    const { command, shell, argsPrefix } = resolveCodexSpawn()
    return spawnEngine(command, [...argsPrefix, ...base, ...model, '-'], args, { shell, stdinText: args.prompt })
      .then((res) => {
        // A rejected -c override aborts codex before it reads the prompt, so the
        // turn fails with a config error that never mentions Cumora. Say it once.
        noteCodexConfigRejection(res.error, args.onLog)
        return res
      })
  }

  startSession(args: EngineSessionArgs): EngineSession | null {
    // Escape hatches → fall back to one-shot `codex exec` (run()): a custom-args
    // override, an explicit opt-out, or Windows (JSON-RPC over a .cmd shell is
    // fragile; exec is the safe path there).
    //
    // This used to `return null` unless BYOA was explicitly unsandboxed, because
    // app-server has no equivalent to `exec --ignore-user-config`. The cost of
    // that was invisible in the code: with no persistent process every codex
    // turn is a fresh session, so agents answered each message with no memory of
    // the one before — what users reported as the agent not remembering the
    // previous exchange.
    //
    // `-c` are global flags and DO apply to app-server, so the filesystem,
    // network, environment and feature profile below is identical on both paths.
    // What app-server cannot exclude is a user's own ~/.codex adding EXTRA
    // mcp_servers — a narrower gap than losing every agent's continuity, on the
    // operator's own machine, with their own config. CUMORA_CODEX_NO_APP_SERVER=1
    // still opts out, and a failing session degrades to one-shot (see daemon.ts).
    if (unsafeEngineArgs('CUMORA_CODEX_ARGS').length) return null
    if (process.env.CUMORA_CODEX_NO_APP_SERVER === '1') return null
    if (IS_WIN) return null
    try { ensureGitRepoForCodex(args.home) }
    catch (err) { args.onLog(`[codex] could not init git repo for app-server (${err instanceof Error ? err.message : String(err)}) — falling back to one-shot exec`); return null }
    // Standing prompt rides the thread's developerInstructions (see CodexSession),
    // approval/sandbox are set per-thread, so no global bypass flags are needed.
    const { command, argsPrefix } = resolveCodexSpawn()
    // Confine the persistent process with the same profile the one-shot path
    // uses. `-c` are global flags and apply to app-server too, so filesystem,
    // network, environment and features are identical on both paths.
    const secure = allowUnsandboxedByoa()
      ? []
      : codexSecureConfigOverrides({ home: args.home, env: args.env })
    return new CodexSession(command, [...argsPrefix, ...secure, 'app-server', '--listen', 'stdio://'], args.home, args.env, args)
  }
}

/** Official Grok Build install lives at ~/.grok/bin even when that dir is
 *  not on the daemon's PATH (launchd / login-shell mismatch). PATH wins. */
function resolveGrokBin(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(PATH_DELIMITER)) {
    if (!dir) continue
    const candidate = join(dir, IS_WIN ? 'grok.exe' : 'grok')
    if (existsSync(candidate)) return candidate
    if (IS_WIN && existsSync(join(dir, 'grok'))) return join(dir, 'grok')
  }
  const homeBin = join(homedir(), '.grok', 'bin', IS_WIN ? 'grok.exe' : 'grok')
  return existsSync(homeBin) ? homeBin : null
}

type AcpMsg = {
  jsonrpc?: string
  id?: number
  method?: string
  result?: { sessionId?: unknown }
  error?: { message?: unknown }
  params?: Record<string, unknown>
}

/** Persistent Grok Build session over ACP stdio (`grok agent --always-approve stdio`).
 *  Handshake: initialize → session/new|load → session/prompt per wake.
 *  Mid-turn steer is not in the ACP surface Grok exposes — steer() is a no-op
 *  and the daemon's next-wake coalescing carries the ping instead. */
class GrokSession implements EngineSession {
  private readonly child: ChildProcess
  private readonly onLog: (line: string) => void
  private readonly onHopUsage?: (r: EngineHopReport) => void
  private outBuf = ''
  private sid: string | null
  private exited = false
  private exitCode = 0
  private reqId = 0
  private initializeId: number | null = null
  private sessionReqId: number | null = null
  private sessionWasLoad = false
  private readonly sessionNewParams: Record<string, unknown>
  private ready = false
  private pending: { resolve: (r: EngineRunResult) => void; id: number; startedAt: number } | null = null
  private queuedPrompt: string | null = null
  private steerWarned = false
  private readonly model: string | null
  /** The model the agent is ACTUALLY running on, as reported by the ACP stream
   *  (`_x.ai/models/update` → `currentModelId`). `this.model` is only the pin
   *  Cumora asked for, and is null whenever the operator left the model
   *  unpinned — which is the default. Mirrors ClaudeSession sniffing
   *  `message.model` off its own stream. */
  private curModel: string | null = null
  readonly carriesStandingPrompt: boolean

  constructor(bin: string, spawnArgs: string[], home: string, env: NodeJS.ProcessEnv, opts: EngineSessionArgs) {
    this.onLog = opts.onLog
    this.onHopUsage = opts.onHopUsage
    this.sid = opts.resumeSessionId ?? null
    this.model = opts.model ?? null
    this.carriesStandingPrompt = !!opts.standingPrompt
    const meta: Record<string, unknown> = { yoloMode: true }
    if (opts.standingPrompt) meta.rules = opts.standingPrompt
    this.sessionNewParams = { cwd: home, mcpServers: [], _meta: meta }
    this.sessionWasLoad = !!opts.resumeSessionId
    const grokEnv: NodeJS.ProcessEnv = { ...env, GROK_DISABLE_AUTOUPDATER: env.GROK_DISABLE_AUTOUPDATER ?? '1' }
    this.child = spawnEngineChild(bin, spawnArgs, { cwd: home, env: grokEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.child.stdout?.on('data', (b: Buffer) => this.onStdout(b))
    this.child.stderr?.on('data', (b: Buffer) => {
      for (const raw of b.toString('utf8').split('\n')) {
        const l = cleanLine(raw)
        if (l) this.onLog(l)
      }
    })
    this.child.on('error', (err) => this.die(1, err.message))
    this.child.on('close', (code, sig) => this.die(code ?? (sig ? 128 : 1), sig ? `terminated by ${sig}` : `exited with code ${code}`))
    queueMicrotask(() => {
      this.initializeId = this.req('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'cumora-daemon', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
    })
  }

  get alive(): boolean { return !this.exited && this.child.stdin?.writable === true }
  get sessionId(): string | null { return this.sid }

  send(prompt: string): Promise<EngineRunResult> {
    if (this.pending) return Promise.resolve({ exitCode: 1, error: 'engine session busy — a turn is already in flight', sessionId: this.sid })
    if (!this.alive) return Promise.resolve({ exitCode: this.exitCode || 1, error: 'engine session is not alive (process gone)', sessionId: this.sid })
    return new Promise<EngineRunResult>((resolve) => {
      this.pending = { resolve, id: 0, startedAt: Date.now() }
      if (this.ready && this.sid) this.startPrompt(prompt)
      else this.queuedPrompt = prompt
    })
  }

  steer(_text: string): void {
    // ACP session/prompt is one-in-flight. A mid-turn inject would cancel the
    // running turn. The daemon coalesces the ping onto the next wake instead.
    if (!this.steerWarned) {
      this.steerWarned = true
      this.onLog('[grok] same-turn steer is not supported on ACP stdio — the ping rides the next wake')
    }
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    this.exited = true
    try { this.child.stdin?.end() } catch { /* ignore */ }
    return terminateEngineTree(this.child, options.force)
  }

  private nextId(): number { this.reqId += 1; return this.reqId }
  private req(method: string, params: Record<string, unknown>): number {
    const id = this.nextId()
    writeStdin(this.child, JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return id
  }

  private startPrompt(prompt: string): void {
    if (!this.sid || !this.pending) return
    const id = this.req('session/prompt', {
      sessionId: this.sid,
      prompt: [{ type: 'text', text: stripLoneSurrogates(prompt) }],
    })
    this.pending.id = id
  }

  private onStdout(buf: Buffer): void {
    this.outBuf += buf.toString('utf8')
    let nl: number
    while ((nl = this.outBuf.indexOf('\n')) >= 0) {
      const line = this.outBuf.slice(0, nl)
      this.outBuf = this.outBuf.slice(nl + 1)
      const t = line.trim()
      if (!t.startsWith('{')) { const c = cleanLine(line); if (c) this.onLog(c); continue }
      let msg: AcpMsg | null = null
      try { msg = JSON.parse(t) as AcpMsg } catch { msg = null }
      if (!msg) { const c = cleanLine(line); if (c) this.onLog(c); continue }
      this.handle(msg)
    }
  }

  private handle(msg: AcpMsg): void {
    if (msg.id !== undefined && msg.id === this.initializeId) {
      this.initializeId = null
      if (msg.error) { this.failPending(String(msg.error.message || 'grok initialize failed')); return }
      if (this.sessionWasLoad && this.sid) {
        this.sessionReqId = this.req('session/load', { sessionId: this.sid, ...this.sessionNewParams })
      } else {
        this.sessionReqId = this.req('session/new', this.sessionNewParams)
      }
      return
    }
    if (msg.error && msg.id !== undefined && msg.id === this.sessionReqId) {
      if (this.sessionWasLoad) {
        this.onLog(`[grok] session/load failed (${String(msg.error.message || '')}) — starting a fresh session`)
        this.sessionWasLoad = false
        this.sid = null
        this.sessionReqId = this.req('session/new', this.sessionNewParams)
        return
      }
      this.failPending(String(msg.error.message || 'grok session start failed'))
      return
    }
    if (msg.id !== undefined && msg.id === this.sessionReqId && msg.result) {
      const sid = typeof msg.result.sessionId === 'string' ? msg.result.sessionId : this.sid
      this.sessionReqId = null
      if (typeof sid === 'string' && sid) this.sid = sid
      this.ready = true
      if (this.queuedPrompt && this.pending) {
        const p = this.queuedPrompt
        this.queuedPrompt = null
        this.startPrompt(p)
      }
      return
    }
    // Grok announces the live model here, and again whenever it changes mid
    // session. Without it the ledger prices every ACP turn on a pin that is
    // usually absent (see curModel).
    if (msg.method === '_x.ai/models/update') {
      const id = (msg.params as { currentModelId?: unknown } | undefined)?.currentModelId
      if (typeof id === 'string' && id) this.curModel = id
      return
    }
    if (msg.method === 'session/update') {
      const update = (msg.params?.update ?? msg.params?.sessionUpdate) as Record<string, unknown> | undefined
      const kind = typeof update?.sessionUpdate === 'string' ? update.sessionUpdate
        : typeof update?.sessionUpdate === 'undefined' && typeof (msg.params as { sessionUpdate?: unknown } | undefined)?.sessionUpdate === 'string'
          ? String((msg.params as { sessionUpdate?: unknown }).sessionUpdate)
          : null
      const u = (update ?? msg.params ?? {}) as Record<string, unknown>
      const k = kind ?? (typeof u.sessionUpdate === 'string' ? u.sessionUpdate : null)
      if (k === 'tool_call' && typeof u.title === 'string') this.onLog(`[grok] tool ${u.title}`)
      else if (k === 'agent_message_chunk') {
        const content = u.content as { text?: unknown } | undefined
        if (typeof content?.text === 'string' && content.text.trim()) {
          this.onLog(`[grok] » ${content.text.replace(/\s+/g, ' ').slice(0, 200)}`)
        }
      }
      return
    }
    if (this.pending && msg.id !== undefined && msg.id === this.pending.id) {
      if (msg.error) { this.failPending(String(msg.error.message || 'grok prompt failed')); return }
      const usage = extractAcpUsage(msg.result)
      if (this.onHopUsage) {
        try {
          this.onHopUsage({
            model: this.curModel || this.model || 'grok',
            usage: usage ?? {},
            latencyMs: Date.now() - this.pending.startedAt,
            hopIndex: 1,
          })
        } catch { /* never break the stream */ }
      }
      const p = this.pending
      this.pending = null
      p.resolve({ exitCode: 0, sessionId: this.sid, usage, model: this.curModel || this.model })
      return
    }
    if (msg.error && msg.id !== undefined) {
      this.failPending(String(msg.error.message || 'grok acp request failed'))
    }
  }

  private failPending(error: string): void {
    if (this.pending) {
      const p = this.pending
      this.pending = null
      p.resolve({ exitCode: 1, error, sessionId: this.sid })
    } else {
      this.onLog(`[grok] ${error}`)
    }
  }

  private die(code: number, why: string): void {
    const alreadyDown = this.exited
    this.exited = true
    this.exitCode = code
    if (!alreadyDown) {
      this.onLog(`[session] engine process died ${this.pending ? 'MID-TURN' : 'while idle'}: ${why} (exit ${code})`)
    }
    if (this.pending) {
      const p = this.pending
      this.pending = null
      p.resolve({ exitCode: code, error: why, sessionId: this.sid })
    }
  }
}

function extractAcpUsage(result: unknown): EngineUsage | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  const raw = (r.usage ?? (r._meta as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined
  if (!raw || typeof raw !== 'object') return undefined
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const usage: EngineUsage = {
    input_tokens: num(raw.input_tokens) ?? num(raw.inputTokens),
    output_tokens: num(raw.output_tokens) ?? num(raw.outputTokens),
    cache_read_input_tokens: num(raw.cache_read_input_tokens) ?? num(raw.cacheReadInputTokens),
    cache_creation_input_tokens: num(raw.cache_creation_input_tokens) ?? num(raw.cacheCreationInputTokens),
  }
  if (usage.input_tokens == null && usage.output_tokens == null) return undefined
  return usage
}

class GrokAdapter implements EngineAdapter {
  readonly id = 'grok' as const
  readonly bin = 'grok'

  private command(env?: NodeJS.ProcessEnv): string {
    return resolveGrokBin(env) ?? this.bin
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_TRIAGE_ARGS')
    const model = ['--model', args.model || 'grok-4.5']
    const command = this.command(args.env)
    const { shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const usingJson = flags.length === 0
    const base = flags.length
      ? [...flags, '-p']
      : ['-p', ...model, '--output-format', 'json', '--always-approve', '--no-auto-update']
    const argv = wantsStdinPrompt ? base : (flags.length ? [...base, args.prompt] : ['-p', args.prompt, ...base.slice(1)])
    const res = await spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...args.env, GROK_DISABLE_AUTOUPDATER: args.env.GROK_DISABLE_AUTOUPDATER ?? '1' },
      signal: args.signal,
      onLog: args.onLog,
      shell,
      stdinText: wantsStdinPrompt ? args.prompt : undefined,
    })
    if (res.error || !usingJson) return res
    try {
      const obj = JSON.parse(res.text) as { text?: unknown; usage?: EngineUsage }
      return {
        text: typeof obj.text === 'string' ? obj.text : res.text,
        usage: obj.usage && typeof obj.usage === 'object' ? obj.usage : undefined,
      }
    } catch {
      return res
    }
  }

  probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    const model = args.tier === 'small' ? ['--model', 'grok-4.5'] : []
    const command = this.command(args.env)
    const { shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const base = ['-p', ...model, '--output-format', 'json', '--always-approve', '--no-auto-update']
    const argv = wantsStdinPrompt ? base : ['-p', DOCTOR_PROMPT, ...base.slice(1)]
    return spawnCapture(command, argv, {
      cwd: args.cwd,
      env: { ...args.env, GROK_DISABLE_AUTOUPDATER: args.env.GROK_DISABLE_AUTOUPDATER ?? '1' },
      signal: args.signal,
      shell,
      stdinText: wantsStdinPrompt ? DOCTOR_PROMPT : undefined,
    })
  }

  async probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // Same gates as startSession: custom args / opt-out / Windows collapse to
    // one-shot `grok -p`, which probe() already covers.
    if (extraArgs('CUMORA_GROK_ARGS').length || process.env.CUMORA_GROK_NO_ACP === '1' || IS_WIN) {
      return { ok: true, detail: '', skipped: true }
    }
    const command = this.command(args.env)
    return new Promise<EngineWakeProbeResult>((resolve) => {
      let settled = false
      const finish = (r: EngineWakeProbeResult) => {
        if (settled) return
        settled = true
        try { child.stdin?.end() } catch { /* ignore */ }
        void terminateEngineTree(child).then(() => resolve(r))
      }
      const child = spawnEngineChild(command, ['agent', '--always-approve', '--no-leader', 'stdio'], {
        cwd: args.cwd,
        env: { ...args.env, GROK_DISABLE_AUTOUPDATER: args.env.GROK_DISABLE_AUTOUPDATER ?? '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
      const onAbort = () => finish({ ok: false, detail: 'aborted (timeout)' })
      if (args.signal.aborted) { onAbort(); return }
      args.signal.addEventListener('abort', onAbort, { once: true })
      let buf = ''
      let stderrTail = ''
      const initId = 1
      const sessionId = 2
      let initialized = false
      const writeRpc = (msg: object) => {
        writeStdin(child, JSON.stringify(msg) + '\n')
      }
      writeRpc({
        jsonrpc: '2.0', id: initId, method: 'initialize',
        params: { protocolVersion: 1, clientInfo: { name: 'cumora-doctor', version: '1.0.0' }, clientCapabilities: {} },
      })
      child.stdout?.on('data', (b: Buffer) => {
        buf += b.toString('utf8')
        for (;;) {
          const nl = buf.indexOf('\n')
          if (nl < 0) break
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('{')) continue
          let msg: AcpMsg
          try { msg = JSON.parse(line) as AcpMsg } catch { continue }
          if (msg.error?.message) {
            finish({ ok: false, detail: `acp rejected handshake: ${String(msg.error.message).slice(0, 240)}` })
            return
          }
          if (!initialized && msg.id === initId && msg.result) {
            initialized = true
            writeRpc({
              jsonrpc: '2.0', id: sessionId, method: 'session/new',
              params: { cwd: args.cwd, mcpServers: [], _meta: { yoloMode: true } },
            })
            continue
          }
          if (initialized && msg.id === sessionId && msg.result) {
            finish({ ok: true, detail: '' })
            return
          }
        }
      })
      child.stderr?.on('data', (b: Buffer) => {
        const tail = stderrTail + b.toString('utf8')
        stderrTail = tail.length > 2000 ? tail.slice(-2000) : tail
      })
      child.on('error', (err) => finish({ ok: false, detail: `spawn error: ${err.message}` }))
      child.on('close', (code, sig) => {
        if (settled) return
        const stage = !initialized ? 'before initialize ack' : 'before session/new ack'
        const exit = sig ? `terminated by ${sig}` : `exit ${code}`
        finish({ ok: false, detail: `grok agent stdio died ${stage} (${exit}): ${salientError(stderrTail) || 'no stderr'}` })
      })
    })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    const agentsMd = join(home, 'AGENTS.md')
    if (!(await exists(agentsMd))) await writeFile(agentsMd, PERSONA_HEADER(persona), 'utf8')
  }

  run(args: EngineRunArgs): Promise<EngineRunResult> {
    const flags = extraArgs('CUMORA_GROK_ARGS')
    const model = args.model ? ['--model', args.model] : []
    const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
    const command = this.command(args.env)
    const { shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const base = flags.length
      ? [...flags, ...resume, '-p']
      : ['-p', ...resume, ...model, '--output-format', 'streaming-messages-json', '--always-approve', '--no-auto-update']
    const argv = wantsStdinPrompt ? base : (flags.length ? [...base, args.prompt] : ['-p', args.prompt, ...base.slice(1)])
    const env: NodeJS.ProcessEnv = { ...args.env, GROK_DISABLE_AUTOUPDATER: args.env.GROK_DISABLE_AUTOUPDATER ?? '1' }
    return spawnEngine(command, argv, { ...args, env }, { shell, stdinText: wantsStdinPrompt ? args.prompt : undefined })
  }

  startSession(args: EngineSessionArgs): EngineSession | null {
    if (extraArgs('CUMORA_GROK_ARGS').length) return null
    if (process.env.CUMORA_GROK_NO_ACP === '1') return null
    // JSON-RPC over a Windows .cmd shim is the same trap Codex hits — exec
    // (`grok -p`) is the safe path there.
    if (IS_WIN) return null
    const model = args.model ? ['--model', args.model] : []
    return new GrokSession(this.command(args.env), ['agent', '--always-approve', '--no-leader', ...model, 'stdio'], args.home, args.env, args)
  }
}

// ─── cursor ───────────────────────────────────────────────────────────────
//
// Cursor Agent (the `cursor-agent` CLI bundled with Cursor, 2026.08.11-e8db854)
// is a ONE-SHOT engine: this version exposes no persistent stdio protocol, so
// there is no startSession — every wake spawns a fresh process and continuity
// comes from `--resume <session_id>`, which re-opens the SAME session id in the
// next one-shot process. The daemon's generic one-shot run() path IS the wake
// path; probeWake() therefore always reports `skipped` (probe() already
// exercises the exact spawn a wake uses).
//
//   cursor-agent -p --output-format stream-json --force --trust \
//     [--model X] [--resume <id>] <prompt>
//
// The stream: a `system/init` event (session id + model), user/assistant/
// thinking events, and a terminal `result` event carrying the turn's usage.
// Two contract quirks that shape this adapter:
//   - A stream may report `is_error:true` with process exit 0 — that is a
//     FAILED turn (model unavailable, …), so the stream decides, not the exit
//     code, so the stream result is authoritative.
//   - usage reports uncached input and cache reads as separate fields, matching
//     Cursor's bundled `TokenUsage` schema; map them directly without folding.
// Triage/probe use the READ-ONLY `--mode ask` variant and never `--force`.

/** Cursor's result-event usage (OpenAI-ish camelCase). Its bundled TokenUsage
 *  schema carries uncached input and cache reads as separate counters. */
interface CursorUsage { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/** The subset of Cursor's stream-json we act on. Everything else is logged and
 *  ignored, so a new event type in a future Cursor never breaks a turn. */
interface CursorEvent {
  type?: unknown
  subtype?: unknown
  session_id?: unknown
  model?: unknown
  is_error?: unknown
  result?: unknown
  usage?: CursorUsage
  message?: { role?: unknown; content?: unknown }
}

/** Normalize Cursor's disjoint usage counters into EngineUsage;
 *  cacheWrite maps to cache_creation. */
function cursorUsageToEngineUsage(u: CursorUsage | undefined): EngineUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input_tokens: num(u.inputTokens),
    output_tokens: num(u.outputTokens),
    cache_read_input_tokens: num(u.cacheReadTokens),
    cache_creation_input_tokens: num(u.cacheWriteTokens),
  }
}

/** Concatenate the text items of a Cursor message content array (same
 *  `{type:'text', text}` item shape Claude uses). */
function cursorTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const it = item as { type?: unknown; text?: unknown }
    if (it.type === 'text' && typeof it.text === 'string') out += it.text
  }
  return out
}

/** Folds Cursor's stream-json into what the daemon wants from a turn: the
 *  session id (every event repeats it — resume keeps continuity across the
 *  per-wake processes), the model from `system/init` (or the pin when the
 *  stream never names one), the normalized turn usage, the concatenated
 *  assistant text (triage reads it), and the result event's error. ONE
 *  turn-level EngineHopReport fires at the `result` event — Cursor reports
 *  usage once per turn, so emitting per assistant message would double-count. */
class CursorTurnTracker {
  sessionId: string | null = null
  model: string | null
  usage: EngineUsage | undefined
  text = ''
  error: string | null = null
  sawResult = false
  private startedAt: number | null = null

  constructor(
    pin: string | null,
    private readonly onHopUsage?: (r: EngineHopReport) => void,
  ) {
    this.model = pin
  }

  /** Feed one event. Returns true when the event terminates the turn. */
  observe(ev: CursorEvent): boolean {
    if (typeof ev.session_id === 'string' && ev.session_id) this.sessionId = ev.session_id
    if (ev.type === 'system' && ev.subtype === 'init') {
      // init's model is what Cursor actually opened the session on — it wins
      // over the pin (which is only what we asked for).
      if (typeof ev.model === 'string' && ev.model) this.model = ev.model
      if (this.startedAt == null) this.startedAt = Date.now()
      return false
    }
    if (ev.type === 'assistant') {
      this.text += cursorTextOf(ev.message?.content)
      return false
    }
    if (ev.type === 'result') {
      this.sawResult = true
      this.usage = cursorUsageToEngineUsage(ev.usage)
      if (ev.is_error === true) {
        this.error = typeof ev.result === 'string' && ev.result
          ? ev.result
          : `cursor turn error${typeof ev.subtype === 'string' ? ` (${ev.subtype})` : ''}`
      }
      // The single turn-level hop — Cursor has no per-message usage, so this
      // is the honest granularity (same contract as Codex's turn-completed).
      if (ev.is_error !== true && this.usage && this.model && this.onHopUsage) {
        const startedAt = this.startedAt
        try {
          this.onHopUsage({
            model: this.model,
            usage: this.usage,
            latencyMs: startedAt != null ? Date.now() - startedAt : undefined,
            hopIndex: 1,
            textChars: this.text.length,
          })
        } catch { /* ledger best-effort — never break the stream */ }
      }
      return true
    }
    return false
  }
}

/** Parse one stdout line of Cursor's stream-json. Non-JSON lines (banners,
 * warnings that land on stdout) come back null and are logged verbatim. */
function parseCursorLine(line: string): CursorEvent | null {
  if (!line.startsWith('{')) return null
  try { return JSON.parse(line) as CursorEvent } catch { return null }
}

/** One-shot `cursor-agent -p --output-format stream-json …`: spawn, fold the
 *  stream through a CursorTurnTracker, resolve on exit. The tracker's error is
 *  folded into the result because a Cursor stream reports failure via
 *  `is_error:true` regardless of the process exit code. Text is the
 *  concatenated assistant text — what classify()/probe() want. */
function spawnCursorStream(
  command: string,
  args: string[],
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    shell: boolean
    stdinText?: string
    onHopUsage?: (r: EngineHopReport) => void
    /** Model pin, used as the tracker's model until system/init names one. */
    pin?: string | null
    /** Fail a clean-exiting stream that never emitted its terminal `result`
     *  event (run(): a turn that never finished is not a success). classify()
     *  and probe() settle for whatever text arrived. */
    requireResult?: boolean
  },
): Promise<EngineRunResult & { text: string }> {
  return new Promise((resolve) => {
    const tracker = new CursorTurnTracker(opts.pin ?? null, opts.onHopUsage)
    const child = spawnEngineChild(command, args, {
      cwd: opts.cwd, env: opts.env,
      stdio: [opts.stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: opts.shell,
    })
    if (opts.stdinText != null) {
      writeStdin(child, opts.stdinText, { end: true })
    }
    const abort = bindAbortTermination(child, opts.signal)
    const stderrTail: string[] = []
    const stdoutTail: string[] = []
    const decoder: Record<'stdout' | 'stderr', StringDecoder> = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    }
    const carry: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
    const takeLine = (stream: 'stdout' | 'stderr', raw: string): void => {
      const line = cleanLine(raw)
      if (!line) return
      pushTail(stream === 'stderr' ? stderrTail : stdoutTail, line)
      opts.onLog?.(line)
      if (stream === 'stdout') {
        const ev = parseCursorLine(line)
        if (ev) tracker.observe(ev)
      }
    }
    const pump = (stream: 'stdout' | 'stderr', buf: Buffer | null): void => {
      const text = buf === null ? decoder[stream].end() : decoder[stream].write(buf)
      const lines = (carry[stream] + text).split('\n')
      carry[stream] = buf === null ? '' : (lines.pop() ?? '')
      for (const line of lines) takeLine(stream, line)
    }
    child.stdout?.on('data', (buf: Buffer) => pump('stdout', buf))
    child.stderr?.on('data', (buf: Buffer) => pump('stderr', buf))
    let settled = false
    child.on('error', (err) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => {
        resolve({ exitCode: 1, error: err instanceof Error ? err.message : String(err), sessionId: null, text: '' })
      })
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => {
        pump('stdout', null)
        pump('stderr', null)
        const procExit = code ?? (signalName ? 128 : 1)
        // The stream is the truth: is_error:true fails the turn even on exit 0.
        const streamError = tracker.error
          ? `engine turn error: ${tracker.error.slice(0, MAX_FAILURE_CHARS)}`
          : (opts.requireResult && !tracker.sawResult
            ? 'engine stream ended without a result event (cursor-agent exited early)'
            : null)
        const exitCode = procExit !== 0 ? procExit : (streamError ? 1 : 0)
        const error = procExit !== 0
          ? failurePreview({ exitCode: procExit, signalName, stderr: stderrTail, stdout: stdoutTail })
          : streamError ?? undefined
        resolve({ exitCode, error, sessionId: tracker.sessionId, usage: tracker.usage, model: tracker.model, text: tracker.text })
      })
    })
  })
}

class CursorAdapter implements EngineAdapter {
  readonly id = 'cursor' as const
  readonly bin = 'cursor-agent'

  /** A turn: full-tools one-shot (`--force` auto-approves the agent's tool use
   *  inside its dedicated, user-owned home — the Cursor analogue of Claude's
   *  --dangerously-skip-permissions), `--trust` skips the workspace-trust
   *  prompt a headless spawn can't answer. The prompt is the LAST argv element
   *  (Cursor takes it positionally); on Windows it travels via stdin instead. */
  private turn(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
    resumeSessionId?: string | null
    onHopUsage?: (r: EngineHopReport) => void
  }): Promise<EngineRunResult & { text: string }> {
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const model = args.model ? ['--model', args.model] : []
    // Continuous context across wakes: --resume re-opens the prior session in
    // this fresh one-shot process (Cursor has no persistent protocol to keep
    // warm instead).
    const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
    const base = ['-p', ...resume, ...model, '--output-format', 'stream-json', '--force', '--trust']
    return spawnCursorStream(command, wantsStdinPrompt ? base : [...base, prompt], {
      cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell,
      stdinText: wantsStdinPrompt ? prompt : undefined,
      onHopUsage: args.onHopUsage,
      pin: args.model ?? null,
      requireResult: true,
    })
  }

  /** The READ-ONE triage/probe shape: `--mode ask` keeps the agent Q&A-only
   *  (no edits, no shell), so classification can never mutate anything. Never
   *  `--force` here. */
  private ask(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
  }): Promise<EngineRunResult & { text: string }> {
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const model = args.model ? ['--model', args.model] : []
    const base = ['--mode', 'ask', '-p', '--output-format', 'stream-json', ...model, '--trust']
    return spawnCursorStream(command, wantsStdinPrompt ? base : [...base, prompt], {
      cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell,
      stdinText: wantsStdinPrompt ? prompt : undefined,
      pin: args.model ?? null,
    })
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_TRIAGE_ARGS')
    if (flags.length) {
      // User-owned triage flag set → plain print mode, raw text back (the same
      // override discipline the other engines share; no stream to fold).
      const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
      const base = [...flags, '-p']
      return spawnCapture(command, wantsStdinPrompt ? base : [...base, args.prompt], {
        cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell,
        stdinText: wantsStdinPrompt ? args.prompt : undefined,
      })
    }
    // Cursor has no fixed cheap cerebellum id (its models are account-gated
    // aliases); unset CUMORA_TRIAGE_MODEL → Cursor's default ('Auto'), honestly
    // reported back by the stream's system/init for the ledger.
    const r = await this.ask(args.prompt, { cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, model: args.model })
    return { text: r.text, error: r.error, usage: r.usage, model: r.model }
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // 'small' → whatever triage runs on (CUMORA_TRIAGE_MODEL, else Cursor's
    // default — the same model as 'big', honestly reported as such); 'big' →
    // Cursor's default. Read-only ask mode either way.
    const model = args.tier === 'small' ? (process.env.CUMORA_TRIAGE_MODEL || null) : null
    const r = await this.ask(DOCTOR_PROMPT, { cwd: args.cwd, env: args.env, signal: args.signal, model })
    return { text: r.text, error: r.error, usage: r.usage, model: r.model }
  }

  probeWake(_args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // There is no distinct wake path to probe: no persistent protocol in this
    // cursor-agent version, so the wake is the SAME one-shot spawn probe()
    // already exercises. Mark skipped so doctor hides the redundant line.
    return Promise.resolve({ ok: true, detail: '', skipped: true })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await mkdir(join(home, '.cursor', 'skills'), { recursive: true })
    // Always rewrite AGENTS.md so persona edits land without requiring a fresh
    // home (matches Claude and Codex). Cursor discovers AGENTS.md from its cwd.
    await writeFile(
      join(home, 'AGENTS.md'),
      PERSONA_HEADER(persona, { personaFile: 'AGENTS.md', skillsDir: '.cursor/skills/' }),
      'utf8',
    )
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    const flags = extraArgs('CUMORA_CURSOR_ARGS')
    if (flags.length) {
      // Whole user-owned flag override → opaque print mode (same escape hatch
      // as CUMORA_CLAUDE_ARGS / CUMORA_CODEX_ARGS / CUMORA_GROK_ARGS): we can't
      // assume the stream-json shape, so no usage/hop ledger — but keep
      // --resume + -p + prompt so session continuity survives the override.
      const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
      const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
      const base = [...flags, ...resume, '-p']
      return spawnEngine(command, wantsStdinPrompt ? base : [...base, args.prompt], args, { shell, stdinText: wantsStdinPrompt ? args.prompt : undefined })
    }
    return this.turn(args.prompt, {
      cwd: args.home, env: args.env, signal: args.signal, onLog: args.onLog,
      model: args.model, resumeSessionId: args.resumeSessionId, onHopUsage: args.onHopUsage,
    })
  }

  // No startSession: Cursor exposes no persistent stdio protocol in this
  // version — the daemon runs the one-shot path above per wake and resumes
  // the session id it reports (see the section note).
}

// ─── opencode ────────────────────────────────────────────────────────────
//
// OpenCode (the `opencode` CLI, contract verified against v1.18.20) is a
// ONE-SHOT engine in Cumora. `opencode run --format json` starts a process for
// one wake and emits JSONL events; continuity comes from passing the emitted
// `sessionID` back through `--session <id>` on the next wake. OpenCode has an
// ACP server, but that protocol is intended for editor clients and does not buy
// us the daemon's standing-prompt/session semantics, so the supported path is
// the documented `run` interface.
//
//   opencode run --format json --auto [--model provider/model]
//     [--session <id>]                 # prompt always travels via stdin
//
// A `step_finish` event is one provider hop. Its token fields are already
// disjoint (uncached input, output, reasoning, cache read/write), so the
// adapter can report honest per-hop ledger rows and sum them for the turn.
// OpenCode's event loop can race the terminal `session.status=idle` event and
// omit the final step_finish even after a successful run, so process exit 0 is
// authoritative; accounting is best-effort rather than a completion gate.
// OpenCode's JSON stream does not currently include the resolved model when no
// pin is supplied; in that case the hop uses the explicit `opencode` fallback
// label rather than inventing a provider/model id.
//
// Full turns use `--auto` because the daemon is headless and the agent's home is
// operator-owned. Triage/doctor deliberately do NOT: they select an injected
// `cumora-triage` agent whose wildcard permission is `deny`, giving the small
// brain a hard, tool-free boundary even if the user's normal OpenCode agent is
// configured to allow shell or edits.

interface OpenCodeTokens {
  input?: unknown
  output?: unknown
  reasoning?: unknown
  cache?: { read?: unknown; write?: unknown }
}

interface OpenCodePart {
  type?: unknown
  text?: unknown
  tokens?: OpenCodeTokens
}

interface OpenCodeEvent {
  type?: unknown
  sessionID?: unknown
  part?: OpenCodePart
  error?: unknown
}

function openCodeUsage(tokens: OpenCodeTokens | undefined): EngineUsage | undefined {
  if (!tokens || typeof tokens !== 'object') return undefined
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  return {
    input_tokens: num(tokens.input),
    // OpenCode keeps reasoning separate from ordinary output; Cumora's common
    // usage shape prices both as output tokens, so fold them together here.
    output_tokens: num(tokens.output) + num(tokens.reasoning),
    cache_read_input_tokens: num(tokens.cache?.read),
    cache_creation_input_tokens: num(tokens.cache?.write),
  }
}

function addEngineUsage(total: EngineUsage | undefined, next: EngineUsage): EngineUsage {
  return {
    input_tokens: (total?.input_tokens ?? 0) + (next.input_tokens ?? 0),
    output_tokens: (total?.output_tokens ?? 0) + (next.output_tokens ?? 0),
    cache_read_input_tokens: (total?.cache_read_input_tokens ?? 0) + (next.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: (total?.cache_creation_input_tokens ?? 0) + (next.cache_creation_input_tokens ?? 0),
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function openCodeErrorText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!objectRecord(value)) return value == null ? 'unknown OpenCode error' : String(value)
  const data = objectRecord(value.data) ? value.data : null
  for (const candidate of [data?.message, value.message, value.name]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  try { return JSON.stringify(value) } catch { return 'unknown OpenCode error' }
}

/** Fold OpenCode's JSONL into the common turn/result shape. */
class OpenCodeTurnTracker {
  sessionId: string | null = null
  model: string | null
  usage: EngineUsage | undefined
  text = ''
  error: string | null = null
  private hopStartedAt: number | null = null
  private hopIndex = 0
  private hopTextChars = 0
  private hopToolUses = 0

  constructor(
    pin: string | null,
    private readonly onHopUsage?: (report: EngineHopReport) => void,
  ) {
    this.model = pin
  }

  observe(event: OpenCodeEvent): void {
    if (typeof event.sessionID === 'string' && event.sessionID) this.sessionId = event.sessionID

    if (event.type === 'error') {
      this.error = openCodeErrorText(event.error)
      return
    }

    if (event.type === 'step_start') {
      this.hopStartedAt = Date.now()
      this.hopTextChars = 0
      this.hopToolUses = 0
      return
    }

    if (event.type === 'text' && typeof event.part?.text === 'string') {
      this.text += event.part.text
      this.hopTextChars += event.part.text.length
      return
    }

    if (event.type === 'tool_use') {
      this.hopToolUses += 1
      return
    }

    if (event.type !== 'step_finish') return
    const hopUsage = openCodeUsage(event.part?.tokens)
    if (!hopUsage) return
    this.usage = addEngineUsage(this.usage, hopUsage)
    this.hopIndex += 1
    if (this.onHopUsage) {
      try {
        this.onHopUsage({
          model: this.model ?? 'opencode',
          usage: hopUsage,
          latencyMs: this.hopStartedAt == null ? undefined : Date.now() - this.hopStartedAt,
          hopIndex: this.hopIndex,
          toolUses: this.hopToolUses,
          textChars: this.hopTextChars,
        })
      } catch { /* ledger reporting is best-effort */ }
    }
    this.hopStartedAt = null
    this.hopTextChars = 0
    this.hopToolUses = 0
  }
}

function parseOpenCodeLine(line: string): OpenCodeEvent | null {
  if (!line.startsWith('{')) return null
  try { return JSON.parse(line) as OpenCodeEvent } catch { return null }
}

/** Reuse the battle-tested one-shot process pump (UTF-8/chunk boundaries,
 * abort handling, bounded failure tails) while folding each complete stdout
 * line through the OpenCode tracker. */
async function spawnOpenCodeStream(
  command: string,
  argv: string[],
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    prompt: string
    signal: AbortSignal
    onLog?: (line: string) => void
    shell: boolean
    onHopUsage?: (report: EngineHopReport) => void
    pin?: string | null
  },
): Promise<EngineRunResult & { text: string }> {
  const tracker = new OpenCodeTurnTracker(opts.pin ?? null, opts.onHopUsage)
  let processResult: EngineRunResult
  try {
    processResult = await spawnEngine(
      command,
      argv,
      {
        home: opts.cwd,
        prompt: opts.prompt,
        env: opts.env,
        onLog: (line) => {
          opts.onLog?.(line)
        },
        signal: opts.signal,
      },
      {
        shell: opts.shell,
        stdinText: opts.prompt,
        // OpenCode's JSONL protocol is stdout-only. Stderr remains visible in
        // logs and process-failure previews, but must never contribute usage,
        // session state, or a stream-level provider error.
        onStdoutLine: (line) => {
          const event = parseOpenCodeLine(line)
          if (event) tracker.observe(event)
        },
      },
    )
  } catch (err) {
    return {
      exitCode: 1,
      error: err instanceof Error ? err.message : String(err),
      sessionId: tracker.sessionId,
      usage: tracker.usage,
      model: tracker.model,
      text: tracker.text,
    }
  }

  const eventError = tracker.error
    ? `engine turn error: ${tracker.error.slice(0, MAX_FAILURE_CHARS)}`
    : null
  const streamError = eventError
  const exitCode = processResult.exitCode !== 0 ? processResult.exitCode : (streamError ? 1 : 0)
  return {
    exitCode,
    // A real process failure (auth, quota, bad flag, abort) is more useful than
    // the secondary fact that its stream never reached step_finish. Promote a
    // stream-only error only when the process itself exited cleanly. If the
    // JSON stream also carried a provider error, append its decoded prose so
    // stale-session/rate-limit recovery can match it without parsing JSON.
    error: processResult.exitCode !== 0
      ? [processResult.error, eventError].filter(Boolean).join('\n')
      : (streamError ?? undefined),
    sessionId: tracker.sessionId,
    usage: tracker.usage,
    model: tracker.model,
    text: tracker.text,
  }
}

const OPENCODE_TRIAGE_AGENT = 'cumora-triage'

/** Inject a reserved, tool-free agent as the final inline config layer while
 * preserving any provider/plugin config the operator already supplied there. */
function openCodeTriageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let inline: Record<string, unknown> = {}
  const raw = env.OPENCODE_CONFIG_CONTENT?.trim()
  if (raw) {
    let parsed: unknown
    try { parsed = JSON.parse(raw) }
    catch (err) {
      throw new Error(`OPENCODE_CONFIG_CONTENT is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!objectRecord(parsed)) throw new Error('OPENCODE_CONFIG_CONTENT must be a JSON object')
    inline = parsed
  }
  const agents = objectRecord(inline.agent) ? inline.agent : {}
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...inline,
      agent: {
        ...agents,
        [OPENCODE_TRIAGE_AGENT]: {
          description: 'Cumora local small-brain classifier (tool-free)',
          mode: 'primary',
          prompt: 'Answer the user directly. Do not call tools or modify anything.',
          permission: { '*': 'deny' },
        },
      },
    }),
  }
}

class OpenCodeAdapter implements EngineAdapter {
  readonly id = 'opencode' as const
  readonly bin = 'opencode'

  private turn(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
    resumeSessionId?: string | null
    onHopUsage?: (report: EngineHopReport) => void
  }): Promise<EngineRunResult & { text: string }> {
    const { command, shell } = resolveSpawn(this.bin)
    const model = args.model ? ['--model', args.model] : []
    const resume = args.resumeSessionId ? ['--session', args.resumeSessionId] : []
    return spawnOpenCodeStream(
      command,
      ['run', '--format', 'json', '--auto', ...resume, ...model],
      {
        cwd: args.cwd,
        env: args.env,
        prompt,
        signal: args.signal,
        onLog: args.onLog,
        shell,
        onHopUsage: args.onHopUsage,
        pin: args.model ?? null,
      },
    )
  }

  private ask(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
  }): Promise<EngineRunResult & { text: string }> {
    const { command, shell } = resolveSpawn(this.bin)
    const model = args.model ? ['--model', args.model] : []
    return spawnOpenCodeStream(
      command,
      ['run', '--format', 'json', '--agent', OPENCODE_TRIAGE_AGENT, ...model],
      {
        cwd: args.cwd,
        env: openCodeTriageEnv(args.env),
        prompt,
        signal: args.signal,
        onLog: args.onLog,
        shell,
        pin: args.model ?? null,
      },
    )
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_TRIAGE_ARGS')
    if (flags.length) {
      // User-owned output flags remain an escape hatch, but the reserved agent
      // is appended last so the triage process stays tool-free.
      const { command, shell } = resolveSpawn(this.bin)
      return spawnCapture(command, ['run', ...flags, '--agent', OPENCODE_TRIAGE_AGENT], {
        cwd: args.cwd,
        env: openCodeTriageEnv(args.env),
        signal: args.signal,
        onLog: args.onLog,
        shell,
        stdinText: args.prompt,
      })
    }
    const result = await this.ask(args.prompt, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      onLog: args.onLog,
      model: args.model,
    })
    return { text: result.text, error: result.error, usage: result.usage, model: result.model }
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // OpenCode has no universal cheap model alias: provider/model ids are
    // operator-specific. The small tier honors CUMORA_TRIAGE_MODEL; otherwise
    // both probes use the operator's configured default.
    const model = args.tier === 'small' ? (process.env.CUMORA_TRIAGE_MODEL?.trim() || null) : null
    const result = await this.ask(DOCTOR_PROMPT, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      model,
    })
    return { text: result.text, error: result.error, usage: result.usage, model: result.model }
  }

  probeWake(_args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // The real wake is the same one-shot `opencode run` shape probe() already
    // exercises; --session only adds continuity, not a second protocol.
    return Promise.resolve({ ok: true, detail: '', skipped: true })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await mkdir(join(home, '.opencode', 'skills'), { recursive: true })
    await writeFile(
      join(home, 'AGENTS.md'),
      PERSONA_HEADER(persona, { personaFile: 'AGENTS.md', skillsDir: '.opencode/skills/' }),
      'utf8',
    )
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    const flags = extraArgs('CUMORA_OPENCODE_ARGS')
    if (flags.length) {
      // Whole user-owned run-flag override: output becomes opaque, but preserve
      // the session id and stdin prompt so continuity and Windows safety remain.
      const resume = args.resumeSessionId ? ['--session', args.resumeSessionId] : []
      const { command, shell } = resolveSpawn(this.bin)
      return spawnEngine(command, ['run', ...flags, ...resume], args, { shell, stdinText: args.prompt })
    }
    return this.turn(args.prompt, {
      cwd: args.home,
      env: args.env,
      signal: args.signal,
      onLog: args.onLog,
      model: args.model,
      resumeSessionId: args.resumeSessionId,
      onHopUsage: args.onHopUsage,
    })
  }

  // No startSession: the documented headless contract is one `run` process per
  // wake; --session re-opens the same conversation in that fresh process.
}

// ─── pi ──────────────────────────────────────────────────────────────────
//
// pi (https://pi.dev, npm `@earendil-works/pi-coding-agent`) is a multi-provider
// terminal coding agent. Two headless modes matter here, and they share ONE
// event stream (pi's AgentSessionEvent JSONL):
//   - `pi --mode json …`  one-shot: a `session` header line, then events, exit.
//   - `pi --mode rpc`     persistent: JSON commands on stdin (`prompt`, `steer`,
//                         `abort`, `get_state`, …), `response` frames + the same
//                         events on stdout. LF-delimited on both sides.
// A turn is finished at `agent_settled` — NOT `agent_end`, which pi can follow
// with an automatic retry / queued continuation. Model failures do NOT change
// the process exit code in json/rpc mode: they surface as an assistant message
// with `stopReason: "error" | "aborted"` + `errorMessage`, so we read the stream,
// not the exit status. Verified against pi 0.83.0.

const PI_LOG_RAW = process.env.CUMORA_PI_VERBOSE === '1'

/** pi's per-message token usage (`@earendil-works/pi-ai` Usage). `input`
 *  EXCLUDES the cache-read portion — the same convention as Anthropic's
 *  input_tokens — so it maps 1:1 onto the Claude-shaped EngineUsage the daemon
 *  already prices (cacheWrite ↔ cache_creation, cacheRead ↔ cache_read). */
interface PiUsage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }

interface PiMessage {
  role?: unknown
  model?: unknown
  usage?: PiUsage
  stopReason?: unknown
  errorMessage?: unknown
  content?: unknown
}

/** The subset of pi's stream we act on (json + rpc). Everything else is logged
 *  and ignored, so a new event type in a future pi never breaks a turn. */
interface PiEvent {
  type?: unknown
  id?: unknown
  command?: unknown
  success?: unknown
  error?: unknown
  message?: PiMessage
  data?: { sessionId?: unknown }
  willRetry?: unknown
  messages?: unknown
}

/** Streaming deltas: one line per token / per tool-output chunk. Never logged or
 *  kept in the failure tail unless CUMORA_PI_VERBOSE=1 — the same fire-hose gate
 *  Codex has (CUMORA_CODEX_VERBOSE). */
function isNoisyPiEvent(ev: PiEvent): boolean {
  return !PI_LOG_RAW && (ev.type === 'message_update' || ev.type === 'tool_execution_update')
}

/** What to log for one pi event. `turn_end` / `agent_end` embed the full
 *  message list (the whole transcript slice) — collapse those to a one-liner so a
 *  long turn doesn't dump kilobytes into the daemon log per hop; every other
 *  event is logged verbatim (message_end included: that's the useful one). */
function piLogLine(ev: PiEvent, raw: string): string {
  if (PI_LOG_RAW) return raw
  if (ev.type === 'agent_end') return `[pi] agent_end (${Array.isArray(ev.messages) ? ev.messages.length : '?'} messages, willRetry=${ev.willRetry === true})`
  if (ev.type === 'turn_end') return '[pi] turn_end'
  return raw
}

function piUsageToEngineUsage(u: PiUsage | undefined): EngineUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  return {
    input_tokens: Number(u.input ?? 0) || 0,
    output_tokens: Number(u.output ?? 0) || 0,
    cache_read_input_tokens: Number(u.cacheRead ?? 0) || 0,
    cache_creation_input_tokens: Number(u.cacheWrite ?? 0) || 0,
  }
}

/** pi content items are `{type:'text'|'thinking'|'toolCall', …}` — the same
 *  question countAssistantContent answers for Claude (did this hop's spend go
 *  into tool routing or prose?), with pi's spelling of the tool item. */
function countPiContent(content: unknown): { toolUses: number; textChars: number } {
  if (!Array.isArray(content)) return { toolUses: 0, textChars: 0 }
  let toolUses = 0, textChars = 0
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const it = item as { type?: unknown; text?: unknown }
    if (it.type === 'toolCall') toolUses += 1
    else if (it.type === 'text' && typeof it.text === 'string') textChars += it.text.length
  }
  return { toolUses, textChars }
}

function piTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const it = item as { type?: unknown; text?: unknown }
    if (it.type === 'text' && typeof it.text === 'string') out += it.text
  }
  return out
}

/** Folds pi's event stream into what the daemon wants from a turn: the real
 *  session id, ONE EngineHopReport per assistant message, the turn's summed
 *  usage + last model (for the run row — pi has no Claude-style `result` total),
 *  the assistant's final text (triage reads it), and the first hard error.
 *  Shared by the persistent PiSession and the one-shot json spawn so both paths
 *  ledger identically — the same split CursorTurnTracker serves for Cursor. */
class PiTurnTracker {
  sessionId: string | null = null
  model: string | null = null
  usage: EngineUsage | undefined
  text = ''
  error: string | null = null
  private hopIndex = 0
  private hopStartedAt: number | null = null

  constructor(private readonly onHopUsage?: (r: EngineHopReport) => void) {}

  /** Reset the per-turn accumulators (a persistent session runs many turns). */
  beginTurn(): void {
    this.usage = undefined
    this.text = ''
    this.error = null
    this.hopIndex = 0
    this.hopStartedAt = null
  }

  /** Feed one event. Returns true when the event terminates the turn. */
  observe(ev: PiEvent): boolean {
    if (ev.type === 'session') {
      if (typeof ev.id === 'string' && ev.id) this.sessionId = ev.id
      return false
    }
    // An assistant message begins streaming = one outbound model call begins.
    if (ev.type === 'message_start' && ev.message?.role === 'assistant' && this.hopStartedAt == null) {
      this.hopStartedAt = Date.now()
      return false
    }
    if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      const m = ev.message
      const model = typeof m.model === 'string' && m.model ? m.model : null
      if (model) this.model = model
      const usage = piUsageToEngineUsage(m.usage)
      if (usage) this.usage = addEngineUsage(this.usage, usage)
      const text = piTextOf(m.content)
      if (text) this.text = text
      if (m.stopReason === 'error' || m.stopReason === 'aborted') {
        this.error = typeof m.errorMessage === 'string' && m.errorMessage ? m.errorMessage : `pi turn ${String(m.stopReason)}`
      }
      // Per-hop trajectory — same contract as ClaudeSession.onStdout: one report
      // per model call so the universal ledger sees BYOA hops at the same
      // granularity as cloud hops.
      if (usage && model && this.onHopUsage) {
        const startedAt = this.hopStartedAt
        this.hopStartedAt = null
        this.hopIndex += 1
        const { toolUses, textChars } = countPiContent(m.content)
        try {
          this.onHopUsage({ model, usage, latencyMs: startedAt != null ? Date.now() - startedAt : undefined, hopIndex: this.hopIndex, toolUses, textChars })
        } catch { /* ledger is best-effort — never break the stream */ }
      } else {
        this.hopStartedAt = null
      }
      return false
    }
    return ev.type === 'agent_settled'
  }
}

/** Parse one stdout line of pi's stream. Non-JSON lines (banners, warnings that
 *  land on stdout) come back as null and are logged verbatim by the caller. */
function parsePiLine(line: string): PiEvent | null {
  if (!line.startsWith('{')) return null
  try { return JSON.parse(line) as PiEvent } catch { return null }
}

/** One-shot `pi --mode json …`: spawn, fold the stream through a
 *  PiTurnTracker, resolve on exit. The tracker's error is folded into the
 *  result because pi's exit code says nothing about the model call (see the
 *  module note above). Text is the last assistant message's text — what
 *  classify()/probe() want. */
function spawnPiJson(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLog?: (line: string) => void; shell: boolean; stdinText?: string; onHopUsage?: (r: EngineHopReport) => void },
): Promise<EngineRunResult & { text: string }> {
  // A queued wake can be cancelled before it reaches the engine gate. Do not
  // start a Pi process after its owner has already gone away.
  if (opts.signal.aborted) {
    return Promise.resolve({ exitCode: 130, error: 'engine turn aborted before start', sessionId: null, text: '' })
  }
  return new Promise((resolve) => {
    const tracker = new PiTurnTracker(opts.onHopUsage)
    const child = spawnEngineChild(command, args, {
      cwd: opts.cwd, env: opts.env,
      stdio: [opts.stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: opts.shell,
    })
    if (opts.stdinText != null) {
      writeStdin(child, opts.stdinText, { end: true })
    }
    const abort = bindAbortTermination(child, opts.signal)
    // StringDecoder + carried partial line, for the same reason spawnEngine has
    // them: a pipe read chops a long event (a big message_end) at an arbitrary
    // byte offset, and a naive per-chunk split would hand JSON.parse two halves.
    const decoder = new StringDecoder('utf8')
    let carry = ''
    let settled = false
    const stderrTail: string[] = []
    const stdoutTail: string[] = []
    const takeLine = (raw: string): void => {
      const line = cleanLine(raw)
      if (!line) return
      const ev = parsePiLine(line)
      if (ev && isNoisyPiEvent(ev)) return
      const shown = ev ? piLogLine(ev, line) : line
      pushTail(stdoutTail, shown)
      opts.onLog?.(shown)
      if (ev) tracker.observe(ev)
    }
    const pump = (buf: Buffer | null): void => {
      const text = buf === null ? decoder.end() : decoder.write(buf)
      const lines = (carry + text).split('\n')
      carry = buf === null ? '' : (lines.pop() ?? '')
      for (const line of lines) takeLine(line)
      if (buf === null && carry === '' && lines.length === 0) return
    }
    child.stdout?.on('data', (buf: Buffer) => pump(buf))
    child.stderr?.on('data', (buf: Buffer) => {
      for (const raw of buf.toString('utf8').split('\n')) {
        const line = cleanLine(raw)
        if (!line) continue
        pushTail(stderrTail, line)
        opts.onLog?.(line)
      }
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => {
        resolve({ exitCode: 1, error: err instanceof Error ? err.message : String(err), sessionId: null, text: '' })
      })
    })
    child.on('close', (code, signalName) => {
      if (settled) return
      settled = true
      abort.dispose()
      void abort.wait().then(() => {
        pump(null) // flush a final line without a trailing newline
        const procExit = code ?? (signalName ? 128 : 1)
        const exitCode = procExit !== 0 ? procExit : (tracker.error ? 1 : 0)
        const error = procExit !== 0
          ? failurePreview({ exitCode: procExit, signalName, stderr: stderrTail, stdout: stdoutTail })
          : (tracker.error ? `engine turn error: ${tracker.error.slice(0, MAX_FAILURE_CHARS)}` : undefined)
        resolve({ exitCode, error, sessionId: tracker.sessionId, usage: tracker.usage, model: tracker.model, text: tracker.text })
      })
    })
  })
}

/** A persistent pi process for ONE agent, driven over `pi --mode rpc` (see the
 *  module note): each `send()` writes ONE `prompt` command and resolves at that
 *  turn's `agent_settled`. Steering is native — `steer` is delivered by pi
 *  itself before the agent's next model call — so there is no stream-boundary
 *  bookkeeping here. The daemon calls send() serially. */
class PiSession implements EngineSession {
  private readonly child: ChildProcess
  private readonly onLog: (line: string) => void
  private readonly tracker: PiTurnTracker
  private readonly decoder = new StringDecoder('utf8')
  private outBuf = ''
  private exited = false
  private exitCode = 0
  private reqId = 0
  private pending: { id: string; resolve: (r: EngineRunResult) => void; stderr: string[]; stdout: string[] } | null = null
  private stderrTail: string[] = []
  private stdoutTail: string[] = []
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private stopPromise: Promise<void> | null = null
  readonly carriesStandingPrompt: boolean

  constructor(bin: string, args: string[], opts: EngineSessionArgs, sessionId: string, carriesStandingPrompt: boolean) {
    this.onLog = opts.onLog
    this.tracker = new PiTurnTracker(opts.onHopUsage)
    this.tracker.sessionId = sessionId
    this.carriesStandingPrompt = carriesStandingPrompt
    // Cross-platform spawn (Windows: `pi.cmd` via the shell). Everything travels
    // over stdin as JSON here, so there are no argv-quoting concerns.
    const { command, shell } = resolveSpawn(bin)
    this.child = spawnEngineChild(command, args, { cwd: opts.home, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], shell })
    this.child.stdout?.on('data', (b: Buffer) => this.onStdout(b))
    this.child.stderr?.on('data', (b: Buffer) => this.onStderr(b))
    this.child.on('error', (err) => this.die(1, err.message))
    this.child.on('close', (code, signalName) =>
      this.die(code ?? (signalName ? 128 : 1), signalName ? `terminated by ${signalName}` : `exited with code ${code}`))
    // Ask pi which session it actually opened. It should be the --session-id we
    // passed; if a future pi ever rewrites it, we resume the REAL one next time.
    this.write({ id: 'state', type: 'get_state' })
  }

  get alive(): boolean { return !this.exited && this.child.stdin?.writable === true }
  get sessionId(): string | null { return this.tracker.sessionId }

  send(prompt: string): Promise<EngineRunResult> {
    if (this.pending) {
      return Promise.resolve({ exitCode: 1, error: 'engine session busy — a turn is already in flight', sessionId: this.sessionId })
    }
    if (!this.alive) {
      const exitCode = this.exitCode || 1
      const detail = failurePreview({ exitCode, signalName: null, stderr: this.stderrTail, stdout: this.stdoutTail })
      return Promise.resolve({ exitCode, error: detail || 'engine session is not alive (process gone)', sessionId: this.sessionId })
    }
    return new Promise<EngineRunResult>((resolve) => {
      const id = `turn-${++this.reqId}`
      this.pending = { id, resolve, stderr: [], stdout: [] }
      this.tracker.beginTurn()
      // Opt-in runaway backstop only (CUMORA_TURN_TIMEOUT_MS); OFF by default so a
      // legit long task is never killed mid-work. When set: abort the run, fail the
      // turn, tear the process down — the daemon respawns (--session-id) next wake.
      if (TURN_TIMEOUT_MS > 0) {
        this.pendingTimer = setTimeout(() => {
          this.write({ type: 'abort' })
          this.settle({ exitCode: 124, error: `engine turn exceeded CUMORA_TURN_TIMEOUT_MS (${Math.round(TURN_TIMEOUT_MS / 1000)}s) — aborted; session will respawn`, sessionId: this.sessionId })
          this.stop()
        }, TURN_TIMEOUT_MS)
        this.pendingTimer.unref?.()
      }
      if (!this.write({ id, type: 'prompt', message: stripLoneSurrogates(prompt) })) {
        this.settle({ exitCode: 1, error: 'failed to write turn to engine', sessionId: this.sessionId })
      }
    })
  }

  /** Same-turn steering: pi queues the message and delivers it after the current
   *  assistant turn's tool calls, before the next model call — the exact "next
   *  safe boundary" the Claude path has to compute by hand. No-op when idle (the
   *  daemon's normal turn handles it then). */
  steer(text: string): void {
    if (this.pending && this.alive && text.trim()) this.write({ type: 'steer', message: stripLoneSurrogates(text) })
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    this.exited = true
    // pi exits cleanly when stdin closes (it disposes the session and returns 0),
    // so close stdin first and only SIGTERM a process that hasn't gone by itself.
    try { this.child.stdin?.end() } catch { /* ignore */ }
    if (options.force) return terminateEngineTree(this.child, true)
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        if (await waitForChildExit(this.child, 2_000)) return
        await terminateEngineTree(this.child)
      })()
    }
    return this.stopPromise
  }

  private write(msg: object): boolean {
    return writeStdin(this.child, `${JSON.stringify(msg)}\n`)
  }

  private onStdout(buf: Buffer): void {
    // StringDecoder so a multi-byte character split across a pipe chunk never
    // becomes U+FFFD inside a JSON line (same fix as the one-shot paths).
    this.outBuf += this.decoder.write(buf)
    let nl: number
    while ((nl = this.outBuf.indexOf('\n')) >= 0) {
      const line = cleanLine(this.outBuf.slice(0, nl))
      this.outBuf = this.outBuf.slice(nl + 1)
      if (!line) continue
      const ev = parsePiLine(line)
      if (ev && isNoisyPiEvent(ev)) continue
      const shown = ev ? piLogLine(ev, line) : line
      pushTail(this.stdoutTail, shown)
      if (this.pending) pushTail(this.pending.stdout, shown)
      this.onLog(shown)
      if (!ev) continue
      if (ev.type === 'response') { this.onResponse(ev); continue }
      // Observe pi's NATIVE auto-compaction (telemetry only), like the Claude path.
      if (ev.type === 'compaction_start') this.onLog('[pi] native context compaction started')
      else if (ev.type === 'compaction_end') this.onLog('[pi] native context compaction finished')
      if (this.tracker.observe(ev) && this.pending) {
        this.settle({
          exitCode: this.tracker.error ? 1 : 0,
          error: this.tracker.error ? `engine turn error: ${this.tracker.error.slice(0, MAX_FAILURE_CHARS)}` : undefined,
          sessionId: this.sessionId,
          usage: this.tracker.usage,
          model: this.tracker.model,
        })
      }
    }
  }

  private onResponse(ev: PiEvent): void {
    if (ev.id === 'state') {
      const sid = ev.data?.sessionId
      if (typeof sid === 'string' && sid) this.tracker.sessionId = sid
      return
    }
    // A prompt rejected BEFORE acceptance (`success:false`) gets no events at all
    // — settle now or the turn would hang until the daemon's timeout.
    if (this.pending && ev.id === this.pending.id && ev.command === 'prompt' && ev.success === false) {
      this.settle({ exitCode: 1, error: `pi rejected the turn: ${typeof ev.error === 'string' && ev.error ? ev.error : 'unknown error'}`, sessionId: this.sessionId })
    }
  }

  private onStderr(buf: Buffer): void {
    for (const raw of buf.toString('utf8').split('\n')) {
      const line = cleanLine(raw)
      if (!line) continue
      pushTail(this.stderrTail, line)
      if (this.pending) pushTail(this.pending.stderr, line)
      this.onLog(line)
    }
  }

  private settle(r: EngineRunResult): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    const p = this.pending
    this.pending = null
    if (p) p.resolve(r)
  }

  /** Process died (error/close). Mark dead and fail any in-flight turn — always
   *  logged, even when idle, for the same reason ClaudeSession does it. */
  private die(code: number, why: string): void {
    const alreadyDown = this.exited
    this.exited = true
    this.exitCode = code
    if (!alreadyDown) {
      this.onLog(`[session] engine process died ${this.pending ? 'MID-TURN' : 'while idle'}: ${why} (exit ${code})`)
    }
    if (this.pending) {
      const detail = failurePreview({ exitCode: code, signalName: null, stderr: this.pending.stderr, stdout: this.pending.stdout })
      this.settle({ exitCode: code, error: detail || why, sessionId: this.sessionId })
    }
  }
}

class PiAdapter implements EngineAdapter {
  readonly id = 'pi' as const
  readonly bin = 'pi'

  /** A clean, tool-free, persona-free one-shot: no session file, no built-in /
   *  extension tools, no extensions, no skills, no AGENTS.md discovery. The pi
   *  analogue of Claude's `--strict-mcp-config` triage spawn. */
  private static readonly BARE = ['--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-context-files']

  /** BYOA turns are short reactive cycles; extended thinking adds latency and,
   *  in a group @all, makes the slowest agent bow out on the "don't duplicate"
   *  rule (same reasoning as Claude's MAX_THINKING_TOKENS=0). pi's per-model
   *  `provider/id:<level>` suffix is the user's opt-in — when the model carries
   *  one, don't fight it. */
  private static thinking(model: string | null | undefined): string[] {
    return model && model.includes(':') ? [] : ['--thinking', 'off']
  }

  private oneShot(prompt: string, args: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal; onLog?: (line: string) => void; model?: string | null }): Promise<EngineRunResult & { text: string }> {
    const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
    const model = args.model ? ['--model', args.model] : []
    // Windows: the .cmd shim runs via the shell, which can't carry a big
    // multi-line prompt as an argv element → stdin (pi reads a piped stdin as the
    // message when stdin isn't a TTY). POSIX: prompt in argv.
    const base = ['--mode', 'json', ...PiAdapter.BARE, ...PiAdapter.thinking(args.model), ...model]
    return spawnPiJson(command, wantsStdinPrompt ? base : [...base, prompt], {
      cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell,
      stdinText: wantsStdinPrompt ? prompt : undefined,
    })
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    // pi is multi-provider, so there is no single cheap "cerebellum" id to hard-
    // code (claude→haiku, codex→gpt-5.4-mini). CUMORA_TRIAGE_MODEL picks one
    // (`provider/id`); unset → pi's own default model, which keeps triage local
    // (never the cloud) at the cost of not being cheaper than the big brain.
    // The json stream names the model that actually ran, so the ledger prices
    // the real one either way.
    const flags = extraArgs('CUMORA_TRIAGE_ARGS')
    if (flags.length) {
      // User-owned flag set → plain print mode, raw text back (mirrors Claude's
      // override path: no envelope to unwrap, no usage).
      const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
      const base = [...flags, '-p']
      return spawnCapture(command, wantsStdinPrompt ? base : [...base, args.prompt], {
        cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell,
        stdinText: wantsStdinPrompt ? args.prompt : undefined,
      })
    }
    const r = await this.oneShot(args.prompt, { cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, model: args.model })
    return { text: r.text, error: r.error, usage: r.usage, model: r.model }
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // 'small' → whatever triage runs on (CUMORA_TRIAGE_MODEL, else pi's default —
    // the same model as 'big', honestly reported as such); 'big' → pi's default.
    const model = args.tier === 'small' ? (process.env.CUMORA_TRIAGE_MODEL || null) : null
    const r = await this.oneShot(DOCTOR_PROMPT, { cwd: args.cwd, env: args.env, signal: args.signal, model })
    return { text: r.text, error: r.error, usage: r.usage, model: r.model }
  }

  probeWake(args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // Same gate as startSession(): a CUMORA_PI_ARGS override collapses the wake to
    // one-shot print mode, which probe() already covers.
    if (extraArgs('CUMORA_PI_ARGS').length) return Promise.resolve({ ok: true, detail: '', skipped: true })
    // The real wake speaks the rpc protocol. The realistic breaks are: `--mode rpc`
    // renamed/removed, or the command/response framing changed. Drive the cheapest
    // round-trip there is — `get_state` needs no model call — and tear down.
    const { command, shell } = resolveSpawn(this.bin)
    return new Promise<EngineWakeProbeResult>((resolve) => {
      let settled = false
      const finish = (r: EngineWakeProbeResult): void => {
        if (settled) return
        settled = true
        try { child.stdin?.end() } catch { /* ignore */ }
        void terminateEngineTree(child).then(() => resolve(r))
      }
      const child = spawnEngineChild(command, ['--mode', 'rpc', ...PiAdapter.BARE], {
        cwd: args.cwd, env: args.env, stdio: ['pipe', 'pipe', 'pipe'], shell,
      })
      const onAbort = (): void => finish({ ok: false, detail: 'aborted (timeout)' })
      if (args.signal.aborted) { onAbort(); return }
      args.signal.addEventListener('abort', onAbort, { once: true })
      let buf = ''
      let stderrTail = ''
      writeStdin(child, `${JSON.stringify({ id: 'doctor', type: 'get_state' })}\n`)
      child.stdout?.on('data', (b: Buffer) => {
        buf += b.toString('utf8')
        for (;;) {
          const nl = buf.indexOf('\n')
          if (nl < 0) break
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          const ev = parsePiLine(line)
          if (!ev || ev.type !== 'response' || ev.id !== 'doctor') continue
          if (ev.success === true) finish({ ok: true, detail: '' })
          else finish({ ok: false, detail: `rpc get_state failed: ${typeof ev.error === 'string' ? ev.error.slice(0, 240) : 'unknown error'}` })
          return
        }
      })
      child.stderr?.on('data', (b: Buffer) => {
        const tail = stderrTail + b.toString('utf8')
        stderrTail = tail.length > 2000 ? tail.slice(-2000) : tail
      })
      child.on('error', (err) => finish({ ok: false, detail: `spawn error: ${err.message}` }))
      child.on('close', (code, sig) => {
        if (settled) return
        finish({ ok: false, detail: `rpc process died before answering get_state (${sig ? `terminated by ${sig}` : `exit ${code}`}): ${salientError(stderrTail) || 'no stderr'}` })
      })
    })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await mkdir(join(home, '.pi', 'skills'), { recursive: true })
    // Always rewrite AGENTS.md so persona edits land without requiring a fresh
    // home (matches Claude and Codex). pi discovers AGENTS.md from its cwd
    // natively; skills are loaded explicitly via --skill (see startSession) since
    // pi's non-interactive modes ignore project resources in an untrusted dir.
    await writeFile(
      join(home, 'AGENTS.md'),
      PERSONA_HEADER(persona, { personaFile: 'AGENTS.md', skillsDir: '.pi/skills/' }),
      'utf8',
    )
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    // Unlike an abort listener registered below, this catches a turn cancelled
    // while it was queued and avoids spawning the persistent RPC process at all.
    if (args.signal.aborted) {
      return { exitCode: 130, error: 'engine turn aborted before start', sessionId: args.resumeSessionId ?? null }
    }
    const flags = extraArgs('CUMORA_PI_ARGS')
    if (flags.length) {
      // User-owned flag set → one-shot print mode with their flags. We still pin
      // the session so context carries across wakes; nothing structured comes
      // back (no stream to sniff), so report the id we passed.
      const sid = args.resumeSessionId ?? randomUUID()
      const { command, shell, wantsStdinPrompt } = resolveSpawn(this.bin)
      const base = [...flags, '--session-id', sid, '-p']
      const r = await spawnEngine(command, wantsStdinPrompt ? base : [...base, args.prompt], args, { shell, stdinText: wantsStdinPrompt ? args.prompt : undefined })
      return { ...r, sessionId: r.sessionId ?? sid }
    }
    // Default: the persistent rpc path is the ONLY protocol we drive, so a one-shot
    // is simply a session that lives for one turn. Same parser, same ledger.
    const session = this.startSession({
      home: args.home, env: args.env, model: args.model, fastModel: args.fastModel,
      resumeSessionId: args.resumeSessionId, onLog: args.onLog, onHopUsage: args.onHopUsage,
    })
    if (!session) return { exitCode: 1, error: 'pi session could not be started', sessionId: args.resumeSessionId ?? null }
    const onAbort = (): void => { void session.stop({ force: true }) }
    args.signal.addEventListener('abort', onAbort, { once: true })
    // The signal may have flipped after the pre-spawn check but before the
    // listener above was installed.
    if (args.signal.aborted) onAbort()
    try {
      // onAbort() tears the just-created session down, but send() would then
      // report that dead session as a generic engine failure. Keep a cancelled
      // turn classified as cancellation and never dispatch its prompt.
      if (args.signal.aborted) {
        return { exitCode: 130, error: 'engine turn aborted before start', sessionId: args.resumeSessionId ?? null }
      }
      return await session.send(args.prompt)
    } finally {
      args.signal.removeEventListener('abort', onAbort)
      session.stop()
    }
  }

  startSession(args: EngineSessionArgs): EngineSession | null {
    // Respect a user's custom flag override by NOT using the persistent path —
    // those flags are tuned for one-shot print mode; fall back to run().
    if (extraArgs('CUMORA_PI_ARGS').length) return null
    // Continuous context across wakes: pin the session id ourselves (`--session-id`
    // creates it when missing, resumes it when present) so a respawn — daemon
    // restart, timeout, crash — picks up where the agent left off.
    const sid = args.resumeSessionId ?? randomUUID()
    const model = args.model ? ['--model', args.model] : []
    // The invariant standing prompt loads ONCE here (not re-sent every turn), so
    // the per-turn stdin messages stay small and pi's native auto-compaction keeps
    // up. `--append-system-prompt` takes a file path.
    let sys: string[] = []
    let carriesStanding = false
    if (args.standingPrompt) {
      const file = join(args.home, '.cumora-standing-prompt.md')
      try { atomicAgentWriteSync(file, args.standingPrompt); sys = ['--append-system-prompt', file]; carriesStanding = true }
      catch { /* couldn't write → leave it; the daemon inlines the standing prompt instead */ }
    }
    const argv = [
      '--mode', 'rpc', '--session-id', sid, ...sys, ...model, ...PiAdapter.thinking(args.model),
      // Load the agent's own skills explicitly: pi's non-interactive modes ignore
      // project-local resources in an untrusted directory, and trusting the home
      // outright (`--approve`) would also enable project settings/extensions.
      '--skill', join(args.home, '.pi', 'skills'),
    ]
    return new PiSession(this.bin, argv, args, sid, carriesStanding)
  }
}

// ── Gemini CLI ───────────────────────────────────────────────────────────────
//
// `gemini -o stream-json` emits JSONL, but NOT Claude Code's stream-json: the
// envelope below is what its own StreamJsonFormatter writes (verified against
// the shipped 0.57.0 bundle and by running the binary). Sibling forks are not
// safe to assume compatible either — Qwen Code shares Gemini's flags and emits
// Claude's envelope instead.

interface GeminiTokenStats {
  /** Gemini's PROMPT total. Cache reads are INCLUDED here — see geminiUsage. */
  input_tokens?: number
  output_tokens?: number
  cached?: number
  /** prompt − cached. The fresh input, and the one the ledger wants. */
  input?: number
}

interface GeminiStats extends GeminiTokenStats {
  total_tokens?: number
  duration_ms?: number
  tool_calls?: number
  /** Per-model breakdown, keyed by the model the CLI RESOLVED (`-m flash` and a
   *  mid-turn fallback both land here under their real ids). */
  models?: Record<string, GeminiTokenStats>
}

interface GeminiEvent {
  type?: string
  session_id?: string
  model?: string
  role?: string
  content?: unknown
  status?: string
  severity?: string
  message?: string
  error?: { type?: string; message?: string }
  stats?: GeminiStats
}

/** Map Gemini's token stats onto the common (Anthropic-shaped) usage record.
 *
 *  The field named `input_tokens` is NOT the one to bill. uiTelemetryService
 *  sets `tokens.prompt` from the API's `input_token_count`, which already
 *  contains the cached prefix, and then derives `tokens.input = prompt −
 *  cached`; `convertToStreamStats` publishes the first as `input_tokens` and
 *  the second as `input`. Billing `input_tokens` while ALSO reporting `cached`
 *  charges the cached prefix twice — and a BYOA agent re-sends a large stable
 *  prefix on every wake, so that prefix is most of the prompt. */
function geminiUsage(stats: GeminiStats | undefined): EngineUsage | undefined {
  if (!stats || typeof stats !== 'object') return undefined
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
  const cached = num(stats.cached)
  const fresh = stats.input != null ? num(stats.input) : Math.max(0, num(stats.input_tokens) - cached)
  const output = num(stats.output_tokens)
  // A turn that died before its first API call reports every counter as 0 (the
  // auth-failure shape). Reporting that as usage would put a zero-token row in
  // the ledger for work that never happened.
  if (!fresh && !output && !cached) return undefined
  return {
    input_tokens: fresh,
    output_tokens: output,
    cache_read_input_tokens: cached,
    // Gemini's implicit caching is not billed as a separate write, and its
    // stats carry no creation counter — leave it absent rather than invent 0.
  }
}

/** The model a turn actually ran on. `init` reports what was REQUESTED; the
 *  stats key reports what the CLI resolved (an alias like `flash`, or a
 *  mid-turn fallback, differ). Prefer the resolved id when it is unambiguous —
 *  cost is priced on it — and keep the requested one when several models ran. */
function geminiResolvedModel(stats: GeminiStats | undefined, seen: string | null): string | null {
  const names = stats?.models ? Object.keys(stats.models) : []
  return names.length === 1 ? names[0] : seen
}

class GeminiTurnTracker {
  text = ''
  sessionId: string | null = null
  model: string | null = null
  usage: EngineUsage | undefined
  error: string | null = null
  private startedAt: number | null = null
  private toolUses = 0
  private textChars = 0

  constructor(
    pin: string | null,
    private readonly onHopUsage?: (report: EngineHopReport) => void,
  ) {
    this.model = pin
  }

  observe(event: GeminiEvent): void {
    if (typeof event.session_id === 'string' && event.session_id) this.sessionId = event.session_id

    if (event.type === 'init') {
      if (typeof event.model === 'string' && event.model) this.model = event.model
      this.startedAt = Date.now()
      return
    }

    if (event.type === 'message') {
      // Assistant text arrives as deltas; the user echo of our own prompt must
      // never be folded into the reply triage reads.
      if (event.role === 'assistant' && typeof event.content === 'string') {
        this.text += event.content
        this.textChars += event.content.length
      }
      return
    }

    if (event.type === 'tool_use') { this.toolUses += 1; return }

    if (event.type === 'error') {
      // `severity: 'warning'` is a loop-detection / blocked-tool notice the run
      // survives. Only an error ends the turn, and the terminating `result`
      // event carries the authoritative verdict anyway.
      if (event.severity !== 'warning' && typeof event.message === 'string') this.error = event.message
      return
    }

    if (event.type !== 'result') return
    if (event.status === 'error') {
      const detail = event.error?.message ?? event.message
      if (typeof detail === 'string' && detail) this.error = detail
      else if (!this.error) this.error = 'gemini reported a failed turn with no detail'
    }
    this.model = geminiResolvedModel(event.stats, this.model)
    const usage = geminiUsage(event.stats)
    if (!usage) return
    this.usage = usage
    if (this.onHopUsage) {
      // Gemini publishes token stats only at the end of the turn, so — as with
      // codex exec — this is ONE hop carrying the turn's whole usage rather
      // than a per-round-trip trajectory. Reporting it is what keeps BYOA
      // spend visible in the same ledger as everything else.
      try {
        this.onHopUsage({
          model: this.model ?? 'gemini',
          usage,
          latencyMs: this.startedAt == null ? undefined : Date.now() - this.startedAt,
          hopIndex: 1,
          toolUses: this.toolUses,
          textChars: this.textChars,
        })
      } catch { /* ledger reporting is best-effort */ }
    }
  }
}

function parseGeminiLine(line: string): GeminiEvent | null {
  if (!line.startsWith('{')) return null
  try { return JSON.parse(line) as GeminiEvent } catch { return null }
}

/** Gemini refuses to act on an untrusted folder, and — worse for an unattended
 *  daemon — SILENTLY downgrades `--yolo` to interactive approval there
 *  ("Approval mode overridden to 'default' because the current folder is not
 *  trusted"), so the turn stalls waiting for a human who is not present.
 *
 *  The env var, not the equivalent `--skip-trust` flag: an unknown env var is
 *  ignored by older builds, while an unknown flag is a fatal argv error. The
 *  home really is ours to trust — the daemon created and seeded it. */
function geminiEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
}

async function spawnGeminiStream(
  command: string,
  argv: string[],
  opts: {
    cwd: string
    env: NodeJS.ProcessEnv
    prompt: string
    signal: AbortSignal
    onLog?: (line: string) => void
    shell: boolean
    onHopUsage?: (report: EngineHopReport) => void
    pin?: string | null
  },
): Promise<EngineRunResult & { text: string }> {
  const tracker = new GeminiTurnTracker(opts.pin ?? null, opts.onHopUsage)
  let processResult: EngineRunResult
  try {
    processResult = await spawnEngine(
      command,
      argv,
      {
        home: opts.cwd,
        prompt: opts.prompt,
        env: opts.env,
        onLog: (line) => {
          const event = parseGeminiLine(line)
          if (event) tracker.observe(event)
          opts.onLog?.(line)
        },
        signal: opts.signal,
      },
      // The prompt goes on stdin on EVERY platform: `gemini` reads it there
      // when no -p is given, which sidesteps both argv length limits and the
      // Windows .cmd shim's inability to carry a multi-line argument.
      { shell: opts.shell, stdinText: opts.prompt },
    )
  } catch (err) {
    return {
      exitCode: 1,
      error: err instanceof Error ? err.message : String(err),
      sessionId: tracker.sessionId,
      usage: tracker.usage,
      model: tracker.model,
      text: tracker.text,
    }
  }

  const eventError = tracker.error
    ? `engine turn error: ${tracker.error.slice(0, MAX_FAILURE_CHARS)}`
    : null
  const exitCode = processResult.exitCode !== 0 ? processResult.exitCode : (eventError ? 1 : 0)
  return {
    exitCode,
    // Same precedence as the other stream adapters: a real process failure
    // (auth, quota, bad flag, abort) explains more than the secondary fact that
    // the stream reported a failed turn. Keep the event's prose alongside it so
    // stale-session recovery can match on it without parsing JSON.
    error: processResult.exitCode !== 0
      ? [processResult.error, eventError].filter(Boolean).join('\n')
      : (eventError ?? undefined),
    sessionId: tracker.sessionId,
    usage: tracker.usage,
    model: tracker.model,
    text: tracker.text,
  }
}

/** Settings that leave the triage process with NO tools at all.
 *
 *  `tools.core` is an allowlist, and the registry applies it as
 *  `coreTools.some(...)` per tool — an EMPTY array is truthy, matches nothing,
 *  and so registers no built-in tools. User settings and installed extensions
 *  can also contribute MCP servers; the system-scope empty MCP allowlist joins
 *  every configured allowlist by intersection, so none of those servers can
 *  register tools either. With no tool to confirm, a headless approval prompt
 *  (which nothing would answer) cannot arise, and the classifier stays a
 *  one-shot. */
const GEMINI_TRIAGE_SETTINGS = JSON.stringify({ tools: { core: [] }, mcp: { allowed: [] } })
const GEMINI_TRIAGE_SETTINGS_FILE = '.cumora-gemini-triage.json'

class GeminiAdapter implements EngineAdapter {
  readonly id = 'gemini' as const
  readonly bin = 'gemini'

  /** stream-json on BOTH paths, including triage. `-o json` writes nothing to
   *  stdout when the turn fails before the model answers (the auth-failure
   *  case) and reports it only on stderr, while stream-json still emits a
   *  `result` event carrying the reason. */
  private static readonly STREAM = ['--output-format', 'stream-json']

  private turn(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
    resumeSessionId?: string | null
    onHopUsage?: (report: EngineHopReport) => void
  }): Promise<EngineRunResult & { text: string }> {
    const { command, shell } = resolveSpawn(this.bin)
    const model = args.model ? ['--model', args.model] : []
    // `--resume` takes "latest", a 1-based index, or a full session UUID —
    // findSession() matches the UUID first, which is the only stable handle
    // across wakes (an index shifts as sessions accumulate).
    const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
    return spawnGeminiStream(
      command,
      [...GeminiAdapter.STREAM, '--yolo', ...resume, ...model],
      {
        cwd: args.cwd,
        env: geminiEnv(args.env),
        prompt,
        signal: args.signal,
        onLog: args.onLog,
        shell,
        onHopUsage: args.onHopUsage,
        pin: args.model ?? null,
      },
    )
  }

  private async ask(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
  }): Promise<EngineRunResult & { text: string }> {
    const { command, shell } = resolveSpawn(this.bin)
    const model = ['--model', args.model || triageModel('gemini-2.5-flash-lite')]
    const settings = join(args.cwd, GEMINI_TRIAGE_SETTINGS_FILE)
    let env = geminiEnv(args.env)
    try {
      // Write-then-rename, not writeFile onto the live path. The triage cwd is
      // shared — the doctor hands the SAME dir to every engine's probe, and
      // concurrent classifies land there too — and writeFile truncates before
      // it writes, so a second caller can be mid-truncate while gemini is
      // reading. Identical content does not save us from a zero-length read;
      // rename is atomic, so a reader sees one whole file or the other.
      const staged = `${settings}.${process.pid}.${randomUUID().slice(0, 8)}`
      await writeFile(staged, GEMINI_TRIAGE_SETTINGS, 'utf8')
      await rename(staged, settings)
      // System scope so it wins over any user/workspace settings the operator
      // has; it MERGES with them, so their auth config is untouched.
      env = { ...env, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings }
    } catch {
      // Triage still works with tools present — the cwd is neutral and the
      // prompt asks for a direct answer. Losing the guarantee is not worth
      // losing the classification.
    }
    return spawnGeminiStream(
      command,
      [...GeminiAdapter.STREAM, '--yolo', ...model],
      {
        cwd: args.cwd,
        env,
        prompt,
        signal: args.signal,
        onLog: args.onLog,
        shell,
        pin: model[1],
      },
    )
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_TRIAGE_ARGS')
    if (flags.length) {
      // Whole user-owned override: output becomes opaque, but the prompt still
      // travels on stdin so a Windows shim and a long prompt both survive.
      const { command, shell } = resolveSpawn(this.bin)
      return spawnCapture(command, flags, {
        cwd: args.cwd,
        env: geminiEnv(args.env),
        signal: args.signal,
        onLog: args.onLog,
        shell,
        stdinText: args.prompt,
      })
    }
    const result = await this.ask(args.prompt, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      onLog: args.onLog,
      model: args.model,
    })
    return { text: result.text, error: result.error, usage: result.usage, model: result.model }
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // Concrete ids rather than Gemini's `pro` / `flash-lite` aliases: the
    // aliases only exist in recent builds, and an operator running an older
    // `gemini` would get a model-not-found from the doctor probe itself — a
    // red brain that says nothing about their actual configuration.
    const model = args.tier === 'small' ? triageModel('gemini-2.5-flash-lite') : 'gemini-2.5-pro'
    const result = await this.ask(DOCTOR_PROMPT, {
      cwd: args.cwd,
      env: args.env,
      signal: args.signal,
      model,
    })
    return { text: result.text, error: result.error, usage: result.usage, model: result.model }
  }

  probeWake(_args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // The real wake is the same one-shot process probe() already exercises;
    // --resume re-opens a conversation inside it, it is not a second protocol.
    return Promise.resolve({ ok: true, detail: '', skipped: true })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await mkdir(join(home, '.gemini', 'skills'), { recursive: true })
    await writeFile(
      join(home, 'GEMINI.md'),
      PERSONA_HEADER(persona, { personaFile: 'GEMINI.md', skillsDir: '.gemini/skills/' }),
      'utf8',
    )
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    const flags = extraArgs('CUMORA_GEMINI_ARGS')
    if (flags.length) {
      const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
      const { command, shell } = resolveSpawn(this.bin)
      return spawnEngine(command, [...flags, ...resume], { ...args, env: geminiEnv(args.env) }, { shell, stdinText: args.prompt })
    }
    return this.turn(args.prompt, {
      cwd: args.home,
      env: args.env,
      signal: args.signal,
      onLog: args.onLog,
      model: args.model,
      resumeSessionId: args.resumeSessionId,
      onHopUsage: args.onHopUsage,
    })
  }

  // No startSession: gemini has no stream-json INPUT mode, so there is no way
  // to feed turn N+1 into a live process. --resume re-opens the conversation in
  // a fresh one, which is what the one-shot path already does.
}

// ── Qwen Code ────────────────────────────────────────────────────────────────
//
// Qwen Code is a Gemini CLI fork, and shares its flags (`-o stream-json`,
// `-p`, `-r`, `-m`) — but NOT its output. It emits Claude Code's envelope
// instead: `{type:'assistant',session_id,message:{model,content,usage}}` and a
// terminating `{type:'result',subtype,is_error,usage}`. That is the shape
// `spawnEngine` already sniffs, so the wake path needs no parser of its own;
// only triage does, because it needs the reply TEXT back.
//
// The two forks having the same flags and different envelopes is exactly why
// neither adapter is derived from the other.

interface QwenBlock { type?: string; text?: unknown }
interface QwenEvent {
  type?: string
  session_id?: string
  is_error?: boolean
  error?: { message?: unknown }
  usage?: EngineUsage
  message?: { model?: unknown; usage?: EngineUsage; content?: unknown }
}

/** Pull the assistant's reply out of a captured stream-json run.
 *
 *  Exported for tests: it is pure, and it is the only part of this adapter
 *  that a fake binary cannot exercise through `spawnEngine`.
 *
 *  Both `-o json` and `-o stream-json` are event streams here — `json` is
 *  simply the same events wrapped in a JSON array, NOT Claude's
 *  `{result,usage}` object — so there is no envelope to unwrap and the text
 *  has to be assembled from the assistant messages. */
export function qwenReplyFromStream(stdout: string): {
  text: string
  usage?: EngineUsage
  model?: string | null
  error?: string
} {
  let text = ''
  let usage: EngineUsage | undefined
  let model: string | null = null
  let error: string | undefined
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let ev: QwenEvent
    try { ev = JSON.parse(line) as QwenEvent } catch { continue }
    if (typeof ev.message?.model === 'string' && ev.message.model) model = ev.message.model
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content as QwenBlock[]) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text
      }
      continue
    }
    if (ev.type !== 'result') continue
    if (ev.usage && typeof ev.usage === 'object') usage = ev.usage
    if (ev.is_error) {
      const detail = ev.error?.message
      error = typeof detail === 'string' && detail ? detail : 'qwen reported a failed turn with no detail'
    }
  }
  return { text: text.trim(), usage, model, error }
}

class QwenAdapter implements EngineAdapter {
  readonly id = 'qwen' as const
  readonly bin = 'qwen'

  /** stream-json on both paths. `-o json` returns the same events as a JSON
   *  array, so it buys nothing here and only adds a second shape to parse. */
  private static readonly STREAM = ['--output-format', 'stream-json']

  private async ask(prompt: string, args: {
    cwd: string
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    onLog?: (line: string) => void
    model?: string | null
  }): Promise<EngineClassifyResult> {
    const { command, shell } = resolveSpawn(this.bin)
    // No --model at all when the caller has none: the big-brain probe must
    // exercise whatever the operator made default, and forcing the cheap
    // triage id there would report on a model their wakes never use.
    const model = args.model ? ['--model', args.model] : []
    const res = await spawnCapture(
      command,
      // `--safe-mode` is qwen's own switch for "ignore every customization":
      // context files, hooks, extensions, skills and MCP servers all stay
      // unloaded, which is the same thing --strict-mcp-config buys the Claude
      // triage path and keeps a cold triage spawn cheap. It deliberately does
      // NOT disable auth, and `-y` (an argv flag) still wins over it, so
      // nothing can stall waiting for an approval nobody is there to give.
      [...QwenAdapter.STREAM, '--safe-mode', '--yolo', ...model],
      {
        cwd: args.cwd,
        env: args.env,
        signal: args.signal,
        onLog: args.onLog,
        shell,
        stdinText: prompt,
      },
    )
    const parsed = qwenReplyFromStream(res.text)
    return {
      text: parsed.text,
      // A process failure explains more than a stream that merely reported one,
      // so keep the same precedence the other stream adapters use.
      error: res.error ?? (parsed.error ? `engine turn error: ${parsed.error.slice(0, MAX_FAILURE_CHARS)}` : undefined),
      usage: parsed.usage,
      model: parsed.model ?? args.model ?? null,
    }
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const flags = extraArgs('CUMORA_TRIAGE_ARGS')
    if (flags.length) {
      // Whole user-owned override: the output becomes opaque, but the prompt
      // still travels on stdin so a long prompt and a Windows shim survive.
      const { command, shell } = resolveSpawn(this.bin)
      return spawnCapture(command, flags, {
        cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog, shell, stdinText: args.prompt,
      })
    }
    return this.ask(args.prompt, {
      cwd: args.cwd, env: args.env, signal: args.signal, onLog: args.onLog,
      model: args.model || triageModel('qwen3-coder-flash'),
    })
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    // Qwen Code is multi-provider (its own OAuth, DashScope, or any OpenAI-
    // compatible base URL), so there is no cheap model id that is right for
    // every operator. The small tier honours CUMORA_TRIAGE_MODEL — the same
    // knob triage reads, so doctor cannot report a red small brain for an
    // operator whose triage is configured correctly — and the big tier uses
    // whatever the operator made default.
    const model = args.tier === 'small' ? triageModel('qwen3-coder-flash') : null
    return this.ask(DOCTOR_PROMPT, { cwd: args.cwd, env: args.env, signal: args.signal, model })
  }

  probeWake(_args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // The wake is the same one-shot process probe() already exercises.
    // --resume re-opens a conversation inside it, it is not a second protocol.
    return Promise.resolve({ ok: true, detail: '', skipped: true })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await mkdir(join(home, '.qwen', 'skills'), { recursive: true })
    await writeFile(
      join(home, 'QWEN.md'),
      PERSONA_HEADER(persona, { personaFile: 'QWEN.md', skillsDir: '.qwen/skills/' }),
      'utf8',
    )
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    const flags = extraArgs('CUMORA_QWEN_ARGS')
    const { command, shell } = resolveSpawn(this.bin)
    // `--resume <id>` resumes by session id (`-c` resumes the newest, which is
    // wrong here: one machine runs many agents out of many homes).
    const resume = args.resumeSessionId ? ['--resume', args.resumeSessionId] : []
    if (flags.length) {
      return spawnEngine(command, [...flags, ...resume], args, { shell, stdinText: args.prompt })
    }
    const model = args.model ? ['--model', args.model] : []
    // No tracker: the envelope is Claude's, so spawnEngine already lifts the
    // session id, the terminating usage, the model, and one hop per assistant
    // message into the ledger.
    return spawnEngine(
      command,
      [...QwenAdapter.STREAM, '--yolo', ...resume, ...model],
      args,
      // Prompt on stdin on every platform: `qwen` reads it there when no -p is
      // given, which avoids argv limits and the Windows .cmd shim's inability
      // to carry a multi-line argument.
      { shell, stdinText: args.prompt },
    )
  }

  // No startSession: qwen has no stream-json INPUT mode, so there is no way to
  // feed turn N+1 into a live process. --resume re-opens the conversation in a
  // fresh one, which is what the one-shot path already does.
}

// ─── Antigravity CLI ──────────────────────────────────────────────────────────────────
//
// `agy --input-format stream-json --output-format stream-json` is a real
// long-lived protocol: one NDJSON user event goes in per turn and exactly one
// terminal result event comes back. Result usage is CUMULATIVE for the whole
// process, so the tracker must subtract the previous total before handing a
// turn to Cumora's ledger. Treating the result as per-turn silently bills the
// first turn again on every later wake.

interface AntigravityNativeUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

interface AntigravityEvent {
  event?: string
  conversation_id?: string
  init?: { conversation_id?: string; model?: string }
  step_update?: {
    conversation_id?: string
    step_index?: number
    state?: string
    step_type?: string
    text_delta?: string
    tool_info?: unknown
  }
  result?: {
    conversation_id?: string
    status?: string
    response?: string
    error?: string
    duration_seconds?: number
    num_turns?: number
    model?: string
    usage?: AntigravityNativeUsage
  }
}

function antigravityCounter(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

/** Convert Antigravity's counters without charging cache reads twice.
 *
 * `input_tokens` is the complete prompt, including cache reads (the documented
 * examples satisfy total = input + output). Cumora's common shape wants fresh
 * input and cache reads in disjoint fields. `thinking_tokens` is a subset of
 * output_tokens, not an extra token class, so it is intentionally not added
 * again. */
function antigravityUsage(raw: AntigravityNativeUsage | undefined): EngineUsage | undefined {
  if (!raw) return undefined
  const cached = antigravityCounter(raw.cache_read_tokens)
  const input = Math.max(0, antigravityCounter(raw.input_tokens) - cached)
  const output = antigravityCounter(raw.output_tokens)
  if (!input && !output && !cached) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cached,
  }
}

function antigravityUsageDelta(
  current: AntigravityNativeUsage | undefined,
  previous: AntigravityNativeUsage | undefined,
): AntigravityNativeUsage | undefined {
  if (!current) return undefined
  const delta = (key: keyof AntigravityNativeUsage): number => {
    const now = antigravityCounter(current[key])
    const before = antigravityCounter(previous?.[key])
    // A CLI-side session reset makes the cumulative total smaller. That new
    // value is the whole current turn, not a negative delta.
    return now >= before ? now - before : now
  }
  return {
    input_tokens: delta('input_tokens'),
    output_tokens: delta('output_tokens'),
    thinking_tokens: delta('thinking_tokens'),
    cache_read_tokens: delta('cache_read_tokens'),
    total_tokens: delta('total_tokens'),
  }
}

function parseAntigravityLine(line: string): AntigravityEvent | null {
  if (!line.startsWith('{')) return null
  try { return JSON.parse(line) as AntigravityEvent } catch { return null }
}

class AntigravityTurnTracker {
  sessionId: string | null = null
  model: string | null
  text = ''
  error: string | null = null
  usage: EngineUsage | undefined
  private previousUsage: AntigravityNativeUsage | undefined
  private startedAt: number | null = null
  private toolUses = 0
  private readonly seenToolSteps = new Set<number>()
  private hopIndex = 0

  constructor(
    pin: string | null,
    private readonly onHopUsage?: (report: EngineHopReport) => void,
  ) {
    this.model = pin
  }

  beginTurn(): void {
    this.text = ''
    this.error = null
    this.usage = undefined
    this.startedAt = Date.now()
    this.toolUses = 0
    this.seenToolSteps.clear()
  }

  /** Feed one event. True means the current turn reached its terminal result. */
  observe(event: AntigravityEvent): boolean {
    const id = event.conversation_id ?? event.init?.conversation_id ?? event.result?.conversation_id
    if (typeof id === 'string' && id) this.sessionId = id
    const namedModel = event.init?.model ?? event.result?.model
    if (typeof namedModel === 'string' && namedModel) this.model = namedModel

    if (event.event === 'step_update') {
      const step = event.step_update
      if (step?.tool_info != null && step.state === 'DONE' && typeof step.step_index === 'number' && !this.seenToolSteps.has(step.step_index)) {
        this.seenToolSteps.add(step.step_index)
        this.toolUses += 1
      }
      return false
    }
    if (event.event !== 'result' || !event.result) return false

    const result = event.result
    if (typeof result.response === 'string') this.text = result.response
    if (result.status !== 'SUCCESS') {
      this.error = typeof result.error === 'string' && result.error
        ? result.error
        : `antigravity turn ended with status ${result.status || 'UNKNOWN'}`
    }
    const delta = antigravityUsageDelta(result.usage, this.previousUsage)
    this.previousUsage = result.usage
    this.usage = antigravityUsage(delta)
    if (this.usage && this.onHopUsage) {
      this.hopIndex += 1
      try {
        this.onHopUsage({
          model: this.model ?? 'antigravity',
          usage: this.usage,
          latencyMs: this.startedAt == null ? undefined : Date.now() - this.startedAt,
          hopIndex: this.hopIndex,
          toolUses: this.toolUses,
          textChars: this.text.length,
        })
      } catch { /* ledger reporting is best-effort */ }
    }
    return true
  }
}

class AntigravitySession implements EngineSession {
  private readonly child: ChildProcess
  private readonly tracker: AntigravityTurnTracker
  private readonly decoder = new StringDecoder('utf8')
  private outBuf = ''
  private exited = false
  private exitCode = 0
  private stderrTail: string[] = []
  private stdoutTail: string[] = []
  private pending: { resolve: (result: EngineRunResult) => void } | null = null
  private stopPromise: Promise<void> | null = null
  readonly carriesStandingPrompt = false

  constructor(
    command: string,
    argv: string[],
    shell: boolean,
    private readonly opts: EngineSessionArgs,
    pin: string | null,
  ) {
    this.tracker = new AntigravityTurnTracker(pin, opts.onHopUsage)
    this.child = spawnEngineChild(command, argv, {
      cwd: opts.home,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell,
    })
    this.child.stdout?.on('data', (buf: Buffer) => this.onStdout(buf))
    this.child.stderr?.on('data', (buf: Buffer) => this.onStderr(buf))
    this.child.on('error', (err) => this.die(1, err.message))
    this.child.on('close', (code, signalName) => {
      this.flushStdout()
      this.die(code ?? (signalName ? 128 : 1), signalName ? `terminated by ${signalName}` : `exited with code ${code}`)
    })
  }

  get alive(): boolean { return !this.exited && this.child.stdin?.writable === true }
  get sessionId(): string | null { return this.tracker.sessionId }
  get text(): string { return this.tracker.text }

  send(prompt: string): Promise<EngineRunResult> {
    if (this.pending) return Promise.resolve({ exitCode: 1, error: 'engine session busy — a turn is already in flight', sessionId: this.sessionId })
    if (!this.alive) {
      return Promise.resolve({
        exitCode: this.exitCode || 1,
        error: failurePreview({ exitCode: this.exitCode || 1, signalName: null, stderr: this.stderrTail, stdout: this.stdoutTail }),
        sessionId: this.sessionId,
      })
    }
    this.tracker.beginTurn()
    return new Promise((resolve) => {
      this.pending = { resolve }
      const message = JSON.stringify({ event: 'user', message: { content: stripLoneSurrogates(prompt) } })
      if (!writeStdin(this.child, `${message}\n`)) {
        this.settle({ exitCode: 1, error: 'failed to write turn to antigravity', sessionId: this.sessionId })
      }
    })
  }

  steer(_text: string): void {
    // The documented protocol requires waiting for a result before the next
    // user event. Queueing mid-turn would be an undocumented race; the daemon's
    // normal coalesced wake delivers the ping after this turn instead.
    if (this.pending) this.opts.onLog('[antigravity] same-turn steer is not supported; the ping rides the next wake')
  }

  stop(options: { force?: boolean } = {}): Promise<void> {
    this.exited = true
    try { this.child.stdin?.end() } catch { /* ignore */ }
    if (options.force) return terminateEngineTree(this.child, true)
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        if (await waitForChildExit(this.child, 2_000)) return
        await terminateEngineTree(this.child)
      })()
    }
    return this.stopPromise
  }

  private onStdout(buf: Buffer): void {
    this.outBuf += this.decoder.write(buf)
    let newline: number
    while ((newline = this.outBuf.indexOf('\n')) >= 0) {
      const raw = this.outBuf.slice(0, newline)
      this.outBuf = this.outBuf.slice(newline + 1)
      this.takeLine(raw)
    }
  }

  private flushStdout(): void {
    this.outBuf += this.decoder.end()
    if (this.outBuf) this.takeLine(this.outBuf)
    this.outBuf = ''
  }

  private takeLine(raw: string): void {
    const line = cleanLine(raw)
    if (!line) return
    pushTail(this.stdoutTail, line)
    this.opts.onLog(line)
    const event = parseAntigravityLine(line)
    if (event && this.tracker.observe(event)) {
      const eventError = this.tracker.error
      this.settle({
        exitCode: eventError ? 1 : 0,
        error: eventError ? `engine turn error: ${eventError.slice(0, MAX_FAILURE_CHARS)}` : undefined,
        sessionId: this.tracker.sessionId,
        usage: this.tracker.usage,
        model: this.tracker.model,
      })
    }
  }

  private onStderr(buf: Buffer): void {
    for (const raw of buf.toString('utf8').split('\n')) {
      const line = cleanLine(raw)
      if (!line) continue
      pushTail(this.stderrTail, line)
      this.opts.onLog(line)
    }
  }

  private settle(result: EngineRunResult): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    pending.resolve(result)
  }

  private die(code: number, detail: string): void {
    if (this.exited && !this.pending) return
    this.exited = true
    this.exitCode = code
    if (this.pending) {
      this.settle({
        exitCode: code || 1,
        error: failurePreview({ exitCode: code || 1, signalName: null, stderr: this.stderrTail, stdout: this.stdoutTail }) || detail,
        sessionId: this.sessionId,
        usage: this.tracker.usage,
        model: this.tracker.model,
      })
    }
  }
}

class AntigravityAdapter implements EngineAdapter {
  readonly id = 'antigravity' as const
  readonly bin = 'agy'

  private sessionArgs(args: EngineSessionArgs, mode: 'accept-edits' | 'plan'): string[] {
    const model = args.model ? ['--model', args.model] : []
    return [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--sandbox',
      '--mode', mode,
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      ...model,
    ]
  }

  private start(args: EngineSessionArgs, mode: 'accept-edits' | 'plan'): AntigravitySession {
    const { command, shell } = resolveSpawn(this.bin)
    // Do not pass --conversation across daemon restarts yet. Its result usage is
    // cumulative over the historical conversation, while Cumora persists only
    // the id, not the prior counters; resuming would overbill that history as
    // the first new turn. The per-agent home + memory remains durable.
    return new AntigravitySession(command, this.sessionArgs(args, mode), shell, args, args.model ?? null)
  }

  startSession(args: EngineSessionArgs): EngineSession | null {
    return this.start(args, 'accept-edits')
  }

  async run(args: EngineRunArgs): Promise<EngineRunResult> {
    if (args.signal.aborted) return { exitCode: 130, error: 'engine turn aborted before start', sessionId: null }
    const sessionArgs: EngineSessionArgs = {
      home: args.home,
      env: args.env,
      model: args.model,
      fastModel: args.fastModel,
      resumeSessionId: args.resumeSessionId,
      onLog: args.onLog,
      onHopUsage: args.onHopUsage,
    }
    const session = this.start(sessionArgs, 'accept-edits')
    const onAbort = (): void => { void session.stop({ force: true }) }
    args.signal.addEventListener('abort', onAbort, { once: true })
    if (args.signal.aborted) onAbort()
    try {
      if (args.signal.aborted) return { exitCode: 130, error: 'engine turn aborted before start', sessionId: null }
      return await session.send(args.prompt)
    } finally {
      args.signal.removeEventListener('abort', onAbort)
      await session.stop()
    }
  }

  async classify(args: EngineClassifyArgs): Promise<EngineClassifyResult> {
    const session = this.start({
      home: args.cwd,
      env: args.env,
      model: args.model ?? process.env.CUMORA_TRIAGE_MODEL ?? null,
      onLog: args.onLog ?? (() => {}),
    }, 'plan')
    const onAbort = (): void => { void session.stop({ force: true }) }
    args.signal.addEventListener('abort', onAbort, { once: true })
    if (args.signal.aborted) onAbort()
    try {
      if (args.signal.aborted) return { text: '', error: 'engine turn aborted before start' }
      const result = await session.send(args.prompt)
      return { text: session.text, error: result.error, usage: result.usage, model: result.model }
    } finally {
      args.signal.removeEventListener('abort', onAbort)
      await session.stop()
    }
  }

  async probe(args: EngineProbeArgs): Promise<EngineClassifyResult> {
    const model = args.tier === 'small' ? (process.env.CUMORA_TRIAGE_MODEL ?? null) : null
    return this.classify({ cwd: args.cwd, prompt: DOCTOR_PROMPT, env: args.env, model, signal: args.signal })
  }

  probeWake(_args: EngineWakeProbeArgs): Promise<EngineWakeProbeResult> {
    // classify()/probe() use the same bidirectional stream-json protocol as a
    // real wake, only in plan mode, so the brain probes already cover it.
    return Promise.resolve({ ok: true, detail: '', skipped: true })
  }

  async seedHome(home: string, persona: EnginePersona): Promise<void> {
    await ensureCommonHome(home)
    await mkdir(join(home, '.agents', 'skills'), { recursive: true })
    await writeFile(
      join(home, 'AGENTS.md'),
      PERSONA_HEADER(persona, { personaFile: 'AGENTS.md', skillsDir: '.agents/skills/' }),
      'utf8',
    )
  }
}


const ADAPTERS: Record<EngineId, EngineAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  grok: new GrokAdapter(),
  cursor: new CursorAdapter(),
  opencode: new OpenCodeAdapter(),
  pi: new PiAdapter(),
  gemini: new GeminiAdapter(),
  qwen: new QwenAdapter(),
  antigravity: new AntigravityAdapter(),
}

export function getAdapter(id: EngineId): EngineAdapter {
  return ADAPTERS[id]
}

export interface EngineDetection {
  engines: EngineId[]
  /** False when `which` / `where` itself failed, so missing engines cannot be
   *  distinguished from a broken scan and callers should keep their last good
   *  inventory. */
  reliable: boolean
}

/** Probe which engines are installed and whether absence is trustworthy. */
export async function detectEnginesWithStatus(): Promise<EngineDetection> {
  const ids = Object.keys(ADAPTERS) as EngineId[]
  const probes = await Promise.all(ids.map(async (id) => {
    const status = await probeBinOnPath(ADAPTERS[id].bin)
    const installed = status === 'present' || (id === 'grok' && resolveGrokBin() != null)
    return { id, installed, status }
  }))
  return {
    engines: probes.filter((p) => p.installed).map((p) => p.id),
    reliable: probes.every((p) => p.status !== 'error'),
  }
}

/** Probe which engines are installed on this machine. */
export async function detectEngines(): Promise<EngineId[]> {
  return (await detectEnginesWithStatus()).engines
}

/** One detected engine as stored on the computer row and shown in the app.
 *  Paths are resolved on the daemon machine (Windows `where` / POSIX `which`);
 *  the renderer never probes PATH. */
export interface DetectedEngineSnapshot {
  id: EngineId
  bin: string
  path: string | null
  /** Version fields are absent from the cheap pairing snapshot and filled in by
   *  enrichDetectedEngines() on the rescan, which is allowed to spawn CLIs. */
  version?: string | null
  latest?: string | null
  outdated?: boolean
  updateCommand?: string | null
  /** Why this installed engine will NOT be driven — the reason
   *  evaluateRunnableEngines() produced. Absent on runnable engines. */
  blockedReason?: string
  /** Account/config-specific model choices discovered by the daemon that owns
   * this CLI login. Absent on the cheap pairing snapshot and older daemons. */
  modelCatalog?: EngineModelCatalog
}

/** Snapshot the installed engines, optionally in a caller-supplied order
 *  (pairing puts the chosen default first). Does not spawn the CLIs. */
export async function snapshotDetectedEngines(ids?: EngineId[]): Promise<DetectedEngineSnapshot[]> {
  const present = ids ?? await detectEngines()
  return Promise.all(present.map(async (id) => {
    const bin = ADAPTERS[id].bin
    const path = id === 'grok'
      ? (resolveGrokBin() ?? await resolveBinPath(bin))
      : await resolveBinPath(bin)
    return { id, bin, path }
  }))
}

/** Add each engine's installed version, the newest one upstream, and how to
 *  update — measured on *this* machine. Spawns one `--version` per engine, so
 *  it rides the 5-minute rescan rather than the pairing path, which the user is
 *  sitting and waiting on. */
export async function enrichDetectedEngines(
  snapshot: DetectedEngineSnapshot[],
  refreshModelCatalog = false,
): Promise<DetectedEngineSnapshot[]> {
  return Promise.all(snapshot.map(async (entry) => {
    const [version, modelCatalog] = await Promise.all([
      probeEngineVersion(entry.id, entry.path),
      discoverEngineModelCatalog(entry.id, entry.path, refreshModelCatalog),
    ])
    return { ...entry, ...version, modelCatalog }
  }))
}

/** Resolve a bin's absolute path on PATH (the first hit), or null if absent. */
export async function resolveBinPath(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = spawn(IS_WIN ? 'where' : 'which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    probe.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8') })
    probe.on('error', () => resolve(null))
    probe.on('close', (code) => resolve(code === 0 ? (out.split(/\r?\n/)[0]?.trim() || null) : null))
  })
}

/** Health of one brain tier of one engine, as measured by a `doctor` probe. */
export interface BrainHealth {
  ok: boolean
  /** Probe wall-clock in ms. */
  ms: number
  /** On ok: the (truncated) reply. On failure: the concise error/exit detail. */
  detail: string
}

/** Wake-path probe result, surfaced alongside the per-tier brains. `null` when
 *  the engine isn't installed; `skipped:true` when the adapter's wake path
 *  collapses to one-shot exec on this machine (the brain probes already cover
 *  that case). */
export interface WakeHealth {
  ok: boolean
  ms: number
  detail: string
  skipped?: boolean
}

/** `doctor` result for one engine. `big`/`small`/`wake` are null when not installed. */
export interface EngineHealth {
  id: EngineId
  installed: boolean
  /** Absolute path of the resolved bin, or null if not on PATH. */
  path: string | null
  big: BrainHealth | null
  small: BrainHealth | null
  /** Wake-path protocol health (codex app-server JSON-RPC handshake; claude
   *  persistent-session flag set; grok ACP stdio handshake). Cursor/OpenCode
   *  skip it because their wake path is the same one-shot call as the brain
   *  probe. Separate signal from big/small because those failures are
   *  auth/quota, while this one is protocol/CLI compatibility. */
  wake: WakeHealth | null
}

/** How the engines Cumora drives word a rejected flag. Taken from the real
 *  binaries, because the shapes differ more than they look:
 *
 *    claude / cursor-agent   error: unknown option '--x'
 *    codex                   error: unexpected argument '--x' found
 *    gemini 0.1.x            Unknown argument: o
 *
 *  Only the first two lead with `error:`, which is what `salientError` keys on.
 *  Gemini prints its ENTIRE help to stderr and puts the cause on the LAST line,
 *  so without this pattern the operator's diagnosis is 280 characters of usage
 *  text with the reason cut off the end. */
const ARGV_REJECTION_RE =
  /\b(?:unknown (?:argument|option|flag)s?|unrecogni[sz]ed (?:argument|option)s?|unexpected argument|invalid option)\b[^\n]*/i

/** The engine rejected one of OUR flags, so it failed before doing any work.
 *
 *  Worth separating from every other probe failure because the fix is
 *  different in kind: not "sign in", not "wait out the rate limit", but "the
 *  installed CLI is older than the flag set this adapter sends". Returns the
 *  offending line, or null when the failure was something else. */
export function argvRejection(raw: string): string | null {
  const m = raw.replace(ANSI_RE, '').replace(/\r/g, '').match(ARGV_REJECTION_RE)
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 120) : null
}

/** Pull the most informative line out of an engine's failure output. Engines bury
 *  the real cause (usage limit / not signed in / bad model) under a multi-line
 *  startup banner, often on a different stream — lead with the line that names it. */
function salientError(raw: string): string {
  // Ahead of the generic scan: an argv rejection can sit BELOW a whole help
  // dump, and the fallback (first 280 chars of everything) would show the
  // banner instead of the cause.
  const rejected = argvRejection(raw)
  if (rejected) return rejected
  const clean = raw.replace(ANSI_RE, '').replace(/\r/g, '')
  const m = clean.match(
    /((?:error|fatal)\b[:\- ].*|you'?ve hit your usage limit.*|usage limit.*|rate.?limit.*|quota.*|over(?:loaded|capacity).*|insufficient (?:credit|quota).*|unauthor\w*.*|forbidden.*|invalid (?:api )?key.*|not (?:logged in|authenticated|signed in).*|(?:please )?(?:sign|log) ?in.*|authentication .*)/i,
  )
  return (m ? m[0] : clean).replace(/\s+/g, ' ').trim().slice(0, 280)
}

/** Diagnose every engine on this machine: is it installed, and are its big-brain
 *  and small-brain (cerebellum) tiers reachable + authed? Each tier gets a trivial
 *  one-shot probe (the same spawn path triage/turns use), so a green result means
 *  real wakes will work. Engines are probed in parallel; the two tiers of one
 *  engine run sequentially to avoid self-induced rate limits. Never throws. */
export async function runEngineDoctor(opts?: {
  env?: NodeJS.ProcessEnv
  /** Per-tier timeout. Default 60s — a cold engine + auth handshake can be slow. */
  timeoutMs?: number
  onLog?: (line: string) => void
}): Promise<EngineHealth[]> {
  const env = opts?.env ?? process.env
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const cwd = await mkdtemp(join(tmpdir(), 'cumora-doctor-'))
  const ids = Object.keys(ADAPTERS) as EngineId[]
  return Promise.all(ids.map(async (id): Promise<EngineHealth> => {
    const adapter = ADAPTERS[id]
    const path = (await resolveBinPath(adapter.bin)) ?? (id === 'grok' ? resolveGrokBin(env) : null)
    if (!path) return { id, installed: false, path: null, big: null, small: null, wake: null }
    const probeTier = async (tier: 'big' | 'small'): Promise<BrainHealth> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const t0 = Date.now()
      let r: EngineClassifyResult
      try {
        opts?.onLog?.(`probing ${id} ${tier}-brain…`)
        r = await adapter.probe({ tier, cwd, env, signal: controller.signal })
      } catch (err) {
        r = { text: '', error: err instanceof Error ? err.message : String(err) }
      } finally {
        clearTimeout(timer)
      }
      const ms = Date.now() - t0
      if (controller.signal.aborted) {
        return { ok: false, ms, detail: `timed out after ${timeoutMs}ms (likely blocked on auth or a throttled provider)` }
      }
      if (r.error || !r.text.trim()) {
        // The real cause is often on STDOUT (e.g. codex prints "ERROR: You've hit
        // your usage limit" to stdout while stderr holds only the startup banner),
        // so search BOTH streams and surface the salient error line — not the banner.
        const both = `${r.error ?? ''}\n${r.text ?? ''}`
        const rejected = argvRejection(both)
        // Name the fix. A red brain that reads "Unknown argument: o" tells an
        // operator nothing; the same line plus the binary it came from says
        // which CLI to update, and rules out the auth/quota causes they would
        // otherwise go looking for first.
        if (rejected) {
          return { ok: false, ms, detail: `${rejected} — \`${adapter.bin}\` is older than the flags Cumora sends; update it` }
        }
        return { ok: false, ms, detail: salientError(both) || 'no output' }
      }
      return { ok: true, ms, detail: r.text.replace(ANSI_RE, '').trim().slice(0, 80) }
    }
    const probeWakeOnce = async (): Promise<WakeHealth> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const t0 = Date.now()
      let r: EngineWakeProbeResult
      try {
        opts?.onLog?.(`probing ${id} wake-path…`)
        // Use a FRESH subdir per engine: codex may `git init` here and we don't
        // want claude's probe (or a re-run) tripping over a stale .git.
        const wakeCwd = await mkdtemp(join(tmpdir(), `cumora-doctor-${id}-wake-`))
        r = await adapter.probeWake({ cwd: wakeCwd, env, signal: controller.signal })
      } catch (err) {
        r = { ok: false, detail: err instanceof Error ? err.message : String(err) }
      } finally {
        clearTimeout(timer)
      }
      const ms = Date.now() - t0
      if (controller.signal.aborted) {
        return { ok: false, ms, detail: `timed out after ${timeoutMs}ms (wake-path handshake)` }
      }
      return { ok: r.ok, ms, detail: r.detail, skipped: r.skipped }
    }
    // Sequential within an engine (same provider/account → don't race a rate limit).
    const big = await probeTier('big')
    const small = await probeTier('small')
    const wake = await probeWakeOnce()
    return { id, installed: true, path, big, small, wake }
  }))
}
