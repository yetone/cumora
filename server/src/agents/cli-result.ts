import type { AttachmentDescriptor } from '../../../shared/attachments.js'

export interface CliSideEffect {
  event: string
  command?: string
  visibleToUser?: boolean
  conversationId?: string
  messageId?: string
  authorId?: string
  companyId?: string
  [key: string]: unknown
}

/** Attachment descriptors discovered by a read command. The runtime HTTP
 *  surface returns these beside the rendered text so a BYOA daemon can cache
 *  the exact files the agent just inspected. They never choose a fetch URL:
 *  the daemon downloads only their validated Cumora storage keys. */
export interface CliAttachmentRead {
  messageId: string
  attachments: readonly AttachmentDescriptor[]
}

export interface CliResult {
  ok: boolean
  text: string
  exitCode: number
  sideEffects?: CliSideEffect[]
  attachmentReads?: CliAttachmentRead[]
}

export interface CliSideEffectsParseResult {
  sideEffects: CliSideEffect[]
  malformedLineCount: number
}

export const CLI_SIDE_EFFECT_WRITE_FAILED_PREFIX = '__CUMORA_CLI_SIDE_EFFECTS_WRITE_FAILED__='

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeCliSideEffects(value: unknown): CliSideEffect[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is CliSideEffect => (
    isRecord(item) && typeof item.event === 'string' && item.event.length > 0
  ))
}

export function cliResultHasReplySideEffect(result: unknown): boolean {
  if (!isRecord(result)) return false
  return normalizeCliSideEffects(result.sideEffects).some((effect) => (
    effect.event === 'message.posted'
    && effect.command === 'reply'
    && effect.visibleToUser !== false
  ))
}

export function cliResultSideEffects(result: unknown): CliSideEffect[] {
  if (!isRecord(result)) return []
  return normalizeCliSideEffects(result.sideEffects)
}

export function cliResultSideEffectChannelUnreliable(result: unknown): boolean {
  if (!isRecord(result)) return false
  return Boolean(
    result.sideEffectsParseFailed ||
    result.sideEffectsReadFailed ||
    result.sideEffectsWriteFailed,
  )
}

export function parseCliSideEffectsJsonlDetailed(raw: string): CliSideEffectsParseResult {
  const effects: CliSideEffect[] = []
  let malformedLineCount = 0
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        effects.push(...normalizeCliSideEffects(parsed))
      } else if (isRecord(parsed)) {
        effects.push(...normalizeCliSideEffects(parsed.sideEffects))
      }
    } catch {
      malformedLineCount += 1
    }
  }
  return { sideEffects: effects, malformedLineCount }
}

export function parseCliSideEffectsJsonl(raw: string): CliSideEffect[] {
  return parseCliSideEffectsJsonlDetailed(raw).sideEffects
}

export function parseCliSideEffectsWriteFailureMarker(raw: string): CliSideEffect[] {
  const effects: CliSideEffect[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(CLI_SIDE_EFFECT_WRITE_FAILED_PREFIX)) continue
    try {
      effects.push(...normalizeCliSideEffects(
        JSON.parse(trimmed.slice(CLI_SIDE_EFFECT_WRITE_FAILED_PREFIX.length)) as unknown,
      ))
    } catch {
      // Keep ordinary stderr visible; malformed diagnostics just mean we
      // cannot recover the side-effect payload from this fallback channel.
    }
  }
  return effects
}

export async function writeCliSideEffectsToResultPath(result: CliResult): Promise<void> {
  const path = process.env.CUMORA_CLI_RESULT_PATH
  const sideEffects = normalizeCliSideEffects(result.sideEffects)
  if (!path || sideEffects.length === 0) return
  const { appendFile } = await import('node:fs/promises')
  await appendFile(path, JSON.stringify({ sideEffects }) + '\n', 'utf8').catch((err) => {
    // Preserve side effects over stderr so the runtime can avoid duplicate
    // assistant-text relay even when the primary JSONL channel is unavailable.
    process.stderr.write(`${CLI_SIDE_EFFECT_WRITE_FAILED_PREFIX}${JSON.stringify(sideEffects)}\n`)
    throw err
  })
}
