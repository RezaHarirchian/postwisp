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
import type { Store } from '../src/core/store.js';
import type { EmailEvent } from '../src/providers/interface.js';
import {
  cfAttachmentKey,
  readStashedAttachment,
  registerCloudflareIngest,
  stashAttachmentBytes,
} from '../src/server/cloudflare-ingest.js';
import {
  readCloudflareStashedAttachment,
  readStashedAttachment as readProviderStashedAttachment,
  stashAttachmentKey,
  stashCloudflareAttachments,
  stashInlineAttachments,
} from '../src/server/attachment-stash.js';

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

function basePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'cf-test-id-1',
    from: { address: 'alice@example.com', name: 'Alice' },
    to: ['inbox@example.com'],
    cc: [],
    subject: 'hello',
    dateMs: Date.now(),
    text: 'hello world',
    html: null,
    headers: { 'message-id': '<m1@example.com>' },
    attachments: [],
    ...overrides,
  });
}

function signedHeaders(rawBody: string, secret = SECRET): Record<string, string> {
  const signature = createHmac('sha256', secret).update(rawBody).digest('hex');
  return {
    'x-postwisp-signature': signature,
    'x-postwisp-timestamp': String(Math.floor(Date.now() / 1000)),
  };
}

interface IngestHarness {
  kv: Map<string, string>;
  seen: Set<string>;
  events: EmailEvent[];
  logs: string[];
  post: (
    rawBody: string,
    headers: Record<string, string>,
    contentType?: string,
  ) => Promise<{ status: number; body: string }>;
}

async function buildHarness(
  opts: { onEvent?: (event: EmailEvent) => Promise<void>; secret?: string } = {},
): Promise<IngestHarness> {
  const kv = new Map<string, string>();
  const seen = new Set<string>();
  const events: EmailEvent[] = [];
  const logs: string[] = [];
  const store = {
    get: (key: string) => kv.get(key) ?? null,
    set: (key: string, value: string) => {
      kv.set(key, value);
    },
    getEmailMeta: (_id: string) => null,
  } as unknown as Store;

  const app = Fastify({ logger: false });
  registerCloudflareIngest(app, {
    secret: opts.secret ?? SECRET,
    hasWebhookEvent: (id: string) => seen.has(id),
    noteWebhookEvent: (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    },
    onEvent:
      opts.onEvent ??
      (async (event) => {
        events.push(event);
      }),
    logger: nullLogger(logs),
    store,
  });
  await app.ready();

  return {
    kv,
    seen,
    events,
    logs,
    post: async (rawBody, headers, contentType = 'application/json') => {
      const response = await app.inject({
        method: 'POST',
        url: '/ingest/cloudflare',
        headers: { 'content-type': contentType, ...headers },
        payload: rawBody,
      });
      return { status: response.statusCode, body: response.body };
    },
  };
}

