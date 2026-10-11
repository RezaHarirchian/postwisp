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

import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EmailMeta {
  id: string;
  provider: string;
  domain: string;
  fromAddr: string;
  subject: string;
  receivedAt: number;
  read: boolean;
  archived: boolean;
  trashed: boolean;
  labels: string[];
  threadId: string | null;
  // P1 additions; all optional so P0 callers keep compiling unchanged.
  // (The explicit `| undefined` keeps exactOptionalPropertyTypes happy when a
  // full record is assembled from a partially-populated provider event.)
  fromName?: string | undefined;
  to?: string[] | undefined;
  dateMs?: number | undefined;
  snippet?: string | undefined;
  bodyText?: string | null | undefined;
  bodyHtml?: string | null | undefined;
  attachments?: AttachmentRef[] | undefined;
  headers?: Record<string, string> | undefined;
  snoozedUntilMs?: number | null | undefined;
}

export interface AttachmentRef {
  id: string;
  filename: string;
  size: number;
  mime: string;
}

export type EmailRecord = EmailMeta;

export interface SearchQuery {
  from?: string;
  subject?: string;
  hasAttachment?: boolean;
  text?: string;
}

export interface SearchOptions {
  domain?: string;
  limit?: number;
  includeArchived?: boolean;
}

// Minimal structural view of a provider's inbound email event. Defined here so
// core never imports provider packages.
export interface EmailEventLike {
  id: string;
  provider: string;
  domain: string;
  from: string;
  fromName?: string;
  to?: string[];
  subject: string;
  dateMs?: number;
  receivedAt?: number;
  snippet?: string;
  bodyText?: string | null;
  bodyHtml?: string | null;
  attachments?: AttachmentRef[];
  headers?: Record<string, string>;
  threadId?: string | null;
  labels?: string[];
}

export interface RuleRow {
  id: number;
  name: string;
  matchFrom: string | null;
  matchSubject: string | null;
  action: string;
  actionArg: string | null;
  enabled: boolean;
}

export type BlockKind = 'block' | 'allow';

