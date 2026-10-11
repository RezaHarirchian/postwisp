# postwisp on Telegram Serverless

The `tgcloud/` directory in this repo is a serverless companion to postwisp:
the same core loop (read mail, send mail) running on Telegram's own
infrastructure instead of a server you operate. No VPS, no Docker, no
domain, no TLS certificates.

How it works: plain JavaScript modules in `tgcloud/` run on Telegram's
servers. Updates to your bot arrive as function calls; outbound mail goes
out through Resend's HTTPS API; inbound mail arrives through a Cloudflare
Email Worker that sends each message straight to your Telegram chat. State
lives in the tgcloud database (the `kv`, `emails`, `outbox`, `suppression`,
and `rules` tables in `tgcloud/schema.js`).

## What is included (and what is not)

The serverless build is a companion, not a port. It covers the core loop:

- Owner guard: every update not from the owner is dropped silently.
- Button menu: inbox, compose, sent, settings.
- Compose: multi-step wizard (to → subject → body → confirm) with real
  sending through Resend, idempotency keys, and a suppression list.
- Inbox: list saved mail, open, full text (chunked to Telegram's
  4096-character limit), mark read, archive.
- Search across saved mail; OTP code extraction from any message.
- Basic rules (from/subject matching → archive, mark read, suppress)
  applied when mail is saved.

Not included: drafts, scheduled sends, attachments, blocklist management,
digest, stats, the multi-provider layer (Resend only), the local SQLite
store, and the self-hosted webhook server. If you need those, run the
self-hosted bot.

## Serverless vs self-hosted

| | Self-hosted | Telegram Serverless |
|---|---|---|
| Runs on | Your VPS / Docker | Telegram's infrastructure |
| Inbound mail | Resend webhooks or Cloudflare worker → your server | Cloudflare worker → Bot API (direct) |
| Outbound mail | Resend / MailerSend / Mailgun | Resend only |
| Storage | Local SQLite (`postwisp.db`) | tgcloud database (no local files) |
| Attachments | Yes, stashed server-side | No |
| `fetch` response cap | None | 30 MB |
| Deploy | `install.sh` / Docker / npm | `tgcloud push` |
| Cost | Your server | Telegram's free serverless tier |

Choose serverless when you want zero infrastructure and the core loop is
enough. Choose self-hosted when you need attachments, scheduling, drafts,
or a second provider.

## Prerequisites

