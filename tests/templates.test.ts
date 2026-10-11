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
import { openStore, type Store } from '../src/core/store.js';
import {
  addTemplate,
  applyTemplateVars,
  deleteTemplate,
  isTestMode,
  listIdentities,
  listTemplates,
  loadCaps,
  setTestMode,
} from '../src/core/templates.js';

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

describe('listIdentities', () => {
  it('returns an empty list when nothing is configured', () => {
    expect(listIdentities(memStore(), ['example.com'])).toEqual([]);
  });

  it('returns every identity when no domain filter is given', () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com', 'other@else.org']));
    expect(listIdentities(store, [])).toEqual(['me@example.com', 'other@else.org']);
  });

  it('drops identities outside the owned domains', () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com', 'stale@old.org']));
    expect(listIdentities(store, ['example.com'])).toEqual(['me@example.com']);
  });

  it('tolerates corrupt or non-array kv values', () => {
    const store = memStore();
    store.set('identities', 'not json');
    expect(listIdentities(store, [])).toEqual([]);
    store.set('identities', JSON.stringify({ nope: true }));
    expect(listIdentities(store, [])).toEqual([]);
  });
});

describe('templates', () => {
  it('starts empty and round-trips add/list/delete', () => {
    const store = memStore();
    expect(listTemplates(store)).toEqual([]);
    expect(addTemplate(store, { name: 'ooo', subject: 'Away', body: 'Back {{date}}.' })).toBe(true);
    expect(listTemplates(store)).toEqual([{ name: 'ooo', subject: 'Away', body: 'Back {{date}}.' }]);
    expect(deleteTemplate(store, 'ooo')).toBe(true);
    expect(listTemplates(store)).toEqual([]);
  });

  it('rejects duplicate names case-insensitively', () => {
    const store = memStore();
    expect(addTemplate(store, { name: 'Ooo', subject: 'a', body: 'b' })).toBe(true);
    expect(addTemplate(store, { name: 'ooo', subject: 'c', body: 'd' })).toBe(false);
    expect(listTemplates(store)).toHaveLength(1);
  });

  it('delete returns false for an unknown name', () => {
    expect(deleteTemplate(memStore(), 'missing')).toBe(false);
  });

  it('deletes case-insensitively, like the duplicate check', () => {
    const store = memStore();
    expect(addTemplate(store, { name: 'Out Of Office', subject: 'a', body: 'b' })).toBe(true);
    expect(deleteTemplate(store, 'out of office')).toBe(true);
    expect(listTemplates(store)).toEqual([]);
  });

  it('warns and reads empty on corrupt stored JSON', () => {
    const store = memStore();
    store.set('templates', '{not json');
    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    try {
      expect(listTemplates(store)).toEqual([]);
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBeGreaterThan(0);
    expect(String(warns[0]![0])).toContain('corrupt');
  });

  it('ignores malformed stored rows', () => {
    const store = memStore();
    store.set('templates', JSON.stringify([{ name: 'broken' }, 'nope', { name: 'ok', subject: 's', body: 'b' }]));
    expect(listTemplates(store)).toEqual([{ name: 'ok', subject: 's', body: 'b' }]);
  });
});

describe('applyTemplateVars', () => {
  it('substitutes the supported variables', () => {
    expect(
      applyTemplateVars('Hi {{to}}, on {{date}}.', { to: 'a@b.c', date: '2026-10-11' }),
    ).toBe('Hi a@b.c, on 2026-10-11.');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(applyTemplateVars('Keep {{unknown}} as is.', { to: 'a@b.c' })).toBe('Keep {{unknown}} as is.');
  });
});

describe('test mode', () => {
  it('is off by default and toggles', () => {
    const store = memStore();
    expect(isTestMode(store)).toBe(false);
    setTestMode(store, true);
    expect(isTestMode(store)).toBe(true);
    setTestMode(store, false);
    expect(isTestMode(store)).toBe(false);
  });
});

describe('loadCaps', () => {
  it('loads the real caps module (no permissive fallback)', async () => {
    const store = memStore();
    const caps = await loadCaps();
    // The real module enforces: a suppressed recipient is blocked.
    store.suppressAddress('a@b.c', 'hard bounce');
    expect(caps.checkSendCaps(store, ['a@b.c'])).toEqual({
      ok: false,
      reason: expect.stringContaining('suppressed'),
    });
    expect(() => caps.recordSent(store, ['ok@d.e'])).not.toThrow();
  });
});
