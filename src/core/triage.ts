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

// AI triage (P8, opt-in): classifies inbound mail with the owner's LLM key
// and maps high-confidence results onto the existing rule actions. Pure
// domain logic; the caller (bot/inbound.ts) owns the Telegram side. The
// LLM's output is untrusted input: the category is validated against a
// fixed set and the confidence is clamped before anything is acted on.

import type { Logger } from './logger.js';
import type { Store } from './store.js';
import { addRule, listRules, type RuleAction } from './inbox.js';
import { LlmError, type LlmClient } from './llm.js';

export type TriageCategory = 'urgent' | 'important' | 'newsletter' | 'noise' | 'unsure';
export type TriageAction = 'label' | 'archive' | 'silent' | 'none';

const CATEGORIES: TriageCategory[] = ['urgent', 'important', 'newsletter', 'noise', 'unsure'];

// Below this confidence nothing is auto-applied; the email goes to the
// owner as an approve/reject item instead.
const AUTO_CONFIDENCE = 0.8;
// Noise is only silenced (archived without any notification) when the
// model is very sure; otherwise it is archived visibly.
const NOISE_SILENT_CONFIDENCE = 0.9;
// The model only needs the head of the mail to classify it; the rest is
// tokens spent for nothing.
const MAX_TRIAGE_INPUT_CHARS = 4000;

const TRIAGE_SYSTEM = [
  'You are an email triage classifier. Read the email and reply with a single JSON object:',
  '{"category": "urgent" | "important" | "newsletter" | "noise" | "unsure", "confidence": 0.0-1.0}.',
  'Categories: urgent = needs action today (bills, security alerts, direct requests to the recipient);',
  'important = worth reading soon (personal mail, work updates);',
  'newsletter = bulk marketing or list mail;',
  'noise = automated notifications, receipts, or junk;',
  'unsure = cannot tell from the content.',
  'Set confidence by how clear the signals are. Reply with JSON only.',
].join(' ');

export interface ClassifiedEmail {
  category: TriageCategory;
  confidence: number;
}

export async function classifyEmail(
  llm: LlmClient,
  email: { from: string; subject: string; body: string },
): Promise<ClassifiedEmail> {
  const body =
    email.body.length > MAX_TRIAGE_INPUT_CHARS
      ? email.body.slice(0, MAX_TRIAGE_INPUT_CHARS)
      : email.body;
  const raw = await llm.chatJson({
    system: TRIAGE_SYSTEM,
    user: `From: ${email.from}\nSubject: ${email.subject}\n\n${body}`,
    maxTokens: 200,
  });
  const obj = raw as { category?: unknown; confidence?: unknown };
  if (!CATEGORIES.includes(obj.category as TriageCategory)) {
    throw new LlmError('the model returned an unknown triage category');
  }
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) {
    throw new LlmError('the model returned an invalid triage confidence');
  }
  return {
    category: obj.category as TriageCategory,
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}

export interface TriageDecision {
  action: TriageAction;
  label: string | null;
}

// The full-confidence suggestion for a category, ignoring the threshold:
// what the unsure digest shows the owner as the proposed action.
export function suggestedActionFor(category: TriageCategory): TriageDecision {
  switch (category) {
    case 'urgent':
      return { action: 'label', label: 'urgent' };
    case 'important':
      return { action: 'label', label: 'important' };
    case 'newsletter':
    case 'noise':
      return { action: 'archive', label: null };
    default:
      return { action: 'none', label: null };
  }
}

export function decideAction(category: TriageCategory, confidence: number): TriageDecision {
  if (category === 'urgent' && confidence >= AUTO_CONFIDENCE) {
    return { action: 'label', label: 'urgent' };
  }
  if (category === 'important' && confidence >= AUTO_CONFIDENCE) {
    return { action: 'label', label: 'important' };
  }
  if (category === 'newsletter' && confidence >= AUTO_CONFIDENCE) {
    return { action: 'archive', label: null };
  }
  if (category === 'noise') {
    if (confidence >= NOISE_SILENT_CONFIDENCE) return { action: 'silent', label: null };
    if (confidence >= AUTO_CONFIDENCE) return { action: 'archive', label: null };
  }
  return { action: 'none', label: null };
}

export function describeTriageAction(action: TriageAction, label: string | null): string {
  if (action === 'label' && label) return `label as ${label}`;
  if (action === 'archive') return 'archive';
  if (action === 'silent') return 'archive silently';
  return 'no action';
}

// Applies a triage decision to the stored email. Shared by the inbound
// auto-apply path and the owner's approve tap on an unsure item.
export function applyTriageAction(
  store: Store,
  emailId: string,
  action: TriageAction,
  label: string | null,
): void {
  if (action === 'none') return;
  const meta = store.getEmailMeta(emailId);
  if (!meta) return;
  const labels = label ? [...new Set([...meta.labels, label])] : meta.labels;
  const archived = meta.archived || action === 'archive' || action === 'silent';
  store.saveEmailMeta({ ...meta, labels, archived });
}

