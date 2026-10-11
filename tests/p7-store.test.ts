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
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('schema v5', () => {
  it('creates the P7 tables on a fresh database', () => {
    const s = memStore();
    s.setSignature('me@example.com', 'Sig');
    expect(s.getSignature('me@example.com')).toBe('Sig');
    const id = s.addProviderKey({ provider: 'resend', label: 'K', apiKey: 'x' });
    expect(s.listProviderKeys()).toHaveLength(1);
    expect(id).toBeGreaterThan(0);
    s.noteSentMessage(7, 'em_1');
    expect(s.emailIdForMessage(7)).toBe('em_1');
  });

  it('migrates a v4 database: new tables appear, old data survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postwisp-p7-'));
    const path = join(dir, 'store.db');
    // Hand-build a v4 database: version stamp plus a subset of the real
    // tables; FULL_SCHEMA backfills the rest on open.
    const db = new Database(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (4);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO kv (key, value) VALUES ('identities', '["me@example.com"]');
      CREATE TABLE emails (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, domain TEXT NOT NULL,
        from_addr TEXT NOT NULL, subject TEXT NOT NULL, received_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        trashed INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', thread_id TEXT,
        from_name TEXT, to_json TEXT NOT NULL DEFAULT '[]', date_ms INTEGER,
        snippet TEXT NOT NULL DEFAULT '', body_text TEXT, body_html TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]', headers_json TEXT NOT NULL DEFAULT '{}',
        snoozed_until_ms INTEGER
      );
      INSERT INTO emails (id, provider, domain, from_addr, subject, received_at)
        VALUES ('old_1', 'resend', 'example.com', 'a@b.c', 'Old mail', 42);
    `);
    db.close();

    const s = openStore(path);
    stores.push(s);
    // Old data survived the migration.
    expect(s.getEmailMeta('old_1')?.subject).toBe('Old mail');
    expect(s.get('identities')).toBe('["me@example.com"]');
    // The P7 tables exist and work.
    s.setSignature('me@example.com', 'Sig');
    expect(s.getSignature('me@example.com')).toBe('Sig');
    s.addProviderKey({ provider: 'resend', label: 'K', apiKey: 'x' });
    expect(s.listProviderKeys('resend')).toHaveLength(1);
    s.noteSentMessage(9, 'old_1');
    expect(s.emailIdForMessage(9)).toBe('old_1');
  });
});
