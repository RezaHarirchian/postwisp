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
import type { SendQueue, SendRequest } from '../src/bot/queue.js';
import type { SendInput, SendResult, EmailEvent } from '../src/providers/interface.js';
import { addRule } from '../src/core/inbox.js';
import { createInboundHandler } from '../src/bot/inbound.js';
import {
  handleComposeCallback,
  handleComposeDocument,
  handleComposeText,
  isTestMode,
  processDueScheduled,
  setTestMode,
  startCompose,
  type ComposeDeps,
} from '../src/bot/compose.js';

// Pin the caps module's behavior so the compose flows can be tested open,
// shut, and with a broken caps module (fail-closed path).
const capsState = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; reason: string },
  recordCalls: [] as string[][],
  loadFails: false,
}));
vi.mock('../src/core/templates.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/templates.js')>();
  return {
    ...mod,
    loadCaps: async () => {
      if (capsState.loadFails) throw new Error('cannot load caps module');
      return {
        checkSendCaps: () => capsState.result,
        recordSent: (_store: unknown, to: string[]) => {
          capsState.recordCalls.push(to);
        },
      };
    },
  };
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
  vi.unstubAllGlobals();
});
beforeEach(() => {
  capsState.result = { ok: true };
  capsState.recordCalls = [];
  capsState.loadFails = false;
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
  setDocument(fileId: string, fileName: string, fileSize: number): void;
  callbackData(data: string): Promise<boolean>;
}

let chatSeq = 1000;

function fakeCtx(deps: ComposeDeps): FakeCtx {
  const chatId = chatSeq++;
  const sent: SentMessage[] = [];
  let lastDocSize = 0;
  const base = {
    chat: { id: chatId },
    message: undefined as unknown,
    api: {
      token: 'test-token',
      getFile: async (_fileId: string) => ({ file_path: 'docs/f.bin', file_size: lastDocSize }),
    },
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
    setDocument(fileId: string, fileName: string, fileSize: number) {
      lastDocSize = fileSize;
      (base as { message: unknown }).message = {
        document: { file_id: fileId, file_name: fileName, file_size: fileSize },
      };
    },
    callbackData(data: string) {
      return handleComposeCallback(ctx, deps, data);
    },
  };
}

function makeDeps(store: Store, overrides: Partial<ComposeDeps> = {}): {
  deps: ComposeDeps;
  sentEmails: SendInput[];
} {
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
    ...overrides,
  };
  return { deps, sentEmails };
}

function withIdentity(store: Store, id = 'me@example.com'): void {
  store.set('identities', JSON.stringify([id]));
}

function callbackDatas(sent: SentMessage[], index: number): string[] {
  const kb = sent[index]?.extra?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
  return (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
}

// Drives the wizard up to the confirm screen: new -> to -> subject -> body
// -> skip attachment. Leaves the state on the confirm step.
async function driveToConfirm(f: FakeCtx, deps: ComposeDeps, to = 'a@x.com'): Promise<void> {
  await startCompose(f.ctx, deps);
  await f.callbackData('c:new');
  f.setText(to);
  await handleComposeText(f.ctx, deps);
  f.setText('Hello');
  await handleComposeText(f.ctx, deps);
  f.setText('Body text here.');
  await handleComposeText(f.ctx, deps);
  await f.callbackData('c:skipattach');
}

describe('compose wizard (U22)', () => {
  it('startCompose shows a notice when no identities exist', async () => {
    const store = memStore();
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain('No sending identities');
  });

  it('runs the full wizard and sends with an idempotency key', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps, 'a@x.com, b@y.org');

    const confirm = f.sent[f.sent.length - 1]!;
    expect(confirm.text).toContain('a@x.com, b@y.org');
    expect(confirm.text).toContain('Hello');
    expect(confirm.text).toContain('Body text here.');
    expect(confirm.text).toContain('me@example.com');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain('c:send');

    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(1);
    const input = sentEmails[0]!;
    expect(input.from).toBe('me@example.com');
    expect(input.to).toEqual(['a@x.com', 'b@y.org']);
    expect(input.subject).toBe('Hello');
    expect(input.text).toBe('Body text here.');
    // Stable per compose session, not a fresh UUID per call: a retried
    // Send tap resumes the same send instead of delivering twice.
    expect(/^postwisp-compose-[0-9a-f-]{36}$/.test(input.idempotencyKey ?? '')).toBe(true);

    const row = store.getSentByProviderId('prov-1');
    expect(row).not.toBeNull();
    expect(row!.to).toBe('a@x.com, b@y.org');
    expect(row!.subject).toBe('Hello');
    expect(row!.domain).toBe('example.com');
    expect(row!.chatId).toBe(999);
    expect(row!.messageId).toBeGreaterThan(0);
    expect(capsState.recordCalls).toEqual([['a@x.com', 'b@y.org']]);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Sent to a@x.com, b@y.org.');
  });

  it('rejects an invalid To address and stays on the step', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    f.setText('not-an-address');
    const consumed = await handleComposeText(f.ctx, deps);
    expect(consumed).toBe(true);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Not a valid address');
    // Still on the To step: a valid address now proceeds to Subject.
    f.setText('ok@x.com');
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Subject?');
    expect(sentEmails).toHaveLength(0);
  });

  it('blocks sending when caps say no, and retries after they clear', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    capsState.result = { ok: false, reason: 'daily cap reached' };
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(0);
    expect(f.sent[f.sent.length - 1]!.text).toContain('daily cap reached');
    capsState.result = { ok: true };
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(1);
  });

  it('fails closed when the caps module cannot load: no uncapped send', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    capsState.loadFails = true;
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(0);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Cannot send right now');
    // The wizard state survives: the owner can retry once the module loads.
    capsState.loadFails = false;
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(1);
  });

  it('offers an identity picker when several identities exist', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['one@example.com', 'two@example.com']));
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toEqual(['c:id:0', 'c:id:1']);
    await f.callbackData('c:id:1');
    expect(f.sent[f.sent.length - 1]!.text).toContain('To?');
  });

  it('cancel discards the wizard', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    await f.callbackData('c:cancel');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Discarded.');
    f.setText('a@x.com');
    expect(await handleComposeText(f.ctx, deps)).toBe(false);
  });
});

