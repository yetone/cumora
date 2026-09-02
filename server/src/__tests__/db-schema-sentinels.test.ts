/**
 * The lock-contention shortcut must never declare a schema "current" while a
 * column the DDL promises is absent.
 *
 * On 2026-08-31 it did exactly that: #133 added `messages.delivery_recipient_id`
 * to the DDL but not to the hand-kept sentinel list, a loaded production lost
 * the lock race on `messages` (55P03), the shortcut answered "current", migrate
 * exited 0, and every BYOA daemon's /inbox 500'd on the missing column. The
 * expectations are now derived from the DDL text, so these tests pin that the
 * derivation actually sees what the DDL declares.
 *
 * Run: node --import tsx --test server/src/__tests__/db-schema-sentinels.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { ddlExpectations } = await import('../db/migrate.js')

test('every ADD COLUMN IF NOT EXISTS in the DDL becomes an expectation', () => {
  const { columns } = ddlExpectations()
  const has = (t: string, c: string) => columns.some((x) => x.table === t && x.column === c)

  // The column whose omission caused the outage.
  assert.ok(has('messages', 'delivery_recipient_id'), 'messages.delivery_recipient_id must be expected')
  // Its neighbours, which were present in prod and masked the gap.
  assert.ok(has('messages', 'client_id'))
  assert.ok(has('messages', 'quoted_message_id'))

  assert.ok(columns.length > 20, `expected many derived columns, got ${columns.length}`)
})

test('CREATE TABLE IF NOT EXISTS names become table expectations', () => {
  const { tables } = ddlExpectations()
  for (const t of ['messages', 'conversations', 'participants', 'llm_calls', 'shipping_features']) {
    assert.ok(tables.includes(t), `${t} must be expected`)
  }
  assert.equal(new Set(tables).size, tables.length, 'table list must be deduplicated')
})

test('commented-out DDL does not become a phantom expectation', () => {
  const { columns } = ddlExpectations()
  // A phantom would make schemaAlreadyCurrent permanently false and disable the
  // shortcut entirely, turning every loaded deploy into a crash-loop.
  for (const c of columns) {
    assert.match(c.table, /^[a-z_][a-z0-9_]*$/)
    assert.match(c.column, /^[a-z_][a-z0-9_]*$/)
  }
})

test('a table the DDL creates and later drops is not an expectation', () => {
  const { tables, columns } = ddlExpectations()
  // The DDL still carries `CREATE TABLE IF NOT EXISTS email_verification_tokens`
  // followed by the migration that dropped it when password auth was removed.
  // Deriving expectations from the CREATEs alone made it a phantom: production
  // could never be "current", the 40P01 shortcut never fired, and the v0.13.1
  // rollout on 2026-09-02 crash-looped its migrate init container under load.
  for (const t of ['email_verification_tokens', 'password_reset_tokens', 'notion_pages', 'github_branches']) {
    assert.ok(!tables.includes(t), `${t} is dropped by the DDL and must not be expected`)
    assert.ok(!columns.some((c) => c.table === t), `no column of dropped table ${t} may be expected`)
  }
  // The live tables next to them are still promised.
  for (const t of ['users', 'sessions', 'user_identities']) assert.ok(tables.includes(t), `${t} must be expected`)
})
