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

// Reactions as quick actions: a thumbs-up on a bot email message archives
// that email. The coordinator records message_id -> email_id when a
// notification goes out (store.noteSentMessage); this handler resolves the
// reaction back to the email. Only the owner's reactions count — the owner
// guard already filters updates, and the from.id check below is the
// explicit second gate.

import type { Context } from 'grammy';
import type { MessageReactionUpdated, ReactionType } from 'grammy/types';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';

export interface ReactionDeps {
  ownerId: number | null;
  // Narrow seams so tests bind fakes without a full store.
  setArchived: (emailId: string, archived: boolean) => void;
  emailIdForMessage: (messageId: number) => string | null;
  logger: Logger;
}

// True when the update adds a thumbs-up reaction. Re-archiving an already
// archived email is a no-op, so only the addition matters, not the delta.
export function thumbsUpAdded(reaction: MessageReactionUpdated | undefined): boolean {
  if (!reaction) return false;
  const current: ReactionType[] | undefined = reaction.new_reaction;
  if (!Array.isArray(current)) return false;
  return current.some((r) => r.type === 'emoji' && r.emoji === '👍');
}

export async function handleMessageReaction(ctx: Context, deps: ReactionDeps): Promise<void> {
  // Belt and braces next to the owner guard: reactions act on mail, so the
  // sender check is explicit here rather than implied.
  if (deps.ownerId === null || ctx.from?.id !== deps.ownerId) return;
  if (!thumbsUpAdded(ctx.messageReaction)) return;
  const messageId = ctx.messageReaction?.message_id;
  if (typeof messageId !== 'number') return;
  const emailId = deps.emailIdForMessage(messageId);
  if (!emailId) {
    deps.logger.info('reaction on unknown message ignored', { messageId });
    return;
  }
  deps.setArchived(emailId, true);
  deps.logger.info('email archived via reaction', { emailId });
  await ctx.reply(t('bot.reaction.archived')).catch(() => undefined);
}

// Narrow Store view the coordinator passes for the two seams above.
export function reactionStoreSeams(store: Store): Pick<ReactionDeps, 'setArchived' | 'emailIdForMessage'> {
  return {
    setArchived: (emailId: string, archived: boolean) => {
      const meta = store.getEmailMeta(emailId);
      if (meta) store.saveEmailMeta({ ...meta, archived });
    },
    emailIdForMessage: (messageId: number) => store.emailIdForMessage(messageId),
  };
}
