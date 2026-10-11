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

import { describe, expect, it } from 'vitest';
import { parseMime } from '../src/providers/mime.js';

// A realistic nested message: multipart/mixed wrapping
// multipart/alternative (text + html) plus one base64 attachment.
const NESTED = [
  'From: Alice <alice@example.com>',
  'To: bob@example.com',
  'Subject: =?UTF-8?B?aGVsbG8gd29ybGQ=?=',
  'Message-Id: <m1@example.com>',
  'Date: Sat, 10 Oct 2026 18:05:11 +0000',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello=2C world=21',
  '--inner',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello, world!</p>',
  '--inner--',
  '--outer',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('attachment-bytes').toString('base64'),
  '--outer--',
  '',
].join('\r\n');

describe('parseMime', () => {
  it('parses nested multiparts, encodings, and attachments', () => {
    const parsed = parseMime(NESTED);
    expect(parsed.headers['from']).toBe('Alice <alice@example.com>');
    // RFC 2047 decoded subject.
    expect(parsed.headers['subject']).toBe('hello world');
    expect(parsed.headers['message-id']).toBe('<m1@example.com>');
    expect(parsed.text).toBe('Hello, world!');
    expect(parsed.html).toBe('<p>Hello, world!</p>');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]!.filename).toBe('notes.txt');
    expect(parsed.attachments[0]!.mime).toBe('text/plain');
    expect(parsed.attachments[0]!.content).toEqual(Buffer.from('attachment-bytes'));
  });

  it('unfolds long headers', () => {
    const parsed = parseMime(
      'Subject: a very long\r\n subject line\r\nTo: x@y.z\r\n\r\nbody',
    );
    expect(parsed.headers['subject']).toBe('a very long subject line');
    expect(parsed.text).toBe('body');
  });

  it('treats a plain message as text', () => {
    const parsed = parseMime('From: a@b.c\r\n\r\njust text');
    expect(parsed.text).toBe('just text');
    expect(parsed.html).toBeNull();
    expect(parsed.attachments).toHaveLength(0);
  });

  it('never throws on garbage input', () => {
    const parsed = parseMime('not a message at all ::: \x00\x01');
    expect(parsed.text).not.toBeNull();
  });
});

describe('mime parse limits', () => {
  it('aborts on excessive nesting depth instead of recursing', () => {
    // 12 nested multiparts; the cap is 10. parseMime converts the abort
    // into an empty parse rather than throwing.
    let raw = 'Content-Type: text/plain\r\n\r\nleaf';
    for (let i = 0; i < 12; i++) {
      raw = `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n${raw}\r\n--b${i}--`;
    }
    const parsed = parseMime(raw);
    expect(parsed.text).toBeNull();
    expect(parsed.html).toBeNull();
    expect(parsed.attachments).toHaveLength(0);
  });

  it('aborts when the part count exceeds the cap', () => {
    const parts = Array.from(
      { length: 600 },
      (_, i) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${i}`,
    ).join('\r\n');
    const raw = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}\r\n--b--`;
    const parsed = parseMime(raw);
    expect(parsed.text).toBeNull();
    expect(parsed.attachments).toHaveLength(0);
  });

  it('still parses ordinary nesting under the caps', () => {
    const parts = Array.from(
      { length: 5 },
      (_, i) => `--b\r\nContent-Type: text/plain\r\n\r\npart ${i}`,
    ).join('\r\n');
    const raw = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}\r\n--b--`;
    const parsed = parseMime(raw);
    expect(parsed.text).toContain('part 0');
  });
});