describe('POST /ingest/cloudflare', () => {
  it('verifies, normalizes and hands the event off', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    const { status, body } = await h.post(rawBody, signedHeaders(rawBody));
    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(h.events).toHaveLength(1);
    const event = h.events[0]!;
    expect(event.id).toBe('cf-test-id-1');
    expect(event.provider).toBe('cloudflare');
    expect(event.domain).toBe('example.com');
    expect(event.from).toEqual({ address: 'alice@example.com', name: 'Alice' });
    expect(event.subject).toBe('hello');
    expect(event.bodyText).toBe('hello world');
    expect(event.snippet).toBe('hello world');
    expect(event.headers).toEqual({ 'message-id': '<m1@example.com>' });
    // The secret and the raw payload never reach the logs.
    expect(h.logs.join('\n')).not.toContain(SECRET);
  });

  it('rejects a tampered body with 401', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    const headers = signedHeaders(rawBody);
    const tampered = rawBody.replace('hello world', 'evil world');
    const { status, body } = await h.post(tampered, headers);
    expect(status).toBe(401);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'unauthorized' });
    expect(h.events).toHaveLength(0);
    // No internals leak into the rejection response.
    expect(body).not.toContain('signature');
  });

  it('rejects a wrong signing secret with 401', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    const headers = signedHeaders(rawBody, randomBytes(32).toString('hex'));
    const { status } = await h.post(rawBody, headers);
    expect(status).toBe(401);
    expect(h.events).toHaveLength(0);
  });

  it('rejects missing or malformed signature and timestamp headers with 401', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    const headers = signedHeaders(rawBody);
    const cases: Record<string, string>[] = [
      { 'x-postwisp-timestamp': headers['x-postwisp-timestamp']! }, // no signature
      { 'x-postwisp-signature': headers['x-postwisp-signature']! }, // no timestamp
      {}, // neither
      { ...headers, 'x-postwisp-timestamp': 'not-a-number' }, // malformed timestamp
    ];
    for (const c of cases) {
      const { status } = await h.post(rawBody, c);
      expect(status).toBe(401);
    }
    expect(h.events).toHaveLength(0);
  });

  it('rejects stale and future timestamps with 401', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    const nowS = Math.floor(Date.now() / 1000);
    for (const ts of [nowS - 360, nowS + 360]) {
      const headers = {
        'x-postwisp-signature': createHmac('sha256', SECRET).update(rawBody).digest('hex'),
        'x-postwisp-timestamp': String(ts),
      };
      const { status } = await h.post(rawBody, headers);
      expect(status).toBe(401);
    }
    expect(h.events).toHaveLength(0);
  });

  it('processes a retried payload id exactly once', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    const headers = signedHeaders(rawBody);
    const first = await h.post(rawBody, headers);
    const second = await h.post(rawBody, headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.events).toHaveLength(1);
    expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });
  });

  it('does not reprocess a payload id when the handler fails: the claim is held', async () => {
    let attempts = 0;
    const processed: EmailEvent[] = [];
    const h = await buildHarness({
      onEvent: async (event) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
        processed.push(event);
      },
    });
    const rawBody = basePayload();
    const headers = signedHeaders(rawBody);
    const first = await h.post(rawBody, headers);
    expect(first.status).toBe(500);
    // The id was claimed before the handler ran, so the worker retry is a
    // duplicate: a poisoned payload cannot be reprocessed into a double
    // owner notification, at the cost of no retry on handler failure.
    const second = await h.post(rawBody, headers);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ ok: true, duplicate: true });
    expect(processed).toHaveLength(0);
    expect(attempts).toBe(1);
  });

  it('rejects invalid JSON with 400', async () => {
    const h = await buildHarness();
    const rawBody = 'this is not json';
    const { status, body } = await h.post(rawBody, signedHeaders(rawBody));
    expect(status).toBe(400);
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'invalid payload' });
    expect(h.events).toHaveLength(0);
  });

  it('rejects a payload missing required fields with 400', async () => {
    const h = await buildHarness();
    for (const overrides of [
      { id: undefined },
      { from: { address: '' } },
      { to: 'not-an-array' },
    ]) {
      const payload = JSON.parse(basePayload());
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete payload[k];
        else payload[k] = v;
      }
      const rawBody = JSON.stringify(payload);
      const { status } = await h.post(rawBody, signedHeaders(rawBody));
      expect(status).toBe(400);
    }
    expect(h.events).toHaveLength(0);
  });

  it('rejects a wrong content type before verification ever runs', async () => {
    const h = await buildHarness();
    const rawBody = basePayload();
    // Not application/json: there is no raw body to verify, so the request
    // is rejected outright and the event is never processed.
    const { status } = await h.post(rawBody, signedHeaders(rawBody), 'text/plain');
    expect(status).toBe(400);
    expect(h.events).toHaveLength(0);
  });
});

