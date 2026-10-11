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

// Handles the `callback_query` update type. Every query is answered FIRST
// (so the client never hangs on a spinner), then the owner guard runs —
// anything not from the owner is dropped silently.
//
// Two button families:
//   cb:* — the companion's own UI (inbox, email detail, compose confirm).
//   w:*  — buttons attached by the Cloudflare worker's DIRECT_BOT_API
//          notifications. The worker cannot write to the tgcloud database,
//          so the email content is parsed back out of the notification
//          message text (see pure.parseInboundMessage).

import { api } from 'sdk';
import {
  addSuppression,
  archiveEmail,
  getEmail,
  kvDelete,
  kvGet,
  markRead,
  matchRules,
  saveEmail,
} from '../lib/store.js';
import {
  PROTECT,
  answerCallback,
  button,
  inlineKeyboard,
  isOwner,
  sendChunked,
} from '../lib/tg.js';
import { extractOtp, parseInboundMessage, truncateSnippet } from '../lib/pure.js';
import {
  doSend,
  renderMenu,
  showEmailDetail,
  showInbox,
  showRules,
  showSent,
  showSettings,
  startCompose,
} from './message.js';

// ---------------------------------------------------------------------------
// worker notifications (w:*): the email lives in the message text
// ---------------------------------------------------------------------------

function notificationEmail(query) {
  const text = query.message && typeof query.message.text === 'string' ? query.message.text : '';
  return parseInboundMessage(text);
}

// Deterministic id per notification message: tapping Save twice stores
// the email once (saveEmail upserts on id).
function notificationId(query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  return `w:${chatId}:${messageId}`;
}

async function saveNotification(chatId, query) {
  const parsed = notificationEmail(query);
  if (!parsed) {
    await answerCallback(query.id, 'Could not read this message.');
    return;
  }
  const id = notificationId(query);
  await saveEmail({
    id,
    from_addr: parsed.from_addr,
    from_name: parsed.from_name,
    subject: parsed.subject,
    snippet: truncateSnippet(parsed.body, 160),
    body: parsed.body,
    received_at: parsed.date_ms,
  });
  // Basic rules run at save time: archive, mark read, or suppress the sender.
  const applied = [];
  for (const action of await matchRules({ from_addr: parsed.from_addr, subject: parsed.subject })) {
    if (action === 'archive') {
      await archiveEmail(id);
      applied.push('archived by rule');
    } else if (action === 'mark_read') {
      await markRead(id);
      applied.push('marked read by rule');
    } else if (action === 'suppress') {
      await addSuppression(parsed.from_addr, 'rule');
      applied.push('sender suppressed by rule');
    }
  }
  const suffix = applied.length > 0 ? ` (${applied.join(', ')})` : '';
  await answerCallback(query.id, `Saved to inbox${suffix}.`);
}

async function otpNotification(chatId, query) {
  const parsed = notificationEmail(query);
  if (!parsed) {
    await answerCallback(query.id, 'Could not read this message.');
    return;
  }
  const codes = extractOtp(parsed.body);
  if (codes.length === 0) {
    await answerCallback(query.id, 'No code found in this message.');
    return;
  }
  await answerCallback(query.id);
  await sendChunked(chatId, `Code${codes.length > 1 ? 's' : ''}: ${codes.join(', ')}`, PROTECT);
}

async function replyNotification(chatId, query) {
  const parsed = notificationEmail(query);
  if (!parsed) {
    await answerCallback(query.id, 'Could not read this message.');
    return;
  }
  const subject = parsed.subject.toLowerCase().startsWith('re:')
    ? parsed.subject
    : `Re: ${parsed.subject}`;
  await answerCallback(query.id);
  await startCompose(chatId, { to: parsed.from_addr, subject });
}

// ---------------------------------------------------------------------------
// companion UI (cb:*)
// ---------------------------------------------------------------------------

async function routeCallback(chatId, query, data) {
  if (data === 'cb:menu') {
    await renderMenu(chatId);
    return;
  }
  if (data === 'cb:inbox' || data.startsWith('cb:inbox:')) {
    const page = Number(data.split(':')[2] || 0);
    await showInbox(chatId, Number.isFinite(page) ? page : 0);
    return;
  }
  if (data.startsWith('cb:open:')) {
    await showEmailDetail(chatId, data.slice('cb:open:'.length));
    return;
  }
  if (data.startsWith('cb:full:')) {
    const email = await getEmail(data.slice('cb:full:'.length));
    if (!email) {
      await api.sendMessage({ chat_id: chatId, text: 'That email is gone.' });
      return;
    }
    await sendChunked(chatId, email.body || email.snippet || '(empty)', PROTECT);
    return;
  }
  if (data.startsWith('cb:read:')) {
    await markRead(data.slice('cb:read:'.length));
    await answerCallback(query.id, 'Marked as read.');
    return;
  }
  if (data.startsWith('cb:arc:')) {
    await archiveEmail(data.slice('cb:arc:'.length));
    await answerCallback(query.id, 'Archived.');
    return;
  }
  if (data.startsWith('cb:rpl:')) {
    const email = await getEmail(data.slice('cb:rpl:'.length));
    if (!email) {
      await api.sendMessage({ chat_id: chatId, text: 'That email is gone.' });
      return;
    }
    const subject = email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`;
    await startCompose(chatId, { to: email.from_addr, subject });
    return;
  }
  if (data === 'cb:compose') {
    await startCompose(chatId, {});
    return;
  }
  if (data === 'cb:send') {
    await doSend(chatId);
    return;
  }
  if (data === 'cb:cancel') {
    await kvDelete(`wz:${chatId}`);
    await api.sendMessage({ chat_id: chatId, text: 'Cancelled.' });
    return;
  }
  if (data === 'cb:sent') {
    await showSent(chatId);
    return;
  }
  if (data === 'cb:settings') {
    await showSettings(chatId);
    return;
  }
  if (data === 'cb:rules') {
    await showRules(chatId);
    return;
  }
  // Worker notification buttons.
  if (data === 'w:sv') {
    await saveNotification(chatId, query);
    return;
  }
  if (data === 'w:otp') {
    await otpNotification(chatId, query);
    return;
  }
  if (data === 'w:rpl') {
    await replyNotification(chatId, query);
    return;
  }
  // Unknown callback data: already answered, nothing to do.
}

export default async function onCallbackQuery(query) {
  if (!query || !query.from) return;
  // Answer first so the client never hangs; the guard runs right after.
  try {
    await answerCallback(query.id);
  } catch {
    // If answering itself fails there is nothing useful to do.
    return;
  }
  if (!(await isOwner(query.from.id, kvGet))) return;
  const chatId = query.message && query.message.chat ? query.message.chat.id : null;
  if (chatId === null || chatId === undefined) return;
  try {
    await routeCallback(chatId, query, query.data || '');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await api.sendMessage({ chat_id: chatId, text: `Something failed: ${reason}` });
    } catch {
      // Last resort failed; the error is already in the handler logs
      // via the platform's console capture.
    }
  }
}
