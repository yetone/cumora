/**
 * Unit tests for BYOA local engine adapters.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-engine.test.ts
 */
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { type EngineHopReport, type EngineRunResult, getAdapter, headlessSpawnOptions, resolveSpawn, runnableEngineIds, secureEngineCapabilityReason } from '../agents/computer/engine.js'
import { CLAUDE_CORE_ENV_KEYS, CLAUDE_TURN_ENV_KEYS } from '../agents/computer/claude-user-settings.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_PATHEXT = process.env.PATHEXT
const ORIGINAL_UNSANDBOXED = process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
const tempDirs: string[] = []
// Sessions spawn a child process. Track them so a FAILING assertion still tears
// the child down — otherwise it outlives the test and the runner never exits.
const liveSessions: Array<{ stop(): void | Promise<void> }> = []

function secureClaudeEnv(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  // withClaudeUserSettingsEnv only imports a key from settings.json when the
  // process environment does NOT already define it — an explicit value wins, by
  // design. Spreading process.env therefore let the developer's own shell
  // decide the outcome: anyone running Claude Code has ANTHROPIC_BASE_URL set,
  // so the settings-import assertions below failed on their machine and nowhere
  // else. Drop the bootstrap keys so these tests measure the import, not the
  // shell. Sourced from the module under test so a fifth key cannot drift.
  for (const key of CLAUDE_CORE_ENV_KEYS) delete base[key]
  for (const key of CLAUDE_TURN_ENV_KEYS) delete base[key]
  base.CLAUDE_CONFIG_DIR = join(root, 'missing-claude-config')
  return {
    ...base,
    CUMORA_AGENT_IPC_DIR: join(root, 'private-ipc'),
    CUMORA_AGENT_MCP_SHIM: join(root, 'trusted', 'cumora-mcp'),
    ...overrides,
  }
}

