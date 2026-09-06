# cumora-email-gate

Cloudflare Email Worker that fronts the agents' inbox.

## What it does

Cloudflare Email Routing → this worker → cumora-server `/webhooks/email/inbound`.

The worker:

1. Rejects mail (`550`) for any recipient outside `EMAIL_ROOT_DOMAINS`.
2. Reads the raw RFC 5322 message and parses it with `postal-mime`.
3. Builds a JSON payload (message-id, in-reply-to, references, from, to, cc, subject, text, html, raw size, `autoSubmitted` per RFC 3834, and `attachments[]` as base64 — capped at 10 MB per attachment and 18 MB in total).
4. HMAC-signs the payload with `EMAIL_INBOUND_HMAC_SECRET` and POSTs to `CUMORA_INBOUND_URL`.
5. Translates the server's response into accept or reject. Every rejection is **permanent** (`message.setReject`) — including the 5xx branch, which arguably should tempfail so the sender's MTA retries. See the note in `src/index.ts`.

Outbound mail goes through Resend on the server side, **not** this worker — Cloudflare Email Workers can't send mail.

## Setup

```bash
cd workers/email-gate
npm install
npx wrangler login                                         # one-time
npx wrangler secret put EMAIL_INBOUND_HMAC_SECRET          # paste server's value
npx wrangler deploy
```

Then in the Cloudflare dashboard:

1. Pick the zone for your `EMAIL_DOMAIN` (e.g. `cumora.ai`).
2. **Email → Email Routing → Get started** (this also adds the right MX records automatically).
3. Under **Catch-all address**, choose **Send to a Worker** → `cumora-email-gate`.
4. That's it — every `*@<EMAIL_DOMAIN>` lands in this worker, which decodes the local-part `<id>.<slug>` to identify the tenant. No per-tenant DNS work.

## Local dev

There's no good local emulator for Email Workers. The simplest loop is:

1. Tunnel your local cumora-server: `cloudflared tunnel --url http://localhost:5181`.
2. Set the worker's `CUMORA_INBOUND_URL` to the tunnel URL + `/webhooks/email/inbound`:
   ```toml
   [vars]
   CUMORA_INBOUND_URL = "https://your-tunnel.example/webhooks/email/inbound"
   ```
3. Send real mail to a test address. Cloudflare's worker logs (`wrangler tail`) show what arrives.

For pure server-side iteration on the inbound handler, hit it directly with `curl`:

```bash
BODY='{"messageId":"test-123@local","from":"Test Sender <sender@example.com>","to":["aurora.personal@cumora.ai"],"subject":"hi","text":"yo"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$EMAIL_INBOUND_HMAC_SECRET" -hex | awk '{print $2}')
curl -X POST http://localhost:5181/webhooks/email/inbound \
     -H "content-type: application/json" \
     -H "x-cumora-signature: sha256=$SIG" \
     --data "$BODY"
```
