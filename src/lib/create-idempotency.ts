const pending = new Map<string, string>()

function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Reuse the same key after an ambiguous failure; clear only after success. */
export function pendingCreateRequestId(scope: string, normalizedInput: unknown): {
  requestId: string
  complete: () => void
} {
  const key = `${scope}:${JSON.stringify(normalizedInput)}`
  let requestId = pending.get(key)
  if (!requestId) {
    requestId = randomRequestId()
    pending.set(key, requestId)
  }
  return {
    requestId,
    complete: () => {
      if (pending.get(key) === requestId) pending.delete(key)
    },
  }
}
