import { createHash } from 'node:crypto'

export const COMPUTER_UNSANDBOXED_MODE_SQL = `
ALTER TABLE computers
  ADD COLUMN unsandboxed_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN unsandboxed_active BOOLEAN NOT NULL DEFAULT false;
`

export function computerUnsandboxedModeChecksum(): string {
  return createHash('sha256').update(COMPUTER_UNSANDBOXED_MODE_SQL).digest('hex')
}
