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

import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSendQueue, type SendRequest } from '../src/bot/queue.js';
import { createLogger, type Logger } from '../src/core/logger.js';

interface Call {
  text: string;
}

function setup() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger: Logger = createLogger({ stream });
  const calls: Call[] = [];
  const send = async (req: SendRequest): Promise<void> => {
    calls.push({ text: req.text });
  };
  const queue = createSendQueue(send, logger);
  return { queue, calls, lines };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSendQueue', () => {
  it('paces sends to one message per second per chat', async () => {
    const { queue, calls } = setup();
    queue.enqueue(1, { text: 'a' });
    queue.enqueue(1, { text: 'b' });
    queue.enqueue(1, { text: 'c' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.text)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls.map((c) => c.text)).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls.map((c) => c.text)).toEqual(['a', 'b', 'c']);
    queue.stop();
  });

  it('sends to different chats independently', async () => {
    const { queue, calls } = setup();
    queue.enqueue(1, { text: 'chat1' });
    queue.enqueue(2, { text: 'chat2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.text).sort()).toEqual(['chat1', 'chat2']);
    queue.stop();
  });

  it('keeps FIFO order within a chat', async () => {
    const { queue, calls } = setup();
    for (const t of ['1', '2', '3', '4']) queue.enqueue(7, { text: t });
    await vi.advanceTimersByTimeAsync(1100 * 4);
    expect(calls.map((c) => c.text)).toEqual(['1', '2', '3', '4']);
    queue.stop();
  });

  it('waits out retry_after on 429 and retries the same request', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger: Logger = createLogger({ stream });
    const calls: string[] = [];
    let attempts = 0;
    const send = async (req: SendRequest): Promise<void> => {
      attempts += 1;
      if (attempts === 1) {
        const err = { error_code: 429, parameters: { retry_after: 5 } };
        throw err;
      }
      calls.push(req.text);
    };
    const queue = createSendQueue(send, logger);
    queue.enqueue(1, { text: 'retry-me' });
    queue.enqueue(1, { text: 'next' });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    // 5s penalty, not the 1.1s spacing.
    await vi.advanceTimersByTimeAsync(4999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['retry-me']);
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls).toEqual(['retry-me', 'next']);
    expect(lines.join('\n')).toContain('rate-limited');
    queue.stop();
  });

  it('drops failed non-429 sends and keeps going', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger: Logger = createLogger({ stream });
    const calls: string[] = [];
    const send = async (req: SendRequest): Promise<void> => {
      if (req.text === 'boom') throw new Error('network down');
      calls.push(req.text);
    };
    const queue = createSendQueue(send, logger);
    queue.enqueue(1, { text: 'boom' });
    queue.enqueue(1, { text: 'after' });
    await vi.advanceTimersByTimeAsync(1100 * 2);
    expect(calls).toEqual(['after']);
    expect(lines.join('\n')).toContain('dropping request');
    queue.stop();
  });

  it('stop() refuses new work', async () => {
    const { queue, calls } = setup();
    queue.enqueue(1, { text: 'a' });
    queue.stop();
    queue.enqueue(1, { text: 'b' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map((c) => c.text)).toEqual(['a']);
  });

  it('warns when a notification is dropped after stop()', async () => {
    const { queue, lines } = setup();
    queue.stop();
    queue.enqueue(1, { text: 'lost notification' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lines.join('\n')).toContain('send queue stopped');
  });
});
