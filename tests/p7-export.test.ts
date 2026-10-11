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
import type { Context } from 'grammy';
import { openStore, type EmailMeta, type Store } from '../src/core/store.js';
import { buildJsonExport, buildMbox, exportFilename } from '../src/core/export.js';
import { handleExportCallback } from '../src/bot/export.js';

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

function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    fromAddr: 'boss@example.com',
    subject: 'Hello',
    receivedAt: 1_760_000_000_000,
    read: false,
    archived: false,
    trashed: false,
    labels: [],
    threadId: null,
    to: ['me@example.com'],
    dateMs: 1_760_000_000_000,
    snippet: 'Hi',
    bodyText: 'Hello there.',
    ...overrides,
  };
}

function fakeCtx(): {
  ctx: Context;
  replies: string[];
  documents: Array<{ filename: string; body: string }>;
} {
  const replies: string[] = [];
  const documents: Array<{ filename: string; body: string }> = [];
  const ctx = {
    chat: { id: 1 },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length, chat: { id: 1 }, date: 0, text };
    },
    replyWithDocument: async (doc: { filename?: string; fileData?: Buffer }) => {
      documents.push({
        filename: doc.filename ?? 'file',
        body: (doc.fileData ?? Buffer.alloc(0)).toString('utf8'),
      });
      return { message_id: 1, chat: { id: 1 }, date: 0 };
    },
    answerCallbackQuery: async () => true,
  } as unknown as Context;
  return { ctx, replies, documents };
}

describe('buildMbox', () => {
  it('emits From separators, headers, and bodies', () => {
    const out = buildMbox([meta(), meta({ id: 'em_2', subject: 'Second', fromAddr: 'a@b.c' })]);
    const separators = out.split('\n').filter((l) => l.startsWith('From '));
    expect(separators).toHaveLength(2);
    expect(separators[0]).toMatch(/^From boss@example\.com \w{3} \w{3} \d{2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(out).toContain('Subject: Hello');
    expect(out).toContain('Subject: Second');
    expect(out).toContain('To: me@example.com');
    expect(out).toContain('Hello there.');
  });

  it('escapes body lines starting with "From " and folds header newlines', () => {
    const out = buildMbox([
      meta({ bodyText: 'From the top\nFrom x@y.z said hi', subject: 'A\nB: injected' }),
    ]);
    expect(out).toContain('>From the top');
    expect(out).toContain('>From x@y.z said hi');
    expect(out).toContain('Subject: A B: injected');
    expect(out).not.toMatch(/^B: injected$/m);
  });

  it('uses the snippet when there is no text body', () => {
    const out = buildMbox([meta({ bodyText: null, snippet: 'Only a snippet' })]);
    expect(out).toContain('Only a snippet');
  });
});

describe('buildJsonExport', () => {
  it('round-trips the stored records', () => {
    const emails = [meta(), meta({ id: 'em_2' })];
    const parsed = JSON.parse(buildJsonExport(emails));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].subject).toBe('Hello');
  });
});

describe('exportFilename', () => {
  it('carries the UTC date and the right extension', () => {
    expect(exportFilename('mbox', 1_760_000_000_000)).toMatch(/^postwisp-export-\d{4}-\d{2}-\d{2}\.mbox$/);
    expect(exportFilename('json', 1_760_000_000_000)).toMatch(/\.json$/);
  });
});

describe('store listExportEmails', () => {
  it('returns non-trashed mail oldest first', () => {
    const store = memStore();
    store.saveEmailMeta(meta({ id: 'new', receivedAt: 2000 }));
    store.saveEmailMeta(meta({ id: 'old', receivedAt: 1000 }));
    store.saveEmailMeta(meta({ id: 'trash', receivedAt: 500, trashed: true }));
    const rows = store.listExportEmails();
    expect(rows.map((r) => r.id)).toEqual(['old', 'new']);
  });
});

describe('handleExportCallback', () => {
  it('offers the format choice', async () => {
    const { ctx, replies } = fakeCtx();
    const store = memStore();
    await handleExportCallback(ctx, { store, backToSettings: async () => {} }, 'exp:home');
    expect(replies[0]).toContain('Choose a format');
  });

  it('sends the mbox and JSON dumps as documents', async () => {
    const store = memStore();
    store.saveEmailMeta(meta());
    const { ctx, documents, replies } = fakeCtx();
    await handleExportCallback(ctx, { store, backToSettings: async () => {} }, 'exp:mbox');
    expect(documents).toHaveLength(1);
    expect(documents[0]!.filename).toMatch(/\.mbox$/);
    expect(documents[0]!.body).toContain('From boss@example.com');
    await handleExportCallback(ctx, { store, backToSettings: async () => {} }, 'exp:json');
    expect(documents).toHaveLength(2);
    expect(documents[1]!.filename).toMatch(/\.json$/);
    expect(JSON.parse(documents[1]!.body)).toHaveLength(1);
    expect(replies).toHaveLength(0);
  });

  it('reports an empty store', async () => {
    const store = memStore();
    const { ctx, replies } = fakeCtx();
    await handleExportCallback(ctx, { store, backToSettings: async () => {} }, 'exp:mbox');
    expect(replies[0]).toContain('Nothing to export');
  });
});
