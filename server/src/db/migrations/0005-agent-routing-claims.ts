import { createHash } from 'node:crypto'

/**
 * Migration 0005: elect one agent for unaddressed human group messages (#123).
 *
 * One row per one-of-us ROUTING ELECTION (#70). When a human group message
 * names nobody and the small-model router elects ONE agent to take the turn
 * instead of waking the room, this row records who was elected (candidates[0]
 * is the primary; the rest is the deterministic fallback order) and holds the
 * lease the sweeper uses to advance to the next candidate when the primary
 * produces no turn.
 */
export const AGENT_ROUTING_CLAIMS_SQL = `
CREATE TABLE IF NOT EXISTS agent_routing_claims (
  message_id          TEXT PRIMARY KEY,
  company_id          TEXT,
  conversation_id     TEXT NOT NULL,
  candidates          TEXT[] NOT NULL,
  cursor              INTEGER NOT NULL DEFAULT 0,
  cursor_advanced_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  status              TEXT NOT NULL DEFAULT 'pending',
  lease_expires_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_routing_claims_sweep
  ON agent_routing_claims(status, lease_expires_at);
`

export function agentRoutingClaimsChecksum(): string {
  return createHash('sha256').update(AGENT_ROUTING_CLAIMS_SQL).digest('hex')
}