describe('attachment kv stash and the download fallback', () => {
  const attB64 = Buffer.from('file-bytes').toString('base64');

  it('stashes inline attachment bytes in kv and reads them back with the stored filename', async () => {
    const h = await buildHarness();
    const rawBody = basePayload({
      id: 'cf-att-1',
      attachments: [
        { id: 'a1', filename: 'report.pdf', size: 10, mime: 'application/pdf', contentBase64: attB64 },
        { id: 'a2', filename: 'big.bin', size: 99, mime: 'application/octet-stream', truncated: true },
      ],
    });
    const { status } = await h.post(rawBody, signedHeaders(rawBody));
    expect(status).toBe(200);
    expect(h.kv.get(cfAttachmentKey('cf-att-1', 'a1'))).toBe(attB64);
    // Truncated entries carry no bytes: nothing is stashed for them.
    expect(h.kv.has(cfAttachmentKey('cf-att-1', 'a2'))).toBe(false);
    // The event still lists both attachments so the owner sees them.
    expect(h.events[0]!.attachments).toHaveLength(2);

    const store = {
      get: (key: string) => h.kv.get(key) ?? null,
      getEmailMeta: (_id: string) => ({
        attachments: [{ id: 'a1', filename: 'report.pdf', size: 10, mime: 'application/pdf' }],
      }),
    } as unknown as Store;
    const stashed = readStashedAttachment(store, 'cf-att-1', 'a1');
    expect(stashed).toEqual({ found: true, filename: 'report.pdf', data: Buffer.from('file-bytes') });

    const missing = readStashedAttachment(store, 'cf-att-1', 'a2');
    expect(missing).toEqual({ found: false, reason: 'missing' });

    // A gone email row degrades to a bare attachment id, never a crash.
    const noRow = readStashedAttachment(
      { ...store, getEmailMeta: () => null } as unknown as Store,
      'cf-att-1',
      'a1',
    );
    expect(noRow).toEqual({ found: true, filename: 'a1.bin', data: Buffer.from('file-bytes') });
  });

  it('skips entries that would exceed the 20MB per-email kv cap', async () => {
    // Tested directly: pushing megabytes through HTTP would only exercise
    // Fastify's body limit, not the kv cap.
    const kv = new Map<string, string>();
    const store = {
      get: (key: string) => kv.get(key) ?? null,
      set: (key: string, value: string) => {
        kv.set(key, value);
      },
    } as unknown as Store;
    const chunk = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
    const att = (id: string) => ({
      id,
      filename: `${id}.bin`,
      size: chunk.length,
      mime: 'application/octet-stream',
      contentBase64: chunk,
    });
    stashAttachmentBytes(store, 'cf-att-cap', [att('big1'), att('big2')]);
    // The first 11MB entry fits under 20MB; the second would exceed it.
    expect(kv.has(cfAttachmentKey('cf-att-cap', 'big1'))).toBe(true);
    expect(kv.has(cfAttachmentKey('cf-att-cap', 'big2'))).toBe(false);
  });

  it('shares one stash implementation across the provider and cloudflare namespaces', () => {
    const kv = new Map<string, string>();
    const store = {
      get: (key: string) => kv.get(key) ?? null,
      set: (key: string, value: string) => {
        kv.set(key, value);
      },
      getEmailMeta: () => null,
    } as unknown as Store;
    // Both writers go through the same core with disjoint key namespaces.
    stashInlineAttachments(store, 'mailgun', 'e1', [
      { id: 'a1', filename: 'f.bin', content: Buffer.from('x') },
    ]);
    stashCloudflareAttachments(store, 'e1', [
      { id: 'a1', contentBase64: Buffer.from('y').toString('base64') },
    ]);
    expect(kv.has(stashAttachmentKey('mailgun', 'e1', 'a1'))).toBe(true);
    expect(kv.has(cfAttachmentKey('e1', 'a1'))).toBe(true);
    // And each reader sees only its own namespace.
    expect(readProviderStashedAttachment(store, 'mailgun', 'e1', 'a1')).toEqual({
      found: true,
      filename: 'a1.bin',
      data: Buffer.from('x'),
    });
    expect(readCloudflareStashedAttachment(store, 'e1', 'a1')).toEqual({
      found: true,
      filename: 'a1.bin',
      data: Buffer.from('y'),
    });
  });
});
