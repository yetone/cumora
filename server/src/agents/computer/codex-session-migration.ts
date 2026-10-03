import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { CODEX_SESSION_SCOPE, codexRuntimeHome } from './codex-runtime.js'
import { EngineSessionStore } from './session-store.js'

async function entries(path: string): Promise<string[]> {
  try { return await readdir(path, { recursive: true }) }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function rolloutId(path: string): Promise<string | undefined> {
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const metadata = JSON.parse(line)
      return metadata.type === 'session_meta' ? metadata.payload?.id : undefined
    }
  } finally {
    lines.close()
    input.destroy()
  }
}

/** Copy an agent's referenced rollout before switching its session pointer.
 * No legacy pointer means there is nothing to migrate (including new users). */
export async function migrateCodexSession(
  agentId: string,
  sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  sessionsDir = join(homedir(), '.cumora', 'sessions'),
  destinationHome = codexRuntimeHome(),
): Promise<boolean> {
  const legacy = join(sessionsDir, agentId, 'codex.session')
  if (!existsSync(legacy)) return false
  const store = new EngineSessionStore(sessionsDir, agentId, 'codex', CODEX_SESSION_SCOPE)
  if (existsSync(store.sessionFile)) {
    await rename(legacy, `${legacy}.migrated`)
    return false // Never overwrite a newer session.
  }
  const id = (await readFile(legacy, 'utf8')).trim()
  if (!id) {
    await rename(legacy, `${legacy}.migrated`)
    return false
  }
  const rollouts = (await entries(join(sourceHome, 'sessions')))
    .filter(path => path.endsWith('.jsonl'))
  const rollout = rollouts.find(path => basename(path).endsWith(`-${id}.jsonl`))
  const source = rollout && join(sourceHome, 'sessions', rollout)
  if (!source || await rolloutId(source) !== id) {
    throw new Error(`Cannot migrate Codex thread ${id} for ${agentId}: its rollout is unavailable in ${sourceHome}. The old session pointer has been preserved.`)
  }
  const destination = join(destinationHome, 'sessions', rollout!)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await copyFile(source, destination)
  // Unlike ordinary best-effort session saves, migration must report a failed
  // pointer write so this agent cannot start with silently discarded context.
  const temporary = `${store.sessionFile}.migrating`
  await writeFile(temporary, `${id}\n`, { mode: 0o600 })
  await rename(temporary, store.sessionFile)
  await rename(legacy, `${legacy}.migrated`)
  return true
}

/** Manual retry for all saved agents. Daemon startup migrates them individually
 * so one unavailable rollout cannot stop other agents from being hosted. */
export async function migrateCodexSessions(
  sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  sessionsDir = join(homedir(), '.cumora', 'sessions'),
  destinationHome = codexRuntimeHome(),
): Promise<string[]> {
  const pointers = (await entries(sessionsDir))
    .filter(path => basename(path) === 'codex.session')
  const migrated: string[] = []
  for (const pointer of pointers) {
    const agentId = basename(dirname(pointer))
    if (await migrateCodexSession(agentId, sourceHome, sessionsDir, destinationHome)) migrated.push(agentId)
  }
  return migrated
}
