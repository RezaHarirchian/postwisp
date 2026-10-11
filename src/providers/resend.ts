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
  EmailProvider,
  InboundEmail,
  SendInput,
  SendResult,
  SentEmail,
} from './interface.js';
import { normalizeResendInbound } from './normalize.js';
import { fetchWithRateRetry, rateLimitedFetch, RateLimiter } from './http.js';
import { VERSION } from '../core/version.js';

export { parseAddress } from './normalize.js';

const API_BASE = 'https://api.resend.com';
// Docs warn raw HTTP calls 403 without a User-Agent (error code 1010).
const USER_AGENT = `postwisp/${VERSION}`;
// Svix rejects anything older so a captured payload can't be replayed forever.
const TIMESTAMP_TOLERANCE_SEC = 300;

// Attachment bytes come from Resend-signed S3/CloudFront links only.
// Anything else is a potential exfil target, not an attachment.
const ATTACHMENT_HOST_SUFFIXES = ['.resend.com', '.amazonaws.com'];

export interface ResendProviderOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  // Test seam: a RateLimiter with a fake clock/wait keeps tests fast.
  // Defaults to the shared pacing for the Resend API (10 rps).
  limiter?: RateLimiter;
}

// Unknown JSON from Resend: every accessor defends itself so one
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

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  readonly capabilities = { scheduling: true, batch: true };

  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  // Rate-limited fetch for provider API calls. Signed-URL attachment
  // downloads are not API calls and go through the raw fetchFn.
  private readonly apiFetch: typeof fetch;

  constructor(options: ResendProviderOptions) {
    if (!options.apiKey) {
      throw new Error('resend provider requires an api key');
    }
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.apiFetch = rateLimitedFetch(this.fetchFn, options.limiter ?? new RateLimiter());
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.apiFetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': USER_AGENT,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      // Keep the message short; the caller decides what is safe to log.
      const detail = await response.text().catch(() => '');
      throw new Error(`resend ${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }

  async send(input: SendInput): Promise<SendResult> {
    if (input.to.length === 0) {
      throw new Error('send requires at least one recipient');
    }
    // The key is per-request so a retried send never becomes two emails.
    const headers: Record<string, string> = {};
    if (input.idempotencyKey) {
      headers['Idempotency-Key'] = input.idempotencyKey;
    }
    // A 429 is retried once after the provider's Retry-After; see http.ts.
    const response = await fetchWithRateRetry(this.apiFetch, `${API_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.html !== undefined ? { html: input.html } : {}),
        ...(input.cc ? { cc: input.cc } : {}),
        ...(input.bcc ? { bcc: input.bcc } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.attachments
          ? {
              attachments: input.attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
                ...(a.mime ? { content_type: a.mime } : {}),
              })),
            }
          : {}),
        ...(input.scheduledAt ? { scheduled_at: input.scheduledAt } : {}),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`resend send failed: ${response.status}${detail ? ` ${detail}` : ''}`);
    }
    const payload = asRecord(await response.json());
    const id = asString(payload['id']);
    if (!id) {
      throw new Error('resend send returned no id');
    }
    return { id };
  }

  async getInboundEmail(id: string): Promise<InboundEmail> {
    if (!id) {
      throw new Error('getInboundEmail requires an id');
    }
    const full = await this.request<Record<string, unknown>>(
      'GET',
      `/emails/receiving/${encodeURIComponent(id)}`,
    );
    // Signed download URLs live behind the attachments endpoint, not the
    // main retrieval one; join them by attachment id.
    const listed = await this.request<{ data?: unknown }>(
      'GET',
      `/emails/receiving/${encodeURIComponent(id)}/attachments`,
    );
    const downloads = new Map<string, string>();
    const list = asRecord(listed).data ?? (Array.isArray(listed) ? listed : []);
    for (const entry of Array.isArray(list) ? list : []) {
      const rec = asRecord(entry);
      const aid = asString(rec['id']);
      const url = asString(rec['download_url']);
      if (aid && url) {
        downloads.set(aid, url);
      }
    }
    // One canonical field mapping; the signed URLs are joined by id and
    // never leak into the normalized event (see normalize.ts).
    const event = normalizeResendInbound(full);
    return {
      id: event.id || id,
      from: event.from,
      to: event.to,
      subject: event.subject,
      dateMs: event.dateMs,
      bodyText: event.bodyText,
      bodyHtml: event.bodyHtml,
      attachments: event.attachments.map((a) => ({
        ...a,
        downloadUrl: downloads.get(a.id) ?? '',
      })),
      threadId: event.threadId,
      headers: event.headers,
    };
  }

  // Only Resend-signed hosts: never fetch an attacker-supplied URL, and
  // never hand the signed URL itself to the bot UI.
  async downloadAttachment(downloadUrl: string): Promise<Buffer> {
    let hostname: string;
    try {
      hostname = new URL(downloadUrl).hostname.toLowerCase();
    } catch {
      throw new Error('refusing to download attachment: not a valid URL');
    }
    const allowed =
      hostname === 'resend.com' ||
      hostname === 'amazonaws.com' ||
      ATTACHMENT_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    if (!allowed) {
      throw new Error(`refusing to download attachment from host: ${hostname}`);
    }
    const response = await this.fetchFn(downloadUrl, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`attachment download failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async listSentEmails(opts: { domain?: string; limit?: number }): Promise<SentEmail[]> {
    const params = new URLSearchParams();
    // Resend's list endpoint documents no domain filter; narrow locally.
    if (opts.limit !== undefined) {
      params.set('limit', String(opts.limit));
    }
    const query = params.size > 0 ? `?${params}` : '';
    const payload = await this.request<{ data?: unknown }>('GET', `/emails${query}`);
    const rows = Array.isArray(asRecord(payload).data) ? (asRecord(payload).data as unknown[]) : [];
    const emails: SentEmail[] = [];
    for (const row of rows) {
      const rec = asRecord(row);
      const from = asString(rec['from']);
      if (opts.domain && !from.toLowerCase().endsWith(`@${opts.domain.toLowerCase()}`)) {
        continue;
      }
      emails.push({
        id: asString(rec['id']),
        from,
        to: asStringArray(rec['to']),
        subject: asString(rec['subject']),
        dateMs: Date.parse(asString(rec['created_at'], '')) || 0,
        status: asString(rec['status'], 'unknown'),
      });
    }
    return emails;
  }

  // Resend issues webhook secrets as `whsec_<base64>`; standard Svix
  // verification base64-decodes the part after the prefix to get the HMAC
  // key. A secret without the prefix is used as-is (tests, non-Svix setups).
  private webhookKey(secret: string): Buffer {
    if (secret.startsWith('whsec_')) {
      return Buffer.from(secret.slice('whsec_'.length), 'base64');
    }
    return Buffer.from(secret, 'utf8');
  }

  // Svix scheme: sign `${id}.${timestamp}.${rawBody}` with HMAC-SHA256 and
  // compare against every v1 signature the header carries. Raw body, never
  // re-serialized JSON, or the digest won't match.
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): { ok: true } | { ok: false; reason: string } {
    const first = (v: string | string[] | undefined): string | undefined =>
      Array.isArray(v) ? v[0] : v;
    const id = first(headers['svix-id']);
    const timestamp = first(headers['svix-timestamp']);
    const signatureHeader = first(headers['svix-signature']);
    if (!id || !timestamp || !signatureHeader) {
      return { ok: false, reason: 'missing svix headers' };
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_SEC) {
      return { ok: false, reason: 'timestamp outside tolerance' };
    }
    const expected = createHmac('sha256', this.webhookKey(secret))
      .update(`${id}.${timestamp}.`)
      .update(rawBody)
      .digest();
    const candidates = signatureHeader
      .split(' ')
      .map((part) => part.trim())
      .filter((part) => part.startsWith('v1,'))
      .map((part) => part.slice(3));
    for (const candidate of candidates) {
      let actual: Buffer;
      try {
        actual = Buffer.from(candidate, 'base64');
      } catch {
        continue;
      }
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        return { ok: true };
      }
    }
    return { ok: false, reason: 'signature mismatch' };
  }
}

