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

import type { Logger } from '../core/logger.js';
import type { Store, SentLog } from '../core/store.js';
import { t } from '../core/i18n.js';
import type { SendInput } from '../providers/interface.js';
import type { DeliveryEvent } from '../server/resend-webhook.js';
import type { SendQueue } from './queue.js';
import { escapeHtml, formatDateUtc, truncate } from './views.js';

// Provider reputation thresholds: a domain that crosses them lands on
// blocklists. The owner gets one warning per domain per metric until the
// rate recovers; the flags live in kv next to the other counters.
const BOUNCE_RATE_LIMIT = 4;
const COMPLAINT_RATE_LIMIT = 0.08;
// Rolling window over the sent log; rows still waiting for a delivery
// event ('sent') are excluded so young sends cannot skew the rate.
const RATE_WINDOW = 200;
const MIN_DECIDED_SAMPLES = 10;

function rateAlertKey(metric: 'bounce' | 'complaint', domain: string): string {
  return `rate_alert:${metric}:${domain.toLowerCase()}`;
}

function alertIfNeeded(
  deps: DeliveryDeps,
  metric: 'bounce' | 'complaint',
  domain: string,
  rate: number,
  limit: number,
  text: string,
): void {
  const key = rateAlertKey(metric, domain);
  const alerted = deps.store.get(key);
  if (rate >= limit) {
    // Warn once: a sustained bad rate must not become a message per event.
    if (alerted === null || alerted === '') {
      deps.store.set(key, String(Date.now()));
      notifyOwner(deps, text);
    }
  } else if (alerted !== null && alerted !== '') {
    // Recovered: the next spike warns again.
    deps.store.set(key, '');
  }
}

// Recomputes the rolling bounce/complaint rates for the domain after every
// delivery event and warns the owner with the exact fix when a threshold
// is crossed.
function checkRateAlerts(deps: DeliveryDeps, domain: string): void {
  if (!domain) return;
  const decided = deps.store
    .listSentLog({ domain, limit: RATE_WINDOW })
    .filter((r) => r.status !== 'sent');
  if (decided.length < MIN_DECIDED_SAMPLES) return;
  const bounceRate = (decided.filter((r) => r.status === 'bounced').length / decided.length) * 100;
  const complaintRate =
    (decided.filter((r) => r.status === 'complained').length / decided.length) * 100;
  const fmt = (n: number): string => n.toFixed(2);
  alertIfNeeded(
    deps,
    'bounce',
    domain,
    bounceRate,
    BOUNCE_RATE_LIMIT,
    t('bot.rates.bounceAlert', { domain: escapeHtml(domain), rate: fmt(bounceRate) }),
  );
  alertIfNeeded(
    deps,
    'complaint',
    domain,
    complaintRate,
    COMPLAINT_RATE_LIMIT,
    t('bot.rates.complaintAlert', { domain: escapeHtml(domain), rate: fmt(complaintRate) }),
  );
}

// Build a SendInput that continues an existing thread. The subject keeps a
// single "Re:" prefix (never "Re: Re:") and the threading headers chain
// through In-Reply-To and References, so mail clients group the messages.
// Headers are keyed lowercase, matching the normalized inbound shape.
export function buildReplyInput(
  orig: { subject: string; headers: Record<string, string>; from: string },
  body: string,
  identity: string,
): SendInput {
  const subject = /^re:/i.test(orig.subject.trim()) ? orig.subject : `Re: ${orig.subject}`;
  const messageId = orig.headers['message-id']?.trim();
  const priorReferences = orig.headers['references']?.trim();
  const headers: Record<string, string> = {};
  if (messageId) {
    headers['In-Reply-To'] = messageId;
    headers['References'] = priorReferences ? `${priorReferences} ${messageId}` : messageId;
  }
  return {
    from: identity,
    to: [orig.from],
    subject,
    text: body,
    headers,
  };
}

export interface DeliveryDeps {
  store: Store;
  logger: Logger;
  // Narrow surface on the Telegram API: only the edit we need.
  api: { editMessageText(chatId: number, messageId: number, text: string): Promise<void> };
  queue: SendQueue | null;
  ownerId: number | null;
}

// Maps a provider delivery event onto the sent log and the chat message
// that confirmed the send. Bounces and complaints also suppress the address
// and notify the owner, because one bad address can drag the whole domain's
// reputation down.
export function createDeliveryHandler(deps: DeliveryDeps): {
  handleDelivery(ev: DeliveryEvent): Promise<void>;
} {
  return {
    async handleDelivery(ev: DeliveryEvent): Promise<void> {
      const sent = deps.store.getSentByProviderId(ev.emailId);
      if (!sent) {
        // Not a message we logged; ack the webhook and move on.
        deps.logger.debug('delivery event for unknown email', {
          emailId: ev.emailId,
          type: ev.type,
        });
        return;
      }

      deps.store.updateSentStatus(ev.emailId, ev.type);
      checkRateAlerts(deps, sent.domain);

      if (sent.chatId !== null && sent.messageId !== null) {
        try {
          await deps.api.editMessageText(sent.chatId, sent.messageId, deliveryText(sent, ev.type));
        } catch (err) {
          // The status is already recorded; a stale message is cosmetic.
          deps.logger.warn('failed to edit sent message with delivery status', {
            emailId: ev.emailId,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (ev.type === 'bounced') {
        // Resend's bounce payload does not reliably distinguish soft from
        // hard in this wiring, so every bounce is treated as hard: an
        // address that keeps bouncing would only damage the domain.
        // sent.to is comma-joined; suppress each address on its own, since
        // the joined string would never match a later recipient.
        for (const addr of sent.to.split(',')) {
          const trimmed = addr.trim();
          if (trimmed.length > 0) {
            deps.store.suppressAddress(trimmed, 'hard bounce');
            deps.store.logConsent('suppress', trimmed, 'hard bounce');
          }
        }
        notifyOwner(deps, t('bot.delivery.bouncedSuppressed', { to: escapeHtml(sent.to) }));
      } else if (ev.type === 'complained') {
        for (const addr of sent.to.split(',')) {
          const trimmed = addr.trim();
          if (trimmed.length > 0) {
            deps.store.suppressAddress(trimmed, 'complaint');
            deps.store.logConsent('suppress', trimmed, 'complaint');
          }
        }
        notifyOwner(deps, t('bot.delivery.complaintSuppressed', { to: escapeHtml(sent.to) }));
      }
    },
  };
}

// Rebuilds the sent-confirmation line from the log record and appends the
// delivery outcome. Everything dynamic is HTML-escaped for the edit call.
function deliveryText(sent: SentLog, type: DeliveryEvent['type']): string {
  const head = t('bot.sent.item', {
    to: escapeHtml(sent.to),
    subject: escapeHtml(truncate(sent.subject, 200)),
    date: formatDateUtc(sent.sentAtMs),
    status: escapeHtml(type),
  });
  const statusLine = t('bot.delivery.statusLine', { status: escapeHtml(type) });
  return truncate(`${head}\n${statusLine}`, 4000);
}

function notifyOwner(deps: DeliveryDeps, text: string): void {
  if (deps.queue === null || deps.ownerId === null) return;
  deps.queue.enqueue(deps.ownerId, {
    text,
    extra: { parseMode: 'HTML', protectContent: true },
  });
}
