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
import { describe, expect, it } from 'vitest';
import { normalizeResendInbound, parseAddress } from '../src/providers/normalize.js';
import { ResendEmailProvider } from '../src/providers/resend.js';
import attachmentsList from './fixtures/resend-attachments-list.json';
import inboundFull from './fixtures/resend-inbound-full.json';

const API_KEY = 're_test_key';

// Every response is canned; no network leaves this file.
function fakeFetch(routes: Record<string, { status: number; body: unknown; bytes?: Buffer }>) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const urlString = String(url);
    seen.push({ url: urlString, init: init ?? {} });
    const headers = new Headers(init?.headers);
    // Attachment bytes come from signed third-party urls: no auth header.
    if (urlString.startsWith('https://api.resend.com')) {
      expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
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

function providerWith(routes: Record<string, { status: number; body: unknown; bytes?: Buffer }>) {
  const { fetchFn, seen } = fakeFetch(routes);
  return { provider: new ResendEmailProvider({ apiKey: API_KEY, fetchFn }), seen };
}

function sign(secret: string, id: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(rawBody).digest('base64');
}

describe('ResendEmailProvider.send', () => {
  it('posts to /emails and returns the id', async () => {
    const { provider, seen } = providerWith({
      'https://api.resend.com/emails': { status: 200, body: { id: 'sent_123' } },
    });
    const result = await provider.send({
      from: 'ops@inbox.postwisp.dev',
      to: ['user@example.com'],
      subject: 'hello',
      text: 'hi',
      idempotencyKey: 'key-1',
    });
    expect(result).toEqual({ id: 'sent_123' });
    const call = seen[0]!;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.init.method).toBe('POST');
    const headers = new Headers(call.init.headers);
    expect(headers.get('idempotency-key')).toBe('key-1');
    const body = JSON.parse(String(call.init.body));
    expect(body.from).toBe('ops@inbox.postwisp.dev');
    expect(body.to).toEqual(['user@example.com']);
    expect(body.subject).toBe('hello');
  });

  it('surfaces resend errors', async () => {
    const { provider } = providerWith({
      'https://api.resend.com/emails': { status: 422, body: { message: 'bad' } },
    });
    await expect(
      provider.send({ from: 'a@b.c', to: ['d@e.f'], subject: 'x' }),
    ).rejects.toThrow('422');
  });
});

describe('ResendEmailProvider.getInboundEmail', () => {
  it('joins the full email with signed attachment urls', async () => {
    const { provider } = providerWith({
      'https://api.resend.com/emails/receiving/56761188-7520-42d8-8898-ff6fc54ce618/attachments': {
        status: 200,
        body: attachmentsList,
      },
      'https://api.resend.com/emails/receiving/56761188-7520-42d8-8898-ff6fc54ce618': {
        status: 200,
        body: inboundFull,
      },
    });
    const email = await provider.getInboundEmail('56761188-7520-42d8-8898-ff6fc54ce618');
    expect(email.id).toBe('56761188-7520-42d8-8898-ff6fc54ce618');
    expect(email.from).toEqual({ address: 'alerts@acme.dev', name: 'Acme Alerts' });
    expect(email.to).toEqual(['ops@inbox.postwisp.dev']);
    expect(email.subject).toBe('Your one-time code is 482913');
    expect(email.bodyText).toContain('482913');
    expect(email.bodyHtml).toContain('<b>482913</b>');
    expect(email.dateMs).toBe(Date.parse('Sat, 10 Oct 2026 18:05:11 +0000'));
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      id: '2a0c9ce0-3112-4728-976e-47ddcd16a318',
      filename: 'avatar.png',
      size: 48210,
      mime: 'image/png',
    });
    expect(email.attachments[0]!.downloadUrl).toContain('s3.amazonaws.com');
    expect(email.threadId).toBeNull();
    expect(email.headers['message-id']).toBe('<111-222-333@acme.dev>');
  });
});

describe('ResendEmailProvider.downloadAttachment', () => {
  it('downloads bytes from allowed hosts', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const { provider } = providerWith({
      'https://s3.amazonaws.com/resend-attachments/': { status: 200, body: null, bytes },
    });
    const out = await provider.downloadAttachment(
      'https://s3.amazonaws.com/resend-attachments/a/avatar.png?sig=xyz',
    );
    expect(out.equals(bytes)).toBe(true);
  });

  it('refuses non-resend hosts', async () => {
    const { provider } = providerWith({});
    await expect(provider.downloadAttachment('https://evil.example/a.png')).rejects.toThrow(
      'refusing to download',
    );
    await expect(provider.downloadAttachment('not a url')).rejects.toThrow(
      'refusing to download',
    );
  });
});

