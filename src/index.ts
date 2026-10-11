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

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadConfig, type PostwispConfig } from './core/config.js';
import { createLogger, type Logger } from './core/logger.js';
import { t } from './core/i18n.js';
import { openStore, type EmailMeta } from './core/store.js';
import { dueSnoozed, unsnoozeEmail, extractOtp } from './core/inbox.js';
import { createServer } from './server/index.js';
import { registerResendWebhook } from './server/resend-webhook.js';
import { registerMailerSendWebhook } from './server/mailersend-webhook.js';
import { registerMailgunWebhook } from './server/mailgun-webhook.js';
import { readStashedAttachment as readProviderStashedAttachment } from './server/attachment-stash.js';
import { registerCloudflareIngest, readStashedAttachment } from './server/cloudflare-ingest.js';
import { registerTelegramWebhook } from './server/telegram-webhook.js';
import { registerUnsubscribe } from './server/unsubscribe.js';
import { registerWebapp } from './server/webapp.js';
import { createBot, type AttachmentFetch } from './bot/index.js';
import { escapeHtml } from './bot/views.js';
import { adaptStore, adaptSearch, toEmailEvent } from './bot/store-adapter.js';
import { createInboundHandler } from './bot/inbound.js';
import { processDueScheduled, type ComposeDeps } from './bot/compose.js';
import { createDeliveryHandler } from './bot/delivery.js';
import { createSendQueue, type SendQueue } from './bot/queue.js';
import { buildNotification } from './bot/notify.js';
import { buildDigestMessages, takeDigestQueue, startDigestScheduler } from './bot/digest.js';
import { llmFromConfig } from './core/llm.js';
import { runNudgeCheck, withCorrectionTracking } from './bot/ai-actions.js';
import { ResendEmailProvider } from './providers/resend.js';
import { MailerSendProvider } from './providers/mailersend.js';
import { MailgunProvider } from './providers/mailgun.js';
import type { EmailEvent, EmailProvider, SendInput, SendResult } from './providers/interface.js';
import type { Update } from 'grammy/types';
import type { InlineKeyboard } from 'grammy';

export interface SystemHandle {
  port: number;
  stop: () => Promise<void>;
}

// The configured provider adapter, or null when its API key is missing.
// Downstream code programs against the EmailProvider interface only.
function createProviderByName(
  name: 'resend' | 'mailersend' | 'mailgun',
  apiKey: string,
): EmailProvider | null {
  switch (name) {
    case 'mailersend':
      return apiKey ? new MailerSendProvider({ apiKey }) : null;
    case 'mailgun':
      return apiKey ? new MailgunProvider({ apiKey }) : null;
    default:
      return apiKey ? new ResendEmailProvider({ apiKey }) : null;
  }
}

function createEmailProvider(config: PostwispConfig): EmailProvider | null {
  switch (config.emailProvider) {
    case 'mailersend':
      return createProviderByName('mailersend', config.mailersendApiKey ?? '');
    case 'mailgun':
      return createProviderByName('mailgun', config.mailgunApiKey ?? '');
    default:
      return createProviderByName('resend', config.resendApiKey ?? '');
  }
}

