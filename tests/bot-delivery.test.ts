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
import { afterEach, describe, expect, it } from 'vitest';
import { buildReplyInput, createDeliveryHandler, type DeliveryDeps } from '../src/bot/delivery.js';
import { t } from '../src/core/i18n.js';
import type { Logger } from '../src/core/logger.js';
import { openStore, type Store } from '../src/core/store.js';
import type { EmailProvider } from '../src/providers/interface.js';
import { ResendEmailProvider } from '../src/providers/resend.js';
import { registerResendWebhook, type DeliveryEvent } from '../src/server/resend-webhook.js';

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function memStore(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}

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

interface FakeApi {
  edits: Array<{ chatId: number; messageId: number; text: string }>;
  fail: boolean;
}

function fakeApi(): FakeApi & DeliveryDeps['api'] {
  const api: FakeApi & DeliveryDeps['api'] = {
    edits: [],
    fail: false,
    async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
      if (api.fail) throw new Error('message not found');
      api.edits.push({ chatId, messageId, text });
    },
  };
  return api;
}

interface FakeQueue {
  sent: Array<{ chatId: number; text: string }>;
  queue: DeliveryDeps['queue'];
}

function fakeQueue(): FakeQueue {
  const fq: FakeQueue = {
    sent: [],
    queue: null,
  };
  fq.queue = {
    enqueue(chatId: number, req: { text: string }): void {
      fq.sent.push({ chatId, text: req.text });
    },
    stop(): void {},
  };
  return fq;
}

function depsFor(store: Store): {
  deps: DeliveryDeps;
  api: FakeApi & DeliveryDeps['api'];
  fq: FakeQueue;
  logs: string[];
} {
  const logs: string[] = [];
  const api = fakeApi();
  const fq = fakeQueue();
  const deps: DeliveryDeps = {
    store,
    logger: nullLogger(logs),
    api,
    queue: fq.queue,
    ownerId: 4242,
  };
  return { deps, api, fq, logs };
}

function logSentRow(store: Store, providerId: string, withChat = true): void {
  store.logSent({
    providerId,
    to: 'bob@example.com',
    subject: 'Invoice <Q3>',
    domain: 'postwisp.dev',
    ...(withChat ? { chatId: 100, messageId: 200 } : {}),
  });
}

describe('buildReplyInput', () => {
  const orig = {
    subject: 'Quarterly report',
    headers: { 'message-id': '<abc123@mail.example.com>', references: '<root@mail.example.com>' },
    from: 'alice@example.com',
  };

  it('adds a single Re: prefix', () => {
    const input = buildReplyInput(orig, 'body', 'me@postwisp.dev');
    expect(input.subject).toBe('Re: Quarterly report');
  });

  it('never stacks Re: prefixes', () => {
    for (const subject of ['Re: Quarterly report', 'RE: Quarterly report', 're: Quarterly report']) {
      const input = buildReplyInput({ ...orig, subject }, 'body', 'me@postwisp.dev');
      expect(input.subject).toBe(subject);
    }
  });

  it('threads through In-Reply-To and References', () => {
    const input = buildReplyInput(orig, 'body', 'me@postwisp.dev');
    expect(input.headers?.['In-Reply-To']).toBe('<abc123@mail.example.com>');
    expect(input.headers?.['References']).toBe(
      '<root@mail.example.com> <abc123@mail.example.com>',
    );
  });

  it('starts a References chain when the original has none', () => {
    const input = buildReplyInput(
      { ...orig, headers: { 'message-id': '<solo@mail.example.com>' } },
      'body',
      'me@postwisp.dev',
    );
    expect(input.headers?.['References']).toBe('<solo@mail.example.com>');
  });

  it('omits threading headers when there is no message-id', () => {
    const input = buildReplyInput({ ...orig, headers: {} }, 'body', 'me@postwisp.dev');
    expect(input.headers).toEqual({});
  });

  it('maps from, to and body', () => {
    const input = buildReplyInput(orig, 'Reply text', 'me@postwisp.dev');
    expect(input.from).toBe('me@postwisp.dev');
    expect(input.to).toEqual(['alice@example.com']);
    expect(input.text).toBe('Reply text');
  });
});

