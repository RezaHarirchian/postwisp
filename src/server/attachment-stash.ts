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

import type { Store } from '../core/store.js';

// The single attachment-stash implementation. Every inbound path that
// receives attachment bytes inline (MailerSend's inbound route forward,
// Mailgun's body-mime, the Cloudflare worker payload) stashes them here
// in kv for the bot's download seam, instead of keeping the raw payload
// around. The namespace keeps key spaces disjoint: provider inbound
// routes use `inbound-att:<provider>`, the Cloudflare worker path uses
// `cfatt` (kept stable so keys written by earlier releases stay readable).

// Telegram bots cannot receive files over 20 MB; an entry over that is
// reported as too large rather than stashed back out.
const MAX_STASHED_DOWNLOAD = 20 * 1024 * 1024;
// The kv stash keeps attachment bytes bounded per email; anything over is
// skipped at ingest so one message cannot fill the database.
const ATTACHMENT_KV_CAP = 20 * 1024 * 1024;

function namespacedKey(namespace: string, emailId: string, attachmentId: string): string {
  return `${namespace}:${emailId}:${attachmentId}`;
}

export function stashAttachmentKey(
  providerName: string,
  emailId: string,
  attachmentId: string,
): string {
  return namespacedKey(`inbound-att:${providerName}`, emailId, attachmentId);
}

export const CF_ATTACHMENT_NAMESPACE = 'cfatt';

export function cfAttachmentKey(emailId: string, attachmentId: string): string {
  return namespacedKey(CF_ATTACHMENT_NAMESPACE, emailId, attachmentId);
}

export interface StashableAttachment {
  id: string;
  filename: string;
  content: Buffer;
}

export type StashedAttachment =
  | { found: true; filename: string; data: Buffer }
  | { found: false; reason: 'missing' | 'too_large' };

// Reads back what the stash functions stored. The stored email row's
// attachment metadata already carries the filename; a bare attachment id
// is the fallback only when the row is gone.
function readStashed(
  store: Store,
  key: string,
  emailId: string,
  attachmentId: string,
): StashedAttachment {
  const b64 = store.get(key);
  if (b64 === null) return { found: false, reason: 'missing' };
  const data = Buffer.from(b64, 'base64');
  if (data.length > MAX_STASHED_DOWNLOAD) return { found: false, reason: 'too_large' };
  const filename =
    store.getEmailMeta(emailId)?.attachments?.find((a) => a.id === attachmentId)?.filename ??
    `${attachmentId}.bin`;
  return { found: true, filename, data };
}

export function readStashedAttachment(
  store: Store,
  providerName: string,
  emailId: string,
  attachmentId: string,
): StashedAttachment {
  return readStashed(store, stashAttachmentKey(providerName, emailId, attachmentId), emailId, attachmentId);
}

export function readCloudflareStashedAttachment(
  store: Store,
  emailId: string,
  attachmentId: string,
): StashedAttachment {
  return readStashed(store, cfAttachmentKey(emailId, attachmentId), emailId, attachmentId);
}

// Stores attachment bytes in kv for the bot's download seam. Entries
// without bytes are listed in the email metadata but have nothing to
// download, so they are skipped here. An empty email id would make the
// key unretrievable through the download seam, so nothing is stashed then
// either; the email itself is still processed (the route dedupes on a body
// hash in that case).
function stashEntries(
  store: Store,
  emailId: string,
  entries: Array<{ id: string; key: string; data: Buffer }>,
): void {
  if (emailId.length === 0) return;
  let stored = 0;
  for (const entry of entries) {
    if (entry.id.length === 0 || entry.data.length === 0) continue;
    if (stored + entry.data.length > ATTACHMENT_KV_CAP) continue;
    store.set(entry.key, entry.data.toString('base64'));
    stored += entry.data.length;
  }
}

export function stashInlineAttachments(
  store: Store,
  providerName: string,
  emailId: string,
  items: StashableAttachment[],
): void {
  stashEntries(
    store,
    emailId,
    items.map((item) => ({
      id: item.id,
      key: stashAttachmentKey(providerName, emailId, item.id),
      data: item.content,
    })),
  );
}

// The Cloudflare worker posts attachment bytes inline as base64 inside the
// payload. Entries without bytes (truncated by the worker) are skipped;
// they are still listed in the email metadata, just with nothing to
// download. Exported so the per-email cap can be tested without pushing
// megabytes over HTTP.
export function stashCloudflareAttachments(
  store: Store,
  emailId: string,
  rawAttachments: unknown,
): void {
  if (!Array.isArray(rawAttachments)) return;
  const entries: Array<{ id: string; key: string; data: Buffer }> = [];
  for (const entry of rawAttachments) {
    if (typeof entry !== 'object' || entry === null) continue;
    const a = entry as Record<string, unknown>;
    const attId = a['id'];
    const b64 = a['contentBase64'];
    if (typeof attId !== 'string' || attId.length === 0) continue;
    if (typeof b64 !== 'string' || b64.length === 0) continue;
    entries.push({ id: attId, key: cfAttachmentKey(emailId, attId), data: Buffer.from(b64, 'base64') });
  }
  stashEntries(store, emailId, entries);
}
