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
import { fetchWithRateRetry, rateLimitedFetch, RateLimiter } from '../src/providers/http.js';

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers });
}

describe('fetchWithRateRetry', () => {
  it('passes non-429 responses through with a single call', async () => {
    let calls = 0;
    const waits: number[] = [];
    const out = await fetchWithRateRetry(
      (async () => {
        calls++;
        return res(200);
      }) as typeof fetch,
      'https://example.com',
      {},
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(out.status).toBe(200);
    expect(calls).toBe(1);
    expect(waits).toHaveLength(0);
  });

  it('retries once after the Retry-After delay on a 429', async () => {
    const seen: number[] = [];
    const waits: number[] = [];
    let calls = 0;
    const out = await fetchWithRateRetry(
      (async () => {
        calls++;
        return calls === 1 ? res(429, { 'retry-after': '2' }) : res(200);
      }) as typeof fetch,
      'https://example.com',
      {},
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(out.status).toBe(200);
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
    expect(seen).toHaveLength(0);
  });

  it('waits a default second when the 429 carries no Retry-After', async () => {
    const waits: number[] = [];
    let calls = 0;
    await fetchWithRateRetry(
      (async () => {
        calls++;
        return calls === 1 ? res(429) : res(200);
      }) as typeof fetch,
      'https://example.com',
      {},
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(calls).toBe(2);
    expect(waits).toEqual([1000]);
  });

  it('does not loop: a second 429 is returned to the caller', async () => {
    let calls = 0;
    const out = await fetchWithRateRetry(
      (async () => {
        calls++;
        return res(429, { 'retry-after': '1' });
      }) as typeof fetch,
      'https://example.com',
      {},
      async () => {},
    );
    expect(out.status).toBe(429);
    expect(calls).toBe(2);
  });

  it('caps an absurd Retry-After instead of sleeping for hours', async () => {
    const waits: number[] = [];
    let calls = 0;
    await fetchWithRateRetry(
      (async () => {
        calls++;
        return calls === 1 ? res(429, { 'retry-after': '999999' }) : res(200);
      }) as typeof fetch,
      'https://example.com',
      {},
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(calls).toBe(2);
    expect(waits[0]).toBeLessThanOrEqual(60_000);
  });
});

describe('RateLimiter', () => {
  it('lets the first call through without waiting', async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter(
      100,
      async (ms) => {
        waits.push(ms);
      },
      () => 1000,
    );
    await limiter.acquire();
    expect(waits).toHaveLength(0);
  });

  it('spaces consecutive calls by the minimum interval', async () => {
    const waits: number[] = [];
    let now = 1000;
    const limiter = new RateLimiter(
      100,
      async (ms) => {
        waits.push(ms);
      },
      () => now,
    );
    await limiter.acquire(); // t=1000: free, next start 1100
    now = 1050;
    await limiter.acquire(); // 50ms early: waits 50, next start 1200
    expect(waits).toEqual([50]);
    now = 1250;
    await limiter.acquire(); // past the window: no wait
    expect(waits).toEqual([50]);
  });

  it('rateLimitedFetch paces every call through the limiter', async () => {
    const waits: number[] = [];
    let now = 0;
    let calls = 0;
    const inner = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const limited = rateLimitedFetch(
      inner,
      new RateLimiter(
        100,
        async (ms) => {
          waits.push(ms);
        },
        () => now,
      ),
    );
    await limited('https://example.com/1');
    now = 10;
    await limited('https://example.com/2');
    expect(calls).toBe(2);
    expect(waits).toEqual([90]);
  });
});
