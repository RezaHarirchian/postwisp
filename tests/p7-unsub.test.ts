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
import type { Context } from 'grammy';
import { openStore, type EmailMeta, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import { findListUnsubscribe, mailtoAddress } from '../src/core/list-unsubscribe.js';
import { handleUnsubscribeAction } from '../src/bot/unsub-action.js';
import { buildEmailView } from '../src/bot/views.js';
import { toViewRecord } from '../src/bot/store-adapter.js';

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

function quietLogger(): Logger {
  return createLogger({ stream: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

function seedEmail(store: Store, headers: Record<string, string>): void {
  const meta: EmailMeta = {
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    fromAddr: 'news@example.org',
    subject: 'Newsletter',
    receivedAt: 1000,
    read: false,
    archived: false,
    trashed: false,
    labels: [],
    threadId: null,
    to: ['me@example.com'],
    bodyText: 'Hello.',
    headers,
  };
  store.saveEmailMeta(meta);
}

function fakeCtx(): { ctx: Context; replies: Array<{ text: string; extra?: unknown }> } {
  const replies: Array<{ text: string; extra?: unknown }> = [];
  const ctx = {
    chat: { id: 1 },
    reply: async (text: string, extra?: unknown) => {
      replies.push({ text, extra });
      return { message_id: replies.length, chat: { id: 1 }, date: 0, text };
    },
    answerCallbackQuery: async () => true,
  } as unknown as Context;
  return { ctx, replies };
}

describe('findListUnsubscribe', () => {
  it('prefers the https URL and detects one-click support', () => {
    const target = findListUnsubscribe({
      'List-Unsubscribe': '<https://example.org/unsub>, <mailto:leave@example.org>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(target).toEqual({
      kind: 'http',
      url: 'https://example.org/unsub',
      oneClick: true,
    });
  });

  it('falls back to mailto when no http URL exists', () => {
    const target = findListUnsubscribe({
      'List-Unsubscribe': '<mailto:leave@example.org?subject=unsubscribe>',
    });
    expect(target?.kind).toBe('mailto');
    expect(mailtoAddress(target!.url)).toBe('leave@example.org');
  });

  it('matches header names case-insensitively and tolerates bare URLs', () => {
    const target = findListUnsubscribe({
      'list-unsubscribe': 'http://example.org/u, <mailto:x@y.z>',
    });
    expect(target?.kind).toBe('http');
    expect(target?.oneClick).toBe(false);
  });

  it('returns null without the header or without a usable target', () => {
    expect(findListUnsubscribe({})).toBeNull();
    expect(findListUnsubscribe({ 'List-Unsubscribe': '<ftp://example.org/x>' })).toBeNull();
  });
});

describe('handleUnsubscribeAction', () => {
  it('shows the mailto address for manual unsubscribing', async () => {
    const store = memStore();
    seedEmail(store, { 'List-Unsubscribe': '<mailto:leave@example.org>' });
    const { ctx, replies } = fakeCtx();
    await handleUnsubscribeAction(ctx, { store, logger: quietLogger() }, 'em_1');
    expect(replies[0]!.text).toContain('leave@example.org');
    expect(replies[0]!.text).toContain('<code>');
  });

  it('POSTs the one-click body and logs the consent event', async () => {
    const store = memStore();
    seedEmail(store, {
      'List-Unsubscribe': '<https://example.org/unsub>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    const { ctx, replies } = fakeCtx();
    let posted: string | null = null;
    await handleUnsubscribeAction(
      ctx,
      {
        store,
        logger: quietLogger(),
        postUnsubscribe: async (url: string) => {
          posted = url;
          return { ok: true, status: 200 };
        },
      },
      'em_1',
    );
    expect(posted).toBe('https://example.org/unsub');
    expect(replies[0]!.text).toContain('Unsubscribed');
    const log = store.listConsentLog(10);
    expect(log[0]?.event).toBe('unsubscribe');
    expect(log[0]?.address).toBe('me@example.com');
    // The owner's own receiving address is not suppressed by unsubscribing
    // from someone else's list.
    expect(store.isSuppressed('me@example.com')).toBe(false);
  });

  it('reports a failed one-click POST without logging consent', async () => {
    const store = memStore();
    seedEmail(store, {
      'List-Unsubscribe': '<https://example.org/unsub>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    const { ctx, replies } = fakeCtx();
    await handleUnsubscribeAction(
      ctx,
      {
        store,
        logger: quietLogger(),
        postUnsubscribe: async () => ({ ok: false, status: 500 }),
      },
      'em_1',
    );
    expect(replies[0]!.text).toContain('failed');
    expect(store.listConsentLog(10)).toHaveLength(0);
  });

  it('shows the link when one-click is not advertised', async () => {
    const store = memStore();
    seedEmail(store, { 'List-Unsubscribe': '<https://example.org/unsub>' });
    const { ctx, replies } = fakeCtx();
    await handleUnsubscribeAction(ctx, { store, logger: quietLogger() }, 'em_1');
    expect(replies[0]!.text).toContain('https://example.org/unsub');
  });

  it('handles a missing email and a missing header', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    await handleUnsubscribeAction(ctx, { store, logger: quietLogger() }, 'nope');
    expect(replies[0]!.text).toContain('not found');
    seedEmail(store, {});
    await handleUnsubscribeAction(ctx, { store, logger: quietLogger() }, 'em_1');
    expect(replies[1]!.text).toContain('Something went wrong');
  });
});

describe('email view unsubscribe button', () => {
  it('renders the Unsubscribe button only when the header is present', () => {
    const store = memStore();
    seedEmail(store, { 'List-Unsubscribe': '<https://example.org/unsub>' });
    const withHeader = buildEmailView(toViewRecord(store.getEmailMeta('em_1')!));
    const datas = withHeader.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toContain('e:em_1:unsub');

    seedEmail(store, {});
    const without = buildEmailView(toViewRecord(store.getEmailMeta('em_1')!));
    const datas2 = without.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas2).not.toContain('e:em_1:unsub');
  });
});
