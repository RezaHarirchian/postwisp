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

// Button-driven compose, drafts, scheduled sends, templates, and the
// test-mode flag. The coordinator owns the bot instance and routes updates
// here: startCompose from the Compose menu button, handleComposeCallback
// for `c:` callback data, handleComposeText for wizard replies, and
// handleComposeDocument for attachments. Wizard state lives per chat in a
// module-level map because the coordinator creates one handler set.

import { randomUUID } from 'node:crypto';
import { InlineKeyboard, type Context } from 'grammy';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import type { SendQueue } from './queue.js';
import type { SendInput, SendResult } from '../providers/interface.js';
import { t } from '../core/i18n.js';
import { buildReplyInput } from './delivery.js';
import { withUnsubscribe, type UnsubscribeConfig } from '../core/unsubscribe.js';
import {
  addTemplate,
  applyTemplateVars,
  deleteTemplate,
  isTestMode,
  listIdentities,
  listTemplates,
  loadCaps,
  setTestMode,
  type CapsApi,
} from '../core/templates.js';

export { isTestMode, setTestMode };

export interface ComposeDeps {
  store: Store;
  logger: Logger;
  queue: SendQueue | null;
  ownerId: number | null;
  domains: string[];
  sendEmail: (input: SendInput) => Promise<SendResult>;
  // Per-key senders, built by the coordinator from the provider_keys table.
  // Unset means every send goes through sendEmail (the config-key default).
  sendEmailWithKey?: (keyId: number, input: SendInput) => Promise<SendResult>;
  // The active provider name, used to filter provider_keys. Unset means no
  // key picker is offered.
  providerName?: string;
  // Builds the unsubscribe footer and one-click headers for non-personal
  // sends. Unset (tests, unwired runs) means no footer is added.
  compliance?: UnsubscribeConfig;
}

// Telegram bots cannot receive files larger than 20 MB, so there is no
// point accepting anything bigger as an attachment.
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
// Above this many recipients a send is bulk mail, with the reputation and
// consent obligations that come with it.
const BULK_RECIPIENT_THRESHOLD = 10;
// Batch sends are hard-capped here: enforced in the To step and again in
// deliver(), so no code path can exceed it.
const BATCH_MAX_RECIPIENTS = 100;
// Scheduling further out than this is a typo or a mistake, not a plan.
const MAX_SCHEDULE_AHEAD_MS = 30 * 86400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A batch is a bulk send big enough to need the batch UI: no attachments,
// a transactional-only warning, and explicit two-step confirmation.
function isBatch(to: string[]): boolean {
  return to.length > BULK_RECIPIENT_THRESHOLD;
}

type Step =
  | 'key'
  | 'identity'
  | 'to'
  | 'subject'
  | 'body'
  | 'attach-choice'
  | 'attach-wait'
  | 'confirm'
  | 'batchreview'
  | 'schedule-when'
  | 'schedule-custom'
  | 'tpl-name'
  | 'tpl-subject'
  | 'tpl-body';

interface ComposeState {
  step: Step;
  // Stable per wizard session: manual sends use it as the idempotency key,
  // so a double-tapped Send button (or a retried callback_query) resumes
  // the same send instead of delivering the email twice.
  id: string;
  identity: string;
  // Extra provider key from the picker; null means the config-key default.
  keyId: number | null;
  to: string[];
  subject: string;
  body: string;
  attachments: Array<{ filename: string; content: Buffer }>;
  editingDraftId: number | null;
  templateDraft: { name: string; subject: string } | null;
  // Threading headers for replies; empty for fresh composes.
  extraHeaders: Record<string, string>;
}

const states = new Map<number, ComposeState>();

// A wizard left behind by tapping another menu must not swallow the next
// text message (the search query, say); menus clear it on the way out.
export function clearComposeState(chatId: number): void {
  states.delete(chatId);
}

function chatIdOf(ctx: Context): number | undefined {
  return ctx.chat?.id;
}

function newState(): ComposeState {
  return {
    step: 'identity',
    id: randomUUID(),
    identity: '',
    keyId: null,
    to: [],
    subject: '',
    body: '',
    attachments: [],
    editingDraftId: null,
    templateDraft: null,
    extraHeaders: {},
  };
}

function homeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t('bot.compose.new'), 'c:new')
    .text(t('bot.compose.drafts'), 'c:drafts')
    .row()
    .text(t('bot.compose.scheduled'), 'c:schedlist')
    .text(t('bot.compose.templates'), 'c:tmpl');
}

async function showHome(ctx: Context, deps: ComposeDeps): Promise<void> {
  const banner = isTestMode(deps.store) ? `${t('bot.testmode.banner')}\n\n` : '';
  await ctx.reply(`${banner}${t('bot.compose.title')}\n${t('bot.compose.home')}`, {
    reply_markup: homeKeyboard(),
  });
}

