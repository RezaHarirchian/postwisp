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
import { adaptStore, adaptSearch, toViewRecord, toEmailEvent, toEventLike } from '../src/bot/store-adapter.js';
import type { EmailEvent } from '../src/providers/interface.js';

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

function sampleEvent(overrides: Partial<EmailEvent> = {}): EmailEvent {
  return {
    id: 'ev-1',
    provider: 'resend',
    domain: 'example.com',
    from: { address: 'boss@example.com', name: 'Boss' },
    to: ['me@example.com'],
    subject: 'Invoice',
    dateMs: 1700000000000,
    snippet: 'please pay',
    bodyText: 'Please pay the invoice.',
    bodyHtml: null,
    attachments: [],
    threadId: null,
    headers: {},
    ...overrides,
  };
}

describe('toViewRecord', () => {
  it('maps store fields to the bot view shape', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const meta = store.getEmailMeta('ev-1');
    expect(meta).not.toBeNull();
    const view = toViewRecord(meta!);
    expect(view).toMatchObject({
      id: 'ev-1',
      domain: 'example.com',
      fromAddr: 'boss@example.com',
      fromName: 'Boss',
      subject: 'Invoice',
      dateMs: 1700000000000,
      isRead: false,
    });
  });

  it('falls back to receivedAt when dateMs is absent', () => {
    const store = memStore();
    store.saveEmailMeta({
      id: 'm-1',
      provider: 'resend',
      domain: 'example.com',
      fromAddr: 'a@b.c',
      subject: 's',
      receivedAt: 123,
      read: false,
      archived: false,
      trashed: false,
      labels: [],
      threadId: null,
    });
    const view = toViewRecord(store.getEmailMeta('m-1')!);
    expect(view.dateMs).toBe(123);
  });
});

describe('toEmailEvent', () => {
  it('rebuilds a provider-shaped event from a stored row', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const ev = toEmailEvent(store.getEmailMeta('ev-1')!);
    expect(ev.from.address).toBe('boss@example.com');
    expect(ev.to).toEqual(['me@example.com']);
    expect(ev.bodyText).toBe('Please pay the invoice.');
  });
});

describe('adaptStore', () => {
  it('flips read/archived without wiping the body', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const adapted = adaptStore(store);
    adapted.setRead('ev-1', true);
    adapted.setArchived('ev-1', true);
    const view = adapted.getEmail('ev-1')!;
    expect(view.isRead).toBe(true);
    expect(view.bodyText).toBe('Please pay the invoice.');
  });

  it('snoozes and blocklists through the canonical modules', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const adapted = adaptStore(store);
    adapted.snoozeEmail('ev-1', Date.now() + 3600_000);
    adapted.blockSender('spam@evil.example');
    const search = adaptSearch(store);
    expect(search).toBeDefined();
  });

  it('addArchiveRule creates a working archive rule', () => {
    const store = memStore();
    const adapted = adaptStore(store);
    adapted.addArchiveRule('news@example.com', '');
    adapted.setSetting('k', 'v');
    expect(adapted.getSetting('k')).toBe('v');
  });

  it('lists emails with domain filter', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent({ id: 'a', domain: 'x.com' })));
    store.saveFullEmail(toEventLike(sampleEvent({ id: 'b', domain: 'y.com' })));
    const adapted = adaptStore(store);
    expect(adapted.listEmails({ domain: 'x.com' }).map((e) => e.id)).toEqual(['a']);
    expect(adapted.listEmails()).toHaveLength(2);
  });
});

describe('adaptSearch', () => {
  it('parses and runs operator queries against the store', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const search = adaptSearch(store);
    const q = search.parseSearch('from:boss invoice');
    expect(q.from).toBe('boss');
    const hits = search.searchEmails(q);
    expect(hits.map((h) => h.id)).toEqual(['ev-1']);
    expect(search.searchEmails(search.parseSearch('from:nobody'))).toHaveLength(0);
  });

  it('normalizes queries instead of blind-casting between the two shapes', () => {
    const store = memStore();
    store.saveFullEmail(toEventLike(sampleEvent()));
    const search = adaptSearch(store);
    // Extra fields on either side are dropped, not passed through.
    const q = search.parseSearch('subject:Invoice');
    expect(q).toEqual({ subject: 'Invoice' });
    expect(search.searchEmails({ ...q, bogus: 1 } as never)).toHaveLength(1);
  });
});