describe('drafts (U23)', () => {
  it('saves a draft from the confirm screen and lists it with actions', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    await f.callbackData('c:savedraft');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Draft saved.');
    expect(store.listDrafts()).toHaveLength(1);

    await f.callbackData('c:drafts');
    const last = f.sent[f.sent.length - 1]!;
    expect(last.text).toContain('a@x.com');
    const datas = callbackDatas(f.sent, f.sent.length - 1);
    expect(datas).toContain('c:dopen:1');
    expect(datas).toContain('c:dsend:1');
    expect(datas).toContain('c:ddel:1');
  });

  it('opens a draft prefilled on the confirm screen', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    const id = store.createDraft({ to: ['d@x.com'], subject: 'Drafted', body: 'Later.', identity: 'me@example.com' });
    await f.callbackData('c:dopen:' + id);
    const confirm = f.sent[f.sent.length - 1]!;
    expect(confirm.text).toContain('Drafted');
    expect(confirm.text).toContain('Later.');
    expect(confirm.text).toContain('d@x.com');
  });

  it('sends a draft from the list and removes it', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    const id = store.createDraft({ to: ['d@x.com'], subject: 'Drafted', body: 'Later.', identity: 'me@example.com' });
    await f.callbackData('c:dsend:' + id);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toEqual(['d@x.com']);
    // Stable per draft: a retried Send tap resumes the same send.
    expect(sentEmails[0]!.idempotencyKey).toBe(`postwisp-draftsend-${id}`);
    expect(store.getDraft(id)).toBeNull();
    expect(store.getSentByProviderId('prov-1')).not.toBeNull();
  });

  it('reuses the idempotency key when Send is tapped twice after a failure', async () => {
    const store = memStore();
    withIdentity(store);
    const seenKeys: Array<string | undefined> = [];
    const sentEmails: SendInput[] = [];
    let failNext = true;
    const { deps } = makeDeps(store, {
      sendEmail: async (input: SendInput): Promise<SendResult> => {
        seenKeys.push(input.idempotencyKey);
        if (failNext) {
          failNext = false;
          throw new Error('connection lost after the provider accepted it');
        }
        sentEmails.push(input);
        return { id: `prov-${sentEmails.length}` };
      },
    });
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    // First tap: the provider send throws (e.g. the response was lost).
    // The wizard state survives a failed send.
    await f.callbackData('c:send');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Sending failed');
    // Second tap retries the same compose session: both attempts carry
    // the same stable key, so the provider dedupes them into one send.
    await f.callbackData('c:send');
    expect(sentEmails).toHaveLength(1);
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toMatch(/^postwisp-compose-[0-9a-f-]{36}$/);
    expect(seenKeys[1]).toBe(seenKeys[0]);
  });

  it('deletes a draft and reports an unknown one', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    const id = store.createDraft({ to: ['d@x.com'], subject: 's', body: 'b' });
    await f.callbackData('c:ddel:' + id);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Draft deleted.');
    expect(store.getDraft(id)).toBeNull();
    await f.callbackData('c:dopen:4242');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Draft not found.');
  });

  it('rejects a draft-delete tap with a non-integer id', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    const id = store.createDraft({ to: ['d@x.com'], subject: 's', body: 'b' });
    await f.callbackData('c:ddel:notanint');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Something went wrong');
    expect(store.getDraft(id)).not.toBeNull();
  });
});

