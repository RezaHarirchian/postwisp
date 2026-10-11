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

// Minimal MIME parser for inbound mail. Mailgun's Routes forward() posts
// the full raw message as body-mime, so the adapter parses it here instead
// of depending on a third-party MIME library. Covers the shapes real mail
// arrives in: nested multiparts, base64 / quoted-printable / 7bit bodies,
// folded headers, RFC 2047 encoded words. Anything exotic degrades to the
// raw text body rather than throwing.

export interface MimeAttachment {
  filename: string;
  mime: string;
  content: Buffer;
}

export interface ParsedMime {
  // Lowercased header names, unfolded and RFC 2047-decoded.
  headers: Record<string, string>;
  text: string | null;
  html: string | null;
  attachments: MimeAttachment[];
}

// A single part over 32 MB is skipped: it cannot be a legitimate inline
// body, and materializing it risks blowing the process memory.
const MAX_PART_BYTES = 32 * 1024 * 1024;
// A crafted message can nest multiparts arbitrarily deep or carry a huge
// part count; both turn the webhook path into a CPU/memory sink. Depth 10
// and 500 parts are far beyond anything real mail needs (typical mail is
// depth <= 3 with a handful of parts). parseMime converts the throw into
// an empty parse, so a hostile message degrades to bodyless, never a
// crash.
const MAX_MIME_DEPTH = 10;
const MAX_MIME_PARTS = 500;

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  let idx = raw.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx < 0) {
    idx = raw.indexOf('\n\n');
    sepLen = 2;
  }
  const head = idx >= 0 ? raw.slice(0, idx) : raw;
  const body = idx >= 0 ? raw.slice(idx + sepLen) : '';
  const headers: Record<string, string> = {};
  let currentName = '';
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && currentName) {
      // Folded continuation: join with a single space.
      headers[currentName] = `${headers[currentName]} ${line.trim()}`;
    } else {
      const colon = line.indexOf(':');
      if (colon > 0) {
        currentName = line.slice(0, colon).trim().toLowerCase();
        headers[currentName] = decodeWords(line.slice(colon + 1).trim());
      }
    }
  }
  return { headers, body };
}

// RFC 2047 encoded words: =?charset?B|Q?text?=
function decodeWords(value: string): string {
  return value.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    try {
      if (String(enc).toUpperCase() === 'B') {
        return decodeText(Buffer.from(String(text), 'base64'), String(charset));
      }
      const qp = String(text).replace(/_/g, ' ');
      return decodeText(decodeQuotedPrintable(qp), String(charset));
    } catch {
      return _m;
    }
  });
}

function decodeQuotedPrintable(input: string): Buffer {
  // Soft line breaks (a lone "=" at end of line) are removed first.
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const ch = withoutSoftBreaks[i];
    if (ch === '=' && i + 2 < withoutSoftBreaks.length) {
      const hex = withoutSoftBreaks.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(ch!.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeText(buf: Buffer, charset: string): string {
  const normalized = charset.toLowerCase().replace(/[^a-z0-9]/g, '');
  const encoding: BufferEncoding =
    normalized === 'utf8' ? 'utf8' : normalized === 'latin1' || normalized === 'iso88591' ? 'latin1' : 'utf8';
  try {
    return buf.toString(encoding);
  } catch {
    return buf.toString('latin1');
  }
}

interface ContentType {
  mime: string;
  params: Record<string, string>;
}

function parseContentType(value: string): ContentType {
  const parts = value.split(';');
  const mime = (parts[0] ?? 'text/plain').trim().toLowerCase() || 'text/plain';
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim().toLowerCase();
      const val = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
      params[key] = decodeWords(val);
    }
  }
  return { mime, params };
}

function parseDisposition(value: string | undefined): { kind: string; filename?: string } {
  if (!value) return { kind: '' };
  const parts = value.split(';');
  const kind = (parts[0] ?? '').trim().toLowerCase();
  let filename: string | undefined;
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim().toLowerCase() === 'filename') {
      filename = decodeWords(part.slice(eq + 1).trim().replace(/^"|"$/g, ''));
    }
  }
  return filename !== undefined ? { kind, filename } : { kind };
}

function decodeBody(body: string, transferEncoding: string): Buffer {
  const enc = transferEncoding.trim().toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(body);
  }
  // 7bit, 8bit, binary: bytes as they arrived.
  return Buffer.from(body, 'latin1');
}

function splitMultipart(body: string, boundary: string, counter: { count: number }): string[] {
  const parts: string[] = [];
  const delimiter = `--${boundary}`;
  const close = `--${boundary}--`;
  let current: string[] | null = null;
  const pushPart = (): void => {
    if (!current) return;
    // Counted here, not after the split, so a part flood is cut off before
    // the part array itself can grow without bound.
    counter.count++;
    if (counter.count > MAX_MIME_PARTS) {
      throw new Error(`mime part count exceeds ${MAX_MIME_PARTS}`);
    }
    parts.push(current.join('\n'));
  };
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === delimiter) {
      pushPart();
      current = [];
    } else if (line === close) {
      pushPart();
      break;
    } else if (current) {
      current.push(rawLine);
    }
  }
  return parts;
}

function mergeInto(target: ParsedMime, part: ParsedMime): void {
  if (target.text === null) target.text = part.text;
  if (target.html === null) target.html = part.html;
  target.attachments.push(...part.attachments);
}

function parseEntity(
  headers: Record<string, string>,
  body: string,
  depth: number,
  counter: { count: number },
): ParsedMime {
  if (depth > MAX_MIME_DEPTH) {
    throw new Error(`mime nesting depth exceeds ${MAX_MIME_DEPTH}`);
  }
  const result: ParsedMime = { headers, text: null, html: null, attachments: [] };
  const contentType = parseContentType(headers['content-type'] ?? 'text/plain');
  const mainType = contentType.mime.split('/')[0] ?? 'text';

  if (mainType === 'multipart') {
    const boundary = contentType.params['boundary'];
    if (!boundary) return result;
    for (const partRaw of splitMultipart(body, boundary, counter)) {
      if (Buffer.byteLength(partRaw, 'latin1') > MAX_PART_BYTES) continue;
      const { headers: partHeaders, body: partBody } = splitHeaders(partRaw);
      mergeInto(result, parseEntity(partHeaders, partBody, depth + 1, counter));
    }
    return result;
  }

  const disposition = parseDisposition(headers['content-disposition']);
  const filename = disposition.filename ?? contentType.params['name'];
  const isAttachment =
    disposition.kind === 'attachment' || filename !== undefined || mainType !== 'text';

  const bytes = decodeBody(body, headers['content-transfer-encoding'] ?? '7bit');
  if (isAttachment) {
    if (bytes.length > MAX_PART_BYTES) return result;
    result.attachments.push({
      filename: filename ?? 'attachment',
      mime: contentType.mime,
      content: bytes,
    });
    return result;
  }

  const decoded = decodeText(bytes, contentType.params['charset'] ?? 'utf-8');
  if (contentType.mime === 'text/html') {
    result.html = decoded;
  } else {
    result.text = decoded;
  }
  return result;
}

// Parses a full raw MIME message. Never throws on malformed input: the
// worst case is an empty text/html pair, which the caller treats as a
// bodyless message.
export function parseMime(raw: Buffer | string): ParsedMime {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('latin1');
    const { headers, body } = splitHeaders(text);
    return parseEntity(headers, body, 0, { count: 0 });
  } catch {
    return { headers: {}, text: null, html: null, attachments: [] };
  }
}
