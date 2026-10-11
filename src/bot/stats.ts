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

import type { Context } from 'grammy';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';
import { escapeHtml, truncate } from './views.js';

// Resend's reputation thresholds: a domain that crosses them lands on
// blocklists, so the dashboard flags them as warnings instead of hiding
// them in a percentage column.
const BOUNCE_WARN_RATE = 4;
const COMPLAINT_WARN_RATE = 0.08;

interface DomainAgg {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
}

// Per-domain delivery table from the sent log: counts plus bounce and
// complaint rates against Resend's warning thresholds. All strings go
// through t(); all dynamic values are HTML-escaped.
export function buildStatsView(store: Store): { text: string } {
  const rows = store.listSentLog({ limit: 500 });
  if (rows.length === 0) {
    return { text: `<b>${t('bot.stats.title')}</b>\n\n${t('bot.stats.empty')}` };
  }

  const domains = new Map<string, DomainAgg>();
  for (const row of rows) {
    const domain = row.domain.trim() === '' ? '?' : row.domain;
    let agg = domains.get(domain);
    if (!agg) {
      agg = { sent: 0, delivered: 0, bounced: 0, complained: 0 };
      domains.set(domain, agg);
    }
    agg.sent += 1;
    if (row.status === 'delivered') agg.delivered += 1;
    else if (row.status === 'bounced') agg.bounced += 1;
    else if (row.status === 'complained') agg.complained += 1;
  }

  const lines = [`<b>${t('bot.stats.title')}</b>`, ''];
  for (const [domain, agg] of domains) {
    lines.push(`<b>${escapeHtml(domain)}</b>`);
    lines.push(
      t('bot.stats.counts', {
        sent: agg.sent,
        delivered: agg.delivered,
        bounced: agg.bounced,
        complained: agg.complained,
      }),
    );
    const bounceRate = (agg.bounced / agg.sent) * 100;
    const complaintRate = (agg.complained / agg.sent) * 100;
    lines.push(
      t('bot.stats.rates', {
        bounceRate: bounceRate.toFixed(2),
        complaintRate: complaintRate.toFixed(2),
      }),
    );
    if (bounceRate >= BOUNCE_WARN_RATE) {
      lines.push(t('bot.stats.bounceWarn', { rate: bounceRate.toFixed(2) }));
    }
    if (complaintRate >= COMPLAINT_WARN_RATE) {
      lines.push(t('bot.stats.complaintWarn', { rate: complaintRate.toFixed(2) }));
    }
    lines.push('');
  }
  return { text: truncate(lines.join('\n').trimEnd(), 4000) };
}

// The coordinator wires this to the Stats menu button; it replaces the
// current echo that only replies with the title.
export async function handleStatsMenu(ctx: Context, deps: { store: Store }): Promise<void> {
  const view = buildStatsView(deps.store);
  await ctx.reply(view.text, { parse_mode: 'HTML', protect_content: true });
}
