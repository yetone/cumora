/** Engine version probing, run on the daemon's own machine.
 *
 *  The Computers tab shows, per engine, the version installed on *that*
 *  computer. Only the daemon can answer that — the desktop app can scan its own
 *  PATH, but that is a different machine whenever you are not sitting at the one
 *  you paired. So the probe lives here and rides the heartbeat's engine rescan.
 *
 *  Local versions are re-probed on every rescan (cheap: one spawn per engine,
 *  against an already-resolved absolute path). Upstream "latest" lookups hit the
 *  network — or a slow `about` / `update --check` subcommand — so they are cached
 *  well past the rescan interval.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'

interface CommandInvocation {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/** npm on Windows installs an extensionless POSIX shim before the runnable
 * `.cmd` shim in `where` output. CreateProcess cannot execute either file
 * directly, so select the sibling batch shim and invoke it through ComSpec. */
export function versionCommandInvocation(
  command: string,
  args: string[],
  platform = process.platform,
  comspec = process.env.ComSpec || 'cmd.exe',
): CommandInvocation {
  if (platform !== 'win32') return { command, args }

  let runnable = command
  if (!/\.(?:cmd|bat|com|exe)$/i.test(runnable)) {
    for (const ext of ['.cmd', '.bat', '.exe', '.com']) {
      if (fs.existsSync(`${command}${ext}`)) {
        runnable = `${command}${ext}`
        break
      }
    }
  }
  if (!/\.(?:cmd|bat)$/i.test(runnable)) return { command: runnable, args }

  const commandArgs = args.map((arg) => {
    const value = String(arg)
    return /^[\w./:=+-]+$/u.test(value) ? value : `"${value.replace(/"/g, '""')}"`
  })
  const commandLine = `""${runnable}"${commandArgs.length ? ` ${commandArgs.join(' ')}` : ''}"`
  return {
    command: comspec,
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  }
}

/** How to ask an engine its version, and how to find out what the newest one is. */
export interface EngineVersionSpec {
  /** Args that make the binary print its version (`--version` for all but hermes). */
  versionArgs: string[]
  /** npm package, when the CLI ships on the public registry. */
  npm?: string
  /** Extra flags the vendor documents for a global install (pi needs --ignore-scripts). */
  npmFlags?: string
  /** Homebrew formula, when the CLI is also brewable. */
  brew?: string
  /** The vendor's own updater, preferred over brew/npm when it exists. */
  selfUpdate?: string
  /** CLIs that report upstream themselves instead of via the npm registry. */
  latestVia?: 'cursor-about' | 'grok-check'
}

/** Keep in sync with src/lib/engines.ts (ENGINE_LABEL / ENGINE_BIN /
 *  RUNNABLE_ENGINE_IDS) and, for engines Cumora can actually wake, ENGINE_IDS
 *  in agents/computer/engine.ts. */
export const ENGINE_VERSION_SPECS: Record<string, EngineVersionSpec> = {
  claude: {
    versionArgs: ['--version'],
    npm: '@anthropic-ai/claude-code',
    brew: 'claude-code',
    selfUpdate: 'claude update',
  },
  cursor: {
    versionArgs: ['--version'],
    latestVia: 'cursor-about',
    selfUpdate: 'cursor-agent update',
  },
  codex: {
    versionArgs: ['--version'],
    npm: '@openai/codex',
  },
  grok: {
    versionArgs: ['--version'],
    latestVia: 'grok-check',
    npm: '@xai-official/grok',
    selfUpdate: 'grok update',
  },
  opencode: {
    versionArgs: ['--version'],
    npm: 'opencode-ai',
    selfUpdate: 'opencode upgrade',
  },
  pi: {
    versionArgs: ['--version'],
    npm: '@earendil-works/pi-coding-agent',
    npmFlags: '--ignore-scripts',
    selfUpdate: 'pi update',
  },
  gemini: {
    versionArgs: ['--version'],
    npm: '@google/gemini-cli',
    brew: 'gemini-cli',
  },
  qwen: {
    versionArgs: ['--version'],
    npm: '@qwen-code/qwen-code',
  },
  antigravity: {
    versionArgs: ['--version'],
    selfUpdate: 'agy update',
  },
  hermes: {
    versionArgs: ['version'],
    selfUpdate: 'hermes update',
  },
}

/** Upstream versions change on the vendor's release cadence, not ours, and the
 *  rescan runs every 5 minutes. Cache far longer than the rescan so a paired
 *  machine is not making the same registry call all day. A stale `latest` only
 *  delays noticing a new release; it never produces a wrong "outdated" badge,
 *  because the *local* side of the comparison is always freshly probed. */
const LATEST_TTL_MS = 6 * 60 * 60 * 1000

const latestCache = new Map<string, { at: number; version: string | null }>()

