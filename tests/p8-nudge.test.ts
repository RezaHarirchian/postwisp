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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { openStore, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import type { LlmClient } from '../src/core/llm.js';
import { findNudgeCandidates } from '../src/core/nudge.js';
import { handleAiCallback, runNudgeCheck, type AiActionDeps } from '../src/bot/ai-actions.js';
import type { SendQueue } from '../src/bot/queue.js';
import { t } from '../src/core/i18n.js';

const DAY = 86400_000;
const T0 = new Date('2026-10-01T12:00:00Z').getTime();

let stores: Store[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
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

// Logs a send at a controlled time: the clock is faked, so logSent stamps
// whatever the fake now is.
function logSentAt(store: Store, atMs: number, opts: { to?: string; subject?: string; status?: string; providerId?: string } = {}): number {
  vi.setSystemTime(atMs);
  const providerId = opts.providerId ?? `prov_${atMs}`;
  store.logSent({
    providerId,
    to: opts.to ?? 'client@example.com',
    subject: opts.subject ?? 'Proposal',
    domain: 'example.com',
    ...(opts.status ? { status: opts.status } : {}),
  });
  const row = store.getSentByProviderId(providerId);
  // Back to the test's "now": callers advance the clock explicitly.
  vi.setSystemTime(T0);
  if (!row) throw new Error('sent log row missing');
  return row.id;
}

function inboundReply(store: Store, receivedAt: number, subject = 'Re: Proposal'): void {
  store.saveFullEmail({
    id: `in_${receivedAt}`,
    provider: 'resend',
    domain: 'example.com',
    from: 'client@example.com',
    subject,
    receivedAt,
  });
}

describe('findNudgeCandidates', () => {
  it('flags sent mail older than the interval with no reply', () => {
    const store = memStore();
    const sentId = logSentAt(store, T0 - 4 * DAY);
    const found = findNudgeCandidates(store, T0, 3);
    expect(found.map((c) => c.sentId)).toEqual([sentId]);
    expect(found[0]).toMatchObject({ to: 'client@example.com', subject: 'Proposal' });
  });

  it('ignores recent sends', () => {
    const store = memStore();
    logSentAt(store, T0 - 2 * DAY);
    expect(findNudgeCandidates(store, T0, 3)).toEqual([]);
  });

  it('ignores sent mail that got a Re: reply', () => {
    const store = memStore();
    logSentAt(store, T0 - 4 * DAY);
    inboundReply(store, T0 - 3 * DAY);
    expect(findNudgeCandidates(store, T0, 3)).toEqual([]);
  });

  it('does not count mail received before the send as a reply', () => {
    const store = memStore();
    logSentAt(store, T0 - 4 * DAY);
    inboundReply(store, T0 - 5 * DAY);
    expect(findNudgeCandidates(store, T0, 3)).toHaveLength(1);
  });

  it('does not count an unrelated subject as a reply', () => {
    const store = memStore();
    logSentAt(store, T0 - 4 * DAY);
    inboundReply(store, T0 - 3 * DAY, 'Something else');
    expect(findNudgeCandidates(store, T0, 3)).toHaveLength(1);
  });

  it('skips terminal delivery states', () => {
    const store = memStore();
    logSentAt(store, T0 - 4 * DAY, { status: 'bounced', providerId: 'p_bounce' });
    logSentAt(store, T0 - 4 * DAY, { status: 'failed', providerId: 'p_fail' });
    expect(findNudgeCandidates(store, T0, 3)).toEqual([]);
  });

  it('skips dismissed and snoozed items, revives expired snoozes', () => {
    const store = memStore();
    const dismissed = logSentAt(store, T0 - 4 * DAY, { providerId: 'p_dis' });
    const snoozed = logSentAt(store, T0 - 4 * DAY, { providerId: 'p_snz' });
    const expired = logSentAt(store, T0 - 4 * DAY, { providerId: 'p_exp' });
    store.setNudgeState(dismissed, null, true);
    store.setNudgeState(snoozed, T0 + DAY, false);
    store.setNudgeState(expired, T0 - DAY, false);
    const found = findNudgeCandidates(store, T0, 3);
    expect(found.map((c) => c.sentId)).toEqual([expired]);
  });
});

describe('runNudgeCheck', () => {
  function fakeQueue(): { queue: SendQueue; enqueued: Array<{ chatId: number; text: string }> } {
    const enqueued: Array<{ chatId: number; text: string }> = [];
    const queue = {
      enqueue: (chatId: number, req: { text: string }) => {
        enqueued.push({ chatId, text: req.text });
      },
    } as unknown as SendQueue;
    return { queue, enqueued };
  }

  it('notifies the owner and auto-snoozes the nudge', async () => {
    const store = memStore();
    const sentId = logSentAt(store, T0 - 4 * DAY);
    const { queue, enqueued } = fakeQueue();
    const notified = await runNudgeCheck({ store, logger: quietLogger(), queue, ownerId: 999, nudgeDays: 3 });
    expect(notified).toBe(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.chatId).toBe(999);
    expect(enqueued[0]!.text).toContain('client@example.com');
    // Auto-snooze: the next check stays quiet until the interval passes.
    const state = store.getNudgeState(sentId);
    expect(state?.dismissed).toBe(false);
    expect(state?.snoozedUntilMs).toBe(T0 + 3 * DAY);
    vi.setSystemTime(T0 + DAY);
    const again = await runNudgeCheck({ store, logger: quietLogger(), queue, ownerId: 999, nudgeDays: 3 });
    expect(again).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  it('does nothing when there is nothing stale', async () => {
    const store = memStore();
    logSentAt(store, T0 - DAY);
    const { queue, enqueued } = fakeQueue();
    expect(await runNudgeCheck({ store, logger: quietLogger(), queue, ownerId: 999, nudgeDays: 3 })).toBe(0);
    expect(enqueued).toEqual([]);
  });
});

describe('nudge callbacks', () => {
  function fakeCtx(): { ctx: Context; replies: string[] } {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 999, type: 'private' },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 1, chat: { id: 999 }, date: 0, text };
      },
    } as unknown as Context;
    return { ctx, replies };
  }

  function deps(store: Store): AiActionDeps {
    const llm: LlmClient = { chatJson: async () => ({}) };
    return { store, logger: quietLogger(), llm, sendDeps: null, ownerId: 999, nudgeDays: 3 };
  }

  it('snooze pushes the nudge out by the interval', async () => {
    const store = memStore();
    const sentId = logSentAt(store, T0 - 4 * DAY);
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, deps(store), `ai:snz:${sentId}`);
    expect(replies[0]).toBe(t('bot.ai.nudgeSnoozed'));
    expect(store.getNudgeState(sentId)?.snoozedUntilMs).toBe(T0 + 3 * DAY);
    expect(findNudgeCandidates(store, T0, 3)).toEqual([]);
  });

  it('dismiss stops the nudge for good', async () => {
    const store = memStore();
    const sentId = logSentAt(store, T0 - 4 * DAY);
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, deps(store), `ai:dis:${sentId}`);
    expect(replies[0]).toBe(t('bot.ai.nudgeDismissed'));
    expect(store.getNudgeState(sentId)?.dismissed).toBe(true);
    vi.setSystemTime(T0 + 30 * DAY);
    expect(findNudgeCandidates(store, T0 + 30 * DAY, 3)).toEqual([]);
  });

  it('ignores malformed ids', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    await handleAiCallback(ctx, deps(store), 'ai:snz:abc');
    await handleAiCallback(ctx, deps(store), 'ai:dis:0');
    expect(replies).toEqual([]);
  });
});
