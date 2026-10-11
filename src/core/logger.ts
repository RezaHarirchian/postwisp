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

import type { LogLevel } from './config.js';
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

// Key names are matched case-insensitively; anything containing one of these
// fragments is treated as a secret. Conservative on purpose: over-redacting a
// debug field is harmless, leaking a token is not.
const SECRET_KEY_FRAGMENTS = [
  'token',
  'secret',
  'apikey',
  'api_key',
  'api-key',
  'password',
  'passwd',
  'authorization',
  'privatekey',
  'private_key',
  'cookie',
  'session',
];

const REDACTED = '[redacted]';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_FRAGMENTS.some((frag) => lower.includes(frag));
}

function maskKnownSecrets(text: string, known: string[]): string {
  let out = text;
  for (const secret of known) {
    if (secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

// Deep-walks any value and masks secrets by key name and by known value.
// Handles cycles by tracking visited objects.
export function redactSecrets(value: unknown, knownSecrets: string[] = []): unknown {
  const seen = new WeakSet<object>();

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return maskKnownSecrets(node, knownSecrets);
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return '[circular]';
    seen.add(node);

    if (Array.isArray(node)) return node.map(walk);

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node)) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
      } else if (typeof val === 'string') {
        out[key] = maskKnownSecrets(val, knownSecrets);
      } else {
        out[key] = walk(val);
      }
    }
    return out;
  };

  return walk(value);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

interface LoggerOptions {
  level?: LogLevel;
  stream?: NodeJS.WritableStream;
  // Optional file every entry is appended to as well (JSON lines, owner-only
  // permissions). Wired from config.logFile by the server entrypoint;
  // `postwisp logs` reads this path back.
  filePath?: string;
  knownSecrets?: string[];
  bound?: Record<string, unknown>[];
}

// One JSON object per line on the given stream. JSON keeps logs greppable
// and lets operators ship them anywhere without a custom parser.
export function createLogger(options: LoggerOptions = {}): Logger {
  const stream = options.stream ?? process.stdout;
  const level: LogLevel = options.level ?? 'info';
  const knownSecrets = [...(options.knownSecrets ?? [])];
  const bound = options.bound ?? [];
  const filePath = options.filePath;

  if (filePath) {
    // Logs can carry redacted-but-sensitive context; keep the file
    // owner-only from the first byte.
    mkdirSync(dirname(filePath), { recursive: true });
    const fd = openSync(filePath, 'a', 0o600);
    closeSync(fd);
    chmodSync(filePath, 0o600);
  }

  const write = (entryLevel: LogLevel, message: string, fields: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const merged: Record<string, unknown> = {};
    for (const scope of bound) Object.assign(merged, scope);
    Object.assign(merged, fields);
    // Fixed keys go last: a field named `msg` or `time` must never spoof them.
    const entry = {
      ...(redactSecrets(merged, knownSecrets) as Record<string, unknown>),
      time: new Date().toISOString(),
      level: entryLevel,
      msg: maskKnownSecrets(message, knownSecrets),
    };
    const line = JSON.stringify(entry) + '\n';
    stream.write(line);
    if (filePath) {
      // Best effort: logging must never crash the app it instruments.
      try {
        appendFileSync(filePath, line, { mode: 0o600 });
      } catch {
        // Dropped; the stream copy above still went out.
      }
    }
  };

  return {
    debug: (message, fields = {}) => write('debug', message, fields),
    info: (message, fields = {}) => write('info', message, fields),
    warn: (message, fields = {}) => write('warn', message, fields),
    error: (message, fields = {}) => write('error', message, fields),
    child: (fields) =>
      createLogger({
        level,
        stream,
        knownSecrets,
        bound: [...bound, fields],
        ...(filePath !== undefined ? { filePath } : {}),
      }),
  };
}
