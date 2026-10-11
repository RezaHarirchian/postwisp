// postwisp — self-hosted Telegram email manager
// Copyright (C) 2026 Reza Harirchian
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Every user-facing string lives here, in English. Keys are typed, so a
// misspelled key is a compile error, not a blank button at runtime.
export const STRINGS = {
  'bot.menu.compose': 'Compose',
  'bot.menu.inbox': 'Inbox',
  'bot.menu.sent': 'Sent',
  'bot.menu.search': 'Search',
  'bot.menu.stats': 'Stats',
  'bot.menu.settings': 'Settings',

  'bot.welcome.title': 'postwisp',
  'bot.welcome.body': 'Your email, in Telegram. Use the buttons below to manage it.',

  'bot.settings.title': 'Settings',
  'bot.settings.owner': 'Owner ID: {id}',
  'bot.settings.provider': 'Provider: {name}',
  'bot.settings.domains': 'Domains: {list}',
  'bot.settings.notConfigured': 'Not configured yet. Run the setup to connect everything.',
  'bot.settings.suppression': 'Suppression list',
  'bot.settings.data': 'Data & privacy',

  'bot.inbox.title': 'Inbox',
  'bot.inbox.empty': 'No emails here.',
  'bot.inbox.domainFilter': 'Domain: {domain}',
  'bot.inbox.domainPrompt': 'Choose a domain to filter the inbox:',
  'bot.inbox.domainAll': 'All domains',
  'bot.inbox.activeMark': '» {label}',
  'bot.inbox.listTitle': 'Inbox ({count})',
  'bot.inbox.item': '{date} — {from}: {subject}',

  'bot.sent.title': 'Sent',
  'bot.sent.empty': 'No sent emails yet.',
  'bot.sent.item': 'To: {to}\nSubject: {subject}\n{date} — {status}',

  'bot.search.prompt': 'Type what to search for. Operators: from:, subject:, has:attachment',
  'bot.search.noResults': 'Nothing found for "{query}".',
  'bot.search.resultsTitle': 'Results for "{query}" ({count})',
  'bot.search.resultItem': '{date} — {from}: {subject}',
  'bot.search.open': 'Open',

  'bot.notify.from': 'From: {from}',
  'bot.notify.subject': 'Subject: {subject}',
  'bot.notify.date': 'Date: {date}',
  'bot.notify.otpLine': 'One-time code: {codes}',
  'bot.notify.bodyCollapsed': 'Message is long. Tap Full text to read it all.',
  'bot.notify.fullText': 'Full text',
  'bot.notify.attachments': 'Attachments ({count})',
  'bot.notify.reply': 'Reply',
  'bot.notify.archive': 'Archive',

  'bot.email.openThread': 'Open thread',
  'bot.email.markRead': 'Mark read',
  'bot.email.markUnread': 'Mark unread',
  'bot.email.snooze1h': 'Snooze 1h',
  'bot.email.snooze1d': 'Snooze 1d',
  'bot.email.blockSender': 'Block sender',
  'bot.email.addRule': 'Archive rule',
  'bot.email.replyLater': 'Replying from the bot comes in a later phase.',
  'bot.email.attachmentsTitle': 'Attachments ({count})',
  'bot.email.attachmentItem': '{filename} ({size})',
  'bot.email.noAttachments': 'No attachments on this email.',
  'bot.email.attachmentTooLarge': '{filename} is larger than 20 MB and was skipped.',
  'bot.email.attachmentFailed': 'Could not download {filename}.',
  'bot.email.archived': 'Archived.',
  'bot.email.markedRead': 'Marked as read.',
  'bot.email.markedUnread': 'Marked as unread.',
  'bot.email.snoozed': 'Snoozed until {date}.',
  'bot.email.senderBlocked': 'Sender {address} blocked.',
  'bot.email.ruleAdded': 'Rule added: future mail from {from} about "{subject}" will be archived.',
  'bot.email.notFound': 'Email not found.',

  'bot.thread.title': 'Thread ({count})',
  'bot.thread.item': '{date} — {from}: {subject}',
  'bot.thread.open': 'Open',

  'bot.digest.title': '{count} new emails',
  'bot.digest.item': 'From: {from}\nSubject: {subject}',
  'bot.digest.open': 'Open',

  'bot.stats.title': 'Delivery stats',
  'bot.stats.empty': 'No sent emails yet.',
  'bot.stats.counts':
    'Sent: {sent} | Delivered: {delivered} | Bounced: {bounced} | Complaints: {complained}',
  'bot.stats.rates': 'Bounce rate: {bounceRate}% | Complaint rate: {complaintRate}%',
  'bot.stats.bounceWarn': 'Warning: bounce rate {rate}% is at or above 4%.',
  'bot.stats.complaintWarn': 'Warning: complaint rate {rate}% is at or above 0.08%.',

  'bot.delivery.statusLine': 'Delivery: {status}',
  'bot.delivery.bouncedSuppressed': '{to} bounced and was suppressed.',
  'bot.delivery.complaintSuppressed': '{to} filed a spam complaint and was suppressed.',

  'bot.rates.bounceAlert':
    'Bounce rate for {domain} is {rate}% (limit 4%). Pause sending on this domain until the list is clean: ' +
    'remove invalid addresses, confirm every recipient opted in, and review the suppression list. ' +
    'Bouncing addresses are suppressed automatically.',
  'bot.rates.complaintAlert':
    'Complaint rate for {domain} is {rate}% (limit 0.08%). Pause sending on this domain and check what ' +
    'triggered the complaints — usually unexpected or too-frequent mail. Complained addresses are suppressed automatically.',

  'bot.suppression.title': 'Suppression list',
  'bot.suppression.empty':
    'The suppression list is empty. Hard bounces, spam complaints and unsubscribes land here automatically; ' +
    'suppressed addresses never receive mail again unless you remove them.',
  'bot.suppression.item': '{email}\n{reason} — {date}',
  'bot.suppression.remove': 'Remove',
  'bot.suppression.removed': '{email} removed from the suppression list.',
  'bot.suppression.clear': 'Clear all',
  'bot.suppression.clearConfirm':
    'Remove all {count} addresses from the suppression list? They can receive mail again and bounce again afterwards.',
  'bot.suppression.cleared': 'Suppression list cleared.',
  'bot.suppression.confirmYes': 'Yes, clear it',

  'bot.data.title': 'Data & privacy',
  'bot.data.body':
    'Stored here: received emails, drafts, scheduled sends, the sent log, the suppression list and the consent audit log. ' +
    'Nothing leaves this machine.',
  'bot.data.auditLog': 'Consent audit log',
  'bot.data.wipe': 'Delete all data',
  'bot.data.wipeConfirm':
    'This deletes every stored email, draft, scheduled send, suppression entry, counter and log. ' +
    'The bot configuration (owner, tokens, domains) is kept. This cannot be undone.',
  'bot.data.wipeYes': 'Yes, delete everything',
  'bot.data.wiped': 'All stored data has been deleted.',
  'bot.data.unavailable': 'Data management is not available in this setup.',

  'bot.audit.title': 'Consent audit log',
  'bot.audit.empty': 'No consent events recorded yet.',
  'bot.audit.item': '{date} — {event}: {address} ({detail})',

  'bot.unsubscribe.oneClick': '{email} unsubscribed via the one-click link.',
  'bot.unsubscribe.stopReply': '{email} unsubscribed by replying STOP.',

  'bot.error.notOwner': 'This bot is private.',
  'bot.error.generic': 'Something went wrong. Please try again.',
  'bot.error.notConfigured': 'postwisp is not set up yet. Run `postwisp setup` first.',
  'bot.alert.webhookRejected':
    'Security: rejected a Resend webhook with a bad signature. If this was not you, check your webhook secret.',

  'cli.status.ok': 'postwisp is running.',
  'cli.status.notConfigured': 'postwisp is not configured. Run `postwisp setup` to begin.',
  'cli.status.configFile': 'config file',
  'cli.status.owner': 'owner',
  'cli.status.dataDir': 'data directory',
  'cli.status.notSet': 'not set',
  'cli.status.set': 'set',
  'cli.doctor.ok': 'ok',
  'cli.doctor.warn': 'warning',
  'cli.doctor.fail': 'fail',
  'cli.doctor.nodeVersion': 'Node.js version',
  'cli.doctor.configReadable': 'config file readable',
  'cli.doctor.dataDirWritable': 'data directory writable',
  'cli.doctor.ownerSet': 'owner configured',
  'cli.doctor.botTokenSet': 'bot token configured',
  'cli.doctor.fixSetup': 'Run `postwisp setup` to configure it.',
  'cli.menu.laterPhase': 'planned for a later phase',
  'cli.menu.choose': 'What would you like to do?',

  'bot.identity.none': 'No sending identities are configured yet. Add them in Settings first.',

  'bot.compose.title': 'Compose',
  'bot.compose.home': 'What would you like to do?',
  'bot.compose.new': 'New email',
  'bot.compose.back': 'Back',
  'bot.compose.chooseIdentity': 'Send from which address?',
  'bot.compose.promptTo': 'To? (comma-separated for several recipients)',
  'bot.compose.invalidTo': 'Not a valid address: {address}. Try again.',
  'bot.compose.promptSubject': 'Subject?',
  'bot.compose.promptBody': 'Body?',
  'bot.compose.promptReplyBody': 'Reply to {to} — write your message:',
  'bot.compose.attachQuestion': 'Attach a file, or skip?',
  'bot.compose.attach': 'Attach a file',
  'bot.compose.skip': 'Skip',
  'bot.compose.sendFile': 'Send the document now (max 20 MB).',
  'bot.compose.attachTooLarge': '{filename} is over 20 MB and was not attached.',
  'bot.compose.attachFailed': 'Could not read that file. Try again or skip.',
  'bot.compose.confirmTitle': 'Review before sending',
  'bot.compose.from': 'From: {identity}',
  'bot.compose.to': 'To: {to}',
  'bot.compose.subject': 'Subject: {subject}',
  'bot.compose.body': 'Body:',
  'bot.compose.send': 'Send',
  'bot.compose.drafts': 'Drafts',
  'bot.compose.scheduled': 'Scheduled',
  'bot.compose.templates': 'Templates',
  'bot.compose.useTemplate': 'Use template',
  'bot.compose.pickTemplate': 'Pick a template:',
  'bot.compose.noTemplates': 'No templates yet. Add one from the Templates screen first.',
  'bot.compose.saveDraft': 'Save draft',
  'bot.compose.schedule': 'Schedule',
  'bot.compose.cancel': 'Cancel',
  'bot.compose.cancelled': 'Discarded.',
  'bot.compose.sent': 'Sent to {to}.',
  'bot.compose.sendFailed': 'Sending failed: {reason}',
  'bot.compose.capsBlocked': 'Cannot send right now: {reason}',
  'bot.compose.bulkWarn':
    'Bulk send to {count} recipients. Bulk mail needs prior consent from every recipient, a working ' +
    'unsubscribe path (added automatically below), and a clean list: bounce rates over 4% or complaint ' +
    'rates over 0.08% get the domain blocklisted.',

  'bot.draft.title': 'Drafts',
  'bot.draft.empty': 'No drafts saved.',
  'bot.draft.item': 'To: {to}\nSubject: {subject}',
  'bot.draft.open': 'Open',
  'bot.draft.send': 'Send',
  'bot.draft.delete': 'Delete',
  'bot.draft.saved': 'Draft saved.',
  'bot.draft.deleted': 'Draft deleted.',
  'bot.draft.notFound': 'Draft not found.',

  'bot.schedule.title': 'Scheduled',
  'bot.schedule.empty': 'Nothing scheduled.',
  'bot.schedule.item': '{when}\nTo: {to} — {subject}',
  'bot.schedule.when': 'When should this go out?',
  'bot.schedule.in1h': 'In 1 hour',
  'bot.schedule.in3h': 'In 3 hours',
  'bot.schedule.tomorrow9': 'Tomorrow 9:00',
  'bot.schedule.custom': 'Custom time',
  'bot.schedule.promptCustom': 'Reply with the time as YYYY-MM-DD HH:MM in server time (the timezone where postwisp runs).',
  'bot.schedule.badTime': 'Could not read that. Use YYYY-MM-DD HH:MM.',
  'bot.schedule.past': 'That time is in the past.',
  'bot.schedule.tooFar': 'Scheduling is limited to 30 days ahead.',
  'bot.schedule.scheduled': 'Scheduled for {when}.',
  'bot.schedule.cancel': 'Cancel',
  'bot.schedule.cancelled': 'Scheduled send cancelled.',

  'bot.template.title': 'Templates',
  'bot.template.empty': 'No templates yet.',
  'bot.template.add': 'Add template',
  'bot.template.delete': 'Delete',
  'bot.template.deleted': 'Template deleted.',
  'bot.template.added': 'Template saved.',
  'bot.template.nameTaken': 'A template with that name already exists.',
  'bot.template.promptName': 'Name for the new template?',
  'bot.template.promptSubject': 'Subject for the template?',
  'bot.template.promptBody': 'Body for the template? (supports the to, date and subject variables)',

  'bot.autoreply.sent': 'Auto-replied to {address}.',
  'bot.autoreply.noIdentity': 'Auto-reply skipped: no sending identity is configured.',
  'bot.autoreply.noSender':
    'A rule wanted to auto-reply to {address} with:\n{reply}\n\nNo email provider is configured, so nothing was sent.',

  'bot.pair.notPrivate':
    'Pairing only works in a private chat with the bot. Open the pairing link in a 1:1 chat — never forward it to a group.',

  'bot.testmode.banner': 'TEST MODE is on. Sends still go out — use delivered@resend.dev to test safely.',
  'bot.testmode.toHint': 'Test mode is on: send to delivered@resend.dev.',
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(key: StringKey, params: Record<string, string | number> = {}): string {
  // The typed key guarantees validity at compile time; the fallback keeps
  // plain-JS callers from crashing on a typo at runtime.
  let out: string = (STRINGS as Record<string, string>)[key] ?? key;
  for (const [name, value] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  return out;
}

// Lists the placeholder names inside a template, e.g. ['id'] for 'Owner: {id}'.
export function placeholders(template: string): string[] {
  const found: string[] = [];
  const re = /\{([a-zA-Z0-9_]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const name = match[1] as string;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}
