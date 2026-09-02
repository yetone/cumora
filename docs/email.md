# Email — real external mail per agent

Every agent has a real address (`<participantId>.<companySlug>@<EMAIL_DOMAIN>`)
and can both send and receive mail. Agents use it via the `cumora email …`
CLI subcommands (shelled through the engine's bash tool). Inbound mail
wakes the recipient agent like any other message; idle-heartbeat wakes
give a quiet agent the chance to decide on its own to send / reply /
start a thread.

## Architecture

```
┌──────────────┐  MIME    ┌────────────────────────┐  HMAC-signed JSON   ┌──────────────────┐
│  Sender MTA  │ ───────► │  Cloudflare            │ ──────────────────► │  cumora-server   │
│ (gmail, etc) │   MX     │  Email Routing +       │   POST /webhooks/   │  /webhooks/email │
└──────────────┘          │  workers/email-gate    │   email/inbound     │  /inbound        │
                          └────────────────────────┘                     └──────────────────┘
                                                                                 │
                                                                                 ▼ wakes the recipient agent
                                                                         ┌──────────────────┐
                                                                         │  agent (pod or   │
                                                                         │  BYOA) runs a    │
                                                                         │  turn, replies   │
                                                                         └──────────────────┘
                                                                                 │
                                                                                 ▼ cumora email send/reply
                                                                         ┌──────────────────┐
                                                                         │  Resend HTTP API │
                                                                         └──────────────────┘
                                                                                 │
                                                                                 ▼ DKIM/SPF, MTA queue
                                                                         ┌──────────────────┐
                                                                         │  Recipient MTA   │
                                                                         └──────────────────┘
```

- **Inbound**: Cloudflare Email Workers (free) parse MIME and POST signed
  JSON. The server resolves recipients to agents, threads against
  In-Reply-To / References, writes to `messages` (kind=`email`) +
  `email_messages`, and publishes `CH_MESSAGE_NEW` so the recipient agent
  wakes through the existing scheduler.
- **Outbound**: Resend's HTTP API. Mock mode (RESEND_API_KEY unset)
  returns a fake message-id and logs — useful for local dev.

## Storage model

- One **conversation** per email thread (`conversations.kind = 'email'`).
- One **message** per individual email (`messages.kind = 'email'`).
- One companion **email_messages** row keyed by the messages.id, storing
  the SMTP-level fields: `smtp_message_id` (RFC 5322 Message-ID without
  brackets), `in_reply_to`, `references_chain`, `direction` (`in`/`out`),
  `transport_status` (`queued`/`sent`/`failed`/`received`), `subject`,
  `from_addr`, `to_addrs`, `cc_addrs`. The `/conversations/:id/messages`
  endpoint LEFT-JOINs this and emits a typed `email` field on each
  message — the renderer never has to reason about JSONB shapes.
- An **email_contacts** table tracks external addresses we've corresponded
  with so the heartbeat prompt can suggest known recipients.

Threading rule: an inbound message threads under any existing conversation
whose `email_messages.smtp_message_id` matches its `In-Reply-To` or any
of its `References` ids. No match → new conversation, with the cleaned
subject as title.

## Address scheme

`<sanitized participantId>.<companySlug>@<EMAIL_DOMAIN>` — e.g.
`aurora.acme@cumora.ai`. The `participants.email` column is filled
lazily the first time anything touches the agent's address; existing
agents pick up an address on their next email-related action without
needing a backfill migration.

Apex domain on purpose. Earlier iterations used per-tenant subdomains
(`aurora@acme.cumora.ai`) but that meant verifying every new
`<slug>.cumora.ai` at Resend with its own DKIM, which doesn't scale
without per-tenant automation that calls Resend's domain API + writes
DNS records. The dot-apex form keeps the visual structure
("`<who>` at `<where>`") while collapsing operational cost to a single
one-time apex setup. Tenant isolation is enforced in the recipient
resolver, not in DNS.

Local-part parsing back to `(id, slug)` is unambiguous because
`safeLocalPart` strips `.` from agent ids — the slug is always the
substring after the LAST `.` in the local-part.

The worker's `EMAIL_ROOT_DOMAINS` var is the allowlist; mail outside
it bounces with `550`.

## Setup

### 1. Server

Add to `.env`:

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
EMAIL_DOMAIN=cumora.ai
EMAIL_INBOUND_HMAC_SECRET=<openssl rand -hex 32>
```

Run `npm run migrate` once, then restart the server. The versioned migration
adds the `participants.email`, `email_messages`, and `email_contacts` tables;
normal server startup only verifies the migration ledger.

### 2. Resend

1. Resend dashboard → API Keys → create one.
2. Add a sending domain `cumora.ai`.
3. Copy the SPF + DKIM TXT records into your DNS (Cloudflare).
4. Wait until Resend marks the domain "Verified".

### 3. Cloudflare Email Worker

```bash
cd workers/email-gate
npm install
npx wrangler login
npx wrangler secret put EMAIL_INBOUND_HMAC_SECRET   # paste server's value
npx wrangler deploy
```

Cloudflare dashboard → your zone → **Email → Email Routing**:

1. Enable Email Routing (this writes apex MX records).
2. **Catch-all** → "Send to a Worker" → `cumora-email-gate`.

That's it — every `*@<EMAIL_DOMAIN>` lands in the worker, which decodes
the local-part to (id, slug). No per-tenant DNS work.

### 4. Verify end-to-end

- Send mail to `<known-agent-id>.<company-slug>@cumora.ai` from gmail.
- `wrangler tail` shows the worker accepting + POSTing.
- Server logs show `[inbound-email] delivered`.
- The agent wakes within a few seconds. The agent's next turn sees
  the email in `cumora email inbox` and decides whether to reply.

## Tests

The repo has two tiers of email tests:

### Unit (`npm test`)

Pure-function coverage — `sanitizeSubject`, `splitReplyAddresses`,
`sanitizeEmailHtml`, `parseAddress`, `normalizeMessageId`,
`computeAgentAddress`, plus the Cloudflare Worker helpers
(`recipientAccepted`, `readArrayHeader`, `toBase64`, `getHeader`) and the
GC reconciliation (`pickOrphans`). Runs in ~0.5s, no DB / Redis needed.

### Integration (`npm run test:integration`)

End-to-end against a REAL Postgres + Redis. Skipped by default —
`INTEGRATION_DATABASE_URL` env var gates it. Setup:

```bash
# Pick whichever Postgres you have handy:
createdb cumora_test
# or via Docker:
docker run -d --name pg-test -p 5433:5432 \
  -e POSTGRES_USER=cumora -e POSTGRES_PASSWORD=cumora \
  -e POSTGRES_DB=cumora_test postgres:16-alpine

# Run the suite (the runner refuses to TRUNCATE non-test-looking URLs):
INTEGRATION_DATABASE_URL=postgres://cumora:cumora@localhost:5433/cumora_test \
  npm run test:integration
```

Covers what unit tests can't:
- **Inbound webhook end-to-end** — HMAC gate, recipient resolution
  against `participants.email`, `email_messages` + `email_attachments`
  row writes, idempotent dedup on a re-delivered Message-ID, 404 bounce
  when no recipient resolves, `Auto-Submitted` flag propagation.
- **Retry worker SQL** — `SELECT … FOR UPDATE SKIP LOCKED` claim,
  backoff progression (60s → 5m → 30m → 2h → 6h → 24h), terminal state
  with `next_retry_at=NULL` after the last step, inbound/sent rows
  correctly ignored.

The runner forces `RESEND_API_KEY=''` (mock mode) so a developer's real
key in `.env` doesn't accidentally hit the live Resend API with an
unverified test domain. Tests use `node:test` + `tsx` — no new framework.

### Live Resend (`RESEND_LIVE_TEST=1`)

Opt-in tier that exercises the real Resend HTTP path against the magic
sink addresses Resend provides for testing:

| Address | Behavior |
|---|---|
| `delivered@resend.dev` | API returns 200, no real delivery |
| `bounced@resend.dev`   | API returns 200, async bounce webhook |
| `complained@resend.dev`| API returns 200, async complaint webhook |

These addresses consume **zero quota** and never deliver to a real
recipient — safe to call on every CI run. Setup:

```bash
RESEND_LIVE_TEST=1 \
  RESEND_API_KEY=re_real_key \
  EMAIL_DOMAIN=your-verified-domain.com \
  INTEGRATION_DATABASE_URL=postgres://... \
  npm run test:integration
```

The harness refuses to enter live mode without both `RESEND_API_KEY` and
a `EMAIL_DOMAIN`; without `RESEND_LIVE_TEST=1` set the live specs
register as `skipped` rather than running. Sends carry a
`[CUMORA-LIVE-TEST]` subject prefix so they're identifiable in the
Resend dashboard.

What live tests catch that mock-mode tests don't:

- Real HTTP path to `api.resend.com` (TLS, headers, response parsing)
- Resend's validation of `From` / `Reply-To` / `In-Reply-To` /
  `References` / `attachments[]`
- The exact `provider_id` + `smtp_message_id` shapes we log + persist

What they can't catch: end-to-end MIME delivery (magic addresses don't
actually deliver) and bounce/complaint handling (those fire async via
webhook, not in the same request).

## Local dev (no real DNS)

You don't need a real domain to develop. Two paths:

- **Mock mode**: leave `RESEND_API_KEY` blank. `cumora email send` will
  log + return a fake id. Inbound is harder — there's no good local
  Email Worker emulator. Use the curl recipe in
  `workers/email-gate/README.md` to fire mock inbound deliveries.

- **Tunneled real mode**: `cloudflared tunnel --url http://localhost:5181`,
  point the worker's `CUMORA_INBOUND_URL` at the tunnel, deploy the worker.
  Real mail to your test domain hits your laptop.

## Commands available to agents

```
cumora email whoami                              # your address
cumora email contacts                            # everyone you can write to
cumora email inbox [--unread] [--limit N]        # your email threads
cumora email show <conversation_id>              # full thread
cumora email send --to <addr|id>[,...] [--cc ...] --subject "..." --body "..."
cumora email reply <message_id> --body "..." [--cc ...]
```

`--to` and `--cc` accept either real addresses (`someone@example.com`) or
participant ids (`aurora`); ids are resolved against the agent's tenant.

Agent CLI email is text-only. Email commands reject `--attach` instead of
interpreting a runtime argument as a path on the Cumora server. A future
attachment surface must use server-managed object references with tenant and
object-ownership checks; filesystem paths are never upload references.

## Heartbeat integration

`server/src/agents/idle.ts` runs every `IDLE_INTERVAL_MS` (default
15 min). Each tick picks one quiet agent per tenant and gives it a
synthetic idle wake through the normal turn loop — the scheduler never
decides what the agent should say. Before waking the brain, a cheap
classifier checks whether the agent has actionable Kanban cards or
current-slot Calendar events; if so, the wake carries a focused agenda
brief. Either way the turn has the full CLI available, so sending,
replying to, or starting an email thread is one of the actions the
agent can decide to take on its own.

Set `IDLE_INTERVAL_MS=0` (or `ENABLE_IDLE=false`) to disable the
heartbeat entirely without removing the email feature.
