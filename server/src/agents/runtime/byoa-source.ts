/** Sources a BYOA daemon is allowed to attribute to local model calls. Keep
 * this one whitelist shared by the triage and per-hop ledger endpoints. */
export const BYOA_SOURCES = [
  'byoa-claude',
  'byoa-codex',
  'byoa-grok',
  'byoa-cursor',
  'byoa-opencode',
  'byoa-pi',
  'byoa-gemini',
  'byoa-qwen',
] as const

export type ByoaSource = typeof BYOA_SOURCES[number]

const BYOA_SOURCE_SET = new Set<string>(BYOA_SOURCES)

export function normalizeByoaSource(value: unknown): ByoaSource {
  return typeof value === 'string' && BYOA_SOURCE_SET.has(value)
    ? value as ByoaSource
    : 'byoa-claude'
}
