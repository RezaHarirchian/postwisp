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

// A 429 is the provider telling us its rate limit, not a failed send.
// Honor Retry-After and try once more; a second 429 (or any other status)
// goes back to the caller unchanged so the send path can report it.
const MAX_RATE_WAIT_MS = 60_000;
const DEFAULT_RATE_WAIT_MS = 1000;

function retryAfterMs(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (raw !== null) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds, MAX_RATE_WAIT_MS / 1000) * 1000;
    }
    const dateMs = Date.parse(raw);
    if (!Number.isNaN(dateMs)) {
      return Math.max(0, Math.min(dateMs - Date.now(), MAX_RATE_WAIT_MS));
    }
  }
  return DEFAULT_RATE_WAIT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Thin wrapper over fetch used by the providers' send paths. The sleep is
// injectable so tests never wait on a real timer.
export async function fetchWithRateRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<Response> {
  const first = await fetchFn(url, init);
  if (first.status !== 429) return first;
  await wait(retryAfterMs(first));
  return fetchFn(url, init);
}

// Proactive rate limiting for provider API calls. Resend documents 10
// requests/second; the reactive 429 retry above stays a last resort, not
// the plan. A min-interval limiter is enough here: the providers'
// sustained call rate is far below any burst ceiling, and the goal is to
// stay under the per-second quota without queueing up bursts.
export const PROVIDER_MIN_INTERVAL_MS = 100;

export class RateLimiter {
  private nextStart = 0;

  constructor(
    private readonly minIntervalMs: number = PROVIDER_MIN_INTERVAL_MS,
    private readonly wait: (ms: number) => Promise<void> = sleep,
    private readonly now: () => number = Date.now,
  ) {}

  // Spaces the start of consecutive calls by at least minIntervalMs.
  // Concurrent callers serialize on the shared nextStart, so the spacing
  // holds even when acquires overlap.
  async acquire(): Promise<void> {
    const start = this.now();
    if (start < this.nextStart) {
      await this.wait(this.nextStart - start);
    }
    this.nextStart = Math.max(start, this.nextStart) + this.minIntervalMs;
  }
}

// Wraps a fetch so every call through it is spaced by the limiter. Used
// for provider API calls; signed-URL attachment downloads are not API
// calls and go through the raw fetch instead.
export function rateLimitedFetch(fetchFn: typeof fetch, limiter: RateLimiter): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    await limiter.acquire();
    return fetchFn(input, init);
  };
}