/** Install a fake CLI that follows the platform's executable conventions. */
async function writeFakeCli(binDir: string, name: string, source: string): Promise<void> {
  const scriptName = `${name}-fixture.js`
  await writeFile(join(binDir, scriptName), source, 'utf8')
  if (IS_WIN) {
    await writeFile(join(binDir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0${scriptName}" %*\r\n`, 'utf8')
    return
  }
  const launcher = join(binDir, name)
  await writeFile(launcher, `#!/bin/sh\nexec node "$(dirname "$0")/${scriptName}" "$@"\n`, 'utf8')
  await chmod(launcher, 0o755)
}

function useFakeCliPath(binDir: string): void {
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`
}

test('engine subprocesses always suppress Windows console windows', () => {
  assert.deepEqual(headlessSpawnOptions({ shell: true, cwd: 'C:\\agent home', windowsHide: false }), {
    shell: true,
    cwd: 'C:\\agent home',
    windowsHide: true,
  })
})

afterEach(async () => {
  for (const s of liveSessions.splice(0)) { try { await s.stop() } catch { /* already gone */ } }
  if (ORIGINAL_PATH === undefined) delete process.env.PATH
  else process.env.PATH = ORIGINAL_PATH
  if (ORIGINAL_PATHEXT === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = ORIGINAL_PATHEXT
  if (ORIGINAL_UNSANDBOXED === undefined) delete process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED
  else process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = ORIGINAL_UNSANDBOXED
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('secure inventory exposes only engines with a verified boundary', () => {
  const installed = ['claude', 'codex', 'grok', 'cursor', 'opencode', 'pi', 'gemini', 'qwen', 'antigravity'] as const
  assert.deepEqual(runnableEngineIds(installed, {}, 'darwin'), ['claude', 'codex'])
  assert.deepEqual(runnableEngineIds(installed, {}, 'linux'), ['claude', 'codex'])
  assert.deepEqual(runnableEngineIds(installed, {}, 'win32'), ['codex'])
  assert.deepEqual(
    runnableEngineIds(installed, { CUMORA_BYOA_ALLOW_UNSANDBOXED: '1' }, 'win32'),
    [...installed],
  )
})

test('secure engines fail closed on old CLIs and missing Linux sandbox dependencies', () => {
  assert.equal(secureEngineCapabilityReason('claude', '2.1.247', 'darwin'), 'version 2.1.247 is older than the secure minimum 2.1.248')
  assert.equal(secureEngineCapabilityReason('claude', '2.1.248', 'darwin'), null)
  assert.equal(secureEngineCapabilityReason('codex', '0.137.9', 'linux'), 'version 0.137.9 is older than the secure minimum 0.138.0')
  assert.equal(secureEngineCapabilityReason('codex', '0.138.0', 'linux'), null)
  assert.match(
    secureEngineCapabilityReason('claude', '2.1.248', 'linux', { bwrap: false, socat: false }) ?? '',
    /bubblewrap.*socat/,
  )
})

test('secure adapters replace persona symlinks without writing their targets', {
  skip: IS_WIN,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-persona-symlink-'))
  tempDirs.push(root)
  const outside = join(root, 'outside-secret')
  await writeFile(outside, 'do not overwrite', 'utf8')

  for (const [engine, personaFile] of [['claude', 'CLAUDE.md'], ['codex', 'AGENTS.md']] as const) {
    const home = join(root, engine)
    await mkdir(home)
    await symlink(outside, join(home, personaFile))
    await getAdapter(engine).seedHome(home, {
      id: engine,
      name: `Secure ${engine}`,
      role: 'Tester',
      systemPrompt: null,
    })
    assert.equal(await readFile(outside, 'utf8'), 'do not overwrite')
    assert.equal((await lstat(join(home, personaFile))).isSymbolicLink(), false)
    assert.match(await readFile(join(home, personaFile), 'utf8'), new RegExp(`Secure ${engine}`))
  }
})

test('secure adapters reject linked state directories', {
  skip: IS_WIN,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-state-symlink-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  await mkdir(home)
  await mkdir(outside)
  await symlink(outside, join(home, 'memory'))

  await assert.rejects(
    getAdapter('codex').seedHome(home, { id: 'codex', name: 'Codex', role: null, systemPrompt: null }),
    /refuses non-directory or linked path/,
  )

  await rm(join(home, 'memory'))
  await mkdir(join(home, 'memory'))
  const outsideFile = join(root, 'outside-file')
  await writeFile(outsideFile, 'do not read as memory', 'utf8')
  await symlink(outsideFile, join(home, 'memory', 'MEMORY.md'))
  await assert.rejects(
    getAdapter('codex').seedHome(home, { id: 'codex', name: 'Codex', role: null, systemPrompt: null }),
    /refuses non-file or linked memory index/,
  )
})

test('local engine failure returns stderr tail for observability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  await writeFakeCli(
    binDir,
    'claude',
    "process.stderr.write('Claude Code error: usage limit reached, no tokens left\\n')\nprocess.exit(1)\n",
  )
  useFakeCliPath(binDir)

  const logs: string[] = []
  const result = await getAdapter('claude').run({
    home,
    prompt: 'wake',
    env: secureClaudeEnv(root),
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /usage limit reached, no tokens left/i)
  assert.deepEqual(logs, ['Claude Code error: usage limit reached, no tokens left'])
})

test('Claude secure mode is fail-closed and strips tool credentials', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-claude-secure-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const configDir = join(root, 'claude-config')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(configDir)
  await mkdir(home)
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({
    model: 'provider/default-model',
    env: {
      ANTHROPIC_API_KEY: 'settings-api-key-must-lose',
      ANTHROPIC_AUTH_TOKEN: 'settings-auth-token',
      ANTHROPIC_BASE_URL: 'https://provider.example.test',
      UNRELATED_SECRET: 'must-not-be-imported',
    },
  }), 'utf8')
  await writeFakeCli(
    binDir,
    'claude',
    "process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, coreEnv: { apiKey: process.env.ANTHROPIC_API_KEY, authToken: process.env.ANTHROPIC_AUTH_TOKEN, baseUrl: process.env.ANTHROPIC_BASE_URL, unrelated: process.env.UNRELATED_SECRET } }))\nprocess.exit(1)\n",
  )
  useFakeCliPath(binDir)

  const logs: string[] = []
  const mcpShim = join(root, 'trusted', 'cumora-mcp')
  await getAdapter('claude').run({
    home,
    prompt: 'wake',
    env: secureClaudeEnv(root, {
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: 'explicit-daemon-api-key',
      OPENAI_API_KEY: 'must-not-appear-in-settings',
    }),
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })

  const captured = JSON.parse(logs[0] ?? '{}') as {
    argv?: string[]
    scrub?: string
    coreEnv?: { apiKey?: string; authToken?: string; baseUrl?: string; unrelated?: string }
  }
  assert.equal(captured.scrub, '1')
  assert.deepEqual(captured.coreEnv, {
    apiKey: 'explicit-daemon-api-key',
    authToken: 'settings-auth-token',
    baseUrl: 'https://provider.example.test',
  })
  assert.ok(captured.argv?.includes('--restricted'))
  assert.ok(captured.argv?.includes('dontAsk'))
  assert.ok(captured.argv?.includes('Read,Write,Edit,Glob,Grep,mcp__cumora__cli'))
  assert.equal(captured.argv?.some((arg) => /Bash\(cumora/.test(arg)), false)
  assert.equal(captured.argv?.some((arg) => arg.includes('dangerously-skip-permissions')), false)
  const mcpIndex = captured.argv?.indexOf('--mcp-config') ?? -1
  assert.ok(mcpIndex >= 0)
  const mcpConfig = JSON.parse(captured.argv?.[mcpIndex + 1] ?? '{}') as {
    mcpServers?: { cumora?: { command?: string; args?: string[]; env?: Record<string, string> } }
  }
  assert.equal(mcpConfig.mcpServers?.cumora?.command, process.execPath)
  assert.deepEqual(mcpConfig.mcpServers?.cumora?.args, [mcpShim])
  const settingsIndex = captured.argv?.indexOf('--settings') ?? -1
  assert.ok(settingsIndex >= 0)
  const settingsText = captured.argv?.[settingsIndex + 1] ?? '{}'
  const settings = JSON.parse(settingsText) as {
    permissions?: { allow?: string[]; deny?: string[] }
    sandbox?: {
      failIfUnavailable?: boolean
      allowUnsandboxedCommands?: boolean
      filesystem?: { denyRead?: string[]; allowRead?: string[] }
      credentials?: { envVars?: Array<{ name?: string; mode?: string }> }
    }
  }
  assert.ok(settings.permissions?.allow?.includes('Read(/**)'))
  assert.ok(settings.permissions?.allow?.includes('Edit(/**)'))
  assert.ok(settings.permissions?.deny?.includes('Read(/bin/**)'))
  assert.ok(settings.permissions?.deny?.includes('Edit(/bin/**)'))
  assert.equal(settings.sandbox?.failIfUnavailable, true)
  assert.equal(settings.sandbox?.allowUnsandboxedCommands, false)
  assert.ok(settings.sandbox?.filesystem?.denyRead?.includes(process.platform === 'darwin' ? '/Users' : '/home'))
  assert.ok(settings.sandbox?.filesystem?.allowRead?.includes(home))
  assert.ok(settings.sandbox?.credentials?.envVars?.some((entry) => entry.name === 'OPENAI_API_KEY' && entry.mode === 'deny'))
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
    assert.ok(settings.sandbox?.credentials?.envVars?.some((entry) => entry.name === name && entry.mode === 'deny'))
  }
  assert.doesNotMatch(settingsText, /must-not-appear-in-settings/)
  assert.doesNotMatch(settingsText, /settings-auth-token|explicit-daemon-api-key|provider\.example\.test/)
})

test('Claude secure triage stays inside the custom provider model namespace', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-claude-provider-model-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const configDir = join(root, 'claude-config')
  const cwd = join(root, 'triage')
  await mkdir(binDir)
  await mkdir(configDir)
  await mkdir(cwd)
  await writeFakeCli(
    binDir,
    'claude',
    "process.stdout.write(JSON.stringify({ result: JSON.stringify({ argv: process.argv.slice(2) }) }))\n",
  )
  useFakeCliPath(binDir)

  const settingsPath = join(configDir, 'settings.json')
  await writeFile(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'fixture-token',
      ANTHROPIC_BASE_URL: 'https://provider.example.test',
      ANTHROPIC_SMALL_FAST_MODEL: 'provider/legacy-fast-model',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider/fast-model',
    },
  }), 'utf8')
  const env = secureClaudeEnv(root, {
    CLAUDE_CONFIG_DIR: configDir,
    CUMORA_TRIAGE_MODEL: undefined,
    ANTHROPIC_SMALL_FAST_MODEL: undefined,
  })
  const configured = await getAdapter('claude').classify({
    cwd, prompt: 'classify', env, signal: new AbortController().signal,
  })
  const configuredArgv = JSON.parse(configured.text) as { argv: string[] }
  const configuredModel = configuredArgv.argv.indexOf('--model')
  assert.ok(configuredModel >= 0)
  assert.equal(configuredArgv.argv[configuredModel + 1], 'provider/fast-model')

  await writeFile(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: 'fixture-token',
      ANTHROPIC_BASE_URL: 'https://provider.example.test',
    },
  }), 'utf8')
  const unnamed = await getAdapter('claude').classify({
    cwd, prompt: 'classify', env, signal: new AbortController().signal,
  })
  const unnamedArgv = JSON.parse(unnamed.text) as { argv: string[] }
  assert.equal(unnamedArgv.argv.includes('--model'), false)
  assert.equal(unnamedArgv.argv.includes('haiku'), false)
})

test('Claude turn preferences reach one-shot and persistent children without widening tools or triage', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-claude-preferences-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const configDir = join(root, 'config')
  const home = join(root, 'home')
  await Promise.all([mkdir(binDir), mkdir(configDir), mkdir(home)])
  await writeFakeCli(binDir, 'claude', `
const argv = process.argv.slice(2)
const capture = () => JSON.stringify({ argv, env: Object.fromEntries(
  ${JSON.stringify([...CLAUDE_CORE_ENV_KEYS, ...CLAUDE_TURN_ENV_KEYS])}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])
) })
if (argv.includes('--input-format')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
    process.stderr.write(capture() + '\\n')
    process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'OK', session_id:'fixture'}) + '\\n')
  })
} else if (argv.includes('--output-format') && argv[argv.indexOf('--output-format') + 1] === 'json') {
  process.stdout.write(JSON.stringify({result: capture()}))
} else {
  process.stderr.write(capture() + '\\n')
  process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'OK'}) + '\\n')
}
`)
  useFakeCliPath(binDir)
  const preferences = {
    effortLevel: 'xhigh', modelSettings: { 'claude-opus-5': { effortLevel: 'medium' } },
    alwaysThinkingEnabled: true, language: 'Chinese',
  }
  for (const thinking of [undefined, false, true]) {
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({
      ...preferences, alwaysThinkingEnabled: thinking,
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'untrusted-command' }] }] },
      permissions: { allow: ['Bash'], defaultMode: 'bypassPermissions' },
      sandbox: { enabled: false },
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'provider/main', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'provider/small', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' },
    }))
    const env = secureClaudeEnv(root, { CLAUDE_CONFIG_DIR: configDir })
    for (const persistent of [false, true]) {
      const logs: string[] = []
      const args = { home, env, model: 'opus', fastModel: 'agent/small', onLog: (line: string) => logs.push(line) }
      if (persistent) {
        const session = getAdapter('claude').startSession?.(args)
        assert.ok(session)
        liveSessions.push(session)
        assert.equal((await session.send('wake')).exitCode, 0)
        await session.stop()
      } else {
        assert.equal((await getAdapter('claude').run({ ...args, prompt: 'wake', signal: new AbortController().signal })).exitCode, 0)
      }
      const captured = JSON.parse(logs[0]) as { argv: string[]; env: NodeJS.ProcessEnv }
      const settings = JSON.parse(captured.argv[captured.argv.indexOf('--settings') + 1])
      assert.equal(settings.effortLevel, 'xhigh')
      assert.deepEqual(settings.modelSettings, preferences.modelSettings)
      assert.equal(settings.alwaysThinkingEnabled, thinking)
      assert.equal(settings.language, 'Chinese')
      assert.equal(captured.env.MAX_THINKING_TOKENS, undefined)
      assert.equal(captured.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'provider/main')
      assert.equal(captured.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'agent/small')
      assert.equal(captured.env.ANTHROPIC_SMALL_FAST_MODEL, 'agent/small')
      assert.equal(captured.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8192')
      assert.equal(settings.hooks, undefined)
      assert.equal(settings.sandbox.enabled, true)
      assert.equal(settings.permissions.defaultMode, 'dontAsk')
      assert.ok(settings.sandbox.credentials.envVars.some((x: {name: string; mode: string}) => x.name === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' && x.mode === 'deny'))
      assert.doesNotMatch(JSON.stringify(captured.argv), /untrusted-command|provider\/main/)
    }
  }
  await writeFile(join(configDir, 'settings.json'), JSON.stringify({
    effortLevel: 'xhigh', alwaysThinkingEnabled: true,
    env: { MAX_THINKING_TOKENS: '4096', CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' },
  }))
  const env = secureClaudeEnv(root, { CLAUDE_CONFIG_DIR: configDir, MAX_THINKING_TOKENS: '0', CLAUDE_CODE_EFFORT_LEVEL: 'low' })
  const logs: string[] = []
  await getAdapter('claude').run({ home, env, prompt: 'wake', onLog: l => logs.push(l), signal: new AbortController().signal })
  const captured = JSON.parse(logs[0])
  assert.equal(captured.env.MAX_THINKING_TOKENS, '0')
  assert.equal(captured.env.CLAUDE_CODE_EFFORT_LEVEL, 'low')
  const triage = await getAdapter('claude').classify({
    cwd: home, env: secureClaudeEnv(root, { CLAUDE_CONFIG_DIR: configDir }), prompt: 'classify', signal: new AbortController().signal,
  })
  const cheap = JSON.parse(triage.text)
  assert.equal(cheap.env.MAX_THINKING_TOKENS, '0')
  assert.equal(cheap.env.CLAUDE_CODE_EFFORT_LEVEL, undefined)
  assert.equal(cheap.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined)
  assert.equal(cheap.argv.includes('--settings'), false)
})

test('persistent Claude startup failure keeps stderr for first send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-session-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  await writeFakeCli(
    binDir,
    'claude',
    "process.stderr.write('Claude Code error: subscription expired\\n')\nprocess.exit(1)\n",
  )
  useFakeCliPath(binDir)

  const logs: string[] = []
  const session = getAdapter('claude').startSession?.({
    home,
    env: secureClaudeEnv(root),
    model: null,
    fastModel: null,
    onLog: (line) => logs.push(line),
  })

  assert.ok(session)
  await delay(50)
  const result = await session.send('wake')

  assert.equal(result.exitCode, 1)
  assert.match(result.error ?? '', /subscription expired/i)
  // The engine's stderr passes through verbatim, followed by the session-death
  // trace (die() now ALWAYS logs a process death — idle deaths used to be
  // silent, which made fleet-wide session disappearances undiagnosable).
  assert.equal(logs[0], 'Claude Code error: subscription expired')
  assert.equal(logs.length, 2)
  assert.match(logs[1] ?? '', /\[session\] engine process died .*exit 1/)
  })

test('grok adapter seeds AGENTS.md and reports sessionId from stream-json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-engine-grok-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)
  const grokEvents = [
    { type: 'system', subtype: 'init', session_id: 'sess-grok-1', model: 'grok-4.6' },
    { type: 'result', subtype: 'success', session_id: 'sess-grok-1', usage: { input_tokens: 3, output_tokens: 1 }, result: 'OK' },
  ]
  await writeFakeCli(
    binDir,
    'grok',
    `process.stdout.write(${JSON.stringify(`${grokEvents.map((event) => JSON.stringify(event)).join('\n')}\n`)})\n`,
  )
  useFakeCliPath(binDir)

  const adapter = getAdapter('grok')
  await adapter.seedHome(home, { id: 'iris', name: 'Iris', role: 'Designer', systemPrompt: null })
  const agentsMd = await readFile(join(home, 'AGENTS.md'), 'utf8')
  assert.match(agentsMd, /Iris/)

  const result = await adapter.run({
    home,
    prompt: 'wake',
    env: secureClaudeEnv(root),
    model: null,
    fastModel: null,
    onLog: () => { /* unused */ },
    signal: new AbortController().signal,
  })

  assert.equal(result.exitCode, 0)
  assert.equal(result.sessionId, 'sess-grok-1')
  assert.equal(result.model, 'grok-4.6')
})

  // Regression: nvm-windows on Windows ships an extensionless POSIX shell-shim
  // (`#!/bin/sh` wrapper) alongside the real `.cmd`. The OLD resolveSpawn iterated
  // `['', ...PATHEXT]` → matched the shim first → returned `shell:false` → Node
  // could not exec the shim and every BYOA turn died with ENOENT.
  // See https://github.com/yetone/cumora/issues/5
  test('resolveSpawn prefers .cmd over extensionless shim on Windows', { skip: !IS_WIN }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'cumora-resolve-'))
    tempDirs.push(root)
    const binDir = join(root, 'bin')
    await mkdir(binDir)
    // Both files exist — mirrors the standard nvm-windows layout.
    await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n', 'utf8')
    await writeFile(join(binDir, 'claude.cmd'), '@echo off\nexit /b 0\n', 'utf8')
    process.env.PATH = `${binDir};${process.env.PATH ?? ''}`
    const r = resolveSpawn('claude')
    // NTFS is case-insensitive, and Windows resolves `claude.cmd` as `claude.CMD`
    // — compare with a normalized basename so the test passes regardless of FS.
    assert.equal(
      r.command.toLowerCase().endsWith('claude.cmd'),
      true,
      `must pick the .cmd, not the shim — got ${r.command}`,
    )
    assert.equal(r.shell, true, '.cmd must run via the shell')
    assert.equal(r.wantsStdinPrompt, true, '.cmd needs the big prompt via stdin')
  })

