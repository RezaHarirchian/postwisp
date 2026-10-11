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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';
import { openStore, type EmailMeta, type Store } from '../src/core/store.js';
import { createLogger, type Logger } from '../src/core/logger.js';
import type { SendInput, SendResult } from '../src/providers/interface.js';
import {
  buildIcsResponse,
  findIcsInEmail,
  parseIcs,
} from '../src/core/ics.js';
import { handleIcsResponse } from '../src/bot/ics-actions.js';
import { buildEmailView } from '../src/bot/views.js';
import { toViewRecord } from '../src/bot/store-adapter.js';

const capsState = vi.hoisted(() => ({
  result: { ok: true } as { ok: true } | { ok: false; reason: string },
}));
vi.mock('../src/core/templates.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/core/templates.js')>();
  return {
    ...mod,
    loadCaps: async () => ({
      checkSendCaps: () => capsState.result,
      recordSent: () => {},
    }),
  };
});

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});
beforeEach(() => {
  capsState.result = { ok: true };
});

function memStore(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}

function quietLogger(): Logger {
  return createLogger({ stream: new Writable({ write(_c, _e, cb) { cb(); } }) });
}

const SAMPLE_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example Corp//EN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:evt-123@example.org',
  'DTSTAMP:20261010T120000Z',
  'DTSTART:20261015T100000Z',
  'DTEND:20261015T110000Z',
  'SUMMARY:Team sync',
  'LOCATION:Room 5',
  'ORGANIZER;CN=Big Boss:mailto:boss@example.org',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

function fakeCtx(): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    chat: { id: 1 },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: replies.length, chat: { id: 1 }, date: 0, text };
    },
    answerCallbackQuery: async () => true,
  } as unknown as Context;
  return { ctx, replies };
}

function seedInvite(store: Store, bodyText: string): void {
  const meta: EmailMeta = {
    id: 'em_1',
    provider: 'resend',
    domain: 'example.com',
    fromAddr: 'boss@example.org',
    subject: 'Invitation: Team sync',
    receivedAt: 1000,
    read: false,
    archived: false,
    trashed: false,
    labels: [],
    threadId: null,
    bodyText,
  };
  store.saveEmailMeta(meta);
}

describe('parseIcs', () => {
  it('parses a basic invite', () => {
    const ev = parseIcs(SAMPLE_ICS);
    expect(ev).not.toBeNull();
    expect(ev!.uid).toBe('evt-123@example.org');
    expect(ev!.summary).toBe('Team sync');
    expect(ev!.dtstart).toBe('20261015T100000Z');
    expect(ev!.dtend).toBe('20261015T110000Z');
    expect(ev!.location).toBe('Room 5');
    expect(ev!.organizer).toEqual({ email: 'boss@example.org', name: 'Big Boss' });
    expect(ev!.method).toBe('REQUEST');
  });

  it('unfolds continuation lines and unescapes text', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:u1',
      'DTSTART:20261015T100000Z',
      'SUMMARY:Long summary that con',
      ' tinues here\\, with a comma',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const ev = parseIcs(ics);
    expect(ev!.summary).toBe('Long summary that continues here, with a comma');
  });

  it('decodes an escaped backslash before n as backslash-plus-n', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:u2',
      'DTSTART:20261015T100000Z',
      'SUMMARY:C:\\\\new folder',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    // The raw ICS text carries "C:\\new folder" (escaped backslash + n):
    // it must not become a newline.
    expect(parseIcs(ics)!.summary).toBe('C:\\new folder');
  });

  it('returns null without a VEVENT or required fields', () => {
    expect(parseIcs('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toBeNull();
    expect(
      parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u\r\nEND:VEVENT\r\nEND:VCALENDAR'),
    ).toBeNull();
    expect(parseIcs('not an ics payload')).toBeNull();
  });
});

