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

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/core/store.js';
import { createLogger } from '../src/core/logger.js';
import { registerUnsubscribe } from '../src/server/unsubscribe.js';
import { unsubscribeToken } from '../src/core/unsubscribe.js';

const SECRET = 'route-test-secret';
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

const devNull = { write: () => true } as unknown as NodeJS.WritableStream;

function buildApp(store: Store, notified: string[]) {
  const app = Fastify({ logger: false });
  registerUnsubscribe(app, {
    secret: SECRET,
    store,
    logger: createLogger({ stream: devNull }),
    onUnsubscribe: (email) => notified.push(email),
  });
  return app;
}

describe('POST /unsub/:token', () => {
  it('suppresses the address, logs consent, and notifies on a valid token', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const notified: string[] = [];
    const app = buildApp(store, notified);
    const token = unsubscribeToken('reader@example.org', SECRET);

    const res = await app.inject({ method: 'POST', url: `/unsub/${token}` });

    expect(res.statusCode).toBe(200);
    expect(store.isSuppressed('reader@example.org')).toBe(true);
    expect(notified).toEqual(['reader@example.org']);
    const log = store.listConsentLog(10);
    expect(log).toHaveLength(1);
    expect(log[0]?.event).toBe('unsubscribe');
    expect(log[0]?.address).toBe('reader@example.org');
    expect(log[0]?.detail).toBe('one-click');
    await app.close();
  });

  it('rejects a forged token without touching the store', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const notified: string[] = [];
    const app = buildApp(store, notified);

    const res = await app.inject({ method: 'POST', url: '/unsub/forged.token' });

    expect(res.statusCode).toBe(400);
    expect(store.listConsentLog(10)).toHaveLength(0);
    expect(notified).toHaveLength(0);
    await app.close();
  });

  it('accepts the RFC 8058 one-click POST shape (urlencoded body)', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const app = buildApp(store, []);
    const token = unsubscribeToken('reader@example.org', SECRET);

    // What a mail client sends: the body is form-encoded, not JSON.
    const res = await app.inject({
      method: 'POST',
      url: `/unsub/${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    expect(res.statusCode).toBe(200);
    expect(store.isSuppressed('reader@example.org')).toBe(true);
    await app.close();
  });

  it('a GET renders a form that POSTs back to the same URL', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const app = buildApp(store, []);
    const token = unsubscribeToken('reader@example.org', SECRET);

    const res = await app.inject({ method: 'GET', url: `/unsub/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('method="post"');
    expect(res.body).toContain(`/unsub/${token}`);
    // The GET alone must not suppress anyone.
    expect(store.isSuppressed('reader@example.org')).toBe(false);
    await app.close();
  });
});
