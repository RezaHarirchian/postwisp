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

// postwisp Cloudflare Email Worker (inbound only).
//
// Deploy this on your own Cloudflare account alongside an Email Routing
// catch-all rule. It parses each incoming message with postal-mime and
// forwards the parsed email to your postwisp server's /ingest/cloudflare
// endpoint, signed with a shared-secret HMAC so postwisp knows the POST
// really came from your worker.
//
// Two modes, picked by which env vars are set (they are mutually
// exclusive — set one pair or the other, never both):
//
//   INGEST MODE (default): POSTWISP_SECRET + POSTWISP_INGEST_URL.
//     Forwards the parsed email to a self-hosted postwisp server.
//
//   DIRECT_BOT_API MODE: TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID.
//     No postwisp server needed. The worker sends the email straight to
//     the owner's Telegram chat via the Bot API, formatted in the wire
//     format the tgcloud companion understands (see
//     tgcloud/lib/pure.js formatInboundMessage — the format below MUST
//     stay in sync with it), with inline buttons: Save to inbox, View
//     code, Reply. Pair this with the tgcloud serverless bot from the
//     same repo so the buttons work.
//
// Sending always goes through the Resend adapter (Cloudflare Workers Paid
// is required for SMTP sending, so this worker never sends).
//
// Setup (full steps in adapters/cloudflare/README.md):
//   INGEST MODE:
//     1. npm init -y && npm i postal-mime
//     2. Copy this file next to your wrangler.toml.
//     3. wrangler secret put POSTWISP_SECRET          (same value as postwisp's POSTWISP_CF_INGEST_SECRET)
//     4. Set POSTWISP_INGEST_URL in wrangler.toml to your postwisp server,
//        e.g. https://postwisp.example.com/ingest/cloudflare
//     5. Enable Email Routing with a catch-all rule to this worker.
//   DIRECT_BOT_API MODE:
//     1. npm init -y && npm i postal-mime
//     2. Copy this file next to your wrangler.toml.
//     3. wrangler secret put TELEGRAM_BOT_TOKEN       (the tgcloud bot's token from BotFather)
//     4. Set TELEGRAM_OWNER_CHAT_ID in wrangler.toml to your numeric Telegram user id
//     5. Enable Email Routing with a catch-all rule to this worker.

import PostalMime from 'postal-mime';

// A file bigger than this is never forwarded inline; too large to be
// useful over this path and a waste of the worker's CPU time.
const PER_FILE_LIMIT = 5 * 1024 * 1024;
// Once included attachments pass this total, the rest are skipped: a
// single email should not dominate one ingest request.
const TOTAL_ATTACHMENTS_LIMIT = 8 * 1024 * 1024;
// postwisp accepts timestamps within +-300s, so the worker's clock
// only has to be roughly right.

