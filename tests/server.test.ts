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

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/core/logger.js';
import { VERSION } from '../src/core/version.js';
import { createServer } from '../src/server/index.js';
import packageJson from '../package.json';

function testServer() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { app: createServer({ logger: createLogger({ stream }) }), lines };
}

describe('GET /healthz', () => {
  it('returns ok and the release version', async () => {
    const { app } = testServer();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: VERSION });
    await app.close();
  });

  it('pins VERSION to package.json', () => {
    expect(VERSION).toBe((packageJson as { version: string }).version);
  });
});

describe('unknown routes', () => {
  it('returns 404 without leaking internals', async () => {
    const { app } = testServer();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: 'not found' });
    await app.close();
  });
});
