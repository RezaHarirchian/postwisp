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
import { parseMime } from './mime.js';
import { fetchWithRateRetry, rateLimitedFetch, RateLimiter } from './http.js';
import { VERSION } from '../core/version.js';

// Wire facts below are per Mailgun's official docs (messages API, routes,
// securing webhooks, stored messages). Anything the docs do not publish
// is read defensively and marked as an assumption in the comments.

const API_BASE = 'https://api.mailgun.net/v3';
const USER_AGENT = `postwisp/${VERSION}`;
// A captured webhook must not be replayable after this window.
const TIMESTAMP_TOLERANCE_SEC = 300;

// Attachment bytes come from Mailgun-signed storage hosts only. Anything
// else is a potential exfil target, not an attachment.
const ATTACHMENT_HOST = 'mailgun.net';

export interface MailgunProviderOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  // Test seam: a RateLimiter with a fake clock/wait keeps tests fast.
  limiter?: RateLimiter;
}

// Unknown JSON from Mailgun: every accessor defends itself so one
// unexpected field shape never crashes the webhook path.
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).toLowerCase() : '';
}

// "Name <addr>" or bare addresses out of a comma-joined To/Cc list.
function parseAddressList(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => parseAddress(part.trim()).address)
    .filter((a) => a.length > 0);
}

function mailgunHostOk(hostname: string): boolean {
  return hostname === ATTACHMENT_HOST || hostname.endsWith(`.${ATTACHMENT_HOST}`);
}

export class MailgunProvider implements EmailProvider {
  readonly name = 'mailgun';
  // Mailgun supports deferred delivery (o:deliverytime) but the send API
  // is one message per call, so batch stays false.
  readonly capabilities = { scheduling: true, batch: false };

  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  // Rate-limited fetch for provider API calls. Signed-URL attachment
  // downloads are not API calls and go through the raw fetchFn.
  private readonly apiFetch: typeof fetch;

