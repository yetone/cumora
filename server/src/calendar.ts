/**
 * Calendar — scheduled + recurring events shared by humans and agents.
 *
 * Two halves live here:
 *   1. Pure recurrence math (`nextOccurrenceOnOrAfter`) — given an event's
 *      start_at + optional rrule + `last_fired_at`, return the next firing
 *      time (or null if the series has terminated).
 *   2. The dispatcher (`tickCalendar` + `dispatchEvent`) — once per minute,
 *      find every 'active' event whose next-occurrence is due, post a typed
 *      Calendar system dispatch into the target conversation, wake the
 *      assignee, and record a `calendar_dispatches` row for idempotency.
 *
 * Recurrence is intentionally minimal — daily / weekly (with byweekday) /
 * monthly / yearly + interval + until + count. No EXDATEs, no BYMONTHDAY,
 * no BYSETPOS. If we ever need a real RRULE we can swap the math without
 * touching callers.
 */
import { randomUUID } from 'node:crypto'
import { pool } from './db/pool.js'
import { CH_MESSAGE_NEW, CH_CALENDAR_REMINDER, CH_CALENDAR_EVENTS, publish } from './redis.js'
import { enqueueBroadcast, withOutboxTransaction } from './realtime-outbox.js'
import { env } from './env.js'
import { formatAddress, sendViaProvider, mintMessageId } from './email.js'
// The pure half lives apart so it can be tested without a database, Redis or an
// email transport. Re-exported here so every existing importer is unaffected.
export { nextOccurrenceOnOrAfter, type RecurrenceRule } from './recurrence.js'
import { nextOccurrenceOnOrAfter, type RecurrenceRule } from './recurrence.js'

const TICK_INTERVAL_MS = 60_000
const CALENDAR_SYSTEM_AUTHOR_ID = 'calendar'
/** A dispatch is "due" any time `scheduled_for <= now`. We cap how far in
 *  the past we'll still fire so a long server outage doesn't unleash a
 *  pile-up of catch-up dispatches the moment we come back. Events whose
 *  next slot fell more than this many minutes ago get fast-forwarded to
 *  the next future slot without firing. */
const MAX_CATCHUP_MS = 60 * 60_000

export interface CalendarEventRow {
  id: string
  company_id: string
  created_by: string
  kind: 'personal' | 'agent_task'
  title: string
  description: string | null
  assignee_id: string | null
  target_conversation_id: string | null
  agent_prompt: string | null
  start_at: Date
  end_at: Date | null
  all_day: boolean
  recurrence: RecurrenceRule | null
  status: 'active' | 'paused' | 'done' | 'cancelled'
  last_fired_at: Date | null
  reminder_minutes_before: number | null
  reminder_channel: 'toast' | 'email' | 'both' | null
  is_private: boolean
  created_at: Date
  updated_at: Date
}

/* ─────────────────────────── dispatcher ─────────────────────────── */

/** Render the body of the system message posted on dispatch. Keep this as a
 *  typed payload rather than prose so the agent wake prompt can reliably
 *  identify the row as a Calendar event and expand every event field. */
function renderDispatchBody(event: CalendarEventRow, scheduledFor: Date): string {
  const title = event.title.trim() || 'Calendar event'
  const description = (event.description ?? '').trim() || null
  const agentPrompt = (event.agent_prompt ?? '').trim() || null
  return JSON.stringify({
    kind: 'calendar_event',
    eventId: event.id,
    eventKind: event.kind,
    title,
    description,
    agentPrompt,
    assigneeId: event.assignee_id,
    targetConversationId: event.target_conversation_id,
    scheduledFor: scheduledFor.toISOString(),
    startAt: event.start_at.toISOString(),
    endAt: event.end_at ? event.end_at.toISOString() : null,
    allDay: event.all_day,
    recurrence: event.recurrence,
    createdBy: event.created_by,
  })
}

/** Resolve a conversation where the dispatch should land. Falls back to a
 *  direct DM between the creator and the assignee when no explicit target
 *  was set on the event. Returns null when we can't safely post (assignee
 *  missing, target conversation deleted, etc.). */
