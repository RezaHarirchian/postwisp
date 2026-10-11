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

// Local backup: mbox and JSON dumps of the stored mail, sent back as
// Telegram documents. The coordinator routes `exp:` callbacks here;
// everything is owner-only by the time it arrives (the owner guard runs
// first).

import { InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Store } from '../core/store.js';
import { t } from '../core/i18n.js';
import { buildJsonExport, buildMbox, exportFilename } from '../core/export.js';

export interface ExportDeps {
  store: Store;
  backToSettings: (ctx: Context) => Promise<void>;
}

export async function handleExportCallback(
  ctx: Context,
  deps: ExportDeps,
  data: string,
): Promise<boolean> {
  if (!data.startsWith('exp:')) return false;
  const [head] = data.slice(4).split(':');
  switch (head) {
    case 'home': {
      const kb = new InlineKeyboard()
        .text(t('bot.export.mbox'), 'exp:mbox')
        .text(t('bot.export.json'), 'exp:json')
        .row()
        .text(t('bot.compose.back'), 'exp:back');
      await ctx.reply(t('bot.export.prompt'), { reply_markup: kb });
      return true;
    }
    case 'back':
      await deps.backToSettings(ctx);
      return true;
    case 'mbox':
    case 'json': {
      const emails = deps.store.listExportEmails();
      if (emails.length === 0) {
        await ctx.reply(t('bot.export.empty'));
        return true;
      }
      const body = head === 'mbox' ? buildMbox(emails) : buildJsonExport(emails);
      const filename = exportFilename(head);
      // Documents carry the owner's own mail: keep them off forwards and
      // screenshots like every other email surface.
      await ctx.replyWithDocument(new InputFile(Buffer.from(body, 'utf8'), filename), {
        protect_content: true,
      });
      return true;
    }
    default:
      return false;
  }
}
