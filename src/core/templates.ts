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

// Identities, reply templates, and the test-mode flag. All three live in
// the kv table as JSON because they are small, owner-edited, and never
// queried by anything but their own accessors; identities themselves are
// filled in by the setup flow in a later phase.

import type { Store } from './store.js';

export interface Template {
  name: string;
  subject: string;
  body: string;
}

// The send-cap guard lives in src/core/caps.ts and ships with the build.
// A failed import is a broken deployment, not a missing optional file, so
// it fails closed: the rejection propagates and every caller blocks the
// send instead of letting it proceed uncapped.
export interface CapsApi {
  checkSendCaps(store: Store, to: string[]): { ok: true } | { ok: false; reason: string };
  recordSent(store: Store, to: string[]): void;
}

let capsPromise: Promise<CapsApi> | null = null;

export function loadCaps(): Promise<CapsApi> {
  if (capsPromise === null) {
    // Non-literal specifier: TypeScript must not try to resolve the module
    // statically here.
    const specifier = './caps.js';
    capsPromise = import(specifier).then(
      (m) =>
        ({
          checkSendCaps: m.checkSendCaps,
          recordSent: m.recordSent,
        }) as CapsApi,
    );
  }
  return capsPromise;
}

// Fills {{name}} placeholders from vars. Unknown placeholders are left
// untouched so a literal {{...}} in a draft is never silently eaten.
export function applyTemplateVars(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(vars)) {
    out = out.split(`{{${name}}}`).join(value);
  }
  return out;
}

// Test mode changes nothing about delivery; it only surfaces a banner and
// nudges the To prompt toward the provider's safe test address.
export function isTestMode(store: Store): boolean {
  return store.get('test_mode') === 'on';
}

export function setTestMode(store: Store, on: boolean): void {
  store.set('test_mode', on ? 'on' : 'off');
}

function readJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // Corrupt kv must be visible in the operator logs, not silently read
    // as empty (which would e.g. hide every template or identity).
    // console.warn: this module is created before any logger exists.
    console.warn('postwisp: ignoring corrupt JSON value in kv store');
    return [];
  }
}

function isTemplate(value: unknown): value is Template {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['name'] === 'string' && typeof v['subject'] === 'string' && typeof v['body'] === 'string';
}

export function listTemplates(store: Store): Template[] {
  return readJsonArray<unknown>(store.get('templates')).filter(isTemplate);
}

// Returns false when a template with the same name already exists.
export function addTemplate(store: Store, tpl: Template): boolean {
  const list = listTemplates(store);
  const name = tpl.name.trim();
  if (name.length === 0) return false;
  if (list.some((t) => t.name.toLowerCase() === name.toLowerCase())) return false;
  list.push({ name, subject: tpl.subject, body: tpl.body });
  store.set('templates', JSON.stringify(list));
  return true;
}

// Matches case-insensitively, like addTemplate's duplicate check: the UI
// always deletes what it just listed, and names compare case-insensitively.
export function deleteTemplate(store: Store, name: string): boolean {
  const list = listTemplates(store);
  const lower = name.toLowerCase();
  const next = list.filter((t) => t.name.toLowerCase() !== lower);
  if (next.length === list.length) return false;
  store.set('templates', JSON.stringify(next));
  return true;
}

// Identities are the From addresses the owner may send as. When the
// caller passes the owned domains, anything outside them is dropped so a
// stale identity can never become a From address.
export function listIdentities(store: Store, domains: string[]): string[] {
  const list = readJsonArray<unknown>(store.get('identities')).filter(
    (v): v is string => typeof v === 'string' && v.includes('@'),
  );
  if (domains.length === 0) return list;
  const owned = new Set(domains.map((d) => d.toLowerCase()));
  return list.filter((id) => {
    const domain = id.split('@')[1]?.toLowerCase();
    return domain !== undefined && owned.has(domain);
  });
}
