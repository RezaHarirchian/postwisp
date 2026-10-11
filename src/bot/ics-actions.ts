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

// Answers a calendar invite from the email view's Accept/Decline buttons.
// The reply is a real METHOD:REPLY iCalendar payload addressed to the
// organizer, sent through the provider like any other outbound mail (caps
// checked, sent-log recorded).

import type { Context } from 'grammy';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import type { SendInput, SendResult } from '../providers/interface.js';
import { t } from '../core/i18n.js';
import { escapeHtml } from './views.js';
import { buildIcsResponse, findIcsInEmail, parseIcs, type IcsPartStat } from '../core/ics.js';
import { listIdentities, loadCaps } from '../core/templates.js';
import type { AttachmentFetch } from './index.js';

export interface IcsActionDeps {
  store: Store;
  logger: Logger;
  ownerId: number | null;
  domains: string[];
  sendEmail: (input: SendInput) => Promise<SendResult>;
  // Resolves attachment bytes for invites that arrived as text/calendar
  // files rather than inline text.
  downloadAttachment?: (emailId: string, attachmentId: string) => Promise<AttachmentFetch>;
}

async function resolveIcsText(
  deps: IcsActionDeps,
  emailId: string,
  bodyText: string | null | undefined,
  attachments: Array<{ id: string; filename: string; mime: string }> | undefined,
): Promise<string | null> {
  const source = findIcsInEmail({ bodyText, attachments });
  if (!source) return null;
  if (source.kind === 'body') return source.icsText;
  if (!deps.downloadAttachment) return null;
  let fetched: AttachmentFetch;
  try {
    fetched = await deps.downloadAttachment(emailId, source.attachmentId);
  } catch {
    return null;
  }
  if (!fetched.ok) return null;
  return fetched.data.toString('utf8');
}

export async function handleIcsResponse(
  ctx: Context,
  deps: IcsActionDeps,
  emailId: string,
  partStat: IcsPartStat,
): Promise<void> {
  const meta = deps.store.getEmailMeta(emailId);
  if (!meta) {
    await ctx.reply(t('bot.email.notFound'));
    return;
  }
  const icsText = await resolveIcsText(deps, emailId, meta.bodyText, meta.attachments);
  const event = icsText ? parseIcs(icsText) : null;
  if (!event) {
    await ctx.reply(t('bot.ics.failed', { reason: 'invite not found' }));
    return;
  }
  // Answer from an identity on the organizer's domain when one exists, so
  // the reply comes from the address that was invited.
  const identities = listIdentities(deps.store, deps.domains);
  const organizerDomain = event.organizer?.email.split('@')[1]?.toLowerCase();
  const attendee =
    (organizerDomain
      ? identities.find((id) => id.split('@')[1]?.toLowerCase() === organizerDomain)
      : undefined) ?? identities[0];
  if (!attendee) {
    await ctx.reply(t('bot.identity.none'));
    return;
  }
  const toAddr = event.organizer?.email ?? meta.fromAddr;
  const accepted = partStat === 'ACCEPTED';
  let caps;
  try {
    caps = await loadCaps();
  } catch (err) {
    deps.logger.error('ics reply blocked: send-cap module failed to load', {
      emailId,
      detail: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(t('bot.compose.capsBlocked', { reason: 'send-limit check unavailable' }));
    return;
  }
  const check = caps.checkSendCaps(deps.store, [toAddr]);
  if (!check.ok) {
    await ctx.reply(t('bot.compose.capsBlocked', { reason: check.reason }));
    return;
  }
  const icsReply = buildIcsResponse(event, attendee, partStat);
  const subject = accepted
    ? t('bot.ics.replyAccepted', { summary: event.summary })
    : t('bot.ics.replyDeclined', { summary: event.summary });
  const body = accepted
    ? t('bot.ics.bodyAccepted', { summary: event.summary })
    : t('bot.ics.bodyDeclined', { summary: event.summary });
  let providerId: string;
  try {
    const result = await deps.sendEmail({
      from: attendee,
      to: [toAddr],
      subject,
      text: body,
      attachments: [{ filename: 'invite.ics', content: Buffer.from(icsReply, 'utf8'), mime: 'text/calendar' }],
      // Stable per email and verdict: a retried tap resumes the send.
      idempotencyKey: `postwisp-ics-${emailId}-${partStat}`,
    });
    providerId = result.id;
  } catch (err) {
    await ctx.reply(t('bot.compose.sendFailed', { reason: err instanceof Error ? err.message : String(err) }));
    return;
  }
  deps.store.logSent({
    providerId,
    to: toAddr,
    subject,
    domain: attendee.split('@')[1] ?? '',
    chatId: deps.ownerId,
    messageId: null,
  });
  caps.recordSent(deps.store, [toAddr]);
  await ctx.reply(
    accepted
      ? t('bot.ics.accepted', { summary: escapeHtml(event.summary) })
      : t('bot.ics.declined', { summary: escapeHtml(event.summary) }),
    { parse_mode: 'HTML' },
  );
}
