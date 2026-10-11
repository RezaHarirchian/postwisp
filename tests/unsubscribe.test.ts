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
  buildUnsubscribeFooter,
  isStopReply,
  unsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
  withUnsubscribe,
  type UnsubscribeConfig,
} from '../src/core/unsubscribe.js';
import type { SendInput } from '../src/providers/interface.js';

const SECRET = 'test-secret-123';
const CFG: UnsubscribeConfig = {
  publicUrl: 'https://mail.example.com',
  secret: SECRET,
  physicalAddress: '123 Main St, Vancouver BC',
};

function sendInput(overrides: Partial<SendInput> = {}): SendInput {
  return {
    from: 'news@mail.example.com',
    to: ['reader@example.org'],
    subject: 'Hello',
    text: 'Body here.',
    ...overrides,
  };
}

describe('unsubscribe tokens', () => {
  it('round-trips an address', () => {
    const token = unsubscribeToken('Reader@Example.org', SECRET);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe('reader@example.org');
  });

  it('rejects a tampered token', () => {
    const token = unsubscribeToken('reader@example.org', SECRET);
    const tampered = `${token.slice(0, 4)}X${token.slice(5)}`;
    expect(verifyUnsubscribeToken(tampered, SECRET)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    const token = unsubscribeToken('reader@example.org', 'other-secret');
    expect(verifyUnsubscribeToken(token, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyUnsubscribeToken('', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('no-dot-here', SECRET)).toBeNull();
    expect(verifyUnsubscribeToken('.onlymac', SECRET)).toBeNull();
  });

  it('builds an absolute one-click URL, or null when unconfigured', () => {
    const url = unsubscribeUrl('reader@example.org', CFG);
    expect(url?.startsWith('https://mail.example.com/unsub/')).toBe(true);
    expect(unsubscribeUrl('reader@example.org', { ...CFG, publicUrl: null })).toBeNull();
    expect(unsubscribeUrl('reader@example.org', { ...CFG, secret: null })).toBeNull();
  });
});

describe('withUnsubscribe', () => {
  it('appends the footer and RFC 8058 headers to a single-recipient send', () => {
    const out = withUnsubscribe(sendInput(), CFG);
    expect(out.text).toContain('Body here.');
    expect(out.text).toContain('Unsubscribe: https://mail.example.com/unsub/');
    expect(out.text).toContain('123 Main St, Vancouver BC');
    expect(out.headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/mail\.example\.com\/unsub\/.+>$/);
    expect(out.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('appends the footer to the HTML body as well', () => {
    const out = withUnsubscribe(sendInput({ html: '<p>Hello</p>' }), CFG);
    expect(out.html).toContain('<p>Hello</p>');
    expect(out.html).toContain('Unsubscribe: https://mail.example.com/unsub/');
    expect(out.html).toContain('123 Main St, Vancouver BC');
  });

  it('escapes footer text in the HTML body', () => {
    const cfg = { ...CFG, physicalAddress: '1 <Main> St & Co.' };
    const out = withUnsubscribe(sendInput({ html: '<p>Hello</p>' }), cfg);
    expect(out.html).toContain('1 &lt;Main&gt; St &amp; Co.');
    expect(out.html).not.toContain('1 <Main> St & Co.');
  });

  it('leaves a 1:1 reply untouched', () => {
    const input = sendInput({ headers: { 'In-Reply-To': '<abc@mail>' } });
    const out = withUnsubscribe(input, CFG);
    expect(out.text).toBe('Body here.');
    expect(out.headers?.['List-Unsubscribe']).toBeUndefined();
  });

  it('detects In-Reply-To case-insensitively', () => {
    const out = withUnsubscribe(sendInput({ headers: { 'in-reply-to': '<abc@mail>' } }), CFG);
    expect(out.text).toBe('Body here.');
  });

  it('uses the STOP footer for multi-recipient sends (no per-recipient headers possible)', () => {
    const out = withUnsubscribe(sendInput({ to: ['a@x.org', 'b@x.org'] }), CFG);
    expect(out.text).toContain('reply to this email with the word STOP');
    expect(out.headers?.['List-Unsubscribe']).toBeUndefined();
  });

  it('keeps existing headers alongside the unsubscribe ones', () => {
    const out = withUnsubscribe(sendInput({ headers: { 'X-Custom': 'yes' } }), CFG);
    expect(out.headers?.['X-Custom']).toBe('yes');
    expect(out.headers?.['List-Unsubscribe']).toMatch(/^<https/);
  });
});

describe('buildUnsubscribeFooter', () => {
  it('omits the address line when none is configured', () => {
    const footer = buildUnsubscribeFooter(
      { from: 'news@mail.example.com', to: ['r@example.org'] },
      { ...CFG, physicalAddress: null },
    );
    expect(footer).toContain('Unsubscribe: https://mail.example.com/unsub/');
    expect(footer).not.toContain('123 Main St');
  });
});

describe('isStopReply', () => {
  it('matches a bare STOP in any case and surrounding whitespace', () => {
    expect(isStopReply('STOP')).toBe(true);
    expect(isStopReply('  stop\n')).toBe(true);
    expect(isStopReply('Stop')).toBe(true);
  });

  it('does not match anything else', () => {
    expect(isStopReply('please stop sending')).toBe(false);
    expect(isStopReply('')).toBe(false);
    expect(isStopReply(null)).toBe(false);
    expect(isStopReply(undefined)).toBe(false);
  });
});

describe('unsubscribe token expiry', () => {
  const SECRET = 'test-secret-16-chars!!';

  it('mints three-part tokens that verify', () => {
    const token = unsubscribeToken('reader@example.org', SECRET);
    expect(token.split('.')).toHaveLength(3);
    expect(verifyUnsubscribeToken(token, SECRET)).toBe('reader@example.org');
  });

  it('rejects tokens older than a year', () => {
    const now = Date.now();
    const old = unsubscribeToken('reader@example.org', SECRET, now - 366 * 86400_000);
    expect(verifyUnsubscribeToken(old, SECRET, now)).toBeNull();
  });

  it('accepts tokens within the year', () => {
    const now = Date.now();
    const token = unsubscribeToken('reader@example.org', SECRET, now - 30 * 86400_000);
    expect(verifyUnsubscribeToken(token, SECRET, now)).toBe('reader@example.org');
  });

  it('rejects tokens from the future beyond clock skew', () => {
    const now = Date.now();
    const future = unsubscribeToken('reader@example.org', SECRET, now + 3600_000);
    expect(verifyUnsubscribeToken(future, SECRET, now)).toBeNull();
  });

  it('treats old two-part tokens as expired', () => {
    // Pre-expiry format: b64url(email).b64url(HMAC).
    expect(verifyUnsubscribeToken('cmVhZGVyQGV4YW1wbGUub3Jn.abcd', SECRET)).toBeNull();
  });

  it('rejects a tampered timestamp', () => {
    const token = unsubscribeToken('reader@example.org', SECRET);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${Buffer.from('1', 'utf8').toString('base64url')}.${parts[2]}`;
    expect(verifyUnsubscribeToken(tampered, SECRET)).toBeNull();
  });
});
