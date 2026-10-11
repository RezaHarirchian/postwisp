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

import { afterEach, describe, expect, it } from 'vitest';
import { checkSendCaps, recordSent } from '../src/core/caps.js';
import { openStore, type Store } from '../src/core/store.js';

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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('checkSendCaps', () => {
  it('allows a normal send', () => {
    const store = memStore();
    expect(checkSendCaps(store, ['bob@example.com'])).toEqual({ ok: true });
  });

  it('blocks a suppressed recipient', () => {
    const store = memStore();
    store.suppressAddress('dead@example.com', 'hard bounce');
    const result = checkSendCaps(store, ['ok@example.com', 'dead@example.com']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('suppressed');
  });

  it('blocks when the daily cap is reached', () => {
    const store = memStore();
    store.set(`send_count_${todayUtc()}`, '100');
    const result = checkSendCaps(store, ['bob@example.com']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('daily send limit');
  });

  it('allows one below the daily cap', () => {
    const store = memStore();
    store.set(`send_count_${todayUtc()}`, '99');
    expect(checkSendCaps(store, ['bob@example.com'])).toEqual({ ok: true });
  });

  it('blocks a recipient that hit the per-recipient cap', () => {
    const store = memStore();
    store.set(`sent_to_bob@example.com_${todayUtc()}`, '5');
    const result = checkSendCaps(store, ['bob@example.com']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('per-recipient');
      expect(result.reason).toContain('bob@example.com');
    }
    // Another recipient is unaffected.
    expect(checkSendCaps(store, ['alice@example.com'])).toEqual({ ok: true });
  });

  it('matches addresses case-insensitively against counters and suppression', () => {
    const store = memStore();
    store.suppressAddress('BOB@Example.COM', 'hard bounce');
    expect(checkSendCaps(store, ['bob@example.com']).ok).toBe(false);
    store.unsuppressAddress('bob@example.com');
    store.set(`sent_to_bob@example.com_${todayUtc()}`, '5');
    expect(checkSendCaps(store, ['BOB@EXAMPLE.COM']).ok).toBe(false);
  });
});

describe('recordSent', () => {
  it('increments the daily and per-recipient counters', () => {
    const store = memStore();
    recordSent(store, ['bob@example.com', 'alice@example.com']);
    expect(store.get(`send_count_${todayUtc()}`)).toBe('1');
    expect(store.get(`sent_to_bob@example.com_${todayUtc()}`)).toBe('1');
    expect(store.get(`sent_to_alice@example.com_${todayUtc()}`)).toBe('1');
    recordSent(store, ['bob@example.com']);
    expect(store.get(`send_count_${todayUtc()}`)).toBe('2');
    expect(store.get(`sent_to_bob@example.com_${todayUtc()}`)).toBe('2');
  });

  it('drives the caps end to end', () => {
    const store = memStore();
    for (let i = 0; i < 5; i += 1) {
      expect(checkSendCaps(store, ['bob@example.com'])).toEqual({ ok: true });
      recordSent(store, ['bob@example.com']);
    }
    expect(checkSendCaps(store, ['bob@example.com']).ok).toBe(false);
  });
});

describe('corrupt counters', () => {
  it('treats a non-finite counter as 0 and repairs it', () => {
    const store = memStore();
    const day = todayUtc();
    store.set(`send_count_${day}`, 'abc');
    store.set(`sent_to_bob@example.com_${day}`, 'NaN');
    expect(checkSendCaps(store, ['bob@example.com'])).toEqual({ ok: true });
    expect(store.get(`send_count_${day}`)).toBe('0');
    expect(store.get(`sent_to_bob@example.com_${day}`)).toBe('0');
  });

  it('still enforces the caps after repairing a corrupt counter', () => {
    const store = memStore();
    const day = todayUtc();
    store.set(`send_count_${day}`, 'junk');
    for (let i = 0; i < 100; i++) recordSent(store, ['bob@example.com']);
    expect(checkSendCaps(store, ['bob@example.com'])).toEqual({
      ok: false,
      reason: expect.stringContaining('daily send limit'),
    });
  });

  it('never persists NaN from recordSent', () => {
    const store = memStore();
    const day = todayUtc();
    store.set(`send_count_${day}`, 'oops');
    recordSent(store, ['Bob@Example.COM']);
    expect(store.get(`send_count_${day}`)).toBe('1');
    expect(store.get(`sent_to_bob@example.com_${day}`)).toBe('1');
  });
});
