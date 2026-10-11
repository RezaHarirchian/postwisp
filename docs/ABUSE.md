# Abuse reporting and operator runbook

postwisp is self-hosted: each instance is run by its own operator on their
own server, using their own email-provider account. This document explains
what counts as abuse, how to report it, and what the operator is expected to
do about it.

## Abuse contact

`abuse@postwisp.com`.

## What counts as abuse

Abuse is unwanted email **sent through** a postwisp instance:

- Spam: bulk unsolicited mail sent via the bot's compose/send functions.
- Phishing: mail impersonating a person or organization, or linking to
  credential-harvesting sites.
- Malware distribution via attachments.

postwisp is not a hosted service and has no multi-tenant admin panel, so
abuse always traces to one operator and one provider account. Reports about
mail that merely *arrived at* a postwisp instance (i.e. the reporter received
nothing from postwisp; the mail was inbound spam) are not postwisp abuse ·
filter it with the bot's blocklist and report the *sender* to their provider.

## How to report abuse

Send an email to `abuse@postwisp.com` including:

1. The full original message with headers (as an attachment or inline).
2. The date and time you received it (with timezone).
3. The `From` address and any `List-Unsubscribe` header.
4. A short description of why you consider it abusive.

Reports without headers are usually unactionable: the headers identify which
provider account and which postwisp instance sent the mail.

## Operator response runbook

postwisp instances are self-hosted, so enforcement sits with the operator.
If you receive an abuse report for your instance, follow this runbook:

1. **Acknowledge within 24 hours.** Reply to the reporter confirming receipt
   and a case identifier. A fast acknowledgment is what reporters and
   providers judge you on.
2. **Investigate via logs.** Find the send in the local database and logs:
   `postwisp logs --tail 200` and the `sent_log` table in
   `postwisp.db` (data dir, default `~/.local/share/postwisp`) show what was
   sent, when, to whom, and through which provider.
3. **Determine the cause.**
   - Compromised bot token or owner account: rotate the token with
     @BotFather, set the new one with `postwisp config set botToken`,
     invalidate pairing links with `postwisp pair --rotate`.
   - Compromised provider API key: rotate it in the provider dashboard, then
     `postwisp config set resendApiKey` (or the mailersend/mailgun key).
   - The operator themselves sent the mail: that is the abuse; stop.
4. **Suspend sending.** Until the cause is fixed, stop the service
   (`systemctl stop postwisp`) so no more mail can go out. Do not delete the
   logs or the database · they are the evidence.
5. **Notify the provider.** If the abuse went through Resend, MailerSend, or
   Mailgun, report the incident to them too; they may suspend the API key or
   domain on their side, and cooperating keeps your account in good standing.
6. **Report back.** Tell the original reporter what you found and what you
   did. Do not share secrets or internal details · the outcome and the
   corrective action are enough.
7. **Fix and re-verify.** Re-run `postwisp doctor`, rotate every credential
   that could have leaked, and confirm clean sending before restarting.

## Complaint handling (delivery webhooks)

Providers report recipient complaints (marked-as-spam, bounces) through
delivery webhooks. postwisp receives these as `DeliveryEvent`s of type
`complained` or `bounced`:

- Complaints are stored in the local database and surfaced to the owner ·
  high complaint or bounce rates are the earliest signal that an instance is
  being abused or has a list-quality problem.
- The owner should treat a spike in `complained` events the same as an abuse
  report: investigate via logs, identify the sends, and suspend if the
  pattern looks automated or non-consensual.
- Suppressed addresses are kept in the database's suppression list; the
  operator should honor provider-level suppression and not attempt to
  re-send to complaining recipients.

## If you are the operator, not the reporter

You are responsible for mail your instance sends. Keep API keys and the bot
token in the 0600 config file, rotate credentials on any suspicion of
exposure, and watch `postwisp logs` and complaint events for patterns you
did not initiate.