// Workers have no Buffer; chunk the bytes so fromCharCode does not blow
// the argument limit on large attachments.
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function signHmacSha256Hex(secret, rawBytes) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, rawBytes);
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The event id must stay short: postwisp puts it in Telegram callback_data
// (64 bytes max), and raw Message-IDs are unbounded. Hash it to a stable
// 34-char id; the full Message-ID is preserved in the headers for threading.
async function shortId(messageIdHeader) {
  if (!messageIdHeader) return `cf-${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(messageIdHeader));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `cf-${hex.slice(0, 32)}`;
}

function addressParts(header) {
  // postal-mime gives address headers as { address, name } already; accept
  // plain strings too so a shape change does not crash the worker.
  if (!header) return [];
  const list = Array.isArray(header) ? header : [header];
  return list
    .map((entry) => (typeof entry === 'string' ? { address: entry } : entry))
    .filter((entry) => entry && typeof entry.address === 'string' && entry.address.length > 0);
}

// Builds the attachment list postwisp expects. Oversized files are not
// forwarded: they are listed with truncated: true so the owner sees that
// something was dropped rather than silently disappearing.
function buildAttachments(rawAttachments) {
  const out = [];
  let included = 0;
  rawAttachments.forEach((att, index) => {
    const bytes = att.content instanceof Uint8Array ? att.content : new Uint8Array(att.content || []);
    const size = bytes.byteLength;
    const entry = {
      id: typeof att.contentId === 'string' && att.contentId.length > 0 ? att.contentId : `att-${index}`,
      filename: typeof att.filename === 'string' && att.filename.length > 0 ? att.filename : `attachment-${index}`,
      size,
      mime: typeof att.mimeType === 'string' && att.mimeType.length > 0 ? att.mimeType : 'application/octet-stream',
    };
    const tooBig = size > PER_FILE_LIMIT || included + size > TOTAL_ATTACHMENTS_LIMIT;
    if (tooBig) {
      entry.truncated = true;
      out.push(entry);
      return;
    }
    entry.contentBase64 = bytesToBase64(bytes);
    included += size;
    out.push(entry);
  });
  return out;
}

// Telegram caps one message at 4096 characters; leave headroom for the
// header lines and a truncation note.
const DIRECT_MESSAGE_LIMIT = 3900;

// Formats the email in the wire format the tgcloud companion parses
// (tgcloud/lib/pure.js formatInboundMessage). This is a duplicate of that
// function — the worker cannot import it — so keep the two in sync:
// "From: ...", "Subject: ...", "Date: ..." header lines, one blank line,
// then the plain-text body.
function formatDirectMessage({ from_addr, from_name, subject, date_ms, body }) {
  // Must stay in sync with formatInboundMessage in tgcloud/lib/pure.js:
  // header values are folded to one line so a newline in a subject cannot
  // break the wire format (parseInboundMessage rejects colon-less lines).
  const oneLine = (v) => String(v || '').replace(/[\r\n]+/g, ' ');
  const from = from_name ? `${oneLine(from_name)} <${oneLine(from_addr)}>` : oneLine(from_addr);
  const header = [
    `From: ${from}`,
    `Subject: ${oneLine(subject)}`,
    `Date: ${new Date(date_ms || Date.now()).toISOString()}`,
  ].join('\n');
  let text = String(body || '');
  const room = DIRECT_MESSAGE_LIMIT - header.length - 2;
  if (text.length > room) {
    text = text.slice(0, Math.max(0, room - 15)) + '\n[truncated]';
  }
  return `${header}\n\n${text}`;
}

// DIRECT_BOT_API mode: parse the email and send it straight to the owner
// via the Bot API, with the inline buttons the tgcloud companion handles
// (w:sv save, w:otp view code, w:rpl reply). protect_content keeps the
// mail from being forwarded out of the chat.
async function sendDirectToTelegram(message, env) {
  const parsed = await PostalMime.parse(message.raw);
  const fromEntry = addressParts(parsed.from)[0];
  const from_addr = fromEntry ? fromEntry.address : 'unknown';
  const from_name = fromEntry && typeof fromEntry.name === 'string' ? fromEntry.name : '';
  const text = formatDirectMessage({
    from_addr,
    from_name,
    subject: typeof parsed.subject === 'string' ? parsed.subject : '',
    date_ms: parsed.date ? parsed.date.getTime() : Date.now(),
    body: typeof parsed.text === 'string' && parsed.text.length > 0
      ? parsed.text
      : '(no plain-text body)',
  });

  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_OWNER_CHAT_ID,
        text,
        protect_content: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Save to inbox', callback_data: 'w:sv' },
              { text: 'View code', callback_data: 'w:otp' },
            ],
            [{ text: 'Reply', callback_data: 'w:rpl' }],
          ],
        },
      }),
    });
  } catch (err) {
    // Network or TLS failure is transient: throw so Email Routing retries.
    console.error('direct bot api sendMessage failed', err instanceof Error ? err.message : String(err));
    throw err;
  }

  if (response.ok) return;

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    // Bad token, bad chat id, or the bot was blocked: retrying changes nothing.
    // Log the status only, never the body: it can carry chat ids or tokens.
    console.error('direct bot api rejected the message', response.status);
    return;
  }

  // 5xx / 429: transient; throw to retry later.
  throw new Error(`direct bot api returned ${response.status}`);
}

export default {
  async email(message, env) {
    // DIRECT_BOT_API mode: no self-hosted server. The worker talks to
    // Telegram directly; the tgcloud companion's handlers parse the
    // message back and power the Save / View code / Reply buttons.
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT_ID) {
      await sendDirectToTelegram(message, env);
      return;
    }

    if (!env.POSTWISP_SECRET || !env.POSTWISP_INGEST_URL) {
      // A config error, not a transient failure: throwing would retry the
      // same email forever, so log and drop it instead.
      console.error('postwisp worker misconfigured: set POSTWISP_SECRET (secret) and POSTWISP_INGEST_URL (var)');
      return;
    }

    const parsed = await PostalMime.parse(message.raw);

    const messageIdHeader = typeof parsed.headers?.get === 'function'
      ? parsed.headers.get('message-id')
      : parsed.messageId;
    const id = await shortId(messageIdHeader);

    const fromEntry = addressParts(parsed.from)[0];
    const payload = {
      id,
      from: { address: fromEntry ? fromEntry.address : 'unknown', name: fromEntry ? fromEntry.name : undefined },
      to: addressParts(parsed.to).map((a) => a.address),
      cc: addressParts(parsed.cc).map((a) => a.address),
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      dateMs: parsed.date ? parsed.date.getTime() : Date.now(),
      text: typeof parsed.text === 'string' ? parsed.text : null,
      html: typeof parsed.html === 'string' ? parsed.html : null,
      headers: {
        'message-id': messageIdHeader || '',
        'in-reply-to': typeof parsed.headers?.get === 'function' ? parsed.headers.get('in-reply-to') || '' : '',
        'references': typeof parsed.headers?.get === 'function' ? parsed.headers.get('references') || '' : '',
      },
      attachments: buildAttachments(parsed.attachments || []),
    };

    const raw = new TextEncoder().encode(JSON.stringify(payload));
    const signature = await signHmacSha256Hex(env.POSTWISP_SECRET, raw);
    const timestamp = String(Math.floor(Date.now() / 1000));

    let response;
    try {
      response = await fetch(env.POSTWISP_INGEST_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-postwisp-signature': signature,
          'x-postwisp-timestamp': timestamp,
        },
        body: raw,
      });
    } catch (err) {
      // Network or TLS failure is transient: throw so Email Routing
      // retries the message instead of losing it.
      console.error('postwisp ingest POST failed', err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (response.ok) return;

    if (response.status >= 400 && response.status < 500) {
      // Definitive rejection (bad signature, bad payload): retrying will
      // not help, so log and return rather than looping forever.
      // Status only, never the body: it can carry message contents.
      console.error('postwisp ingest rejected the email', response.status);
      return;
    }

    // 5xx: the server is unhealthy right now; throw to retry later.
    throw new Error(`postwisp ingest returned ${response.status}`);
  },
};
