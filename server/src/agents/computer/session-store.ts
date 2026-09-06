import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { EngineId } from './engine.js'

export function sessionIdPreview(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** Engine-owned pointer to the engine's real transcript/session storage.
 *
 * Cumora deliberately stores only the opaque id. The engine owns the actual
 * transcript and is the only component allowed to interpret the id. Binding a
 * store instance to one EngineId makes cross-engine resume impossible by
 * construction while retaining each engine's continuity across fallback.
 */
export class EngineSessionStore {
  readonly sessionFile: string
  readonly engine: EngineId

  private readonly legacyFile: string
  private writes: Promise<void> = Promise.resolve()

  constructor(
    sessionsDir: string,
    private readonly agentId: string,
    engine: EngineId,
  ) {
    this.engine = engine
    this.sessionFile = join(sessionsDir, agentId, `${engine}.session`)
    this.legacyFile = join(sessionsDir, `${agentId}.session`)
  }

  async load(): Promise<string | null> {
    try {
      return (await readFile(this.sessionFile, 'utf8')).trim() || null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[computer] ${this.agentId} could not load ${this.engine} session:`, err instanceof Error ? err.message : err)
      }
      return null
    }
  }

  /** Queue a snapshot of the requested value. Each operation absorbs its own
   * failure so a single filesystem error cannot poison all later saves. */
  save(sessionId: string | null): Promise<void> {
    const snapshot = sessionId
    this.writes = this.writes.then(async () => {
      try {
        if (snapshot) await this.atomicWrite(snapshot)
        else await rm(this.sessionFile, { force: true })
      } catch (err) {
        console.warn(`[computer] ${this.agentId} could not persist ${this.engine} session:`, err instanceof Error ? err.message : err)
      }
    })
    return this.writes
  }

  /** Move the old engine-agnostic pointer aside. Its ownership cannot be
   * established safely, so it must never be offered to any engine. */
  async quarantineLegacy(): Promise<boolean> {
    try {
      const info = await lstat(this.legacyFile)
      if (!info.isFile()) {
        console.warn(`[computer] ${this.agentId} ignored legacy unscoped session because it is not a regular file`)
        return false
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const quarantined = `${this.legacyFile}.legacy-unscoped-${stamp}-${randomUUID()}`
      await rename(this.legacyFile, quarantined)
      console.warn(`[computer] ${this.agentId} quarantined legacy unscoped session — engine ownership cannot be verified; ${this.engine} will start fresh unless it has an engine-scoped session`)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      console.warn(`[computer] ${this.agentId} could not quarantine legacy unscoped session; it will be ignored:`, err instanceof Error ? err.message : err)
      return false
    }
  }

  async flush(): Promise<void> {
    await this.writes
  }

  private async atomicWrite(sessionId: string): Promise<void> {
    await mkdir(dirname(this.sessionFile), { recursive: true })
    const temporary = `${this.sessionFile}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${sessionId}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.sessionFile)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
}