function identitiesOrNone(deps: ComposeDeps): string[] {
  return listIdentities(deps.store, deps.domains);
}

async function askTo(ctx: Context, deps: ComposeDeps, state: ComposeState): Promise<void> {
  state.step = 'to';
  const hint = isTestMode(deps.store) ? `\n${t('bot.testmode.toHint')}` : '';
  const text = `${t('bot.compose.promptTo')}${hint}`;
  const templates = listTemplates(deps.store);
  if (templates.length > 0) {
    await ctx.reply(text, {
      reply_markup: new InlineKeyboard().text(t('bot.compose.useTemplate'), 'c:usetmpl'),
    });
    return;
  }
  await ctx.reply(text, { reply_markup: { force_reply: true } });
}

async function afterRecipients(ctx: Context, state: ComposeState): Promise<void> {
  // A template may already have filled subject and body; skip whatever is
  // already there instead of asking again.
  if (state.subject === '') {
    state.step = 'subject';
    await ctx.reply(t('bot.compose.promptSubject'), { reply_markup: { force_reply: true } });
    return;
  }
  await afterSubject(ctx, state);
}

async function afterSubject(ctx: Context, state: ComposeState): Promise<void> {
  if (state.body === '') {
    state.step = 'body';
    await ctx.reply(t('bot.compose.promptBody'), { reply_markup: { force_reply: true } });
    return;
  }
  await askAttachChoice(ctx, state);
}

async function offerTemplates(ctx: Context, deps: ComposeDeps): Promise<void> {
  const templates = listTemplates(deps.store);
  if (templates.length === 0) {
    await ctx.reply(t('bot.compose.noTemplates'));
    return;
  }
  const kb = new InlineKeyboard();
  templates.forEach((tpl, i) => {
    kb.text(tpl.name, `c:tpl:${i}`).row();
  });
  kb.text(t('bot.compose.back'), 'c:back');
  await ctx.reply(t('bot.compose.pickTemplate'), { reply_markup: kb });
}

async function askAttachChoice(ctx: Context, state: ComposeState): Promise<void> {
  // Batch sends never carry attachments: multi-recipient mail with files
  // attached reads as bulk abuse to providers. The rule is enforced again
  // in deliver(), so a state built any other way is blocked too.
  if (isBatch(state.to)) {
    await showConfirm(ctx, state);
    return;
  }
  state.step = 'attach-choice';
  const kb = new InlineKeyboard()
    .text(t('bot.compose.attach'), 'c:attach')
    .text(t('bot.compose.skip'), 'c:skipattach');
  await ctx.reply(t('bot.compose.attachQuestion'), { reply_markup: kb });
}

// The confirm screen always shows the substituted text: what the owner
// sees here is what the recipient gets. (For scheduled sends {{date}}
// resolves at fire time, so the date shown here is today's, not the
// fire date — the one moving part.)
async function showConfirm(ctx: Context, state: ComposeState): Promise<void> {
  state.step = 'confirm';
  const batch = isBatch(state.to);
  const { subject, body } = substituted(state);
  const lines = [
    t('bot.compose.confirmTitle'),
    '',
    t('bot.compose.from', { identity: state.identity }),
    // The batch review screen carries the full list; the confirm screen
    // stays compact with just the count.
    batch
      ? t('bot.compose.toBatch', { count: state.to.length })
      : t('bot.compose.to', { to: state.to.join(', ') }),
    t('bot.compose.subject', { subject }),
    '',
    t('bot.compose.body'),
    body.length > 1000 ? `${body.slice(0, 1000)}…` : body,
  ];
  if (state.attachments.length > 0) {
    lines.push('', `Attachments: ${state.attachments.map((a) => a.filename).join(', ')}`);
  }
  // Bulk mail has reputation consequences the owner should see before
  // tapping Send; the confirm screen is the last chance to back out.
  if (state.to.length > BULK_RECIPIENT_THRESHOLD) {
    lines.push('', t('bot.compose.bulkWarn', { count: state.to.length }));
  }
  // Batch sends get their own warning and a two-step confirmation: the
  // review screen lists every recipient, and only the button there sends.
  if (batch) {
    lines.push('', t('bot.compose.batchWarn', { count: state.to.length }));
  }
  const kb = new InlineKeyboard();
  if (batch) {
    kb.text(t('bot.compose.reviewRecipients'), 'c:batchreview').row();
  } else {
    kb.text(t('bot.compose.send'), 'c:send');
  }
  kb.text(t('bot.compose.saveDraft'), 'c:savedraft')
    .row()
    .text(t('bot.compose.schedule'), 'c:schedule')
    .text(t('bot.compose.cancel'), 'c:cancel');
  await ctx.reply(lines.join('\n'), { reply_markup: kb, protect_content: true });
}

