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

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isMailerSendInboundPayload,
  MailerSendProvider,
  parseMailerSendDeliveryEvent,
  parseMailerSendInbound,
} from '../src/providers/mailersend.js';

const API_KEY = 'mlsn_test_key';
const SECRET = 'route-signing-secret';

// The fixed public test secret from MailerSend's webhook docs.
const TEST_SECRET = 'test_Am3L1GuOIc4blLUuHqAPxxwkZaJyEk8G';

// Every response is canned; no network leaves this file.
function fakeFetch(
  routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const urlString = String(url);
    seen.push({ url: urlString, init: init ?? {} });
    const headers = new Headers(init?.headers);
    if (urlString.startsWith('https://api.mailersend.com')) {
      expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    }
    const route = Object.entries(routes).find(([prefix]) => urlString.startsWith(prefix))?.[1];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    return new Response(
      route.body === undefined ? null : JSON.stringify(route.body),
      { status: route.status, headers: route.headers },
    );
  }) as typeof fetch;
  return { fetchFn, seen };
}

function providerWith(
  routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const { fetchFn, seen } = fakeFetch(routes);
  return { provider: new MailerSendProvider({ apiKey: API_KEY, fetchFn }), seen };
}

function sign(secret: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

const PING = Buffer.from(
  JSON.stringify({ type: 'webhook.test', message: 'This is a ping test message' }),
);

describe('MailerSendProvider.send', () => {
  it('posts the documented wire shape and returns the X-Message-Id', async () => {
    const { provider, seen } = providerWith({
      'https://api.mailersend.com/v1/email': {
        status: 202,
        headers: { 'x-message-id': 'msg_abc123' },
      },
    });
    const result = await provider.send({
      from: 'Ops <ops@example.com>',
      to: ['user@example.com'],
      subject: 'hello',
      text: 'hi',
      replyTo: 'reply@example.com',
      headers: { 'In-Reply-To': '<thread@example.com>', 'X-Custom': 'dropped' },
      attachments: [{ filename: 'a.txt', content: Buffer.from('data'), mime: 'text/plain' }],
      scheduledAt: '2026-10-11T10:00:00.000Z',
    });
    expect(result).toEqual({ id: 'msg_abc123' });
    const call = seen[0]!;
    expect(call.url).toBe('https://api.mailersend.com/v1/email');
    expect(call.init.method).toBe('POST');
    const body = JSON.parse(String(call.init.body));
    expect(body.from).toEqual({ email: 'ops@example.com', name: 'Ops' });
    expect(body.to).toEqual([{ email: 'user@example.com' }]);
    expect(body.reply_to).toEqual({ email: 'reply@example.com' });
    // In-Reply-To is forwarded; enterprise-only custom headers are omitted.
    expect(body.in_reply_to).toBe('<thread@example.com>');
    expect(body.headers).toBeUndefined();
    expect(body.attachments).toEqual([
      { filename: 'a.txt', content: Buffer.from('data').toString('base64'), content_type: 'text/plain' },
    ]);
    expect(body.send_at).toBe(Math.floor(Date.parse('2026-10-11T10:00:00.000Z') / 1000));
  });

  it('requires recipients and maps 422 into a clear error', async () => {
    const { provider } = providerWith({
      'https://api.mailersend.com/v1/email': {
        status: 422,
        body: { message: 'The given data was invalid.', errors: { to: ['bad'] } },
      },
    });
    await expect(provider.send({ from: 'a@b.c', to: [], subject: 'x' })).rejects.toThrow(
      'at least one recipient',
    );
    await expect(provider.send({ from: 'a@b.c', to: ['d@e.f'], subject: 'x' })).rejects.toThrow(
      /422.*The given data was invalid/,
    );
  });

  it('rejects a 202 without the message id header', async () => {
    const { provider } = providerWith({
      'https://api.mailersend.com/v1/email': { status: 202 },
    });
    await expect(
      provider.send({ from: 'a@b.c', to: ['d@e.f'], subject: 'x' }),
    ).rejects.toThrow('X-Message-Id');
  });
});

describe('MailerSendProvider.verifyWebhook', () => {
  it('accepts a correctly signed payload', () => {
    const { provider } = providerWith({});
    const raw = Buffer.from(JSON.stringify({ type: 'activity.delivered', data: {} }));
    expect(
      provider.verifyWebhook(raw, { signature: sign(SECRET, raw) }, SECRET),
    ).toEqual({ ok: true });
  });

  it('rejects tampered bodies, wrong secrets, and missing signatures', () => {
    const { provider } = providerWith({});
    const raw = Buffer.from(JSON.stringify({ type: 'activity.delivered', data: {} }));
    const tampered = Buffer.from(JSON.stringify({ type: 'activity.delivered', data: { x: 1 } }));
    expect(provider.verifyWebhook(tampered, { signature: sign(SECRET, raw) }, SECRET)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(provider.verifyWebhook(raw, { signature: sign('other', raw) }, SECRET).ok).toBe(false);
    expect(provider.verifyWebhook(raw, {}, SECRET)).toEqual({
      ok: false,
      reason: 'missing signature',
    });
    expect(provider.verifyWebhook(raw, { signature: 'not-hex' }, SECRET).ok).toBe(false);
  });

  it('accepts the documented test secret for the webhook.test ping only', () => {
    const { provider } = providerWith({});
    // The ping signed with the public test secret verifies...
    expect(
      provider.verifyWebhook(PING, { signature: sign(TEST_SECRET, PING) }, 'wrong-secret'),
    ).toEqual({ ok: true });
    // ...but the test secret never authorizes a real event.
    const real = Buffer.from(JSON.stringify({ type: 'activity.delivered', data: {} }));
    const realSignedWithTest = provider.verifyWebhook(
      real,
      { signature: sign(TEST_SECRET, real) },
      SECRET,
    );
    expect(realSignedWithTest).toEqual({ ok: false, reason: 'signature mismatch' });
  });
});

const INBOUND_PAYLOAD = {
  type: 'inbound.received',
  data: {
    message_id: 'inb_1',
    from: { email: 'customer@example.com', name: 'Customer' },
    to: [{ email: 'support@example.com' }],
    subject: 'help',
    text: 'please help',
    html: '<p>please help</p>',
    date: 'Sat, 10 Oct 2026 18:05:11 +0000',
    headers: { 'Message-Id': '<m1@example.com>', 'In-Reply-To': '<t0@example.com>' },
    attachments: [
      {
        id: 'att1',
        filename: 'log.txt',
        content_type: 'text/plain',
        content: Buffer.from('logdata').toString('base64'),
      },
      { filename: 'pic.png', content_type: 'image/png', url: 'https://cdn.example.com/p.png' },
    ],
  },
};

describe('parseMailerSendInbound', () => {
  it('normalizes the forward payload to an EmailEvent', () => {
    const { event, rawAttachments } = parseMailerSendInbound(INBOUND_PAYLOAD);
    expect(event.provider).toBe('mailersend');
    expect(event.id).toBe('inb_1');
    expect(event.from).toEqual({ address: 'customer@example.com', name: 'Customer' });
    expect(event.to).toEqual(['support@example.com']);
    expect(event.subject).toBe('help');
    expect(event.bodyText).toBe('please help');
    expect(event.bodyHtml).toBe('<p>please help</p>');
    expect(event.dateMs).toBe(Date.parse('Sat, 10 Oct 2026 18:05:11 +0000'));
    expect(event.threadId).toBe('<t0@example.com>');
    expect(event.attachments).toHaveLength(2);
    expect(event.attachments[0]).toMatchObject({
      id: 'att1',
      filename: 'log.txt',
      size: 7,
      mime: 'text/plain',
    });
    // The URL-carried attachment stays a metadata entry; only inline bytes
    // are returned for the stash.
    expect(event.attachments[1]).toMatchObject({ filename: 'pic.png', mime: 'image/png' });
    expect(rawAttachments).toHaveLength(1);
    expect(rawAttachments[0]!.content).toEqual(Buffer.from('logdata'));
  });

  it('detects inbound forwards and rejects activity events', () => {
    expect(isMailerSendInboundPayload(INBOUND_PAYLOAD)).toBe(true);
    expect(isMailerSendInboundPayload({ type: 'activity.delivered', data: {} })).toBe(false);
  });
});

describe('parseMailerSendDeliveryEvent', () => {
  const delivered = {
    type: 'activity.delivered',
    data: { email: { message: { id: 'msg_abc123' } } },
  };
  const bounced = {
    type: 'activity.hard_bounced',
    data: { email: { message: { id: 'msg_abc123' } }, meta: { bounce_reason: 'x' } },
  };

  it('maps delivered and bounced to the shared DeliveryEvent shape', () => {
    expect(parseMailerSendDeliveryEvent(delivered)).toEqual({
      type: 'delivered',
      emailId: 'msg_abc123',
    });
    expect(parseMailerSendDeliveryEvent(bounced)).toEqual({
      type: 'bounced',
      emailId: 'msg_abc123',
    });
    expect(
      parseMailerSendDeliveryEvent({ type: 'activity.soft_bounced', data: delivered.data }),
    ).toEqual({ type: 'bounced', emailId: 'msg_abc123' });
    expect(
      parseMailerSendDeliveryEvent({ type: 'activity.spam_complaint', data: delivered.data }),
    ).toEqual({ type: 'complained', emailId: 'msg_abc123' });
    expect(
      parseMailerSendDeliveryEvent({ type: 'activity.suppressed', data: delivered.data }),
    ).toEqual({ type: 'failed', emailId: 'msg_abc123' });
  });

  it('ignores events with no delivery equivalent', () => {
    expect(parseMailerSendDeliveryEvent({ type: 'activity.opened', data: {} })).toBeUndefined();
    expect(parseMailerSendDeliveryEvent({ type: 'activity.deferred', data: {} })).toBeUndefined();
    expect(parseMailerSendDeliveryEvent({ type: 'sender_identity.verified' })).toBeUndefined();
  });
});

describe('MailerSendProvider.listSentEmails', () => {
  it('resolves the domain id and maps the emails list', async () => {
    const { provider, seen } = providerWith({
      'https://api.mailersend.com/v1/domains': {
        status: 200,
        body: { data: [{ id: '7nxe3yGpqQmv', name: 'example.com' }] },
      },
      'https://api.mailersend.com/v1/emails': {
        status: 200,
        body: {
          data: [
            {
              id: 'e1',
              from: 'ops@example.com',
              to: 'user@example.com',
              subject: 'hi',
              status: 'delivered',
              created_at: '2026-10-10T10:00:00.000000Z',
            },
          ],
        },
      },
    });
    const rows = await provider.listSentEmails({ domain: 'example.com', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'e1',
      from: 'ops@example.com',
      to: ['user@example.com'],
      subject: 'hi',
      status: 'delivered',
    });
    expect(rows[0]!.dateMs).toBe(Date.parse('2026-10-10T10:00:00.000000Z'));
    expect(seen.some((s) => s.url.startsWith('https://api.mailersend.com/v1/domains'))).toBe(true);
    const emailsCall = seen.find((s) => s.url.startsWith('https://api.mailersend.com/v1/emails'))!;
    expect(emailsCall.url).toContain('domain_id=7nxe3yGpqQmv');
  });

  it('refuses to list without a domain', async () => {
    const { provider } = providerWith({});
    await expect(provider.listSentEmails({})).rejects.toThrow('not supported without a domain');
  });
});

describe('MailerSendProvider unsupported operations', () => {
  it('getInboundEmail throws a clear not-supported error', async () => {
    const { provider } = providerWith({});
    await expect(provider.getInboundEmail('inb_1')).rejects.toThrow('not supported');
  });
});
