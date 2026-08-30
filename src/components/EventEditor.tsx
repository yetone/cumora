/**
 * Modal for creating + editing a calendar event. Drives the AI-native
 * "schedule a task for an agent" flow: title + start time + assignee +
 * prompt + recurrence. Reuses the same API as the agent CLI's
 * `cumora calendar create`, so the two stay shape-compatible.
 */
import { useEffect, useMemo, useState } from 'react'
import { useCalendar } from '@/stores/calendar'
import { useParticipants } from '@/stores/participants'
import { useConversations } from '@/stores/conversations'
import { useMe } from '@/stores/auth'
import { Avatar } from '@/components/Avatar'
import { DateTimePicker } from '@/components/DateTimePicker'
import { Input } from '@/components/Input'
import { TextArea } from '@/components/TextArea'
import type { CalendarEvent, CalendarEventKind, RecurrenceRule, Participant } from '@/types'
import { useTLabel } from '@/lib/i18n'

/** Prefilled defaults passed in when creating a NEW event from a calendar
 *  drag-select or right-click. Ignored when `event` is supplied (edit
 *  mode). The Calendar UI uses this for: drag a time range in week view →
 *  prefill startAt + endAt; right-click an empty slot → prefill startAt at
 *  the clicked time; drag across days in month view → prefill an all-day
 *  multi-day range. */
export interface EventEditorPrefill {
  startAt: Date
  endAt?: Date | null
  allDay?: boolean
}

interface Props {
  event: CalendarEvent | null
  prefill?: EventEditorPrefill | null
  onClose: () => void
}

// i18n: original English labels stay as the source of truth (and fallback)
// so future copy edits by the author auto-flow. The parallel lookup table
// gives t() a MessageKey to resolve without changing the data shape.
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY_LABEL_KEY = [
  'event.weekdaySun',
  'event.weekdayMon',
  'event.weekdayTue',
  'event.weekdayWed',
  'event.weekdayThu',
  'event.weekdayFri',
  'event.weekdaySat',
] as const

/** Format a JS Date into `YYYY-MM-DDTHH:mm` for `<input type=datetime-local>`. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Inverse of toLocalInput — parse the input value as local time and produce
 *  an ISO timestamp the server accepts. */
function fromLocalInput(s: string): string {
  // new Date('YYYY-MM-DDTHH:mm') interprets as local time, which is what
  // we want — toISOString() then converts to UTC for the wire.
  return new Date(s).toISOString()
}

