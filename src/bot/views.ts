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

import { InlineKeyboard } from 'grammy';
import { t } from '../core/i18n.js';
import { findListUnsubscribe } from '../core/list-unsubscribe.js';
import { findIcsInEmail } from '../core/ics.js';

// Minimal structural shape of an email. The coordinator merges this with the
// inbox/store worker's canonical EmailRecord at merge time.
export interface EmailAttachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
}

export interface EmailViewRecord {
  id: string;
  domain: string;
  fromAddr: string;
  fromName?: string;
  subject: string;
  dateMs: number | null;
  snippet?: string | null;
  bodyText?: string | null;
  attachments?: EmailAttachment[];
  threadId?: string | null;
  isRead?: boolean;
  // Raw headers for List-Unsubscribe detection and similar; kept off the
  // record unless the caller has the full email.
  headers?: Record<string, string>;
}

// User content goes into HTML messages, so it must be escaped before it
// touches any markup. Escape once, at render time.
export function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// UTC keeps timestamps unambiguous for a self-hosted bot whose owner may be
// traveling; the phone shows its own local time in the message metadata.
export function formatDateUtc(dateMs: number | null | undefined): string {
  if (dateMs === null || dateMs === undefined) return '—';
  const d = new Date(dateMs);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function senderLabel(email: Pick<EmailViewRecord, 'fromAddr' | 'fromName'>): string {
  return email.fromName && email.fromName.length > 0 ? email.fromName : email.fromAddr;
}

// Callback data must stay under Telegram's 64-byte limit, so ids ride along
// with a short action prefix and everything else resolves server-side.
// Use cb() when building callback data: it throws where the over-long
// payload is built instead of failing later as a silent dead button.
export function cb(data: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > 64) {
    throw new Error(
      `callback_data exceeds Telegram's 64-byte limit (${bytes} bytes): ${data.slice(0, 32)}…`,
    );
  }
  return data;
}
// e:<id>            open the email view
// e:<id>:full      full body text
// e:<id>:att       attachment list
// e:<id>:arch      archive
// e:<id>:read      mark read
// e:<id>:unread    mark unread
// e:<id>:sz1h      snooze one hour
// e:<id>:sz24h     snooze one day
// e:<id>:blk       block sender
// e:<id>:rule      add from-subject archive rule
// e:<id>:reply     reply (later phase)
// e:<id>:draft     generate an AI reply draft (P8, only when the LLM key is set)
// e:<id>:unsub     unsubscribe via List-Unsubscribe
// e:<id>:icsa      accept calendar invite
// e:<id>:icsd      decline calendar invite
// th:<threadId>    open the thread view
// dom:<domain>     filter inbox by domain
// dom:all          clear the domain filter
export type EmailAction =
  | 'full'
  | 'att'
  | 'arch'
  | 'read'
  | 'unread'
  | 'sz1h'
  | 'sz24h'
  | 'blk'
  | 'rule'
  | 'reply'
  | 'draft'
  | 'unsub'
  | 'icsa'
  | 'icsd';

export type CallbackAction =
  | { kind: 'email'; id: string; action: 'open' | EmailAction }
  | { kind: 'thread'; threadId: string }
  | { kind: 'domain'; domain: string | null };

export function parseCallbackData(data: string): CallbackAction | null {
  if (data.startsWith('th:')) {
    const threadId = data.slice(3);
    return threadId.length > 0 ? { kind: 'thread', threadId } : null;
  }
  if (data.startsWith('dom:')) {
    const domain = data.slice(4);
    if (domain.length === 0) return null;
    return { kind: 'domain', domain: domain === 'all' ? null : domain };
  }
  if (data.startsWith('e:')) {
    const rest = data.slice(2);
    const sep = rest.lastIndexOf(':');
    if (sep === -1) {
      return rest.length > 0 ? { kind: 'email', id: rest, action: 'open' } : null;
    }
    const id = rest.slice(0, sep);
    const action = rest.slice(sep + 1);
    const known: EmailAction[] = ['full', 'att', 'arch', 'read', 'unread', 'sz1h', 'sz24h', 'blk', 'rule', 'reply', 'draft', 'unsub', 'icsa', 'icsd'];
    if (id.length > 0 && (known as string[]).includes(action)) {
      return { kind: 'email', id, action: action as EmailAction };
    }
    return null;
  }
  return null;
}

export interface EmailView {
  text: string;
  replyMarkup: InlineKeyboard;
}

// A conversation thread, oldest message first. Each line carries an Open
// button so the owner can jump into any single message's detail view.
export function buildThreadView(emails: EmailViewRecord[]): EmailView {
  const sorted = [...emails].sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
  const lines = [t('bot.thread.title', { count: sorted.length }), ''];
  const kb = new InlineKeyboard();
  for (const email of sorted) {
    lines.push(
      t('bot.thread.item', {
        date: formatDateUtc(email.dateMs),
        from: escapeHtml(senderLabel(email)),
        subject: escapeHtml(email.subject),
      }),
    );
    // Button text stays short; the full subject is already in the line above.
    kb.text(t('bot.thread.open'), cb(`e:${email.id}`)).row();
  }
  return { text: lines.join('\n'), replyMarkup: kb };
}

