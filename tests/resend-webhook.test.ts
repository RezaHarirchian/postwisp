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

import { createHmac, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../src/core/logger.js';
import type { EmailEvent, EmailProvider, InboundEmail } from '../src/providers/interface.js';
import { normalizeResendInbound } from '../src/providers/normalize.js';
import { ResendEmailProvider } from '../src/providers/resend.js';
import { registerResendWebhook } from '../src/server/resend-webhook.js';
import envelope from './fixtures/resend-email-received.json';
import inboundFull from './fixtures/resend-inbound-full.json';

const SECRET = randomBytes(32).toString('hex');

function nullLogger(captured: string[]): Logger {
  const push = (message: string, fields?: Record<string, unknown>) =>
    captured.push(`${message} ${JSON.stringify(fields ?? {})}`);
  const logger: Logger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => logger,
  };
  return logger;
}

interface WebhookHarness {
  seen: Set<string>;
  events: EmailEvent[];
  logs: string[];
  alerts: string[];
  post: (rawBody: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
}

// The signature check runs through the real adapter; only the API fetch
// is stubbed, with the signed body carried over the raw request bytes.
async function buildHarness(
  onEvent?: (event: EmailEvent) => Promise<void>,
  opts?: {
    // Simulates the race the atomic claim guards against: every delivery
    // passes the pre-check, so only the insert-if-absent claim can stop
    // the second one.
    preCheckPassThrough?: boolean;
  },
): Promise<WebhookHarness> {
  const seen = new Set<string>();
  const events: EmailEvent[] = [];
  const logs: string[] = [];
  const alerts: string[] = [];
  const verifier = new ResendEmailProvider({ apiKey: 're_test_key' });

  const full = normalizeResendInbound(inboundFull);
  const inbound: InboundEmail = {
    id: full.id,
    from: full.from,
    to: full.to,
    subject: full.subject,
    dateMs: full.dateMs,
    bodyText: full.bodyText,
    bodyHtml: full.bodyHtml,
    attachments: full.attachments.map((a) => ({
      ...a,
      downloadUrl: 'https://s3.amazonaws.com/resend-attachments/a/avatar.png?sig=xyz',
    })),
    threadId: full.threadId,
    headers: full.headers,
  };

  const provider: EmailProvider = {
    name: 'resend',
    capabilities: { scheduling: true, batch: true },
    // The signature check runs through the real adapter; spreading a class
    // instance would drop its prototype methods, so delegate explicitly.
    verifyWebhook: (rawBody, headers, secret) =>
      verifier.verifyWebhook(rawBody, headers, secret),
    send: () => Promise.reject(new Error('not used here')),
    getInboundEmail: async (id: string) => {
      expect(id).toBe('56761188-7520-42d8-8898-ff6fc54ce618');
      return inbound;
    },
    downloadAttachment: () => Promise.reject(new Error('not used here')),
    listSentEmails: () => Promise.resolve([]),
  };

  const app = Fastify({ logger: false });
  registerResendWebhook(app, {
    provider,
    secret: SECRET,
    hasWebhookEvent: opts?.preCheckPassThrough ? () => false : (id: string) => seen.has(id),
    noteWebhookEvent: (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    onEvent:
      onEvent ??
      (async (event) => {
        events.push(event);
      }),
    onSecurityAlert: (text: string) => {
      alerts.push(text);
    },
    logger: nullLogger(logs),
  });
  await app.ready();

  return {
    seen,
    events,
    logs,
    alerts,
    post: async (rawBody: string, headers: Record<string, string>) => {
      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/resend',
        headers: { 'content-type': 'application/json', ...headers },
        payload: rawBody,
      });
      return { status: response.statusCode, body: response.body };
    },
  };
}

function signedHeaders(rawBody: string, id: string, timestamp: string): Record<string, string> {
  const sig = createHmac('sha256', SECRET)
    .update(`${id}.${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${sig}` };
}

