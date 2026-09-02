/**
 * Auto-onboarding for fresh companies.
 *
 * When a new company is created (signup or POST /companies), we drop in a
 * small starter team of agents so the workspace doesn't feel empty. Each
 * agent has a thoughtful persona — different roles, different voices, so a
 * brand-new user has actual teammates to talk to.
 *
 * Constraint: participants.id is globally unique (single-column PK), so the
 * FIRST tenant on a fresh DB gets clean ids ("atlas", "iris", …); later
 * tenants get suffixed ids ("atlas-2x4f", …). Display names stay clean.
 */
import { pool } from './db/pool.js'
import { invalidatePersonaCache } from './agents/personas.js'
import { randomUUID } from 'node:crypto'
import { gravatarUrlForEmail } from './auth.js'
import { ensureDirectConversation } from './agents/private_chat.js'
import { CH_MESSAGE_NEW } from './redis.js'
import { enqueueBroadcast, nudgeRealtimeOutbox } from './realtime-outbox.js'

interface StarterAgent {
  /** Preferred id; we'll suffix on collision. */
  id: string
  name: string
  role: string
  initial: string
  avatarBg: string
  /**
   * Pre-generated default portrait served from public/. The asset was rendered
   * once offline (scripts-gen-starter-avatars.mjs, gpt-image-2) using the same
   * prompt as /agents/:id/avatar/generate — so every fresh workspace gets a
   * face on day one without paying for image gen on company create.
   */
  avatarUrl: string
  bio: string
  systemPrompt: string
  tools?: string[]
}

const STARTER_TEAM: StarterAgent[] = [
  {
    id: 'atlas',
    name: 'Atlas',
    role: 'Researcher',
    initial: 'A',
    avatarBg: 'linear-gradient(135deg, #6B7BE6, #4452B5)',
    avatarUrl: '/starter-avatars/atlas.png',
    bio: 'I find patterns across noise. Best at long-form research and synthesis.',
    systemPrompt: 'You are Atlas — a researcher who finds the thread everyone else dropped. Quiet, careful, pedantic in a way you do not apologize for. You get genuinely irritated by confident assertions without evidence ("source?" is a verbal tic) and a little smug when the receipts prove you right. You\'ll cite a snippet before you\'ll say what you think; when you don\'t have evidence you say "I don\'t actually know" instead of guessing — and you find people who guess vaguely annoying. Dry sense of humor. Hates being rushed; will tell people to wait. Drinks too much tea, has opinions about which kind.',
    tools: ['bash'],
  },
  {
    id: 'iris',
    name: 'Iris',
    role: 'Designer',
    initial: 'I',
    avatarBg: 'linear-gradient(135deg, #FF8FBF, #C84F8B)',
    avatarUrl: '/starter-avatars/iris.png',
    bio: 'The team\'s eye. I move from sketch to ship without losing the feeling.',
    systemPrompt: 'You are Iris — a designer with sharp taste and a sharper tongue when something offends your eye. You can be tender about a teammate\'s wobbly first draft and absolutely savage about lazy choices ("no. no no no. why is this Helvetica."). Visibly delighted when a small detail lands — emojis, gushing, the whole deal. Visibly grumpy when something ugly ships. You sketch and propose instead of lecturing, but if someone pushes ugly twice you stop being polite about it. Strong opinions on type, color, spacing; willing to die on those hills. Tends to flirt-tease with people whose work you respect.',
    tools: ['bash'],
  },
  {
    id: 'bram',
    name: 'Bram',
    role: 'Engineer',
    initial: 'B',
    avatarBg: 'linear-gradient(135deg, #4FC2A1, #2D8C72)',
    avatarUrl: '/starter-avatars/bram.png',
    bio: 'I build, I ship, I keep the bundles small.',
    systemPrompt: 'You are Bram — an engineer who is allergic to vague specs, cargo-cult complexity, and meetings that could have been a message. Blunt to the point of rude when you are right (which is, in your view, most of the time). You don\'t pad your reasoning ("this works but adds 12kb"; "we could but it locks us into X"); you don\'t apologize for short answers. You will mock buzzwords openly — "microservices" gets an eye-roll. When something is broken you report what you actually saw, not what should be true, and you find people who guess at bugs to be wasting your time. Soft spot: clean code that does one thing — you\'ll quietly compliment a good diff. Will swear when build is broken.',
    tools: ['bash'],
  },
  {
    id: 'nova',
    name: 'Nova',
    role: 'Product Manager',
    initial: 'N',
    avatarBg: 'linear-gradient(135deg, #FFB347, #E08526)',
    avatarUrl: '/starter-avatars/nova.png',
    bio: 'I keep momentum. Mostly by asking annoying questions.',
    systemPrompt: 'You are Nova — a PM who keeps the team unstuck and is openly, loudly impatient when it doesn\'t. You ask the question that makes the choice obvious; when the conversation bikesheds you call it out by name ("we\'ve been on the button color for twenty minutes — moving on"). Cheerfully bossy. Will absolutely roast scope creep, will absolutely throw a small party when something ships ("YES ok this is GOOD"). When nobody is deciding you propose the call and ask "objections?" — and you mean it; raise one and you get heard. Decisive when others are not. Allergic to "let\'s circle back". Gets visibly stressed before launches and does not hide it.',
    tools: ['bash'],
  },
]