async function resolveTargetConversation(event: CalendarEventRow): Promise<string | null> {
  if (event.target_conversation_id) {
    const { rows } = await pool.query<{ assignee_is_member: boolean }>(
      `SELECT ($3::text IS NULL OR EXISTS (
                SELECT 1 FROM conversation_members member
                 WHERE member.conversation_id = c.id
                   AND member.company_id = c.company_id
                   AND member.participant_id = $3
              )) AS assignee_is_member
         FROM conversations c
        WHERE c.id = $1 AND c.company_id = $2
        LIMIT 1`,
      [event.target_conversation_id, event.company_id, event.assignee_id],
    )
    if (!rows[0]) return null
    // Best-effort: skip dispatch if the assignee isn't a member of the
    // target conversation. Avoids the @mention dangling in a room the
    // agent can't see.
    if (!rows[0].assignee_is_member) return null
    return event.target_conversation_id
  }
  if (!event.assignee_id) return null
  // Fallback: look for an existing direct conversation between the
  // creator and the assignee. We don't auto-create one — if it doesn't
  // exist the dispatch records 'skipped'.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT c.id FROM conversations c
      WHERE c.company_id = $1 AND c.kind = 'direct'
        AND EXISTS (
          SELECT 1 FROM conversation_members creator
           WHERE creator.conversation_id = c.id
             AND creator.participant_id = $2
        )
        AND EXISTS (
          SELECT 1 FROM conversation_members assignee
           WHERE assignee.conversation_id = c.id
             AND assignee.participant_id = $3
        )
        AND (SELECT COUNT(*) FROM conversation_members member
              WHERE member.conversation_id = c.id) = 2
      LIMIT 1`,
    [event.company_id, event.created_by, event.assignee_id],
  )
  return rows[0]?.id ?? null
}

async function postDispatchMessage(args: {
  event: CalendarEventRow
  conversationId: string
  body: string
}): Promise<string> {
  const { event, conversationId, body } = args
  return withOutboxTransaction(async (client) => {
    const target = await client.query(
      `SELECT c.id FROM conversations c
        WHERE c.id = $1 AND c.company_id = $2
        FOR UPDATE OF c`,
      [conversationId, event.company_id],
    )
    if (!target.rowCount) throw new Error('calendar target conversation disappeared')
    const membership = await client.query(
      `SELECT 1 FROM conversation_members
        WHERE conversation_id = $1
          AND company_id = $2
          AND participant_id = $3`,
      [conversationId, event.company_id, event.assignee_id],
    )
    if (!membership.rowCount) throw new Error('calendar assignee is no longer a target member')
    const seqResult = await client.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS seq`,
      [conversationId],
    )
    const sequence = seqResult.rows[0]?.seq ?? 1
    const messageId = `m-${randomUUID()}`
    // Author: Calendar itself. The creator is preserved in the payload, but the
    // agent should read this as a scheduled Calendar event, not as the creator
    // manually sending a generic system row.
    await client.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1,$2,$3,'system',$4,$5,$6)`,
      [messageId, conversationId, CALENDAR_SYSTEM_AUTHOR_ID, body, sequence, event.company_id],
    )
    await client.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId])
    await enqueueBroadcast(client, CH_MESSAGE_NEW, {
      type: 'message.new',
      conversationId,
      companyId: event.company_id,
      message: {
        id: messageId,
        conversationId,
        authorId: CALENDAR_SYSTEM_AUTHOR_ID,
        kind: 'system',
        body,
        sequence,
        at: new Date().toISOString(),
      },
    })
    return messageId
  })
}

/** Dispatch a single event's occurrence. Inserts the dispatch row first
 *  (unique-key dedup against (event_id, scheduled_for)) so concurrent
 *  ticks fall through gracefully. */
export async function dispatchEvent(event: CalendarEventRow, scheduledFor: Date): Promise<{
  status: 'dispatched' | 'skipped' | 'failed' | 'duplicate'
  messageId?: string
  conversationId?: string
  error?: string
}> {
  const dispatchId = `cd-${randomUUID()}`
  try {
    const claim = await pool.query(
      `INSERT INTO calendar_dispatches (id, event_id, company_id, scheduled_for, status)
       VALUES ($1,$2,$3,$4,'pending')
       ON CONFLICT (event_id, scheduled_for) DO NOTHING
       RETURNING id`,
      [dispatchId, event.id, event.company_id, scheduledFor],
    )
    if (claim.rows.length === 0) {
      // Another tick (or replica) already owns this slot — let it finish.
      return { status: 'duplicate' }
    }
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) }
  }

  // Personal events don't dispatch; we only fire agent_task. The row
  // exists so the history view can show "(personal) at <time>", but no
  // conversation is touched.
  if (event.kind !== 'agent_task' || !event.assignee_id) {
    await pool.query(
      `UPDATE calendar_dispatches SET status = 'skipped', error = $2
        WHERE id = $1`,
      [dispatchId, event.kind === 'personal' ? 'personal event' : 'no assignee'],
    )
    return { status: 'skipped' }
  }

  let conversationId: string | null = null
  try {
    conversationId = await resolveTargetConversation(event)
    if (!conversationId) {
      await pool.query(
        `UPDATE calendar_dispatches SET status = 'skipped', error = $2 WHERE id = $1`,
        [dispatchId, 'no target conversation'],
      )
      return { status: 'skipped', error: 'no target conversation' }
    }
    const body = renderDispatchBody(event, scheduledFor)
    const messageId = await postDispatchMessage({ event, conversationId, body })
    await pool.query(
      `UPDATE calendar_dispatches
          SET status = 'dispatched', conversation_id = $2, message_id = $3
        WHERE id = $1`,
      [dispatchId, conversationId, messageId],
    )
    return { status: 'dispatched', messageId, conversationId }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    await pool.query(
      `UPDATE calendar_dispatches SET status = 'failed', error = $2,
              conversation_id = $3 WHERE id = $1`,
      [dispatchId, err, conversationId],
    )
    return { status: 'failed', error: err, conversationId: conversationId ?? undefined }
  }
}

/* ─────────────────────────── reminders ─────────────────────────── */

/** Resolve which user ids should get a reminder for an event. Always
 *  includes the creator if they're a real user; adds a human assignee
 *  too (agents intentionally don't get reminders — they get the
 *  dispatch). Returns `{userId, email|null}` so the caller can fan out
 *  to toast (uses userId) and email (uses email) in one pass. */
async function resolveReminderRecipients(event: CalendarEventRow): Promise<Array<{ userId: string; email: string | null }>> {
  const ids = new Set<string>()
  ids.add(event.created_by)
  if (event.assignee_id) {
    // Pull only HUMAN participants — agents are excluded since they
    // already get the dispatch and don't need an early toast.
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM participants WHERE id = $1 AND company_id = $2 AND kind = 'human' LIMIT 1`,
      [event.assignee_id, event.company_id],
    )
    if (rows[0]) ids.add(rows[0].id)
  }
  if (ids.size === 0) return []
  // Look up emails for the user ids. Participants.id for humans equals
  // users.id, so we can join straight on it.
  const { rows: emails } = await pool.query<{ id: string; email: string | null }>(
    `SELECT id, email FROM users WHERE id = ANY($1::text[])`,
    [Array.from(ids)],
  )
  const byId = new Map<string, string | null>()
  for (const r of emails) byId.set(r.id, r.email)
  return Array.from(ids).map((userId) => ({ userId, email: byId.get(userId) ?? null }))
}

