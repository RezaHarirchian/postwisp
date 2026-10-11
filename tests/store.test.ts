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

import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore, type EmailMeta, type Store } from '../src/core/store.js';

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

function sampleMeta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    fromAddr: 'a@example.com',
    subject: 'hello',
    receivedAt: 1700000000000,
    read: false,
    archived: false,
    trashed: false,
    labels: [],
    threadId: null,
    ...overrides,
  };
}

describe('kv', () => {
  it('returns null for missing keys and round-trips values', () => {
    const s = memStore();
    expect(s.get('owner_id')).toBeNull();
    s.set('owner_id', '123');
    expect(s.get('owner_id')).toBe('123');
  });
});

describe('suppressed addresses', () => {
  it('suppresses case-insensitively and can be lifted', () => {
    const s = memStore();
    expect(s.isSuppressed('B@Example.com')).toBe(false);
    s.suppressAddress('B@Example.com', 'hard bounce');
    expect(s.isSuppressed('b@example.com')).toBe(true);
    s.unsuppressAddress('B@EXAMPLE.COM');
    expect(s.isSuppressed('b@example.com')).toBe(false);
  });

  it('trims surrounding whitespace on store and lookup', () => {
    const s = memStore();
    s.suppressAddress('  padded@example.com  ', 'bounce');
    expect(s.isSuppressed('padded@example.com')).toBe(true);
    expect(s.isSuppressed('  padded@example.com ')).toBe(true);
  });
});

describe('email metadata', () => {
  it('saves and reads back metadata with labels and flags', () => {
    const s = memStore();
    s.saveEmailMeta(sampleMeta({ labels: ['vip'], read: true, threadId: 't1' }));
    const got = s.getEmailMeta('em_1');
    expect(got?.labels).toEqual(['vip']);
    expect(got?.read).toBe(true);
    expect(got?.threadId).toBe('t1');
  });

  it('returns null for unknown ids', () => {
    expect(memStore().getEmailMeta('nope')).toBeNull();
  });

  it('lists newest first and filters by domain', () => {
    const s = memStore();
    s.saveEmailMeta(sampleMeta({ id: 'e1', domain: 'a.com', receivedAt: 100 }));
    s.saveEmailMeta(sampleMeta({ id: 'e2', domain: 'b.com', receivedAt: 300 }));
    s.saveEmailMeta(sampleMeta({ id: 'e3', domain: 'a.com', receivedAt: 200 }));
    expect(s.listEmailMeta().map((m) => m.id)).toEqual(['e2', 'e3', 'e1']);
    expect(s.listEmailMeta({ domain: 'a.com' }).map((m) => m.id)).toEqual(['e3', 'e1']);
    expect(s.listEmailMeta({ limit: 1 })).toHaveLength(1);
  });

  it('clamps a negative limit instead of dumping the table', () => {
    const s = memStore();
    s.saveEmailMeta(sampleMeta({ id: 'e1' }));
    expect(s.listEmailMeta({ limit: -1 })).toHaveLength(0);
  });

  it('upsert updates flags without duplicating', () => {
    const s = memStore();
    s.saveEmailMeta(sampleMeta({ read: false }));
    s.saveEmailMeta(sampleMeta({ read: true, archived: true }));
    expect(s.listEmailMeta()).toHaveLength(1);
    expect(s.getEmailMeta('em_1')?.read).toBe(true);
    expect(s.getEmailMeta('em_1')?.archived).toBe(true);
  });
});

describe('file-backed store', () => {
  it('persists across reopen and creates parent dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postwisp-store-'));
    const path = join(dir, 'nested', 'postwisp.db');
    const s1 = openStore(path);
    stores.push(s1);
    s1.set('k', 'v');
    s1.close();
    stores = stores.filter((x) => x !== s1);

    const s2 = openStore(path);
    stores.push(s2);
    expect(s2.get('k')).toBe('v');
  });

  it('creates the database file with 0600 permissions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postwisp-store-'));
    const path = join(dir, 'postwisp.db');
    const s = openStore(path);
    stores.push(s);
    s.set('k', 'v');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // WAL sidecars hold un-checkpointed email bodies too.
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
      if (existsSync(sidecar)) {
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    }
  });
});