export interface Draft {
  id: number;
  to: string[];
  subject: string;
  body: string;
  identity: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewDraft {
  to: string[];
  subject: string;
  body: string;
  identity?: string | null;
}

export interface ScheduledSend {
  id: number;
  to: string[];
  subject: string;
  body: string;
  identity: string | null;
  sendAtMs: number;
  status: 'pending' | 'sent' | 'cancelled';
  providerId: string | null;
  createdAt: number;
}

export interface NewScheduledSend {
  to: string[];
  subject: string;
  body: string;
  identity?: string | null;
  sendAtMs: number;
}

export interface SentLog {
  id: number;
  providerId: string;
  to: string;
  subject: string;
  domain: string;
  sentAtMs: number;
  status: string;
  chatId: number | null;
  messageId: number | null;
}

export interface NewSentLog {
  providerId: string;
  to: string;
  subject: string;
  domain: string;
  status?: string;
  chatId?: number | null;
  messageId?: number | null;
}

// Versioned so future releases can migrate without wiping user data.
const SCHEMA_VERSION = 4;

const VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

const FULL_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppressed_addresses (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  domain TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  trashed INTEGER NOT NULL DEFAULT 0,
  labels TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  date_ms INTEGER,
  snippet TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  body_html TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '{}',
  snoozed_until_ms INTEGER
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  match_from TEXT,
  match_subject TEXT,
  action TEXT NOT NULL,
  action_arg TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS blocklist (
  address TEXT PRIMARY KEY,
  kind TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_domain ON emails(domain);
CREATE INDEX IF NOT EXISTS idx_emails_received ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_emails_snoozed ON emails(snoozed_until_ms);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  identity TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  identity TEXT,
  send_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_sends(status, send_at_ms);
CREATE TABLE IF NOT EXISTS sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL UNIQUE,
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  sent_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  chat_id INTEGER,
  message_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sent_log_domain ON sent_log(domain, sent_at_ms);
CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  address TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_consent_log_ts ON consent_log(ts);
`;

// Runs once per database, guarded by the stored version below. SQLite's
// ALTER TABLE has no IF NOT EXISTS, hence the explicit version gate.
const MIGRATION_V1_V2 = `
ALTER TABLE emails ADD COLUMN from_name TEXT;
ALTER TABLE emails ADD COLUMN to_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE emails ADD COLUMN date_ms INTEGER;
ALTER TABLE emails ADD COLUMN snippet TEXT NOT NULL DEFAULT '';
ALTER TABLE emails ADD COLUMN body_text TEXT;
ALTER TABLE emails ADD COLUMN body_html TEXT;
ALTER TABLE emails ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE emails ADD COLUMN headers_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE emails ADD COLUMN snoozed_until_ms INTEGER;
`;

// v2 -> v3 only adds tables, so plain CREATE TABLE IF NOT EXISTS suffices.
const MIGRATION_V2_V3 = `
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  identity TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  identity TEXT,
  send_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_sends(status, send_at_ms);
CREATE TABLE IF NOT EXISTS sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL UNIQUE,
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  sent_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  chat_id INTEGER,
  message_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sent_log_domain ON sent_log(domain, sent_at_ms);
`;

// v3 -> v4 only adds the consent audit log, so plain CREATE TABLE IF NOT
// EXISTS suffices.
const MIGRATION_V3_V4 = `
CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  event TEXT NOT NULL,
  address TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_consent_log_ts ON consent_log(ts);
`;

export interface ConsentLogEntry {
  id: number;
  ts: number;
  event: string;
  address: string;
  detail: string;
}

export interface SuppressedEntry {
  email: string;
  reason: string;
  createdAt: number;
}

export interface Store {
  get(key: string): string | null;
  set(key: string, value: string): void;
  suppressAddress(email: string, reason: string): void;
  isSuppressed(email: string): boolean;
  unsuppressAddress(email: string): void;
  saveEmailMeta(meta: EmailMeta): void;
  getEmailMeta(id: string): EmailMeta | null;
  listEmailMeta(opts?: { domain?: string; limit?: number }): EmailMeta[];
  searchEmails(q: SearchQuery, opts?: SearchOptions): EmailRecord[];
  noteWebhookEvent(eventId: string): boolean;
  hasWebhookEvent(eventId: string): boolean;
  createDraft(d: NewDraft): number;
  getDraft(id: number): Draft | null;
  listDrafts(): Draft[];
  updateDraft(id: number, d: Partial<NewDraft>): void;
  deleteDraft(id: number): void;
  scheduleSend(s: NewScheduledSend): number;
  listScheduled(): ScheduledSend[];
  cancelScheduled(id: number): void;
  dueScheduled(nowMs: number): ScheduledSend[];
  markScheduledSent(id: number, providerId: string): void;
  logSent(e: NewSentLog): void;
  getSentByProviderId(providerId: string): SentLog | null;
  updateSentStatus(providerId: string, status: string): void;
  listSentLog(opts?: { domain?: string; limit?: number }): SentLog[];
  saveFullEmail(ev: EmailEventLike): void;
  ruleList(): RuleRow[];
  ruleAdd(
    name: string,
    matchFrom: string | null,
    matchSubject: string | null,
    action: string,
    actionArg: string | null,
  ): number;
  ruleDelete(id: number): void;
  ruleSetEnabled(id: number, enabled: boolean): void;
  blockSet(address: string, kind: BlockKind): void;
  blockRemove(address: string): void;
  blockGet(address: string): BlockKind | null;
  snoozeSet(id: string, untilMs: number | null): void;
  dueSnoozed(nowMs: number): EmailRecord[];
  // Append-only audit trail of consent-relevant events: unsubscribes,
  // suppressions, and owner overrides. Never updated or deleted except by
  // a full data wipe.
  logConsent(event: string, address: string, detail: string): void;
  listConsentLog(limit?: number): ConsentLogEntry[];
  listSuppressed(limit?: number): SuppressedEntry[];
  // GDPR Art. 17: removes every user-data row (emails, kv, suppressions,
  // drafts, scheduled sends, sent log, rules, blocklist, consent log).
  // The schema itself is kept so the database stays usable.
  wipeAllData(): void;
  close(): void;
}

// A corrupt JSON column must not take down a whole listing: these run
// inside the 30s/60s timers, where an uncaught throw would crash the
// process. Parse each row defensively; callers skip the ones that fail.
// console.warn (not the Logger) because the store is created before any
// logger exists and must stay dependency-free.
function tryParseJson(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function rowToMeta(row: Record<string, unknown>): EmailMeta | null {
  const labels = tryParseJson(row['labels']);
  const to = tryParseJson(row['to_json'] ?? '[]');
  const attachments = tryParseJson(row['attachments_json'] ?? '[]');
  const headers = tryParseJson(row['headers_json'] ?? '{}');
  if (!labels.ok || !to.ok || !attachments.ok || !headers.ok) {
    console.warn(`postwisp: skipping email row with corrupt JSON (id=${String(row['id'])})`);
    return null;
  }
  return {
    id: row['id'] as string,
    provider: row['provider'] as string,
    domain: row['domain'] as string,
    fromAddr: row['from_addr'] as string,
    subject: row['subject'] as string,
    receivedAt: row['received_at'] as number,
    read: (row['read'] as number) === 1,
    archived: (row['archived'] as number) === 1,
    trashed: (row['trashed'] as number) === 1,
    labels: labels.value as string[],
    threadId: (row['thread_id'] as string | null) ?? null,
    fromName: (row['from_name'] as string | null) ?? undefined,
    to: to.value as string[],
    dateMs: (row['date_ms'] as number | null) ?? undefined,
    snippet: (row['snippet'] as string) ?? '',
    bodyText: (row['body_text'] as string | null) ?? null,
    bodyHtml: (row['body_html'] as string | null) ?? null,
    attachments: attachments.value as AttachmentRef[],
    headers: headers.value as Record<string, string>,
    snoozedUntilMs: (row['snoozed_until_ms'] as number | null) ?? null,
  };
}

function rowToRule(row: Record<string, unknown>): RuleRow {
  return {
    id: row['id'] as number,
    name: row['name'] as string,
    matchFrom: (row['match_from'] as string | null) ?? null,
    matchSubject: (row['match_subject'] as string | null) ?? null,
    action: row['action'] as string,
    actionArg: (row['action_arg'] as string | null) ?? null,
    enabled: (row['enabled'] as number) === 1,
  };
}

function rowToDraft(row: Record<string, unknown>): Draft | null {
  const to = tryParseJson(row['to_json'] as string);
  if (!to.ok) {
    console.warn(`postwisp: skipping draft row with corrupt JSON (id=${String(row['id'])})`);
    return null;
  }
  return {
    id: row['id'] as number,
    to: to.value as string[],
    subject: row['subject'] as string,
    body: row['body'] as string,
    identity: (row['identity'] as string | null) ?? null,
    createdAt: row['created_at'] as number,
    updatedAt: row['updated_at'] as number,
  };
}

function rowToScheduled(row: Record<string, unknown>): ScheduledSend | null {
  const to = tryParseJson(row['to_json'] as string);
  if (!to.ok) {
    console.warn(`postwisp: skipping scheduled-send row with corrupt JSON (id=${String(row['id'])})`);
    return null;
  }
  return {
    id: row['id'] as number,
    to: to.value as string[],
    subject: row['subject'] as string,
    body: row['body'] as string,
    identity: (row['identity'] as string | null) ?? null,
    sendAtMs: row['send_at_ms'] as number,
    status: row['status'] as ScheduledSend['status'],
    providerId: (row['provider_id'] as string | null) ?? null,
    createdAt: row['created_at'] as number,
  };
}

// Drops rows whose JSON columns failed to parse (see tryParseJson).
function compact<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

function rowToSentLog(row: Record<string, unknown>): SentLog {  return {
    id: row['id'] as number,
    providerId: row['provider_id'] as string,
    to: row['to_addr'] as string,
    subject: row['subject'] as string,
    domain: row['domain'] as string,
    sentAtMs: row['sent_at_ms'] as number,
    status: row['status'] as string,
    chatId: (row['chat_id'] as number | null) ?? null,
    messageId: (row['message_id'] as number | null) ?? null,
  };
}

// LIKE metacharacters in user input must not act as wildcards.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  // WAL survives crashes better than the default rollback journal; it is the
  // standard choice for a local app database with concurrent readers.
  db.pragma('journal_mode = WAL');

  db.exec(VERSION_TABLE);
  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  if (versionRow && versionRow.version < SCHEMA_VERSION) {
    // v1 databases predate the new email columns; the ALTERs must run before
    // the full schema (whose snoozed index references one of those columns).
    if (versionRow.version < 2) db.exec(MIGRATION_V1_V2);
    if (versionRow.version < 3) db.exec(MIGRATION_V2_V3);
    if (versionRow.version < 4) db.exec(MIGRATION_V3_V4);
    db.exec(FULL_SCHEMA);
    db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
  } else {
    db.exec(FULL_SCHEMA);
    if (!versionRow) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }

  if (dbPath !== ':memory:') {
    // Email bodies live in this file: it must never be world-readable.
    // SQLite creates the -wal/-shm sidecars lazily with default permissions,
    // so force them into existence with a no-op write before locking all
    // three down. The connection stays open for the process lifetime, so a
    // sidecar created here is the one later writes reuse.
    db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('__perm_probe__', '1')").run();
    db.prepare("DELETE FROM kv WHERE key = '__perm_probe__'").run();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(p)) chmodSync(p, 0o600);
    }
  }

  const getKv = db.prepare('SELECT value FROM kv WHERE key = ?');
  const setKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const insertSuppressed = db.prepare(
    'INSERT INTO suppressed_addresses (email, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET reason = excluded.reason',
  );
  const selectSuppressed = db.prepare('SELECT 1 FROM suppressed_addresses WHERE email = ?');
  const deleteSuppressed = db.prepare('DELETE FROM suppressed_addresses WHERE email = ?');
  // Base upsert leaves the extended columns untouched so callers that only
  // flip state (read/archived/trashed) never wipe a previously stored body.
  const upsertEmailBase = db.prepare(
    `INSERT INTO emails (id, provider, domain, from_addr, subject, received_at, read, archived, trashed, labels, thread_id)
     VALUES (@id, @provider, @domain, @fromAddr, @subject, @receivedAt, @read, @archived, @trashed, @labels, @threadId)
     ON CONFLICT(id) DO UPDATE SET
       read = excluded.read, archived = excluded.archived, trashed = excluded.trashed,
       labels = excluded.labels, thread_id = excluded.thread_id`,
  );
  const upsertEmailFull = db.prepare(
    `INSERT INTO emails (id, provider, domain, from_addr, subject, received_at, read, archived, trashed, labels, thread_id,
       from_name, to_json, date_ms, snippet, body_text, body_html, attachments_json, headers_json, snoozed_until_ms)
     VALUES (@id, @provider, @domain, @fromAddr, @subject, @receivedAt, @read, @archived, @trashed, @labels, @threadId,
       @fromName, @toJson, @dateMs, @snippet, @bodyText, @bodyHtml, @attachmentsJson, @headersJson, @snoozedUntilMs)
     ON CONFLICT(id) DO UPDATE SET
       read = excluded.read, archived = excluded.archived, trashed = excluded.trashed,
       labels = excluded.labels, thread_id = excluded.thread_id,
       from_name = excluded.from_name, to_json = excluded.to_json, date_ms = excluded.date_ms,
       snippet = excluded.snippet, body_text = excluded.body_text, body_html = excluded.body_html,
       attachments_json = excluded.attachments_json, headers_json = excluded.headers_json,
       snoozed_until_ms = excluded.snoozed_until_ms`,
  );
  const selectEmail = db.prepare('SELECT * FROM emails WHERE id = ?');
  const listEmails = db.prepare('SELECT * FROM emails WHERE (? IS NULL OR domain = ?) ORDER BY received_at DESC LIMIT ?');
  const insertWebhook = db.prepare(
    'INSERT OR IGNORE INTO webhook_events (event_id, received_at_ms) VALUES (?, ?)',
  );
  const selectWebhook = db.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?');
  const selectRules = db.prepare('SELECT * FROM rules ORDER BY id ASC');
  const insertRule = db.prepare(
    'INSERT INTO rules (name, match_from, match_subject, action, action_arg, enabled) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const deleteRule = db.prepare('DELETE FROM rules WHERE id = ?');
  const updateRuleEnabled = db.prepare('UPDATE rules SET enabled = ? WHERE id = ?');
  const upsertBlock = db.prepare(
    'INSERT INTO blocklist (address, kind) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET kind = excluded.kind',
  );
  const deleteBlock = db.prepare('DELETE FROM blocklist WHERE address = ?');
  const selectBlock = db.prepare('SELECT kind FROM blocklist WHERE address = ?');
  const updateSnooze = db.prepare('UPDATE emails SET snoozed_until_ms = ? WHERE id = ?');
  const selectDueSnoozed = db.prepare(
    'SELECT * FROM emails WHERE snoozed_until_ms IS NOT NULL AND snoozed_until_ms <= ? AND trashed = 0 ORDER BY snoozed_until_ms ASC',
  );
  const insertDraft = db.prepare(
    'INSERT INTO drafts (to_json, subject, body, identity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectDraft = db.prepare('SELECT * FROM drafts WHERE id = ?');
  const listDrafts = db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC');
  const updateDraft = db.prepare(
    'UPDATE drafts SET to_json = ?, subject = ?, body = ?, identity = ?, updated_at = ? WHERE id = ?',
  );
  const deleteDraft = db.prepare('DELETE FROM drafts WHERE id = ?');
  const insertScheduled = db.prepare(
    "INSERT INTO scheduled_sends (to_json, subject, body, identity, send_at_ms, status, provider_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const listScheduled = db.prepare("SELECT * FROM scheduled_sends WHERE status = 'pending' ORDER BY send_at_ms ASC");
  const updateScheduledStatus = db.prepare('UPDATE scheduled_sends SET status = ? WHERE id = ?');
  const selectDueScheduled = db.prepare(
    "SELECT * FROM scheduled_sends WHERE status = 'pending' AND send_at_ms <= ? ORDER BY send_at_ms ASC",
  );
  const markScheduledSent = db.prepare(
    "UPDATE scheduled_sends SET status = 'sent', provider_id = ? WHERE id = ?",
  );
  const insertSentLog = db.prepare(
    'INSERT INTO sent_log (provider_id, to_addr, subject, domain, sent_at_ms, status, chat_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const selectSentByProvider = db.prepare('SELECT * FROM sent_log WHERE provider_id = ?');
  const updateSentStatus = db.prepare('UPDATE sent_log SET status = ? WHERE provider_id = ?');
  const listSentLog = db.prepare(
    'SELECT * FROM sent_log WHERE (? IS NULL OR domain = ?) ORDER BY sent_at_ms DESC LIMIT ?',
  );
  const insertConsent = db.prepare(
    'INSERT INTO consent_log (ts, event, address, detail) VALUES (?, ?, ?, ?)',
  );
  const listConsentLog = db.prepare('SELECT * FROM consent_log ORDER BY ts DESC LIMIT ?');
  const listSuppressed = db.prepare(
    // rowid breaks ties when two suppressions land in the same millisecond.
    'SELECT email, reason, created_at FROM suppressed_addresses ORDER BY created_at DESC, rowid DESC LIMIT ?',
  );

  const toDbBase = (meta: EmailMeta) => ({
    id: meta.id,
    provider: meta.provider,
    domain: meta.domain,
    fromAddr: meta.fromAddr,
    subject: meta.subject,
    receivedAt: meta.receivedAt,
    read: meta.read ? 1 : 0,
    archived: meta.archived ? 1 : 0,
    trashed: meta.trashed ? 1 : 0,
    labels: JSON.stringify(meta.labels),
    threadId: meta.threadId,
  });

  const toDbFull = (meta: EmailMeta) => ({
    ...toDbBase(meta),
    fromName: meta.fromName ?? null,
    toJson: JSON.stringify(meta.to ?? []),
    dateMs: meta.dateMs ?? null,
    snippet: meta.snippet ?? '',
    bodyText: meta.bodyText ?? null,
    bodyHtml: meta.bodyHtml ?? null,
    attachmentsJson: JSON.stringify(meta.attachments ?? []),
    headersJson: JSON.stringify(meta.headers ?? {}),
    snoozedUntilMs: meta.snoozedUntilMs ?? null,
  });

  // Presence of any extended field means the caller owns the full record.
  const EXTENDED_KEYS = [
    'fromName',
    'to',
    'dateMs',
    'snippet',
    'bodyText',
    'bodyHtml',
    'attachments',
    'headers',
    'snoozedUntilMs',
  ] as const;

  return {
    get(key: string): string | null {
      const row = getKv.get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
    set(key: string, value: string): void {
      setKv.run(key, value);
    },
    suppressAddress(email: string, reason: string): void {
      insertSuppressed.run(email.trim().toLowerCase(), reason, Date.now());
    },
    isSuppressed(email: string): boolean {
      return selectSuppressed.get(email.trim().toLowerCase()) !== undefined;
    },
    unsuppressAddress(email: string): void {
      deleteSuppressed.run(email.trim().toLowerCase());
    },
    saveEmailMeta(meta: EmailMeta): void {
      if (EXTENDED_KEYS.some((k) => meta[k] !== undefined)) {
        upsertEmailFull.run(toDbFull(meta));
      } else {
        upsertEmailBase.run(toDbBase(meta));
      }
    },
    getEmailMeta(id: string): EmailMeta | null {
      const row = selectEmail.get(id) as Record<string, unknown> | undefined;
      return row ? rowToMeta(row) : null;
    },
    listEmailMeta(opts: { domain?: string; limit?: number } = {}): EmailMeta[] {
      // A negative LIMIT means "no limit" in SQLite; clamp so callers cannot
      // accidentally dump the whole table.
      const limit = Math.max(0, Math.floor(opts.limit ?? 50));
      const rows = listEmails.all(opts.domain ?? null, opts.domain ?? null, limit) as Record<
        string,
        unknown
      >[];
      return compact(rows.map(rowToMeta));
    },
    searchEmails(q: SearchQuery, opts: SearchOptions = {}): EmailRecord[] {
      const clauses: string[] = ['trashed = 0', '(? IS NULL OR domain = ?)'];
      const params: unknown[] = [opts.domain ?? null, opts.domain ?? null];
      if (!opts.includeArchived) clauses.push('archived = 0');
      if (q.from !== undefined) {
        clauses.push('(lower(from_addr) LIKE ? ESCAPE \'\\\' OR lower(from_name) LIKE ? ESCAPE \'\\\')');
        const like = `%${escapeLike(q.from.toLowerCase())}%`;
        params.push(like, like);
      }
      if (q.subject !== undefined) {
        clauses.push('lower(subject) LIKE ? ESCAPE \'\\\'');
        params.push(`%${escapeLike(q.subject.toLowerCase())}%`);
      }
      if (q.text !== undefined) {
        clauses.push(
          "lower(subject || ' ' || ifnull(snippet, '') || ' ' || ifnull(body_text, '')) LIKE ? ESCAPE '\\'",
        );
        params.push(`%${escapeLike(q.text.toLowerCase())}%`);
      }
      if (q.hasAttachment !== undefined) {
        clauses.push(q.hasAttachment ? "attachments_json != '[]'" : "attachments_json = '[]'");
      }
      const limit = Math.max(0, Math.floor(opts.limit ?? 50));
      const rows = db
        .prepare(`SELECT * FROM emails WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC LIMIT ?`)
        .all(...params, limit) as Record<string, unknown>[];
      return compact(rows.map(rowToMeta));
    },
    noteWebhookEvent(eventId: string): boolean {
      // INSERT OR IGNORE: first sighting inserts (changes = 1), replays do not.
      return insertWebhook.run(eventId, Date.now()).changes === 1;
    },
    hasWebhookEvent(eventId: string): boolean {
      return selectWebhook.get(eventId) !== undefined;
    },
    saveFullEmail(ev: EmailEventLike): void {
      upsertEmailFull.run(
        toDbFull({
          id: ev.id,
          provider: ev.provider,
          domain: ev.domain,
          fromAddr: ev.from,
          subject: ev.subject,
          receivedAt: ev.receivedAt ?? ev.dateMs ?? Date.now(),
          read: false,
          archived: false,
          trashed: false,
          labels: ev.labels ?? [],
          threadId: ev.threadId ?? null,
          fromName: ev.fromName,
          to: ev.to,
          dateMs: ev.dateMs,
          snippet: ev.snippet,
          bodyText: ev.bodyText,
          bodyHtml: ev.bodyHtml,
          attachments: ev.attachments,
          headers: ev.headers,
          snoozedUntilMs: null,
        }),
      );
    },
    ruleList(): RuleRow[] {
      const rows = selectRules.all() as Record<string, unknown>[];
      return rows.map(rowToRule);
    },
    ruleAdd(
      name: string,
      matchFrom: string | null,
      matchSubject: string | null,
      action: string,
      actionArg: string | null,
    ): number {
      const info = insertRule.run(name, matchFrom, matchSubject, action, actionArg, 1);
      return Number(info.lastInsertRowid);
    },
    ruleDelete(id: number): void {
      deleteRule.run(id);
    },
    ruleSetEnabled(id: number, enabled: boolean): void {
      updateRuleEnabled.run(enabled ? 1 : 0, id);
    },
    blockSet(address: string, kind: BlockKind): void {
      upsertBlock.run(address, kind);
    },
    blockRemove(address: string): void {
      deleteBlock.run(address);
    },
    blockGet(address: string): BlockKind | null {
      const row = selectBlock.get(address) as { kind: string } | undefined;
      return row ? (row.kind as BlockKind) : null;
    },
    snoozeSet(id: string, untilMs: number | null): void {
      updateSnooze.run(untilMs, id);
    },
    dueSnoozed(nowMs: number): EmailRecord[] {
      const rows = selectDueSnoozed.all(nowMs) as Record<string, unknown>[];
      return compact(rows.map(rowToMeta));
    },
    createDraft(d: NewDraft): number {
      const now = Date.now();
      const info = insertDraft.run(
        JSON.stringify(d.to),
        d.subject,
        d.body,
        d.identity ?? null,
        now,
        now,
      );
      return Number(info.lastInsertRowid);
    },
    getDraft(id: number): Draft | null {
      const row = selectDraft.get(id) as Record<string, unknown> | undefined;
      return row ? rowToDraft(row) : null;
    },
    listDrafts(): Draft[] {
      const rows = listDrafts.all() as Record<string, unknown>[];
      return compact(rows.map(rowToDraft));
    },
    updateDraft(id: number, d: Partial<NewDraft>): void {
      const cur = selectDraft.get(id) as Record<string, unknown> | undefined;
      const draft = cur ? rowToDraft(cur) : null;
      if (!draft) return;
      updateDraft.run(
        d.to !== undefined ? JSON.stringify(d.to) : JSON.stringify(draft.to),
        d.subject !== undefined ? d.subject : draft.subject,
        d.body !== undefined ? d.body : draft.body,
        d.identity !== undefined ? d.identity : draft.identity,
        Date.now(),
        id,
      );
    },
    deleteDraft(id: number): void {
      deleteDraft.run(id);
    },
    scheduleSend(s: NewScheduledSend): number {
      const info = insertScheduled.run(
        JSON.stringify(s.to),
        s.subject,
        s.body,
        s.identity ?? null,
        s.sendAtMs,
        'pending',
        null,
        Date.now(),
      );
      return Number(info.lastInsertRowid);
    },
    listScheduled(): ScheduledSend[] {
      const rows = listScheduled.all() as Record<string, unknown>[];
      return compact(rows.map(rowToScheduled));
    },
    cancelScheduled(id: number): void {
      updateScheduledStatus.run('cancelled', id);
    },
    dueScheduled(nowMs: number): ScheduledSend[] {
      const rows = selectDueScheduled.all(nowMs) as Record<string, unknown>[];
      return compact(rows.map(rowToScheduled));
    },
    markScheduledSent(id: number, providerId: string): void {
      markScheduledSent.run(providerId, id);
    },
    logSent(e: NewSentLog): void {
      insertSentLog.run(
        e.providerId,
        e.to,
        e.subject,
        e.domain,
        Date.now(),
        e.status ?? 'sent',
        e.chatId ?? null,
        e.messageId ?? null,
      );
    },
    getSentByProviderId(providerId: string): SentLog | null {
      const row = selectSentByProvider.get(providerId) as Record<string, unknown> | undefined;
      return row ? rowToSentLog(row) : null;
    },
    updateSentStatus(providerId: string, status: string): void {
      updateSentStatus.run(status, providerId);
    },
    listSentLog(opts: { domain?: string; limit?: number } = {}): SentLog[] {
      const limit = Math.max(0, Math.floor(opts.limit ?? 50));
      const rows = listSentLog.all(opts.domain ?? null, opts.domain ?? null, limit) as Record<
        string,
        unknown
      >[];
      return rows.map(rowToSentLog);
    },
    logConsent(event: string, address: string, detail: string): void {
      insertConsent.run(Date.now(), event, address.trim().toLowerCase(), detail);
    },
    listConsentLog(limit = 50): ConsentLogEntry[] {
      const rows = listConsentLog.all(Math.max(0, Math.floor(limit))) as Record<string, unknown>[];
      return rows.map((row) => ({
        id: row['id'] as number,
        ts: row['ts'] as number,
        event: row['event'] as string,
        address: row['address'] as string,
        detail: row['detail'] as string,
      }));
    },
    listSuppressed(limit = 50): SuppressedEntry[] {
      const rows = listSuppressed.all(Math.max(0, Math.floor(limit))) as Record<string, unknown>[];
      return rows.map((row) => ({
        email: row['email'] as string,
        reason: row['reason'] as string,
        createdAt: row['created_at'] as number,
      }));
    },
    wipeAllData(): void {
      // One transaction: the wipe either completes fully or not at all.
      const wipe = db.transaction(() => {
        for (const table of [
          'emails',
          'kv',
          'suppressed_addresses',
          'drafts',
          'scheduled_sends',
          'sent_log',
          'webhook_events',
          'rules',
          'blocklist',
          'consent_log',
        ]) {
          db.prepare(`DELETE FROM ${table}`).run();
        }
      });
      wipe();
    },
    close(): void {
      db.close();
    },
  };
}