describe('ResendEmailProvider.listSentEmails', () => {
  const listBody = {
    object: 'list',
    data: [
      {
        id: 's1',
        from: 'ops@inbox.postwisp.dev',
        to: ['a@x.dev'],
        subject: 'one',
        created_at: '2026-10-10T10:00:00Z',
        status: 'delivered',
      },
      {
        id: 's2',
        from: 'ops@other.dev',
        to: ['b@x.dev'],
        subject: 'two',
        created_at: '2026-10-10T11:00:00Z',
        status: 'sent',
      },
    ],
  };

  it('passes limit and filters by domain locally', async () => {
    const { provider, seen } = providerWith({
      'https://api.resend.com/emails': { status: 200, body: listBody },
    });
    const emails = await provider.listSentEmails({ domain: 'inbox.postwisp.dev', limit: 5 });
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ id: 's1', status: 'delivered' });
    expect(seen[0]!.url).toBe('https://api.resend.com/emails?limit=5');
  });
});

describe('ResendEmailProvider.verifyWebhook', () => {
  const secret = randomBytes(32).toString('hex');
  const rawBody = Buffer.from('{"type":"email.received"}');
  const id = 'msg_123';
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = (sig: string) => ({
    'svix-id': id,
    'svix-timestamp': ts,
    'svix-signature': sig,
  });

  it('accepts a valid signature', () => {
    const provider = new ResendEmailProvider({ apiKey: API_KEY });
    expect(
      provider.verifyWebhook(rawBody, headers(`v1,${sign(secret, id, ts, rawBody)}`), secret),
    ).toEqual({ ok: true });
  });

  it('accepts when any of several v1 signatures matches', () => {
    const provider = new ResendEmailProvider({ apiKey: API_KEY });
    const good = `v1,${sign(secret, id, ts, rawBody)}`;
    expect(
      provider.verifyWebhook(rawBody, headers(`v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good}`), secret),
    ).toEqual({ ok: true });
  });

  it('rejects missing headers', () => {
    const provider = new ResendEmailProvider({ apiKey: API_KEY });
    expect(provider.verifyWebhook(rawBody, {}, secret).ok).toBe(false);
    expect(provider.verifyWebhook(rawBody, { 'svix-id': id }, secret).ok).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const provider = new ResendEmailProvider({ apiKey: API_KEY });
    const bad = sign(secret, id, ts, Buffer.from('{"type":"email.sent"}'));
    const result = provider.verifyWebhook(rawBody, headers(`v1,${bad}`), secret);
    expect(result).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects a stale timestamp', () => {
    const provider = new ResendEmailProvider({ apiKey: API_KEY });
    const oldTs = String(Math.floor(Date.now() / 1000) - 301);
    const sig = `v1,${sign(secret, id, oldTs, rawBody)}`;
    const result = provider.verifyWebhook(
      rawBody,
      { 'svix-id': id, 'svix-timestamp': oldTs, 'svix-signature': sig },
      secret,
    );
    expect(result).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });
});

describe('normalizeResendInbound', () => {
  it('maps the documented receiving payload to an EmailEvent', () => {
    const event = normalizeResendInbound(inboundFull);
    expect(event.id).toBe('56761188-7520-42d8-8898-ff6fc54ce618');
    expect(event.provider).toBe('resend');
    expect(event.domain).toBe('inbox.postwisp.dev');
    expect(event.from).toEqual({ address: 'alerts@acme.dev', name: 'Acme Alerts' });
    expect(event.to).toEqual(['ops@inbox.postwisp.dev']);
    expect(event.subject).toBe('Your one-time code is 482913');
    expect(event.snippet).toBe('Your one-time code is 482913. It expires in 10 minutes.');
    expect(event.bodyText).toContain('482913');
    expect(event.bodyHtml).toContain('<b>482913</b>');
    expect(event.attachments).toEqual([
      { id: '2a0c9ce0-3112-4728-976e-47ddcd16a318', filename: 'avatar.png', size: 48210, mime: 'image/png' },
    ]);
    expect(event.threadId).toBeNull();
    expect(event.headers['from']).toBe('Acme Alerts <alerts@acme.dev>');
    // Signed urls never survive normalization; the bot downloads bytes.
    expect(JSON.stringify(event)).not.toContain('s3.amazonaws.com');
  });

  it('threads on in-reply-to', () => {
    const payload = {
      ...inboundFull,
      headers: { ...inboundFull.headers, 'In-Reply-To': '<parent@acme.dev>' },
    };
    expect(normalizeResendInbound(payload).threadId).toBe('<parent@acme.dev>');
  });

  it('is total on garbage input', () => {
    expect(() => normalizeResendInbound(undefined)).not.toThrow();
    expect(() => normalizeResendInbound({ to: 'not-an-array' })).not.toThrow();
    const event = normalizeResendInbound(undefined);
    expect(event.provider).toBe('resend');
    expect(event.attachments).toEqual([]);
  });
});

describe('parseAddress', () => {
  it('splits name and address', () => {
    expect(parseAddress('Acme <a@b.c>')).toEqual({ address: 'a@b.c', name: 'Acme' });
    expect(parseAddress('a@b.c')).toEqual({ address: 'a@b.c' });
    expect(parseAddress('"Doe, Jane" <j@d.e>')).toEqual({ address: 'j@d.e', name: 'Doe, Jane' });
  });
});