describe('corrupt rows', () => {
  // Reaches past the Store API to corrupt a JSON column the way a bad
  // write or a disk glitch would.
  function corruptColumn(dbPath: string, table: string, column: string, id: string | number): void {
    const db = new Database(dbPath);
    try {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).run('{corrupt', id);
    } finally {
      db.close();
    }
  }

  it('skips email rows with corrupt JSON instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postwisp-store-'));
    const path = join(dir, 'postwisp.db');
    const s = openStore(path);
    stores.push(s);
    s.saveFullEmail({
      id: 'good',
      provider: 'resend',
      domain: 'example.com',
      from: 'a@b.c',
      subject: 'Good',
    });
    s.saveFullEmail({
      id: 'bad',
      provider: 'resend',
      domain: 'example.com',
      from: 'a@b.c',
      subject: 'Bad',
    });
    s.close();
    stores = stores.filter((x) => x !== s);
    corruptColumn(path, 'emails', 'labels', 'bad');

    const warns: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warns.push(args);
    let reopened;
    try {
      reopened = openStore(path);
      stores.push(reopened);
      expect(reopened.getEmailMeta('bad')).toBeNull();
      expect(reopened.getEmailMeta('good')?.subject).toBe('Good');
      expect(reopened.listEmailMeta().map((m) => m.id)).toEqual(['good']);
      expect(reopened.searchEmails({}).map((m) => m.id)).toEqual(['good']);
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBeGreaterThan(0);
  });

  it('skips draft and scheduled rows with corrupt JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postwisp-store-'));
    const path = join(dir, 'postwisp.db');
    const s = openStore(path);
    stores.push(s);
    const draftId = s.createDraft({ to: ['a@b.c'], subject: 's', body: 'b' });
    const schedId = s.scheduleSend({
      to: ['a@b.c'],
      subject: 's',
      body: 'b',
      sendAtMs: Date.now() + 3600_000,
    });
    s.close();
    stores = stores.filter((x) => x !== s);
    corruptColumn(path, 'drafts', 'to_json', draftId);
    corruptColumn(path, 'scheduled_sends', 'to_json', schedId);

    const orig = console.warn;
    console.warn = () => undefined;
    try {
      const reopened = openStore(path);
      stores.push(reopened);
      expect(reopened.getDraft(draftId)).toBeNull();
      expect(reopened.listDrafts()).toHaveLength(0);
      expect(reopened.listScheduled()).toHaveLength(0);
      expect(reopened.dueScheduled(Date.now() + 7200_000)).toHaveLength(0);
    } finally {
      console.warn = orig;
    }
  });
});

describe('consent log', () => {
  it('appends events and lists them newest-first', () => {
    const s = memStore();
    s.logConsent('unsubscribe', 'Reader@Example.org', 'one-click');
    s.logConsent('suppress', 'b@example.org', 'hard bounce');
    const rows = s.listConsentLog(10);
    expect(rows).toHaveLength(2);
    // Newest first.
    expect(rows[0]?.event).toBe('suppress');
    expect(rows[0]?.address).toBe('b@example.org');
    expect(rows[0]?.detail).toBe('hard bounce');
    expect(rows[1]?.address).toBe('reader@example.org');
    expect(typeof rows[0]?.ts).toBe('number');
  });

  it('respects the limit', () => {
    const s = memStore();
    for (let i = 0; i < 5; i++) s.logConsent('suppress', `u${i}@x.org`, 'hard bounce');
    expect(s.listConsentLog(3)).toHaveLength(3);
  });
});

describe('suppression listing and wipe', () => {
  it('lists suppressed addresses newest-first with reasons', () => {
    const s = memStore();
    s.suppressAddress('a@example.org', 'hard bounce');
    s.suppressAddress('b@example.org', 'complaint');
    const rows = s.listSuppressed(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.email).toBe('b@example.org');
    expect(rows[0]?.reason).toBe('complaint');
    expect(rows[1]?.email).toBe('a@example.org');
  });

  it('wipeAllData removes every user-data row but keeps the schema usable', () => {
    const s = memStore();
    s.saveEmailMeta(sampleMeta({ id: 'e1' }));
    s.set('k', 'v');
    s.suppressAddress('a@example.org', 'hard bounce');
    s.logConsent('unsubscribe', 'a@example.org', 'one-click');
    s.noteWebhookEvent('ev1');
    s.wipeAllData();
    expect(s.listEmailMeta()).toHaveLength(0);
    expect(s.get('k')).toBeNull();
    expect(s.isSuppressed('a@example.org')).toBe(false);
    expect(s.listConsentLog(10)).toHaveLength(0);
    expect(s.listSuppressed(10)).toHaveLength(0);
    expect(s.hasWebhookEvent('ev1')).toBe(false);
    // The database still works afterwards.
    s.set('k2', 'v2');
    expect(s.get('k2')).toBe('v2');
  });
});
