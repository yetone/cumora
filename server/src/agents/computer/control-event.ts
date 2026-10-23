/** Wire protocol shared by the API server and the standalone Computer daemon. */
export type ComputerControlEvent =
  | { kind: 'engine.detect'; id: string; at: number }
  /** `engine` names what to update; the daemon derives the command itself. */
  | { kind: 'engine.update'; id: string; at: number; engine: string }

const ENGINE_ID = /^[a-z][a-z0-9-]{0,31}$/

export function parseComputerControlEvent(raw: string): ComputerControlEvent | null {
  try {
    const value = JSON.parse(raw) as { kind?: unknown; id?: unknown; at?: unknown; engine?: unknown } | null
    if (!value) return null
    const { kind, id, at } = value
    if (typeof id !== 'string' || !id || typeof at !== 'number' || !Number.isFinite(at)) return null
    if (kind === 'engine.detect') return { kind, id, at }
    const { engine } = value
    // Only a plain engine id crosses the wire: the daemon picks the command, so
    // a payload can never smuggle one in.
    if (kind === 'engine.update' && typeof engine === 'string' && ENGINE_ID.test(engine)) {
      return { kind, id, at, engine }
    }
    return null
  } catch {
    return null
  }
}
