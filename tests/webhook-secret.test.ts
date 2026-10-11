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
import { ResendEmailProvider } from '../src/providers/resend.js';

// Resend issues webhook secrets as `whsec_<base64>`; verification must decode
// the key material, not HMAC with the literal string. A secret without the
// prefix keeps working as a raw key.
describe('whsec_ webhook secrets', () => {
  function sign(key: Buffer, id: string, ts: string, body: Buffer): string {
    return createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64');
  }

  function headersFor(sig: string, id = 'evt_1', ts = String(Math.floor(Date.now() / 1000))): Record<string, string> {
    return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
  }

  it('verifies with a whsec_-prefixed base64 secret', () => {
    const key = randomBytes(32);
    const secret = `whsec_${key.toString('base64')}`;
    const body = Buffer.from('{"type":"email.received"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const provider = new ResendEmailProvider({ apiKey: 'test' });
    const res = provider.verifyWebhook(body, headersFor(sign(key, 'evt_1', ts, body), 'evt_1', ts), secret);
    expect(res).toEqual({ ok: true });
  });

  it('rejects when the whsec_ key does not match', () => {
    const key = randomBytes(32);
    const secret = `whsec_${key.toString('base64')}`;
    const body = Buffer.from('{"type":"email.received"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const provider = new ResendEmailProvider({ apiKey: 'test' });
    const res = provider.verifyWebhook(
      body,
      headersFor(sign(randomBytes(32), 'evt_1', ts, body), 'evt_1', ts),
      secret,
    );
    expect(res.ok).toBe(false);
  });

  it('still accepts a raw secret without the prefix', () => {
    const secret = 'plain-test-secret';
    const body = Buffer.from('{"ok":true}');
    const ts = String(Math.floor(Date.now() / 1000));
    const provider = new ResendEmailProvider({ apiKey: 'test' });
    const res = provider.verifyWebhook(
      body,
      headersFor(sign(Buffer.from(secret, 'utf8'), 'evt_1', ts, body), 'evt_1', ts),
      secret,
    );
    expect(res).toEqual({ ok: true });
  });
});
