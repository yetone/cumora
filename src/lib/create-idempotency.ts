export const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000

interface PendingEntry {
  requestId: string
  createdAt: number
}

const pending = new Map<string, PendingEntry>()

function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Reuse the same key after an ambiguous failure within TTL; clear only after success or non-retryable failure. */
export function pendingCreateRequestId(
  scope: string,
  normalizedInput: unknown,
  options?: { ttlMs?: number; now?: number },
): {
  requestId: string
  complete: () => void
  fail: (error?: unknown) => void
} {
  const ttlMs = options?.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS
  const now = options?.now ?? Date.now()
  const key = `${scope}:${JSON.stringify(normalizedInput)}`

  let entry = pending.get(key)
  if (!entry || now - entry.createdAt >= ttlMs) {
    entry = { requestId: randomRequestId(), createdAt: now }
    pending.set(key, entry)
  }

  const currentRequestId = entry.requestId

  return {
    requestId: currentRequestId,
    complete: () => {
      const active = pending.get(key)
      if (active && active.requestId === currentRequestId) pending.delete(key)
    },
    fail: (error?: unknown) => {
      const status =
        typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status: unknown }).status)
          : undefined
      const isClientError = status !== undefined && status >= 400 && status < 500
      if (error === undefined || isClientError) {
        const active = pending.get(key)
        if (active && active.requestId === currentRequestId) pending.delete(key)
      }
    },
  }
}

export function clearPendingCreateRequestId(scope: string, normalizedInput: unknown): void {
  const key = `${scope}:${JSON.stringify(normalizedInput)}`
  pending.delete(key)
}

export function _resetPendingCreateRequestIdsForTests(): void {
  pending.clear()
}

