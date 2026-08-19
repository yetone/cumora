import { sql } from 'drizzle-orm'
import { pgTable, text, integer, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core'

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'group' | 'direct'
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  members: jsonb('members').$type<string[]>().notNull(),
  pinned: boolean('pinned').default(false).notNull(),
  tag: text('tag'),
  pulledBy: jsonb('pulled_by').$type<{ agentId: string; at: string; reason: string } | null>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(),
    kind: text('kind').notNull(), // 'text' | 'tool' | 'attachment' | 'thought' | 'system'
    body: text('body').notNull(),
    sequence: integer('sequence').notNull(),
    reactions: jsonb('reactions').$type<Array<{ emoji: string; count: number; mine?: boolean }> | null>(),
    tool: jsonb('tool').$type<Record<string, unknown> | null>(),
    attachment: jsonb('attachment').$type<Record<string, unknown> | null>(),
    clientId: text('client_id'),
    poll: jsonb('poll').$type<PollPayload | null>(),
    // Reply-to / quote target: id of another message in THIS conversation that
    // this message is quoting. Soft FK to messages.id with ON DELETE SET NULL
    // so deleting an original leaves orphan replies as "[deleted]" stubs
    // rather than cascading. Null for non-reply messages (the vast majority).
    quotedMessageId: text('quoted_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    convoSeqIdx: index('idx_messages_convo_seq').on(table.conversationId, table.sequence),
    convoCreatedIdx: index('idx_messages_convo_created').on(table.conversationId, table.createdAt),
    quotedIdx: index('idx_messages_quoted').on(table.quotedMessageId),
    clientIdIdx: uniqueIndex('uniq_messages_client_id')
      .on(table.conversationId, table.authorId, table.clientId)
      .where(sql`${table.clientId} IS NOT NULL`),
  }),
)

export const participants = pgTable('participants', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'agent' | 'human'
  name: text('name').notNull(),
  role: text('role'),
  initial: text('initial').notNull(),
  avatarBg: text('avatar_bg').notNull(),
  status: text('status').notNull(),
  bio: text('bio'),
  tools: jsonb('tools').$type<string[] | null>(),
  systemPrompt: text('system_prompt'),
})

export const conversationCounters = pgTable(
  'conversation_counters',
  {
    conversationId: text('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
    nextSequence: integer('next_sequence').default(1).notNull(),
  },
)

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    createdBy: text('created_by').notNull(),
    kind: text('kind').notNull(), // 'personal' | 'agent_task'
    title: text('title').notNull(),
    description: text('description'),
    assigneeId: text('assignee_id'),
    targetConversationId: text('target_conversation_id'),
    agentPrompt: text('agent_prompt'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    endAt: timestamp('end_at', { withTimezone: true }),
    allDay: boolean('all_day').default(false).notNull(),
    recurrence: jsonb('recurrence').$type<RecurrenceRule | null>(),
    status: text('status').notNull(), // 'active' | 'paused' | 'done' | 'cancelled'
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    reminderMinutesBefore: integer('reminder_minutes_before'),
    reminderChannel: text('reminder_channel'), // 'toast' | 'email' | 'both'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    companyStartIdx: index('idx_calendar_events_company_start').on(table.companyId, table.startAt),
    assigneeIdx: index('idx_calendar_events_assignee').on(table.assigneeId, table.startAt),
  }),
)

export const calendarReminders = pgTable(
  'calendar_reminders',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
    companyId: text('company_id').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    firedAt: timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
    channel: text('channel').notNull(),
    recipients: jsonb('recipients').$type<string[]>().notNull(),
    status: text('status').notNull(),
    error: text('error'),
  },
)

export const calendarDispatches = pgTable(
  'calendar_dispatches',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
    companyId: text('company_id').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').notNull(),
    conversationId: text('conversation_id'),
    messageId: text('message_id'),
    error: text('error'),
  },
)

export interface PollOption {
  id: string
  text: string
}

export interface PollPayload {
  question: string
  mode: 'single' | 'multi'
  options: PollOption[]
  expiresAt: string | null   // iso, null = no expiration
  closedAt: string | null    // iso when manually/auto closed
  closedReason: 'expired' | 'manual' | null
}

export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  byweekday?: number[]
  until?: string | null
  count?: number | null
}

export type DbMessage = typeof messages.$inferSelect
export type DbConversation = typeof conversations.$inferSelect
export type DbParticipant = typeof participants.$inferSelect
export type DbCalendarEvent = typeof calendarEvents.$inferSelect
export type DbCalendarDispatch = typeof calendarDispatches.$inferSelect
export type DbCalendarReminder = typeof calendarReminders.$inferSelect
