<!--
postwisp · self-hosted Telegram email manager
Copyright (C) 2026 Reza Harirchian

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
-->

# Cloudflare Email Routing inbound for postwisp

`worker.js` in this directory is a companion Cloudflare Email Worker that you
deploy on **your own** Cloudflare account. It receives mail for your domain
through Cloudflare Email Routing, parses it with `postal-mime`, and
forwards it in one of two modes:

- **Ingest mode** (default): POSTs the parsed email to your self-hosted
  postwisp server's `/ingest/cloudflare` endpoint, signed with a
  shared-secret HMAC so postwisp knows the request came from your worker.
- **Direct Bot API mode**: sends the email straight to your Telegram chat
  via the Bot API · no postwisp server needed. Pair it with the `tgcloud/`
  serverless companion in this repo (see `docs/SERVERLESS.md`) so the
  message's Save / View code / Reply buttons work.

The mode is picked by which env vars are set; they are mutually exclusive.
Set `POSTWISP_SECRET` + `POSTWISP_INGEST_URL` for ingest mode, or
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_OWNER_CHAT_ID` for direct mode. Never both.

This phase is **inbound-only**. Sending always goes through the Resend
adapter: sending mail from a worker requires Workers Paid, which is out of
scope.

## MX exclusivity

A domain's MX records can point at Resend **or** Cloudflare Email Routing,
never both. Pick one inbound provider per domain:

- If postwisp sends via Resend for a domain, keep Resend's MX there and do
  not enable Email Routing for that domain.
- If you want Cloudflare to receive mail for a domain, route its MX to
  Cloudflare Email Routing and do not point that domain at Resend.

Sending via Resend while receiving via Cloudflare on the same domain is
fine; that split is per-direction, not per-domain.

## Prerequisites

- A Cloudflare account with the domain added to it.
- `wrangler` installed and logged in (`wrangler login`).
- Ingest mode: your postwisp server reachable over HTTPS at a stable URL.
- Direct mode: the bot token of your tgcloud serverless bot (from BotFather,
  with Serverless enabled) and your numeric Telegram user id.

## Deploy steps · ingest mode

1. Create the worker project and install the parser:

   ```
   mkdir postwisp-mail-worker && cd postwisp-mail-worker
   npm init -y
   npm i postal-mime
   ```

2. Copy `worker.js` from this directory into the project root.

3. Create `wrangler.toml`:

   ```toml
   name = "postwisp-mail-worker"
   main = "worker.js"
   compatibility_date = "2026-10-10"

   [vars]
   POSTWISP_INGEST_URL = "https://your-server.example.com/ingest/cloudflare"
   ```

   `POSTWISP_INGEST_URL` must be the full URL of your postwisp server's
   `/ingest/cloudflare` endpoint.

4. Generate the shared secret and give it to both sides. On postwisp's side
   it is `POSTWISP_CF_INGEST_SECRET` (env) or `cloudflare_ingest_secret`
   (config file):

   ```
   openssl rand -hex 32
   ```

   Store it in the worker as an encrypted secret (never in `wrangler.toml`):

   ```
   wrangler secret put POSTWISP_SECRET
   ```

   And set the same value for postwisp, e.g. in its environment:

   ```
   export POSTWISP_CF_INGEST_SECRET=<paste the same hex>
   ```

5. Deploy:

   ```
   wrangler deploy
   ```

6. In the Cloudflare dashboard, go to Email Routing for your domain and add
   a catch-all rule that sends to the worker you just deployed. Until that
   rule exists, Cloudflare drops incoming mail instead of forwarding it.

## Verifying

Send a test email to any address on the domain, then check both ends:

- `wrangler tail` (or the dashboard's worker logs) should show no errors.
- postwisp's log should show the `cloudflare ingest processed` line, and
  the email should appear in the bot as a normal inbound message.

If the worker logs `postwisp ingest rejected the email`, the shared secret
on the two sides does not match · check `POSTWISP_SECRET` in the worker
against postwisp's `POSTWISP_CF_INGEST_SECRET`.

## Payload and security

The worker signs every request:

- `x-postwisp-signature`: hex HMAC-SHA256 over the raw JSON request body,
  keyed with the shared secret. Compared with `timingSafeEqual`.
- `x-postwisp-timestamp`: unix seconds. Rejected if more than 300 seconds
  from the server's clock, either way. Replays an old request cannot work
  after that window, and the payload id is deduplicated on receipt.

## Event ids

The payload `id` is `cf-` plus the first 32 hex chars of the SHA-256 of the
Message-ID header (or `cf-<uuid>` when the email has none). Raw Message-IDs
are unbounded and postwisp embeds the id in Telegram callback data (64 bytes
max), so the hash keeps buttons working. The full Message-ID is preserved in
`headers['message-id']` for threading.

## Attachment caps

- Files larger than 5 MB are not forwarded inline.
- Once forwarded attachments pass 8 MB in one email, the rest are skipped.
- Skipped files are still listed in the payload with `truncated: true`, so
  the owner sees that something was dropped instead of wondering where it
  went.
- Attachment bytes are stashed server-side for later download, capped at
  20 MB total per email.

## Secret rotation

1. Generate a new secret: `openssl rand -hex 32`.
2. Set it in postwisp first (env or config file, then restart).
3. Update the worker: `wrangler secret put POSTWISP_SECRET`, then
   `wrangler deploy`.
4. Send a test email to confirm the new secret works.

Between steps 2 and 3 there is a window where the two sides disagree; mail
arriving in that window is rejected with a 4xx and the worker logs it.
Keep the window short.

## Deploy steps · direct Bot API mode (no postwisp server)

Use this when you run the `tgcloud/` serverless companion instead of a
self-hosted postwisp. The full walkthrough is in `docs/SERVERLESS.md`; the
worker half is:

1. Create the worker project and install the parser:

   ```
   mkdir postwisp-mail-worker && cd postwisp-mail-worker
   npm init -y
   npm i postal-mime
   ```

2. Copy `worker.js` from this directory into the project root.

3. Create `wrangler.toml` (note: no `POSTWISP_*` vars here):

   ```toml
   name = "postwisp-mail-worker"
   main = "worker.js"
   compatibility_date = "2026-10-10"

   [vars]
   TELEGRAM_OWNER_CHAT_ID = "123456789"
   ```

   `TELEGRAM_OWNER_CHAT_ID` is your numeric Telegram user id · the same
   value you seed as `owner_id` in the tgcloud database.

4. Store the bot token as an encrypted secret (never in `wrangler.toml`):

   ```
   wrangler secret put TELEGRAM_BOT_TOKEN
   ```

   This must be the token of the same bot you deployed with `tgcloud push`,
   so the message buttons reach the tgcloud handlers.

5. Deploy, then add the Email Routing catch-all rule for your domain that
   sends to this worker (same as ingest mode step 6).

Each incoming email arrives in your chat as one message (long bodies are
truncated at ~3900 characters) with three buttons:

- **Save to inbox** · parses the message and stores it in the tgcloud
  database, running your rules. After this the mail shows up in the
  companion's Inbox, search, and OTP views.
- **View code** · extracts one-time passcodes from the body and replies
  with them (the reply is sent with `protect_content`).
- **Reply** · starts the compose wizard prefilled with the sender and a
  `Re:` subject.

The message itself is sent with `protect_content: true`, so it cannot be
forwarded out of the chat. Verify by sending a test email to the domain
and tapping each button.