describe('scheduling (U24)', () => {
  it('schedules with the +1h preset and lists it with a cancel button', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    await f.callbackData('c:schedule');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain('c:sch:1h');
    const before = Date.now();
    await f.callbackData('c:sch:1h');
    const rows = store.listScheduled();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sendAtMs).toBeGreaterThanOrEqual(before + 3599_000);
    expect(rows[0]!.to).toEqual(['a@x.com']);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Scheduled for');

    await f.callbackData('c:schedlist');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain(`c:schcancel:${rows[0]!.id}`);
    await f.callbackData(`c:schcancel:${rows[0]!.id}`);
    expect(store.listScheduled()).toHaveLength(0);
    expect(f.sent[f.sent.length - 1]!.text).toContain('cancelled');
  });

  function futureCustomText(daysAhead: number): string {
    const d = new Date(Date.now() + daysAhead * 86400_000 + 3600_000);
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  it('accepts a custom time inside 30 days', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    await f.callbackData('c:schedule');
    await f.callbackData('c:sch:custom');
    f.setText(futureCustomText(5));
    expect(await handleComposeText(f.ctx, deps)).toBe(true);
    expect(store.listScheduled()).toHaveLength(1);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Scheduled for');
  });

  it('rejects bad, past, and too-far custom times', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await driveToConfirm(f, deps);
    await f.callbackData('c:schedule');
    await f.callbackData('c:sch:custom');

    f.setText('tomorrow-ish');
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('YYYY-MM-DD HH:MM');

    f.setText('2020-01-01 10:00');
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('in the past');

    f.setText(futureCustomText(40));
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('30 days');

    expect(store.listScheduled()).toHaveLength(0);
  });

  it('processDueScheduled sends due rows, even long overdue, and logs them', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const id1 = store.scheduleSend({
      to: ['late@x.com'],
      subject: 'Overdue',
      body: 'Still goes.',
      identity: 'me@example.com',
      sendAtMs: Date.now() - 30 * 3600_000,
    });
    store.scheduleSend({
      to: ['future@x.com'],
      subject: 'Later',
      body: 'Not yet.',
      sendAtMs: Date.now() + 3600_000,
    });
    await processDueScheduled(deps);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toEqual(['late@x.com']);
    // The key is stable per scheduled row: a retry after a lost response
    // resumes the same send instead of delivering a duplicate.
    expect(sentEmails[0]!.idempotencyKey).toBe(`postwisp-sched-${id1}`);
    expect(store.dueScheduled(Date.now())).toHaveLength(0);
    const row = store.getSentByProviderId('prov-1');
    expect(row).not.toBeNull();
    expect(row!.to).toBe('late@x.com');
    expect(row!.domain).toBe('example.com');
    expect(capsState.recordCalls).toEqual([['late@x.com']]);
  });

  it('processDueScheduled leaves a failed send pending for the next run', async () => {
    const store = memStore();
    withIdentity(store);
    let fail = true;
    const { deps, sentEmails } = makeDeps(store, {
      sendEmail: async (input: SendInput) => {
        if (fail) throw new Error('provider down');
        sentEmails.push(input);
        return { id: 'prov-ok' };
      },
    });
    store.scheduleSend({ to: ['x@y.z'], subject: 's', body: 'b', sendAtMs: Date.now() - 1000 });
    await processDueScheduled(deps);
    expect(store.dueScheduled(Date.now())).toHaveLength(1);
    fail = false;
    await processDueScheduled(deps);
    expect(store.dueScheduled(Date.now())).toHaveLength(0);
  });

  it('resolves {{date}} at fire time, not at schedule time', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    store.scheduleSend({
      to: ['a@x.com'],
      subject: 'Report {{date}}',
      body: 'Today is {{date}}.',
      identity: 'me@example.com',
      sendAtMs: Date.now() - 1000,
    });
    await processDueScheduled(deps);
    expect(sentEmails).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    expect(sentEmails[0]!.subject).toBe(`Report ${today}`);
    expect(sentEmails[0]!.text).toBe(`Today is ${today}.`);
  });

  it('stores scheduled sends with template variables unresolved', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    f.setText('a@x.com');
    await handleComposeText(f.ctx, deps);
    f.setText('Dated');
    await handleComposeText(f.ctx, deps);
    f.setText('Today is {{date}}.');
    await handleComposeText(f.ctx, deps);
    await f.callbackData('c:skipattach');
    await f.callbackData('c:schedule');
    await f.callbackData('c:sch:1h');
    const rows = store.listScheduled();
    expect(rows).toHaveLength(1);
    // Raw: the date must not be baked in at schedule time.
    expect(rows[0]!.body).toContain('{{date}}');
  });
});

