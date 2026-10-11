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

import type { Logger } from '../core/logger.js';

export interface SendRequest {
  text: string;
  extra?: {
    replyMarkup?: unknown;
    protectContent?: boolean;
    parseMode?: string;
    // The email this message notifies about. The coordinator records the
    // sent message id against it so reactions can act on the email.
    notifyEmailId?: string;
  };
}

export interface SendQueue {
  enqueue(chatId: number, req: SendRequest): void;
  stop(): void;
}

// Telegram's limit is 30 messages per second globally and roughly one per
// second per chat; 1100ms of spacing keeps one chat safely under the limit
// while other chats send independently.
const SEND_SPACING_MS = 1100;

interface ChatState {
  items: SendRequest[];
  active: boolean;
  stopped: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Telegram reports flood control as a 429 with retry_after in seconds.
// Return the wait in milliseconds, or null when the error is something else.
function retryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  const code = e['error_code'] ?? e['statusCode'] ?? e['status'];
  if (code !== 429) return null;
  const params = e['parameters'] as Record<string, unknown> | undefined;
  const retryAfter = params?.['retry_after'] ?? e['retry_after'];
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.ceil(retryAfter * 1000);
  }
  // A 429 without retry_after still means back off; one spacing round is
  // the gentlest sane default.
  return SEND_SPACING_MS;
}

export function createSendQueue(send: (req: SendRequest) => Promise<void>, logger: Logger): SendQueue {
  const chats = new Map<number, ChatState>();
  let stopped = false;

  async function pump(chatId: number): Promise<void> {
    const state = chats.get(chatId);
    if (!state || state.active || state.stopped) return;
    state.active = true;
    try {
      while (state.items.length > 0 && !stopped && !state.stopped) {
        const req = state.items[0] as SendRequest;
        try {
          await send(req);
          state.items.shift();
          await delay(SEND_SPACING_MS);
        } catch (err) {
          const wait = retryAfterMs(err);
          if (wait !== null) {
            // Flood control: keep the same request at the head and wait out
            // the penalty before retrying it.
            logger.warn('telegram send rate-limited, backing off', { chatId, waitMs: wait });
            await delay(wait);
          } else {
            logger.error('telegram send failed, dropping request', {
              chatId,
              detail: err instanceof Error ? err.message : String(err),
            });
            state.items.shift();
            await delay(SEND_SPACING_MS);
          }
        }
      }
    } finally {
      state.active = false;
    }
  }

  return {
    enqueue(chatId: number, req: SendRequest): void {
      if (stopped) {
        // Silent drops are invisible: a notification lost here never
        // reaches the owner, so say so loudly in the logs.
        logger.warn('send queue stopped: dropping notification', { chatId });
        return;
      }
      let state = chats.get(chatId);
      if (!state) {
        state = { items: [], active: false, stopped: false };
        chats.set(chatId, state);
      }
      state.items.push(req);
      // A running pump picks the item up; otherwise start one. Single-threaded
      // JS makes the active flag race-free.
      void pump(chatId);
    },
    stop(): void {
      stopped = true;
      for (const state of chats.values()) state.stopped = true;
      chats.clear();
    },
  };
}
