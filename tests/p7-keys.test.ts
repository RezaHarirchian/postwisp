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
import { handleProviderKeyCallback, handleProviderKeyText } from '../src/bot/keys.js';

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

function fakeCtx(): {
  ctx: Context;
  sent: SentMessage[];
  setText(t: string): void;
} {
  const sent: SentMessage[] = [];
  const base = {
    chat: { id: 8001 },
    message: undefined as unknown,
    reply: async (text: string, extra?: Record<string, unknown>) => {
      sent.push({ text, extra });
      return { message_id: sent.length, chat: { id: 8001 }, date: 0, text };
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

function callbackDatas(sent: SentMessage[], index: number): string[] {
  const kb = sent[index]?.extra?.reply_markup as
    | { inline_keyboard?: Array<Array<{ callback_data?: string; text?: string }>> }
    | undefined;
  return (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
}

describe('provider_keys store', () => {
  it('round-trips keys and filters by provider', () => {
    const store = memStore();
    const id1 = store.addProviderKey({ provider: 'resend', label: 'Main', apiKey: 'k1' });
    store.addProviderKey({ provider: 'mailgun', label: 'Other', apiKey: 'k2' });
    expect(store.listProviderKeys()).toHaveLength(2);
    const resend = store.listProviderKeys('resend');
    expect(resend).toHaveLength(1);
    expect(resend[0]!.id).toBe(id1);
    expect(resend[0]!.label).toBe('Main');
    expect(resend[0]!.apiKey).toBe('k1');
    store.deleteProviderKey(id1);
    expect(store.listProviderKeys('resend')).toHaveLength(0);
  });

  it('is wiped with the rest of the user data', () => {
    const store = memStore();
    store.addProviderKey({ provider: 'resend', label: 'Main', apiKey: 'k1' });
    store.wipeAllData();
    expect(store.listProviderKeys()).toHaveLength(0);
  });
});

describe('compose key picker', () => {
  function makeDeps(store: Store): {
    deps: ComposeDeps;
    defaultSends: SendInput[];
    keySends: Array<{ keyId: number; input: SendInput }>;
  } {
    const defaultSends: SendInput[] = [];
    const keySends: Array<{ keyId: number; input: SendInput }> = [];
    const deps: ComposeDeps = {
      store,
      logger: quietLogger(),
      queue: null,
      ownerId: 999,
      domains: ['example.com'],
      providerName: 'resend',
      sendEmail: async (input: SendInput): Promise<SendResult> => {
        defaultSends.push(input);
        return { id: 'prov-default' };
      },
      sendEmailWithKey: async (keyId: number, input: SendInput): Promise<SendResult> => {
        keySends.push({ keyId, input });
        return { id: `prov-key-${keyId}` };
      },
    };
    return { deps, defaultSends, keySends };
  }

  async function driveToSend(f: ReturnType<typeof fakeCtx>, deps: ComposeDeps, keyData: string) {
    await startCompose(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:new');
    await handleComposeCallback(f.ctx, deps, keyData);
    f.setText('a@x.com');
    await handleComposeText(f.ctx, deps);
    f.setText('Hello');
    await handleComposeText(f.ctx, deps);
    f.setText('Body');
    await handleComposeText(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:skipattach');
    await handleComposeCallback(f.ctx, deps, 'c:send');
  }

  it('offers the key picker and routes the send through the picked key', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    const keyId = store.addProviderKey({ provider: 'resend', label: 'Second', apiKey: 'k2' });
    const { deps, defaultSends, keySends } = makeDeps(store);
    const f = fakeCtx();
    await startCompose(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:new');
    expect(f.sent[f.sent.length - 1]!.text).toContain('which provider key');
    expect(callbackDatas(f.sent, f.sent.length - 1)).toContain(`c:key:${keyId}`);

    const f2 = fakeCtx();
    await driveToSend(f2, deps, `c:key:${keyId}`);
    expect(keySends).toHaveLength(1);
    expect(keySends[0]!.keyId).toBe(keyId);
    expect(keySends[0]!.input.to).toEqual(['a@x.com']);
    expect(defaultSends).toHaveLength(0);
    expect(f2.sent[f2.sent.length - 1]!.text).toContain('Sent to a@x.com');
  });

  it('falls back to the default key when picked', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    store.addProviderKey({ provider: 'resend', label: 'Second', apiKey: 'k2' });
    const { deps, defaultSends, keySends } = makeDeps(store);
    const f = fakeCtx();
    await driveToSend(f, deps, 'c:key:def');
    expect(defaultSends).toHaveLength(1);
    expect(keySends).toHaveLength(0);
  });

  it('rejects an unknown key id', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    store.addProviderKey({ provider: 'resend', label: 'Second', apiKey: 'k2' });
    const { deps } = makeDeps(store);
    const f = fakeCtx();
    await startCompose(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:new');
    await handleComposeCallback(f.ctx, deps, 'c:key:999');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Something went wrong');
  });

  it('skips the picker entirely when no extra keys exist', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    const { deps, defaultSends } = makeDeps(store);
    const f = fakeCtx();
    await startCompose(f.ctx, deps);
    await handleComposeCallback(f.ctx, deps, 'c:new');
    // Single identity and no keys: straight to the To prompt.
    expect(f.sent[f.sent.length - 1]!.text).toContain('To?');
    expect(defaultSends).toHaveLength(0);
  });
});

describe('provider key settings UI', () => {
  function keyDeps(store: Store) {
    return {
      store,
      providerName: 'resend',
      backToSettings: async () => {},
    };
  }

  it('adds a key through the label/key prompts without echoing the key', async () => {
    const store = memStore();
    const deps = keyDeps(store);
    const f = fakeCtx();
    await handleProviderKeyCallback(f.ctx, deps, 'key:home');
    expect(f.sent[0]!.text).toContain('No extra provider keys');
    await handleProviderKeyCallback(f.ctx, deps, 'key:add');
    f.setText('Second account');
    expect(await handleProviderKeyText(f.ctx, deps)).toBe(true);
    f.setText('re_secret_value');
    expect(await handleProviderKeyText(f.ctx, deps)).toBe(true);
    const keys = store.listProviderKeys('resend');
    expect(keys).toHaveLength(1);
    expect(keys[0]!.label).toBe('Second account');
    // The key value never appears in bot output.
    expect(f.sent.map((m) => m.text).join('\n')).not.toContain('re_secret_value');
    expect(f.sent[f.sent.length - 1]!.text).toContain('Second account');
  });

  it('removes a key', async () => {
    const store = memStore();
    const id = store.addProviderKey({ provider: 'resend', label: 'Old', apiKey: 'k' });
    const deps = keyDeps(store);
    const f = fakeCtx();
    await handleProviderKeyCallback(f.ctx, deps, `key:rm:${id}`);
    expect(store.listProviderKeys('resend')).toHaveLength(0);
    expect(f.sent[0]!.text).toContain('removed');
  });

  it('ignores text when no key prompt is pending', async () => {
    const store = memStore();
    const f = fakeCtx();
    f.setText('hello');
    expect(await handleProviderKeyText(f.ctx, keyDeps(store))).toBe(false);
  });
});
