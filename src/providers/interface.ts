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

// ---------------------------------------------------------------------------
// STABILITY: this file is the frozen v1 provider contract. Every adapter
// (resend, mailersend, mailgun, and any future one) implements EmailProvider
// exactly as defined here, and the bot layer programs against these types
// only. A breaking change here (renaming or removing a member, changing a
// signature, narrowing an accepted shape) requires ALL of:
//   1. a major version bump of postwisp,
//   2. a migration note in docs/PROVIDER-INTERFACE.md describing what
//      changed and how adapters and callers must adapt,
//   3. updates to every adapter in the same commit.
// Additive changes (new optional members, new provider modules) are not
// breaking and do not need a major bump.
// ---------------------------------------------------------------------------

// One contract every mail provider adapter must satisfy. The bot talks to
// this shape only; anything provider-specific stays inside the adapter.

// A normalized inbound event ready for the bot layer. No provider-specific
// fields leak through: downstream code must not branch on provider names.
export interface EmailEvent {
  id: string;
  provider: string;
  domain: string;
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  dateMs: number;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ id: string; filename: string; size: number; mime: string }>;
  threadId: string | null;
  headers: Record<string, string>;
}

// Everything send() needs today. Full compose (templates, drafts,
// scheduled sends) is P2; the shape already carries what Resend supports
// so the adapter stays a thin mapping.
export interface SendInput {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: Buffer | string; mime?: string }>;
  scheduledAt?: string;
  idempotencyKey?: string;
}

export interface SendResult {
  id: string;
}

// Full content of one received email. downloadUrl entries are signed,
// short-lived URLs: the bot downloads the bytes via downloadAttachment
// and never shows the URL itself anywhere.
export interface InboundEmail {
  id: string;
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  dateMs: number;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ id: string; filename: string; size: number; mime: string; downloadUrl: string }>;
  threadId: string | null;
  headers: Record<string, string>;
}

export interface SentEmail {
  id: string;
  from: string;
  to: string[];
  subject: string;
  dateMs: number;
  status: string;
}

// A delivery outcome for a message we sent. Carries no content, only the
// provider id the sent log was keyed on; the bot layer maps it to a
// sent-log row and updates the chat message. Every provider's webhook
// route normalizes its delivery events to this shape before handing them
// downstream, so one handler serves all providers.
export interface DeliveryEvent {
  type: 'delivered' | 'bounced' | 'complained' | 'failed';
  emailId: string;
}

export interface EmailProvider {
  name: string;
  send(input: SendInput): Promise<SendResult>;
  getInboundEmail(id: string): Promise<InboundEmail>;
  downloadAttachment(downloadUrl: string): Promise<Buffer>;
  listSentEmails(opts: { domain?: string; limit?: number }): Promise<SentEmail[]>;
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): { ok: true } | { ok: false; reason: string };
  capabilities: { scheduling: boolean; batch: boolean };
}
