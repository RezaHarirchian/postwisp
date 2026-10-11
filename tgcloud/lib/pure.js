// postwisp — Telegram Serverless companion
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

// Dependency-free pure logic for the Telegram Serverless build.
// No imports at all: the tgcloud runtime has no npm, and keeping this file
// import-free means the self-hosted bot and the test suite can use it
// directly. Every function is total and deterministic.

// Telegram caps one message at 4096 characters.
export const TELEGRAM_MAX_CHARS = 4096;

// OTP keywords, lowercased for comparison. A code only counts when it sits
// near one of these words; bare digit runs elsewhere are usually dates,
// prices, or part numbers, not one-time passcodes.
const OTP_KEYWORDS = [
  'otp',
  'code',
  'passcode',
  'verification',
  'verify',
  'security code',
  'pin',
  'token',
  '2fa',
  'mfa',
  'one-time',
  'one time',
];

// How far past a keyword we still accept a code: one line of prose, not
// the whole message.
const OTP_WINDOW_CHARS = 80;

// 4-8 digit runs not touching another digit. Lookarounds (not \b) so a
// 9-digit number never yields an 8-digit "code" from its tail.
const DIGIT_RUN = /(?<!\d)\d{4,8}(?!\d)/g;

// Pulls one-time passcodes out of message text: 4-8 digit runs appearing
// within OTP_WINDOW_CHARS after an OTP keyword. Deduped, in order of
// first appearance.
export function extractOtp(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lower = text.toLowerCase();
  const seen = new Set();
  const out = [];
  let start = 0;
  while (start < lower.length) {
    let earliest = -1;
    for (const keyword of OTP_KEYWORDS) {
      const at = lower.indexOf(keyword, start);
      if (at !== -1 && (earliest === -1 || at < earliest)) earliest = at;
    }
    if (earliest === -1) break;
    const window = text.slice(earliest, earliest + OTP_WINDOW_CHARS);
    for (const match of window.matchAll(DIGIT_RUN)) {
      const code = match[0];
      if (!seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
    start = earliest + 1;
  }
  return out;
}

// Splits text into chunks no longer than `limit` code points. Array.from
// splits on code points, so emoji and other astral characters never get
// cut in half; String.prototype.length would miscount them.
export function chunkText(text, limit = TELEGRAM_MAX_CHARS) {
  if (typeof text !== 'string') text = String(text);
  const points = Array.from(text);
  const chunks = [];
  for (let i = 0; i < points.length; i += limit) {
    chunks.push(points.slice(i, i + limit).join(''));
  }
  return chunks.length > 0 ? chunks : [''];
}

// Escapes the five characters Telegram's HTML parse_mode treats as markup.
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

// Collapses whitespace and trims to `max` code points, appending an
// ellipsis when truncated. Used for inbox list lines.
export function truncateSnippet(text, max = 160) {
  const single = String(text).replace(/\s+/g, ' ').trim();
  const points = Array.from(single);
  if (points.length <= max) return single;
  return points.slice(0, max - 1).join('') + '…';
}

// Evaluates one rule against an email. The rule's field names the email
// property to test ('from' or 'subject'); matcher is 'contains',
// 'starts_with', 'ends_with', 'equals', or 'regex'. Comparison is
// case-insensitive except 'regex', which the rule author controls.
// An invalid regex never matches — a bad rule must not crash the handler.
export function evalRule(rule, email) {
  const value = typeof rule.value === 'string' ? rule.value : '';
  const target = rule.field === 'from'
    ? String(email.from_addr ?? '')
    : String(email.subject ?? '');
  const matcher = String(rule.matcher ?? 'contains');
  if (matcher === 'regex') {
    try {
      return new RegExp(value, 'i').test(target);
    } catch {
      return false;
    }
  }
  const lowerTarget = target.toLowerCase();
  const lowerValue = value.toLowerCase();
  switch (matcher) {
    case 'starts_with': return lowerTarget.startsWith(lowerValue);
    case 'ends_with': return lowerTarget.endsWith(lowerValue);
    case 'equals': return lowerTarget === lowerValue;
    case 'contains':
    default: return lowerTarget.includes(lowerValue);
  }
}

// True when the email carries one of the standard unsubscribe markers.
// The serverless build keeps a minimal version of the self-hosted check:
// presence of List-Unsubscribe headers or an unsubscribe link in the body.
export function hasUnsubscribe(headers, body) {
  const headerValue = String(headers?.['list-unsubscribe'] ?? headers?.['List-Unsubscribe'] ?? '');
  if (headerValue.length > 0) return true;
  return /unsubscribe/i.test(String(body ?? ''));
}

// ---------------------------------------------------------------------------
// Inbound wire format: Cloudflare worker -> Telegram message -> tgcloud
// handler.
//
// The worker (adapters/cloudflare/worker.js, DIRECT_BOT_API mode) cannot
// write to the tgcloud database, so each email arrives as a plain Telegram
// message with inline buttons. The message text carries the email in this
// structured format; the handler parses it back with parseInboundMessage
// when the owner taps Save / View code / Reply.
//
// The format is: "From: ...", "Subject: ...", "Date: ..." header lines,
// one blank line, then the body. The worker duplicates formatInboundMessage
// (it cannot import this file); the two copies MUST stay in sync — the
// round-trip is covered by tests on this side.
// ---------------------------------------------------------------------------

export function formatInboundMessage({ from_addr, from_name, subject, date_ms, body }) {
  // Header values must stay on one line: a newline inside a subject would
  // produce a header line without a colon, and parseInboundMessage rejects
  // the whole message. Collapse runs of newlines to a single space.
  const oneLine = (v) => String(v || '').replace(/[\r\n]+/g, ' ');
  const from = from_name ? `${oneLine(from_name)} <${oneLine(from_addr)}>` : oneLine(from_addr);
  const lines = [
    `From: ${from}`,
    `Subject: ${oneLine(subject)}`,
    `Date: ${new Date(date_ms || Date.now()).toISOString()}`,
    '',
    String(body || ''),
  ];
  return lines.join('\n');
}

// Parses formatInboundMessage output back into an email object. Returns
// null when the text is not in the wire format.
export function parseInboundMessage(text) {
  if (typeof text !== 'string') return null;
  const blankAt = text.indexOf('\n\n');
  if (blankAt === -1) return null;
  const headerBlock = text.slice(0, blankAt);
  const body = text.slice(blankAt + 2);
  const headers = {};
  for (const line of headerBlock.split('\n')) {
    const colonAt = line.indexOf(':');
    if (colonAt === -1) return null;
    headers[line.slice(0, colonAt).trim().toLowerCase()] = line.slice(colonAt + 1).trim();
  }
  if (!('from' in headers) || !('subject' in headers)) return null;
  const fromHeader = headers.from;
  const addrMatch = /<([^<>]+)>/.exec(fromHeader);
  const from_addr = addrMatch ? addrMatch[1].trim() : fromHeader.trim();
  const from_name = addrMatch ? fromHeader.slice(0, addrMatch.index).trim() : '';
  return {
    from_addr,
    from_name,
    subject: headers.subject,
    date_ms: headers.date ? Date.parse(headers.date) : Date.now(),
    body,
  };
}
