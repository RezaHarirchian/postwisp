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
import {
  TELEGRAM_MAX_CHARS,
  chunkText,
  escapeHtml,
  evalRule,
  extractOtp,
  formatInboundMessage,
  hasUnsubscribe,
  parseInboundMessage,
  truncateSnippet,
} from '../tgcloud/lib/pure.js';

describe('extractOtp', () => {
  it('finds a code near a keyword', () => {
    expect(extractOtp('Your verification code is 482917. It expires soon.')).toEqual(['482917']);
  });

  it('accepts 4 to 8 digit codes', () => {
    expect(extractOtp('code: 1234')).toEqual(['1234']);
    expect(extractOtp('code: 12345678')).toEqual(['12345678']);
  });

  it('rejects runs shorter than 4 or longer than 8 digits', () => {
    expect(extractOtp('code: 123')).toEqual([]);
    expect(extractOtp('code: 123456789')).toEqual([]);
  });

  it('never takes an 8-digit slice out of a longer run', () => {
    expect(extractOtp('code: 123456789')).toEqual([]);
  });

  it('ignores digit runs far from any keyword', () => {
    expect(extractOtp('Your order 482917 shipped on 2026-10-11.')).toEqual([]);
  });

  it('dedupes repeated codes', () => {
    expect(extractOtp('code 1111, again code 1111')).toEqual(['1111']);
  });

  it('is case-insensitive on keywords', () => {
    expect(extractOtp('Your OTP is 5566')).toEqual(['5566']);
  });

  it('handles empty and non-string input', () => {
    expect(extractOtp('')).toEqual([]);
    expect(extractOtp(undefined as unknown as string)).toEqual([]);
  });
});

describe('chunkText', () => {
  it('returns short text as a single chunk', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('splits at the Telegram limit', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_CHARS + 10);
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(TELEGRAM_MAX_CHARS);
    expect(chunks[1]).toHaveLength(10);
  });

  it('never splits a surrogate pair', () => {
    const emoji = '🚀';
    const text = 'a'.repeat(TELEGRAM_MAX_CHARS - 1) + emoji + 'b';
    const chunks = chunkText(text);
    // chunks[0] holds 4096 code points (4095 a's + the emoji); its UTF-16
    // length is 4097 because the emoji is a surrogate pair.
    expect(Array.from(chunks[0] ?? '')).toHaveLength(TELEGRAM_MAX_CHARS);
    expect(chunks[0]?.endsWith(emoji)).toBe(true);
    expect(chunks[1]).toBe('b');
  });

  it('returns one empty chunk for empty input', () => {
    expect(chunkText('')).toEqual(['']);
  });
});

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml('<b>"a" & \'b\'</b>')).toBe('&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;');
  });

  it('leaves plain text alone', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('truncateSnippet', () => {
  it('collapses whitespace', () => {
    expect(truncateSnippet('a  b\nc')).toBe('a b c');
  });

  it('truncates long text with an ellipsis', () => {
    const out = truncateSnippet('x'.repeat(200), 10);
    expect(Array.from(out)).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves short text unchanged', () => {
    expect(truncateSnippet('short', 160)).toBe('short');
  });
});

describe('evalRule', () => {
  const email = { from_addr: 'news@example.com', subject: 'Weekly digest' };

  it('contains is case-insensitive', () => {
    expect(evalRule({ field: 'from', matcher: 'contains', value: 'NEWS' }, email)).toBe(true);
    expect(evalRule({ field: 'subject', matcher: 'contains', value: 'monthly' }, email)).toBe(false);
  });

  it('supports starts_with, ends_with, equals', () => {
    expect(evalRule({ field: 'from', matcher: 'starts_with', value: 'news@' }, email)).toBe(true);
    expect(evalRule({ field: 'subject', matcher: 'ends_with', value: 'digest' }, email)).toBe(true);
    expect(evalRule({ field: 'subject', matcher: 'equals', value: 'Weekly digest' }, email)).toBe(true);
    expect(evalRule({ field: 'subject', matcher: 'equals', value: 'weekly' }, email)).toBe(false);
  });

  it('supports regex and never throws on invalid patterns', () => {
    expect(evalRule({ field: 'subject', matcher: 'regex', value: '^weekly' }, email)).toBe(true);
    expect(evalRule({ field: 'subject', matcher: 'regex', value: '([' }, email)).toBe(false);
  });

  it('treats an unknown matcher as contains', () => {
    expect(evalRule({ field: 'subject', matcher: 'bogus', value: 'digest' }, email)).toBe(true);
  });
});

describe('hasUnsubscribe', () => {
  it('detects the List-Unsubscribe header', () => {
    expect(hasUnsubscribe({ 'list-unsubscribe': '<mailto:x@y>' }, 'hello')).toBe(true);
  });

  it('detects an unsubscribe link in the body', () => {
    expect(hasUnsubscribe({}, 'click here to unsubscribe')).toBe(true);
  });

  it('returns false for plain mail', () => {
    expect(hasUnsubscribe({}, 'hello there')).toBe(false);
  });
});

describe('inbound wire format', () => {
  const email = {
    from_addr: 'alice@example.com',
    from_name: 'Alice',
    subject: 'Your code',
    date_ms: 1760140000000,
    body: 'Your code is 482917.',
  };

  it('round-trips through format and parse', () => {
    const parsed = parseInboundMessage(formatInboundMessage(email));
    expect(parsed).toMatchObject({
      from_addr: 'alice@example.com',
      from_name: 'Alice',
      subject: 'Your code',
      body: 'Your code is 482917.',
    });
  });

  it('handles a bare address without a display name', () => {
    const parsed = parseInboundMessage(formatInboundMessage({ ...email, from_name: '' }));
    expect(parsed?.from_addr).toBe('alice@example.com');
    expect(parsed?.from_name).toBe('');
  });

  it('keeps multi-line bodies intact', () => {
    const body = 'line one\n\nline three';
    const parsed = parseInboundMessage(formatInboundMessage({ ...email, body }));
    expect(parsed?.body).toBe(body);
  });

  it('folds newlines in header values so the wire format survives', () => {
    const parsed = parseInboundMessage(
      formatInboundMessage({ ...email, subject: 'line one\nline two', from_name: 'Al\nice' }),
    );
    expect(parsed?.subject).toBe('line one line two');
    expect(parsed?.from_name).toBe('Al ice');
  });

  it('returns null for text that is not in the wire format', () => {
    expect(parseInboundMessage('just some text')).toBeNull();
    expect(parseInboundMessage('From: x')).toBeNull();
    expect(parseInboundMessage(undefined as unknown as string)).toBeNull();
  });
});
