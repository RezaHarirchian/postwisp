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
import { defaultConfig } from '../src/core/config.js';
import { openStore, type Store } from '../src/core/store.js';
import { createLogger } from '../src/core/logger.js';
import {
  clearPairingToken,
  fetchBotUsername,
  generatePairingToken,
  pairingLink,
  pairingTokenMatches,
  readPairingToken,
  runPairCommand,
  storePairingToken,
  PAIRING_TOKEN_TTL_MS,
  type FetchImpl,
} from '../src/cli/commands/pair.js';
import { pairingMiddleware } from '../src/bot/index.js';
import { withPairingTokenRedaction } from '../src/core/pairing.js';

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

function getMeFetch(username: string): FetchImpl {
  return async () =>
    new Response(JSON.stringify({ ok: true, result: { username } }), { status: 200 });
}

function statusFetch(status: number): FetchImpl {
  return async () => new Response('{}', { status });
}

describe('generatePairingToken', () => {
  it('returns 64 hex chars and is unique', () => {
    const a = generatePairingToken();
    const b = generatePairingToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('builds the exact deep-link format', () => {
    expect(pairingLink('TestBot', 'abc123')).toBe('https://t.me/TestBot?start=abc123');
  });
});

describe('pairing token kv round-trip', () => {
  it('stores, reads and clears a token with a 15 minute expiry', () => {
    const store = memStore();
    const now = 1_000_000;
    storePairingToken(store, 'tok', now);
    const read = readPairingToken(store);
    expect(read).toEqual({ token: 'tok', expiresAtMs: now + PAIRING_TOKEN_TTL_MS });
    expect(PAIRING_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
    clearPairingToken(store);
    expect(readPairingToken(store)).toBeNull();
  });

  it('matches only the exact unexpired token', () => {
    const stored = { token: 'tok', expiresAtMs: 2000 };
    expect(pairingTokenMatches(stored, 'tok', 1999)).toBe(true);
    expect(pairingTokenMatches(stored, 'tok', 2000)).toBe(false);
    expect(pairingTokenMatches(stored, 'other', 1999)).toBe(false);
    expect(pairingTokenMatches(stored, 'tokk', 1999)).toBe(false);
    expect(pairingTokenMatches(null, 'tok', 1999)).toBe(false);
  });
});

describe('fetchBotUsername', () => {
  it('resolves the username on success', async () => {
    await expect(fetchBotUsername('any-token', getMeFetch('MyBot'))).resolves.toBe('MyBot');
  });

  it('fails with a fix command when Telegram rejects the token, without leaking it', async () => {
    const token = 'secret-bot-token-value';
    await expect(fetchBotUsername(token, statusFetch(401))).rejects.toThrowError(/postwisp setup/);
    try {
      await fetchBotUsername(token, statusFetch(401));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });

  it('fails with a fix command on network errors, without leaking the token', async () => {
    const token = 'secret-bot-token-value';
    const failing: FetchImpl = async () => {
      throw new Error('boom');
    };
    await expect(fetchBotUsername(token, failing)).rejects.toThrowError(/postwisp setup/);
    try {
      await fetchBotUsername(token, failing);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });
});

describe('runPairCommand', () => {
  it('refuses without a bot token and names the fix', async () => {
    const out: string[] = [];
    await expect(
      runPairCommand({ config: defaultConfig(), store: memStore(), out: (l) => out.push(l) }),
    ).rejects.toThrowError(/postwisp setup/);
  });

  it('prints a deep link and stores a fresh token', async () => {
    const out: string[] = [];
    const store = memStore();
    const now = 5_000_000;
    await runPairCommand(
      {
        config: { ...defaultConfig(), botToken: 'tok' },
        store,
        fetchImpl: getMeFetch('PairBot'),
        nowMs: () => now,
        out: (l) => out.push(l),
      },
      {},
    );
    const text = out.join('\n');
    expect(text).toMatch(/https:\/\/t\.me\/PairBot\?start=[0-9a-f]{64}/);
    expect(text).toContain('15 minutes');
    const stored = readPairingToken(store);
    expect(stored?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.expiresAtMs).toBe(now + PAIRING_TOKEN_TTL_MS);
    // The printed token is the stored one.
    expect(text).toContain(stored?.token ?? 'missing');
  });

  it('rotates: the old token stops matching and a new link is printed', async () => {
    const out: string[] = [];
    const store = memStore();
    const base = {
      config: { ...defaultConfig(), botToken: 'tok' },
      store,
      fetchImpl: getMeFetch('PairBot'),
      out: (l: string) => out.push(l),
    };
    await runPairCommand({ ...base, nowMs: () => 1000 });
    const first = readPairingToken(store)?.token;
    await runPairCommand({ ...base, nowMs: () => 2000 }, { rotate: true });
    const second = readPairingToken(store)?.token;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
    expect(out.join('\n')).toContain('Previous pairing link invalidated.');
    expect(pairingTokenMatches(readPairingToken(store), first ?? '', 2000)).toBe(false);
    expect(pairingTokenMatches(readPairingToken(store), second ?? '', 2000)).toBe(true);
  });
});

describe('pairingMiddleware', () => {
  const logger = createLogger({ stream: { write: () => true } as NodeJS.WritableStream });

  function fakeCtx(text: string | undefined, fromId: number | undefined, chatType = 'private') {
    const replies: string[] = [];
    const ctx = {
      chat: { id: 1, type: chatType },
      message: text === undefined ? undefined : { text },
      from: fromId === undefined ? undefined : { id: fromId },
      reply: async (msg: string) => {
        replies.push(msg);
      },
    } as unknown as Context;
    return { ctx, replies };
  }

  function setup(token: string, nowMs: number) {
    const store = memStore();
    storePairingToken(store, token, nowMs);
    const saved: number[] = [];
    let nextCalls = 0;
    const mw = pairingMiddleware({
      store,
      logger,
      saveOwner: (id) => saved.push(id),
      nowMs: () => nowMs,
    });
    return { store, saved, mw, next: async () => nextCalls++, nextCalls: () => nextCalls };
  }

  it('pairs on /start with a matching token: saves owner, clears token, stops the chain', async () => {
    const { store, saved, mw } = setup('a'.repeat(64), 1000);
    const { ctx, replies } = fakeCtx(`/start ${'a'.repeat(64)}`, 777);
    let nextCalls = 0;
    await mw(ctx, async () => nextCalls++);
    expect(saved).toEqual([777]);
    expect(readPairingToken(store)).toBeNull();
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('Paired');
    // The pairing tap never reaches the owner guard.
    expect(nextCalls).toBe(0);
  });

  it('a replayed tap after pairing falls through (single use)', async () => {
    const { saved, mw } = setup('a'.repeat(64), 1000);
    const { ctx } = fakeCtx(`/start ${'a'.repeat(64)}`, 777);
    let nextCalls = 0;
    const next = async () => nextCalls++;
    await mw(ctx, next);
    await mw(ctx, next);
    expect(saved).toEqual([777]);
    expect(nextCalls).toBe(1);
  });

  it('falls through on a wrong token', async () => {
    const { saved, mw, next, nextCalls } = setup('a'.repeat(64), 1000);
    const { ctx } = fakeCtx(`/start ${'b'.repeat(64)}`, 777);
    await mw(ctx, next);
    expect(nextCalls()).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('falls through on an expired token', async () => {
    const store = memStore();
    storePairingToken(store, 'a'.repeat(64), 1000);
    const saved: number[] = [];
    let nextCalls = 0;
    const mw = pairingMiddleware({
      store,
      logger,
      saveOwner: (id) => saved.push(id),
      nowMs: () => 1000 + PAIRING_TOKEN_TTL_MS + 1,
    });
    const { ctx } = fakeCtx(`/start ${'a'.repeat(64)}`, 777);
    await mw(ctx, async () => nextCalls++);
    expect(nextCalls).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it('falls through on /start without a payload and on plain text', async () => {
    const { mw, next, nextCalls } = setup('a'.repeat(64), 1000);
    await mw(fakeCtx('/start', 777).ctx, next);
    await mw(fakeCtx('hello', 777).ctx, next);
    expect(nextCalls()).toBe(2);
  });

  it('falls through when there is no sender or no store', async () => {
    const { mw, next, nextCalls } = setup('a'.repeat(64), 1000);
    await mw(fakeCtx(`/start ${'a'.repeat(64)}`, undefined).ctx, next);
    const noStore = pairingMiddleware({ store: undefined, logger, nowMs: () => 1000 });
    await noStore(fakeCtx(`/start ${'a'.repeat(64)}`, 777).ctx, next);
    expect(nextCalls()).toBe(2);
  });

  it('accepts /start@BotName with a payload', async () => {
    const { saved, mw, next } = setup('a'.repeat(64), 1000);
    const { ctx } = fakeCtx(`/start@PairBot ${'a'.repeat(64)}`, 42);
    await mw(ctx, next);
    expect(saved).toEqual([42]);
  });

  it('rejects pairing taps from non-private chats without consuming the token', async () => {
    const token = 'c'.repeat(64);
    const { store, saved, mw } = setup(token, 1000);
    let nextCalls = 0;
    const { ctx, replies } = fakeCtx(`/start ${token}`, 777, 'group');
    await mw(ctx, async () => nextCalls++);
    expect(saved).toHaveLength(0);
    expect(nextCalls).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('private chat');
    // The token survives: the owner can retry from a 1:1 chat.
    expect(readPairingToken(store)?.token).toBe(token);
  });
});

describe('withPairingTokenRedaction', () => {
  function capturingLogger() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    return { lines, logger: createLogger({ stream }) };
  }

  it('masks the live pairing token in log lines', async () => {
    const { lines, logger } = capturingLogger();
    const store = memStore();
    const token = 'd'.repeat(64);
    storePairingToken(store, token, Date.now());
    const wrapped = withPairingTokenRedaction(logger, store);
    wrapped.info(`saw token ${token} here`, { detail: `also ${token}` });
    expect(lines.join('')).not.toContain(token);
    expect(lines.join('')).toContain('[redacted]');
  });

  it('stops masking after the token is cleared and passes other text through', async () => {
    const { lines, logger } = capturingLogger();
    const store = memStore();
    storePairingToken(store, 'e'.repeat(64), Date.now());
    const wrapped = withPairingTokenRedaction(logger, store);
    clearPairingToken(store);
    wrapped.info('plain message', { n: 1 });
    expect(lines.join('')).toContain('plain message');
  });

  it('returns the logger unchanged without a store', async () => {
    const { logger } = capturingLogger();
    expect(withPairingTokenRedaction(logger, undefined)).toBe(logger);
  });
});
