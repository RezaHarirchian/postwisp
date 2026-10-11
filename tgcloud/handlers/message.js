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

// Handles the `message` update type: commands, the compose wizard, and
// search. The owner guard runs FIRST: anything not from the owner is
// dropped silently.

import { api } from 'sdk';
import {
  countInbox,
  enqueueOutbox,
  getEmail,
  isSuppressed,
  kvDelete,
  kvGet,
  kvSet,
  listInbox,
  listOutbox,
  listRules,
  searchEmails,
  updateOutboxStatus,
} from '../lib/store.js';
import { sendViaResend } from '../lib/resend.js';
import { PROTECT, button, inlineKeyboard, isOwner } from '../lib/tg.js';
import { truncateSnippet } from '../lib/pure.js';

const PAGE_SIZE = 5;
const WIZARD_PREFIX = 'wz:';

function wizardKey(chatId) {
  return `${WIZARD_PREFIX}${chatId}`;
}

async function loadWizard(chatId) {
  const raw = await kvGet(wizardKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Very small address check: enough to catch typos before a send, not a
// full RFC parser. Resend does the real validation.
function validAddress(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function parseAddresses(text) {
  return String(text)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function formatDate(ms) {
  const parsed = Number(ms);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

// ---------------------------------------------------------------------------
// menu
// ---------------------------------------------------------------------------

export async function renderMenu(chatId) {
  const text = [
    'postwisp serverless',
    '',
    'Inbox reads mail you saved. Compose sends mail through Resend.',
    'Send any text to search the inbox.',
    'New mail arrives from the Cloudflare worker; tap Save on a',
    'notification to keep it here.',
  ].join('\n');
  await api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: inlineKeyboard([
      [button('Inbox', 'cb:inbox:0'), button('Compose', 'cb:compose')],
      [button('Sent', 'cb:sent'), button('Settings', 'cb:settings')],
    ]),
  });
}

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

export async function showInbox(chatId, page) {
  const safePage = Math.max(0, page || 0);
  const rows = await listInbox({ limit: PAGE_SIZE, offset: safePage * PAGE_SIZE });
  const keyboard = [];
  const lines = [];
  if (rows.length === 0 && safePage === 0) {
    lines.push('Inbox is empty.', '', 'Tap Save on a worker notification to keep mail here.');
  } else {
    rows.forEach((row, index) => {
      const from = row.from_name ? `${row.from_name} <${row.from_addr}>` : row.from_addr;
      const marker = row.is_read ? '' : ' [new]';
      lines.push(`${safePage * PAGE_SIZE + index + 1}. ${from}${marker}`);
      lines.push(`   ${row.subject || '(no subject)'}`);
      if (row.snippet) lines.push(`   ${truncateSnippet(row.snippet, 80)}`);
      keyboard.push([button(`Open ${safePage * PAGE_SIZE + index + 1}`, `cb:open:${row.id}`)]);
    });
    const nav = [];
    if (safePage > 0) nav.push(button('Prev', `cb:inbox:${safePage - 1}`));
    if (rows.length === PAGE_SIZE) nav.push(button('Next', `cb:inbox:${safePage + 1}`));
    if (nav.length > 0) keyboard.push(nav);
  }
  keyboard.push([button('Menu', 'cb:menu')]);
  await api.sendMessage({
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: inlineKeyboard(keyboard),
    ...PROTECT,
  });
}

export async function showEmailDetail(chatId, id) {
  const email = await getEmail(id);
  if (!email) {
    await api.sendMessage({ chat_id: chatId, text: 'That email is gone.' });
    return;
  }
  const from = email.from_name ? `${email.from_name} <${email.from_addr}>` : email.from_addr;
  const text = [`From: ${from}`, `Subject: ${email.subject || '(no subject)'}`, `Date: ${formatDate(email.received_at)}`, '', email.snippet || ''].join('\n');
  await api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: inlineKeyboard([
      [button('Full text', `cb:full:${email.id}`), button('Mark read', `cb:read:${email.id}`)],
      [button('Archive', `cb:arc:${email.id}`), button('Reply', `cb:rpl:${email.id}`)],
      [button('Inbox', 'cb:inbox:0')],
    ]),
    ...PROTECT,
  });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function doSearch(chatId, queryText) {
  const hits = await searchEmails(queryText, 10);
  if (hits.length === 0) {
    await api.sendMessage({ chat_id: chatId, text: `No mail matching "${queryText}".` });
    return;
  }
  const keyboard = hits.map((row, index) => [
    button(`Open ${index + 1}`, `cb:open:${row.id}`),
  ]);
  keyboard.push([button('Menu', 'cb:menu')]);
  const lines = [`${hits.length} match(es) for "${queryText}":`, ''];
  hits.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.from_addr} — ${row.subject || '(no subject)'}`);
  });
  await api.sendMessage({
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: inlineKeyboard(keyboard),
    ...PROTECT,
  });
}

// ---------------------------------------------------------------------------
// compose wizard: to -> subject -> body -> confirm -> send
// ---------------------------------------------------------------------------

export async function startCompose(chatId, prefill = {}) {
  const to = Array.isArray(prefill.to) ? prefill.to : prefill.to ? [prefill.to] : [];
  const subject = prefill.subject || '';
  // Reply flow: recipient and subject are known, go straight to the body.
  const step = to.length > 0 ? 'body' : 'to';
  // The wizard id doubles as the send's idempotency key seed: a failed send
  // keeps the wizard, so re-tapping Send reuses the key and Resend returns
  // the original result instead of delivering twice.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await kvSet(wizardKey(chatId), JSON.stringify({ id, step, to, subject, body: '' }));
  if (step === 'to') {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Compose: who is this to? (comma-separated addresses, /cancel to stop)',
    });
  } else {
    await api.sendMessage({
      chat_id: chatId,
      text: `Compose to ${to.join(', ')}\nSubject: ${subject || '(none)'}\n\nNow the body (/cancel to stop):`,
    });
  }
}

async function handleWizardStep(chatId, rawText, wizard) {
  const text = rawText.trim();
  if (wizard.step === 'to') {
    const addresses = parseAddresses(text);
    const bad = addresses.filter((address) => !validAddress(address));
    if (addresses.length === 0 || bad.length > 0) {
      await api.sendMessage({
        chat_id: chatId,
        text: `Those do not look like email addresses: ${bad.join(', ') || '(empty)'}. Try again, or /cancel.`,
      });
      return;
    }
    wizard.to = addresses;
    wizard.step = 'subject';
    await kvSet(wizardKey(chatId), JSON.stringify(wizard));
    await api.sendMessage({ chat_id: chatId, text: 'Subject? (one line, /cancel to stop)' });
    return;
  }
  if (wizard.step === 'subject') {
    if (!text) {
      await api.sendMessage({ chat_id: chatId, text: 'Subject cannot be empty. Try again, or /cancel.' });
      return;
    }
    wizard.subject = text;
    wizard.step = 'body';
    await kvSet(wizardKey(chatId), JSON.stringify(wizard));
    await api.sendMessage({ chat_id: chatId, text: 'Body? (plain text, /cancel to stop)' });
    return;
  }
  if (wizard.step === 'body') {
    wizard.body = rawText;
    wizard.step = 'confirm';
    await kvSet(wizardKey(chatId), JSON.stringify(wizard));
    await showConfirm(chatId, wizard);
    return;
  }
  // A stray message during 'confirm': re-show the confirm card.
  if (wizard.step === 'confirm') {
    await showConfirm(chatId, wizard);
  }
}

async function showConfirm(chatId, wizard) {
  const preview = wizard.body.length > 500 ? `${wizard.body.slice(0, 500)}…` : wizard.body;
  const text = ['Ready to send:', `To: ${wizard.to.join(', ')}`, `Subject: ${wizard.subject}`, '', preview].join('\n');
  await api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: inlineKeyboard([[button('Send', 'cb:send'), button('Cancel', 'cb:cancel')]]),
    ...PROTECT,
  });
}

export async function doSend(chatId) {
  const wizard = await loadWizard(chatId);
  if (!wizard || wizard.step !== 'confirm') return;
  // Suppression is checked before anything is queued: an address on the
  // list never reaches Resend.
  for (const address of wizard.to) {
    if (await isSuppressed(address)) {
      await api.sendMessage({ chat_id: chatId, text: `Not sent: ${address} is on the suppression list.` });
      return;
    }
  }
  const apiKey = await kvGet('resend_api_key');
  const from = await kvGet('from_addr');
  if (!apiKey || !from) {
    await api.sendMessage({
      chat_id: chatId,
      text: 'Cannot send: resend_api_key and from_addr must be seeded first (see docs/SERVERLESS.md).',
    });
    return;
  }
  const idempotencyKey = `tg-${wizard.id || `${chatId}-legacy`}`;
  const outboxId = await enqueueOutbox({
    to_addrs: wizard.to,
    subject: wizard.subject,
    body: wizard.body,
    idempotency_key: idempotencyKey,
  });
  try {
    const { id } = await sendViaResend({
      apiKey,
      from,
      to: wizard.to,
      subject: wizard.subject,
      text: wizard.body,
      idempotencyKey,
    });
    await updateOutboxStatus(outboxId, 'sent');
    await kvDelete(wizardKey(chatId));
    await api.sendMessage({ chat_id: chatId, text: `Sent to ${wizard.to.join(', ')} (Resend id ${id}).` });
  } catch (error) {
    await updateOutboxStatus(outboxId, 'failed');
    const reason = error instanceof Error ? error.message : String(error);
    await api.sendMessage({ chat_id: chatId, text: `Send failed and was logged: ${reason}` });
  }
}

// ---------------------------------------------------------------------------
// sent + settings
// ---------------------------------------------------------------------------

export async function showSent(chatId) {
  const rows = await listOutbox(10);
  const lines = rows.length === 0
    ? ['Nothing sent yet.']
    : rows.map((row) => {
        let to = '';
        try {
          to = JSON.parse(row.to_addrs).join(', ');
        } catch {
          to = String(row.to_addrs);
        }
        return `${to} — ${row.subject || '(no subject)'} [${row.status}]`;
      });
  await api.sendMessage({
    chat_id: chatId,
    text: lines.join('\n'),
    ...PROTECT,
    reply_markup: inlineKeyboard([[button('Menu', 'cb:menu')]]),
  });
}

export async function showSettings(chatId) {
  const owner = await kvGet('owner_id');
  const resendKey = await kvGet('resend_api_key');
  const from = await kvGet('from_addr');
  const emailCount = await countInbox();
  const rules = await listRules();
  const text = [
    'Settings',
    `Owner id: ${owner || '(not set)'}`,
    `Resend key: ${resendKey ? 'set' : 'not set'}`,
    `From address: ${from || '(not set)'}`,
    `Saved emails: ${emailCount}`,
    `Rules: ${rules.length}`,
  ].join('\n');
  await api.sendMessage({
    chat_id: chatId,
    text,
    reply_markup: inlineKeyboard([[button('List rules', 'cb:rules'), button('Menu', 'cb:menu')]]),
  });
}

export async function showRules(chatId) {
  const rules = await listRules();
  const lines = rules.length === 0
    ? ['No rules. Rules are seeded with tgcloud run (see docs/SERVERLESS.md).']
    : rules.map((rule) => `${rule.field} ${rule.matcher} "${rule.value}" -> ${rule.action}`);
  await api.sendMessage({
    chat_id: chatId,
    text: lines.join('\n'),
    reply_markup: inlineKeyboard([[button('Settings', 'cb:settings')]]),
  });
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export default async function onMessage(message) {
  if (!message || !message.from || !message.chat) return;
  // Owner guard first: drop anything not from the owner, silently.
  if (!(await isOwner(message.from.id, kvGet))) return;
  const chatId = message.chat.id;
  const rawText = typeof message.text === 'string' ? message.text : '';
  const text = rawText.trim();

  if (text === '/cancel') {
    await kvDelete(wizardKey(chatId));
    await api.sendMessage({ chat_id: chatId, text: 'Cancelled.' });
    return;
  }

  // An active wizard consumes every text message until confirm/cancel.
  const wizard = await loadWizard(chatId);
  if (wizard && text) {
    await handleWizardStep(chatId, rawText, wizard);
    return;
  }

  if (text === '/start' || text === '/menu' || text === '/help') {
    await renderMenu(chatId);
    return;
  }
  if (text === '/compose') {
    await startCompose(chatId, {});
    return;
  }
  if (text === '/inbox') {
    await showInbox(chatId, 0);
    return;
  }
  if (text === '/sent') {
    await showSent(chatId);
    return;
  }
  if (text === '/settings') {
    await showSettings(chatId);
    return;
  }
  if (text.startsWith('/search ')) {
    const queryText = text.slice('/search '.length).trim();
    if (queryText) await doSearch(chatId, queryText);
    return;
  }
  if (text.startsWith('/')) {
    await renderMenu(chatId);
    return;
  }
  // Plain text with no wizard running is a search.
  if (text) {
    await doSearch(chatId, text);
  }
  // Non-text messages (photos, stickers, ...) are ignored.
}