test('resolveSpawn runs a native Windows executable without cmd.exe', { skip: !IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-resolve-exe-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  await mkdir(binDir)
  await writeFile(join(binDir, 'codex.exe'), '', 'utf8')
  process.env.PATH = `${binDir};${ORIGINAL_PATH ?? ''}`
  process.env.PATHEXT = '.EXE;.CMD;.BAT;.COM'

  const r = resolveSpawn('codex')

  assert.equal(r.command.toLowerCase().endsWith('codex.exe'), true)
  assert.equal(r.shell, false, 'native executables must bypass cmd.exe argument parsing')
  assert.equal(r.wantsStdinPrompt, false)
})

test('Codex one-shot paths send prompts through stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-stdin-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir)
  await mkdir(home)

  const capture = join(binDir, 'capture.js')
  const captureSource = "let stdin = ''\n" +
    "process.stdin.setEncoding('utf8')\n" +
    "process.stdin.on('data', (chunk) => { stdin += chunk })\n" +
    "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin })))\n"
  await writeFile(capture, captureSource, 'utf8')
  if (IS_WIN) {
    // Mirror npm's standard layout. Cumora must invoke this JS entry point
    // directly so cmd.exe cannot strip quotes from structured TOML -c values.
    const packageBin = join(binDir, 'node_modules', '@openai', 'codex', 'bin')
    await mkdir(packageBin, { recursive: true })
    await writeFile(join(packageBin, 'codex.js'), captureSource, 'utf8')
    await writeFile(join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0capture.js" %*\r\n', 'utf8')
  } else {
    const launcher = join(binDir, 'codex')
    await writeFile(launcher, '#!/bin/sh\nexec node "$(dirname "$0")/capture.js" "$@"\n', 'utf8')
    await chmod(launcher, 0o755)
  }
  process.env.PATH = `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`

  const adapter = getAdapter('codex')
  const mcpShim = join(root, 'trusted', 'cumora-mcp')
  const longPrompt = `line one with spaces & shell characters\n${'x'.repeat(12_000)}`
  const logs: string[] = []
  const run = await adapter.run({
    home,
    prompt: longPrompt,
    env: {
      ...process.env,
      OPENAI_API_KEY: 'must-not-reach-tools',
      CUMORA_AGENT_IPC_DIR: join(root, 'private-ipc'),
      CUMORA_AGENT_MCP_SHIM: mcpShim,
    },
    model: 'test-model',
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })
  assert.equal(run.exitCode, 0)
  const runCapture = JSON.parse(logs.at(-1) ?? '{}') as { argv?: string[]; stdin?: string }
  assert.ok(runCapture.argv?.includes('default_permissions="cumora"'))
  assert.ok(runCapture.argv?.includes('permissions.cumora.network.enabled=false'))
  if (IS_WIN) assert.ok(runCapture.argv?.includes('windows.sandbox="elevated"'))
  assert.ok(runCapture.argv?.includes('shell_environment_policy.inherit="none"'))
  assert.equal(runCapture.argv?.some((arg) => arg.includes(`${join(root, 'private-ipc', 'requests')}"="write`)), false)
  assert.equal(runCapture.argv?.some((arg) => arg.includes(`${join(root, 'private-ipc', 'responses')}"="write`)), false)
  assert.ok(runCapture.argv?.includes('web_search="disabled"'))
  assert.ok(runCapture.argv?.includes('features.hooks=false'))
  // Assert the INTENT — this home is marked untrusted — not one spelling of it.
  // The dotted `projects."<home>".trust_level=…` form used to be here and had
  // to change because Codex 0.150/0.151 refuses to start on it under
  // --strict-config (#144); pinning the exact string is what would make the
  // next necessary rewrite look like a regression.
  const trustArg = runCapture.argv?.find((arg) => arg.startsWith('projects='))
  assert.ok(trustArg, `no projects override in argv: ${JSON.stringify(runCapture.argv)}`)
  assert.ok(trustArg.includes(JSON.stringify(home)), 'the override must name this agent home')
  assert.ok(trustArg.includes('trust_level="untrusted"'), 'the agent home must be untrusted')
  assert.equal(
    runCapture.argv?.some((arg) => arg.startsWith('projects.')), false,
    'the dotted form is rejected on POSIX by every codex version measured, 0.152.0 included',
  )
  assert.ok(runCapture.argv?.some((arg) =>
    arg.startsWith('mcp_servers.cumora={')
      && arg.includes(`command=${JSON.stringify(process.execPath)}`)
      && arg.includes(`args=[${JSON.stringify(mcpShim)}]`)
      && arg.includes(`CUMORA_AGENT_IPC_DIR=${JSON.stringify(join(root, 'private-ipc'))}`)
      && arg.includes('enabled_tools=["cli"]')
      && arg.includes('required=true'),
  ))
  assert.ok(runCapture.argv?.includes('exec'))
  assert.ok(runCapture.argv?.includes('--ignore-user-config'))
  assert.ok(runCapture.argv?.includes('--ignore-rules'))
  assert.ok(runCapture.argv?.includes('--model'))
  assert.ok(runCapture.argv?.includes('test-model'))
  assert.ok(runCapture.argv?.includes('--skip-git-repo-check'))
  assert.equal(runCapture.argv?.at(-1), '-')
  assert.equal(runCapture.argv?.some((arg) => arg.includes('dangerously')), false)
  assert.equal(runCapture.argv?.some((arg) => arg.includes('must-not-reach-tools')), false)
  assert.equal(runCapture.stdin, longPrompt)

  const triagePrompt = 'triage prompt with spaces\nand a second line'
  const triage = await adapter.classify({
    cwd: home,
    prompt: triagePrompt,
    env: { ...process.env },
    model: 'triage-model',
    signal: new AbortController().signal,
  })
  const triageCapture = JSON.parse(triage.text) as { argv?: string[]; stdin?: string }
  assert.ok(triageCapture.argv?.includes('permissions.cumora.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}'))
  assert.equal(triageCapture.argv?.some((arg) => arg.startsWith('mcp_servers.cumora=')), false)
  assert.ok(triageCapture.argv?.includes('--ignore-user-config'))
  assert.ok(triageCapture.argv?.includes('triage-model'))
  assert.equal(triageCapture.argv?.at(-1), '-')
  assert.equal(triageCapture.stdin, triagePrompt)

  const probe = await adapter.probe({
    tier: 'big',
    cwd: home,
    env: { ...process.env },
    signal: new AbortController().signal,
  })
  const probeCapture = JSON.parse(probe.text) as { argv?: string[]; stdin?: string }
  assert.ok(probeCapture.argv?.includes('permissions.cumora.network.enabled=false'))
  assert.ok(probeCapture.argv?.includes('--ignore-user-config'))
  assert.equal(probeCapture.argv?.at(-1), '-')
  assert.equal(probeCapture.stdin, 'Connectivity check. Reply with exactly: OK')
})

