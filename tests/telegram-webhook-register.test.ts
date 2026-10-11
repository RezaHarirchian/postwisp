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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { startSystem } from '../src/index.js';

// The Telegram transport registration in startSystem: webhook mode must call
// setWebhook (otherwise the route receives nothing), polling mode must clear
// a stale webhook (otherwise getUpdates receives nothing). The Bot API is
// injected via the telegramFetch seam; nothing here touches the network.
describe('telegram transport registration', () => {
  interface Call {
    url: string;
    body: unknown;
  }

  function stubTelegram(calls: Call[]): typeof fetch {
    return (async (url: unknown, init?: { body?: unknown }) => {
      let body: unknown = null;
      try {
        body = init?.body ? JSON.parse(String(init.body)) : null;
      } catch {
        body = null;
      }
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as typeof fetch;
  }

  function baseConfig() {
    return {
      ...defaultConfig(),
      dataDir: mkdtempSync(join(tmpdir(), 'postwisp-tgwebhook-')),
      serverPort: 0,
      serverHost: '127.0.0.1',
      botToken: 'test-token',
      ownerId: 1,
    };
  }

  it('registers the webhook URL with Telegram in webhook mode', async () => {
    const calls: Call[] = [];
    const config = {
      ...baseConfig(),
      telegramWebhookPath: '/tg/secret-path',
      telegramWebhookSecret: 's'.repeat(16),
      publicUrl: 'https://mail.example.com',
    };
    const system = await startSystem(config, createLogger({ level: 'error' }), {
      telegramFetch: stubTelegram(calls),
    });
    try {
      const setHook = calls.find((c) => c.url.includes('/setWebhook'));
      expect(setHook).toBeDefined();
      const body = setHook!.body as Record<string, unknown>;
      expect(body['url']).toBe('https://mail.example.com/tg/secret-path');
      expect(body['secret_token']).toBe('s'.repeat(16));
      // Webhook mode never polls.
      expect(calls.some((c) => c.url.includes('/getUpdates'))).toBe(false);
    } finally {
      await system.stop();
    }
  });

  it('clears a stale webhook when falling back to polling', async () => {
    const calls: Call[] = [];
    const config = baseConfig(); // no webhook path/secret -> polling
    const system = await startSystem(config, createLogger({ level: 'error' }), {
      telegramFetch: stubTelegram(calls),
    });
    try {
      // deleteWebhook is awaited before the polling loop starts.
      expect(calls.some((c) => c.url.includes('/deleteWebhook'))).toBe(true);
    } finally {
      await system.stop();
    }
  });
});