  constructor(options: MailgunProviderOptions) {
    if (!options.apiKey) {
      throw new Error('mailgun provider requires an api key');
    }
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiFetch = rateLimitedFetch(this.fetchFn, options.limiter ?? new RateLimiter());
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`api:${this.apiKey}`, 'utf8').toString('base64')}`;
  }

  private async request<T>(method: string, url: string): Promise<T> {
    const response = await this.apiFetch(url, {
      method,
      headers: { Authorization: this.authHeader(), 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`mailgun ${method} ${url} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.to.length === 0) {
      throw new Error('send requires at least one recipient');
    }
    // Mailgun sends from a domain, not an account: the sending domain is
    // the from address's domain.
    const domain = domainOf(parseAddress(input.from).address);
    if (!domain) {
      throw new Error('mailgun send requires a from address with a domain');
    }
    let body: URLSearchParams | FormData;
    let contentType: string | undefined;
    if (input.attachments && input.attachments.length > 0) {
      // Attachments need multipart; Mailgun takes repeated `attachment`
      // fields, one per file.
      const form = new FormData();
      for (const a of input.attachments) {
        const bytes = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content, 'base64');
        form.append('attachment', new Blob([bytes], { type: a.mime ?? 'application/octet-stream' }), a.filename);
      }
      body = form;
    } else {
      body = new URLSearchParams();
      contentType = 'application/x-www-form-urlencoded';
    }
    body.set('from', input.from);
    body.set('to', input.to.join(','));
    if (input.cc) body.set('cc', input.cc.join(','));
    if (input.bcc) body.set('bcc', input.bcc.join(','));
    body.set('subject', input.subject);
    if (input.text !== undefined) body.set('text', input.text);
    if (input.html !== undefined) body.set('html', input.html);
    if (input.replyTo) body.set('h:Reply-To', input.replyTo);
    // Mailgun takes custom headers as h: fields. Only the unsubscribe
    // headers are forwarded: anything else the caller set is the provider
    // layer's business, not this adapter's.
    if (input.headers) {
      for (const [key, value] of Object.entries(input.headers)) {
        const lower = key.toLowerCase();
        if (lower === 'list-unsubscribe' || lower === 'list-unsubscribe-post') {
          body.set(`h:${key}`, value);
        }
      }
    }
    // o:deliverytime accepts seconds since the epoch per the docs.
    if (input.scheduledAt !== undefined) {
      const deliveryTime = Math.floor(Date.parse(input.scheduledAt) / 1000);
      if (!Number.isFinite(deliveryTime)) {
        throw new Error('scheduledAt is not a valid date');
      }
      body.set('o:deliverytime', String(deliveryTime));
    }
    // o:testmode is documented but SendInput carries no test-mode signal,
    // so it is never set: a silent test flag would lose mail.
    // A 429 is retried once after the provider's Retry-After; see http.ts.
    const response = await fetchWithRateRetry(this.apiFetch, `${API_BASE}/${domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'User-Agent': USER_AGENT,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = '';
      try {
        message = asString(asRecord(JSON.parse(detail))['message']);
      } catch {
        // Not JSON: fall back to the raw text below.
      }
      const summary = (message || detail.trim()).slice(0, 300);
      throw new Error(`mailgun send failed: ${response.status}${summary ? ` ${summary}` : ''}`);
    }
    const payload = asRecord(await response.json());
    // The response id is the Message-ID; delivery webhooks report the same
    // value at event-data.message.headers.message-id.
    const id = asString(payload['id']);
    if (!id) {
      throw new Error('mailgun send returned no id');
    }
    return { id };
  }

  // store() keeps the message retrievable for 3 days. The id accepted here
  // is Mailgun's full storage URL (the message-url field Routes forward()
  // posts): it already carries the region host and the domain, so this
  // works for US and EU accounts alike. A bare storage key cannot be
  // resolved without a domain, so it is a loud error, not a guess.
  async getInboundEmail(id: string): Promise<InboundEmail> {
    let url: URL;
    try {
      url = new URL(id);
    } catch {
      throw new Error(
        'mailgun getInboundEmail needs the full storage URL (the message-url field from the route forward); a bare id cannot be resolved without a domain',
      );
    }
    if (!mailgunHostOk(url.hostname.toLowerCase())) {
      throw new Error(`refusing to fetch stored message from host: ${url.hostname}`);
    }
    const payload = await this.request<Record<string, unknown>>('GET', url.toString());
    const bodyMime = asString(payload['body-mime']);
    if (!bodyMime) {
      throw new Error('mailgun stored message is missing body-mime');
    }
    const mime = parseMime(bodyMime);
    const attachments = Array.isArray(payload['attachments'])
      ? (payload['attachments'] as unknown[])
      : [];
    let attIndex = 0;
    const normalized = attachments.map((entry) => {
      const a = asRecord(entry);
      const downloadUrl = asString(a['url']);
      const attId = downloadUrl || `mgatt-${attIndex}`;
      attIndex++;
      return {
        id: attId,
        filename: asString(a['name'], 'attachment'),
        size: typeof a['size'] === 'number' ? a['size'] : 0,
        mime: asString(a['content-type'], 'application/octet-stream'),
        downloadUrl,
      };
    });
    return {
      id: mime.headers['message-id'] || id,
      from: parseAddress(mime.headers['from'] ?? ''),
      to: parseAddressList(mime.headers['to'] ?? ''),
      subject: mime.headers['subject'] ?? '',
      dateMs: Date.parse(mime.headers['date'] ?? '') || Date.now(),
      bodyText: mime.text,
      bodyHtml: mime.html,
      attachments: normalized,
      threadId: mime.headers['in-reply-to'] ?? mime.headers['references']?.split(/\s+/)[0] ?? null,
      headers: mime.headers,
    };
  }

  // Only Mailgun storage hosts: never fetch an attacker-supplied URL, and
  // never hand the URL itself to the bot UI.
  async downloadAttachment(downloadUrl: string): Promise<Buffer> {
    let hostname: string;
    try {
      hostname = new URL(downloadUrl).hostname.toLowerCase();
    } catch {
      throw new Error('refusing to download attachment: not a valid URL');
    }
    if (!mailgunHostOk(hostname)) {
      throw new Error(`refusing to download attachment from host: ${hostname}`);
    }
    const response = await this.fetchFn(downloadUrl, {
      headers: { Authorization: this.authHeader(), 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`attachment download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  // The events API is the documented equivalent of a sent-mail list:
  // accepted events are messages Mailgun took for delivery. Without a
  // domain there is no query to run, so that is a loud error.
  async listSentEmails(opts: { domain?: string; limit?: number }): Promise<SentEmail[]> {
    if (!opts.domain) {
      throw new Error(
        'mailgun listSentEmails is not supported without a domain: the events API is per-domain',
      );
    }
    const params = new URLSearchParams({
      event: 'accepted',
      limit: String(Math.min(Math.max(opts.limit ?? 25, 1), 300)),
    });
    const payload = await this.request<{ items?: unknown }>(
      'GET',
      `${API_BASE}/${opts.domain}/events?${params}`,
    );
    const items = Array.isArray(payload.items) ? payload.items : [];
    const emails: SentEmail[] = [];
    for (const item of items) {
      const ed = asRecord(item);
      const headers = asRecord(asRecord(ed['message'])['headers']);
      const to = parseAddressList(asString(headers['to']));
      const ts = ed['timestamp'];
      emails.push({
        id: asString(headers['message-id']),
        from: parseAddress(asString(headers['from'])).address,
        to,
        subject: asString(headers['subject']),
        dateMs: typeof ts === 'number' ? Math.floor(ts * 1000) : 0,
        status: 'sent',
      });
    }
    return emails;
  }

  // Mailgun does NOT sign the raw body. Per the securing-webhooks docs the
  // signature is hex HMAC-SHA256(signingKey, timestamp + token). Event
  // webhooks carry timestamp/token/signature under payload.signature (also
  // accepted under payload.event-data.signature); Routes forward()/store()
  // posts carry them as top-level form fields. A ±5-minute timestamp window
  // blocks replays.
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): { ok: true } | { ok: false; reason: string } {
    let timestamp: string | undefined;
    let token: string | undefined;
    let signature: string | undefined;
    const text = rawBody.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const rec = asRecord(parsed);
      const sigBlock =
        asRecord(rec['signature'])['timestamp'] !== undefined
          ? asRecord(rec['signature'])
          : asRecord(asRecord(rec['event-data'])['signature']);
      timestamp = asString(sigBlock['timestamp']) || undefined;
      token = asString(sigBlock['token']) || undefined;
      signature = asString(sigBlock['signature']) || undefined;
    }
    if (timestamp === undefined || token === undefined || signature === undefined) {
      const form = new URLSearchParams(text);
      timestamp = form.get('timestamp') ?? undefined;
      token = form.get('token') ?? undefined;
      signature = form.get('signature') ?? undefined;
    }
    if (!timestamp || !token || !signature) {
      return { ok: false, reason: 'missing signature fields' };
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_SEC) {
      return { ok: false, reason: 'timestamp outside tolerance' };
    }
    const candidate = signature.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(candidate)) {
      return { ok: false, reason: 'signature mismatch' };
    }
    const expected = createHmac('sha256', secret).update(`${timestamp}${token}`).digest();
    const actual = Buffer.from(candidate, 'hex');
    if (timingSafeEqual(actual, expected)) {
      return { ok: true };
    }
    return { ok: false, reason: 'signature mismatch' };
  }
}

