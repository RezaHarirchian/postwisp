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
import {
  openStore,
  type EmailEventLike,
  type EmailMeta,
  type Store,
} from '../src/core/store.js';

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
    fromAddr: 'boss@example.com',
    subject: 'Invoice for March',
    receivedAt: 1000,
    read: false,
    archived: false,
    trashed: false,
    labels: [],
    threadId: null,
    ...overrides,
  };
}

function sampleEvent(overrides: Partial<EmailEventLike> = {}): EmailEventLike {
  return {
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    from: 'boss@example.com',
    fromName: 'Big Boss',
    to: ['me@example.com'],
    subject: 'Invoice for March',
    dateMs: 1000,
    snippet: 'Please find the invoice attached',
    bodyText: 'The urgent invoice total is 500.',
    attachments: [{ id: 'a1', filename: 'invoice.pdf', size: 1234, mime: 'application/pdf' }],
    headers: { 'Message-Id': '<1@example.com>' },
    ...overrides,
  };
}

describe('schema v2 migration', () => {
  it('migrates a v1 database without losing rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postwisp-p1-'));
    const path = join(dir, 'store.db');
    // Hand-build a v1 database: old emails table, version stamped at 1.
    const db = new Database(path);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (1);
      CREATE TABLE emails (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, domain TEXT NOT NULL,
        from_addr TEXT NOT NULL, subject TEXT NOT NULL, received_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
        trashed INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '[]', thread_id TEXT
      );
      INSERT INTO emails (id, provider, domain, from_addr, subject, received_at)
        VALUES ('old_1', 'resend', 'example.com', 'a@b.c', 'Old mail', 42);
    `);
    db.close();

    const s = openStore(path);
    stores.push(s);
    const meta = s.getEmailMeta('old_1');
    expect(meta?.subject).toBe('Old mail');
    expect(meta?.snippet).toBe('');
    expect(meta?.attachments).toEqual([]);
    expect(meta?.snoozedUntilMs).toBeNull();
    // Rules and blocklist tables must exist after migration.
    expect(s.ruleList()).toEqual([]);
    expect(s.blockGet('x@y.z')).toBeNull();
  });
});

describe('saveFullEmail', () => {
  it('round-trips the extended fields', () => {
    const s = memStore();
    s.saveFullEmail(sampleEvent());
    const got = s.getEmailMeta('em_1');
    expect(got?.fromName).toBe('Big Boss');
    expect(got?.to).toEqual(['me@example.com']);
    expect(got?.dateMs).toBe(1000);
    expect(got?.snippet).toBe('Please find the invoice attached');
    expect(got?.bodyText).toBe('The urgent invoice total is 500.');
    expect(got?.attachments).toHaveLength(1);
    expect(got?.headers).toEqual({ 'Message-Id': '<1@example.com>' });
    expect(got?.read).toBe(false);
  });

  it('a base-only saveEmailMeta does not wipe stored extended fields', () => {
    const s = memStore();
    s.saveFullEmail(sampleEvent());
    s.saveEmailMeta(sampleMeta({ id: 'em_1', read: true }));
    const got = s.getEmailMeta('em_1');
    expect(got?.read).toBe(true);
    expect(got?.bodyText).toBe('The urgent invoice total is 500.');
    expect(got?.attachments).toHaveLength(1);
  });

  it('keeps working with old-style callers that never set extended fields', () => {
    const s = memStore();
    s.saveEmailMeta(sampleMeta({ id: 'em_2' }));
    expect(s.getEmailMeta('em_2')?.subject).toBe('Invoice for March');
    expect(s.listEmailMeta()).toHaveLength(1);
  });
});

describe('searchEmails', () => {
  function seeded(): Store {
    const s = memStore();
    s.saveFullEmail(sampleEvent({ id: 'em_1' }));
    s.saveFullEmail(
      sampleEvent({
        id: 'em_2',
        from: 'hr@example.com',
        fromName: 'HR Dept',
        subject: 'Welcome aboard',
        snippet: 'your first day',
        bodyText: 'Bring your laptop.',
        attachments: [],
      }),
    );
    s.saveFullEmail(
      sampleEvent({
        id: 'em_3',
        domain: 'other.com',
        from: 'boss@example.com',
        subject: 'Other domain mail',
        snippet: 'nothing of note',
        bodyText: 'nothing special',
        attachments: [],
      }),
    );
    return s;
  }

  it('matches from: case-insensitively against address and display name', () => {
    const s = seeded();
    expect(s.searchEmails({ from: 'BOSS' }).map((e) => e.id).sort()).toEqual(['em_1', 'em_3']);
    expect(s.searchEmails({ from: 'hr dept' }).map((e) => e.id)).toEqual(['em_2']);
  });

  it('matches subject: as a case-insensitive substring', () => {
    const s = seeded();
    expect(s.searchEmails({ subject: 'WELCOME' }).map((e) => e.id)).toEqual(['em_2']);
  });

  it('searches text across subject, snippet and body', () => {
    const s = seeded();
    expect(s.searchEmails({ text: 'invoice' }).map((e) => e.id)).toEqual(['em_1']);
    expect(s.searchEmails({ text: 'first day' }).map((e) => e.id)).toEqual(['em_2']);
    expect(s.searchEmails({ text: 'urgent' }).map((e) => e.id)).toEqual(['em_1']);
  });

  it('filters on hasAttachment', () => {
    const s = seeded();
    expect(s.searchEmails({ hasAttachment: true }).map((e) => e.id)).toEqual(['em_1']);
    expect(s.searchEmails({ hasAttachment: false }).map((e) => e.id).sort()).toEqual([
      'em_2',
      'em_3',
    ]);
  });

  it('combines operators and respects the domain filter', () => {
    const s = seeded();
    expect(
      s.searchEmails({ from: 'boss', text: 'nothing' }, { domain: 'other.com' }).map((e) => e.id),
    ).toEqual(['em_3']);
    expect(s.searchEmails({ from: 'boss' }, { domain: 'example.com' }).map((e) => e.id)).toEqual([
      'em_1',
    ]);
  });

  it('always excludes trashed mail', () => {
    const s = seeded();
    s.saveEmailMeta(sampleMeta({ id: 'em_1', trashed: true }));
    expect(s.searchEmails({ from: 'boss' }).map((e) => e.id)).toEqual(['em_3']);
  });

  it('excludes archived mail unless includeArchived is set', () => {
    const s = seeded();
    s.saveEmailMeta(sampleMeta({ id: 'em_2', archived: true }));
    expect(s.searchEmails({ subject: 'welcome' })).toEqual([]);
    expect(
      s.searchEmails({ subject: 'welcome' }, { includeArchived: true }).map((e) => e.id),
    ).toEqual(['em_2']);
  });

  it('treats LIKE wildcards in the query as literal characters', () => {
    const s = seeded();
    expect(s.searchEmails({ text: '100%' })).toEqual([]);
  });

  it('honours the limit', () => {
    const s = seeded();
    expect(s.searchEmails({}, { limit: 1 })).toHaveLength(1);
  });
});

describe('noteWebhookEvent', () => {
  it('returns true on first sight, false on replay', () => {
    const s = memStore();
    expect(s.noteWebhookEvent('evt_1')).toBe(true);
    expect(s.noteWebhookEvent('evt_1')).toBe(false);
    expect(s.noteWebhookEvent('evt_2')).toBe(true);
  });
});
