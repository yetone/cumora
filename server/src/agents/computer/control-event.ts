/** Wire protocol shared by the API server and the standalone Computer daemon. */
export interface ComputerControlEvent {
  kind: 'engine.detect'
  id: string
  at: number
}

export function parseComputerControlEvent(raw: string): ComputerControlEvent | null {
  try {
    const value = JSON.parse(raw) as Partial<ComputerControlEvent> | null
    if (
      !value
      || value.kind !== 'engine.detect'
      || typeof value.id !== 'string'
      || value.id.length === 0
      || typeof value.at !== 'number'
      || !Number.isFinite(value.at)
    ) return null
    return value as ComputerControlEvent
  } catch {
    return null
  }
}