export interface ParsedMailgunInbound {
  event: EmailEvent;
  // Attachment bytes parsed out of body-mime; the route stashes them in kv
  // for the bot's download seam.
  rawAttachments: Array<{ id: string; filename: string; content: Buffer }>;
}

// Normalizes a Routes forward() POST. The forward posts form-encoded fields
// including body-mime (the full raw message); From/To/Subject/timestamp/
// token/signature ride along as top-level fields. Signature verification
// happens in verifyWebhook before this runs, so this function is pure
// parsing. Throws on a missing body-mime: that is a Mailgun-side or
// forgery problem, never a partial email.
export function parseMailgunInbound(fields: Record<string, string>): ParsedMailgunInbound {
  const bodyMime = fields['body-mime'];
  if (!bodyMime) {
    throw new Error('mailgun inbound is missing body-mime');
  }
  const mime = parseMime(bodyMime);
  const id = mime.headers['message-id'] || fields['message-url'] || '';
  const from = parseAddress(fields['From'] ?? mime.headers['from'] ?? '');
  const to = parseAddressList(fields['To'] ?? fields['recipients'] ?? mime.headers['to'] ?? '');
  const headers = mime.headers;
  const inReplyTo = headers['in-reply-to'];
  const firstReference = headers['references']?.split(/\s+/)[0];

  const attachments: EmailEvent['attachments'] = [];
  const rawAttachments: ParsedMailgunInbound['rawAttachments'] = [];
  mime.attachments.forEach((a, index) => {
    const attId = `mgatt-${index}`;
    attachments.push({ id: attId, filename: a.filename, size: a.content.length, mime: a.mime });
    rawAttachments.push({ id: attId, filename: a.filename, content: a.content });
  });

  return {
    event: {
      id,
      provider: 'mailgun',
      domain: domainOf(to[0] ?? ''),
      from,
      to,
      subject: fields['Subject'] ?? headers['subject'] ?? '',
      dateMs: Date.parse(headers['date'] ?? '') || Date.now(),
      snippet: snippetOf(mime.text ?? ''),
      bodyText: mime.text,
      bodyHtml: mime.html,
      attachments,
      threadId: inReplyTo ?? firstReference ?? null,
      headers,
    },
    rawAttachments,
  };
}

