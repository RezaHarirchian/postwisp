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

import type { Context } from 'grammy';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createBot, mainKeyboard, ownerGuard } from '../src/bot/index.js';
import { createLogger } from '../src/core/logger.js';
import { t } from '../src/core/i18n.js';

function testLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { logger: createLogger({ stream }), lines };
}

function fakeCtx(fromId?: number, chatId?: number): Context {
  return {
    from: fromId === undefined ? undefined : { id: fromId },
    chat: chatId === undefined ? undefined : { id: chatId },
  } as Context;
}

describe('ownerGuard', () => {
  it('lets the owner through in their private chat', async () => {
    const { logger } = testLogger();
    let reached = false;
    await ownerGuard(123, logger)(fakeCtx(123, 123), async () => {
      reached = true;
    });
    expect(reached).toBe(true);
  });

  it('drops updates from anyone else and logs it', async () => {
    const { logger, lines } = testLogger();
    let reached = false;
    await ownerGuard(123, logger)(fakeCtx(999, 999), async () => {
      reached = true;
    });
    expect(reached).toBe(false);
    expect(lines.join('\n')).toContain('non-owner');
  });

  it('drops the owner’s own messages in a group chat', async () => {
    const { logger, lines } = testLogger();
    let reached = false;
    // from.id is the owner but the chat is a group: email content must
    // never land where group members can read it.
    await ownerGuard(123, logger)(fakeCtx(123, -456), async () => {
      reached = true;
    });
    expect(reached).toBe(false);
    expect(lines.join('\n')).toContain('non-owner');
  });

  it('drops updates with no sender at all', async () => {
    const { logger } = testLogger();
    let reached = false;
    await ownerGuard(123, logger)(fakeCtx(undefined), async () => {
      reached = true;
    });
    expect(reached).toBe(false);
  });

  it('fails closed when no owner is configured', async () => {
    const { logger } = testLogger();
    let reached = false;
    await ownerGuard(null, logger)(fakeCtx(123), async () => {
      reached = true;
    });
    expect(reached).toBe(false);
  });
});

describe('mainKeyboard', () => {
  it('contains all six menu buttons', () => {
    const keyboard = mainKeyboard();
    const labels = keyboard.keyboard.flat().map((b) => b.text);
    for (const key of [
      'bot.menu.compose',
      'bot.menu.inbox',
      'bot.menu.sent',
      'bot.menu.search',
      'bot.menu.stats',
      'bot.menu.settings',
    ] as const) {
      expect(labels).toContain(t(key));
    }
  });

  it('is persistent and resized', () => {
    const kb = mainKeyboard() as unknown as { is_persistent?: boolean; resize_keyboard?: boolean };
    expect(kb.is_persistent).toBe(true);
    expect(kb.resize_keyboard).toBe(true);
  });
});

describe('createBot', () => {
  it('builds without contacting Telegram', () => {
    const { logger } = testLogger();
    const bot = createBot({
      token: 'dummy-token-for-tests',
      logger,
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
    });
    expect(bot).toBeDefined();
  });
});

describe('email actions via callback queries', () => {
  // Drives a real grammy update through the middleware chain with a
  // mocked Bot API, capturing every sendMessage payload.
  async function tapCallback(
    email: import('../src/bot/views.js').EmailViewRecord,
    data: string,
  ): Promise<{ sent: Array<Record<string, unknown>>; rules: Array<{ from: string; subject: string }> }> {
    const { logger } = testLogger();
    const rules: Array<{ from: string; subject: string }> = [];
    const store: import('../src/bot/index.js').BotStore = {
      getSetting: () => null,
      setSetting: () => undefined,
      getEmail: (id: string) => (id === email.id ? email : null),
      listEmails: () => [email],
      setRead: () => undefined,
      setArchived: () => undefined,
      snoozeEmail: () => undefined,
      blockSender: () => undefined,
      addArchiveRule: (from: string, subject: string) => {
        rules.push({ from, subject });
      },
    };
    const bot = createBot({
      token: 'test-token',
      logger,
      settings: { ownerId: 123, providerName: 'resend', domains: [] },
      store,
    });
    // handleUpdate needs bot info; no network is involved.
    (bot as unknown as { botInfo: unknown }).botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'Test',
      username: 'testbot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };
    const sent: Array<Record<string, unknown>> = [];
    bot.api.config.use(async (prev, method, payload) => {
      if (method === 'sendMessage') {
        sent.push(payload as Record<string, unknown>);
        // Raw Bot API response shape, as the HTTP layer would deliver it.
        return {
          ok: true,
          result: { message_id: sent.length, date: 0, chat: { id: 123, type: 'private' }, text: '' },
        };
      }
      if (method === 'answerCallbackQuery') return { ok: true, result: true };
      return prev(method, payload);
    });
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cq-1',
        from: { id: 123, is_bot: false, first_name: 'Owner' },
        message: {
          message_id: 7,
          date: 1700000000,
          chat: { id: 123, type: 'private' },
          text: 'original',
        },
        chat_instance: 'ci-1',
        data,
      },
    } as never);
    return { sent, rules };
  }

  function emailRecord(overrides: Partial<import('../src/bot/views.js').EmailViewRecord> = {}) {
    return {
      id: 'email1',
      domain: 'example.com',
      fromAddr: 'boss@example.com',
      subject: 'Invoice #42',
      dateMs: 1700000000000,
      ...overrides,
    };
  }

  it("the 'rule' reply carries protect_content (subject is email content)", async () => {
    const { sent, rules } = await tapCallback(emailRecord(), 'e:email1:rule');
    expect(rules).toEqual([{ from: 'boss@example.com', subject: 'Invoice #42' }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!['protect_content']).toBe(true);
    expect(sent[0]!['text']).toContain('Invoice #42');
  });

  it("the 'full' body view keeps the head plus first chunk under 4096 chars", async () => {
    const longSubject = 's'.repeat(2000);
    const { sent } = await tapCallback(
      emailRecord({ subject: longSubject, bodyText: 'b'.repeat(20000) }),
      'e:email1:full',
    );
    expect(sent.length).toBeGreaterThan(1);
    for (const msg of sent) {
      expect((msg['text'] as string).length).toBeLessThanOrEqual(4096);
    }
    // The head (with the long subject) is part of the first message.
    expect(sent[0]!['text']).toContain(longSubject);
  });
});

describe('cb (callback data guard)', () => {
  it('passes through data within the 64-byte limit', async () => {
    const { cb } = await import('../src/bot/views.js');
    expect(cb('e:email1:full')).toBe('e:email1:full');
    expect(cb('x'.repeat(64))).toBe('x'.repeat(64));
  });

  it('throws on data over the 64-byte limit', async () => {
    const { cb } = await import('../src/bot/views.js');
    expect(() => cb('x'.repeat(65))).toThrow(/64-byte/);
    // Multibyte characters count as their UTF-8 bytes, not chars.
    expect(() => cb('é'.repeat(33))).toThrow(/64-byte/);
  });
});