// The second batch step: the full recipient list for review, the warning
// again, and the only button that actually sends. The list is chunked so a
// hundred long addresses cannot push one message past Telegram's limit.
async function showBatchReview(ctx: Context, state: ComposeState): Promise<void> {
  state.step = 'batchreview';
  const perChunk = 50;
  for (let i = 0; i < state.to.length; i += perChunk) {
    const lines = [t('bot.compose.batchReviewTitle', { count: state.to.length }), ''];
    state.to.slice(i, i + perChunk).forEach((addr, j) => {
      lines.push(t('bot.compose.batchItem', { n: i + j + 1, address: addr }));
    });
    await ctx.reply(lines.join('\n'), { protect_content: true });
  }
  const kb = new InlineKeyboard()
    .text(t('bot.compose.sendBatch', { count: state.to.length }), 'c:batchsend')
    .row()
    .text(t('bot.compose.back'), 'c:back');
  await ctx.reply(t('bot.compose.batchWarn', { count: state.to.length }), {
    reply_markup: kb,
    protect_content: true,
  });
}

async function listTemplatesFlow(ctx: Context, deps: ComposeDeps): Promise<void> {
  const templates = listTemplates(deps.store);
  const kb = new InlineKeyboard();
  templates.forEach((tpl, i) => {
    kb.text(`${tpl.name} — ${t('bot.template.delete')}`, `c:tdel:${i}`).row();
  });
  kb.text(t('bot.template.add'), 'c:tadd').row();
  kb.text(t('bot.compose.back'), 'c:home');
  const text = templates.length === 0 ? t('bot.template.empty') : t('bot.template.title');
  await ctx.reply(text, { reply_markup: kb });
}

async function listScheduledFlow(ctx: Context, deps: ComposeDeps): Promise<void> {
  const rows = deps.store.listScheduled().slice(0, 10);
  if (rows.length === 0) {
    await ctx.reply(t('bot.schedule.empty'), { reply_markup: homeKeyboard() });
    return;
  }
  await ctx.reply(t('bot.schedule.title'), { reply_markup: homeKeyboard() });
  for (const s of rows) {
    const kb = new InlineKeyboard().text(t('bot.schedule.cancel'), `c:schcancel:${s.id}`);
    // Shown as the recipient will see it: {{date}} resolved against the
    // scheduled fire date.
    const { subject } = resolveScheduledVars(s, s.sendAtMs);
    await ctx.reply(
      t('bot.schedule.item', { when: fmtLocal(s.sendAtMs), to: s.to.join(', '), subject }),
      { reply_markup: kb, protect_content: true },
    );
  }
}

async function finalizeSchedule(
  ctx: Context,
  deps: ComposeDeps,
  chatId: number,
  state: ComposeState,
  sendAtMs: number,
): Promise<void> {
  // Stored raw: {{date}} is fire-time data and is resolved when the row
  // fires (or against its fire date for display), never when the owner
  // taps Schedule — a send scheduled days out must not carry today's date.
  deps.store.scheduleSend({
    to: state.to,
    subject: state.subject,
    body: state.body,
    identity: state.identity,
    sendAtMs,
  });
  if (state.editingDraftId !== null) deps.store.deleteDraft(state.editingDraftId);
  states.delete(chatId);
  await ctx.reply(t('bot.schedule.scheduled', { when: fmtLocal(sendAtMs) }));
}

// Resolves template variables against a fire time instead of now.
// {{to}} and {{subject}} come from the stored row; only {{date}} moves.
function resolveScheduledVars(
  s: { to: string[]; subject: string; body: string },
  atMs: number,
): { subject: string; body: string } {
  const to = s.to.join(', ');
  const date = new Date(atMs).toISOString().slice(0, 10);
  const subject = applyTemplateVars(s.subject, { to, date });
  const body = applyTemplateVars(s.body, { to, date, subject });
  return { subject, body };
}

function parseCustomTime(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, ys, mos, ds, hs, mis] = m as unknown as [string, string, string, string, string, string];
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  // Reject impossible dates like February 30, which the Date constructor
  // silently rolls over.
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date.getTime();
}

async function listDraftsFlow(ctx: Context, deps: ComposeDeps): Promise<void> {
  const drafts = deps.store.listDrafts().slice(0, 10);
  if (drafts.length === 0) {
    await ctx.reply(t('bot.draft.empty'), { reply_markup: homeKeyboard() });
    return;
  }
  await ctx.reply(t('bot.draft.title'), { reply_markup: homeKeyboard() });
  for (const d of drafts) {
    const kb = new InlineKeyboard()
      .text(t('bot.draft.open'), `c:dopen:${d.id}`)
      .text(t('bot.draft.send'), `c:dsend:${d.id}`)
      .text(t('bot.draft.delete'), `c:ddel:${d.id}`);
    // Draft content is the owner's own email text; keep it off screenshots.
    await ctx.reply(`${fmtLocal(d.updatedAt)}\n${t('bot.draft.item', { to: d.to.join(', '), subject: d.subject })}`, {
      reply_markup: kb,
      protect_content: true,
    });
  }
}

function fmtLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Template-style {{to}} / {{date}} / {{subject}} variables are resolved
// against the values the owner actually picked, so the confirm screen and
// the sent email always agree.
function substituted(state: ComposeState): { subject: string; body: string } {
  const to = state.to.join(', ');
  const date = new Date().toISOString().slice(0, 10);
  const subject = applyTemplateVars(state.subject, { to, date });
  const body = applyTemplateVars(state.body, { to, date, subject });
  return { subject, body };
}

export type DeliverResult =
  | { ok: true; id: string }
  | { ok: false; blocked: boolean; reason: string };

export interface DeliverInput {
  from: string;
  to: string[];
  subject: string;
  body: string;
  attachments?: SendInput['attachments'];
  idempotencyKey?: string;
  extraHeaders?: Record<string, string>;
  keyId?: number | null;
};

// One place where an outbound email leaves the bot: caps first, then the
// provider. Callers log the send and record it against the caps afterwards.
// The idempotency key is caller-chosen: scheduled sends pass a stable one
// so a retry after a lost response resumes the same send instead of
// delivering a duplicate.
async function deliver(
  deps: ComposeDeps,
  input: DeliverInput,
): Promise<DeliverResult> {
  // Code-level batch gates: the UI keeps attachments out of batch sends and
  // caps the recipient list, but every path that reaches deliver() —
  // drafts, scheduled rows, direct calls — is checked here too.
  if (input.to.length > BATCH_MAX_RECIPIENTS) {
    return {
      ok: false,
      blocked: true,
      reason: t('bot.compose.tooManyRecipients', { max: BATCH_MAX_RECIPIENTS }),
    };
  }
  if (isBatch(input.to) && input.attachments !== undefined && input.attachments.length > 0) {
    return { ok: false, blocked: true, reason: t('bot.compose.batchNoAttach') };
  }
  let caps: CapsApi;
  try {
    caps = await loadCaps();
  } catch (err) {
    // Fail closed: without the cap module the send would go out uncapped.
    deps.logger.error('send blocked: send-cap module failed to load', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, blocked: true, reason: 'send-limit check unavailable' };
  }
  const check = caps.checkSendCaps(deps.store, input.to);
  if (!check.ok) return { ok: false, blocked: true, reason: check.reason };
  // The selected identity's signature rides under the body, separated the
  // traditional way. It is added before the unsubscribe footer so the
  // footer stays the last thing the recipient sees.
  const signature = deps.store.getSignature(input.from);
  const body = signature ? `${input.body}\n\n-- \n${signature}` : input.body;
  let sendInput: SendInput = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: body,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
  };
  if (input.attachments !== undefined && input.attachments.length > 0) {
    sendInput.attachments = input.attachments;
  }
  if (input.extraHeaders !== undefined && Object.keys(input.extraHeaders).length > 0) {
    sendInput.headers = input.extraHeaders;
  }
  // Last, so the threading headers above are visible to the personal-reply
  // check: non-personal sends carry the unsubscribe footer and RFC 8058
  // headers, 1:1 replies pass through untouched.
  if (deps.compliance) {
    sendInput = withUnsubscribe(sendInput, deps.compliance);
  }
  // An explicitly picked provider key routes to that key's adapter; the
  // default (null) keeps the long-standing single-key send path.
  const sendEmail =
    input.keyId != null && deps.sendEmailWithKey
      ? (si: SendInput) => deps.sendEmailWithKey!(input.keyId as number, si)
      : deps.sendEmail;
  let result: SendResult;
  try {
    result = await sendEmail(sendInput);
  } catch (err) {
    return { ok: false, blocked: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, id: result.id };
}

