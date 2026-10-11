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

// Button-driven compliance screens: the suppression list, the consent
// audit log, and the data wipe (GDPR Art. 17). The coordinator routes
// `sup:` / `data:` callbacks here; everything is owner-only by the time it
// arrives (the owner guard runs first).

import { createHash } from 'node:crypto';
import { InlineKeyboard, type Context } from 'grammy';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';
import { cb, escapeHtml, formatDateUtc } from './views.js';

export interface ComplianceDeps {
  store: Store;
  // Wipes every user-data row (and truncates the log file); provided by the
  // coordinator, which owns the store and the log path.
  wipeData: () => void;
  // Back button target; lives in bot/index.ts to avoid an import cycle.
  backToSettings: (ctx: Context) => Promise<void>;
}

const LIST_LIMIT = 20;
// Clear-all operates on a wider scope than the list display; the confirm
// screen must count the same scope it is about to clear.
const CLEAR_LIMIT = 1000;

// 'sup:rm:' leaves 57 bytes for the address under Telegram's 64-byte cap.
const RM_PREFIX = 'sup:rm:';
const RM_HASH_PREFIX = 'sup:rmh:';

// The address itself is the stable identifier: it resolves deterministically
// at tap time, so a list that changed since render cannot unsuppress the
// wrong entry (a positional index could). Addresses that do not fit the
// 64-byte callback cap ride as a short hash and are resolved by scanning
// the list for the same hash.
function removalCallback(email: string): string {
  const direct = `${RM_PREFIX}${email}`;
  if (Buffer.byteLength(direct, 'utf8') <= 64) return cb(direct);
  return cb(`${RM_HASH_PREFIX}${shortAddrHash(email)}`);
}

function shortAddrHash(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 12);
}

function resolveRemovalTarget(store: Store, data: string): string | null {
  if (data.startsWith(RM_HASH_PREFIX)) {
    const hash = data.slice(RM_HASH_PREFIX.length);
    const row = store
      .listSuppressed(CLEAR_LIMIT)
      .find((r) => shortAddrHash(r.email) === hash);
    return row?.email ?? null;
  }
  const email = data.slice(RM_PREFIX.length);
  // A tap for an address that already left the list is a no-op, not a
  // consent-log entry.
  return store.isSuppressed(email) ? email : null;
}

// The settings screen's entry points; rendered next to the settings text.
export function settingsComplianceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('bot.settings.suppression'), 'sup:list')
    .text(t('bot.settings.data'), 'data:home');
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(t('bot.compose.back'), 'set:home');
}

async function showSuppressionList(ctx: Context, deps: ComplianceDeps): Promise<void> {
  const rows = deps.store.listSuppressed(LIST_LIMIT);
  if (rows.length === 0) {
    await ctx.reply(t('bot.suppression.empty'), {
      reply_markup: backKeyboard(),
      protect_content: true,
    });
    return;
  }
  const kb = new InlineKeyboard();
  rows.forEach((row) => {
    kb.text(`${t('bot.suppression.remove')} ${row.email}`, removalCallback(row.email)).row();
  });
  kb.text(t('bot.suppression.clear'), 'sup:clear').row();
  kb.text(t('bot.compose.back'), 'set:home');
  const lines = [`<b>${escapeHtml(t('bot.suppression.title'))}</b>`, ''];
  for (const row of rows) {
    lines.push(
      t('bot.suppression.item', {
        email: escapeHtml(row.email),
        reason: escapeHtml(row.reason),
        date: formatDateUtc(row.createdAt),
      }),
    );
    lines.push('');
  }
  await ctx.reply(lines.join('\n').trimEnd(), {
    parse_mode: 'HTML',
    reply_markup: kb,
    protect_content: true,
  });
}

async function showDataHome(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text(t('bot.data.auditLog'), 'data:audit')
    .text(t('bot.data.wipe'), 'data:wipe')
    .row()
    .text(t('bot.compose.back'), 'set:home');
  const text = `<b>${escapeHtml(t('bot.data.title'))}</b>\n\n${escapeHtml(t('bot.data.body'))}`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, protect_content: true });
}

async function showAuditLog(ctx: Context, deps: ComplianceDeps): Promise<void> {
  const rows = deps.store.listConsentLog(LIST_LIMIT);
  const kb = new InlineKeyboard().text(t('bot.compose.back'), 'data:home');
  if (rows.length === 0) {
    await ctx.reply(t('bot.audit.empty'), { reply_markup: kb, protect_content: true });
    return;
  }
  const lines = [`<b>${escapeHtml(t('bot.audit.title'))}</b>`, ''];
  for (const row of rows) {
    lines.push(
      t('bot.audit.item', {
        date: formatDateUtc(row.ts),
        event: escapeHtml(row.event),
        address: escapeHtml(row.address),
        detail: escapeHtml(row.detail),
      }),
    );
  }
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: kb,
    protect_content: true,
  });
}

async function showWipeConfirm(ctx: Context): Promise<void> {
  const kb = new InlineKeyboard()
    .text(t('bot.data.wipeYes'), 'data:wipe:yes')
    .row()
    .text(t('bot.compose.cancel'), 'data:home');
  const text =
    `<b>${escapeHtml(t('bot.data.wipe'))}</b>\n\n${escapeHtml(t('bot.data.wipeConfirm'))}`;
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb, protect_content: true });
}

// Returns true when the callback was consumed.
export async function handleComplianceCallback(
  ctx: Context,
  deps: ComplianceDeps,
  data: string,
): Promise<boolean> {
  if (data === 'set:home') {
    await deps.backToSettings(ctx);
    return true;
  }
  if (data === 'sup:list') {
    await showSuppressionList(ctx, deps);
    return true;
  }
  if (data.startsWith(RM_PREFIX) || data.startsWith(RM_HASH_PREFIX)) {
    const email = resolveRemovalTarget(deps.store, data);
    if (email) {
      deps.store.unsuppressAddress(email);
      deps.store.logConsent('unsuppress', email, 'owner override from suppression list');
      await ctx.reply(t('bot.suppression.removed', { email }), {
        protect_content: true,
      });
    }
    await showSuppressionList(ctx, deps);
    return true;
  }
  if (data === 'sup:clear') {
    const count = deps.store.listSuppressed(CLEAR_LIMIT).length;
    const kb = new InlineKeyboard()
      .text(t('bot.suppression.confirmYes'), 'sup:clear:yes')
      .row()
      .text(t('bot.compose.cancel'), 'sup:list');
    await ctx.reply(t('bot.suppression.clearConfirm', { count }), {
      reply_markup: kb,
      protect_content: true,
    });
    return true;
  }
  if (data === 'sup:clear:yes') {
    for (const row of deps.store.listSuppressed(CLEAR_LIMIT)) {
      deps.store.unsuppressAddress(row.email);
      deps.store.logConsent('unsuppress', row.email, 'owner cleared the suppression list');
    }
    await ctx.reply(t('bot.suppression.cleared'), { protect_content: true });
    await showSuppressionList(ctx, deps);
    return true;
  }
  if (data === 'data:home') {
    await showDataHome(ctx);
    return true;
  }
  if (data === 'data:audit') {
    await showAuditLog(ctx, deps);
    return true;
  }
  if (data === 'data:wipe') {
    await showWipeConfirm(ctx);
    return true;
  }
  if (data === 'data:wipe:yes') {
    deps.wipeData();
    await ctx.reply(t('bot.data.wiped'), { protect_content: true });
    await deps.backToSettings(ctx);
    return true;
  }
  return false;
}
