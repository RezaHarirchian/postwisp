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

import { createHash } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import type { EmailEvent, SendInput, SendResult } from '../providers/interface.js';
import { evaluateRules, isBlocked, extractOtp } from '../core/inbox.js';
import { buildNotification } from './notify.js';
import { isQuietNow, queueDigest } from './digest.js';
import type { SendQueue } from './queue.js';
import { toEventLike } from './store-adapter.js';
import { escapeHtml } from './views.js';
import { t } from '../core/i18n.js';
import { listIdentities, loadCaps, type CapsApi } from '../core/templates.js';
import { isStopReply } from '../core/unsubscribe.js';

export interface InboundDeps {
  store: Store;
  logger: Logger;
  queue: SendQueue | null;
  ownerId: number | null;
  // When present, matched auto-reply rules actually send instead of only
  // notifying the owner that a rule wanted to reply.
  sendEmail?: (input: SendInput) => Promise<SendResult>;
}

// Picks the From address for an auto-reply: the first identity on the
// email's own domain, falling back to the first identity at all.
function identityForDomain(store: Store, domain: string): string | undefined {
  const identities = listIdentities(store, []);
  const lower = domain.toLowerCase();
  return (
    identities.find((id) => id.split('@')[1]?.toLowerCase() === lower) ?? identities[0]
  );
}

// Stable per-email identity for cross-endpoint dedupe: the RFC 5322
// Message-ID when a provider preserved it, else a hash of the
// delivery-stable fields. Two ingest endpoints (e.g. the Resend webhook
// and the Cloudflare worker) see the same email under different provider
// event ids, so the provider event id cannot serve this purpose.
export function inboundStableId(ev: EmailEvent): string {
  const mid = ev.headers['message-id']?.trim();
  if (mid) return `mid:${mid}`;
  const h = createHash('sha256');
  for (const part of [
    ev.domain,
    ev.from.address,
    ev.subject,
    String(ev.dateMs),
    ev.bodyText ?? '',
    ev.snippet,
  ]) {
    h.update(part);
    h.update('\0');
  }
  return `hash:${h.digest('hex')}`;
}