describe('templates (U26)', () => {
  it('adds a template through the button flow and lists it', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:tmpl');
    expect(f.sent[f.sent.length - 1]!.text).toContain('No templates yet.');
    await f.callbackData('c:tadd');
    f.setText('ooo');
    await handleComposeText(f.ctx, deps);
    f.setText('Out of office');
    await handleComposeText(f.ctx, deps);
    f.setText('Hi {{to}}, back {{date}}.');
    await handleComposeText(f.ctx, deps);
    expect(f.sent.some((m) => m.text.includes('Template saved.'))).toBe(true);
    await f.callbackData('c:tmpl');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain('c:tdel:0');
  });

  it('rejects a duplicate template name in the add flow', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    store.set('templates', JSON.stringify([{ name: 'ooo', subject: 's', body: 'b' }]));
    await f.callbackData('c:tadd');
    f.setText('OOO');
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('already exists');
  });

  it('deletes a template', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    store.set('templates', JSON.stringify([{ name: 'ooo', subject: 's', body: 'b' }]));
    await f.callbackData('c:tdel:0');
    expect(f.sent.some((m) => m.text.includes('Template deleted.'))).toBe(true);
    expect(f.sent[f.sent.length - 1]!.text).toContain('No templates yet.');
  });

  it('applies a template in the wizard with variable substitution', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    store.set(
      'templates',
      JSON.stringify([{ name: 'greet', subject: 'Hello {{to}}', body: 'Hi {{to}}, today is {{date}}.' }]),
    );
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    // The To prompt offers the template button.
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain('c:usetmpl');
    await f.callbackData('c:usetmpl');
    await f.callbackData('c:tpl:0');
    // Subject and body came from the template, so only To is asked.
    f.setText('friend@x.com');
    await handleComposeText(f.ctx, deps);
    expect(f.sent[f.sent.length - 1]!.text).toContain('Attach a file');
    await f.callbackData('c:skipattach');
    const confirm = f.sent[f.sent.length - 1]!;
    expect(confirm.text).toContain('Hello friend@x.com');
    expect(confirm.text).toContain('Hi friend@x.com, today is');
    expect(confirm.text).not.toContain('{{to}}');
    await f.callbackData('c:send');
    expect(sentEmails[0]!.subject).toBe('Hello friend@x.com');
    expect(sentEmails[0]!.text).toContain('Hi friend@x.com, today is');
  });
});

describe('attachments', () => {
  function stubFetch(): void {
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
        }) as unknown as Response,
    );
  }

  it('attaches a document under the cap and sends it along', async () => {
    stubFetch();
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    f.setText('a@x.com');
    await handleComposeText(f.ctx, deps);
    f.setText('With file');
    await handleComposeText(f.ctx, deps);
    f.setText('See attached.');
    await handleComposeText(f.ctx, deps);
    await f.callbackData('c:attach');
    f.setDocument('file-1', 'notes.txt', 4);
    expect(await handleComposeDocument(f.ctx, deps)).toBe(true);
    const confirm = f.sent[f.sent.length - 1]!;
    expect(confirm.text).toContain('notes.txt');
    await f.callbackData('c:send');
    expect(sentEmails[0]!.attachments).toHaveLength(1);
    expect(sentEmails[0]!.attachments![0]!.filename).toBe('notes.txt');
  });

  it('rejects a document over 20 MB and stays on the attach step', async () => {
    stubFetch();
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    await f.callbackData('c:new');
    f.setText('a@x.com');
    await handleComposeText(f.ctx, deps);
    f.setText('s');
    await handleComposeText(f.ctx, deps);
    f.setText('b');
    await handleComposeText(f.ctx, deps);
    await f.callbackData('c:attach');
    f.setDocument('file-big', 'huge.bin', 21 * 1024 * 1024);
    expect(await handleComposeDocument(f.ctx, deps)).toBe(true);
    expect(f.sent[f.sent.length - 1]!.text).toContain('over 20 MB');
    // A second, small document still works: the wizard did not advance.
    f.setDocument('file-2', 'small.txt', 4);
    expect(await handleComposeDocument(f.ctx, deps)).toBe(true);
    expect(f.sent[f.sent.length - 1]!.text).toContain('small.txt');
  });

  it('ignores documents when no wizard is waiting for one', async () => {
    const store = memStore();
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    f.setDocument('file-1', 'x.txt', 4);
    expect(await handleComposeDocument(f.ctx, deps)).toBe(false);
  });
});

