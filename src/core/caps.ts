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

import type { Store } from './store.js';

// Send quotas guard the domain's reputation: a suppressed address never
// receives mail, and the daily caps stop a runaway bot or a compromised
// schedule from burning the domain. Counters live in the plain kv store so
// the schema stays untouched; keys roll over naturally with the UTC date.
const DAILY_SEND_LIMIT = 100;
const PER_RECIPIENT_DAILY_LIMIT = 5;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function dailySendKey(day: string): string {
  return `send_count_${day}`;
}

function perRecipientKey(addr: string, day: string): string {
  return `sent_to_${addr.trim().toLowerCase()}_${day}`;
}

// Counters live in the plain kv store, where a corrupt value is one bad
// write away. NaN fails every >= comparison, which would silently bypass
// the caps; treat a non-finite counter as 0 and repair it on the spot.
function readCounter(store: Store, key: string): number {
  const n = Number(store.get(key) ?? '0');
  if (!Number.isFinite(n)) {
    store.set(key, '0');
    return 0;
  }
  return n;
}

// Reasons are short English strings on purpose: the bot layer maps them to
// user-facing text via t(), so this module stays UI-free.
export function checkSendCaps(
  store: Store,
  to: string[],
): { ok: true } | { ok: false; reason: string } {
  for (const addr of to) {
    if (store.isSuppressed(addr)) {
      return { ok: false, reason: `recipient ${addr.trim()} is suppressed` };
    }
  }

  const day = todayUtc();
  const sentToday = readCounter(store, dailySendKey(day));
  if (sentToday >= DAILY_SEND_LIMIT) {
    return { ok: false, reason: `daily send limit reached (${DAILY_SEND_LIMIT}/day)` };
  }

  for (const addr of to) {
    const toRecipient = readCounter(store, perRecipientKey(addr, day));
    if (toRecipient >= PER_RECIPIENT_DAILY_LIMIT) {
      return {
        ok: false,
        reason: `per-recipient daily limit reached for ${addr.trim()} (${PER_RECIPIENT_DAILY_LIMIT}/day)`,
      };
    }
  }

  return { ok: true };
}

// Call after a send succeeds. The daily counter counts send calls (one
// Resend send is one API call even with several recipients); the
// per-recipient counter counts deliveries per address.
export function recordSent(store: Store, to: string[]): void {
  const day = todayUtc();
  const key = dailySendKey(day);
  store.set(key, String(readCounter(store, key) + 1));
  for (const addr of to) {
    const recipientKey = perRecipientKey(addr, day);
    store.set(recipientKey, String(readCounter(store, recipientKey) + 1));
  }
}
