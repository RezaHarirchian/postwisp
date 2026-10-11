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

// P8 (AI, opt-in) Telegram handlers: smart-reply drafts, triage
// approve/reject, and follow-up nudge actions. Every entry point checks
// the LLM client first: with no key configured the buttons that lead here
// are never rendered, and these handlers refuse to run.

import { InlineKeyboard, type Context } from 'grammy';
import type { Logger } from '../core/logger.js';
import type { Store } from '../core/store.js';
import type { LlmClient } from '../core/llm.js';
import { generateReplyDraft } from '../core/smartreply.js';
import {
  applyTriageAction,
  describeTriageAction,
  learnFromCorrection,
  noteManualArchive,
  suggestedActionFor,
  type TriageAction,
  type TriageCategory,
  type UnsureTriage,
} from '../core/triage.js';
import { findNudgeCandidates, type NudgeCandidate } from '../core/nudge.js';
import { listIdentities } from '../core/templates.js';
import { sendReplyEmail, startReplyCompose, type ComposeDeps } from './compose.js';
import { buildReplyInput } from './delivery.js';
import type { SendQueue } from './queue.js';
import { cb, escapeHtml, formatDateUtc } from './views.js';
import { t } from '../core/i18n.js';

export interface AiActionDeps {
  store: Store;
  logger: Logger;
  // Null means AI is inert: handlers refuse, buttons are never rendered.
  llm: LlmClient | null;
  // Null when the coordinator could not wire sending (tests, unwired runs).
  sendDeps: ComposeDeps | null;
  ownerId: number | null;
  nudgeDays: number;
}

const DAY_MS = 86400_000;

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

// The unsure-triage digest item: what the mail is, what the model
// suggested, and one-tap approve/reject. Callback ids are numeric triage
// row ids, safely inside the 64-byte callback limit.
export function buildTriageUnsureView(u: UnsureTriage): {
  text: string;
  replyMarkup: InlineKeyboard;
} {
  const suggested = suggestedActionFor(u.category);
  const lines = [
    `<b>${escapeHtml(t('bot.ai.triageUnsureTitle'))}</b>`,
    t('bot.notify.from', { from: escapeHtml(u.from) }),
    t('bot.notify.subject', { subject: escapeHtml(u.subject) }),
    t('bot.ai.triageSuggested', {
      action: describeTriageAction(suggested.action, suggested.label),
      category: u.category,
      confidence: Math.round(u.confidence * 100),
    }),
  ];
  const kb = new InlineKeyboard()
    .text(t('bot.ai.approve'), cb(`ai:tok:${u.triageId}`))
    .text(t('bot.ai.reject'), cb(`ai:tno:${u.triageId}`));
  return { text: lines.join('\n'), replyMarkup: kb };
}

export function buildNudgeView(c: NudgeCandidate): {
  text: string;
  replyMarkup: InlineKeyboard;
} {
  const lines = [
    `<b>${escapeHtml(t('bot.ai.nudgeTitle'))}</b>`,
    t('bot.ai.nudgeBody', {
      to: escapeHtml(c.to),
      subject: escapeHtml(c.subject),
      date: formatDateUtc(c.sentAtMs),
    }),
  ];
  const kb = new InlineKeyboard()
    .text(t('bot.ai.nudgeSnooze'), cb(`ai:snz:${c.sentId}`))
    .text(t('bot.ai.nudgeDismiss'), cb(`ai:dis:${c.sentId}`));
  return { text: lines.join('\n'), replyMarkup: kb };
}

