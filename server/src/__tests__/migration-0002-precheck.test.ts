import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.CUMORA_RUNTIME_CLIENT = 'http'
process.env.OPENAI_API_KEY ??= 'test-key'

const { checkConversationMembersResolvable } = await import('../db/migrate.js')

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
