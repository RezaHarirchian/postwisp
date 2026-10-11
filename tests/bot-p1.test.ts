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
import Fastify from 'fastify';
import { createServer } from '../src/server/index.js';
import { registerTelegramWebhook } from '../src/server/telegram-webhook.js';
import { createLogger } from '../src/core/logger.js';

const SECRET = 'test-secret-token';
const PATH = '/tg/un_guessable_path_123';

function testApp(onUpdate: (update: unknown) => Promise<void> = async () => {}) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const app = createServer({ logger: createLogger({ stream }) });
  registerTelegramWebhook(app, { path: PATH, secretToken: SECRET, handleUpdate: onUpdate });
  return { app, lines };
}

describe('registerTelegramWebhook', () => {
  it('rejects requests without the secret token', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'POST', url: PATH, payload: { update_id: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with a wrong secret token', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: { update_id: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('delivers the parsed update to the handler and answers 200', async () => {
    const seen: unknown[] = [];
    const { app } = testApp(async (update) => {
      seen.push(update);
    });
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: { update_id: 42, message: { text: 'hi' } },
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual([{ update_id: 42, message: { text: 'hi' } }]);
  });

  it('still answers 200 when the handler throws, so Telegram does not retry', async () => {
    const { app } = testApp(async () => {
      throw new Error('poisoned update');
    });
    const res = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: { update_id: 7 },
    });
    expect(res.statusCode).toBe(200);
  });

  it('does not register on any other path', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/tg/some_other_path',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('fails closed when the secret is empty: every request is a 401', async () => {
    let handled = 0;
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const app = createServer({ logger: createLogger({ stream }) });
    registerTelegramWebhook(app, {
      path: PATH,
      secretToken: '',
      handleUpdate: async () => {
        handled++;
      },
    });
    // No header at all: timingSafeEqual(empty, empty) would be true without
    // the fail-closed guard, so this is the exact bypass being tested.
    const noHeader = await app.inject({ method: 'POST', url: PATH, payload: { update_id: 1 } });
    expect(noHeader.statusCode).toBe(401);
    const withHeader = await app.inject({
      method: 'POST',
      url: PATH,
      headers: { 'x-telegram-bot-api-secret-token': 'anything' },
      payload: { update_id: 2 },
    });
    expect(withHeader.statusCode).toBe(401);
    expect(handled).toBe(0);
  });
});

describe('buildThreadView', () => {
  it('lists messages oldest first with dates and open buttons', async () => {
    const { buildThreadView } = await import('../src/bot/views.js');
    const view = buildThreadView([
      { id: 'b', domain: 'x.com', fromAddr: 'b@x.com', subject: 're: hi', dateMs: Date.UTC(2026, 9, 10, 13, 0) },
      { id: 'a', domain: 'x.com', fromAddr: 'a@x.com', subject: 'hi', dateMs: Date.UTC(2026, 9, 10, 12, 0) },
    ]);
    expect(view.text).toContain('Thread (2)');
    // Item format is "{date} — {from}: {subject}"; date order proves the sort.
    const firstDate = view.text.indexOf('2026-10-10 12:00 UTC — a@x.com: hi');
    const secondDate = view.text.indexOf('2026-10-10 13:00 UTC — b@x.com: re: hi');
    expect(firstDate).toBeGreaterThanOrEqual(0);
    expect(secondDate).toBeGreaterThan(firstDate);
    const kb = view.replyMarkup as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(kb.inline_keyboard.flat().map((btn) => btn.callback_data)).toEqual(['e:a', 'e:b']);
  });
});

