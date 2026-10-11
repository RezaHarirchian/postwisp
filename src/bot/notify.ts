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
import { cb, escapeHtml, formatDateUtc } from './views.js';

// Structural shape of the provider event. The coordinator merges this with
// the provider worker's canonical EmailEvent at merge time.
export interface NotifyAttachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
}

export interface NotifyEvent {
  id: string;
  provider: string;
  domain: string;
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  dateMs: number;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: NotifyAttachment[];
  threadId: string | null;
  headers: Record<string, string>;
}

export interface Notification {
  text: string;
  replyMarkup: InlineKeyboard;
  parseMode: 'HTML';
  // The bot only ever talks to the owner, and forwards should stay
  // impossible: every notification send carries protect_content.
  protectContent: true;
}

// Bodies over this length stay collapsed so a long email cannot blow past
// Telegram's message limits or flood the chat; the Full text button re-sends.
const BODY_COLLAPSE_AT = 500;

export interface NotifyOptions {
  // Sibling seam: extractOtp comes from src/core/inbox.ts at merge time.
  extractOtp?: (text: string) => string[];
}

// Telegram caps one message at 4096 characters. Split long bodies on line
// boundaries so a "full text" tap never fails on a long email. Slicing is
// done on code points (Array.from), never on UTF-16 units, so a surrogate
// pair is never torn apart.
export function chunkText(text: string, max = 4000): string[] {
  const chars = Array.from(text);
  if (chars.length <= max) return [text];
  const chunks: string[] = [];
  let rest = chars;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest.join(''));
      break;
    }
    let cut = max;
    for (let i = max; i >= Math.floor(max / 2); i--) {
      if (rest[i] === '\n') {
        cut = i;
        break;
      }
    }
    chunks.push(rest.slice(0, cut).join(''));
    rest = rest.slice(cut);
    if (rest[0] === '\n') rest = rest.slice(1);
  }
  return chunks;
}

// Code-point-safe truncation for single fields. The caller budgets first;
// this only guarantees the bound.
export function truncatePoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

// A cut at the very end of an escaped message can land inside an HTML
// entity (&am|p;); strip the dangling fragment so the message still renders.
function stripDanglingEntity(text: string): string {
  return text.replace(/&[a-zA-Z0-9#]*$/, '');
}

// Telegram's hard limit for one message. The queue cannot retry an
// oversized send — it is dropped — so the notification is budgeted field
// by field instead of hoping the pieces fit.
const NOTIFICATION_MAX = 4096;
const NOTIFICATION_MARGIN = 128;

// One owner notification per new email. Returns the text plus the send
// options; the caller (send queue) forwards them verbatim. Every field is
// truncated to a budget so the assembled message always fits Telegram's
// 4096-character limit — an oversized notification would be dropped and
// the owner never told about the email.
export function buildNotification(ev: NotifyEvent, opts: NotifyOptions = {}): Notification {
  const rawFrom =
    ev.from.name && ev.from.name.length > 0 ? `${ev.from.name} <${ev.from.address}>` : ev.from.address;
  const fromLabel = truncatePoints(rawFrom, 160);
  const subject = truncatePoints(ev.subject, 320);
  const head = [
    t('bot.notify.from', { from: escapeHtml(fromLabel) }),
    t('bot.notify.subject', { subject: escapeHtml(subject) }),
    t('bot.notify.date', { date: formatDateUtc(ev.dateMs) }),
  ].join('\n');

  const body = ev.bodyText ?? '';
  const collapsed = body.length > BODY_COLLAPSE_AT;
  const displayRaw = collapsed ? ev.snippet : body.length > 0 ? body : ev.snippet;
  // Leave room for the OTP line, the blockquote markup, and HTML entity
  // expansion (escaping happens after truncation).
  const bodyBudget = Math.max(0, NOTIFICATION_MAX - head.length - NOTIFICATION_MARGIN - 160);
  const display = truncatePoints(displayRaw, bodyBudget);

  const lines = [head];
  if (collapsed) {
    // Telegram renders expandable blockquotes collapsed by default.
    lines.push('', `<blockquote expandable>${escapeHtml(display)}</blockquote>`);
    lines.push(t('bot.notify.bodyCollapsed'));
  } else if (display.length > 0) {
    lines.push('', escapeHtml(display));
  }

  if (opts.extractOtp) {
    // Extracted from the full body even when the display is collapsed:
    // the code must reach the owner without tapping Full text.
    const codes = opts.extractOtp(body.length > 0 ? body : ev.snippet);
    if (codes.length > 0) {
      // <code> spans are one-tap copyable in Telegram clients.
      const spans = codes.map((c) => `<code>${escapeHtml(c)}</code>`).join(' ');
      lines.push('', t('bot.notify.otpLine', { codes: spans }));
    }
  }

  const kb = new InlineKeyboard();
  const attachCount = ev.attachments.length;
  if (collapsed || attachCount > 0) {
    if (collapsed) kb.text(t('bot.notify.fullText'), cb(`e:${ev.id}:full`));
    if (attachCount > 0) kb.text(t('bot.notify.attachments', { count: attachCount }), cb(`e:${ev.id}:att`));
    kb.row();
  }
  kb.text(t('bot.notify.reply'), cb(`e:${ev.id}:reply`)).text(t('bot.notify.archive'), cb(`e:${ev.id}:arch`));

  // Hard guarantee, independent of the budgets above: never emit more than
  // the limit no matter what changed.
  const text = stripDanglingEntity(truncatePoints(lines.join('\n'), NOTIFICATION_MAX));

  return {
    text,
    replyMarkup: kb,
    parseMode: 'HTML',
    protectContent: true,
  };
}