// An explicit rule for the sender always wins over a guess: with one in
// place the AI stays out and no token is spent on this email.
function hasRuleForSender(store: Store, fromAddr: string): boolean {
  const from = fromAddr.trim().toLowerCase();
  if (from.length === 0) return false;
  return listRules(store).some(
    (r) => r.enabled && r.matchFrom !== null && from.includes(r.matchFrom.toLowerCase()),
  );
}

export interface UnsureTriage {
  triageId: number;
  from: string;
  subject: string;
  category: TriageCategory;
  confidence: number;
}

export interface InboundTriage {
  // True when the mail was classified as noise with high confidence: the
  // caller skips the notification, like a silent rule would.
  silent: boolean;
  // Set when the classification was not confident enough to auto-apply:
  // the caller asks the owner with one-tap approve/reject buttons.
  unsure: UnsureTriage | null;
}

export async function triageInbound(
  deps: { store: Store; logger: Logger; llm: LlmClient },
  email: { id: string; fromAddr: string; subject: string; snippet: string; bodyText: string | null },
): Promise<InboundTriage> {
  const idle: InboundTriage = { silent: false, unsure: null };
  if (hasRuleForSender(deps.store, email.fromAddr)) return idle;
  let classified: ClassifiedEmail;
  try {
    classified = await classifyEmail(deps.llm, {
      from: email.fromAddr,
      subject: email.subject,
      body: email.bodyText ?? email.snippet ?? '',
    });
  } catch (err) {
    // A failed classification must never lose or misfile mail: the email
    // flows through the normal path as if triage were off.
    deps.logger.warn('AI triage skipped: classification failed', {
      emailId: email.id,
      detail: err instanceof Error ? err.message : String(err),
    });
    return idle;
  }
  const decision = decideAction(classified.category, classified.confidence);
  if (decision.action === 'none') {
    const triageId = deps.store.recordTriage({
      emailId: email.id,
      category: classified.category,
      confidence: classified.confidence,
      action: 'none',
      label: null,
      applied: false,
    });
    return {
      silent: false,
      unsure: {
        triageId,
        from: email.fromAddr,
        subject: email.subject,
        category: classified.category,
        confidence: classified.confidence,
      },
    };
  }
  applyTriageAction(deps.store, email.id, decision.action, decision.label);
  deps.store.recordTriage({
    emailId: email.id,
    category: classified.category,
    confidence: classified.confidence,
    action: decision.action,
    label: decision.label,
    applied: true,
  });
  deps.logger.info('AI triage applied', {
    emailId: email.id,
    category: classified.category,
    action: decision.action,
  });
  return { silent: decision.action === 'silent', unsure: null };
}

// The user corrected a triage decision: archive what the AI labeled, or
// keep what the AI archived. The correction becomes a persistent rule
// through the normal rules system, so it fires on future mail like any
// owner-written rule. Returns a human description of the learned rule, or
// null when nothing was learned.
export type CorrectionKind = 'archived' | 'kept';

export function learnFromCorrection(
  store: Store,
  fromAddr: string,
  kind: CorrectionKind,
): string | null {
  const from = fromAddr.trim().toLowerCase();
  if (from.length === 0) return null;
  const action: RuleAction = kind === 'archived' ? 'archive' : 'label';
  const actionArg = kind === 'archived' ? null : 'ai-kept';
  const dupe = listRules(store).some(
    (r) =>
      r.enabled &&
      (r.matchFrom ?? '').toLowerCase() === from &&
      r.action === action &&
      (r.actionArg ?? null) === actionArg,
  );
  if (dupe) return null;
  const name = kind === 'archived' ? `AI: archive mail from ${from}` : `AI: keep mail from ${from}`;
  addRule(store, { name, matchFrom: from, action, actionArg });
  return kind === 'archived' ? `archive mail from ${from}` : `keep mail from ${from}`;
}

// Called when the owner manually archives (or un-archives) an email the AI
// triaged: a manual action that contradicts the triage is a correction.
export function noteManualArchive(
  store: Store,
  emailId: string,
  archived: boolean,
): string | null {
  const triage = store.getTriageByEmail(emailId);
  if (!triage || triage.corrected) return null;
  const meta = store.getEmailMeta(emailId);
  if (!meta) return null;
  // Unsure items record action 'none'; the suggestion the digest showed is
  // what the owner saw as the triage decision.
  const decided: TriageAction =
    triage.action === 'none'
      ? suggestedActionFor(triage.category as TriageCategory).action
      : (triage.action as TriageAction);
  let kind: CorrectionKind | null = null;
  if (archived && decided === 'label') kind = 'archived';
  else if (!archived && (decided === 'archive' || decided === 'silent')) kind = 'kept';
  if (!kind) return null;
  const learned = learnFromCorrection(store, meta.fromAddr, kind);
  if (learned === null) return null;
  store.markTriageCorrected(triage.id);
  return learned;
}