describe('buildIcsResponse', () => {
  it('builds a METHOD:REPLY with the verdict and echoed timestamps', () => {
    const ev = parseIcs(SAMPLE_ICS)!;
    const out = buildIcsResponse(ev, 'me@example.com', 'ACCEPTED', 1_760_000_000_000);
    expect(out).toContain('METHOD:REPLY');
    expect(out).toContain('ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com');
    expect(out).toContain('UID:evt-123@example.org');
    expect(out).toContain('DTSTART:20261015T100000Z');
    expect(out).toContain('ORGANIZER;CN=Big Boss:mailto:boss@example.org');
    // The reply is itself parseable.
    expect(parseIcs(out)!.uid).toBe('evt-123@example.org');
  });
});

describe('findIcsInEmail', () => {
  it('finds inline ICS in the body', () => {
    const src = findIcsInEmail({ bodyText: `Hi\n${SAMPLE_ICS}\nBye` });
    expect(src?.kind).toBe('body');
  });

  it('prefers a text/calendar attachment over body text', () => {
    const src = findIcsInEmail({
      bodyText: SAMPLE_ICS,
      attachments: [{ id: 'a1', filename: 'invite.ics', mime: 'text/calendar' }],
    });
    expect(src).toEqual({ kind: 'attachment', attachmentId: 'a1' });
  });

  it('returns null when there is no invite', () => {
    expect(findIcsInEmail({ bodyText: 'plain text' })).toBeNull();
    expect(findIcsInEmail({})).toBeNull();
  });
});

describe('email view invite buttons', () => {
  it('renders Accept/Decline only when an invite is present', () => {
    const store = memStore();
    seedInvite(store, `See attached.\n${SAMPLE_ICS}`);
    const view = buildEmailView(toViewRecord(store.getEmailMeta('em_1')!));
    const datas = view.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toContain('e:em_1:icsa');
    expect(datas).toContain('e:em_1:icsd');

    seedInvite(store, 'No invite here.');
    const plain = buildEmailView(toViewRecord(store.getEmailMeta('em_1')!));
    const datas2 = plain.replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas2).not.toContain('e:em_1:icsa');
  });
});

describe('handleIcsResponse', () => {
  function deps(store: Store, sentEmails: SendInput[]) {
    return {
      store,
      logger: quietLogger(),
      ownerId: 999,
      domains: ['example.com'],
      sendEmail: async (input: SendInput): Promise<SendResult> => {
        sentEmails.push(input);
        return { id: 'prov-1' };
      },
    };
  }

  it('accepts an invite with a METHOD:REPLY to the organizer', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    seedInvite(store, `Hi\n${SAMPLE_ICS}`);
    const sentEmails: SendInput[] = [];
    const { ctx, replies } = fakeCtx();
    await handleIcsResponse(ctx, deps(store, sentEmails), 'em_1', 'ACCEPTED');
    expect(sentEmails).toHaveLength(1);
    const sent = sentEmails[0]!;
    expect(sent.to).toEqual(['boss@example.org']);
    expect(sent.subject).toBe('Accepted: Team sync');
    const ics = sent.attachments![0]!;
    expect(ics.filename).toBe('invite.ics');
    const payload = ics.content.toString();
    expect(payload).toContain('METHOD:REPLY');
    expect(payload).toContain('PARTSTAT=ACCEPTED');
    expect(replies[0]).toContain('Invite accepted');
    // The send is recorded like any other outbound mail.
    expect(store.getSentByProviderId('prov-1')).not.toBeNull();
  });

  it('declines with PARTSTAT=DECLINED in the reply', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    seedInvite(store, SAMPLE_ICS);
    const sentEmails: SendInput[] = [];
    const { ctx, replies } = fakeCtx();
    await handleIcsResponse(ctx, deps(store, sentEmails), 'em_1', 'DECLINED');
    const payload = sentEmails[0]!.attachments![0]!.content.toString();
    expect(payload).toContain('PARTSTAT=DECLINED');
    expect(replies[0]).toContain('Invite declined');
  });

  it('fails cleanly without an invite or identity', async () => {
    const store = memStore();
    store.set('identities', JSON.stringify(['me@example.com']));
    seedInvite(store, 'No invite.');
    const sentEmails: SendInput[] = [];
    const { ctx, replies } = fakeCtx();
    await handleIcsResponse(ctx, deps(store, sentEmails), 'em_1', 'ACCEPTED');
    expect(sentEmails).toHaveLength(0);
    expect(replies[0]).toContain('Could not process');
  });
});
