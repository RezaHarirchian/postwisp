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
import type { DeliveryEvent, EmailProvider, SendInput } from '../src/providers/interface.js';
import { ResendEmailProvider } from '../src/providers/resend.js';
import { MailerSendProvider, parseMailerSendDeliveryEvent } from '../src/providers/mailersend.js';
import { MailgunProvider, parseMailgunDeliveryEvent } from '../src/providers/mailgun.js';
import { deliveryEventType } from '../src/server/resend-webhook.js';

// Shared contract matrix: the same behavioral assertions run against every
// provider adapter with an injected fake fetch. Provider-specific quirks
// (Mailgun form parsing, the MailerSend test-secret ping, MIME edge cases)
// live in the focused test files, not here.

interface SeenCall {
  url: string;
  init: RequestInit;
}

interface CannedRoute {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function fakeFetch(routes: Record<string, CannedRoute>) {
  const seen: SeenCall[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const urlString = String(url);
    seen.push({ url: urlString, init: init ?? {} });
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

interface WebhookCase {
  goodBody: Buffer;
  goodHeaders: Record<string, string | string[] | undefined>;
  tamperedBody: Buffer;
  // A payload that carries no signature material at all.
  missingBody: Buffer;
  missingHeaders: Record<string, string | string[] | undefined>;
  goodSecret: string;
  wrongSecret: string;
}

interface DeliveryCase {
  map: (envelope: unknown) => DeliveryEvent | undefined;
  deliveredEnvelope: unknown;
  bouncedEnvelope: unknown;
  expectedId: string;
}

interface ProviderCase {
  providerName: string;
  create: (fetchFn: typeof fetch) => EmailProvider;
  sendRoutes: Record<string, CannedRoute>;
  expectedSendId: string;
  assertSendWire: (seen: SeenCall[]) => void;
  sendErrorRoutes: Record<string, CannedRoute>;
  sendErrorPattern: RegExp;
  webhook: WebhookCase;
  delivery: DeliveryCase;
}

const SEND_INPUT: SendInput = {
  from: 'ops@example.com',
  to: ['user@example.com'],
  subject: 'contract',
  text: 'body',
};

function resendSignature(secret: string, id: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.`).update(rawBody).digest('base64');
}

const RESEND_BODY = Buffer.from(JSON.stringify({ type: 'email.received', data: {} }));
const RESEND_ID = 'wh_123';
const RESEND_TS = String(Math.floor(Date.now() / 1000));
const RESEND_SECRET = 'resend-secret';

function mailgunSignature(secret: string, timestamp: string, token: string): string {
  return createHmac('sha256', secret).update(`${timestamp}${token}`).digest('hex');
}

const MG_TS = String(Math.floor(Date.now() / 1000));
const MG_TOKEN = 'mg-token';
const MG_SECRET = 'mailgun-secret';
const MG_GOOD_FORM = Buffer.from(
  new URLSearchParams({
    timestamp: MG_TS,
    token: MG_TOKEN,
    signature: mailgunSignature(MG_SECRET, MG_TS, MG_TOKEN),
    'body-mime': 'x',
  }).toString(),
);
const MG_TAMPERED_FORM = Buffer.from(
  new URLSearchParams({
    timestamp: MG_TS,
    token: 'other-token',
    signature: mailgunSignature(MG_SECRET, MG_TS, MG_TOKEN),
    'body-mime': 'x',
  }).toString(),
);

const MS_BODY = Buffer.from(JSON.stringify({ type: 'activity.delivered', data: {} }));
const MS_SECRET = 'mailersend-secret';

const CASES: ProviderCase[] = [
  {
    providerName: 'resend',
    create: (fetchFn) => new ResendEmailProvider({ apiKey: 're_k', fetchFn }),
    sendRoutes: { 'https://api.resend.com/emails': { status: 200, body: { id: 're_1' } } },
    expectedSendId: 're_1',
    assertSendWire: (seen) => {
      const call = seen[0]!;
      expect(call.url).toBe('https://api.resend.com/emails');
      expect(call.init.method).toBe('POST');
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer re_k');
      const body = JSON.parse(String(call.init.body));
      expect(body.from).toBe('ops@example.com');
      expect(body.to).toEqual(['user@example.com']);
      expect(body.subject).toBe('contract');
    },
    sendErrorRoutes: {
      'https://api.resend.com/emails': { status: 422, body: { message: 'bad request' } },
    },
    sendErrorPattern: /422/,
    webhook: {
      goodBody: RESEND_BODY,
      goodHeaders: {
        'svix-id': RESEND_ID,
        'svix-timestamp': RESEND_TS,
        'svix-signature': `v1,${resendSignature(RESEND_SECRET, RESEND_ID, RESEND_TS, RESEND_BODY)}`,
      },
      tamperedBody: Buffer.from(JSON.stringify({ type: 'email.received', data: { x: 1 } })),
      missingBody: RESEND_BODY,
      missingHeaders: {},
      goodSecret: RESEND_SECRET,
      wrongSecret: 'wrong',
    },
    delivery: {
      map: (envelope) => {
        const rec = envelope as { type?: unknown; data?: { email_id?: unknown } };
        const mapped = deliveryEventType(rec.type);
        if (!mapped) return undefined;
        const emailId = typeof rec.data?.email_id === 'string' ? rec.data.email_id : '';
        return { type: mapped, emailId };
      },
      deliveredEnvelope: { type: 'email.delivered', data: { email_id: 're_1' } },
      bouncedEnvelope: { type: 'email.bounced', data: { email_id: 're_1' } },
      expectedId: 're_1',
    },
  },
  {
    providerName: 'mailersend',
    create: (fetchFn) => new MailerSendProvider({ apiKey: 'ms_k', fetchFn }),
    sendRoutes: {
      'https://api.mailersend.com/v1/email': {
        status: 202,
        headers: { 'x-message-id': 'ms_1' },
      },
    },
    expectedSendId: 'ms_1',
    assertSendWire: (seen) => {
      const call = seen[0]!;
      expect(call.url).toBe('https://api.mailersend.com/v1/email');
      expect(call.init.method).toBe('POST');
      expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer ms_k');
      const body = JSON.parse(String(call.init.body));
      expect(body.from).toEqual({ email: 'ops@example.com' });
      expect(body.to).toEqual([{ email: 'user@example.com' }]);
      expect(body.subject).toBe('contract');
    },
    sendErrorRoutes: {
      'https://api.mailersend.com/v1/email': {
        status: 422,
        body: { message: 'The given data was invalid.' },
      },
    },
    sendErrorPattern: /422.*invalid/,
    webhook: {
      goodBody: MS_BODY,
      goodHeaders: {
        signature: createHmac('sha256', MS_SECRET).update(MS_BODY).digest('hex'),
      },
      tamperedBody: Buffer.from(JSON.stringify({ type: 'activity.delivered', data: { x: 1 } })),
      missingBody: MS_BODY,
      missingHeaders: {},
      goodSecret: MS_SECRET,
      wrongSecret: 'wrong',
    },
    delivery: {
      map: parseMailerSendDeliveryEvent,
      deliveredEnvelope: {
        type: 'activity.delivered',
        data: { email: { message: { id: 'ms_1' } } },
      },
      bouncedEnvelope: {
        type: 'activity.hard_bounced',
        data: { email: { message: { id: 'ms_1' } } },
      },
      expectedId: 'ms_1',
    },
  },
  {
    providerName: 'mailgun',
    create: (fetchFn) => new MailgunProvider({ apiKey: 'mg_k', fetchFn }),
    sendRoutes: {
      'https://api.mailgun.net/v3/example.com/messages': {
        status: 200,
        body: { id: '<mg1@mailgun>', message: 'Queued.' },
      },
    },
    expectedSendId: '<mg1@mailgun>',
    assertSendWire: (seen) => {
      const call = seen[0]!;
      expect(call.url).toBe('https://api.mailgun.net/v3/example.com/messages');
      expect(call.init.method).toBe('POST');
      expect(new Headers(call.init.headers).get('authorization')).toBe(
        `Basic ${Buffer.from('api:mg_k', 'utf8').toString('base64')}`,
      );
      const body = new URLSearchParams(String(call.init.body));
      expect(body.get('from')).toBe('ops@example.com');
      expect(body.get('to')).toBe('user@example.com');
      expect(body.get('subject')).toBe('contract');
    },
    sendErrorRoutes: {
      'https://api.mailgun.net/v3/example.com/messages': {
        status: 401,
        body: { message: 'Invalid private key' },
      },
    },
    sendErrorPattern: /401.*Invalid private key/,
    webhook: {
      goodBody: MG_GOOD_FORM,
      goodHeaders: {},
      tamperedBody: MG_TAMPERED_FORM,
      // No timestamp/token/signature fields anywhere.
      missingBody: Buffer.from(new URLSearchParams({ 'body-mime': 'x' }).toString()),
      missingHeaders: {},
      goodSecret: MG_SECRET,
      wrongSecret: 'wrong',
    },
    delivery: {
      map: parseMailgunDeliveryEvent,
      deliveredEnvelope: {
        'event-data': {
          event: 'delivered',
          message: { headers: { 'message-id': '<mg1@mailgun>' } },
        },
      },
      bouncedEnvelope: {
        'event-data': {
          event: 'failed',
          severity: 'permanent',
          message: { headers: { 'message-id': '<mg1@mailgun>' } },
        },
      },
      expectedId: '<mg1@mailgun>',
    },
  },
];

for (const c of CASES) {
  describe(`provider contract: ${c.providerName}`, () => {
    it('send() produces the documented wire shape and returns the provider id', async () => {
      const { fetchFn, seen } = fakeFetch(c.sendRoutes);
      const result = await c.create(fetchFn).send(SEND_INPUT);
      expect(result).toEqual({ id: c.expectedSendId });
      c.assertSendWire(seen);
    });

    it('send() maps a 4xx into a clear Error', async () => {
      const { fetchFn } = fakeFetch(c.sendErrorRoutes);
      await expect(c.create(fetchFn).send(SEND_INPUT)).rejects.toThrow(c.sendErrorPattern);
    });

    it('verifyWebhook accepts a correctly signed payload', () => {
      const { fetchFn } = fakeFetch({});
      const result = c.create(fetchFn).verifyWebhook(
        c.webhook.goodBody,
        c.webhook.goodHeaders,
        c.webhook.goodSecret,
      );
      expect(result).toEqual({ ok: true });
    });

    it('verifyWebhook rejects tampered, wrong-secret, and missing signatures', () => {
      const { fetchFn } = fakeFetch({});
      const provider = c.create(fetchFn);
      const tampered = provider.verifyWebhook(
        c.webhook.tamperedBody,
        c.webhook.goodHeaders,
        c.webhook.goodSecret,
      );
      expect(tampered.ok).toBe(false);
      const wrongSecret = provider.verifyWebhook(
        c.webhook.goodBody,
        c.webhook.goodHeaders,
        c.webhook.wrongSecret,
      );
      expect(wrongSecret.ok).toBe(false);
      const missing = provider.verifyWebhook(
        c.webhook.missingBody,
        c.webhook.missingHeaders,
        c.webhook.goodSecret,
      );
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.reason.length).toBeGreaterThan(0);
      }
    });

    it('delivery-event mapping covers delivered and bounced', () => {
      expect(c.delivery.map(c.delivery.deliveredEnvelope)).toEqual({
        type: 'delivered',
        emailId: c.delivery.expectedId,
      });
      expect(c.delivery.map(c.delivery.bouncedEnvelope)).toEqual({
        type: 'bounced',
        emailId: c.delivery.expectedId,
      });
    });

    it('capabilities flags are booleans', () => {
      const { fetchFn } = fakeFetch({});
      const caps = c.create(fetchFn).capabilities;
      expect(typeof caps.scheduling).toBe('boolean');
      expect(typeof caps.batch).toBe('boolean');
    });
  });
}
