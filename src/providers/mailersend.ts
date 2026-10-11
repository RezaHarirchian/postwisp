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

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  DeliveryEvent,
  EmailEvent,
  EmailProvider,
  InboundEmail,
  SendInput,
  SendResult,
  SentEmail,
} from './interface.js';
import { parseAddress, snippetOf } from './normalize.js';
import { fetchWithRateRetry, rateLimitedFetch, RateLimiter } from './http.js';

// Wire facts below are per developers.mailersend.com (email API,
// webhooks, messages/emails reference) and mailersend.com/help
// (inbound routes). Anything the docs do not publish — notably a JSON
// schema for the inbound-route forward payload — is read defensively
// and marked as an assumption in the comments.

const API_BASE = 'https://api.mailersend.com/v1';
const USER_AGENT = 'postwisp/0.1.0';

// Published in MailerSend's webhook docs as the fixed signature for the
// "webhook.test" ping sent when a webhook is created. It authorizes the
// ping only; real events must always verify against the webhook's own
// signing secret (see verifyWebhook).
const WEBHOOK_TEST_SECRET = 'test_Am3L1GuOIc4blLUuHqAPxxwkZaJyEk8G';

// Attachment downloads go through the MailerSend API only. Anything else
// is a potential exfil target, not an attachment.
const ATTACHMENT_HOST_SUFFIXES = ['.mailersend.com'];

export interface MailerSendProviderOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  // Test seam: a RateLimiter with a fake clock/wait keeps tests fast.
  limiter?: RateLimiter;
}

// Unknown JSON from MailerSend: every accessor defends itself so one
// unexpected field shape never crashes the webhook path.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

// "Name <addr>", a bare address, or MailerSend's {email, name} object.
function parseMailbox(value: unknown): { address: string; name?: string } {
  const rec = asRecord(value);
  if (typeof rec['email'] === 'string') {
    return typeof rec['name'] === 'string' && rec['name'].length > 0
      ? { address: rec['email'], name: rec['name'] }
      : { address: rec['email'] };
  }
  return parseAddress(asString(value));
}

function flattenHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(asRecord(value))) {
    if (typeof val === 'string') {
      out[key.toLowerCase()] = val;
    }
  }
  return out;
}

export class MailerSendProvider implements EmailProvider {
  readonly name = 'mailersend';
  // MailerSend supports deferred delivery (send_at) but has no single-call
  // multi-recipient batch with per-recipient visibility guarantees, so
  // batch stays false.
  readonly capabilities = { scheduling: true, batch: false };

  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  // Rate-limited fetch for provider API calls. Signed-URL attachment
  // downloads are not API calls and go through the raw fetchFn.
  private readonly apiFetch: typeof fetch;

  constructor(options: MailerSendProviderOptions) {
    if (!options.apiKey) {
      throw new Error('mailersend provider requires an api key');
    }
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiFetch = rateLimitedFetch(this.fetchFn, options.limiter ?? new RateLimiter());
  }

