/**
 * Exercises the opt-in `archive-detach` repair for migration 0002 against a
 * real PostgreSQL.
 *
 * The repair runs *before* 0002 installs `conversation_members` and its
 * projection triggers, so the migrated schema these integration tests share
 * cannot host the precondition it fixes — post-0002 you cannot even create an
 * orphan, the trigger rejects it. So this builds the three tables the repair
 * reads in a throwaway schema and runs the exact exported SQL against them.
 * What is under test is the SQL itself: which ids get archived, that the
 * ordinal is captured, that surviving members keep their order, and that
 * `external:` markers and `messages` are left alone.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { pool } from '../db/pool.js'
import {
  MIGRATION_0002_ARCHIVE_DDL,
  MIGRATION_0002_ARCHIVE_TABLE,
  repairConversationMembers,
} from '../db/migrate.js'
import { teardownAll } from './_helpers.js'

const SCHEMA = 'migration_0002_repair_fixture'

let client: import('pg').PoolClient

before(async () => {
  client = await pool.connect()
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await client.query(`CREATE SCHEMA ${SCHEMA}`)
  await client.query(`SET search_path = ${SCHEMA}`)
  await client.query(`
    CREATE TABLE participants (
      id         TEXT NOT NULL,
      company_id TEXT NOT NULL,
      PRIMARY KEY (id, company_id)
    );
    CREATE TABLE conversations (
      id         TEXT PRIMARY KEY,
      company_id TEXT,
      members    JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      author_id       TEXT NOT NULL
    );
  `)
})

after(async () => {
  await client.query(`RESET search_path`).catch(() => { /* best effort */ })
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => { /* best effort */ })
  // search_path is SESSION state and `release()` does not reset it — hand the
  // connection back to the shared pool clean, or the next borrower inherits
  // a schema that no longer exists.
  client.release()
  await teardownAll()
})

test('[integration] archive-detach removes only the unresolvable ids and keeps the rest in order', async () => {
  await client.query(`
    INSERT INTO participants (id, company_id) VALUES
      ('alice', 'co-a'), ('bob', 'co-a'), ('nova', 'co-b');
    INSERT INTO conversations (id, company_id, members) VALUES
      ('pulled-1', 'co-a', '["alice","nova","bob","ghost","external:someone@example.com"]'),
      ('clean-1',  'co-a', '["alice","bob"]'),
      ('tenantless', NULL, '["whoever"]');
    INSERT INTO messages (id, conversation_id, author_id) VALUES
      ('m1', 'pulled-1', 'nova'),
      ('m2', 'pulled-1', 'alice');
  `)

  const summary = await repairConversationMembers(client)
  assert.deepEqual(summary, { archived: 2, conversations: 1 })

  const { rows: [conversation] } = await client.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = 'pulled-1'`,
  )
  // 'nova' (other tenant) and 'ghost' (nowhere) are gone; the survivors keep
  // their relative order and the external marker is untouched.
  assert.deepEqual(conversation.members, ['alice', 'bob', 'external:someone@example.com'])

  const { rows: untouched } = await client.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = 'clean-1'`,
  )
  assert.deepEqual(untouched[0].members, ['alice', 'bob'])

  // A conversation with no tenant is outside the repair's remit — detaching
  // members cannot fix it, and the precheck must still stop the deploy.
  const { rows: tenantless } = await client.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = 'tenantless'`,
  )
  assert.deepEqual(tenantless[0].members, ['whoever'])

  const { rows: archived } = await client.query<{
    member_id: string; ordinal: number; original_members: string[]
    authored_messages: boolean; participant_elsewhere: boolean
  }>(
    `SELECT member_id, ordinal, original_members, authored_messages, participant_elsewhere
       FROM ${MIGRATION_0002_ARCHIVE_TABLE} ORDER BY ordinal`,
  )
  const original = ['alice', 'nova', 'bob', 'ghost', 'external:someone@example.com']
  assert.deepEqual(archived, [
    {
      member_id: 'nova', ordinal: 1, original_members: original,
      authored_messages: true, participant_elsewhere: true,
    },
    {
      member_id: 'ghost', ordinal: 3, original_members: original,
      authored_messages: false, participant_elsewhere: false,
    },
  ])

  // Authorship is evidence of what happened and is never rewritten.
  const { rows: [messages] } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM messages WHERE author_id = 'nova'`,
  )
  assert.equal(messages.count, '1')
})

test('[integration] the archive reconstructs the pre-detach array exactly', async () => {
  // What original_members buys: the old state can be reproduced element for
  // element rather than re-derived by interleaving ordinals. Post-0002 the
  // projection trigger would reject writing an unresolvable id back — this
  // fixture is the pre-0002 world, where the repair actually runs.
  await client.query(`
    UPDATE conversations c
       SET members = a.original_members
      FROM ${MIGRATION_0002_ARCHIVE_TABLE} a
     WHERE a.conversation_id = c.id
  `)

  const { rows: [conversation] } = await client.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = 'pulled-1'`,
  )
  assert.deepEqual(conversation.members, [
    'alice', 'nova', 'bob', 'ghost', 'external:someone@example.com',
  ])
})

test('[integration] the repair is idempotent on an already-clean database', async () => {
  await client.query(`DELETE FROM ${MIGRATION_0002_ARCHIVE_TABLE}`)
  await client.query(`DELETE FROM conversations WHERE company_id IS NULL`)
  await client.query(`UPDATE conversations SET members = '["alice","bob"]'`)

  const first = await repairConversationMembers(client)
  assert.deepEqual(first, { archived: 0, conversations: 0 })
  const second = await repairConversationMembers(client)
  assert.deepEqual(second, { archived: 0, conversations: 0 })

  // Re-running the DDL on an existing archive is a no-op, not an error.
  await client.query(MIGRATION_0002_ARCHIVE_DDL)
})
