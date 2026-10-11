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

// Extra provider API keys beyond the one in the server config. The compose
// wizard's identity picker offers them per send; the coordinator builds one
// adapter per key. Key values are write-only here: they are stored and
// deleted, never displayed. The coordinator routes `key:` callbacks here;
// everything is owner-only by the time it arrives (the owner guard runs
// first).

import { InlineKeyboard, type Context } from 'grammy';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';
import { escapeHtml } from './views.js';

export interface ProviderKeyDeps {
  store: Store;
  // Keys belong to the active provider; the picker only offers its own.
  providerName: string;
  backToSettings: (ctx: Context) => Promise<void>;
}

// Chats waiting to type a key label, then the key value itself.
const pendingLabel = new Map<number, true>();
const pendingKey = new Map<number, string>();

export function clearProviderKeyState(chatId: number): void {
  pendingLabel.delete(chatId);
  pendingKey.delete(chatId);
}

async function showHome(ctx: Context, deps: ProviderKeyDeps): Promise<void> {
  const keys = deps.store.listProviderKeys(deps.providerName);
  const kb = new InlineKeyboard();
  for (const k of keys) {
    kb.text(`${k.label} — ${t('bot.keys.remove')}`, `key:rm:${k.id}`).row();
  }
  kb.text(t('bot.keys.add'), 'key:add').row();
  kb.text(t('bot.compose.back'), 'key:home-back');
  const text =
    keys.length === 0
      ? t('bot.keys.empty')
      : `${t('bot.keys.title')}\n\n${keys
          .map((k) => `${escapeHtml(k.label)} (${escapeHtml(k.provider)})`)
          .join('\n')}`;
  await ctx.reply(text, {
    parse_mode: 'HTML',
    reply_markup: kb,
    protect_content: true,
  });
}

export async function handleProviderKeyCallback(
  ctx: Context,
  deps: ProviderKeyDeps,
  data: string,
): Promise<boolean> {
  if (!data.startsWith('key:')) return false;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  const [head, arg] = data.slice(4).split(':');
  switch (head) {
    case 'home':
      clearProviderKeyState(chatId);
      await showHome(ctx, deps);
      return true;
    case 'home-back':
      clearProviderKeyState(chatId);
      await deps.backToSettings(ctx);
      return true;
    case 'add':
      pendingLabel.set(chatId, true);
      // A previous half-finished add must not leak into this one.
      pendingKey.delete(chatId);
      await ctx.reply(t('bot.keys.promptLabel'), { reply_markup: { force_reply: true } });
      return true;
    case 'rm': {
      const id = Number(arg);
      if (!Number.isInteger(id)) {
        await showHome(ctx, deps);
        return true;
      }
      const row = deps.store.listProviderKeys(deps.providerName).find((k) => k.id === id);
      deps.store.deleteProviderKey(id);
      if (row) await ctx.reply(t('bot.keys.removed', { label: row.label }));
      await showHome(ctx, deps);
      return true;
    }
    default:
      return false;
  }
}

// Consumes the ForceReply answers for the add-key flow: label first, then
// the key value. The key itself is never echoed back anywhere.
export async function handleProviderKeyText(ctx: Context, deps: ProviderKeyDeps): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  const text = ctx.message?.text;
  if (typeof text !== 'string') return false;
  if (pendingLabel.has(chatId)) {
    const label = text.trim();
    if (label.length === 0) {
      await ctx.reply(t('bot.keys.badLabel'), { reply_markup: { force_reply: true } });
      return true;
    }
    pendingLabel.delete(chatId);
    pendingKey.set(chatId, label);
    await ctx.reply(t('bot.keys.promptKey', { label }), {
      reply_markup: { force_reply: true },
    });
    return true;
  }
  const label = pendingKey.get(chatId);
  if (label === undefined) return false;
  const apiKey = text.trim();
  if (apiKey.length === 0) {
    await ctx.reply(t('bot.keys.badKey'), { reply_markup: { force_reply: true } });
    return true;
  }
  pendingKey.delete(chatId);
  deps.store.addProviderKey({ provider: deps.providerName, label, apiKey });
  await ctx.reply(t('bot.keys.saved', { label }));
  await showHome(ctx, deps);
  return true;
}