  private async request<T>(method: string, path: string, query?: string): Promise<T> {
    const response = await this.apiFetch(`${API_BASE}${path}${query ?? ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`mailersend ${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }

  // MailerSend's 422 bodies carry {message, errors}; surface the message
  // so the caller gets the reason, not just a status code.
  private sendError(status: number, raw: string): Error {
    let message = '';
    try {
      message = asString(asRecord(JSON.parse(raw))['message']);
    } catch {
      // Not JSON: fall back to the raw text below.
    }
    const detail = message || raw.trim().slice(0, 300);
    return new Error(`mailersend send failed: ${status}${detail ? ` ${detail}` : ''}`);
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.to.length === 0) {
      throw new Error('send requires at least one recipient');
    }
    const from = parseMailbox(input.from);
    // Custom headers are an enterprise-only feature in MailerSend's API;
    // sending them on a non-enterprise account fails the request, so they
    // are omitted except In-Reply-To, which the API accepts on any account
    // (needed for threading replies).
    const inReplyTo = input.headers
      ? Object.entries(input.headers).find(([k]) => k.toLowerCase() === 'in-reply-to')?.[1]
      : undefined;
    // send_at is a unix timestamp (seconds) per the email API docs.
    let sendAt: number | undefined;
    if (input.scheduledAt !== undefined) {
      sendAt = Math.floor(Date.parse(input.scheduledAt) / 1000);
      if (!Number.isFinite(sendAt)) {
        throw new Error('scheduledAt is not a valid date');
      }
    }
    // A 429 is retried once after the provider's Retry-After; see http.ts.
    const response = await fetchWithRateRetry(this.apiFetch, `${API_BASE}/email`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { email: from.address, ...(from.name ? { name: from.name } : {}) },
        to: input.to.map((email) => ({ email })),
        subject: input.subject,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.cc ? { cc: input.cc.map((email) => ({ email })) } : {}),
        ...(input.bcc ? { bcc: input.bcc.map((email) => ({ email })) } : {}),
        ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        ...(input.attachments
          ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
                ...(a.mime ? { content_type: a.mime } : {}),
              })),
            }
          : {}),
        // send_at is a unix timestamp (seconds) per the email API docs.
        ...(sendAt !== undefined ? { send_at: sendAt } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw this.sendError(response.status, detail);
    }
    // Success is 202 with an empty body; the message id comes from the
    // X-Message-Id response header. Delivery webhooks report the same id
    // at data.email.message.id, so the sent log keys on it directly.
    const id = response.headers.get('x-message-id') ?? '';
    if (!id) {
      throw new Error('mailersend send returned no X-Message-Id header');
    }
    return { id };
  }

  // MailerSend documents no API endpoint to fetch a received message by
  // id — received mail only appears in the dashboard's "Inbound activity"
  // log. The inbound route webhook already posts the full parsed message,
  // so the route normalizes that payload directly and never calls this.
  async getInboundEmail(_id: string): Promise<InboundEmail> {
    throw new Error(
      'mailersend getInboundEmail is not supported: MailerSend posts the full parsed ' +
        'message to the inbound route webhook and documents no fetch-by-id endpoint',
    );
  }

  // Only MailerSend API hosts: never fetch an attacker-supplied URL, and
  // never hand the URL itself to the bot UI.
  async downloadAttachment(downloadUrl: string): Promise<Buffer> {
    let hostname: string;
    try {
      hostname = new URL(downloadUrl).hostname.toLowerCase();
    } catch {
      throw new Error('refusing to download attachment: not a valid URL');
    }
    const allowed =
      hostname === 'mailersend.com' ||
      hostname === 'api.mailersend.com' ||
      ATTACHMENT_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    if (!allowed) {
      throw new Error(`refusing to download attachment from host: ${hostname}`);
    }
    const response = await this.fetchFn(downloadUrl, {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`attachment download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listSentEmails(opts: { domain?: string; limit?: number }): Promise<SentEmail[]> {
    // The /v1/emails endpoint requires a domain_id (the hashed domain id,
    // not the domain name) plus a bounded date window; without a domain
    // there is no query to run, so that is a loud error, not an empty list.
    if (!opts.domain) {
      throw new Error(
        'mailersend listSentEmails is not supported without a domain: the emails endpoint requires a domain id',
      );
    }
    const domainId = await this.resolveDomainId(opts.domain);
    const nowS = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      domain_id: domainId,
      // Data retention is 1-30 days depending on plan; a 7-day window
      // stays inside every plan's retention.
      date_from: String(nowS - 7 * 24 * 3600),
      date_to: String(nowS),
      limit: String(Math.min(Math.max(opts.limit ?? 25, 10), 1000)),
    });
    const payload = await this.request<{ data?: unknown }>('GET', '/emails', `?${params}`);
    const rows = Array.isArray(asRecord(payload).data) ? (asRecord(payload).data as unknown[]) : [];
    return rows.map((row) => {
      const rec = asRecord(row);
      return {
        id: asString(rec['id']),
        from: asString(rec['from']),
        to: [asString(rec['to'])].filter((t) => t.length > 0),
        subject: asString(rec['subject']),
        dateMs: Date.parse(asString(rec['created_at'], '')) || 0,
        status: asString(rec['status'], 'unknown'),
      };
    });
  }

  // The emails endpoint wants the hashed domain id from the domains list,
  // not the domain name the operator configures.
  private async resolveDomainId(domain: string): Promise<string> {
    const payload = await this.request<{ data?: unknown }>('GET', '/domains');
    const rows = Array.isArray(asRecord(payload).data) ? (asRecord(payload).data as unknown[]) : [];
    for (const row of rows) {
      const rec = asRecord(row);
      if (asString(rec['name']).toLowerCase() === domain.toLowerCase()) {
        const id = asString(rec['id']);
        if (id) return id;
      }
    }
    throw new Error(`mailersend: domain not found in account: ${domain}`);
  }

  // MailerSend signs with `Signature` = lowercase hex HMAC-SHA256 of the
  // RAW request body, keyed with the per-webhook signing secret. The same
  // scheme signs inbound-route forwards (keyed with the route's secret).
  // The fixed public test secret authorizes the "webhook.test" ping only:
  // a real event carrying a test-secret signature is rejected.
  //
  // ACCEPTED RESIDUAL RISK (replay): MailerSend's Signature scheme carries
  // no timestamp, so unlike the Svix and Mailgun schemes there is nothing
  // to bound a replay window with. Replay protection is the webhook dedupe
  // store only: a captured payload replayed after its dedupe entry expires
  // verifies as genuine and is processed again. The scheme cannot provide
  // timestamps, so this is documented rather than fixed; also noted in
  // SECURITY.md under "What is NOT protected".
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): { ok: true } | { ok: false; reason: string } {
    const signature = firstHeader(headers['signature']);
    if (!signature) {
      return { ok: false, reason: 'missing signature' };
    }
    let type: unknown;
    try {
      type = asRecord(JSON.parse(rawBody.toString('utf8')))['type'];
    } catch {
      return { ok: false, reason: 'invalid payload' };
    }
    const isTestPing = type === 'webhook.test';
    const candidate = signature.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(candidate)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    // The test secret is accepted only for the ping payload itself; it is
    // never tried for real events, so it cannot authorize them.
    const keys = isTestPing ? [secret, WEBHOOK_TEST_SECRET] : [secret];
    const actual = Buffer.from(candidate, 'hex');
    for (const key of keys) {
      const expected = createHmac('sha256', key).update(rawBody).digest();
      if (timingSafeEqual(actual, expected)) {
        return { ok: true };
      }
    }
    return { ok: false, reason: 'signature mismatch' };
  }
}

export interface ParsedMailerSendInbound {
  event: EmailEvent;
  // Attachment bytes that rode along inline (the route's include-attachments
  // toggle controls this); the route stashes them in kv for the download seam.
  rawAttachments: Array<{ id: string; filename: string; content: Buffer }>;
}

// The inbound route posts the parsed email to the forward URL. MailerSend
// publishes no JSON schema for this payload, so every accessor defends
// itself and both envelope shapes ({...fields} and {type, data: {...}})
// are accepted.
export function parseMailerSendInbound(payload: unknown): ParsedMailerSendInbound {
  const root = asRecord(payload);
  const data = asRecord(root['data']);
  // Prefer the data envelope when it carries the message fields.
  const rec = data['from'] !== undefined || data['message_id'] !== undefined ? data : root;

  const id = asString(rec['message_id'], asString(rec['id']));
  const from = parseMailbox(rec['from']);
  const toRaw = rec['to'];
  const to = (Array.isArray(toRaw) ? toRaw : [toRaw])
    .map((t) => parseMailbox(t).address)
    .filter((a) => a.length > 0);
  const bodyText = typeof rec['text'] === 'string' ? rec['text'] : null;
  const bodyHtml = typeof rec['html'] === 'string' ? rec['html'] : null;
  const headers = flattenHeaders(rec['headers']);
  const createdAt = Date.parse(asString(rec['date'], asString(rec['created_at'], '')));
  const headerDate = Date.parse(headers['date'] ?? '');

  const attachments: EmailEvent['attachments'] = [];
  const rawAttachments: ParsedMailerSendInbound['rawAttachments'] = [];
  const rawList = rec['attachments'];
  let index = 0;
  if (Array.isArray(rawList)) {
    for (const entry of rawList) {
      const a = asRecord(entry);
      // The payload carries either inline base64 content (when the route
      // includes attachments) or a fetchable URL; both are normalized.
      const contentB64 = asString(a['content']);
      const url = asString(a['url'], asString(a['download_url']));
      const attId = asString(a['id'], `msatt-${index}`);
      index++;
      const filename = asString(a['filename'], asString(a['name'], 'attachment'));
      const mime = asString(a['content_type'], asString(a['mime'], 'application/octet-stream'));
      let size = typeof a['size'] === 'number' ? a['size'] : 0;
      let content: Buffer | null = null;
      if (contentB64.length > 0) {
        try {
          content = Buffer.from(contentB64, 'base64');
          size = content.length;
        } catch {
          content = null;
        }
      }
      attachments.push({ id: attId, filename, size, mime });
      if (content) {
        rawAttachments.push({ id: attId, filename, content });
      } else if (url.length > 0) {
        // A URL-carried attachment has no inline bytes; the downloadUrl on
        // the InboundEmail shape is for fetch-by-id flows which MailerSend
        // does not offer, so it stays a metadata entry here.
      }
    }
  }

  const inReplyTo = headers['in-reply-to'];
  const firstReference = headers['references']?.split(/\s+/)[0];
  return {
    event: {
      id,
      provider: 'mailersend',
      domain: domainOf(to[0] ?? ''),
      from,
      to,
      subject: asString(rec['subject']),
      dateMs: createdAt || headerDate || Date.now(),
      snippet: snippetOf(bodyText ?? ''),
      bodyText,
      bodyHtml,
      attachments,
      threadId: inReplyTo ?? firstReference ?? null,
      headers,
    },
    rawAttachments,
  };
}

// True when the verified payload looks like an inbound-route forward rather
// than an activity webhook: the forward carries the message fields, while
// activity events carry a type like "activity.delivered".
export function isMailerSendInboundPayload(payload: unknown): boolean {
  const root = asRecord(payload);
  const data = asRecord(root['data']);
  const rec = data['from'] !== undefined || data['message_id'] !== undefined ? data : root;
  return (
    rec['from'] !== undefined ||
    rec['message_id'] !== undefined ||
    rec['subject'] !== undefined
  );
}

// Maps MailerSend activity events to the shared DeliveryEvent shape.
// Returns undefined for event types with no delivery equivalent (opens,
// clicks, deferrals); the route ignores those. The message id is at
// data.email.message.id per the webhooks docs.
export function parseMailerSendDeliveryEvent(envelope: unknown): DeliveryEvent | undefined {
  const rec = asRecord(envelope);
  const type = asString(rec['type']);
  let mapped: DeliveryEvent['type'] | undefined;
  switch (type) {
    case 'activity.delivered':
      mapped = 'delivered';
      break;
    case 'activity.hard_bounced':
    case 'activity.soft_bounced':
      mapped = 'bounced';
      break;
    case 'activity.spam_complaint':
      mapped = 'complained';
      break;
    // Suppressed: the send never left MailerSend, so it failed.
    case 'activity.suppressed':
      mapped = 'failed';
      break;
    default:
      return undefined;
  }
  const data = asRecord(rec['data']);
  const email = asRecord(data['email']);
  const message = asRecord(email['message']);
  const emailId = asString(message['id'], asString(data['message_id']));
  return { type: mapped, emailId };
}
