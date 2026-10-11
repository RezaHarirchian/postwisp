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

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import type { EmailEvent } from '../providers/interface.js';
import { snippetOf } from '../providers/normalize.js';
import {
  cfAttachmentKey,
  readCloudflareStashedAttachment,
  stashCloudflareAttachments,
  CF_ATTACHMENT_NAMESPACE,
} from './attachment-stash.js';

// Backwards-compatible re-exports: earlier releases (and the bot wiring in
// src/index.ts) import the stash helpers from this module. The
// implementation lives in attachment-stash.ts now.
export { cfAttachmentKey };
export { readCloudflareStashedAttachment as readStashedAttachment };
export { stashCloudflareAttachments as stashAttachmentBytes };
export { CF_ATTACHMENT_NAMESPACE as CF_ATTACHMENT_PREFIX };
export type { StashedAttachment } from './attachment-stash.js';

export interface CloudflareIngestDeps {
  secret: string;
  // The worker retries on transport failures, so payloads can arrive twice.
  // hasWebhookEvent is the fast-path pre-check; noteWebhookEvent is the
  // atomic insert-if-absent claim made BEFORE the handler runs. A false
  // claim means another delivery holds the id.
  hasWebhookEvent: (id: string) => boolean;
  noteWebhookEvent: (id: string) => boolean;
  onEvent: (event: EmailEvent) => Promise<void>;
  logger: Logger;
  // Attachment bytes ride along in the payload (the worker posts parsed
  // content, not fetchable URLs); they are stashed in kv for the bot's
  // download seam to pick up later.
  store: Store;
}

// Replays outside +-5 minutes are rejected: a captured request cannot be
// reused after this window, and the payload id is deduplicated anyway.
const TIMESTAMP_TOLERANCE_S = 300;

// The endpoint the companion Cloudflare Email Worker POSTs to. Transport
// only: verify, dedupe, normalize, hand off. Product logic lives in the
// bot layer; the signing secret and the raw payload never reach a log line.
export function registerCloudflareIngest(app: FastifyInstance, deps: CloudflareIngestDeps): void {
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
      '/ingest/cloudflare',
      {
        // Fastify's default 1MB body limit would reject legitimate mail:
        // the worker forwards up to 8MB of raw attachments (~11MB base64)
        // plus JSON framing. 24MB clears that while the 20MB kv cap stays
        // the binding per-email bound below.
        bodyLimit: 24 * 1024 * 1024,
      },
      async (request, reply) => {
        const rawBody = request.body as Buffer;
        // A non-JSON content type reaches the handler as a string through
        // some transports; verification needs the exact bytes, so it is
        // rejected here instead of failing closed as a bad signature.
        if (!Buffer.isBuffer(rawBody)) {
          deps.logger.warn('cloudflare ingest had non-json body', {});
          return reply.code(400).send({ ok: false, error: 'invalid payload' });
        }

        const signature = headerValue(request.headers['x-postwisp-signature']);
        const timestampRaw = headerValue(request.headers['x-postwisp-timestamp']);
        if (!verifySignature(rawBody, signature, deps.secret) || !verifyTimestamp(timestampRaw)) {
          deps.logger.warn('cloudflare ingest rejected', { reason: 'unauthorized' });
          return reply.code(401).send({ ok: false, error: 'unauthorized' });
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
        } catch {
          deps.logger.warn('cloudflare ingest had invalid json', {});
          return reply.code(400).send({ ok: false, error: 'invalid payload' });
        }

        let event: EmailEvent;
        try {
          event = normalizeCloudflarePayload(payload);
        } catch (err) {
          deps.logger.warn('cloudflare ingest had invalid payload', {
            reason: err instanceof Error ? err.message : 'unknown',
          });
          return reply.code(400).send({ ok: false, error: 'invalid payload' });
        }

        // Fast path for worker retries: skip payloads already seen. Not the
        // correctness mechanism — the atomic claim before the handler below
        // is.
        if (deps.hasWebhookEvent(event.id)) {
          deps.logger.info('cloudflare ingest duplicate skipped', {});
          return reply.code(200).send({ ok: true, duplicate: true });
        }

        // Atomic claim BEFORE any work: insert-if-absent, so two concurrent
        // deliveries of the same payload cannot both be processed. The stash
        // is idempotent, so claiming before it is safe.
        if (!deps.noteWebhookEvent(event.id)) {
          deps.logger.info('cloudflare ingest duplicate skipped', {});
          return reply.code(200).send({ ok: true, duplicate: true });
        }

        stashCloudflareAttachments(deps.store, event.id, payload['attachments']);

        await deps.onEvent(event);

        deps.logger.info('cloudflare ingest processed', { emailId: event.id });
        return reply.code(200).send({ ok: true });
      },
    );
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function verifySignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  // Missing header fails closed. The hex shape check happens before
  // timingSafeEqual because it throws on unequal buffer lengths.
  if (signature === undefined || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'hex');
  return timingSafeEqual(expected, actual);
}