1. A Telegram bot from [@BotFather](https://t.me/BotFather). Open the bot,
   enable **Serverless**, and copy the **CLI access token** it shows.
2. The `tgcloud` CLI on your machine: `npm install -g @tgcloud/cli`.
3. A Resend API key and a verified sending domain (sending stays on
   Resend; the serverless build has no other provider).
4. A Cloudflare account with your receiving domain on it (for inbound;
   see below).
5. This repo checked out, with the `tgcloud/` directory intact.

Run `postwisp deploy:serverless` at any point: it checks the prerequisites
and prints the steps below.

## Deploy, step by step

```sh
# 1. Log in (paste the CLI access token from BotFather when asked)
tgcloud login

# 2. Deploy the code
tgcloud push

# 3. Create the tables
tgcloud migrate

# 4. Seed secrets (next section), then re-push only if you edited code:
tgcloud push

# 5. Test: send /start to the bot · the menu should appear.
```

`tgcloud push` uploads `tgcloud/handlers/` and `tgcloud/lib/`.
`tgcloud migrate` applies `tgcloud/schema.js`.

## Seeding secrets

The bot needs three values in its `kv` table before it can do anything.
They are seeded with a temporary handler executed by `tgcloud run` ·
values stay on your machine, never in the repo.

Create `tgcloud/handlers/seed.js` (temporary · delete it after seeding):

```js
// tgcloud/handlers/seed.js · temporary seed handler. Delete after seeding.
import { db } from 'sdk';
import { kv } from '../schema.js';

export default async function seed(secrets) {
  for (const [key, value] of Object.entries(secrets)) {
    await db
      .insert(kv)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({ target: kv.key, set: { value: String(value) } })
      .run();
    console.log(`kv: ${key} set`);
  }
}
```

Run it with your values (JSON5, so keys go unquoted):

```sh
npx tgcloud run handlers/seed '{ owner_id: "123456789", resend_api_key: "re_paste_yours_here", from_addr: "you@yourdomain.com" }'
```

Your numeric Telegram user id comes from [@userinfobot](https://t.me/userinfobot).
Then delete the handler and push again so it never reaches the bot:

```sh
rm tgcloud/handlers/seed.js
tgcloud push
```

Until `owner_id` is seeded, the bot drops every update silently (that is
the owner guard doing its job, not a broken deploy). Until
`resend_api_key` and `from_addr` are seeded, compose refuses to send and
tells you exactly that.

Optional seeds for later: rows in the `rules` table, e.g.
`{ field: 'subject', matcher: 'contains', value: 'newsletter', action: 'archive' }`.
Rules run when a notification is saved to the inbox.

## Inbound mail: the Cloudflare direct path

Telegram Serverless exposes no public HTTPS endpoint for webhooks, so
inbound mail cannot arrive the self-hosted way. Instead, the companion
Cloudflare Email Worker (`adapters/cloudflare/worker.js`) has a
**direct Bot API mode**: when `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_OWNER_CHAT_ID` are set (instead of the ingest-secret pair), the
worker sends each incoming email straight to your Telegram chat with three
inline buttons:

- **Save to inbox** · parses the message and stores it in the tgcloud
  database, running your rules. Only saved mail appears in Inbox, search,
  and OTP views.
- **View code** · extracts one-time passcodes and replies with them.
- **Reply** · starts the compose wizard prefilled with the sender.

Deploy steps for the worker half are in `adapters/cloudflare/README.md`
("direct Bot API mode"). The message format the worker sends is the wire
format in `tgcloud/lib/pure.js` (`formatInboundMessage`); the worker
duplicates that function because it cannot import it · keep the two in
sync.

### The Resend inbound webhook limitation, stated plainly

Resend's inbound receiving works through **webhooks**: Resend POSTs each
incoming email to a public HTTPS URL you configure. Telegram Serverless
functions have no public HTTPS endpoint that can receive such webhooks ·
there is nowhere for Resend to POST to. So Resend inbound does **not**
work with the serverless build, full stop.

Your options:

1. **Cloudflare Email Routing + the worker's direct mode** (recommended).
   Point the domain's MX at Cloudflare, deploy the worker, done. Sending
   still goes through Resend on the same domain · the split is
   per-direction, not per-domain.
2. **A forwarder**: a tiny HTTPS service elsewhere that receives the
   Resend webhook and relays it. That service is self-hosted
   infrastructure again, which defeats the purpose for most people.

Do not point Resend's inbound webhooks at a Telegram Serverless bot and
expect mail to arrive; it cannot.

## Limitations of the serverless build

- Core loop only (see "What is included" above).
- No local SQLite: state lives in the tgcloud database; there is no
  `postwisp.db` to back up or inspect locally.
- Outbound `fetch` responses are capped at 30 MB by the platform.
- No npm dependencies inside `tgcloud/`: modules may only import from
  `sdk`, `sdk/db`, or relative `.js` paths.
- Long email bodies are truncated (~3900 chars) in worker notifications.
- Search scans the most recent 200 saved emails; the archive is not
  indexed beyond that.

## `postwisp deploy:serverless`

The CLI walkthrough:

```sh
postwisp deploy:serverless
```

It is guided, not automatic: it checks that the `tgcloud` CLI is
installed (`tgcloud --version`), that `tgcloud status` works (logged
in), and that the `tgcloud/` project files exist in the repo · then prints
the exact ordered steps (login → push → migrate → seed → test) and offers
to show this document. It never deploys anything by itself; the BotFather
token and the login are yours to handle.

`postwisp doctor` also reports the serverless companion as an
informational check (warn at most, never a failure): whether the `tgcloud`
CLI is installed and whether `tgcloud/` is present.

## Troubleshooting

- **Bot does nothing at all**: `owner_id` is not seeded, or you messaged
  from a different Telegram account. Seed `owner_id` with your numeric id
  (`@userinfobot` shows it).
- **Menu works, compose refuses to send**: `resend_api_key` or
  `from_addr` is missing · re-run the seed step.
- **"Send failed: Resend rate limit (HTTP 429); retry after Ns"**: you hit
  Resend's rate limit. The message is in the outbox as `failed`; wait N
  seconds and send again. The idempotency key prevents duplicates.
- **Worker notification buttons do nothing**: the buttons reach the bot
  that sent the message. Make sure `TELEGRAM_BOT_TOKEN` in the worker is
  the same bot you deployed with `tgcloud push`.
- **Mail never arrives in Telegram**: check the worker logs
  (`wrangler tail`); the Email Routing catch-all rule must point at the
  worker, and the domain's MX must point at Cloudflare.
- **A code is not detected**: `View code` only finds 4–8 digit runs near
  words like "code", "OTP", or "verification". Bare numbers elsewhere are
  ignored on purpose.

## Status: live end-to-end test pending

The handlers, the wire format, the Resend sender, and the worker direct
mode are unit-tested against mocks in this repo (`pnpm test`). A live
end-to-end run · real `tgcloud push`/`migrate`, a real Serverless-enabled
bot, a real inbound email · still needs a Serverless-enabled bot token
from BotFather and has not been performed. It is tracked as PENDING-SECRET.
