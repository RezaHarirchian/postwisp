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

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDigestMessages,
  startDigestScheduler,
  type DigestEmail,
} from '../src/bot/digest.js';

function makeEmail(i: number, subjectLen = 40): DigestEmail {
  return {
    id: `email-${i}`,
    fromAddr: `sender${i}@example.org`,
    fromName: `Sender ${i}`,
    subject: `S${i}-` + 'x'.repeat(subjectLen),
  };
}

function buttonCallbacks(msg: { replyMarkup: unknown }): string[] {
  const kb = msg.replyMarkup as {
    inline_keyboard?: Array<Array<{ callback_data?: string }>>;
  };
  return (kb?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
}

describe('buildDigestMessages', () => {
  it('returns one message for a small digest', () => {
    const msgs = buildDigestMessages([makeEmail(1), makeEmail(2)]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain('2 new emails');
    expect(msgs[0]!.text).toContain('Sender 1');
    expect(msgs[0]!.protectContent).toBe(true);
    expect(buttonCallbacks(msgs[0]!)).toEqual(['e:email-1', 'e:email-2']);
  });

  it('fans a large drained queue out into multiple sub-4096 messages', () => {
    const emails = Array.from({ length: 120 }, (_, i) => makeEmail(i, 120));
    const msgs = buildDigestMessages(emails);
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) {
      expect(m.text.length).toBeLessThanOrEqual(4096);
      expect(m.protectContent).toBe(true);
    }
    // Every email appears exactly once, with its Open button.
    const allCallbacks = msgs.flatMap(buttonCallbacks);
    expect(allCallbacks).toHaveLength(120);
    expect(new Set(allCallbacks).size).toBe(120);
    expect(allCallbacks).toContain('e:email-0');
    expect(allCallbacks).toContain('e:email-119');
  });

  it('numbers continuation pages', () => {
    const emails = Array.from({ length: 120 }, (_, i) => makeEmail(i, 120));
    const msgs = buildDigestMessages(emails);
    expect(msgs[0]!.text).toContain(`(1/${msgs.length})`);
    expect(msgs[msgs.length - 1]!.text).toContain(`(${msgs.length}/${msgs.length})`);
  });

  it('handles an empty queue with a single titled message', () => {
    const msgs = buildDigestMessages([]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain('0 new emails');
    expect(msgs[0]!.protectContent).toBe(true);
  });

  it('truncates pathological subjects so one email cannot blow the chunk', () => {
    const msgs = buildDigestMessages([makeEmail(1, 20000)]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text.length).toBeLessThanOrEqual(4096);
  });
});

describe('buildDigestMessages', () => {
  it('returns the single message with protect_content set', () => {
    const [d] = buildDigestMessages([makeEmail(1)]);
    expect(d!.text).toContain('1 new emails');
    expect(d!.protectContent).toBe(true);
  });
});

describe('startDigestScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("falls back to 08:00 when the stored hour isn't finite", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 11, 7, 0, 0));
    const delays: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const fires: number[] = [];
    const sched = startDigestScheduler({ mode: 'daily', hour: NaN, onFire: () => fires.push(1) });
    // 07:00 -> next 08:00 is exactly one hour out.
    expect(delays[0]).toBe(60 * 60 * 1000);
    sched.stop();
    spy.mockRestore();
  });

  it('honors a valid hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 11, 7, 0, 0));
    const delays: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);

    const sched = startDigestScheduler({ mode: 'daily', hour: 9, onFire: () => {} });
    expect(delays[0]).toBe(2 * 60 * 60 * 1000);
    sched.stop();
    spy.mockRestore();
  });
});
