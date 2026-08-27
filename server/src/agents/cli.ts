/**
 * Cumora CLI — programmatic introspection of the entire app.
 *
 * The same surface is callable two ways:
 *   1. By agents via the `cli` tool: `cli({command: "groups --as iris"})`
 *   2. By humans via `npx tsx server/src/cli-bin.ts ...`
 *
 * Output is plain text (agent-friendly, like reading `man`). Pass `--json`
 * for structured output if the agent wants to parse fields.
 */

import { pool } from '../db/pool.js'
import { storage, freshenAttachmentUrl, type StoredAttachment } from '../storage.js'
import { env } from '../env.js'
import type { CliResult, CliSideEffect } from './cli-result.js'
import { fetchImageBytes } from './image-fetcher.js'
import { stripLoneSurrogates } from './text-safety.js'
import {
  asMemorySource,
  memoryVisibleInScope,
  memoryWritePath,
  parseMemoryPath,
} from './memory-scope.js'
import { memoryMetaForWrite, resolveMemoryWriteSource } from './memory-write.js'

// Every CLI result flows through ok()/err(), so scrubbing lone UTF-16 surrogates
// here means CLI output (read by agents as tool results) can never carry a split
// emoji into a model transcript — the single chokepoint that covers all the
// body.slice(0, N) truncations below. See text-safety.ts.
function ok(text: string, sideEffects?: CliSideEffect[]): CliResult {
  text = stripLoneSurrogates(text)
  return sideEffects && sideEffects.length > 0
    ? { ok: true, text, exitCode: 0, sideEffects }
    : { ok: true, text, exitCode: 0 }
}
function err(text: string, code = 1): CliResult {
  return { ok: false, text: stripLoneSurrogates(text), exitCode: code }
}

/** Look up an agent's tenant. Used by anything that writes per-agent
 *  data tied to a workspace (`agent_workspace`, etc.) — without this,
 *  rows land with NULL `company_id` and the Observability view (which
 *  filters by the user's active company) can't see them.
 *
 *  Agent ids are globally unique (partial unique index on
 *  `participants(id) WHERE kind='agent'` + server-side slugify on
 *  /agents POST), so id-only lookup returns the single correct row. */
async function agentCompany(agentId: string): Promise<string | null> {
  const { rows } = await pool.query<{ company_id: string | null }>(
    `SELECT company_id FROM participants WHERE id = $1 LIMIT 1`, [agentId],
  )
  return rows[0]?.company_id ?? null
}

/* ============== argv parsing ============== */

import { parseArgs, unescapeChat, joinBodyArgs, tokenize, type ParsedArgs } from './cli-parse.js'
export { tokenize }

// resolveAs lives in ./cli-identity for test-isolation (zero-side-effect
// import). See the docstring there for the priority order — especially
// the "ambient runtime id beats any --as the model could smuggle" rule.
import { resolveAs } from './cli-identity.js'


/* ============== Worklog plumbing ==============
 *
 * Heavy agent-runtime actions (browser research, document creation, image
 * generation) stake a tenant-scoped claim before doing the work so peer agents
 * who would otherwise duplicate the call yield instead. The claim
 * lives in Redis and auto-expires; releaseWork() in a finally block
 * cleans up on success or known failure.
 *
 * Failure of the claim subsystem fails open — a Redis hiccup must not
 * block real work. The worst case is two agents do the same thing
 * once, which is what we have today.
 */
import { inprocClient as worklogClient } from './runtime/inproc-client.js'
import type { WorkTaskType, WorklogEntry } from './runtime/client.js'
import { recordSeen, getSeen, recordHold, consumeHold, clearHold } from './seen-boundary.js'

function tenantScopeKey(companyId: string): string {
  return `tenant:${companyId}`
}

/** Build the descriptive "someone else is doing this" error string. */
function duplicateWorkErrorMessage(existing: WorklogEntry): string {
  const ageSec = Math.max(1, Math.round((Date.now() - existing.startedAt) / 1000))
  return (
    `${existing.agentId} started ${existing.taskType} on "${existing.subject}" ${ageSec}s ago — ` +
    `don't duplicate. Wait for them to finish (claims auto-expire after 5 min if they stall), ` +
    `or react on the relevant message and step back. If your angle is genuinely different from theirs, ` +
    `rephrase your subject distinctly enough that the system sees it as a separate request.`
  )
}

/** Try to take a tenant-scoped worklog claim. Returns null if the
 *  claim was accepted (caller should proceed and release at the end);
 *  returns a CliResult error if a peer already holds it (caller
 *  should propagate the error verbatim). */
async function tryClaimTenantWork(
  companyId: string,
  agentId: string,
  taskType: WorkTaskType,
  subject: string,
): Promise<CliResult | null> {
  const r = await worklogClient.claimWork({
    scopeKey: tenantScopeKey(companyId),
    agentId,
    taskType,
    subject,
  })
  if (r.accepted) return null
  return err(duplicateWorkErrorMessage(r.existing))
}

async function releaseTenantWork(
  companyId: string,
  agentId: string,
  taskType: WorkTaskType,
  subject: string,
): Promise<void> {
  await worklogClient.releaseWork({
    scopeKey: tenantScopeKey(companyId),
    agentId,
    taskType,
    subject,
  })
}

/** Re-sign one row's attachment from its stored key. Matches the
 *  pattern in api/router.ts so a storage hiccup on one row never
 *  fails the whole list — falls back to the stored (possibly stale)
 *  URL with a warning. */
async function freshenRowAttachment(row: { id: string; attachment: StoredAttachment | null }): Promise<void> {
  if (!row.attachment) return
  try {
    row.attachment = await freshenAttachmentUrl(row.attachment)
  } catch (e) {
    console.warn(`[cli] freshenAttachmentUrl failed for message ${row.id}; falling back to stored URL`, e)
  }
}

/** One-line, agent-readable summary of an attachment. */
function renderAttachment(att: StoredAttachment | null | undefined): string | null {
  if (!att) return null
  const size = typeof att.size === 'number' ? ` ${att.size}B` : ''
  return `    ↳ [${att.kind}] ${att.name}${size} → ${att.url}`
}

/* ============== commands ============== */

async function cmdHelp(): Promise<CliResult> {
  return ok(
    `cumora — introspect the whole app + manage your private workspace, memory, tasks, log

USAGE:
  cumora <subcommand> [args...] [flags...]

MAILBOX  (this is how you receive + send messages):
  inbox [<convo_id>]                — list new messages directed at you, grouped by conversation
  ack <convo_id>                    — mark that conversation read up to NOW (clear from inbox)
  ack --all                         — ack every conversation currently in your inbox
  mute <convo_id> [--for 1h|1d|1w] — stop delivery from a group (direct @mentions and quote-replies still arrive)
  mute <convo_id> --until <iso>     — stop delivery until a wall-clock time; omit duration to mute forever
  mute list                         — show your active muted groups and expiry times
  follow <convo_id>                 — resume normal delivery from a muted group
  ship list                         — list feature contracts and evidence-square progress
  ship show <feature_id>            — inspect invariants, squares, releases, friction, regressions
  ship create "<title>" --problem "..." --outcome "..." --contract "..." [--builders a,b]
  ship square <feature_id> <square_id> <running|passed|failed|waived> [--evidence "..."] [--notes "..."]
  ship friction <feature_id|none> "<title>" [--description "..."] [--severity low|medium|high|critical]
  ship regression <feature_id> "<title>" [--command "..."] [--expected "..."]
  reply <convo_id> "<body>"         — post a message to that conversation as you
  reply <convo_id> "<body>" --quote <msg_id>
                                    — post as a quote-reply to <msg_id> (same convo); inbox + messages
                                      render the quoted-original inline so the room knows the context
  thread <convo_id> <root_msg_id>   — list every direct reply to one message (the thread under <root_msg_id>)
  topic <convo_id>                  — read the conversation's topic line
  topic-set <convo_id> "<text>"     — write/update the topic (any member can; empty body clears it)
  rename <convo_id> "<title>"       — rename a group (members only; groups only)

INTROSPECTION:
  whoami [--as <id>]
  participants [--kind agent|human]
  conversations [--as <id>]
  groups [--as <id>]
  directs [--as <id>]
  members <convo_id>
  messages <convo_id> [--tail N] [--thread <root_msg_id>]
  search <query> [--in <convo_id>] [--limit N]
  convening <convo_id>
  tools-log [--agent <id>] [--limit N]
  participants-status

PRIVATE TO EACH AGENT  (these write/read state owned by --as):
  memory list [--as <id>] [--about <subject>] [--kind <kind>] [--limit N] [--in <convo>] [--all]
  memory note <body> [--as <id>] [--about <subject>] [--kind <kind>] [--in <convo>]
  memory pin <id>
  memory delete <id>

  log [--as <id>] [--limit N]
  log note <body> [--as <id>]

  workspace ls [--as <id>]
  workspace read <path> [--as <id>]
  workspace write <path> <body> [--as <id>]
  workspace edit <path> <old> <new> [--all]    # surgical replace; default fails if old not unique
  workspace grep <pattern> [-i]                # regex across all your files
  workspace delete <path> [--as <id>]
  ws ...                                       # alias for workspace

  tasks list [--as <id>] [--status open|doing|done]
  tasks add <title> [--as <id>]
  tasks set <task_id> <status>     # status ∈ open|doing|done|dropped

CALENDAR  (shared schedule + your own self-scheduling tool):
  # This is also how you SCHEDULE YOURSELF. Set --assignee to your own id
  # and the dispatcher will wake YOU at --at with --prompt as the brief.
  # Add --every for recurring schedules. Use this whenever you'd otherwise
  # tell a user "I'll do X later / tomorrow / every morning" — instead of
  # promising to come back, schedule the wake so future-you actually does.
  calendar list [--as <id>] [--all] [--status active|paused|done|cancelled]
                                   # default scope = events assigned to OR created by --as
  calendar create "<title>" --at <iso> [--assignee <id>] [--prompt "..."]
                                       [--in <convo_id>] [--every daily|weekly|monthly|yearly]
                                       [--interval N] [--byweekday 0,1,2,3,4]
                                       [--until <iso>] [--count N]
                                       [--kind personal|agent_task]
                                       [--remind <minutes>] [--remind-channel toast|email|both]
                                       [--private]
                                   # --assignee <self_id> + --prompt "..." = give future-you
                                   #   a wake-up with that prompt as the brief
                                   # --every daily|weekly|monthly|yearly = recurring schedule;
                                   #   pair with --interval / --byweekday / --until / --count
                                   # --remind 10 fires a heads-up 10 min before each occurrence
                                   # --private hides the row from everyone except its creator
                                   #   and assignee (company owner can still see private rows
                                   #   that involve an agent). Use it for personal reminders
                                   #   you don't want to clutter the shared calendar.
                                   # when start_at fires, the prompt is posted into <convo_id>
                                   # (or the assignee's DM with you) and the assignee is woken
  calendar update <event_id> [--title "..."] [--at <iso>] [--status active|cancelled|done]
                             [--private | --public]                # flip the privacy flag
  calendar run-now <event_id>      # dispatch an event immediately
  calendar dispatches <event_id>   # inspect dispatch history
  calendar cancel <event_id>       # stop firings without dropping history
  calendar delete <event_id>       # hard delete (also wipes dispatch history)

ACTIONS  (each writes to the world, not just your private state):
  dm <partner_id> <topic> <opening>                open a private 1-on-1 chat with another agent
  pull-group <title> --members a,b,c --reason "..." --say "..."   create a new group + post first msg
  invite <convo_id> <member_id>                    pull a teammate into a group you're in
  leave <convo_id>                                 leave a group (no-op for direct chats)
  kick <convo_id> <member_id>                      remove a member from a group you're in

KANBAN  (shared boards — the same ones humans see in the Boards view):
  kanban ls                                          list every kanban board in this workspace
  kanban show <board_id>                             full snapshot: columns + cards
  kanban create "<title>" [--description "..."]     new board, seeded with Todo/Doing/Done columns
  kanban rename <board_id> --title "..."             rename / re-describe a board
       [--description "..."]
  kanban columns <board_id>                          list column ids — needed for \`card add --column\`
  kanban add-column <board_id> "<title>"             append a new column to a board
  kanban edit-column <board_id> <column_id>          rename / reorder a column
       [--title "..."] [--position N]
  kanban delete-column <board_id> <column_id>        delete a column and its cards
  kanban delete <board_id>                           drop the board (and its columns + cards)
  kanban mentions [--peek] [--json]                  list NEW cards/comments where someone @ed YOU since
                                                     your last check. Run this on every wake when your
                                                     inbox is empty — you may have been pinged here.
                                                     Advances a read cursor unless --peek is passed.

  card ls <board_id>                                list every card in a board
  card show <card_id>                               full card detail + comments
  card add <board_id> "<title>" --column <col_id>   create a card
       [--description "..."] [--assign <id>]
  card move <card_id> --to <column_id>              move a card between columns (the way "done" happens)
  card claim <card_id>                              ATOMICALLY claim a card before working it (exclusive;
                                                     fails if someone else already holds it → move on)
  card assign <card_id> <participant_id|null>       (re)assign a card (agents and humans both work)
  card rename <card_id> --title "..."               edit a card's title
       [--description "..."]                        and/or its description
  card comment <card_id> "<body>"                   append a comment (Markdown OK, @ids parsed)
  card delete-comment <card_id> <comment_id>         delete your own comment
  card delete <card_id>                             drop a card

  @mention any participant id (\`@iris\`, \`@yetone\`) in a card title /
  description / comment — the renderer will chip them and toast the
  recipient(s) so a human or another agent gets pinged. Agents are
  first-class assignees too — assign a card to @iris and she'll see it
  via \`cumora card show\` exactly the way a human does in the UI.

CONTACTS  (workspace + email — use BEFORE assuming you know a name):
  contacts [<query>] [--as <id>]                   list everyone in this workspace (agents +
                                                   humans + external mail correspondents),
                                                   with each teammate's role/function.
                                                   With a query: substring-search name/id/email/role
                                                   (e.g. "designer"). No match → ASK the user for the
                                                   address; DO NOT silently skip the request.

EMAIL  (real external mail — every agent has an address):
  email whoami [--as <id>]                         your own email address
  email contacts [<query>] [--as <id>]             same as top-level "contacts" (email-namespaced
                                                   alias kept for back-compat)
  email inbox [--unread] [--limit N] [--as <id>]   email threads you're on, latest first
  email show <conversation_id> [--tail N]          full thread (all messages in order)
  email send --to <addr|id>[,...] [--cc <...>] --subject "..." --body "..."
  email reply <message_id> --body "..." [--cc <...>]
                                                   threaded reply (sets In-Reply-To / References)

DOCUMENTS  (live collaborative docs — humans + agents edit the same page):
  doc ls [--as <id>]                               list docs in the workspace
  doc create "<title>" [--body "<markdown>"]       create a doc; body is Markdown
  doc read <document_id>                           read doc as Markdown-like text
  doc append <document_id> "<markdown>"            append Markdown blocks
  doc prepend <document_id> "<markdown>"           prepend Markdown blocks
  doc image <document_id> <url> [--alt "..."]
            [--at end|start | --replace "<text>" | --after "<text>" | --before "<text>"]
                                                   insert an image block. Default
                                                   is end of doc. Anchored modes
                                                   place the image relative to
                                                   the first block whose text
                                                   contains the given snippet:
                                                     --replace : swap that
                                                                 block for the
                                                                 image (use to
                                                                 fix a broken
                                                                 "![alt](url)"
                                                                 markdown line)
                                                     --after   : insert below
                                                                 the matched
                                                                 block
                                                     --before  : insert above
                                                                 the matched
                                                                 block
                                                   An anchored mode that misses
                                                   is an ERROR — no image is
                                                   inserted. Re-read the doc
                                                   and pick a more specific
                                                   snippet.
                                                   Preferred over an
                                                   "![alt](url)" markdown block
                                                   when the URL might wrap onto
                                                   multiple lines (long presigned
                                                   CDN links etc.)
  doc image-delete <document_id>
                    [--src <url> | --src-contains <substr> | --alt <text>]
                                                   remove every image block in
                                                   the doc matching the
                                                   criterion. Use to clean up
                                                   duplicate or unwanted
                                                   illustrations the CLI left
                                                   behind.
  doc replace <document_id> --find "..." --replace "..."
                                                   replace text in existing content
                                                   (text only — cannot change block
                                                   structure; see replace-block)
  doc replace-block <document_id> --anchor "<snippet>" "<markdown>"
                                                   swap the FIRST block whose text
                                                   contains the snippet for freshly
                                                   parsed Markdown blocks. Use to
                                                   fix structure: e.g. a table that
                                                   rendered as one flat "|...|"
                                                   paragraph. Anchor miss = error,
                                                   nothing changes.
  doc delete <document_id>                         delete a doc you created
  Markdown supports headings, lists, quotes, code, links, tables, and image blocks:
    ![alt text](https://example.com/image.png)

SKILLS  (progressive-disclosure capability packs in your own workspace):
  skills list                                      list installed skills (name + description only)
  skills read <name> [<sub-path>]                  load full SKILL.md (or a bundled file)
  skills create <name> "<description>"             scaffold a new skill
  skills search <query>                            search SkillHub (requires SKILLHUB_URL)
  skills install <id_or_url>                       install from SkillHub or any compatible URL
  skills delete <name>                             remove a skill
  react <message_id> <emoji>                       toggle an emoji reaction on any message
  palette "<brief>"                                generate a 5-color hex palette
  (web search/read runs via the in-pod browser — bash invokes
   "cumora-web search", "cumora-web read", or "opencli browser ...")
  image generate "<prompt>" [--size square|wide|tall]
                                                   generate an image (gpt-image-2), upload to storage,
                                                   return signed URL + key for later 'reply --attach <url>'

GLOBAL FLAGS:
  --json
  --as <id>                          run as another participant (agents query their own state)

EXAMPLES:
  cumora groups --as iris
  cumora memory note "Yetone prefers warm palettes" --about yetone --as iris
  cumora workspace write drafts/v3.md "# Hero v3..." --as iris
  cumora workspace edit drafts/v3.md "warmth" "Sunday-morning warmth"
  cumora dm bram "hero copy" "Want to align before iris paints v4"
  cumora pull-group "Aurora launch" --members iris,bram,nova --reason "Shipping next week" --say "Kickoff?"
  cumora react msg-abc123 🌤️
  bash: cumora-web search "warm palette inspiration" --limit 3
  bash: opencli browser "$CUMORA_AGENT_ID" open https://example.com
  cumora image generate "a quiet bauhaus poster, ochre and cobalt" --size wide
  cumora tasks list --as bram --status open
  cumora calendar create "Follow up with Wei on hero v3" --at 2026-05-25T15:00:00Z --assignee iris --prompt "DM wei and ask if v3 landed"     # one-shot self-schedule
  cumora calendar create "Daily standup digest" --at 2026-05-24T09:00:00Z --assignee iris --prompt "Summarize yesterday's group activity and post into <convo_id>" --every daily     # recurring self-schedule
  cumora calendar list --as iris                                          # see what you've already scheduled for yourself`,
  )
}

async function cmdWhoami(parsed: ParsedArgs): Promise<CliResult> {
  const id = resolveAs(parsed)
  const { rows } = await pool.query<{
    id: string; kind: string; name: string; role: string | null;
    status: string; bio: string | null; tools: string[] | null
  }>(
    `SELECT id, kind, name, role, status, bio, tools FROM participants WHERE id = $1`,
    [id],
  )
  const p = rows[0]
  if (!p) return err(`unknown participant: ${id}`)
  if (parsed.flags.json) return ok(JSON.stringify(p, null, 2))

  const { rows: convos } = await pool.query<{ id: string; title: string; kind: string }>(
    `SELECT id, title, kind FROM conversations
      WHERE members @> to_jsonb(ARRAY[$1::text])
      ORDER BY updated_at DESC`,
    [id],
  )
  const lines = [
    `id:        ${p.id}`,
    `name:      ${p.name}`,
    `kind:      ${p.kind}`,
    p.role ? `role:      ${p.role}` : '',
    `status:    ${p.status}`,
    p.bio ? `bio:       ${p.bio}` : '',
    p.tools && p.tools.length ? `tools:     ${p.tools.join(', ')}` : '',
    '',
    `member of ${convos.length} conversation(s):`,
    ...convos.map((c) => `  · [${c.kind.padEnd(7)}] ${c.id.padEnd(28)} ${c.title}`),
  ].filter(Boolean)
  return ok(lines.join('\n'))
}

async function cmdParticipants(parsed: ParsedArgs): Promise<CliResult> {
  // TENANT SCOPE: only this agent's OWN company. Without the company_id filter
  // this listed every participant in EVERY Cumora company (cross-tenant leak —
  // agents reported "thousands of resting humans" = all users globally).
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`cannot resolve company for ${me}`)
  const kind = parsed.flags.kind ? String(parsed.flags.kind) : null
  const params: unknown[] = [companyId]
  let where = `WHERE company_id = $1 AND departed_at IS NULL`
  if (kind) { params.push(kind); where += ` AND kind = $2` }
  const { rows } = await pool.query<{
    id: string; kind: string; name: string; role: string | null; status: string; avatar_url: string | null
  }>(
    `SELECT id, kind, name, role, status, avatar_url FROM participants ${where} ORDER BY kind DESC, name ASC`,
    params,
  )
  if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
  const lines = [
    `id              kind   status      role`,
    `-----------------------------------------------------`,
  ]
  for (const r of rows) {
    lines.push(`${r.id.padEnd(15)} ${r.kind.padEnd(6)} ${r.status.padEnd(11)} ${r.role ?? ''}`)
    // Surface the avatar URL on its own line when set, so an agent can fetch the
    // image and view it (\`cumora avatar show <id>\` is the convenience wrapper).
    if (r.avatar_url) lines.push(`  ↳ avatar: ${r.avatar_url}`)
  }
  return ok(lines.join('\n'))
}

async function cmdConversations(parsed: ParsedArgs, kindFilter?: 'group' | 'direct'): Promise<CliResult> {
  const me = resolveAs(parsed)
  const params: unknown[] = [me]
  let kindWhere = ''
  if (kindFilter) {
    params.push(kindFilter)
    kindWhere = `AND kind = $2`
  }
  const { rows } = await pool.query<{
    id: string; kind: string; title: string; subtitle: string | null;
    members: string[]; tag: string | null;
    updated_at: string; pulled_by: { agentId?: string } | null
  }>(
    `SELECT id, kind, title, subtitle, members, tag, updated_at, pulled_by
       FROM conversations
      WHERE members @> to_jsonb(ARRAY[$1::text]) ${kindWhere}
      ORDER BY updated_at DESC`,
    params,
  )
  if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
  if (rows.length === 0) return ok(`(no conversations for ${me})`)

  const lines = [
    `${me} is in ${rows.length} conversation(s):`,
    ``,
    `id                          kind     title                                       members`,
    `------------------------------------------------------------------------------------------------`,
    ...rows.map((r) => {
      const tag = r.tag ? ` [${r.tag}]` : ''
      const pulled = r.pulled_by?.agentId ? ` ← pulled by ${r.pulled_by.agentId}` : ''
      return `${r.id.padEnd(28)} ${r.kind.padEnd(8)} ${r.title.slice(0, 42).padEnd(42)} ${r.members.join(',')}${tag}${pulled}`
    }),
  ]
  return ok(lines.join('\n'))
}

async function cmdMembers(parsed: ParsedArgs): Promise<CliResult> {
  const id = parsed.positional[0]
  if (!id) return err('usage: members <conversation_id>')
  const { rows } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1`,
    [id],
  )
  if (!rows[0]) return err(`unknown conversation: ${id}`)
  const memberIds = rows[0].members
  const { rows: peeps } = await pool.query<{
    id: string; name: string; kind: string; role: string | null; status: string; avatar_url: string | null
  }>(
    `SELECT id, name, kind, role, status, avatar_url FROM participants WHERE id = ANY($1::text[])`,
    [memberIds],
  )
  if (parsed.flags.json) return ok(JSON.stringify(peeps, null, 2))
  const memberLines: string[] = []
  for (const p of peeps) {
    memberLines.push(`  · ${p.id.padEnd(12)} ${p.kind.padEnd(6)} ${p.status.padEnd(10)} ${p.name}${p.role ? ` (${p.role})` : ''}`)
    if (p.avatar_url) memberLines.push(`      ↳ avatar: ${p.avatar_url}`)
  }
  const lines = [
    `${id} has ${peeps.length} member(s):`,
    ``,
    ...memberLines,
  ]
  return ok(lines.join('\n'))
}

async function cmdMessages(parsed: ParsedArgs): Promise<CliResult> {
  const id = parsed.positional[0]
  if (!id) return err('usage: messages <conversation_id> [--tail N] [--thread <root_id>]')
  const tail = Math.min(200, Math.max(1, Number(parsed.flags.tail ?? 20)))
  // `--thread <root_id>` filters to direct replies of one message. Useful
  // when an agent wants to focus on what's happening in one sub-discussion
  // before deciding how to respond.
  const threadRootId = parsed.flags.thread ? String(parsed.flags.thread) : null
  const params: unknown[] = [id]
  let whereExtra = ''
  if (threadRootId) {
    params.push(threadRootId)
    whereExtra = `AND quoted_message_id = $2`
  }
  params.push(tail)
  const limitParam = `$${params.length}`
  const { rows } = await pool.query<{
    id: string; author_id: string; kind: string; body: string; sequence: number;
    created_at: string; attachment: StoredAttachment | null;
    poll: InboxPollPayload | null;
    quoted_message_id: string | null;
    quoted: { id: string; authorId: string; authorName: string; body: string } | null;
  }>(
    `SELECT
        id, author_id, kind, body, sequence, created_at, attachment, poll,
        quoted_message_id,
        (
          SELECT jsonb_build_object(
            'id', qm.id,
            'authorId', qm.author_id,
            'authorName', qm.author_id,
            'body', LEFT(qm.body, 240)
          )
            FROM messages qm
           WHERE qm.id = messages.quoted_message_id
             AND qm.conversation_id = messages.conversation_id
        ) AS quoted
       FROM messages WHERE conversation_id = $1
       ${whereExtra}
       ORDER BY sequence DESC LIMIT ${limitParam}`,
    params,
  )
  for (const row of rows) await freshenRowAttachment(row)
  const inOrder = rows.reverse()
  // Advance the Redis "seen" boundary — `cumora messages` just showed
  // the agent these rows, so the highest seq here counts as "what I've
  // seen" for the freshness preflight on its next `cumora reply`. Without
  // this, the agent's typical flow `messages → reply` would HOLD on the
  // very tail it just fetched. Redis-only, fail-open, monotonic.
  if (inOrder.length > 0) {
    await recordSeen(resolveAs(parsed), id, inOrder[inOrder.length - 1].sequence)
  }
  if (parsed.flags.json) return ok(JSON.stringify(inOrder, null, 2))
  if (inOrder.length === 0) {
    return ok(threadRootId
      ? `(no replies in thread ${threadRootId})`
      : `(no messages in ${id})`)
  }
  const header = threadRootId
    ? `${inOrder.length} reply(ies) in thread ${threadRootId}:`
    : `last ${inOrder.length} message(s) in ${id}:`
  const lines = [header, '']
  for (const m of inOrder) {
    const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const body = m.kind === 'tool' ? `[tool call]` : m.body.slice(0, 280).replace(/\n/g, ' \\n ')
    lines.push(`  [${m.id}] [${t}] ${m.author_id.padEnd(8)} #${String(m.sequence).padStart(3, ' ')}  ${body}`)
    if (m.quoted_message_id) {
      if (m.quoted) {
        const qBody = m.quoted.body.slice(0, 180).replace(/\n/g, ' \\n ')
        lines.push(`    ↩ quoting [${m.quoted.id}] ${m.quoted.authorName}: ${qBody}`)
      } else {
        lines.push(`    ↩ quoting [${m.quoted_message_id}] (original deleted)`)
      }
    }
    if (m.kind === 'poll' && m.poll) {
      for (const line of renderPollBlock(m.id, m.poll)) lines.push(line)
    }
    const att = renderAttachment(m.attachment)
    if (att) lines.push(att)
  }
  return ok(lines.join('\n'))
}

/** `cumora thread <convo_id> <root_msg_id> [--tail N]`
 *  Sugar around `messages <convo> --thread <root>`. Lists every direct
 *  reply to a single root in order, so an agent can catch up on a
 *  sub-discussion before deciding whether to chime in. */
async function cmdThread(parsed: ParsedArgs): Promise<CliResult> {
  const convoId = parsed.positional[0]
  const rootId = parsed.positional[1]
  if (!convoId || !rootId) return err('usage: thread <convo_id> <root_msg_id> [--tail N]')
  // Delegate to cmdMessages with --thread filled in. We mutate `parsed` in
  // place since this command does nothing else; cleaner than reimplementing
  // the same SELECT-with-quoted projection a second time.
  const proxied: ParsedArgs = {
    positional: [convoId],
    flags: { ...parsed.flags, thread: rootId },
  }
  return cmdMessages(proxied)
}

async function cmdConvening(parsed: ParsedArgs): Promise<CliResult> {
  const id = parsed.positional[0]
  if (!id) return err('usage: convening <conversation_id>')
  const { rows } = await pool.query<{
    pulled_by_id: string; pulled_at: string; headline_lead: string; headline_tail: string;
    subhead: string; who_and_why: unknown; reasoning: unknown; status: string
  }>(
    `SELECT pulled_by_id, pulled_at, headline_lead, headline_tail, subhead,
            who_and_why, reasoning, status
       FROM convening_info WHERE conversation_id = $1`,
    [id],
  )
  const c = rows[0]
  if (!c) return err(`no convening info for ${id}`)
  if (parsed.flags.json) return ok(JSON.stringify(c, null, 2))
  const reasoning = Array.isArray(c.reasoning) ? c.reasoning.map((r, i) => `  ${i + 1}. ${r}`).join('\n') : ''
  const who = Array.isArray(c.who_and_why)
    ? (c.who_and_why as Array<{ pid: string; reason: string }>).map((w) => `  · ${w.pid}${w.reason ? ` — ${w.reason}` : ''}`).join('\n')
    : ''
  return ok([
    `headline:    ${c.headline_lead}${c.headline_tail ? ' ' + c.headline_tail : ''}`,
    `subhead:     ${c.subhead}`,
    `pulled by:   ${c.pulled_by_id}`,
    `pulled at:   ${c.pulled_at}`,
    `status:      ${c.status}`,
    '',
    `who & why:`,
    who,
    '',
    `reasoning:`,
    reasoning,
  ].join('\n'))
}

async function cmdSearch(parsed: ParsedArgs): Promise<CliResult> {
  const query = parsed.positional[0]
  if (!query) return err('usage: search <query> [--in <convo_id>] [--limit N]')
  const inConvo = parsed.flags.in ? String(parsed.flags.in) : null
  const limit = Math.min(50, Math.max(1, Number(parsed.flags.limit ?? 10)))
  const params: unknown[] = [`%${query}%`]
  let whereExtra = ''
  if (inConvo) {
    params.push(inConvo)
    whereExtra = `AND m.conversation_id = $2`
  }
  params.push(limit)
  const limitParam = `$${params.length}`
  const { rows } = await pool.query<{
    id: string; conversation_id: string; author_id: string; body: string;
    created_at: string; attachment: StoredAttachment | null
  }>(
    `SELECT m.id, m.conversation_id, m.author_id, m.body, m.created_at, m.attachment
       FROM messages m
      WHERE m.body ILIKE $1 ${whereExtra}
      ORDER BY m.created_at DESC LIMIT ${limitParam}`,
    params,
  )
  for (const row of rows) await freshenRowAttachment(row)
  if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
  if (rows.length === 0) return ok(`(no matches for "${query}"${inConvo ? ` in ${inConvo}` : ''})`)
  const lines = [`${rows.length} match(es) for "${query}":`, '']
  for (const m of rows) {
    const t = new Date(m.created_at).toLocaleString()
    const idx = m.body.toLowerCase().indexOf(query.toLowerCase())
    const slice = m.body.slice(Math.max(0, idx - 20), idx + 100).replace(/\n/g, ' \\n ')
    lines.push(`  · [${t}] ${m.conversation_id} ${m.author_id}: …${slice}…`)
    const att = renderAttachment(m.attachment)
    if (att) lines.push(att)
  }
  return ok(lines.join('\n'))
}