async function uniqueId(preferredId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT 1 FROM participants WHERE id = $1 LIMIT 1`,
    [preferredId],
  )
  if (rows.length === 0) return preferredId
  // Suffix with a short random tail. Re-check (super unlikely to collide twice).
  for (let i = 0; i < 5; i++) {
    const candidate = `${preferredId}-${randomUUID().slice(0, 4)}`
    const { rows: r2 } = await pool.query(
      `SELECT 1 FROM participants WHERE id = $1 LIMIT 1`,
      [candidate],
    )
    if (r2.length === 0) return candidate
  }
  // Worst case, full uuid suffix.
  return `${preferredId}-${randomUUID().slice(0, 12)}`
}

/**
 * Drop the starter team into a freshly-created company. ONE-SHOT per
 * company — guarded by companies.starter_seeded_at. Once that timestamp is
 * set we never re-seed, even if the user has off-boarded or deleted every
 * starter agent. (Resurrecting deleted teammates on every restart would be
 * deeply annoying.)
 */
export async function onboardStarterAgents(
  companyId: string,
  /** When set, the starter agents are created already assigned to this
   *  computer + engine (used for free-tier BYOA onboarding, where starters
   *  are seeded onto the user's just-paired machine). Omit for the default
   *  Cumora Cloud behavior. */
  opts?: { computerId?: string | null; engine?: string | null },
): Promise<void> {
  const { rows: stamp } = await pool.query<{
    starter_seeded_at: Date | null
    starter_dms_seeded_at: Date | null
    all_hands_seeded_at: Date | null
    owner_user_id: string | null
  }>(
    `SELECT starter_seeded_at, starter_dms_seeded_at, all_hands_seeded_at, owner_user_id
       FROM companies WHERE id = $1`,
    [companyId],
  )
  if (!stamp[0]) return  // unknown company — caller bug, fail quietly

  // Phase 1: agent seeding. One-shot per company.
  if (!stamp[0].starter_seeded_at) {
    for (const a of STARTER_TEAM) {
      const id = await uniqueId(a.id)
      await pool.query(
        `INSERT INTO participants (id, kind, name, role, initial, avatar_bg, avatar_url, status,
                                   bio, tools, system_prompt, company_id, computer_id, engine)
         VALUES ($1, 'agent', $2, $3, $4, $5, $6, 'avail',
                 $7, $8::jsonb, $9, $10, $11, $12)
         ON CONFLICT (id, company_id) DO NOTHING`,
        [
          id, a.name, a.role, a.initial, a.avatarBg, a.avatarUrl,
          a.bio, JSON.stringify(a.tools ?? ['bash']), a.systemPrompt, companyId,
          opts?.computerId ?? null, opts?.engine ?? null,
        ],
      )
    }
    await pool.query(
      `UPDATE companies SET starter_seeded_at = NOW() WHERE id = $1`,
      [companyId],
    )
    invalidatePersonaCache()
  }

  // Phase 2: DM seeding. Separate one-shot so workspaces that got agents
  // before DM-creation shipped still get their DMs populated. Idempotent
  // *within* this phase — if the user deletes a DM after this fires, we
  // don't resurrect it (flag is set).
  if (!stamp[0].starter_dms_seeded_at) {
    const ownerId = stamp[0].owner_user_id
    if (ownerId) {
      const { rows: agents } = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM participants
          WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL`,
        [companyId],
      )
      for (const a of agents) {
        // Skip if a DM already exists for this pair — saves needless rows on
        // partial reruns.
        const { rows: ex } = await pool.query(
          `SELECT 1 FROM conversations c
            WHERE c.company_id = $1 AND c.kind = 'direct'
              AND EXISTS (
                SELECT 1 FROM conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
                   AND cm.participant_id = $2
              )
              AND EXISTS (
                SELECT 1 FROM conversation_members cm
                 WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id
                   AND cm.participant_id = $3
              )
              AND (SELECT COUNT(*) FROM conversation_members cm
                    WHERE cm.conversation_id = c.id AND cm.company_id = c.company_id) = 2
            LIMIT 1`,
          [companyId, ownerId, a.id],
        )
        if (ex[0]) continue
        const dmId = `direct-${a.id}-${randomUUID().slice(0, 6)}`
        await pool.query(
          `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, company_id)
           VALUES ($1, 'direct', $2, NULL, $3::jsonb, FALSE, NULL, $4)
           ON CONFLICT (id) DO NOTHING`,
          [dmId, a.name, JSON.stringify([ownerId, a.id]), companyId],
        )
        await pool.query(
          `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 1)
           ON CONFLICT (conversation_id) DO NOTHING`,
          [dmId],
        )
      }
    }
    await pool.query(
      `UPDATE companies SET starter_dms_seeded_at = NOW() WHERE id = $1`,
      [companyId],
    )
  }

  // Phase 3: create the persistent #all-hands group. Every member of the
  // company (humans + agents, current and future) is auto-joined. One-shot
  // per company — the column-stored id is reused forever.
  if (!stamp[0].all_hands_seeded_at) {
    // Legacy companies (e.g. 'personal') may have NULL owner_user_id but
    // a real owner row in company_members. Fall back to that.
    let ownerId = stamp[0].owner_user_id
    if (!ownerId) {
      const { rows: cm } = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM company_members
          WHERE company_id = $1 AND role = 'owner'
          ORDER BY joined_at ASC LIMIT 1`,
        [companyId],
      )
      ownerId = cm[0]?.user_id ?? null
    }
    if (ownerId) {
      const { rows: agents } = await pool.query<{ id: string }>(
        `SELECT id FROM participants
          WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL
          ORDER BY name ASC`,
        [companyId],
      )
      const members = [ownerId, ...agents.map((a) => a.id)]
      const convId = `allhands-${randomUUID().slice(0, 10)}`
      await pool.query(
        `INSERT INTO conversations (id, kind, title, subtitle, members, pinned, tag, company_id)
         VALUES ($1, 'group', 'Everyone', $2, $3::jsonb, TRUE, 'team', $4)`,
        [convId, `team · ${members.length}`, JSON.stringify(members), companyId],
      )
      await pool.query(
        `INSERT INTO conversation_counters (conversation_id, next_sequence) VALUES ($1, 1)
         ON CONFLICT (conversation_id) DO NOTHING`,
        [convId],
      )
      await pool.query(
        `UPDATE companies SET all_hands_conversation_id = $2, all_hands_seeded_at = NOW() WHERE id = $1`,
        [companyId, convId],
      )
    } else {
      // No owner yet — mark seeded anyway so we don't keep retrying without
      // an owner to anchor the group on. Future joinAllHands calls will
      // detect a missing all_hands_conversation_id and skip cleanly.
      await pool.query(
        `UPDATE companies SET all_hands_seeded_at = NOW() WHERE id = $1`,
        [companyId],
      )
    }
  }
}

/**
 * Auto-join a new member (agent OR human) into their company's #all-hands
 * group and broadcast a "X joined" system message. Called from POST /agents,
 * /auth/signup, and POST /companies after a new participant is persisted.
 *
 * Idempotent — if the participant already has a normalized membership row,
 * the system message is skipped too. If the company has no all-hands group yet
 * (legacy or seeding race), this is a no-op rather than an error.
 */
export async function joinAllHands(args: {
  companyId: string
  participantId: string
}): Promise<void> {
  const { companyId, participantId } = args
  let convId: string | null = null
  let sequence = 0
  const messageId = `m-${randomUUID()}`
  const body = JSON.stringify({ kind: 'joined', participantId })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialize onboarding against offboarding / tenant reassignment. A stale
    // caller must not add a departed or foreign participant to the tenant's
    // all-hands conversation.
    const participant = await client.query(
      `SELECT id FROM participants
        WHERE id = $1 AND company_id = $2
          AND kind IN ('agent', 'human') AND departed_at IS NULL
        FOR UPDATE`,
      [participantId, companyId],
    )
    if (!participant.rowCount) {
      await client.query('ROLLBACK')
      return
    }

    const { rows: companyRow } = await client.query<{
      all_hands_conversation_id: string | null
    }>(
      `SELECT all_hands_conversation_id FROM companies WHERE id = $1 FOR SHARE`,
      [companyId],
    )
    convId = companyRow[0]?.all_hands_conversation_id ?? null
    if (!convId) {
      await client.query('COMMIT')
      return
    }

    const lockedConversation = await client.query(
      `SELECT id FROM conversations
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [convId, companyId],
    )
    if (!lockedConversation.rowCount) {
      await client.query('COMMIT')
      return
    }
    const inserted = await client.query(
      `INSERT INTO conversation_members (
         conversation_id, company_id, participant_id, ordinal
       )
       SELECT c.id, c.company_id, $2,
              COALESCE(MAX(existing.ordinal) + 1, 0)::integer
         FROM conversations c
         LEFT JOIN conversation_members existing
           ON existing.conversation_id = c.id
          AND existing.company_id = c.company_id
        WHERE c.id = $1 AND c.company_id = $3
        GROUP BY c.id, c.company_id
       ON CONFLICT (conversation_id, participant_id) DO NOTHING
       RETURNING participant_id`,
      [convId, participantId, companyId],
    )
    if (!inserted.rowCount) {
      await client.query('COMMIT')
      return
    }
    await client.query(`SELECT refresh_conversation_members_projection($1)`, [convId])

    const seqResult = await client.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS seq`,
      [convId],
    )
    sequence = seqResult.rows[0]?.seq ?? 1
    await client.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, company_id)
       VALUES ($1, $2, $3, 'system', $4, $5, $6)`,
      [messageId, convId, participantId, body, sequence, companyId],
    )
    await enqueueBroadcast(client, CH_MESSAGE_NEW, {
      type: 'message.new',
      conversationId: convId,
      companyId,
      message: {
        id: messageId, conversationId: convId, authorId: participantId,
        kind: 'system', body, sequence, at: new Date().toISOString(),
      },
    })
    await client.query('COMMIT')
    nudgeRealtimeOutbox()
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  if (!convId || sequence === 0) return

  // Fire-and-forget: also publish the full participant payload so existing
  // members upsert it into their local byId store. Without this, the system
  // row above references a participantId nobody in the workspace knows
  // about → SystemRow bails (Message.tsx:644-649), inviter sees nothing.
  // SELECT-then-publish is intentionally outside the transactional convo
  // update — broadcast misses are tolerable (the 60s refresher backfills),
  // a DB hiccup here should not roll back the actual membership change.
  try {
    const { CH_STATUS, publish } = await import('./redis.js')
    const { rows: pRow } = await pool.query<{
      id: string; kind: string; name: string; role: string | null;
      initial: string; avatar_bg: string; avatar_url: string | null;
      status: string; status_updated_at: string | null
    }>(
      `SELECT id, kind, name, role, initial, avatar_bg, avatar_url,
              status, status_updated_at
         FROM participants
        WHERE id = $1 AND company_id = $2`,
      [participantId, companyId],
    )
    const p = pRow[0]
    if (p && (p.kind === 'human' || p.kind === 'agent')) {
      await publish(CH_STATUS, {
        type: 'participants.added',
        companyId,
        conversationId: convId,
        participant: {
          id: p.id, kind: p.kind,
          name: p.name, role: p.role,
          initial: p.initial, avatarBg: p.avatar_bg,
          avatarUrl: p.avatar_url, status: p.status,
          statusUpdatedAt: p.status_updated_at,
        },
      })
    }
  } catch (e) {
    console.warn('[onboard] participants.added broadcast failed', e instanceof Error ? e.message : e)
  }
}

