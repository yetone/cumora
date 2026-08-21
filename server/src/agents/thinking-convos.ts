/**
 * Reverse index for "which conversations is this agent currently
 * thinking in?". `markThinking` writes a per-conversation ZSET so
 * *peers* can glance; memory writes need the inverse — stamp
 * provenance without the agent passing `--in` every time.
 *
 * Fail-open: a Redis miss returns [] and the write stays GLOBAL.
 */
import { redis } from '../redis.js'

export function agentThinkingConvosKey(agentId: string): string {
  return `cumora:agent-thinking-convos:${agentId}`
}

export async function recordThinkingConversations(
  agentId: string,
  conversationIds: string[],
  ttlSec: number,
): Promise<void> {
  if (conversationIds.length === 0) return
  try {
    await redis.set(
      agentThinkingConvosKey(agentId),
      JSON.stringify(conversationIds),
      'EX',
      Math.max(ttlSec + 30, 90),
    )
  } catch {
    /* fail-open — writers will stamp global provenance */
  }
}

export async function clearThinkingConversations(agentId: string): Promise<void> {
  try {
    await redis.del(agentThinkingConvosKey(agentId))
  } catch { /* fail-open */ }
}

export async function getThinkingConversations(agentId: string): Promise<string[]> {
  try {
    const raw = await redis.get(agentThinkingConvosKey(agentId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}
