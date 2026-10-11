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

import type { Store, EmailMeta, SearchQuery as CoreSearchQuery, EmailEventLike } from '../core/store.js';
import {
  parseSearch as coreParseSearch,
  extractOtp,
  addRule,
  snoozeEmail as coreSnoozeEmail,
  blockAddress,
} from '../core/inbox.js';
import type { EmailEvent } from '../providers/interface.js';
import type { BotStore, SearchFns, SearchQuery } from './index.js';
import type { EmailViewRecord } from './views.js';

// The bot layer was built against narrow seam interfaces before the inbox
// core landed. These adapters bind the canonical store to those seams so
// bot/index.ts needs no changes at merge time.
//
// The bot-layer SearchQuery and the core SearchQuery are structurally
// identical but distinct types; normalize at runtime instead of casting
// blindly, so a shape drift on either side fails safe instead of
// silently.
function toBotQuery(q: CoreSearchQuery): SearchQuery {
  const out: SearchQuery = {};
  if (typeof q.from === 'string') out.from = q.from;
  if (typeof q.subject === 'string') out.subject = q.subject;
  if (typeof q.hasAttachment === 'boolean') out.hasAttachment = q.hasAttachment;
  if (typeof q.text === 'string') out.text = q.text;
  return out;
}

function toCoreQuery(q: SearchQuery): CoreSearchQuery {
  const out: CoreSearchQuery = {};
  if (typeof q.from === 'string') out.from = q.from;
  if (typeof q.subject === 'string') out.subject = q.subject;
  if (typeof q.hasAttachment === 'boolean') out.hasAttachment = q.hasAttachment;
  if (typeof q.text === 'string') out.text = q.text;
  return out;
}

// Note: the project compiles with exactOptionalPropertyTypes, so optional
// fields are assigned conditionally rather than as explicit undefined.
export function toEventLike(ev: EmailEvent): EmailEventLike {
  const like: EmailEventLike = {
    id: ev.id,
    provider: ev.provider,
    domain: ev.domain,
    from: ev.from.address,
    subject: ev.subject,
  };
  if (ev.from.name !== undefined) like.fromName = ev.from.name;
  if (ev.to !== undefined) like.to = ev.to;
  if (ev.dateMs !== undefined) like.dateMs = ev.dateMs;
  if (ev.snippet !== undefined) like.snippet = ev.snippet;
  if (ev.bodyText !== undefined) like.bodyText = ev.bodyText;
  if (ev.bodyHtml !== undefined) like.bodyHtml = ev.bodyHtml;
  if (ev.attachments !== undefined) like.attachments = ev.attachments.map((a) => ({ ...a }));
  if (ev.headers !== undefined) like.headers = ev.headers;
  if (ev.threadId !== undefined) like.threadId = ev.threadId;
  return like;
}

export function toViewRecord(meta: EmailMeta): EmailViewRecord {
  const view: EmailViewRecord = {
    id: meta.id,
    domain: meta.domain,
    fromAddr: meta.fromAddr,
    subject: meta.subject,
    dateMs: meta.dateMs ?? meta.receivedAt,
    isRead: meta.read,
  };
  if (meta.fromName !== undefined) view.fromName = meta.fromName;
  if (meta.snippet !== undefined) view.snippet = meta.snippet;
  if (meta.bodyText !== undefined) view.bodyText = meta.bodyText;
  if (meta.attachments !== undefined) view.attachments = meta.attachments.map((a) => ({ ...a }));
  if (meta.threadId !== undefined && meta.threadId !== null) view.threadId = meta.threadId;
  return view;
}

// Rebuild a provider-shaped event from a stored row (snooze-due re-notify).
export function toEmailEvent(meta: EmailMeta): EmailEvent {
  const ev: EmailEvent = {
    id: meta.id,
    provider: meta.provider,
    domain: meta.domain,
    from: { address: meta.fromAddr },
    subject: meta.subject,
    dateMs: meta.dateMs ?? meta.receivedAt,
    snippet: meta.snippet ?? '',
    bodyText: meta.bodyText ?? null,
    bodyHtml: meta.bodyHtml ?? null,
    attachments: (meta.attachments ?? []).map((a) => ({ ...a })),
    threadId: meta.threadId,
    headers: meta.headers ?? {},
    to: [],
  };
  if (meta.fromName !== undefined) ev.from.name = meta.fromName;
  if (meta.to !== undefined) ev.to = meta.to;
  return ev;
}

export function adaptStore(store: Store): BotStore {
  return {
    getSetting: (key: string): string | null => store.get(key),
    setSetting: (key: string, value: string): void => {
      store.set(key, value);
    },
    getEmail: (id: string): EmailViewRecord | null => {
      const meta = store.getEmailMeta(id);
      return meta ? toViewRecord(meta) : null;
    },
    listEmails: (opts?: { domain?: string; limit?: number }): EmailViewRecord[] => {
      const searchOpts: { domain?: string; limit?: number } = {};
      if (opts?.domain !== undefined) searchOpts.domain = opts.domain;
      if (opts?.limit !== undefined) searchOpts.limit = opts.limit;
      return store.listEmailMeta(searchOpts).map(toViewRecord);
    },
    setRead: (id: string, read: boolean): void => {
      const meta = store.getEmailMeta(id);
      if (meta) store.saveEmailMeta({ ...meta, read });
    },
    setArchived: (id: string, archived: boolean): void => {
      const meta = store.getEmailMeta(id);
      if (meta) store.saveEmailMeta({ ...meta, archived });
    },
    snoozeEmail: (id: string, untilMs: number): void => {
      coreSnoozeEmail(store, id, untilMs);
    },
    blockSender: (address: string): void => {
      blockAddress(store, address);
    },
    addArchiveRule: (from: string, subject: string): void => {
      addRule(store, {
        name: `archive: ${from}${subject ? ` / ${subject}` : ''}`,
        matchFrom: from || null,
        matchSubject: subject || null,
        action: 'archive',
        actionArg: null,
      });
    },
  };
}

export function adaptSearch(store: Store): SearchFns {
  return {
    parseSearch: (q: string): SearchQuery => toBotQuery(coreParseSearch(q)),
    searchEmails: (q: SearchQuery, opts?: { limit?: number }): EmailViewRecord[] => {
      const searchOpts: { limit?: number } = {};
      if (opts?.limit !== undefined) searchOpts.limit = opts.limit;
      return store.searchEmails(toCoreQuery(q), searchOpts).map(toViewRecord);
    },
  };
}

export { extractOtp };
