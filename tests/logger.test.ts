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
import { describe, expect, it } from 'vitest';
import { createLogger, redactSecrets } from '../src/core/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes one JSON object per line with level and message', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream });
    log.info('hello', { n: 1 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['level']).toBe('info');
    expect(entry['msg']).toBe('hello');
    expect(entry['n']).toBe(1);
    expect(typeof entry['time']).toBe('string');
  });

  it('drops messages below the configured level', () => {
    const { lines, stream } = capture();
    const log = createLogger({ level: 'warn', stream });
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('redacts secret keys in nested objects', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream });
    log.info('login attempt', {
      user: 'u1',
      auth: { botToken: 'super-secret-value', retries: 2 },
      headers: { authorization: 'Bearer abc' },
    });
    const raw = lines.join('\n');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).not.toContain('Bearer abc');
    expect(raw).toContain('[redacted]');
    expect(raw).toContain('u1');
  });

  it('masks registered secret values inside plain strings', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream, knownSecrets: ['sk-live-12345678'] });
    log.info('using key sk-live-12345678 for the request');
    expect(lines.join('\n')).not.toContain('sk-live-12345678');
  });

  it('child loggers inherit bound fields', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream }).child({ component: 'bot' }).child({ chat: 7 });
    log.info('hi');
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['component']).toBe('bot');
    expect(entry['chat']).toBe(7);
  });
});

describe('redactSecrets', () => {
  it('handles circular structures without throwing', () => {
    const obj: Record<string, unknown> = { token: 'x' };
    obj['self'] = obj;
    expect(() => redactSecrets(obj)).not.toThrow();
  });

  it('leaves non-secret data untouched', () => {
    const out = redactSecrets({ a: 1, b: ['x', 'y'] }) as Record<string, unknown>;
    expect(out).toEqual({ a: 1, b: ['x', 'y'] });
  });
});

describe('log spoofing', () => {
  it('does not let fields overwrite the fixed time/level/msg keys', () => {
    const { lines, stream } = capture();
    const log = createLogger({ stream });
    log.info('real message', { msg: 'spoofed', time: 'spoofed', level: 'spoofed' });
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['msg']).toBe('real message');
    expect(entry['level']).toBe('info');
    expect(entry['time']).not.toBe('spoofed');
  });
});
