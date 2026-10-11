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
import {
  handleSignatureCallback,
  handleSignatureText,
} from '../src/bot/signatures.js';

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
  return createLogger({ stream: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

interface SentMessage {
  text: string;
  extra?: Record<string, unknown>;
}

function fakeCtx(): { ctx: Context; sent: SentMessage[]; setText(t: string): void } {
  const sent: SentMessage[] = [];
  const base = {
    chat: { id: 7001 },
    message: undefined as unknown,
    reply: async (text: string, extra?: Record<string, unknown>) => {
      sent.push({ text, extra });
      return { message_id: sent.length, chat: { id: 7001 }, date: 0, text };
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

describe('signatures store', () => {
  it('round-trips a signature per identity', () => {
    const store = memStore();
    expect(store.getSignature('me@example.com')).toBeNull();
    store.setSignature('me@example.com', 'Best,\nReza');
    expect(store.getSignature('me@example.com')).toBe('Best,\nReza');
    store.setSignature('other@example.com', 'Cheers');
    expect(store.getSignature('other@example.com')).toBe('Cheers');
    store.deleteSignature('me@example.com');
    expect(store.getSignature('me@example.com')).toBeNull();
  });

  it('normalizes identity case and ignores empty signatures', () => {
    const store = memStore();
    store.setSignature('ME@example.com', 'Sig');
    expect(store.getSignature('me@example.com')).toBe('Sig');
    store.setSignature('me@example.com', '   ');
    expect(store.getSignature('me@example.com')).toBe('Sig');
  });

  it('is wiped with the rest of the user data', () => {
    const store = memStore();
    store.setSignature('me@example.com', 'Sig');
    store.wipeAllData();
    expect(store.getSignature('me@example.com')).toBeNull();
  });
});

describe('compose signature append', () => {
  async function driveToSend(deps: ComposeDeps, f: ReturnType<typeof fakeCtx>): Promise<void> {
    await startCompose(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:new');
    f.setText('a@x.com');
    await handleComposeText(f.ctx, deps);
    f.setText('Hello');
    await handleComposeText(f.ctx, deps);
    f.setText('Body text here.');
    await handleComposeText(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:skipattach');
    await handleComposeCallback(f.ctx, deps, 'c:send');
  }

  it('appends the identity signature under the body', async () => {
    const store = memStore();
    withIdentity(store);
    store.setSignature('me@example.com', 'Best,\nReza');
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx();
    await driveToSend(deps, f);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.text).toBe('Body text here.\n\n-- \nBest,\nReza');
  });

  it('sends unchanged without a signature', async () => {
    const store = memStore();
    withIdentity(store);
    const { deps, sentEmails } = makeDeps(store);
    const f = fakeCtx();
    await driveToSend(deps, f);
    expect(sentEmails[0]!.text).toBe('Body text here.');
  });
});

describe('signature settings UI', () => {
  function sigDeps(store: Store) {
    return {
      store,
      domains: ['example.com'],
      backToSettings: async () => {},
    };
  }

  it('lists identities and saves a signature through the prompt', async () => {
    const store = memStore();
    withIdentity(store);
    const deps = sigDeps(store);
    const f = fakeCtx();
    await handleSignatureCallback(f.ctx, deps, 'sig:home');
    expect(f.sent[0]!.text).toContain('Choose an identity');
    const kb = f.sent[0]!.extra?.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    expect(kb.inline_keyboard.flat().map((b) => b.callback_data)).toContain('sig:pick:0');

    await handleSignatureCallback(f.ctx, deps, 'sig:pick:0');
    expect(f.sent[1]!.text).toContain('No signature set');

    await handleSignatureCallback(f.ctx, deps, 'sig:set:0');
    expect(f.sent[2]!.text).toContain('Type the signature');
    f.setText('Kind regards,\nReza');
    expect(await handleSignatureText(f.ctx, deps)).toBe(true);
    expect(store.getSignature('me@example.com')).toBe('Kind regards,\nReza');
    expect(f.sent[3]!.text).toContain('Signature saved');
  });

  it('clears a signature', async () => {
    const store = memStore();
    withIdentity(store);
    store.setSignature('me@example.com', 'Old');
    const deps = sigDeps(store);
    const f = fakeCtx();
    await handleSignatureCallback(f.ctx, deps, 'sig:clr:0');
    expect(store.getSignature('me@example.com')).toBeNull();
    expect(f.sent[0]!.text).toContain('cleared');
  });

  it('ignores text when no signature prompt is pending', async () => {
    const store = memStore();
    const f = fakeCtx();
    f.setText('hello');
    expect(await handleSignatureText(f.ctx, sigDeps(store))).toBe(false);
  });
});
