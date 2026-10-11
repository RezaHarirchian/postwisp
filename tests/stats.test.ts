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

import type { Context } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { buildStatsView, handleStatsMenu } from '../src/bot/stats.js';
import { openStore, type Store } from '../src/core/store.js';

let stores: Store[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores = [];
});

function memStore(): Store {
  const s = openStore(':memory:');
  stores.push(s);
  return s;
}

let seq = 0;
function logBatch(
  store: Store,
  domain: string,
  counts: { delivered?: number; bounced?: number; complained?: number; sent?: number },
): void {
  const entries: Array<[string, number]> = [
    ['delivered', counts.delivered ?? 0],
    ['bounced', counts.bounced ?? 0],
    ['complained', counts.complained ?? 0],
    ['sent', counts.sent ?? 0],
  ];
  for (const [status, n] of entries) {
    for (let i = 0; i < n; i += 1) {
      seq += 1;
      store.logSent({
        providerId: `prov_${seq}`,
        to: 'bob@example.com',
        subject: 's',
        domain,
        status,
      });
    }
  }
}

describe('buildStatsView', () => {
  it('shows an empty state with no sent mail', () => {
    const view = buildStatsView(memStore());
    expect(view.text).toContain('Delivery stats');
    expect(view.text).toContain('No sent emails yet.');
  });

  it('renders per-domain counts and rates', () => {
    const store = memStore();
    logBatch(store, 'postwisp.dev', { delivered: 90, bounced: 3, complained: 0, sent: 7 });
    logBatch(store, 'other.dev', { delivered: 5, bounced: 0, complained: 0 });

    const view = buildStatsView(store);
    expect(view.text).toContain('postwisp.dev');
    expect(view.text).toContain('Sent: 100 | Delivered: 90 | Bounced: 3 | Complaints: 0');
    expect(view.text).toContain('Bounce rate: 3.00% | Complaint rate: 0.00%');
    expect(view.text).toContain('other.dev');
    expect(view.text).toContain('Sent: 5 | Delivered: 5 | Bounced: 0 | Complaints: 0');
    // Below both thresholds: no warnings.
    expect(view.text).not.toContain('Warning:');
  });

  it('warns when the bounce rate reaches 4%', () => {
    const store = memStore();
    logBatch(store, 'postwisp.dev', { delivered: 96, bounced: 4 });

    const view = buildStatsView(store);
    expect(view.text).toContain('Warning: bounce rate 4.00% is at or above 4%.');
  });

  it('warns when the complaint rate reaches 0.08%', () => {
    const store = memStore();
    logBatch(store, 'postwisp.dev', { delivered: 99, complained: 1 });

    const view = buildStatsView(store);
    expect(view.text).toContain('Warning: complaint rate 1.00% is at or above 0.08%.');
  });

  it('keeps the view short', () => {
    const store = memStore();
    logBatch(store, 'postwisp.dev', { delivered: 400, bounced: 40, complained: 10 });
    const view = buildStatsView(store);
    expect(view.text.length).toBeLessThanOrEqual(4000);
  });
});

describe('handleStatsMenu', () => {
  it('replies with the stats view and protects the content', async () => {
    const store = memStore();
    logBatch(store, 'postwisp.dev', { delivered: 2, bounced: 1 });
    const calls: Array<{ text: string; extra: unknown }> = [];
    const ctx = {
      reply: async (text: string, extra: unknown) => {
        calls.push({ text, extra });
        return undefined;
      },
    } as unknown as Context;

    await handleStatsMenu(ctx, { store });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.text).toContain('Delivery stats');
    expect(call.text).toContain('postwisp.dev');
    expect(call.extra).toEqual({ parse_mode: 'HTML', protect_content: true });
  });
});