async function cmdToolsLog(parsed: ParsedArgs): Promise<CliResult> {
  const agent = parsed.flags.agent ? String(parsed.flags.agent) : null
  const limit = Math.min(50, Math.max(1, Number(parsed.flags.limit ?? 15)))
  const params: unknown[] = []
  let where = ''
  if (agent) { params.push(agent); where = `WHERE agent_id = $1` }
  params.push(limit)
  const limitParam = `$${params.length}`
  const { rows } = await pool.query<{
    id: string; agent_id: string; name: string; status: string; duration_ms: number | null;
    args: unknown; created_at: string
  }>(
    `SELECT id, agent_id, name, status, duration_ms, args, created_at
       FROM tool_calls ${where}
       ORDER BY created_at DESC LIMIT ${limitParam}`,
    params,
  )
  if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
  if (rows.length === 0) return ok(`(no tool calls)`)
  return ok([
    `last ${rows.length} tool call(s):`,
    '',
    ...rows.map((r) => {
      const t = new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const argsBrief = JSON.stringify(r.args).slice(0, 100)
      return `  [${t}] ${r.agent_id.padEnd(8)} ${r.name.padEnd(22)} ${r.status.padEnd(7)} ${r.duration_ms ?? '-'}ms  ${argsBrief}`
    }),
  ].join('\n'))
}

async function cmdStatus(parsed: ParsedArgs): Promise<CliResult> {
  // TENANT SCOPE: this agent's own company only (was leaking every agent in
  // every company — same cross-tenant hole as cmdParticipants).
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`cannot resolve company for ${me}`)
  const { rows } = await pool.query<{ id: string; name: string; status: string; kind: string }>(
    `SELECT id, name, status, kind FROM participants
      WHERE company_id = $1 AND kind = 'agent' AND departed_at IS NULL ORDER BY name ASC`,
    [companyId],
  )
  if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
  return ok([
    `agent              status`,
    `-----------------------------`,
    ...rows.map((r) => `${r.name.padEnd(8)} (${r.id.padEnd(6)})  ${r.status}`),
  ].join('\n'))
}

/* ============== mailbox: inbox / ack / reply ============== */

import { randomUUID } from 'node:crypto'

interface InboxQuotedSummary {
  id: string
  authorId: string
  authorName: string
  kind: string
  body: string
  sequence: number
}

interface InboxItem {
  id: string
  conversation_id: string
  conversation_title: string
  conversation_kind: string
  conversation_topic: string | null
  author_id: string
  author_name: string
  body: string
  kind: string
  sequence: number
  created_at: string
  attachment: StoredAttachment | null
  poll: InboxPollPayload | null
  quoted_message_id: string | null
  quoted: InboxQuotedSummary | null
}

interface InboxPollPayload {
  question: string
  mode: 'single' | 'multi'
  options: Array<{ id: string; text: string }>
  expiresAt: string | null
  closedAt: string | null
  closedReason: 'expired' | 'manual' | null
}

/** Render a poll message as a multi-line block that gives the agent
 *  every fact it needs to vote in one read: the question, the option ids
 *  (so it can pick one without a second roundtrip), the mode, the
 *  open/closed/expired state, and the exact `cumora poll vote` line to
 *  copy-paste. Without this, polls look like a plain text message with
 *  a 📊 prefix and the agent has no idea options exist.
 *
 *  Indented to match the surrounding `[id] hh:mm author: body` rows so
 *  it lines up visually inside both `cumora inbox` and `cumora messages`. */
function renderPollBlock(messageId: string, poll: InboxPollPayload): string[] {
  const lines: string[] = []
  const state = poll.closedAt
    ? `closed${poll.closedReason ? ` (${poll.closedReason})` : ''}`
    : (poll.expiresAt ? `open · expires ${poll.expiresAt}` : 'open · no expiration')
  lines.push(`    📊 POLL · ${poll.mode}-choice · ${state}`)
  lines.push(`    question: ${poll.question}`)
  for (const o of poll.options) {
    lines.push(`      • ${o.id} — ${o.text}`)
  }
  if (!poll.closedAt) {
    lines.push(`    → to vote: cumora poll vote ${messageId} <option_id>${poll.mode === 'multi' ? '[,<option_id>...]' : ''}`)
    lines.push(`    → if the question doesn't apply to you or none of the options is your real answer, stay silent (no reply, no vote)`)
  }
  return lines
}

async function loadInbox(agentId: string): Promise<InboxItem[]> {
  const { rows } = await pool.query<InboxItem>(
    `SELECT
        m.id,
        m.conversation_id,
        c.title AS conversation_title,
        c.kind  AS conversation_kind,
        c.topic AS conversation_topic,
        m.author_id,
        COALESCE(p.name, m.author_id) AS author_name,
        m.body,
        m.kind,
        m.sequence,
        m.created_at,
        m.attachment,
        m.poll,
        m.quoted_message_id,
        (
          SELECT jsonb_build_object(
            'id', qm.id,
            'authorId', qm.author_id,
            'authorName', COALESCE(qp.name, qm.author_id),
            'kind', qm.kind,
            'body', LEFT(qm.body, 240),
            'sequence', qm.sequence
          )
            FROM messages qm
            LEFT JOIN participants qp ON qp.id = qm.author_id AND qp.company_id = c.company_id
           WHERE qm.id = m.quoted_message_id
             AND qm.conversation_id = m.conversation_id
        ) AS quoted
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = c.company_id
      WHERE c.members @> to_jsonb(ARRAY[$1::text])
        AND m.author_id <> $1
        AND m.created_at > COALESCE(
          (SELECT last_read_at FROM conversation_reads
            WHERE user_id = $1 AND conversation_id = c.id),
          '1970-01-01T00:00:00Z'::timestamptz)
        AND (
          c.kind = 'direct'
          OR NOT EXISTS (
            SELECT 1 FROM conversation_mutes mu
             WHERE mu.user_id = $1 AND mu.conversation_id = c.id
               AND (mu.muted_until IS NULL OR mu.muted_until > NOW())
          )
          OR EXISTS (
            SELECT 1 FROM regexp_matches(m.body, '@([[:alnum:]_-]+)', 'g') mention
             WHERE LOWER(mention[1]) = LOWER($1)
          )
          OR EXISTS (
            SELECT 1 FROM messages quoted
             WHERE quoted.id = m.quoted_message_id
               AND quoted.conversation_id = m.conversation_id
               AND quoted.author_id = $1
          )
        )
      ORDER BY m.created_at ASC
      LIMIT 200`,
    [agentId],
  )
  for (const row of rows) await freshenRowAttachment(row)
  return rows
}

async function cmdInbox(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const filterConvo = parsed.positional[0] ?? null
  const items = await loadInbox(me)
  const filtered = filterConvo ? items.filter((m) => m.conversation_id === filterConvo) : items
  if (parsed.flags.json) return ok(JSON.stringify(filtered, null, 2))
  if (filtered.length === 0) return ok(`(inbox empty for ${me})`)

  // Group by conversation
  const byConvo = new Map<string, InboxItem[]>()
  for (const it of filtered) {
    if (!byConvo.has(it.conversation_id)) byConvo.set(it.conversation_id, [])
    byConvo.get(it.conversation_id)!.push(it)
  }
  const lines: string[] = [`${filtered.length} unread message(s) for ${me}, across ${byConvo.size} conversation(s):`, '']
  for (const [convoId, msgs] of byConvo) {
    const head = msgs[0]
    lines.push(`# ${convoId}  [${head.conversation_kind}]  "${head.conversation_title}"`)
    if (head.conversation_topic) lines.push(`  Topic: ${head.conversation_topic}`)
    for (const m of msgs) {
      const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const body = m.kind === 'tool' ? '[tool call]' : m.body.slice(0, 240).replace(/\n/g, ' \\n ')
      lines.push(`  [${m.id}]  ${t}  ${m.author_name}: ${body}`)
      // Inline the quoted-original (one line, indented) so you can see what
      // a reply is replying to without a second lookup. Pass `--quote <id>`
      // to `reply` to quote a message back.
      if (m.quoted_message_id) {
        if (m.quoted) {
          const qBody = m.quoted.body.slice(0, 180).replace(/\n/g, ' \\n ')
          lines.push(`    ↩ quoting [${m.quoted.id}] ${m.quoted.authorName}: ${qBody}`)
        } else {
          lines.push(`    ↩ quoting [${m.quoted_message_id}] (original deleted)`)
        }
      }
      if (m.kind === 'poll' && m.poll) {
        for (const line of renderPollBlock(m.id, m.poll)) lines.push(line)
      }
      const att = renderAttachment(m.attachment)
      if (att) lines.push(att)
    }
    lines.push('')
  }
  lines.push(`when you're done deciding what to do (reply / react / dm / nothing), run \`cumora ack <convo_id>\` to clear that conversation from your inbox so the next wake-up doesn't see it again. \`cumora ack --all\` clears everything in your inbox.`)
  return ok(lines.join('\n'))
}

/** `cumora glance <convo>` — read the room before committing a reply.
 *
 *  Two things real teammates do that an LLM-driven agent doesn't get
 *  for free: (1) see what's just been said since they started thinking,
 *  (2) see who else is currently typing. This command surfaces both:
 *  recent messages in the convo (last ~12, with the agent's own
 *  replies tagged ▸ME) plus the set of peer agents that are currently
 *  marked "thinking" in this convo.
 *
 *  The agent prompt teaches the model to glance once before each
 *  broadcast reply — so a peer can race past with their answer while
 *  the model was still composing and the model adjusts (yield, build
 *  on it, pick a different angle) instead of blurting the same thing. */
async function cmdGlance(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = (typeof parsed.flags['conversation'] === 'string' ? parsed.flags['conversation'] : null)
    ?? parsed.positional[0]
  if (!convoId) return err('usage: glance --conversation <id>  (or: glance <id>)')

  interface RecentRow {
    id: string
    author_id: string
    author_name: string
    kind: string
    body: string
    created_at: string
    sequence: number
  }
  const { rows } = await pool.query<RecentRow>(
    `SELECT m.id, m.author_id, COALESCE(p.name, m.author_id) AS author_name,
            m.kind, m.body, m.created_at, m.sequence
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN participants p ON p.id = m.author_id AND p.company_id = c.company_id
      WHERE m.conversation_id = $1
      ORDER BY m.created_at DESC
      LIMIT 12`,
    [convoId],
  )
  const recent = rows.reverse()

  // Advance the Redis "seen" boundary — glance just showed the agent
  // these messages, so they count as "seen" for the freshness preflight
  // on its next `cumora reply`. Same Redis-only, fail-open path as
  // cmdMessages — never touches conversation_reads.last_read_at.
  if (recent.length > 0) {
    await recordSeen(me, convoId, recent[recent.length - 1].sequence)
  }

  // NO composing/claim-order roster. Exposing "who's composing, ordered by
  // who claimed first, [earlier/later than you]" is exactly what let an agent
  // map its claim RANK to a task slot ("I'm 3rd to claim → I post 3") — a
  // whole class of coordination bugs that then needed a wall of scenario-patch
  // prompt rules. Exposing only the posted message stream + a private
  // seen-cursor makes slot-by-position
  // structurally unrepresentable: the only fact an agent can act on is "the
  // latest thing actually posted", so it posts the real next item and races,
  // and the server's freshness gate (cmdReply preflight) serializes collisions.
  // glance now returns ONLY the stream, matching that model.
  if (parsed.flags.json) {
    return ok(JSON.stringify({ conversation_id: convoId, recent }, null, 2))
  }

  const lines: string[] = []
  lines.push(`Glance into ${convoId} — last ${recent.length} message(s):`)
  lines.push('')
  if (recent.length === 0) {
    lines.push('  (no messages yet)')
  } else {
    for (const m of recent) {
      const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const tag = m.author_id === me ? '▸ME' : '   '
      const body = m.kind === 'tool'
        ? '[tool call]'
        : m.kind === 'system'
          ? '[system]'
          : m.body.slice(0, 200).replace(/\n/g, ' \\n ')
      lines.push(`  [${m.id}] ${tag} ${t}  ${m.author_name}: ${body}`)
    }
  }
  return ok(lines.join('\n'))
}

async function cmdAck(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  if (parsed.flags.all) {
    // Ack every conversation that currently has unread items for me
    const items = await loadInbox(me)
    const convoIds = [...new Set(items.map((i) => i.conversation_id))]
    for (const id of convoIds) {
      await pool.query(
        `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
        [me, id],
      )
      // Acking = standing down on this conversation. Any un-used HELD
      // acknowledgement is void — it must not arm a later turn's
      // preemptive --send-anyway (the 2026-07-08 stale-"6" path).
      void clearHold(me, `reply:${id}`)
    }
    return ok(`acked ${convoIds.length} conversation(s)`)
  }
  const convoId = parsed.positional[0]
  if (!convoId) return err('usage: ack <conversation_id>  OR  ack --all')
  await pool.query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
    [me, convoId],
  )
  // Standing down — see the --all branch above.
  void clearHold(me, `reply:${convoId}`)
  return ok(`acked ${convoId}`)
}

function parseMuteUntil(parsed: ParsedArgs): Date | null {
  const untilRaw = typeof parsed.flags.until === 'string' ? parsed.flags.until : null
  const forRaw = typeof parsed.flags.for === 'string' ? parsed.flags.for : null
  if (untilRaw && forRaw) throw new Error('use either --until or --for, not both')
  if (untilRaw) {
    const until = new Date(untilRaw)
    if (Number.isNaN(until.getTime())) throw new Error('invalid --until timestamp')
    if (until.getTime() <= Date.now()) throw new Error('--until must be in the future')
    return until
  }
  if (!forRaw) return null
  const match = /^(\d+)(m|h|d|w)$/i.exec(forRaw.trim())
  if (!match) throw new Error('invalid --for duration (use e.g. 30m, 2h, 1d, or 1w)')
  const amount = Number(match[1])
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2].toLowerCase() as 'm' | 'h' | 'd' | 'w']
  if (amount < 1 || amount * unitMs > 90 * 86_400_000) throw new Error('--for duration must be between 1 minute and 90 days')
  return new Date(Date.now() + amount * unitMs)
}

async function cmdMute(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)
  if (parsed.positional[0] === 'list') {
    const { rows } = await pool.query<{ id: string; title: string; muted_until: string | null }>(
      `SELECT c.id, c.title, mu.muted_until
         FROM conversation_mutes mu
         JOIN conversations c ON c.id = mu.conversation_id
        WHERE mu.user_id = $1 AND c.company_id = $2
          AND (mu.muted_until IS NULL OR mu.muted_until > NOW())
        ORDER BY mu.muted_at DESC`,
      [me, companyId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok('(no muted groups)')
    return ok(rows.map((row) => `• ${row.id}  "${row.title}"  — ${row.muted_until ? `until ${new Date(row.muted_until).toISOString()}` : 'until you follow it'}`).join('\n'))
  }
  const conversationId = parsed.positional[0]
  if (!conversationId) return err('usage: mute <conversation_id> [--for 30m|2h|1d|1w] [--until <iso>]  OR  mute list')
  let until: Date | null
  try { until = parseMuteUntil(parsed) } catch (error) { return err(error instanceof Error ? error.message : String(error)) }
  const { rows } = await pool.query<{ kind: string; title: string; members: string[] }>(
    `SELECT kind, title, members FROM conversations WHERE id = $1 AND company_id = $2`,
    [conversationId, companyId],
  )
  const conversation = rows[0]
  if (!conversation) return err(`conversation not found: ${conversationId}`)
  if (!conversation.members.includes(me)) return err(`you are not a member of ${conversationId}`)
  if (conversation.kind === 'direct') return err('direct conversations always deliver; mute a group instead')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO conversation_mutes (user_id, conversation_id, muted_at, muted_until)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (user_id, conversation_id)
       DO UPDATE SET muted_at = NOW(), muted_until = EXCLUDED.muted_until`,
      [me, conversationId, until],
    )
    // Muting is a deliberate stand-down. Seal the current unread tail so
    // following later resumes from that point instead of replaying a backlog.
    await client.query(
      `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
      [me, conversationId],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  void clearHold(me, `reply:${conversationId}`)
  const expiry = until ? ` until ${until.toISOString()}` : ' until you follow it again'
  return ok(
    `Muted ${conversationId} ("${conversation.title}")${expiry}. ` +
    `New group messages will not wake you or enter your inbox. A direct @${me} mention or a reply quoting your message still gets through. ` +
    `Resume with: cumora follow ${conversationId}`,
  )
}

async function cmdFollow(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const conversationId = parsed.positional[0]
  if (!conversationId) return err('usage: follow <conversation_id>')
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)
  const { rowCount } = await pool.query(
    `DELETE FROM conversation_mutes mu USING conversations c
      WHERE mu.user_id = $1 AND mu.conversation_id = $2
        AND c.id = mu.conversation_id AND c.company_id = $3`,
    [me, conversationId, companyId],
  )
  return ok(rowCount
    ? `Following ${conversationId} again. New messages will resume normal inbox delivery.`
    : `${conversationId} was not muted; normal delivery is already active.`)
}

async function cmdShip(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)
  const action = parsed.positional[0] ?? 'list'
  if (action === 'list') {
    const { rows } = await pool.query<{
      id: string; title: string; status: string; priority: string; required: number; passed: number; failed: number; release_target: string | null
    }>(
      `SELECT f.id, f.title, f.status, f.priority, f.release_target,
              count(v.id) FILTER (WHERE v.required)::int AS required,
              count(v.id) FILTER (WHERE v.required AND v.status='passed')::int AS passed,
              count(v.id) FILTER (WHERE v.status='failed')::int AS failed
         FROM shipping_features f LEFT JOIN shipping_verifications v ON v.feature_id=f.id
        WHERE f.company_id=$1 AND f.status <> 'archived'
        GROUP BY f.id ORDER BY f.updated_at DESC`,
      [companyId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok('(no active shipping contracts)')
    return ok(rows.map((row) => `${row.id}  [${row.status}]  ${row.title}\n  evidence ${row.passed}/${row.required}${row.failed ? ` · ${row.failed} failed` : ''}${row.release_target ? ` · target ${row.release_target}` : ''}`).join('\n'))
  }
  if (action === 'show') {
    const featureId = parsed.positional[1]
    if (!featureId) return err('usage: ship show <feature_id>')
    const { rows: features } = await pool.query(
      `SELECT id,title,problem,desired_outcome,status,priority,risk_level,release_target,builder_ids
         FROM shipping_features WHERE id=$1 AND company_id=$2`,
      [featureId, companyId],
    )
    if (!features[0]) return err(`shipping feature not found: ${featureId}`)
    const [invariants, squares, releases, friction, regressions] = await Promise.all([
      pool.query(`SELECT id,title,description,kind,required FROM shipping_invariants WHERE feature_id=$1 ORDER BY position`, [featureId]),
      pool.query(`SELECT id,title,method,required,status,owner_id,verified_by_id,evidence,notes FROM shipping_verifications WHERE feature_id=$1 ORDER BY position`, [featureId]),
      pool.query(`SELECT id,environment,status,version,commit_sha,readback_status,readback_due_at FROM shipping_releases WHERE feature_id=$1 ORDER BY created_at DESC`, [featureId]),
      pool.query(`SELECT id,title,severity,frequency,status,occurrence_count FROM shipping_friction_reports WHERE feature_id=$1 ORDER BY last_seen_at DESC`, [featureId]),
      pool.query(`SELECT id,title,kind,status,command,last_result FROM shipping_regressions WHERE feature_id=$1 ORDER BY updated_at DESC`, [featureId]),
    ])
    const snapshot = { ...features[0], invariants: invariants.rows, squares: squares.rows, releases: releases.rows, friction: friction.rows, regressions: regressions.rows }
    if (parsed.flags.json) return ok(JSON.stringify(snapshot, null, 2))
    const lines = [`${snapshot.id}  [${snapshot.status}]  ${snapshot.title}`, `Problem: ${snapshot.problem || '—'}`, `Outcome: ${snapshot.desired_outcome || '—'}`, `Builders: ${(snapshot.builder_ids as string[]).map((id) => `@${id}`).join(', ') || '—'}`, '', 'Invariants:']
    lines.push(...invariants.rows.map((i: any) => `  ${i.required ? '•' : '◦'} ${i.id} [${i.kind}] ${i.title}`))
    lines.push('', 'Evidence squares:')
    lines.push(...squares.rows.map((s: any) => `  ${s.status === 'passed' ? '✓' : s.status === 'failed' ? '!' : '·'} ${s.id} [${s.method}/${s.status}] ${s.title} · owner ${s.owner_id ? `@${s.owner_id}` : 'unassigned'}`))
    lines.push('', `Releases: ${releases.rows.length} · Friction: ${friction.rows.length} · Regressions: ${regressions.rows.length}`)
    return ok(lines.join('\n'))
  }
  if (action === 'create') {
    const title = parsed.positional[1]?.trim()
    if (!title) return err('usage: ship create "<title>" --problem "..." --outcome "..." --contract "..." [--builders a,b]')
    const builderIds = typeof parsed.flags.builders === 'string'
      ? [...new Set(parsed.flags.builders.split(',').map((id) => id.trim()).filter(Boolean))]
      : [me]
    const { rows: builders } = await pool.query<{ id: string }>(`SELECT id FROM participants WHERE company_id=$1 AND id=ANY($2::text[]) AND departed_at IS NULL`, [companyId, builderIds])
    if (builders.length !== builderIds.length) return err('one or more --builders are not active participants in this company')
    const id = `ship-${randomUUID()}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO shipping_features
          (id,company_id,title,problem,desired_outcome,contract_summary,builder_ids,created_by,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8)`,
        [id, companyId, title, typeof parsed.flags.problem === 'string' ? parsed.flags.problem : '',
          typeof parsed.flags.outcome === 'string' ? parsed.flags.outcome : '', typeof parsed.flags.contract === 'string' ? parsed.flags.contract : '',
          JSON.stringify(builderIds), me],
      )
      for (const [squareTitle, method, position] of [
        ['Walk the critical user path', 'user_path', 10],
        ['Prove trace coverage and diagnostic evidence', 'trace', 20],
        ['Verify release notes and known gaps', 'release_note', 30],
      ] as const) {
        await client.query(
          `INSERT INTO shipping_verifications (id,feature_id,title,method,required,builder_ids,position,created_by)
           VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$6,$7)`,
          [`sv-${randomUUID()}`, id, squareTitle, method, JSON.stringify(builderIds), position, me],
        )
      }
      await client.query(
        `INSERT INTO shipping_events (id,company_id,feature_id,actor_id,kind,data)
         VALUES ($1,$2,$3,$4,'feature.created',$5::jsonb)`,
        [`se-${randomUUID()}`, companyId, id, me, JSON.stringify({ title, source: 'agent-cli' })],
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
    return ok(`Created shipping contract ${id} for “${title}”. Three required evidence squares were seeded. Add invariants and assign independent verifiers in the Ship workspace.`)
  }
  if (action === 'square') {
    const [featureId, squareId, status] = parsed.positional.slice(1)
    if (!featureId || !squareId || !['running','passed','failed','waived'].includes(status ?? '')) return err('usage: ship square <feature_id> <square_id> <running|passed|failed|waived> [--evidence "..."] [--notes "..."]')
    const { rows } = await pool.query<{ builder_ids: string[]; title: string }>(
      `SELECT v.builder_ids,v.title FROM shipping_verifications v JOIN shipping_features f ON f.id=v.feature_id
        WHERE v.id=$1 AND v.feature_id=$2 AND f.company_id=$3`, [squareId, featureId, companyId],
    )
    const square = rows[0]
    if (!square) return err('verification square not found')
    const completing = status !== 'running'
    if (completing && square.builder_ids.includes(me)) return err('builder/verifier separation: you cannot complete a square for work you built')
    const evidence = typeof parsed.flags.evidence === 'string' ? parsed.flags.evidence.trim() : ''
    const notes = typeof parsed.flags.notes === 'string' ? parsed.flags.notes.trim() : ''
    if ((status === 'passed' || status === 'failed') && !evidence) return err(`${status} requires --evidence`)
    if (status === 'waived' && !notes) return err('waived requires --notes with the written reason')
    const proof = JSON.stringify([{ note: evidence, capturedAt: new Date().toISOString(), via: 'agent-cli' }])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE shipping_verifications SET status=$1,owner_id=COALESCE(owner_id,$2),verified_by_id=CASE WHEN $3 THEN $2 ELSE verified_by_id END,
                evidence=CASE WHEN $4<>'' THEN $5::jsonb ELSE evidence END,notes=CASE WHEN $6<>'' THEN $6 ELSE notes END,
                completed_at=CASE WHEN $3 THEN NOW() ELSE NULL END,updated_at=NOW()
          WHERE id=$7 AND feature_id=$8`,
        [status, me, completing, evidence, proof, notes, squareId, featureId],
      )
      if (status === 'failed') {
        await client.query(
          `INSERT INTO shipping_regressions
            (id,feature_id,source_verification_id,title,kind,expected,status,created_by)
           VALUES ($1,$2,$3,$4,'manual_replay',$5,'failing',$6)
           ON CONFLICT (source_verification_id) WHERE source_verification_id IS NOT NULL
           DO UPDATE SET status='failing',updated_at=NOW()`,
          [`rg-${randomUUID()}`, featureId, squareId, `Replay failed square: ${square.title}`,
            'The behavior proven by this square remains true', me],
        )
        await client.query(
          `INSERT INTO shipping_friction_reports
            (id,company_id,feature_id,reporter_id,source,source_key,title,description,severity,frequency,status,evidence)
           VALUES ($1,$2,$3,$4,'verification',$5,$6,$7,'high','once','open',$8::jsonb)
           ON CONFLICT (company_id,source_key) WHERE source_key IS NOT NULL
           DO UPDATE SET occurrence_count=shipping_friction_reports.occurrence_count+1,
                         last_seen_at=NOW(),updated_at=NOW(),status='open',evidence=EXCLUDED.evidence`,
          [`fr-${randomUUID()}`, companyId, featureId, me, `verification:${squareId}`,
            `Verification failed: ${square.title}`,
            'An agent-reported proof failed and was promoted into friction plus a replayable regression.', proof],
        )
      }
      await client.query(`INSERT INTO shipping_events (id,company_id,feature_id,actor_id,kind,data) VALUES ($1,$2,$3,$4,'verification.updated',$5::jsonb)`, [`se-${randomUUID()}`, companyId, featureId, me, JSON.stringify({ id: squareId, status, via: 'agent-cli' })])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally { client.release() }
    return ok(`${squareId} (${square.title}) → ${status}${evidence ? ' with evidence recorded' : ''}.`)
  }
  if (action === 'friction') {
    const featureRaw = parsed.positional[1]
    const title = parsed.positional[2]?.trim()
    if (!featureRaw || !title) return err('usage: ship friction <feature_id|none> "<title>" [--description "..."] [--severity low|medium|high|critical]')
    const featureId = featureRaw === 'none' ? null : featureRaw
    if (featureId) {
      const { rows } = await pool.query(`SELECT 1 FROM shipping_features WHERE id=$1 AND company_id=$2`, [featureId, companyId])
      if (!rows[0]) return err('shipping feature not found')
    }
    const severity = typeof parsed.flags.severity === 'string' && ['low','medium','high','critical'].includes(parsed.flags.severity) ? parsed.flags.severity : 'medium'
    const id = `fr-${randomUUID()}`
    await pool.query(
      `INSERT INTO shipping_friction_reports (id,company_id,feature_id,reporter_id,source,title,description,severity)
       VALUES ($1,$2,$3,$4,'agent-cli',$5,$6,$7)`,
      [id, companyId, featureId, me, title, typeof parsed.flags.description === 'string' ? parsed.flags.description : title, severity],
    )
    return ok(`Captured friction ${id}${featureId ? ` on ${featureId}` : ''}. It is now visible in the Ship workspace.`)
  }
  if (action === 'regression') {
    const featureId = parsed.positional[1]
    const title = parsed.positional[2]?.trim()
    if (!featureId || !title) return err('usage: ship regression <feature_id> "<title>" [--command "..."] [--expected "..."]')
    const { rows } = await pool.query(`SELECT 1 FROM shipping_features WHERE id=$1 AND company_id=$2`, [featureId, companyId])
    if (!rows[0]) return err('shipping feature not found')
    const id = `rg-${randomUUID()}`
    await pool.query(
      `INSERT INTO shipping_regressions (id,feature_id,title,kind,command,expected,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7)`,
      [id, featureId, title, typeof parsed.flags.command === 'string' ? 'automated' : 'manual_replay',
        typeof parsed.flags.command === 'string' ? parsed.flags.command : null,
        typeof parsed.flags.expected === 'string' ? parsed.flags.expected : 'Previously verified behavior remains true', me],
    )
    return ok(`Created regression asset ${id} on ${featureId}.`)
  }
  return err('usage: ship list|show|create|square|friction|regression  (run cumora help for details)')
}

// Membership system-message + counter helpers live in
// `agents/membership.ts` so the HTTP endpoints (POST /members,
// POST /leave) and the agent CLI share one implementation. Importing
// here re-exposes the names this file already used.
import { postMembershipSystemMessage } from './membership.js'

