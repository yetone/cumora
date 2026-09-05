/**
 * A `message.new` event must land a sidebar row exactly where a refetch would.
 *
 * Every new message used to trigger a full `GET /conversations` — per online
 * client, per message, each one recomputing the last message and unread count
 * for every conversation in the workspace. The event already carries the
 * message, so the row is now patched in place. That is only safe if the patch
 * and the fetch agree, and these are the two places where they could drift:
 * the shape the WS payload is narrowed to, and the order the row lands in.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ApiMessage } from '../src/api/client'
import type { Conversation } from '../src/types'
import { bySidebarOrder, lastMessageFromWs, timeFromIso } from '../src/lib/conversationRow'

function wsMessage(over: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id: 'm-1',
    conversationId: 'g-1',
    authorId: 'u-ada',
    kind: 'text',
    body: 'hello',
    at: '2026-03-01T10:00:00.000Z',
    sequence: 7,
    ...over,
  } as ApiMessage
}

function row(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'g-1',
    kind: 'group',
    title: 'Room',
    topic: null,
    members: [],
    pinned: false,
    muted: false,
    mutedUntil: null,
    lastMessageId: null,
    lastAt: '',
    lastAtIso: '2026-03-01T09:00:00.000Z',
    preview: '',
    projectId: null,
    projectName: null,
    projectColor: null,
    ...over,
  } as Conversation
}

describe('WS payload → last-message shape', () => {
  it('renames the timestamp field the server spells differently', () => {
    // The WS event says `at`; `GET /conversations` says `createdAt`. Getting
    // this wrong leaves every patched row stamped with the epoch.
    const last = lastMessageFromWs(wsMessage())
    assert.equal(last.createdAt, '2026-03-01T10:00:00.000Z')
  })

  it('prefers an explicit createdAt when the payload carries both', () => {
    const last = lastMessageFromWs(wsMessage({ createdAt: '2026-03-01T11:00:00.000Z' }))
    assert.equal(last.createdAt, '2026-03-01T11:00:00.000Z')
  })

  it('carries the email envelope through, so the preview reads as a subject', () => {
    const last = lastMessageFromWs(wsMessage({
      kind: 'email',
      email: {
        subject: 'Re: contract draft',
        direction: 'in',
        from: 'ada@example.com',
        to: [],
        cc: [],
        transportStatus: 'received',
      },
    } as Partial<ApiMessage>))
    assert.deepEqual(last.email, {
      subject: 'Re: contract draft',
      direction: 'in',
      from: 'ada@example.com',
    })
  })

  it('null, not undefined, when the message is not an email', () => {
    // The row renderer branches on `last.email` being present; the fetch path
    // produces SQL NULL here, so the patch must not produce `undefined`.
    assert.equal(lastMessageFromWs(wsMessage()).email, null)
  })

  it('keeps the attachment descriptor the preview renders a 📎 from', () => {
    const attachment = { name: 'contract.pdf', kind: 'pdf' as const }
    assert.deepEqual(lastMessageFromWs(wsMessage({ attachment })).attachment, attachment)
  })
})

describe('sidebar order after a patch', () => {
  it('floats the most recent conversation to the top', () => {
    const older = row({ id: 'g-old', lastAtIso: '2026-03-01T09:00:00.000Z' })
    const newer = row({ id: 'g-new', lastAtIso: '2026-03-01T10:00:00.000Z' })
    assert.deepEqual([older, newer].sort(bySidebarOrder).map((c) => c.id), ['g-new', 'g-old'])
  })

  it('keeps pinned rows above unpinned ones however recent they are', () => {
    // Mirrors the server's `ORDER BY c.pinned DESC, c.updated_at DESC` — a
    // patch that sorted by time alone would reshuffle the list on every
    // message and disagree with the next reconnect reload.
    const pinnedStale = row({ id: 'g-pin', pinned: true, lastAtIso: '2026-01-01T00:00:00.000Z' })
    const freshUnpinned = row({ id: 'g-fresh', lastAtIso: '2026-03-01T10:00:00.000Z' })
    assert.deepEqual(
      [freshUnpinned, pinnedStale].sort(bySidebarOrder).map((c) => c.id),
      ['g-pin', 'g-fresh'],
    )
  })

  it('does not throw on a row that has never had a message', () => {
    const empty = row({ id: 'g-empty', lastAtIso: undefined })
    const withMessage = row({ id: 'g-msg', lastAtIso: '2026-03-01T10:00:00.000Z' })
    assert.deepEqual([empty, withMessage].sort(bySidebarOrder).map((c) => c.id), ['g-msg', 'g-empty'])
  })
})

describe('sidebar timestamp', () => {
  it('is empty for a row with no timestamp at all', () => {
    assert.equal(timeFromIso(undefined), '')
  })

  it('shows a clock for today and a date for last week', () => {
    const today = new Date()
    today.setHours(14, 5, 0, 0)
    assert.equal(timeFromIso(today.toISOString()), '14:05')

    const lastWeek = new Date(today.getTime() - 7 * 86400e3)
    assert.equal(timeFromIso(lastWeek.toISOString()), `${lastWeek.getMonth() + 1}/${lastWeek.getDate()}`)
  })
})
