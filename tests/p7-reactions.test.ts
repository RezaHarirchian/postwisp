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
import type { MessageReactionUpdated } from 'grammy/types';
import { openStore, type EmailMeta, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import {
  handleMessageReaction,
  reactionStoreSeams,
  thumbsUpAdded,
} from '../src/bot/reactions.js';

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

function reaction(newEmojis: string[]): MessageReactionUpdated {
  return {
    chat: { id: 999, type: 'private' },
    message_id: 42,
    user: { id: 999, is_bot: false, first_name: 'Owner' },
    old_reaction: [],
    new_reaction: newEmojis.map((emoji) => ({ type: 'emoji', emoji })),
    date: 0,
  } as unknown as MessageReactionUpdated;
}

function fakeCtx(fromId: number, reactionUpdate?: MessageReactionUpdated): {
  ctx: Context;
  replies: string[];
} {
  const replies: string[] = [];
  const ctx = {
    from: { id: fromId },
    chat: { id: 999 },
    messageReaction: reactionUpdate,
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1, chat: { id: 999 }, date: 0, text };
    },
  } as unknown as Context;
  return { ctx, replies };
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
  };
  store.saveEmailMeta(meta);
}

describe('thumbsUpAdded', () => {
  it('detects a thumbs-up among the new reactions', () => {
    expect(thumbsUpAdded(reaction(['👍']))).toBe(true);
    expect(thumbsUpAdded(reaction(['❤️', '👍']))).toBe(true);
  });

  it('ignores other emoji, removals, and missing updates', () => {
    expect(thumbsUpAdded(reaction(['❤️']))).toBe(false);
    expect(thumbsUpAdded(reaction([]))).toBe(false);
    expect(thumbsUpAdded(undefined)).toBe(false);
  });
});

describe('message_id -> email_id mapping', () => {
  it('round-trips and overwrites on re-notify', () => {
    const store = memStore();
    expect(store.emailIdForMessage(42)).toBeNull();
    store.noteSentMessage(42, 'em_1');
    expect(store.emailIdForMessage(42)).toBe('em_1');
    store.noteSentMessage(42, 'em_2');
    expect(store.emailIdForMessage(42)).toBe('em_2');
  });

  it('is wiped with the rest of the user data', () => {
    const store = memStore();
    store.noteSentMessage(42, 'em_1');
    store.wipeAllData();
    expect(store.emailIdForMessage(42)).toBeNull();
  });
});

describe('handleMessageReaction', () => {
  function deps(store: Store, ownerId: number | null = 999) {
    const seams = reactionStoreSeams(store);
    return {
      ownerId,
      setArchived: seams.setArchived,
      emailIdForMessage: seams.emailIdForMessage,
      logger: quietLogger(),
    };
  }

  it('archives the email on the owner’s thumbs-up', async () => {
    const store = memStore();
    seedEmail(store);
    store.noteSentMessage(42, 'em_1');
    const { ctx, replies } = fakeCtx(999, reaction(['👍']));
    await handleMessageReaction(ctx, deps(store));
    expect(store.getEmailMeta('em_1')?.archived).toBe(true);
    expect(replies[0]).toContain('Archived');
  });

  it('ignores reactions from anyone but the owner', async () => {
    const store = memStore();
    seedEmail(store);
    store.noteSentMessage(42, 'em_1');
    const { ctx, replies } = fakeCtx(123, reaction(['👍']));
    await handleMessageReaction(ctx, deps(store));
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    expect(replies).toHaveLength(0);
  });

  it('ignores reactions on unknown messages and non-thumbs-up', async () => {
    const store = memStore();
    seedEmail(store);
    const d = deps(store);
    const { ctx: ctx1, replies: r1 } = fakeCtx(999, reaction(['👍']));
    await handleMessageReaction(ctx1, d);
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    expect(r1).toHaveLength(0);

    store.noteSentMessage(42, 'em_1');
    const { ctx: ctx2, replies: r2 } = fakeCtx(999, reaction(['❤️']));
    await handleMessageReaction(ctx2, d);
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    expect(r2).toHaveLength(0);
  });

  it('does nothing without an owner configured', async () => {
    const store = memStore();
    seedEmail(store);
    store.noteSentMessage(42, 'em_1');
    const { ctx, replies } = fakeCtx(999, reaction(['👍']));
    await handleMessageReaction(ctx, deps(store, null));
    expect(store.getEmailMeta('em_1')?.archived).toBe(false);
    expect(replies).toHaveLength(0);
  });
});