// Starts every component: HTTP server always, Telegram bot only when a token
// and owner are configured. Missing bot credentials warn instead of crashing
// so `pnpm dev` stays usable before setup.
export async function startSystem(
  config: PostwispConfig,
  logger: Logger,
  deps?: { telegramFetch?: typeof fetch },
): Promise<SystemHandle> {
  const store = openStore(join(config.dataDir, 'postwisp.db'));
  const serverLogger = logger.child({ component: 'server' });
  const server = createServer({ logger: serverLogger });
  // Routes are registered throughout this function; Fastify forbids adding
  // routes once listening, so listen only after everything is registered.

  const provider = createEmailProvider(config);

  // P8 AI (opt-in, BYOK): null without a configured key, which keeps every
  // AI path — triage, smart replies, nudges, UI buttons — fully inert.
  const llm = llmFromConfig(config);

  // Extra provider API keys from the store: one adapter per key, built
  // against the same frozen EmailProvider interface as the default. The
  // compose wizard offers them in its sending-identity picker.
  const keyAdapters = new Map<number, EmailProvider>();
  for (const row of store.listProviderKeys(config.emailProvider)) {
    const adapter = createProviderByName(config.emailProvider, row.apiKey);
    if (adapter) {
      keyAdapters.set(row.id, adapter);
    } else {
      logger.warn('provider key skipped: empty key value', { keyId: row.id });
    }
  }

  const botLogger = logger.child({ component: 'bot' });
  const ownerId = config.ownerId;
  let queue: SendQueue | null = null;
  let stopBot: (() => Promise<void>) | null = null;
  let botStarted = false;
  let startTelegramTransport: (() => Promise<void>) | null = null;
  const stopTimers: Array<() => void> = [];
  // Delivery webhooks map provider events onto the sent log and the chat
  // message that confirmed the send. Created with the bot; null without one.
  let onDelivery:
    | ((ev: import('./server/resend-webhook.js').DeliveryEvent) => Promise<void>)
    | null = null;

  if (config.botToken) {
    // Pairing mode: with no owner yet the bot still starts so the /start
    // <token> deep link can bind one. The owner guard drops everything
    // else; anything needing an owner (queue, timers, delivery edits) is
    // skipped until pairing completes and the process restarts.
    const pairingMode = ownerId === null;
    if (pairingMode) {
      logger.warn('bot started in pairing mode: run `postwisp pair` and open the link to bind the owner');
    }
    const bot = createBot({
      token: config.botToken,
      logger: botLogger,
      ...(deps?.telegramFetch ? { apiFetch: deps.telegramFetch } : {}),
      settings: { ownerId, providerName: provider?.name ?? 'resend', domains: config.domains, publicUrl: config.publicUrl, aiEnabled: llm !== null },
      store: withCorrectionTracking(adaptStore(store), store, botLogger, llm !== null),
      search: adaptSearch(store),
      extractOtp,
      // P8 AI (opt-in): without a key this stays unset and every AI path
      // in the bot stays inert.
      ...(llm ? { llm } : {}),
      nudgeDays: config.nudgeDays,
      // listSent is optional on BotDeps; only present when a provider exists.
      ...(provider
        ? {
            listSent: async (domain?: string) => {
              const opts: { domain?: string; limit?: number } = { limit: 20 };
              if (domain !== undefined) opts.domain = domain;
              return (await provider.listSentEmails(opts)).map((s) => ({
                id: s.id,
                to: s.to[0] ?? '',
                subject: s.subject,
                dateMs: s.dateMs,
                status: s.status,
              }));
            },
          }
        : {}),
      // Attachments are fetched fresh at tap time: signed URLs expire, so
      // the stored row carries metadata only. Mail that arrived through
      // the Cloudflare worker has no provider URL to fetch from; its
      // bytes were stashed in kv at ingest time, so that is checked first.
      // 20 MB is Telegram's bot limit.
      ...(provider || config.cloudflareIngestSecret
        ? {
            downloadAttachment: async (
              emailId: string,
              attachmentId: string,
            ): Promise<AttachmentFetch> => {
              const stashed = readStashedAttachment(store, emailId, attachmentId);
              if (stashed.found) {
                return { ok: true, filename: stashed.filename, data: stashed.data };
              }
              if (stashed.reason === 'too_large') return { ok: false, reason: 'too_large' };
              // Mail that arrived through a provider inbound route (MailerSend
              // forwards, Mailgun body-mime) carries inline attachment bytes
              // stashed under the provider's namespace at ingest time.
              if (provider) {
                const providerStashed = readProviderStashedAttachment(
                  store,
                  provider.name,
                  emailId,
                  attachmentId,
                );
                if (providerStashed.found) {
                  return {
                    ok: true,
                    filename: providerStashed.filename,
                    data: providerStashed.data,
                  };
                }
                if (providerStashed.reason === 'too_large') return { ok: false, reason: 'too_large' };
              }
              if (!provider) return { ok: false, reason: 'missing' };
              const inbound = await provider.getInboundEmail(emailId).catch(() => null);
              const att = inbound?.attachments.find((a) => a.id === attachmentId);
              if (!att) return { ok: false, reason: 'missing' };
              if (att.size > 20 * 1024 * 1024) return { ok: false, reason: 'too_large' };
              try {
                const data = await provider.downloadAttachment(att.downloadUrl);
                return { ok: true, filename: att.filename, data };
              } catch {
                return { ok: false, reason: 'failed' };
              }
            },
            ...(provider ? { sendEmail: (input: SendInput) => provider.send(input) } : {}),
          }
        : {}),
      // Multi-key sending: the compose wizard picks a key per send; without
      // extra keys every send keeps going through the single-key path.
      ...(keyAdapters.size > 0
        ? {
            sendEmailWithKey: async (keyId: number, input: SendInput): Promise<SendResult> => {
              const adapter = keyAdapters.get(keyId);
              if (!adapter) throw new Error(`unknown provider key: ${keyId}`);
              return adapter.send(input);
            },
          }
        : {}),
      fullStore: store,
      // Compose declares a queue seam but never reads it; null is fine.
      queue: null,
      // Non-personal sends carry the unsubscribe footer and RFC 8058
      // headers; the signing secret doubles as the one-click token key.
      compliance: {
        publicUrl: config.publicUrl,
        secret: config.webhookSecret,
        physicalAddress: config.physicalAddress,
      },
      // GDPR Art. 17: wipe every user-data row, then truncate the log file.
      wipeData: () => {
        store.wipeAllData();
        if (config.logFile) {
          try {
            writeFileSync(config.logFile, '', { mode: 0o600 });
          } catch {
            // Best effort: the database wipe above is the binding part.
          }
        }
      },
    });

    // The queue, delivery edits and all timers need an owner; in pairing
    // mode they wait for the restart after /start binds one.
    if (ownerId !== null) {
      queue = createSendQueue(async (req) => {
        const markup = req.extra?.replyMarkup as InlineKeyboard | undefined;
        const msg = await bot.api.sendMessage(ownerId, req.text, {
          parse_mode: 'HTML',
          protect_content: true,
          ...(markup ? { reply_markup: markup } : {}),
        });
        // Reaction quick-actions resolve the message back to the email:
        // record the mapping while the message id is in hand. A mapping
        // failure must never retry the send, so it is caught here.
        const emailId = req.extra?.notifyEmailId;
        if (typeof emailId === 'string' && emailId.length > 0 && typeof msg.message_id === 'number') {
          try {
            store.noteSentMessage(msg.message_id, emailId);
          } catch (err) {
            botLogger.warn('failed to record sent-message mapping', {
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }, botLogger);
    }

    const useTelegramWebhook = !!(config.telegramWebhookPath && config.telegramWebhookSecret);
    if (useTelegramWebhook) {
      // Production: Telegram pushes updates to us; never poll and serve.
      registerTelegramWebhook(server, {
        path: config.telegramWebhookPath as string,
        secretToken: config.telegramWebhookSecret as string,
        handleUpdate: (update) => bot.handleUpdate(update as Update),
      });
      logger.info('bot serving via webhook');
    }
    // Transport activation (setWebhook / deleteWebhook / polling) happens
    // after server.listen below: Telegram must not push updates before the
    // route exists.
    startTelegramTransport = async (): Promise<void> => {
      if (useTelegramWebhook) {
        // The route above is useless until Telegram knows the URL: register
        // it on every startup so a changed publicUrl or path self-heals.
        const webhookUrl = config.publicUrl ? config.publicUrl + config.telegramWebhookPath : null;
        if (webhookUrl) {
          try {
            await bot.api.setWebhook(webhookUrl, { secret_token: config.telegramWebhookSecret as string });
            logger.info('telegram webhook registered', { url: webhookUrl });
          } catch (err) {
            logger.error('telegram setWebhook failed: no updates will arrive until it succeeds', {
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          logger.error(
            'telegram webhook route is up but publicUrl is not set: cannot register with Telegram, no updates will arrive',
          );
        }
      } else {
        // Polling in dev; production deployments use webhooks instead. Clear a
        // stale webhook first: while one is set, getUpdates receives nothing.
        try {
          await bot.api.deleteWebhook();
        } catch (err) {
          logger.warn('could not clear a stale telegram webhook: polling may receive nothing', {
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        botStarted = true;
        bot.start().catch((error: unknown) => {
          botLogger.error('bot failed to start', {
            detail: error instanceof Error ? error.message : String(error),
          });
        });
        logger.info('bot started', { mode: 'polling' });
      }
    };
    stopBot = async () => {
      // Webhook mode never calls bot.start(): stopping a never-started bot
      // throws, so only stop what was started.
      if (botStarted) await bot.stop();
    };

    if (ownerId !== null) {
      const activeQueue: SendQueue = queue as SendQueue;
      // The status line the delivery handler appends is pre-escaped HTML, so
      // the edit must be parsed as HTML.
      const delivery = createDeliveryHandler({
        store,
        logger: botLogger,
        api: {
          editMessageText: async (chatId, messageId, text) => {
            await bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' });
          },
        },
        queue: activeQueue,
        ownerId,
      });
      onDelivery = (ev) => delivery.handleDelivery(ev);
      const digestMode = store.get('digest_mode');
      if (digestMode === 'hourly' || digestMode === 'daily') {
        const scheduler = startDigestScheduler({
          mode: digestMode,
          hour: Number(store.get('digest_hour') ?? 8),
          onFire: () => {
            const ids = takeDigestQueue(store);
            if (ids.length === 0) return;
            const emails = ids
              .map((id) => store.getEmailMeta(id))
              .filter((m): m is EmailMeta => m !== null)
              .filter((m) => {
                // Ids ride in callback_data (64-byte Telegram limit) and cb()
                // throws on overflow; a throw here would escape the timer and
                // crash the process. Skip loudly instead — the email stays in
                // the store and remains reachable via search.
                if (Buffer.byteLength(`e:${m.id}`, 'utf8') > 64) {
                  logger.warn('digest skipped email with over-long id', { emailId: m.id });
                  return false;
                }
                return true;
              })
              .map((m) => {
                const e: { id: string; fromAddr: string; fromName?: string; subject: string } = {
                  id: m.id,
                  fromAddr: m.fromAddr,
                  subject: m.subject,
                };
                if (m.fromName !== undefined) e.fromName = m.fromName;
                return e;
              });
            for (const msg of buildDigestMessages(emails)) {
              activeQueue.enqueue(ownerId, {
                text: msg.text,
                extra: {
                  replyMarkup: msg.replyMarkup,
                  parseMode: 'HTML',
                  protectContent: msg.protectContent,
                },
              });
            }
          },
        });
        stopTimers.push(() => scheduler.stop());
      }

      const snoozeTimer = setInterval(() => {
        for (const meta of dueSnoozed(store, Date.now())) {
          unsnoozeEmail(store, meta.id);
          let notif;
          try {
            notif = buildNotification(toEmailEvent(meta), { extractOtp });
          } catch (err) {
            // Same over-long-id guard as the digest drain: never let one bad
            // email crash the timer loop.
            logger.warn('snooze notify skipped email', { emailId: meta.id, err });
            continue;
          }
          activeQueue.enqueue(ownerId, {
            text: notif.text,
            extra: {
              replyMarkup: notif.replyMarkup,
              parseMode: notif.parseMode,
              protectContent: notif.protectContent,
            },
          });
        }
      }, 60_000);
      stopTimers.push(() => clearInterval(snoozeTimer));

      // Scheduled sends are checked every 30s; due ones go out through the
      // same provider send path as manual composes.
      if (provider) {
        const activeProvider = provider;
        const composeDeps: ComposeDeps = {
          store,
          logger: botLogger,
          queue: null,
          ownerId,
          domains: config.domains,
          sendEmail: (input: SendInput) => activeProvider.send(input),
          compliance: {
            publicUrl: config.publicUrl,
            secret: config.webhookSecret,
            physicalAddress: config.physicalAddress,
          },
        };
        const scheduleTimer = setInterval(() => {
          processDueScheduled(composeDeps).catch((err: unknown) => {
            logger.error('scheduled send run failed', { err: String(err) });
          });
        }, 30_000);
        stopTimers.push(() => clearInterval(scheduleTimer));
      }

      // P8 follow-up nudges: once a day, sent mail old enough to expect a
      // reply but still silent gets the owner a snooze/dismiss nudge.
      // Gated on the LLM key like every other P8 path: without it no
      // scheduler work runs at all.
      if (llm) {
        const nudgeScheduler = startDigestScheduler({
          mode: 'daily',
          hour: 9,
          onFire: () => {
            runNudgeCheck({
              store,
              logger: botLogger,
              queue: activeQueue,
              ownerId,
              nudgeDays: config.nudgeDays,
            }).catch((err: unknown) => {
              logger.error('nudge check failed', { err: String(err) });
            });
          },
        });
        stopTimers.push(() => nudgeScheduler.stop());
      }
    }
  } else {
    logger.warn('bot not started: set a bot token first, then run `postwisp pair` to bind the owner');
  }

  const inbound = createInboundHandler({
    store,
    logger,
    queue,
    ownerId,
    // Auto-reply rules only send when a provider exists; otherwise the
    // owner still gets the "rule wanted to reply" notice.
    ...(provider ? { sendEmail: (input: SendInput) => provider.send(input) } : {}),
    // P8 AI triage (opt-in): without a key this stays unset and triage is
    // fully inert.
    ...(llm ? { ai: { llm } } : {}),
  });

  if (provider && config.webhookSecret) {
    const activeProvider = provider;
    // Security alerts are throttled: a probing attacker must not be able to
    // turn rejected webhooks into a notification flood for the owner.
    let lastSecurityAlert = 0;
    const onSecurityAlert = (text: string): void => {
      const now = Date.now();
      if (now - lastSecurityAlert < 3600_000 || !queue || ownerId === null) return;
      lastSecurityAlert = now;
      queue.enqueue(ownerId, { text });
    };
    const webhookDeps = {
      provider: activeProvider,
      secret: config.webhookSecret,
      hasWebhookEvent: (id: string) => store.hasWebhookEvent(id),
      noteWebhookEvent: (id: string) => store.noteWebhookEvent(id),
      onEvent: (ev: EmailEvent) => inbound.handleEmailEvent(ev),
      // Delivery events update the sent log and the confirmation message.
      ...(onDelivery ? { onDelivery } : {}),
      onSecurityAlert,
      logger: serverLogger,
    };
    // The route is provider-specific (signature scheme, payload shape), but
    // everything downstream of it (onEvent/onDelivery) is provider-agnostic.
    switch (activeProvider.name) {
      case 'mailersend':
        registerMailerSendWebhook(server, { ...webhookDeps, store });
        break;
      case 'mailgun':
        registerMailgunWebhook(server, { ...webhookDeps, store });
        break;
      default:
        registerResendWebhook(server, webhookDeps);
    }
  } else {
    logger.warn(
      'provider webhook not registered: set the email provider API key and webhook secret first',
    );
  }

  // The RFC 8058 one-click endpoint the unsubscribe footers point at.
  // The webhook signing secret mints and verifies the per-recipient
  // tokens; without it no token can exist, so the route stays unregistered.
  if (config.webhookSecret) {
    const unsubSecret = config.webhookSecret;
    registerUnsubscribe(server, {
      secret: unsubSecret,
      store,
      logger: serverLogger,
      onUnsubscribe: (email) => {
        if (queue && ownerId !== null) {
          queue.enqueue(ownerId, {
            text: t('bot.unsubscribe.oneClick', { email: escapeHtml(email) }),
            extra: { protectContent: true },
          });
        }
      },
    });
    logger.info('unsubscribe endpoint registered', {});
  }

  // The Web App inbox: read and archive only, no settings or compose. The
  // bot token verifies Telegram initData on every API call; without it the
  // routes stay unregistered.
  if (config.botToken) {
    registerWebapp(server, { store, botToken: config.botToken, logger: serverLogger });
    logger.info('webapp inbox registered', {});
  }

  // The Cloudflare companion worker is an independent inbound path: it
  // needs the shared signing secret but no Resend provider.
  if (config.cloudflareIngestSecret) {
    registerCloudflareIngest(server, {
      secret: config.cloudflareIngestSecret,
      hasWebhookEvent: (id: string) => store.hasWebhookEvent(id),
      noteWebhookEvent: (id: string) => store.noteWebhookEvent(id),
      onEvent: (ev) => inbound.handleEmailEvent(ev),
      logger: serverLogger,
      store,
    });
    logger.info('cloudflare ingest registered', {});
  } else {
    logger.warn('cloudflare ingest not registered: set the Cloudflare ingest secret first');
  }

  await server.listen({ port: config.serverPort, host: config.serverHost });
  logger.info('server listening', { host: config.serverHost, port: config.serverPort });

  if (startTelegramTransport) await startTelegramTransport();

  return {
    port: (server.server.address() as { port: number }).port,
    stop: async () => {
      for (const stopTimer of stopTimers) stopTimer();
      if (stopBot) await stopBot();
      if (queue) queue.stop();
      await server.close();
      store.close();
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = [
    config.botToken,
    config.resendApiKey,
    config.mailersendApiKey,
    config.mailgunApiKey,
    config.webhookSecret,
    config.telegramWebhookSecret,
    config.cloudflareIngestSecret,
    config.llmApiKey,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);
  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: secrets,
    // The file appender is 0600; `postwisp logs` reads this path.
    ...(config.logFile ? { filePath: config.logFile } : {}),
  });

  const system = await startSystem(config, logger);

  const shutdown = async () => {
    logger.info('shutting down');
    await system.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
