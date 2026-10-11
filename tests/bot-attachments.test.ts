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
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '../src/core/store.js';
import { createLogger } from '../src/core/logger.js';
import { createBot, type AttachmentFetch } from '../src/bot/index.js';
import { adaptStore, toEventLike } from '../src/bot/store-adapter.js';
import { chunkText } from '../src/bot/notify.js';
import type { EmailEvent } from '../src/providers/interface.js';

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
  const stream = new Writable({ write(_c, _e, cb) { cb(); } });
  return createLogger({ stream });
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Test',
  username: 'testbot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function sampleEvent(): EmailEvent {
  return {
    id: 'ev1',
    provider: 'resend',
    domain: 'example.com',
    from: { address: 'boss@example.com' },
    to: ['me@example.com'],
    subject: 'Files',
    dateMs: 1700000000000,
    snippet: 'see attached',
    bodyText: 'See attached.',
    bodyHtml: null,
    attachments: [
      { id: 'a1', filename: 'a.pdf', size: 100, mime: 'application/pdf' },
      { id: 'a2', filename: 'b.pdf', size: 200, mime: 'application/pdf' },
    ],
    threadId: null,
    headers: {},
  };
}

// Intercepts every Bot API call: no network, records method + payload.
// Transformers must return the raw Telegram envelope ({ ok, result }).
function tapApi(bot: { api: { config: { use: (t: unknown) => void } } }, calls: Array<{ method: string; payload: unknown }>) {
  bot.api.config.use(async (_prev: unknown, method: string, payload: unknown) => {
    calls.push({ method, payload });
    if (method === 'answerCallbackQuery') return { ok: true, result: true };
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 123, type: 'private' } } };
  });
}

function callbackUpdate(data: string, fromId = 123) {
  return {
    update_id: 1,
    callback_query: {
      id: 'cq1',
      from: { id: fromId, is_bot: false, first_name: 'Owner' },
      data,
      chat_instance: 'x',
      message: { message_id: 1, date: 1, chat: { id: fromId, type: 'private' }, text: 'x' },
    },
  };
}

describe('attachment download action', () => {
  it('sends each attachment as a protected document', async () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const bot = createBot({
      token: 'x',
      logger: quietLogger(),
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
      store: adaptStore(store),
      downloadAttachment: async (emailId, attachmentId): Promise<AttachmentFetch> => {
        expect(emailId).toBe('ev1');
        return { ok: true, filename: `${attachmentId}.pdf`, data: Buffer.from('PDF') };
      },
    });
    bot.botInfo = BOT_INFO;
    const calls: Array<{ method: string; payload: unknown }> = [];
    tapApi(bot, calls);
    await bot.handleUpdate(callbackUpdate('e:ev1:att'));
    const docs = calls.filter((c) => c.method === 'sendDocument');
    expect(docs).toHaveLength(2);
    for (const d of docs) {
      expect((d.payload as Record<string, unknown>)['protect_content']).toBe(true);
    }
  });

  it('reports oversized attachments instead of failing', async () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const bot = createBot({
      token: 'x',
      logger: quietLogger(),
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
      store: adaptStore(store),
      downloadAttachment: async (): Promise<AttachmentFetch> => ({ ok: false, reason: 'too_large' }),
    });
    bot.botInfo = BOT_INFO;
    const calls: Array<{ method: string; payload: unknown }> = [];
    tapApi(bot, calls);
    await bot.handleUpdate(callbackUpdate('e:ev1:att'));
    expect(calls.filter((c) => c.method === 'sendDocument')).toHaveLength(0);
    const texts = calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => (c.payload as Record<string, unknown>)['text'] as string);
    expect(texts.some((t) => t.includes('20 MB'))).toBe(true);
  });

  it('says so when the email has no attachments', async () => {
    const store = memStore();
    const ev = sampleEvent();
    ev.attachments = [];
    store.saveFullEmail(toEventLike(ev));
    const bot = createBot({
      token: 'x',
      logger: quietLogger(),
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
      store: adaptStore(store),
      downloadAttachment: async (): Promise<AttachmentFetch> => ({ ok: false, reason: 'missing' }),
    });
    bot.botInfo = BOT_INFO;
    const calls: Array<{ method: string; payload: unknown }> = [];
    tapApi(bot, calls);
    await bot.handleUpdate(callbackUpdate('e:ev1:att'));
    expect(calls.filter((c) => c.method === 'sendDocument')).toHaveLength(0);
  });
});

describe('chunkText', () => {
  it('leaves short text alone', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('splits long text under the limit, preferring line breaks', () => {
    const text = `${'a'.repeat(3900)}\n${'b'.repeat(3900)}`;
    const chunks = chunkText(text, 4000);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length <= 4000)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });

  it('hard-cuts text with no line breaks', () => {
    const chunks = chunkText('x'.repeat(9000), 4000);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('x'.repeat(9000));
  });
});
