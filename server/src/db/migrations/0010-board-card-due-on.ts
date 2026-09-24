import { createHash } from 'node:crypto'

/** A due date is a calendar day, with no implied time or notification. */
export const BOARD_CARD_DUE_ON_SQL = `
ALTER TABLE board_cards ADD COLUMN IF NOT EXISTS due_on DATE;
`

export const BOARD_CARD_DUE_ON_INDEX_NAME = 'idx_board_cards_due_on'
export const BOARD_CARD_DUE_ON_INDEX_SQL = `
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${BOARD_CARD_DUE_ON_INDEX_NAME}
  ON board_cards(board_id, due_on) WHERE due_on IS NOT NULL;
`

export function boardCardDueOnChecksum(): string {
  return createHash('sha256').update(BOARD_CARD_DUE_ON_SQL + BOARD_CARD_DUE_ON_INDEX_SQL).digest('hex')
}