describe('createDeliveryHandler', () => {
  it('updates the sent status and appends it to the chat message', async () => {
    const store = memStore();
    logSentRow(store, 'prov_1');
    const { deps, api } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'delivered', emailId: 'prov_1' });

    expect(store.getSentByProviderId('prov_1')?.status).toBe('delivered');
    expect(api.edits).toHaveLength(1);
    const edit = api.edits[0]!;
    expect(edit.chatId).toBe(100);
    expect(edit.messageId).toBe(200);
    // Dynamic content is HTML-escaped; the status line is appended.
    expect(edit.text).toContain('Invoice &lt;Q3&gt;');
    expect(edit.text).toContain(t('bot.delivery.statusLine', { status: 'delivered' }));
  });

  it('ignores events for unknown provider ids', async () => {
    const store = memStore();
    const { deps, api } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'delivered', emailId: 'nope' });

    expect(api.edits).toHaveLength(0);
    expect(store.getSentByProviderId('nope')).toBeNull();
  });

  it('skips the edit when the sent row has no chat message', async () => {
    const store = memStore();
    logSentRow(store, 'prov_2', false);
    const { deps, api } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'delivered', emailId: 'prov_2' });

    expect(store.getSentByProviderId('prov_2')?.status).toBe('delivered');
    expect(api.edits).toHaveLength(0);
  });

  it('logs instead of throwing when the edit fails', async () => {
    const store = memStore();
    logSentRow(store, 'prov_3');
    const { deps, api, logs } = depsFor(store);
    api.fail = true;

    await createDeliveryHandler(deps).handleDelivery({ type: 'delivered', emailId: 'prov_3' });

    expect(store.getSentByProviderId('prov_3')?.status).toBe('delivered');
    expect(logs.some((line) => line.includes('failed to edit sent message'))).toBe(true);
  });

  it('suppresses and notifies the owner on a hard bounce', async () => {
    const store = memStore();
    logSentRow(store, 'prov_4');
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'bounced', emailId: 'prov_4' });

    expect(store.getSentByProviderId('prov_4')?.status).toBe('bounced');
    expect(store.isSuppressed('bob@example.com')).toBe(true);
    expect(fq.sent).toHaveLength(1);
    expect(fq.sent[0]!.chatId).toBe(4242);
    expect(fq.sent[0]!.text).toContain('bounced and was suppressed');
  });

  it('suppresses and notifies the owner on a complaint', async () => {
    const store = memStore();
    logSentRow(store, 'prov_5');
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'complained', emailId: 'prov_5' });

    expect(store.isSuppressed('bob@example.com')).toBe(true);
    expect(fq.sent).toHaveLength(1);
    expect(fq.sent[0]!.text).toContain('spam complaint');
  });

  it('suppresses every recipient of a multi-recipient bounce', async () => {
    const store = memStore();
    store.logSent({
      providerId: 'prov_8',
      to: 'bob@example.com, carol@example.com',
      subject: 'Team update',
      domain: 'postwisp.dev',
    });
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'bounced', emailId: 'prov_8' });

    expect(store.isSuppressed('bob@example.com')).toBe(true);
    expect(store.isSuppressed('carol@example.com')).toBe(true);
    expect(fq.sent).toHaveLength(1);
  });

  it('does not suppress on failed', async () => {
    const store = memStore();
    logSentRow(store, 'prov_6');
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'failed', emailId: 'prov_6' });

    expect(store.getSentByProviderId('prov_6')?.status).toBe('failed');
    expect(store.isSuppressed('bob@example.com')).toBe(false);
    expect(fq.sent).toHaveLength(0);
  });

  it('stays silent when the queue or owner is missing', async () => {
    const store = memStore();
    logSentRow(store, 'prov_7');
    const { deps } = depsFor(store);
    deps.queue = null;
    deps.ownerId = null;

    await createDeliveryHandler(deps).handleDelivery({ type: 'bounced', emailId: 'prov_7' });

    expect(store.isSuppressed('bob@example.com')).toBe(true);
  });
});

const SECRET = randomBytes(32).toString('hex');

function signedHeaders(rawBody: string, id: string, timestamp: string): Record<string, string> {
  const sig = createHmac('sha256', SECRET)
    .update(`${id}.${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest('base64');
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${sig}` };
}

