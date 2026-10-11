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

import { Bot, Keyboard, InputFile, type Context, type Middleware } from 'grammy';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import { saveConfigFile } from '../core/config.js';
import {
  clearPairingToken,
  pairingTokenMatches,
  readPairingToken,
  withPairingTokenRedaction,
  type KvStore,
} from '../core/pairing.js';
import type { SendQueue } from './queue.js';
import type { SendInput, SendResult } from '../providers/interface.js';
import { chunkText } from './notify.js';
import { t } from '../core/i18n.js';
import {
  clearComposeState,
  handleComposeCallback,
  handleComposeDocument,
  handleComposeText,
  startCompose,
  startReplyCompose,
  type ComposeDeps,
} from './compose.js';
import { handleStatsMenu } from './stats.js';
import {
  handleComplianceCallback,
  settingsComplianceKeyboard,
  type ComplianceDeps,
} from './compliance.js';
import {
  clearSignatureState,
  handleSignatureCallback,
  handleSignatureText,
  type SignatureDeps,
} from './signatures.js';
import {
  clearProviderKeyState,
  handleProviderKeyCallback,
  handleProviderKeyText,
  type ProviderKeyDeps,
} from './keys.js';
import { handleExportCallback, type ExportDeps } from './export.js';
import { handleIcsResponse } from './ics-actions.js';
import { handleUnsubscribeAction } from './unsub-action.js';
import { handleMessageReaction, reactionStoreSeams } from './reactions.js';
import {
  handleAiCallback,
  handleDraftReplyButton,
  withCorrectionTracking,
  type AiActionDeps,
} from './ai-actions.js';
import type { LlmClient } from '../core/llm.js';
import type { UnsubscribeConfig } from '../core/unsubscribe.js';
import {
  buildDomainPicker,
  buildEmailView,
  buildInboxList,
  buildSearchResults,
  buildSentList,
  buildThreadView,
  escapeHtml,
  formatDateUtc,
  parseCallbackData,
  type EmailAction,
  type EmailViewRecord,
  type SentListItem,
} from './views.js';

export interface BotSettings {
  ownerId: number | null;
  providerName: string;
  domains: string[];
  // Public base URL of the server (https://mail.example.com). When set,
  // the settings screen offers the Web App inbox button; unset hides it.
  publicUrl?: string | null;
  // P8 AI status line. Unset means off.
  aiEnabled?: boolean;
}

// Structural seams for the sibling workers' modules (src/core/inbox.ts and
// the store's full-email additions). The coordinator wires the real
// implementations and merges these types at merge time; every seam is
// optional so the bot still boots with P0 behavior when unwired.
export interface BotStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  getEmail(id: string): EmailViewRecord | null;
  listEmails(opts?: { domain?: string; limit?: number }): EmailViewRecord[];
  setRead(id: string, read: boolean): void;
  setArchived(id: string, archived: boolean): void;
  snoozeEmail(id: string, untilMs: number): void;
  blockSender(address: string): void;
  addArchiveRule(from: string, subject: string): void;
}

export interface SearchQuery {
  from?: string;
  subject?: string;
  hasAttachment?: boolean;
  text?: string;
}

export interface SearchFns {
  parseSearch(q: string): SearchQuery;
  searchEmails(q: SearchQuery, opts?: { limit?: number }): EmailViewRecord[];
}

export type AttachmentFetch =
  | { ok: true; filename: string; data: Buffer }
  | { ok: false; reason: 'missing' | 'too_large' | 'failed' };

