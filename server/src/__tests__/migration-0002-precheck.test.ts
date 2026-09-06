import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const {
  checkConversationMembersResolvable,
  migration0002RepairMode,
  repairConversationMembers,
  MIGRATION_0002_ARCHIVE_TABLE,
} = await import('../db/migrate.js')

const fakeClient = (summary: Record<string, unknown>, samples: Array<Record<string, unknown>> = []) => {
  const statements: string[] = []
  return {
    statements,
    async query(sql: string) {
      statements.push(sql)
      return { rows: sql.includes('LIMIT') ? samples : [summary] }
    },
  }
}

test('the 0002 precheck is read-only and passes when every member resolves', async () => {
  const client = fakeClient({ pairs: '0', null_company_conversations: '0' })
  await checkConversationMembersResolvable(client)
  assert.equal(client.statements.length, 1)
  for (const sql of client.statements) {
    assert.doesNotMatch(sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i)
  }
})

test('the 0002 precheck fails closed with counts and a masked sample', async () => {
  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    const client = fakeClient(
      { pairs: '3', conversations: '2', member_ids: '2', missing_everywhere: '2', other_tenant: '1', user_rows: '0',
        company_members_without_participant: '0', personal_tenant: '1', authored_messages: '1', null_company_conversations: '0' },
      [
        { conversation_id: 'c1', company_id: 'personal', member_id: 'agent-gone', participant_elsewhere: false, is_user: false, authored: true },
        { conversation_id: 'c2', company_id: 'acme', member_id: 'someone@example.com', participant_elsewhere: true, is_user: false, authored: false },
      ],
    )
    await assert.rejects(
      checkConversationMembersResolvable(client),
      (err: unknown) => (err as { code?: string }).code === '23503'
        && /3 conversation member id\(s\) in 2 conversation\(s\)/.test((err as Error).message),
    )
    assert.equal(client.statements.length, 2)
  } finally {
    console.error = originalError
  }
  assert.match(errors[0], /pairs=3 conversations=2 member_ids=2 missing_everywhere=2 other_tenant=1/)
  assert.match(errors[1], /conversation=c1 company=personal member=agent-gone \[no-participant-anywhere,authored-messages-here\]/)
  assert.match(errors[2], /member=som…@example\.com \[participant-in-other-tenant\]/)
  assert.doesNotMatch(errors.join('\n'), /someone@example\.com/)
})

test('a conversation without a tenant is reported even when every member resolves', async () => {
  const client = fakeClient({ pairs: '0', null_company_conversations: '4' })
  const originalError = console.error
  console.error = () => {}
  try {
    await assert.rejects(
      checkConversationMembersResolvable(client),
      (err: unknown) => /4 conversation\(s\) have no company_id/.test((err as Error).message),
    )
  } finally {
    console.error = originalError
  }
})

test('the repair flag defaults to off and rejects anything it does not recognize', () => {
  assert.equal(migration0002RepairMode(undefined), 'off')
  assert.equal(migration0002RepairMode(''), 'off')
  assert.equal(migration0002RepairMode('  OFF '), 'off')
  assert.equal(migration0002RepairMode('Archive-Detach'), 'archive-detach')
  // A typo must not read as "operator declined the repair".
  assert.throws(() => migration0002RepairMode('true'), /must be unset/)
  assert.throws(() => migration0002RepairMode('detach'), /got 'detach'/)
})

test('the repair archives every orphan with its ordinal before detaching it', async () => {
  const statements: string[] = []
  const client = {
    async query(sql: string) {
      statements.push(sql)
      return { rows: [{ archived: '534', conversations: '23' }] }
    },
  }
  const summary = await repairConversationMembers(client)
  assert.deepEqual(summary, { archived: 534, conversations: 23 })

  assert.equal(statements.length, 4)
  assert.match(statements[0], new RegExp(`CREATE TABLE IF NOT EXISTS ${MIGRATION_0002_ARCHIVE_TABLE}`))
  // The archive has to be written before the rows it describes are removed.
  assert.match(statements[1], new RegExp(`^\\s*INSERT INTO ${MIGRATION_0002_ARCHIVE_TABLE}`))
  assert.match(statements[2], /UPDATE conversations/)
  assert.match(statements[1], /member\.ord - 1/)
  assert.match(statements[1], /ON CONFLICT \(conversation_id, member_id\) DO NOTHING/)

  // Messages are evidence of what happened; the repair must never rewrite them.
  for (const sql of statements) {
    assert.doesNotMatch(sql, /(?:UPDATE|DELETE\s+FROM)\s+messages\b/i)
    assert.doesNotMatch(sql, /(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+participants\b/i)
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+conversations\b/i)
  }

  // `external:` markers are not participants by design and must survive.
  assert.match(statements[2], /member\.id LIKE 'external:%'/)
})
