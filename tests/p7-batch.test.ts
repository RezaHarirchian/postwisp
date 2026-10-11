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
import type { SendInput, SendResult } from '../src/providers/interface.js';
import {
  handleComposeCallback,
  handleComposeText,
  startCompose,
  type ComposeDeps,
} from '../src/bot/compose.js';

// Same caps pinning as bot-compose.test.ts: the flows run open by default.
const capsState = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; reason: string },
}));
vi.mock('../src/core/templates.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/templates.js')>();
  return {
    ...mod,
    loadCaps: async () => ({
      checkSendCaps: () => capsState.result,
      recordSent: () => {},
    }),
  };
});

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});
beforeEach(() => {
  capsState.result = { ok: true };
});

function memStore(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}

function quietLogger(): Logger {
  const stream = new Writable({ write(_c, _e, cb) { cb(); } });
  return createLogger({ stream });
}

interface SentMessage {
  text: string;
  extra?: Record<string, unknown>;
}

interface FakeCtx {
  ctx: Context;
  sent: SentMessage[];
  setText(text: string): void;
  callbackData(data: string): Promise<boolean>;
}

let chatSeq = 5000;

function fakeCtx(deps: ComposeDeps): FakeCtx {
  const chatId = chatSeq++;
  const sent: SentMessage[] = [];
  const base = {
    chat: { id: chatId },
    message: undefined as unknown,
    reply: async (text: string, extra?: Record<string, unknown>) => {
      sent.push({ text, extra });
      return { message_id: sent.length, chat: { id: chatId }, date: 0, text };
    },
    answerCallbackQuery: async () => true,
  };
  const ctx = base as unknown as Context;
  return {
    ctx,
    sent,
    setText(text: string) {
      (base as { message: unknown }).message = { text };
    },
    callbackData(data: string) {
      return handleComposeCallback(ctx, deps, data);
    },
  };
}

function makeDeps(store: Store): { deps: ComposeDeps; sentEmails: SendInput[] } {
  const sentEmails: SendInput[] = [];
  const deps: ComposeDeps = {
    store,
    logger: quietLogger(),
    queue: null,
    ownerId: 999,
    domains: ['example.com'],
    sendEmail: async (input: SendInput): Promise<SendResult> => {
      sentEmails.push(input);
      return { id: `prov-${sentEmails.length}` };
    },
  };
  return { deps, sentEmails };
}

function withIdentity(store: Store, id = 'me@example.com'): void {
  store.set('identities', JSON.stringify([id]));
}

function addrs(n: number): string {
  return Array.from({ length: n }, (_, i) => `r${i}@x.com`).join(', ');
}

function callbackDatas(sent: SentMessage[], index: number): string[] {
  const kb = sent[index]?.extra?.reply_markup as
    | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
    | undefined;
  return (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
}

// Drives the wizard to the confirm screen with a batch recipient list.
async function driveToBatchConfirm(f: FakeCtx, deps: ComposeDeps, n = 11): Promise<void> {
  await startCompose(f.ctx, deps);
  await f.callbackData('c:new');
  f.setText(addrs(n));
  await handleComposeText(f.ctx, deps);
  f.setText('Batch subject');
  await handleComposeText(f.ctx, deps);
  f.setText('Batch body');
  await handleComposeText(f.ctx, deps);
}

describe('batch send (P7)', () => {
  it('rejects more than 100 recipients at the To step', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    f.setText(addrs(101));
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('at most 100');
  });

  it('skips attachments for batch and requires the review step', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToBatchConfirm(f, deps);

    // No attachment question: the step after the body is the confirm
    // screen, carrying the transactional-only warning.
    const confirm = f.sent[f.sent.length - 1]!;
    expect(confirm.text).toContain('transactional bulk notifications');
    const datas = callbackDatas(f.sent, f.sent.length - 1);
    expect(datas).toContain('c:batchreview');
    expect(datas).not.toContain('c:send');
    expect(sentEmails).toHaveLength(0);
  });

  it('routes even a direct c:send on a batch to the review step', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToBatchConfirm(f, deps);
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(0);
    expect(f.sent[f.sent.length - 1]!.text).toContain('transactional bulk notifications');
  });

  it('batchreview lists recipients; batchsend delivers', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToBatchConfirm(f, deps, 12);
    await f.callbackData('c:batchreview');
    const reviewTexts = f.sent.map((m) => m.text).join('\n');
    expect(reviewTexts).toContain('Batch recipients (12)');
    expect(reviewTexts).toContain('r0@x.com');
    expect(reviewTexts).toContain('r11@x.com');
    const datas = callbackDatas(f.sent, f.sent.length - 1);
    expect(datas).toContain('c:batchsend');

    await f.callbackData('c:batchsend');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toHaveLength(12);
    expect(sentEmails[0]!.attachments ?? []).toEqual([]);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Batch sent to 12 recipients');
  });

  it('blocks a 101-recipient draft at the deliver() gate', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    const id = store.createDraft({
      to: addrs(101).split(', '),
      subject: 'x',
      body: 'y',
      identity: 'me@example.com',
    });
    await f.callbackData(`c:dsend:${id}`);
    expect(sentEmails).toHaveLength(0);
    expect(f.sent[f.sent.length - 1]!.text).toContain('at most 100');
  });

  it('a small send still goes through the single Send button', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    f.setText('a@x.com, b@y.org');
    await handleComposeText(f.ctx, deps);
    f.setText('Hello');
    await handleComposeText(f.ctx, deps);
    f.setText('Body');
    await handleComposeText(f.ctx, deps);
    await f.callbackData('c:skipattach');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain('c:send');
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(1);
  });
});