// The full detail view for one email: header, snippet, and every action the
// owner can take, as inline buttons. The guard in index.ts sits in front.
// opts.aiDraft adds the "Draft reply" button; it is only set when the LLM
// key is configured, so the button never appears for an inert AI.
export function buildEmailView(email: EmailViewRecord, opts: { aiDraft?: boolean } = {}): EmailView {
  const lines = [
    t('bot.notify.from', { from: escapeHtml(senderLabel(email)) }),
    t('bot.notify.subject', { subject: escapeHtml(email.subject) }),
    t('bot.notify.date', { date: formatDateUtc(email.dateMs) }),
  ];
  if (email.snippet && email.snippet.length > 0) {
    lines.push('', escapeHtml(email.snippet));
  }
  const id = email.id;
  const kb = new InlineKeyboard();
  if (email.threadId) {
    kb.text(t('bot.email.openThread'), cb(`th:${email.threadId}`)).row();
  }
  const attachCount = email.attachments?.length ?? 0;
  if (attachCount > 0) {
    kb.text(t('bot.notify.attachments', { count: attachCount }), cb(`e:${id}:att`)).row();
  }
  kb.text(t('bot.notify.reply'), cb(`e:${id}:reply`)).text(t('bot.notify.archive'), cb(`e:${id}:arch`)).row();
  if (opts.aiDraft) {
    kb.text(t('bot.ai.draftReply'), cb(`e:${id}:draft`)).row();
  }
  kb.text(
    email.isRead ? t('bot.email.markUnread') : t('bot.email.markRead'),
    cb(`e:${id}:${email.isRead ? 'unread' : 'read'}`),
  )
    .row();
  kb.text(t('bot.email.snooze1h'), cb(`e:${id}:sz1h`)).text(t('bot.email.snooze1d'), cb(`e:${id}:sz24h`)).row();
  kb.text(t('bot.email.blockSender'), cb(`e:${id}:blk`)).text(t('bot.email.addRule'), cb(`e:${id}:rule`)).row();
  // List-Unsubscribe and calendar invites surface as their own row so they
  // read as one-tap actions, not buried in the management buttons.
  if (email.headers && findListUnsubscribe(email.headers)) {
    kb.text(t('bot.unsub.button'), cb(`e:${id}:unsub`)).row();
  }
  if (findIcsInEmail({ bodyText: email.bodyText, attachments: email.attachments })) {
    kb.text(t('bot.ics.accept'), cb(`e:${id}:icsa`)).text(t('bot.ics.decline'), cb(`e:${id}:icsd`)).row();
  }
  return { text: lines.join('\n'), replyMarkup: kb };
}

// Latest-first inbox list with an Open button per message. The domain filter
// arrives via the domain picker callback; the list itself is dumb.
export function buildInboxList(emails: EmailViewRecord[]): EmailView {
  if (emails.length === 0) {
    return { text: t('bot.inbox.empty'), replyMarkup: new InlineKeyboard() };
  }
  const lines = [t('bot.inbox.listTitle', { count: emails.length }), ''];
  const kb = new InlineKeyboard();
  for (const email of emails) {
    lines.push(
      t('bot.inbox.item', {
        date: formatDateUtc(email.dateMs),
        from: escapeHtml(senderLabel(email)),
        subject: escapeHtml(email.subject),
      }),
    );
    kb.text(t('bot.search.open'), cb(`e:${email.id}`)).row();
  }
  return { text: lines.join('\n'), replyMarkup: kb };
}

// Search results reuse the inbox item layout; the query sits in the title.
export function buildSearchResults(query: string, emails: EmailViewRecord[]): EmailView {
  if (emails.length === 0) {
    return { text: t('bot.search.noResults', { query: escapeHtml(query) }), replyMarkup: new InlineKeyboard() };
  }
  const lines = [t('bot.search.resultsTitle', { query: escapeHtml(query), count: emails.length }), ''];
  const kb = new InlineKeyboard();
  for (const email of emails) {
    lines.push(
      t('bot.search.resultItem', {
        date: formatDateUtc(email.dateMs),
        from: escapeHtml(senderLabel(email)),
        subject: escapeHtml(email.subject),
      }),
    );
    kb.text(t('bot.search.open'), cb(`e:${email.id}`)).row();
  }
  return { text: lines.join('\n'), replyMarkup: kb };
}

export interface SentListItem {
  id: string;
  to: string;
  subject: string;
  dateMs: number;
  status: string;
}

// Outgoing mail, latest first. No actions yet; viewing or resending is a
// later phase, so the list is text-only.
export function buildSentList(sent: SentListItem[]): EmailView {
  if (sent.length === 0) {
    return { text: t('bot.sent.empty'), replyMarkup: new InlineKeyboard() };
  }
  const lines = [t('bot.sent.title'), ''];
  for (const item of sent) {
    lines.push(
      t('bot.sent.item', {
        to: escapeHtml(item.to),
        subject: escapeHtml(item.subject),
        date: formatDateUtc(item.dateMs),
        status: escapeHtml(item.status),
      }),
    );
    lines.push('');
  }
  return { text: lines.join('\n').trimEnd(), replyMarkup: new InlineKeyboard() };
}

// Shown when the owner has more than one domain. The active filter gets a
// marker; 'all' clears the filter. Callbacks: dom:<domain> / dom:all.
export function buildDomainPicker(domains: string[], active?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const label = (domain: string | null, text: string): string =>
    active === domain || (domain === null && active === undefined) ? t('bot.inbox.activeMark', { label: text }) : text;
  kb.text(label(null, t('bot.inbox.domainAll')), cb('dom:all')).row();
  for (const domain of domains) {
    kb.text(label(domain, domain), cb(`dom:${domain}`)).row();
  }
  return kb;
}