/** Test seam: drop memoized upstream versions. */
export function clearLatestCache(): void {
  latestCache.clear()
}

/** Pull the first version-looking token out of CLI output. Accepts both semver
 *  and the CalVer some vendors print (`2026.08.30`). */
/** Lines that carry a version number but never the CLI's OWN version.
 *
 *  `npm warn EBADENGINE Unsupported engine { required: { node: '>=20.19.0' } }`
 *  and `(node:1234) [DEP0040] DeprecationWarning: …` both routinely precede a
 *  CLI's real output, and both contain something that looks exactly like a
 *  version. Taking the first match in the combined stream then reads the
 *  warning's number as the engine's version — which is how a Claude Code 2.0.9
 *  came back as "20.19.0" and satisfied the 2.1.248 secure floor. The gate that
 *  exists to refuse an un-sandboxable CLI failed OPEN on unrelated noise. */
const VERSION_NOISE_LINE =
  /^\s*(?:npm\s+(?:warn|WARN|notice|err)|\(node:\d+\)|warning:|warn\b|deprecat|debugger\s|\[dep\d)/i

const VERSION_TOKEN = /v?(\d{4}\.\d{2}\.\d{2}(?:-[\w.]+)?|\d+\.\d+\.\d+(?:[-+][\w.]+)?)/i

/** The version a command reported. stdout is what a CLI prints its own version
 *  on, so it is asked first; stderr is only a fallback for the engines that
 *  report there, and can no longer outrank the real answer. */
export function versionFromOutput(out: CommandOutput): string | null {
  return parseCliVersion(out.stdout) ?? parseCliVersion(out.stderr)
}

/** The version a CLI reported, ignoring lines that are someone else's version.
 *
 *  Scans line by line rather than the blob so a warning cannot win merely by
 *  arriving first. */
export function parseCliVersion(text: string | null | undefined): string | null {
  if (!text) return null
  // Warnings are frequently multi-line, and only the FIRST line carries the
  // marker — npm's EBADENGINE puts the version on an indented continuation:
  //   npm warn EBADENGINE Unsupported engine {
  //     required: { node: '>=20.19.0' }
  //   }
  // So a line is noise if it announces itself as one, or if it is a
  // continuation of one: indented, or a bare closing brace. Suppression only
  // ever begins after a marker line, so output with no warnings is untouched.
  let inNoise = false
  for (const line of String(text).split(/\r?\n/)) {
    if (VERSION_NOISE_LINE.test(line)) { inNoise = true; continue }
    if (inNoise && (/^\s+\S/.test(line) || /^\s*[)}\]]+[,;]?\s*$/.test(line) || line.trim() === '')) continue
    inNoise = false
    const m = line.match(VERSION_TOKEN)
    if (m) return m[1]
  }
  return null
}

function versionParts(v: string): number[] {
  const main = String(v).replace(/^v/i, '').split(/[-+]/)[0] ?? ''
  return main.split('.').map((n) => Number.parseInt(n, 10) || 0)
}

/** Semver/CalVer floor used for local capability gates. A prerelease at the
 * exact numeric floor remains below the final release; unknown versions fail
 * closed at the caller. */
export function isCliVersionAtLeast(current: string | null, minimum: string): boolean {
  if (!current) return false
  const a = versionParts(current)
  const b = versionParts(minimum)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  const currentMain = current.trim().replace(/^v/i, '').split('+', 1)[0]
  const minimumMain = minimum.trim().replace(/^v/i, '').split('+', 1)[0]
  return !(currentMain.includes('-') && !minimumMain.includes('-'))
}

/** True only when `latest` is strictly newer. Unknown on either side means we
 *  say nothing rather than nag. */
export function isCliOutdated(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false
  if (current === latest) return false
  const a = versionParts(current)
  const b = versionParts(latest)
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (y > x) return true
    if (y < x) return false
  }
  return false
}

function realpathOf(binPath: string): string {
  try {
    return fs.realpathSync(binPath)
  } catch {
    return binPath
  }
}

export function isHomebrewInstall(binPath: string, real: string): boolean {
  const hay = `${binPath}\n${real}`
  return /(^|[/\\])(Homebrew|homebrew|linuxbrew|Cellar)([/\\]|$)/i.test(hay)
    || binPath.startsWith('/opt/homebrew/')
}

function npmUpdateCommand(spec: EngineVersionSpec): string | null {
  if (!spec.npm) return null
  const flags = spec.npmFlags ? `${spec.npmFlags} ` : ''
  return `npm install -g ${flags}${spec.npm}@latest`
}

/** Prefer the CLI's own updater when it has one (`pi update`, `claude update`):
 *  that is the path vendors document, and it behaves the same on Windows. Fall
 *  back to brew only when the binary actually came from brew, else npm. */
