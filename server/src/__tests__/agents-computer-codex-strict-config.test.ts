/**
 * The secure Codex override set has to survive `--strict-config` (#144).
 *
 * Codex 0.150/0.151 refuses a quoted dynamic map key in a dotted `-c` override:
 *
 *   Error loading config.toml: unknown configuration field
 *     `projects."<agent-home>"` in -c/--config override
 *
 * That killed every secure Codex wake before the model ran, and because the
 * undelivered message stays durable the daemon retried the same failure
 * forever. The inline-table form parses on every version anyone has checked.
 *
 * What these can and cannot do: Codex is not installed in CI, so they pin the
 * argv this repo *builds*, not what a particular Codex release accepts. The
 * parse behaviour was checked by hand against 0.134.0 and 0.152.0 locally and
 * by the reporter against 0.150.1 and 0.151.0-alpha. So the value here is
 * catching a regression back to a shape known to break, and pinning the
 * security intent that shape exists to express.
 *
 * Run: node --import tsx --test server/src/__tests__/agents-computer-codex-strict-config.test.ts
 */
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { getAdapter } from '../agents/computer/engine.js'

const IS_WIN = process.platform === 'win32'
const ORIGINAL_PATH = process.env.PATH
const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_USERPROFILE = process.env.USERPROFILE
const tempDirs: string[] = []

afterEach(async () => {
  process.env.PATH = ORIGINAL_PATH
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = ORIGINAL_USERPROFILE
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Echoes its own argv as JSON so the test can read what was built. */
const FAKE_CODEX = `#!/usr/bin/env node
'use strict'
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\\n')
`

interface Fixture { root: string; home: string; env: NodeJS.ProcessEnv }

async function fixture(homeName: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cumora-codex-cfg-'))
  tempDirs.push(root)
  process.env.HOME = root
  process.env.USERPROFILE = root
  const binDir = join(root, 'bin')
  // The reporter asked specifically for a home with ordinary separators and
  // spaces: that is where the quoting in the override has to hold up.
  const home = join(root, homeName)
  await mkdir(binDir)
  await mkdir(home, { recursive: true })
  const fake = join(binDir, 'codex')
  await writeFile(fake, FAKE_CODEX, 'utf8')
  await chmod(fake, 0o755)
  return {
    root, home,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${ORIGINAL_PATH ?? ''}`,
      CUMORA_AGENT_IPC_DIR: join(root, 'ipc'),
      CUMORA_AGENT_MCP_SHIM: join(root, 'shim.mjs'),
    },
  }
}

async function secureArgv(f: Fixture): Promise<string[]> {
  const logs: string[] = []
  await getAdapter('codex').run({
    home: f.home,
    prompt: 'hello',
    env: f.env,
    model: 'test-model',
    fastModel: null,
    onLog: (line) => logs.push(line),
    signal: new AbortController().signal,
  })
  const last = logs.map((l) => l.trim()).filter((l) => l.startsWith('{')).at(-1) ?? '{}'
  return (JSON.parse(last) as { argv?: string[] }).argv ?? []
}

test('the project trust override is an inline table, not a dotted dynamic key', { skip: IS_WIN }, async () => {
  const f = await fixture('agent home')
  const argv = await secureArgv(f)

  const dotted = argv.filter((a) => a.startsWith('projects.'))
  assert.deepEqual(
    dotted, [],
    'a dotted `projects."<home>".…` override is what Codex 0.150/0.151 refuses under --strict-config',
  )
  const inline = argv.find((a) => a.startsWith('projects='))
  assert.ok(inline, `no projects override at all: ${JSON.stringify(argv)}`)
  assert.equal(inline, `projects={${JSON.stringify(f.home)}={trust_level="untrusted"}}`)
})

test('a home containing spaces is still quoted correctly', { skip: IS_WIN }, async () => {
  // The whole reason the key is dynamic: it is a real filesystem path, and the
  // one in the report had spaces in it.
  const f = await fixture('agent home with spaces')
  const argv = await secureArgv(f)
  const inline = argv.find((a) => a.startsWith('projects='))
  assert.ok(inline)
  assert.ok(inline.includes('agent home with spaces'))
  // JSON.stringify is the TOML basic-string escape this builder uses; the point
  // is that the path is quoted at all, so the space cannot split the key.
  assert.ok(inline.includes(`{${JSON.stringify(f.home)}=`), `path not quoted: ${inline}`)
})

test('--strict-config is still on, which is what makes the shape matter', { skip: IS_WIN }, async () => {
  // Without it Codex would tolerate an unrecognised override instead of
  // refusing to start, and this whole class of failure would be invisible
  // rather than fixed.
  const f = await fixture('agent home')
  assert.ok((await secureArgv(f)).includes('--strict-config'))
})

test('the untrusted marking survives alongside the rest of the secure set', { skip: IS_WIN }, async () => {
  // --strict-config validates every override together, so the trust key has to
  // coexist with the permission, feature and environment ones rather than
  // merely be well-formed on its own.
  const f = await fixture('agent home')
  const argv = await secureArgv(f)
  for (const expected of [
    'default_permissions="cumora"',
    'permissions.cumora.network.enabled=false',
    'shell_environment_policy.inherit="none"',
    'web_search="disabled"',
    'features.hooks=false',
  ]) {
    assert.ok(argv.includes(expected), `missing from the secure set: ${expected}`)
  }
  assert.ok(argv.some((a) => a.startsWith('projects=') && a.includes('trust_level="untrusted"')))
})
