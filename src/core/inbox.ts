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

// Pure inbox domain logic: search parsing, filter rules, snooze, blocklist,
// OTP extraction. No I/O, no network; persistence goes through Store.

import type { EmailRecord, SearchQuery, Store } from './store.js';

export type { SearchQuery } from './store.js';

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

// Split on whitespace but keep quoted spans (e.g. subject:"foo bar") intact.
function tokenize(q: string): string[] {
  return q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

// Parses queries like 'from:boss subject:invoice has:attachment urgent'.
// Unknown has: values fall back to plain text so nothing is silently dropped.
export function parseSearch(q: string): SearchQuery {
  const out: SearchQuery = {};
  const text: string[] = [];
  for (const tok of tokenize(q)) {
    const m = /^(from|subject|has):(.*)$/i.exec(tok);
    if (!m) {
      text.push(unquote(tok));
      continue;
    }
    const key = (m[1] ?? '').toLowerCase();
    const val = unquote(m[2] ?? '');
    // An empty operator value (e.g. a bare `subject:`) would compile to
    // LIKE '%%' — a match-all. Ignore the operator instead.
    if (val === '') continue;
    if (key === 'from') {
      out.from = val;
    } else if (key === 'subject') {
      out.subject = val;
    } else if (key === 'has' && val.toLowerCase() === 'attachment') {
      out.hasAttachment = true;
    } else {
      text.push(tok);
    }
  }
  const rest = text.join(' ').trim();
  if (rest) out.text = rest;
  return out;
}

export type RuleAction = 'label' | 'archive' | 'silent' | 'autoreply';

export interface Rule {
  id: number;
  name: string;
  matchFrom: string | null;
  matchSubject: string | null;
  action: RuleAction;
  actionArg: string | null;
  enabled: boolean;
}

export interface NewRule {
  name: string;
  matchFrom?: string | null;
  matchSubject?: string | null;
  action: RuleAction;
  actionArg?: string | null;
}

function toRule(row: {
  id: number;
  name: string;
  matchFrom: string | null;
  matchSubject: string | null;
  action: string;
  actionArg: string | null;
  enabled: boolean;
}): Rule {
  // The action column is only ever written through addRule, which types it.
  return { ...row, action: row.action as RuleAction };
}

export function listRules(store: Store): Rule[] {
  return store.ruleList().map(toRule);
}

export function addRule(store: Store, rule: NewRule): number {
  // An empty-string matcher behaves as match-all in matches(); normalize
  // it to null (match everything) at write time so the stored rule says
  // what it means.
  const matchFrom = rule.matchFrom === undefined || rule.matchFrom === '' ? null : rule.matchFrom;
  const matchSubject =
    rule.matchSubject === undefined || rule.matchSubject === '' ? null : rule.matchSubject;
  return store.ruleAdd(
    rule.name,
    matchFrom,
    matchSubject,
    rule.action,
    rule.actionArg ?? null,
  );
}

export function deleteRule(store: Store, id: number): void {
  store.ruleDelete(id);
}

export function setRuleEnabled(store: Store, id: number, enabled: boolean): void {
  store.ruleSetEnabled(id, enabled);
}

export interface RuleOutcome {
  silent: boolean;
  archive: boolean;
  labels: string[];
  autoreply: string | null;
}

function matches(value: string | null, haystack: string): boolean {
  // A null matcher means "match everything"; otherwise case-insensitive substring.
  return value === null || haystack.toLowerCase().includes(value.toLowerCase());
}

// Runs enabled rules in id order against an inbound message.
export function evaluateRules(
  store: Store,
  ev: { from: string; subject: string },
): RuleOutcome {
  const out: RuleOutcome = { silent: false, archive: false, labels: [], autoreply: null };
  for (const rule of listRules(store)) {
    if (!rule.enabled) continue;
    if (!matches(rule.matchFrom, ev.from)) continue;
    if (!matches(rule.matchSubject, ev.subject)) continue;
    switch (rule.action) {
      case 'label':
        if (rule.actionArg) out.labels.push(rule.actionArg);
        break;
      case 'archive':
        out.archive = true;
        break;
      case 'silent':
        out.silent = true;
        break;
      case 'autoreply':
        // First matching autoreply wins; later ones must not override it.
        if (out.autoreply === null && rule.actionArg) out.autoreply = rule.actionArg;
        break;
      default:
        // The action column is only written through addRule, so anything
        // else means a tampered row. Skip the rule, loudly: silently
        // ignoring it would hide the tampering.
        // console.warn: this module is pure domain logic with no logger.
        console.warn(`postwisp: skipping rule with unknown action (id=${rule.id}, action=${rule.action})`);
        break;
    }
  }
  return out;
}

// A snoozed email hides until untilMs, then resurfaces via dueSnoozed.
export function snoozeEmail(store: Store, id: string, untilMs: number): void {
  store.snoozeSet(id, untilMs);
}

export function unsnoozeEmail(store: Store, id: string): void {
  store.snoozeSet(id, null);
}

export function dueSnoozed(store: Store, nowMs: number): EmailRecord[] {
  return store.dueSnoozed(nowMs);
}

// Sender blocklist with a VIP allowlist. One row per address; the allowlist
// always wins, so isBlocked is true only for pure blocklist entries.
function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function blockAddress(store: Store, address: string): void {
  store.blockSet(normalizeAddress(address), 'block');
}

export function allowAddress(store: Store, address: string): void {
  store.blockSet(normalizeAddress(address), 'allow');
}

export function unlistAddress(store: Store, address: string): void {
  store.blockRemove(normalizeAddress(address));
}

export function isBlocked(store: Store, address: string): boolean {
  return store.blockGet(normalizeAddress(address)) === 'block';
}

export function isAllowlisted(store: Store, address: string): boolean {
  return store.blockGet(normalizeAddress(address)) === 'allow';
}

// Pulls one-time passcodes out of message text: 4-8 digit runs that are not
// part of a longer digit run. Lookarounds (not \b) so a 9-digit number never
// yields an 8-digit "code" from its tail.
export function extractOtp(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!\d)\d{4,8}(?!\d)/g)) {
    const code = m[0];
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}
