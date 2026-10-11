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
import { createBot } from '../src/bot/index.js';
import { adaptStore, adaptSearch, toEventLike } from '../src/bot/store-adapter.js';
import { t } from '../src/core/i18n.js';
import type { SendInput, SendResult } from '../src/providers/interface.js';

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

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

interface ApiCall { method: string; payload: unknown }

function buildBot(store: Store, calls: ApiCall[], sent: SendInput[] = []) {
  const bot = createBot({
    token: 'x',
    logger: quietLogger(),
    settings: { ownerId: 123, providerName: 'resend', domains: ['example.com'] },
    store: adaptStore(store),
    search: adaptSearch(store),
    fullStore: store,
    sendEmail: async (input: SendInput): Promise<SendResult> => {
      sent.push(input);
      return { id: 'sent-1' };
    },
  });
  bot.botInfo = BOT_INFO;
  bot.api.config.use(async (_prev: unknown, method: string, payload: unknown) => {
    calls.push({ method, payload });
    if (method === 'answerCallbackQuery') return { ok: true, result: true };
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: 123, type: 'private' } } };
  });
  return bot;
}

function textUpdate(text: string) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 123, type: 'private' },
      from: { id: 123, is_bot: false, first_name: 'Owner' },
      text,
    },
  };
}

function callbackUpdate(data: string) {
  return {
    update_id: 2,
    callback_query: {
      id: 'cq1',
      from: { id: 123, is_bot: false, first_name: 'Owner' },
      data,
      chat_instance: 'x',
      message: { message_id: 1, date: 1, chat: { id: 123, type: 'private' }, text: 'x' },
    },
  };
}

function lastText(calls: ApiCall[]): string {
  const sent = calls.filter((c) => c.method === 'sendMessage');
  return (sent[sent.length - 1].payload as Record<string, unknown>)['text'] as string;
}

describe('P2 wiring', () => {
  it('routes the Compose menu into the wizard', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    store.set('identities', JSON.stringify(['me@example.com']));
    const calls: ApiCall[] = [];
    const bot = buildBot(store, calls);
    await bot.handleUpdate(textUpdate(t('bot.menu.compose')));
    expect(lastText(calls)).toContain(t('bot.compose.title'));
  });

  it('shows the no-identities notice when none are configured', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const calls: ApiCall[] = [];
    const bot = buildBot(store, calls);
    await bot.handleUpdate(textUpdate(t('bot.menu.compose')));
    expect(lastText(calls)).toContain(t('bot.identity.none'));
  });

  it('routes the Stats menu into the dashboard', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const calls: ApiCall[] = [];
    const bot = buildBot(store, calls);
    await bot.handleUpdate(textUpdate(t('bot.menu.stats')));
    expect(lastText(calls)).toContain(t('bot.stats.title'));
  });

  it('routes c: callbacks into the compose wizard', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    store.set('identities', JSON.stringify(['me@example.com']));
    const calls: ApiCall[] = [];
    const bot = buildBot(store, calls);
    await bot.handleUpdate(callbackUpdate('c:new'));
    // No identities configured would show the notice; with one identity the
    // wizard asks for the recipient.
    expect(lastText(calls)).not.toContain(t('bot.compose.title'));
  });

  it('falls back to the label when compose is unwired', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    const bot = createBot({
      token: 'x',
      logger: quietLogger(),
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
      store: adaptStore(store),
    });
    bot.botInfo = BOT_INFO;
    const calls: ApiCall[] = [];
    bot.api.config.use(async (_prev: unknown, method: string, payload: unknown) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 1, date: 1, chat: { id: 123, type: 'private' } } };
    });
    await bot.handleUpdate(textUpdate(t('bot.menu.compose')));
    expect(lastText(calls)).toBe(t('bot.menu.compose'));
  });

  it('starts a threaded reply from the email reply button', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    store.set('identities', JSON.stringify(['me@example.com']));
    store.saveFullEmail(
      toEventLike({
        id: 'ev9',
        provider: 'resend',
        domain: 'example.com',
        from: { address: 'boss@example.com' },
        to: ['me@example.com'],
        subject: 'Q3 numbers',
        dateMs: 1700000000000,
        snippet: 'numbers',
        bodyText: 'See the numbers.',
        bodyHtml: null,
        attachments: [],
        threadId: null,
        headers: { 'message-id': '<abc123@example.com>' },
      }),
    );
    const calls: ApiCall[] = [];
    const sent: SendInput[] = [];
    const bot = buildBot(store, calls, sent);

    await bot.handleUpdate(callbackUpdate('e:ev9:reply'));
    expect(lastText(calls)).toContain('boss@example.com');

    await bot.handleUpdate(textUpdate('Here they are.'));
    await bot.handleUpdate(callbackUpdate('c:skipattach'));
    expect(lastText(calls)).toContain('Re: Q3 numbers');

    await bot.handleUpdate(callbackUpdate('c:send'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['boss@example.com']);
    expect(sent[0]!.headers?.['In-Reply-To']).toBe('<abc123@example.com>');
    expect(sent[0]!.headers?.['References']).toBe('<abc123@example.com>');
  });
});