// ── Codex app-server handshake failures must kill the SESSION ────────────────
// The handshake is one-shot: threadReq is consumed at the initialize ack, and
// only a failed thread/resume re-issues a thread/start. So if the thread never
// opens, `ready` can never flip — and because the app-server SURVIVES rejecting
// the handshake, the session would keep reporting alive and the daemon would
// reuse it, parking every later prompt in queuedPrompt with nothing able to
// drain it. That is a permanently, silently dead agent.

/** A fake `codex app-server --listen stdio://`: acks `initialize`, then rejects
 *  whatever thread request follows, and STAYS ALIVE — the condition that makes
 *  the zombie possible. */
async function fakeCodexRejectingThread(root: string): Promise<string> {
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const bin = join(binDir, 'codex')
  await writeFile(
    bin,
    '#!/usr/bin/env node\n' +
    "let buf = ''\n" +
    "process.stdin.on('data', (d) => {\n" +
    "  buf += d.toString('utf8')\n" +
    "  let nl\n" +
    "  while ((nl = buf.indexOf('\\n')) >= 0) {\n" +
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)\n' +
    '    if (!line.trim()) continue\n' +
    '    let msg; try { msg = JSON.parse(line) } catch { continue }\n' +
    "    if (msg.method === 'initialize') {\n" +
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')\n" +
    "    } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {\n" +
    "      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'unsupported model for this account' } }) + '\\n')\n" +
    '    }\n' +
    '  }\n' +
    '})\n' +
    // Never exit on our own: the whole point is an app-server that outlives a
    // rejected handshake.
    'setInterval(() => {}, 1 << 30)\n',
    'utf8',
  )
  await chmod(bin, 0o755)
  return binDir
}

