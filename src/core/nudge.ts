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

// Follow-up nudges (P8, opt-in): finds sent emails old enough to expect a
// reply that never came. Pure domain logic over the store; the caller owns
// the notification and the auto-snooze bookkeeping.

import type { SentLog, Store } from './store.js';

export interface NudgeCandidate {
  sentId: number;
  to: string;
  subject: string;
  sentAtMs: number;
}

const DAY_MS = 86400_000;
// Terminal delivery states: nudging a bounced or failed send is pointless.
const FINAL_STATUSES = new Set(['bounced', 'failed', 'complained']);

// The sent log carries no thread id, so a reply is inbound mail from the
// same recipient, received after the send, whose subject answers the sent
// subject (leading Re: prefixes stripped, then an exact match).
function isReplySubject(sentSubject: string, inboundSubject: string): boolean {
  const strip = (s: string): string => s.trim().toLowerCase().replace(/^(re:\s*)+/, '');
  const sent = strip(sentSubject);
  return sent.length > 0 && strip(inboundSubject) === sent;
}

function hasReply(store: Store, sent: SentLog): boolean {
  const recipients = sent.to
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  for (const rcpt of recipients) {
    // searchEmails matches substrings on from/name; tighten to the exact
    // address so a similarly-named sender cannot cancel a nudge.
    const inbound = store.searchEmails({ from: rcpt }, { limit: 200, includeArchived: true });
    for (const mail of inbound) {
      if (mail.fromAddr.trim().toLowerCase() !== rcpt) continue;
      if (mail.receivedAt <= sent.sentAtMs) continue;
      if (isReplySubject(sent.subject, mail.subject)) return true;
    }
  }
  return false;
}

export function findNudgeCandidates(
  store: Store,
  nowMs: number,
  days: number,
): NudgeCandidate[] {
  const saneDays = Math.max(1, Math.floor(days));
  const cutoff = nowMs - saneDays * DAY_MS;
  const out: NudgeCandidate[] = [];
  for (const sent of store.listSentLog({ limit: 500 })) {
    if (sent.sentAtMs > cutoff) continue;
    if (FINAL_STATUSES.has(sent.status)) continue;
    const state = store.getNudgeState(sent.id);
    if (state?.dismissed) continue;
    if (state?.snoozedUntilMs != null && state.snoozedUntilMs > nowMs) continue;
    if (sent.to.trim().length === 0) continue;
    if (hasReply(store, sent)) continue;
    out.push({ sentId: sent.id, to: sent.to, subject: sent.subject, sentAtMs: sent.sentAtMs });
  }
  return out;
}
