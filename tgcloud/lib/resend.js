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

// Outbound sending for the serverless build, via Resend's HTTPS API.
// The tgcloud runtime offers outbound `fetch` from 'sdk' (30 MB response
// cap); there is no SMTP here and no Resend SDK. The input shape mirrors
// the self-hosted provider contract's SendInput (src/providers/interface.ts)
// so the two builds speak the same language.

import { fetch } from 'sdk';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Sends one email through Resend. Returns the Resend message id.
// The apiKey comes from the caller (kv key 'resend_api_key'); never
// hardcode it or log it. idempotencyKey maps to Resend's
// Idempotency-Key header: reuse it when retrying the same send and
// Resend will return the original result instead of sending twice.
// Throws Error on any failure; the caller (the handler) logs it and
// reports failure to the owner.
export async function sendViaResend({ apiKey, from, to, subject, text, idempotencyKey }) {
  if (!apiKey) throw new Error('Resend API key is not set (kv: resend_api_key)');
  const recipients = Array.isArray(to) ? to : [to];
  if (recipients.length === 0) throw new Error('No recipients');

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  // Only send the header when a key exists: an empty Idempotency-Key is
  // worse than none because two empty keys would collide.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ from, to: recipients, subject, text }),
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (response.status === 429) {
    // Rate limited. The handler cannot wait here (serverless functions
    // are short-lived), so fail loudly with the retry hint intact.
    const retryAfter = body && typeof body.retry_after === 'number' ? body.retry_after : null;
    throw new Error(
      `Resend rate limit (HTTP 429)${retryAfter !== null ? `; retry after ${retryAfter}s` : ''}. ` +
      'The message stays in the outbox as failed; send it again later.',
    );
  }

  if (!response.ok) {
    const message = (body && (body.message || body.error)) || `HTTP ${response.status}`;
    throw new Error(`Resend send failed: ${message}`);
  }

  const id = body && typeof body.id === 'string' ? body.id : null;
  if (!id) throw new Error('Resend accepted the send but returned no message id');
  return { id };
}