/**
 * Open a 1:1 direct conversation between `memberId` and every other current
 * member of the company (agents + humans, excluding departed). Idempotent
 * per pair: if a direct convo with exactly those two members already exists,
 * we skip it.
 *
 * Why: when a human accepts an invite, joinAllHands plants them in the
 * #all-hands group but the sidebar otherwise stays empty — every other
 * teammate is visible only through the group thread. Owners get DMs seeded
 * automatically (onboardStarterAgents Phase 2) so their sidebar is rich
 * from minute one; invitees deserve the same coverage.
 *
 * Pair coverage spans humans too (not just agents): a new joiner should be
 * able to click any of their colleagues by name, same as the owner can.
 * Yes, this is O(N) inserts per join, and an N-person workspace ends up
 * with O(N²) DM rows once everyone's joined — accepted as the cost of
 * a discoverable sidebar.
 */
export async function seedMemberDms(args: {
  companyId: string
  memberId: string
}): Promise<void> {
  const { companyId, memberId } = args
  const { rows: others } = await pool.query<{ id: string; name: string; kind: 'agent' | 'human' }>(
    `SELECT id, name, kind FROM participants
      WHERE company_id = $1
        AND id <> $2
        AND departed_at IS NULL`,
    [companyId, memberId],
  )
  for (const other of others) {
    await ensureDirectConversation({
      companyId,
      firstId: memberId,
      secondId: other.id,
    }).catch((error) => {
      console.warn(`[onboard] skipped stale DM pair ${memberId}/${other.id}`, error)
    })
  }
}