async function startFakeCodexSession(opts: { resume?: string } = {}) {
  process.env.CUMORA_BYOA_ALLOW_UNSANDBOXED = '1'
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const binDir = await fakeCodexRejectingThread(root)
  const logs: string[] = []
  const session = getAdapter('codex').startSession!({
    home,
    env: secureClaudeEnv(root, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
    resumeSessionId: opts.resume ?? null,
    onLog: (l) => logs.push(l),
  })
  assert.ok(session, 'codex adapter must start a persistent session on this platform')
  liveSessions.push(session!)
  return { session: session!, logs }
}

test('a Codex session whose thread never opens dies instead of wedging', { skip: IS_WIN }, async () => {
  const { session } = await startFakeCodexSession()

  const first = await session.send('first wake')
  assert.notEqual(first.exitCode, 0, 'the rejected handshake must fail the turn')
  assert.match(String(first.error), /unsupported model for this account/)

  // The session must NOT advertise itself as reusable: the daemon drops a
  // !alive session and spawns a clean one on the next wake.
  assert.equal(session.alive, false, 'a session that can never open a thread must not stay alive')

  // And a send() that still lands on it has to settle, not hang forever.
  const second = await Promise.race([
    session.send('second wake'),
    delay(1000).then(() => 'HUNG' as const),
  ])
  assert.notEqual(second, 'HUNG', 'a later turn must settle rather than park forever in queuedPrompt')
  assert.notEqual((second as { exitCode: number }).exitCode, 0)
  assert.match(String((second as { error?: string }).error), /unsupported model for this account/,
    'the later turn should report the real handshake cause')
})

test('a Codex session whose resume fallback also fails dies instead of wedging', { skip: IS_WIN }, async () => {
  // thread/resume is rejected, the adapter retries with a fresh thread/start,
  // and that is rejected too — the second failure must still tear down.
  const { session } = await startFakeCodexSession({ resume: 'thread_stale' })

  const first = await session.send('first wake')
  assert.notEqual(first.exitCode, 0)
  assert.equal(session.alive, false, 'a failed resume AND failed fresh start must not leave a live zombie')

  const second = await Promise.race([
    session.send('second wake'),
    delay(1000).then(() => 'HUNG' as const),
  ])
  assert.notEqual(second, 'HUNG', 'a later turn must settle rather than park forever')
})

// ── stream-json events split across pipe reads ──────────────────────────────
// A pipe read chops stdout at an arbitrary byte offset, so a long event arrives
// as two 'data' chunks. Parsing each chunk in isolation threw away both halves,
// and the swallow-partial-lines catch made it silent: no ledger row, and the
// turn's authoritative usage/model/session id lost.

test('a stream-json event split across pipe chunks is still parsed', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-chunk-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)

  // One assistant event padded far past any pipe buffer, then the terminating
  // result. Emitted with NO trailing newline on the last line, which is how the
  // engines actually finish.
  const fake = join(binDir, 'claude')
  await writeFile(
    fake,
    '#!/usr/bin/env node\n' +
    "const big = 'z'.repeat(400000)\n" +
    "const assistant = { type: 'assistant', session_id: 'sess-chunked', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 11, output_tokens: 7 }, content: [{ type: 'text', text: big }] } }\n" +
    "const result = { type: 'result', session_id: 'sess-chunked', usage: { input_tokens: 11, output_tokens: 7 }, model: 'claude-sonnet-4-6' }\n" +
    "process.stdout.write(JSON.stringify(assistant) + '\\n')\n" +
    "process.stdout.write(JSON.stringify(result))\n",
    'utf8',
  )
  await chmod(fake, 0o755)

  const hops: Array<{ model: string }> = []
  const r = await getAdapter('claude').run({
    home,
    prompt: 'go',
    env: secureClaudeEnv(dirname(home), { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
    onLog: () => {},
    onHopUsage: (h) => hops.push({ model: h.model }),
    signal: new AbortController().signal,
  })

  assert.equal(r.exitCode, 0)
  assert.equal(r.sessionId, 'sess-chunked', 'session id must survive a chunk split (else no --resume next wake)')
  assert.equal(r.usage?.output_tokens, 7, "the result event's usage must survive")
  assert.equal(r.model, 'claude-sonnet-4-6')
  assert.equal(hops.length, 1, 'the assistant hop must reach the trajectory ledger exactly once')
})

test('a multi-byte character split across pipe chunks is not corrupted', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-utf8-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)

  // Pad so the event is long enough to be chopped, and fill it with multi-byte
  // characters so a boundary is very likely to land mid-codepoint.
  const fake = join(binDir, 'claude')
  await writeFile(
    fake,
    '#!/usr/bin/env node\n' +
    "const big = '中'.repeat(150000)\n" +
    "const ev = { type: 'result', session_id: 'sess-utf8', usage: { input_tokens: 1, output_tokens: 2 }, model: 'm', note: big }\n" +
    "process.stdout.write(JSON.stringify(ev) + '\\n')\n",
    'utf8',
  )
  await chmod(fake, 0o755)

  const r = await getAdapter('claude').run({
    home,
    prompt: 'go',
    env: secureClaudeEnv(root, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
    onLog: () => {},
    signal: new AbortController().signal,
  })

  assert.equal(r.sessionId, 'sess-utf8', 'a codepoint split mid-boundary must not corrupt the JSON')
  assert.equal(r.usage?.output_tokens, 2)
})