/** Send the reminder for one (event, occurrence). Dedups on the unique
 *  (event_id, scheduled_for) index — concurrent ticks see one winner.
 *  Returns whether the row was claimed AND fired. */
async function sendReminder(event: CalendarEventRow, occurrence: Date, now: Date): Promise<{
  status: 'sent' | 'skipped' | 'failed' | 'duplicate'
  error?: string
}> {
  if (!event.reminder_minutes_before || !event.reminder_channel) return { status: 'skipped' }
  const reminderId = `cr-${randomUUID()}`
  // Claim the slot first so a concurrent tick / replica falls through.
  const claim = await pool.query(
    `INSERT INTO calendar_reminders (id, event_id, company_id, scheduled_for, channel, recipients, status)
     VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,'sent')
     ON CONFLICT (event_id, scheduled_for) DO NOTHING
     RETURNING id`,
    [reminderId, event.id, event.company_id, occurrence, event.reminder_channel],
  )
  if (claim.rows.length === 0) return { status: 'duplicate' }

  const recipients = await resolveReminderRecipients(event)
  if (recipients.length === 0) {
    await pool.query(`UPDATE calendar_reminders SET status='skipped' WHERE id=$1`, [reminderId])
    return { status: 'skipped' }
  }
  const leadMinutes = Math.max(0, Math.round((occurrence.getTime() - now.getTime()) / 60_000))

  const errors: string[] = []
  // Toast channel: WS broadcast. The bridge fan-outs to every socket in
  // the company; the renderer filters by recipientUserIds.
  if (event.reminder_channel === 'toast' || event.reminder_channel === 'both') {
    try {
      await publish(CH_CALENDAR_REMINDER, {
        type: 'calendar.reminder',
        companyId: event.company_id,
        eventId: event.id,
        title: event.title,
        occurrenceAt: occurrence.toISOString(),
        leadMinutes,
        recipientUserIds: recipients.map((r) => r.userId),
        kind: event.kind,
        assigneeId: event.assignee_id,
      })
    } catch (e) {
      errors.push(`toast: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Email channel: one email per recipient address. We skip recipients
  // missing a mailable address rather than fail the whole reminder; the
  // toast path still works for them.
  if (event.reminder_channel === 'email' || event.reminder_channel === 'both') {
    const emailRecipients = recipients.filter((r) => r.email)
    if (emailRecipients.length > 0 && env.EMAIL_DOMAIN) {
      const subject = sanitizeReminderSubject(event, leadMinutes)
      const text = renderReminderText(event, occurrence, leadMinutes)
      const html = renderReminderHtml(event, occurrence, leadMinutes)
      const fromAddr = `reminders@${env.EMAIL_DOMAIN}`
      for (const r of emailRecipients) {
        try {
          const res = await sendViaProvider({
            from: formatAddress(fromAddr, 'Cumora Calendar'),
            to: [r.email as string],
            subject,
            text,
            html,
            messageId: mintMessageId(),
            autoSubmitted: 'auto-generated',
          })
          if (!res.ok && res.error) errors.push(`email[${r.email}]: ${res.error}`)
        } catch (e) {
          errors.push(`email[${r.email}]: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  await pool.query(
    `UPDATE calendar_reminders
        SET recipients = $2::jsonb,
            status = $3,
            error = $4
      WHERE id = $1`,
    [
      reminderId,
      JSON.stringify(recipients.map((r) => r.userId)),
      errors.length === 0 ? 'sent' : 'failed',
      errors.length === 0 ? null : errors.join('; '),
    ],
  )
  return errors.length === 0 ? { status: 'sent' } : { status: 'failed', error: errors.join('; ') }
}

function sanitizeReminderSubject(event: CalendarEventRow, leadMinutes: number): string {
  // Strip control characters to stop header injection, keep subject short.
  const title = event.title.replace(/[\r\n\t -]/g, ' ').slice(0, 160)
  if (leadMinutes <= 1) return `Starting now: ${title}`
  if (leadMinutes < 60) return `In ${leadMinutes} min: ${title}`
  const h = Math.round(leadMinutes / 60)
  return `In ${h} hour${h === 1 ? '' : 's'}: ${title}`
}

function renderReminderText(event: CalendarEventRow, occurrence: Date, leadMinutes: number): string {
  const lines = [
    `Heads-up — "${event.title}" is coming up.`,
    ``,
    `When: ${occurrence.toUTCString()} (in ~${leadMinutes} minute${leadMinutes === 1 ? '' : 's'})`,
  ]
  if (event.description) lines.push('', event.description)
  if (event.kind === 'agent_task' && event.assignee_id) {
    lines.push('', `Will be handed off to: @${event.assignee_id}`)
  }
  lines.push('', '—', 'Cumora Calendar')
  return lines.join('\n')
}

function renderReminderHtml(event: CalendarEventRow, occurrence: Date, leadMinutes: number): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const title = esc(event.title)
  const when = esc(occurrence.toUTCString())
  const lead = leadMinutes === 1 ? '1 minute' : `${leadMinutes} minutes`
  const desc = event.description ? `<p style="color:#5B7186">${esc(event.description)}</p>` : ''
  const assign = event.kind === 'agent_task' && event.assignee_id
    ? `<p style="color:#5B7186">Will be handed off to <b>@${esc(event.assignee_id)}</b>.</p>`
    : ''
  return `<!doctype html><html><body style="font-family:-apple-system,sans-serif;background:#FAFCFE;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #E5ECF2;border-radius:14px;padding:24px">
      <div style="color:#0078C8;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;font-weight:700">Reminder · in ${lead}</div>
      <h1 style="margin:6px 0 12px;font-size:20px;color:#0A1B2E">${title}</h1>
      <p style="color:#5B7186;margin:0 0 4px">${when} UTC</p>
      ${desc}
      ${assign}
      <hr style="border:none;border-top:1px solid #E5ECF2;margin:24px 0 12px"/>
      <p style="color:#94A8BC;font-size:11px;margin:0">Cumora Calendar</p>
    </div></body></html>`
}

/** Single tick: walk every active event. For each, compute its NEXT
 *  occurrence relative to the last fire; (a) if a reminder window is
 *  open right now, fire the reminder; (b) if the slot itself is due
 *  (now ≥ occurrence), dispatch. Both code paths dedup via unique
 *  indexes so multi-replica races collapse cleanly. */
export async function tickCalendar(now: Date = new Date()): Promise<{ scanned: number; fired: number; reminded: number }> {
  // No start_at filter — events with an upcoming reminder need to be
  // considered before their start_at, and "active" keeps the working set
  // small anyway.
  const { rows } = await pool.query<CalendarEventRow>(
    `SELECT id, company_id, created_by, kind, title, description, assignee_id,
            target_conversation_id, agent_prompt, start_at, end_at, all_day,
            recurrence, status, last_fired_at,
            reminder_minutes_before, reminder_channel,
            is_private,
            created_at, updated_at
       FROM calendar_events
      WHERE status = 'active'`,
  )
  let fired = 0
  let reminded = 0
  for (const row of rows) {
    const after = row.last_fired_at
      ? new Date(row.last_fired_at.getTime() + 1)
      : row.start_at
    const slot = nextOccurrenceOnOrAfter(row.start_at, row.recurrence, after)
    if (!slot) {
      await withOutboxTransaction(async (client) => {
        await client.query(`UPDATE calendar_events SET status='done', updated_at=NOW() WHERE id=$1`, [row.id])
        await enqueueCalendarChanged(client, row.company_id, 'event.updated', row.id)
      })
      continue
    }

    // Reminder check — fires in the window [slot - reminderMin, slot].
    // We always check before the dispatch branch since reminder time is
    // strictly earlier; a tick that lands inside the window after slot
    // (e.g. due to outage) won't double-fire because of the unique key.
    if (row.reminder_minutes_before !== null && row.reminder_channel) {
      const reminderTime = new Date(slot.getTime() - row.reminder_minutes_before * 60_000)
      if (now.getTime() >= reminderTime.getTime() && now.getTime() < slot.getTime()) {
        const r = await sendReminder(row, slot, now)
        if (r.status === 'sent') reminded += 1
      }
    }

    if (slot.getTime() > now.getTime()) continue           // not yet
    const lag = now.getTime() - slot.getTime()
    if (lag > MAX_CATCHUP_MS) {
      await withOutboxTransaction(async (client) => {
        await client.query(
          `UPDATE calendar_events SET last_fired_at = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, slot],
        )
        await enqueueCalendarChanged(client, row.company_id, 'event.updated', row.id)
      })
      continue
    }
    const result = await dispatchEvent(row, slot)
    if (result.status === 'dispatched' || result.status === 'skipped' || result.status === 'failed') {
      await withOutboxTransaction(async (client) => {
        await client.query(
          `UPDATE calendar_events SET last_fired_at = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, slot],
        )
        if (!row.recurrence) {
          await client.query(`UPDATE calendar_events SET status='done', updated_at=NOW() WHERE id=$1`, [row.id])
        }
        await enqueueCalendarChanged(
          client,
          row.company_id,
          result.status === 'dispatched' ? 'event.dispatched' : 'event.updated',
          row.id,
        )
      })
      if (result.status === 'dispatched') fired += 1
    }
  }
  return { scanned: rows.length, fired, reminded }
}

/** Queue the tick-driven invalidation in the calendar mutation transaction. */
async function enqueueCalendarChanged(
  client: import('pg').PoolClient,
  companyId: string,
  kind: 'event.updated' | 'event.dispatched',
  eventId: string,
): Promise<void> {
  await enqueueBroadcast(client, CH_CALENDAR_EVENTS, {
    type: 'calendar.changed',
    companyId,
    kind,
    eventId,
    actorId: null,
  })
}

let started = false
let timer: NodeJS.Timeout | null = null

export function startCalendarScheduler(): void {
  if (started) return
  started = true
  const loop = async () => {
    try {
      const r = await tickCalendar()
      if (r.fired > 0 || r.reminded > 0) {
        console.log(`[calendar] tick fired=${r.fired} reminded=${r.reminded} scanned=${r.scanned}`)
      }
    } catch (e) {
      console.error('[calendar] tick error', e)
    }
  }
  // First tick on the next event-loop turn so the server is fully up.
  setTimeout(() => { void loop() }, 5_000)
  timer = setInterval(() => { void loop() }, TICK_INTERVAL_MS)
  console.log(`[calendar] scheduler started (tick=${TICK_INTERVAL_MS}ms)`)
}

export function stopCalendarScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
}