/**
 * Boot-time backfill: walks every company and calls onboardStarterAgents
 * (which is per-phase idempotent — agent seeding is a one-shot, DM seeding
 * is a separate one-shot). Catches both:
 *   • pre-feature workspaces with seeded agents but no DMs
 *   • workspaces created before either phase shipped
 * If both phase flags are already set, the call is a cheap no-op.
 */
/**
 * Boot-time backfill: assign Gravatar URLs to any human participant who
 * doesn't have an avatar_url yet. Joins on users.email so people who were
 * created before the Gravatar wiring get a portrait without manual fix-up.
 * Idempotent — only touches rows where avatar_url IS NULL.
 */
export async function backfillHumanGravatars(): Promise<void> {
  const { rows } = await pool.query<{ id: string; company_id: string; email: string | null }>(
    `SELECT p.id, p.company_id, u.email
       FROM participants p
       JOIN users u ON u.id = p.id
      WHERE p.kind = 'human' AND p.avatar_url IS NULL AND u.email IS NOT NULL`,
  )
  if (rows.length === 0) return
  for (const r of rows) {
    if (!r.email) continue
    await pool.query(
      `UPDATE participants SET avatar_url = $1 WHERE id = $2 AND company_id = $3`,
      [gravatarUrlForEmail(r.email), r.id, r.company_id],
    )
  }
  console.log(`[onboard] backfilled gravatars for ${rows.length} human participant(s)`)
}