// ── one-shot engine children must die with their runner ─────────────────────
// The persistent session is torn down by AgentRunner.stop(); the one-shot child
// was not, because its AbortSignal came from a controller nothing ever aborted.
// An orphan keeps the `cumora` IPC shim on PATH, so it can go on posting AS the
// agent while the replacement runner answers the same
// messages — with the OLD persona the operator just changed.

/** A fake engine shaped like a real one: it spawns a child that INHERITS its
 *  stdio and outlives it, the way `claude` does for every Bash tool command.
 *  That grandchild holds the stdout/stderr pipes open, so `close` may never fire
 *  after the engine is killed — which is why the abort path must settle on
 *  `exit`. Written in Node rather than shell so the process tree is identical on
 *  every platform (bash execs the last command, dash forks it). */
async function fakeEngineWithLingeringChild(root: string): Promise<string> {
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const bin = join(binDir, 'claude')
  await writeFile(
    bin,
    '#!/usr/bin/env node\n' +
    "require('child_process').spawn('sleep', ['120'], { stdio: 'inherit' })\n" +
    'setTimeout(() => {}, 120000)\n',
    'utf8',
  )
  await chmod(bin, 0o755)
  return binDir
}

async function runFakeEngine(binDir: string, home: string, signal: AbortSignal) {
  return getAdapter('claude').run({
    home,
    prompt: 'go',
    env: secureClaudeEnv(dirname(home), { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
    onLog: () => {},
    signal,
  })
}

test('an already-aborted signal kills the engine child immediately', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-abort-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  const binDir = await fakeEngineWithLingeringChild(root)

  // The queued-turn case: the signal is ALREADY aborted by the time run() is
  // reached, so a listener registered afterwards would never fire.
  const ac = new AbortController()
  ac.abort()

  const r = await Promise.race([
    runFakeEngine(binDir, home, ac.signal),
    delay(15_000, 'ORPHANED' as const, { ref: false }),
  ])
  assert.notEqual(r, 'ORPHANED', 'the child outlived its aborted signal — it would keep posting as the agent')
  assert.notEqual((r as { exitCode: number }).exitCode, 0, 'a killed turn must not report success')
})

test('aborting mid-run kills the engine child', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-abort2-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  const binDir = await fakeEngineWithLingeringChild(root)

  const ac = new AbortController()
  const p = runFakeEngine(binDir, home, ac.signal)
  await delay(150)
  ac.abort()
  const r = await Promise.race([p, delay(15_000, 'ORPHANED' as const, { ref: false })])
  assert.notEqual(r, 'ORPHANED', 'abort must terminate the turn even when a grandchild holds the stdio pipes')
  assert.notEqual((r as { exitCode: number }).exitCode, 0)
})

