export interface EngineUpdate {
  id: string
  engine: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error?: string
}

// Covers the updater's ten-minute timeout and the final engine rescan.
export const ENGINE_UPDATE_TTL_SECONDS = 15 * 60