export interface BotDeps {
  token: string;
  logger: Logger;
  settings: BotSettings;
  store?: BotStore;
  search?: SearchFns;
  // Provider seam: the coordinator injects provider.listSentEmails here.
  listSent?: (domain?: string) => Promise<SentListItem[]>;
  // Sibling seam: extractOtp comes from src/core/inbox.ts at merge time.
  extractOtp?: (text: string) => string[];
  // Attachment bytes, fetched fresh from the provider at tap time (signed
  // URLs expire, so the stored email row carries metadata only).
  downloadAttachment?: (emailId: string, attachmentId: string) => Promise<AttachmentFetch>;
  // P2: the canonical store and the provider's send, for compose/drafts/
  // scheduled/sent-log. Optional so the bot still boots unwired.
  fullStore?: Store;
  sendEmail?: (input: SendInput) => Promise<SendResult>;
  // P7: per-key senders built by the coordinator from the provider_keys
  // table. Unset means every send goes through sendEmail.
  sendEmailWithKey?: (keyId: number, input: SendInput) => Promise<SendResult>;
  queue?: SendQueue | null;
  // Builds the unsubscribe footer on non-personal sends. Unset means no
  // footer is added (tests, unwired runs).
  compliance?: UnsubscribeConfig;
  // Wipes every user-data row for the GDPR delete flow; the coordinator
  // provides it because it owns the store and the log file.
  wipeData?: () => void;
  // P8 AI (opt-in): the LLM client, null when no key is configured. Every
  // AI path checks this first; without it no AI button is rendered and no
  // AI work runs.
  llm?: LlmClient | null;
  // Days of silence before a follow-up nudge fires. Defaults to 3.
  nudgeDays?: number;
  // Test seam: grammy captures its own fetch implementation, so tests that
  // need to observe Bot API calls (setWebhook/deleteWebhook) inject one here.
  apiFetch?: typeof fetch;
}

// The Bot API performs no authentication, so every update is checked here.
// Fail-closed: with no owner configured, everything is dropped. The chat
// must be the owner's private chat as well: email content must never land
// in a group, even one the owner is in.
export function ownerGuard(ownerId: number | null, logger: Logger): Middleware<Context> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (ownerId === null || fromId !== ownerId || chatId !== ownerId) {
      logger.warn('dropped update from non-owner', {
        fromId: fromId ?? null,
        chatId: chatId ?? null,
      });
      return;
    }
    await next();
  };
}

export interface PairingOptions {
  // The canonical store's kv; undefined when the bot runs without a store.
  store: KvStore | undefined;
  logger: Logger;
  // Overridable so tests never touch the real config file.
  saveOwner?: (ownerId: number) => void;
  nowMs?: () => number;
}

function startPayload(text: string): string | null {
  // Accepts "/start <payload>" and "/start@BotName <payload>".
  const match = /^\/start(@[A-Za-z0-9_]+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  return match?.[2] ?? null;
}

// Consumes a valid pairing deep-link tap before the owner guard can drop
// it. Pairing happens before an owner exists, so this must run first.
// Single use: the token is cleared before the owner is saved, so a
// replayed tap can never pair twice. Anything that is not a matching
// /start payload falls through to the guard.
export function pairingMiddleware(opts: PairingOptions): Middleware<Context> {
  const saveOwner = opts.saveOwner ?? ((ownerId: number) => saveConfigFile({ ownerId }));
  const nowMs = opts.nowMs ?? Date.now;
  // The pairing token is minted at runtime and rotated, so it cannot be
  // baked into the logger's knownSecrets at startup: mask the live value.
  const logger = withPairingTokenRedaction(opts.logger, opts.store);
  return async (ctx, next) => {
    const text = ctx.message?.text;
    const fromId = ctx.from?.id;
    const payload = typeof text === 'string' ? startPayload(text) : null;
    if (opts.store && payload !== null && typeof fromId === 'number') {
      // The token is a bearer secret: it must never travel through a group
      // chat, where every member would see it.
      if (ctx.chat?.type !== 'private') {
        await ctx.reply(t('bot.pair.notPrivate'));
        return;
      }
      if (pairingTokenMatches(readPairingToken(opts.store), payload, nowMs())) {
        clearPairingToken(opts.store);
        saveOwner(fromId);
        logger.info('paired new owner via deep link', { ownerId: fromId });
        await ctx.reply(
          'Paired. This chat is now the bot owner. Restart the postwisp server so the new owner takes effect.',
        );
        return;
      }
    }
    await next();
  };
}

// The whole interface is buttons. Commands exist only as a hidden fallback
// for clients that cannot render keyboards.
export function mainKeyboard(): Keyboard {
  return new Keyboard()
    .text(t('bot.menu.compose'))
    .text(t('bot.menu.inbox'))
    .text(t('bot.menu.sent'))
    .row()
    .text(t('bot.menu.search'))
    .text(t('bot.menu.stats'))
    .text(t('bot.menu.settings'))
    .row()
    .resized()
    .persistent();
}

function settingsText(settings: BotSettings): string {
  if (settings.ownerId === null) return t('bot.settings.notConfigured');
  const lines = [
    t('bot.settings.title'),
    t('bot.settings.owner', { id: settings.ownerId }),
    t('bot.settings.provider', { name: settings.providerName }),
    t('bot.settings.domains', { list: settings.domains.length > 0 ? settings.domains.join(', ') : '—' }),
    // The key itself is never shown: only whether AI is on or off.
    t('bot.settings.ai', { status: t(settings.aiEnabled ? 'bot.ai.on' : 'bot.ai.off') }),
  ];
  return lines.join('\n');
}

// The settings screen, shared by the menu button and the compliance
// screens' Back button. The persistent main keyboard stays visible; the
// inline keyboard below opens the suppression list, data management, and
// the P7 screens (signatures, provider keys, export, web inbox).
async function showSettings(ctx: Context, deps: BotDeps): Promise<void> {
  const webAppUrl = deps.settings.publicUrl ? `${deps.settings.publicUrl}/webapp` : undefined;
  await ctx.reply(settingsText(deps.settings), {
    reply_markup: settingsComplianceKeyboard(webAppUrl),
    protect_content: true,
  });
}

async function replyInboxList(ctx: Context, deps: BotDeps, domain?: string): Promise<void> {
  if (!deps.store) {
    await ctx.reply(t('bot.inbox.title'), { reply_markup: mainKeyboard() });
    return;
  }
  const emails =
    domain === undefined
      ? deps.store.listEmails({ limit: 10 })
      : deps.store.listEmails({ domain, limit: 10 });
  const view = buildInboxList(emails);
  await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.replyMarkup, protect_content: true });
}

