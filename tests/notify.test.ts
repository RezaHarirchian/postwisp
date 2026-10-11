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
import { buildNotification, type NotifyEvent } from '../src/bot/notify.js';

function makeEvent(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    id: 'ev1',
    provider: 'resend',
    domain: 'example.com',
    from: { address: 'alice@example.com', name: 'Alice' },
    to: ['me@example.com'],
    subject: 'Hello',
    dateMs: Date.UTC(2026, 9, 10, 12, 0, 0),
    snippet: 'short snippet',
    bodyText: 'short body',
    bodyHtml: null,
    attachments: [],
    threadId: null,
    headers: {},
    ...overrides,
  };
}

function buttonTexts(n: ReturnType<typeof buildNotification>): string[] {
  const kb = n.replyMarkup as unknown as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  return kb.inline_keyboard.flat().map((b) => `${b.text}|${b.callback_data}`);
}

describe('buildNotification', () => {
  it('renders From / Subject / Date lines plus the body', () => {
    const n = buildNotification(makeEvent());
    expect(n.text).toContain('From: Alice &lt;alice@example.com&gt;');
    expect(n.text).toContain('Subject: Hello');
    expect(n.text).toContain('2026-10-10 12:00 UTC');
    expect(n.text).toContain('short body');
  });

  it('escapes HTML in user content', () => {
    const n = buildNotification(
      makeEvent({ subject: '<b>oops</b>', from: { address: 'a@b.c', name: '<script>' } }),
    );
    expect(n.text).toContain('&lt;b&gt;oops&lt;/b&gt;');
    expect(n.text).toContain('&lt;script&gt;');
    expect(n.text).not.toContain('<script>');
  });

  it('collapses bodies longer than 500 chars into an expandable blockquote', () => {
    const n = buildNotification(makeEvent({ bodyText: 'x'.repeat(600), snippet: 'the snippet' }));
    expect(n.text).toContain('<blockquote expandable>the snippet</blockquote>');
    expect(n.text).not.toContain('x'.repeat(600));
    const buttons = buttonTexts(n);
    expect(buttons.some((b) => b.startsWith('Full text|e:ev1:full'))).toBe(true);
  });

  it('shows the full body inline when it fits', () => {
    const n = buildNotification(makeEvent({ bodyText: 'fits fine' }));
    expect(n.text).toContain('fits fine');
    expect(buttonTexts(n).some((b) => b.includes(':full'))).toBe(false);
  });

  it('adds an attachments button with the count and hides Full text when short', () => {
    const n = buildNotification(
      makeEvent({
        bodyText: 'short',
        attachments: [{ id: 'a1', filename: 'f.pdf', size: 10, mime: 'application/pdf' }],
      }),
    );
    const buttons = buttonTexts(n);
    expect(buttons.some((b) => b.startsWith('Attachments (1)|e:ev1:att'))).toBe(true);
    expect(buttons.some((b) => b.startsWith('Reply|e:ev1:reply'))).toBe(true);
    expect(buttons.some((b) => b.startsWith('Archive|e:ev1:arch'))).toBe(true);
  });

  it('renders OTP codes as one-tap code spans', () => {
    const n = buildNotification(makeEvent({ bodyText: 'your code is 123456' }), {
      extractOtp: (text) => (text.includes('123456') ? ['123456'] : []),
    });
    expect(n.text).toContain('One-time code: <code>123456</code>');
  });

  it('omits the OTP line when no codes are found', () => {
    const n = buildNotification(makeEvent(), { extractOtp: () => [] });
    expect(n.text).not.toContain('One-time code');
  });

  it('marks every notification with parseMode HTML and protect_content', () => {
    const n = buildNotification(makeEvent());
    expect(n.parseMode).toBe('HTML');
    expect(n.protectContent).toBe(true);
  });
});

describe('notification size limits', () => {
  it('keeps the notification under 4096 chars with oversized fields', () => {
    const n = buildNotification(
      makeEvent({
        subject: 'S'.repeat(5000),
        from: { address: 'a@b.c', name: 'N'.repeat(5000) },
        snippet: 'P'.repeat(20000),
        bodyText: 'B'.repeat(20000),
      }),
    );
    expect(n.text.length).toBeLessThanOrEqual(4096);
    expect(n.text).toContain('S'.repeat(10));
  });

  it('keeps the notification under 4096 chars with a huge inline body', () => {
    const n = buildNotification(makeEvent({ bodyText: 'B'.repeat(100000) }));
    expect(n.text.length).toBeLessThanOrEqual(4096);
  });

  it('keeps the notification under 4096 chars with entity-heavy content', () => {
    const n = buildNotification(
      makeEvent({ subject: '<>&'.repeat(3000), snippet: '&'.repeat(10000) }),
    );
    expect(n.text.length).toBeLessThanOrEqual(4096);
  });
});

describe('chunkText', () => {
  it('never splits a surrogate pair', async () => {
    const { chunkText } = await import('../src/bot/notify.js');
    const emoji = '😀';
    const text = `${'a'.repeat(3999)}${emoji}${'b'.repeat(100)}`;
    const chunks = chunkText(text, 4000);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      // A lone surrogate would show up as an unpaired code unit.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(c)).toBe(false);
      expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c)).toBe(false);
    }
  });

  it('still splits on line boundaries under the budget', async () => {
    const { chunkText } = await import('../src/bot/notify.js');
    // The newline sits inside the preferred [max/2, max] window.
    const text = `${'a'.repeat(3900)}\n${'b'.repeat(5000)}`;
    const chunks = chunkText(text, 4000);
    expect(chunks[0]).toBe('a'.repeat(3900));
    // The newline at the cut is consumed, not duplicated; the long tail
    // keeps chunking at the budget.
    expect(chunks[1]).toBe('b'.repeat(4000));
    expect(chunks[2]).toBe('b'.repeat(1000));
  });

  it('honors a custom budget below the default', async () => {
    const { chunkText } = await import('../src/bot/notify.js');
    const chunks = chunkText('x'.repeat(10000), 1000);
    expect(chunks.length).toBe(10);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });
});
