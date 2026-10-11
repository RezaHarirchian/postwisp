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

describe('drafts', () => {
  it('creates, reads, updates, lists and deletes', () => {
    const store = memStore();
    const id = store.createDraft({ to: ['a@b.c'], subject: 's', body: 'b', identity: 'me@x.com' });
    expect(store.getDraft(id)?.subject).toBe('s');
    store.updateDraft(id, { subject: 's2' });
    expect(store.getDraft(id)?.subject).toBe('s2');
    expect(store.getDraft(id)?.to).toEqual(['a@b.c']);
    expect(store.listDrafts()).toHaveLength(1);
    store.deleteDraft(id);
    expect(store.getDraft(id)).toBeNull();
  });
});

describe('scheduled sends', () => {
  it('schedules, lists due, marks sent and cancels', () => {
    const store = memStore();
    const past = Date.now() - 1000;
    const future = Date.now() + 3600_000;
    const id1 = store.scheduleSend({ to: ['a@b.c'], subject: 'now', body: 'b', sendAtMs: past });
    const id2 = store.scheduleSend({ to: ['a@b.c'], subject: 'later', body: 'b', sendAtMs: future });
    expect(store.dueScheduled(Date.now()).map((s) => s.id)).toEqual([id1]);
    store.markScheduledSent(id1, 'prov-1');
    expect(store.dueScheduled(Date.now())).toHaveLength(0);
    store.cancelScheduled(id2);
    expect(store.listScheduled()).toHaveLength(0);
  });
});

describe('sent log', () => {
  it('logs, looks up by provider id, updates status and filters by domain', () => {
    const store = memStore();
    store.logSent({ providerId: 'p1', to: 'a@b.c', subject: 'hi', domain: 'b.c', chatId: 7, messageId: 9 });
    expect(store.getSentByProviderId('p1')?.status).toBe('sent');
    store.updateSentStatus('p1', 'delivered');
    expect(store.getSentByProviderId('p1')?.status).toBe('delivered');
    expect(store.listSentLog({ domain: 'b.c' })).toHaveLength(1);
    expect(store.listSentLog({ domain: 'other' })).toHaveLength(0);
  });
});