async function afterDelivered(
  ctx: Context,
  deps: ComposeDeps,
  input: { from: string; to: string[]; subject: string },
  providerId: string,
  // Batch sends pass their own confirmation: the raw recipient list would
  // be a hundred addresses long.
  doneText?: string,
): Promise<void> {
  const msg = await ctx.reply(doneText ?? t('bot.compose.sent', { to: input.to.join(', ') }), {
    protect_content: true,
  });
  const domain = input.from.split('@')[1] ?? '';
  deps.store.logSent({
    providerId,
    to: input.to.join(', '),
    subject: input.subject,
    domain,
    chatId: deps.ownerId,
    messageId: msg?.message_id ?? null,
  });
  const caps = await loadCaps().catch((err: unknown) => {
    // The email already went out; a broken cap module must not fail the
    // user-visible flow, but it must be loud in the logs.
    deps.logger.error('send-cap record failed', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (caps) caps.recordSent(deps.store, input.to);
}

async function deliverFailure(ctx: Context, res: { blocked: boolean; reason: string }): Promise<void> {
  await ctx.reply(
    res.blocked ? t('bot.compose.capsBlocked', { reason: res.reason }) : t('bot.compose.sendFailed', { reason: res.reason }),
  );
}

// Sends a programmatic reply (P8 smart-reply approve) through the same
// path as a manual compose: caps, signature, compliance footer, sent log.
// Returns true when the mail went out.
export async function sendReplyEmail(
  ctx: Context,
  deps: ComposeDeps,
  input: {
    from: string;
    to: string[];
    subject: string;
    body: string;
    extraHeaders?: Record<string, string>;
    idempotencyKey?: string;
  },
): Promise<boolean> {
  const res = await deliver(deps, {
    from: input.from,
    to: input.to,
    subject: input.subject,
    body: input.body,
    ...(input.extraHeaders !== undefined ? { extraHeaders: input.extraHeaders } : {}),
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  if (!res.ok) {
    await deliverFailure(ctx, res);
    return false;
  }
  await afterDelivered(
    ctx,
    deps,
    { from: input.from, to: input.to, subject: input.subject },
    res.id,
  );
  return true;
}

async function beginWizard(ctx: Context, deps: ComposeDeps, chatId: number): Promise<void> {
  const identities = identitiesOrNone(deps);
  if (identities.length === 0) {
    await ctx.reply(t('bot.identity.none'));
    return;
  }
  const state = newState();
  states.set(chatId, state);
  // With extra provider keys configured, the sending-identity picker starts
  // by choosing which key the send goes out on; the config key stays the
  // default and needs no picker of its own.
  const keys = deps.providerName ? deps.store.listProviderKeys(deps.providerName) : [];
  if (keys.length > 0 && deps.sendEmailWithKey) {
    state.step = 'key';
    const kb = new InlineKeyboard().text(t('bot.compose.defaultKey'), 'c:key:def').row();
    for (const k of keys) {
      kb.text(k.label, `c:key:${k.id}`).row();
    }
    await ctx.reply(t('bot.compose.chooseKey'), { reply_markup: kb });
    return;
  }
  await askIdentity(ctx, deps, state);
}

async function askIdentity(ctx: Context, deps: ComposeDeps, state: ComposeState): Promise<void> {
  const identities = identitiesOrNone(deps);
  if (identities.length === 1) {
    state.identity = identities[0] as string;
    await askTo(ctx, deps, state);
    return;
  }
  state.step = 'identity';
  const kb = new InlineKeyboard();
  identities.forEach((id, i) => {
    kb.text(id, `c:id:${i}`).row();
  });
  await ctx.reply(t('bot.compose.chooseIdentity'), { reply_markup: kb });
}

export async function startCompose(ctx: Context, deps: ComposeDeps): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  states.delete(chatId);
  if (identitiesOrNone(deps).length === 0) {
    await ctx.reply(t('bot.identity.none'));
    return;
  }
  await showHome(ctx, deps);
}

// Starts a threaded reply: the recipient and the threading headers are
// fixed from the original, the subject keeps a single Re: prefix, and the
// owner only writes the body. With prefillBody the body is already written
// (P8 smart-reply edit) and the wizard continues at the attachment step,
// exactly as if the owner had typed it.
export async function startReplyCompose(
  ctx: Context,
  deps: ComposeDeps,
  orig: { from: string; subject: string; headers: Record<string, string> },
  prefillBody?: string,
): Promise<void> {
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  const identities = identitiesOrNone(deps);
  if (identities.length === 0) {
    await ctx.reply(t('bot.identity.none'));
    return;
  }
  const identity = identities[0] as string;
  const reply = buildReplyInput(orig, '', identity);
  const state = newState();
  state.step = 'body';
  state.identity = identity;
  state.to = [orig.from];
  state.subject = reply.subject;
  state.extraHeaders = reply.headers ?? {};
  states.set(chatId, state);
  if (prefillBody !== undefined && prefillBody.length > 0) {
    state.body = prefillBody;
    await askAttachChoice(ctx, state);
    return;
  }
  await ctx.reply(t('bot.compose.promptReplyBody', { to: orig.from }), {
    reply_markup: { force_reply: true },
  });
}

export async function handleComposeCallback(ctx: Context, deps: ComposeDeps, data: string): Promise<boolean> {
  if (!data.startsWith('c:')) return false;
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) return false;
  await ctx.answerCallbackQuery().catch(() => undefined);
  const [head, arg] = data.slice(2).split(':');
  const state = states.get(chatId);

  switch (head) {
    case 'home':
      await showHome(ctx, deps);
      return true;
    case 'new':
      await beginWizard(ctx, deps, chatId);
      return true;
    case 'id': {
      const identities = identitiesOrNone(deps);
      const picked = identities[Number(arg)];
      const st = state ?? newState();
      if (picked === undefined) {
        await ctx.reply(t('bot.identity.none'));
        return true;
      }
      st.identity = picked;
      states.set(chatId, st);
      await askTo(ctx, deps, st);
      return true;
    }
    case 'key': {
      const st = state ?? newState();
      if (arg === 'def') {
        st.keyId = null;
      } else {
        const id = Number(arg);
        const keys = deps.providerName ? deps.store.listProviderKeys(deps.providerName) : [];
        if (!Number.isInteger(id) || !keys.some((k) => k.id === id)) {
          await ctx.reply(t('bot.error.generic'));
          return true;
        }
        st.keyId = id;
      }
      states.set(chatId, st);
      await askIdentity(ctx, deps, st);
      return true;
    }
    case 'attach':
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      state.step = 'attach-wait';
      await ctx.reply(t('bot.compose.sendFile'));
      return true;
    case 'skipattach':
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      await showConfirm(ctx, state);
      return true;
    case 'usetmpl':
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      await offerTemplates(ctx, deps);
      return true;
    case 'tpl': {
      const templates = listTemplates(deps.store);
      const tpl = templates[Number(arg)];
      if (!state || !tpl) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      state.subject = tpl.subject;
      state.body = tpl.body;
      await askTo(ctx, deps, state);
      return true;
    }
    case 'back': {
      if (!state) {
        await showHome(ctx, deps);
        return true;
      }
      if (state.step === 'tpl-name' || state.step === 'tpl-subject' || state.step === 'tpl-body') {
        // Abandoned template creation: drop the half-built state so the
        // next text message is not swallowed as a template field.
        states.delete(chatId);
        await showHome(ctx, deps);
        return true;
      }
      if (state.step === 'to') {
        // Back from the template picker: re-ask for recipients instead of
        // jumping to a confirm screen with nothing filled in.
        await askTo(ctx, deps, state);
        return true;
      }
      await showConfirm(ctx, state);
      return true;
    }
    case 'send': {
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      // The confirm screen never offers Send for a batch, but a crafted or
      // replayed callback must not bypass the two-step review either.
      if (isBatch(state.to)) {
        await showBatchReview(ctx, state);
        return true;
      }
      const { subject, body } = substituted(state);
      const input = {
        from: state.identity,
        to: state.to,
        subject,
        body,
        attachments: state.attachments,
        extraHeaders: state.extraHeaders,
        keyId: state.keyId,
        // Stable per compose session: a retried Send tap reuses the key.
        idempotencyKey: `postwisp-compose-${state.id}`,
      };
      const res = await deliver(deps, input);
      if (!res.ok) {
        await deliverFailure(ctx, res);
        return true;
      }
      await afterDelivered(ctx, deps, input, res.id);
      if (state.editingDraftId !== null) deps.store.deleteDraft(state.editingDraftId);
      states.delete(chatId);
      return true;
    }
    case 'batchreview': {
      if (!state || !isBatch(state.to)) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      await showBatchReview(ctx, state);
      return true;
    }
    case 'batchsend': {
      if (!state || !isBatch(state.to)) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      const { subject, body } = substituted(state);
      const input = {
        from: state.identity,
        to: state.to,
        subject,
        body,
        // Batch sends never carry attachments; deliver() blocks them as a
        // second gate in case the state was built another way.
        attachments: [] as Array<{ filename: string; content: Buffer }>,
        extraHeaders: state.extraHeaders,
        keyId: state.keyId,
        // Stable per compose session: a retried Send tap reuses the key.
        idempotencyKey: `postwisp-batch-${state.id}`,
      };
      const res = await deliver(deps, input);
      if (!res.ok) {
        await deliverFailure(ctx, res);
        return true;
      }
      await afterDelivered(ctx, deps, input, res.id, t('bot.compose.batchSent', { count: state.to.length }));
      if (state.editingDraftId !== null) deps.store.deleteDraft(state.editingDraftId);
      states.delete(chatId);
      return true;
    }
    case 'savedraft': {
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      if (state.editingDraftId !== null) {
        deps.store.updateDraft(state.editingDraftId, {
          to: state.to,
          subject: state.subject,
          body: state.body,
          identity: state.identity,
        });
      } else {
        deps.store.createDraft({
          to: state.to,
          subject: state.subject,
          body: state.body,
          identity: state.identity,
        });
      }
      states.delete(chatId);
      await ctx.reply(t('bot.draft.saved'));
      return true;
    }
    case 'schedule':
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      state.step = 'schedule-when';
      {
        const kb = new InlineKeyboard()
          .text(t('bot.schedule.in1h'), 'c:sch:1h')
          .text(t('bot.schedule.in3h'), 'c:sch:3h')
          .row()
          .text(t('bot.schedule.tomorrow9'), 'c:sch:tmr')
          .text(t('bot.schedule.custom'), 'c:sch:custom')
          .row()
          .text(t('bot.compose.back'), 'c:back');
        await ctx.reply(t('bot.schedule.when'), { reply_markup: kb });
      }
      return true;
    case 'sch': {
      if (!state) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      if (arg === 'custom') {
        state.step = 'schedule-custom';
        await ctx.reply(t('bot.schedule.promptCustom'), { reply_markup: { force_reply: true } });
        return true;
      }
      let sendAtMs: number;
      if (arg === '1h') sendAtMs = Date.now() + 3600_000;
      else if (arg === '3h') sendAtMs = Date.now() + 3 * 3600_000;
      else if (arg === 'tmr') {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        sendAtMs = d.getTime();
      } else {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      await finalizeSchedule(ctx, deps, chatId, state, sendAtMs);
      return true;
    }
    case 'schcancel': {
      const id = Number(arg);
      if (!Number.isInteger(id)) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      deps.store.cancelScheduled(id);
      await ctx.reply(t('bot.schedule.cancelled'));
      return true;
    }
    case 'cancel':
      states.delete(chatId);
      await ctx.reply(t('bot.compose.cancelled'));
      return true;
    case 'schedlist':
      await listScheduledFlow(ctx, deps);
      return true;
    case 'tmpl':
      await listTemplatesFlow(ctx, deps);
      return true;
    case 'tadd': {
      const st = newState();
      st.step = 'tpl-name';
      st.templateDraft = { name: '', subject: '' };
      states.set(chatId, st);
      await ctx.reply(t('bot.template.promptName'), { reply_markup: { force_reply: true } });
      return true;
    }
    case 'tdel': {
      const templates = listTemplates(deps.store);
      const tpl = templates[Number(arg)];
      if (tpl) {
        deleteTemplate(deps.store, tpl.name);
        await ctx.reply(t('bot.template.deleted'));
      }
      await listTemplatesFlow(ctx, deps);
      return true;
    }
    case 'drafts':
      await listDraftsFlow(ctx, deps);
      return true;
    case 'dopen': {
      const draft = deps.store.getDraft(Number(arg));
      if (!draft) {
        await ctx.reply(t('bot.draft.notFound'));
        return true;
      }
      const identities = identitiesOrNone(deps);
      const st = newState();
      st.step = 'confirm';
      st.identity = draft.identity ?? identities[0] ?? '';
      if (st.identity === '') {
        await ctx.reply(t('bot.identity.none'));
        return true;
      }
      st.to = draft.to;
      st.subject = draft.subject;
      st.body = draft.body;
      st.editingDraftId = draft.id;
      states.set(chatId, st);
      await showConfirm(ctx, st);
      return true;
    }
    case 'dsend': {
      const draft = deps.store.getDraft(Number(arg));
      if (!draft) {
        await ctx.reply(t('bot.draft.notFound'));
        return true;
      }
      const identities = identitiesOrNone(deps);
      const identity = draft.identity ?? identities[0];
      if (!identity) {
        await ctx.reply(t('bot.identity.none'));
        return true;
      }
      const res = await deliver(deps, {
        from: identity,
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        // Stable per draft: a retried Send tap resumes the same send.
        idempotencyKey: `postwisp-draftsend-${draft.id}`,
      });
      if (!res.ok) {
        await deliverFailure(ctx, res);
        return true;
      }
      await afterDelivered(ctx, deps, { from: identity, to: draft.to, subject: draft.subject }, res.id);
      deps.store.deleteDraft(draft.id);
      return true;
    }
    case 'ddel': {
      const id = Number(arg);
      if (!Number.isInteger(id)) {
        await ctx.reply(t('bot.error.generic'));
        return true;
      }
      deps.store.deleteDraft(id);
      await ctx.reply(t('bot.draft.deleted'));
      return true;
    }
    default:
      return false;
  }
}

export async function handleComposeText(ctx: Context, deps: ComposeDeps): Promise<boolean> {
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) return false;
  const state = states.get(chatId);
  if (!state) return false;
  const text = ctx.message?.text;
  if (typeof text !== 'string') return false;

  switch (state.step) {
    case 'to': {
      const addrs = text
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const bad = addrs.find((a) => !EMAIL_RE.test(a));
      if (addrs.length === 0 || bad !== undefined) {
        await ctx.reply(t('bot.compose.invalidTo', { address: bad ?? text.trim() }));
        return true;
      }
      if (addrs.length > BATCH_MAX_RECIPIENTS) {
        await ctx.reply(t('bot.compose.tooManyRecipients', { max: BATCH_MAX_RECIPIENTS }));
        return true;
      }
      state.to = addrs;
      await afterRecipients(ctx, state);
      return true;
    }
    case 'subject':
      state.subject = text;
      await afterSubject(ctx, state);
      return true;
    case 'body':
      state.body = text;
      await askAttachChoice(ctx, state);
      return true;
    case 'schedule-custom': {
      const sendAtMs = parseCustomTime(text);
      if (sendAtMs === null) {
        await ctx.reply(t('bot.schedule.badTime'));
        return true;
      }
      if (sendAtMs <= Date.now()) {
        await ctx.reply(t('bot.schedule.past'));
        return true;
      }
      if (sendAtMs - Date.now() > MAX_SCHEDULE_AHEAD_MS) {
        await ctx.reply(t('bot.schedule.tooFar'));
        return true;
      }
      await finalizeSchedule(ctx, deps, chatId, state, sendAtMs);
      return true;
    }
    case 'tpl-name': {
      const name = text.trim();
      if (name.length === 0) {
        await ctx.reply(t('bot.template.promptName'), { reply_markup: { force_reply: true } });
        return true;
      }
      if (listTemplates(deps.store).some((tpl) => tpl.name.toLowerCase() === name.toLowerCase())) {
        await ctx.reply(t('bot.template.nameTaken'));
        return true;
      }
      if (state.templateDraft) state.templateDraft.name = name;
      state.step = 'tpl-subject';
      await ctx.reply(t('bot.template.promptSubject'), { reply_markup: { force_reply: true } });
      return true;
    }
    case 'tpl-subject':
      if (state.templateDraft) state.templateDraft.subject = text;
      state.step = 'tpl-body';
      await ctx.reply(t('bot.template.promptBody'), { reply_markup: { force_reply: true } });
      return true;
    case 'tpl-body': {
      const draft = state.templateDraft;
      states.delete(chatId);
      if (draft) {
        addTemplate(deps.store, { name: draft.name, subject: draft.subject, body: text });
        await ctx.reply(t('bot.template.added'));
      }
      await listTemplatesFlow(ctx, deps);
      return true;
    }
    default:
      return false;
  }
}

// Runs on a timer from the coordinator. Due sends go out even when they
// are long overdue — a late email beats a silently dropped one — and a
// failure leaves the row pending for the next run.
export async function processDueScheduled(deps: ComposeDeps): Promise<void> {
  const { store, logger } = deps;
  const due = store.dueScheduled(Date.now());
  if (due.length === 0) return;
  const identities = identitiesOrNone(deps);
  for (const s of due) {
    const identity = s.identity ?? identities[0];
    if (!identity) {
      logger.warn('scheduled send skipped: no sending identity configured', { scheduledId: s.id });
      continue;
    }
    // The key is stable per scheduled row: a send that reached Resend but
    // lost its response resumes as the same send on the next run.
    // {{date}} resolves now, at fire time — not when the row was scheduled.
    const { subject, body } = resolveScheduledVars(s, Date.now());
    const res = await deliver(deps, {
      from: identity,
      to: s.to,
      subject,
      body,
      idempotencyKey: `postwisp-sched-${s.id}`,
    });
    if (!res.ok) {
      logger.warn('scheduled send failed; left pending for the next run', {
        scheduledId: s.id,
        reason: res.reason,
      });
      continue;
    }
    store.markScheduledSent(s.id, res.id);
    const domain = identity.split('@')[1] ?? '';
    store.logSent({
      providerId: res.id,
      to: s.to.join(', '),
      subject,
      domain,
      chatId: deps.ownerId,
      messageId: null,
    });
    const caps = await loadCaps().catch((err: unknown) => {
      logger.error('send-cap record failed for scheduled send', {
        scheduledId: s.id,
        detail: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (caps) caps.recordSent(store, s.to);
    logger.info('scheduled send delivered', { scheduledId: s.id, providerId: res.id });
  }
}

// The coordinator routes message:document here when the wizard is waiting
// for an attachment; every other document is none of our business.
export async function handleComposeDocument(ctx: Context, deps: ComposeDeps): Promise<boolean> {
  const chatId = chatIdOf(ctx);
  if (chatId === undefined) return false;
  const state = states.get(chatId);
  if (!state || state.step !== 'attach-wait') return false;
  // Second gate for the batch rule: the wizard never offers the attach
  // step for batch sends, but a stale button tap must not slip one in.
  if (isBatch(state.to)) {
    await ctx.reply(t('bot.compose.batchNoAttach'));
    return true;
  }
  const doc = ctx.message?.document;
  if (!doc?.file_id) return false;
  const filename = doc.file_name ?? 'attachment';

  let file: { file_path?: string; file_size?: number };
  try {
    file = await ctx.api.getFile(doc.file_id);
  } catch {
    await ctx.reply(t('bot.compose.attachFailed'));
    return true;
  }
  const size = file.file_size ?? doc.file_size ?? 0;
  if (size > MAX_ATTACH_BYTES) {
    await ctx.reply(t('bot.compose.attachTooLarge', { filename }));
    return true;
  }
  let bytes: Buffer;
  try {
    const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    await ctx.reply(t('bot.compose.attachFailed'));
    return true;
  }
  state.attachments.push({ filename, content: bytes });
  await showConfirm(ctx, state);
  return true;
}