describe('POST /webhooks/resend', () => {
  it('verifies, normalizes and hands the event off', async () => {
    const h = await buildHarness();
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const { status } = await h.post(rawBody, signedHeaders(rawBody, 'msg_1', ts));
    expect(status).toBe(200);
    expect(h.events).toHaveLength(1);
    const event = h.events[0]!;
    expect(event.id).toBe('56761188-7520-42d8-8898-ff6fc54ce618');
    expect(event.provider).toBe('resend');
    expect(event.domain).toBe('inbox.postwisp.dev');
    expect(event.subject).toBe('Your one-time code is 482913');
    expect(event.bodyText).toContain('482913');
    // The secret and the raw payload never reach the logs.
    expect(h.logs.join('\n')).not.toContain(SECRET);
    expect(h.logs.join('\n')).not.toContain('482913');
  });

  it('rejects a tampered signature with 401', async () => {
    const h = await buildHarness();
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(rawBody, 'msg_2', ts);
    // Sign one payload, deliver another: same header, different bytes.
    const tampered = rawBody.replace('482913', '000000');
    const { status, body } = await h.post(tampered, headers);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'unauthorized' });
    expect(h.events).toHaveLength(0);
    expect(h.logs.some((line) => line.includes('resend webhook rejected'))).toBe(true);
    // No internals leak into the rejection response.
    expect(body).not.toContain('signature');
  });

  it('processes a retried svix-id exactly once', async () => {
    const h = await buildHarness();
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(rawBody, 'msg_3', ts);
    const first = await h.post(rawBody, headers);
    const second = await h.post(rawBody, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.events).toHaveLength(1);
    expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });
  });

  it('does not reprocess a svix-id when the handler fails: the claim is held', async () => {
    let attempts = 0;
    const processed: EmailEvent[] = [];
    const h = await buildHarness(async (event) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient failure');
      processed.push(event);
    });
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(rawBody, 'msg_6', ts);
    const first = await h.post(rawBody, headers);
    expect(first.status).toBe(500);
    // The id was claimed before the handler ran, so the retry is a
    // duplicate: a poisoned event cannot be reprocessed into a double
    // owner notification, at the cost of no retry on handler failure.
    const second = await h.post(rawBody, headers);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });
    expect(processed).toHaveLength(0);
    expect(attempts).toBe(1);
  });

  it('stops a second delivery that slips past the pre-check via the atomic claim', async () => {
    const processed: EmailEvent[] = [];
    // preCheckPassThrough simulates the race: both deliveries pass the
    // pre-check, so only the insert-if-absent claim stops the double.
    const h = await buildHarness(
      async (event) => {
        processed.push(event);
      },
      { preCheckPassThrough: true },
    );
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(rawBody, 'msg_7', ts);
    const first = await h.post(rawBody, headers);
    expect(JSON.parse(first.body)).toEqual({ ok: true });
    const second = await h.post(rawBody, headers);
    expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });
    expect(processed).toHaveLength(1);
  });

  it('rejects a five-minute-old timestamp', async () => {
    const h = await buildHarness();
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000) - 360);
    const { status } = await h.post(rawBody, signedHeaders(rawBody, 'msg_4', ts));
    expect(status).toBe(401);
    expect(h.events).toHaveLength(0);
  });

  it('alerts the owner on a rejected signature without leaking internals', async () => {
    const h = await buildHarness();
    const rawBody = JSON.stringify(envelope);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(rawBody, 'msg_7', ts);
    const tampered = rawBody.replace('482913', '000000');
    const { status, body } = await h.post(tampered, headers);
    expect(status).toBe(401);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain('bad signature');
    expect(body).not.toContain('signature');
  });

  it('acknowledges non-received events without processing', async () => {
    const h = await buildHarness();
    const rawBody = JSON.stringify({ ...envelope, type: 'email.delivered' });
    const ts = String(Math.floor(Date.now() / 1000));
    const { status } = await h.post(rawBody, signedHeaders(rawBody, 'msg_5', ts));
    expect(status).toBe(200);
    expect(h.events).toHaveLength(0);
  });
});
