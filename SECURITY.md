# Security

postwisp is self-hosted software. You run it on your own server, for one
owner, with your own provider accounts. This document states what the code
protects, what it does not, and how to report vulnerabilities.

## Threat model

- One server, one operator, one Telegram owner. postwisp is not a
  multi-tenant service; there is no notion of other users to isolate from.
- Attackers are remote: forged provider webhooks, messages from non-owner
  Telegram accounts, local users on a shared machine reading files.
- The operator is trusted: if someone has root on the server, they can read
  the database, the config, and the mail. Physical and OS-level security of
  the host is the operator's job.

## What is protected

- **Owner guard.** A middleware in the bot rejects every update that is not
  from the paired owner. No command, button, or inline query does anything
  for anyone else. Pairing links are one-time and invalidate after use;
  `postwisp pair --rotate` invalidates a printed link and issues a new one.
- **Webhook signatures.** Inbound provider webhooks are verified against the
  provider-issued signing secret (`POSTWISP_WEBHOOK_SECRET`) before any
  payload is processed; unverifiable payloads are rejected and the rejection
  is logged. Webhook secrets must be provider-issued · the wizard only asks
  you to paste the secret from the provider's dashboard and never generates
  one, because a locally generated value could never verify a real webhook
  (it cannot check the origin of a pasted value, so keep the dashboard as
  the source of truth).
- **Cloudflare ingest auth.** The Cloudflare ingest route only exists when
  `POSTWISP_CF_INGEST_SECRET` is set, and every POST to it must carry the
  shared secret. Unset means the route is disabled; there is no unsigned
  fallback.
- **Telegram webhook secret.** In webhook mode, updates are checked against
  the secret Telegram sends in a header; mismatches are rejected.
- **0600 secrets.** The config file (`~/.config/postwisp/config.json`) is
  created with mode 0600 and re-enforced on every write. `postwisp doctor`
  fails loudly if the mode is anything else.
- **No secret logging.** Logs go through a redaction layer: bot tokens, API
  keys, webhook secrets, ingest secrets, and any configured secret are
  replaced with `[redacted]` before they reach a log line. `postwisp logs`
  and `postwisp config get` never print a secret value.
- **SSRF guard on attachment downloads.** Attachment bytes are fetched only
  from the provider's own hosts (Resend: `*.resend.com`, `*.amazonaws.com`;
  MailerSend: `*.mailersend.com`; Mailgun: `*.mailgun.net`). Any other host
  is refused. Attachment URLs are never shown to the Telegram user · only
  the downloaded file is forwarded.

## What is NOT protected

- **Physical server access.** The database and config sit on your disk in
  plain form. Disk encryption, OS hardening, and access control are the
  operator's responsibility.
- **No end-to-end encryption.** Mail is stored in a local SQLite database in
  cleartext. Telegram itself, and anyone with access to the server, can read
  your mail. postwisp does not promise confidentiality against Telegram or
  the host operator.
- **Provider and Telegram transport.** TLS protects mail in transit to and
  from the providers and Telegram, but postwisp cannot verify what those
  parties do with your data. Read their policies.
- **MailerSend webhook replays.** MailerSend's webhook signature scheme
  carries no timestamp, so there is no replay window to enforce. A
  captured MailerSend webhook payload replayed after its dedupe entry
  expires verifies as genuine and is processed again. This is accepted
  residual risk: the signature scheme cannot provide timestamps. The
  dedupe store is the only replay protection on that path.

## Reporting a vulnerability

Email `security@postwisp.com` with a description, the affected version, and
steps to reproduce. We acknowledge reports within 48 hours and keep you
informed until a fix is released.

Please do not open a public GitHub issue for a vulnerability until a fix is
available.

## Supported versions

| Version | Status                                   |
|---------|------------------------------------------|
| 0.2.x   | Supported while in active development    |

Only the latest release receives security fixes. `postwisp update` keeps an
install current.
