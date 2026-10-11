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
import { openStore, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import { addRule, blockAddress } from '../src/core/inbox.js';
import { createInboundHandler } from '../src/bot/inbound.js';
import { takeDigestQueue } from '../src/bot/digest.js';
import type { SendQueue, SendRequest } from '../src/bot/queue.js';
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

function quietLogger(): Logger {
  const stream = new Writable({ write(_c, _e, cb) { cb(); } });
  return createLogger({ stream });
}

// Synchronous fake queue: records instead of pacing.
function fakeQueue(): { queue: SendQueue; sent: SendRequest[] } {
  const sent: SendRequest[] = [];
  return {
    sent,
    queue: {
      enqueue(_chatId: number, req: SendRequest): void {
        sent.push(req);
      },
      stop(): void {},
    },
  };
}

function sampleEvent(overrides: Partial<EmailEvent> = {}): EmailEvent {
  return {
    id: 'ev-1',
    provider: 'resend',
    domain: 'example.com',
    from: { address: 'boss@example.com', name: 'Boss' },
    to: ['me@example.com'],
    subject: 'Invoice #42',
    dateMs: 1700000000000,
    snippet: 'please pay soon',
    bodyText: 'Please pay the invoice.',
    bodyHtml: null,
    attachments: [],
    threadId: null,
    headers: {},
    ...overrides,
  };
}

describe('createInboundHandler', () => {
  it('persists the email and notifies the owner', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent());
    expect(store.getEmailMeta('ev-1')?.subject).toBe('Invoice #42');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Invoice #42');
    expect(sent[0]!.extra?.protectContent).toBe(true);
  });

  it('skips notification for blocked senders but still stores', async () => {
    const store = memStore();
    blockAddress(store, 'spam@evil.example');
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-2', from: { address: 'spam@evil.example' } }));
    expect(store.getEmailMeta('ev-2')).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('honors silent rules: stored, no notification', async () => {
    const store = memStore();
    addRule(store, { name: 'mute news', matchFrom: 'news', action: 'silent' });
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-3', from: { address: 'news@example.com' } }));
    expect(store.getEmailMeta('ev-3')).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('applies label and archive rule outcomes to the stored row', async () => {
    const store = memStore();
    addRule(store, { name: 'tag boss', matchFrom: 'boss', action: 'label', actionArg: 'work' });
    addRule(store, { name: 'archive receipts', matchSubject: 'receipt', action: 'archive' });
    const { queue } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-4', subject: 'receipt for lunch' }));
    const meta = store.getEmailMeta('ev-4')!;
    expect(meta.labels).toContain('work');
    expect(meta.archived).toBe(true);
  });

  it('queues into the digest during quiet hours instead of notifying', async () => {
    const store = memStore();
    store.set('quiet_start', '00:00');
    store.set('quiet_end', '23:59');
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-5' }));
    expect(sent).toHaveLength(0);
    expect(takeDigestQueue(store, false)).toContain('ev-5');
  });

  it('queues into the digest when digest mode is on', async () => {
    const store = memStore();
    store.set('digest_mode', 'hourly');
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-6' }));
    expect(sent).toHaveLength(0);
    expect(takeDigestQueue(store, false)).toContain('ev-6');
  });

  it('stores without notifying when no queue is wired', async () => {
    const store = memStore();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue: null, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-7' }));
    expect(store.getEmailMeta('ev-7')).not.toBeNull();
  });

  it('surfaces autoreply rule matches to the owner instead of staying silent', async () => {
    const store = memStore();
    addRule(store, { name: 'ooo', matchFrom: 'boss', action: 'autoreply', actionArg: 'Out of office.' });
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-8' }));
    // One notice about the pending reply plus the normal notification.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.some((s) => s.text.includes('auto-reply'))).toBe(true);
  });
});

describe('STOP replies', () => {
  it('suppresses the sender, logs consent, and notifies the owner instead of the inbox flow', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(
      sampleEvent({ id: 'ev-stop', from: { address: 'reader@example.org' }, bodyText: '  STOP ' }),
    );
    // The email is still stored; the sender is suppressed.
    expect(store.getEmailMeta('ev-stop')).not.toBeNull();
    expect(store.isSuppressed('reader@example.org')).toBe(true);
    const log = store.listConsentLog(10);
    expect(log[0]?.event).toBe('unsubscribe');
    expect(log[0]?.address).toBe('reader@example.org');
    expect(log[0]?.detail).toBe('STOP reply');
    // The owner hears about the unsubscribe, not a new-mail notification.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('reader@example.org');
    expect(sent[0]!.text).toContain('STOP');
  });

  it('does not treat ordinary mail as an unsubscribe', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(
      sampleEvent({ id: 'ev-ok', from: { address: 'reader@example.org' }, bodyText: 'Please stop by tomorrow' }),
    );
    expect(store.isSuppressed('reader@example.org')).toBe(false);
    expect(sent[0]!.text).toContain('Invoice #42');
  });
});

describe('cross-endpoint inbound dedupe', () => {
  it('notifies once when the same email arrives via two endpoints', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    const headers = { 'message-id': '<dup-1@mail.example>' };
    // Same email, different provider event ids: one per ingest endpoint.
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-a', headers }));
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-b', headers }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Invoice #42');
  });

  it('dedupes by content hash when no message-id is present', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-a' }));
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-b' }));
    expect(sent).toHaveLength(1);
  });

  it('still notifies for genuinely different emails', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    await handler.handleEmailEvent(
      sampleEvent({ id: 'ev-a', headers: { 'message-id': '<one@mail.example>' } }),
    );
    await handler.handleEmailEvent(
      sampleEvent({ id: 'ev-b', headers: { 'message-id': '<two@mail.example>' }, subject: 'Other' }),
    );
    expect(sent).toHaveLength(2);
  });

  it('fires an autoreply rule only once for a duplicated delivery', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    const { queue } = fakeQueue();
    const sentEmails: string[] = [];
    const handler = createInboundHandler({
      store,
      logger: quietLogger(),
      queue,
      ownerId: 7,
      sendEmail: async (input) => {
        sentEmails.push(input.idempotencyKey ?? '');
        return { id: 'prov-1' };
      },
    });
    addRule(store, { name: 'ooo', matchFrom: 'boss', action: 'autoreply', actionArg: 'Out of office.' });
    const headers = { 'message-id': '<ooo-1@mail.example>' };
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-a', headers }));
    await handler.handleEmailEvent(sampleEvent({ id: 'ev-b', headers }));
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatch(/^postwisp-autoreply:mid:</);
  });

  it('sends the duplicate STOP reply notice only once', async () => {
    const store = memStore();
    const { queue, sent } = fakeQueue();
    const handler = createInboundHandler({ store, logger: quietLogger(), queue, ownerId: 7 });
    const headers = { 'message-id': '<stop-1@mail.example>' };
    const stop = (id: string) =>
      sampleEvent({ id, from: { address: 'reader@example.org' }, bodyText: 'STOP', headers });
    await handler.handleEmailEvent(stop('ev-a'));
    await handler.handleEmailEvent(stop('ev-b'));
    expect(sent).toHaveLength(1);
    expect(store.listConsentLog(10).filter((e) => e.event === 'unsubscribe')).toHaveLength(1);
  });
});
