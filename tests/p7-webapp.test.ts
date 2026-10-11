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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/server/index.js';
import { registerWebapp, verifyInitData } from '../src/server/webapp.js';
import { openStore, type EmailMeta, type Store } from '../src/core/store.js';
import { createLogger } from '../src/core/logger.js';
import { defaultConfig } from '../src/core/config.js';
import { startSystem } from '../src/index.js';
import { Writable } from 'node:stream';

const BOT_TOKEN = 'test-bot-token-123';

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

function quietLogger() {
  return createLogger({ stream: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

// Mints initData the same way Telegram does: sorted fields, HMAC with the
// WebAppData-derived key. postTamper runs after the hash is set, simulating
// a captured payload with a modified field.
function mintInitData(
  botToken: string,
  authDateSec: number,
  postTamper?: (p: URLSearchParams) => void,
): string {
  const params = new URLSearchParams({
    auth_date: String(authDateSec),
    query_id: 'q1',
    user: JSON.stringify({ id: 7, first_name: 'Owner' }),
  });
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(pairs.join('\n')).digest('hex');
  params.set('hash', hash);
  if (postTamper) postTamper(params);
  return params.toString();
}

function seedEmail(store: Store): void {
  const meta: EmailMeta = {
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    fromAddr: 'boss@example.com',
    subject: 'Hello',
    receivedAt: 1000,
    read: false,
    archived: false,
    trashed: false,
    labels: [],
    threadId: null,
    bodyText: 'Body here.',
  };
  store.saveEmailMeta(meta);
}

function authedHeaders(initData: string): Record<string, string> {
  return { 'x-telegram-init-data': initData };
}

describe('verifyInitData', () => {
  const nowMs = 1_800_000_000_000;

  it('accepts freshly minted initData', () => {
    const initData = mintInitData(BOT_TOKEN, Math.floor(nowMs / 1000) - 60);
    expect(verifyInitData(initData, BOT_TOKEN, nowMs)).toBe(true);
  });

  it('rejects a tampered field', () => {
    const initData = mintInitData(BOT_TOKEN, Math.floor(nowMs / 1000) - 60, (p) =>
      p.set('query_id', 'evil'),
    );
    expect(verifyInitData(initData, BOT_TOKEN, nowMs)).toBe(false);
  });

  it('rejects the wrong bot token', () => {
    const initData = mintInitData('other-token', Math.floor(nowMs / 1000) - 60);
    expect(verifyInitData(initData, BOT_TOKEN, nowMs)).toBe(false);
  });

  it('rejects a missing hash', () => {
    expect(verifyInitData('auth_date=1&query_id=q', BOT_TOKEN, nowMs)).toBe(false);
  });

  it('rejects stale initData', () => {
    const initData = mintInitData(BOT_TOKEN, Math.floor(nowMs / 1000) - 90000);
    expect(verifyInitData(initData, BOT_TOKEN, nowMs)).toBe(false);
  });

  it('rejects garbage', () => {
    expect(verifyInitData('not-a-query-string%%%', BOT_TOKEN, nowMs)).toBe(false);
  });
});

describe('webapp routes', () => {
  async function setup() {
    const store = memStore();
    seedEmail(store);
    const app = createServer({ logger: quietLogger() });
    registerWebapp(app, { store, botToken: BOT_TOKEN, logger: quietLogger() });
    await app.ready();
    const initData = mintInitData(BOT_TOKEN, Math.floor(Date.now() / 1000) - 60);
    return { store, app, initData };
  }

  it('serves the inbox page without auth', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/webapp' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('telegram-web-app.js');
  });

  it('rejects API calls without initData', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/webapp/api/emails' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects API calls with forged initData', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/webapp/api/emails',
      headers: authedHeaders('auth_date=1&hash=deadbeef'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists emails with valid initData', async () => {
    const { app, initData } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/webapp/api/emails',
      headers: authedHeaders(initData),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0].subject).toBe('Hello');
  });

  it('opening an email marks it read', async () => {
    const { store, app, initData } = await setup();
    const res = await app.inject({
      method: 'GET',
      url: '/webapp/api/emails/em_1',
      headers: authedHeaders(initData),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email.bodyText).toBe('Body here.');
    expect(store.getEmailMeta('em_1')?.read).toBe(true);
  });

  it('archives an email and returns 404 for unknown ids', async () => {
    const { store, app, initData } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/webapp/api/emails/em_1/archive',
      headers: authedHeaders(initData),
    });
    expect(res.statusCode).toBe(200);
    expect(store.getEmailMeta('em_1')?.archived).toBe(true);
    const missing = await app.inject({
      method: 'POST',
      url: '/webapp/api/emails/nope/archive',
      headers: authedHeaders(initData),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('exposes no settings or compose routes', async () => {
    const { app, initData } = await setup();
    for (const url of ['/webapp/api/settings', '/webapp/api/send', '/webapp/api/keys']) {
      const res = await app.inject({ method: 'GET', url, headers: authedHeaders(initData) });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('webapp coordinator wiring', () => {
  it('registers the webapp routes when a bot token is configured', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'postwisp-p7-webapp-'));
    const config = {
      ...defaultConfig(),
      dataDir,
      serverPort: 0,
      serverHost: '127.0.0.1',
      botToken: BOT_TOKEN,
      ownerId: 7,
      publicUrl: 'https://mail.example.com',
      telegramWebhookPath: '/tg/secret-path',
      telegramWebhookSecret: 's'.repeat(16),
    };
    const telegramFetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })) as typeof fetch;
    const system = await startSystem(config, createLogger({ level: 'error' }), { telegramFetch });
    try {
      const initData = mintInitData(BOT_TOKEN, Math.floor(Date.now() / 1000) - 60);
      const res = await fetch(`http://127.0.0.1:${system.port}/webapp/api/emails`, {
        headers: authedHeaders(initData),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      const page = await fetch(`http://127.0.0.1:${system.port}/webapp`);
      expect(page.status).toBe(200);
    } finally {
      await system.stop();
    }
  });

  it('leaves the webapp routes unregistered without a bot token', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'postwisp-p7-webapp-'));
    const config = { ...defaultConfig(), dataDir, serverPort: 0, serverHost: '127.0.0.1' };
    const system = await startSystem(config, createLogger({ level: 'error' }));
    try {
      const res = await fetch(`http://127.0.0.1:${system.port}/webapp`);
      expect(res.status).toBe(404);
    } finally {
      await system.stop();
    }
  });
});