async function handleEmailAction(
  ctx: Context,
  deps: BotDeps,
  id: string,
  action: EmailAction | 'open',
  composeDeps: ComposeDeps | null,
  aiDeps: AiActionDeps | null,
): Promise<void> {
  const store = deps.store;
  if (!store) {
    await ctx.reply(t('bot.error.notConfigured'));
    return;
  }
  const email = store.getEmail(id);
  if (!email) {
    await ctx.reply(t('bot.email.notFound'));
    return;
  }
  switch (action) {
    case 'open': {
      const view = buildEmailView(email, { aiDraft: aiDeps?.llm != null });
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.replyMarkup, protect_content: true });
      return;
    }
    case 'full': {
      if (email.bodyText && email.bodyText.length > 0) {
        // Long bodies are the point of this button; resend in full, chunked
        // to stay under Telegram's message limit. The head is prepended
        // after chunking, so the body budget leaves room for it: a long
        // subject would otherwise push the first message past 4096 chars
        // and the send would be rejected.
        const head = `${t('bot.notify.subject', { subject: escapeHtml(email.subject) })}\n\n`;
        const budget = Math.max(256, 4096 - head.length - 64);
        const chunks = chunkText(escapeHtml(email.bodyText), budget);
        await ctx.reply(head + (chunks[0] ?? ''), { parse_mode: 'HTML', protect_content: true });
        for (const chunk of chunks.slice(1)) {
          await ctx.reply(chunk, { parse_mode: 'HTML', protect_content: true });
        }
      } else {
        const view = buildEmailView(email, { aiDraft: aiDeps?.llm != null });
        await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.replyMarkup, protect_content: true });
      }
      return;
    }
    case 'att': {
      const attachments = email.attachments ?? [];
      if (attachments.length === 0 || !deps.downloadAttachment) {
        await ctx.reply(t('bot.email.noAttachments'), {
          parse_mode: 'HTML',
          protect_content: true,
        });
        return;
      }
      await ctx.reply(t('bot.email.attachmentsTitle', { count: attachments.length }), {
        protect_content: true,
      });
      // One document per attachment, capped: Telegram bots cannot receive
      // files over 20 MB, and a long tail of files is a tap-list problem.
      for (const a of attachments.slice(0, 10)) {
        let fetched: AttachmentFetch;
        try {
          fetched = await deps.downloadAttachment(id, a.id);
        } catch {
          fetched = { ok: false, reason: 'failed' };
        }
        if (!fetched.ok) {
          const key =
            fetched.reason === 'too_large' ? 'bot.email.attachmentTooLarge' : 'bot.email.attachmentFailed';
          await ctx.reply(t(key, { filename: a.filename }), { protect_content: true });
          continue;
        }
        await ctx.replyWithDocument(new InputFile(fetched.data, fetched.filename), {
          protect_content: true,
        });
      }
      return;
    }
    case 'arch':
      store.setArchived(id, true);
      await ctx.reply(t('bot.email.archived'));
      return;
    case 'read':
      store.setRead(id, true);
      await ctx.reply(t('bot.email.markedRead'));
      return;
    case 'unread':
      store.setRead(id, false);
      await ctx.reply(t('bot.email.markedUnread'));
      return;
    case 'sz1h':
    case 'sz24h': {
      const untilMs = Date.now() + (action === 'sz1h' ? 3600 : 86400) * 1000;
      store.snoozeEmail(id, untilMs);
      await ctx.reply(t('bot.email.snoozed', { date: formatDateUtc(untilMs) }));
      return;
    }
    case 'blk':
      store.blockSender(email.fromAddr);
      await ctx.reply(t('bot.email.senderBlocked', { address: email.fromAddr }));
      return;
    case 'rule':
      store.addArchiveRule(email.fromAddr, email.subject);
      // The subject is email content; keep it off screenshots and forwards.
      await ctx.reply(t('bot.email.ruleAdded', { from: email.fromAddr, subject: email.subject }), {
        protect_content: true,
      });
      return;
    case 'reply': {
      // A threaded reply is just a compose with the recipient, subject and
      // threading headers prefilled; the owner only writes the body.
      const meta = deps.fullStore?.getEmailMeta(id);
      if (meta && composeDeps) {
        await startReplyCompose(ctx, composeDeps, {
          from: meta.fromAddr,
          subject: meta.subject,
          headers: meta.headers ?? {},
        });
        return;
      }
      await ctx.reply(t('bot.email.replyLater'));
      return;
    }
    case 'draft': {
      // P8 smart reply: generate a draft with the owner's LLM key, then
      // approve or edit it. The button is only rendered when the key is
      // set; without it this explains instead of failing silently.
      if (aiDeps?.llm && aiDeps.sendDeps) {
        await handleDraftReplyButton(ctx, aiDeps, id);
        return;
      }
      await ctx.reply(t('bot.ai.notAvailable'));
      return;
    }
    case 'unsub': {
      if (!deps.fullStore) {
        await ctx.reply(t('bot.error.notConfigured'));
        return;
      }
      await handleUnsubscribeAction(ctx, { store: deps.fullStore, logger: deps.logger }, id);
      return;
    }
    case 'icsa':
    case 'icsd': {
      if (!deps.fullStore || !deps.sendEmail) {
        await ctx.reply(t('bot.error.notConfigured'));
        return;
      }
      await handleIcsResponse(
        ctx,
        {
          store: deps.fullStore,
          logger: deps.logger,
          ownerId: deps.settings.ownerId,
          domains: deps.settings.domains,
          sendEmail: deps.sendEmail,
          ...(deps.downloadAttachment ? { downloadAttachment: deps.downloadAttachment } : {}),
        },
        id,
        action === 'icsa' ? 'ACCEPTED' : 'DECLINED',
      );
      return;
    }
  }
}