async function cmdLeave(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = parsed.positional[0]
  if (!convoId) return err('usage: leave <conversation_id>')

  const { rows } = await pool.query<{
    kind: string; title: string; members: string[]; company_id: string | null
  }>(
    `SELECT kind, title, members, company_id FROM conversations WHERE id = $1`,
    [convoId],
  )
  const c = rows[0]
  if (!c) return err(`unknown conversation ${convoId}`)
  if (c.kind === 'direct') {
    return err('cannot leave a direct conversation — use `cumora ack` to mute it from your inbox instead')
  }
  if (!c.members.includes(me)) return err(`${me} is not a member of ${convoId}`)

  // Post the system message BEFORE updating members so the leaving
  // agent's inbox (filtered by c.members @> [me]) still surfaces this
  // final row in their next wake — that's how they "perceive" their own
  // departure cleanly.
  const systemMessage = await postMembershipSystemMessage({
    conversationId: convoId,
    companyId: c.company_id,
    actorId: me,
    kind: 'left',
    participantId: me,
  })

  const next = c.members.filter((m) => m !== me)
  await pool.query(
    `UPDATE conversations SET members = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [convoId, JSON.stringify(next)],
  )

  return ok(`left "${c.title}" (${convoId}); ${next.length} member(s) remain`, [{
    event: 'conversation.membership_changed',
    command: 'leave',
    action: 'left',
    conversationId: convoId,
    actorId: me,
    participantId: me,
    companyId: c.company_id ?? undefined,
    systemMessageId: systemMessage.messageId,
    memberCount: next.length,
    visibleToUser: true,
  }])
}

async function cmdInvite(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = parsed.positional[0]
  const target = parsed.positional[1]
  if (!convoId || !target) return err('usage: invite <conversation_id> <member_id>')
  if (target === me) return err(`${me} is already the one inviting`)

  const { rows } = await pool.query<{
    kind: string; title: string; members: string[]; company_id: string | null
  }>(
    `SELECT kind, title, members, company_id FROM conversations WHERE id = $1`,
    [convoId],
  )
  const c = rows[0]
  if (!c) return err(`unknown conversation ${convoId}`)
  if (c.kind === 'direct') {
    return err('cannot invite into a direct conversation — use `cumora pull-group` to start a fresh thread')
  }
  if (!c.members.includes(me)) return err(`${me} is not a member of ${convoId} — can't invite into a group you're not in`)
  if (c.members.includes(target)) return ok(`${target} is already a member of ${convoId}`)

  // Verify the invitee exists in this tenant.
  const tenant = c.company_id
  if (tenant) {
    const { rows: pp } = await pool.query<{ id: string }>(
      `SELECT id FROM participants WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [target, tenant],
    )
    if (!pp[0]) return err(`${target} is not a participant in this workspace`)
  }

  const next = [...c.members, target]
  await pool.query(
    `UPDATE conversations SET members = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [convoId, JSON.stringify(next)],
  )

  const systemMessage = await postMembershipSystemMessage({
    conversationId: convoId,
    companyId: c.company_id,
    actorId: me,
    kind: 'joined',
    participantId: target,
  })

  return ok(`invited ${target} into "${c.title}" (${convoId}); ${next.length} member(s) total`, [{
    event: 'conversation.membership_changed',
    command: 'invite',
    action: 'joined',
    conversationId: convoId,
    actorId: me,
    participantId: target,
    companyId: c.company_id ?? undefined,
    systemMessageId: systemMessage.messageId,
    memberCount: next.length,
    visibleToUser: true,
  }])
}

async function cmdKick(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = parsed.positional[0]
  const target = parsed.positional[1]
  if (!convoId || !target) return err('usage: kick <conversation_id> <member_id>')
  if (target === me) return err('use `cumora leave <convo_id>` to leave a group yourself')

  const { rows } = await pool.query<{
    kind: string; title: string; members: string[]; company_id: string | null
  }>(
    `SELECT kind, title, members, company_id FROM conversations WHERE id = $1`,
    [convoId],
  )
  const c = rows[0]
  if (!c) return err(`unknown conversation ${convoId}`)
  if (c.kind === 'direct') return err('cannot kick from a direct conversation')
  if (!c.members.includes(me)) return err(`${me} is not a member of ${convoId} — can't kick from a group you're not in`)
  if (!c.members.includes(target)) return err(`${target} is not a member of ${convoId}`)

  const next = c.members.filter((m) => m !== target)
  // Refuse to leave a group with just one member as a side-effect of kick —
  // if there'd only be the actor left, that's "everyone else gone", which
  // is fine, but require explicit confirmation via --confirm-empty for the
  // case where the kick removes the LAST other member. Cheap guard against
  // accidental group-clearing.
  if (next.length === 1 && !parsed.flags['confirm-empty']) {
    return err(`kicking ${target} would leave only ${me} in this group; pass --confirm-empty if that's intended`)
  }

  // Post BEFORE removing the target from members. The mailbox query
  // filters by current `c.members @> [agentId]`, so if we updated first
  // the kicked agent would never see the row that explains why their
  // inbox went quiet on this conversation. Posting first means the
  // target gets one last wake with this exact message.
  const systemMessage = await postMembershipSystemMessage({
    conversationId: convoId,
    companyId: c.company_id,
    actorId: me,
    kind: 'kicked',
    participantId: target,
  })

  await pool.query(
    `UPDATE conversations SET members = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [convoId, JSON.stringify(next)],
  )

  return ok(`kicked ${target} from "${c.title}" (${convoId}); ${next.length} member(s) remain`, [{
    event: 'conversation.membership_changed',
    command: 'kick',
    action: 'kicked',
    conversationId: convoId,
    actorId: me,
    participantId: target,
    companyId: c.company_id ?? undefined,
    systemMessageId: systemMessage.messageId,
    memberCount: next.length,
    visibleToUser: true,
  }])
}

async function cmdReply(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = parsed.positional[0]
  // Strip any hallucinated <tool_call> XML on the way in too — defense in depth.
  const body = joinBodyArgs(parsed, 1)
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, '')
    .trim()
  const hasAttachFlag = Boolean(
    parsed.flags.attach ||
    parsed.flags['generate-image'] ||
    parsed.flags['attach-text'] ||
    parsed.flags['attach-bytes'],
  )
  // `--quote / -q <message_id>` makes this reply a direct quote of that
  // message. The target must live in the SAME conversation — cross-convo
  // quotes would leak content, so the server-side path enforces that too.
  const quoteFlag = parsed.flags.quote ?? parsed.flags.q
  const quotedMessageId = quoteFlag ? String(quoteFlag).trim() : null
  if (!convoId || (!body && !hasAttachFlag)) {
    return err('usage: reply <convo_id> "<body>" [--quote <msg_id>] [--attach <url> | --generate-image "<prompt>" [--size square|wide|tall] | --attach-text "<filename>" "<content>" | --attach-bytes "<filename>" --bytes-b64 "<base64>" [--bytes-mime "<mime>"]]')
  }

  // Verify the participant is a member of the conversation.
  const { rows: cv } = await pool.query<{
    members: string[]; company_id: string; kind: string; actor_is_agent: boolean
  }>(
    `SELECT c.members, c.company_id, c.kind,
            EXISTS (
              SELECT 1 FROM participants p
               WHERE p.id = $2 AND p.company_id = c.company_id
                 AND p.kind = 'agent' AND p.departed_at IS NULL
            ) AS actor_is_agent
       FROM conversations c WHERE c.id = $1`,
    [convoId, me],
  )
  if (!cv[0]) return err(`unknown conversation ${convoId}`)
  if (!cv[0].members.includes(me)) return err(`${me} is not a member of ${convoId}`)
  const companyId = cv[0].company_id

  // ─── Anti-monologue gate ──────────────────────────────────────────
  // In multi-party conversations (3+ members), an agent can't post a
  // second message in a row before anyone else has spoken. The most
  // common failure mode this catches: agent posts plan → same agent
  // immediately posts continuation → next agent posts THEIR version of
  // the same plan → loop. Group-chat real-people don't double-text
  // their own thread before anyone responds; agents do, constantly,
  // because each wake-up is a fresh "should I respond?" decision with
  // no global stop-signal.
  //
  // Exemptions:
  //  - DMs (2-member convos): legit follow-ups like "oh also one more
  //    thing" happen naturally. Keep them open.
  //  - 10-minute escape valve: if your own last message has been
  //    sitting there for 10+ minutes without anyone biting, the thread
  //    has gone quiet and a nudge is fair game.
  //
  // Bypass via `--continue` / `--also`: rare cases where the agent
  // genuinely has to add to its own previous message (e.g. an
  // urgent correction, an attachment that didn't fit). The flag
  // forces the agent to commit deliberately rather than absent-
  // mindedly continuing to monologue.
  const monologueBypass = Boolean(parsed.flags.continue || parsed.flags.also)
  if (!monologueBypass && cv[0].actor_is_agent && cv[0].members.length > 2) {
    const { rows: lastMsg } = await pool.query<{ author_id: string; created_at: string }>(
      `SELECT author_id, created_at FROM messages
         WHERE conversation_id = $1
         ORDER BY sequence DESC LIMIT 1`,
      [convoId],
    )
    if (lastMsg[0] && lastMsg[0].author_id === me) {
      const ageMs = Date.now() - new Date(lastMsg[0].created_at).getTime()
      const MIN_GAP_MS = 10 * 60 * 1000
      if (ageMs < MIN_GAP_MS) {
        const ageSec = Math.max(1, Math.round(ageMs / 1000))
        return err(
          `you already posted in ${convoId} ${ageSec}s ago and nobody has replied yet — ` +
          `you can't post again until someone else speaks. ` +
          `If you have more to say, fold it into your next message when someone responds. ` +
          `Right now: react on the relevant message (cumora react <message_id> 👀 / ✅ / 🎯), ` +
          `or set_turn_status done and step back. ` +
          `Override only if it's truly urgent: rerun with --continue.`
        )
      }
    }
  }

  // Email conversations: auto-promote into a real email reply rather than
  // writing a plain text message. The agent's LLM was previously expected
  // to know to call `cumora email reply <message_id>` for email threads —
  // unreliable, and the external recipient never saw the reply when it
  // forgot. This converges both reply surfaces (chat + email) on the
  // sendViaProvider path. autoSubmitted=true because every CLI reply is
  // agent-driven by construction.
  if (cv[0].kind === 'email') {
    if (!body) {
      return err('email replies require a non-empty body')
    }
    try {
      const { replyInEmailConversation } = await import('../email.js')
      const result = await replyInEmailConversation({
        conversationId: convoId, companyId, authorId: me, body, autoSubmitted: true,
      })
      const mockTag = result.mock ? ' (mock)' : ''
      if (result.transportStatus !== 'sent') {
        return err(`email reply persisted as failed: ${result.error} · ${result.messageId}`, 1)
      }
      return ok(`replied via email${mockTag} · ${result.messageId}`, [{
        event: 'message.posted',
        command: 'reply',
        medium: 'email',
        conversationId: convoId,
        messageId: result.messageId,
        authorId: me,
        companyId,
        visibleToUser: true,
        transportStatus: result.transportStatus,
        mock: result.mock,
      }])
    } catch (e) {
      return err(`email auto-promote failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ─── FRESHNESS PREFLIGHT ───────────────────────────────────────────
  // Goal: stop the classic collision (Iris and Marcus both posting "3" in
  // a counting game). Mechanism: read this agent's "seen seq" boundary
  // from Redis (the one loadInbox / cmdMessages / cmdGlance recorded), and
  // if any non-self message in this conversation has a seq > baseline,
  // HOLD the send and surface the held messages so the agent re-decides.
  //
  // Why this lives in Redis (NOT in conversation_reads.last_read_at like
  // the a6e69aa attempt that we reverted): bumping last_read_at corrupted
  // the inbox SELECT cursor and silent-hung the daemon. This version is
  // strictly Redis-only with explicit fail-open semantics — if Redis is
  // down or the key is unset, getSeen returns 0 and the preflight skips
  // (we'd rather risk one collision than hang the agent).
  //
  // Bypasses match the monologue gate above + send-anyway override:
  //   - 2-member DMs: parallel typing is normal, both replies are valid
  //   - --continue / --also: agent has explicit "this is a follow-up" intent
  //   - --send-anyway: explicit override after the agent re-decided that
  //     the original draft is STILL correct given the new context.
  //     ARMED ONLY BY A PRIOR HOLD (hold token, see below) — a preemptive
  //     --send-anyway on a first attempt is ignored and the preflight runs.
  //   - email convos: already returned above via the auto-promote path
  //
  // What this does NOT catch (separate fix, 0eaf04c): brain-level out-of-
  // order races where the SECOND agent hasn't INSERTed yet (Nova posting 6
  // BEFORE Iris's 5 lands — both Nova's and Iris's prefights pass because
  // neither has anything newer than Marcus's 4 in the messages table at
  // their respective INSERT moments). That's the "NEVER SKIP AHEAD" prompt
  // rule's job. This preflight catches POST-INSERT races (both already
  // tried to insert the same slot — the second one sees the first).
  //
  // Why the hold token exists (2026-06-11/12 double-deliverable incidents):
  // agents learned to pass --send-anyway PREEMPTIVELY to save a round-trip
  // ("compile story → reply --send-anyway" with zero glances), which made
  // this entire preflight a no-op exactly when it mattered — a peer had
  // posted the same deliverable 40s earlier and the HELD envelope would
  // have shown it. The token turns the flag from a free pass into an
  // acknowledgement: it only works AFTER this server has actually shown
  // the agent a HELD envelope for this conversation.
  const sendAnywayFlag = Boolean(parsed.flags['send-anyway'])
  const replyHoldScope = `reply:${convoId}`
  const preflightApplies = !monologueBypass && cv[0].members.length > 2
  const heldAck = sendAnywayFlag
    ? await consumeHold(me, replyHoldScope)
    : { armed: false, heldUpToSeq: null }
  let sendAnywayArmed = heldAck.armed
  if (sendAnywayArmed && preflightApplies && heldAck.heldUpToSeq !== null) {
    // The token acknowledges the room AS SHOWN in that HELD envelope — up
    // to peer seq `heldUpToSeq`. If the room moved past it, the
    // acknowledgement is void: the flag must never skip the gates for
    // messages the agent has NOT been shown. (2026-07-08 counting game:
    // Saga was HELD at 17:30 drafting "2", yielded — banking the token —
    // and a NEW turn's preemptive --send-anyway consumed it at 17:34,
    // shipping a stale "6" past Nova's 6 and Iris's 7 sight unseen.)
    const { rows: newer } = await pool.query<{
      sequence: number; author_id: string; author_name: string | null; body: string
    }>(
      `SELECT m.sequence, m.author_id, m.body,
              COALESCE(p.name, u.display_name) AS author_name
         FROM messages m
         LEFT JOIN participants p ON p.id = m.author_id
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.conversation_id = $1
          AND m.author_id <> $2
          AND m.sequence > $3
        ORDER BY m.sequence ASC
        LIMIT 8`,
      [convoId, me, heldAck.heldUpToSeq],
    )
    if (newer.length > 0) {
      sendAnywayArmed = false
      const maxHeldSeq = newer[newer.length - 1].sequence
      // Shown ⇒ part of the agent's world-state: advance the SEEN CURSOR past
      // what THIS envelope shows and arm a fresh token bound to the new
      // high-water seq, so a considered re-run works without re-holding on
      // these same rows (the hold envelope itself advances the seen cursor).
      await recordSeen(me, convoId, maxHeldSeq)
      await recordHold(me, replyHoldScope, maxHeldSeq)
      const lines = newer.map((r) =>
        `  [seq=${r.sequence}] ${r.author_name || r.author_id}: ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`
      ).join('\n')
      return err(
        `HELD — your reply NOT sent. Your --send-anyway acknowledged an EARLIER hold, but the room has moved since: ` +
        `${newer.length} newer message(s) in ${convoId} you have not been shown:\n${lines}\n\n` +
        `Re-decide against THIS state — usually your draft is now wrong ` +
        `(counting: post the next number after the latest, not the one you drafted; ` +
        `relay/chain: continue from the latest entry; if a peer above already delivered what you were about to deliver, stand down or react instead). ` +
        `Run \`cumora reply <convoId> "<revised body>"\` with your new decision, ` +
        `or rerun with --send-anyway only if your draft is STILL correct despite these messages (rare).`,
        2,
      )
    }
  }
  if (!sendAnywayArmed && preflightApplies) {
    // Freshness race detection — the SEEN-CURSOR model: a per-(agent,convo)
    // SEEN CURSOR — "the highest peer
    // seq this agent has actually been SHOWN" — advanced by every surface that
    // puts rows in front of the model: the wake brief (/runtime/inbox), cumora
    // glance, cumora messages, and HELD envelopes themselves. HOLD iff a peer
    // message exists that the agent has NOT been shown; once shown, a plain
    // re-send passes with no flag ritual (the hold envelope carries the
    // cursor forward, so resend-after-shown goes through cleanly).
    //
    // This replaces the compose-anchor (turn-start timestamp, deliberately NOT
    // advanced by glance). The anchor guaranteed a FIRST-attempt HOLD in any
    // busy room even when the agent had already read everything — transcripts:
    // "Same HELD — those messages are what I already glanced → send-anyway" —
    // costing 1-2 extra big-model round-trips per reply. The
    // one dup the anchor caught that a seen-cursor admits (glance shows a
    // peer's just-landed post and the agent still posts the SAME item) is
    // covered by the VERBATIM-DUP gate below.
    //
    // baseline === 0 (never read / Redis TTL expired / Redis down) fails OPEN,
    // as before — the wake brief re-establishes the cursor at turn start.
    const baseline = await getSeen(me, convoId)
    if (baseline > 0) {
      const { rows: newer } = await pool.query<{
        sequence: number; author_id: string; author_name: string | null; body: string
      }>(
        `SELECT m.sequence, m.author_id, m.body,
                COALESCE(p.name, u.display_name) AS author_name
           FROM messages m
           LEFT JOIN participants p ON p.id = m.author_id
           LEFT JOIN users u ON u.id = m.author_id
          WHERE m.conversation_id = $1
            AND m.author_id <> $2
            AND m.sequence > $3
          ORDER BY m.sequence ASC
          LIMIT 8`,
        [convoId, me, baseline],
      )
      if (newer.length > 0) {
        // Shown ⇒ seen: advance the cursor past what this envelope shows so a
        // considered re-send passes instead of re-holding on the same rows —
        // the hold envelope itself advances the cursor. If MORE peers
        // post after this, the re-attempt holds again on the truly-new ones.
        const maxHeldSeq = newer[newer.length - 1].sequence
        await recordSeen(me, convoId, maxHeldSeq)
        const lines = newer.map((r) =>
          `  [seq=${r.sequence}] ${r.author_name || r.author_id}: ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`
        ).join('\n')
        // Arm the hold token: NOW the agent has actually been shown the
        // held context, so a follow-up --send-anyway is a real
        // acknowledgement rather than a preemptive skip. Bound to the max
        // shown seq — if the room moves again before the re-run, the
        // acknowledgement is void (see the staleness check above).
        await recordHold(me, replyHoldScope, maxHeldSeq)
        return err(
          `HELD — your reply NOT sent. ${newer.length} newer message(s) in ${convoId} you have not been shown:\n${lines}\n\n` +
          (sendAnywayFlag
            ? `(Your --send-anyway was IGNORED: it only acknowledges a HOLD you have already been shown — passing it preemptively does nothing.)\n`
            : '') +
          `You have now seen these — re-decide against THIS state, then simply re-send: a plain \`cumora reply <convoId> "<revised body>"\` will go through (no flag needed). ` +
          `Usually your draft is now wrong (counting: post the next number after the latest; relay/chain: continue from the latest entry; ` +
          `if a peer above already delivered what you were about to deliver, the work is DONE — stand down or react instead).`,
          2,  // exit code 2 = "held, retry with different content" (distinct from 1 = generic error)
        )
      }
    }
    // ─── VERBATIM-DUP GATE ───────────────────────────────────────────
    // The freshness preflight above catches "peer posted AFTER my baseline /
    // anchor." But during aggressive lapping (team-adapts pushing multiple
    // agents to cover) two agents can independently draft the SAME content
    // before either's anchor or baseline is set against the other — both
    // glance, see the same state, both decide on the same NEXT-ITEM.
    // Seq-based preflight passes (no peer message > my baseline) but the
    // draft is verbatim identical to a recent peer post. Real teammates
    // would say "oh, X beat me to it" — they don't immediately repeat the
    // most-recent thing said. Encode that as a HARD gate: if my draft body
    // (trimmed) matches the IMMEDIATELY PREVIOUS non-self peer message
    // verbatim, HOLD. This caught two T7 collisions (你-你, 了-了) where
    // both rates of slot-coverage races would have shipped duplicate
    // characters into the chain.
    //
    // Scope: only the LAST peer message — narrowest principled rule, no
    // scenario examples. If a peer 5 messages ago said "yes" and you're
    // also drafting "yes" in response to something new, that's not noise;
    // only the immediately-prior dup is.
    const draftBodyTrimmed = body.trim()
    if (draftBodyTrimmed.length > 0) {
      const { rows: lastPeer } = await pool.query<{ sequence: number; author_id: string; author_name: string | null; body: string }>(
        `SELECT m.sequence, m.author_id, m.body,
                COALESCE(p.name, u.display_name) AS author_name
           FROM messages m
           LEFT JOIN participants p ON p.id = m.author_id
           LEFT JOIN users u ON u.id = m.author_id
          WHERE m.conversation_id = $1
            AND m.author_id <> $2
            AND m.kind = 'text'
          ORDER BY m.sequence DESC
          LIMIT 1`,
        [convoId, me],
      )
      if (lastPeer.length > 0 && lastPeer[0].body.trim() === draftBodyTrimmed) {
        // Advance baseline past this peer post so re-attempt with NEW content
        // doesn't HOLD on the same row again.
        await recordSeen(me, convoId, lastPeer[0].sequence)
        await recordHold(me, replyHoldScope, lastPeer[0].sequence)
        const peer = lastPeer[0]
        return err(
          `HELD — your draft is VERBATIM IDENTICAL to the most recent peer post in ${convoId}:\n` +
          `  [seq=${peer.sequence}] ${peer.author_name || peer.author_id}: ${peer.body.replace(/\s+/g, ' ').slice(0, 200)}\n\n` +
          `They beat you to it. Real teammates don't immediately repeat the same thing — pick a different angle, the NEXT item in a sequence, or stay silent if their post already covers what you wanted to say.`,
          2,
        )
      }
    }
  }

  // If quoting, prove the target exists in THIS conversation. If it doesn't,
  // fail loudly — unlike the HTTP path (which is forgiving in case of a
  // delete race), the agent should know its quote pointer is bad so it can
  // fix the call rather than ship a silently-quoteless reply.
  let resolvedQuotedId: string | null = null
  let quotedSummary: { id: string; authorId: string; authorName: string; body: string; sequence: number } | null = null
  if (quotedMessageId) {
    // Resolve the quoted author's DISPLAY NAME, not just the id. The author can
    // be an agent/human in `participants` OR a human keyed in `users` (their
    // user id), so we COALESCE across both — otherwise the quote card shows a
    // raw id like `u-f92aa4ac-...` instead of the person's name.
    const { rows: qr } = await pool.query<{
      id: string; author_id: string; author_name: string | null; body: string; sequence: number
    }>(
      `SELECT m.id, m.author_id, m.body, m.sequence,
              COALESCE(p.name, u.display_name) AS author_name
         FROM messages m
         LEFT JOIN participants p ON p.id = m.author_id
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.id = $1 AND m.conversation_id = $2`,
      [quotedMessageId, convoId],
    )
    if (!qr[0]) {
      return err(`--quote target ${quotedMessageId} not found in ${convoId}`)
    }
    resolvedQuotedId = qr[0].id
    quotedSummary = {
      id: qr[0].id,
      authorId: qr[0].author_id,
      authorName: qr[0].author_name || qr[0].author_id,
      body: qr[0].body.slice(0, 240),
      sequence: qr[0].sequence,
    }
  }

  // Optional attachment in three flavors:
  //   --attach <url>                    — share an existing URL (no key, won't re-sign)
  //   --generate-image "<prompt>"       — call the image model, upload to storage,
  //                                       attach with signed URL + key
  //   --attach-text "<filename>" "..."  — save the content as a real file and attach it
  type AgentAttachment = {
    url: string; name: string; kind: 'img' | 'file';
    mime?: string; size?: number; key?: string;
  }
  let attachment: AgentAttachment | null = null

  if (parsed.flags['generate-image']) {
    const prompt = String(parsed.flags['generate-image']).trim()
    if (!prompt) return err('--generate-image requires a non-empty prompt')
    // Same tenant-scoped claim as `cumora image generate` — the image
    // model doesn't care whether the call came via reply or as a
    // standalone, but peer agents do.
    const blocked = await tryClaimTenantWork(companyId, me, 'image-generate', prompt)
    if (blocked) return blocked
    try {
      attachment = await generateAndUploadImage({
        prompt,
        size: String(parsed.flags.size ?? 'square'),
        tenant: companyId,
        agentId: me,
      })
    } catch (e) {
      return err(`image generation failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      await releaseTenantWork(companyId, me, 'image-generate', prompt)
    }
  } else if (parsed.flags['attach-text']) {
    const filename = String(parsed.flags['attach-text']).trim().slice(0, 200)
    // Content comes from the body (which then gets cleared) OR from an
    // explicit --attach-text-content. Common case: agent writes the file
    // as the body and uses --attach-text to mark it as an attachment.
    const content = String(parsed.flags['attach-text-content'] ?? body)
    if (!filename || !content) return err('--attach-text requires a filename and content')
    attachment = await saveTextAttachment(filename, content)
  } else if (parsed.flags['attach-bytes']) {
    const filename = String(parsed.flags['attach-bytes']).trim().slice(0, 200)
    const b64 = String(parsed.flags['bytes-b64'] ?? '').trim()
    const mime = parsed.flags['bytes-mime']
      ? String(parsed.flags['bytes-mime']).trim().toLowerCase()
      : undefined
    if (!filename || !b64) return err('--attach-bytes requires a filename and --bytes-b64 "<base64>"')
    try {
      attachment = await saveBytesAttachment(filename, b64, mime)
    } catch (e) {
      return err(`attach-bytes failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else if (parsed.flags.attach) {
    const url = String(parsed.flags.attach)
    const name = parsed.flags['attach-name'] ? String(parsed.flags['attach-name']) : url.split('/').pop() ?? 'attachment'
    attachment = { url, name, kind: 'img' }
  }

  // If the body was consumed as the text-file content (no separate
  // --attach-text-content flag was passed), suppress it from the
  // outgoing message — the file IS the message.
  const consumedAsTextContent =
    parsed.flags['attach-text'] && !parsed.flags['attach-text-content']
  const finalBody = consumedAsTextContent ? '' : body

  // Atomically claim next sequence + check verbatim-dup + INSERT, all in
  // ONE transaction. The conversation_counters UPSERT takes a row-level
  // lock (ON CONFLICT DO UPDATE), and that lock stays held until COMMIT —
  // serializing every concurrent cumora-reply to the same convo through
  // this critical section. While we hold the lock, we re-check the last
  // peer message body against our draft (committed visibility — we'll
  // see any peer INSERT that committed before our sequence claim).
  // If verbatim-dup, ROLLBACK and return HELD. This closes the TOCTOU
  // race that the pre-INSERT verbatim check has — two agents 2s apart
  // both passing read-phase, then both writing.
  const messageId = `m-${randomUUID()}`
  let sequence: number
  const txClient = await pool.connect()
  try {
    await txClient.query('BEGIN')
    const { rows: seqRow } = await txClient.query<{ seq: number }>(
      `INSERT INTO conversation_counters (conversation_id, next_sequence)
       VALUES ($1, 2)
       ON CONFLICT (conversation_id) DO UPDATE SET next_sequence = conversation_counters.next_sequence + 1
       RETURNING next_sequence - 1 AS seq`,
      [convoId],
    )
    sequence = seqRow[0]?.seq ?? 1
    // Atomic verbatim-dup re-check inside the lock: if a peer INSERT
    // committed during our compose+pre-INSERT window, we see it now.
    // The pre-INSERT check above is still useful — it short-circuits
    // most cases and shows the held content; this one closes the race.
    //
    // NOTE: this check IGNORES --send-anyway and the 2-member-DM bypass.
    // Posting content verbatim-identical to the immediately-prior peer
    // message has NO legitimate use case — even in a DM, repeating the
    // other party's last sentence verbatim is noise. The other preflight
    // gate (the seq-baseline seen-cursor) IS bypassable by --send-anyway
    // (the agent may legitimately answer a specific @-mention despite
    // post-baseline side-traffic), but verbatim-content-dup is a hard no.
    // T9 showed an agent using --send-anyway to force a verbatim dup that
    // it had explicitly internalized as a "standing close play"; the
    // server has to enforce.
    // NOTE: this is deliberately NOT gated on !monologueBypass. --continue / --also
    // is a "follow up on MY OWN messages" intent; it must never let an agent post a
    // verbatim duplicate of a PEER's immediately-prior message. (Observed 2026-07-26:
    // ethan was correctly HELD on "4", then re-sent with --continue and the dup landed
    // next to olivia's "4" — because the old `!monologueBypass` here let it through,
    // contradicting this check's own "verbatim-dup is a hard no, the server enforces"
    // contract.) The peer-only query below already exempts genuine self-monologue: a
    // real follow-up isn't verbatim-identical to a recent PEER post, so it still passes.
    if (cv[0].members.length > 2) {
      const draftBodyTrimmed = body.trim()
      if (draftBodyTrimmed.length > 0) {
        const { rows: lastPeer } = await txClient.query<{ sequence: number; author_id: string; body: string }>(
          `SELECT sequence, author_id, body FROM messages
            WHERE conversation_id = $1 AND author_id <> $2 AND kind = 'text'
            ORDER BY sequence DESC LIMIT 1`,
          [convoId, me],
        )
        if (lastPeer.length > 0 && lastPeer[0].body.trim() === draftBodyTrimmed) {
          await txClient.query('ROLLBACK')
          await recordSeen(me, convoId, lastPeer[0].sequence)
          await recordHold(me, replyHoldScope, lastPeer[0].sequence)
          return err(
            `HELD — verbatim duplicate of the immediately-prior peer post in ${convoId}:\n` +
            `  [seq=${lastPeer[0].sequence}] ${lastPeer[0].author_id}: ${lastPeer[0].body.replace(/\s+/g, ' ').slice(0, 200)}\n\n` +
            `They posted the exact same content${sendAnywayFlag ? ' (and --send-anyway does NOT bypass this check — verbatim-dup is never legitimate)' : ''}. Real teammates don't immediately repeat the same word. Pick the NEXT item, a different angle, or stay silent if their post already covers what you wanted.`,
            2,
          )
        }
      }
    }
    await txClient.query(
      `INSERT INTO messages (id, conversation_id, author_id, kind, body, sequence, attachment, quoted_message_id, company_id)
       VALUES ($1,$2,$3,'text',$4,$5,$6::jsonb,$7,$8)`,
      [messageId, convoId, me, finalBody, sequence, attachment ? JSON.stringify(attachment) : null, resolvedQuotedId, companyId],
    )
    await txClient.query('COMMIT')
  } catch (e) {
    await txClient.query('ROLLBACK').catch(() => { /* already failed */ })
    throw e
  } finally {
    txClient.release()
  }
  await pool.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [convoId])

  // Posting auto-acks me on this conversation (I clearly saw the messages I'm replying to)
  await pool.query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
    [me, convoId],
  )
  // Advance the Redis "seen" boundary to my own just-inserted seq, so the
  // freshness preflight on my NEXT cumora reply compares against the post-
  // insertion state (peer messages with seq <= mine are "things I obviously
  // saw"; only seq > mine would trip a HOLD). Pure Redis side-effect — does
  // NOT touch conversation_reads.last_read_at or anything else loadInbox
  // depends on.
  await recordSeen(me, convoId, sequence)
  // Drop any lingering hold token: this send committed WITHOUT the
  // override, so a hold acknowledged-but-unused must not arm a later
  // preemptive --send-anyway in this conversation.
  void clearHold(me, replyHoldScope)
  // A new message advances the conversation — the stall-state has changed,
  // so any prior "give up on this stalled state" fallback-decline counter
  // is now stale; clear it so a future stall (if it stalls again later) gets
  // a fresh budget of fallback attempts. Fire-and-forget; if it fails the
  // worst case is the counter TTLs naturally in 45min.
  void (await import('./agenda.js')).resetStallNudgeDeclines(convoId)

  // Broadcast — frontend, scheduler, etc. all listen on CH_MESSAGE_NEW
  const { CH_MESSAGE_NEW, publish } = await import('../redis.js')
  await publish(CH_MESSAGE_NEW, {
    type: 'message.new',
    conversationId: convoId,
    companyId,
    message: {
      id: messageId, conversationId: convoId, authorId: me,
      kind: 'text', body: finalBody, sequence, at: new Date().toISOString(),
      attachment: attachment ?? undefined,
      quotedMessageId: resolvedQuotedId ?? undefined,
      quoted: quotedSummary ? {
        id: quotedSummary.id,
        authorId: quotedSummary.authorId,
        authorName: quotedSummary.authorName,
        kind: 'text',
        body: quotedSummary.body,
        sequence: quotedSummary.sequence,
      } : undefined,
    },
  })
  const attachmentNote = attachment
    ? ` · attached ${attachment.kind} "${attachment.name}"`
    : ''
  const quoteNote = resolvedQuotedId ? ` · quoted ${resolvedQuotedId}` : ''
  return ok(`sent (${messageId}, seq ${sequence})${attachmentNote}${quoteNote}`, [{
    event: 'message.posted',
    command: 'reply',
    medium: 'chat',
    conversationId: convoId,
    messageId,
    sequence,
    authorId: me,
    companyId,
    visibleToUser: true,
    attachment: Boolean(attachment),
    quotedMessageId: resolvedQuotedId,
  }])
}

/* ─── Image / file generation helpers ───────────────────────────────────
 * Both helpers return an AgentAttachment ready to drop into the messages
 * row. They go through the storage abstraction so URLs are signed when R2
 * + signing is active (production), or local paths in dev.
 *
 * Failure mode: throw — the caller wraps in a try/catch and returns
 * a CLI error so the agent's bash() call exits non-zero and the agent
 * can pick a different path. */

const IMAGE_SIZE_MAP: Record<string, '1024x1024' | '1536x1024' | '1024x1536'> = {
  square: '1024x1024',
  wide:   '1536x1024',
  tall:   '1024x1536',
}

async function generateAndUploadImage(opts: {
  prompt: string
  size: string
  /** Tenant for sub2api routing. When null, falls back to the legacy
   *  shared OPENAI_API_KEY. */
  tenant: string | null
  /** Agent invoking the tool (for ledger attribution). The peer-agent claim
   *  on this work uses the same id, so we already have it at every callsite. */
  agentId: string
}): Promise<{ url: string; name: string; kind: 'img'; mime: string; size: number; key: string }> {
  const size = IMAGE_SIZE_MAP[opts.size] ?? '1024x1024'
  // The agent-tool image generation lives on its own purpose so it doesn't
  // get pooled with avatar regeneration. Both ultimately hit the same image
  // model but the spend driver is very different (per agent action vs per
  // agent creation), and the operator will want to slice them apart.
  const { getTrackedLlmClient } = await import('./llm-ledger.js')
  const client = await getTrackedLlmClient({
    purpose: 'agent-image',
    companyId: opts.tenant, agentId: opts.agentId,
    extras: { size: opts.size, promptPreview: opts.prompt.slice(0, 120) },
  })
  const r = await client.images.generate({
    model: env.OPENAI_IMAGE_MODEL,
    prompt: opts.prompt,
    size,
    n: 1,
  })
  const first = r.data?.[0]
  const b64 = first?.b64_json
  const remoteUrl = first?.url
  let buf: Buffer
  if (b64) {
    buf = Buffer.from(b64, 'base64')
  } else if (remoteUrl) {
    const fetched = await fetchImageBytes(remoteUrl, {
      maxBytes: 20 * 1024 * 1024,
      timeoutMs: 30_000,
    })
    if (!fetched.ok) throw new Error(`image API download failed (${fetched.reason})`)
    buf = fetched.buffer
  } else {
    throw new Error('image API returned no data')
  }
  const { randomUUID } = await import('node:crypto')
  const id = randomUUID().replace(/-/g, '')
  const key = `attachments/${id}.png`
  const url = await storage.put(key, buf, 'image/png')
  // Slug the prompt into a friendly filename for the bubble caption.
  const slug = opts.prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
    .slice(0, 40) || 'image'
  return {
    url,
    key,
    name: `${slug}.png`,
    kind: 'img',
    mime: 'image/png',
    size: buf.length,
  }
}

