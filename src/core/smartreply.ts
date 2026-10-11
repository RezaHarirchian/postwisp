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

// Smart reply drafts (P8, opt-in): the owner's LLM key drafts a reply to
// an inbound email. The generated text is untrusted: it is escaped at
// render time, length-capped here, and never executed or interpolated
// into anything but the message body.

import { LlmError, type LlmClient } from './llm.js';

// The model only needs the head of the mail; the rest is tokens spent for
// nothing. Drafts are capped so a runaway model cannot produce a wall of
// text for the owner to scroll through.
const MAX_REPLY_INPUT_CHARS = 6000;
const MAX_DRAFT_CHARS = 3000;
const MAX_DRAFT_WORDS = 150;

const REPLY_SYSTEM = [
  'You draft email replies. Read the email below and write a short, plain reply.',
  'Reply with a single JSON object: {"body": "the reply text"}.',
  `Keep it under ${MAX_DRAFT_WORDS} words. One short greeting line at most, no sign-off (it is added separately).`,
  'Plain text only: no markdown, no HTML.',
].join(' ');

export async function generateReplyDraft(
  llm: LlmClient,
  email: { from: string; subject: string; body: string },
): Promise<string> {
  const text =
    email.body.length > MAX_REPLY_INPUT_CHARS
      ? email.body.slice(0, MAX_REPLY_INPUT_CHARS)
      : email.body;
  const raw = await llm.chatJson({
    system: REPLY_SYSTEM,
    user: `From: ${email.from}\nSubject: ${email.subject}\n\n${text}`,
    maxTokens: 600,
  });
  const body = (raw as { body?: unknown }).body;
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new LlmError('the model returned an empty draft');
  }
  const trimmed = body.trim();
  return trimmed.length > MAX_DRAFT_CHARS ? trimmed.slice(0, MAX_DRAFT_CHARS) : trimmed;
}