// Sends the auto-reply for a matched rule, then tells the owner in one
// line. A failed send is logged and surfaced; the rule never fires twice
// for the same email because the handler dedupes on inboundStableId
// before this runs, and the idempotency key below is stable per email.
async function sendAutoreply(deps: InboundDeps, ev: EmailEvent, text: string): Promise<void> {
  const { store, logger, queue, ownerId } = deps;
  const sendEmail = deps.sendEmail;
  if (queue === null || ownerId === null || sendEmail === undefined) return;

  const identity = identityForDomain(store, ev.domain);
  if (!identity) {
    logger.warn('autoreply skipped: no sending identity configured', { emailId: ev.id });
    queue.enqueue(ownerId, { text: t('bot.autoreply.noIdentity') });
    return;
  }
  const to = [ev.from.address];
  let caps: CapsApi;
  try {
    caps = await loadCaps();
  } catch (err) {
    // Fail closed: without the cap module the reply would go out uncapped.
    logger.error('autoreply blocked: send-cap module failed to load', {
      emailId: ev.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    queue.enqueue(ownerId, { text: t('bot.compose.capsBlocked', { reason: 'send-limit check unavailable' }) });
    return;
  }
  const check = caps.checkSendCaps(store, to);
  if (!check.ok) {
    logger.warn('autoreply blocked by send caps', { emailId: ev.id, reason: check.reason });
    queue.enqueue(ownerId, { text: t('bot.compose.capsBlocked', { reason: check.reason }) });
    return;
  }
  const subject = `Re: ${ev.subject}`;
  try {
    const result = await sendEmail({
      from: identity,
      to,
      subject,
      text,
      idempotencyKey: `postwisp-autoreply:${inboundStableId(ev)}`,
    });
    store.logSent({
      providerId: result.id,
      to: ev.from.address,
      subject,
      domain: ev.domain,
      chatId: ownerId,
      messageId: null,
    });
    caps.recordSent(store, to);
    logger.info('autoreply sent', { emailId: ev.id, providerId: result.id });
    queue.enqueue(ownerId, { text: t('bot.autoreply.sent', { address: ev.from.address }) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.error('autoreply send failed', { emailId: ev.id, reason });
    queue.enqueue(ownerId, { text: t('bot.compose.sendFailed', { reason }) });
  }
}

// One place where a normalized inbound email becomes storage, rules,
// and (maybe) a Telegram notification. Order matters: persist first so a
// crash after this point never loses mail; notify last.
export function createInboundHandler(deps: InboundDeps): {
  handleEmailEvent(ev: EmailEvent): Promise<void>;
} {
  const { store, logger, queue, ownerId } = deps;

  return {
    async handleEmailEvent(ev: EmailEvent): Promise<void> {
      store.saveFullEmail(toEventLike(ev));

      // Cross-endpoint dedupe: the same email can arrive via two ingest
      // endpoints under different provider event ids, and each endpoint
      // only dedupes its own. Gate here, on the stable inbound id, before
      // any notification or auto-reply side effect. The email is persisted
      // above first, so a crash between the two never loses mail.
      if (!store.noteWebhookEvent(`postwisp-inbound:${inboundStableId(ev)}`)) {
        logger.info('duplicate inbound email skipped', { emailId: ev.id });
        return;
      }

      // A bare "STOP" reply is an unsubscribe request, not mail: suppress
      // the sender, log the consent event, and tell the owner. The email
      // itself stays stored above, so nothing is lost.
      if (isStopReply(ev.bodyText)) {
        store.suppressAddress(ev.from.address, 'STOP reply');
        store.logConsent('unsubscribe', ev.from.address, 'STOP reply');
        logger.info('address unsubscribed via STOP reply', { emailId: ev.id });
        if (queue !== null && ownerId !== null) {
          queue.enqueue(ownerId, {
            text: t('bot.unsubscribe.stopReply', { email: escapeHtml(ev.from.address) }),
            extra: { parseMode: 'HTML', protectContent: true },
          });
        }
        return;
      }

      const outcome = evaluateRules(store, { from: ev.from.address, subject: ev.subject });
      const meta = store.getEmailMeta(ev.id);
      if (meta) {
        const labels = [...new Set([...meta.labels, ...outcome.labels])];
        store.saveEmailMeta({ ...meta, labels, archived: meta.archived || outcome.archive });
      }

      if (isBlocked(store, ev.from.address)) {
        logger.info('inbound email from blocked sender skipped', { emailId: ev.id });
        return;
      }
      if (outcome.silent) return;

      if (queue === null || ownerId === null) {
        logger.warn('email saved but not notified: telegram queue unavailable', {
          emailId: ev.id,
        });
        return;
      }

      if (outcome.autoreply !== null) {
        if (deps.sendEmail === undefined) {
          // No provider wired: the owner sees that a rule fired instead of silence.
          logger.info('autoreply rule matched but no sender is configured', {
            emailId: ev.id,
          });
          queue.enqueue(ownerId, {
            text: t('bot.autoreply.noSender', {
              address: escapeHtml(ev.from.address),
              reply: escapeHtml(outcome.autoreply),
            }),
          });
        } else {
          await sendAutoreply(deps, ev, outcome.autoreply);
        }
      }

      const quietStart = store.get('quiet_start');
      const quietEnd = store.get('quiet_end');
      const digestMode = store.get('digest_mode') ?? 'off';
      const quiet =
        quietStart !== null && quietEnd !== null && isQuietNow(new Date(), quietStart, quietEnd);
      if (quiet || digestMode !== 'off') {
        queueDigest(store, ev.id);
        return;
      }

      const notif = buildNotification(ev, { extractOtp });
      queue.enqueue(ownerId, {
        text: notif.text,
        extra: {
          replyMarkup: notif.replyMarkup,
          parseMode: notif.parseMode,
          protectContent: notif.protectContent,
        },
      });
    },
  };
}
