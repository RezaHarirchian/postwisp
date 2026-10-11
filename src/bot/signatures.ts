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

// Per-identity signatures: one signature per sending identity, appended to
// composed mail in compose.ts's deliver(). The coordinator routes `sig:`
// callbacks here; everything is owner-only by the time it arrives (the
// owner guard runs first).

import { InlineKeyboard, type Context } from 'grammy';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';
import { listIdentities } from '../core/templates.js';

export interface SignatureDeps {
  store: Store;
  domains: string[];
  backToSettings: (ctx: Context) => Promise<void>;
}

// Signatures over this length are a formatting accident, not a signature.
const MAX_SIGNATURE_LENGTH = 2000;

// Chats waiting to type a signature after tapping Set signature.
const pendingSignature = new Map<number, string>();

export function clearSignatureState(chatId: number): void {
  pendingSignature.delete(chatId);
}

function identities(deps: SignatureDeps): string[] {
  return listIdentities(deps.store, deps.domains);
}

async function showHome(ctx: Context, deps: SignatureDeps): Promise<void> {
  const kb = new InlineKeyboard();
  identities(deps).forEach((id, i) => {
    kb.text(id, `sig:pick:${i}`).row();
  });
  kb.text(t('bot.compose.back'), 'sig:home-back');
  await ctx.reply(`${t('bot.sig.title')}\n${t('bot.sig.chooseIdentity')}`, { reply_markup: kb });
}

async function showIdentity(ctx: Context, deps: SignatureDeps, index: number): Promise<void> {
  const id = identities(deps)[index];
  if (id === undefined) {
    await showHome(ctx, deps);
    return;
  }
  const current = deps.store.getSignature(id);
  const text =
    current === null
      ? t('bot.sig.none', { identity: id })
      : t('bot.sig.current', { identity: id, signature: current });
  const kb = new InlineKeyboard()
    .text(t('bot.sig.set'), `sig:set:${index}`)
    .text(t('bot.sig.clear'), `sig:clr:${index}`)
    .row()
    .text(t('bot.compose.back'), 'sig:home');
  await ctx.reply(text, { reply_markup: kb, protect_content: true });
}

export async function handleSignatureCallback(
  ctx: Context,
  deps: SignatureDeps,
  data: string,
): Promise<boolean> {
  if (!data.startsWith('sig:')) return false;
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  const [head, arg] = data.slice(4).split(':');
  switch (head) {
    case 'home':
      pendingSignature.delete(chatId);
      await showHome(ctx, deps);
      return true;
    case 'home-back':
      pendingSignature.delete(chatId);
      await deps.backToSettings(ctx);
      return true;
    case 'pick':
      await showIdentity(ctx, deps, Number(arg));
      return true;
    case 'set': {
      const id = identities(deps)[Number(arg)];
      if (id === undefined) {
        await showHome(ctx, deps);
        return true;
      }
      pendingSignature.set(chatId, id);
      await ctx.reply(t('bot.sig.prompt', { identity: id }), {
        reply_markup: { force_reply: true },
      });
      return true;
    }
    case 'clr': {
      const id = identities(deps)[Number(arg)];
      if (id !== undefined) {
        deps.store.deleteSignature(id);
        await ctx.reply(t('bot.sig.cleared', { identity: id }));
      }
      await showIdentity(ctx, deps, Number(arg));
      return true;
    }
    default:
      return false;
  }
}

// Consumes the ForceReply answer for a pending signature prompt.
export async function handleSignatureText(ctx: Context, deps: SignatureDeps): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return false;
  const identity = pendingSignature.get(chatId);
  if (identity === undefined) return false;
  const text = ctx.message?.text;
  if (typeof text !== 'string') return false;
  pendingSignature.delete(chatId);
  const signature = text.trim().slice(0, MAX_SIGNATURE_LENGTH);
  if (signature.length === 0) {
    await ctx.reply(t('bot.sig.prompt', { identity }));
    pendingSignature.set(chatId, identity);
    return true;
  }
  deps.store.setSignature(identity, signature);
  await ctx.reply(t('bot.sig.saved', { identity }));
  const index = identities(deps).indexOf(identity);
  if (index !== -1) await showIdentity(ctx, deps, index);
  return true;
}