export function inferUpdateCommand(spec: EngineVersionSpec, binPath: string | null): string | null {
  if (spec.selfUpdate) return spec.selfUpdate
  if (spec.brew && binPath && isHomebrewInstall(binPath, realpathOf(binPath))) {
    return `brew upgrade ${spec.brew}`
  }
  return npmUpdateCommand(spec)
}

export function parseCursorAbout(text: string): string | null {
  const latestLine = text.split(/\r?\n/).find((line) => /^\s*Latest\b/i.test(line))
  if (!latestLine) return null
  return parseCliVersion(latestLine)
}

export function parseGrokCheck(text: string): string | null {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    return typeof data.latestVersion === 'string' ? data.latestVersion : null
  } catch {
    return parseCliVersion(text)
  }
}

export interface CommandOutput {
  stdout: string
  stderr: string
  /** stdout first — the order every combined-text caller wants. */
  combined: string
}

/** Run a command and return its output, or empty strings on any failure. Never
 *  rejects: a missing or wedged CLI must not take down the rescan.
 *
 *  The streams are returned APART because they mean different things: a CLI
 *  prints its version on stdout and its warnings on stderr, and merging them
 *  let an `npm warn EBADENGINE … node: '>=20.19.0'` line stand in for an
 *  engine's version at the secure floor. */
function spawnCommand(cmd: string, args: string[], timeoutMs: number): Promise<CommandOutput> {
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      const invocation = versionCommandInvocation(cmd, args)
      child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      })
    } catch {
      resolve({ stdout: '', stderr: '', combined: '' })
      return
    }
    // Kept apart, then joined stdout-first. A CLI prints its version on stdout
    // and its warnings on stderr, so scanning stdout first means a warning
    // cannot win by arriving earlier — which is what let an npm EBADENGINE
    // line stand in for an engine's version at the secure floor. Some engines
    // do report the version on stderr, so it stays in the text, just after.
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (buf: Buffer) => { stdout += buf.toString('utf8') })
    child.stderr?.on('data', (buf: Buffer) => { stderr += buf.toString('utf8') })
    const captured = (): CommandOutput => ({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      combined: `${stdout}\n${stderr}`.trim(),
    })
    const finish = (value: CommandOutput) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(captured())
    }, timeoutMs)
    child.on('error', () => finish({ stdout: '', stderr: '', combined: '' }))
    child.on('close', () => finish(captured()))
  })
}

async function npmLatest(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      headers: { 'User-Agent': 'cumora-daemon', Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json() as Record<string, unknown>
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

async function probeLatest(id: string, spec: EngineVersionSpec, binPath: string | null): Promise<string | null> {
  const cached = latestCache.get(id)
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.version

  let version: string | null = null
  try {
    if (spec.latestVia === 'cursor-about' && binPath) {
      const about = (await spawnCommand(binPath, ['about'], 10_000)).combined
      version = parseCursorAbout(about) || parseCliVersion(about)
    } else if (spec.latestVia === 'grok-check' && binPath) {
      const check = (await spawnCommand(binPath, ['update', '--check', '--json'], 12_000)).combined
      version = parseGrokCheck(check)
    }
    if (!version && spec.npm) version = await npmLatest(spec.npm)
  } catch {
    version = null
  }
  latestCache.set(id, { at: Date.now(), version })
  return version
}

/** What the daemon reports per engine, beyond the bin path. */
export interface EngineVersionInfo {
  version: string | null
  latest: string | null
  outdated: boolean
  updateCommand: string | null
}

/** Probe one engine on this machine. `binPath` is the already-resolved absolute
 *  path, so this never depends on the daemon's PATH being as rich as a shell's. */
export async function probeEngineVersion(id: string, binPath: string | null): Promise<EngineVersionInfo> {
  const spec = ENGINE_VERSION_SPECS[id]
  const empty: EngineVersionInfo = { version: null, latest: null, outdated: false, updateCommand: null }
  if (!spec || !binPath) return empty

  const version = versionFromOutput(await spawnCommand(binPath, spec.versionArgs, 6000))
  const latest = await probeLatest(id, spec, binPath)
  const outdated = isCliOutdated(version, latest)
  return {
    version,
    latest,
    outdated,
    updateCommand: outdated ? inferUpdateCommand(spec, binPath) : null,
  }
}

/** Local-only version probe for security capability gates. Unlike
 * probeEngineVersion(), this never contacts npm or an engine updater. */
export async function probeLocalEngineVersion(id: string, binPath: string | null): Promise<string | null> {
  const spec = ENGINE_VERSION_SPECS[id]
  if (!spec || !binPath) return null
  return versionFromOutput(await spawnCommand(binPath, spec.versionArgs, 6000))
}