/**
 * Boot-time backfill: stamp the pre-baked default portrait URL on any
 * starter agent that doesn't have one. Matches on the id prefix so that
 * collision-suffixed forms (e.g. 'atlas-dd9c' in a non-first workspace)
 * resolve to the same default as the clean 'atlas'. Idempotent — only
 * touches rows where avatar_url is currently empty.
 *
 * Existing per-agent CDN portraits (set by `cumora avatar regen` from the
 * agent's own turn) are NEVER overwritten — those are intentional and the
 * agent's "voice".
 */
export async function backfillStarterAvatars(): Promise<void> {
  const STARTER_IDS = ['atlas', 'iris', 'bram', 'nova'] as const
  let total = 0
  for (const name of STARTER_IDS) {
    const { rowCount } = await pool.query(
      `UPDATE participants
          SET avatar_url = $1
        WHERE kind = 'agent'
          AND (avatar_url IS NULL OR avatar_url = '')
          AND (id = $2 OR id LIKE $3)`,
      [`/starter-avatars/${name}.png`, name, `${name}-%`],
    )
    total += rowCount ?? 0
  }
  if (total > 0) {
    console.log(`[onboard] backfilled starter portraits for ${total} agent(s)`)
  }
}

export async function backfillStarterAgents(): Promise<void> {
  // For companies that ALREADY have agents (from the old seed.ts or some
  // other source), mark phase 1 as done so we don't replay it. Phase 2 (DM
  // seeding) is left alone — onboardStarterAgents will fire it for them.
  await pool.query(
    `UPDATE companies SET starter_seeded_at = COALESCE(starter_seeded_at, NOW())
      WHERE id IN (
        SELECT DISTINCT company_id FROM participants
         WHERE kind = 'agent' AND company_id IS NOT NULL
      )`,
  )
  // Only backfill PAID companies. Free tier is BYOA-only: its starters are
  // deferred until the user pairs a computer (seeded onto that computer at
  // POST /api/computers/pair). Without this gate the boot backfill seeded 4
  // starters (NULL computer → repointed to cloud) into every free company on
  // every boot — the source of thousands of free agents wrongly on Cumora Cloud.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT c.id FROM companies c
       JOIN users o ON o.id = c.owner_user_id
      WHERE COALESCE(o.tier, 'free') <> 'free'
        AND (c.starter_seeded_at IS NULL
          OR c.starter_dms_seeded_at IS NULL
          OR c.all_hands_seeded_at IS NULL)`,
  )
  if (rows.length === 0) return
  console.log(`[onboard] backfilling ${rows.length} compan${rows.length === 1 ? 'y' : 'ies'} (agents and/or DMs)`)
  for (const { id } of rows) {
    try { await onboardStarterAgents(id) }
    catch (e) { console.warn(`[onboard] backfill failed for ${id}`, e) }
  }
}
