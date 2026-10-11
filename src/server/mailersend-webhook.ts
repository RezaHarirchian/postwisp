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
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../core/logger.js';
import { t } from '../core/i18n.js';
import type { Store } from '../core/store.js';
import type { DeliveryEvent, EmailEvent, EmailProvider } from '../providers/interface.js';
import {
  isMailerSendInboundPayload,
  parseMailerSendDeliveryEvent,
  parseMailerSendInbound,
} from '../providers/mailersend.js';
import { stashInlineAttachments } from './attachment-stash.js';

export interface MailerSendWebhookDeps {
  provider: EmailProvider;
  secret: string;
  // MailerSend activity events carry no dedupe id, so the route falls back
  // to a hash of the raw body. hasWebhookEvent is the fast-path pre-check;
  // noteWebhookEvent is the atomic insert-if-absent claim made BEFORE the
  // handler runs. A false claim means another delivery holds the id.
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
  // Inline attachment bytes from inbound forwards are stashed here for the
  // bot's download seam.
  store: Store;
}

// One route serves both MailerSend post types: inbound-route forwards carry
// the full parsed message (normalized directly, no API fetch needed), and
// activity webhooks carry delivery outcomes. Both are signed with the same
// `Signature` scheme. Transport only: verify, dedupe, normalize, hand off.
// Product logic lives in the bot layer; the signing secret and the raw
// payload never reach a log line.
export function registerMailerSendWebhook(app: FastifyInstance, deps: MailerSendWebhookDeps): void {
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

    scoped.post(
      '/webhooks/mailersend',
      {
        // Inbound forwards can carry attachments inline as base64; the
        // default 1MB body limit would reject legitimate mail.
        bodyLimit: 24 * 1024 * 1024,
      },
      async (request, reply) => {
        const rawBody = request.body as Buffer;
        if (!Buffer.isBuffer(rawBody)) {
          deps.logger.warn('mailersend webhook had non-json body', {});
          return reply.code(400).send({ ok: false, error: 'invalid payload' });
        }

        const verified = deps.provider.verifyWebhook(rawBody, request.headers, deps.secret);
        if (!verified.ok) {
          deps.logger.warn('mailersend webhook rejected', { reason: verified.reason });
          deps.onSecurityAlert?.(t('bot.alert.webhookRejected'));
          return reply.code(401).send({ ok: false, error: 'unauthorized' });
        }

        let envelope: Record<string, unknown>;
        try {
          envelope = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
        } catch {
          deps.logger.warn('mailersend webhook had invalid json', {});
          return reply.code(400).send({ ok: false, error: 'invalid payload' });
        }

        const type = typeof envelope['type'] === 'string' ? envelope['type'] : '';

        // The ping MailerSend sends when the webhook is created. Verified
        // above; nothing to do.
        if (type === 'webhook.test') {
          return reply.code(200).send({ ok: true });
        }

        const delivery = parseMailerSendDeliveryEvent(envelope);
        if (delivery) {
          if (!delivery.emailId) {
            deps.logger.warn('mailersend webhook delivery event missing message id', {});
            return reply.code(400).send({ ok: false, error: 'invalid payload' });
          }
          const dedupeId = createHash('sha256').update(rawBody).digest('hex');
          if (deps.hasWebhookEvent(dedupeId)) {
            deps.logger.info('mailersend webhook duplicate skipped', {});
            return reply.code(200).send({ ok: true, duplicate: true });
          }
          // Atomic claim BEFORE the handler: insert-if-absent, so a
          // concurrent second delivery cannot pass while this one runs.
          if (!deps.noteWebhookEvent(dedupeId)) {
            deps.logger.info('mailersend webhook duplicate skipped', {});
            return reply.code(200).send({ ok: true, duplicate: true });
          }
          await deps.onDelivery?.(delivery);
          deps.logger.info('mailersend webhook delivery event processed', {
            emailId: delivery.emailId,
            type,
          });
          return reply.code(200).send({ ok: true });
        }

        if (!isMailerSendInboundPayload(envelope)) {
          deps.logger.info('mailersend webhook ignored event', { type: type || 'unknown' });
          return reply.code(200).send({ ok: true });
        }

        const { event, rawAttachments } = parseMailerSendInbound(envelope);
        // The inbound forward carries the parsed message id; fall back to a
        // body hash when the payload omits it so retries still dedupe.
        const dedupeId = event.id || createHash('sha256').update(rawBody).digest('hex');
        if (deps.hasWebhookEvent(dedupeId)) {
          deps.logger.info('mailersend webhook duplicate skipped', {});
          return reply.code(200).send({ ok: true, duplicate: true });
        }

        // Atomic claim BEFORE any work: insert-if-absent, so two concurrent
        // deliveries of the same event cannot both be processed. The stash
        // is idempotent, so claiming before it is safe.
        if (!deps.noteWebhookEvent(dedupeId)) {
          deps.logger.info('mailersend webhook duplicate skipped', {});
          return reply.code(200).send({ ok: true, duplicate: true });
        }

        stashInlineAttachments(deps.store, deps.provider.name, event.id, rawAttachments);
        await deps.onEvent(event);

        deps.logger.info('mailersend webhook processed', { emailId: event.id });
        return reply.code(200).send({ ok: true });
      },
    );
  });
}
