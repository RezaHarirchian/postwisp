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

// Small database helpers over the tgcloud schema (tgcloud/schema.js).
//
// Query style follows the documented tgcloud builder (Drizzle-style,
// core.telegram.org/bots/serverless — "The database"):
//   db.insert(table).values(row).run()
//   db.insert(table).values(row).onConflictDoUpdate({ target: col, set }).run()
//   db.insert(table).values(row).returning().run()   -> rows
//   db.select().from(table).where(eq(col, value)).get()   -> row | null
//   db.select().from(table).where(...).orderBy(desc(col)).limit(n).all()
//   db.update(table).set(patch).where(eq(col, value)).run()
//   db.delete(table).where(eq(col, value)).run()
// Every query is async; writes end with .run().

import { db } from 'sdk';
import { asc, desc, eq } from 'sdk/db';
import { emails, kv, outbox, rules, suppression } from '../schema.js';
import { evalRule } from './pure.js';

// ---------------------------------------------------------------------------
// kv: config and wizard state
// ---------------------------------------------------------------------------

export async function kvGet(key) {
  const row = await db.select().from(kv).where(eq(kv.key, key)).get();
  return row ? String(row.value) : null;
}

export async function kvSet(key, value) {
  const v = String(value);
  await db
    .insert(kv)
    .values({ key, value: v })
    .onConflictDoUpdate({ target: kv.key, set: { value: v } })
    .run();
}

export async function kvDelete(key) {
  await db.delete(kv).where(eq(kv.key, key)).run();
}

// ---------------------------------------------------------------------------
// emails: inbound mail saved from worker notifications
// ---------------------------------------------------------------------------

// labels is a JSON array string; 'archived' marks archived mail.
function parseLabels(row) {
  try {
    const parsed = JSON.parse(row.labels || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isArchivedRow(row) {
  return parseLabels(row).includes('archived');
}

export async function saveEmail({ id, from_addr, from_name, subject, snippet, body, received_at }) {
  const row = {
    id,
    from_addr: from_addr || '',
    from_name: from_name || '',
    subject: subject || '',
    snippet: snippet || '',
    body: body || '',
    received_at: received_at || Date.now(),
    is_read: 0,
    labels: '[]',
  };
  await db
    .insert(emails)
    .values(row)
    .onConflictDoUpdate({ target: emails.id, set: row })
    .run();
}

export async function getEmail(id) {
  return db.select().from(emails).where(eq(emails.id, id)).get();
}

export async function listInbox({ limit = 5, offset = 0, unreadOnly = false } = {}) {
  let query = db.select().from(emails);
  if (unreadOnly) query = query.where(eq(emails.is_read, 0));
  const rows = await query.orderBy(desc(emails.received_at)).limit(limit).offset(offset).all();
  return rows.filter((row) => !isArchivedRow(row));
}

export async function countInbox() {
  const rows = await db.select().from(emails).all();
  return rows.filter((row) => !isArchivedRow(row)).length;
}

export async function markRead(id) {
  await db.update(emails).set({ is_read: 1 }).where(eq(emails.id, id)).run();
}

export async function archiveEmail(id) {
  const row = await getEmail(id);
  if (!row) return;
  const labels = parseLabels(row);
  if (!labels.includes('archived')) labels.push('archived');
  await db
    .update(emails)
    .set({ labels: JSON.stringify(labels) })
    .where(eq(emails.id, id))
    .run();
}

// Search runs over the most recent 200 non-archived emails and filters in
// JavaScript. A companion mailbox is small, and this avoids LIKE escaping
// subtleties (%, _) on the wire.
export async function searchEmails(queryText, limit = 10) {
  const needle = String(queryText || '').toLowerCase().trim();
  if (!needle) return [];
  const rows = await db
    .select()
    .from(emails)
    .orderBy(desc(emails.received_at))
    .limit(200)
    .all();
  const hits = rows.filter((row) => {
    if (isArchivedRow(row)) return false;
    const haystack = [row.from_addr, row.from_name, row.subject, row.snippet, row.body]
      .map((part) => String(part || '').toLowerCase())
      .join('\n');
    return haystack.includes(needle);
  });
  return hits.slice(0, limit);
}

// ---------------------------------------------------------------------------
// outbox: queued and sent mail
// ---------------------------------------------------------------------------

export async function enqueueOutbox({ to_addrs, subject, body, send_at, idempotency_key }) {
  // id is autoIncrement: .returning() hands back the inserted row.
  const rows = await db
    .insert(outbox)
    .values({
      to_addrs: JSON.stringify(to_addrs),
      subject: subject || '',
      body: body || '',
      send_at: send_at || Date.now(),
      status: 'pending',
      idempotency_key: idempotency_key || '',
    })
    .returning()
    .run();
  return rows[0].id;
}

export async function updateOutboxStatus(id, status) {
  await db.update(outbox).set({ status }).where(eq(outbox.id, id)).run();
}

export async function listOutbox(limit = 10) {
  return db.select().from(outbox).orderBy(desc(outbox.send_at)).limit(limit).all();
}

// ---------------------------------------------------------------------------
// suppression: never send to these addresses
// ---------------------------------------------------------------------------

export async function addSuppression(address, reason) {
  const normalized = String(address).toLowerCase().trim();
  const existing = await db.select().from(suppression).where(eq(suppression.address, normalized)).get();
  if (existing) return;
  await db
    .insert(suppression)
    .values({ address: normalized, reason: reason || '', created_at: Date.now() })
    .run();
}

export async function isSuppressed(address) {
  const normalized = String(address).toLowerCase().trim();
  const row = await db.select().from(suppression).where(eq(suppression.address, normalized)).get();
  return row !== null;
}

// ---------------------------------------------------------------------------
// rules: simple from/subject matching, evaluated on save
// ---------------------------------------------------------------------------

export async function listRules() {
  return db.select().from(rules).orderBy(asc(rules.id)).all();
}

// Returns the actions of every rule matching the email, in rule order.
// The caller applies them; matching itself has no side effects.
export async function matchRules(email) {
  const matched = [];
  for (const rule of await listRules()) {
    let applies = false;
    try {
      applies = evalRule({ field: rule.field, matcher: rule.matcher, value: rule.value }, email);
    } catch {
      applies = false;
    }
    if (applies) matched.push(String(rule.action));
  }
  return matched;
}