async function buildDeliveryRouteHarness(wireOnDelivery: boolean): Promise<{
  post: (rawBody: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
  deliveries: DeliveryEvent[];
  seen: Set<string>;
}> {
  const seen = new Set<string>();
  const deliveries: DeliveryEvent[] = [];
  const verifier = new ResendEmailProvider({ apiKey: 're_test_key' });
  const provider: EmailProvider = {
    name: 'resend',
    capabilities: { scheduling: true, batch: true },
    verifyWebhook: (rawBody, headers, secret) => verifier.verifyWebhook(rawBody, headers, secret),
    send: () => Promise.reject(new Error('not used here')),
    getInboundEmail: () => Promise.reject(new Error('not used here')),
    downloadAttachment: () => Promise.reject(new Error('not used here')),
    listSentEmails: () => Promise.resolve([]),
  };
  const app = Fastify({ logger: false });
  registerResendWebhook(app, {
    provider,
    secret: SECRET,
    hasWebhookEvent: (id: string) => seen.has(id),
    noteWebhookEvent: (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    onEvent: async () => {},
    ...(wireOnDelivery
      ? {
          onDelivery: async (event: DeliveryEvent) => {
            deliveries.push(event);
          },
        }
      : {}),
    logger: nullLogger([]),
  });
  await app.ready();
  return {
    deliveries,
    seen,
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

describe('delivery webhook route', () => {
  const types = ['email.delivered', 'email.bounced', 'email.complained', 'email.failed'] as const;

  for (const envelopeType of types) {
    it(`hands ${envelopeType} to onDelivery`, async () => {
      const h = await buildDeliveryRouteHarness(true);
      const rawBody = JSON.stringify({ type: envelopeType, data: { email_id: 'prov_x' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const { status } = await h.post(rawBody, signedHeaders(rawBody, `svix-${envelopeType}`, ts));
      expect(status).toBe(200);
      expect(h.deliveries).toEqual([
        { type: envelopeType.replace('email.', ''), emailId: 'prov_x' },
      ]);
      // The svix-id is recorded, so a Resend retry is a cheap duplicate.
      expect(h.seen.has(`svix-${envelopeType}`)).toBe(true);
    });
  }

  it('dedupes a retried delivery event', async () => {
    const h = await buildDeliveryRouteHarness(true);
    const rawBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 'prov_y' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = signedHeaders(rawBody, 'svix-retry', ts);
    const first = await h.post(rawBody, headers);
    const second = await h.post(rawBody, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });
    expect(h.deliveries).toHaveLength(1);
  });

  it('rejects a delivery event without email_id', async () => {
    const h = await buildDeliveryRouteHarness(true);
    const rawBody = JSON.stringify({ type: 'email.delivered', data: {} });
    const ts = String(Math.floor(Date.now() / 1000));
    const { status } = await h.post(rawBody, signedHeaders(rawBody, 'svix-noid', ts));
    expect(status).toBe(400);
    expect(h.deliveries).toHaveLength(0);
  });

  it('acks a delivery event when onDelivery is not wired', async () => {
    const h = await buildDeliveryRouteHarness(false);
    const rawBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 'prov_z' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const { status } = await h.post(rawBody, signedHeaders(rawBody, 'svix-unwired', ts));
    expect(status).toBe(200);
  });

  it('still ignores unknown event types', async () => {
    const h = await buildDeliveryRouteHarness(true);
    const rawBody = JSON.stringify({ type: 'email.opened', data: { email_id: 'prov_o' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const { status, body } = await h.post(rawBody, signedHeaders(rawBody, 'svix-open', ts));
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(h.deliveries).toHaveLength(0);
  });
});

describe('rate alerts', () => {
  let seedCounter = 0;
  function seedDecided(store: Store, domain: string, statuses: string[]): void {
    for (const status of statuses) {
      const providerId = `seed_${seedCounter++}`;
      store.logSent({ providerId, to: 'u@x.org', subject: 's', domain });
      store.updateSentStatus(providerId, status);
    }
  }

  function bounceAlerts(fq: { sent: Array<{ text: string }> }): Array<{ text: string }> {
    return fq.sent.filter((m) => m.text.includes('Bounce rate'));
  }

  function complaintAlerts(fq: { sent: Array<{ text: string }> }): Array<{ text: string }> {
    return fq.sent.filter((m) => m.text.includes('Complaint rate'));
  }

  it('warns the owner once when the bounce rate crosses 4%', async () => {
    const store = memStore();
    seedDecided(store, 'postwisp.dev', Array(19).fill('delivered'));
    logSentRow(store, 'prov_b');
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'bounced', emailId: 'prov_b' });

    // 20 decided, 1 bounced = 5% >= 4%.
    const alerts = bounceAlerts(fq);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('postwisp.dev');
    expect(alerts[0]?.text).toContain('Pause sending');

    // A second bounce does not re-warn while the flag stands.
    logSentRow(store, 'prov_b2');
    await createDeliveryHandler(deps).handleDelivery({ type: 'bounced', emailId: 'prov_b2' });
    expect(bounceAlerts(fq)).toHaveLength(1);
  });

  it('stays silent below the threshold and with too few samples', async () => {
    const store = memStore();
    seedDecided(store, 'postwisp.dev', Array(49).fill('delivered'));
    logSentRow(store, 'prov_b');
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'bounced', emailId: 'prov_b' });

    // 50 decided, 1 bounced = 2% < 4%.
    expect(bounceAlerts(fq)).toHaveLength(0);

    const small = memStore();
    seedDecided(small, 'postwisp.dev', Array(5).fill('delivered'));
    logSentRow(small, 'prov_s');
    const smallDeps = depsFor(small);
    await createDeliveryHandler(smallDeps.deps).handleDelivery({ type: 'bounced', emailId: 'prov_s' });
    // 6 decided < 10 minimum: one bounce must not page the owner.
    expect(bounceAlerts(smallDeps.fq)).toHaveLength(0);
  });

  it('warns again after the rate recovers', async () => {
    const store = memStore();
    seedDecided(store, 'postwisp.dev', Array(19).fill('delivered'));
    logSentRow(store, 'prov_b');
    const { deps, fq } = depsFor(store);
    const handler = createDeliveryHandler(deps);

    await handler.handleDelivery({ type: 'bounced', emailId: 'prov_b' });
    expect(bounceAlerts(fq)).toHaveLength(1);

    // More deliveries: 1 bounce in 31 decided = 3.2% < 4% recovers and
    // clears the flag.
    seedDecided(store, 'postwisp.dev', Array(10).fill('delivered'));
    logSentRow(store, 'prov_d');
    await handler.handleDelivery({ type: 'delivered', emailId: 'prov_d' });
    expect(bounceAlerts(fq)).toHaveLength(1);

    // A new spike warns again: 2 bounces in 32 decided = 6.25% >= 4%.
    logSentRow(store, 'prov_b3');
    await handler.handleDelivery({ type: 'bounced', emailId: 'prov_b3' });
    expect(bounceAlerts(fq)).toHaveLength(2);
  });

  it('warns when the complaint rate crosses 0.08%', async () => {
    const store = memStore();
    seedDecided(store, 'postwisp.dev', Array(999).fill('delivered'));
    logSentRow(store, 'prov_c');
    const { deps, fq } = depsFor(store);

    await createDeliveryHandler(deps).handleDelivery({ type: 'complained', emailId: 'prov_c' });

    // 1000 decided, 1 complaint = 0.1% >= 0.08%.
    const alerts = complaintAlerts(fq);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toContain('postwisp.dev');
  });

  it('logs consent entries for bounce and complaint suppressions', async () => {
    const store = memStore();
    logSentRow(store, 'prov_b');
    logSentRow(store, 'prov_c');
    const { deps } = depsFor(store);
    const handler = createDeliveryHandler(deps);

    await handler.handleDelivery({ type: 'bounced', emailId: 'prov_b' });
    await handler.handleDelivery({ type: 'complained', emailId: 'prov_c' });

    const log = store.listConsentLog(10);
    expect(log.filter((e) => e.event === 'suppress' && e.detail === 'hard bounce')).toHaveLength(1);
    expect(log.filter((e) => e.event === 'suppress' && e.detail === 'complaint')).toHaveLength(1);
  });
});
