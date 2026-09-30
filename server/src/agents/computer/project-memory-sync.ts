/** Event-driven, bounded fetching. Unacknowledged jobs are resent by the server. */
export function createProjectMemorySync(deps: {
  fetchPending(): Promise<Array<{ projectId: string }>>
  cleanup(projectId: string): Promise<void>
  acknowledge(projectId: string): Promise<void>
  onError(error: unknown): void
}) {
  let active: Promise<void> | null = null
  let requested = false
  let stopped = false

  function request(): Promise<void> {
    if (stopped) return Promise.resolve()
    requested = true
    if (active) return active
    active = (async () => {
      try {
        do {
          requested = false
          const batch = await deps.fetchPending()
          for (const job of batch) {
            if (stopped) return
            await deps.cleanup(job.projectId)
            await deps.acknowledge(job.projectId)
          }
          if (batch.length === 50) requested = true
        } while (requested && !stopped)
      } catch (error) {
        deps.onError(error)
      } finally { active = null }
    })()
    return active
  }
  return { request, stop() { stopped = true } }
}