test('aborting kills a descendant that detached into its own process group', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-abort-detached-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  const binDir = join(root, 'bin')
  const pidFile = join(root, 'detached.pid')
  await mkdir(home)
  await mkdir(binDir)
  const fake = join(binDir, 'claude')
  await writeFile(
    fake,
    '#!/usr/bin/env node\n' +
    "const { spawn } = require('node:child_process')\n" +
    "const { writeFileSync } = require('node:fs')\n" +
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 120000)'], { detached: true, stdio: 'ignore' })\n" +
    "writeFileSync(process.env.FAKE_DETACHED_PID_FILE, String(child.pid))\n" +
    'setTimeout(() => {}, 120000)\n',
    'utf8',
  )
  await chmod(fake, 0o755)

  const ac = new AbortController()
  const run = getAdapter('claude').run({
    home,
    prompt: 'go',
    env: secureClaudeEnv(root, {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_DETACHED_PID_FILE: pidFile,
    }),
    onLog: () => {},
    signal: ac.signal,
  })
  let detachedPid = 0
  try {
    for (let i = 0; i < 100 && detachedPid === 0; i += 1) {
      try { detachedPid = Number((await readFile(pidFile, 'utf8')).trim()) }
      catch { await delay(20) }
    }
    assert.ok(detachedPid > 0, 'fake engine must expose its detached child pid')
    ac.abort()
    const result = await Promise.race([run, delay(15_000, 'ORPHANED' as const, { ref: false })])
    assert.notEqual(result, 'ORPHANED')

    assert.throws(
      () => process.kill(detachedPid, 0),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ESRCH',
      'run() must not resolve until a setsid-style descendant is gone',
    )
  } finally {
    if (detachedPid > 0) {
      try { process.kill(detachedPid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
})

test('a normal run is unaffected by the abort wiring', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-noabort-'))
  tempDirs.push(root)
  const binDir = join(root, 'bin')
  const home = join(root, 'home')
  await mkdir(binDir); await mkdir(home)
  const fake = join(binDir, 'claude')
  await writeFile(fake, '#!/bin/sh\necho ok\nexit 0\n', 'utf8')
  await chmod(fake, 0o755)

  const r = await getAdapter('claude').run({
    home,
    prompt: 'go',
    env: secureClaudeEnv(root, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
    onLog: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(r.exitCode, 0)
})

// ── Grok ACP session: the ledger must see the REAL model ─────────────────────
// `opts.model` is only the pin Cumora asked for, and it is null whenever the
// operator left the model unpinned — the default. Reporting the engine id
// ('grok') in its place puts a model that does not exist into llm_calls, and
// prices the turn on a fallback rate. Grok announces the live model over ACP.

/** A fake `grok agent … stdio`: ACP handshake, a models/update notification,
 *  then one prompt result carrying usage. */
async function fakeGrokAcp(root: string, opts: { announceModel?: string } = {}): Promise<string> {
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  const announce = opts.announceModel
    ? `if (msg.method === 'initialize') send({ jsonrpc: '2.0', method: '_x.ai/models/update', params: { currentModelId: ${JSON.stringify(opts.announceModel)} } })\n`
    : ''
  await writeFile(
    join(binDir, 'grok'),
    '#!/usr/bin/env node\n' +
    "let buf = ''\n" +
    "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')\n" +
    "process.stdin.on('data', (d) => {\n" +
    "  buf += d.toString('utf8')\n" +
    '  let nl\n' +
    "  while ((nl = buf.indexOf('\\n')) >= 0) {\n" +
    '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)\n' +
    '    if (!line.trim()) continue\n' +
    '    let msg; try { msg = JSON.parse(line) } catch { continue }\n' +
    announce +
    "    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } })\n" +
    "    else if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-acp-1' } })\n" +
    "    else if (msg.method === 'session/prompt') send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } } })\n" +
    '  }\n' +
    '})\n' +
    'setInterval(() => {}, 1 << 30)\n',
    'utf8',
  )
  await chmod(join(binDir, 'grok'), 0o755)
  return binDir
}

async function grokAcpTurn(binDir: string, home: string) {
  const hops: EngineHopReport[] = []
  const session = getAdapter('grok').startSession!({
    home,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    onLog: () => {},
    onHopUsage: (h) => hops.push(h),
  })
  assert.ok(session, 'grok must start an ACP session on this platform')
  liveSessions.push(session!)
  const result = await Promise.race([
    session!.send('go'),
    delay(15_000).then(() => 'TIMEOUT' as const),
  ])
  assert.notEqual(result, 'TIMEOUT', 'the ACP turn never settled')
  return { result: result as EngineRunResult, hops }
}

test('a Grok ACP turn reports the model the engine announced', { skip: IS_WIN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cumora-grok-acp-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  // No model pinned — the default, and exactly when the old code fell back to
  // the engine id.
  const binDir = await fakeGrokAcp(root, { announceModel: 'grok-4.6' })
  const { result, hops } = await grokAcpTurn(binDir, home)

  assert.equal(result.exitCode, 0)
  assert.equal(result.model, 'grok-4.6', 'the turn must be priced on the real model, not left null')
  assert.equal(hops.length, 1)
  assert.equal(hops[0].model, 'grok-4.6', 'the ledger hop must name a real model, not the engine id')
  assert.equal(hops[0].usage.output_tokens, 4)
})

test('a Grok ACP turn still settles when no model is announced', { skip: IS_WIN }, async () => {
  // Older CLI, or a build that drops the notification: fall back rather than
  // hang or crash.
  const root = await mkdtemp(join(tmpdir(), 'cumora-grok-acp2-'))
  tempDirs.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  const binDir = await fakeGrokAcp(root)
  const { result, hops } = await grokAcpTurn(binDir, home)

  assert.equal(result.exitCode, 0)
  assert.equal(result.model, null, 'with nothing announced and nothing pinned there is no model to report')
  assert.equal(hops[0].model, 'grok', 'the hop keeps its last-resort label')
})