describe('test mode (U32)', () => {
  it('toggles and banners the compose flow', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps } = makeDeps(store);
    expect(isTestMode(store)).toBe(false);
    setTestMode(store, true);
    expect(isTestMode(store)).toBe(true);

    const f = fakeCtx(deps);
    await startCompose(f.ctx, deps);
    expect(f.sent[0]!.text).toContain('TEST MODE');
    await f.callbackData('c:new');
    expect(f.sent[f.sent.length - 1]!.text).toContain('delivered@resend.dev');
  });
});

describe('callback scheme', () => {
  it('ignores non-c: callback data', async () => {
    const store = memStore();
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    expect(await handleComposeCallback(f.ctx, deps, 'inbox:123')).toBe(false);
  });

  it('ignores text with no active wizard', async () => {
    const store = memStore();
    const { deps } = makeDeps(store);
    const f = fakeCtx(deps);
    f.setText('hello?');
    expect(await handleComposeText(f.ctx, deps)).toBe(false);
  });
});

function fakeQueue(): { queue: SendQueue; sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  return {
    sent,
    queue: {
      enqueue(_chatId: number, req: SendRequest): void {
        sent.push(req);
      },
      stop(): void {},
    },
  };
}

function sampleEvent(overrides: Partial<EmailEvent> = {}): EmailEvent {
  return {
    id: 'ev-1',
    provider: 'resend',
    domain: 'example.com',
    from: { address: 'boss@example.com', name: 'Boss' },
    to: ['me@example.com'],
    subject: 'Invoice #42',
    dateMs: 1700000000000,
    snippet: 'please pay soon',
    bodyText: 'Please pay the invoice.',
    bodyHtml: null,
    attachments: [],
    threadId: null,
    headers: {},
    ...overrides,
  };
}

describe('auto-reply sending (U27)', () => {
  it('sends the reply through the injected sender and keeps a one-line owner notice', async () => {
    const store = memStore();
    withIdentity(store);
    store.set('identities', JSON.stringify(['me@example.com', 'me@other.org']));
    addRule(store, { name: 'ooo', matchFrom: 'boss', action: 'autoreply', actionArg: 'Out of office.' });
    const sentEmails: SendInput[] = [];
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      sendEmail: async (input: SendInput) => {
        sentEmails.push(input);
        return { id: 'prov-ar-1' };
      },
    });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-ar-1' }));
    expect(sentEmails).toHaveLength(1);
    const input = sentEmails[0]!;
    expect(input.from).toBe('me@example.com');
    expect(input.to).toEqual(['boss@example.com']);
    expect(input.subject).toBe('Re: Invoice #42');
    expect(input.text).toBe('Out of office.');
    // Stable per email (content hash here: no message-id header), so a
    // duplicate delivery of the same email cannot send the reply twice.
    expect(input.idempotencyKey).toMatch(/^postwisp-autoreply:hash:[0-9a-f]{64}$/);
    const row = store.getSentByProviderId('prov-ar-1');
    expect(row).not.toBeNull();
    expect(row!.to).toBe('boss@example.com');
    expect(row!.domain).toBe('example.com');
    expect(capsState.recordCalls).toEqual([['boss@example.com']]);
    expect(sent.some((s) => s.text.includes('Auto-replied to boss@example.com.'))).toBe(true);
  });

  it('prefers the identity on the recipient domain', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com', 'me@other.org']));
    addRule(store, { name: 'ooo', matchFrom: 'boss', action: 'autoreply', actionArg: 'Away.' });
    const sentEmails: SendInput[] = [];
    const { queue } = fakeQueue();
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      sendEmail: async (input: SendInput) => {
        sentEmails.push(input);
        return { id: 'prov-ar-2' };
      },
    });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-ar-2', domain: 'other.org' }));
    expect(sentEmails[0]!.from).toBe('me@other.org');
  });

  it('skips with a notice when no identity is configured', async () => {
    const store = memStore();
    addRule(store, { name: 'ooo', matchFrom: 'boss', action: 'autoreply', actionArg: 'Away.' });
    const sentEmails: SendInput[] = [];
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      sendEmail: async (input: SendInput) => {
        sentEmails.push(input);
        return { id: 'prov-ar-3' };
      },
    });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-ar-3' }));
    expect(sentEmails).toHaveLength(0);
    expect(sent.some((s) => s.text.includes('no sending identity'))).toBe(true);
  });
});
