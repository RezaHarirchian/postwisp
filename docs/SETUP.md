# postwisp setup guide

Complete setup from an empty machine to a working Telegram email bot.

## Prerequisites

1. A server (VPS, home machine, container) you can run a persistent process on.
2. Node.js 20 or newer (`node --version`).
3. A Telegram bot: talk to [@BotFather](https://t.me/BotFather), create a bot,
   copy the token.
4. An account with one email provider: **Resend**, **MailerSend**, or
   **Mailgun**. You need an API key and a sending domain verified there.
5. A domain you control (for sending and for inbound via Cloudflare).
6. (Inbound only) A Cloudflare account with Email Workers on your domain.

## 1. Install

```sh
npm install -g postwisp
postwisp doctor   # confirm Node 20+, paths, and permissions before you start
```

## 2. Run the wizard

```sh
postwisp setup
```

Seven steps, each verified before moving on. The wizard is resumable: if you
stop halfway, running `postwisp setup` again continues from the last
unfinished step.

1. **bot-token** · paste the token from @BotFather.
2. **owner** · pair your Telegram account. The wizard gives you a one-time
   pairing link; opening it in Telegram and pressing Start makes that chat the
   owner. Only the owner can use the bot.
3. **provider** · pick Resend, MailerSend, or Mailgun and paste the API key.
4. **domains** · comma-separated list of sending domains, e.g.
   `mail.example.com, example.com`.
5. **compliance** · physical address for the unsubscribe footer, an abuse
   contact, and your public URL.
6. **cloudflare** · configure the Cloudflare Email Worker ingest secret, so
   inbound mail from Cloudflare Email Workers is accepted on a signed route.
7. **e2e** · the wizard sends a live test email through your provider to prove
   the full path works before it declares success.

### Non-interactive setup (`setup --yes`)

For scripted or CI installs, set the environment variables and pass `--yes`:

```sh
export POSTWISP_BOT_TOKEN='<bot token>'
export POSTWISP_OWNER_ID='<your Telegram numeric user id>'
export POSTWISP_EMAIL_PROVIDER=resend              # resend | mailersend | mailgun
export POSTWISP_RESEND_API_KEY='<api key>'         # or MAILERSEND_/MAILGUN_
export POSTWISP_DOMAINS='mail.example.com'
export POSTWISP_WEBHOOK_SECRET='<provider webhook secret>'
export POSTWISP_CF_INGEST_SECRET='<secret>'        # optional, Cloudflare inbound
export POSTWISP_TEST_EMAIL='you@example.com'       # optional, for the e2e test
postwisp setup --yes
```

Values you omit can be filled in later with `postwisp config set <key> <value>`
or by re-running the wizard. `POSTWISP_SETUP_STEP` is internal wizard
bookkeeping, not operator config · do not set it by hand.

## 3. DNS records

Your provider's dashboard gives you the exact records when you add the domain.
The three standard records for deliverability:

- **SPF** · a TXT record on the domain authorizing the provider's servers.
- **DKIM** · a TXT record with the provider's public signing key.
- **DMARC** · a TXT record on `_dmarc.<domain>` stating what receivers should
  do with failures (start with `p=none`, tighten later).

Verify them with `postwisp domains`, which lists each domain's verification
status as reported by Resend (the command is Resend-only for now).

## 4. Telegram: webhook vs polling

- **Polling (default).** The bot fetches updates from Telegram itself. Nothing
  to configure, works behind NAT and without a public URL. Correct choice for
  most self-hosted installs.
- **Webhook.** Set `telegramWebhookPath` (unguessable path),
  `telegramWebhookSecret` (Telegram sends it in a header), and `publicUrl`
  (your public base URL, e.g. `https://mail.example.com`) in the config. On
  startup the server registers `publicUrl + telegramWebhookPath` with Telegram
  via `setWebhook`, so updates are pushed to you; in polling mode any stale
  webhook is cleared instead. The bot checks inbound updates against the
  secret; anything that fails verification is rejected. Use it when you
  need lower latency or are already running a public endpoint. Check the
  live state anytime with `postwisp webhooks`.

## 5. Cloudflare inbound

Inbound mail arrives through a Cloudflare Email Worker you deploy on your
domain:

```sh
postwisp cloudflare   # prints the deployment guide
```

The worker POSTs parsed mail to the postwisp server's Cloudflare ingest route,
signed with the shared secret from the setup wizard step (`POSTWISP_CF_INGEST_SECRET`).
If the secret is unset, the ingest route is disabled entirely and nothing is
accepted · there is no unsigned fallback.

## 6. Run it persistently (systemd)

Example unit file for a single-user install:

```ini
[Unit]
Description=postwisp Telegram email bot
After=network.target

[Service]
Type=simple
User=postwisp
Environment=POSTWISP_LOG_FILE=/var/log/postwisp/postwisp.log
ExecStart=/usr/local/bin/postwisp-start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Notes:

- The daemon entrypoint is `dist/index.js` (Docker runs it as `node dist/index.js`).
  For an npm install, run it as `node "$(npm root -g)/postwisp/dist/index.js"`;
  from a source checkout, `node dist/index.js` after `pnpm build` (or `pnpm dev`
  for watch mode). If you want a single name in the unit file, wrap one of
  these in a small `postwisp-start` script and point `ExecStart` at it.
- Config lives at `~/.config/postwisp/config.json` with mode 0600 for
  whichever user runs the service; make sure that user owns the data dir
  (`~/.local/share/postwisp` by default).
- The server binds `127.0.0.1:3000` by default. Put a reverse proxy (nginx,
  Caddy) in front of it for TLS if you use Telegram webhook mode.
- Enable and start: `systemctl enable --now postwisp`.

## 7. Updating

```sh
postwisp update
```

Checks the npm registry for a newer release and installs it. postwisp also
checks in the background once a day and notifies you in the CLI when an
update is available.

## Troubleshooting

1. **"Setup is incomplete" / wizard restarts from scratch**
   The wizard stores progress in the config file. Check it is writable and
   not replaced between runs:
   `ls -l ~/.config/postwisp/config.json` then `postwisp doctor`.

2. **The pairing link does nothing**
   The server must be running for the bot to receive your tap. Start the
   server, open the link, press Start in Telegram. The link works once; if
   the chat was already claimed, print a fresh one with
   `postwisp pair --rotate`.

3. **Test email never arrives**
   `postwisp domains` · if the domain shows `pending`, finish DNS verification
   in your provider's dashboard first. Then `postwisp logs` for the provider
   API error (keys shown redacted; the HTTP status is what matters).

4. **`postwisp doctor` fails "config file permissions"**
   The config must be mode 0600 because it holds secrets:
   `chmod 600 ~/.config/postwisp/config.json`.

5. **Telegram says nothing, `status` says not working**
   Run `postwisp doctor` (config, token, owner, database checks),
   then `postwisp webhooks test telegram` for the Telegram path and
   `postwisp logs --tail 100` for the server-side error.
