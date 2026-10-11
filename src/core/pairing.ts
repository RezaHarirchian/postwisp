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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from './store.js';
import { redactSecrets, type Logger } from './logger.js';

// One-time token for Telegram pairing: `postwisp pair` mints it, the bot
// consumes it when the owner taps the t.me deep link. Lives here (not in
// the CLI) so the bot layer does not import from the CLI layer.
export const PAIRING_TOKEN_KEY = 'pairing_token';
export const PAIRING_TOKEN_EXPIRES_KEY = 'pairing_token_expires';
// 15 minutes: long enough to open Telegram and tap Start, short enough
// that a leaked link turns useless quickly.
export const PAIRING_TOKEN_TTL_MS = 15 * 60 * 1000;

export type KvStore = Pick<Store, 'get' | 'set'>;

// 64 hex chars: 32 bytes of entropy, and exactly Telegram's 64-byte limit
// for /start payloads.
export function generatePairingToken(): string {
  return randomBytes(32).toString('hex');
}

export function pairingLink(username: string, token: string): string {
  return `https://t.me/${username}?start=${token}`;
}

export function storePairingToken(store: KvStore, token: string, nowMs: number): void {
  store.set(PAIRING_TOKEN_KEY, token);
  store.set(PAIRING_TOKEN_EXPIRES_KEY, String(nowMs + PAIRING_TOKEN_TTL_MS));
}

export interface PairingToken {
  token: string;
  expiresAtMs: number;
}

export function readPairingToken(store: KvStore): PairingToken | null {
  const token = store.get(PAIRING_TOKEN_KEY);
  if (!token) return null;
  const expiresAtMs = Number(store.get(PAIRING_TOKEN_EXPIRES_KEY));
  if (!Number.isFinite(expiresAtMs)) return null;
  return { token, expiresAtMs };
}

export function clearPairingToken(store: KvStore): void {
  // The kv table has no delete; an empty token reads back as absent.
  store.set(PAIRING_TOKEN_KEY, '');
  store.set(PAIRING_TOKEN_EXPIRES_KEY, '0');
}

// The pairing token is minted at runtime (`postwisp pair`) and rotated, so
// it cannot be baked into the logger's knownSecrets at startup. Wrap the
// logger instead: every line emitted on the pairing path has the
// currently-stored token value redacted. The lookup is lazy per log call,
// so a rotation (`pair --rotate`) takes effect immediately.
export function withPairingTokenRedaction(logger: Logger, store: KvStore | undefined): Logger {
  if (!store) return logger;
  const wrap =
    (fn: (message: string, fields?: Record<string, unknown>) => void) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      const token = store.get(PAIRING_TOKEN_KEY);
      if (!token) {
        fn(message, fields);
        return;
      }
      fn(
        redactSecrets(message, [token]) as string,
        redactSecrets(fields, [token]) as Record<string, unknown>,
      );
    };
  return {
    debug: wrap((m, f) => logger.debug(m, f)),
    info: wrap((m, f) => logger.info(m, f)),
    warn: wrap((m, f) => logger.warn(m, f)),
    error: wrap((m, f) => logger.error(m, f)),
    child: (fields) => withPairingTokenRedaction(logger.child(fields), store),
  };
}

// Constant-time compare: the token is a Bearer <redacted> while valid.
export function pairingTokenMatches(
  stored: PairingToken | null,
  presented: string,
  nowMs: number,
): boolean {
  if (!stored || nowMs >= stored.expiresAtMs) return false;
  const expected = Buffer.from(stored.token, 'utf8');
  const actual = Buffer.from(presented, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