// Maps Mailgun message events to the shared DeliveryEvent shape. Returns
// undefined for event types with no delivery equivalent (opens, clicks,
// unsubscribes, stored); the route ignores those. The message id is at
// event-data.message.headers.message-id, matching the id send() returned.
export function parseMailgunDeliveryEvent(envelope: unknown): DeliveryEvent | undefined {
  const eventData = asRecord(asRecord(envelope)['event-data']);
  const eventName = asString(eventData['event']);
  let mapped: DeliveryEvent['type'] | undefined;
  switch (eventName) {
    case 'delivered':
      mapped = 'delivered';
      break;
    case 'failed': {
      // NOTE (accepted mapping): a 'temporary' severity means Mailgun will
      // retry the delivery, but the shared DeliveryEvent contract has no
      // non-terminal state (only delivered/bounced/complained/failed), so
      // it is reported as 'failed' here. Downstream treats 'failed' as
      // permanent: a message Mailgun later delivers on retry keeps its
      // failed status in the sent log. This coarse mapping is deliberate —
      // widening the contract would be a breaking change (see the
      // stability notice in providers/interface.ts).
      const severity = asString(eventData['severity']);
      mapped = severity === 'temporary' ? 'failed' : 'bounced';
      break;
    }
    case 'complained':
      mapped = 'complained';
      break;
    // rejected: Mailgun refused the message; dropped: Mailgun stopped it
    // (e.g. suppression list). Either way it never delivered.
    case 'rejected':
    case 'dropped':
      mapped = 'failed';
      break;
    default:
      return undefined;
  }
  const headers = asRecord(asRecord(eventData['message'])['headers']);
  const emailId = asString(headers['message-id']);
  return { type: mapped, emailId };
}