// The "Draft reply" button on the email view: generate a draft from the
// email content and show it with approve/edit buttons. The draft is
// stored server-side; only its numeric id rides in the callback.
export async function handleDraftReplyButton(
  ctx: Context,
  deps: AiActionDeps,
  emailId: string,
): Promise<void> {
  if (!deps.llm || !deps.sendDeps) {
    await ctx.reply(t('bot.ai.notAvailable'));
    return;
  }
  const meta = deps.store.getEmailMeta(emailId);
  if (!meta) {
    await ctx.reply(t('bot.email.notFound'));
    return;
  }
  let body: string;
  try {
    body = await generateReplyDraft(deps.llm, {
      from: meta.fromAddr,
      subject: meta.subject,
      body: meta.bodyText ?? meta.snippet ?? '',
    });
  } catch (err) {
    deps.logger.warn('AI reply draft failed', {
      emailId,
      detail: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply(t('bot.ai.draftFailed'));
    return;
  }
  const id = deps.store.saveReplyDraft({
    emailId,
    toAddr: meta.fromAddr,
    subject: replySubject(meta.subject),
    body,
  });
  const kb = new InlineKeyboard()
    .text(t('bot.ai.approve'), cb(`ai:rok:${id}`))
    .text(t('bot.ai.edit'), cb(`ai:red:${id}`));
  // The draft is model output: untrusted, so it is escaped like any other
  // user content before it touches markup.
  await ctx.reply(`<b>${escapeHtml(t('bot.ai.draftTitle'))}</b>\n\n${escapeHtml(body)}`, {
    parse_mode: 'HTML',
    reply_markup: kb,
    protect_content: true,
  });
}

// ai:tok:<triageId> / ai:tno:<triageId> — approve or reject an unsure
// triage suggestion. ai:rok:<draftId> / ai:red:<draftId> — approve or
// edit a reply draft. ai:snz:<sentId> / ai:dis:<sentId> — snooze or
// dismiss a follow-up nudge.
export async function handleAiCallback(
  ctx: Context,
  deps: AiActionDeps,
  data: string,
): Promise<void> {
  if (!deps.llm) {
    await ctx.reply(t('bot.ai.notAvailable'));
    return;
  }
  const rest = data.slice(3);
  const sep = rest.indexOf(':');
  const head = sep === -1 ? rest : rest.slice(0, sep);
  const arg = sep === -1 ? '' : rest.slice(sep + 1);
  switch (head) {
    case 'tok':
      await approveTriage(ctx, deps, arg);
      return;
    case 'tno':
      await rejectTriage(ctx, deps, arg);
      return;
    case 'rok':
      await approveReplyDraft(ctx, deps, arg);
      return;
    case 'red':
      await editReplyDraft(ctx, deps, arg);
      return;
    case 'snz':
      await snoozeNudge(ctx, deps, arg);
      return;
    case 'dis':
      await dismissNudge(ctx, deps, arg);
      return;
    default:
      return;
  }
}

function parseId(arg: string): number | null {
  const n = Number(arg);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function approveTriage(ctx: Context, deps: AiActionDeps, arg: string): Promise<void> {
  const id = parseId(arg);
  const triage = id === null ? null : deps.store.getTriage(id);
  if (!triage) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  // Unsure items record action 'none'; what the owner approves is the
  // suggestion the digest showed.
  const suggested =
    triage.action === 'none'
      ? suggestedActionFor(triage.category as TriageCategory)
      : { action: triage.action as TriageAction, label: triage.label };
  applyTriageAction(deps.store, triage.emailId, suggested.action, suggested.label);
  deps.store.markTriageApplied(triage.id);
  await ctx.reply(
    t('bot.ai.triageApplied', {
      action: describeTriageAction(suggested.action, suggested.label),
    }),
  );
}

async function rejectTriage(ctx: Context, deps: AiActionDeps, arg: string): Promise<void> {
  const id = parseId(arg);
  const triage = id === null ? null : deps.store.getTriage(id);
  if (!triage) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  deps.store.markTriageCorrected(triage.id);
  // What the owner rejects is the suggestion the digest showed: for
  // unsure items that is derived from the category, since the recorded
  // action is 'none'.
  const suggested =
    triage.action === 'none'
      ? suggestedActionFor(triage.category as TriageCategory)
      : { action: triage.action as TriageAction, label: triage.label };
  // With no suggested action there is nothing to invert: rejecting "no
  // action" is just an acknowledgment, not a learnable correction.
  if (suggested.action === 'none') {
    await ctx.reply(t('bot.ai.triageRejected'));
    return;
  }
  const meta = deps.store.getEmailMeta(triage.emailId);
  if (!meta) {
    await ctx.reply(t('bot.ai.triageRejected'));
    return;
  }
  // The suggestion is refused: learn the opposite treatment for this
  // sender through the normal rules system, so future mail is handled
  // the way the owner chose.
  const kind = suggested.action === 'archive' || suggested.action === 'silent' ? 'kept' : 'archived';
  const learned = learnFromCorrection(deps.store, meta.fromAddr, kind);
  if (learned === null) {
    await ctx.reply(t('bot.ai.triageRejected'));
    return;
  }
  await ctx.reply(t('bot.ai.ruleLearned', { rule: escapeHtml(learned) }), {
    protect_content: true,
  });
}

async function approveReplyDraft(ctx: Context, deps: AiActionDeps, arg: string): Promise<void> {
  const id = parseId(arg);
  const draft = id === null ? null : deps.store.getReplyDraft(id);
  if (!draft || !deps.sendDeps) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  const sendDeps = deps.sendDeps;
  const identities = listIdentities(sendDeps.store, sendDeps.domains);
  if (identities.length === 0) {
    await ctx.reply(t('bot.identity.none'));
    return;
  }
  const identity = identities[0] as string;
  const meta = deps.store.getEmailMeta(draft.emailId);
  const reply = buildReplyInput(
    { from: draft.toAddr, subject: meta?.subject ?? draft.subject, headers: meta?.headers ?? {} },
    '',
    identity,
  );
  const headers = reply.headers ?? {};
  const ok = await sendReplyEmail(ctx, sendDeps, {
    from: identity,
    to: [draft.toAddr],
    subject: reply.subject,
    body: draft.body,
    ...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}),
    // A double-tapped Approve resumes the same send instead of delivering
    // the reply twice.
    idempotencyKey: `postwisp-ai-reply:${draft.id}`,
  });
  if (ok) deps.store.deleteReplyDraft(draft.id);
}

async function editReplyDraft(ctx: Context, deps: AiActionDeps, arg: string): Promise<void> {
  const id = parseId(arg);
  const draft = id === null ? null : deps.store.getReplyDraft(id);
  if (!draft || !deps.sendDeps) {
    await ctx.reply(t('bot.error.generic'));
    return;
  }
  const meta = deps.store.getEmailMeta(draft.emailId);
  deps.store.deleteReplyDraft(draft.id);
  // The compose flow opens prefilled with the draft; the owner edits the
  // text and confirms like any other reply.
  await startReplyCompose(
    ctx,
    deps.sendDeps,
    { from: draft.toAddr, subject: meta?.subject ?? draft.subject, headers: meta?.headers ?? {} },
    draft.body,
  );
}

async function snoozeNudge(ctx: Context, deps: AiActionDeps, arg: string): Promise<void> {
  const sentId = parseId(arg);
  if (sentId === null) return;
  deps.store.setNudgeState(sentId, Date.now() + deps.nudgeDays * DAY_MS, false);
  await ctx.reply(t('bot.ai.nudgeSnoozed'));
}

async function dismissNudge(ctx: Context, deps: AiActionDeps, arg: string): Promise<void> {
  const sentId = parseId(arg);
  if (sentId === null) return;
  deps.store.setNudgeState(sentId, null, true);
  await ctx.reply(t('bot.ai.nudgeDismissed'));
}

export interface NudgeCheckDeps {
  store: Store;
  logger: Logger;
  queue: SendQueue;
  ownerId: number;
  nudgeDays: number;
}

// One nudge pass: notify the owner about every stale sent email, then
// auto-snooze each so it comes back after the interval while the thread
// stays silent. Dismissed items never return.
export async function runNudgeCheck(deps: NudgeCheckDeps): Promise<number> {
  const now = Date.now();
  const candidates = findNudgeCandidates(deps.store, now, deps.nudgeDays);
  let notified = 0;
  for (const c of candidates) {
    try {
      const view = buildNudgeView(c);
      deps.queue.enqueue(deps.ownerId, {
        text: view.text,
        extra: { replyMarkup: view.replyMarkup, parseMode: 'HTML', protectContent: true },
      });
      deps.store.setNudgeState(c.sentId, now + deps.nudgeDays * DAY_MS, false);
      notified++;
    } catch (err) {
      deps.logger.warn('nudge notify failed', {
        sentId: c.sentId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return notified;
}

// Wraps the bot store's setArchived so a manual archive that contradicts
// an AI triage becomes a learned rule. Inert when disabled: without a
// triage record the lookup is a no-op.
export function withCorrectionTracking<T extends { setArchived(id: string, archived: boolean): void }>(
  botStore: T,
  fullStore: Store | null,
  logger: Logger,
  enabled: boolean,
): T {
  if (!botStore || !fullStore || !enabled) return botStore;
  return {
    ...botStore,
    setArchived(id: string, archived: boolean): void {
      botStore.setArchived(id, archived);
      try {
        const learned = noteManualArchive(fullStore, id, archived);
        if (learned) logger.info('AI triage correction learned a rule', { emailId: id, rule: learned });
      } catch (err) {
        logger.warn('AI correction tracking failed', {
          emailId: id,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
