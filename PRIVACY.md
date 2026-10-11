# Privacy

postwisp is a self-hosted bot. There is no postwisp account, no hosted
service, and no company server that ever sees your data. Everything the bot
touches lives on the operator's own machine.

## What is stored

All of the following live on the operator's server and nowhere else:

- **Emails** · inbound and outbound mail bodies, metadata, and attachments,
  in a local SQLite database (`postwisp.db` in the data dir,
  `~/.local/share/postwisp` by default).
- **Key-value state** · pairing tokens, bot settings, suppression lists,
  rules, and blocklists, in the same database.
- **Logs** · operational logs on stdout and, optionally, in a log file
  (`POSTWISP_LOG_FILE`). Secrets are redacted from every log line.
- **Config** · `~/.config/postwisp/config.json`, mode 0600, holding API keys,
  tokens, and secrets.

## What is NOT collected

- **No telemetry.** postwisp sends no usage data, crash reports, or analytics
  anywhere. There is no code path that phones home; the only outbound
  connections are to Telegram, the configured email provider, and (for
  updates) the npm registry.
- **No accounts.** There is no sign-up, no postwisp identity, and nothing to
  log in to except your own Telegram bot.
- **No tracking.** No cookies, no fingerprints, no behavioral profiling.

Third parties involved in operating a postwisp instance · Telegram, the email
provider, Cloudflare · collect and retain data under their own policies.
postwisp cannot control what they keep.

## Data retention

postwisp keeps what it stores until the operator deletes it. Mail stays in the
database indefinitely; there is no automatic expiry. Logs rotate only if the
operator configures log rotation on the log file.

## Your right to delete

The operator (who is also the only data subject in a normal install) can
delete everything:

```sh
# stop the service first, then:
rm -rf ~/.local/share/postwisp     # the database: all mail, drafts, scheduled sends, settings
rm -rf ~/.config/postwisp          # config with API keys and secrets
rm -f  /var/log/postwisp/*.log    # logs, if configured
```

If log data also reached stdout of a service manager (systemd journal,
Docker logs), purge those too.

Self-service wipe: Settings → Data & privacy → Delete all data (double
confirmation). It wipes every user-data row in the database and truncates
the log file. The config file (`~/.config/postwisp`, API keys and secrets)
is not touched by the button · remove it manually with the commands above
if you are decommissioning the install.

GDPR Art. 17 note: in a single-operator install the operator and the data
subject are the same person, so deletion is a local file operation. If you
run postwisp in a way where other people's mail passes through it, you are
the data controller for that data and must handle erasure requests yourself.

## Contact

Questions about data handling: `security@postwisp.com`.
