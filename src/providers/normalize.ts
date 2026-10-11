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

// Maps Resend's receiving API payloads to EmailEvent. Pure and total:
// every input produces an event, never throws, never touches the network.
// Shape per resend.com/docs/api-reference/emails/retrieve-received-email:
// { object, id, to, from, subject, html, text, headers, bcc, cc,
//   reply_to, received_for, authentication, message_id, raw,
//   attachments: [{ id, filename, content_type, content_disposition,
//                   content_id, size }] }.
// ASSUMPTIONS (documented where the KB is silent):
// - the retrieval response carries no created_at; date falls back to the
//   Date header, then to now (in the webhook flow the fetch happens within
//   seconds of receipt, so the skew is negligible).
// - domain is taken from the first recipient address, since Resend does
//   not echo the receiving domain on the payload.
// - threadId follows In-Reply-To, else the first References token, else
//   null; a standalone inbound email starts no thread on its own.
// - from is also accepted as { address, name } so the provider's own
//   InboundEmail shape can be re-normalized without a second mapper.

import type { EmailEvent } from './interface.js';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// "Name <addr>" or a bare address. Name is display-only metadata.
export function parseAddress(raw: string): { address: string; name?: string } {
  const match = raw.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (match) {
    const name = (match[1] ?? '').trim().replace(/^["']|["']$/g, '');
    const address = (match[2] ?? '').trim();
    return name ? { address, name } : { address };
  }
  return { address: raw.trim() };
}

function parseFrom(value: unknown): { address: string; name?: string } {
  const rec = asRecord(value);
  if (typeof rec['address'] === 'string') {
    return typeof rec['name'] === 'string' && rec['name'].length > 0
      ? { address: rec['address'], name: rec['name'] }
      : { address: rec['address'] };
  }
  return parseAddress(asString(value));
}

function flattenHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(asRecord(value))) {
    if (typeof val === 'string') {
      out[key.toLowerCase()] = val;
    }
  }
  return out;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

// Builds the 200-char list snippet: collapse whitespace, trim, then cut
// without splitting a UTF-16 surrogate pair. String.slice can strand a
// lead surrogate, which renders as U+FFFD downstream; backing off one unit
// when the cut lands on a lead surrogate keeps the cut on a character
// boundary while preserving the exact unit budget.
export function snippetOf(text: string, maxLen = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  let end = maxLen;
  const prev = collapsed.charCodeAt(end - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) end -= 1;
  return collapsed.slice(0, end);
}

export function normalizeResendInbound(payload: unknown): EmailEvent {
  const rec = asRecord(payload);
  const to = asStringArray(rec['to']);
  const from = parseFrom(rec['from']);
  // The provider's own InboundEmail shape uses bodyText/bodyHtml/mime for
  // the same fields; both spellings are accepted so re-normalizing it is
  // lossless.
  const bodyText =
    typeof rec['text'] === 'string'
      ? rec['text']
      : typeof rec['bodyText'] === 'string'
        ? rec['bodyText']
        : null;
  const bodyHtml =
    typeof rec['html'] === 'string'
      ? rec['html']
      : typeof rec['bodyHtml'] === 'string'
        ? rec['bodyHtml']
        : null;
  const headers = flattenHeaders(rec['headers']);

  const attachments: EmailEvent['attachments'] = [];
  const rawAttachments = rec['attachments'];
  if (Array.isArray(rawAttachments)) {
    for (const entry of rawAttachments) {
      const a = asRecord(entry);
      attachments.push({
        id: asString(a['id']),
        filename: asString(a['filename'], 'attachment'),
        size: typeof a['size'] === 'number' ? a['size'] : 0,
        mime: asString(a['content_type'], asString(a['mime'], 'application/octet-stream')),
      });
    }
  }

  const createdAt = Date.parse(asString(rec['created_at'], ''));
  const headerDate = Date.parse(headers['date'] ?? '');
  // Re-normalizing the provider's own InboundEmail shape: keep its date.
  const dateMsField = typeof rec['dateMs'] === 'number' ? rec['dateMs'] : 0;
  const inReplyTo = headers['in-reply-to'];
  const firstReference = headers['references']?.split(/\s+/)[0];

  return {
    id: asString(rec['id']),
    provider: 'resend',
    domain: domainOf(to[0] ?? ''),
    from,
    to,
    subject: asString(rec['subject']),
    dateMs: createdAt || headerDate || dateMsField || Date.now(),
    snippet: snippetOf(bodyText ?? ''),
    bodyText,
    bodyHtml,
    attachments,
    threadId: inReplyTo ?? firstReference ?? null,
    headers,
  };
}