export function createBot(deps: BotDeps): Bot {
  const bot = deps.apiFetch ? new Bot(deps.token, { client: { fetch: deps.apiFetch } }) : new Bot(deps.token);

  // Pairing before the guard: /start <token> is the only update allowed
  // through while no owner is configured. Everything else still falls
  // through to the guard, which drops it.
  bot.use(pairingMiddleware({ store: deps.fullStore, logger: deps.logger }));

  // Guard first: nothing below runs for anyone but the owner.
  bot.use(ownerGuard(deps.settings.ownerId, deps.logger));

  // Middleware errors must not take the bot down silently.
  bot.catch((err) => {
    deps.logger.error('bot error', {
      detail: err instanceof Error ? err.message : String(err),
    });
  });

  const keyboard = mainKeyboard();
  const withMenu = { reply_markup: keyboard };

  // Tracks chats waiting to type a search query after tapping Search.
  const pendingSearch = new Set<number>();
  const trackChat = (ctx: Context): number | undefined => ctx.chat?.id;

  bot.command('start', (ctx) => ctx.reply(`${t('bot.welcome.title')}\n${t('bot.welcome.body')}`, withMenu));

  bot.hears(t('bot.menu.settings'), (ctx) => {
    const chatId = trackChat(ctx);
    if (chatId !== undefined) { pendingSearch.delete(chatId); clearComposeState(chatId); clearSignatureState(chatId); clearProviderKeyState(chatId); }
    return showSettings(ctx, deps);
  });
  bot.hears(t('bot.menu.inbox'), async (ctx) => {
    const chatId = trackChat(ctx);
    if (chatId !== undefined) { pendingSearch.delete(chatId); clearComposeState(chatId); clearSignatureState(chatId); clearProviderKeyState(chatId); }
    const domains = deps.settings.domains;
    if (domains.length > 1) {
      await ctx.reply(t('bot.inbox.domainPrompt'), { reply_markup: buildDomainPicker(domains) });
      return;
    }
    await replyInboxList(ctx, deps, domains[0]);
  });
  bot.hears(t('bot.menu.sent'), async (ctx) => {
    const chatId = trackChat(ctx);
    if (chatId !== undefined) { pendingSearch.delete(chatId); clearComposeState(chatId); clearSignatureState(chatId); clearProviderKeyState(chatId); }
    if (!deps.listSent) {
      await ctx.reply(t('bot.sent.title'), withMenu);
      return;
    }
    const view = buildSentList(await deps.listSent());
    await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.replyMarkup, protect_content: true });
  });
  bot.hears(t('bot.menu.search'), async (ctx) => {
    if (!deps.search) {
      await ctx.reply(t('bot.search.prompt'), withMenu);
      return;
    }
    const chatId = trackChat(ctx);
    if (chatId !== undefined) {
      pendingSearch.add(chatId);
      clearComposeState(chatId);
      clearSignatureState(chatId);
      clearProviderKeyState(chatId);
    }
    // ForceReply focuses the input on the query; the next text message is
    // treated as the query (see the message:text handler below).
    await ctx.reply(t('bot.search.prompt'), { reply_markup: { force_reply: true } });
  });
  bot.hears(t('bot.menu.stats'), (ctx) => {
    const chatId = trackChat(ctx);
    if (chatId !== undefined) { pendingSearch.delete(chatId); clearComposeState(chatId); clearSignatureState(chatId); clearProviderKeyState(chatId); }
    if (deps.fullStore) return handleStatsMenu(ctx, { store: deps.fullStore });
    return ctx.reply(t('bot.stats.title'), withMenu);
  });
  // Compose needs the provider's send; without it the wizard cannot run, so
  // the button stays a label until the coordinator wires it.
  const composeDeps: ComposeDeps | null =
    deps.fullStore && deps.sendEmail
      ? {
          store: deps.fullStore,
          logger: deps.logger,
          queue: deps.queue ?? null,
          ownerId: deps.settings.ownerId,
          domains: deps.settings.domains,
          sendEmail: deps.sendEmail,
          ...(deps.sendEmailWithKey ? { sendEmailWithKey: deps.sendEmailWithKey } : {}),
          providerName: deps.settings.providerName,
          ...(deps.compliance ? { compliance: deps.compliance } : {}),
        }
      : null;
  // Compliance screens need the canonical store; without it the settings
  // buttons that open them are inert. wipeData falls back to the store
  // wipe when the coordinator did not provide log truncation.
  const fullStore = deps.fullStore;

  // P8 AI handlers: null llm means every AI entry point refuses. The
  // buttons that lead here are only rendered when the key is set.
  const aiDeps: AiActionDeps | null = fullStore
    ? {
        store: fullStore,
        logger: deps.logger,
        llm: deps.llm ?? null,
        sendDeps: composeDeps,
        ownerId: deps.settings.ownerId,
        nudgeDays: deps.nudgeDays ?? 3,
      }
    : null;  const wipeData = deps.wipeData;
  const complianceDeps: ComplianceDeps | null = fullStore
    ? {
        store: fullStore,
        wipeData: wipeData ?? (() => fullStore.wipeAllData()),
        backToSettings: (ctx: Context) => showSettings(ctx, deps),
      }
    : null;
  bot.hears(t('bot.menu.compose'), (ctx) => {
    const chatId = trackChat(ctx);
    if (chatId !== undefined) pendingSearch.delete(chatId);
    if (composeDeps) return startCompose(ctx, composeDeps);
    return ctx.reply(t('bot.menu.compose'), withMenu);
  });

  bot.on('callback_query:data', async (ctx) => {
    // Always clear the spinner, even for unknown data.
    await ctx.answerCallbackQuery().catch(() => undefined);
    if (composeDeps && ctx.callbackQuery.data.startsWith('c:')) {
      await handleComposeCallback(ctx, composeDeps, ctx.callbackQuery.data);
      return;
    }
    const cbData = ctx.callbackQuery.data;
    // P8 AI callbacks (triage approve/reject, reply draft approve/edit,
    // nudge snooze/dismiss). Short numeric ids ride in the data; the
    // handler resolves everything else server-side.
    if (cbData.startsWith('ai:')) {
      if (aiDeps) await handleAiCallback(ctx, aiDeps, cbData);
      return;
    }
    if (
      complianceDeps &&
      (cbData.startsWith('sup:') || cbData.startsWith('data:') || cbData === 'set:home')
    ) {
      await handleComplianceCallback(ctx, complianceDeps, cbData);
      return;
    }
    // P7 screens (signatures, export, provider keys) need the canonical
    // store; without it the settings buttons that open them are inert.
    if (fullStore) {
      const backToSettings = (c: Context) => showSettings(c, deps);
      if (cbData.startsWith('sig:')) {
        const sigDeps: SignatureDeps = {
          store: fullStore,
          domains: deps.settings.domains,
          backToSettings,
        };
        await handleSignatureCallback(ctx, sigDeps, cbData);
        return;
      }
      if (cbData.startsWith('exp:')) {
        const expDeps: ExportDeps = { store: fullStore, backToSettings };
        await handleExportCallback(ctx, expDeps, cbData);
        return;
      }
      if (cbData.startsWith('key:')) {
        const keyDeps: ProviderKeyDeps = {
          store: fullStore,
          providerName: deps.settings.providerName,
          backToSettings,
        };
        await handleProviderKeyCallback(ctx, keyDeps, cbData);
        return;
      }
    }
    const action = parseCallbackData(ctx.callbackQuery.data);
    if (!action) return;
    if (action.kind === 'domain') {
      await replyInboxList(ctx, deps, action.domain ?? undefined);
      return;
    }
    if (action.kind === 'thread') {
      if (!deps.store) {
        await ctx.reply(t('bot.error.notConfigured'));
        return;
      }
      const emails = deps.store
        .listEmails({ limit: 200 })
        .filter((e) => e.threadId === action.threadId)
        .sort((a, b) => (a.dateMs ?? 0) - (b.dateMs ?? 0));
      if (emails.length === 0) {
        await ctx.reply(t('bot.email.notFound'));
        return;
      }
      const view = buildThreadView(emails);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.replyMarkup, protect_content: true });
      return;
    }
    await handleEmailAction(ctx, deps, action.id, action.action, composeDeps, aiDeps);
  });

  // Any other text: an in-progress compose wizard first, then a pending
  // P7 prompt (signature, provider key), then a pending search query,
  // otherwise re-open the menu.
  bot.on('message:text', async (ctx) => {
    if (composeDeps && (await handleComposeText(ctx, composeDeps))) return;
    if (fullStore) {
      const backToSettings = (c: Context) => showSettings(c, deps);
      if (
        await handleSignatureText(ctx, {
          store: fullStore,
          domains: deps.settings.domains,
          backToSettings,
        })
      )
        return;
      if (
        await handleProviderKeyText(ctx, {
          store: fullStore,
          providerName: deps.settings.providerName,
          backToSettings,
        })
      )
        return;
    }
    const chatId = trackChat(ctx);
    if (chatId !== undefined && pendingSearch.has(chatId) && deps.search) {
      pendingSearch.delete(chatId);
      const query = ctx.message.text;
      const results = deps.search.searchEmails(deps.search.parseSearch(query), { limit: 10 });
      const view = buildSearchResults(query, results);
      await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.replyMarkup, protect_content: true });
      return;
    }
    await ctx.reply(t('bot.welcome.body'), withMenu);
  });

  // Documents only matter to the compose wizard's attachment step.
  bot.on('message:document', async (ctx) => {
    if (composeDeps) await handleComposeDocument(ctx, composeDeps);
  });

  // Reactions as quick actions: a thumbs-up on a bot email message
  // archives that email. The owner guard above already filters updates;
  // the handler verifies the sender again explicitly.
  bot.on('message_reaction', async (ctx) => {
    if (!deps.fullStore) return;
    // A reaction-archive is a manual archive like any other: when it
    // contradicts an AI triage, the correction is learned.
    const seams = withCorrectionTracking(
      reactionStoreSeams(deps.fullStore),
      deps.fullStore,
      deps.logger,
      deps.llm != null,
    );
    await handleMessageReaction(ctx, {
      ownerId: deps.settings.ownerId,
      setArchived: seams.setArchived,
      emailIdForMessage: seams.emailIdForMessage,
      logger: deps.logger,
    });
  });

  return bot;
}
