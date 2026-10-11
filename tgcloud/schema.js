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

// Database schema for the Telegram Serverless build. Applied with
// `tgcloud migrate`; add a new table or column here and migrate again to
// change the production schema.
//
// Mapping to the self-hosted SQLite schema (src/core/store.ts):
//   kv          <- kv                          (config + wizard state)
//   emails      <- emails, subset              (inbound mail; no provider,
//                                              domain, thread, attachments,
//                                              snooze, or trash columns —
//                                              the core loop does not need them)
//   outbox      <- scheduled_sends + sent_log, subset (queued and sent mail;
//                                              send_at is kept for future
//                                              scheduling, status is
//                                              pending/sent/failed)
//   suppression <- suppressed_addresses, subset (no-consent send protection)
//   rules       <- rules, subset               (from/subject contains rules only)
//
// NOT carried over: drafts, blocklist, webhook_events, consent_log,
// sent provider ids. This is a companion to the self-hosted bot, not a
// port: `tgcloud migrate` creates empty tables. Copying data out of an
// existing self-hosted postwisp.db into tgcloud is out of scope.

import { integer, table, text } from 'sdk/db';

export const kv = table('kv', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// One row per inbound email. labels is a JSON array string; the handlers
// treat 'archived' as the archive marker (no separate archived column in
// this build). is_read is 0/1.
export const emails = table('emails', {
  id: text('id').primaryKey(),
  from_addr: text('from_addr'),
  from_name: text('from_name'),
  subject: text('subject'),
  snippet: text('snippet'),
  body: text('body'),
  received_at: integer('received_at'),
  is_read: integer('is_read'),
  labels: text('labels'),
});

// Queued and sent outbound mail. idempotency_key maps to Resend's
// Idempotency-Key header so a retried send never duplicates.
export const outbox = table('outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  to_addrs: text('to_addrs'),
  subject: text('subject'),
  body: text('body'),
  send_at: integer('send_at'),
  status: text('status'),
  idempotency_key: text('idempotency_key'),
});

// Addresses that must never receive mail: bounced, complained, or
// explicitly opted out. Checked before every send.
export const suppression = table('suppression', {
  address: text('address').primaryKey(),
  reason: text('reason'),
  created_at: integer('created_at'),
});

// Simple rules: field is 'from' or 'subject', matcher is one of the
// matchers pure.evalRule understands, value is what to match against,
// action is 'archive', 'mark_read', or 'suppress'.
export const rules = table('rules', {
  id: integer('id').primaryKey(),
  field: text('field'),
  matcher: text('matcher'),
  value: text('value'),
  action: text('action'),
});
