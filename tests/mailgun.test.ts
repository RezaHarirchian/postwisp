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
  MailgunProvider,
  parseMailgunDeliveryEvent,
  parseMailgunInbound,
} from '../src/providers/mailgun.js';

const API_KEY = 'mg_test_key';
const SECRET = 'webhook-signing-key';

// Every response is canned; no network leaves this file.
function fakeFetch(
  routes: Record<string, { status: number; body?: unknown; bytes?: Buffer }>,
) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const urlString = String(url);
    seen.push({ url: urlString, init: init ?? {} });
    const headers = new Headers(init?.headers);
    const hostname = new URL(urlString).hostname;
    if (hostname === 'mailgun.net' || hostname.endsWith('.mailgun.net')) {
      // HTTP Basic auth with user 'api' and the key as password.
      expect(headers.get('authorization')).toBe(
        `Basic ${Buffer.from(`api:${API_KEY}`, 'utf8').toString('base64')}`,
      );
    }
    const route = Object.entries(routes).find(([prefix]) => urlString.startsWith(prefix))?.[1];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    if (route.bytes) {
      return new Response(route.bytes as unknown as BodyInit, { status: route.status });
    }
    return Response.json(route.body, { status: route.status });
  }) as typeof fetch;
  return { fetchFn, seen };
}

function providerWith(
  routes: Record<string, { status: number; body?: unknown; bytes?: Buffer }>,
) {
  const { fetchFn, seen } = fakeFetch(routes);
  return { provider: new MailgunProvider({ apiKey: API_KEY, fetchFn }), seen };
}

