/**
 * A fresh install has to survive its own first boot.
 *
 * `seedIfEmpty()` runs on the boot path, unconditionally, right after the
 * read-only schema check — and it only does anything when `conversations` is
 * empty, which is exactly the state a brand-new deployment starts in.
 *
 * Migration 0002 made `conversations.company_id` NOT NULL. The column has no
 * default anywhere (it is added bare in the legacy baseline), and the seed's
 * INSERT did not name it, so the first seeded row raised
 *
 *   error: null value in column "company_id" of relation "conversations"
 *   violates not-null constraint
 *   detail: Failing row contains (aurora, group, Aurora · Q3 Launch, …)
 *
 * which propagates out of seedIfEmpty() to main()'s catch and exits 1 — a boot
 * crash-loop on every new install.
 *
 * Before 0.14 this was survivable by accident: the column was nullable, and
 * boot ran the full DDL every time, including
 * `UPDATE conversations SET company_id = 'personal' WHERE company_id IS NULL`.
 * Moving migrations into a one-shot job removed both the tolerance and the
 * repair, so the seed now has to be correct on the first attempt.
 *
 * Run: INTEGRATION_DATABASE_URL=… npm run test:integration
 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { pool } from '../db/pool.js'
import { seedIfEmpty } from '../seed.js'
import { ensureSchemaOnce, resetAllTables, teardownAll } from './_helpers.js'

/** Put the database back into the shape a migrated-but-unused one has.
 *
 *  resetAllTables() also truncates `companies`, and the baseline DDL's
 *  `INSERT INTO companies ('personal', …) ON CONFLICT DO NOTHING` only runs
 *  with the migration — so restore that one row, or the seed fails on a
 *  foreign key for a reason a real fresh install never hits. */
async function asFreshInstall(): Promise<void> {
  await resetAllTables()
  await pool.query(
    `INSERT INTO companies (id, name, slug) VALUES ('personal', 'Personal', 'personal')
     ON CONFLICT (id) DO NOTHING`,
  )
}

before(async () => { await ensureSchemaOnce() })
beforeEach(async () => { await asFreshInstall() })
after(async () => { await resetAllTables(); await teardownAll() })

test('[integration] seeding an empty database does not abort the boot', async () => {
  // The bug was a thrown 23502 here, not a wrong value — reaching the next
  // line at all is most of the assertion.
  await seedIfEmpty()
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM conversations`,
  )
  assert.ok(Number(rows[0].count) > 0, 'seed inserted no conversations')
})

test('[integration] every seeded conversation carries a workspace', async () => {
  await seedIfEmpty()
  const { rows } = await pool.query<{ id: string; company_id: string | null }>(
    `SELECT id, company_id FROM conversations ORDER BY id`,
  )
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(row.company_id, 'personal', `${row.id} landed in the wrong workspace`)
  }
})

test('[integration] the membership trigger fills rows the seed never wrote', async () => {
  // The seed still writes the legacy JSONB array; the AFTER INSERT trigger
  // added by 0002 derives the normalized rows from it. Those rows are NOT NULL
  // on company_id too, so a conversation seeded without one would fail here
  // even if the conversation insert somehow succeeded.
  await seedIfEmpty()
  const { rows } = await pool.query<{ id: string; member_rows: string; projection_len: number }>(
    `SELECT c.id,
            COUNT(cm.participant_id)::text AS member_rows,
            jsonb_array_length(c.members) AS projection_len
       FROM conversations c
       LEFT JOIN conversation_members cm
         ON cm.conversation_id = c.id AND cm.company_id = c.company_id
      GROUP BY c.id, c.members
      ORDER BY c.id`,
  )
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(
      Number(row.member_rows), row.projection_len,
      `${row.id}: ${row.member_rows} normalized rows vs ${row.projection_len} in the projection`,
    )
  }
  const orphans = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM conversation_members WHERE company_id IS NULL`,
  )
  assert.equal(orphans.rows[0].count, '0')
})

test('[integration] a second boot leaves the seeded rows alone', async () => {
  await seedIfEmpty()
  const first = await pool.query<{ id: string; company_id: string | null }>(
    `SELECT id, company_id FROM conversations ORDER BY id`,
  )
  await seedIfEmpty()
  const second = await pool.query<{ id: string; company_id: string | null }>(
    `SELECT id, company_id FROM conversations ORDER BY id`,
  )
  assert.deepEqual(second.rows, first.rows)
})