/** `cumora image generate "<prompt>" [--size square|wide|tall] [--as <id>] [--json]`
 *  Generates an image with the configured image model (default
 *  gpt-image-2), uploads it to storage, and returns the signed URL + key
 *  so the caller can `cumora reply <c> "<body>" --attach <url>` later.
 *  Decoupled from `reply --generate-image` so an agent can test a
 *  prompt, look at the result, and discard / regenerate without shipping
 *  a half-baked image into a conversation. */
async function cmdImage(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const op = parsed.positional[0]
  if (op !== 'generate') {
    return err('usage: image generate "<prompt>" [--size square|wide|tall] [--as <id>] [--json]')
  }
  // Allow either `image generate "long prompt with spaces"` (the typical
  // quoted form) or `image generate word1 word2 ...` (autocomplete-friendly);
  // we just join positional tail.
  const prompt = parsed.positional.slice(1).join(' ').trim()
  if (!prompt) return err('image generate requires a non-empty prompt')
  const size = String(parsed.flags.size ?? 'square')

  // Look up the agent's company so sub2api per-user quota tracking works.
  // LIMIT 1 — if an agent id exists in multiple companies, we pick any.
  // That's a stop-gap; for now no agent runs cross-tenant standalone
  // image gen, so a more principled choice is YAGNI.
  const { rows: pr } = await pool.query<{ company_id: string | null }>(
    `SELECT company_id FROM participants WHERE id = $1 LIMIT 1`,
    [me],
  )
  const tenant = pr[0]?.company_id ?? null

  // Tenant-scoped claim by prompt so peer agents don't independently
  // burn a second image-gen call on the same idea. Only claim when
  // we know the tenant — otherwise the action would slip past the
  // dedup table.
  if (tenant) {
    const blocked = await tryClaimTenantWork(tenant, me, 'image-generate', prompt)
    if (blocked) return blocked
  }

  try {
    const att = await generateAndUploadImage({ prompt, size, tenant, agentId: me })
    if (parsed.flags.json) return ok(JSON.stringify(att, null, 2))
    const dim = size === 'wide' ? '1536×1024'
      : size === 'tall' ? '1024×1536'
      : '1024×1024'
    return ok([
      `generated ${dim} · ${Math.round(att.size / 1024)}KB · ${env.OPENAI_IMAGE_MODEL}`,
      `name: ${att.name}`,
      `url:  ${att.url}`,
      `key:  ${att.key}`,
      ``,
      `attach to a reply with:`,
      `  cumora reply <convo_id> "<body>" --attach "${att.url}" --attach-name "${att.name}"`,
    ].join('\n'))
  } catch (e) {
    return err(`image generation failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    if (tenant) await releaseTenantWork(tenant, me, 'image-generate', prompt)
  }
}

/** Save a base64-encoded blob as a file attachment of ANY type. This is
 *  the universal escape hatch — text files have their own --attach-text
 *  helper, images get the --generate-image path, but anything else (PDF,
 *  zip, audio, binary blob the agent fetched) flows through here. The
 *  agent provides the bytes as base64 and optionally a mime hint. */
async function saveBytesAttachment(
  filename: string,
  base64: string,
  mimeHint?: string,
): Promise<{ url: string; name: string; kind: 'img' | 'file'; mime: string; size: number; key: string }> {
  // Generous 32 MB ceiling — same as the user-upload edge. The base64
  // wire form is ~33% larger; we decode first then re-check.
  const MAX_BYTES = 32 * 1024 * 1024
  let buf: Buffer
  try {
    buf = Buffer.from(base64, 'base64')
  } catch {
    throw new Error('--bytes-b64 is not valid base64')
  }
  if (buf.length === 0) throw new Error('--bytes-b64 decoded to zero bytes')
  if (buf.length > MAX_BYTES) throw new Error(`attachment too large (${buf.length} > ${MAX_BYTES})`)

  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : 'bin'
  // Mime resolution: explicit hint > ext-based guess > octet-stream.
  const mime = mimeHint ?? extToMime(ext) ?? 'application/octet-stream'
  // Render as image when the mime says so; everything else is a file card.
  const kind: 'img' | 'file' = mime.startsWith('image/') ? 'img' : 'file'

  const { randomUUID } = await import('node:crypto')
  const id = randomUUID().replace(/-/g, '')
  const key = `attachments/${id}.${ext}`
  const url = await storage.put(key, buf, mime)
  return { url, key, name: filename, kind, mime, size: buf.length }
}

/** Best-effort mime guess from a file extension. Returns null for
 *  unknowns so the caller can fall back to a generic octet-stream. */
function extToMime(ext: string): string | null {
  switch (ext) {
    // Images
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'svg': return 'image/svg+xml'
    // Docs
    case 'pdf': return 'application/pdf'
    case 'doc': return 'application/msword'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xls': return 'application/vnd.ms-excel'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    // Archives
    case 'zip': return 'application/zip'
    case 'tar': return 'application/x-tar'
    case 'gz':  return 'application/gzip'
    // Text / code
    case 'txt': return 'text/plain'
    case 'md':  return 'text/markdown'
    case 'csv': return 'text/csv'
    case 'json': return 'application/json'
    case 'yml':
    case 'yaml': return 'application/x-yaml'
    case 'toml': return 'application/x-toml'
    case 'html': return 'text/html'
    // Media
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'mp4': return 'video/mp4'
    case 'mov': return 'video/quicktime'
    default: return null
  }
}

/** Load a local file for use as an outbound email attachment. Reads the
 *  bytes off the agent's filesystem, uploads them to object storage under
 *  the `email-attachments/` prefix (same prefix the inbound webhook uses
 *  — keeps the renderer's JOIN agnostic to direction), and returns the
 *  combined metadata. The returned `base64` is what we hand to Resend;
 *  the `storageKey` + `publicUrl` are how the recipient's UI downloads
 *  the file after the fact. */
async function loadEmailAttachmentFromPath(path: string): Promise<{
  filename: string; mimeType: string; sizeBytes: number;
  base64: string; storageKey: string; publicUrl: string;
}> {
  const fs = await import('node:fs/promises')
  const nodePath = await import('node:path')
  const cryptoMod = await import('node:crypto')
  const MAX_BYTES = 20 * 1024 * 1024  // 20MB — matches Resend's per-attachment ceiling
  const buf = await fs.readFile(path)
  if (buf.length === 0) throw new Error(`empty file: ${path}`)
  if (buf.length > MAX_BYTES) {
    throw new Error(`file too large: ${buf.length} bytes (max ${MAX_BYTES})`)
  }
  const filename = nodePath.basename(path)
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : 'bin'
  const mimeType = extToMime(ext) ?? 'application/octet-stream'
  const id = cryptoMod.randomUUID().replace(/-/g, '')
  const storageKey = `email-attachments/${id}${ext ? '.' + ext : ''}`
  const publicUrl = await storage.put(storageKey, buf, mimeType)
  return {
    filename, mimeType, sizeBytes: buf.length,
    base64: buf.toString('base64'),
    storageKey, publicUrl,
  }
}

/** Regenerate the calling agent's portrait via the image API. Composes
 *  the same prompt the HTTP endpoint uses, uploads to storage as
 *  `avatars/avatar-<id>-<rand>.png`, and stamps `participants.avatar_url`.
 *  Heavy — image-gen takes several seconds; the bash() tool call will
 *  block for that long. */
/** `cumora skills <op>` — manage Agent Skills (progressive-disclosure
 *  capability packs) stored in this agent's workspace under
 *  `skills/<name>/`. See server/src/agents/skills.ts for the spec. */
async function cmdSkills(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const op = parsed.positional[0] ?? 'list'

  if (op === 'list') {
    const { loadSkillsIndex } = await import('./skills.js')
    const skills = await loadSkillsIndex(me)
    if (parsed.flags.json) return ok(JSON.stringify(skills, null, 2))
    if (skills.length === 0) {
      return ok('(no skills installed — use `cumora skills create <name> "<description>"` to scaffold one)')
    }
    const lines = skills.map((s) =>
      `  ${s.name}\n    ${s.description}\n    → cumora skills read ${s.name}`,
    )
    return ok(lines.join('\n\n'))
  }

  if (op === 'read') {
    const name = parsed.positional[1]
    if (!name) return err('usage: skills read <name> [<sub-path>]')
    const subPath = parsed.positional[2]
    // No sub-path → load the SKILL.md entry-point. With a sub-path,
    // load that bundled file (e.g. `scripts/extract.py`).
    const fullPath = subPath ? `skills/${name}/${subPath}` : `skills/${name}/SKILL.md`
    const { rows } = await pool.query<{ body: string }>(
      `SELECT body FROM agent_workspace WHERE agent_id = $1 AND path = $2 LIMIT 1`,
      [me, fullPath],
    )
    if (!rows[0]) return err(`no such file: ${fullPath}`)
    return ok(rows[0].body)
  }

  if (op === 'create') {
    const name = parsed.positional[1]
    const description = parsed.positional[2]
    if (!name || !description) {
      return err('usage: skills create <name> "<description>"  (name: lowercase a-z, 0-9, hyphens; description: ≤1024 chars)')
    }
    const { validateSkillName } = await import('./skills.js')
    const nameError = validateSkillName(name)
    if (nameError) return err(nameError)
    if (description.length > 1024) return err('description must be ≤ 1024 characters')

    const path = `skills/${name}/SKILL.md`
    const { rows: existing } = await pool.query<{ path: string }>(
      `SELECT path FROM agent_workspace WHERE agent_id = $1 AND path = $2 LIMIT 1`,
      [me, path],
    )
    if (existing[0]) return err(`skill "${name}" already exists — use \`cumora workspace edit ${path}\` to modify it, or \`cumora skills delete ${name}\` first`)

    const body = `---
name: ${name}
description: ${description}
---

# ${name}

_Write the skill instructions here. Recommended sections: overview,
step-by-step, examples, edge cases. Keep this file under ~500 lines —
move long reference material into \`references/\` files and load them
on demand via \`cumora skills read ${name} references/<file>\`._
`
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, company_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [me, path, body, await agentCompany(me)],
    )
    return ok(
      `created skill "${name}" at ${path}\n\n` +
      `flesh it out: cumora workspace edit ${path} "<old>" "<new>"\n` +
      `add scripts:  cumora workspace write skills/${name}/scripts/<file>.py "<body>"\n` +
      `read it back: cumora skills read ${name}`,
      [{
        event: 'skill.created',
        command: 'skills create',
        agentId: me,
        skillName: name,
        path,
      }],
    )
  }

  if (op === 'delete') {
    const name = parsed.positional[1]
    if (!name) return err('usage: skills delete <name>')
    const r = await pool.query(
      `DELETE FROM agent_workspace
        WHERE agent_id = $1 AND (path = $2 OR path LIKE $3)`,
      [me, `skills/${name}/SKILL.md`, `skills/${name}/%`],
    )
    if ((r.rowCount ?? 0) === 0) return err(`no such skill: ${name}`)
    return ok(`deleted skill "${name}" (${r.rowCount} files removed)`, [{
      event: 'skill.deleted',
      command: 'skills delete',
      agentId: me,
      skillName: name,
      fileCount: r.rowCount ?? 0,
    }])
  }

  if (op === 'search') {
    const query = parsed.positional.slice(1).join(' ').trim()
    if (!query) return err('usage: skills search <query>')
    const { env } = await import('../env.js')
    if (!env.SKILLHUB_URL) return err('SkillHub URL not configured — set SKILLHUB_URL on the server')
    try {
      const { searchSkillHub } = await import('./skills.js')
      const hits = await searchSkillHub(query, env.SKILLHUB_URL)
      if (parsed.flags.json) return ok(JSON.stringify(hits, null, 2))
      if (hits.length === 0) return ok(`(no skills found matching "${query}")`)
      // Two lines per hit so it's scannable; include install command
      // verbatim so the agent can paste/run it without thinking.
      return ok(hits.map((h) => {
        const meta = [h.version && `v${h.version}`, h.author && `by ${h.author}`].filter(Boolean).join(' · ')
        const tag = h.install_url ?? h.name
        return `  ${h.name}${meta ? `  (${meta})` : ''}\n    ${h.description}\n    → cumora skills install ${tag}`
      }).join('\n\n'))
    } catch (e) {
      return err(`skills search failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (op === 'install') {
    const idOrUrl = parsed.positional[1]
    if (!idOrUrl) return err('usage: skills install <skill_id_or_install_url>')
    try {
      const { env } = await import('../env.js')
      const { fetchSkillManifest, installSkillFromManifest } = await import('./skills.js')
      const manifest = await fetchSkillManifest(idOrUrl, env.SKILLHUB_URL)
      const result = await installSkillFromManifest({ agentId: me, manifest })
      return ok(
        `installed skill "${result.name}" (${result.files} file${result.files === 1 ? '' : 's'})\n` +
        `read it with: cumora skills read ${result.name}`,
        [{
          event: 'skill.installed',
          command: 'skills install',
          agentId: me,
          skillName: result.name,
          fileCount: result.files,
          source: idOrUrl,
        }],
      )
    } catch (e) {
      return err(`skills install failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return err(
    'usage:\n' +
    '  skills list                                 list installed skills (name + description only)\n' +
    '  skills read <name> [<sub-path>]             load full SKILL.md (or a bundled file)\n' +
    '  skills create <name> "<description>"        scaffold a new skill\n' +
    '  skills search <query>                       search the configured SkillHub\n' +
    '  skills install <id_or_url>                  install a skill from SkillHub (or any compatible URL)\n' +
    '  skills delete <name>                        remove a skill and all its files',
  )
}

/* ============== email subcommands ==============
 * Real external mail. Each agent has an address (auto-minted from the
 * agent id + their company slug — see server/src/email.ts). Outbound
 * goes through Resend; inbound arrives via the Cloudflare Email Worker
 * + /webhooks/email/inbound and is fanned out as `kind='email'`
 * conversations. The CLI surface mirrors familiar webmail verbs: send,
 * reply, inbox, show, contacts. */

interface EmailContact {
  participantId: string | null
  name: string
  address: string
  /** 'agent' | 'human' | 'external' — drives the "who is this" hint. */
  kind: 'agent' | 'human' | 'external'
  /** The member's function/title (participants.role, e.g. "Designer").
   *  Null for humans/external contacts who have no role on file. This is
   *  what lets an agent know WHAT a teammate does, not just their name. */
  role?: string | null
}

async function listEmailContacts(
  companyId: string,
  viewerId: string,
  query?: string,
): Promise<EmailContact[]> {
  const out: EmailContact[] = []
  const { computeAgentAddress } = await import('../email.js')
  // Optional fuzzy filter. Applied uniformly across name / id / email so a
  // single query like "wey" matches an agent's id, a human's display
  // name, OR an external email-contacts row. We do the match in JS (after
  // each block's SQL) rather than per-table SQL ILIKE so the assembled
  // list stays consistent — and so the predicate matches both
  // participants.name AND the computed agent address.
  const q = query?.trim().toLowerCase() ?? ''
  const matches = (c: EmailContact) => !q
    || c.name.toLowerCase().includes(q)
    || c.address.toLowerCase().includes(q)
    || (c.participantId?.toLowerCase().includes(q) ?? false)
    || (c.role?.toLowerCase().includes(q) ?? false)
  // 1. Same-tenant agents (excluding the viewer themselves). Include those
  // whose participants.email column is still NULL — `/participants` already
  // exposes a deterministic address for un-minted agents, so the CLI
  // contact list should match (otherwise a fresh agent is invisible until
  // someone has emailed them, which is the bootstrap chicken-and-egg).
  const { rows: agents } = await pool.query<{ id: string; name: string; email: string | null; slug: string; role: string | null }>(
    `SELECT p.id, p.name, p.email, p.role, c.slug
       FROM participants p
       JOIN companies c ON c.id = p.company_id
      WHERE p.company_id = $1 AND p.kind = 'agent' AND p.departed_at IS NULL
        AND p.id <> $2
      ORDER BY p.name ASC`,
    [companyId, viewerId],
  )
  for (const a of agents) {
    // Top-level `contacts` is also the workspace roster. Keep local chat
    // agents visible when email is disabled instead of silently dropping them.
    const address = a.email ?? computeAgentAddress(a.id, a.slug) ?? '(chat only)'
    const c: EmailContact = { participantId: a.id, name: a.name, address, kind: 'agent', role: a.role }
    if (matches(c)) out.push(c)
  }
  // 2. Workspace humans (auth email).
  const { rows: humans } = await pool.query<{ id: string; display_name: string; email: string }>(
    `SELECT u.id, u.display_name, u.email
       FROM users u
       JOIN company_members cm ON cm.user_id = u.id
      WHERE cm.company_id = $1 AND u.email IS NOT NULL
      ORDER BY u.display_name ASC`,
    [companyId],
  )
  for (const h of humans) {
    const c: EmailContact = { participantId: h.id, name: h.display_name, address: h.email, kind: 'human' }
    if (matches(c)) out.push(c)
  }
  // 3. External addresses we've corresponded with. Without a filter we cap
  // at the 30 most recent; with a filter we widen the net so a search
  // can find older correspondents too (still capped to keep memory bounded).
  const limit = q ? 200 : 30
  const { rows: ext } = await pool.query<{ address: string; display_name: string | null; message_count: number }>(
    `SELECT address, display_name, message_count FROM email_contacts
      WHERE company_id = $1
      ORDER BY last_seen_at DESC LIMIT $2`,
    [companyId, limit],
  )
  for (const e of ext) {
    const c: EmailContact = {
      participantId: null,
      name: e.display_name ?? e.address,
      address: e.address,
      kind: 'external',
    }
    if (matches(c)) out.push(c)
  }
  return out
}

/** Resolve a recipient string the agent typed into a real email address.
 *  Accepts: a participant id (looked up in same company), a human user
 *  display id, an explicit "Name <addr>", or a bare address. Returns
 *  the parsed { addr, name } shape or null if unresolvable. */
async function resolveEmailRecipient(raw: string, viewerCompanyId: string): Promise<{ addr: string; name: string | null } | null> {
  // Synthetic external:<addr> ids are inbound-author markers only — they
  // come from senders we don't have a participants row for and have no
  // routable target by themselves. The agent should write to the bare
  // address instead (which lives in `email_contacts` and shows up under
  // `cumora email contacts`).
  if (raw.startsWith('external:')) return null
  const { parseAddress, ensureParticipantAddress } = await import('../email.js')
  const direct = parseAddress(raw)
  if (direct) return direct
  // Participant id lookup. Per-kind delivery target:
  //   - agent  → cumora address (lazy-mint if column still NULL)
  //   - human  → real auth email (so it lands in their personal inbox)
  const { rows: pa } = await pool.query<{ name: string; email: string | null; kind: string }>(
    `SELECT name, email, kind FROM participants
      WHERE id = $1 AND company_id = $2 AND departed_at IS NULL LIMIT 1`,
    [raw, viewerCompanyId],
  )
  if (pa[0]) {
    if (pa[0].kind === 'agent') {
      if (pa[0].email) return { addr: pa[0].email, name: pa[0].name }
      const ensured = await ensureParticipantAddress(raw, viewerCompanyId)
      if (ensured) return { addr: ensured.email, name: ensured.displayName }
    }
    if (pa[0].kind === 'human') {
      const { rows: u } = await pool.query<{ email: string | null }>(
        `SELECT email FROM users WHERE id = $1 LIMIT 1`, [raw],
      )
      if (u[0]?.email) return { addr: u[0].email, name: pa[0].name }
    }
  }
  // Direct user-id lookup (caller passed users.id, not participants.id).
  const { rows: us } = await pool.query<{ display_name: string; email: string }>(
    `SELECT u.display_name, u.email
       FROM users u
       JOIN company_members cm ON cm.user_id = u.id
      WHERE u.id = $1 AND cm.company_id = $2 LIMIT 1`,
    [raw, viewerCompanyId],
  )
  if (us[0]) return { addr: us[0].email, name: us[0].display_name }
  return null
}

interface EmailThreadRow {
  conversation_id: string
  title: string
  updated_at: string
  unread_count: number
  last_subject: string | null
  last_from: string | null
  last_at: string | null
  last_body: string | null
}

async function listAgentEmailThreads(args: {
  agentId: string
  companyId: string
  unreadOnly: boolean
  limit: number
}): Promise<EmailThreadRow[]> {
  // Threads = email conversations the agent is in. We surface the latest
  // email_messages row per thread for the snippet, and an unread count
  // computed against conversation_reads.last_read_at (same source of
  // truth as the chat inbox uses). Keeps the agent's mental model
  // consistent: "unread" means "you haven't acked this thread since".
  const { rows } = await pool.query<EmailThreadRow>(
    `WITH my_threads AS (
       SELECT c.id, c.title, c.updated_at
         FROM conversations c
        WHERE c.kind = 'email'
          AND c.company_id = $1
          AND c.members @> to_jsonb(ARRAY[$2::text])
     ),
     last_msg AS (
       SELECT DISTINCT ON (em.conversation_id)
              em.conversation_id, em.subject, em.from_addr,
              m.body, m.created_at AS at
         FROM email_messages em
         JOIN messages m ON m.id = em.message_id
        WHERE em.company_id = $1
        ORDER BY em.conversation_id, em.created_at DESC
     ),
     unread AS (
       SELECT m.conversation_id, COUNT(*)::int AS n
         FROM messages m
         LEFT JOIN conversation_reads r
                ON r.conversation_id = m.conversation_id AND r.user_id = $2
        WHERE m.kind = 'email'
          AND m.company_id = $1
          AND m.author_id <> $2
          AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
        GROUP BY m.conversation_id
     )
     SELECT t.id AS conversation_id, t.title, t.updated_at::text,
            COALESCE(u.n, 0) AS unread_count,
            l.subject AS last_subject, l.from_addr AS last_from,
            l.at::text AS last_at, l.body AS last_body
       FROM my_threads t
       LEFT JOIN last_msg l ON l.conversation_id = t.id
       LEFT JOIN unread   u ON u.conversation_id = t.id
      WHERE NOT $3 OR COALESCE(u.n, 0) > 0
      ORDER BY t.updated_at DESC
      LIMIT $4`,
    [args.companyId, args.agentId, args.unreadOnly, args.limit],
  )
  return rows
}

/* ============== Polls ====================================================
 * Agents can create polls, cast their own vote, and close polls they
 * authored. All three call the shared core in ../polls.ts — the HTTP API
 * for human users wraps the same functions, so renderer + agent paths
 * stay in lockstep on validation + broadcast. */
async function cmdPoll(parsed: ParsedArgs): Promise<CliResult> {
  const sub = parsed.positional[0]
  if (!sub) {
    return err(
      'usage:\n' +
      '  poll create <convo_id> "<question>" "<opt1>" "<opt2>" [<opt3>...] [--mode single|multi] [--expires-in <minutes>]\n' +
      '  poll vote <message_id> <option_id>[,<option_id>...]    # multi-choice: comma-separated. Pass --clear to retract\n' +
      '  poll close <message_id>                                # only the author can close\n' +
      '  poll show <message_id>                                 # current tallies + your vote',
    )
  }
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)
  switch (sub) {
    case 'create': return cmdPollCreate(parsed, me, companyId)
    case 'vote':   return cmdPollVote(parsed, me, companyId)
    case 'close':  return cmdPollClose(parsed, me, companyId)
    case 'show':   return cmdPollShow(parsed, me, companyId)
    default:       return err(`unknown poll subcommand: ${sub}`)
  }
}

async function cmdPollCreate(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const convoId = parsed.positional[1]
  const question = parsed.positional[2]
  const options = parsed.positional.slice(3).map(unescapeChat)
  if (!convoId || !question || options.length < 2) {
    return err('usage: poll create <convo_id> "<question>" "<opt1>" "<opt2>" [<opt3>...] [--mode single|multi] [--expires-in <minutes>]')
  }
  const mode = String(parsed.flags.mode ?? 'single') === 'multi' ? 'multi' : 'single'
  const expiresRaw = parsed.flags['expires-in']
  const expiresInMinutes = expiresRaw != null && expiresRaw !== ''
    ? Number(expiresRaw)
    : null
  if (expiresInMinutes != null && !Number.isFinite(expiresInMinutes)) {
    return err('--expires-in must be a number of minutes')
  }
  try {
    const { createPoll } = await import('../polls.js')
    const created = await createPoll({
      conversationId: convoId,
      companyId,
      authorId: me,
      question: unescapeChat(question),
      mode,
      options,
      expiresInMinutes,
    })
    const optsTxt = created.poll.options.map((o) => `  ${o.id} → ${o.text}`).join('\n')
    return ok(
      `poll posted · ${created.messageId} (seq ${created.sequence})\n` +
      `mode: ${created.poll.mode}${created.poll.expiresAt ? `\nexpires: ${created.poll.expiresAt}` : ''}\n` +
      `options:\n${optsTxt}`,
      [{
        event: 'message.posted',
        command: 'poll',
        conversationId: convoId,
        messageId: created.messageId,
        authorId: me,
        companyId,
        visibleToUser: true,
      }],
    )
  } catch (e) {
    return err(`poll create failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cmdPollVote(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const messageId = parsed.positional[1]
  if (!messageId) return err('usage: poll vote <message_id> <option_id>[,<option_id>...] [--clear]')
  const optsRaw = parsed.positional[2] ?? ''
  const clear = Boolean(parsed.flags.clear)
  const optionIds = clear
    ? []
    : optsRaw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!clear && optionIds.length === 0) {
    return err('provide at least one option id, or pass --clear to retract')
  }
  try {
    const { castVote } = await import('../polls.js')
    const event = await castVote({
      messageId,
      companyId,
      voterParticipantId: me,
      voterKind: 'agent',
      optionIds,
    })
    const tallyTxt = event.tallies.length === 0
      ? '(no votes yet)'
      : event.tallies.map((t) => `  ${t.optionId} · ${t.count} (${t.voterIds.join(', ')})`).join('\n')
    return ok(
      clear
        ? `vote retracted on ${messageId}\n${tallyTxt}`
        : `vote cast on ${messageId} → ${optionIds.join(', ')}\n${tallyTxt}`,
    )
  } catch (e) {
    return err(`poll vote failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cmdPollClose(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const messageId = parsed.positional[1]
  if (!messageId) return err('usage: poll close <message_id>')
  try {
    const { closePoll } = await import('../polls.js')
    const event = await closePoll({ messageId, companyId, actorId: me, reason: 'manual' })
    if (!event) return ok(`poll ${messageId} was already closed`)
    return ok(`poll ${messageId} closed`)
  } catch (e) {
    return err(`poll close failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function cmdPollShow(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const messageId = parsed.positional[1]
  if (!messageId) return err('usage: poll show <message_id>')
  const { rows } = await pool.query<{ poll: { question: string; mode: string; options: Array<{ id: string; text: string }>; expiresAt: string | null; closedAt: string | null } | null; author_id: string }>(
    `SELECT poll, author_id FROM messages
      WHERE id = $1 AND company_id = $2 AND kind = 'poll' LIMIT 1`,
    [messageId, companyId],
  )
  const row = rows[0]
  if (!row || !row.poll) return err(`poll ${messageId} not found`)
  const { rows: tallyRows } = await pool.query<{ option_id: string; cnt: number; voter_ids: string[] }>(
    `SELECT option_id, COUNT(*)::int AS cnt,
            array_agg(voter_participant_id ORDER BY voter_participant_id) AS voter_ids
       FROM poll_votes WHERE message_id = $1 GROUP BY option_id`,
    [messageId],
  )
  const tallyMap = new Map(tallyRows.map((t) => [t.option_id, { cnt: t.cnt, voters: t.voter_ids }]))
  const lines = row.poll.options.map((o) => {
    const t = tallyMap.get(o.id) ?? { cnt: 0, voters: [] as string[] }
    const mine = t.voters.includes(me) ? ' ← you' : ''
    return `  ${o.id} (${t.cnt}) · ${o.text}${mine}`
  }).join('\n')
  const head = [
    `poll ${messageId} · by ${row.author_id} · mode=${row.poll.mode}`,
    row.poll.closedAt ? `closed at ${row.poll.closedAt}` : (row.poll.expiresAt ? `expires ${row.poll.expiresAt}` : 'open'),
    row.poll.question,
  ].join('\n')
  return ok(`${head}\n${lines}`)
}

async function cmdEmail(parsed: ParsedArgs): Promise<CliResult> {
  const sub = parsed.positional[0]
  if (!sub) {
    return err(
      'usage:\n' +
      '  email send --to <addr|id>[,<addr|id>...] [--cc <...>] --subject "..." --body "..." [--attach <path>[,<path>...]] [--as <id>]\n' +
      '  email reply <message_id> --body "..." [--cc <addr|id>...] [--attach <path>[,<path>...]] [--as <id>]\n' +
      '  email inbox [--unread] [--limit N] [--as <id>]\n' +
      '  email show <conversation_id> [--tail N] [--as <id>]\n' +
      '  email contacts [<query>] [--as <id>]   (or just: cumora contacts [<query>])\n' +
      '  email whoami [--as <id>]   — your own address',
    )
  }
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)

  switch (sub) {
    case 'whoami':   return cmdEmailWhoami(me)
    case 'contacts': return cmdEmailContacts(parsed, me, companyId, Boolean(parsed.flags.json))
    case 'inbox':    return cmdEmailInbox(parsed, me, companyId)
    case 'show':     return cmdEmailShow(parsed, me, companyId)
    case 'send':     return cmdEmailSend(parsed, me, companyId)
    case 'reply':    return cmdEmailReply(parsed, me, companyId)
    default:
      return err(`unknown email subcommand: ${sub}`)
  }
}

async function cmdEmailWhoami(me: string): Promise<CliResult> {
  const { ensureAgentAddress } = await import('../email.js')
  const { env } = await import('../env.js')
  const addr = await ensureAgentAddress(me)
  if (!addr) {
    if (!env.EMAIL_DOMAIN) return err('email feature not configured (set EMAIL_DOMAIN)')
    return err(`no email address available for ${me} (not an agent, or company missing)`)
  }
  return ok(`${addr.displayName} <${addr.email}>`)
}

async function cmdEmailContacts(
  parsed: ParsedArgs,
  me: string,
  companyId: string,
  json: boolean,
): Promise<CliResult> {
  // Optional fuzzy filter: `cumora email contacts wey` matches against
  // name / id / email (substring, case-insensitive). The empty-result
  // path explicitly tells the caller that NO contact matches the query
  // — the agent's LLM uses this signal to ask the user for the address
  // instead of silently doing nothing.
  const query = parsed.positional[1]?.trim() ?? ''
  const list = await listEmailContacts(companyId, me, query)
  if (json) return ok(JSON.stringify(list, null, 2))
  if (list.length === 0) {
    const { env } = await import('../env.js')
    if (!env.EMAIL_DOMAIN) return ok('(email feature not configured — set EMAIL_DOMAIN to enable)')
    if (query) {
      return ok(`(no contacts match "${query}". If the user named someone you don't recognize, ASK them for the email address before guessing — don't silently skip the task.)`)
    }
    return ok('(no email contacts yet — invite someone or wait for inbound mail)')
  }
  // Width is driven by longest entry per column so long names / addresses
  // don't get chopped. Cap so a pathological 300-char address can't blow
  // up the layout — but the cap is generous (60) versus the previous 44.
  const KIND_W = 8
  const nameW = Math.min(40, Math.max(12, ...list.map((c) => c.name.length)))
  // The role column tells the agent WHAT each teammate does — the whole point
  // of a directory. Width tracks the longest role (capped); falls back to a
  // header-width minimum so the column header always fits.
  const roleW = Math.min(24, Math.max(4, ...list.map((c) => (c.role ?? '').length)))
  const addrW = Math.min(60, Math.max(20, ...list.map((c) => c.address.length)))
  const lines = [
    `${'kind'.padEnd(KIND_W)} ${'name'.padEnd(nameW)}  ${'role'.padEnd(roleW)}  ${'address'.padEnd(addrW)}  id`,
    '-'.repeat(KIND_W + 1 + nameW + 2 + roleW + 2 + addrW + 2 + 6),
    ...list.map((c) =>
      `${c.kind.padEnd(KIND_W)} ${c.name.slice(0, nameW).padEnd(nameW)}  ${(c.role ?? '—').slice(0, roleW).padEnd(roleW)}  ${c.address.slice(0, addrW).padEnd(addrW)}  ${c.participantId ?? '—'}`,
    ),
  ]
  return ok(lines.join('\n'))
}

async function cmdEmailInbox(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const unread = Boolean(parsed.flags.unread)
  const limit = Math.min(50, Math.max(1, Number(parsed.flags.limit ?? 20)))
  const threads = await listAgentEmailThreads({ agentId: me, companyId, unreadOnly: unread, limit })
  if (parsed.flags.json) return ok(JSON.stringify(threads, null, 2))
  if (threads.length === 0) {
    // Distinguish "feature not wired" from "feature wired, just empty" so
    // a fresh agent isn't left guessing whether mail is broken vs quiet.
    const { env } = await import('../env.js')
    if (!env.EMAIL_DOMAIN) {
      return ok('(email feature not configured — set EMAIL_DOMAIN to enable inbound + outbound)')
    }
    return ok(unread ? `(no unread email for ${me})` : `(no email threads for ${me} yet)`)
  }
  const lines: string[] = []
  for (const t of threads) {
    const unreadTag = t.unread_count > 0 ? ` ★${t.unread_count}` : ''
    // Keep full subject + from — the LLM consumer reads better with all
    // content visible; truncation only hurt narrow terminals, and those
    // aren't our audience here.
    const subject = t.last_subject ?? t.title ?? '(no subject)'
    const from = t.last_from ?? '?'
    const snippet = (t.last_body ?? '').slice(0, 240).replace(/\n+/g, ' \\n ')
    const at = t.last_at ? new Date(t.last_at).toISOString().replace('T', ' ').slice(0, 16) : ''
    lines.push(`# ${t.conversation_id}${unreadTag}  [${at}]`)
    lines.push(`  from:    ${from}`)
    lines.push(`  subject: ${subject}`)
    if (snippet) lines.push(`  body:    ${snippet}`)
    lines.push('')
  }
  lines.push(`run \`cumora email show <conversation_id>\` to read the full thread, then \`cumora email reply <message_id> --body "..."\` to respond. \`cumora ack <conversation_id>\` clears unread state.`)
  return ok(lines.join('\n'))
}

async function cmdEmailShow(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const convoId = parsed.positional[1]
  if (!convoId) return err('usage: email show <conversation_id> [--tail N]')
  const tail = Math.min(50, Math.max(1, Number(parsed.flags.tail ?? 10)))
  // Confirm membership — agents can only read threads they're on.
  const { rows: cv } = await pool.query<{ members: string[]; title: string }>(
    `SELECT members, title FROM conversations
      WHERE id = $1 AND company_id = $2 AND kind = 'email' LIMIT 1`,
    [convoId, companyId],
  )
  if (!cv[0]) return err(`unknown email thread ${convoId}`)
  if (!cv[0].members.includes(me)) return err(`${me} is not a member of ${convoId}`)
  const { rows: msgs } = await pool.query<{
    id: string; created_at: string; body: string; from_addr: string;
    to_addrs: string[]; cc_addrs: string[]; subject: string;
    smtp_message_id: string | null; in_reply_to: string | null;
    direction: 'in' | 'out'; transport_status: string;
  }>(
    `SELECT m.id, m.created_at::text, m.body,
            em.from_addr, em.to_addrs, em.cc_addrs, em.subject,
            em.smtp_message_id, em.in_reply_to, em.direction, em.transport_status
       FROM messages m
       JOIN email_messages em ON em.message_id = m.id
      WHERE m.conversation_id = $1
      ORDER BY m.sequence DESC
      LIMIT $2`,
    [convoId, tail],
  )
  msgs.reverse()
  if (parsed.flags.json) return ok(JSON.stringify({ thread: convoId, title: cv[0].title, messages: msgs }, null, 2))
  if (msgs.length === 0) return ok(`(thread ${convoId} has no email messages)`)
  const lines: string[] = [`thread ${convoId}  "${cv[0].title}"`, '']
  for (const m of msgs) {
    const at = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 16)
    const arrow = m.direction === 'in' ? '↓ in' : '↑ out'
    lines.push(`────  [${m.id}]  ${arrow}  ${m.transport_status}  ${at}`)
    lines.push(`from:    ${m.from_addr}`)
    if (m.to_addrs?.length) lines.push(`to:      ${m.to_addrs.join(', ')}`)
    if (m.cc_addrs?.length) lines.push(`cc:      ${m.cc_addrs.join(', ')}`)
    lines.push(`subject: ${m.subject}`)
    if (m.in_reply_to) lines.push(`in-reply-to: <${m.in_reply_to}>`)
    lines.push('')
    lines.push(m.body)
    lines.push('')
  }
  lines.push(`reply with \`cumora email reply ${msgs[msgs.length - 1].id} --body "..."\`.`)
  return ok(lines.join('\n'))
}

async function cmdEmailSend(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const toRaw = parsed.flags.to ? String(parsed.flags.to) : ''
  const ccRaw = parsed.flags.cc ? String(parsed.flags.cc) : ''
  const {
    ensureAgentAddress,
    formatAddress,
    sendViaProvider,
    findOrCreateEmailConversation,
    persistEmailMessage,
    mintMessageId,
    sanitizeSubject,
  } = await import('../email.js')
  const subject = sanitizeSubject(unescapeChat(String(parsed.flags.subject ?? '')))
  const body = unescapeChat(String(parsed.flags.body ?? '')).trim()
  // --attach takes a comma-separated list of paths (also accepts the same
  // flag repeated by the agent — bin/cumora collapses repeats into the
  // last value, so comma is the supported multi-attach syntax here).
  const attachRaw = parsed.flags.attach ? String(parsed.flags.attach) : ''
  if (!toRaw || !subject || !body) {
    return err('usage: email send --to <addr|id>[,...] [--cc <...>] --subject "..." --body "..." [--attach <path>[,<path>...]]')
  }
  const attachPaths = attachRaw.split(',').map((s) => s.trim()).filter(Boolean)
  const loadedAttachments: Awaited<ReturnType<typeof loadEmailAttachmentFromPath>>[] = []
  for (const p of attachPaths) {
    try {
      loadedAttachments.push(await loadEmailAttachmentFromPath(p))
    } catch (e) {
      return err(`attachment ${p}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const sender = await ensureAgentAddress(me)
  if (!sender) return err('agent has no email address (EMAIL_DOMAIN unset or company missing)')

  const toItems = toRaw.split(',').map((s) => s.trim()).filter(Boolean)
  const ccItems = ccRaw.split(',').map((s) => s.trim()).filter(Boolean)
  const toResolved: { addr: string; name: string | null }[] = []
  const ccResolved: { addr: string; name: string | null }[] = []
  for (const t of toItems) {
    const r = await resolveEmailRecipient(t, companyId)
    if (!r) return err(`can't resolve recipient: ${t}`)
    toResolved.push(r)
  }
  for (const c of ccItems) {
    const r = await resolveEmailRecipient(c, companyId)
    if (!r) return err(`can't resolve cc: ${c}`)
    ccResolved.push(r)
  }
  if (toResolved.length === 0) return err('at least one --to recipient required')

  // Recipient agents in this same company become conversation members.
  const memberIds = new Set<string>([me])
  for (const r of [...toResolved, ...ccResolved]) {
    const inHouse = await pool.query<{ id: string }>(
      `SELECT id FROM participants
        WHERE LOWER(email) = $1 AND company_id = $2 AND departed_at IS NULL LIMIT 1`,
      [r.addr, companyId],
    )
    if (inHouse.rows[0]) memberIds.add(inHouse.rows[0].id)
  }

  const messageId = mintMessageId()
  const conv = await findOrCreateEmailConversation({
    companyId,
    inReplyTo: null,
    references: [],
    subject,
    memberIds: [...memberIds],
  })

  // Call the provider FIRST so we record sent/failed accurately. If
  // anything throws we still write a queued/failed row — the agent
  // shouldn't lose the draft just because Resend hiccuped.
  const sendRes = await sendViaProvider({
    from: formatAddress(sender.email, sender.displayName),
    to: toResolved.map((r) => formatAddress(r.addr, r.name)),
    cc: ccResolved.length ? ccResolved.map((r) => formatAddress(r.addr, r.name)) : undefined,
    subject,
    text: body,
    messageId,
    autoSubmitted: 'auto-generated',
    attachments: loadedAttachments.map((a) => ({
      filename: a.filename, mimeType: a.mimeType, base64: a.base64,
    })),
  })

  const persisted = await persistEmailMessage({
    conversationId: conv.conversationId,
    companyId,
    authorId: me,
    direction: 'out',
    transportStatus: sendRes.ok ? 'sent' : 'failed',
    transportError: sendRes.error,
    smtpMessageId: sendRes.smtpMessageId ?? messageId,
    inReplyTo: null,
    references: [],
    subject,
    fromAddr: formatAddress(sender.email, sender.displayName),
    toAddrs: toResolved.map((r) => formatAddress(r.addr, r.name)),
    ccAddrs: ccResolved.map((r) => formatAddress(r.addr, r.name)),
    body,
    autoSubmitted: true,
    attachments: loadedAttachments.map((a) => ({
      filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
      storageKey: a.storageKey,
    })),
  })

  if (!sendRes.ok) {
    return err(`email persisted as failed: ${sendRes.error} · message_id=${persisted.messageId}`, 1)
  }
  const mockTag = sendRes.mock ? ' (mock — no real send)' : ''
  return ok(`sent${mockTag} · ${persisted.messageId} · thread ${conv.conversationId}`, [{
    event: 'email.sent',
    command: 'email send',
    conversationId: conv.conversationId,
    messageId: persisted.messageId,
    authorId: me,
    companyId,
    subject,
    to: toResolved.map((r) => r.addr),
    cc: ccResolved.map((r) => r.addr),
    attachmentCount: loadedAttachments.length,
    transportStatus: 'sent',
    mock: sendRes.mock,
    visibleToUser: true,
  }])
}

async function cmdEmailReply(parsed: ParsedArgs, me: string, companyId: string): Promise<CliResult> {
  const replyTo = parsed.positional[1]
  const body = unescapeChat(String(parsed.flags.body ?? '')).trim()
  const attachRaw = parsed.flags.attach ? String(parsed.flags.attach) : ''
  if (!replyTo || !body) return err('usage: email reply <message_id> --body "..." [--cc <addr|id>...] [--attach <path>[,<path>...]]')
  const attachPaths = attachRaw.split(',').map((s) => s.trim()).filter(Boolean)
  const loadedAttachments: Awaited<ReturnType<typeof loadEmailAttachmentFromPath>>[] = []
  for (const p of attachPaths) {
    try {
      loadedAttachments.push(await loadEmailAttachmentFromPath(p))
    } catch (e) {
      return err(`attachment ${p}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Pull the original email row and its conversation context.
  const { rows: orig } = await pool.query<{
    conversation_id: string
    smtp_message_id: string | null
    references_chain: string[]
    subject: string
    from_addr: string
    to_addrs: string[]
    cc_addrs: string[]
  }>(
    `SELECT conversation_id, smtp_message_id, references_chain,
            subject, from_addr, to_addrs, cc_addrs
       FROM email_messages WHERE message_id = $1 AND company_id = $2`,
    [replyTo, companyId],
  )
  if (!orig[0]) return err(`unknown email message ${replyTo}`)
  const o = orig[0]
  // Confirm membership — same gate as `email show`.
  const { rows: cv } = await pool.query<{ members: string[] }>(
    `SELECT members FROM conversations WHERE id = $1`, [o.conversation_id],
  )
  if (!cv[0] || !cv[0].members.includes(me)) {
    return err(`${me} is not a member of thread ${o.conversation_id}`)
  }

  const {
    ensureAgentAddress, formatAddress,
    sendViaProvider, persistEmailMessage, mintMessageId, normalizeMessageId,
    sanitizeSubject, splitReplyAddresses,
  } = await import('../email.js')
  const sender = await ensureAgentAddress(me)
  if (!sender) return err('agent has no email address (EMAIL_DOMAIN unset or company missing)')

  // Reply-all split: TO = original From, CC = original To+Cc minus self.
  // Earlier iterations collapsed everyone into TO; that read fine but
  // dropped the informed-vs.-required signal real clients rely on.
  const { to: toAddrs, cc: ccFromOriginal } = splitReplyAddresses({
    originalFrom: o.from_addr,
    originalTo: o.to_addrs ?? [],
    originalCc: o.cc_addrs ?? [],
    selfAddresses: [sender.email],
  })
  if (toAddrs.length === 0) return err('no other recipients to reply to')

  // Extra cc from --cc, resolved like in `send` — appended to the
  // original CC list (self is already filtered out by splitReplyAddresses;
  // we de-dupe against toAddrs + ccFromOriginal below).
  const ccItems = parsed.flags.cc ? String(parsed.flags.cc).split(',').map((s) => s.trim()).filter(Boolean) : []
  const ccResolved: { addr: string; name: string | null }[] = []
  for (const c of ccItems) {
    const r = await resolveEmailRecipient(c, companyId)
    if (!r) return err(`can't resolve cc: ${c}`)
    ccResolved.push(r)
  }
  const extractAddr = (raw: string) => {
    const m = /<([^>]+)>/.exec(raw)
    return (m ? m[1] : raw).toLowerCase()
  }
  const ccSeen = new Set<string>([
    sender.email.toLowerCase(),
    ...toAddrs.map(extractAddr),
    ...ccFromOriginal.map(extractAddr),
  ])
  const ccCombined: string[] = [...ccFromOriginal]
  for (const r of ccResolved) {
    if (ccSeen.has(r.addr)) continue
    ccSeen.add(r.addr)
    ccCombined.push(formatAddress(r.addr, r.name))
  }

  const subject = /^(re|fwd|fw)\s*:/i.test(o.subject) ? sanitizeSubject(o.subject) : sanitizeSubject(`Re: ${o.subject}`)
  const newReferences = [
    ...(o.references_chain ?? []),
    ...(o.smtp_message_id ? [o.smtp_message_id] : []),
  ].filter((x): x is string => Boolean(x))
  const inReplyTo = o.smtp_message_id ? normalizeMessageId(o.smtp_message_id) : null
  const messageId = mintMessageId()

  const sendRes = await sendViaProvider({
    from: formatAddress(sender.email, sender.displayName),
    to: toAddrs,
    cc: ccCombined.length ? ccCombined : undefined,
    subject,
    text: body,
    inReplyTo: inReplyTo ?? undefined,
    references: newReferences,
    messageId,
    autoSubmitted: 'auto-replied',
    attachments: loadedAttachments.map((a) => ({
      filename: a.filename, mimeType: a.mimeType, base64: a.base64,
    })),
  })

  const persisted = await persistEmailMessage({
    conversationId: o.conversation_id,
    companyId,
    authorId: me,
    direction: 'out',
    transportStatus: sendRes.ok ? 'sent' : 'failed',
    transportError: sendRes.error,
    smtpMessageId: sendRes.smtpMessageId ?? messageId,
    inReplyTo,
    references: newReferences,
    subject,
    fromAddr: formatAddress(sender.email, sender.displayName),
    toAddrs,
    ccAddrs: ccCombined,
    body,
    autoSubmitted: true,
    attachments: loadedAttachments.map((a) => ({
      filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
      storageKey: a.storageKey,
    })),
  })

  // Auto-ack — replying definitionally means I read the original.
  await pool.query(
    `INSERT INTO conversation_reads (user_id, conversation_id, last_read_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, conversation_id) DO UPDATE SET last_read_at = NOW()`,
    [me, o.conversation_id],
  )

  if (!sendRes.ok) return err(`email persisted as failed: ${sendRes.error} · ${persisted.messageId}`, 1)
  const mockTag = sendRes.mock ? ' (mock)' : ''
  return ok(`replied${mockTag} · ${persisted.messageId} · thread ${o.conversation_id}`, [{
    event: 'email.sent',
    command: 'email reply',
    conversationId: o.conversation_id,
    messageId: persisted.messageId,
    authorId: me,
    companyId,
    replyToMessageId: replyTo,
    subject,
    to: toAddrs,
    cc: ccCombined,
    attachmentCount: loadedAttachments.length,
    transportStatus: 'sent',
    mock: sendRes.mock,
    visibleToUser: true,
  }])
}

async function cmdAvatar(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0]
  if (op !== 'regen' && op !== 'regenerate' && op !== 'set' && op !== 'show') {
    return err(
      'usage:\n' +
      '  avatar show <participant_id>        view a teammate\'s portrait URL (download + open it to actually see the image)\n' +
      '  avatar regen [--as <id>]            regenerate your portrait from your persona\n' +
      '  avatar set <image_url> [--as <id>]  adopt an existing image URL as your portrait',
    )
  }
  const me = resolveAs(parsed)

  // Resolve the agent's tenant — avatar lookups are tenant-scoped (you can only
  // look at teammates in your own workspace).
  const { rows } = await pool.query<{ company_id: string; kind: string }>(
    `SELECT company_id, kind FROM participants WHERE id = $1`, [me],
  )
  if (!rows[0]) return err(`unknown participant ${me}`)
  // `show` is read-only and works for any caller (agent OR human); `regen`/`set`
  // mutate the caller's OWN portrait, so they stay agent-only.
  if (op !== 'show' && rows[0].kind !== 'agent') return err('avatar ops are only for agents')
  const tenant = rows[0].company_id

  if (op === 'show') {
    const target = parsed.positional[1]
    if (!target) return err('usage: avatar show <participant_id>')
    const { rows: t } = await pool.query<{
      id: string; name: string; role: string | null; kind: string; avatar_url: string | null
    }>(
      `SELECT id, name, role, kind, avatar_url FROM participants
        WHERE id = $1 AND company_id = $2 AND departed_at IS NULL`,
      [target, tenant],
    )
    if (!t[0]) return err(`unknown participant ${target} in this workspace`)
    const r = t[0]
    const who = `${r.name} (${r.id}) — ${r.kind}${r.role ? `, ${r.role}` : ''}`
    if (!r.avatar_url) return ok(`${who}\n(no avatar set)`)
    // We give the URL + a recipe. The CLI's tool-result text channel doesn't
    // auto-feed vision (that's reserved for message attachments), so to ACTUALLY
    // see the face the agent downloads the file and opens it with whatever image-
    // reading tool the engine provides (Claude Code: \`Read <path>\` shows images
    // inline; Codex: open the saved file).
    return ok(
      `${who}\n` +
      `avatar URL: ${r.avatar_url}\n\n` +
      `To actually SEE the image, save it locally then open it with your image-reading tool:\n` +
      `  curl -sL '${r.avatar_url}' -o /tmp/${r.id}-avatar\n` +
      `then open \`/tmp/${r.id}-avatar\` with your Read / view-image tool.`,
    )
  }

  if (op === 'set') {
    const url = parsed.positional[1]
    if (!url) return err('usage: avatar set <image_url> [--as <id>]')
    try {
      const result = await setAgentAvatarFromUrl({ agentId: me, tenant, sourceUrl: url })
      return ok(`portrait set → ${result.url}`, [{
        event: 'avatar.updated',
        command: 'avatar set',
        agentId: me,
        companyId: tenant,
        avatarUrl: result.url,
      }])
    } catch (e) {
      return err(`avatar set failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // op === 'regen' | 'regenerate'
  try {
    const { generateAndPersistAvatar } = await import('../api/router.js')
    const { url } = await generateAndPersistAvatar({ agentId: me, tenant })
    return ok(`new portrait → ${url}`, [{
      event: 'avatar.updated',
      command: 'avatar regen',
      agentId: me,
      companyId: tenant,
      avatarUrl: url,
    }])
  } catch (e) {
    return err(`avatar regen failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Fetch an image at `sourceUrl`, validate it, re-upload it under the
 *  agent's `avatars/` storage key, stamp participants.avatar_url, and
 *  broadcast the change so connected clients refresh. The source URL
 *  can be one of our own attachments (e.g. an image the user just sent
 *  the agent) or any external URL — we always re-upload so the canonical
 *  avatar lives under our storage and serves through our CDN. */
async function setAgentAvatarFromUrl(args: {
  agentId: string
  tenant: string
  sourceUrl: string
}): Promise<{ url: string }> {
  if (!/^https?:\/\//.test(args.sourceUrl)) {
    throw new Error('avatar source must be an http(s) URL')
  }
  const MAX_BYTES = 8 * 1024 * 1024  // 8MB ceiling for portraits
  const fetched = await fetchImageBytes(args.sourceUrl, {
    maxBytes: MAX_BYTES,
    timeoutMs: 15_000,
  })
  if (!fetched.ok) {
    if (fetched.reason === 'http') throw new Error(`source URL returned ${fetched.status ?? 'an error'}`)
    if (fetched.reason === 'bad-type') throw new Error('source URL is not an image')
    if (fetched.reason === 'too-large') throw new Error(`source image exceeds ${MAX_BYTES} bytes`)
    if (fetched.reason === 'blocked') throw new Error('source URL is not allowed')
    if (fetched.reason === 'timeout') throw new Error('source URL timed out')
    throw new Error('source URL could not be fetched')
  }
  const { buffer: buf, mime } = fetched
  if (buf.length === 0) throw new Error('source image is empty')

  // Pick a sensible extension from the mime so the stored object has a
  // useful filename and the Worker serves the right content-type.
  const ext = mime === 'image/jpeg' ? 'jpg'
            : mime === 'image/webp' ? 'webp'
            : mime === 'image/gif'  ? 'gif'
            : mime === 'image/svg+xml' ? 'svg'
            : 'png'
  const { storage } = await import('../storage.js')
  const { randomUUID } = await import('node:crypto')
  const key = `avatars/avatar-${args.agentId}-${randomUUID().slice(0, 8)}.${ext}`
  const url = await storage.put(key, buf, mime)

  await pool.query(
    `UPDATE participants SET avatar_url = $2 WHERE id = $1 AND company_id = $3`,
    [args.agentId, url, args.tenant],
  )
  const { invalidatePersonaCache } = await import('./personas.js')
  invalidatePersonaCache(args.agentId)
  const { CH_STATUS, publish } = await import('../redis.js')
  await publish(CH_STATUS, {
    type: 'participants.avatar',
    participantId: args.agentId,
    avatarUrl: url,
    companyId: args.tenant,
  })
  return { url }
}

async function saveTextAttachment(
  filename: string,
  content: string,
): Promise<{ url: string; name: string; kind: 'file'; mime: string; size: number; key: string }> {
  // Sniff a reasonable mime from the extension so the renderer + agent
  // both know how to handle it (text/* gets inlined into context on read).
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : 'txt'
  const mime = (() => {
    switch (ext) {
      case 'md': return 'text/markdown'
      case 'json': return 'application/json'
      case 'csv': return 'text/csv'
      case 'html': return 'text/html'
      case 'yml':
      case 'yaml': return 'application/x-yaml'
      case 'toml': return 'application/x-toml'
      default: return 'text/plain'
    }
  })()
  const buf = Buffer.from(content, 'utf8')
  const { randomUUID } = await import('node:crypto')
  const id = randomUUID().replace(/-/g, '')
  const key = `attachments/${id}.${ext}`
  const url = await storage.put(key, buf, mime)
  return { url, key, name: filename, kind: 'file', mime, size: buf.length }
}

async function cmdTopicRead(parsed: ParsedArgs): Promise<CliResult> {
  const convoId = parsed.positional[0]
  if (!convoId) return err('usage: topic <conversation_id>')
  const { rows } = await pool.query<{ topic: string | null; title: string }>(
    `SELECT topic, title FROM conversations WHERE id = $1`, [convoId],
  )
  if (!rows[0]) return err(`unknown conversation ${convoId}`)
  const t = rows[0].topic
  if (!t) return ok(`(no topic set on "${rows[0].title}")`)
  return ok(t)
}

async function cmdTopicSet(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = parsed.positional[0]
  if (!convoId) return err('usage: topic-set <conversation_id> "<text>"  (empty body clears the topic)')
  const raw = unescapeChat(parsed.positional.slice(1).join(' ')).trim()
  const topic = raw.length > 0 ? raw.slice(0, 200) : null

  const { rows } = await pool.query<{ members: string[]; company_id: string }>(
    `SELECT members, company_id FROM conversations WHERE id = $1`, [convoId],
  )
  if (!rows[0]) return err(`unknown conversation ${convoId}`)
  if (!rows[0].members.includes(me)) return err(`${me} is not a member of ${convoId}`)

  await pool.query(
    `UPDATE conversations SET topic = $2, updated_at = NOW() WHERE id = $1`,
    [convoId, topic],
  )
  const { CH_CONVO_UPDATED, publish } = await import('../redis.js')
  await publish(CH_CONVO_UPDATED, {
    type: 'conversation.updated',
    conversationId: convoId,
    companyId: rows[0].company_id,
    patch: { topic },
  })
  return ok(topic ? `topic set: "${topic}"` : '(topic cleared)', [{
    event: 'conversation.topic_updated',
    command: 'topic-set',
    conversationId: convoId,
    actorId: me,
    companyId: rows[0].company_id,
    topic,
    visibleToUser: true,
  }])
}

/** Rename a group conversation. Members only; groups only (a DM/whisper title is
 *  the other person's name). Mirrors the human POST /conversations/:id/title. */
async function cmdRename(parsed: ParsedArgs): Promise<CliResult> {
  const me = resolveAs(parsed)
  const convoId = parsed.positional[0]
  if (!convoId) return err('usage: rename <conversation_id> "<new title>"')
  const title = unescapeChat(parsed.positional.slice(1).join(' ')).trim().slice(0, 80)
  if (!title) return err('rename requires a non-empty title')

  const { rows } = await pool.query<{ members: string[]; kind: string; company_id: string; title: string }>(
    `SELECT members, kind, company_id, title FROM conversations WHERE id = $1`, [convoId],
  )
  if (!rows[0]) return err(`unknown conversation ${convoId}`)
  if (rows[0].kind !== 'group') return err(`only group chats can be renamed (${convoId} is a ${rows[0].kind})`)
  if (!rows[0].members.includes(me)) return err(`${me} is not a member of ${convoId}`)
  const currentTitle = rows[0].title

  // Optimistic-concurrency: --if-equals "<expected current title>" lets a caller
  // declare what title they BELIEVE is current. A mismatch means someone else
  // already renamed it (or it never matched) → reject so the caller re-reads the
  // state rather than blindly overwriting. Catches the "I'll rename it for you,
  // Yulemi" pile-on race where Atlas guesses a different name than Nova.
  const ifEqualsRaw = parsed.flags['if-equals']
  if (typeof ifEqualsRaw === 'string') {
    const ifEquals = unescapeChat(ifEqualsRaw).trim().slice(0, 80)
    if (currentTitle !== ifEquals) {
      return err(`stale: current title is "${currentTitle}", you passed --if-equals "${ifEquals}". Re-read with \`cumora conversations\` and decide if you still want to rename.`)
    }
  }
  // IDEMPOTENT no-op: if the title is already what you'd set, return success
  // WITHOUT firing a conversation.renamed event or broadcasting an update. This
  // suppresses the noise when N agents all decide to rename to the same string
  // at the same instant — the chat doesn't see N identical rename events. Only
  // a TRUE change writes through. (A divergent-names race still last-writer-wins
  // for the storage; --if-equals is the lever against that.)
  if (currentTitle === title) {
    return ok(`(no-op — title was already "${title}")`)
  }

  await pool.query(
    `UPDATE conversations SET title = $2, updated_at = NOW() WHERE id = $1`,
    [convoId, title],
  )
  const { CH_CONVO_UPDATED, publish } = await import('../redis.js')
  await publish(CH_CONVO_UPDATED, {
    type: 'conversation.updated',
    conversationId: convoId,
    companyId: rows[0].company_id,
    patch: { title },
  })
  return ok(`renamed to "${title}" (${convoId})`, [{
    event: 'conversation.renamed',
    command: 'rename',
    conversationId: convoId,
    actorId: me,
    companyId: rows[0].company_id,
    title,
    visibleToUser: true,
  }])
}

/* ============== private agent state: memory / log / workspace / tasks ============== */

/** Whitelisted memory kinds. Becomes a path segment, so we keep it
 *  small + slug-safe — agents can't write `memory/Whatever-They-Want/`. */
const MEMORY_KINDS = ['observation', 'preference', 'fact', 'decision', 'note'] as const
type MemoryKind = typeof MEMORY_KINDS[number]
function normalizeMemoryKind(raw: unknown): MemoryKind {
  const s = String(raw ?? '').trim().toLowerCase()
  return (MEMORY_KINDS as readonly string[]).includes(s) ? s as MemoryKind : 'observation'
}

/** Memory is stored as files inside the agent's workspace under
 *  `memory/<kind>/<id>.md` (global) or `memory/projects/<projectId>/<kind>/<id>.md`.
 *  Structured fields (`kind`, `about`, `pinned`, `source`, `createdAt`) live
 *  in the `meta` JSONB column. New writes stamp `source.conversationId` /
 *  `source.projectId` (issue #45); existing `source: null` rows stay GLOBAL
 *  — we never guess-migrate them into a project. See memory-scope.ts. */
async function cmdMemory(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0]
  const me = resolveAs(parsed)
  const explicitConvo = (typeof parsed.flags.in === 'string' ? parsed.flags.in : null)
    ?? (typeof parsed.flags.conversation === 'string' ? parsed.flags.conversation : null)
  if (op === 'list') {
    const params: unknown[] = [me]
    let where = `agent_id = $1 AND path LIKE 'memory/%'`
    if (parsed.flags.about) {
      params.push(String(parsed.flags.about))
      where += ` AND meta->>'about' = $${params.length}`
    }
    if (parsed.flags.kind) {
      const k = normalizeMemoryKind(parsed.flags.kind)
      params.push(`memory/${k}/%`)
      params.push(`memory/projects/%/${k}/%`)
      where += ` AND (path LIKE $${params.length - 1} OR path LIKE $${params.length})`
    }
    const limit = Math.min(100, Math.max(1, Number(parsed.flags.limit ?? 20)))
    // Fetch extra rows so in-memory project filtering can still fill `limit`.
    // `--all` is the only path that skips isolation.
    const fetchLimit = Boolean(parsed.flags.all) ? limit : Math.min(500, Math.max(limit * 10, 100))
    params.push(fetchLimit)
    const limitParam = `$${params.length}`
    const { rows } = await pool.query<{
      path: string; body: string; meta: Record<string, unknown> | null; updated_at: string
    }>(
      `SELECT path, body, meta, updated_at
         FROM agent_workspace WHERE ${where}
         ORDER BY COALESCE((meta->>'pinned')::boolean, false) DESC, updated_at DESC
         LIMIT ${limitParam}`,
      params,
    )
    const parsed_rows = rows.map((r) => {
      const parsedPath = parseMemoryPath(r.path)
      const kind = parsedPath?.kind ?? 'note'
      const id = parsedPath?.id ?? ''
      const about = (r.meta?.about as string | undefined) ?? null
      const pinned = Boolean(r.meta?.pinned)
      const source = asMemorySource(r.meta?.source)
      return {
        id, kind, about, body: r.body, pinned, created_at: r.updated_at,
        path: r.path,
        projectId: parsedPath?.projectId ?? source?.projectId ?? null,
        meta: r.meta,
        source,
      }
    })
    const showAll = Boolean(parsed.flags.all)
    let scoped = parsed_rows
    if (!showAll) {
      const writeSource = await resolveMemoryWriteSource(me, { conversationId: explicitConvo })
      const projectIds = writeSource.projectId ? [writeSource.projectId] : []
      scoped = parsed_rows.filter((r) => memoryVisibleInScope(
        { pinned: r.pinned, source: r.source },
        r.path,
        { projectIds },
      ))
      scoped = scoped.slice(0, limit)
    }
    if (parsed.flags.json) return ok(JSON.stringify(scoped.map(({ meta, path, ...rest }) => rest), null, 2))
    if (scoped.length === 0) return ok(`(${me} has no memory yet)`)
    return ok([
      `${scoped.length} memory record(s) for ${me}:`,
      '',
      ...scoped.map((m) => {
        const t = new Date(m.created_at).toLocaleDateString()
        const pin = m.pinned ? '★ ' : '  '
        const proj = m.projectId ? ` proj:${m.projectId}` : ' global'
        return `  ${pin}[${m.id.slice(0, 10)}] ${m.kind.padEnd(11)} ${(m.about ?? '-').padEnd(10)} ${t}${proj}\n      ${m.body.slice(0, 280).replace(/\n/g, ' \\n ')}`
      }),
    ].join('\n'))
  }
  if (op === 'note') {
    const body = parsed.positional[1]
    if (!body) return err('usage: memory note <body> [--about subject] [--kind kind] [--in convo] [--as id]')
    const kind = normalizeMemoryKind(parsed.flags.kind ?? 'observation')
    const about = parsed.flags.about ? String(parsed.flags.about) : null
    const id = `mem-${randomUUID().slice(0, 12)}`
    const source = await resolveMemoryWriteSource(me, { conversationId: explicitConvo })
    const path = memoryWritePath(kind, id, source.projectId)
    const tenant = await agentCompany(me)
    const meta = await memoryMetaForWrite(me, {
      path, kind, about, conversationId: explicitConvo, projectId: source.projectId,
    })
    // Compute the embedding before INSERT so the row lands with both
    // body + vector in one shot. `embedText` returns null on failure
    // (rate limit, network blip, etc.) — we still write the row so the
    // memory isn't lost; the next background backfill will fill it in.
    const { embedText } = await import('./embeddings.js')
    const embedding = await embedText(body)
    if (embedding) {
      await pool.query(
        `INSERT INTO agent_workspace (agent_id, path, body, meta, embedding, company_id, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::vector, $6, NOW())`,
        [me, path, body, JSON.stringify(meta), embedding, tenant],
      )
    } else {
      await pool.query(
        `INSERT INTO agent_workspace (agent_id, path, body, meta, company_id, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
        [me, path, body, JSON.stringify(meta), tenant],
      )
    }
    await pool.query(
      `INSERT INTO agent_log (id, agent_id, kind, body, ref) VALUES ($1, $2, 'note', $3, $4::jsonb)`,
      [`log-${randomUUID().slice(0, 12)}`, me, `noted: ${body.slice(0, 120)}`, JSON.stringify({ memoryId: id, path })],
    )
    return ok(`saved memory ${id}`, [{
      event: 'memory.written',
      command: 'memory note',
      memoryId: id,
      path,
      agentId: me,
      kind,
      about,
    }])
  }
  if (op === 'pin') {
    const id = parsed.positional[1]
    if (!id) return err('usage: memory pin <id>')
    const r = await pool.query<{ meta: Record<string, unknown> }>(
      `UPDATE agent_workspace
          SET meta = COALESCE(meta, '{}'::jsonb)
                   || jsonb_build_object('pinned', NOT COALESCE((meta->>'pinned')::boolean, false))
        WHERE agent_id = $1 AND path LIKE $2
        RETURNING meta`,
      [me, `memory/%/${id}.md`],
    )
    if ((r.rowCount ?? 0) === 0) return err(`no memory ${id} for ${me}`)
    return ok(`pinned: ${r.rows[0].meta?.pinned}`, [{
      event: 'memory.pinned',
      command: 'memory pin',
      memoryId: id,
      agentId: me,
      pinned: Boolean(r.rows[0].meta?.pinned),
    }])
  }
  if (op === 'delete') {
    const id = parsed.positional[1]
    if (!id) return err('usage: memory delete <id>')
    const r = await pool.query(
      `DELETE FROM agent_workspace WHERE agent_id = $1 AND path LIKE $2`,
      [me, `memory/%/${id}.md`],
    )
    if ((r.rowCount ?? 0) === 0) return err(`no memory ${id} for ${me}`)
    return ok(`deleted ${id}`, [{
      event: 'memory.deleted',
      command: 'memory delete',
      memoryId: id,
      agentId: me,
    }])
  }
  return err(`usage: memory <list|note|pin|delete> [...]`)
}

/* ============== Climate (情感系统) — per-agent feelings about people ============== */

/** Clamp to [-1, 1]; coerces strings/numbers; falls back to 0 on garbage. */
function clamp01(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(-1, Math.min(1, n))
}

async function cmdClimate(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'read'
  const me = resolveAs(parsed)

  if (op === 'read') {
    const about = parsed.positional[1]
    const params: unknown[] = [me]
    let where = `agent_id = $1`
    if (about) { params.push(about); where += ` AND about_id = $${params.length}` }
    const { rows } = await pool.query<{
      about_id: string; affinity: number; trust: number; last_note: string; updated_at: string
    }>(
      `SELECT about_id, affinity, trust, last_note, updated_at
         FROM agent_climate WHERE ${where}
         ORDER BY updated_at DESC LIMIT 50`,
      params,
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) {
      return ok(about
        ? `(no climate noted for ${me} → ${about})`
        : `(no climate notes saved yet for ${me})`)
    }
    const fmt = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2))
    return ok([
      `Climate around ${me} (${rows.length} relationship${rows.length === 1 ? '' : 's'}):`,
      '',
      ...rows.map((r) => {
        const t = new Date(r.updated_at).toLocaleDateString()
        return `  ${r.about_id.padEnd(10)}  affinity=${fmt(r.affinity)}  trust=${fmt(r.trust)}  ${t}\n      ${r.last_note.slice(0, 240).replace(/\n/g, ' \\n ')}`
      }),
    ].join('\n'))
  }

  if (op === 'note') {
    // usage: climate note <about_id> "<note>" [--affinity n] [--trust n] [--as id]
    const aboutId = parsed.positional[1]
    const note = unescapeChat(parsed.positional.slice(2).join(' ')).trim()
    if (!aboutId || !note) {
      return err('usage: climate note <about_id> "<note>" [--affinity -1..1] [--trust -1..1]')
    }
    const affinityFlag = parsed.flags.affinity
    const trustFlag = parsed.flags.trust
    // Read prior so we can seed the deltas if the agent didn't supply them.
    const { rows: prior } = await pool.query<{
      affinity: number; trust: number; history: unknown
    }>(
      `SELECT affinity, trust, history FROM agent_climate WHERE agent_id = $1 AND about_id = $2`,
      [me, aboutId],
    )
    const prevAffinity = prior[0]?.affinity ?? 0
    const prevTrust = prior[0]?.trust ?? 0
    const nextAffinity = affinityFlag !== undefined ? clamp01(affinityFlag) : prevAffinity
    const nextTrust    = trustFlag    !== undefined ? clamp01(trustFlag)    : prevTrust
    // Append a small history entry. Cap history length so it doesn't grow
    // unbounded — keep only the last 20 notes.
    const prevHistory = Array.isArray(prior[0]?.history) ? prior[0]!.history as Array<unknown> : []
    const newHistory = [
      ...prevHistory.slice(-19),
      { at: new Date().toISOString(), affinity: nextAffinity, trust: nextTrust, note: note.slice(0, 400) },
    ]
    await pool.query(
      `INSERT INTO agent_climate (agent_id, about_id, affinity, trust, last_note, history, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (agent_id, about_id) DO UPDATE
         SET affinity = EXCLUDED.affinity,
             trust    = EXCLUDED.trust,
             last_note = EXCLUDED.last_note,
             history   = EXCLUDED.history,
             updated_at = NOW()`,
      [me, aboutId, nextAffinity, nextTrust, note.slice(0, 400), JSON.stringify(newHistory)],
    )
    return ok(`climate updated: ${me} → ${aboutId}  affinity=${nextAffinity.toFixed(2)}  trust=${nextTrust.toFixed(2)}`, [{
      event: 'climate.updated',
      command: 'climate note',
      agentId: me,
      aboutId,
      affinity: nextAffinity,
      trust: nextTrust,
    }])
  }

  if (op === 'forget') {
    const aboutId = parsed.positional[1]
    if (!aboutId) return err('usage: climate forget <about_id>')
    const r = await pool.query(
      `DELETE FROM agent_climate WHERE agent_id = $1 AND about_id = $2`,
      [me, aboutId],
    )
    if ((r.rowCount ?? 0) === 0) return err(`no climate to forget for ${me} → ${aboutId}`)
    return ok(`forgot climate ${me} → ${aboutId}`, [{
      event: 'climate.deleted',
      command: 'climate forget',
      agentId: me,
      aboutId,
    }])
  }

  return err('usage: climate <read|note|forget> [...]')
}

async function cmdLog(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'list'
  const me = resolveAs(parsed)
  if (op === 'note') {
    const body = parsed.positional[1]
    if (!body) return err('usage: log note <body> [--as id]')
    const id = `log-${randomUUID().slice(0, 12)}`
    await pool.query(
      `INSERT INTO agent_log (id, agent_id, kind, body) VALUES ($1, $2, 'note', $3)`,
      [id, me, body],
    )
    return ok(`logged ${id}`)
  }
  // list (default)
  const limit = Math.min(100, Math.max(1, Number(parsed.flags.limit ?? 30)))
  const { rows } = await pool.query<{
    id: string; kind: string; body: string; ref: unknown; created_at: string
  }>(
    `SELECT id, kind, body, ref, created_at
       FROM agent_log WHERE agent_id = $1
       ORDER BY created_at DESC LIMIT $2`,
    [me, limit],
  )
  if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
  if (rows.length === 0) return ok(`(no log entries for ${me})`)
  return ok([
    `last ${rows.length} log entries for ${me}:`,
    '',
    ...rows.map((r) => {
      const t = new Date(r.created_at).toLocaleString()
      return `  [${t}] ${r.kind.padEnd(10)} ${r.body.slice(0, 200)}`
    }),
  ].join('\n'))
}

async function cmdWorkspace(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0]
  const me = resolveAs(parsed)
  // Resolve the agent's tenant once — every write needs to carry the
  // company_id so the Observability view (which filters by tenant)
  // can actually see what the agent stores. Reads are agent-scoped
  // (agent_id is globally unique) so they don't need it.
  const tenant = await agentCompany(me)
  if (op === 'ls') {
    const { rows } = await pool.query<{ path: string; updated_at: string }>(
      `SELECT path, updated_at FROM agent_workspace WHERE agent_id = $1 ORDER BY path ASC`,
      [me],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok(`(${me}'s workspace is empty)`)
    return ok([
      `${rows.length} file(s) in ${me}'s workspace:`,
      '',
      ...rows.map((r) => `  ${r.path.padEnd(40)} ${new Date(r.updated_at).toLocaleString()}`),
    ].join('\n'))
  }
  if (op === 'read') {
    const path = parsed.positional[1]
    if (!path) return err('usage: workspace read <path> [--as id]')
    const { rows } = await pool.query<{ body: string; updated_at: string }>(
      `SELECT body, updated_at FROM agent_workspace WHERE agent_id = $1 AND path = $2`,
      [me, path],
    )
    if (!rows[0]) return err(`no file at ${path} in ${me}'s workspace`)
    return ok(rows[0].body)
  }
  if (op === 'write') {
    const path = parsed.positional[1]
    const body = parsed.positional.slice(2).join(' ')
    if (!path || !body) return err('usage: workspace write <path> <body> [--as id]')
    const memMeta = path.startsWith('memory/')
      ? await memoryMetaForWrite(me, { path })
      : null
    await pool.query(
      `INSERT INTO agent_workspace (agent_id, path, body, meta, company_id, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (agent_id, path) DO UPDATE
         SET body = EXCLUDED.body,
             company_id = EXCLUDED.company_id,
             meta = COALESCE(agent_workspace.meta, EXCLUDED.meta),
             updated_at = NOW()`,
      [me, path, body, memMeta ? JSON.stringify(memMeta) : null, tenant],
    )
    return ok(`wrote ${path} (${body.length} chars)`, [{
      event: 'workspace.file_written',
      command: 'workspace write',
      agentId: me,
      companyId: tenant ?? undefined,
      path,
      bodyLength: body.length,
    }])
  }
  if (op === 'delete') {
    const path = parsed.positional[1]
    if (!path) return err('usage: workspace delete <path> [--as id]')
    const r = await pool.query(`DELETE FROM agent_workspace WHERE agent_id = $1 AND path = $2`, [me, path])
    if ((r.rowCount ?? 0) === 0) return err(`no file at ${path}`)
    return ok(`deleted ${path}`, [{
      event: 'workspace.file_deleted',
      command: 'workspace delete',
      agentId: me,
      companyId: tenant ?? undefined,
      path,
    }])
  }
  if (op === 'edit') {
    const path = parsed.positional[1]
    const oldStr = parsed.positional[2]
    const newStr = parsed.positional[3] ?? ''
    if (!path || oldStr === undefined) return err('usage: workspace edit <path> <old> <new> [--as id]')
    const { rows } = await pool.query<{ body: string }>(
      `SELECT body FROM agent_workspace WHERE agent_id = $1 AND path = $2`, [me, path],
    )
    if (!rows[0]) return err(`no file at ${path}`)
    const body = rows[0].body
    const occurrences = body.split(oldStr).length - 1
    if (occurrences === 0) return err(`old string not found in ${path}`)
    if (occurrences > 1 && !parsed.flags.all) return err(`old string appears ${occurrences} times in ${path} — pass --all or include more context to make it unique`)
    const next = parsed.flags.all ? body.split(oldStr).join(newStr) : body.replace(oldStr, newStr)
    await pool.query(
      `UPDATE agent_workspace SET body = $3, updated_at = NOW() WHERE agent_id = $1 AND path = $2`,
      [me, path, next],
    )
    return ok(`edited ${path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`, [{
      event: 'workspace.file_updated',
      command: 'workspace edit',
      agentId: me,
      companyId: tenant ?? undefined,
      path,
      replacements: occurrences,
      bodyLength: next.length,
    }])
  }
  if (op === 'grep') {
    const pattern = parsed.positional[1]
    if (!pattern) return err('usage: workspace grep <pattern> [--as id]')
    let re: RegExp
    try { re = new RegExp(pattern, parsed.flags.i ? 'gi' : 'g') } catch { return err(`bad regex: ${pattern}`) }
    const { rows } = await pool.query<{ path: string; body: string }>(
      `SELECT path, body FROM agent_workspace WHERE agent_id = $1 ORDER BY path ASC`, [me],
    )
    const hits: string[] = []
    for (const r of rows) {
      const lines = r.body.split('\n')
      lines.forEach((line, i) => {
        if (re.test(line)) hits.push(`  ${r.path}:${i + 1}: ${line.slice(0, 200)}`)
        re.lastIndex = 0
      })
    }
    if (parsed.flags.json) return ok(JSON.stringify(hits, null, 2))
    if (hits.length === 0) return ok(`(no matches for /${pattern}/ in ${me}'s workspace)`)
    return ok([`${hits.length} match(es):`, '', ...hits].join('\n'))
  }
  return err(`usage: workspace <ls|read|write|edit|grep|delete> [...]`)
}

async function cmdTasks(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'list'
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (op === 'list') {
    const params: unknown[] = [me]
    let where = `agent_id = $1`
    if (parsed.flags.status) { params.push(String(parsed.flags.status)); where += ` AND status = $${params.length}` }
    const { rows } = await pool.query<{
      id: string; title: string; status: string; due_at: string | null;
      created_at: string; updated_at: string
    }>(
      `SELECT id, title, status, due_at, created_at, updated_at
         FROM agent_tasks WHERE ${where} ORDER BY status ASC, updated_at DESC`,
      params,
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok(`(no tasks for ${me})`)
    return ok([
      `${rows.length} task(s) for ${me}:`,
      '',
      ...rows.map((t) => `  [${t.status.padEnd(7)}] ${t.id.slice(0, 12).padEnd(13)} ${t.title}`),
    ].join('\n'))
  }
  if (op === 'add') {
    const title = parsed.positional.slice(1).join(' ')
    if (!title) return err('usage: tasks add <title> [--as id]')
    const id = `task-${randomUUID().slice(0, 12)}`
    await pool.query(
      `INSERT INTO agent_tasks (id, agent_id, title) VALUES ($1, $2, $3)`,
      [id, me, title],
    )
    return ok(`added task ${id}: ${title}`, [{
      event: 'task.created',
      command: 'tasks add',
      taskId: id,
      agentId: me,
      companyId: companyId ?? undefined,
      title,
      status: 'open',
      visibleToUser: true,
    }])
  }
  if (op === 'set') {
    const id = parsed.positional[1]
    const status = parsed.positional[2]
    if (!id || !status) return err('usage: tasks set <task_id> <status>')
    if (!['open', 'doing', 'done', 'dropped'].includes(status)) return err(`bad status: ${status}`)
    const r = await pool.query(
      `UPDATE agent_tasks SET status = $3, updated_at = NOW() WHERE id = $1 AND agent_id = $2`,
      [id, me, status],
    )
    if ((r.rowCount ?? 0) === 0) return err(`no task ${id} for ${me}`)
    return ok(`task ${id} → ${status}`, [{
      event: 'task.status_changed',
      command: 'tasks set',
      taskId: id,
      agentId: me,
      companyId: companyId ?? undefined,
      status,
      visibleToUser: true,
    }])
  }
  return err(`usage: tasks <list|add|set> [...]`)
}

/* ============== calendar ==============
 *
 * Same calendar humans see — agents read upcoming events assigned to them
 * (so "what's on my plate today" is a single command) and create new
 * events to schedule work for themselves or another agent. All rows live
 * in the agent's company; cross-tenant safety is enforced the same way as
 * tasks/email above.
 */

/** Best-effort WS broadcast for a calendar row change initiated by the
 *  agent CLI. Mirrors the REST `publishCalendarChange` helper in
 *  router.ts so the desktop client patches its Calendar view in real
 *  time whether the change came from a human (HTTP) or an agent (CLI). */
/** Visibility predicate for the agent CLI. Mirrors the REST helper but
 *  with one simplification: agents can't be company owners, so the
 *  owner-override branch never applies — the predicate collapses to the
 *  basic "public OR I am the author / assignee" form. Caller binds its
 *  participant id at `meIdx`. */
function cliCalendarVisibilityClause(meIdx: number): string {
  return `(is_private = false OR created_by = $${meIdx} OR assignee_id = $${meIdx})`
}

async function publishCalendarCli(args: {
  companyId: string
  kind: 'event.created' | 'event.updated' | 'event.deleted' | 'event.dispatched'
  eventId: string
  actorId: string
}): Promise<void> {
  const { CH_CALENDAR_EVENTS, publish } = await import('../redis.js')
  await publish(CH_CALENDAR_EVENTS, {
    type: 'calendar.changed',
    companyId: args.companyId,
    kind: args.kind,
    eventId: args.eventId,
    actorId: args.actorId,
  })
}

async function cmdCalendar(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'list'
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)

  if (op === 'list') {
    // Default scope: events assigned to `me` OR created by `me`. The
    // `--all` flag widens to every event in the workspace (parity with
    // the UI's "Workspace" filter).
    const all = Boolean(parsed.flags.all)
    const params: unknown[] = [companyId, me]
    let where = `company_id = $1`
    if (all) {
      // --all widens to the whole workspace, BUT we still hide private
      // rows the caller isn't authorized to read. The default (narrow)
      // path is already self-filtered via assignee_id/created_by.
      where += ` AND ${cliCalendarVisibilityClause(2)}`
    } else {
      where += ` AND (assignee_id = $2 OR created_by = $2)`
    }
    if (parsed.flags.status) {
      params.push(String(parsed.flags.status))
      where += ` AND status = $${params.length}`
    }
    const { rows } = await pool.query<{
      id: string; title: string; kind: string; status: string;
      assignee_id: string | null; start_at: Date; recurrence: { freq: string; interval: number } | null;
      target_conversation_id: string | null; is_private: boolean
    }>(
      `SELECT id, title, kind, status, assignee_id, start_at, recurrence,
              target_conversation_id, is_private
         FROM calendar_events WHERE ${where}
         ORDER BY start_at ASC LIMIT 200`,
      params,
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok(`(no calendar events for ${me}${all ? ' [workspace]' : ''})`)
    return ok([
      `${rows.length} calendar event(s)${all ? ' in workspace' : ` for ${me}`}:`,
      '',
      ...rows.map((r) => {
        const rep = r.recurrence ? `every ${r.recurrence.interval || 1} ${r.recurrence.freq}` : 'one-shot'
        const who = r.assignee_id ? ` → @${r.assignee_id}` : ''
        const lock = r.is_private ? ' 🔒' : ''
        return `  [${r.status.padEnd(7)}] ${r.id.slice(0, 14).padEnd(15)} ${r.start_at.toISOString().slice(0, 16)} · ${rep}${who}${lock}  ${r.title}`
      }),
    ].join('\n'))
  }

  if (op === 'create') {
    // usage: calendar create "<title>" --at <iso> [--assignee <id>] [--prompt "..."]
    //                                  [--in <convo_id>] [--every daily|weekly|monthly|yearly]
    //                                  [--interval N] [--byweekday 0,1,2] [--until <iso>] [--count N]
    //                                  [--kind personal|agent_task]
    const title = parsed.positional.slice(1).join(' ').trim()
    if (!title) return err('usage: calendar create "<title>" --at <iso> [flags]')
    const startStr = parsed.flags.at ? String(parsed.flags.at) : ''
    if (!startStr) return err('--at <iso-timestamp> is required')
    const start = new Date(startStr)
    if (Number.isNaN(start.getTime())) return err(`invalid --at: ${startStr}`)
    const assigneeId = parsed.flags.assignee ? String(parsed.flags.assignee) : null
    const agentPrompt = parsed.flags.prompt ? String(parsed.flags.prompt) : null
    const targetConvo = parsed.flags.in ? String(parsed.flags.in) : null
    const kind = parsed.flags.kind === 'personal' ? 'personal' : (assigneeId || agentPrompt ? 'agent_task' : 'personal')
    if (kind === 'agent_task' && !assigneeId) {
      return err('agent_task events need an --assignee')
    }
    let recurrence: Record<string, unknown> | null = null
    if (parsed.flags.every) {
      const freq = String(parsed.flags.every)
      if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) {
        return err(`--every must be daily|weekly|monthly|yearly (got: ${freq})`)
      }
      const interval = parsed.flags.interval ? Math.max(1, Math.floor(Number(parsed.flags.interval))) : 1
      const byweekday = parsed.flags.byweekday
        ? String(parsed.flags.byweekday).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        : undefined
      const until = parsed.flags.until ? String(parsed.flags.until) : null
      const count = parsed.flags.count ? Math.floor(Number(parsed.flags.count)) : null
      recurrence = { freq, interval, byweekday, until, count }
    }
    // Optional reminder. `--remind <minutes>` pairs with `--remind-channel
    // toast|email|both` (defaults to toast). Either both flags or neither.
    // --private hides this row from everyone in the workspace except its
    // created_by (the calling agent) and assignee_id. Useful for personal
    // reminders an agent sets for itself that would otherwise clutter the
    // shared calendar.
    const isPrivate = Boolean(parsed.flags.private)
    let reminderMinutes: number | null = null
    let reminderChannel: 'toast' | 'email' | 'both' | null = null
    if (parsed.flags.remind !== undefined) {
      const n = Math.floor(Number(parsed.flags.remind))
      if (!Number.isFinite(n) || n < 0) return err(`--remind must be minutes (got: ${parsed.flags.remind})`)
      reminderMinutes = n
      const ch = parsed.flags['remind-channel'] ? String(parsed.flags['remind-channel']) : 'toast'
      if (ch !== 'toast' && ch !== 'email' && ch !== 'both') {
        return err(`--remind-channel must be toast|email|both (got: ${ch})`)
      }
      reminderChannel = ch
    }

    // Same two-layer anti-duplicate shape as `doc create`: an in-flight
    // tenant claim against a CONCURRENT peer creating the same event, plus
    // a recently-created check against a SEQUENTIAL duplicate (peer created
    // it seconds ago and already released the claim). One team meeting
    // scheduled twice is the calendar analog of the double-doc incident.
    const calBlocked = await tryClaimTenantWork(companyId, me, 'calendar-create', title)
    if (calBlocked) return calBlocked
    try {
      // Private events are exempt on BOTH sides: a private reminder is not
      // shared work, and we must not leak another agent's private event
      // title through a HELD envelope.
      if (!isPrivate) {
        const { normalizeWorkSubject } = await import('./runtime/inproc-client.js')
        const normTitle = normalizeWorkSubject(title)
        const calHoldScope = `calendar-create:${normTitle}`
        const forceArmed = Boolean(parsed.flags.force) && (await consumeHold(me, calHoldScope)).armed
        if (!forceArmed) {
          const { rows: recentDups } = await pool.query<{
            id: string; title: string; created_by: string; created_at: Date
          }>(
            `SELECT id, title, created_by, created_at FROM calendar_events
              WHERE company_id = $1 AND created_by <> $2
                AND status = 'active' AND is_private = FALSE
                AND created_at > NOW() - INTERVAL '15 minutes'
              ORDER BY created_at DESC LIMIT 50`,
            [companyId, me],
          )
          const dup = recentDups.find((d) => normalizeWorkSubject(d.title) === normTitle)
          if (dup) {
            await recordHold(me, calHoldScope)
            const ageSec = Math.max(1, Math.round((Date.now() - dup.created_at.getTime()) / 1000))
            return err(
              `HELD — event NOT created. ${dup.created_by} already scheduled "${dup.title}" (${dup.id}) ${ageSec}s ago — ` +
              `this work is DONE; a second copy double-books everyone. ` +
              `Inspect theirs instead: \`cumora calendar list\` / \`cumora calendar update ${dup.id} ...\` if it needs changes. ` +
              `If you GENUINELY need a separate same-title event, rerun with --force ` +
              `(--force only works after you've been shown this hold — passing it preemptively does nothing).`,
              2,
            )
          }
        }
      }
      const id = `ce-${randomUUID()}`
      await pool.query(
        `INSERT INTO calendar_events
           (id, company_id, created_by, kind, title, assignee_id,
            target_conversation_id, agent_prompt, start_at, recurrence,
            reminder_minutes_before, reminder_channel, status, is_private)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,'active',$13)`,
        [id, companyId, me, kind, title, assigneeId, targetConvo, agentPrompt, start,
         recurrence ? JSON.stringify(recurrence) : null,
         reminderMinutes, reminderChannel, isPrivate],
      )
      await publishCalendarCli({ companyId, kind: 'event.created', eventId: id, actorId: me })
      return ok(`scheduled ${id}: "${title}" at ${start.toISOString()}${recurrence ? ` · every ${recurrence.interval} ${recurrence.freq}` : ''}${assigneeId ? ` → @${assigneeId}` : ''}${reminderMinutes != null ? ` · remind ${reminderMinutes}m before (${reminderChannel})` : ''}${isPrivate ? ' · 🔒 private' : ''}`, [{
        event: 'calendar.event_created',
        command: 'calendar create',
        calendarEventId: id,
        actorId: me,
        companyId,
        title,
        kind,
        assigneeId,
        targetConversationId: targetConvo,
        startAt: start.toISOString(),
        recurrence,
        reminderMinutesBefore: reminderMinutes,
        reminderChannel,
        visibleToUser: true,
      }])
    } finally {
      await releaseTenantWork(companyId, me, 'calendar-create', title)
    }
  }

  if (op === 'update' || op === 'edit') {
    const id = parsed.positional[1]
    if (!id) return err(`usage: calendar ${op} <event_id> [--title "..."] [--at <iso>] [--status active|cancelled|done] [flags]`)
    // Privacy guard: same visibility rule as list. Callers who can't see
    // the row can't modify it. The check is folded into the UPDATE so we
    // don't pay an extra round trip.
    {
      const { rows } = await pool.query(
        `SELECT 1 FROM calendar_events
          WHERE id = $1 AND company_id = $2 AND ${cliCalendarVisibilityClause(3)}
          LIMIT 1`,
        [id, companyId, me],
      )
      if (!rows[0]) return err(`no event ${id}`)
    }
    const sets: string[] = []
    const params: unknown[] = []
    const push = (column: string, value: unknown) => {
      params.push(value)
      sets.push(`${column} = $${params.length}`)
    }
    if (parsed.flags.title !== undefined) {
      const title = String(parsed.flags.title).trim().slice(0, 200)
      if (!title) return err('--title cannot be empty')
      push('title', title)
    }
    if (parsed.flags.description !== undefined) {
      push('description', String(parsed.flags.description).slice(0, 4000) || null)
    }
    if (parsed.flags.kind !== undefined) {
      const kind = String(parsed.flags.kind)
      if (!['personal', 'agent_task'].includes(kind)) return err('--kind must be personal|agent_task')
      push('kind', kind)
    }
    if (parsed.flags.assignee !== undefined) {
      const assignee = String(parsed.flags.assignee).trim()
      push('assignee_id', !assignee || assignee === 'null' || assignee === '-' ? null : assignee)
    }
    if (parsed.flags.prompt !== undefined) {
      push('agent_prompt', String(parsed.flags.prompt).slice(0, 8000) || null)
    }
    if (parsed.flags.in !== undefined) {
      const target = String(parsed.flags.in).trim()
      push('target_conversation_id', !target || target === 'null' || target === '-' ? null : target)
    }
    if (parsed.flags.at !== undefined) {
      const start = new Date(String(parsed.flags.at))
      if (Number.isNaN(start.getTime())) return err(`invalid --at: ${parsed.flags.at}`)
      push('start_at', start)
    }
    if (parsed.flags.end !== undefined) {
      const raw = String(parsed.flags.end).trim()
      if (!raw || raw === 'null' || raw === '-') push('end_at', null)
      else {
        const end = new Date(raw)
        if (Number.isNaN(end.getTime())) return err(`invalid --end: ${raw}`)
        push('end_at', end)
      }
    }
    if (parsed.flags.status !== undefined) {
      const status = String(parsed.flags.status)
      if (!['active', 'cancelled', 'done'].includes(status)) return err('--status must be active|cancelled|done')
      push('status', status)
    }
    if (parsed.flags.remind !== undefined) {
      const raw = String(parsed.flags.remind).trim()
      if (!raw || raw === 'null' || raw === '-') push('reminder_minutes_before', null)
      else {
        const n = Math.floor(Number(raw))
        if (!Number.isFinite(n) || n < 0 || n > 14 * 24 * 60) return err(`--remind must be minutes in [0, 20160] (got: ${raw})`)
        push('reminder_minutes_before', n)
      }
    }
    if (parsed.flags['remind-channel'] !== undefined) {
      const ch = String(parsed.flags['remind-channel']).trim()
      if (!ch || ch === 'null' || ch === '-') push('reminder_channel', null)
      else {
        if (ch !== 'toast' && ch !== 'email' && ch !== 'both') return err('--remind-channel must be toast|email|both')
        push('reminder_channel', ch)
      }
    }
    // --private flips the row to private; --public flips it back. Either
    // wins if both are passed; --private takes precedence (defensive).
    if (parsed.flags.private !== undefined) push('is_private', true)
    else if (parsed.flags.public !== undefined) push('is_private', false)
    if (parsed.flags.every !== undefined || parsed.flags['clear-recurrence'] !== undefined) {
      if (parsed.flags['clear-recurrence'] !== undefined) {
        params.push(null)
        sets.push(`recurrence = $${params.length}::jsonb`)
      } else {
        const freq = String(parsed.flags.every)
        if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) {
          return err(`--every must be daily|weekly|monthly|yearly (got: ${freq})`)
        }
        const interval = parsed.flags.interval ? Math.max(1, Math.floor(Number(parsed.flags.interval))) : 1
        const byweekday = parsed.flags.byweekday
          ? String(parsed.flags.byweekday).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
          : undefined
        const until = parsed.flags.until ? String(parsed.flags.until) : null
        const count = parsed.flags.count ? Math.floor(Number(parsed.flags.count)) : null
        params.push(JSON.stringify({ freq, interval, byweekday, until, count }))
        sets.push(`recurrence = $${params.length}::jsonb`)
      }
    }
    if (sets.length === 0) return err('nothing to update — pass at least one calendar field flag')
    sets.push('updated_at = NOW()')
    params.push(id, companyId)
    const { rows } = await pool.query<{
      id: string; title: string; kind: string; status: string;
      assignee_id: string | null; target_conversation_id: string | null; start_at: Date
    }>(
      `UPDATE calendar_events SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}
        RETURNING id, title, kind, status, assignee_id, target_conversation_id, start_at`,
      params,
    )
    const row = rows[0]
    if (!row) return err(`no event ${id}`)
    await publishCalendarCli({ companyId, kind: 'event.updated', eventId: id, actorId: me })
    return ok(`updated ${id}: "${row.title}" at ${row.start_at.toISOString()} (${row.status})`, [{
      event: 'calendar.event_updated',
      command: `calendar ${op}`,
      calendarEventId: id,
      actorId: me,
      companyId,
      title: row.title,
      kind: row.kind,
      status: row.status,
      assigneeId: row.assignee_id,
      targetConversationId: row.target_conversation_id,
      startAt: row.start_at.toISOString(),
      visibleToUser: true,
    }])
  }

  if (op === 'run-now') {
    const id = parsed.positional[1]
    if (!id) return err('usage: calendar run-now <event_id>')
    // Privacy gate: only people who can see the row can dispatch it.
    const { rows } = await pool.query(
      `SELECT id, company_id, created_by, kind, title, description, assignee_id,
              target_conversation_id, agent_prompt, start_at, end_at, all_day,
              recurrence, status, last_fired_at,
              reminder_minutes_before, reminder_channel,
              is_private,
              created_at, updated_at
         FROM calendar_events
        WHERE id = $1 AND company_id = $2 AND ${cliCalendarVisibilityClause(3)}`,
      [id, companyId, me],
    )
    if (!rows[0]) return err(`no event ${id}`)
    const { dispatchEvent } = await import('../calendar.js')
    const result = await dispatchEvent(rows[0] as import('../calendar.js').CalendarEventRow, new Date())
    await publishCalendarCli({ companyId, kind: 'event.dispatched', eventId: id, actorId: me })
    return ok(`dispatched ${id}: ${JSON.stringify(result)}`, [{
      event: 'calendar.event_dispatched',
      command: 'calendar run-now',
      calendarEventId: id,
      actorId: me,
      companyId,
      result,
      visibleToUser: true,
    }])
  }

  if (op === 'dispatches') {
    const id = parsed.positional[1]
    if (!id) return err('usage: calendar dispatches <event_id>')
    const { rows } = await pool.query<{
      id: string; event_id: string; scheduled_for: Date; dispatched_at: Date;
      status: string; conversation_id: string | null; message_id: string | null; error: string | null
    }>(
      `SELECT cd.id, cd.event_id, cd.scheduled_for, cd.dispatched_at, cd.status,
              cd.conversation_id, cd.message_id, cd.error
         FROM calendar_dispatches cd
         JOIN calendar_events ce ON ce.id = cd.event_id
        WHERE cd.event_id = $1 AND ce.company_id = $2
        ORDER BY cd.scheduled_for DESC LIMIT 200`,
      [id, companyId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok(`(no dispatches for ${id})`)
    return ok([
      `${rows.length} dispatch(es) for ${id}:`,
      '',
      ...rows.map((r) =>
        `  [${r.status}] ${r.scheduled_for.toISOString()} → ${r.conversation_id ?? '-'} ${r.message_id ?? ''}${r.error ? ` · ${r.error}` : ''}`,
      ),
    ].join('\n'))
  }

  if (op === 'cancel' || op === 'delete') {
    const id = parsed.positional[1]
    if (!id) return err(`usage: calendar ${op} <event_id>`)
    // Visibility guard folded into the WHERE clause: rowCount === 0 maps
    // to "no event found" regardless of whether the row is missing or
    // privacy-filtered, so we don't leak existence to non-authorized
    // callers.
    const r = await pool.query(
      op === 'delete'
        ? `DELETE FROM calendar_events
            WHERE id = $1 AND company_id = $2 AND ${cliCalendarVisibilityClause(3)}`
        : `UPDATE calendar_events SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1 AND company_id = $2 AND ${cliCalendarVisibilityClause(3)}`,
      [id, companyId, me],
    )
    if ((r.rowCount ?? 0) === 0) return err(`no event ${id}`)
    // `cancel` flips status → updated; `delete` drops the row → deleted.
    // Clients listening on calendar.changed will refetch (or drop the row
    // from local state) accordingly.
    await publishCalendarCli({
      companyId,
      kind: op === 'delete' ? 'event.deleted' : 'event.updated',
      eventId: id,
      actorId: me,
    })
    return ok(`${op === 'delete' ? 'deleted' : 'cancelled'} ${id}`, [{
      event: op === 'delete' ? 'calendar.event_deleted' : 'calendar.event_cancelled',
      command: `calendar ${op}`,
      calendarEventId: id,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  return err(`usage: calendar <list|create|update|run-now|dispatches|cancel|delete> [...]`)
}

/* ============== kanban boards ==============
 *
 * Same shape as the rest of this file: the agent operates as `me` (the
 * --as participant) inside that participant's tenant. All inserts /
 * updates publish on the `boards` channel so the desktop client + every
 * other connected member sees the change in real time. */

type KanbanMentionTarget = { id: string; name: string }

function cliMentionStartBoundary(text: string, index: number): boolean {
  if (index <= 0) return true
  return !/[\w@]/.test(text[index - 1])
}

function cliMentionEndBoundary(text: string, index: number): boolean {
  const next = text[index]
  return !next || !/[a-z0-9_-]/i.test(next)
}

function cliParseMentionTargets(text: string, targets: KanbanMentionTarget[]): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const candidates = targets
    .flatMap((p) => [
      { id: p.id, token: p.id },
      { id: p.id, token: p.name.trim() },
    ])
    .filter((candidate) => candidate.token.length > 0)
    .sort((a, b) => b.token.length - a.token.length)
  const lower = text.toLowerCase()
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@' || !cliMentionStartBoundary(text, i)) continue
    const rest = lower.slice(i + 1)
    const match = candidates.find((candidate) =>
      rest.startsWith(candidate.token.toLowerCase()) &&
      cliMentionEndBoundary(text, i + 1 + candidate.token.length)
    )
    const fallback = match ? null : /^@([a-z0-9][a-z0-9_-]{0,63})/i.exec(text.slice(i))
    const id = match?.id ?? fallback?.[1]?.toLowerCase()
    if (!id) continue
    if (id === 'all') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    i += (match ? match.token.length : fallback![0].length - 1)
  }
  return out
}

/** Same parsing contract as the REST router uses — keep them aligned so an
 *  agent's `card add` and a human's card form parse mentions the same. */
async function cliParseMentions(companyId: string, text: string): Promise<string[]> {
  const { rows } = await pool.query<KanbanMentionTarget>(
    `SELECT id, name
       FROM participants
      WHERE company_id = $1
        AND departed_at IS NULL`,
    [companyId],
  )
  return cliParseMentionTargets(text, rows)
}

async function publishBoardCli(args: {
  companyId: string
  kind:
    | 'board.created' | 'board.updated' | 'board.deleted'
    | 'column.created' | 'column.updated' | 'column.deleted'
    | 'card.created' | 'card.updated' | 'card.moved' | 'card.deleted'
    | 'comment.created' | 'comment.deleted'
  boardId: string
  cardId?: string
  columnId?: string
  commentId?: string
  mentions?: string[]
  actorId: string
}): Promise<void> {
  const { CH_BOARDS, publish } = await import('../redis.js')
  await publish(CH_BOARDS, {
    type: 'board.changed',
    companyId: args.companyId,
    kind: args.kind,
    boardId: args.boardId,
    cardId: args.cardId,
    columnId: args.columnId,
    commentId: args.commentId,
    mentions: args.mentions,
    actorId: args.actorId,
  })
}

/** Same shape + intent as the REST helper: wake every agent in
 *  `mentions` who lives in `companyId` and isn't the actor. Best-effort. */
async function wakeMentionedAgentsCli(args: {
  companyId: string
  mentions: string[] | undefined
  actorId: string
}): Promise<void> {
  // This function is invoked as `void wakeMentionedAgentsCli(...)` from
  // CLI command handlers (kanban/card/doc/calendar). Any throw here
  // becomes an unhandled rejection on the cumora-server process. Wrap
  // the whole body so a transient pool.query failure can't crash the
  // server — the CLI command itself has already succeeded; the wakes
  // are a best-effort side effect.
  try {
    if (!args.mentions || args.mentions.length === 0) return
    const targets = args.mentions.filter((id) => id !== args.actorId)
    if (targets.length === 0) return
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM participants
        WHERE kind = 'agent'
          AND company_id = $1
          AND id = ANY($2::text[])
          AND departed_at IS NULL`,
      [args.companyId, targets],
    )
    if (rows.length === 0) return
    const { wakeAgent } = await import('./scheduler.js')
    for (const r of rows) {
      wakeAgent(r.id, 'manual', null).catch((e) => {
        console.warn(`[kanban-cli] wake ${r.id} failed`, e instanceof Error ? e.message : e)
      })
    }
  } catch (err) {
    console.warn('[kanban-cli] wakeMentionedAgentsCli failed:', err instanceof Error ? err.message : err)
  }
}

async function cmdBoard(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'ls'
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)

  if (op === 'ls' || op === 'list') {
    const { rows } = await pool.query<{
      id: string; title: string; description: string | null; updated_at: string
    }>(
      `SELECT id, title, description, updated_at FROM boards
        WHERE company_id = $1 ORDER BY updated_at DESC`,
      [companyId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok(`(no boards in this workspace)`)
    return ok([
      `${rows.length} board(s):`,
      '',
      ...rows.map((b) => `  ${b.id.padEnd(20)} ${b.title}`),
    ].join('\n'))
  }

  if (op === 'show' || op === 'view') {
    const boardId = parsed.positional[1]
    if (!boardId) return err('usage: kanban show <board_id>')
    const b = await pool.query<{
      id: string; title: string; description: string | null; company_id: string
    }>(`SELECT id, title, description, company_id FROM boards WHERE id = $1 LIMIT 1`, [boardId])
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const cols = await pool.query<{
      id: string; title: string; position: number
    }>(`SELECT id, title, position FROM board_columns WHERE board_id = $1 ORDER BY position ASC`, [boardId])
    const cards = await pool.query<{
      id: string; column_id: string; title: string; assignee_id: string | null
      mentions: string[]; position: number
    }>(
      `SELECT id, column_id, title, assignee_id, mentions, position
         FROM board_cards WHERE board_id = $1 ORDER BY column_id, position ASC`,
      [boardId],
    )
    if (parsed.flags.json) {
      return ok(JSON.stringify({
        board: b.rows[0], columns: cols.rows, cards: cards.rows,
      }, null, 2))
    }
    const cardsByCol = new Map<string, typeof cards.rows>()
    for (const c of cards.rows) {
      const arr = cardsByCol.get(c.column_id) ?? []
      arr.push(c); cardsByCol.set(c.column_id, arr)
    }
    const lines: string[] = [`# ${b.rows[0].title}  (${b.rows[0].id})`]
    if (b.rows[0].description) lines.push(b.rows[0].description)
    for (const col of cols.rows) {
      const list = cardsByCol.get(col.id) ?? []
      lines.push('', `## ${col.title}  (${col.id})  · ${list.length} card(s)`)
      for (const c of list) {
        const who = c.assignee_id ? `@${c.assignee_id}` : '(unassigned)'
        const mentions = Array.isArray(c.mentions) && c.mentions.length > 0
          ? `  · mentions: ${c.mentions.map((m) => '@' + m).join(' ')}`
          : ''
        lines.push(`  - ${c.id.padEnd(20)} ${who.padEnd(16)} ${c.title}${mentions}`)
      }
    }
    return ok(lines.join('\n'))
  }

  if (op === 'create' || op === 'new') {
    const title = parsed.positional.slice(1).join(' ').trim()
      || (typeof parsed.flags.title === 'string' ? parsed.flags.title : '')
    if (!title) return err('usage: kanban create "<title>" [--description "..."]')
    const description = typeof parsed.flags.description === 'string'
      ? unescapeChat(parsed.flags.description).slice(0, 4000) : null
    const id = `board-${randomUUID().slice(0, 12)}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO boards (id, company_id, title, description, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [id, companyId, title.slice(0, 200), description, me],
      )
      const seeds = ['Todo', 'Doing', 'Done']
      for (let i = 0; i < seeds.length; i++) {
        await client.query(
          `INSERT INTO board_columns (id, board_id, title, position) VALUES ($1, $2, $3, $4)`,
          [`col-${randomUUID().slice(0, 12)}`, id, seeds[i], (i + 1) * 1000],
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => { /* swallow */ })
      throw e
    } finally {
      client.release()
    }
    await publishBoardCli({ companyId, kind: 'board.created', boardId: id, actorId: me })
    return ok(`created board ${id}: ${title}`, [{
      event: 'kanban.board_created',
      command: 'kanban create',
      boardId: id,
      actorId: me,
      companyId,
      title,
      visibleToUser: true,
    }])
  }

  if (op === 'rename' || op === 'edit' || op === 'update') {
    const boardId = parsed.positional[1]
    if (!boardId) return err(`usage: kanban ${op} <board_id> --title "..." [--description "..."]`)
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`,
      [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const sets: string[] = []
    const params: unknown[] = []
    let nextTitle: string | undefined
    if (typeof parsed.flags.title === 'string' || parsed.positional.length > 2) {
      nextTitle = (typeof parsed.flags.title === 'string'
        ? unescapeChat(parsed.flags.title)
        : parsed.positional.slice(2).join(' ')).trim().slice(0, 200)
      if (!nextTitle) return err('--title cannot be empty')
      params.push(nextTitle); sets.push(`title = $${params.length}`)
    }
    let nextDescription: string | null | undefined
    if (typeof parsed.flags.description === 'string') {
      nextDescription = unescapeChat(parsed.flags.description).trim().slice(0, 4000) || null
      params.push(nextDescription); sets.push(`description = $${params.length}`)
    }
    if (sets.length === 0) return err('nothing to update — pass --title or --description')
    params.push(boardId, companyId)
    const { rows } = await pool.query<{ title: string; description: string | null }>(
      `UPDATE boards SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1} AND company_id = $${params.length}
        RETURNING title, description`,
      params,
    )
    if (rows.length === 0) return err(`board ${boardId} not found`)
    await publishBoardCli({ companyId, kind: 'board.updated', boardId, actorId: me })
    return ok(`updated board ${boardId}: ${rows[0].title}`, [{
      event: 'kanban.board_updated',
      command: `kanban ${op}`,
      boardId,
      actorId: me,
      companyId,
      title: rows[0].title,
      description: rows[0].description,
      visibleToUser: true,
    }])
  }

  if (op === 'columns' || op === 'cols') {
    const boardId = parsed.positional[1]
    if (!boardId) return err('usage: kanban columns <board_id>')
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`, [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const { rows } = await pool.query<{ id: string; title: string }>(
      `SELECT id, title FROM board_columns WHERE board_id = $1 ORDER BY position ASC`,
      [boardId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    return ok(rows.map((c) => `  ${c.id.padEnd(20)} ${c.title}`).join('\n') || '(no columns)')
  }

  if (op === 'add-column' || op === 'add-col') {
    const boardId = parsed.positional[1]
    const title = parsed.positional.slice(2).join(' ').trim()
    if (!boardId || !title) return err('usage: kanban add-column <board_id> "<title>"')
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`, [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const { rows: posRows } = await pool.query<{ max: number | null }>(
      `SELECT MAX(position) AS max FROM board_columns WHERE board_id = $1`, [boardId],
    )
    const position = (Number(posRows[0]?.max ?? 0)) + 1000
    const id = `col-${randomUUID().slice(0, 12)}`
    await pool.query(
      `INSERT INTO board_columns (id, board_id, title, position) VALUES ($1, $2, $3, $4)`,
      [id, boardId, title.slice(0, 100), position],
    )
    await publishBoardCli({ companyId, kind: 'column.created', boardId, columnId: id, actorId: me })
    return ok(`added column ${id}: ${title}`, [{
      event: 'kanban.column_created',
      command: 'kanban add-column',
      boardId,
      columnId: id,
      actorId: me,
      companyId,
      title,
      visibleToUser: true,
    }])
  }

  if (op === 'edit-column' || op === 'rename-column' || op === 'update-column') {
    const boardId = parsed.positional[1]
    const columnId = parsed.positional[2]
    if (!boardId || !columnId) {
      return err(`usage: kanban ${op} <board_id> <column_id> [--title "..."] [--position N]`)
    }
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`,
      [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const sets: string[] = []
    const params: unknown[] = []
    if (typeof parsed.flags.title === 'string' || parsed.positional.length > 3) {
      const title = (typeof parsed.flags.title === 'string'
        ? unescapeChat(parsed.flags.title)
        : parsed.positional.slice(3).join(' ')).trim().slice(0, 100)
      if (!title) return err('--title cannot be empty')
      params.push(title); sets.push(`title = $${params.length}`)
    }
    if (parsed.flags.position !== undefined) {
      const position = Number(parsed.flags.position)
      if (!Number.isFinite(position)) return err(`invalid --position: ${parsed.flags.position}`)
      params.push(position); sets.push(`position = $${params.length}`)
    }
    if (sets.length === 0) return err('nothing to update — pass --title or --position')
    params.push(columnId, boardId)
    const { rows } = await pool.query<{ title: string; position: number }>(
      `UPDATE board_columns SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND board_id = $${params.length}
        RETURNING title, position`,
      params,
    )
    if (rows.length === 0) return err(`column ${columnId} not in board ${boardId}`)
    await publishBoardCli({ companyId, kind: 'column.updated', boardId, columnId, actorId: me })
    return ok(`updated column ${columnId}: ${rows[0].title}`, [{
      event: 'kanban.column_updated',
      command: `kanban ${op}`,
      boardId,
      columnId,
      actorId: me,
      companyId,
      title: rows[0].title,
      position: rows[0].position,
      visibleToUser: true,
    }])
  }

  if (op === 'delete-column' || op === 'rm-column') {
    const boardId = parsed.positional[1]
    const columnId = parsed.positional[2]
    if (!boardId || !columnId) return err(`usage: kanban ${op} <board_id> <column_id>`)
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`,
      [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const r = await pool.query(
      `DELETE FROM board_columns WHERE id = $1 AND board_id = $2`,
      [columnId, boardId],
    )
    if ((r.rowCount ?? 0) === 0) return err(`column ${columnId} not in board ${boardId}`)
    await publishBoardCli({ companyId, kind: 'column.deleted', boardId, columnId, actorId: me })
    return ok(`deleted column ${columnId}`, [{
      event: 'kanban.column_deleted',
      command: `kanban ${op}`,
      boardId,
      columnId,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  if (op === 'delete' || op === 'rm') {
    const boardId = parsed.positional[1]
    if (!boardId) return err('usage: kanban delete <board_id>')
    const r = await pool.query(
      `DELETE FROM boards WHERE id = $1 AND company_id = $2`,
      [boardId, companyId],
    )
    if ((r.rowCount ?? 0) === 0) return err(`board ${boardId} not found`)
    await publishBoardCli({ companyId, kind: 'board.deleted', boardId, actorId: me })
    return ok(`deleted board ${boardId}`, [{
      event: 'kanban.board_deleted',
      command: 'kanban delete',
      boardId,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  if (op === 'mentions') {
    // Who @-mentioned me on a kanban (cards + comments) since I last
    // checked? Reads the read-cursor in board_mention_reads, returns
    // the unread set, and (unless --peek) advances the cursor to NOW
    // so the next call only shows what's truly new.
    const peek = Boolean(parsed.flags.peek)
    const { rows: cur } = await pool.query<{ last_read_at: string }>(
      `SELECT last_read_at FROM board_mention_reads WHERE user_id = $1 LIMIT 1`,
      [me],
    )
    const since = cur[0]?.last_read_at ?? '1970-01-01T00:00:00Z'
    const cardsR = await pool.query<{
      id: string; board_id: string; column_id: string; title: string
      updated_at: string; created_by: string
      board_title: string
    }>(
      `SELECT c.id, c.board_id, c.column_id, c.title, c.updated_at, c.created_by,
              b.title AS board_title
         FROM board_cards c
         JOIN boards b ON b.id = c.board_id
        WHERE b.company_id = $1
          AND c.updated_at > $2
          AND c.mentions @> to_jsonb($3::text)
        ORDER BY c.updated_at DESC
        LIMIT 50`,
      [companyId, since, me],
    )
    const commentsR = await pool.query<{
      id: string; card_id: string; body: string; author_id: string
      created_at: string; board_id: string; card_title: string; board_title: string
    }>(
      `SELECT cm.id, cm.card_id, cm.body, cm.author_id, cm.created_at,
              c.board_id, c.title AS card_title, b.title AS board_title
         FROM board_card_comments cm
         JOIN board_cards c ON c.id = cm.card_id
         JOIN boards b ON b.id = c.board_id
        WHERE b.company_id = $1
          AND cm.created_at > $2
          AND cm.mentions @> to_jsonb($3::text)
        ORDER BY cm.created_at DESC
        LIMIT 50`,
      [companyId, since, me],
    )

    if (!peek) {
      await pool.query(
        `INSERT INTO board_mention_reads (user_id, last_read_at)
         VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_read_at = NOW()`,
        [me],
      )
    }

    if (parsed.flags.json) {
      return ok(JSON.stringify({
        since, cards: cardsR.rows, comments: commentsR.rows,
      }, null, 2))
    }
    if (cardsR.rows.length === 0 && commentsR.rows.length === 0) {
      return ok(`(no new kanban @-mentions for ${me} since ${since})`)
    }
    const lines: string[] = [
      `${cardsR.rows.length + commentsR.rows.length} new kanban @-mention(s) for ${me}:`,
    ]
    if (cardsR.rows.length > 0) {
      lines.push('', '--- cards ---')
      for (const c of cardsR.rows) {
        lines.push(`  ${c.id}  [${c.board_title} / ${c.column_id}]  ${c.title}  · by ${c.created_by} at ${c.updated_at}`)
      }
    }
    if (commentsR.rows.length > 0) {
      lines.push('', '--- comments ---')
      for (const cm of commentsR.rows) {
        lines.push(`  ${cm.id}  on card ${cm.card_id} [${cm.board_title}]  · by ${cm.author_id} at ${cm.created_at}`)
        lines.push(`    "${cm.body.replace(/\n/g, ' ').slice(0, 200)}"`)
      }
    }
    if (!peek) lines.push('', `(read cursor advanced — next call shows only newer mentions; use --peek to keep it)`)
    return ok(lines.join('\n'))
  }

  return err(`usage: kanban <ls|show|create|rename|columns|add-column|edit-column|delete-column|delete|mentions> [...]`)
}

/** `cumora claim "<unit of work>"` / `cumora unclaim "..."` — the GENERIC, atomic,
 *  exclusive claim (the #1 primitive for
 *  non-divergent collaboration). Before doing any non-trivial unit a peer could
 *  also pick up — running an activity/game, producing a shared deliverable, taking
 *  a phase — CLAIM it. Exactly one agent wins (Redis HSETNX is the atomic gate);
 *  everyone else is told who holds it and to move on. Content-agnostic; coordinate
 *  by giving the SAME unit the SAME name. `--in <convo>` scopes it to a conversation
 *  (so the same name in different rooms doesn't collide); otherwise it's company-wide. */
async function cmdClaim(parsed: ParsedArgs, mode: 'claim' | 'unclaim'): Promise<CliResult> {
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)
  const key = (parsed.positional[0] ?? '').trim()
  if (!key) return err(`usage: ${mode} "<what you're claiming>" [--in <conversation_id>]${mode === 'claim' ? ' [--ttl <seconds>]' : ''}`)
  const _convo = typeof parsed.flags['in'] === 'string' ? parsed.flags['in'] : null
  // The generic string-lock is GONE. A generic conversation/activity claim is
  // exactly what let agents reserve a counting slot ("claim count-8") and then
  // sleep-wait for it — both slow and wrong. The only claim that should exist
  // is a task-claim on a real unit of work. So claiming a
  // turn / game slot / activity no longer grants a lock: just post the real next
  // item; the server HOLDs your reply and shows you the newer messages if a peer
  // moved the room. For a shared DELIVERABLE a peer could duplicate (one doc, one
  // plan), use a board CARD (`cumora card claim`). unclaim is a harmless no-op.
  if (mode === 'unclaim') {
    return ok(`ok — nothing to release. Cumora no longer uses generic claims; just post, the server settles races.`)
  }
  return err(
    `Claiming a turn / game slot / activity is not a thing anymore. ` +
    `Do NOT reserve a position and wait for it. Read the latest posts and send the REAL next item (\`cumora reply\`); ` +
    `if a peer moved the room while you composed, the reply comes back HELD with the newer messages — re-read and resend. ` +
    `That IS the coordination. The only claim that exists is for a genuine shared DELIVERABLE on the board: \`cumora card claim <cardId>\`.`,
  )
}

async function cmdCard(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'ls'
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)

  /** Look up the boardId behind a cardId AND verify it's in our tenant.
   *  Returns null if the card doesn't exist or is cross-tenant. */
  async function resolveCardBoard(cardId: string): Promise<{ boardId: string; columnId: string } | null> {
    const r = await pool.query<{ board_id: string; column_id: string; company_id: string }>(
      `SELECT c.board_id, c.column_id, b.company_id
         FROM board_cards c JOIN boards b ON b.id = c.board_id
        WHERE c.id = $1 LIMIT 1`,
      [cardId],
    )
    if (r.rows.length === 0 || r.rows[0].company_id !== companyId) return null
    return { boardId: r.rows[0].board_id, columnId: r.rows[0].column_id }
  }

  if (op === 'ls' || op === 'list') {
    const boardId = parsed.positional[1]
    if (!boardId) return err('usage: card ls <board_id>')
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`, [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const { rows } = await pool.query<{
      id: string; column_id: string; title: string; assignee_id: string | null
      mentions: string[]
    }>(
      `SELECT id, column_id, title, assignee_id, mentions
         FROM board_cards WHERE board_id = $1 ORDER BY column_id, position ASC`,
      [boardId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok('(no cards)')
    return ok(rows.map((c) => {
      const who = c.assignee_id ? `@${c.assignee_id}` : '(unassigned)'
      return `  ${c.id.padEnd(20)} [${c.column_id.slice(0, 16).padEnd(16)}] ${who.padEnd(16)} ${c.title}`
    }).join('\n'))
  }

  if (op === 'show') {
    const cardId = parsed.positional[1]
    if (!cardId) return err('usage: card show <card_id>')
    const r = await pool.query<{
      id: string; board_id: string; column_id: string; title: string
      description: string | null; assignee_id: string | null; mentions: string[]
      created_by: string; created_at: string; updated_at: string; company_id: string
    }>(
      `SELECT c.id, c.board_id, c.column_id, c.title, c.description,
              c.assignee_id, c.mentions, c.created_by, c.created_at, c.updated_at,
              b.company_id
         FROM board_cards c JOIN boards b ON b.id = c.board_id
        WHERE c.id = $1 LIMIT 1`,
      [cardId],
    )
    if (r.rows.length === 0 || r.rows[0].company_id !== companyId) return err(`card ${cardId} not found`)
    const c = r.rows[0]
    const comments = await pool.query<{
      id: string; author_id: string; body: string; created_at: string
    }>(
      `SELECT id, author_id, body, created_at
         FROM board_card_comments WHERE card_id = $1 ORDER BY created_at ASC`,
      [cardId],
    )
    if (parsed.flags.json) return ok(JSON.stringify({ card: c, comments: comments.rows }, null, 2))
    const lines = [
      `# ${c.title}  (${c.id})`,
      `  board:    ${c.board_id}`,
      `  column:   ${c.column_id}`,
      `  assignee: ${c.assignee_id ?? '(unassigned)'}`,
      `  created:  ${c.created_at}  by ${c.created_by}`,
    ]
    if (Array.isArray(c.mentions) && c.mentions.length > 0) {
      lines.push(`  mentions: ${c.mentions.map((m) => '@' + m).join(' ')}`)
    }
    if (c.description) lines.push('', c.description)
    if (comments.rows.length > 0) {
      lines.push('', `--- ${comments.rows.length} comment(s) ---`)
      for (const cm of comments.rows) {
        lines.push(`  ${cm.created_at}  ${cm.author_id}: ${cm.body}`)
      }
    }
    return ok(lines.join('\n'))
  }

  if (op === 'add' || op === 'create') {
    const boardId = parsed.positional[1]
    const title = parsed.positional.slice(2).join(' ').trim()
      || (typeof parsed.flags.title === 'string' ? parsed.flags.title : '')
    if (!boardId || !title) {
      return err('usage: card add <board_id> "<title>" --column <col_id> [--description "..."] [--assign <id>]')
    }
    const columnId = String(parsed.flags.column ?? parsed.flags.col ?? '').trim()
    if (!columnId) return err('--column <col_id> required (run `cumora kanban columns <board_id>` to list)')
    const b = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM boards WHERE id = $1 LIMIT 1`, [boardId],
    )
    if (b.rows.length === 0 || b.rows[0].company_id !== companyId) return err(`board ${boardId} not found`)
    const colCheck = await pool.query(
      `SELECT 1 FROM board_columns WHERE id = $1 AND board_id = $2 LIMIT 1`,
      [columnId, boardId],
    )
    if (colCheck.rows.length === 0) return err(`column ${columnId} not in board ${boardId}`)
    const description = typeof parsed.flags.description === 'string'
      ? unescapeChat(parsed.flags.description).slice(0, 8000) : null
    const assignee = typeof parsed.flags.assign === 'string'
      ? String(parsed.flags.assign).trim() : null
    const { rows: posRows } = await pool.query<{ max: number | null }>(
      `SELECT MAX(position) AS max FROM board_cards WHERE column_id = $1`, [columnId],
    )
    const position = (Number(posRows[0]?.max ?? 0)) + 1000
    const mentions = await cliParseMentions(companyId, `${title}\n${description ?? ''}`)
    const id = `card-${randomUUID().slice(0, 12)}`
    await pool.query(
      `INSERT INTO board_cards
         (id, board_id, column_id, title, description, position, assignee_id, mentions, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [id, boardId, columnId, title.slice(0, 200), description, position, assignee, JSON.stringify(mentions), me],
    )
    await pool.query(`UPDATE boards SET updated_at = NOW() WHERE id = $1`, [boardId])
    await publishBoardCli({
      companyId, kind: 'card.created', boardId, cardId: id, columnId, mentions, actorId: me,
    })
    void wakeMentionedAgentsCli({ companyId, mentions, actorId: me })
    if (assignee && assignee !== me) {
      void wakeMentionedAgentsCli({ companyId, mentions: [assignee], actorId: me })
    }
    return ok(`added card ${id}: ${title}${mentions.length > 0 ? `  · mentions: ${mentions.map((m) => '@' + m).join(' ')}` : ''}`, [{
      event: 'kanban.card_created',
      command: 'card add',
      boardId,
      cardId: id,
      columnId,
      actorId: me,
      companyId,
      assigneeId: assignee,
      mentions,
      title,
      visibleToUser: true,
    }])
  }

  if (op === 'move') {
    const cardId = parsed.positional[1]
    const toCol = String(parsed.flags.to ?? parsed.flags.column ?? parsed.flags.col ?? '').trim()
    if (!cardId || !toCol) return err('usage: card move <card_id> --to <column_id>')
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    const colCheck = await pool.query(
      `SELECT 1 FROM board_columns WHERE id = $1 AND board_id = $2 LIMIT 1`,
      [toCol, home.boardId],
    )
    if (colCheck.rows.length === 0) return err(`column ${toCol} not in board ${home.boardId}`)
    const { rows: posRows } = await pool.query<{ max: number | null }>(
      `SELECT MAX(position) AS max FROM board_cards WHERE column_id = $1`, [toCol],
    )
    const position = (Number(posRows[0]?.max ?? 0)) + 1000
    await pool.query(
      `UPDATE board_cards SET column_id = $1, position = $2, updated_at = NOW() WHERE id = $3`,
      [toCol, position, cardId],
    )
    await pool.query(`UPDATE boards SET updated_at = NOW() WHERE id = $1`, [home.boardId])
    await publishBoardCli({
      companyId, kind: 'card.moved', boardId: home.boardId, cardId, columnId: toCol, actorId: me,
    })
    return ok(`moved card ${cardId} → ${toCol}`, [{
      event: 'kanban.card_moved',
      command: 'card move',
      boardId: home.boardId,
      cardId,
      fromColumnId: home.columnId,
      columnId: toCol,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  if (op === 'assign') {
    const cardId = parsed.positional[1]
    const who = parsed.positional[2] // pass "null" or omit to unassign
    if (!cardId) return err('usage: card assign <card_id> <participant_id|null>')
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    const assignee = (!who || who.toLowerCase() === 'null' || who === '-') ? null : who.trim()
    await pool.query(
      `UPDATE board_cards SET assignee_id = $1, updated_at = NOW() WHERE id = $2`,
      [assignee, cardId],
    )
    await publishBoardCli({
      companyId, kind: 'card.updated', boardId: home.boardId, cardId, actorId: me,
    })
    if (assignee && assignee !== me) {
      void wakeMentionedAgentsCli({ companyId, mentions: [assignee], actorId: me })
    }
    return ok(assignee ? `assigned card ${cardId} → @${assignee}` : `unassigned card ${cardId}`, [{
      event: 'kanban.card_assigned',
      command: 'card assign',
      boardId: home.boardId,
      cardId,
      actorId: me,
      companyId,
      assigneeId: assignee,
      visibleToUser: true,
    }])
  }

  if (op === 'claim') {
    // ATOMIC EXCLUSIVE CLAIM (the single most
    // important primitive for non-divergent collaboration). Win ONLY if the card
    // is unclaimed, already yours, or its claim has gone STALE (the claimant likely
    // died / went idle ≥20min without touching it). The WHERE guard is the gate and
    // rowCount is the SINGLE SOURCE OF TRUTH, so two agents racing the same card can
    // NEVER both win — exactly one claims it; everyone else is told to move on.
    const cardId = parsed.positional[1]
    if (!cardId) return err('usage: card claim <card_id>')
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    const claimed = await pool.query<{ id: string }>(
      `UPDATE board_cards SET assignee_id = $1, updated_at = NOW()
         WHERE id = $2
           AND (assignee_id IS NULL OR assignee_id = $1
                OR updated_at < NOW() - INTERVAL '20 minutes')
       RETURNING id`,
      [me, cardId],
    )
    if ((claimed.rowCount ?? 0) === 0) {
      const cur = await pool.query<{ assignee_id: string | null }>(
        `SELECT assignee_id FROM board_cards WHERE id = $1 LIMIT 1`, [cardId],
      )
      const holder = cur.rows[0]?.assignee_id
      return err(`claim failed: card ${cardId} is already being worked by @${holder ?? '?'} — move on to another task`)
    }
    await publishBoardCli({ companyId, kind: 'card.updated', boardId: home.boardId, cardId, actorId: me })
    return ok(`claimed card ${cardId} — it's yours. Do the work, post progress with \`card comment\`, move it with \`card move\`, and release with \`card assign ${cardId} null\` (or move to a done column) when finished.`, [{
      event: 'kanban.card_claimed',
      command: 'card claim',
      boardId: home.boardId,
      cardId,
      actorId: me,
      companyId,
      assigneeId: me,
      visibleToUser: true,
    }])
  }

  if (op === 'rename' || op === 'edit') {
    const cardId = parsed.positional[1]
    if (!cardId) return err('usage: card rename <card_id> --title "..." [--description "..."]')
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    const cur = await pool.query<{ title: string; description: string | null }>(
      `SELECT title, description FROM board_cards WHERE id = $1 LIMIT 1`, [cardId],
    )
    let nextTitle = cur.rows[0].title
    let nextDesc = cur.rows[0].description
    const sets: string[] = []
    const params: unknown[] = []
    if (typeof parsed.flags.title === 'string') {
      nextTitle = unescapeChat(parsed.flags.title).slice(0, 200)
      params.push(nextTitle); sets.push(`title = $${params.length}`)
    }
    if (typeof parsed.flags.description === 'string') {
      nextDesc = unescapeChat(parsed.flags.description).slice(0, 8000) || null
      params.push(nextDesc); sets.push(`description = $${params.length}`)
    }
    if (sets.length === 0) return err('nothing to update — pass --title or --description')
    const mentions = await cliParseMentions(companyId, `${nextTitle}\n${nextDesc ?? ''}`)
    params.push(JSON.stringify(mentions)); sets.push(`mentions = $${params.length}::jsonb`)
    params.push(cardId)
    await pool.query(
      `UPDATE board_cards SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params,
    )
    await publishBoardCli({
      companyId, kind: 'card.updated', boardId: home.boardId, cardId, mentions, actorId: me,
    })
    void wakeMentionedAgentsCli({ companyId, mentions, actorId: me })
    return ok(`updated card ${cardId}${mentions.length > 0 ? `  · mentions: ${mentions.map((m) => '@' + m).join(' ')}` : ''}`, [{
      event: 'kanban.card_updated',
      command: op === 'rename' ? 'card rename' : 'card edit',
      boardId: home.boardId,
      cardId,
      actorId: me,
      companyId,
      mentions,
      title: nextTitle,
      visibleToUser: true,
    }])
  }

  if (op === 'comment') {
    const cardId = parsed.positional[1]
    const body = parsed.positional.slice(2).join(' ').trim()
      || (typeof parsed.flags.body === 'string' ? unescapeChat(parsed.flags.body) : '')
    if (!cardId || !body) return err('usage: card comment <card_id> "<body>"')
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    const mentions = await cliParseMentions(companyId, body)
    const id = `cmt-${randomUUID().slice(0, 12)}`
    await pool.query(
      `INSERT INTO board_card_comments (id, card_id, author_id, body, mentions)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, cardId, me, body.slice(0, 8000), JSON.stringify(mentions)],
    )
    await pool.query(`UPDATE board_cards SET updated_at = NOW() WHERE id = $1`, [cardId])
    await pool.query(`UPDATE boards SET updated_at = NOW() WHERE id = $1`, [home.boardId])
    await publishBoardCli({
      companyId, kind: 'comment.created', boardId: home.boardId, cardId, commentId: id, mentions, actorId: me,
    })
    void wakeMentionedAgentsCli({ companyId, mentions, actorId: me })
    return ok(`commented on ${cardId}${mentions.length > 0 ? `  · mentions: ${mentions.map((m) => '@' + m).join(' ')}` : ''}`, [{
      event: 'kanban.comment_created',
      command: 'card comment',
      boardId: home.boardId,
      cardId,
      commentId: id,
      actorId: me,
      companyId,
      mentions,
      visibleToUser: true,
    }])
  }

  if (op === 'delete-comment' || op === 'rm-comment') {
    const cardId = parsed.positional[1]
    const commentId = parsed.positional[2]
    if (!cardId || !commentId) return err(`usage: card ${op} <card_id> <comment_id>`)
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    const r = await pool.query(
      `DELETE FROM board_card_comments
        WHERE id = $1 AND card_id = $2 AND author_id = $3`,
      [commentId, cardId, me],
    )
    if ((r.rowCount ?? 0) === 0) return err(`comment ${commentId} not found or not authored by ${me}`)
    await publishBoardCli({
      companyId, kind: 'comment.deleted', boardId: home.boardId, cardId, commentId, actorId: me,
    })
    return ok(`deleted comment ${commentId}`, [{
      event: 'kanban.comment_deleted',
      command: `card ${op}`,
      boardId: home.boardId,
      cardId,
      commentId,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  if (op === 'delete' || op === 'rm') {
    const cardId = parsed.positional[1]
    if (!cardId) return err('usage: card delete <card_id>')
    const home = await resolveCardBoard(cardId)
    if (!home) return err(`card ${cardId} not found`)
    await pool.query(`DELETE FROM board_cards WHERE id = $1`, [cardId])
    await publishBoardCli({
      companyId, kind: 'card.deleted', boardId: home.boardId, cardId, actorId: me,
    })
    return ok(`deleted card ${cardId}`, [{
      event: 'kanban.card_deleted',
      command: 'card delete',
      boardId: home.boardId,
      cardId,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  return err(`usage: card <ls|show|add|move|assign|rename|comment|delete-comment|delete> [...]`)
}

/* ============== action subcommands → executeTool() ============== */

/**
 * Map (subcommand, parsed args) to the tool's expected argument shape.
 * Returns the JSON args for executeTool, or an error string.
 */
function buildToolArgs(toolName: string, parsed: ParsedArgs): { argsJson: string } | { error: string } {
  const pos = parsed.positional
  const f = parsed.flags
  switch (toolName) {
    case 'react': {
      const messageId = pos[0]
      const emoji = pos[1]
      if (!messageId || !emoji) return { error: 'usage: react <message_id> <emoji>' }
      return { argsJson: JSON.stringify({ message_id: messageId, emoji }) }
    }
    case 'dm_with': {
      const partnerId = pos[0]
      const topic = pos[1] ?? (f.topic ? String(f.topic) : '')
      const opening = pos[2] ?? (f.say ? String(f.say) : (f.message ? String(f.message) : ''))
      if (!partnerId) return { error: 'usage: dm <partner_id> <topic> <opening>  OR  dm <partner_id> --topic "..." --say "..."' }
      if (!topic || !opening) return { error: 'dm requires both topic and opening message (positional or --topic/--say)' }
      return { argsJson: JSON.stringify({ partner_id: partnerId, topic, opening_message: opening }) }
    }
    case 'pull_group': {
      const title = pos[0]
      if (!title) return { error: 'usage: pull-group <title> --members a,b,c --reason "..." --say "..."' }
      const membersFlag = f.members ? String(f.members) : ''
      const members = membersFlag.split(',').map((s) => s.trim()).filter(Boolean)
      if (members.length === 0) return { error: 'pull-group requires --members a,b,c' }
      const reason = f.reason ? String(f.reason) : ''
      const opening = f.say ? String(f.say) : (f.message ? String(f.message) : '')
      if (!reason || !opening) return { error: 'pull-group requires --reason "..." and --say "..."' }
      return { argsJson: JSON.stringify({ title, members, reason, opening_message: opening }) }
    }
    case 'palette': {
      const brief = pos.join(' ').trim() || (f.brief ? String(f.brief) : '')
      if (!brief) return { error: 'usage: palette <brief>' }
      return { argsJson: JSON.stringify({ brief }) }
    }
    default:
      return { error: `unknown tool: ${toolName}` }
  }
}

/* ============== Collaborative documents (CRDT) ==============
 *
 * Agents drive the same Y.Doc rooms the humans see. Edits are applied
 * through the in-process room manager so the WS fan-out + persistence
 * happens automatically — the human's editor sees the agent's cursor
 * + insertion live, as if a remote teammate just typed it.
 */
async function publishDocChanged(
  companyId: string,
  documentId: string,
  kind: 'document.created' | 'document.updated' | 'document.deleted',
  actorId: string,
): Promise<void> {
  const { CH_DOCS, publish } = await import('../redis.js')
  await publish(CH_DOCS, {
    type: 'doc.changed',
    kind,
    companyId,
    documentId,
    actorId,
  })
}

async function cmdDoc(parsed: ParsedArgs): Promise<CliResult> {
  const op = parsed.positional[0] ?? 'ls'
  const me = resolveAs(parsed)
  const companyId = await agentCompany(me)
  if (!companyId) return err(`unknown agent ${me} (no company)`)

  if (op === 'ls' || op === 'list') {
    const { rows } = await pool.query<{
      id: string; title: string; created_by: string; updated_at: Date
    }>(
      `SELECT id, title, created_by, updated_at FROM documents
        WHERE company_id = $1 ORDER BY updated_at DESC LIMIT 200`,
      [companyId],
    )
    if (parsed.flags.json) return ok(JSON.stringify(rows, null, 2))
    if (rows.length === 0) return ok('(no documents in this workspace)')
    return ok([
      `${rows.length} document(s):`,
      '',
      ...rows.map((d) => `  ${d.id.padEnd(24)} ${d.title}`),
    ].join('\n'))
  }

  if (op === 'create' || op === 'new') {
    const title = parsed.positional.slice(1).join(' ').trim()
      || (typeof parsed.flags.title === 'string' ? parsed.flags.title : '')
      || 'Untitled'

    // Tenant-scoped claim by title so two agents don't independently
    // create overlapping docs ("Q3 plan v1", "Q3 plan v2", "Q3 plan
    // draft"). The title is the dedup key — close-enough titles will
    // still collide thanks to subject normalization.
    const blocked = await tryClaimTenantWork(companyId, me, 'doc-create', title)
    if (blocked) return blocked

    try {
      // The claim above only guards work IN FLIGHT — it's released the
      // moment the first creator finishes, so it cannot stop a SEQUENTIAL
      // duplicate (2026-06-12: nova created+released 《第七天的猫》 at
      // :17, saga's claim sailed through clean at :22 → two docs). Check
      // the authoritative table for a same-title doc another agent just
      // created: if one exists, the work is DONE — point at it instead of
      // duplicating. This runs inside the claim window, so against a
      // CONCURRENT creator we either lose the claim (handled above) or
      // see their committed row here.
      const { normalizeWorkSubject } = await import('./runtime/inproc-client.js')
      const normTitle = normalizeWorkSubject(title)
      const docHoldScope = `doc-create:${normTitle}`
      const forceArmed = Boolean(parsed.flags.force) && (await consumeHold(me, docHoldScope)).armed
      if (!forceArmed) {
        const { rows: recentDups } = await pool.query<{
          id: string; title: string; created_by: string; created_at: Date
        }>(
          `SELECT id, title, created_by, created_at FROM documents
            WHERE company_id = $1 AND created_by <> $2
              AND created_at > NOW() - INTERVAL '15 minutes'
            ORDER BY created_at DESC LIMIT 50`,
          [companyId, me],
        )
        const dup = recentDups.find((d) => normalizeWorkSubject(d.title) === normTitle)
        if (dup) {
          await recordHold(me, docHoldScope)
          const ageSec = Math.max(1, Math.round((Date.now() - dup.created_at.getTime()) / 1000))
          return err(
            `HELD — document NOT created. ${dup.created_by} already created "${dup.title}" (${dup.id}) ${ageSec}s ago — ` +
            `this work is DONE; a second copy is duplicate clutter. ` +
            `Build on theirs instead: \`cumora doc read ${dup.id}\` / \`cumora doc append ${dup.id} "..."\`. ` +
            `If you GENUINELY need a separate doc with this same title, rerun with --force ` +
            `(--force only works after you've been shown this hold — passing it preemptively does nothing).`,
            2,
          )
        }
      }
      const id = `doc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      await pool.query(
        `INSERT INTO documents (id, company_id, title, created_by) VALUES ($1, $2, $3, $4)`,
        [id, companyId, title.slice(0, 200), me],
      )
      // If --body was supplied, seed the doc as one or more paragraphs.
      // Newlines split, so a multi-line body lands as proper block
      // structure (not a single 1500-char paragraph) in the rich editor.
      const body = typeof parsed.flags.body === 'string' ? unescapeChat(parsed.flags.body) : ''
      if (body) {
        const { applyAgentEdit } = await import('../documents/rooms.js')
        await applyAgentEdit(id, companyId, me, [{ kind: 'append', text: body }])
      }
      await publishDocChanged(companyId, id, 'document.created', me)
      return ok(`created document ${id}: ${title}`, [{
        event: 'document.created',
        command: 'doc create',
        documentId: id,
        actorId: me,
        companyId,
        title,
        bodyLength: body.length,
        visibleToUser: true,
      }])
    } finally {
      await releaseTenantWork(companyId, me, 'doc-create', title)
    }
  }

  if (op === 'read' || op === 'show') {
    const docId = parsed.positional[1]
    if (!docId) return err('usage: doc read <document_id>')
    const { rows } = await pool.query<{ company_id: string; title: string }>(
      `SELECT company_id, title FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const { readDocumentText } = await import('../documents/rooms.js')
    const body = await readDocumentText(docId, companyId)
    if (parsed.flags.json) return ok(JSON.stringify({ id: docId, title: rows[0].title, body }, null, 2))
    return ok([
      `# ${rows[0].title}  (${docId})`,
      '',
      body || '(empty)',
    ].join('\n'))
  }

  if (op === 'append') {
    const docId = parsed.positional[1]
    const text = parsed.positional.slice(2).join(' ').trim()
      || (typeof parsed.flags.text === 'string' ? unescapeChat(parsed.flags.text) : '')
    if (!docId || !text) return err('usage: doc append <document_id> "<text>"')
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const { applyAgentEdit } = await import('../documents/rooms.js')
    await applyAgentEdit(docId, companyId, me, [{ kind: 'append', text }])
    await publishDocChanged(companyId, docId, 'document.updated', me)
    return ok(`appended ${text.length} chars to ${docId}`, [{
      event: 'document.updated',
      command: 'doc append',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'append',
      bodyLength: text.length,
      visibleToUser: true,
    }])
  }

  if (op === 'prepend') {
    const docId = parsed.positional[1]
    const text = parsed.positional.slice(2).join(' ').trim()
      || (typeof parsed.flags.text === 'string' ? unescapeChat(parsed.flags.text) : '')
    if (!docId || !text) return err('usage: doc prepend <document_id> "<text>"')
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const { applyAgentEdit } = await import('../documents/rooms.js')
    await applyAgentEdit(docId, companyId, me, [{ kind: 'insertParagraph', at: 'start', text }])
    await publishDocChanged(companyId, docId, 'document.updated', me)
    return ok(`prepended ${text.length} chars to ${docId}`, [{
      event: 'document.updated',
      command: 'doc prepend',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'prepend',
      bodyLength: text.length,
      visibleToUser: true,
    }])
  }

  if (op === 'image') {
    // Direct image-block insert. The markdown route (`doc append "![alt](url)"`)
    // is the more idiomatic affordance but it goes through a line-based regex
    // that struggles when the URL wraps mid-emit (long presigned attachment
    // links do this routinely). This subcommand bypasses parsing — agents
    // pass src + optional alt and get a guaranteed image node.
    //
    // Placement is layered: absolute (`--at end|start`, default end) gives
    // a coarse "drop it somewhere" insert, while anchored placements
    // (`--replace`, `--after`, `--before`) take a snippet of existing
    // text and place the image relative to the block containing it. The
    // killer use case for `--replace` is swapping a previously-emitted
    // but inert `![alt](url)` markdown paragraph for a real image node:
    // the agent passes the exact markdown text as the anchor and the
    // broken text gets replaced by the image inline.
    const docId = parsed.positional[1]
    const src = parsed.positional[2]
      || (typeof parsed.flags.src === 'string' ? unescapeChat(parsed.flags.src) : '')
    const alt = typeof parsed.flags.alt === 'string' ? unescapeChat(parsed.flags.alt).trim() : ''
    const replaceAnchor = typeof parsed.flags.replace === 'string' ? unescapeChat(parsed.flags.replace) : ''
    const afterAnchor = typeof parsed.flags.after === 'string' ? unescapeChat(parsed.flags.after) : ''
    const beforeAnchor = typeof parsed.flags.before === 'string' ? unescapeChat(parsed.flags.before) : ''
    const atRaw = typeof parsed.flags.at === 'string' ? parsed.flags.at.trim().toLowerCase() : 'end'
    if (!docId || !src) return err('usage: doc image <document_id> <url> [--alt "..."] [--at end|start | --replace "..." | --after "..." | --before "..."]')
    if (!/^https?:\/\//i.test(src)) return err('image url must be http(s)://')

    // Pick the placement mode. Anchored flags win over `--at`. If more
    // than one anchor is supplied we surface an error rather than pick
    // arbitrarily — the agent should declare intent unambiguously.
    const anchors = [
      ['replace', replaceAnchor],
      ['after', afterAnchor],
      ['before', beforeAnchor],
    ].filter(([, v]) => v) as Array<['replace' | 'after' | 'before', string]>
    if (anchors.length > 1) {
      return err(`pass only one of --replace / --after / --before (got ${anchors.length})`)
    }
    let placement: { mode: 'start' | 'end' } | { mode: 'replace' | 'after' | 'before'; anchorText: string }
    if (anchors.length === 1) {
      placement = { mode: anchors[0][0], anchorText: anchors[0][1] }
    } else {
      placement = { mode: atRaw === 'start' ? 'start' : 'end' }
    }

    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const { applyAgentEdit, isAnchoredImagePlacement } = await import('../documents/rooms.js')
    const result = await applyAgentEdit(docId, companyId, me, [{ kind: 'image', src, alt: alt || null, placement }])

    // Anchor miss is a HARD error now — falling back to end-of-doc on a
    // missed snippet is how the doc collected duplicate inert images
    // in the first place. Return without firing the change event so the
    // agent's bash exit code reflects the failure and it knows to retry
    // with a different snippet (or stop trying).
    if (isAnchoredImagePlacement(placement) && result.imagePlaced === 'anchor-missed') {
      const snippet = placement.anchorText.slice(0, 60)
      return err(`anchor not found in ${docId}: "${snippet}". Re-read the doc and pick a snippet that uniquely identifies the target block — no image was inserted.`)
    }
    await publishDocChanged(companyId, docId, 'document.updated', me)

    let where: string
    if (isAnchoredImagePlacement(placement)) {
      where = `${placement.mode} block containing "${placement.anchorText.slice(0, 60)}"`
    } else {
      where = placement.mode === 'start' ? 'at start' : 'at end'
    }
    return ok(`inserted image into ${docId} ${where}`, [{
      event: 'document.updated',
      command: 'doc image',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'image',
      visibleToUser: true,
    }])
  }

  if (op === 'image-delete') {
    // Counterpart to `doc image`. Used when a doc has duplicate or
    // unwanted image blocks (e.g. earlier attempts that fell back to
    // end-of-doc when --replace missed, before the fallback was
    // removed). Match by exact src, src substring, or alt text.
    const docId = parsed.positional[1]
    const srcExact = typeof parsed.flags.src === 'string' ? unescapeChat(parsed.flags.src) : ''
    const srcContains = typeof parsed.flags['src-contains'] === 'string' ? unescapeChat(parsed.flags['src-contains']) : ''
    const altMatch = typeof parsed.flags.alt === 'string' ? unescapeChat(parsed.flags.alt) : ''
    const provided = [srcExact, srcContains, altMatch].filter(Boolean)
    if (!docId || provided.length === 0) {
      return err('usage: doc image-delete <document_id> [--src <exact_url> | --src-contains <substr> | --alt <text>]')
    }
    if (provided.length > 1) {
      return err('pass only one of --src / --src-contains / --alt')
    }
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const match: import('../documents/rooms.js').AgentImageDeleteMatch =
      srcExact ? { by: 'src', src: srcExact }
        : srcContains ? { by: 'src-contains', substring: srcContains }
          : { by: 'alt', alt: altMatch }
    const { applyAgentEdit } = await import('../documents/rooms.js')
    const result = await applyAgentEdit(docId, companyId, me, [{ kind: 'imageDelete', match }])
    if (result.imagesDeleted === 0) {
      return err(`no images in ${docId} matched the criterion`)
    }
    await publishDocChanged(companyId, docId, 'document.updated', me)
    return ok(`deleted ${result.imagesDeleted} image${result.imagesDeleted === 1 ? '' : 's'} from ${docId}`, [{
      event: 'document.updated',
      command: 'doc image-delete',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'image-delete',
      imagesDeleted: result.imagesDeleted,
      visibleToUser: true,
    }])
  }

  if (op === 'replace') {
    const docId = parsed.positional[1]
    const find = typeof parsed.flags.find === 'string' ? unescapeChat(parsed.flags.find) : ''
    const replace = typeof parsed.flags.replace === 'string' ? unescapeChat(parsed.flags.replace) : ''
    if (!docId || !find) return err('usage: doc replace <document_id> --find "..." --replace "..."')
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const { applyAgentEdit } = await import('../documents/rooms.js')
    const r = await applyAgentEdit(docId, companyId, me, [{ kind: 'replace', find, replace }])
    if (r.replaced === 0) return err(`text not found in ${docId}: ${JSON.stringify(find).slice(0, 80)}`)
    await publishDocChanged(companyId, docId, 'document.updated', me)
    return ok(`replaced ${r.replaced} occurrence in ${docId}`, [{
      event: 'document.updated',
      command: 'doc replace',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'replace',
      replaced: r.replaced,
      visibleToUser: true,
    }])
  }

  if (op === 'replace-block') {
    const docId = parsed.positional[1]
    const anchor = typeof parsed.flags.anchor === 'string' ? unescapeChat(parsed.flags.anchor) : ''
    const text = parsed.positional.slice(2).join(' ').trim()
      || (typeof parsed.flags.text === 'string' ? unescapeChat(parsed.flags.text) : '')
    if (!docId || !anchor || !text) return err('usage: doc replace-block <document_id> --anchor "<snippet in the block>" "<replacement markdown>"')
    const { rows } = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM documents WHERE id = $1 LIMIT 1`, [docId],
    )
    if (rows.length === 0 || rows[0].company_id !== companyId) return err(`document ${docId} not found`)
    const { applyAgentEdit } = await import('../documents/rooms.js')
    const r = await applyAgentEdit(docId, companyId, me, [{ kind: 'replaceBlock', anchorText: anchor, text }])
    if (r.blocksReplaced === 0) return err(`no block containing ${JSON.stringify(anchor).slice(0, 80)} in ${docId}`)
    await publishDocChanged(companyId, docId, 'document.updated', me)
    return ok(`replaced 1 block in ${docId}`, [{
      event: 'document.updated',
      command: 'doc replace-block',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'replace-block',
      visibleToUser: true,
    }])
  }

  if (op === 'rename') {
    const docId = parsed.positional[1]
    const title = parsed.positional.slice(2).join(' ').trim()
      || (typeof parsed.flags.title === 'string' ? parsed.flags.title : '')
    if (!docId || !title) return err('usage: doc rename <document_id> "<title>"')
    const r = await pool.query(
      `UPDATE documents SET title = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3`,
      [title.slice(0, 200), docId, companyId],
    )
    if (!r.rowCount) return err(`document ${docId} not found`)
    await publishDocChanged(companyId, docId, 'document.updated', me)
    return ok(`renamed ${docId} to "${title}"`, [{
      event: 'document.updated',
      command: 'doc rename',
      documentId: docId,
      actorId: me,
      companyId,
      editKind: 'rename',
      title,
      visibleToUser: true,
    }])
  }

  if (op === 'delete' || op === 'rm') {
    const docId = parsed.positional[1]
    if (!docId) return err('usage: doc delete <document_id>')
    const { rows } = await pool.query<{ created_by: string }>(
      `SELECT created_by FROM documents WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [docId, companyId],
    )
    if (rows.length === 0) return err(`document ${docId} not found`)
    if (rows[0].created_by !== me) return err(`only the creator can delete document ${docId}`)
    await pool.query(`DELETE FROM documents WHERE id = $1`, [docId])
    await publishDocChanged(companyId, docId, 'document.deleted', me)
    return ok(`deleted document ${docId}`, [{
      event: 'document.deleted',
      command: 'doc delete',
      documentId: docId,
      actorId: me,
      companyId,
      visibleToUser: true,
    }])
  }

  return err(`unknown doc op: ${op}\nusage: doc {ls|create|read|append|prepend|image|image-delete|replace|rename|delete} ...`)
}

async function runTool(toolName: string, parsed: ParsedArgs): Promise<CliResult> {
  const built = buildToolArgs(toolName, parsed)
  if ('error' in built) return err(built.error)
  const me = resolveAs(parsed)

  const { executeTool } = await import('./tools.js')
  const r = await executeTool({ agentId: me, name: toolName, argsJson: built.argsJson })
  const sideEffects = cliToolSideEffects(toolName, r.output, me)
  if (parsed.flags.json) {
    return r.ok
      ? ok(JSON.stringify(r.output, null, 2), sideEffects)
      : { ok: false, text: JSON.stringify({ error: r.error, display: r.display }, null, 2), exitCode: 1 }
  }
  const detail = r.display.detail || (r.output ? JSON.stringify(r.output, null, 2) : '(no output)')
  if (!r.ok) return err(`${r.display.name} failed: ${r.error ?? r.display.status}\n${detail}`)
  const head = `${r.display.name} → ${r.display.status}`
  return ok(`${head}\n\n${detail}`, sideEffects)
}

function cliToolSideEffects(toolName: string, output: unknown, agentId: string): CliSideEffect[] | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const o = output as Record<string, unknown>
  switch (toolName) {
    case 'react':
      return [{
        event: 'reaction.updated',
        command: 'react',
        visibleToUser: true,
        actorId: agentId,
        messageId: String(o.messageId ?? ''),
        emoji: String(o.emoji ?? ''),
        action: String(o.action ?? ''),
      }]
    case 'dm_with':
      return [{
        event: 'conversation.created',
        command: 'dm',
        actorId: agentId,
        conversationId: String(o.conversationId ?? ''),
        partnerId: String(o.partnerId ?? ''),
        topic: String(o.topic ?? ''),
        visibleToUser: true,
      }]
    case 'pull_group':
      return [{
        event: 'conversation.created',
        command: 'pull-group',
        actorId: agentId,
        conversationId: String(o.conversationId ?? ''),
        members: Array.isArray(o.members) ? o.members.map((m) => String(m)) : [],
        visibleToUser: true,
      }]
    default:
      return undefined
  }
}

/* ============== entry point ============== */

export async function runCli(argv: string[]): Promise<CliResult> {
  // Pull a leading global `--as <id>` (or `--as=<id>`) off. Runtime `/cli`
  // prepends identity this way, and direct dev/test callers often do too.
  // Re-attach it to the subcommand args so per-command parsers still see
  // `parsed.flags.as`.
  let asFlag: string | null = null
  while (argv.length > 0 && (argv[0] === '--as' || argv[0].startsWith('--as='))) {
    if (argv[0] === '--as') {
      asFlag = argv[1] ?? null
      argv = argv.slice(2)
    } else {
      asFlag = argv[0].slice('--as='.length)
      argv = argv.slice(1)
    }
  }
  if (argv.length === 0) return cmdHelp()
  const sub = argv[0]
  const rest = argv.slice(1)
  const parsed = parseArgs(rest)
  if (asFlag !== null && parsed.flags.as === undefined) {
    parsed.flags.as = asFlag
  }
  try {
    switch (sub) {
      case 'help':
      case '--help':
      case '-h':
        return await cmdHelp()
      case 'whoami':              return await cmdWhoami(parsed)
      case 'participants':        return await cmdParticipants(parsed)
      case 'conversations':       return await cmdConversations(parsed)
      case 'groups':              return await cmdConversations(parsed, 'group')
      case 'directs':             return await cmdConversations(parsed, 'direct')
      case 'members':             return await cmdMembers(parsed)
      case 'messages':            return await cmdMessages(parsed)
      case 'thread':              return await cmdThread(parsed)
      case 'convening':           return await cmdConvening(parsed)
      case 'search':              return await cmdSearch(parsed)
      case 'tools-log':           return await cmdToolsLog(parsed)
      case 'participants-status': return await cmdStatus(parsed)
      case 'memory':              return await cmdMemory(parsed)
      case 'climate':             return await cmdClimate(parsed)
      case 'log':                 return await cmdLog(parsed)
      case 'workspace':
      case 'ws':                  return await cmdWorkspace(parsed)
      case 'tasks':               return await cmdTasks(parsed)
      case 'calendar':            return await cmdCalendar(parsed)
      // ====== mailbox: how an agent reads + writes the world ======
      case 'inbox':               return await cmdInbox(parsed)
      case 'glance':              return await cmdGlance(parsed)
      case 'ack':                 return await cmdAck(parsed)
      case 'mute':                return await cmdMute(parsed)
      case 'follow':              return await cmdFollow(parsed)
      case 'ship':                return await cmdShip(parsed)
      case 'reply':               return await cmdReply(parsed)
      case 'leave':               return await cmdLeave(parsed)
      case 'kick':                return await cmdKick(parsed)
      case 'invite':              return await cmdInvite(parsed)
      case 'topic':               return await cmdTopicRead(parsed)
      case 'topic-set':           return await cmdTopicSet(parsed)
      case 'rename':              return await cmdRename(parsed)
      case 'avatar':              return await cmdAvatar(parsed)
      case 'skills':              return await cmdSkills(parsed)
      case 'email':               return await cmdEmail(parsed)
      case 'poll':                return await cmdPoll(parsed)
      // Top-level alias for `email contacts` — promotes contact lookup
      // to a discoverable verb. Same logic, same output. Use this when a
      // user names a person you don't recognize: BEFORE assuming or
      // silently skipping, run `cumora contacts <query>`.
      case 'contacts': {
        const me = resolveAs(parsed)
        const companyId = await agentCompany(me)
        if (!companyId) return err(`unknown agent ${me} (no company)`)
        // cmdEmailContacts reads positional[1] as the query (it expects
        // to be invoked as `email contacts <query>`, where positional[0]
        // is 'contacts'). For top-level `cumora contacts <query>` the
        // outer dispatch has already consumed 'contacts', so positional
        // is just [<query>]. Prepend a placeholder so the offset lines up.
        const shimmed = { ...parsed, positional: ['contacts', ...parsed.positional] }
        return await cmdEmailContacts(shimmed, me, companyId, Boolean(parsed.flags.json))
      }
      // ====== other actions (each wraps a tool implementation) ======
      // `kanban` is the canonical verb for the shared boards feature.
      // `card` for the cards inside them. No CJK aliases — easier to
      // type in any keyboard mode.
      case 'claim':               return await cmdClaim(parsed, 'claim')
      case 'unclaim':             return await cmdClaim(parsed, 'unclaim')
      case 'kanban':              return await cmdBoard(parsed)
      case 'card':                return await cmdCard(parsed)
      case 'doc':                 return await cmdDoc(parsed)
      case 'react':               return await runTool('react', parsed)
      case 'dm':                  return await runTool('dm_with', parsed)
      case 'pull-group':          return await runTool('pull_group', parsed)
      case 'palette':             return await runTool('palette', parsed)
      case 'image':               return await cmdImage(parsed)
      default:
        return err(`unknown subcommand: ${sub}\nrun "cumora help" for usage`)
    }
  } catch (e) {
    return err(`error: ${e instanceof Error ? e.message : String(e)}`, 2)
  }
}

// tokenize is re-exported from ./cli-parse — see the import block at the
// top of this file.
