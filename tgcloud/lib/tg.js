// postwisp — Telegram Serverless companion
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

// Thin Telegram Bot API helpers for the tgcloud handlers. One place for
// the 4096-char chunking rule and for answering callback queries, so the
// handlers never forget either.

import { api } from 'sdk';
import { chunkText, TELEGRAM_MAX_CHARS } from './pure.js';

// Sends text, splitting into 4096-code-point chunks when needed. Every
// chunk is its own sendMessage call; `extra` (parse_mode, reply_markup,
// protect_content, ...) applies to all of them.
export async function sendChunked(chatId, text, extra = {}) {
  const chunks = chunkText(text, TELEGRAM_MAX_CHARS);
  for (const chunk of chunks) {
    await api.sendMessage({ chat_id: chatId, text: chunk, ...extra });
  }
}

// Every callback query the bot receives MUST be answered, or the client
// shows a loading spinner until it times out. Answer immediately, before
// doing the real work.
export async function answerCallback(callbackQueryId, text) {
  const params = { callback_query_id: callbackQueryId };
  if (text) params.text = text;
  await api.answerCallbackQuery(params);
}

// Every message that carries email content is sent with protect_content
// so it cannot be forwarded or saved out of the chat.
export const PROTECT = { protect_content: true };

// Small builders for inline keyboards. callback_data is capped at 64
// bytes by Telegram; keep data payloads short (prefix + id).
export function inlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

export function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

// Owner guard. The owner id lives in kv under 'owner_id', seeded during
// deploy (see docs/SERVERLESS.md). Anything that is not from the owner —
// wrong user, missing id, or group chat noise — is dropped silently:
// replying would confirm to strangers that this bot is alive.
export async function isOwner(userId, kvGet) {
  if (userId === undefined || userId === null) return false;
  const owner = await kvGet('owner_id');
  if (owner === null) return false;
  return String(userId) === String(owner);
}