function sign(secret: string, timestamp: string, token: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${token}`).digest('hex');
}

const TIMESTAMP = String(Math.floor(Date.now() / 1000));

const BODY_MIME = [
  'From: Alice <alice@example.com>',
  'To: bob@example.com',
  'Subject: hello',
  'Message-Id: <m1@example.com>',
  'Date: Sat, 10 Oct 2026 18:05:11 +0000',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain',
  '',
  'plain body',
  '--b1',
  'Content-Type: application/pdf; name="doc.pdf"',
  'Content-Disposition: attachment; filename="doc.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('pdf-bytes').toString('base64'),
  '--b1--',
  '',
].join('\r\n');

describe('MailgunProvider.send', () => {
  it('posts form-urlencoded to the from-address domain and returns the id', async () => {
    const { provider, seen } = providerWith({
      'https://api.mailgun.net/v3/example.com/messages': {
        status: 200,
        body: { id: '<abc@mailgun>', message: 'Queued. Thank you.' },
      },
    });
    const result = await provider.send({
      from: 'ops@example.com',
      to: ['a@example.com', 'b@example.com'],
      subject: 'hello',
      text: 'hi',
      replyTo: 'reply@example.com',
      scheduledAt: '2026-10-11T10:00:00.000Z',
    });
    expect(result).toEqual({ id: '<abc@mailgun>' });
    const call = seen[0]!;
    expect(call.url).toBe('https://api.mailgun.net/v3/example.com/messages');
    expect(call.init.method).toBe('POST');
    const headers = new Headers(call.init.headers);
    expect(headers.get('content-type')).toContain('application/x-www-form-urlencoded');
    const body = new URLSearchParams(String(call.init.body));
    expect(body.get('from')).toBe('ops@example.com');
    expect(body.get('to')).toBe('a@example.com,b@example.com');
    expect(body.get('subject')).toBe('hello');
    expect(body.get('text')).toBe('hi');
    expect(body.get('h:Reply-To')).toBe('reply@example.com');
    expect(body.get('o:deliverytime')).toBe(
      String(Math.floor(Date.parse('2026-10-11T10:00:00.000Z') / 1000)),
    );
  });

  it('uses multipart with attachment fields when attachments are present', async () => {
    const { provider, seen } = providerWith({
      'https://api.mailgun.net/v3/example.com/messages': {
        status: 200,
        body: { id: '<abc@mailgun>', message: 'Queued.' },
      },
    });
    await provider.send({
      from: 'ops@example.com',
      to: ['a@example.com'],
      subject: 'x',
      attachments: [{ filename: 'f.txt', content: Buffer.from('data'), mime: 'text/plain' }],
    });
    const call = seen[0]!;
    const body = call.init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const file = body.get('attachment') as File;
    expect(file.name).toBe('f.txt');
    expect(await file.text()).toBe('data');
    expect(body.get('subject')).toBe('x');
  });

  it('requires recipients and surfaces mailgun errors', async () => {
    const { provider } = providerWith({
      'https://api.mailgun.net/v3/example.com/messages': {
        status: 401,
        body: { message: 'Invalid private key' },
      },
    });
    await expect(provider.send({ from: 'a@b.c', to: [], subject: 'x' })).rejects.toThrow(
      'at least one recipient',
    );
    await expect(provider.send({ from: 'a@example.com', to: ['d@e.f'], subject: 'x' })).rejects.toThrow(
      /401.*Invalid private key/,
    );
    await expect(
      provider.send({ from: 'no-domain', to: ['d@e.f'], subject: 'x' }),
    ).rejects.toThrow('requires a from address with a domain');
  });
});

describe('MailgunProvider.verifyWebhook', () => {
  it('accepts route forwards with top-level form signature fields', () => {
    const { provider } = providerWith({});
    const token = 'tok123';
    const params = new URLSearchParams({
      timestamp: TIMESTAMP,
      token,
      signature: sign(SECRET, TIMESTAMP, token),
      'body-mime': 'x',
    });
    expect(
      provider.verifyWebhook(Buffer.from(params.toString()), {}, SECRET),
    ).toEqual({ ok: true });
  });

  it('accepts event webhooks with the signature under payload.signature', () => {
    const { provider } = providerWith({});
    const token = 'tok456';
    const raw = Buffer.from(
      JSON.stringify({
        signature: { timestamp: TIMESTAMP, token, signature: sign(SECRET, TIMESTAMP, token) },
        'event-data': { event: 'delivered' },
      }),
    );
    expect(
      provider.verifyWebhook(raw, { 'content-type': 'application/json' }, SECRET),
    ).toEqual({ ok: true });
  });

  it('rejects tampered, missing, and replayed signatures', () => {
    const { provider } = providerWith({});
    const token = 'tok123';
    const good = new URLSearchParams({
      timestamp: TIMESTAMP,
      token,
      signature: sign(SECRET, TIMESTAMP, token),
    });
    const tampered = new URLSearchParams({ timestamp: TIMESTAMP, token: 'other', signature: sign(SECRET, TIMESTAMP, token) });
    expect(provider.verifyWebhook(Buffer.from(tampered.toString()), {}, SECRET)).toEqual({
      ok: false,
      reason: 'signature mismatch',
    });
    expect(provider.verifyWebhook(Buffer.from('timestamp=1&token=2'), {}, SECRET)).toEqual({
      ok: false,
      reason: 'missing signature fields',
    });
    const old = new URLSearchParams({
      timestamp: String(Math.floor(Date.now() / 1000) - 3600),
      token,
      signature: sign(SECRET, String(Math.floor(Date.now() / 1000) - 3600), token),
    });
    expect(provider.verifyWebhook(Buffer.from(old.toString()), {}, SECRET)).toEqual({
      ok: false,
      reason: 'timestamp outside tolerance',
    });
    expect(provider.verifyWebhook(Buffer.from(good.toString()), {}, 'wrong').ok).toBe(false);
  });
});

describe('parseMailgunInbound', () => {
  it('builds an EmailEvent from the forward fields and body-mime', () => {
    const { event, rawAttachments } = parseMailgunInbound({
      From: 'Alice <alice@example.com>',
      To: 'bob@example.com',
      Subject: 'hello',
      'message-url': 'https://storage-us-east4.api.mailgun.net/v3/domains/example.com/messages/key1',
      timestamp: TIMESTAMP,
      token: 't',
      signature: 's',
      'body-mime': BODY_MIME,
    });
    expect(event.provider).toBe('mailgun');
    expect(event.id).toBe('<m1@example.com>');
    expect(event.from).toEqual({ address: 'alice@example.com', name: 'Alice' });
    expect(event.to).toEqual(['bob@example.com']);
    expect(event.subject).toBe('hello');
    expect(event.bodyText).toContain('plain body');
    expect(event.dateMs).toBe(Date.parse('Sat, 10 Oct 2026 18:05:11 +0000'));
    expect(event.attachments).toHaveLength(1);
    expect(event.attachments[0]).toMatchObject({
      id: 'mgatt-0',
      filename: 'doc.pdf',
      size: 9,
      mime: 'application/pdf',
    });
    expect(rawAttachments[0]!.content).toEqual(Buffer.from('pdf-bytes'));
  });

  it('throws when body-mime is missing', () => {
    expect(() => parseMailgunInbound({ From: 'a@b.c' })).toThrow('missing body-mime');
  });
});

describe('parseMailgunDeliveryEvent', () => {
  const base = (event: string, severity?: string) => ({
    'event-data': {
      id: 'evt1',
      event,
      ...(severity ? { severity } : {}),
      message: { headers: { 'message-id': '<abc@mailgun>' } },
    },
  });

  it('maps delivered and bounced to the shared DeliveryEvent shape', () => {
    expect(parseMailgunDeliveryEvent(base('delivered'))).toEqual({
      type: 'delivered',
      emailId: '<abc@mailgun>',
    });
    expect(parseMailgunDeliveryEvent(base('failed', 'permanent'))).toEqual({
      type: 'bounced',
      emailId: '<abc@mailgun>',
    });
    expect(parseMailgunDeliveryEvent(base('failed', 'temporary'))).toEqual({
      type: 'failed',
      emailId: '<abc@mailgun>',
    });
    expect(parseMailgunDeliveryEvent(base('complained'))).toEqual({
      type: 'complained',
      emailId: '<abc@mailgun>',
    });
    expect(parseMailgunDeliveryEvent(base('dropped'))).toEqual({
      type: 'failed',
      emailId: '<abc@mailgun>',
    });
  });

  it('ignores events with no delivery equivalent', () => {
    expect(parseMailgunDeliveryEvent(base('opened'))).toBeUndefined();
    expect(parseMailgunDeliveryEvent(base('clicked'))).toBeUndefined();
    expect(parseMailgunDeliveryEvent({})).toBeUndefined();
  });
});

describe('MailgunProvider.getInboundEmail', () => {
  it('rejects a bare id without a storage URL', async () => {
    const { provider } = providerWith({});
    await expect(provider.getInboundEmail('key1')).rejects.toThrow('full storage URL');
  });

  it('fetches the stored message and parses body-mime', async () => {
    const storageUrl =
      'https://storage-us-east4.api.mailgun.net/v3/domains/example.com/messages/key1';
    const { provider } = providerWith({
      [storageUrl]: {
        status: 200,
        body: {
          'body-mime': BODY_MIME,
          attachments: [
            {
              url: `${storageUrl}/attachments/0`,
              name: 'doc.pdf',
              'content-type': 'application/pdf',
              size: 9,
            },
          ],
        },
      },
    });
    const email = await provider.getInboundEmail(storageUrl);
    expect(email.id).toBe('<m1@example.com>');
    expect(email.from).toEqual({ address: 'alice@example.com', name: 'Alice' });
    expect(email.subject).toBe('hello');
    expect(email.bodyText).toContain('plain body');
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      filename: 'doc.pdf',
      mime: 'application/pdf',
      downloadUrl: `${storageUrl}/attachments/0`,
    });
  });
});

describe('MailgunProvider.listSentEmails', () => {
  it('maps accepted events from the events API', async () => {
    const { provider, seen } = providerWith({
      'https://api.mailgun.net/v3/example.com/events': {
        status: 200,
        body: {
          items: [
            {
              timestamp: 1760000000,
              message: {
                headers: {
                  'message-id': '<abc@mailgun>',
                  from: 'ops@example.com',
                  to: 'user@example.com',
                  subject: 'hi',
                },
              },
            },
          ],
        },
      },
    });
    const rows = await provider.listSentEmails({ domain: 'example.com', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '<abc@mailgun>',
      from: 'ops@example.com',
      to: ['user@example.com'],
      subject: 'hi',
      status: 'sent',
    });
    expect(rows[0]!.dateMs).toBe(1760000000 * 1000);
    expect(seen[0]!.url).toContain('event=accepted');
  });

  it('refuses to list without a domain', async () => {
    const { provider } = providerWith({});
    await expect(provider.listSentEmails({})).rejects.toThrow('not supported without a domain');
  });
});
