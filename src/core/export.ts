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

// Local backup formats for the stored mail: mbox (importable by every mail
// client) and JSON (the raw stored records). Pure functions over the store
// rows; the bot layer turns the strings into Telegram documents.

import type { EmailMeta } from './store.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// The mbox "From " separator line: `From address Day Mon DD HH:MM:SS YYYY`.
// UTC, like the rest of postwisp's timestamps.
function mboxFromLine(fromAddr: string, dateMs: number | null): string {
  const d = new Date(dateMs ?? 0);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `From ${fromAddr} ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ` +
    `${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`
  );
}

// A body line starting with "From " would be mistaken for a message
// separator on import; the traditional ">From " escape prevents that.
function escapeMboxBody(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.startsWith('From ') ? `>${line}` : line))
    .join('\n');
}

// Header values are single-line: fold embedded newlines so a crafted
// subject cannot inject extra headers into the dump.
function headerValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function mboxHeaders(meta: EmailMeta): string[] {
  const lines = [`From: ${headerValue(meta.fromAddr)}`];
  const to = meta.to ?? [];
  if (to.length > 0) lines.push(`To: ${headerValue(to.join(', '))}`);
  lines.push(`Subject: ${headerValue(meta.subject)}`);
  lines.push(`Date: ${new Date(meta.dateMs ?? meta.receivedAt).toUTCString()}`);
  const messageId = meta.headers?.['message-id'];
  if (messageId) lines.push(`Message-ID: ${headerValue(messageId)}`);
  return lines;
}

// Standard mbox: one "From " separator per message, then headers, a blank
// line, then the body. The body is the stored text; HTML-only mail exports
// its snippet so the dump is never an empty message.
export function buildMbox(emails: EmailMeta[]): string {
  const parts: string[] = [];
  for (const meta of emails) {
    const body = escapeMboxBody(meta.bodyText ?? meta.snippet ?? '');
    parts.push(
      `${mboxFromLine(meta.fromAddr, meta.dateMs ?? meta.receivedAt)}\n` +
        `${mboxHeaders(meta).join('\n')}\n\n${body}\n`,
    );
  }
  return parts.join('\n');
}

// The JSON dump is the stored records verbatim, pretty-printed for humans.
export function buildJsonExport(emails: EmailMeta[]): string {
  return JSON.stringify(emails, null, 2) + '\n';
}

// Filenames carry the UTC date so repeated exports do not collide.
export function exportFilename(kind: 'mbox' | 'json', nowMs: number = Date.now()): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return kind === 'mbox' ? `postwisp-export-${date}.mbox` : `postwisp-export-${date}.json`;
}
