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

import type { FastifyInstance } from 'fastify';
import type { Logger } from '../core/logger.js';
import { t } from '../core/i18n.js';
import type { EmailEvent, EmailProvider, DeliveryEvent } from '../providers/interface.js';
import { normalizeResendInbound } from '../providers/normalize.js';

export interface ResendWebhookDeps {
  provider: EmailProvider;
  secret: string;
  // Resend retries reuse the svix-id. hasWebhookEvent is the fast-path
  // pre-check; noteWebhookEvent is the atomic insert-if-absent claim made
  // BEFORE the handler runs. A false claim means another delivery holds
  // the id, so this one is skipped as a duplicate.
  hasWebhookEvent: (id: string) => boolean;
  noteWebhookEvent: (id: string) => boolean;
  onEvent: (event: EmailEvent) => Promise<void>;
  // Delivery outcomes for messages we sent. Carries no content, only the
  // provider id the sent log was keyed on; the bot layer maps it to a
  // sent-log row and updates the chat message.
  onDelivery?: (event: DeliveryEvent) => Promise<void>;
  // Called on rejected webhooks (bad signature). The wiring throttles these
  // so a probing attacker cannot turn them into notification spam.
  onSecurityAlert?: (text: string) => void;
  logger: Logger;
}

// The delivery-event shape lives in the frozen provider contract
// (providers/interface.ts) so every provider's webhook route normalizes to
// the same type; re-exported here so existing imports keep working.
export type { DeliveryEvent };

// Transport only: verify, dedupe, fetch, normalize, hand off.
// Product logic lives in the bot layer; the signing secret and the raw
// payload never reach a log line.
export function registerResendWebhook(app: FastifyInstance, deps: ResendWebhookDeps): void {
  // Scoped registration so the raw-body parser applies to this route only
  // and every other route keeps Fastify's default JSON handling.
  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scoped.post('/webhooks/resend', async (request, reply) => {
      const rawBody = request.body as Buffer;
      const svixId = headerValue(request.headers['svix-id']);

      const verified = deps.provider.verifyWebhook(rawBody, request.headers, deps.secret);
      if (!verified.ok) {
        deps.logger.warn('resend webhook rejected', { reason: verified.reason });
        deps.onSecurityAlert?.(t('bot.alert.webhookRejected'));
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      // Fast path for Resend retries, which reuse the svix-id: skip events
      // already seen. Not the correctness mechanism — the atomic claim
      // before the handler below is.
      if (svixId && deps.hasWebhookEvent(svixId)) {
        deps.logger.info('resend webhook duplicate skipped', {});
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      let envelope: { type?: unknown; data?: unknown };
      try {
        envelope = JSON.parse(rawBody.toString('utf8')) as { type?: unknown; data?: unknown };
      } catch {
        deps.logger.warn('resend webhook had invalid json', {});
        return reply.code(400).send({ ok: false, error: 'invalid payload' });
      }

      if (envelope.type !== 'email.received' && !deliveryEventType(envelope.type)) {
        deps.logger.info('resend webhook ignored event', { type: String(envelope.type ?? 'unknown') });
        return reply.code(200).send({ ok: true });
      }

      if (deliveryEventType(envelope.type)) {
        const data = (envelope.data ?? {}) as Record<string, unknown>;
        const emailId = typeof data['email_id'] === 'string' ? data['email_id'] : '';
        if (!emailId) {
          deps.logger.warn('resend webhook delivery event missing email_id', {});
          return reply.code(400).send({ ok: false, error: 'invalid payload' });
        }

        // Atomic claim BEFORE the handler: insert-if-absent, so a concurrent
        // second delivery cannot pass while this one runs. A claimed but
        // crashed handler is not retried — a poisoned event must not wedge
        // Resend's retry queue behind it.
        if (svixId && !deps.noteWebhookEvent(svixId)) {
          deps.logger.info('resend webhook duplicate skipped', {});
          return reply.code(200).send({ ok: true, duplicate: true });
        }

        await deps.onDelivery?.({ type: deliveryEventType(envelope.type)!, emailId });

        deps.logger.info('resend webhook delivery event processed', {
          emailId,
          type: String(envelope.type),
        });
        return reply.code(200).send({ ok: true });
      }

      const data = (envelope.data ?? {}) as Record<string, unknown>;
      const emailId = typeof data['email_id'] === 'string' ? data['email_id'] : '';
      if (!emailId) {
        deps.logger.warn('resend webhook missing email_id', {});
        return reply.code(400).send({ ok: false, error: 'invalid payload' });
      }

      // Full body + attachments come from the API; the webhook carries
      // metadata only, by Resend's design.
      const inbound = await deps.provider.getInboundEmail(emailId);
      const event = normalizeResendInbound(inbound);

      // Atomic claim BEFORE the handler: insert-if-absent, so two
      // concurrent deliveries of the same event cannot both be processed
      // (the fast-path pre-check above cannot see a concurrent claim).
      if (svixId && !deps.noteWebhookEvent(svixId)) {
        deps.logger.info('resend webhook duplicate skipped', {});
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      await deps.onEvent(event);

      deps.logger.info('resend webhook processed', { emailId });
      return reply.code(200).send({ ok: true });
    });
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Maps Resend's delivery event types to the shared DeliveryEvent shape.
// Exported for the provider contract tests. Resend's delivery events carry
// metadata only, so the route never touches the provider API for them;
// the payload's email_id is all the bot needs. Types with no delivery
// equivalent return undefined and are ignored by the route.
export function deliveryEventType(type: unknown): DeliveryEvent['type'] | undefined {
  switch (type) {
    case 'email.delivered':
      return 'delivered';
    case 'email.bounced':
      return 'bounced';
    case 'email.complained':
      return 'complained';
    case 'email.failed':
      return 'failed';
    default:
      return undefined;
  }
}
