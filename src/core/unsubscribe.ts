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
import type { SendInput } from '../providers/interface.js';

// Everything the footer and the one-click endpoint need. The HMAC secret is
// the provider webhook signing secret: high-entropy, server-side, and never
// exposed to recipients (only the derived token leaves the machine).
export interface UnsubscribeConfig {
  publicUrl: string | null;
  secret: string | null;
  physicalAddress: string | null;
}

function b64urlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

// Unsubscribe links expire: a leaked link must not stay valid forever.
// The token carries its issue time; links older than a year are rejected.
// Old two-part tokens (no timestamp) are treated as expired.
const UNSUBSCRIBE_TOKEN_MAX_AGE_MS = 365 * 86400_000;
// Tolerate a little clock skew between minter and verifier.
const UNSUBSCRIBE_TOKEN_SKEW_MS = 5 * 60_000;

// The token binds the address to this server: b64url(email).b64url(issuedAt).b64url(HMAC).
// A recipient can only ever unsubscribe themselves.
export function unsubscribeToken(email: string, secret: string, issuedAtMs: number = Date.now()): string {
  const normalized = email.trim().toLowerCase();
  const mac = createHmac('sha256', secret).update(`${normalized}${issuedAtMs}`).digest();
  return `${b64urlEncode(normalized)}.${b64urlEncode(String(issuedAtMs))}.${b64urlEncode(mac)}`;
}

// Returns the address the token was minted for, or null when the token is
// malformed, forged, or expired.
export function verifyUnsubscribeToken(token: string, secret: string, nowMs: number = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [emailB64, tsB64, macB64] = parts as [string, string, string];
  let email: string;
  let issuedAtMs: number;
  try {
    email = Buffer.from(emailB64, 'base64url').toString('utf8');
    issuedAtMs = Number(Buffer.from(tsB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || !normalized.includes('@')) return null;
  if (!Number.isFinite(issuedAtMs)) return null;
  if (issuedAtMs > nowMs + UNSUBSCRIBE_TOKEN_SKEW_MS) return null;
  if (nowMs - issuedAtMs > UNSUBSCRIBE_TOKEN_MAX_AGE_MS) return null;
  const expected = createHmac('sha256', secret).update(`${normalized}${issuedAtMs}`).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(macB64, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return normalized;
}

// The absolute one-click URL for one recipient, or null when the server
// cannot mint links (no public URL or no signing secret configured).
export function unsubscribeUrl(email: string, cfg: UnsubscribeConfig): string | null {
  if (!cfg.publicUrl || !cfg.secret) return null;
  return `${cfg.publicUrl}/unsub/${unsubscribeToken(email, cfg.secret)}`;
}

// A threaded reply is a 1:1 conversation, not bulk mail: no footer there.
// Everything else the owner sends gets one.
function isPersonalReply(input: SendInput): boolean {
  const headers = input.headers ?? {};
  return Object.keys(headers).some((k) => k.toLowerCase() === 'in-reply-to');
}

// The footer every non-personal send carries. With a single recipient the
// footer holds their personal one-click link; with several, one message
// cannot carry per-recipient headers, so recipients unsubscribe by replying
// STOP (handled on the inbound side).
export function buildUnsubscribeFooter(
  input: { from: string; to: string[] },
  cfg: UnsubscribeConfig,
): string {
  const lines = ['---', `You received this email from ${input.from}.`];
  if (input.to.length === 1 && input.to[0]) {
    const url = unsubscribeUrl(input.to[0], cfg);
    if (url) lines.push(`Unsubscribe: ${url}`);
    else lines.push('To unsubscribe, reply to this email with the word STOP.');
  } else {
    lines.push('To unsubscribe, reply to this email with the word STOP.');
  }
  if (cfg.physicalAddress) lines.push(cfg.physicalAddress);
  return lines.join('\n');
}

// Attaches the footer and the RFC 8058 one-click headers to a non-personal
// send. Personal (1:1 reply) input is returned untouched. The footer goes
// into both text and HTML bodies: an HTML-only email must still show a
// visible unsubscribe link.
export function withUnsubscribe(input: SendInput, cfg: UnsubscribeConfig): SendInput {
  if (isPersonalReply(input)) return input;
  const footer = buildUnsubscribeFooter(input, cfg);
  const body = input.text === undefined ? footer : `${input.text}\n\n${footer}`;
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  // One-click headers only make sense per recipient; with several
  // recipients the STOP-reply footer above is the unsubscribe path.
  if (input.to.length === 1 && input.to[0]) {
    const url = unsubscribeUrl(input.to[0], cfg);
    if (url) {
      headers['List-Unsubscribe'] = `<${url}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }
  }
  const htmlBody =
    input.html === undefined
      ? undefined
      : `${input.html}<br><br><p>${escapeHtmlLines(footer)}</p>`;
  return {
    ...input,
    text: body,
    ...(htmlBody === undefined ? {} : { html: htmlBody }),
    headers,
  };
}

// Minimal HTML escaping for the footer inside an HTML body. The footer is
// operator- and recipient-derived text, never markup.
function escapeHtmlLines(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split('\n')
    .join('<br>');
}

// An inbound message whose whole body is "stop" is an unsubscribe request,
// not mail to read.
export function isStopReply(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().toLowerCase() === 'stop';
}