export function EventEditor({ event, prefill, onClose }: Props) {
  // Non-invasive i18n: prefer translated MessageKey, fall back to the
  // author's original English literal so future copy edits stay in sync.
  // The optional params object is forwarded to t() when the bundle has
  // a translated entry that uses interpolation.
  const tLabel = useTLabel()
  const create = useCalendar((s) => s.create)
  const update = useCalendar((s) => s.update)
  const remove = useCalendar((s) => s.remove)
  const runNow = useCalendar((s) => s.runNow)
  const byId = useParticipants((s) => s.byId)
  const conversations = useConversations((s) => s.list)
  const meId = useMe()

  const isEdit = !!event

  const [title, setTitle] = useState(event?.title ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [kind, setKind] = useState<CalendarEventKind>(event?.kind ?? 'agent_task')
  const [startAt, setStartAt] = useState(() =>
    event ? toLocalInput(new Date(event.startAt))
    : prefill ? toLocalInput(prefill.startAt)
    : toLocalInput(roundUpToNext15(new Date())),
  )
  const [endAt, setEndAt] = useState(() =>
    event?.endAt ? toLocalInput(new Date(event.endAt))
    : prefill?.endAt ? toLocalInput(prefill.endAt)
    : '',
  )
  const [allDay, setAllDay] = useState<boolean>(event?.allDay ?? prefill?.allDay ?? false)
  const [assigneeId, setAssigneeId] = useState<string | null>(event?.assigneeId ?? null)
  const [targetConversationId, setTargetConversationId] = useState<string | null>(event?.targetConversationId ?? null)
  const [agentPrompt, setAgentPrompt] = useState(event?.agentPrompt ?? '')
  const [recurEnabled, setRecurEnabled] = useState(!!event?.recurrence)
  const [recur, setRecur] = useState<RecurrenceRule>(
    event?.recurrence ?? { freq: 'weekly', interval: 1 },
  )
  // Reminder: enabled when either column is set on the event row. We pre-
  // seed with a sensible default (10 min · toast) so toggling on doesn't
  // require the user to think.
  const [reminderEnabled, setReminderEnabled] = useState(
    event?.reminderMinutesBefore != null && !!event?.reminderChannel,
  )
  const [reminderMinutes, setReminderMinutes] = useState<number>(event?.reminderMinutesBefore ?? 10)
  const [reminderChannel, setReminderChannel] = useState<'toast' | 'email' | 'both'>(
    event?.reminderChannel ?? 'toast',
  )
  // Privacy toggle. Defaults to whatever the row already is; new events
  // start public to match the existing "shared workspace calendar" default.
  const [isPrivate, setIsPrivate] = useState<boolean>(event?.isPrivate ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Assignee picker source: every active participant (agents preferred at
  // top — that's the primary use case — but humans are valid too for
  // "remind teammate" personal events).
  const candidates: Participant[] = useMemo(() => {
    return Object.values(byId)
      .filter((p) => !p.departedAt)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'agent' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
  }, [byId])

  // Conversations the assignee belongs to — these are the valid drop
  // targets for an agent_task. Fall back to "any conversation in the
  // workspace" if no assignee is picked yet.
  const targetConvos = useMemo(() => {
    if (!assigneeId) return conversations
    return conversations.filter((c) => c.members.includes(assigneeId))
  }, [conversations, assigneeId])

  const submit = async () => {
    setErr(null)
    const cleanTitle = title.trim()
    if (!cleanTitle) { setErr(tLabel('event.titleRequired', "title is required")); return }
    if (kind === 'agent_task' && !assigneeId) { setErr(tLabel('event.assigneeRequired', "pick an assignee for the agent task")); return }
    if (!startAt) { setErr(tLabel('event.startTimeRequired', "start time is required")); return }

    const recurrence: RecurrenceRule | null = recurEnabled
      ? {
          freq: recur.freq,
          interval: Math.max(1, Math.floor(recur.interval || 1)),
          byweekday: recur.freq === 'weekly' ? recur.byweekday : undefined,
          until: recur.until ? new Date(recur.until).toISOString() : null,
          count: recur.count ?? null,
        }
      : null

    setBusy(true)
    try {
      const payload = {
        title: cleanTitle,
        kind,
        description: description.trim() || null,
        assigneeId: kind === 'agent_task' ? assigneeId : null,
        targetConversationId: kind === 'agent_task' ? targetConversationId : null,
        agentPrompt: kind === 'agent_task' ? (agentPrompt.trim() || null) : null,
        startAt: fromLocalInput(startAt),
        endAt: endAt ? fromLocalInput(endAt) : null,
        allDay,
        recurrence,
        reminderMinutesBefore: reminderEnabled ? Math.max(0, Math.floor(reminderMinutes)) : null,
        reminderChannel: reminderEnabled ? reminderChannel : null,
        isPrivate,
      }
      if (event) {
        await update(event.id, payload)
      } else {
        await create(payload)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!event) return
    if (!confirm(tLabel('event.deleteConfirm', `Delete "${event.title}"? This wipes its dispatch history too.`, { title: event.title }))) return
    setBusy(true)
    try {
      await remove(event.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRunNow = async () => {
    if (!event) return
    setBusy(true)
    try {
      const r = await runNow(event.id)
      if (r.status === 'dispatched') onClose()
      else setErr(tLabel('event.runNowError', `run-now: ${r.status}${r.error ? ` — ${r.error}` : ''}`, { status: r.status, error: r.error ? tLabel('event.runNowErrorSep', ' — ') + r.error : '' }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canDelete = event && event.createdBy === meId

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(15, 30, 50, 0.55)', backdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cloud rounded-[18px] shadow-pop w-full max-w-[600px] max-h-[88vh] flex flex-col overflow-hidden"
        style={{ border: '1px solid var(--ink-100)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 border-b border-ink-100 shrink-0">
          <h2 className="font-display font-medium text-[20px] tracking-tight">
            {isEdit ? tLabel('event.editEvent', "Edit event") : tLabel('event.newEvent', "New event")}
          </h2>
          <div className="text-[12.5px] text-ink-500 italic font-display mt-0.5">
            {kind === 'agent_task' ? tLabel('event.subtitleAgentTask', "Pick an agent and a time. When it fires, your prompt lands in the conversation and wakes them.") : tLabel('event.subtitlePersonal', "A personal time marker — no agent gets pinged.")}
          </div>
        </div>

        <div className="px-6 py-5 overflow-y-auto overflow-x-hidden flex-1 min-h-0 space-y-5">
          <Field label={tLabel('event.titleLabel', "Title")}>
            <Input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tLabel('event.titlePh', "e.g. Daily standup digest")}
              autoFocus
              maxLength={200}
            />
          </Field>

          <Field label={tLabel('event.kindLabel', "Kind")} hint={tLabel('event.kindHint', "Agent task fires a prompt; personal is just a time marker.")}>
            <div className="flex gap-2">
              {(['agent_task', 'personal'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className="px-3 py-1.5 rounded-full text-[12.5px] font-medium transition"
                  style={{
                    background: kind === k ? 'var(--skype)' : 'var(--paper)',
                    color: kind === k ? 'white' : 'var(--ink-700)',
                    border: '1.5px solid ' + (kind === k ? 'var(--skype)' : 'var(--ink-100)'),
                  }}
                >{k === 'agent_task' ? tLabel('event.kindAgentTask', "Agent task") : tLabel('event.kindPersonal', "Personal")}</button>
              ))}
            </div>
          </Field>

          <Field label={tLabel('event.whenLabel', "When")}>
            <label className="flex items-center gap-2 text-[13px] text-ink-700 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              {tLabel('event.allDay', "All-day")}
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1">{tLabel('event.startsLabel', "Starts")}</div>
                <DateTimePicker
                  mode={allDay ? 'date' : 'datetime'}
                  value={startAt}
                  onChange={(v) => setStartAt(allDay ? `${v.slice(0, 10)}T00:00` : v)}
                />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-ink-400 mb-1">
                  {tLabel('event.endsLabel', "Ends")} <span className="normal-case text-ink-300">{tLabel('event.endsOptional', "— optional")}</span>
                </div>
                <DateTimePicker
                  mode={allDay ? 'date' : 'datetime'}
                  value={endAt}
                  placeholder="—"
                  allowClear
                  onChange={(v) => {
                    if (!v) { setEndAt(''); return }
                    setEndAt(allDay ? `${v.slice(0, 10)}T23:59` : v)
                  }}
                />
              </div>
            </div>
          </Field>

          <Field label={tLabel('event.repeatLabel', "Repeat")} hint={tLabel('event.repeatHint', "Leave off for a one-shot event.")}>
            <label className="flex items-center gap-2 text-[13px] text-ink-700 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={recurEnabled}
                onChange={(e) => setRecurEnabled(e.target.checked)}
              />
              {tLabel('event.recurring', "Recurring")}
            </label>
            {recurEnabled && (
              <div className="space-y-2 pl-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] text-ink-500">{tLabel('event.everyLabel', "every")}</span>
                  <Input
                    type="number"
                    min={1}
                    value={recur.interval}
                    onChange={(e) => setRecur({ ...recur, interval: Math.max(1, Number(e.target.value) || 1) })}
                    style={{ width: 70 }}
                  />
                  <select
                    value={recur.freq}
                    onChange={(e) => setRecur({ ...recur, freq: e.target.value as RecurrenceRule['freq'] })}
                    className="ev-input"
                    style={{ width: 'auto' }}
                  >
                    <option value="daily">{`day${recur.interval > 1 ? 's' : ''}`}</option>
                    <option value="weekly">{`week${recur.interval > 1 ? 's' : ''}`}</option>
                    <option value="monthly">{`month${recur.interval > 1 ? 's' : ''}`}</option>
                    <option value="yearly">{`year${recur.interval > 1 ? 's' : ''}`}</option>
                  </select>
                </div>
                {recur.freq === 'weekly' && (
                  <div className="flex flex-wrap gap-1">
                    {WEEKDAY_LABELS.map((label, idx) => {
                      const on = (recur.byweekday ?? []).includes(idx)
                      return (
                        <button
                          type="button"
                          key={idx}
                          onClick={() => {
                            const next = new Set(recur.byweekday ?? [])
                            if (next.has(idx)) next.delete(idx)
                            else next.add(idx)
                            setRecur({ ...recur, byweekday: [...next].sort((a, b) => a - b) })
                          }}
                          className="w-9 h-7 rounded-md text-[11.5px] font-semibold transition"
                          style={{
                            background: on ? 'var(--skype)' : 'var(--paper)',
                            color: on ? 'white' : 'var(--ink-600)',
                            border: '1.5px solid ' + (on ? 'var(--skype)' : 'var(--ink-100)'),
                          }}
                        >{tLabel(WEEKDAY_LABEL_KEY[idx], label)}</button>
                      )
                    })}
                  </div>
                )}
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="text-[11.5px] text-ink-500 flex items-center gap-1.5">
                    <span>{tLabel('event.untilLabel', "until")}</span>
                    <div style={{ width: 180 }}>
                      <DateTimePicker
                        mode="date"
                        value={recur.until ? `${recur.until.slice(0, 10)}T00:00` : ''}
                        allowClear
                        placeholder={tLabel('event.neverPh', "never")}
                        onChange={(v) => setRecur({
                          ...recur,
                          until: v ? new Date(`${v.slice(0, 10)}T00:00:00`).toISOString() : null,
                        })}
                      />
                    </div>
                  </div>
                  <label className="text-[11.5px] text-ink-500 flex items-center gap-1.5">
                    {tLabel('event.orMaxLabel', "or max")}
                    <Input
                      type="number"
                      min={1}
                      placeholder={tLabel('event.infinitePh', "∞")}
                      value={recur.count ?? ''}
                      onChange={(e) => setRecur({ ...recur, count: e.target.value ? Math.max(1, Number(e.target.value)) : null })}
                      style={{ width: 80 }}
                    />
                    {tLabel('event.timesLabel', "times")}
                  </label>
                </div>
              </div>
            )}
          </Field>

          <Field label={tLabel('event.reminderLabel', "Reminder")} hint={tLabel('event.reminderHint', "Heads-up to you (and any human assignee) before each occurrence.")}>
            <label className="flex items-center gap-2 text-[13px] text-ink-700 mb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={reminderEnabled}
                onChange={(e) => setReminderEnabled(e.target.checked)}
              />
              {tLabel('event.remindMeBefore', "Remind me before")}
            </label>
            {reminderEnabled && (
              <div className="space-y-2 pl-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex flex-wrap gap-1">
                    {[5, 10, 15, 30, 60, 120, 1440].map((m) => {
                      const on = reminderMinutes === m
                      const label = m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setReminderMinutes(m)}
                          className="px-2.5 py-1 rounded-full text-[11.5px] font-medium transition"
                          style={{
                            background: on ? 'var(--skype)' : 'var(--paper)',
                            color: on ? 'white' : 'var(--ink-700)',
                            border: '1.5px solid ' + (on ? 'var(--skype)' : 'var(--ink-100)'),
                          }}
                        >{label}</button>
                      )
                    })}
                  </div>
                  <span className="text-[11.5px] text-ink-400">{tLabel('event.orLabel', "or")}</span>
                  <Input
                    type="number"
                    min={0}
                    value={reminderMinutes}
                    onChange={(e) => setReminderMinutes(Math.max(0, Number(e.target.value) || 0))}
                    style={{ width: 80 }}
                  />
                  <span className="text-[11.5px] text-ink-500">{tLabel('event.minutesBefore', "minutes before")}</span>
                </div>
                <div className="flex gap-1.5">
                  {(['toast', 'email', 'both'] as const).map((ch) => {
                    const on = reminderChannel === ch
                    return (
                      <button
                        key={ch}
                        type="button"
                        onClick={() => setReminderChannel(ch)}
                        className="px-3 py-1 rounded-full text-[11.5px] font-medium transition"
                        style={{
                          background: on ? 'var(--skype)' : 'var(--paper)',
                          color: on ? 'white' : 'var(--ink-700)',
                          border: '1.5px solid ' + (on ? 'var(--skype)' : 'var(--ink-100)'),
                        }}
                      >{ch === 'toast' ? tLabel('event.remChannelToast', "Toast") : ch === 'email' ? tLabel('event.remChannelEmail', "Email") : tLabel('event.remChannelBoth', "Both")}</button>
                    )
                  })}
                </div>
              </div>
            )}
          </Field>

          {kind === 'agent_task' && (
            <>
              <Field label={tLabel('event.assignToLabel', "Assign to")} hint={tLabel('event.assignToHint', "The agent (or human) who'll receive the dispatch.")}>
                <div className="grid grid-cols-1 gap-1 max-h-[200px] overflow-auto pr-1">
                  {candidates.map((p) => {
                    const on = assigneeId === p.id
                    return (
                      <button
                        type="button"
                        key={p.id}
                        onClick={() => setAssigneeId(p.id)}
                        className="text-left flex items-center gap-3 py-1.5 px-2.5 rounded-[10px] transition"
                        style={{
                          background: on ? 'var(--sky-50)' : 'var(--paper)',
                          border: `1.5px solid ${on ? 'var(--sky2-300)' : 'var(--ink-100)'}`,
                        }}
                      >
                        <Avatar p={p} size={28} ringColor="var(--paper)" showStatus={false} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-semibold text-ink-900 truncate">{p.name}</div>
                          <div className="text-[11px] text-ink-500 truncate">
                            {p.role || (p.kind === 'human' ? tLabel('common.human', "human") : tLabel('common.agent', "agent"))}
                          </div>
                        </div>
                        {on && (
                          <span className="text-[12px] text-skype-deep font-semibold">✓</span>
                        )}
                      </button>
                    )
                  })}
                  {candidates.length === 0 && (
                    <div className="text-[12.5px] text-ink-500 italic font-display py-4 text-center">
                      {tLabel('event.noTeammates', "No teammates available — add an agent first.")}
                    </div>
                  )}
                </div>
              </Field>

              <Field label={tLabel('event.postInLabel', "Post in")} hint={tLabel('event.postInHint', "Where the dispatch message lands when it fires. Leave blank to use your DM with the assignee.")}>
                <select
                  value={targetConversationId ?? ''}
                  onChange={(e) => setTargetConversationId(e.target.value || null)}
                  className="ev-input"
                >
                  <option value="">{tLabel('event.dmAssignee', "— Direct message with assignee —")}</option>
                  {targetConvos.map((c) => (
                    <option key={c.id} value={c.id}>{c.title}</option>
                  ))}
                </select>
              </Field>

              <Field label={tLabel('event.promptLabel', "Prompt")} hint={tLabel('event.promptHint', "What the agent should do each time. Plain text — agents see it as a system message.")}>
                <TextArea
                  value={agentPrompt}
                  onChange={(e) => setAgentPrompt(e.target.value)}
                  placeholder={tLabel('event.promptPh', "e.g. Summarize the past 24h of conversation activity and post the digest here.")}
                  rows={4}
                  maxLength={8000}
                />
              </Field>
            </>
          )}

          <Field label={tLabel('event.privacyLabel', "Privacy")} hint={tLabel('event.privacyHint', "Private events only show up for the creator and the assignee. The workspace owner can still see private events that involve an agent, for supervision. Default: shared with everyone in the workspace.")}>
            <label className="flex items-center gap-2 text-[13px] text-ink-700 cursor-pointer">
              <input
                type="checkbox"
                checked={isPrivate}
                onChange={(e) => setIsPrivate(e.target.checked)}
              />
              <span>{tLabel('event.privateHideShared', "🔒 Private — hide from the shared calendar")}</span>
            </label>
          </Field>

          <Field label={tLabel('event.notesLabel', "Notes")} hint={tLabel('event.notesHint', "Optional context — shown alongside the prompt on dispatch.")}>
            <TextArea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tLabel('event.notesPh', "Anything else worth knowing?")}
              rows={2}
              maxLength={4000}
            />
          </Field>

          {err && (
            <div className="text-[12.5px] text-coral-deep bg-coral-soft py-2 px-3 rounded-lg">{err}</div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-ink-100 flex items-center gap-2 bg-paper shrink-0">
          {canDelete && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="px-3 py-2 rounded-[9px] text-[12.5px] font-semibold text-coral-deep bg-cloud hover:bg-coral-soft transition"
              style={{ border: '1px solid var(--ink-100)' }}
            >{tLabel('common.delete', "Delete")}</button>
          )}
          {isEdit && event!.kind === 'agent_task' && event!.status === 'active' && (
            <button
              type="button"
              onClick={onRunNow}
              disabled={busy}
              className="px-3 py-2 rounded-[9px] text-[12.5px] font-semibold text-skype-deep bg-cloud hover:bg-sky2-100 transition"
              style={{ border: '1px solid var(--ink-100)' }}
              title={tLabel('event.runNowTitle', "Fire this event right now, without waiting for its next scheduled time")}
            >{tLabel('event.runNow', "Run now")}</button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 rounded-[9px] text-[12.5px] font-semibold text-ink-700 bg-cloud hover:bg-sky2-50 transition"
            style={{ border: '1px solid var(--ink-100)' }}
          >{tLabel('common.cancel', "Cancel")}</button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="px-5 py-2 rounded-[9px] text-[12.5px] font-semibold text-white transition disabled:opacity-50"
            style={{
              background: 'var(--skype)',
              boxShadow: '0 4px 12px -3px rgba(0, 168, 240, 0.5)',
            }}
          >{busy ? tLabel('event.saving', "Saving…") : isEdit ? tLabel('common.save', "Save") : tLabel('event.schedule', "Schedule")}</button>
        </div>
      </div>

      <style>{`
        .ev-input {
          width: 100%;
          padding: 8px 12px;
          font-size: 13.5px;
          background: var(--paper);
          border: 1.5px solid var(--ink-100);
          border-radius: 10px;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          color: var(--ink-900);
        }
        .ev-input:focus {
          border-color: var(--sky2-300);
          box-shadow: 0 0 0 3px var(--sky-50);
        }
      `}</style>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-bold tracking-wider uppercase text-ink-500 mb-1">{label}</label>
      {hint && (
        <div className="text-[11.5px] text-ink-300 mb-1.5 font-display italic">{hint}</div>
      )}
      {children}
    </div>
  )
}

/** Round a Date forward to the next quarter-hour so the default "new event"
 *  start time isn't an awkward 14:37. */
function roundUpToNext15(d: Date): Date {
  const out = new Date(d)
  out.setSeconds(0, 0)
  const m = out.getMinutes()
  const add = (15 - (m % 15)) % 15
  out.setMinutes(m + (add === 0 ? 15 : add))
  return out
}
