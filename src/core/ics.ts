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

// Minimal iCalendar parsing for meeting invites (RFC 5545). Only the first
// VEVENT is read: invites carry one event, and recurring-series surgery is
// out of scope for a Telegram bot. Pure functions, no network, no store.

export interface IcsOrganizer {
  email: string;
  name?: string;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  // Raw property values, echoed back verbatim in the METHOD:REPLY so the
  // organizer's parser sees the same timestamps it sent.
  dtstart: string;
  dtend?: string;
  location?: string;
  organizer?: IcsOrganizer;
  method?: string;
  sequence?: number;
}

export type IcsPartStat = 'ACCEPTED' | 'DECLINED';

// RFC 5545 line folding: a line starting with a space or tab continues the
// previous line, with the folding whitespace removed.
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

// Splits "DTSTART;TZID=Europe/Istanbul:20261015T100000" into name, params,
// value. A colon inside a quoted param value must not split early, so the
// split runs on the first colon outside quotes.
function parseProperty(line: string): IcsProperty | null {
  let split = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      split = i;
      break;
    }
  }
  if (split === -1) return null;
  const head = line.slice(0, split);
  const value = line.slice(split + 1);
  const [rawName, ...paramParts] = head.split(';');
  const name = (rawName ?? '').trim().toUpperCase();
  if (name.length === 0) return null;
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    if (key.length > 0) params[key] = val;
  }
  return { name, params, value };
}

// TEXT values escape commas, semicolons, backslashes and newlines. One
// pass: sequential replaces would turn an escaped backslash followed by
// 'n' (\\n) into a newline instead of a backslash plus 'n'.
function unescapeText(value: string): string {
  return value.replace(/\\(\\|n|N|;|,)/g, (m, c: string) => {
    switch (c.toLowerCase()) {
      case '\\':
        return '\\';
      case 'n':
        return '\n';
      case ';':
        return ';';
      case ',':
        return ',';
      default:
        return m;
    }
  });
}

function parseOrganizer(value: string, params: Record<string, string>): IcsOrganizer | null {
  const m = /^mailto:([^?]+)/i.exec(value.trim());
  const email = m?.[1]?.trim().toLowerCase();
  if (!email) return null;
  const org: IcsOrganizer = { email };
  const cn = params['CN'];
  if (cn && cn.length > 0) org.name = cn;
  return org;
}

// Returns the first VEVENT in the payload, or null when there is none or
// the required UID/DTSTART/SUMMARY fields are missing.
export function parseIcs(text: string): IcsEvent | null {
  const lines = unfold(text);
  let inCalendar = false;
  let inEvent = false;
  let method: string | undefined;
  const props: IcsProperty[] = [];
  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === 'BEGIN:VCALENDAR') {
      inCalendar = true;
      continue;
    }
    if (upper === 'END:VCALENDAR') break;
    if (!inCalendar) continue;
    if (upper === 'BEGIN:VEVENT') {
      inEvent = true;
      props.length = 0;
      continue;
    }
    if (upper === 'END:VEVENT') break;
    const prop = parseProperty(line);
    if (!prop) continue;
    if (prop.name === 'METHOD' && !inEvent) {
      method = prop.value.trim().toUpperCase();
      continue;
    }
    if (inEvent) props.push(prop);
  }
  if (!inEvent && props.length === 0) return null;
  const get = (name: string): IcsProperty | undefined => props.find((p) => p.name === name);
  const uid = get('UID')?.value.trim();
  const dtstart = get('DTSTART')?.value.trim();
  const summary = get('SUMMARY')?.value.trim();
  if (!uid || !dtstart || !summary) return null;
  const event: IcsEvent = { uid, summary: unescapeText(summary), dtstart };
  const dtend = get('DTEND')?.value.trim();
  if (dtend) event.dtend = dtend;
  const location = get('LOCATION')?.value.trim();
  if (location) event.location = unescapeText(location);
  const organizerProp = get('ORGANIZER');
  if (organizerProp) {
    const organizer = parseOrganizer(organizerProp.value, organizerProp.params);
    if (organizer) event.organizer = organizer;
  }
  if (method) event.method = method;
  const sequence = get('SEQUENCE')?.value.trim();
  if (sequence !== undefined) {
    const n = Number(sequence);
    if (Number.isInteger(n)) event.sequence = n;
  }
  return event;
}

// TEXT values going out need the reverse escaping of unescapeText.
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

// Fold to the RFC 5545 75-octet recommendation. The cut walks code points
// (Array.from), never UTF-16 units, so a surrogate pair is never torn
// apart; the byte budget is measured per code point.
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const chars = Array.from(line);
  const parts: string[] = [];
  let rest = chars;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? 75 : 74;
    let bytes = 0;
    let cut = 0;
    while (cut < rest.length) {
      const b = Buffer.byteLength(rest[cut] as string, 'utf8');
      if (bytes + b > limit) break;
      bytes += b;
      cut++;
    }
    // A single code point wider than the limit cannot happen in UTF-8
    // (max 4 bytes); take it whole rather than emit an empty fold.
    if (cut === 0) cut = 1;
    parts.push(`${first ? '' : ' '}${rest.slice(0, cut).join('')}`);
    rest = rest.slice(cut);
    first = false;
  }
  return parts.join('\r\n');
}

function dtstamp(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// Builds the METHOD:REPLY payload answering the invite. The attendee is the
// owner's sending identity; PARTSTAT carries the verdict. Timestamps are
// echoed from the original so the organizer matches the reply to the event.
export function buildIcsResponse(
  event: IcsEvent,
  attendeeEmail: string,
  partStat: IcsPartStat,
  nowMs: number = Date.now(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//postwisp//postwisp//EN',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${dtstamp(nowMs)}`,
    `DTSTART:${event.dtstart}`,
  ];
  if (event.dtend !== undefined) lines.push(`DTEND:${event.dtend}`);
  if (event.organizer !== undefined) {
    const cn =
      event.organizer.name !== undefined ? `;CN=${escapeText(event.organizer.name)}` : '';
    lines.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }
  lines.push(`ATTENDEE;PARTSTAT=${partStat}:mailto:${attendeeEmail.trim().toLowerCase()}`);
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.sequence !== undefined) lines.push(`SEQUENCE:${event.sequence}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export type IcsSource =
  | { kind: 'body'; icsText: string }
  | { kind: 'attachment'; attachmentId: string };

// Finds an invite in an email: a text/calendar attachment wins over inline
// text, because the attachment is the canonical payload when both exist.
// Attachment bytes are not available here; the caller downloads them and
// runs parseIcs on the result.
export function findIcsInEmail(input: {
  bodyText?: string | null | undefined;
  attachments?: Array<{ id: string; filename: string; mime: string }> | undefined;
}): IcsSource | null {
  const attachment = input.attachments?.find(
    (a) => a.mime.toLowerCase() === 'text/calendar' || a.filename.toLowerCase().endsWith('.ics'),
  );
  if (attachment) return { kind: 'attachment', attachmentId: attachment.id };
  const body = input.bodyText ?? '';
  if (body.includes('BEGIN:VCALENDAR')) {
    const start = body.indexOf('BEGIN:VCALENDAR');
    const end = body.indexOf('END:VCALENDAR');
    const icsText = end === -1 ? body.slice(start) : body.slice(start, end + 'END:VCALENDAR'.length);
    return { kind: 'body', icsText };
  }
  return null;
}
