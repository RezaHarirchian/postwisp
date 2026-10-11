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

import { InlineKeyboard } from 'grammy';
import { t } from '../core/i18n.js';
import { cb, escapeHtml, senderLabel } from './views.js';
import { truncatePoints } from './notify.js';

// Minimal key-value seam. The coordinator wires the real store at merge time;
// digest state is one JSON list plus three settings keys.
export interface DigestKv {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export const DIGEST_QUEUE_KEY = 'digest:queue';
export const QUIET_START_KEY = 'quiet_start';
export const QUIET_END_KEY = 'quiet_end';
export const DIGEST_MODE_KEY = 'digest_mode'; // 'off' | 'hourly' | 'daily'

function toMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

// Quiet hours suppress instant notifications; new mail accumulates into the
// digest instead. Overnight ranges (e.g. 22:00–07:00) wrap past midnight.
export function isQuietNow(now: Date, startHHMM: string, endHHMM: string): boolean {
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  if (start === null || end === null || start === end) return false;
  const at = now.getHours() * 60 + now.getMinutes();
  if (start < end) return at >= start && at < end;
  return at >= start || at < end;
}

export interface DigestEmail {
  id: string;
  fromAddr: string;
  fromName?: string;
  subject: string;
}

// Telegram's per-message limit. The scheduler drains the whole queue at
// once, so a busy night must fan out into several messages — one oversized
// message would fail to send and the digest would be lost entirely.
const DIGEST_MAX = 4096;
const DIGEST_MARGIN = 64;

export interface DigestMessage {
  text: string;
  replyMarkup: InlineKeyboard;
  // The digest carries email subjects and senders: keep it off screenshots
  // and forwards like every other content-bearing message.
  protectContent: true;
}

// Chunked digest: greedy-packs emails so every message fits the limit.
// Each chunk keeps its own Open buttons for its emails. Callers drain the
// queue and enqueue every returned message in order.
export function buildDigestMessages(emails: DigestEmail[]): DigestMessage[] {
  const items = emails.map((email) => ({
    email,
    text: t('bot.digest.item', {
      from: escapeHtml(truncatePoints(senderLabel(email), 160)),
      subject: escapeHtml(truncatePoints(email.subject, 320)),
    }),
  }));
  const titleLen = t('bot.digest.title', { count: emails.length }).length;
  const chunks: Array<typeof items> = [[]];
  const lens: number[] = [titleLen];
  for (const item of items) {
    const cur = chunks[chunks.length - 1]!;
    // +1 for the blank line after each item.
    if (cur.length > 0 && lens[lens.length - 1]! + item.text.length + 1 > DIGEST_MAX - DIGEST_MARGIN) {
      chunks.push([]);
      lens.push(titleLen);
    }
    chunks[chunks.length - 1]!.push(item);
    lens[lens.length - 1] = lens[lens.length - 1]! + item.text.length + 1;
  }
  return chunks.map((group, i) => {
    const page = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
    const lines = [`${t('bot.digest.title', { count: emails.length })}${page}`, ''];
    const kb = new InlineKeyboard();
    for (const item of group) {
      lines.push(item.text);
      lines.push('');
      kb.text(t('bot.digest.open'), cb(`e:${item.email.id}`)).row();
    }
    return {
      text: lines.join('\n').trimEnd(),
      replyMarkup: kb,
      protectContent: true as const,
    };
  });
}

// During quiet hours or in digest mode, new mail ids accumulate here instead
// of notifying instantly. takeDigestQueue drains the list atomically for the
// caller; the store is synchronous, so read-then-clear cannot interleave.
export function queueDigest(kv: DigestKv, emailId: string): void {
  const queued = takeDigestQueue(kv, false);
  if (!queued.includes(emailId)) queued.push(emailId);
  kv.set(DIGEST_QUEUE_KEY, JSON.stringify(queued));
}

export function takeDigestQueue(kv: DigestKv, clear = true): string[] {
  const raw = kv.get(DIGEST_QUEUE_KEY);
  let ids: string[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      ids = [];
    }
  }
  if (clear) kv.set(DIGEST_QUEUE_KEY, JSON.stringify([]));
  return ids;
}

export interface DigestSchedulerOptions {
  mode: 'hourly' | 'daily';
  // For 'daily': the local hour (0–23) at which the digest fires.
  hour: number;
  onFire: () => void | Promise<void>;
}

// Fires onFire once per hour, or once a day at the given hour. The callback
// owns the actual send (drain the queue, build the digest, notify).
export function startDigestScheduler(options: DigestSchedulerOptions): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  // The hour comes from a kv string parsed with Number(): a corrupt value
  // is NaN, which would schedule nonsense. Fall back to 08:00.
  const hour = Number.isFinite(options.hour) ? options.hour : 8;
  // setHours silently rolls over out-of-range values (25 becomes 01:00 next
  // day), so clamp the range explicitly.
  const safeHour = hour >= 0 && hour <= 23 ? Math.floor(hour) : 8;

  const fire = (): void => {
    if (!stopped) void options.onFire();
  };

  if (options.mode === 'hourly') {
    timer = setInterval(fire, 60 * 60 * 1000);
  } else {
    const scheduleNext = (): void => {
      if (stopped) return;
      const now = new Date();
      const next = new Date(now);
      next.setHours(safeHour, 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      timer = setTimeout(() => {
        fire();
        scheduleNext();
      }, next.getTime() - now.getTime());
    };
    scheduleNext();
  }

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        clearInterval(timer as ReturnType<typeof setInterval>);
      }
    },
  };
}