describe('parseCallbackData', () => {
  it('parses the full callback scheme and rejects junk', async () => {
    const { parseCallbackData } = await import('../src/bot/views.js');
    expect(parseCallbackData('e:abc123')).toEqual({ kind: 'email', id: 'abc123', action: 'open' });
    expect(parseCallbackData('e:abc123:full')).toEqual({ kind: 'email', id: 'abc123', action: 'full' });
    expect(parseCallbackData('e:abc123:sz24h')).toEqual({ kind: 'email', id: 'abc123', action: 'sz24h' });
    expect(parseCallbackData('th:thread-9')).toEqual({ kind: 'thread', threadId: 'thread-9' });
    expect(parseCallbackData('dom:example.com')).toEqual({ kind: 'domain', domain: 'example.com' });
    expect(parseCallbackData('dom:all')).toEqual({ kind: 'domain', domain: null });
    expect(parseCallbackData('nope')).toBeNull();
    expect(parseCallbackData('e:')).toBeNull();
    expect(parseCallbackData('e:a:bogus')).toBeNull();
    // Callback data must fit Telegram's 64-byte limit.
    for (const data of ['e:some-long-but-plausible-id-12345:full', 'th:thread-abc-123', 'dom:example.com']) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('isQuietNow', () => {
  it('matches a daytime range', async () => {
    const { isQuietNow } = await import('../src/bot/digest.js');
    expect(isQuietNow(new Date(2026, 9, 10, 3, 0), '01:00', '06:00')).toBe(true);
    expect(isQuietNow(new Date(2026, 9, 10, 12, 0), '01:00', '06:00')).toBe(false);
  });

  it('handles overnight ranges that wrap past midnight', async () => {
    const { isQuietNow } = await import('../src/bot/digest.js');
    expect(isQuietNow(new Date(2026, 9, 10, 23, 30), '22:00', '07:00')).toBe(true);
    expect(isQuietNow(new Date(2026, 9, 10, 3, 0), '22:00', '07:00')).toBe(true);
    expect(isQuietNow(new Date(2026, 9, 10, 12, 0), '22:00', '07:00')).toBe(false);
  });

  it('treats an empty or malformed range as never quiet', async () => {
    const { isQuietNow } = await import('../src/bot/digest.js');
    expect(isQuietNow(new Date(2026, 9, 10, 3, 0), '08:00', '08:00')).toBe(false);
    expect(isQuietNow(new Date(2026, 9, 10, 3, 0), 'bogus', '07:00')).toBe(false);
  });
});

describe('digest queue', () => {
  function memKv() {
    const map = new Map<string, string>();
    return {
      get: (k: string) => map.get(k) ?? null,
      set: (k: string, v: string) => {
        map.set(k, v);
      },
    };
  }

  it('accumulates ids and drains them in order', async () => {
    const { queueDigest, takeDigestQueue } = await import('../src/bot/digest.js');
    const kv = memKv();
    queueDigest(kv, 'a');
    queueDigest(kv, 'b');
    queueDigest(kv, 'a'); // duplicates collapse
    expect(takeDigestQueue(kv)).toEqual(['a', 'b']);
    expect(takeDigestQueue(kv)).toEqual([]);
  });

  it('builds one summary message with an open button per mail', async () => {
    const { buildDigestMessages } = await import('../src/bot/digest.js');
    const [d] = buildDigestMessages([
      { id: 'a', fromAddr: 'a@x.com', subject: 'first <b>mail</b>' },
      { id: 'b', fromAddr: 'b@x.com', fromName: 'Bee', subject: 'second' },
    ]);
    expect(d!.text).toContain('2 new emails');
    expect(d!.text).toContain('first &lt;b&gt;mail&lt;/b&gt;');
    const kb = d!.replyMarkup as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(kb.inline_keyboard.flat().map((btn) => btn.callback_data)).toEqual(['e:a', 'e:b']);
  });
});

describe('startDigestScheduler', () => {
  it('fires hourly on a one-hour interval', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const { startDigestScheduler } = await import('../src/bot/digest.js');
      let fires = 0;
      const sched = startDigestScheduler({ mode: 'hourly', hour: 9, onFire: () => { fires += 1; } });
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(fires).toBe(1);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(fires).toBe(2);
      sched.stop();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(fires).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildEmailView', () => {
  it('renders header, snippet, and action buttons with short callback data', async () => {
    const { buildEmailView } = await import('../src/bot/views.js');
    const view = buildEmailView({
      id: 'msg-1',
      domain: 'x.com',
      fromAddr: 'a@x.com',
      fromName: 'Ann',
      subject: 'Hello <world>',
      dateMs: Date.UTC(2026, 9, 10, 12, 0),
      snippet: 'see this',
      threadId: 'th-1',
      isRead: false,
    });
    expect(view.text).toContain('From: Ann');
    expect(view.text).toContain('Subject: Hello &lt;world&gt;');
    expect(view.text).toContain('see this');
    const kb = view.replyMarkup as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const datas = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toContain('th:th-1');
    expect(datas).toContain('e:msg-1:arch');
    expect(datas).toContain('e:msg-1:read');
    expect(datas).toContain('e:msg-1:sz1h');
    expect(datas).toContain('e:msg-1:blk');
    for (const d of datas) expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64);
  });
});

describe('buildSentList', () => {
  it('lists sent mail and handles the empty case', async () => {
    const { buildSentList } = await import('../src/bot/views.js');
    const empty = buildSentList([]);
    expect(empty.text).toContain('No sent emails yet.');
    const view = buildSentList([
      { id: 's1', to: 'b@x.com', subject: 'Re: hello', dateMs: Date.UTC(2026, 9, 10, 12, 0), status: 'delivered' },
    ]);
    expect(view.text).toContain('To: b@x.com');
    expect(view.text).toContain('delivered');
  });
});

describe('buildDomainPicker', () => {
  it('marks the active domain and offers an all-domains reset', async () => {
    const { buildDomainPicker } = await import('../src/bot/views.js');
    const kb = buildDomainPicker(['a.com', 'b.com'], 'b.com') as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    const rows = kb.inline_keyboard.flat();
    expect(rows[0]).toMatchObject({ callback_data: 'dom:all' });
    expect(rows.find((b) => b.callback_data === 'dom:b.com')?.text).toContain('»');
    expect(rows.find((b) => b.callback_data === 'dom:a.com')?.text).not.toContain('»');
  });
});

describe('buildSearchResults', () => {
  it('shows results with open buttons and a no-results message', async () => {
    const { buildSearchResults } = await import('../src/bot/views.js');
    const none = buildSearchResults('zzz', []);
    expect(none.text).toContain('Nothing found for "zzz".');
    const view = buildSearchResults('hi', [
      { id: 'm1', domain: 'x.com', fromAddr: 'a@x.com', subject: 'hi there', dateMs: Date.UTC(2026, 9, 10, 12, 0) },
    ]);
    expect(view.text).toContain('Results for "hi" (1)');
    const kb = view.replyMarkup as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(kb.inline_keyboard.flat()[0]?.callback_data).toBe('e:m1');
  });
});

describe('createBot with P1 handlers', () => {
  it('still builds without optional seams wired', async () => {
    const { Writable } = await import('node:stream');
    const { createLogger } = await import('../src/core/logger.js');
    const { createBot } = await import('../src/bot/index.js');
    const stream = new Writable({ write(_c, _e, cb) { cb(); } });
    const bot = createBot({
      token: 'dummy-token-for-tests',
      logger: createLogger({ stream }),
      settings: { ownerId: 123, providerName: 'resend', domains: ['a.com', 'b.com'] },
    });
    expect(bot).toBeDefined();
  });

  it('drops a non-owner callback query before any handler runs', async () => {
    const { Writable } = await import('node:stream');
    const { createLogger } = await import('../src/core/logger.js');
    const { createBot } = await import('../src/bot/index.js');
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const bot = createBot({
      token: 'dummy-token-for-tests',
      logger: createLogger({ stream }),
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
    });
    // Resolves without a network call: the guard drops the update, so no
    // handler ever reaches ctx.reply (which would throw without Telegram).
    // botInfo is set directly to skip bot.init()'s getMe network call.
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Test',
      username: 'testbot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cq1',
        from: { id: 999, is_bot: false, first_name: 'Intruder' },
        data: 'e:abc:arch',
        chat_instance: 'x',
      },
    });
    expect(lines.join('\n')).toContain('non-owner');
  });
});
