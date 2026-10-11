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

// One-tap unsubscribe from the email view's Unsubscribe button. The button
// only renders when the List-Unsubscribe header was detected (see views.ts):
// mailto: targets show the address for a manual send, https: targets POST
// the RFC 8058 one-click body when the sender advertises it, and otherwise
// the owner gets the link to open in a browser.

import type { Context } from 'grammy';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';
import { findListUnsubscribe, mailtoAddress } from '../core/list-unsubscribe.js';
import { escapeHtml } from './views.js';

export interface UnsubActionDeps {
  store: Store;
  logger: Logger;
  // Test seam: the default is the global fetch.
  postUnsubscribe?: (url: string) => Promise<{ ok: boolean; status: number }>;
}

async function defaultPostUnsubscribe(url: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    signal: AbortSignal.timeout(15_000),
  });
  return { ok: res.ok, status: res.status };
}

export async function handleUnsubscribeAction(
  ctx: Context,
  deps: UnsubActionDeps,
  emailId: string,
): Promise<void> {
  const meta = deps.store.getEmailMeta(emailId);
  if (!meta) {
    await ctx.reply(t('bot.email.notFound'));
    return;
  }
  const target = findListUnsubscribe(meta.headers ?? {});
  if (!target) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  if (target.kind === 'mailto') {
    const address = mailtoAddress(target.url);
    if (!address) {
      await ctx.reply(t('bot.error.generic'));
      return;
    }
    // The <code> span is one-tap copyable in Telegram clients.
    await ctx.reply(t('bot.unsub.mailto', { address: `<code>${escapeHtml(address)}</code>` }), {
      parse_mode: 'HTML',
      protect_content: true,
    });
    return;
  }
  if (!target.oneClick) {
    // Telegram clients linkify a bare URL, so plain text is enough.
    await ctx.reply(t('bot.unsub.openLink', { url: target.url }), { protect_content: true });
    return;
  }
  const post = deps.postUnsubscribe ?? defaultPostUnsubscribe;
  let result: { ok: boolean; status: number };
  try {
    result = await post(target.url);
  } catch (err) {
    deps.logger.warn('one-click unsubscribe POST failed', {
      emailId,
      detail: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(t('bot.unsub.failed', { reason: err instanceof Error ? err.message : String(err) }));
    return;
  }
  if (!result.ok) {
    deps.logger.warn('one-click unsubscribe rejected', { emailId, status: result.status });
    await ctx.reply(t('bot.unsub.failed', { reason: `HTTP ${result.status}` }));
    return;
  }
  // The subscribed address is the owner's own receiving address (the To of
  // this mail): log the consent event, but do not suppress it — the owner
  // may still want to send to themselves.
  const subscribed = (meta.to ?? [])[0];
  if (subscribed) deps.store.logConsent('unsubscribe', subscribed, 'list-unsubscribe one-click');
  await ctx.reply(t('bot.unsub.done'));
}