function verifyTimestamp(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const ts = Number(raw);
  if (!Number.isInteger(ts)) return false;
  const nowS = Math.floor(Date.now() / 1000);
  return Math.abs(nowS - ts) <= TIMESTAMP_TOLERANCE_S;
}

// The worker posts parsed content inline; anything here that is missing or
// wrong-typed is a worker bug or a forged request, never user input.
export function normalizeCloudflarePayload(payload: Record<string, unknown>): EmailEvent {
  const id = asNonEmptyString(payload['id'], 'id');
  const fromRec = asRecord(payload['from'], 'from');
  const fromAddress = asNonEmptyString(fromRec['address'], 'from.address');
  const fromName = typeof fromRec['name'] === 'string' ? fromRec['name'] : undefined;
  const to = asStringArray(payload['to'], 'to');
  const subject = typeof payload['subject'] === 'string' ? payload['subject'] : '';
  const dateMs = typeof payload['dateMs'] === 'number' && Number.isFinite(payload['dateMs'])
    ? payload['dateMs']
    : Date.now();
  const bodyText = typeof payload['text'] === 'string' ? payload['text'] : null;
  const bodyHtml = typeof payload['html'] === 'string' ? payload['html'] : null;
  const headerRec = asRecord(payload['headers'], 'headers');
  const headers: Record<string, string> = {};
  for (const key of ['message-id', 'in-reply-to', 'references']) {
    if (typeof headerRec[key] === 'string') headers[key] = headerRec[key] as string;
  }

  const attachments: EmailEvent['attachments'] = [];
  const rawAttachments = payload['attachments'];
  if (Array.isArray(rawAttachments)) {
    for (const entry of rawAttachments) {
      const a = asRecord(entry, 'attachments[]');
      attachments.push({
        id: asNonEmptyString(a['id'], 'attachments[].id'),
        filename: typeof a['filename'] === 'string' && a['filename'].length > 0
          ? (a['filename'] as string)
          : 'attachment',
        size: typeof a['size'] === 'number' && Number.isFinite(a['size']) ? (a['size'] as number) : 0,
        mime: typeof a['mime'] === 'string' ? (a['mime'] as string) : 'application/octet-stream',
      });
    }
  }

  const event: EmailEvent = {
    id,
    provider: 'cloudflare',
    domain: to.length > 0 ? domainOf(to[0]!) : '',
    from: { address: fromAddress },
    to,
    subject,
    dateMs,
    snippet: snippetOf(bodyText ?? ''),
    bodyText,
    bodyHtml,
    attachments,
    threadId: null,
    headers,
  };
  if (fromName !== undefined) event.from.name = fromName;
  return event;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected ${name} to be an object`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`expected ${name} to be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`expected ${name} to be an array of strings`);
  }
  return value as string[];
}
