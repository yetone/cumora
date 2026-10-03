import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Keep pointers to the isolated runtime separate from pre-upgrade threads.
export const CODEX_SESSION_SCOPE = 'runtime'
export const CODEX_LOGIN_COMMAND = 'cumora agent computer --codex-login'
export const CODEX_MIGRATE_COMMAND = 'cumora agent computer --migrate-codex-sessions'

export function codexRuntimeHome(): string {
  return join(homedir(), '.cumora', 'codex-runtime')
}

/** Only Codex children get this environment; other engines keep their homes. */
export function codexRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = codexRuntimeHome()
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: home }
}
